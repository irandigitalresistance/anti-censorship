"""rlagent/eval/eval_one_ckpt.py

Evaluate a single checkpoint on a single eval-profile, append a row to
the output JSON. Usage:

    docker exec ... python -m rlagent.eval.eval_one_ckpt \\
        --agent ppo --label ppo_mixed \\
        --ckpt /opt/rlagent/runs/ppo_mixed-rot-6k/checkpoints/final.pt \\
        --eval-profile mci --out /opt/rlagent/runs/transfer.json --n 300
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from rlagent.envs.irgfw_gym import IrgfwEnv, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT
from rlagent.train.train import _build_agent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--label", default=None,
                    help="Display name in the output (defaults to --agent)")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--eval-profile", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--sni", default="www.twitter.com")
    args = ap.parse_args()

    env = IrgfwEnv(target_ip=args.target_ip, target_sni=args.sni,
                   isp_profile=args.eval_profile, campaign_length=args.n)
    agent = _build_agent(args.agent,
                         env.observation_space.shape[0],
                         env.action_space.n, gpu=-1, seed=0)
    try:
        import torch
        agent.load_state_dict(torch.load(args.ckpt, map_location="cpu"))
    except Exception:
        import pickle
        with open(args.ckpt, "rb") as f:
            agent.load_state_dict(pickle.load(f))

    obs, _ = env.reset()
    bypass = 0; n = 0
    for _ in range(args.n):
        a = agent.act(obs)
        if isinstance(a, tuple): a = a[0]
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
        "agent": args.label or args.agent,
        "ckpt": args.ckpt,
        "eval_profile": args.eval_profile,
        "n": n, "bypass": bypass,
        "bypass_rate": bypass / max(1, n),
    })
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(rows, f, indent=2)
    print(f"  {args.label or args.agent:12s} eval={args.eval_profile:18s} "
          f"bypass={bypass}/{n}={bypass/max(1,n):.3f}")


if __name__ == "__main__":
    main()
