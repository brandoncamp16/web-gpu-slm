#!/usr/bin/env bash
set -euo pipefail

REPO="$HOME/siteCodebase"
BRANCH="production"

STATE_DIR="$HOME/deploy/state"
LAST_SENT_FILE="$STATE_DIR/last_sent_sha"

PROD_HOST="127.0.0.1"
PROD_USER="user"
SSH_KEY="$HOME/.ssh/prod_deploy_ed25519"
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

scp -i "$SSH_KEY" /tmp/siteCodebase.tgz "${PROD_USER}@${PROD_HOST}:$PROD_INCOMING/siteCodebase.tgz"
scp -i "$SSH_KEY" /tmp/release_sha "${PROD_USER}@${PROD_HOST}:$PROD_INCOMING/release_sha"

ssh -i "$SSH_KEY" "${PROD_USER}@${PROD_HOST}" "deploy/trigger_stage_build.sh"

echo "$NEW_SHA" > "$LAST_SENT_FILE"
echo "Shipped SHA: $NEW_SHA"