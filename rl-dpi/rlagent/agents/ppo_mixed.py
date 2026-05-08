"""rlagent/agents/ppo_mixed.py

PPO that trains on a *rotating* DPI profile: every K episodes, the host
script restarts the dpi container with a different profile. The agent
sees the ISP one-hot in its observation and must learn a policy that
generalises across profiles.

This module is structurally identical to `ppo.py` — no architectural
change to the agent itself. The novelty is the *training schedule*,
implemented in `scripts/train_ppo_mixed.sh`.
"""
from __future__ import annotations
from .ppo import PPOAgent


class PPOMixedAgent(PPOAgent):
    name = "ppo_mixed"
