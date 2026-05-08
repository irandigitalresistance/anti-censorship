"""Random-action baseline. Floor of the agent zoo (E1)."""
from __future__ import annotations
import numpy as np


class RandomAgent:
    name = "random"

    def __init__(self, n_actions: int, seed: int = 0) -> None:
        self.n_actions = n_actions
        self.rng = np.random.default_rng(seed)

    def act(self, obs: np.ndarray) -> int:
        return int(self.rng.integers(self.n_actions))

    def update(self, obs, action, reward, next_obs, done) -> None:
        pass

    def state_dict(self) -> dict:
        return {}

    def load_state_dict(self, sd: dict) -> None:
        pass
