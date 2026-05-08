#!/usr/bin/env bash
# scripts/train_ppo_mixed.sh
#
# Trains PPO with the DPI profile rotating every BLOCK episodes. Each
# block restarts the dpi container under a different profile so PPO
# experiences all variants and must learn a profile-invariant policy.
#
# Schedule: 6 blocks of 1000 episodes each, cycling profiles
#   block 1: mci          ep    0..1000
#   block 2: irancell     ep 1000..2000
#   block 3: shatel       ep 2000..3000
#   block 4: mci_patched  ep 3000..4000
#   block 5: mci          ep 4000..5000
#   block 6: irancell     ep 5000..6000

set -euo pipefail
cd "$(dirname "$0")/.."

PROFILES=(mci irancell shatel mci_patched mci irancell)
BLOCK=1000
LOGDIR="/opt/rlagent/runs/ppo_mixed-rot-6k"

# Init: wipe prior runs of this name + clear the dpi container.
MSYS_NO_PATHCONV=1 docker exec irgfw-client rm -rf "$LOGDIR" 2>&1 || true
MSYS_NO_PATHCONV=1 docker exec irgfw-client mkdir -p "$LOGDIR/checkpoints" 2>&1

CKPT_LATEST="$LOGDIR/latest.pt"

for i in "${!PROFILES[@]}"; do
    P=${PROFILES[$i]}
    EP_OFFSET=$(( BLOCK * i ))
    EP_END=$(( BLOCK * (i + 1) ))
    echo "============================================================"
    echo "[ppo_mixed] block $((i+1))/${#PROFILES[@]}  profile=$P  ep $EP_OFFSET..$EP_END"
    echo "============================================================"

    IRGFW_PROFILE="$P" docker compose -f env/docker-compose.yml up -d --force-recreate dpi 2>&1 | tail -2
    sleep 4

    # If we have a saved checkpoint from previous block, the train script
    # is one-shot — easiest is to keep the agent state as a separate
    # checkpoint and resume manually. We use the "resume" trick: pass
    # --resume <ckpt> and the trainer will load it before starting.
    RESUME_ARG=""
    if MSYS_NO_PATHCONV=1 docker exec irgfw-client test -f "$CKPT_LATEST"; then
        RESUME_ARG="--resume $CKPT_LATEST"
    fi

    MSYS_NO_PATHCONV=1 docker exec -e PYTHONPATH=/opt irgfw-client \
        python3 -m rlagent.train.train \
            --agent ppo --episodes "$BLOCK" --rollout-len 256 \
            --target-ip 10.0.2.2 --target-sni www.twitter.com \
            --isp-profile "$P" \
            --logdir "$LOGDIR/block_$i" \
            --gpu 0 $RESUME_ARG 2>&1 | tail -5

    # Copy this block's final ckpt as latest
    MSYS_NO_PATHCONV=1 docker exec irgfw-client cp \
        "$LOGDIR/block_$i/checkpoints/final.pt" "$CKPT_LATEST"
done

# Combine all per-block logs into one continuous log for plotting
MSYS_NO_PATHCONV=1 docker exec irgfw-client bash -c "
    cat $LOGDIR/block_*/log.jsonl > $LOGDIR/log.jsonl
    cp $LOGDIR/block_$((${#PROFILES[@]}-1))/summary.json $LOGDIR/summary.json
    cp $LOGDIR/block_$((${#PROFILES[@]}-1))/checkpoints/final.pt $LOGDIR/checkpoints/final.pt
"
echo "[ppo_mixed] DONE"
