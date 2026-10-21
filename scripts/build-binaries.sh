#!/usr/bin/env bash
# Build btcd, lnd, and Aperture from pinned source tags into .bin/. Pure Go, no Docker or Xcode.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$HOME/Code/scratch/lightning-builds}"
export CGO_ENABLED=0 GOBIN="$ROOT/.bin"
mkdir -p "$SRC" "$GOBIN"

clone() {
  local dir="$SRC/$2"
  [ -d "$dir" ] || git clone -q --depth 1 --branch "$3" "$1" "$dir"
  if [ -n "$(git -C "$dir" status --porcelain)" ] || [ "$(git -C "$dir" rev-parse HEAD)" != "$(git -C "$dir" rev-parse "$3^{commit}")" ]; then
    echo "Source must be clean and pinned to $3: $dir. Existing work was preserved." >&2
    exit 1
  fi
}
clone https://github.com/btcsuite/btcd.git btcd v0.26.2
clone https://github.com/lightningnetwork/lnd.git lnd-v0.21.4-beta v0.21.4-beta
clone https://github.com/lightninglabs/aperture.git aperture v0.5.0

(cd "$SRC/btcd" && go install . ./cmd/btcctl)
(cd "$SRC/lnd-v0.21.4-beta" && go install -tags="signrpc walletrpc chainrpc invoicesrpc routerrpc peersrpc" ./cmd/lnd ./cmd/lncli)
(cd "$SRC/aperture" && go install ./cmd/aperture)
ls "$GOBIN"
