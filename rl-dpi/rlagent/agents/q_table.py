"""Tabular Q-learning. Bridges UCB1 → state-conditional. We hash a coarse
projection of the observation into a discrete bucket so the table stays
small."""
from __future__ import annotations
from collections import defaultdict
import numpy as np


def _bucket_obs(obs: np.ndarray) -> tuple:
    """Coarse 6-feature bucket of the 65-dim obs:
       (last_verdict, racing_budget_band, graylist_band, isp_idx,
        campaign_band, sni_first_char_band)."""
    last_verdict = -1
    for i in range(9, -1, -1):
        slice_ = obs[i*4:(i+1)*4]
        if slice_.sum() > 0:
            last_verdict = int(np.argmax(slice_)); break
    racing = int(min(3, obs[40] * 4))
    graylist = int(min(3, obs[41] * 4))
    isp_idx = int(np.argmax(obs[58:63]))
    campaign = int(min(4, obs[63] * 5))
    sni_first = int(min(7, obs[42] * 8)) if obs[42] > 0 else 0
    return (last_verdict, racing, graylist, isp_idx, campaign, sni_first)


class QTableAgent:
    name = "qtable"

    def __init__(self, n_actions: int, alpha: float = 0.2, gamma: float = 0.9,
                 epsilon: float = 0.1, seed: int = 0) -> None:
        self.n_actions = n_actions
        self.alpha = alpha
        self.gamma = gamma
        self.epsilon = epsilon
        self.rng = np.random.default_rng(seed)
        self.Q: dict[tuple, np.ndarray] = defaultdict(lambda: np.zeros(n_actions))

    def act(self, obs: np.ndarray) -> int:
        if self.rng.random() < self.epsilon:
            return int(self.rng.integers(self.n_actions))
        return int(np.argmax(self.Q[_bucket_obs(obs)]))

    def update(self, obs, action, reward, next_obs, done) -> None:
        s = _bucket_obs(obs)
        sn = _bucket_obs(next_obs)
        target = reward + (0.0 if done else self.gamma * float(np.max(self.Q[sn])))
        self.Q[s][action] += self.alpha * (target - self.Q[s][action])

    def state_dict(self) -> dict:
        return {"Q": dict(self.Q), "alpha": self.alpha, "gamma": self.gamma,
                "epsilon": self.epsilon}

    def load_state_dict(self, sd: dict) -> None:
        self.Q = defaultdict(lambda: np.zeros(self.n_actions))
        for k, v in sd["Q"].items():
            self.Q[k] = v
