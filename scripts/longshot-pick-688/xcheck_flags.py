#!/usr/bin/env python3
"""4 印の Python 移植(flags.py)を、本番の computeShadowFlags(TS)と突き合わせる。

使い方(リポジトリのルートで):
  python3 scripts/longshot-pick-688/xcheck_flags.py <hist2021> <hist> <horse_runs.csv> <out.json>
実データの (馬, レース) を無作為に抽出した 2,500 件(馬の全戦績を渡し、今回以降の走が混ざる入力を含む)と、端の合成ケースを合わせて突き合わせる。
結果の 3着内・払戻は読まない(着順は過去走の入力としてのみ使う)。
"""
import collections
import json
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import flags  # noqa: E402
import runs as R  # noqa: E402

N_REAL = 2500


def real_cases(hist_paths, csv_path, rng):
    races = R.load_hist(hist_paths)
    csvr = R.load_csv_runs(csv_path)
    hist_by_horse = collections.defaultdict(dict)
    pairs = []
    for r in races:
        st = [h for h in r["horses"] if h["finishStatus"] not in ("取消", "除外")]
        for h in st:
            hist_by_horse[h["horseId"]][r["raceId"]] = R.hist_run(r, h, len(st))
        inv = {h["horseId"]: 1.0 / h["winOdds"] for h in st if h["winOdds"]}
        tot = sum(inv.values())
        for h in st:
            if r["date"] >= "2021-06-20" and h["horseId"] in inv:
                pairs.append((r["date"], r["courseType"], h["horseId"], inv[h["horseId"]] / tot))
    out = []
    for date, ct, hid, q in rng.sample(pairs, N_REAL):
        runs = R.merged_runs(csvr.get(hid, {}), hist_by_horse.get(hid, {}))  # 全戦績(今回以降の走を含む)
        out.append({"runs": runs, "today": {"date": date.replace("-", "/"), "courseType": ct}, "q": q, "kind": "real"})
    return out


def synthetic_cases(rng, n=1500):
    base = "2024/06/15"
    import datetime
    t0 = datetime.date(2024, 6, 15)

    def d(off):
        return (t0 - datetime.timedelta(days=off)).strftime("%Y/%m/%d")
    offsets = [-30, 0, 1, 2, 14, 100, 179, 180, 181, 182, 365, 800]
    out = []
    fixed = [
        # 過去走なし
        {"runs": [], "today": {"date": base, "courseType": "芝"}, "q": 0.03},
        # 今回と同じ日・今回より後の走だけ
        {"runs": [{"date": d(0), "courseType": "芝", "passing": [1], "entryCount": 8, "finish": 1}, {"date": d(-5), "courseType": "芝", "passing": [1], "entryCount": 8, "finish": 1}], "today": {"date": base, "courseType": "芝"}, "q": 0.03},
        # 前走 180 日 / 181 日
        {"runs": [{"date": d(180), "courseType": "芝", "passing": [3], "entryCount": 16, "finish": 5}], "today": {"date": base, "courseType": "芝"}, "q": 0.1},
        {"runs": [{"date": d(181), "courseType": "芝", "passing": [3], "entryCount": 16, "finish": 5}], "today": {"date": base, "courseType": "芝"}, "q": 0.1},
        # 通過順/頭数がちょうど 0.125
        {"runs": [{"date": d(20), "courseType": "ダ", "passing": [2], "entryCount": 16, "finish": 5}], "today": {"date": base, "courseType": "芝"}, "q": 0.1},
        {"runs": [{"date": d(20), "courseType": "ダ", "passing": [3], "entryCount": 16, "finish": 5}], "today": {"date": base, "courseType": "芝"}, "q": 0.1},
        # q = 0.05 ちょうど、平均着順 11.5 ちょうど
        {"runs": [{"date": d(20 + i), "courseType": "芝", "passing": [5], "entryCount": 18, "finish": f} for i, f in enumerate([12, 11, 99])] , "today": {"date": base, "courseType": "芝"}, "q": 0.05},
        {"runs": [{"date": d(20 + i), "courseType": "芝", "passing": [5], "entryCount": 18, "finish": f} for i, f in enumerate([12, 11])], "today": {"date": base, "courseType": "芝"}, "q": 0.0499999},
        {"runs": [{"date": d(20 + i), "courseType": "芝", "passing": [5], "entryCount": 18, "finish": f} for i, f in enumerate([12, 11])], "today": {"date": base, "courseType": "芝"}, "q": 0.05},
        # 非数値の着順だけ
        {"runs": [{"date": d(20 + i), "courseType": "芝", "passing": [5], "entryCount": 18, "finish": None} for i in range(3)], "today": {"date": base, "courseType": "芝"}, "q": 0.01},
        # 通過順が空・頭数 0・頭数 null・コース種別 null
        {"runs": [{"date": d(20), "courseType": None, "passing": [], "entryCount": 0, "finish": 3}], "today": {"date": base, "courseType": "芝"}, "q": 0.2},
        {"runs": [{"date": d(20), "courseType": "芝", "passing": [1], "entryCount": None, "finish": 3}], "today": {"date": base, "courseType": "芝"}, "q": 0.2},
        # q が null
        {"runs": [{"date": d(20), "courseType": "芝", "passing": [1], "entryCount": 8, "finish": 15}], "today": {"date": base, "courseType": "芝"}, "q": None},
        # 日付が null の走が混ざる
        {"runs": [{"date": None, "courseType": "芝", "passing": [1], "entryCount": 8, "finish": 15}, {"date": d(20), "courseType": "ダ", "passing": [1], "entryCount": 8, "finish": 2}], "today": {"date": base, "courseType": "芝"}, "q": 0.1},
    ]
    out += [dict(x, kind="fixed") for x in fixed]
    for _ in range(n):
        k = rng.randint(0, 6)
        rs = []
        for _ in range(k):
            ec = rng.choice([None, 0, 1, 8, 16, 18, 14])
            rs.append({"date": d(rng.choice(offsets)), "courseType": rng.choice(["芝", "ダ", "障", None]),
                       "passing": rng.choice([[], [1], [2, 3], [3, 3, 3], [2], [5, 6, 7, 8], [4], [0]]),
                       "entryCount": ec, "finish": rng.choice([None, 1, 2, 3, 5, 10, 11, 12, 13, 15, 18])})
        out.append({"runs": rs, "today": {"date": base, "courseType": rng.choice(["芝", "ダ"])},
                    "q": rng.choice([None, 0.0, 0.01, 0.0499999, 0.05, 0.0500001, 0.2]), "kind": "synthetic"})
    return out


