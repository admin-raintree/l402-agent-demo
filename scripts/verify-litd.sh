#!/usr/bin/env bash
# Start a fresh regtest network whose buyer lnd accepts RPC middleware, attach litd in
# remote mode with accounts enabled, test the account allowance outside the MCP policy, then run
# a subscription through the MCP wallet with an account macaroon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export L402_DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/l402-litd.XXXXXX")"
export L402_FIXED_MARKET=1 L402_RPC_MIDDLEWARE=1
D="$L402_DEMO_DIR"
[ -x "$ROOT/.bin/litd" ] && [ -x "$ROOT/.bin/litcli" ] || { echo "Run scripts/build-litd.sh first." >&2; exit 1; }
trap '"$ROOT/scripts/down.sh"' EXIT
printf 'Verification state: %s\n' "$D"
"$ROOT/scripts/up.sh"

echo "Starting litd (remote mode, accounts enabled)…"
"$ROOT/.bin/litd" --lit-dir="$D/lit" --network=regtest --lnd-mode=remote \
  --remote.lnd.rpcserver=127.0.0.1:10019 \
  --remote.lnd.macaroonpath="$D/buyer/data/chain/bitcoin/regtest/admin.macaroon" \
  --remote.lnd.tlscertpath="$D/buyer/tls.cert" \
  --httpslisten=127.0.0.1:8443 --disableui \
  --faraday-mode=disable --loop-mode=disable --pool-mode=disable --taproot-assets-mode=disable \
  --autopilot.disable >"$D/logs/litd.log" 2>&1 &
echo $! >"$D/litd.pid"
litcli() { "$ROOT/.bin/litcli" --network=regtest --rpcserver=127.0.0.1:8443 --tlscertpath="$D/lit/tls.cert" \
  --macaroonpath="$D/lit/regtest/lit.macaroon" "$@"; }
for _ in $(seq 120); do litcli accounts list >/dev/null 2>&1 && break; sleep 0.5; done
litcli accounts list >/dev/null || { tail -n 20 "$D/logs/litd.log" >&2; exit 1; }

bun "$ROOT/scripts/litd-allowance.ts"
bun "$ROOT/scripts/litd-subscription-smoke.ts"
