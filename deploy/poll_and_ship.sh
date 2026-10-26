#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="$HOME/deploy/state"
LAST_SENT_FILE="$STATE_DIR/last_sent_sha"
mkdir -p "$STATE_DIR" /tmp

trap 'echo "ERROR: poll_and_ship.sh failed at line $LINENO (Command: $BASH_COMMAND)" >&2' ERR

REPO="$HOME/siteCodebase"
BRANCH="production"

PROD_HOST="127.0.0.1"
PROD_USER="user"
SSH_KEY="$HOME/.ssh/id_ed25519"
PROD_INCOMING="deploy/incoming"

cd "$REPO"
git fetch origin

NEW_SHA="$(git rev-parse "origin/$BRANCH")"
OLD_SHA=""
[[ -f "$LAST_SENT_FILE" ]] && OLD_SHA="$(tr -d '\n' < "$LAST_SENT_FILE")"

if [[ "$NEW_SHA" == "$OLD_SHA" ]]; then
  echo "No change on origin/$BRANCH ($NEW_SHA)."
  exit 0
fi

echo "New SHA detected: $NEW_SHA"

git checkout "$BRANCH" >/dev/null 2>&1 || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

echo "$NEW_SHA" > /tmp/release_sha
tar --exclude=.git -czf /tmp/siteCodebase.tgz -C "$REPO" .

SSH_OPTS="-i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# Custom SSH execution wrapper to capture fingerprint/connection errors clearly
run_ssh_cmd() {
  local output
  if ! output=$(eval "$@" 2>&1); then
    if echo "$output" | grep -qE "Host key verification failed|fingerprint|REMOTE HOST IDENTIFICATION HAS CHANGED|Permission denied"; then
      echo "--------------------------------------------------------" >&2
      echo "ERROR: [poll_and_ship.sh] SSH Host Key or Authentication Failure!" >&2
      echo "Raw SSH Output: $output" >&2
      echo "Hint: Run 'ssh-keygen -R 127.0.0.1' or connect manually once" >&2
      echo "      via 'ssh 127.0.0.1' to accept the new host fingerprint." >&2
      echo "--------------------------------------------------------" >&2
    else
      echo "ERROR: [poll_and_ship.sh] Remote SSH command failed: $output" >&2
    fi
    exit 1
  fi
}

ssh $SSH_OPTS "${PROD_USER}@${PROD_HOST}" "mkdir -p $PROD_INCOMING"
scp $SSH_OPTS /tmp/siteCodebase.tgz "${PROD_USER}@${PROD_HOST}:$PROD_INCOMING/siteCodebase.tgz"
scp $SSH_OPTS /tmp/release_sha "${PROD_USER}@${PROD_HOST}:$PROD_INCOMING/release_sha"
ssh $SSH_OPTS "${PROD_USER}@${PROD_HOST}" "deploy/trigger_stage_build.sh"

echo "$NEW_SHA" > "$LAST_SENT_FILE"
echo "Shipped SHA: $NEW_SHA"