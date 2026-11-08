#!/usr/bin/env python3
"""#683: 展開のずれ(H1 前残り / H2 差し決着)の集計。標準ライブラリだけ。計画は docs/investigations/pace-mismatch-683/plan.md。

使い方(<table> は build_table.py の出力):
  explore <table> <out_dir>                       探索の期間: explore-results.json
  fix <out_dir>                                   explore-results.json から candidates.json を作る(選定ルールは plan §7)
  roi-explore <table> <out_dir>                   候補の回収率・ハンデ分割(探索の期間。roi-explore.json)
  confirm <table> <out_dir>                       確認の期間(candidates.json が無いと動かない): confirm-results.json
"""
from __future__ import annotations

import json
import math
import os
import random
import sys

import common as c

MIN_N = 300
BH_Q = 0.05
HOLM_ALPHA = 0.05
N_SHUFFLE = 1000
SEED = 683
EPS = 1e-9
THR = {"T1": {"lo": 0.2667, "hi": 0.4000}, "T2": {"lo": 0.2000, "hi": 0.4667}}
COEF_A = [2.857, 0.9216, -0.5561]  # 本番 #656 の固定係数(参考)
HS = ("H1", "H2")
CELLS = [(h, t, b) for h in HS for t in THR for b in c.BANDS]


def cell_name(k):
    return f"{k[0]}|{k[1]}|{k[2]}"


def norm_sf(z):
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def two_p(z):
    return 2 * norm_sf(abs(z))


def logit(q):
    return math.log(q / (1 - q))


def sigmoid(x):
    return 1 / (1 + math.exp(-x))


def feats(race):
    """レース内の馬ごとの (x1=logit q, x2=ln n) を返す。オッズが無い馬は None。"""
    hs = race["horses"]
    inv = [1 / h["odds"] if h["odds"] else None for h in hs]
    tot = sum(v for v in inv if v)
    ln_n = math.log(race["nStart"])
    return [(logit(v / tot), ln_n) if v else None for v in inv]


def is_top3(h):
    return h["finish"] is not None and h["finish"] <= 3


def fit_logit(rows):
    """rows: [(x1, x2, y)]。3 係数のロジスティック回帰を Newton 法で最尤推定。"""
    b = [0.0, 1.0, 0.0]
    for _ in range(50):
        g = [0.0] * 3
        H = [[0.0] * 3 for _ in range(3)]
        for x1, x2, y in rows:
            x = (1.0, x1, x2)
            p = sigmoid(b[0] + b[1] * x1 + b[2] * x2)
            w = p * (1 - p)
            for i in range(3):
                g[i] += (y - p) * x[i]
                for j in range(3):
                    H[i][j] += w * x[i] * x[j]
        d = solve3(H, g)
        b = [b[i] + d[i] for i in range(3)]
        if max(abs(v) for v in d) < 1e-10:
            break
    return b


def solve3(A, y):
    M = [A[i][:] + [y[i]] for i in range(3)]
    for i in range(3):
        piv = max(range(i, 3), key=lambda r: abs(M[r][i]))
        M[i], M[piv] = M[piv], M[i]
        for r in range(3):
            if r != i:
                f = M[r][i] / M[i][i]
                for k in range(i, 4):
                    M[r][k] -= f * M[i][k]
    return [M[i][3] / M[i][i] for i in range(3)]


def eligible(table, period):
    return [r for r in table if c.in_period(r, period) and c.exclusion_reason(r) is None]


def build_race_rec(r, coef):
    fs = feats(r)
    horses = []
    for h, x in zip(r["horses"], fs):
        p3 = None if x is None else sigmoid(coef[0] + coef[1] * x[0] + coef[2] * x[1])
        band = None
        if h["ninki"] is not None:
            for name, (lo, hi) in c.BANDS.items():
                if lo <= h["ninki"] <= hi:
                    band = name
        horses.append({"band": band, "p3": p3, "y": 1 if is_top3(h) else 0, "style": h["style"],
                       "top3pop": h["ninki"] is not None and h["ninki"] <= 3, "umaban": h["umaban"]})
    return {"raw": r, "horses": horses, "f": c.front_share(r)}


