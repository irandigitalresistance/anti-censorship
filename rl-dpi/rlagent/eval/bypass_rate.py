"""rlagent/eval/bypass_rate.py — Experiment E1.

For each trained agent checkpoint, run N evaluation episodes (purely
greedy / no exploration) on a held-out target SNI list and report the
bypass rate. Output: JSON file consumed by scripts/plots.py.

Held-out SNIs: a different blocked-domain set than what was trained on,
to control for SNI-overfitting.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

from rlagent.envs.irgfw_gym import IrgfwEnv, VERDICT_NAMES, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT


HELD_OUT_BLOCKED_SNIS = [
    "web.telegram.org",
    "www.facebook.com",
    "www.instagram.com",
    "www.youtube.com",
    "www.x.com",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--agent", required=True)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--isp-profile", default="mci")
    ap.add_argument("--episodes-per-sni", type=int, default=200)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    # Load agent
    from rlagent.train.train import _build_agent
    env = IrgfwEnv(target_ip=args.target_ip, isp_profile=args.isp_profile)
    obs_dim = env.observation_space.shape[0]
    n_actions = env.action_space.n
    agent = _build_agent(args.agent, obs_dim, n_actions, gpu=-1, seed=0)

    if args.checkpoint:
        try:
            import torch
            agent.load_state_dict(torch.load(args.checkpoint, map_location="cpu"))
        except Exception:
            import pickle
            with open(args.checkpoint, "rb") as f:
                agent.load_state_dict(pickle.load(f))

    results: dict[str, dict] = {}
    for sni in HELD_OUT_BLOCKED_SNIS:
        env_sni = IrgfwEnv(target_ip=args.target_ip,
                           target_sni=sni, isp_profile=args.isp_profile,
                           campaign_length=args.episodes_per_sni)
        obs, _ = env_sni.reset()
        bypass = 0; n = 0
        action_freq: dict[int, int] = {}
        for _ in range(args.episodes_per_sni):
            if args.agent == "ppo_transformer":
                from rlagent.agents.ppo_transformer import PPOTransformerAgent  # type: ignore
                # No discrete action; just count bypass
                byte_seq = agent.act(obs)
                from rlagent.envs.mutations import Plan
                from rlagent.envs.irgfw_gym import _send_plan
                v, _ms = _send_plan(env_sni.target_ip, env_sni.target_port,
                                    Plan(chunks=[byte_seq], name="t", cost=1.0))
                if v in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
                    bypass += 1
                n += 1
            else:
                if args.agent == "geneva":
                    action, chain = agent.act(obs)
                else:
                    a = agent.act(obs)
                    action = a[0] if isinstance(a, tuple) else a
                action_freq[int(action)] = action_freq.get(int(action), 0) + 1
                obs, r, done, trunc, info = env_sni.step(int(action))
                if info["verdict_id"] in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
                    bypass += 1
                n += 1
                if done or trunc:
                    obs, _ = env_sni.reset()
        results[sni] = {
            "bypass": bypass,
            "n": n,
            "rate": bypass / max(1, n),
            "action_freq": action_freq,
        }

    overall = sum(r["bypass"] for r in results.values()) / max(
        1, sum(r["n"] for r in results.values()))
    out = {
        "agent": args.agent,
        "isp_profile": args.isp_profile,
        "checkpoint": args.checkpoint,
        "per_sni": results,
        "overall_bypass_rate": overall,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"[eval] overall_bypass_rate={overall:.3f} -> {args.out}")


if __name__ == "__main__":
    main()
