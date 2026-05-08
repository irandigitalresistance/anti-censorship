#!/usr/bin/env bash
# scripts/setup_gpu.sh
# Verifies the NVIDIA toolchain inside the irgfw-client container and installs
# a CUDA-enabled torch build there. Safe to re-run.

set -euo pipefail

if ! docker exec irgfw-client nvidia-smi >/dev/null 2>&1; then
    cat <<EOF
[setup_gpu] No GPU visible inside irgfw-client.
            Make sure the NVIDIA Container Toolkit is installed AND the
            client service in env/docker-compose.yml has been edited to
            include:
                deploy:
                  resources:
                    reservations:
                      devices:
                        - driver: nvidia
                          count: 1
                          capabilities: [gpu]
            Run: docker compose up -d --force-recreate client
EOF
    exit 1
fi

docker exec irgfw-client pip install --no-cache-dir \
    torch==2.2.2+cu121 --index-url https://download.pytorch.org/whl/cu121

docker exec irgfw-client python3 -c \
    "import torch; print('cuda available:', torch.cuda.is_available()); print('device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')"
