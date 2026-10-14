"""ZIP だけで分かること(netkeiba に出ない): 馬の同定キーの一意性、列ごとの欠損の型、着順が空の行の意味。

使い方: python3 -I zip_stats.py --zip-dir <dir> --months 202607 202609 [--json-out x.json]
ネットワークには出ない。出力に馬名は含めない。
"""
import argparse
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_zip_month, race_id_of, parse_record  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()
    rows, races = [], {}
    for ym in a.months:
        m = load_zip_month(a.zip_dir, ym)
        rows += m["horselist"]
        for x in m["racelist"]:
            races[race_id_of(x)] = x
    flat = [r for r in rows if r["競馬場"] != "帯広ば"]
    out = {"出走行(帯広ばを除く)": len(flat), "出走行(全体)": len(rows)}
    print(f"出走行(全体)={len(rows)}  帯広ばを除く={len(flat)}")

    # 1. 馬の同定
    names = defaultdict(set)
    for r in flat:
        names[r["馬名"]].add((r["生年月日"], r["父馬名"], r["母馬名"]))
    multi = {n: s for n, s in names.items() if len(s) > 1}
    print(f"\n馬名の種類={len(names)}  同じ馬名で(生年月日,父,母)が複数ある馬名={len(multi)}")
    keys = defaultdict(set)
    for r in flat:
        keys[(r["馬名"], r["生年月日"])].add((r["父馬名"], r["母馬名"]))
    print(f"(馬名,生年月日)の種類={len(keys)}  同じ(馬名,生年月日)で父母が異なるもの={sum(1 for s in keys.values() if len(s) > 1)}")
    out["馬名の種類"] = len(names)
    out["同名で別の馬(生年月日,父,母が異なる)の馬名数"] = len(multi)
    out["(馬名,生年月日)の種類"] = len(keys)

    # 同一レース内での馬名の重複
    per_race = defaultdict(list)
    for r in flat:
        per_race[race_id_of(r)].append(r["馬名"])
    dup_in_race = sum(1 for v in per_race.values() if len(v) != len(set(v)))
    print(f"同じレースに同じ馬名が2回出るレース={dup_in_race} / {len(per_race)}")
    out["同じレースに同名が2回出るレース"] = dup_in_race

    # 2. 列ごとの欠損(帯広ばを除く)。競馬場ごと
    cols = ["馬体重", "馬体重増減", "ダート左成績", "ダート右成績", "当競馬場成績", "うち当距離成績", "最高タイム", "最高タイム良馬場", "着順", "タイム", "上がり3F", "人気"]
    by_v = defaultdict(lambda: Counter())
    nv = Counter()
    for r in flat:
        nv[r["競馬場"]] += 1
        for c in cols:
            if r[c] == "":
                by_v[r["競馬場"]][c] += 1
    print("\n列が空の行の数(競馬場ごと / 出走行)")
    print("  " + " ".join(f"{c}" for c in cols))
    tbl = {}
    for v in sorted(nv):
        print(f"  {v}({nv[v]}): " + " ".join(f"{by_v[v][c]}" for c in cols))
        tbl[v] = {"出走行": nv[v], **{c: by_v[v][c] for c in cols}}
    out["競馬場ごとの空欄数"] = tbl
    # 体重があるのに増減が空
    wi = Counter()
    wt_text = Counter()
    per_race_inc = defaultdict(list)
    for r in flat:
        if not r["馬体重"].isnumeric():
            wt_text[r["馬体重"]] += 1
            continue
        per_race_inc[race_id_of(r)].append(r["馬体重増減"] == "")
        if r["馬体重増減"] == "":
            wi[r["競馬場"]] += 1
    print(f"\n馬体重が数字でない行の値の分布={dict(wt_text)}")
    print(f"馬体重が数字なのに増減が空の行(競馬場ごと)={dict(wi)}  合計={sum(wi.values())}")
    cls = Counter("全頭が空" if all(v) else ("一部が空" if any(v) else "空なし") for v in per_race_inc.values())
    print(f"増減の空欄のレース単位の分類(馬体重が数字の行があるレース)={dict(cls)}")
    out["馬体重が数字でない行の値の分布"] = dict(wt_text)
    out["馬体重が数字なのに増減が空(競馬場別)"] = dict(wi)
    out["増減の空欄のレース単位の分類"] = dict(cls)
    zero = Counter()
    for r in flat:
        if r["馬体重増減"] in ("0", "+0", "-0"):
            zero[r["競馬場"]] += 1
    print(f"増減が 0 の行(競馬場ごと)={dict(zero)}")
    out["増減が0の行"] = dict(zero)

    # 3. 着順が空の行
    blank = [r for r in flat if r["着順"] == ""]
    maxd = max(r["競走年月日"] for r in flat)
    print(f"\nZIP の最終日={maxd}  着順が空の行={len(blank)}")
    bd = Counter()
    for r in blank:
        w = r["馬体重"]
        wk = "体重が数字" if w.isnumeric() else f"体重が{w!r}"
        bd[(r["競走年月日"] == maxd, wk, "人気あり" if r["人気"] else "人気なし", "タイムあり" if r["タイム"] else "タイムなし")] += 1
    for k, v in sorted(bd.items(), key=lambda kv: -kv[1]):
        print("  ", k, v)
    out["着順が空の行"] = {"件数": len(blank), "ZIPの最終日": maxd,
                      "内訳": {"|".join(map(str, k)): v for k, v in bd.items()}}

    # 3b. 頭数と行数・着順が空の行数
    cnt, blk = Counter(), Counter()
    for r in rows:
        k = race_id_of(r)
        cnt[k] += 1
        blk[k] += 1 if r["着順"] == "" else 0
    same_all = sum(1 for k, rc in races.items() if rc["頭数"] != "" and int(rc["頭数"]) == cnt[k])
    flat_races = {k: rc for k, rc in races.items() if rc["競馬場"] != "帯広ば"}
    with_blank = sum(1 for k in flat_races if blk[k] > 0)
    print(f"\nレース数(全体)={len(races)}  racelist の頭数 == horselist の行数 のレース={same_all}")
    print(f"レース数(帯広ばを除く)={len(flat_races)}  着順が空の行を含むレース={with_blank}")
    out["レース数(全体)"] = len(races)
    out["頭数==出走表の行数のレース(全体)"] = same_all
    out["レース数(帯広ばを除く)"] = len(flat_races)
    out["着順が空の行を含むレース(帯広ばを除く)"] = with_blank

    # 4. 全成績の合計と他の列の整合
    bad = 0
    for r in flat:
        t = parse_record(r["全成績"])
        l = parse_record(r["ダート左成績"])
        rr = parse_record(r["ダート右成績"])
        c = parse_record(r["当競馬場成績"])
        d = parse_record(r["うち当距離成績"])
        if None in (t, l, rr, c, d):
            bad += 1
            continue
        if not all(sum(x) <= sum(t) for x in (l, rr, c, d)) or sum(d) > sum(c):
            bad += 1
    print(f"\n全成績 >= 左・右・当競馬場・当距離、当距離 <= 当競馬場 が崩れる行(空欄行を含む)={bad} / {len(flat)}")
    out["成績列の包含関係が崩れる行"] = bad
    if a.json_out:
        json.dump(out, open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
