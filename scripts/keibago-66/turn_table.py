"""項目5-F: ZIP の racelist で、`回り` は『競馬場×芝ダート区分』や『競馬場×芝ダート区分×距離』の関数か。

使い方: python3 -I turn_table.py --zip-dir <dir> --months 202607 202609 [--json-out turn_table.json]
"""
import argparse
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_zip_month  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()
    races = []
    for ym in a.months:
        races += load_zip_month(a.zip_dir, ym)["racelist"]
    print(f"レース数={len(races)}  回りの値={dict(Counter(r['回り'] for r in races))}")

    by_v = defaultdict(Counter)
    by_vk = defaultdict(Counter)
    by_vkd = defaultdict(Counter)
    for r in races:
        kind = r["芝ダート区分"] or "(空)"
        by_v[r["競馬場"]][r["回り"]] += 1
        by_vk[(r["競馬場"], kind)][r["回り"]] += 1
        by_vkd[(r["競馬場"], kind, r["距離"])][r["回り"]] += 1
    print("\n競馬場ごとの回り(レース数)")
    out = {}
    for v in sorted(by_v):
        print(f"  {v}: {dict(by_v[v])}")
        out[v] = dict(by_v[v])
    multi_v = [v for v, c in by_v.items() if len(c) > 1]
    multi_vk = [k for k, c in by_vk.items() if len(c) > 1]
    multi_vkd = [k for k, c in by_vkd.items() if len(c) > 1]
    print(f"\n回りが複数ある競馬場={len(multi_v)}  (競馬場×種別)={len(multi_vk)}  (競馬場×種別×距離)={len(multi_vkd)}")
    print("(競馬場×種別)の組み合わせ数:", len(by_vk), " (競馬場×種別×距離)の組み合わせ数:", len(by_vkd))
    for k in multi_vk:
        print("  複数:", k, dict(by_vk[k]))
    print("\n(競馬場×種別)ごとの回り:")
    for k in sorted(by_vk):
        print(" ", k, dict(by_vk[k]))
    if a.json_out:
        json.dump({"競馬場ごとの回り": out, "回りが複数の競馬場": multi_v,
                   "競馬場x種別ごとの回り": {f"{k[0]}|{k[1]}": dict(c) for k, c in sorted(by_vk.items())},
                   "競馬場x種別x距離の組み合わせ数": len(by_vkd), "回りが複数の競馬場x種別x距離": len(multi_vkd)},
                  open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
