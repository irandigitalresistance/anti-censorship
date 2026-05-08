"""rlagent/agents/ppo_distill.py

PPO whose actor head is *biased* at initialisation toward the top-K
actions discovered by a previously-run Geneva training. This is a
cheap form of behavioural distillation: instead of imitation-learning
on full trajectories, we set the actor's logits so that initial action
sampling has high mass on the chains Geneva evolved as best.

After this initialisation, standard PPO takes over.
"""
from __future__ import annotations
import numpy as np
import torch

from .ppo import PPOAgent


def bias_actor_toward(agent: PPOAgent, action_logits_bias: np.ndarray,
                      strength: float = 3.0) -> None:
    """Add `strength * action_logits_bias` to the actor's output bias.

    Usage:
        bias = np.zeros(n_actions)
        bias[geneva_top_actions] = 1.0
        bias_actor_toward(ppo, bias, strength=3.0)
    """
    with torch.no_grad():
        b = torch.from_numpy(action_logits_bias.astype(np.float32) * strength).to(
            agent.net.actor.weight.device)
        agent.net.actor.bias += b


class PPODistillAgent(PPOAgent):
    name = "ppo_distill"