def main(hist2021, hist, csv_path, out_path):
    rng = random.Random(688)
    cases = real_cases([hist2021, hist], csv_path, rng) + synthetic_cases(rng)
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "cases.json")
        json.dump(cases, open(p, "w", encoding="utf-8"), ensure_ascii=False)
        root = os.path.abspath(os.path.join(HERE, "..", ".."))
        res = subprocess.run(["node", "--experimental-strip-types", "--import", os.path.join(HERE, "register-ts.mjs"),
                              os.path.join(HERE, "xcheck_flags.mjs"), p], capture_output=True, text=True, cwd=root, check=True)
    ts = json.loads(res.stdout)
    py = [list(flags.compute_flags(c["runs"], c["today"]["date"], c["today"]["courseType"], c["q"])) for c in cases]
    bad = [i for i in range(len(cases)) if ts[i] != py[i]]
    tally = collections.Counter()
    for c, t in zip(cases, ts):
        tally[(c["kind"],) + tuple("n" if v is None else v for v in t)] += 0
    dist = {k: collections.Counter() for k in ("real", "synthetic", "fixed")}
    names = ["longRest", "surfaceChange", "frontRunner", "longshotSlump"]
    for c, t in zip(cases, ts):
        for nm, v in zip(names, t):
            dist[c["kind"]][f"{nm}={v}"] += 1
    summary = {
        "n_cases": len(cases), "n_by_kind": {k: sum(1 for c in cases if c["kind"] == k) for k in dist},
        "n_mismatch": len(bad), "mismatch_examples": [{"case": cases[i], "ts": ts[i], "py": py[i]} for i in bad[:5]],
        "ts_value_counts": {k: dict(v) for k, v in dist.items()},
    }
    # 休み明けの割合(実データの全抽出。ただし抽出は馬×レースの無作為で、候補馬に限らない)
    real = [t for c, t in zip(cases, ts) if c["kind"] == "real"]
    has = [t for t in real if t[0] is not None]
    summary["real_longrest_share_among_has_prior"] = sum(t[0] for t in has) / len(has)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: summary[k] for k in ("n_cases", "n_by_kind", "n_mismatch", "real_longrest_share_among_has_prior")}, ensure_ascii=False))
    return len(bad)


if __name__ == "__main__":
    a = sys.argv[1:]
    sys.exit(1 if main(*a) else 0)
