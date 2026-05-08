"""rlagent/eval/eval_ensemble.py

Build an ensemble of the 5 trained mci checkpoints (UCB1, Q-table, Geneva,
DQN, PPO) and evaluate it across all 4 profiles. Append rows to
transfer.json.
"""
from __future__ import annotations
import argparse, json, sys, pickle
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from rlagent.envs.irgfw_gym import IrgfwEnv, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT
from rlagent.agents.ensemble import EnsembleAgent
from rlagent.train.train import _build_agent


def load_member(agent_name: str, obs_dim: int, n_actions: int, ckpt: Path):
    agent = _build_agent(agent_name, obs_dim, n_actions, gpu=-1, seed=0)
    try:
        import torch
        agent.load_state_dict(torch.load(str(ckpt), map_location="cpu"))
    except Exception:
        with open(ckpt, "rb") as f:
            agent.load_state_dict(pickle.load(f))
    return agent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-dir", default="/opt/rlagent/runs")
    ap.add_argument("--ckpt-suffix", default="-mci-3k-ckpt")
    ap.add_argument("--eval-profile", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--sni", default="www.twitter.com")
    args = ap.parse_args()

    env = IrgfwEnv(target_ip=args.target_ip, target_sni=args.sni,
                   isp_profile=args.eval_profile, campaign_length=args.n)
    obs_dim = env.observation_space.shape[0]; n_actions = env.action_space.n

    members = []
    for run_dir in sorted(Path(args.runs_dir).iterdir()):
        if not run_dir.is_dir(): continue
        if not run_dir.name.endswith(args.ckpt_suffix): continue
        agent_name = run_dir.name.split("-")[0]
        ckpt = run_dir / "checkpoints" / "final.pt"
        if not ckpt.exists(): continue
        print(f"  loading member: {agent_name} from {ckpt}", flush=True)
        members.append(load_member(agent_name, obs_dim, n_actions, ckpt))

    ens = EnsembleAgent(n_actions, members)

    obs, _ = env.reset()
    bypass = 0; n = 0
    for _ in range(args.n):
        a = ens.act(obs)
        obs, r, done, trunc, info = env.step(int(a))
        if info["verdict_id"] in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
            bypass += 1
        n += 1
        if done or trunc:
            obs, _ = env.reset()

    rows = []
    if Path(args.out).exists():
        rows = json.load(open(args.out))
    rows.append({
        "agent": "ensemble",
        "eval_profile": args.eval_profile,
        "n": n, "bypass": bypass,
        "bypass_rate": bypass / max(1, n),
    })
    with open(args.out, "w") as f:
        json.dump(rows, f, indent=2)
    print(f"  ensemble    eval={args.eval_profile:14s} "
          f"bypass={bypass}/{n}={bypass/max(1,n):.3f}")


if __name__ == "__main__":
    main()
