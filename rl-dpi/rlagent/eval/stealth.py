"""rlagent/eval/stealth.py — Experiment E6.

Long-horizon stealth campaign. Each trial = 1000 connections from one
simulated source IP; record the connection index at which the simulated
graylist trips. Output: per-agent CDF of campaign length.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

from rlagent.envs.irgfw_gym import (
    IrgfwEnv, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT, VERDICT_RST,
)
from rlagent.train.train import _build_agent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--agent", required=True)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--isp-profile", default="mci")
    ap.add_argument("--n-trials", type=int, default=20)
    ap.add_argument("--campaign-len", type=int, default=1000)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    env = IrgfwEnv(target_ip=args.target_ip, isp_profile=args.isp_profile,
                   campaign_length=args.campaign_len)
    agent = _build_agent(args.agent,
                         env.observation_space.shape[0],
                         env.action_space.n, gpu=-1, seed=0)
    try:
        import torch
        agent.load_state_dict(torch.load(args.checkpoint, map_location="cpu"))
    except Exception:
        import pickle
        with open(args.checkpoint, "rb") as f:
            agent.load_state_dict(pickle.load(f))

    trials = []
    for trial in range(args.n_trials):
        obs, _ = env.reset()
        bypass_run = 0
        rst_run = 0
        first_failure_at = None
        for i in range(args.campaign_len):
            a = agent.act(obs)
            if isinstance(a, tuple): a = a[0]
            obs, r, done, trunc, info = env.step(int(a))
            v = info["verdict_id"]
            if v in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
                bypass_run += 1
            elif v == VERDICT_RST:
                rst_run += 1
                if first_failure_at is None and rst_run >= 5:
                    first_failure_at = i
            if done or trunc:
                break
        trials.append({
            "trial": trial,
            "connections": i + 1,
            "bypass": bypass_run,
            "rst": rst_run,
            "first_fail_at": first_failure_at,
        })
        print(f"  trial {trial}: connections={i+1} bypass={bypass_run} "
              f"first_fail={first_failure_at}")

    median_len = sorted(t["connections"] for t in trials)[len(trials) // 2]
    out = {"agent": args.agent, "isp_profile": args.isp_profile,
           "trials": trials, "median_campaign_len": median_len}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()
