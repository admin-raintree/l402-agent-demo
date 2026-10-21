#!/usr/bin/env bash
# Build the optional wallet backend with its REST wallet API and swap runtime.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG=v0.2.0-rc2
DIR="${WAVELENGTH_SRC:-$ROOT/.bin/wavelength-src}"
export CGO_ENABLED=0 GOBIN="$ROOT/.bin"
mkdir -p "$GOBIN"

[ -d "$DIR" ] || git clone -q --depth 1 --branch "$TAG" https://github.com/lightninglabs/wavelength.git "$DIR"
if [ -n "$(git -C "$DIR" status --porcelain)" ] || [ "$(git -C "$DIR" rev-parse HEAD)" != "$(git -C "$DIR" rev-parse "$TAG^{commit}")" ]; then
  echo "Source must be clean and pinned to $TAG: $DIR. Existing work was preserved." >&2
  exit 1
fi
if [ "${WAVELENGTH_RC2_ACK_FIX:-0}" = 1 ]; then
  BUILD_DIR=$(mktemp -d "$GOBIN/wavelength-build.XXXXXX")
  trap 'rm -rf "$BUILD_DIR"' EXIT
  git -C "$DIR" archive "$TAG" | tar -x -C "$BUILD_DIR"
  patch -d "$BUILD_DIR" -p1 < "$ROOT/patches/wavelength-rc2-local-ack.patch"
  (
    cd "$BUILD_DIR"
    go test ./oor -count=1
    go build -buildvcs=false -tags="wavewalletrpc swapruntime" \
      -ldflags='-X github.com/lightninglabs/wavelength/build.CommitHash=952e6ca+local-ack' \
      -o "$GOBIN/waved-rc2-local" ./cmd/waved
  )
  echo "Built $GOBIN/waved-rc2-local: RC2 with the local acknowledgment patch (not an upstream release)."
else
  (cd "$DIR" && go install -tags="wavewalletrpc swapruntime" ./cmd/waved ./cmd/wavecli)
  "$GOBIN/waved" --version
fi
