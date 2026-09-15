#!/usr/bin/env bash
# Start a fresh local regtest network: btcd, two lnd nodes, a funded channel,
# the paid data service, and Aperture in front of it. State lives in .demo/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/.bin"
D="$ROOT/.demo"
export PATH="$BIN:$PATH"

"$ROOT/scripts/down.sh" >/dev/null 2>&1 || true
rm -rf "$D" && mkdir -p "$D/logs"
# On any failure, stop whatever already started (logs stay in .demo/logs).
trap 'status=$?; [ $status -ne 0 ] && "$ROOT/scripts/down.sh" >/dev/null; exit $status' EXIT

RPC=(--rpcuser=demo --rpcpass=demo)
# Wait up to 90s for a command to succeed; on timeout show the logs and fail.
wait_for() {
  local what=$1; shift
  for _ in $(seq 180); do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "Timed out waiting for $what. Recent logs:" >&2; tail -n 5 "$D"/logs/*.log >&2; exit 1
}
btcd_start() {
  mkdir -p "$D/btcd" && touch "$D/btcd/btcd.conf"
  btcd --regtest --txindex "${RPC[@]}" --rpclisten=127.0.0.1:18556 --listen=127.0.0.1:18555 \
    -C "$D/btcd/btcd.conf" -b "$D/btcd/data" --logdir="$D/btcd/logs" \
    --rpccert="$D/btcd/rpc.cert" --rpckey="$D/btcd/rpc.key" "$@" >"$D/logs/btcd.log" 2>&1 &
  echo $! >"$D/btcd.pid"
  wait_for btcd btcctl -C "$D/btcd/btcd.conf" --regtest "${RPC[@]}" --rpcserver=127.0.0.1:18556 --rpccert="$D/btcd/rpc.cert" getblockcount
}
mine() { btcctl -C "$D/btcd/btcd.conf" --regtest "${RPC[@]}" --rpcserver=127.0.0.1:18556 --rpccert="$D/btcd/rpc.cert" generate "$1"; }

# name rpc-port p2p-port
lnd_start() {
  lnd --lnddir="$D/$1" --bitcoin.regtest --bitcoin.node=btcd \
    --btcd.rpchost=127.0.0.1:18556 --btcd.rpcuser=demo --btcd.rpcpass=demo --btcd.rpccert="$D/btcd/rpc.cert" \
    --noseedbackup --norest --rpclisten="127.0.0.1:$2" --listen="127.0.0.1:$3" \
    --alias="$1" --trickledelay=50 --nobootstrap >"$D/logs/$1.log" 2>&1 &
  echo $! >"$D/$1.pid"
}
cli() { local n=$1 port=$2; shift 2; lncli --lnddir="$D/$n" --network=regtest --rpcserver="127.0.0.1:$port" "$@"; }
buyer() { cli buyer 10019 "$@"; }
seller() { cli seller 10020 "$@"; }
synced() { "$1" getinfo | grep -q '"synced_to_chain": true'; }
wait_synced() { wait_for "$1 to sync" synced "$1"; }

echo "Starting btcd…"
# lnd waits until the chain tip is recent, so mine one block to a burn address before starting it.
btcd_start --miningaddr=bcrt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdku202
mine 1 >/dev/null

# btcd mines only to an address fixed at startup. Get the agent wallet's address first,
# then restart btcd pointed at it. lnd is stopped during the restart so it resyncs cleanly.
echo "Creating the agent wallet…"
lnd_start buyer 10019 9745
wait_synced buyer
ADDR=$(buyer newaddress p2wkh | sed -n 's/.*"address": "\(.*\)".*/\1/p')
kill "$(cat "$D/buyer.pid")"; wait "$(cat "$D/buyer.pid")" 2>/dev/null || true
kill "$(cat "$D/btcd.pid")"; wait "$(cat "$D/btcd.pid")" 2>/dev/null || true
btcd_start --miningaddr="$ADDR"
mine 400 >/dev/null

echo "Starting lnd nodes…"
lnd_start buyer 10019 9745
lnd_start seller 10020 9746
wait_synced buyer
wait_synced seller
funded() { buyer walletbalance | grep -q '"confirmed_balance": "[1-9]'; }
wait_for "buyer funds" funded

echo "Opening a 2,000,000-sat channel from the agent wallet to the provider…"
SELLER_PUBKEY=$(seller getinfo | sed -n 's/.*"identity_pubkey": "\(.*\)".*/\1/p')
buyer connect "$SELLER_PUBKEY@127.0.0.1:9746" >/dev/null
buyer openchannel --node_key="$SELLER_PUBKEY" --local_amt=2000000 >/dev/null
sleep 1
mine 6 >/dev/null
channel_active() { buyer listchannels --active_only | grep -q '"active": true'; }
wait_for "channel to open" channel_active

# Least privilege: the agent's MCP server gets a macaroon that can read and pay invoices, nothing else.
buyer bakemacaroon offchain:read offchain:write info:read --save_to="$D/agent-pay.macaroon" >/dev/null

echo "Starting the paid data service and Aperture…"
SELLER_PUBKEY="$SELLER_PUBKEY" bun "$ROOT/seller/server.ts" >"$D/logs/service.log" 2>&1 &
echo $! >"$D/service.pid"

cat >"$D/aperture.yaml" <<YAML
listenaddr: "127.0.0.1:8700"
insecure: true
autocert: false
debuglevel: "info"
strictverify: true
dbbackend: "sqlite"
sqlite:
  databasefilename: "$D/aperture/aperture.db"
authenticator:
  network: "regtest"
  lndhost: "127.0.0.1:10020"
  tlspath: "$D/seller/tls.cert"
  macdir: "$D/seller/data/chain/bitcoin/regtest"
services:
  - name: "catalog"
    hostregexp: '.*'
    pathregexp: '^/\.well-known/.*$'
    address: "127.0.0.1:8701"
    protocol: http
    price: 0
    authwhitelistpaths: ['^/\.well-known/.*$']
  - name: "hashprice"
    hostregexp: '.*'
    pathregexp: '^/v1/hashprice.*$'
    address: "127.0.0.1:8701"
    protocol: http
    price: 10
  - name: "breakeven"
    hostregexp: '.*'
    pathregexp: '^/v1/breakeven.*$'
    address: "127.0.0.1:8701"
    protocol: http
    price: 50
  - name: "report"
    hostregexp: '.*'
    pathregexp: '^/v1/report.*$'
    address: "127.0.0.1:8701"
    protocol: http
    price: 1000
YAML
mkdir -p "$D/aperture"
aperture --configfile="$D/aperture.yaml" --basedir="$D/aperture" >"$D/logs/aperture.log" 2>&1 &
echo $! >"$D/aperture.pid"
wait_for Aperture curl -sf http://127.0.0.1:8700/.well-known/l402.json

echo
echo "Ready."
echo "  Aperture (L402 proxy):  http://127.0.0.1:8700"
echo "  Provider node:          $SELLER_PUBKEY"
echo "  Agent channel balance:  $(buyer channelbalance | grep -A1 '"local_balance"' | sed -n 's/.*"sat": "\([0-9]*\)".*/\1/p') sats"
echo "  Logs:                   $D/logs"