def conds(rec, styles):
    """styles(馬ごとの脚質)から、(T, H) ごとの条件の真偽を返す。"""
    nf = nb = 0
    for h, s in zip(rec["horses"], styles):
        if h["top3pop"] and s:
            if s in c.FRONT:
                nf += 1
            else:
                nb += 1
    f = rec["f"]
    res = {}
    for t, th in THR.items():
        res[("H1", t)] = nb >= 2 and f <= th["lo"] + EPS
        res[("H2", t)] = nf >= 2 and f >= th["hi"] - EPS
    return res


def accumulate(recs, styles_of=None):
    """全セルの (n, O, E, V) と、補集合の (n, O, E, V) を返す。styles_of(rec) でシャッフル後の脚質を与える。"""
    acc = {k: [0, 0, 0.0, 0.0] for k in CELLS}
    comp = {k: [0, 0, 0.0, 0.0] for k in CELLS}
    for rec in recs:
        styles = styles_of(rec) if styles_of else [h["style"] for h in rec["horses"]]
        cd = conds(rec, styles)
        for (h_, t), on in cd.items():
            if not on:
                continue
            target = c.FRONT if h_ == "H1" else c.BACK
            for h, s in zip(rec["horses"], styles):
                if h["p3"] is None or not s or h["band"] is None:
                    continue
                a = acc[(h_, t, h["band"])] if s in target else comp[(h_, t, h["band"])]
                a[0] += 1
                a[1] += h["y"]
                a[2] += h["p3"]
                a[3] += h["p3"] * (1 - h["p3"])
    return acc, comp


def stat(a):
    n, o, e, v = a
    if n == 0 or v <= 0:
        return {"n": n, "O": o, "E": e, "ratio": None, "z": None}
    return {"n": n, "O": o, "E": round(e, 3), "ratio": round(o / e, 4), "z": round((o - e) / math.sqrt(v), 4)}


def bh(ps):
    """BH 補正の q 値(入力順を保つ)。"""
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    q = [0.0] * m
    prev = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        prev = min(prev, ps[i] * m / rank)
        q[i] = prev
    return q


def holm(ps):
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    adj = [0.0] * m
    run = 0.0
    for rank, i in enumerate(order):
        run = max(run, min(1.0, (m - rank) * ps[i]))
        adj[i] = run
    return adj


def shuffled_styles(rec, rng):
    idx = [i for i, h in enumerate(rec["horses"]) if h["style"]]
    labels = [rec["horses"][i]["style"] for i in idx]
    rng.shuffle(labels)
    styles = [None] * len(rec["horses"])
    for i, s in zip(idx, labels):
        styles[i] = s
    return styles


