#!/usr/bin/env bash
set -euo pipefail

STATE="$HOME/deploy/state"
RELEASES="$HOME/deploy/releases"
INCOMING="$HOME/deploy/incoming"
BUILDROOT="$HOME/deploy/build"
RUNNER="$HOME/siteCodebase"

mkdir -p "$STATE" "$RELEASES" "$INCOMING" "$BUILDROOT" "$RUNNER" /tmp

# Verify Docker Compose is installed
command -v docker &> /dev/null || {
  echo "ERROR: [deploy.sh] 'docker' command is not installed or not found in PATH." >&2
  exit 1
}
docker compose version &> /dev/null || {
  echo "ERROR: [deploy.sh] 'docker compose' plugin is not installed or not available." >&2
  exit 1
}

trap 'echo "ERROR: deploy.sh failed at line $LINENO (Command: $BASH_COMMAND)" >&2' ERR

PENDING_FILE="$STATE/pending_sha"
GOOD_FILE="$STATE/good_shas"
HISTORY_FILE="$STATE/shas_history"

# Health-gated services (Start with frontend; Can expand later)
HEALTH_SERVICES=("frontend")

LOCK="/tmp/docker-website_deploy.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "Deploy already running; exiting."; exit 0; }

touch "$GOOD_FILE" "$HISTORY_FILE"

apply_release() {
  local sha="$1"
  local snap_dir="$RELEASES/$sha"
  
  # Ensure the snapshot folder exists
  [[ -d "$snap_dir" ]] || { echo "Snapshot folder for $sha not found!"; exit 1; }

  # 1. Copy EVERYTHING (all compose files, .env, etc.) straight into the runner folder
  cp -a "$snap_dir/." "$RUNNER/"

  # 2. Write the single source of truth for tracking scripts
  printf "RELEASE_SHA=%s\n" "$sha" > "$RUNNER/release_sha.env"

  # 3. Export the tracking variable directly to the execution environment
  export RELEASE_SHA="$sha"

  cd "$RUNNER"

  # 4. Run Docker Compose using both files explicitly so it combines both configurations 
  docker compose --env-file .env --env-file release_sha.env up -d
}

wait_for_selected_services() {
  local timeout_s="${1:-90}"
  local interval_s=3
  local elapsed=0

  cd "$RUNNER"
  echo "Waiting up to ${timeout_s}s for: ${HEALTH_SERVICES[*]}"

  while (( elapsed < timeout_s )); do
    local ok=1

    for svc in "${HEALTH_SERVICES[@]}"; do
      local cid status health
      cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
      [[ -n "$cid" ]] || { ok=0; break; }

      status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo "unknown")"
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "unknown")"

      [[ "$status" == "running" ]] || { ok=0; break; }
      [[ "$health" == "none" || "$health" == "healthy" ]] || { ok=0; break; }
    done

    [[ "$ok" -eq 1 ]] && return 0
    sleep "$interval_s"
    elapsed=$((elapsed + interval_s))
  done

  return 1
}

most_recent_good_sha() {
  head -n 1 "$GOOD_FILE" | tr -d '\n'
}

push_good_sha() {
  local sha="$1"
  { echo "$sha"; cat "$GOOD_FILE"; } | awk 'NF' | awk '!seen[$0]++' | head -n 5 > "$GOOD_FILE.tmp"
  mv "$GOOD_FILE.tmp" "$GOOD_FILE"
}

add_history_sha() {
  local sha="$1"
  { echo "$sha"; cat "$HISTORY_FILE"; } | awk 'NF' | awk '!seen[$0]++' > "$HISTORY_FILE.tmp"
  mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
}

prune_sha() {
  local sha="$1"
  echo "Pruning SHA (not in good_shas): $sha"

  # Remove any containers built from docker-website-*:<sha>
  while IFS= read -r img; do
    [[ -n "$img" ]] || continue

    # Remove containers using this image
    docker ps -a --filter "ancestor=$img" -q | xargs -r docker rm -f || true
    docker image rm -f "$img" >/dev/null 2>&1 || true
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' | awk -v s="$sha" '$0 ~ /^docker-website-/ && $0 ~ (":" s "$")')

  # Remove compose snapshot
  rm -rf "$RELEASES/$sha" || true
}

