#!/usr/bin/env python3
"""#684: #683 の表に、ハナ候補の定義(D1・D2)を足したレース単位の表を作る。

使い方: build_table.py <hist.ndjson.gz> <horse_runs.csv> <out.ndjson.gz>
(生データのパスは引数。リポジトリには置かない。)

#683 の build_table.py と同じ過去走の集め方(そのレースの日付より前だけ。csv と hist を raceId で重複除去。
通過順が空の走は数えない)。馬ごとに次を足す。
- d1: 前走(通過順のある直近の走)の passing[0] == 1。過去走なしは None。
- d2: 直近 3 走(通過順のある走)のうち passing[0] <= 2 が 1 回以上。過去走なしは None。
d1・d2 が None の馬と、脚質 style が None の馬は同じ(通過順のある過去走が 0 本)。
"""
from __future__ import annotations

import collections
import csv
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pace-mismatch-683"))
from legstyle import horse_style  # noqa: E402


def hana_flags(runs):
    """runs: [(passing, field_size)] 新しい順(通過順は空でない)。"""
    if not runs:
        return None, None
    d1 = runs[0][0][0] == 1
    d2 = any(p[0] <= 2 for p, _ in runs[:3])
    return d1, d2


def main(hist_path, csv_path, out_path):
    csvruns = collections.defaultdict(dict)
    with open(csv_path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            d = json.loads(r["data"])
            csvruns[r["horse_id"]][d[5]] = (d[0].replace("/", "-"), d[21], d[7])
    races = [json.loads(l) for l in gzip.open(hist_path, "rt", encoding="utf-8")]
    races.sort(key=lambda r: (r["date"], r["raceId"]))
    hrun = collections.defaultdict(dict)
    out = []
    for r in races:
        starters = [h for h in r["horses"] if h["finishStatus"] not in ("取消", "除外")]
        n_start = len(starters)
        horses = []
        for h in starters:
            m = {}
            for rid, (dt, p, fs) in csvruns.get(h["horseId"], {}).items():
                if dt < r["date"] and p:
                    m[rid] = (dt, p, fs)
            for rid, v in hrun.get(h["horseId"], {}).items():
                if v[0] < r["date"] and v[1]:
                    m[rid] = v
            runs = [(p, fs) for dt, p, fs in sorted(m.values(), key=lambda x: x[0], reverse=True)]
            d1, d2 = hana_flags(runs)
            horses.append({
                "umaban": h["umaban"], "ninki": h["ninki"], "odds": h["winOdds"],
                "style": horse_style(runs), "nprior": len(runs), "d1": d1, "d2": d2,
                "finish": h["finish"], "status": h["finishStatus"],
            })
        out.append({
            "raceId": r["raceId"], "date": r["date"], "courseType": r["courseType"],
            "raceClass": r.get("raceClass"), "weightType": r.get("weightType"),
            "distance": r["distance"], "nStart": n_start, "horses": horses,
            "payouts": {"win": r["payouts"]["win"], "place": r["payouts"]["place"]},
        })
        for h in r["horses"]:
            if h["passing"] and h["finishStatus"] not in ("取消", "除外"):
                hrun[h["horseId"]][r["raceId"]] = (r["date"], h["passing"], n_start)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        for x in out:
            f.write(json.dumps(x, ensure_ascii=False) + "\n")
    print("races", len(out))


if __name__ == "__main__":
    main(*sys.argv[1:4])
