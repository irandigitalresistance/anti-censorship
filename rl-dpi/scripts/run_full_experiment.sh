#!/usr/bin/env bash
# scripts/run_full_experiment.sh
#
# End-to-end orchestration of one training run, executed *inside* the
# `irgfw-client` container which has the rlagent code mounted.

set -euo pipefail

# Defaults
AGENT="${AGENT:-ppo_param}"
EPISODES="${EPISODES:-200000}"
PROFILE="${PROFILE:-mci}"
TARGET_SNI="${TARGET_SNI:-www.twitter.com}"
GPU="${GPU:-0}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent)     AGENT="$2"; shift 2 ;;
        --episodes)  EPISODES="$2"; shift 2 ;;
        --profile)   PROFILE="$2"; shift 2 ;;
        --sni)       TARGET_SNI="$2"; shift 2 ;;
        --gpu)       GPU="$2"; shift 2 ;;
        *) echo "unknown arg: $1"; exit 2 ;;
    esac
done

cd "$(dirname "$0")/.."
ENV_DIR="$(pwd)/env"
RUN_NAME="${AGENT}-${PROFILE}-$(date +%Y%m%d-%H%M%S)"
LOGDIR="rlagent/runs/${RUN_NAME}"
mkdir -p "${LOGDIR}"

echo "[run] bringing up IRGFW-Sim with profile=${PROFILE}"
(cd "${ENV_DIR}" && IRGFW_PROFILE="${PROFILE}" docker compose up -d --build)

# Wait for nginx readiness
for i in $(seq 1 30); do
    if docker exec irgfw-client curl -ks https://10.0.2.2/ -o /dev/null \
            --connect-timeout 1 --max-time 2 \
            --resolve "www.google.com:443:10.0.2.2" \
            -H "Host: www.google.com"; then
        break
    fi
    sleep 1
done

# Phase-5 fidelity gate (cheap; just baseline_blocked + baseline_clean)
echo "[run] running fidelity baseline check"
docker exec irgfw-client python3 \
    /opt/censorship-details/dpi_fuzzer.py \
    --target 10.0.2.2 --port 443 \
    --blocked-sni www.twitter.com --clean-sni www.google.com \
    --only baseline_blocked,baseline_clean --json > /tmp/fid.json
docker exec irgfw-client python3 \
    /opt/rlagent/../env/tests/validate_with_fuzzer.py \
    --json /tmp/fid.json --profile "${PROFILE}" || {
        echo "[run] FIDELITY CHECK FAILED — aborting before training"
        exit 1
    }

echo "[run] fidelity OK; starting training agent=${AGENT} episodes=${EPISODES}"
docker exec -e PYTHONPATH=/opt/rlagent -e CUDA_VISIBLE_DEVICES="${GPU}" \
    irgfw-client \
    python3 -m rlagent.train.train \
        --agent "${AGENT}" \
        --episodes "${EPISODES}" \
        --target-ip 10.0.2.2 \
        --target-sni "${TARGET_SNI}" \
        --isp-profile "${PROFILE}" \
        --logdir "/opt/rlagent/runs/${RUN_NAME}" \
        --gpu "${GPU}"

echo "[run] DONE. logs in rlagent/runs/${RUN_NAME}/"
