#!/usr/bin/env bash
set -euo pipefail
trap 'echo "ERROR: trigger_stage_build.sh failed at line $LINENO (Command: $BASH_COMMAND)" >&2' ERR
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user start --no-block receive_stage_build.service
echo "Triggered receive_stage_build.service"