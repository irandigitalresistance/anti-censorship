"""PPO with a parametric action space:
   * Discrete head over `mutations.CATALOG`
   * Continuous head over (split_offset_norm, delay_ms_norm, padding_bytes_norm,
     decoy_count_norm) — these *modify* the chosen mutation when applicable.

The continuous outputs are mapped to ranges in `apply_param_overrides()`,
which the trainer calls before passing the plan to the environment.

Hypothesised best agent: discrete picks the mutation family, continuous
fine-tunes it.
"""
from __future__ import annotations
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

N_PARAMS = 4


def _layer_init(layer, std=np.sqrt(2), bias=0.0):
    nn.init.orthogonal_(layer.weight, std)
    nn.init.constant_(layer.bias, bias)
    return layer


class _ParamActorCritic(nn.Module):
    def __init__(self, obs_dim: int, n_actions: int, hidden: int = 256) -> None:
        super().__init__()
        self.shared = nn.Sequential(
            _layer_init(nn.Linear(obs_dim, hidden)), nn.Tanh(),
            _layer_init(nn.Linear(hidden, hidden)), nn.Tanh(),
        )
        self.actor_disc = _layer_init(nn.Linear(hidden, n_actions), std=0.01)
        self.actor_cont_mu  = _layer_init(nn.Linear(hidden, N_PARAMS), std=0.01)
        self.actor_cont_log_std = nn.Parameter(torch.zeros(N_PARAMS) - 0.5)
        self.critic = _layer_init(nn.Linear(hidden, 1), std=1.0)

    def forward(self, x):
        h = self.shared(x)
        return (self.actor_disc(h),
                self.actor_cont_mu(h),
                self.actor_cont_log_std.exp().expand_as(self.actor_cont_mu(h)),
                self.critic(h).squeeze(-1))


def apply_param_overrides(plan, params: np.ndarray):
    """Overlay the continuous params onto the chosen plan in-place.

    params[0]: split-offset multiplier in [0,1] → maps to byte index
               (only takes effect when there is a single chunk; otherwise
               the discrete head already chose a split).
    params[1]: inter-segment delay in [0, 500] ms
    params[2]: pre-connect-byte toggle in [0,1] (>=0.5 enables)
    params[3]: number of decoy clean-SNI CHs prepended in [0, 3]

    All overrides preserve byte-stream validity — no insertion of raw
    bytes inside an in-progress TLS record. Earlier versions broke this
    invariant; PPO-param promptly learned to spam params that produced
    malformed handshakes and eat 3s timeouts.
    """
    from ..envs import mutations

    p = np.clip(params, 0.0, 1.0)
    delay_ms   = int(p[1] * 500)
    decoys     = int(round(p[3] * 3))
    if delay_ms > 0:
        plan.delay_between_ms = delay_ms
    if p[2] >= 0.5:
        plan.pre_connect_byte = True
    if decoys > 0 and len(plan.chunks) > 0:
        clean = mutations.build_clienthello("www.google.com")
        plan.chunks = [clean] * decoys + plan.chunks
    if len(plan.chunks) == 1 and p[0] > 0.05:
        first = plan.chunks[0]
        idx = max(1, min(len(first) - 1, int(len(first) * p[0])))
        plan.chunks = [first[:idx], first[idx:]]
    return plan


