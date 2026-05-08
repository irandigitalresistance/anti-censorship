"""rlagent/envs/irgfw_gym.py

Gymnasium wrapper around IRGFW-Sim. One `step()` is one TLS-handshake
attempt: the agent picks an action (= one mutation from `mutations.CATALOG`),
the wrapper transmits it, and the verdict (server_hello / rst / timeout)
becomes the reward.

Long-horizon "campaign" variant: each `reset()` starts a fresh source-IP
session of N connections; once the simulated graylist trips, the campaign
ends with a -5 penalty. Used to train *stealthy* agents (E6).

Observation, action, and reward exactly per the plan (§2.1).
"""

from __future__ import annotations

import collections
import os
import socket
import time
from dataclasses import dataclass
from typing import Any, Optional

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from . import mutations


# ---------------------------------------------------------------------------
# Network transport (single connection attempt)
# ---------------------------------------------------------------------------

VERDICT_SERVER_HELLO = 0
VERDICT_TLS_ALERT    = 1
VERDICT_RST          = 2
VERDICT_TIMEOUT      = 3
VERDICT_ERROR        = 4
N_VERDICTS = 5

VERDICT_NAMES = ["server_hello", "tls_alert", "rst", "timeout", "error"]


def _send_plan(target_ip: str, target_port: int, plan: mutations.Plan,
               timeout: float = 1.5) -> tuple[int, float]:
    """Open a TCP connection to (target_ip, target_port), apply the plan,
    return (verdict_id, elapsed_ms)."""
    t0 = time.time()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((target_ip, target_port))
    except Exception:
        return VERDICT_ERROR, (time.time() - t0) * 1000.0
    try:
        if plan.pre_connect_byte:
            s.sendall(b"\x00")
            time.sleep(0.005)
        for i, c in enumerate(plan.chunks):
            s.sendall(c)
            if plan.delay_between_ms and i < len(plan.chunks) - 1:
                time.sleep(plan.delay_between_ms / 1000.0)
        data = b""
        deadline = time.time() + timeout
        while time.time() < deadline and len(data) < 128:
            try:
                s.settimeout(max(0.1, deadline - time.time()))
                chunk = s.recv(4096)
            except socket.timeout:
                break
            except ConnectionResetError:
                return VERDICT_RST, (time.time() - t0) * 1000.0
            if not chunk: break
            data += chunk
        elapsed = (time.time() - t0) * 1000.0
        if not data:
            return VERDICT_TIMEOUT, elapsed
        if data[0] == 0x16:
            return VERDICT_SERVER_HELLO, elapsed
        if data[0] == 0x15:
            return VERDICT_TLS_ALERT, elapsed
        return VERDICT_TIMEOUT, elapsed
    except ConnectionResetError:
        return VERDICT_RST, (time.time() - t0) * 1000.0
    except Exception:
        return VERDICT_ERROR, (time.time() - t0) * 1000.0
    finally:
        try: s.close()
        except Exception: pass


# ---------------------------------------------------------------------------
# Observation builder
# ---------------------------------------------------------------------------

ISP_IDS = {"mci": 0, "irancell": 1, "shatel": 2, "mci_patched": 3, "unknown": 4}


@dataclass
class StepInfo:
    verdict_id: int
    elapsed_ms: float
    plan_name: str
    plan_cost: float
    action_id: int


class _History:
    """Rolling window of last N verdicts and racing-budget estimates."""

    def __init__(self, n: int = 10) -> None:
        self.n = n
        self.verdicts: collections.deque[int] = collections.deque(maxlen=n)
        self.times:    collections.deque[float] = collections.deque(maxlen=n)
        self.recent_rsts: collections.deque[float] = collections.deque(maxlen=64)

    def push(self, v: int, t: float) -> None:
        self.verdicts.append(v)
        self.times.append(t)
        if v == VERDICT_RST:
            self.recent_rsts.append(time.time())

    def rst_count_60s(self) -> int:
        cutoff = time.time() - 60
        return sum(1 for t in self.recent_rsts if t > cutoff)

    def racing_budget_estimate(self) -> float:
        rsts = [t for t, v in zip(self.times, self.verdicts) if v == VERDICT_RST]
        if not rsts:
            return 0.0
        return sum(rsts) / len(rsts)


def _sni_token_ids(sni: str, length: int = 16) -> np.ndarray:
    """Cheap fixed-length encoding of the SNI: take the first `length`
    ASCII codepoints, padding with 0."""
    arr = np.zeros(length, dtype=np.float32)
    for i, c in enumerate(sni.encode("ascii", errors="ignore")[:length]):
        arr[i] = c / 255.0
    return arr


# ---------------------------------------------------------------------------
# Env
# ---------------------------------------------------------------------------

class IrgfwEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(
        self,
        target_ip: str = "10.0.2.2",
        target_port: int = 443,
        target_sni: str = "www.twitter.com",
        clean_sni:  str = "www.google.com",
        isp_profile: str = "mci",
        campaign_length: int = 50,
        racing_budget_target_ms: float = 8.0,
        max_episode_steps: int = 1,
        # E8 ablation: zero out a contiguous observation slice every step.
        # Each entry: (start_idx, end_idx, name). Used for the observation
        # ablation experiment.
        mask_obs_slices: tuple[tuple[int, int, str], ...] = (),
    ) -> None:
        super().__init__()
        self.target_ip = target_ip
        self.target_port = target_port
        self.target_sni = target_sni
        self.clean_sni = clean_sni
        self.isp_profile = isp_profile
        self.campaign_length = campaign_length
        self.racing_budget_target_ms = racing_budget_target_ms

        self.action_space = spaces.Discrete(len(mutations.CATALOG))

        # Observation: per-plan §2.1 (~64 dims)
        #   40: last 10 verdicts × 4 (we group server_hello+tls_alert into PASS?
        #       no — keep 4 distinct; with 5 verdicts that's 50, but we use
        #       4-of-5 dims: server_hello, tls_alert, rst, timeout — error
        #       collapses into timeout for the obs).
        #    1: racing-budget estimate (ms / 100, clipped 0–1)
        #    1: graylist signal (recent_rst_count / 64, clipped 0–1)
        #   16: SNI token IDs
        #    5: ISP one-hot
        #    2: campaign progress (linear + log)
        # Total: 65 dims
        self.observation_space = spaces.Box(low=0.0, high=1.0,
                                            shape=(65,), dtype=np.float32)

        self._history = _History(n=10)
        self._connection_idx = 0
        self._best_cost_seen = float("inf")
        self._campaign_failed = False
        self._mask_obs_slices = tuple(mask_obs_slices)

    # ---------- gym API ----------

    def reset(self, seed: Optional[int] = None, options: Optional[dict] = None,
              ) -> tuple[np.ndarray, dict]:
        super().reset(seed=seed)
        self._history = _History(n=10)
        self._connection_idx = 0
        self._best_cost_seen = float("inf")
        self._campaign_failed = False
        return self._observation(), {"info": "campaign_started"}

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict]:
        if self._campaign_failed:
            return self._observation(), 0.0, True, False, {"info": "campaign_already_failed"}

        plan = mutations.get(int(action), self.target_sni)
        verdict, elapsed_ms = _send_plan(self.target_ip, self.target_port, plan)
        self._history.push(verdict, elapsed_ms)
        self._connection_idx += 1

        # ---- reward shaping (per plan §2.1) ----
        r = 0.0
        if verdict in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
            r += 1.0
            # cheapest-winner bonus
            if plan.cost < self._best_cost_seen:
                r += 0.05
                self._best_cost_seen = plan.cost
        elif verdict == VERDICT_RST:
            r -= 1.0
        elif verdict == VERDICT_TIMEOUT:
            r -= 0.5
        else:                          # error
            r -= 0.2

        r -= 0.05 * (elapsed_ms / 100.0)

        # graylist proxy: many recent RSTs from this src means the simulated
        # DPI is closing in.
        if self._history.rst_count_60s() >= 5:
            r -= 0.10

        terminated = self._connection_idx >= self.campaign_length
        # campaign cumulative penalty
        truncated = False
        if self._history.rst_count_60s() >= 20:
            r -= 5.0
            self._campaign_failed = True
            terminated = True

        info = {
            "verdict": VERDICT_NAMES[verdict],
            "verdict_id": verdict,
            "elapsed_ms": elapsed_ms,
            "plan_name": plan.name,
            "plan_cost": plan.cost,
            "action_id": int(action),
            "connection_idx": self._connection_idx,
        }
        return self._observation(), r, terminated, truncated, info

    # ---------- observation ----------

    def _observation(self) -> np.ndarray:
        obs = np.zeros(65, dtype=np.float32)
        # last 10 verdicts × 4 one-hot dims (40 dims)
        for i, v in enumerate(self._history.verdicts):
            base = i * 4
            if v in (VERDICT_SERVER_HELLO,):
                obs[base + 0] = 1.0
            elif v == VERDICT_TLS_ALERT:
                obs[base + 1] = 1.0
            elif v == VERDICT_RST:
                obs[base + 2] = 1.0
            else:
                obs[base + 3] = 1.0
        # racing-budget estimate / 100ms, clipped
        obs[40] = min(1.0, self._history.racing_budget_estimate() / 100.0)
        # graylist signal
        obs[41] = min(1.0, self._history.rst_count_60s() / 64.0)
        # SNI token ids
        obs[42:42+16] = _sni_token_ids(self.target_sni, 16)
        # ISP one-hot
        isp_idx = ISP_IDS.get(self.isp_profile, ISP_IDS["unknown"])
        obs[58 + isp_idx] = 1.0
        # campaign progress
        obs[63] = min(1.0, self._connection_idx / max(1, self.campaign_length))
        obs[64] = min(1.0, np.log1p(self._connection_idx) / np.log1p(self.campaign_length))
        # E8: zero out masked dimensions (used to measure each feature's
        # contribution to the policy).
        for start, end, _name in self._mask_obs_slices:
            obs[start:end] = 0.0
        return obs

    def close(self) -> None:
        pass


# ---------- registry ----------

def make(**kwargs: Any) -> IrgfwEnv:
    """Convenience factory."""
    return IrgfwEnv(**kwargs)
