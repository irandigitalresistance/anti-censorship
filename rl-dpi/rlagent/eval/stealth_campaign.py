"""rlagent/eval/stealth_campaign.py — Experiment E6.

For each trained agent's checkpoint, run several long-horizon campaigns
on the strict-graylist profile (5 MB / 60 s, the documented Iran value).
Each campaign is N connections from one simulated source IP. Record at
which connection the simulated graylist trips.

Output: per-agent JSON with the connection-count distribution + a
"campaign_length" survival series usable for a CDF plot.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from rlagent.envs.irgfw_gym import (
    IrgfwEnv, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT, VERDICT_RST,
)
from rlagent.train.train import _build_agent


def run_one_session(agent, env, max_conns: int) -> dict:
    """One stealth session — no reset of source IP — until graylist trip
    or max_conns reached. Returns counts + first-fail index."""
    obs, _ = env.reset()
    bypass = 0; rst = 0; rst_streak = 0
    first_streak_at = None
    for i in range(max_conns):
        a = agent.act(obs)
        if isinstance(a, tuple): a = a[0]
        obs, r, done, trunc, info = env.step(int(a))
        v = info["verdict_id"]
        if v in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
            bypass += 1; rst_streak = 0
        elif v == VERDICT_RST:
            rst += 1; rst_streak += 1
            if rst_streak >= 5 and first_streak_at is None:
                # 5 consecutive RSTs → graylist almost certainly tripped
                first_streak_at = i
        if done or trunc:
            obs, _ = env.reset()
    return {"connections": max_conns, "bypass": bypass, "rst": rst,
            "first_streak_at": first_streak_at}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-dir", default="/opt/rlagent/runs")
    ap.add_argument("--ckpt-suffix", default="-mci-3k-ckpt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--sni", default="www.twitter.com")
    ap.add_argument("--n-sessions", type=int, default=3)
    ap.add_argument("--max-conns", type=int, default=1000)
    args = ap.parse_args()

    rows: list[dict] = []
    for run_dir in sorted(Path(args.runs_dir).iterdir()):
        if not run_dir.is_dir(): continue
        if not run_dir.name.endswith(args.ckpt_suffix): continue
        agent_name = run_dir.name.split("-")[0]
        ckpt = run_dir / "checkpoints" / "final.pt"
        if not ckpt.exists(): continue
        env = IrgfwEnv(target_ip=args.target_ip, target_sni=args.sni,
                       isp_profile="mci_strict_graylist",
                       campaign_length=args.max_conns)
        agent = _build_agent(agent_name,
                             env.observation_space.shape[0],
                             env.action_space.n, gpu=-1, seed=0)
        try:
            import torch
            agent.load_state_dict(torch.load(str(ckpt), map_location="cpu"))
        except Exception:
            import pickle
            with open(ckpt, "rb") as f:
                agent.load_state_dict(pickle.load(f))

        for s in range(args.n_sessions):
            print(f"  agent={agent_name:8s} session={s+1}/{args.n_sessions}",
                  flush=True)
            row = run_one_session(agent, env, args.max_conns)
            row["agent"] = agent_name; row["session"] = s
            rows.append(row)
            print(f"    bypass={row['bypass']}/{row['connections']} "
                  f"first_streak_at={row['first_streak_at']}", flush=True)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(rows, f, indent=2)


if __name__ == "__main__":
    main()
