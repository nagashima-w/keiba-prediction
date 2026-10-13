"""項目6: netkeiba の戦績(ajax_horse_results)の各列が、未ログインでどれだけ埋まっているか(取得済み 20 頭の全行で数える)。

使い方: python3 -I netkeiba_columns.py --fixtures <fixtures> --raw-dir <dir> [--json-out x.json]
ネットワークには出ない。
"""
import argparse
import glob
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import parse_results_table  # noqa: E402

EMPTY = {"", "**", "&nbsp;", "\xa0", "--", "-"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()
    files = glob.glob(os.path.join(a.raw_dir, "horse_results_*.json")) + [os.path.join(a.fixtures, "horse_results_2021104387.json")]
    filled, kinds, n = Counter(), Counter(), 0
    cols = None
    for f in files:
        for r in parse_results_table(f):
            n += 1
            cols = list(r.keys())
            for k, v in r.items():
                if v.strip() not in EMPTY:
                    filled[k] += 1
                if v.strip() == "**":
                    kinds[k] += 1
    print(f"行数={n}  列数={len(cols)}")
    out = {"行数": n, "列数": len(cols), "列ごとの非空の行数": {}}
    for k in cols:
        name = k.split("\n")[0]
        print(f"  {name}: 非空 {filled[k]}/{n}  ('**' の行 {kinds[k]})")
        out["列ごとの非空の行数"][name] = {"非空": filled[k], "**": kinds[k]}
    if a.json_out:
        json.dump(out, open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
