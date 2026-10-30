#!/usr/bin/env bash
# Creates frontend/js/vendor/transformers-4.3.1.min.js: the official transformers.js 4.3.1
# browser bundle with one change, so the app serves a pinned copy instead of loading it from a CDN.
#
# The change: model parts (e.g. embed_tokens, vision_encoder, decoder) are read and set up
# one at a time instead of all at once. Upstream reads every model file into memory in
# parallel, so a phone holds all of them (~360 MB for SmolVLM2 500M Fast) at the same
# moment on top of the loaded model. One at a time, only the largest file is held.
#
# Usage: ./scripts/vendor-transformers.sh   (needs curl, sha256sum, python3)
set -euo pipefail

VERSION="4.3.1"
URL="https://cdn.jsdelivr.net/npm/@huggingface/transformers@${VERSION}/dist/transformers.min.js"
SHA256="8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/frontend/js/vendor/transformers-${VERSION}.min.js"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsSL "$URL" -o "$TMP"
echo "$SHA256  $TMP" | sha256sum -c --quiet - || { echo "Unexpected file contents (checksum mismatch)" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
python3 - "$TMP" "$OUT" "$VERSION" <<'EOF'
import sys
src, out, version = sys.argv[1], sys.argv[2], sys.argv[3]
code = open(src, encoding="utf-8").read()

# constructSessions(): Promise.all over the sessions -> a sequential loop
before = ("async function sM(t,e,r,s=void 0){return Object.fromEntries(await Promise.all(Object.keys(e).map(async n=>"
          "{let o=s?.[n]??!1,{buffer_or_path:a,session_options:i,session_config:l}=await qR(t,e[n],r,o,n),c=await au(a,i,l);"
          "return[n,c]})))}")
after = ("async function sM(t,e,r,s=void 0){let R=[];for(let n of Object.keys(e)){"
         "let o=s?.[n]??!1,{buffer_or_path:a,session_options:i,session_config:l}=await qR(t,e[n],r,o,n),c=await au(a,i,l);"
         "R.push([n,c])}return Object.fromEntries(R)}")
if code.count(before) != 1:
    sys.exit("Patch target not found exactly once; the bundle changed")
code = code.replace(before, after)

header = f"""/*
 * transformers.js {version} (https://github.com/huggingface/transformers.js), dist/transformers.min.js
 * Copyright Hugging Face. Licensed under the Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
 * Includes ONNX Runtime Web (MIT License, Copyright Microsoft Corporation).
 *
 * MODIFIED by this project (scripts/vendor-transformers.sh): model sessions are loaded one at a
 * time instead of in parallel (constructSessions), to lower peak memory on phones.
 */
"""
open(out, "w", encoding="utf-8").write(header + code)
EOF
echo "Wrote $OUT"
