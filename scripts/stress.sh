#!/usr/bin/env bash
# F1 acceptance: the concurrency suite must pass 20 consecutive times.
set -euo pipefail
for i in $(seq 1 20); do
  echo "== stress run $i/20"
  npx jest -c jest.int.config.js --runInBand concurrency
done
echo "stress: 20/20 green"
