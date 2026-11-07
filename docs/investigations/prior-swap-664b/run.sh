#!/bin/bash
# 使い方: run.sh <材料ディレクトリ(scratchpad)> <候補 id>...   リポジトリのルートで実行する。
S="$1"; shift
for id in "$@"; do
  pnpm tsx docs/investigations/prior-swap-664b/replay664.ts "$S/alloc/allocation-dataset.ndjson.gz" "$S/s649/replay.ndjson.gz" "$S/p662/coef-pre-holdout.json" "$S/p664b/coef-664.json" "$S/p664/feat664.ndjson.gz" "$S/s649/extras.ndjson.gz" "$S/p664b/out" "$id"
done
