"""Transformer byte-policy. Autoregressively emits the ClientHello byte
sequence; reward is the simulator's verdict after sending it.

This is the speculative novelty of the paper — letting RL discover
mutations *outside* the discrete catalogue. A small GPT-style decoder
(~5M params), trained with REINFORCE + entropy bonus + KL penalty
against the catalogue (so the policy doesn't collapse to a single
unhelpful sequence early on).
"""
from __future__ import annotations
import math
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


VOCAB = 257   # 256 byte values + EOS
EOS   = 256
MAX_LEN = 1024


class _Block(nn.Module):
    def __init__(self, d: int, n_heads: int, ff: int) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(d)
        self.attn = nn.MultiheadAttention(d, n_heads, batch_first=True)
        self.ln2 = nn.LayerNorm(d)
        self.mlp = nn.Sequential(nn.Linear(d, ff), nn.GELU(), nn.Linear(ff, d))

    def forward(self, x, mask):
        h = self.ln1(x)
        h, _ = self.attn(h, h, h, attn_mask=mask, need_weights=False)
        x = x + h
        x = x + self.mlp(self.ln2(x))
        return x


class _ByteGPT(nn.Module):
    def __init__(self, obs_dim: int, d: int = 256, n_heads: int = 8,
                 n_layers: int = 6, ff: int = 1024, max_len: int = MAX_LEN) -> None:
        super().__init__()
        self.tok = nn.Embedding(VOCAB, d)
        self.pos = nn.Parameter(torch.zeros(1, max_len, d))
        self.cond = nn.Linear(obs_dim, d)
        self.blocks = nn.ModuleList([_Block(d, n_heads, ff) for _ in range(n_layers)])
        self.ln_f = nn.LayerNorm(d)
        self.head = nn.Linear(d, VOCAB)
        self.value = nn.Linear(d, 1)
        self.max_len = max_len

    def forward(self, tokens: torch.Tensor, cond: torch.Tensor):
        # tokens: (B, T); cond: (B, obs_dim)
        B, T = tokens.shape
        x = self.tok(tokens) + self.pos[:, :T, :]
        # Add conditioning vector to every position.
        x = x + self.cond(cond).unsqueeze(1)
        mask = torch.triu(torch.ones(T, T, device=tokens.device), diagonal=1).bool()
        for blk in self.blocks:
            x = blk(x, mask)
        x = self.ln_f(x)
        # value: pool last token
        return self.head(x), self.value(x[:, -1, :]).squeeze(-1)


class PPOTransformerAgent:
    name = "ppo_transformer"

    def __init__(self, obs_dim: int, max_bytes: int = 512,
                 device: str = "cuda", lr: float = 1e-4,
                 ent_coef: float = 0.01, vf_coef: float = 0.5,
                 minibatch_size: int = 32, seed: int = 0) -> None:
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        torch.manual_seed(seed); np.random.seed(seed)

        self.max_bytes = min(max_bytes, MAX_LEN - 1)
        self.net = _ByteGPT(obs_dim).to(self.device)
        self.opt = torch.optim.AdamW(self.net.parameters(), lr=lr)
        self.ent_coef = ent_coef; self.vf_coef = vf_coef
        self.mb = minibatch_size
        self._roll = {"obs": [], "tokens": [], "logps": [], "rews": [], "vals": []}

    @torch.no_grad()
    def sample(self, obs: np.ndarray, temperature: float = 1.0) -> tuple[bytes, list[int], float, float]:
        cond = torch.from_numpy(obs).float().unsqueeze(0).to(self.device)
        tok = torch.full((1, 1), EOS, dtype=torch.long, device=self.device)
        # Seed: start with TLS record header (0x16 0x03 0x01) so the model
        # has a natural prefix and isn't burning samples on irrelevant prefixes.
        seeds = [0x16, 0x03, 0x01]
        for s in seeds:
            tok = torch.cat([tok, torch.tensor([[s]], device=self.device)], dim=1)
        logps: list[float] = []
        for _ in range(self.max_bytes - len(seeds)):
            logits, value = self.net(tok, cond)
            logits = logits[:, -1, :] / temperature
            probs = F.softmax(logits, dim=-1)
            sampled = torch.multinomial(probs, 1)
            lp = torch.log(probs.gather(-1, sampled) + 1e-9)
            logps.append(float(lp.item()))
            tok = torch.cat([tok, sampled], dim=1)
            if int(sampled.item()) == EOS:
                break
        all_tokens = tok[0, 1:].cpu().tolist()  # drop the leading EOS sentinel
        bytes_only = bytes(t for t in all_tokens if t < 256)
        # last value
        _, value = self.net(tok, cond)
        return bytes_only, all_tokens, float(sum(logps)), float(value.item())

    def act(self, obs: np.ndarray) -> bytes:
        b, tokens, logp, value = self.sample(obs, temperature=1.0)
        self._roll["obs"].append(obs.astype(np.float32))
        self._roll["tokens"].append(tokens)
        self._roll["logps"].append(logp)
        self._roll["vals"].append(value)
        return b

    def record_step(self, reward: float, done: bool) -> None:
        self._roll["rews"].append(reward)

    def update_with_rollout(self) -> dict:
        if not self._roll["rews"]:
            return {}
        rews = torch.tensor(self._roll["rews"], dtype=torch.float32, device=self.device)
        vals = torch.tensor(self._roll["vals"], dtype=torch.float32, device=self.device)
        adv = rews - vals
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)

        cond = torch.from_numpy(np.stack(self._roll["obs"])).to(self.device)
        # Pad token sequences to a common length.
        T = max(len(t) for t in self._roll["tokens"])
        toks_padded = torch.zeros(len(self._roll["tokens"]), T,
                                  dtype=torch.long, device=self.device)
        mask = torch.zeros(len(self._roll["tokens"]), T,
                           dtype=torch.bool, device=self.device)
        for i, t in enumerate(self._roll["tokens"]):
            toks_padded[i, :len(t)] = torch.tensor(t, dtype=torch.long, device=self.device)
            mask[i, :len(t)] = True

        # Re-prefix the leading EOS so the model gets the same conditioning
        # as during sampling.
        prefixed = torch.cat([torch.full((toks_padded.size(0), 1), EOS,
                                          dtype=torch.long, device=self.device),
                              toks_padded], dim=1)

        logits, vp = self.net(prefixed, cond)
        # next-token logp at each position predicts toks_padded
        logp = F.log_softmax(logits[:, :-1, :], dim=-1)
        gathered = logp.gather(-1, toks_padded.unsqueeze(-1)).squeeze(-1)
        # Sum across valid positions.
        seq_logp = (gathered * mask.float()).sum(dim=1)

        ent = -(F.softmax(logits[:, :-1, :], dim=-1) * logp).sum(-1)
        ent = (ent * mask.float()).sum(1) / mask.float().sum(1).clamp(min=1)

        pg = -(seq_logp * adv).mean()
        vf = F.mse_loss(vp, rews)
        loss = pg + self.vf_coef * vf - self.ent_coef * ent.mean()

        self.opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.net.parameters(), 1.0)
        self.opt.step()

        for k in self._roll: self._roll[k] = []
        return {"loss": float(loss.item())}

    def state_dict(self) -> dict:
        return {"net": self.net.state_dict()}

    def load_state_dict(self, sd: dict) -> None:
        self.net.load_state_dict(sd["net"])
