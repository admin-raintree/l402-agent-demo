#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export L402_DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/l402-workspace.XXXXXX")"
export L402_STATE_DIR="$L402_DEMO_DIR/agent"
export L402_FIXED_MARKET=1
export L402_WALLET=lnd
trap '"$ROOT/scripts/down.sh"' EXIT
printf 'Local test workspace: %s\n' "$L402_DEMO_DIR"
"$ROOT/scripts/up.sh"
bun "$ROOT/dashboard/server.ts"
