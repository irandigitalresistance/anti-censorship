"""rlagent/train/train.py

Unified training driver for every agent in the zoo. Handles the rollout
loop, per-agent update cadence, tensorboard logging, checkpointing.

Usage (inside the client container):

    python -m rlagent.train.train \\
        --agent ppo_param \\
        --episodes 200000 \\
        --target-ip 10.0.2.2 \\
        --target-sni www.twitter.com \\
        --isp-profile mci \\
        --logdir runs/ppo_param-mci \\
        --gpu 0

Each run writes:
    runs/<name>/log.jsonl              per-step JSON log
    runs/<name>/tensorboard/           torch tensorboard
    runs/<name>/checkpoints/<step>.pt  every checkpoint_freq steps
    runs/<name>/summary.json           final aggregated metrics
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np

# torch is optional for non-DL agents; lazy-import below
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from rlagent.envs.irgfw_gym import IrgfwEnv, VERDICT_NAMES
from rlagent.envs import mutations
from rlagent.agents.random_agent import RandomAgent
from rlagent.agents.bandit       import UCB1Agent
from rlagent.agents.q_table      import QTableAgent
from rlagent.agents.geneva       import GenevaAgent


def _build_agent(name: str, obs_dim: int, n_actions: int, gpu: int, seed: int):
    if name == "random":
        return RandomAgent(n_actions, seed=seed)
    if name == "ucb1":
        return UCB1Agent(n_actions, seed=seed)
    if name == "qtable":
        return QTableAgent(n_actions, seed=seed)
    if name == "geneva":
        return GenevaAgent(n_actions, seed=seed)
    if name == "ppo_mixed":
        from rlagent.agents.ppo_mixed import PPOMixedAgent
        device = f"cuda:{gpu}" if gpu >= 0 else "cpu"
        return PPOMixedAgent(obs_dim, n_actions, device=device, seed=seed)
    if name == "ppo_distill":
        from rlagent.agents.ppo_distill import PPODistillAgent
        device = f"cuda:{gpu}" if gpu >= 0 else "cpu"
        return PPODistillAgent(obs_dim, n_actions, device=device, seed=seed)
    if name == "dqn":
        from rlagent.agents.dqn import DQNAgent
        device = f"cuda:{gpu}" if gpu >= 0 else "cpu"
        return DQNAgent(obs_dim, n_actions, device=device, seed=seed)
    if name == "ppo":
        from rlagent.agents.ppo import PPOAgent
        device = f"cuda:{gpu}" if gpu >= 0 else "cpu"
        return PPOAgent(obs_dim, n_actions, device=device, seed=seed)
    if name == "ppo_param":
        from rlagent.agents.ppo_param import PPOParamAgent
        device = f"cuda:{gpu}" if gpu >= 0 else "cpu"
        return PPOParamAgent(obs_dim, n_actions, device=device, seed=seed)
    if name == "ppo_transformer":
        from rlagent.agents.ppo_transformer import PPOTransformerAgent
        device = f"cuda:{gpu}" if gpu >= 0 else "cpu"
        return PPOTransformerAgent(obs_dim, device=device, seed=seed)
    raise ValueError(f"unknown agent: {name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True,
                    choices=["random", "ucb1", "qtable", "dqn",
                             "ppo", "ppo_param", "ppo_transformer", "geneva"])
    ap.add_argument("--episodes", type=int, default=100_000)
    ap.add_argument("--target-ip", default="10.0.2.2")
    ap.add_argument("--target-port", type=int, default=443)
    ap.add_argument("--target-sni", default="www.twitter.com")
    ap.add_argument("--clean-sni",  default="www.google.com")
    ap.add_argument("--isp-profile", default="mci")
    ap.add_argument("--campaign-length", type=int, default=50)
    ap.add_argument("--rollout-len", type=int, default=2048,
                    help="PPO rollout length")
    ap.add_argument("--checkpoint-freq", type=int, default=50_000)
    ap.add_argument("--logdir", required=True)
    ap.add_argument("--gpu", type=int, default=-1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-wall-time-s", type=int, default=24 * 3600)
    ap.add_argument("--resume", default=None,
                    help="Path to a previous checkpoint to load before training")
    ap.add_argument("--mask-obs", default="",
                    help="Comma-separated obs slices to mask: "
                         "history (0-40), racing (40-41), graylist (41-42), "
                         "sni (42-58), isp (58-63), campaign (63-65)")
    args = ap.parse_args()

    OBS_SLICES = {
        "history":  (0, 40, "history"),
        "racing":   (40, 41, "racing"),
        "graylist": (41, 42, "graylist"),
        "sni":      (42, 58, "sni"),
        "isp":      (58, 63, "isp"),
        "campaign": (63, 65, "campaign"),
    }
    masks = []
    if args.mask_obs:
        for m in args.mask_obs.split(","):
            m = m.strip()
            if m and m in OBS_SLICES:
                masks.append(OBS_SLICES[m])
            elif m:
                raise SystemExit(f"unknown mask slice: {m}")

    Path(args.logdir).mkdir(parents=True, exist_ok=True)
    Path(args.logdir, "checkpoints").mkdir(exist_ok=True)
    log_fh = open(Path(args.logdir, "log.jsonl"), "w", buffering=1)

    env = IrgfwEnv(
        target_ip=args.target_ip,
        target_port=args.target_port,
        target_sni=args.target_sni,
        clean_sni=args.clean_sni,
        isp_profile=args.isp_profile,
        campaign_length=args.campaign_length,
        mask_obs_slices=tuple(masks),
    )
    obs_dim = env.observation_space.shape[0]
    n_actions = env.action_space.n
    agent = _build_agent(args.agent, obs_dim, n_actions, args.gpu, args.seed)

    if args.resume:
        print(f"[train] resuming from {args.resume}")
        try:
            import torch
            agent.load_state_dict(torch.load(args.resume, map_location="cpu"))
        except Exception:
            import pickle
            with open(args.resume, "rb") as f:
                agent.load_state_dict(pickle.load(f))

    print(f"[train] agent={args.agent} obs_dim={obs_dim} n_actions={n_actions} "
          f"target={args.target_ip}:{args.target_port} sni={args.target_sni} "
          f"profile={args.isp_profile}")

    obs, _ = env.reset()
    bypass_count = 0
    rst_count = 0
    timeout_count = 0
    rolling_bypass = []
    t0 = time.time()
    last_ckpt_at = 0
    cumulative_reward = 0.0

    for step in range(1, args.episodes + 1):
        # --- act ---
        if args.agent == "ppo_transformer":
            byte_seq = agent.act(obs)
            # Bypass the catalogue: send the raw bytes directly. Build a
            # one-shot Plan with that exact byte sequence.
            from rlagent.envs.mutations import Plan
            plan = Plan(chunks=[byte_seq], name="transformer_byte_policy", cost=1.0)
            from rlagent.envs.irgfw_gym import _send_plan
            verdict, elapsed_ms = _send_plan(env.target_ip, env.target_port, plan)
            # We need to translate this into a step + reward by hand because
            # we bypassed env.step.
            from rlagent.envs.irgfw_gym import VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT, VERDICT_RST, VERDICT_TIMEOUT
            r = 0.0
            if verdict in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
                r += 1.0
            elif verdict == VERDICT_RST:
                r -= 1.0
            elif verdict == VERDICT_TIMEOUT:
                r -= 0.5
            else:
                r -= 0.2
            r -= 0.05 * (elapsed_ms / 100.0)
            agent.record_step(r, done=True)
            next_obs = obs
            done = True
            info = {"verdict_id": verdict, "elapsed_ms": elapsed_ms,
                    "plan_name": plan.name, "action_id": -1}
            cumulative_reward += r
            # Update once per rollout
            if step % 64 == 0:
                agent.update_with_rollout()
        elif args.agent == "geneva":
            action_first, chain = agent.act(obs)
            from rlagent.agents.geneva import _compose
            from rlagent.envs.irgfw_gym import _send_plan, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT, VERDICT_RST, VERDICT_TIMEOUT
            plan = _compose(chain, env.target_sni)
            verdict, elapsed_ms = _send_plan(env.target_ip, env.target_port, plan)
            r = 0.0
            if verdict in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT):
                r += 1.0
            elif verdict == VERDICT_RST:
                r -= 1.0
            elif verdict == VERDICT_TIMEOUT:
                r -= 0.5
            else:
                r -= 0.2
            r -= 0.05 * (elapsed_ms / 100.0)
            agent.update(obs, action_first, r, obs, done=True)
            cumulative_reward += r
            next_obs = obs; done = True
            info = {"verdict_id": verdict, "elapsed_ms": elapsed_ms,
                    "plan_name": plan.name, "action_id": action_first,
                    "chain": chain}
        elif args.agent == "ppo_param":
            action_id, params = agent.act(obs)
            plan = mutations.get(int(action_id), env.target_sni)
            from rlagent.agents.ppo_param import apply_param_overrides
            plan = apply_param_overrides(plan, params)
            from rlagent.envs.irgfw_gym import _send_plan, VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT, VERDICT_RST, VERDICT_TIMEOUT
            verdict, elapsed_ms = _send_plan(env.target_ip, env.target_port, plan)
            # piggyback gym for state-update bookkeeping
            r = 0.0
            if verdict in (VERDICT_SERVER_HELLO, VERDICT_TLS_ALERT): r += 1.0
            elif verdict == VERDICT_RST: r -= 1.0
            elif verdict == VERDICT_TIMEOUT: r -= 0.5
            else: r -= 0.2
            r -= 0.05 * (elapsed_ms / 100.0)
            env._history.push(verdict, elapsed_ms)
            env._connection_idx += 1
            done = env._connection_idx >= env.campaign_length
            agent.record_step(r, done)
            cumulative_reward += r
            next_obs = env._observation()
            info = {"verdict_id": verdict, "elapsed_ms": elapsed_ms,
                    "plan_name": plan.name, "action_id": int(action_id)}
            if agent.has_rollout(args.rollout_len):
                agent.update_with_rollout(next_obs)
        elif args.agent == "ppo":
            action = agent.act(obs)
            next_obs, r, done, trunc, info = env.step(action)
            cumulative_reward += r
            agent.record_step(r, done or trunc)
            if agent.has_rollout(args.rollout_len):
                agent.update_with_rollout(next_obs)
            done = done or trunc
        else:                           # random / ucb1 / qtable / dqn
            action = agent.act(obs)
            next_obs, r, done, trunc, info = env.step(action)
            cumulative_reward += r
            agent.update(obs, action, r, next_obs, done or trunc)
            done = done or trunc

        # --- bookkeeping ---
        verdict_id = info["verdict_id"]
        elapsed_ms = info.get("elapsed_ms", 0.0)
        if verdict_id in (0, 1):
            bypass_count += 1
            rolling_bypass.append(1)
        elif verdict_id == 2:
            rst_count += 1
            rolling_bypass.append(0)
        elif verdict_id == 3:
            timeout_count += 1
            rolling_bypass.append(0)
        else:
            rolling_bypass.append(0)
        if len(rolling_bypass) > 1000:
            rolling_bypass.pop(0)

        log_fh.write(json.dumps({
            "step": step,
            "verdict": VERDICT_NAMES[verdict_id],
            "plan": info.get("plan_name"),
            "action_id": info.get("action_id"),
            "elapsed_ms": elapsed_ms,
            "reward": r,
            "cumulative_reward": cumulative_reward,
        }) + "\n")

        if step % 1000 == 0:
            rate = sum(rolling_bypass) / max(1, len(rolling_bypass))
            print(f"[train] step={step:>8d} bypass_rate_1k={rate:.3f} "
                  f"cum_r={cumulative_reward:.1f} "
                  f"elapsed={time.time()-t0:.0f}s")

        # --- reset ---
        if done:
            obs, _ = env.reset()
        else:
            obs = next_obs

        # checkpoints
        if step - last_ckpt_at >= args.checkpoint_freq:
            last_ckpt_at = step
            ckpt_path = Path(args.logdir, "checkpoints", f"{step:08d}.pt")
            try:
                import torch
                torch.save(agent.state_dict(), ckpt_path)
            except Exception:
                # Non-torch agents
                with open(ckpt_path, "wb") as f:
                    import pickle; pickle.dump(agent.state_dict(), f)

        if time.time() - t0 > args.max_wall_time_s:
            print(f"[train] hit wall-time limit at step={step}")
            break

    # --- always save a final checkpoint ---
    final_ckpt = Path(args.logdir, "checkpoints", f"final.pt")
    try:
        import torch
        torch.save(agent.state_dict(), final_ckpt)
    except Exception:
        with open(final_ckpt, "wb") as f:
            import pickle; pickle.dump(agent.state_dict(), f)

    # --- final summary ---
    summary = {
        "agent": args.agent,
        "isp_profile": args.isp_profile,
        "target_sni": args.target_sni,
        "episodes_run": step,
        "wall_time_s": time.time() - t0,
        "total_bypass": bypass_count,
        "total_rst": rst_count,
        "total_timeout": timeout_count,
        "bypass_rate": bypass_count / max(1, step),
        "rolling_bypass_rate_last_1000": sum(rolling_bypass) / max(1, len(rolling_bypass)),
        "cumulative_reward": cumulative_reward,
    }
    with open(Path(args.logdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"[train] DONE. summary -> {args.logdir}/summary.json")


if __name__ == "__main__":
    main()
