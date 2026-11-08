#!/usr/bin/env python3
"""#684: ハナ候補の数(H3a・H3b・H4a・H4b)と H5(人気上位に逃げ・先行がいない)の集計。標準ライブラリだけ。
計画は docs/investigations/hana-count-684/plan.md。#683 の analyze.py の関数(係数の当て直し・BH・Holm・O/E)を再利用する。

使い方(<table> は build_table.py の出力):
  explore <table> <out_dir>      探索の期間: explore-results.json
  fix <out_dir>                  explore-results.json から candidates.json を作る(計画 §6)
  confirm <table> <out_dir>      確認の期間(candidates.json が無いと動かない): confirm-results.json
"""
from __future__ import annotations

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

MIN_N = 300
BH_Q = 0.05
HOLM_ALPHA = 0.05
N_SHUFFLE = 1000
SEED = 684
EPS = 1e-9
MIN_KNOWN = {3: 2, 5: 3}  # H5: 1〜K 番人気のうち判定済みの下限(計画 §4b)
CARRY_CELL = ("H2", "T1", "4-9")
EXP683 = os.path.join(HERE, "..", "..", "docs", "investigations", "pace-mismatch-683")

CELLS = [(h, d, b) for h in ("H3a", "H3b", "H4a", "H4b") for d in ("d1", "d2") for b in c.BANDS]
CELLS += [("H5", k, b) for k in ("K3", "K5") for b in ("4-9", "10+")]
DIRECTION = {"H3a": "over", "H3b": "over", "H4a": "under", "H4b": "over", "H5": "over"}


def cname(k):
    return f"{k[0]}|{k[1]}|{k[2]}"


def labels_of(rec):
    return [(h["style"], h["d1"], h["d2"]) for h in rec["raw"]["horses"]]


def race_cond(rec, labels, H, d):
    """レースの条件(群が決まる前)。d は 'd1'/'d2' または 'K3'/'K5'。"""
    if H == "H5":
        K = int(d[1:])
        top = [lb[0] for lb, h in zip(labels, rec["raw"]["horses"])
               if h["ninki"] is not None and h["ninki"] <= K and lb[0]]
        return len(top) >= MIN_KNOWN[K] and not any(s in c.FRONT for s in top)
    i = 1 if d == "d1" else 2
    n = sum(1 for lb in labels if lb[i])
    if H == "H3a":
        return n == 1
    if H == "H3b":
        return n <= 1
    return n >= 3


def is_type(lb, H, d):
    """条件に当たるレースで、群に入る馬の型(判定済みの馬が前提)。"""
    if H == "H5":
        return lb[0] in c.FRONT
    i = 1 if d == "d1" else 2
    if H in ("H3a", "H4a"):
        return bool(lb[i])
    if H == "H3b":
        return lb[0] == "先行" and not lb[i]
    return lb[0] in c.BACK  # H4b


def accumulate(recs, shuffle_rng=None):
    acc = {k: [0, 0, 0.0, 0.0] for k in CELLS}
    comp = {k: [0, 0, 0.0, 0.0] for k in CELLS}
    for rec in recs:
        labels = labels_of(rec)
        if shuffle_rng is not None:
            idx = [i for i, lb in enumerate(labels) if lb[0]]
            perm = [labels[i] for i in idx]
            shuffle_rng.shuffle(perm)
            labels = list(labels)
            for i, lb in zip(idx, perm):
                labels[i] = lb
        on = {}
        for H, d, b in CELLS:
            if (H, d) not in on:
                on[(H, d)] = race_cond(rec, labels, H, d)
            if not on[(H, d)]:
                continue
            a = acc[(H, d, b)]
            cp = comp[(H, d, b)]
            for lb, h in zip(labels, rec["horses"]):
                if h["p3"] is None or not lb[0] or h["band"] != b:
                    continue
                t = a if is_type(lb, H, d) else cp
                t[0] += 1
                t[1] += h["y"]
                t[2] += h["p3"]
                t[3] += h["p3"] * (1 - h["p3"])
    return acc, comp


def make_recs(races, coef):
    return [a683.build_race_rec(r, coef) for r in races]


def fit_coef(races):
    rows = []
    for r in races:
        for h, x in zip(r["horses"], a683.feats(r)):
            if x is not None:
                rows.append((x[0], x[1], 1.0 if a683.is_top3(h) else 0.0))
    return a683.fit_logit(rows), rows


