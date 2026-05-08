"""DQN with a small MLP. cleanrl single-file idiom."""
from __future__ import annotations
import random
from collections import deque

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class _MLPQ(nn.Module):
    def __init__(self, obs_dim: int, n_actions: int, hidden: int = 256) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(obs_dim, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
            nn.Linear(hidden, n_actions),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class DQNAgent:
    name = "dqn"

    def __init__(self, obs_dim: int, n_actions: int,
                 device: str = "cuda", lr: float = 5e-4, gamma: float = 0.95,
                 buffer_size: int = 100_000, batch_size: int = 256,
                 epsilon_start: float = 1.0, epsilon_end: float = 0.05,
                 epsilon_decay_steps: int = 200_000,
                 target_update_freq: int = 1000,
                 seed: int = 0) -> None:
        self.obs_dim = obs_dim
        self.n_actions = n_actions
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        torch.manual_seed(seed); np.random.seed(seed); random.seed(seed)

        self.q       = _MLPQ(obs_dim, n_actions).to(self.device)
        self.q_targ  = _MLPQ(obs_dim, n_actions).to(self.device)
        self.q_targ.load_state_dict(self.q.state_dict())
        self.opt = torch.optim.Adam(self.q.parameters(), lr=lr)

        self.gamma = gamma
        self.batch_size = batch_size
        self.buffer: deque = deque(maxlen=buffer_size)

        self.eps_start = epsilon_start
        self.eps_end = epsilon_end
        self.eps_decay_steps = epsilon_decay_steps
        self.target_update_freq = target_update_freq
        self._step = 0

    @property
    def epsilon(self) -> float:
        f = min(1.0, self._step / self.eps_decay_steps)
        return self.eps_start + (self.eps_end - self.eps_start) * f

    def act(self, obs: np.ndarray) -> int:
        self._step += 1
        if random.random() < self.epsilon:
            return random.randint(0, self.n_actions - 1)
        with torch.no_grad():
            t = torch.from_numpy(obs).float().unsqueeze(0).to(self.device)
            return int(self.q(t).argmax(dim=1).item())

    def update(self, obs, action, reward, next_obs, done) -> float:
        self.buffer.append((obs.astype(np.float32), int(action), float(reward),
                            next_obs.astype(np.float32), bool(done)))
        if len(self.buffer) < self.batch_size:
            return 0.0
        batch = random.sample(self.buffer, self.batch_size)
        obs_b      = torch.from_numpy(np.stack([b[0] for b in batch])).to(self.device)
        act_b      = torch.tensor([b[1] for b in batch], dtype=torch.long, device=self.device)
        rew_b      = torch.tensor([b[2] for b in batch], dtype=torch.float32, device=self.device)
        nobs_b     = torch.from_numpy(np.stack([b[3] for b in batch])).to(self.device)
        done_b     = torch.tensor([b[4] for b in batch], dtype=torch.float32, device=self.device)

        with torch.no_grad():
            target = rew_b + (1 - done_b) * self.gamma * self.q_targ(nobs_b).max(dim=1).values
        pred = self.q(obs_b).gather(1, act_b.unsqueeze(1)).squeeze(1)
        loss = F.smooth_l1_loss(pred, target)

        self.opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.q.parameters(), 5.0)
        self.opt.step()

        if self._step % self.target_update_freq == 0:
            self.q_targ.load_state_dict(self.q.state_dict())

        return float(loss.item())

    def state_dict(self) -> dict:
        return {"q": self.q.state_dict(), "step": self._step}

    def load_state_dict(self, sd: dict) -> None:
        self.q.load_state_dict(sd["q"])
        self.q_targ.load_state_dict(sd["q"])
        self._step = sd.get("step", 0)
