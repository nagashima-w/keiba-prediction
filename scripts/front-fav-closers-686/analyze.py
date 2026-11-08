#!/usr/bin/env python3
"""#686: 人気上位がそろって先行のレースの、差し・追込の穴馬(H6)と #683 の H2|T1|4-9 を
2021-06-20〜2024-08-04 で 1 回だけ当てる。標準ライブラリだけ。計画は docs/investigations/front-fav-closers-686/plan.md。
#683 の common.py・analyze.py の関数を再利用する(そちらは変えない)。

使い方: analyze.py <table.ndjson.gz> <out_dir>   (out_dir/results.json を作る。既にあれば止まる)
"""
from __future__ import annotations

import collections
import importlib.util
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
D683 = os.path.join(HERE, "..", "pace-mismatch-683")
sys.path.insert(0, D683)
import common as c  # noqa: E402

_spec = importlib.util.spec_from_file_location("a683", os.path.join(D683, "analyze.py"))
a683 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(a683)

PERIOD = ("2021-06-20", "2024-08-04")
HOLM_ALPHA = 0.05
N_SHUFFLE = 1000
SEED = 686
MIN_KNOWN = {3: 2, 5: 3}
COEF_B_FIXED = [2.6574, 0.8926, -0.5093]
CELLS = [(k, b) for k in (3, 5) for b in ("4-9", "10+")] + [("H2T1", "4-9")]
CARRY = ("H2T1", "4-9")
EXP683 = os.path.join(HERE, "..", "..", "docs", "investigations", "pace-mismatch-683")


def cname(k):
    return f"H2|T1|4-9" if k == CARRY else f"H6|K{k[0]}|{k[1]}"


def race_on(rec, styles, key):
    """key の条件に、このレースが当たるか。H6: 1〜K 番人気の判定済みが下限以上で、差し・追込が 1 頭もいない。"""
    if key[0] == "H2T1":
        return a683.conds(rec, styles)[("H2", "T1")]
    K = key[0]
    top = [s for s, h in zip(styles, rec["raw"]["horses"])
           if h["ninki"] is not None and h["ninki"] <= K and s]
    return len(top) >= MIN_KNOWN[K] and not any(s in c.BACK for s in top)


def accumulate(recs, shuffle_rng=None):
    acc = {k: [0, 0, 0.0, 0.0] for k in CELLS}
    comp = {k: [0, 0, 0.0, 0.0] for k in CELLS}
    n_on = {"K3": 0, "K5": 0, "H2T1": 0}
    for rec in recs:
        styles = [h["style"] for h in rec["horses"]]
        if shuffle_rng is not None:
            styles = a683.shuffled_styles(rec, shuffle_rng)
        for key in CELLS:
            if key[1] == "10+" and key[0] == "H2T1":
                continue
            if not race_on(rec, styles, key):
                continue
            if key[1] == CELLS[0][1]:  # 帯の最初のセルでレース数を数える
                n_on["H2T1" if key[0] == "H2T1" else f"K{key[0]}"] += 1
            for s, h in zip(styles, rec["horses"]):
                if h["p3"] is None or not s or h["band"] != key[1]:
                    continue
                t = (acc if s in c.BACK else comp)[key]
                t[0] += 1
                t[1] += h["y"]
                t[2] += h["p3"]
                t[3] += h["p3"] * (1 - h["p3"])
    return acc, comp, n_on


def cell_results(acc, comp):
    out = []
    for k in CELLS:
        s = a683.stat(acc[k])
        d = {"cell": cname(k), **s, "comp": a683.stat(comp[k])}
        d["p_one_sided"] = a683.norm_sf(s["z"]) if s["z"] is not None else 1.0
        out.append(d)
    for d, a in zip(out, a683.holm([d["p_one_sided"] for d in out])):
        d["p_holm"] = a
        d["remains"] = bool(d["ratio"] is not None and d["ratio"] > 1 and a < HOLM_ALPHA)
    return out


def horse_rows(recs, key):
    grp, rest = [], []
    for rec in recs:
        styles = [h["style"] for h in rec["horses"]]
        on = race_on(rec, styles, key)
        win = a683.payout_map(rec["raw"], "win")
        plc = a683.payout_map(rec["raw"], "place")
        for s, h in zip(styles, rec["horses"]):
            if h["p3"] is None or not s or s not in c.BACK or h["band"] != key[1]:
                continue
            row = (win.get(h["umaban"], 0) / 100.0, plc.get(h["umaban"], 0) / 100.0, h["p3"], h["y"],
                   rec["raw"]["weightType"])
            (grp if on else rest).append(row)
    return grp, rest