cleanup_to_good_shas() {
  # For every sha in history that is NOT in good_shas -> prune it
  while IFS= read -r sha; do
    [[ -n "$sha" ]] || continue
    if ! grep -qxF "$sha" "$GOOD_FILE"; then
      prune_sha "$sha"
    fi
  done < "$HISTORY_FILE"

  # After cleanup, history becomes exactly the retained good list
  awk 'NF' "$GOOD_FILE" > "$HISTORY_FILE.tmp"
  mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
}

# Determine the current deployed SHA (if any) and the state of its containers
current_sha=$(cat "$RUNNER/release_sha.env" 2>/dev/null | cut -d'=' -f2 || echo "")

# If we have a currently deployed SHA, check if its containers are alive
if [[ -n "$current_sha" ]]; then
  containers_running=$(cd "$RUNNER" && RELEASE_SHA="$current_sha" docker compose ps -q)
else
  containers_running=""
fi

# If there's no pending file, check current SHA and the state of the containers to determine if they need to be started.
if [[ ! -f "$PENDING_FILE" ]]; then
  
  # If there's an installed version but it's completely stopped, wake it up!
  if [[ -n "$current_sha" && -z "$containers_running" ]]; then
    echo "No new updates, but active stack ($current_sha) is DOWN. Waking it up..."
    cd "$RUNNER"
    export RELEASE_SHA="$current_sha"
    docker compose --env-file .env --env-file release_sha.env up -d
    
    # We still want to verify it actually woke up properly
    if wait_for_selected_services 180; then
      echo "Stack successfully recovered and healthy!"
      exit 0
    else
      echo "Failed to bring existing stack back online."
      exit 1
    fi
  fi

  # If it's already running perfectly, just exit quietly.
  echo "No pending changes. Current stack is running normally. Nothing to do."
  exit 0
fi

# Handle pending updates.
PENDING_SHA="$(tr -d '\n' < "$PENDING_FILE")"
[[ -n "$PENDING_SHA" ]] || { echo "pending_sha empty"; exit 1; }

# If the pending update is already the one installed, and it's running, exit.
if [[ "$PENDING_SHA" == "$current_sha" && -n "$containers_running" ]]; then
  echo "Latest SHA ($PENDING_SHA) is already deployed and running. Clearing pending file."
  rm -f "$PENDING_FILE"
  exit 0
fi

# If the pending update is the one installed, but it's stopped, wake it up.
if [[ "$PENDING_SHA" == "$current_sha" && -z "$containers_running" ]]; then
  echo "Latest SHA ($PENDING_SHA) matches system state, but containers are down. Waking up..."
  cd "$RUNNER"
  export RELEASE_SHA="$PENDING_SHA"
  docker compose --env-file .env --env-file release_sha.env up -d
  
  if wait_for_selected_services 180; then
    echo "Stack successfully woken up and healthy!"
    rm -f "$PENDING_FILE"
    exit 0
  else
    echo "Failed to bring existing stack back online."
    exit 1
  fi
fi

echo "Deploying pending SHA: $PENDING_SHA"
apply_release "$PENDING_SHA"

if wait_for_selected_services 180; then
  echo "Deploy healthy: $PENDING_SHA"

  push_good_sha "$PENDING_SHA"
  add_history_sha "$PENDING_SHA"
  cleanup_to_good_shas

  date -Is > "$STATE/last_deployed_timestamp"
  rm -f "$PENDING_FILE"

  exit 0
fi

echo "Deploy FAILED health checks: $PENDING_SHA"

ROLLBACK_SHA="$(most_recent_good_sha)"
if [[ -z "$ROLLBACK_SHA" ]]; then
  echo "No good_shas entry available for rollback. Manual intervention required."
  exit 1
fi

echo "Rolling back immediately to most recent good SHA: $ROLLBACK_SHA"
apply_release "$ROLLBACK_SHA"

if wait_for_selected_services 180; then
  echo "Rollback healthy. Leaving pending_sha in place for investigation: $PENDING_SHA"
  exit 1
fi

echo "Rollback attempt also failed. Manual intervention required."
exit 2