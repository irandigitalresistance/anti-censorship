"""rlagent/eval/transfer.py — Experiment E4.

Train on profile A, evaluate zero-shot on profile B (and B'). Reports a
3×N matrix of (agent, train_profile, eval_profile) → bypass rate.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from itertools import product


PROFILES = ["mci", "irancell", "shatel"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", required=True,
                    help="JSON file: {agent: {train_profile: checkpoint_path}}")
    ap.add_argument("--out", required=True)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--episodes-per-cell", type=int, default=500)
    args = ap.parse_args()

    with open(args.matrix) as f:
        matrix = json.load(f)

    rows = []
    for agent_name, by_train in matrix.items():
        for train_p, ckpt in by_train.items():
            for eval_p in PROFILES:
                # Run evaluation programmatically by invoking the bypass_rate
                # logic in-process.
                from rlagent.eval.bypass_rate import HELD_OUT_BLOCKED_SNIS  # noqa: F401
                from rlagent.envs.irgfw_gym import IrgfwEnv, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT
                from rlagent.train.train import _build_agent
                env = IrgfwEnv(target_ip=args.target_ip, isp_profile=eval_p)
                agent = _build_agent(agent_name,
                                     env.observation_space.shape[0],
                                     env.action_space.n, gpu=-1, seed=0)
                try:
                    import torch
                    agent.load_state_dict(torch.load(ckpt, map_location="cpu"))
                except Exception:
                    import pickle
                    with open(ckpt, "rb") as f:
                        agent.load_state_dict(pickle.load(f))
                obs, _ = env.reset()
                bypass = 0; n = 0
                for _ in range(args.episodes_per_cell):
                    a = agent.act(obs)
                    if isinstance(a, tuple):
                        a = a[0]
                    obs, r, done, trunc, info = env.step(int(a))
                    if info["verdict_id"] in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
                        bypass += 1
                    n += 1
                    if done or trunc:
                        obs, _ = env.reset()
                rows.append({
                    "agent": agent_name,
                    "train_profile": train_p,
                    "eval_profile":  eval_p,
                    "rate": bypass / max(1, n),
                    "n": n,
                })
                print(f"  {agent_name:18s} train={train_p:9s} eval={eval_p:9s} "
                      f"bypass={bypass}/{n}={bypass/max(1,n):.3f}")

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(rows, f, indent=2)


if __name__ == "__main__":
    main()
