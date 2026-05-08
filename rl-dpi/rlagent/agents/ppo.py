"""PPO with a categorical policy over the discrete action catalogue.

Single-file cleanrl-style. Collects rollouts, computes GAE, runs a few
epochs of clipped PPO. Wired so a `Trainer` can call `act()` and
`update_with_rollout()` without owning any torch state itself.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def _layer_init(layer: nn.Module, std: float = np.sqrt(2),
                bias_const: float = 0.0) -> nn.Module:
    nn.init.orthogonal_(layer.weight, std)
    nn.init.constant_(layer.bias, bias_const)
    return layer


class _ActorCritic(nn.Module):
    def __init__(self, obs_dim: int, n_actions: int, hidden: int = 256) -> None:
        super().__init__()
        self.shared = nn.Sequential(
            _layer_init(nn.Linear(obs_dim, hidden)), nn.Tanh(),
            _layer_init(nn.Linear(hidden, hidden)), nn.Tanh(),
        )
        self.actor = _layer_init(nn.Linear(hidden, n_actions), std=0.01)
        self.critic = _layer_init(nn.Linear(hidden, 1), std=1.0)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.shared(x)
        return self.actor(h), self.critic(h).squeeze(-1)


@dataclass
class _Rollout:
    obs:     list[np.ndarray]
    acts:    list[int]
    logps:   list[float]
    rews:    list[float]
    vals:    list[float]
    dones:   list[bool]


class PPOAgent:
    name = "ppo"

    def __init__(self, obs_dim: int, n_actions: int,
                 device: str = "cuda", lr: float = 3e-4,
                 gamma: float = 0.95, gae_lambda: float = 0.95,
                 clip_coef: float = 0.2, ent_coef: float = 0.01,
                 vf_coef: float = 0.5, n_epochs: int = 4,
                 minibatch_size: int = 256, seed: int = 0) -> None:
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        torch.manual_seed(seed); np.random.seed(seed)

        self.net = _ActorCritic(obs_dim, n_actions).to(self.device)
        self.opt = torch.optim.Adam(self.net.parameters(), lr=lr)
        self.gamma = gamma; self.gae_lambda = gae_lambda
        self.clip_coef = clip_coef; self.ent_coef = ent_coef; self.vf_coef = vf_coef
        self.n_epochs = n_epochs; self.mb = minibatch_size
        self._roll = _Rollout([], [], [], [], [], [])

    def _policy(self, obs: np.ndarray) -> tuple[int, float, float]:
        with torch.no_grad():
            t = torch.from_numpy(obs).float().unsqueeze(0).to(self.device)
            logits, value = self.net(t)
            dist = torch.distributions.Categorical(logits=logits)
            a = dist.sample()
            return int(a.item()), float(dist.log_prob(a).item()), float(value.item())

    def act(self, obs: np.ndarray) -> int:
        a, logp, v = self._policy(obs)
        # Stash rollout slot for the trainer to fill in (rew, done) post-step.
        self._roll.obs.append(obs.astype(np.float32))
        self._roll.acts.append(a)
        self._roll.logps.append(logp)
        self._roll.vals.append(v)
        return a

    def record_step(self, reward: float, done: bool) -> None:
        self._roll.rews.append(reward)
        self._roll.dones.append(done)

    def has_rollout(self, n: int) -> bool:
        return len(self._roll.obs) >= n

    def update_with_rollout(self, last_obs: np.ndarray) -> dict:
        if not self._roll.rews:
            return {}
        # Bootstrap last value
        with torch.no_grad():
            t = torch.from_numpy(last_obs).float().unsqueeze(0).to(self.device)
            _, last_val = self.net(t)
            last_val = float(last_val.item())

        rews = np.asarray(self._roll.rews, dtype=np.float32)
        vals = np.asarray(self._roll.vals + [last_val], dtype=np.float32)
        dones = np.asarray(self._roll.dones, dtype=np.float32)

        # GAE
        adv = np.zeros_like(rews)
        last = 0.0
        for t in reversed(range(len(rews))):
            nonterm = 1.0 - dones[t]
            delta = rews[t] + self.gamma * vals[t + 1] * nonterm - vals[t]
            last = delta + self.gamma * self.gae_lambda * nonterm * last
            adv[t] = last
        ret = adv + np.asarray(self._roll.vals, dtype=np.float32)

        obs_t = torch.from_numpy(np.stack(self._roll.obs)).to(self.device)
        act_t = torch.tensor(self._roll.acts, dtype=torch.long, device=self.device)
        logp_t = torch.tensor(self._roll.logps, dtype=torch.float32, device=self.device)
        adv_t = torch.tensor(adv, dtype=torch.float32, device=self.device)
        ret_t = torch.tensor(ret, dtype=torch.float32, device=self.device)
        adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)

        n = len(rews); idx = np.arange(n)
        losses = []
        for _ in range(self.n_epochs):
            np.random.shuffle(idx)
            for s in range(0, n, self.mb):
                mb = idx[s:s + self.mb]
                logits, vals_pred = self.net(obs_t[mb])
                dist = torch.distributions.Categorical(logits=logits)
                new_logp = dist.log_prob(act_t[mb])
                ratio = (new_logp - logp_t[mb]).exp()
                surr1 = ratio * adv_t[mb]
                surr2 = torch.clamp(ratio, 1 - self.clip_coef, 1 + self.clip_coef) * adv_t[mb]
                pg_loss = -torch.min(surr1, surr2).mean()
                vf_loss = F.mse_loss(vals_pred, ret_t[mb])
                ent = dist.entropy().mean()
                loss = pg_loss + self.vf_coef * vf_loss - self.ent_coef * ent
                self.opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), 0.5)
                self.opt.step()
                losses.append(float(loss.item()))

        self._roll = _Rollout([], [], [], [], [], [])
        return {"loss": float(np.mean(losses)) if losses else 0.0}

    def state_dict(self) -> dict:
        return {"net": self.net.state_dict()}

    def load_state_dict(self, sd: dict) -> None:
        self.net.load_state_dict(sd["net"])