def run_explore(table_path, out_dir):
    races = a683.eligible(c.load(table_path), c.EXPLORE)
    coef, rows = fit_coef(races)
    with open(os.path.join(EXP683, "candidates.json"), encoding="utf-8") as f:
        c683 = json.load(f)
    coef_match = max(abs(x - y) for x, y in zip(coef, c683["coef_B"]))
    recs = make_recs(races, coef)
    acc, comp = accumulate(recs)
    cells = []
    for k in CELLS:
        s = a683.stat(acc[k])
        d = {"cell": cname(k), "H": k[0], "def": k[1], "band": k[2], "predicted": DIRECTION[k[0]], **s,
             "comp": a683.stat(comp[k])}
        d["p"] = a683.two_p(s["z"]) if s["z"] is not None else None
        d["tested"] = s["n"] >= MIN_N and s["z"] is not None
        cells.append(d)
    tested = [d for d in cells if d["tested"]]
    for d, q in zip(tested, a683.bh([d["p"] for d in tested])):
        d["q_bh"] = q
    accA, _ = accumulate(make_recs(races, a683.COEF_A))
    for d, k in zip(cells, CELLS):
        d["refA"] = a683.stat(accA[k])
    tested_keys = [k for k, d in zip(CELLS, cells) if d["tested"]]
    rng = random.Random(SEED)
    maxz = []
    for _ in range(N_SHUFFLE):
        a, _c = accumulate(recs, rng)
        zs = []
        for k in tested_keys:
            n, o, e, v = a[k]
            if n > 0 and v > 0:
                zs.append(abs((o - e) / math.sqrt(v)))
        maxz.append(max(zs) if zs else 0.0)
    obs = max(abs(d["z"]) for d in tested) if tested else 0.0
    srt = sorted(maxz)
    shuffle = {"n_shuffle": N_SHUFFLE, "seed": SEED, "observed_max_abs_z": round(obs, 4),
               "null_p95": round(c.percentile(srt, 0.95), 4), "null_median": round(c.percentile(srt, 0.5), 4),
               "empirical_p": sum(1 for z in maxz if z >= obs - EPS) / N_SHUFFLE}
    allE = sum(a683.sigmoid(coef[0] + coef[1] * r_[0] + coef[2] * r_[1]) for r_ in rows)
    out = {"period": c.EXPLORE, "races": len(races), "coef_B": coef, "coef_B_vs_683_maxabsdiff": coef_match,
           "calibration_all": {"horses": len(rows), "O": sum(r_[2] for r_ in rows), "E": round(allE, 2)},
           "cells": cells, "m_tested": len(tested), "shuffle": shuffle, "bh_q": BH_Q, "min_n": MIN_N}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "explore-results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("races", len(races), "coef_B", [round(x, 4) for x in coef], "683 との差", coef_match, out["calibration_all"])
    for d in cells:
        print(d["cell"], "n", d["n"], "O/E", d["ratio"], "z", d["z"], "tested", d["tested"], "q", d.get("q_bh"),
              "| comp O/E", d["comp"]["ratio"], "z", d["comp"]["z"])
    print(shuffle, "m", len(tested))


def run_fix(out_dir):
    with open(os.path.join(out_dir, "explore-results.json"), encoding="utf-8") as f:
        ex = json.load(f)
    with open(os.path.join(EXP683, "explore-results.json"), encoding="utf-8") as f:
        e683 = json.load(f)
    carry = next(d for d in e683["cells"] if d["cell"] == "H2|T1|4-9")
    cand = [{"cell": "H2|T1|4-9", "source": "683", "carryover": True, "持ち越し": True, "direction": "over",
             "explore": {"n": carry["n"], "ratio": carry["ratio"], "z": carry["z"], "q_bh": carry["q_bh"],
                         "note": "#683 の値の引用(探索の期間を再集計していない。#683 の定義・しきい値のまま)"}}]
    for d in ex["cells"]:
        if d["tested"] and d.get("q_bh", 1.0) < BH_Q and (d["ratio"] > 1) == (d["predicted"] == "over"):
            cand.append({"cell": d["cell"], "source": "684", "carryover": False, "H": d["H"], "def": d["def"],
                         "band": d["band"], "direction": d["predicted"],
                         "explore": {"n": d["n"], "ratio": d["ratio"], "z": d["z"], "q_bh": d["q_bh"]}})
    out = {"coef_B": ex["coef_B"], "coef_A": a683.COEF_A,
           "rule": "684 のセル: n>=300 かつ BH q<0.05 かつ予想の向き。持ち越し 1 セルは無条件(plan §6)",
           "m_tested": ex["m_tested"], "candidates": cand}
    with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("candidates", len(cand), [x["cell"] for x in cand])


