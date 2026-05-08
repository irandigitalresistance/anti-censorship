"""rlagent/train/train_distill.py

Train PPO whose actor head is initialised with a logit bias toward the
top-K actions of a previously-trained Geneva agent. Then continue with
standard PPO. The hypothesis is that this gives PPO a better starting
distribution (Geneva-discovered chains) and lets it match Geneva's
transferability without the GA's exploration cost.
"""
from __future__ import annotations
import argparse, json, sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from rlagent.envs.irgfw_gym import IrgfwEnv, VERDICT_NAMES
from rlagent.agents.geneva import GenevaAgent
from rlagent.agents.ppo_distill import PPODistillAgent, bias_actor_toward


def extract_geneva_action_bias(geneva_ckpt: Path, n_actions: int) -> np.ndarray:
    """Load a saved Geneva GA and produce a per-action bias vector
    proportional to how often each action appears in the top-N
    individuals (weighted by fitness)."""
    sd = None
    try:
        import torch
        sd = torch.load(str(geneva_ckpt), map_location="cpu")
    except Exception:
        import pickle
        with open(geneva_ckpt, "rb") as f:
            sd = pickle.load(f)
    bias = np.zeros(n_actions, dtype=np.float32)
    pop = sd.get("pop", [])
    pop_sorted = sorted(pop, key=lambda x: -x[1])  # by fitness desc
    top = pop_sorted[: min(8, len(pop_sorted))]
    for chain, fit, _n in top:
        weight = max(0.1, float(fit))
        for a in chain:
            bias[a] += weight
    if bias.max() > 0:
        bias = bias / bias.max()
    return bias


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--geneva-ckpt", required=True)
    ap.add_argument("--episodes", type=int, default=3000)
    ap.add_argument("--rollout-len", type=int, default=256)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--target-sni", default="www.twitter.com")
    ap.add_argument("--isp-profile", default="mci")
    ap.add_argument("--logdir", required=True)
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--bias-strength", type=float, default=3.0)
    args = ap.parse_args()

    Path(args.logdir).mkdir(parents=True, exist_ok=True)
    Path(args.logdir, "checkpoints").mkdir(exist_ok=True)
    log_fh = open(Path(args.logdir, "log.jsonl"), "w", buffering=1)

    env = IrgfwEnv(target_ip=args.target_ip, target_sni=args.target_sni,
                   isp_profile=args.isp_profile, campaign_length=50)
    obs_dim = env.observation_space.shape[0]; n_actions = env.action_space.n

    # Build PPO and inject Geneva bias into the actor head
    device = f"cuda:{args.gpu}" if args.gpu >= 0 else "cpu"
    agent = PPODistillAgent(obs_dim, n_actions, device=device)
    bias = extract_geneva_action_bias(Path(args.geneva_ckpt), n_actions)
    print("[distill] Geneva top-action bias (top 5):")
    top_idx = np.argsort(bias)[::-1][:5]
    from rlagent.envs import mutations
    names = mutations.names()
    for a in top_idx:
        print(f"  action {a:2d} bias={bias[a]:.2f}  {names[a]}")
    bias_actor_toward(agent, bias, strength=args.bias_strength)

    # Standard PPO loop
    import time
    obs, _ = env.reset()
    bypass = 0; rolling = []; t0 = time.time(); cum_r = 0.0
    for step in range(1, args.episodes + 1):
        action = agent.act(obs)
        next_obs, r, done, trunc, info = env.step(action)
        cum_r += r
        agent.record_step(r, done or trunc)
        if agent.has_rollout(args.rollout_len):
            agent.update_with_rollout(next_obs)
        v = info["verdict_id"]
        rolling.append(1 if v in (0, 1) else 0)
        if v in (0, 1): bypass += 1
        if len(rolling) > 1000: rolling.pop(0)
        log_fh.write(json.dumps({
            "step": step, "verdict": VERDICT_NAMES[v],
            "plan": info.get("plan_name"), "action_id": info.get("action_id"),
            "elapsed_ms": info.get("elapsed_ms", 0.0),
            "reward": r, "cumulative_reward": cum_r,
        }) + "\n")
        if step % 1000 == 0:
            print(f"[distill] step={step} bypass_rate_1k={np.mean(rolling):.3f} "
                  f"cum_r={cum_r:.1f} elapsed={time.time()-t0:.0f}s")
        if done or trunc:
            obs, _ = env.reset()
        else:
            obs = next_obs

    # Save final checkpoint
    import torch
    torch.save(agent.state_dict(), Path(args.logdir, "checkpoints", "final.pt"))

    summary = {
        "agent": "ppo_distill",
        "isp_profile": args.isp_profile,
        "target_sni": args.target_sni,
        "episodes_run": args.episodes,
        "wall_time_s": time.time() - t0,
        "total_bypass": bypass,
        "bypass_rate": bypass / max(1, args.episodes),
        "rolling_bypass_rate_last_1000": float(np.mean(rolling)) if rolling else 0.0,
        "cumulative_reward": cum_r,
        "geneva_ckpt": args.geneva_ckpt,
        "bias_strength": args.bias_strength,
    }
    with open(Path(args.logdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"[distill] DONE.  bypass_rate_last_1k={summary['rolling_bypass_rate_last_1000']:.3f}")


if __name__ == "__main__":
    main()
