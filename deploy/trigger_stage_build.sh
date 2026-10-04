#!/usr/bin/env bash
set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user start --no-block receive_stage_build.service
echo "Triggered receive_stage_build.service"