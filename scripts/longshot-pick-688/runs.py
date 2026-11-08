"""#688: 2 つの hist と horse_runs.csv から、馬ごとの過去走(flags.py に渡す形)を作る道具。

- csv の 1 行 = [日付, ..., raceId(5), 中央/地方(6), 頭数(7), ..., オッズ(10), 人気(11), 着順(12), ..., コース種別(17), 距離(18), ..., 通過順(21), ...]
- 走は raceId で重複除去(hist が csv を上書き)。そのレースの日付より前かどうかの判定は呼び出し側(flags.py は strict に絞る)。
- hist の頭数は取消・除外を除く出走頭数(#687 の build_table.py と同じ)。
"""
from __future__ import annotations

import collections
import csv
import gzip
import json


def load_hist(paths):
    seen, races = set(), []
    for p in paths:
        for line in gzip.open(p, "rt", encoding="utf-8"):
            r = json.loads(line)
            if r["raceId"] in seen:
                continue
            seen.add(r["raceId"])
            races.append(r)
    races.sort(key=lambda r: (r["date"], r["raceId"]))
    return races


def load_csv_runs(path):
    out = collections.defaultdict(dict)
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            d = json.loads(row["data"])
            fin = d[12] if isinstance(d[12], int) and not isinstance(d[12], bool) else None
            out[row["horse_id"]][d[5]] = {
                "date": d[0], "courseType": d[17] if d[17] else None, "passing": list(d[21]) if d[21] else [],
                "entryCount": d[7] if isinstance(d[7], int) else None, "finish": fin,
            }
    return out


def hist_run(r, h, n_start):
    fin = h["finish"] if isinstance(h["finish"], int) else None
    return {"date": r["date"].replace("-", "/"), "courseType": r["courseType"] or None,
            "passing": list(h["passing"]) if h["passing"] else [], "entryCount": n_start, "finish": fin}


def merged_runs(csv_runs, hist_runs_of_horse):
    """csv と hist(raceId → run)を raceId で重複除去して合わせた run のリスト。"""
    m = dict(csv_runs)
    m.update(hist_runs_of_horse)
    return list(m.values())
