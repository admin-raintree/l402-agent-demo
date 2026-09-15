#!/usr/bin/env bash
# Build btcd, lnd, and Aperture from pinned source tags into .bin/. Pure Go, no Docker or Xcode.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$HOME/Code/scratch/lightning-builds}"
export CGO_ENABLED=0 GOBIN="$ROOT/.bin"
mkdir -p "$SRC" "$GOBIN"

clone() { [ -d "$SRC/$2" ] || git clone -q --depth 1 --branch "$3" "$1" "$SRC/$2"; }
clone https://github.com/btcsuite/btcd.git btcd v0.26.2
clone https://github.com/lightningnetwork/lnd.git lnd v0.21.3-beta
clone https://github.com/lightninglabs/aperture.git aperture v0.5.0

(cd "$SRC/btcd" && go install . ./cmd/btcctl)
(cd "$SRC/lnd" && go install -tags="signrpc walletrpc chainrpc invoicesrpc routerrpc peersrpc" ./cmd/lnd ./cmd/lncli)
(cd "$SRC/aperture" && go install ./cmd/aperture)
ls "$GOBIN"
