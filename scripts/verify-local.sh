#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export L402_DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/l402-regtest.XXXXXX")"
export L402_FIXED_MARKET=1
export L402_WALLET=lnd
trap '"$ROOT/scripts/down.sh"' EXIT
printf 'Verification state: %s\n' "$L402_DEMO_DIR"
"$ROOT/scripts/up.sh"
bun "$ROOT/scripts/macaroon-scope.ts"
bun "$ROOT/scripts/smoke.ts"
bun "$ROOT/scripts/task-smoke.ts"
bun "$ROOT/scripts/subscription-smoke.ts"
