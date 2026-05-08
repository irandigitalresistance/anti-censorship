"""scripts/plots.py — generate the paper figures from the per-run JSON.

Inputs:
    rlagent/runs/<run_name>/log.jsonl       per-step training log
    rlagent/runs/<run_name>/summary.json    final aggregated metrics
    eval/<expt>/<agent>.json                eval outputs (E1, E4, E6)

Outputs:
    paper/figures/bypass_rate.pdf           E1 bar chart
    paper/figures/sample_efficiency.pdf     E2 learning curves
    paper/figures/action_freq.pdf           E3 heatmap
    paper/figures/transfer_matrix.pdf       E4
    paper/figures/recovery.pdf              E5
    paper/figures/stealth_cdf.pdf           E6
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


def _load_summary(d: Path) -> dict | None:
    p = d / "summary.json"
    if not p.exists():
        return None
    with open(p) as f:
        return json.load(f)


def _load_log_rolling(d: Path, window: int = 1000) -> tuple[list[int], list[float]]:
    """Return (steps, rolling_bypass_rate) from log.jsonl."""
    log = d / "log.jsonl"
    if not log.exists(): return [], []
    bypass = []
    steps = []
    rates = []
    with open(log) as f:
        for line in f:
            row = json.loads(line)
            v = row.get("verdict")
            bypass.append(1 if v in ("server_hello", "tls_alert") else 0)
            if len(bypass) >= window and len(bypass) % 100 == 0:
                steps.append(row["step"])
                rates.append(np.mean(bypass[-window:]))
    return steps, rates


def fig_bypass_rate(runs_dir: Path, out: Path) -> None:
    summaries: list[dict] = []
    for run in sorted(runs_dir.iterdir()):
        if not run.is_dir(): continue
        s = _load_summary(run)
        if s: summaries.append(s)
    if not summaries:
        print("  (no summaries; skipping bypass_rate)"); return
    summaries.sort(key=lambda s: s["bypass_rate"])
    names = [s["agent"] for s in summaries]
    rates = [s["bypass_rate"] for s in summaries]
    plt.figure(figsize=(7, 4))
    plt.barh(names, rates, color="#2a8")
    plt.xlabel("bypass rate (training-time average)")
    plt.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(out); plt.close()
    print(f"  wrote {out}")


def fig_sample_efficiency(runs_dir: Path, out: Path) -> None:
    plt.figure(figsize=(7, 4))
    plotted = 0
    for run in sorted(runs_dir.iterdir()):
        if not run.is_dir(): continue
        s = _load_summary(run)
        if not s: continue
        steps, rates = _load_log_rolling(run, window=1000)
        if not steps: continue
        plt.plot(steps, rates, label=s["agent"])
        plotted += 1
    if plotted == 0:
        print("  (no logs; skipping sample_efficiency)"); return
    plt.xlabel("episodes"); plt.ylabel("rolling 1k bypass rate")
    plt.legend(loc="best", fontsize=8)
    plt.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(out); plt.close()
    print(f"  wrote {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default="rlagent/runs")
    ap.add_argument("--out",  default="paper/figures")
    args = ap.parse_args()

    runs_dir = Path(args.runs)
    out_dir  = Path(args.out)

    fig_bypass_rate(runs_dir, out_dir / "bypass_rate.pdf")
    fig_sample_efficiency(runs_dir, out_dir / "sample_efficiency.pdf")
    # E3, E4, E5, E6 figures are produced from explicit JSON outputs of the
    # eval scripts; user runs `python -m rlagent.eval.transfer ...` etc.
    # then re-runs this with --runs pointing at the eval directory.


if __name__ == "__main__":
    main()
