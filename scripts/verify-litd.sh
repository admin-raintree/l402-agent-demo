#!/usr/bin/env bash
# Start a fresh regtest network (up.sh attaches litd in remote mode with accounts enabled), test
# the account allowance outside the MCP policy, then run a subscription through the MCP wallet
# with an account macaroon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export L402_DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/l402-litd.XXXXXX")"
export L402_FIXED_MARKET=1
trap '"$ROOT/scripts/down.sh"' EXIT
printf 'Verification state: %s\n' "$L402_DEMO_DIR"
"$ROOT/scripts/up.sh"

bun "$ROOT/scripts/litd-allowance.ts"
bun "$ROOT/scripts/litd-subscription-smoke.ts"