def roi_entry(cell, grp, rest):
    d = {"cell": cell, "group_n": len(grp), "rest_n": len(rest)}
    for name, idx in (("win", 0), ("place", 1)):
        g, r_ = a683.roi_stats(grp, idx), a683.roi_stats(rest, idx)
        d[name] = {"group": g and {k: v for k, v in g.items() if k != "var"},
                   "rest": r_ and {k: v for k, v in r_.items() if k != "var"}, "diff_z": a683.diff_z(g, r_)}
    d["handicap_split"] = {}
    for lab, rows in (("handicap", [r for r in grp if r[4] == "ハンデ"]),
                      ("non_handicap", [r for r in grp if r[4] != "ハンデ"])):
        if rows:
            e = sum(r[2] for r in rows)
            o = sum(r[3] for r in rows)
            d["handicap_split"][lab] = {"n": len(rows), "O": o, "E": round(e, 2), "ratio": round(o / e, 4) if e else None}
    return d


def main(table_path, out_dir):
    res_path = os.path.join(out_dir, "results.json")
    if os.path.exists(res_path):
        sys.exit("results.json が既にある: 集計は 1 回だけ(plan §7)")
    with open(os.path.join(EXP683, "candidates.json"), encoding="utf-8") as f:
        c683 = json.load(f)["coef_B"]
    if max(abs(round(x, 4) - y) for x, y in zip(c683, COEF_B_FIXED)) > 1e-9:
        sys.exit(f"固定係数が #683 の coef_B と一致しない: {c683}")
    coef = c683
    table = [r for r in c.load(table_path) if c.in_period(r, PERIOD)]
    reasons = collections.Counter(c.exclusion_reason(r) or "対象" for r in table)
    by_month = collections.defaultdict(collections.Counter)
    for r in table:
        by_month[r["date"][:7]][c.exclusion_reason(r) or "対象"] += 1
    races = [r for r in table if c.exclusion_reason(r) is None]
    rows = []
    for r in races:
        for h, x in zip(r["horses"], a683.feats(r)):
            if x is not None:
                rows.append((x[0], x[1], 1.0 if a683.is_top3(h) else 0.0))
    refit = a683.fit_logit(rows)

    def calib(cf):
        e = sum(a683.sigmoid(cf[0] + cf[1] * x1 + cf[2] * x2) for x1, x2, _ in rows)
        return {"horses": len(rows), "O": sum(y for _, _, y in rows), "E": round(e, 2)}

    recs = [a683.build_race_rec(r, coef) for r in races]
    acc, comp, n_on = accumulate(recs)
    cells = cell_results(acc, comp)
    refit_recs = [a683.build_race_rec(r, refit) for r in races]
    racc, _rcomp, _ = accumulate(refit_recs)
    for d, k in zip(cells, CELLS):
        d["refit_ref"] = a683.stat(racc[k])
    years = {}
    for y in sorted({r["raw"]["date"][:4] for r in recs}):
        a, _cm, n = accumulate([r for r in recs if r["raw"]["date"][:4] == y])
        years[y] = {"races_on": n, "cells": {cname(k): a683.stat(a[k]) for k in CELLS}}
    roi = [roi_entry(cname(k), *horse_rows(recs, k)) for k in CELLS]
    zs0 = [d["z"] for d in cells if d["z"] is not None]
    obs = max(zs0) if zs0 else 0.0
    rng = random.Random(SEED)
    maxz = []
    for _ in range(N_SHUFFLE):
        a, _cm, _n = accumulate(recs, rng)
        zs = [(o - e) / math.sqrt(v) for n, o, e, v in a.values() if n > 0 and v > 0]
        maxz.append(max(zs) if zs else 0.0)
    srt = sorted(maxz)
    shuffle = {"n_shuffle": N_SHUFFLE, "seed": SEED, "observed_max_z": round(obs, 4),
               "null_p95": round(c.percentile(srt, 0.95), 4), "null_median": round(c.percentile(srt, 0.5), 4),
               "empirical_p": sum(1 for z in maxz if z >= obs - 1e-9) / N_SHUFFLE}
    out = {"period": PERIOD, "table_races": len(table), "eligible_races": len(races),
           "exclusion": dict(reasons), "exclusion_by_month": {m: dict(v) for m, v in sorted(by_month.items())},
           "coef_B_fixed": coef, "coef_refit": refit,
           "calibration_fixed": calib(coef), "calibration_refit": calib(refit),
           "races_on": n_on, "cells": cells, "years": years, "roi": roi, "shuffle": shuffle,
           "holm_alpha": HOLM_ALPHA}
    os.makedirs(out_dir, exist_ok=True)
    with open(res_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("table", len(table), "eligible", len(races), dict(reasons))
    print("calib fixed", out["calibration_fixed"], "refit", out["calibration_refit"], [round(x, 4) for x in refit])
    print("races_on", n_on)
    for d in cells:
        print(d["cell"], "n", d["n"], "O/E", d["ratio"], "z", d["z"], "holm", d["p_holm"], "remains", d["remains"],
              "| comp", d["comp"]["ratio"], d["comp"]["z"], "| refit", d["refit_ref"]["ratio"])
    print(shuffle)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
