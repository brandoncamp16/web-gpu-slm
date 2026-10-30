#!/usr/bin/env bash
# Creates a local certificate authority (CA) and an HTTPS certificate for this
# machine, so phones on the same network (e.g. an iPhone) can open the app over
# https:// and use WebGPU and the camera.
#
# Usage:  ./scripts/make-local-cert.sh [extra IP or hostname ...]
#         ./scripts/make-local-cert.sh --no-name-constraints [...]
#
# Output (in certs/, which is gitignored):
#   ca.crt      public CA certificate: install this on the phone (served at http://<ip>/ca.crt in prod)
#   ca.key      CA private key: keep it private, never share or commit it
#   server.crt  HTTPS certificate used by nginx in prod mode
#   server.key  its private key
#
# The CA is reused when it already exists, so re-running the script after the
# PC's IP changes does not require trusting anything again on the phone.
set -euo pipefail

cd "$(dirname "$0")/.."
CERT_DIR="certs"
CA_NAME="WebGPU SLM Benchmark Local CA"
CA_DAYS=3650
SERVER_DAYS=800 # Apple rejects TLS certificates valid for more than 825 days

NAME_CONSTRAINTS=1
EXTRA_NAMES=()
for arg in "$@"; do
  case "$arg" in
    --no-name-constraints) NAME_CONSTRAINTS=0 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) EXTRA_NAMES+=("$arg") ;;
  esac
done

command -v openssl >/dev/null || { echo "ERROR: openssl is not installed." >&2; exit 1; }

# ---------- Find this machine's LAN IPv4 address(es) ----------
is_private_ip() {
  [[ "$1" =~ ^10\. || "$1" =~ ^192\.168\. || "$1" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]]
}

detect_lan_ips() {
  if command -v ipconfig.exe >/dev/null 2>&1; then
    # WSL: phones connect to the Windows host, so use its real network adapters
    # (skip virtual adapters such as vEthernet / WSL / Bluetooth)
    ipconfig.exe 2>/dev/null | tr -d '\r' | awk '
      /adapter/ { skip = ($0 ~ /vEthernet|WSL|Bluetooth|Loopback/) }
      /IPv4 Address/ && !skip { sub(/.*: /, ""); print }'
  else
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' || true
  fi
}

LAN_IPS=()
while read -r ip; do
  [[ -n "$ip" ]] && is_private_ip "$ip" && LAN_IPS+=("$ip")
done < <(detect_lan_ips)

if [[ ${#LAN_IPS[@]} -eq 0 && ${#EXTRA_NAMES[@]} -eq 0 ]]; then
  echo "WARNING: could not detect a LAN IP. Pass it as an argument, e.g. ./scripts/make-local-cert.sh 192.168.1.50" >&2
fi

# Subject Alternative Names: localhost + LAN IPs + anything passed in
SAN="DNS:localhost,IP:127.0.0.1"
for ip in "${LAN_IPS[@]}"; do SAN+=",IP:$ip"; done
for name in "${EXTRA_NAMES[@]}"; do
  if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SAN+=",IP:$name"; else SAN+=",DNS:$name"; fi
done

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- Certificate authority (created once, then reused) ----------
if [[ -f "$CERT_DIR/ca.key" && -f "$CERT_DIR/ca.crt" ]]; then
  echo "Reusing existing CA: $CERT_DIR/ca.crt"
else
  echo "Creating CA: $CA_NAME"
  {
    echo "[req]"
    echo "distinguished_name = dn"
    echo "prompt = no"
    echo "x509_extensions = ca_ext"
    echo "[dn]"
    echo "CN = $CA_NAME"
    echo "O = WebGPU SLM Benchmark"
    echo "[ca_ext]"
    echo "basicConstraints = critical, CA:TRUE, pathlen:0"
    echo "keyUsage = critical, keyCertSign, cRLSign"
    echo "subjectKeyIdentifier = hash"
    if [[ $NAME_CONSTRAINTS -eq 1 ]]; then
      # This CA can only vouch for private-network addresses and local names,
      # so even a leaked key could not be used to impersonate real websites.
      echo "nameConstraints = critical, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:127.0.0.0/255.0.0.0, permitted;DNS:localhost, permitted;DNS:.local"
    fi
  } > "$TMP/ca.cnf"
  openssl req -quiet -x509 -new -newkey rsa:2048 -nodes -sha256 -days "$CA_DAYS" \
    -keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" -config "$TMP/ca.cnf"
  chmod 600 "$CERT_DIR/ca.key"
fi

# ---------- Server certificate (re-issued every run) ----------
echo "Issuing server certificate for: ${SAN//,/ }"
{
  echo "[req]"
  echo "distinguished_name = dn"
  echo "prompt = no"
  echo "[dn]"
  echo "O = WebGPU SLM Benchmark"
} > "$TMP/server.cnf"
{
  echo "basicConstraints = critical, CA:FALSE"
  echo "keyUsage = critical, digitalSignature, keyEncipherment"
  echo "extendedKeyUsage = serverAuth"
  echo "subjectAltName = $SAN"
  echo "subjectKeyIdentifier = hash"
  echo "authorityKeyIdentifier = keyid"
} > "$TMP/server.ext"

openssl req -quiet -new -newkey rsa:2048 -nodes -sha256 \
  -keyout "$CERT_DIR/server.key" -out "$TMP/server.csr" -config "$TMP/server.cnf"
openssl x509 -req -in "$TMP/server.csr" -sha256 -days "$SERVER_DAYS" \
  -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial -CAserial "$TMP/ca.srl" \
  -extfile "$TMP/server.ext" -out "$CERT_DIR/server.crt"
# Keys stay private; nginx's master process runs as root in the container and can still read them
chmod 600 "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/server.crt" "$CERT_DIR/ca.crt"

openssl verify -CAfile "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt"

HOST="${LAN_IPS[0]:-${EXTRA_NAMES[0]:-localhost}}"
cat <<EOF

Done. Next steps:
  1. Start prod mode:   docker compose --env-file prod.env up -d --build
  2. On the iPhone (same Wi-Fi), one time only:
       - Safari: open http://$HOST/ca.crt and tap Allow
       - Settings > Profile Downloaded > Install
       - Settings > General > About > Certificate Trust Settings > turn on "$CA_NAME"
  3. Open https://$HOST

Keep $CERT_DIR/ca.key private. Remove the profile from the phone when you no longer need it.
EOF
