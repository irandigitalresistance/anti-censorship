#!/usr/bin/env bash
# scripts/sweep_agents.sh
#
# Train every agent in the zoo for a fixed episode budget, against the
# canonical mci profile. Used to populate the E1/E2 figures.
#
# Usage:
#   bash scripts/sweep_agents.sh [episodes]
#
# Default: 25_000 episodes per agent.

set -euo pipefail

EPISODES="${1:-25000}"
PROFILE="${PROFILE:-mci}"
TARGET_SNI="${TARGET_SNI:-www.twitter.com}"
GPU="${GPU:-0}"

AGENTS=(random ucb1 qtable geneva dqn ppo ppo_param)

cd "$(dirname "$0")/.."

for agent in "${AGENTS[@]}"; do
    LOGDIR="/opt/rlagent/runs/${agent}-${PROFILE}-${EPISODES}ep"
    echo "============================================================"
    echo "[sweep] training agent=${agent} episodes=${EPISODES} profile=${PROFILE}"
    echo "============================================================"
    MSYS_NO_PATHCONV=1 docker exec -e PYTHONPATH=/opt irgfw-client bash -c "
        rm -rf '${LOGDIR}'
        python3 -m rlagent.train.train \
            --agent '${agent}' --episodes '${EPISODES}' \
            --target-ip 10.0.2.2 --target-sni '${TARGET_SNI}' \
            --isp-profile '${PROFILE}' \
            --logdir '${LOGDIR}' \
            --gpu '${GPU}' 2>&1 | tail -30
    "
done

echo "============================================================"
echo "[sweep] all agents done. Generating plots."
echo "============================================================"
MSYS_NO_PATHCONV=1 docker exec -e PYTHONPATH=/opt irgfw-client python3 -c "
import json, glob
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from pathlib import Path
import numpy as np

# E1 — bypass rate bar chart
runs = []
for d in sorted(Path('/opt/rlagent/runs').iterdir()):
    f = d / 'summary.json'
    if not f.exists(): continue
    s = json.load(open(f))
    if str(d.name).endswith('-${EPISODES}ep'):
        runs.append(s)
runs.sort(key=lambda s: s['bypass_rate'])
fig, ax = plt.subplots(figsize=(7, 4))
names = [s['agent'] for s in runs]
rates = [s['bypass_rate'] for s in runs]
last1k = [s['rolling_bypass_rate_last_1000'] for s in runs]
ax.barh(names, rates, color='#2a8', label='whole run')
ax.barh(names, last1k, color='#085', alpha=0.7, label='last 1000 ep')
for i, (r, l) in enumerate(zip(rates, last1k)):
    ax.text(max(r, l) + 0.005, i, f'{r:.3f} / {l:.3f}', va='center', fontsize=9)
ax.set_xlabel('bypass rate')
ax.set_xlim(0, 1.05)
ax.set_title('IRGFW-Sim, profile=${PROFILE} — ${EPISODES} ep per agent')
ax.legend(loc='lower right', fontsize=8)
plt.tight_layout()
plt.savefig('/opt/paper/figures/bypass_rate.pdf')
plt.savefig('/opt/paper/figures/bypass_rate.png', dpi=120)

# E2 — sample efficiency learning curves
fig, ax = plt.subplots(figsize=(7, 4))
for d in sorted(Path('/opt/rlagent/runs').iterdir()):
    if not str(d.name).endswith('-${EPISODES}ep'): continue
    s = json.load(open(d / 'summary.json'))
    log = d / 'log.jsonl'
    if not log.exists(): continue
    bypass = []; xs = []; ys = []
    with open(log) as f:
        for line in f:
            row = json.loads(line)
            bypass.append(1 if row['verdict'] in ('server_hello', 'tls_alert') else 0)
            if len(bypass) >= 1000 and len(bypass) % 100 == 0:
                xs.append(row['step']); ys.append(np.mean(bypass[-1000:]))
    ax.plot(xs, ys, label=s['agent'], linewidth=1.2)
ax.set_xlabel('episodes'); ax.set_ylabel('rolling 1k bypass rate')
ax.set_title('E2 — sample efficiency (profile=${PROFILE})')
ax.legend(loc='lower right', fontsize=8)
ax.grid(alpha=0.3)
plt.tight_layout()
plt.savefig('/opt/paper/figures/sample_efficiency.pdf')
plt.savefig('/opt/paper/figures/sample_efficiency.png', dpi=120)
print('plots written to /opt/paper/figures/')
"
