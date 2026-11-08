#!/usr/bin/env python3
"""#683: hist.ndjson.gz と horse_runs.csv から、レース単位の表(脚質・人気・オッズ・結果)を作る。

使い方: build_table.py <hist.ndjson.gz> <horse_runs.csv> <out.ndjson.gz>
(生データのパスは引数。リポジトリには置かない。)

- 過去走 = csv の走 + hist 内のそのレースより前の走(raceId で重複除去)。**そのレースの日付より前**(同日を含めない)だけ。
- 過去走の頭数: csv は出走頭数、hist は取消・除外を除いた頭数。
- 脚質 = legstyle.horse_style(本番 analyzeHorseLegStyle の style と同じ。直近 3 走)。
- 出力は 1 行 1 レース。結果(finish)・払戻も同じ表に入れるが、計画の確定前は特徴量以外を読まない
  (thresholds.py は特徴量の列だけを読む)。
"""
from __future__ import annotations

import collections
import csv
import gzip
import json
import sys

from legstyle import horse_style


def main(hist_path, csv_path, out_path):
    csvruns = collections.defaultdict(dict)
    with open(csv_path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            d = json.loads(r["data"])
            # d: [日付, ..., raceId(5), ..., 頭数(7), ..., 通過順(21), ...]
            csvruns[r["horse_id"]][d[5]] = (d[0].replace("/", "-"), d[21], d[7])
    races = [json.loads(l) for l in gzip.open(hist_path, "rt", encoding="utf-8")]
    races.sort(key=lambda r: (r["date"], r["raceId"]))
    hrun = collections.defaultdict(dict)  # 馬 -> raceId -> (日付, 通過順, 頭数)
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
            horses.append({
                "umaban": h["umaban"], "ninki": h["ninki"], "odds": h["winOdds"],
                "style": horse_style(runs), "nprior": len(runs),
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
