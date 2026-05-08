"""rlagent/agents/ensemble.py

Heterogeneous ensemble: load N trained agents, each votes its top-3
actions per state; sum votes, argmax. No retraining; pure inference-time
combination.

Hypothesis: averaging out the per-agent biases (UCB1's stationary pick,
Q-table's overfitting, Geneva's chain preference, DQN's Q-error,
PPO's policy variance) yields a policy that beats any single one on the
transferability matrix.
"""
from __future__ import annotations
from collections import Counter
from pathlib import Path

import numpy as np


class EnsembleAgent:
    name = "ensemble"

    def __init__(self, n_actions: int, members: list, top_k: int = 3) -> None:
        """`members` is a list of already-loaded agent objects."""
        self.n_actions = n_actions
        self.members = members
        self.top_k = top_k

    def _candidates(self, member, obs: np.ndarray) -> list[int]:
        """Return the member's top-K preferred actions."""
        # Heterogeneous: pick a small number of likely choices per agent.
        if hasattr(member, "values") and hasattr(member, "counts"):
            # UCB1 — pick top-K by value. If no action has been tried, abstain.
            if int(member.counts.sum()) == 0:
                return []
            scores = member.values
            return list(np.argsort(scores)[::-1][: self.top_k])
        if hasattr(member, "Q"):
            # Q-table — bucket the obs and pick top-K. If the bucket is
            # unknown (all-zero Q values from defaultdict default), abstain
            # rather than vote for actions [0, 1, 2] which would pollute
            # the ensemble.
            from .q_table import _bucket_obs
            scores = member.Q[_bucket_obs(obs)]
            if float(np.max(np.abs(scores))) < 1e-6:
                return []          # abstain
            return list(np.argsort(scores)[::-1][: self.top_k])
        if hasattr(member, "q") and hasattr(member.q, "forward"):
            # DQN
            import torch
            with torch.no_grad():
                t = torch.from_numpy(obs).float().unsqueeze(0).to(
                    next(member.q.parameters()).device)
                qv = member.q(t).squeeze(0).cpu().numpy()
            return list(np.argsort(qv)[::-1][: self.top_k])
        if hasattr(member, "net") and hasattr(member.net, "forward"):
            # PPO categorical
            import torch
            with torch.no_grad():
                t = torch.from_numpy(obs).float().unsqueeze(0).to(
                    next(member.net.parameters()).device)
                out = member.net(t)
                logits = out[0] if isinstance(out, tuple) else out
                probs = torch.softmax(logits, dim=-1).squeeze(0).cpu().numpy()
            return list(np.argsort(probs)[::-1][: self.top_k])
        if hasattr(member, "best"):
            # Geneva — best individual's chain
            best = member.best()
            return list(best.chain[: self.top_k]) or [0]
        # Random fallback
        return [int(np.random.randint(self.n_actions))]

    def act(self, obs: np.ndarray) -> int:
        votes = Counter()
        for m in self.members:
            try:
                top = self._candidates(m, obs)
            except Exception:
                continue
            # weighted votes: 3, 2, 1 for top-3
            for rank, a in enumerate(top):
                votes[int(a)] += self.top_k - rank
        if not votes:
            return 0
        return votes.most_common(1)[0][0]

    def update(self, *args, **kwargs) -> None:
        pass

    def state_dict(self) -> dict:
        return {}

    def load_state_dict(self, sd: dict) -> None:
        pass
