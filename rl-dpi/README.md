# RL-DPI

Open-source Iran-DPI simulator and a zoo of reinforcement-learning agents that
learn to craft TLS-handshake packet sequences which bypass it.

This is the artifact for the paper *"Learning to Bypass: Reinforcement-Learned
Packet Crafting Against an Iran-Like Deep Packet Inspector"*. It contains:

* **`env/`** — **IRGFW-Sim**, a Docker stack that emulates Iran's
  national DPI (stateless SNI matcher, DNS injector returning
  `10.10.34.34/.35/.36`, HTTP `Host:` filter with 403+iframe injection,
  Qosmos-ixEngine-style parser bugs, active probing, graylist, configurable
  per-ISP profile). Built directly from the layer-by-layer description in
  `D:\censorship-details\report.md` §4 and §11.12.
* **`rlagent/`** — Gymnasium environment, a 50-mutation action catalogue
  seeded from `D:\censorship-details\dpi_fuzzer.py`, and seven RL agents
  (Random, UCB1 bandit, tabular-Q, DQN, PPO, PPO-parametric, Transformer
  byte-policy) plus a Geneva genetic-algorithm baseline.
* **`paper/`** — LaTeX source.
* **`scripts/`** — orchestration: simulator validation, full experiment
  sweep, plotting.

## Ethics

Training is performed against a **local simulator**. No traffic is ever sent
toward Iranian infrastructure. All bypass primitives modelled here are
already publicly documented in academic and operator literature; the RL
contribution is automated discovery and chaining, not a new attack class.

## Quickstart

```bash
# 1. Bring up the simulator and validate fidelity against dpi_fuzzer.py
bash scripts/validate_simulator.sh

# 2. Train one agent for a quick smoke test (~20 min on a consumer GPU)
bash scripts/run_full_experiment.sh --agent dqn --episodes 50000 --gpu 0

# 3. Reproduce paper figures
python scripts/plots.py --runs rlagent/runs/ --out paper/figures/
```

## Layout

See `D:\anti-censorship\rl-dpi\README.md` and the plan at
`C:\Users\alavi\.claude\plans\read-the-censorship-details-and-quizzical-stardust.md`.
