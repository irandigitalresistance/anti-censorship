"""rlagent/eval/transfer_matrix.py — Experiment E4.

For each (agent, eval_profile) cell of the matrix, run a fixed number of
greedy evaluation episodes and record the bypass rate. The DPI profile
must be set externally via IRGFW_PROFILE before running this script
against each profile (the caller restarts the dpi container with the
right env var, then runs this script with --eval-profile).

This script appends one row per (agent, ckpt_profile, eval_profile) into
the output JSON, so it can be invoked once per eval-profile.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from rlagent.envs.irgfw_gym import (
    IrgfwEnv, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT,
)
from rlagent.train.train import _build_agent


def evaluate(agent_name: str, ckpt_path: Path, eval_profile: str,
             target_ip: str, sni: str, n_episodes: int) -> dict:
    env = IrgfwEnv(target_ip=target_ip, target_sni=sni,
                   isp_profile=eval_profile, campaign_length=n_episodes)
    obs_dim = env.observation_space.shape[0]
    n_actions = env.action_space.n
    agent = _build_agent(agent_name, obs_dim, n_actions, gpu=-1, seed=0)
    if ckpt_path.exists():
        try:
            import torch
            agent.load_state_dict(torch.load(str(ckpt_path), map_location="cpu"))
        except Exception:
            import pickle
            with open(ckpt_path, "rb") as f:
                agent.load_state_dict(pickle.load(f))

    obs, _ = env.reset()
    bypass = 0; rst = 0; timeout = 0; n = 0
    for _ in range(n_episodes):
        a = agent.act(obs)
        if isinstance(a, tuple): a = a[0]
        obs, r, done, trunc, info = env.step(int(a))
        v = info["verdict_id"]
        if v in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
            bypass += 1
        elif v == 2:
            rst += 1
        elif v == 3:
            timeout += 1
        n += 1
        if done or trunc:
            obs, _ = env.reset()
    return {
        "agent": agent_name,
        "ckpt": str(ckpt_path),
        "eval_profile": eval_profile,
        "n": n,
        "bypass": bypass,
        "rst": rst,
        "timeout": timeout,
        "bypass_rate": bypass / max(1, n),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-dir", default="/opt/rlagent/runs")
    ap.add_argument("--out", required=True)
    ap.add_argument("--eval-profile", required=True)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--sni", default="www.twitter.com")
    ap.add_argument("--n-episodes", type=int, default=500)
    args = ap.parse_args()

    out_path = Path(args.out)
    rows: list[dict] = []
    if out_path.exists():
        rows = json.load(open(out_path))

    for run_dir in sorted(Path(args.runs_dir).iterdir()):
        if not run_dir.is_dir(): continue
        if not str(run_dir.name).endswith("-3k-ckpt"): continue
        agent_name = run_dir.name.split("-")[0]
        ckpt = run_dir / "checkpoints" / "final.pt"
        if not ckpt.exists(): continue
        print(f"  eval agent={agent_name:8s} eval_profile={args.eval_profile}", flush=True)
        row = evaluate(agent_name, ckpt, args.eval_profile,
                       args.target_ip, args.sni, args.n_episodes)
        print(f"    -> bypass {row['bypass']}/{row['n']} = {row['bypass_rate']:.3f}",
              flush=True)
        rows.append(row)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(rows, f, indent=2)


if __name__ == "__main__":
    main()