class PPOParamAgent:
    name = "ppo_param"

    def __init__(self, obs_dim: int, n_actions: int,
                 device: str = "cuda", lr: float = 3e-4,
                 gamma: float = 0.95, gae_lambda: float = 0.95,
                 clip_coef: float = 0.2, ent_coef: float = 0.01,
                 vf_coef: float = 0.5, n_epochs: int = 4,
                 minibatch_size: int = 256, seed: int = 0) -> None:
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        torch.manual_seed(seed); np.random.seed(seed)

        self.net = _ParamActorCritic(obs_dim, n_actions).to(self.device)
        self.opt = torch.optim.Adam(self.net.parameters(), lr=lr)
        self.gamma = gamma; self.gae_lambda = gae_lambda
        self.clip_coef = clip_coef; self.ent_coef = ent_coef; self.vf_coef = vf_coef
        self.n_epochs = n_epochs; self.mb = minibatch_size
        self._roll = {"obs": [], "act_disc": [], "act_cont": [],
                      "logp_disc": [], "logp_cont": [],
                      "rews": [], "vals": [], "dones": []}

    def act(self, obs: np.ndarray) -> tuple[int, np.ndarray]:
        with torch.no_grad():
            t = torch.from_numpy(obs).float().unsqueeze(0).to(self.device)
            logits, mu, std, value = self.net(t)
            dist_d = torch.distributions.Categorical(logits=logits)
            ad = dist_d.sample()
            dist_c = torch.distributions.Normal(mu, std)
            ac = dist_c.sample().clamp(-2.0, 2.0)
            params = torch.sigmoid(ac).squeeze(0).cpu().numpy()
            self._roll["obs"].append(obs.astype(np.float32))
            self._roll["act_disc"].append(int(ad.item()))
            self._roll["act_cont"].append(ac.squeeze(0).cpu().numpy())
            self._roll["logp_disc"].append(float(dist_d.log_prob(ad).item()))
            self._roll["logp_cont"].append(float(dist_c.log_prob(ac).sum(-1).item()))
            self._roll["vals"].append(float(value.item()))
            return int(ad.item()), params

    def record_step(self, reward: float, done: bool) -> None:
        self._roll["rews"].append(reward); self._roll["dones"].append(done)

    def has_rollout(self, n: int) -> bool:
        return len(self._roll["obs"]) >= n

    def update_with_rollout(self, last_obs: np.ndarray) -> dict:
        if not self._roll["rews"]:
            return {}
        with torch.no_grad():
            t = torch.from_numpy(last_obs).float().unsqueeze(0).to(self.device)
            _, _, _, last_val = self.net(t)
            last_val = float(last_val.item())

        rews = np.asarray(self._roll["rews"], dtype=np.float32)
        vals = np.asarray(self._roll["vals"] + [last_val], dtype=np.float32)
        dones = np.asarray(self._roll["dones"], dtype=np.float32)

        adv = np.zeros_like(rews); last = 0.0
        for t in reversed(range(len(rews))):
            nonterm = 1.0 - dones[t]
            delta = rews[t] + self.gamma * vals[t + 1] * nonterm - vals[t]
            last = delta + self.gamma * self.gae_lambda * nonterm * last
            adv[t] = last
        ret = adv + np.asarray(self._roll["vals"], dtype=np.float32)

        obs_t = torch.from_numpy(np.stack(self._roll["obs"])).to(self.device)
        ad_t = torch.tensor(self._roll["act_disc"], dtype=torch.long, device=self.device)
        ac_t = torch.from_numpy(np.stack(self._roll["act_cont"])).to(self.device)
        ld_t = torch.tensor(self._roll["logp_disc"], dtype=torch.float32, device=self.device)
        lc_t = torch.tensor(self._roll["logp_cont"], dtype=torch.float32, device=self.device)
        adv_t = torch.tensor(adv, dtype=torch.float32, device=self.device)
        ret_t = torch.tensor(ret, dtype=torch.float32, device=self.device)
        adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)

        n = len(rews); idx = np.arange(n)
        losses = []
        for _ in range(self.n_epochs):
            np.random.shuffle(idx)
            for s in range(0, n, self.mb):
                mb = idx[s:s + self.mb]
                logits, mu, std, vp = self.net(obs_t[mb])
                dd = torch.distributions.Categorical(logits=logits)
                dc = torch.distributions.Normal(mu, std)
                new_ld = dd.log_prob(ad_t[mb])
                new_lc = dc.log_prob(ac_t[mb]).sum(-1)
                logr = (new_ld - ld_t[mb]) + (new_lc - lc_t[mb])
                ratio = logr.exp()
                surr1 = ratio * adv_t[mb]
                surr2 = torch.clamp(ratio, 1 - self.clip_coef, 1 + self.clip_coef) * adv_t[mb]
                pg = -torch.min(surr1, surr2).mean()
                vf = F.mse_loss(vp, ret_t[mb])
                ent = dd.entropy().mean() + dc.entropy().sum(-1).mean()
                loss = pg + self.vf_coef * vf - self.ent_coef * ent
                self.opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), 0.5)
                self.opt.step()
                losses.append(float(loss.item()))

        for k in self._roll: self._roll[k] = []
        return {"loss": float(np.mean(losses)) if losses else 0.0}

    def state_dict(self) -> dict:
        return {"net": self.net.state_dict()}

    def load_state_dict(self, sd: dict) -> None:
        self.net.load_state_dict(sd["net"])
