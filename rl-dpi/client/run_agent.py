#!/usr/bin/env python3
"""client/run_agent.py — Iran-side operator runner.

A standalone CLI that loads a trained policy checkpoint and uses it to
craft + send a TLS handshake against any target IP/port. The operator
runs this from inside Iran on a real ISP connection; the policy picks
a mutation, the script applies it, and prints the verdict.

Two modes:
  * one-shot: connect once, apply the policy's chosen mutation, print
    the result. Useful for measurement.
  * socks5: open a SOCKS5 listener on localhost; for every CONNECT,
    use the policy to pick + apply a mutation. Useful as a daily
    proxy.

Dependencies (pure stdlib + torch):
  pip install torch==2.2.2  # CPU build is fine

The operator does NOT need Docker, the simulator, or any of the
training infrastructure. The runtime is just torch + the policy
state-dict + the mutations module.

Usage:
  # one-shot test
  python client/run_agent.py --policy policy.pt --target www.twitter.com:443

  # socks5 proxy
  python client/run_agent.py --policy policy.pt --socks5 127.0.0.1:1080

  # report-mode (probe many SNIs, log verdicts as JSON)
  python client/run_agent.py --policy policy.pt --probe-sni-list snis.txt --json
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import struct
import sys
import threading
import time
from pathlib import Path

# Add rlagent to path
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from rlagent.envs import mutations
from rlagent.envs.irgfw_gym import (
    _send_plan, VERDICT_NAMES,
    VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT, VERDICT_RST,
    VERDICT_TIMEOUT, VERDICT_ERROR,
)


# ---------------------------------------------------------------------------
# Policy loading — torch-only path; supports any of our PPO/DQN agents.
# ---------------------------------------------------------------------------

def load_policy(policy_path: str, agent_kind: str = "ppo") -> "object":
    """Return an object with .act(obs: np.ndarray) -> int."""
    import numpy as np
    import torch

    from rlagent.train.train import _build_agent

    # Build a CPU agent of the right class, load the state dict.
    n_actions = mutations.N_ACTIONS
    obs_dim = 65
    agent = _build_agent(agent_kind, obs_dim, n_actions, gpu=-1, seed=0)
    sd = torch.load(policy_path, map_location="cpu")
    agent.load_state_dict(sd)

    # Force-greedy mode for inference: zero out exploration ε if applicable.
    for attr, val in (("epsilon", 0.0),
                      ("eps_start", 0.0),
                      ("eps_end", 0.0)):
        if hasattr(agent, attr):
            try: setattr(agent, attr, val)
            except Exception: pass
    return agent


def make_obs(target_sni: str) -> "np.ndarray":
    """Construct an observation vector identical to the env's idle state.
    The trained policy was conditioned on this layout."""
    import numpy as np
    obs = np.zeros(65, dtype=np.float32)
    # SNI tokens in dims 42..58
    for i, c in enumerate(target_sni.encode("ascii", errors="ignore")[:16]):
        obs[42 + i] = c / 255.0
    # ISP one-hot: "unknown" = 4
    obs[58 + 4] = 1.0
    return obs


# ---------------------------------------------------------------------------
# One-shot mode
# ---------------------------------------------------------------------------

def one_shot(agent, target_host: str, target_port: int,
             target_sni: str | None = None) -> dict:
    sni = target_sni or target_host
    obs = make_obs(sni)
    action = agent.act(obs)
    if isinstance(action, tuple):
        action = action[0]
    plan = mutations.get(int(action), sni)

    # Resolve target. Honest path: caller's stub_resolver
    # (which inside Iran will hit the bogon-injected DNS).
    try:
        target_ip = socket.gethostbyname(target_host)
    except Exception as e:
        return {"ok": False, "error": f"dns failed: {e}"}

    verdict, elapsed_ms = _send_plan(target_ip, target_port, plan, timeout=4.0)
    return {
        "target": f"{target_host}:{target_port}",
        "target_ip": target_ip,
        "sni": sni,
        "action_id": int(action),
        "plan": plan.name,
        "verdict": VERDICT_NAMES[verdict],
        "elapsed_ms": round(elapsed_ms, 1),
        "ok": verdict in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT),
    }


# ---------------------------------------------------------------------------
# Probe mode — go through a list of SNIs, report per-target verdict
# ---------------------------------------------------------------------------

def probe_list(agent, sni_list: list[str], target_port: int = 443) -> list[dict]:
    out = []
    for sni in sni_list:
        out.append(one_shot(agent, sni, target_port, target_sni=sni))
    return out


# ---------------------------------------------------------------------------
# SOCKS5 proxy mode
# ---------------------------------------------------------------------------

def _read_n(s: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        c = s.recv(n - len(buf))
        if not c: raise ConnectionError("socks5 short read")
        buf += c
    return buf


def _socks5_handle(client: socket.socket, agent) -> None:
    try:
        # Greeting: VER NMETHODS METHODS...
        ver, n = client.recv(2)
        if ver != 0x05: client.close(); return
        client.recv(n)
        client.sendall(b"\x05\x00")    # NO AUTH

        # Request: VER CMD RSV ATYP ...
        hdr = _read_n(client, 4)
        ver, cmd, rsv, atyp = hdr
        if ver != 0x05 or cmd != 0x01:
            client.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            client.close(); return
        if atyp == 0x01:
            target_ip = socket.inet_ntoa(_read_n(client, 4))
            target_host = target_ip
        elif atyp == 0x03:
            n = _read_n(client, 1)[0]
            target_host = _read_n(client, n).decode("ascii")
            target_ip = socket.gethostbyname(target_host)
        else:
            client.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
            client.close(); return
        target_port = struct.unpack(">H", _read_n(client, 2))[0]

        # Apply policy
        obs = make_obs(target_host)
        action = agent.act(obs)
        if isinstance(action, tuple): action = action[0]
        plan = mutations.get(int(action), target_host)

        # Open upstream, apply plan's chunks/delays, then bridge bytes.
        upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        upstream.connect((target_ip, target_port))
        if plan.pre_connect_byte:
            upstream.sendall(b"\x00"); time.sleep(0.005)
        for i, c in enumerate(plan.chunks):
            upstream.sendall(c)
            if plan.delay_between_ms and i < len(plan.chunks) - 1:
                time.sleep(plan.delay_between_ms / 1000.0)

        # Reply OK to client
        client.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00" + struct.pack(">H", target_port))
        print(f"[socks5] {target_host}:{target_port} via plan={plan.name}",
              flush=True)

        # Now bridge bytes both ways
        def pipe(src, dst):
            try:
                while True:
                    b = src.recv(4096)
                    if not b: break
                    dst.sendall(b)
            except Exception:
                pass
            finally:
                try: src.shutdown(socket.SHUT_RD)
                except Exception: pass
                try: dst.shutdown(socket.SHUT_WR)
                except Exception: pass

        t1 = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
        t2 = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
        t1.start(); t2.start(); t1.join(); t2.join()
    except Exception as e:
        print(f"[socks5] error: {e}", flush=True)
    finally:
        try: client.close()
        except Exception: pass


def socks5_serve(bind: str, agent) -> None:
    host, port = bind.split(":")
    port = int(port)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(64)
    print(f"[socks5] listening on {host}:{port}")
    while True:
        client, addr = srv.accept()
        threading.Thread(target=_socks5_handle, args=(client, agent),
                         daemon=True).start()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--policy", required=True,
                    help="Path to policy state-dict (.pt)")
    ap.add_argument("--agent-kind", default="ppo",
                    choices=["random", "ucb1", "qtable", "geneva", "dqn",
                             "ppo", "ppo_param", "ppo_transformer",
                             "ppo_mixed", "ppo_distill"])
    ap.add_argument("--target", default=None,
                    help="One-shot target host:port (e.g. www.twitter.com:443)")
    ap.add_argument("--probe-sni-list", default=None,
                    help="Path to file with one SNI per line; probe each")
    ap.add_argument("--socks5", default=None,
                    help="Bind addr for socks5 mode (e.g. 127.0.0.1:1080)")
    ap.add_argument("--json", action="store_true",
                    help="Machine-readable output")
    args = ap.parse_args()

    if not (args.target or args.probe_sni_list or args.socks5):
        ap.error("pick one of --target / --probe-sni-list / --socks5")

    agent = load_policy(args.policy, agent_kind=args.agent_kind)
    print(f"[runner] loaded policy {args.policy} (kind={args.agent_kind})")

    if args.target:
        host, _, port = args.target.partition(":")
        result = one_shot(agent, host, int(port or 443))
        print(json.dumps(result, indent=2) if args.json
              else f"  {result['target']:35s} plan={result['plan']:30s} "
                   f"verdict={result['verdict']}  ({result['elapsed_ms']:.0f}ms)")
        sys.exit(0 if result.get("ok") else 1)

    if args.probe_sni_list:
        snis = [l.strip() for l in open(args.probe_sni_list) if l.strip()]
        results = probe_list(agent, snis)
        if args.json:
            print(json.dumps(results, indent=2))
        else:
            ok = sum(1 for r in results if r.get("ok"))
            print(f"  {ok}/{len(results)} bypassed")
            for r in results:
                print(f"  {r['target']:35s} {r['verdict']:14s} "
                      f"plan={r.get('plan','-')}")
        sys.exit(0 if ok > 0 else 1)

    if args.socks5:
        try:
            socks5_serve(args.socks5, agent)
        except KeyboardInterrupt:
            print("[runner] stopped")


if __name__ == "__main__":
    main()
