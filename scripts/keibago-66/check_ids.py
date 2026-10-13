"""項目3(1/2): ZIP から組み立てた race_id の集合と、netkeiba のレース一覧フィクスチャの race_id の集合を日ごとに突き合わせる。

使い方: python3 -I check_ids.py --zip-dir <dir> --fixtures <fixtures dir> --months 202607 202609
ネットワークには出ない。
"""
import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_zip_month, race_id_of, CODE_VENUE  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()

    ids = {}
    for ym in a.months:
        m = load_zip_month(a.zip_dir, ym)
        for x in m["racelist"]:
            ids.setdefault(x["競走年月日"], []).append(race_id_of(x))
    # ZIP 内で race_id が重複していないか
    dup = sum(1 for d, l in ids.items() if len(l) != len(set(l)))
    print(f"ZIP の日数={len(ids)} race_id の重複がある日={dup}")

    total_f = total_z = total_both = 0
    days = []
    for fn in sorted(os.listdir(a.fixtures)):
        mm = re.fullmatch(r"nar_race_list_sub_(\d{8})\.html", fn)
        if not mm:
            continue
        d = mm.group(1)
        if d not in ids:
            print(f"{d}: ZIP に該当月なし(対象外)")
            continue
        s = open(os.path.join(a.fixtures, fn), encoding="utf-8").read()
        f = set(re.findall(r"race_id=(\d{12})", s))
        z = set(ids[d])
        total_f += len(f)
        total_z += len(z)
        total_both += len(f & z)
        venues = Counter(CODE_VENUE.get(r[4:6], r[4:6]) for r in f)
        days.append({"日": d, "フィクスチャ": len(f), "ZIP": len(z), "共通": len(f & z), "場": dict(venues)})
        print(f"{d}: フィクスチャ={len(f)} ZIP={len(z)} 共通={len(f & z)} "
              f"フィクスチャのみ={len(f - z)} ZIPのみ={len(z - f)} 場={dict(venues)}")
        if f - z:
            print("   フィクスチャのみ:", sorted(f - z)[:6])
        if z - f:
            print("   ZIPのみ:", sorted(z - f)[:6])
    print(f"合計: フィクスチャ={total_f} ZIP={total_z} 共通={total_both}")
    if a.json_out:
        import json
        json.dump({"ZIPの日数": len(ids), "race_idの重複がある日": dup, "日別": days,
                   "合計": {"フィクスチャ": total_f, "ZIP": total_z, "共通": total_both}},
                  open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
