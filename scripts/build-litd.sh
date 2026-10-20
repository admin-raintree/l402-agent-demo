#!/usr/bin/env bash
# Build litd and litcli from a pinned Lightning Terminal tag into .bin/. No web UI, so no Node or Yarn.
# litd runs in remote mode against the pinned lnd from build-binaries.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$HOME/Code/scratch/lightning-builds}"
TAG=v0.17.7
DIR="$SRC/lightning-terminal"
export CGO_ENABLED=0 GOBIN="$ROOT/.bin"
mkdir -p "$SRC" "$GOBIN"

[ -d "$DIR" ] || git clone -q --depth 1 --branch "$TAG" https://github.com/lightninglabs/lightning-terminal.git "$DIR"
if [ -n "$(git -C "$DIR" status --porcelain)" ] || [ "$(git -C "$DIR" rev-parse HEAD)" != "$(git -C "$DIR" rev-parse "$TAG^{commit}")" ]; then
  echo "Source must be clean and pinned to $TAG: $DIR. Existing work was preserved." >&2
  exit 1
fi
# Release tags from make/release_flags.mk and make/compile_flags.mk, plus litd_no_ui.
TAGS="litd_no_ui litd autopilotrpc signrpc walletrpc chainrpc invoicesrpc watchtowerrpc neutrinorpc monitoring peersrpc kvdb_postgres kvdb_etcd kvdb_sqlite"
(cd "$DIR" && go install -trimpath -tags="$TAGS" ./cmd/litd ./cmd/litcli)
"$GOBIN/litd" --version
