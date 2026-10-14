"""項目3・5(拡張): 取得済み頭数分の戦績の行のうち、日付が ZIP の収録月に入る地方の行を、(競馬場・日付・R・馬番)で ZIP の出走行と突き合わせる。

結果ページ7本の比較(compare_races.py)より、レース・競馬場・日付が散らばった標本になる。
使い方: python3 -I compare_history_rows.py --zip-dir <dir> --fixtures <fixtures> --raw-dir <netkeiba 取得物> --months 202607 202609 [--json-out x.json]
ネットワークには出ない。出力に馬名は含めない。
"""
import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_zip_month, parse_results_table, VENUE_CODE  # noqa: E402
from compare_races import time4_to_text  # noqa: E402
from reconstruct_history import venue_of  # noqa: E402


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()

    zrow = {}  # (競馬場, 日付8桁, R, 馬番) -> 行
    zrace = {}
    for ym in a.months:
        m = load_zip_month(a.zip_dir, ym)
        for x in m["horselist"]:
            zrow[(x["競馬場"], x["競走年月日"], x["レース番号"], x["馬番"])] = x
        for x in m["racelist"]:
            zrace[(x["競馬場"], x["競走年月日"], x["レース番号"])] = x
    months = set(a.months)
    blank_in_race = Counter()
    for k, x in zrow.items():
        if x["着順"] == "":
            blank_in_race[(k[0], k[1], k[2])] += 1

    files = glob.glob(os.path.join(a.raw_dir, "horse_results_*.json")) + [os.path.join(a.fixtures, "horse_results_2021104387.json")]
    n = Counter()
    eq = Counter()
    diffs = defaultdict(list)
    nhist = nmatch = nin = 0
    nonnum = Counter()
    for f in files:
        for r in parse_results_table(f):
            nhist += 1
            kind, v = venue_of(r["開催"])
            d = r["日付"].replace("/", "")
            if kind != "nar" or d[:6] not in months:
                continue
            nin += 1
            key = (v, d, r["R"], r["馬番"])
            z = zrow.get(key)
            if z is None:
                diffs["対応する行が無い"].append(key)
                continue
            nmatch += 1
            rc = zrace[(v, d, r["R"])]

            def add(field, x, y):
                n[field] += 1
                if x == y:
                    eq[field] += 1
                else:
                    diffs[field].append((v, d, r["R"], r["馬番"], x, y))

            add("枠番", z["枠番"], r["枠番"])
            add("着順(数字か空)", z["着順"], r["着順"] if r["着順"].isdigit() else "")
            if not r["着順"].isdigit():
                nonnum[(r["着順"], z["着順"] == "")] += 1
            add("人気", z["人気"], r["人気"])
            add("斤量(減量記号を除く)", num(z["負担重量"].lstrip("△▲☆◇★")), num(r["斤量"]))
            add("距離(数字)", int(rc["距離"]), int(r["距離"][1:]) if r["距離"][1:].isdigit() else None)
            add("頭数(そのまま)", int(rc["頭数"]), num(r["頭数"]) and int(num(r["頭数"])))
            add("頭数(ZIPの頭数から着順が空の行の数を引く)", int(rc["頭数"]) - blank_in_race[(v, d, r["R"])], num(r["頭数"]) and int(num(r["頭数"])))
            if r["着順"].isdigit():
                add("タイム", time4_to_text(z["タイム"]), r["タイム"])
                # 戦績の『着差』列は秒差(例 0.7)で、ZIP の『着差』は馬身の文字(例 クビ)。意味が違うので突き合わせない。
            w = r["馬体重"]
            if w and w not in ("計不", "-"):
                head = w.split("(")[0]
                add("馬体重", z["馬体重"], head)
    print(f"{len(files)}頭の戦績の行={nhist}  うち収録月内の地方の行={nin}  馬番まで含めて ZIP の行を引けた行={nmatch}")
    out = {"戦績の行": nhist, "収録月内の地方の行": nin, "ZIPの行を引けた": nmatch, "着順が数字でない行(netkeiba の着順,ZIPの着順が空か)": {f"{k[0]}|{k[1]}": v for k, v in nonnum.items()}, "fields": {}}
    for f in sorted(n):
        print(f"  {f}: 一致 {eq[f]}/{n[f]}")
        out["fields"][f] = {"n": n[f], "一致": eq[f]}
        for d in diffs[f][:6]:
            print("      食い違い", d)
    if diffs["対応する行が無い"]:
        print("  対応する行が無い:", diffs["対応する行が無い"][:5], len(diffs["対応する行が無い"]))
    print("  着順が数字でない行:", dict(nonnum))
    if a.json_out:
        json.dump(out, open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
