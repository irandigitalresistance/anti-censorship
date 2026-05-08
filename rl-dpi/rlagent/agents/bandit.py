"""UCB1 multi-armed bandit. Strong stateless baseline; surfaces "which
single mutation is the most reliable bypass" without any state."""
from __future__ import annotations
import math

import numpy as np


class UCB1Agent:
    name = "ucb1"

    def __init__(self, n_actions: int, c: float = 1.4, seed: int = 0) -> None:
        self.n_actions = n_actions
        self.c = c
        self.counts = np.zeros(n_actions, dtype=np.int64)
        self.values = np.zeros(n_actions, dtype=np.float64)
        self.t = 0
        self.rng = np.random.default_rng(seed)

    def act(self, obs: np.ndarray) -> int:
        self.t += 1
        # Untried actions go first
        for a in range(self.n_actions):
            if self.counts[a] == 0:
                return a
        ucb = self.values + self.c * np.sqrt(np.log(self.t) / self.counts)
        return int(np.argmax(ucb))

    def update(self, obs, action, reward, next_obs, done) -> None:
        self.counts[action] += 1
        n = self.counts[action]
        self.values[action] += (reward - self.values[action]) / n

    def state_dict(self) -> dict:
        return {"counts": self.counts, "values": self.values, "t": self.t}

    def load_state_dict(self, sd: dict) -> None:
        self.counts = sd["counts"]; self.values = sd["values"]; self.t = sd["t"]
