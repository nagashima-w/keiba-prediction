#!/usr/bin/env python3
"""#687: 2 つの hist と horse_runs.csv から、レース単位の表(脚質・ハナ候補・人気・オッズ・結果・過去走の参照)を作る。

使い方: build_table.py <hist1.ndjson.gz> [<hist2.ndjson.gz> ...] <horse_runs.csv> <out.ndjson.gz>
(最後の 2 つ以外が hist。生データのパスは引数。リポジトリには置かない。)

- hist を raceId で重複除去して日付順に並べ、連続した履歴にする。
- 脚質・d1・d2 は #683・#684 と同じ(csv と hist の過去走を raceId で重複除去、そのレースの日付より前、通過順が空の走は数えない)。
- pri = 馬ごとの hist 内の過去走(障害でなく paceClass のある走)のうち、そのレースの日付より前で 730 日以内のものの [日数, raceId]。
  過去走の成績 (y, q, 頭数) は、後段が同じ表の raceId・horseId から引く。
"""
from __future__ import annotations

import collections
import csv
import datetime
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pace-mismatch-683"))
from legstyle import horse_style  # noqa: E402

WINDOW_DAYS = 730


def days(d):
    return datetime.date.fromisoformat(d).toordinal()


def main(hist_paths, csv_path, out_path):
    csvruns = collections.defaultdict(dict)
    with open(csv_path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            d = json.loads(r["data"])
            csvruns[r["horse_id"]][d[5]] = (d[0].replace("/", "-"), d[21], d[7])
    seen, races = set(), []
    for p in hist_paths:
        for line in gzip.open(p, "rt", encoding="utf-8"):
            r = json.loads(line)
            if r["raceId"] in seen:
                continue
            seen.add(r["raceId"])
            races.append(r)
    races.sort(key=lambda r: (r["date"], r["raceId"]))
    hrun = collections.defaultdict(dict)  # 馬 -> raceId -> (日付, 通過順, 頭数)
    hres = collections.defaultdict(list)  # 馬 -> [(日数, raceId)]  paceClass のある走
    out = []
    for r in races:
        starters = [h for h in r["horses"] if h["finishStatus"] not in ("取消", "除外")]
        n_start = len(starters)
        today = days(r["date"])
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
            pri = [[today - d, rid] for d, rid in hres.get(h["horseId"], []) if 0 < today - d <= WINDOW_DAYS]
            horses.append({
                "horseId": h["horseId"], "umaban": h["umaban"], "ninki": h["ninki"], "odds": h["winOdds"],
                "style": horse_style(runs), "nprior": len(runs),
                "d1": (runs[0][0][0] == 1) if runs else None,
                "d2": any(p[0] <= 2 for p, _ in runs[:3]) if runs else None,
                "finish": h["finish"], "status": h["finishStatus"], "pri": pri,
            })
        out.append({
            "raceId": r["raceId"], "date": r["date"], "courseType": r["courseType"],
            "raceClass": r.get("raceClass"), "weightType": r.get("weightType"),
            "distance": r["distance"], "nStart": n_start, "pc": r.get("paceClass"),
            "venue": r.get("venueName"), "grade": r.get("grade"), "detail": r.get("courseDetail"), "horses": horses,
            "payouts": {"win": r["payouts"]["win"], "place": r["payouts"]["place"]},
        })
        for h in starters:
            if r.get("paceClass"):
                hres[h["horseId"]].append((today, r["raceId"]))
        for h in r["horses"]:
            if h["passing"] and h["finishStatus"] not in ("取消", "除外"):
                hrun[h["horseId"]][r["raceId"]] = (r["date"], h["passing"], n_start)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        for x in out:
            f.write(json.dumps(x, ensure_ascii=False) + "\n")
    print("races", len(out))


if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[:-2], a[-2], a[-1])