def run_explore(table_path, out_dir):
    table = c.load(table_path)
    races = eligible(table, c.EXPLORE)
    rows = []
    for r in races:
        for h, x in zip(r["horses"], feats(r)):
            if x is not None:
                rows.append((x[0], x[1], 1.0 if is_top3(h) else 0.0))
    coef = fit_logit(rows)
    recs = [build_race_rec(r, coef) for r in races]
    acc, comp = accumulate(recs)
    cells = []
    for k in CELLS:
        s = stat(acc[k])
        d = {"cell": cell_name(k), "H": k[0], "thr": k[1], "band": k[2], **s,
             "comp": stat(comp[k])}
        d["p"] = two_p(s["z"]) if s["z"] is not None else None
        d["tested"] = s["n"] >= MIN_N and s["z"] is not None
        cells.append(d)
    tested = [d for d in cells if d["tested"]]
    qs = bh([d["p"] for d in tested])
    for d, q in zip(tested, qs):
        d["q_bh"] = q
    # 参考: 案 A の固定係数
    recsA = [build_race_rec(r, COEF_A) for r in races]
    accA, _ = accumulate(recsA)
    for d, k in zip(cells, CELLS):
        d["refA"] = stat(accA[k])
    # シャッフルの帰無分布
    tested_keys = [k for k, d in zip(CELLS, cells) if d["tested"]]
    rng = random.Random(SEED)
    maxz = []
    for _ in range(N_SHUFFLE):
        cache = {}
        a, _c = accumulate(recs, lambda rec: cache.setdefault(id(rec), shuffled_styles(rec, rng)))
        zs = []
        for k in tested_keys:
            n, o, e, v = a[k]
            if n > 0 and v > 0:
                zs.append(abs((o - e) / math.sqrt(v)))
        maxz.append(max(zs) if zs else 0.0)
    obs = max(abs(d["z"]) for d in tested) if tested else 0.0
    srt = sorted(maxz)
    shuffle = {
        "n_shuffle": N_SHUFFLE, "seed": SEED, "observed_max_abs_z": round(obs, 4),
        "null_p95": round(c.percentile(srt, 0.95), 4), "null_median": round(c.percentile(srt, 0.5), 4),
        "empirical_p": (sum(1 for z in maxz if z >= obs - EPS) + 0) / N_SHUFFLE,
    }
    # 市場の見込みの較正(探索の期間全体: 全馬の O と E)
    allO = sum(r_[2] for r_ in rows)
    allE = sum(sigmoid(coef[0] + coef[1] * r_[0] + coef[2] * r_[1]) for r_ in rows)
    out = {
        "period": c.EXPLORE, "races": len(races), "coef_B": coef, "coef_A": COEF_A,
        "calibration_all": {"horses": len(rows), "O": allO, "E": round(allE, 2)},
        "cells": cells, "m_tested": len(tested), "shuffle": shuffle,
        "bh_q": BH_Q, "min_n": MIN_N,
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "explore-results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print_summary(out)


def print_summary(out):
    print("races", out["races"], "coef_B", [round(x, 4) for x in out["coef_B"]], "calib", out["calibration_all"])
    for d in out["cells"]:
        print(d["cell"], "n", d["n"], "O/E", d["ratio"], "z", d["z"], "tested", d["tested"], "q", d.get("q_bh"),
              "| comp O/E", d["comp"]["ratio"], "z", d["comp"]["z"])
    print(out["shuffle"])


def run_fix(out_dir):
    with open(os.path.join(out_dir, "explore-results.json"), encoding="utf-8") as f:
        ex = json.load(f)
    cand = []
    for d in ex["cells"]:
        if d["tested"] and d.get("q_bh", 1.0) < BH_Q:
            cand.append({"cell": d["cell"], "H": d["H"], "thr": d["thr"], "band": d["band"],
                         "direction": "over" if d["ratio"] > 1 else "under",
                         "explore": {"n": d["n"], "ratio": d["ratio"], "z": d["z"], "q_bh": d["q_bh"]},
                         "hypothesis_direction": d["ratio"] > 1})
    out = {"coef_B": ex["coef_B"], "coef_A": ex["coef_A"], "rule": "n>=300 かつ BH q<0.05(plan §7)",
           "m_tested": ex["m_tested"], "candidates": cand}
    with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("candidates", len(cand), [x["cell"] for x in cand])


def payout_map(r, kind):
    return {p["umaban"]: p["payout"] for p in r["payouts"][kind]}


def group_horses(recs, key):
    """key=(H,thr,band) について、群(条件に当たるレースの対象脚質)と rest(当たらないレースの同じ脚質)の馬を返す。"""
    h_, t, band = key
    target = c.FRONT if h_ == "H1" else c.BACK
    grp, rest = [], []
    for rec in recs:
        on = conds(rec, [h["style"] for h in rec["horses"]])[(h_, t)]
        win = payout_map(rec["raw"], "win")
        plc = payout_map(rec["raw"], "place")
        for h in rec["horses"]:
            if h["band"] != band or not h["style"] or h["style"] not in target:
                continue
            row = (win.get(h["umaban"], 0) / 100.0, plc.get(h["umaban"], 0) / 100.0, h["p3"], h["y"], rec["raw"]["weightType"])
            (grp if on else rest).append(row)
    return grp, rest


def roi_stats(rows, idx):
    n = len(rows)
    if n == 0:
        return None
    vals = [r[idx] for r in rows]
    m = sum(vals) / n
    var = sum((v - m) ** 2 for v in vals) / (n - 1) if n > 1 else 0.0
    return {"n": n, "roi": round(m, 4), "var": var}


def diff_z(a, b):
    if not a or not b:
        return None
    se = math.sqrt(a["var"] / a["n"] + b["var"] / b["n"])
    return round((a["roi"] - b["roi"]) / se, 3) if se > 0 else None


def roi_block(recs, cand_cells, coefkey):
    out = []
    for cd in cand_cells:
        key = (cd["H"], cd["thr"], cd["band"])
        grp, rest = group_horses(recs, key)
        d = {"cell": cd["cell"], "group_n": len(grp), "rest_n": len(rest)}
        for name, idx in (("win", 0), ("place", 1)):
            g, r_ = roi_stats(grp, idx), roi_stats(rest, idx)
            d[name] = {"group": g and {k: v for k, v in g.items() if k != "var"},
                       "rest": r_ and {k: v for k, v in r_.items() if k != "var"}, "diff_z": diff_z(g, r_)}
        hs = [r for r in grp if r[4] == "ハンデ"]
        nh = [r for r in grp if r[4] != "ハンデ"]
        d["handicap_split"] = {}
        for lab, rows in (("handicap", hs), ("non_handicap", nh)):
            if rows:
                e = sum(r[2] for r in rows if r[2] is not None)
                o = sum(r[3] for r in rows)
                d["handicap_split"][lab] = {"n": len(rows), "O": o, "E": round(e, 2), "ratio": round(o / e, 4) if e else None}
        out.append(d)
    return out


def run_roi_explore(table_path, out_dir):
    with open(os.path.join(out_dir, "candidates.json"), encoding="utf-8") as f:
        cand = json.load(f)
    races = eligible(c.load(table_path), c.EXPLORE)
    recs = [build_race_rec(r, cand["coef_B"]) for r in races]
    out = roi_block(recs, cand["candidates"], "B")
    with open(os.path.join(out_dir, "roi-explore.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False)[:3000])


def run_confirm(table_path, out_dir):
    cpath = os.path.join(out_dir, "candidates.json")
    if not os.path.exists(cpath):
        sys.exit("candidates.json が無い: 確認の期間は候補を固定してから開く(plan §7)")
    with open(cpath, encoding="utf-8") as f:
        cand = json.load(f)
    if not cand["candidates"]:
        sys.exit("候補が 0 件: 確認の期間は開かない(plan §7)")
    races = eligible(c.load(table_path), c.CONFIRM)
    recs = [build_race_rec(r, cand["coef_B"]) for r in races]
    acc, comp = accumulate(recs)
    recsA = [build_race_rec(r, cand["coef_A"]) for r in races]
    accA, _ = accumulate(recsA)
    res = []
    for cd in cand["candidates"]:
        key = (cd["H"], cd["thr"], cd["band"])
        s = stat(acc[key])
        sign = 1 if cd["direction"] == "over" else -1
        d = {"cell": cd["cell"], "direction": cd["direction"], "explore": cd["explore"], **s,
             "comp": stat(comp[key]), "refA": stat(accA[key])}
        if s["z"] is not None:
            d["same_direction"] = (s["ratio"] > 1) == (cd["direction"] == "over")
            d["p_one_sided"] = norm_sf(sign * s["z"])
        else:
            d["same_direction"] = False
            d["p_one_sided"] = 1.0
        res.append(d)
    adj = holm([d["p_one_sided"] for d in res])
    for d, a in zip(res, adj):
        d["p_holm"] = a
        d["remains"] = bool(d["n"] >= MIN_N and d["same_direction"] and a < HOLM_ALPHA)
    out = {"period": c.CONFIRM, "races": len(races), "K": len(res), "results": res,
           "roi": roi_block(recs, cand["candidates"], "B")}
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
    elif cmd == "roi-explore":
        run_roi_explore(sys.argv[2], sys.argv[3])
    elif cmd == "confirm":
        run_confirm(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
