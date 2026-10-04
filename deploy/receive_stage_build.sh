#!/usr/bin/env bash
set -euo pipefail

INCOMING="$HOME/deploy/incoming"
STATE="$HOME/deploy/state"
RELEASES="$HOME/deploy/releases"
BUILDROOT="$HOME/deploy/build"

LOCK="/tmp/docker-website.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "Stage/build already running; exiting."; exit 0; }

test -f "$INCOMING/siteCodebase.tgz"
test -f "$INCOMING/release_sha"

SHA="$(tr -d '\n' < "$INCOMING/release_sha")"
[[ -n "$SHA" ]] || { echo "release_sha empty"; exit 1; }

echo "Incoming SHA: $SHA"

LAST_BUILT_FILE="$STATE/last_built_sha"
LAST_BUILT=""
[[ -f "$LAST_BUILT_FILE" ]] && LAST_BUILT="$(tr -d '\n' < "$LAST_BUILT_FILE")"

# If already built, just re-mark pending
if [[ "$SHA" == "$LAST_BUILT" ]]; then
  echo "SHA $SHA already built; marking pending."
  echo "$SHA" > "$STATE/pending_sha"
  date -Is > "$STATE/pending_timestamp"
  rm -f "$INCOMING/siteCodebase.tgz" "$INCOMING/release_sha"
  exit 0
fi

# Extract tarball
BUILDDIR="$BUILDROOT/$SHA"
rm -rf "$BUILDDIR"
mkdir -p "$BUILDDIR"
tar -xzf "$INCOMING/siteCodebase.tgz" -C "$BUILDDIR"

# Find and build all services that have a Dockerfile at <dir>/Dockerfile
cd "$BUILDDIR"

mapfile -t DOCKERFILES < <(find . -mindepth 2 -maxdepth 2 -type f -name Dockerfile | sort)

if [[ "${#DOCKERFILES[@]}" -eq 0 ]]; then
  echo "No Dockerfiles found in incoming source. Aborting."
  exit 1
fi

for df in "${DOCKERFILES[@]}"; do
  # df looks like: ./frontend/Dockerfile -> service dir = frontend
  svc_dir="$(dirname "$df")"
  svc_name="$(basename "$svc_dir")"

  image="docker-website-${svc_name}:${SHA}"
  echo "Building $image from $svc_dir/Dockerfile (context: repo root)"
  docker build -t "$image" -f "$svc_dir/Dockerfile" .
done

# Snapshot runner compose for this SHA
SNAPDIR="$RELEASES/$SHA"
rm -rf "$SNAPDIR"
mkdir -p "$SNAPDIR"

# Snapshot all compose files shipped with the repo
cp "$BUILDDIR"/docker-compose*.yml "$SNAPDIR/"

# Look for the .env file from repo.
if [[ -f "$BUILDDIR/.env" ]]; then
  cp "$BUILDDIR/.env" "$SNAPDIR/.env"
fi

# Create nginx configuration directory and snapshot nginx configs
if [[ -d "$BUILDDIR/frontend/nginx" ]]; then
  mkdir -p "$SNAPDIR/frontend/nginx"
  cp -a "$BUILDDIR/frontend/nginx/." "$SNAPDIR/frontend/nginx/"
fi

# Include the MongoDB initialization scripts
if [[ -d "$BUILDDIR/backend/mongo-init" ]]; then
  mkdir -p "$SNAPDIR/backend/mongo-init"
  cp -a "$BUILDDIR/backend/mongo-init/." "$SNAPDIR/backend/mongo-init/"
fi

# Create image directory and snapshot imaages
if [[ -d "$BUILDDIR/frontend/images" ]]; then
  mkdir -p "$SNAPDIR/frontend/images"
  cp -a "$BUILDDIR/frontend/images/." "$SNAPDIR/frontend/images/"
fi

# Update state
echo "$SHA" > "$STATE/last_built_sha"
date -Is > "$STATE/last_built_timestamp"
echo "$SHA" > "$STATE/pending_sha"
date -Is > "$STATE/pending_timestamp"

# Track history of built SHAs (dedupe)
HISTORY_FILE="$STATE/shas_history"
touch "$HISTORY_FILE"
{ echo "$SHA"; cat "$HISTORY_FILE"; } | awk 'NF' | awk '!seen[$0]++' > "$HISTORY_FILE.tmp"
mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"

# Cleanup incoming
rm -f "$INCOMING/siteCodebase.tgz" "$INCOMING/release_sha"

# Optional: remove extracted build dir to save disk
rm -rf "$BUILDDIR"

echo "Build complete for SHA: $SHA (Pending deploy at Midnight)"