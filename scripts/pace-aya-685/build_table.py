#!/usr/bin/env python3
"""#685: 2021-06-20〜2024-08-09 のレース単位の表を作る。#683 の build_table.main をそのまま呼ぶ。
使い方: build_table.py <hist2021.ndjson.gz> <horse_runs.csv> <out.ndjson.gz>
(生データのパスは引数。リポジトリには置かない。)"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pace-mismatch-683"))
import build_table as b683  # noqa: E402

if __name__ == "__main__":
    b683.main(*sys.argv[1:4])