def horse_rows(recs, key):
    """key=(H,def,band) の群・比較先(条件に当たらないレースの同じ型の馬)の (単勝, 複勝, p3, y, 重量種別) 行。"""
    H, d, b = key
    grp, rest = [], []
    for rec in recs:
        labels = labels_of(rec)
        on = race_cond(rec, labels, H, d)
        win = a683.payout_map(rec["raw"], "win")
        plc = a683.payout_map(rec["raw"], "place")
        for lb, h in zip(labels, rec["horses"]):
            if h["p3"] is None or not lb[0] or h["band"] != b or not is_type(lb, H, d):
                continue
            row = (win.get(h["umaban"], 0) / 100.0, plc.get(h["umaban"], 0) / 100.0, h["p3"], h["y"],
                   rec["raw"]["weightType"])
            (grp if on else rest).append(row)
    return grp, rest


def carry_rows(recs):
    H, t, b = CARRY_CELL
    grp, rest = a683.group_horses(recs, (H, t, b))
    return grp, rest


def roi_entry(cell, grp, rest):
    d = {"cell": cell, "group_n": len(grp), "rest_n": len(rest)}
    for name, idx in (("win", 0), ("place", 1)):
        g, r_ = a683.roi_stats(grp, idx), a683.roi_stats(rest, idx)
        d[name] = {"group": g and {k: v for k, v in g.items() if k != "var"},
                   "rest": r_ and {k: v for k, v in r_.items() if k != "var"}, "diff_z": a683.diff_z(g, r_)}
    d["handicap_split"] = {}
    for lab, rows in (("handicap", [r for r in grp if r[4] == "ハンデ"]), ("non_handicap", [r for r in grp if r[4] != "ハンデ"])):
        if rows:
            e = sum(r[2] for r in rows)
            o = sum(r[3] for r in rows)
            d["handicap_split"][lab] = {"n": len(rows), "O": o, "E": round(e, 2), "ratio": round(o / e, 4) if e else None}
    return d


def run_confirm(table_path, out_dir):
    cpath = os.path.join(out_dir, "candidates.json")
    if not os.path.exists(cpath):
        sys.exit("candidates.json が無い: 確認の期間は候補を固定してから開く(plan §6)")
    with open(cpath, encoding="utf-8") as f:
        cand = json.load(f)
    if not cand["candidates"]:
        sys.exit("候補が 0 件")
    races = a683.eligible(c.load(table_path), c.CONFIRM)
    recs = make_recs(races, cand["coef_B"])
    recsA = make_recs(races, cand["coef_A"])
    acc, comp = accumulate(recs)
    accA, _ = accumulate(recsA)
    acc683, comp683 = a683.accumulate(recs)
    acc683A, _ = a683.accumulate(recsA)
    res, roi = [], []
    for cd in cand["candidates"]:
        if cd["carryover"]:
            s = a683.stat(acc683[CARRY_CELL])
            extra = {"comp": a683.stat(comp683[CARRY_CELL]), "refA": a683.stat(acc683A[CARRY_CELL])}
            roi.append(roi_entry(cd["cell"], *carry_rows(recs)))
        else:
            key = (cd["H"], cd["def"], cd["band"])
            s = a683.stat(acc[key])
            extra = {"comp": a683.stat(comp[key]), "refA": a683.stat(accA[key])}
            roi.append(roi_entry(cd["cell"], *horse_rows(recs, key)))
        sign = 1 if cd["direction"] == "over" else -1
        d = {"cell": cd["cell"], "carryover": cd["carryover"], "direction": cd["direction"],
             "explore": cd["explore"], **s, **extra}
        if s["z"] is not None:
            d["same_direction"] = (s["ratio"] > 1) == (cd["direction"] == "over")
            d["p_one_sided"] = a683.norm_sf(sign * s["z"])
        else:
            d["same_direction"], d["p_one_sided"] = False, 1.0
        res.append(d)
    for d, a in zip(res, a683.holm([d["p_one_sided"] for d in res])):
        d["p_holm"] = a
        d["remains"] = bool(d["n"] >= MIN_N and d["same_direction"] and a < HOLM_ALPHA)
    out = {"period": c.CONFIRM, "races": len(races), "K": len(res), "results": res, "roi": roi}
    with open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for d in res:
        print(d["cell"], "n", d["n"], "O/E", d["ratio"], "z", d["z"], "holm", d["p_holm"], "remains", d["remains"])


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "explore":
        run_explore(sys.argv[2], sys.argv[3])
    elif cmd == "fix":
        run_fix(sys.argv[2])
    elif cmd == "confirm":
        run_confirm(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
