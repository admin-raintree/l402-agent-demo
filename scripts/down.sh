#!/usr/bin/env bash
# Stop every process started by up.sh and wait for it to exit, so ports are free for the next run.
D="$(cd "$(dirname "$0")/.." && pwd)/.demo"
pids=()
for f in "$D"/*.pid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f") && kill "$pid" 2>/dev/null && pids+=("$pid")
  rm -f "$f"
done
for _ in $(seq 40); do
  alive=0
  for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
  [ "$alive" = 0 ] && break
  sleep 0.5
done
for pid in "${pids[@]}"; do kill -9 "$pid" 2>/dev/null; done
echo "Stopped."
