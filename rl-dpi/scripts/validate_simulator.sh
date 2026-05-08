#!/usr/bin/env bash
# scripts/validate_simulator.sh
#
# Phase-5 fidelity gate. Brings up IRGFW-Sim with the canonical 'mci'
# profile, then runs dpi_fuzzer.py from the client container against the
# server container, and asserts the verdict matrix matches the predicted
# Iran pattern documented in D:\censorship-details\report.md §11.12.
#
# This MUST pass before any RL training results can be claimed.

set -euo pipefail

cd "$(dirname "$0")/.."
ENV_DIR="$(pwd)/env"

PROFILE="${IRGFW_PROFILE:-mci}"
echo "[validate] starting IRGFW-Sim with profile=${PROFILE}"

(cd "$ENV_DIR" && IRGFW_PROFILE="$PROFILE" docker compose up -d --build)

echo "[validate] waiting for nginx to come up"
for i in $(seq 1 30); do
    if docker exec irgfw-client curl -ks https://10.0.2.2/ -o /dev/null \
            --connect-timeout 1 --max-time 2 -H "Host: www.google.com" \
            --resolve "www.google.com:443:10.0.2.2"; then
        echo "[validate] server reachable"
        break
    fi
    sleep 1
done

echo "[validate] running dpi_fuzzer.py inside the client container"
docker exec irgfw-client python3 \
    /opt/censorship-details/dpi_fuzzer.py \
    --target 10.0.2.2 --port 443 \
    --blocked-sni www.twitter.com \
    --clean-sni   www.google.com \
    --json > /tmp/irgfw-fuzz.json

echo "[validate] running fidelity assertions"
docker exec irgfw-client python3 /opt/rlagent/../env/tests/validate_with_fuzzer.py \
    --json /tmp/irgfw-fuzz.json --profile "$PROFILE"

echo "[validate] PASS"
