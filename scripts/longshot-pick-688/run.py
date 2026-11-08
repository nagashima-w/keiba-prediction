#!/usr/bin/env python3
"""#688: 6 番人気以下から 1 頭選ぶ。標準ライブラリだけ。計画は docs/investigations/longshot-pick-688/plan.md。

使い方(リポジトリのルートで。<tab> は #687 の build_table.py の出力、<h2021>・<h> は 2 つの hist、<csv> は horse_runs.csv):
  cv      <tab> <h2021> <h> <csv> <out_dir> <cache_dir>   探索の期間だけで学習と選び方 → cv-results.json(確認を開く条件の判定を含む)
  fix     <out_dir> <cache_dir>                            条件を満たしたときだけ、探索全体で学習し直して scores-coef.json
  confirm <tab> <h2021> <h> <csv> <out_dir> <scores_out>   scores-coef.json があるときだけ。確認の期間を 1 回だけ集計 → confirm-results.json
"""
from __future__ import annotations

import gzip
import json
import multiprocessing as mp
import os
import pickle
import sys

import common688 as K
import evaluate as V
import features as Fe
import fit as Fi

PREP_PATH = os.path.join(K.HERE, "..", "..", "docs", "investigations", "pace-fit-687", "prep-results.json")
_G = {}


def block_of(date):
    for i, b in enumerate(K.BLOCKS):
        if b[0] <= date <= b[1]:
            return i
    raise ValueError(date)


def _task(t):
    name, lam, fold = t
    X, y, off, blk = _G["X"][name], _G["y"], _G["off"], _G["blk"]
    tr = [i for i, b in enumerate(blk) if b != fold]
    te = [i for i, b in enumerate(blk) if b == fold]
    w = Fi.fit([X[i] for i in tr], [y[i] for i in tr], [off[i] for i in tr], lam)
    p = Fi.predict([X[i] for i in te], [off[i] for i in te], w)
    return name, lam, fold, Fi.logloss(p, [y[i] for i in te]), p


def run_cv(tab, h2021, h, csv_path, out_dir, cache_dir):
    prep = Fe.load_prep(PREP_PATH)
    cache = os.path.join(cache_dir, "explore_races.pkl")
    if os.path.exists(cache):
        races = pickle.load(open(cache, "rb"))
    else:
        races = Fe.build(tab, [h2021, h], csv_path, prep, K.EXPLORE)
        pickle.dump(races, open(cache, "wb"))
    stats = Fe.make_stats(races)
    rows = [r for race in races for r in race["cands"]]
    date_of = {race["raceId"]: race["date"] for race in races}
    blk = [block_of(date_of[r["raceId"]]) for r in rows]
    y = [r["y"] for r in rows]
    off = [K.logit(r["p3"]) for r in rows]
    _G.update({"X": {n: Fe.matrix(rows, names, stats) for n, names in Fe.SETS.items()}, "y": y, "off": off, "blk": blk})
    tasks = [(n, lam, f) for n in Fe.SETS for lam in K.LAMBDAS for f in range(len(K.BLOCKS))]
    with mp.get_context("fork").Pool(4) as pool:
        res = pool.map(_task, tasks)
    loss = {}
    pred = {}
    for name, lam, fold, ll, p in res:
        loss.setdefault((name, lam), {})[fold] = ll
        pred.setdefault((name, lam), {})[fold] = p
    m0 = {}
    for f in range(len(K.BLOCKS)):
        idx = [i for i, b in enumerate(blk) if b == f]
        m0[f] = Fi.logloss([rows[i]["p3"] for i in idx], [y[i] for i in idx])
    table = []
    for (name, lam), d in loss.items():
        table.append({"set": name, "lambda": lam, "block_loss": [d[f] for f in range(4)], "mean_loss": sum(d.values()) / 4})
    table.sort(key=lambda r: (r["mean_loss"], len(Fe.SETS[r["set"]])))
    best = table[0]
    mc_best = min((r for r in table if r["set"] == "Mc"), key=lambda r: r["mean_loss"])
    better_m0 = sum(1 for f in range(4) if best["block_loss"][f] < m0[f])
    better_mc = sum(1 for f in range(4) if best["block_loss"][f] < mc_best["block_loss"][f])
    gate = best["set"] in ("M1", "M2") and better_m0 >= 3 and better_mc >= 3
    out = {
        "block_ranges": K.BLOCKS, "n_races": len(races), "n_rows": len(rows),
        "m0_block_loss": [m0[f] for f in range(4)], "m0_mean_loss": sum(m0.values()) / 4,
        "table": table, "chosen": {"set": best["set"], "lambda": best["lambda"]},
        "mc_best": {"lambda": mc_best["lambda"], "block_loss": mc_best["block_loss"], "mean_loss": mc_best["mean_loss"]},
        "blocks_better_than_m0": better_m0, "blocks_better_than_mc_best": better_mc,
        "gate_open_confirm": gate,
        "gate_rule": "選ばれた集合が M1 または M2 で、保持ブロックの対数損失が M0 より小さいブロックが 4 つ中 3 つ以上、かつ Mc(最良の λ)より小さいブロックが 4 つ中 3 つ以上(plan.md §4)",
    }
    # 記述: 選ばれた設定の保持ブロックの予測で 1 頭選んだ O/E(学習に使ったデータの当てはまり。検定しない)
    pk = (best["set"], best["lambda"])
    sc = {}
    for f in range(4):
        idx = [i for i, b in enumerate(blk) if b == f]
        for i, p in zip(idx, pred[pk][f]):
            sc[(rows[i]["raceId"], rows[i]["umaban"])] = p
    pr = V.prepare(races)
    sbr = V.scores_list(pr, sc)
    cells = V.cells(pr, sbr)
    out["descriptive_heldout_picks"] = {"cells": cells, "baseline": V.baseline_cells(pr)}
    # M0 vs 選ばれた設定の保持ブロックの記述(参考): 候補全体の平均 p3 と y
    out["explore_candidate_base"] = {"O": sum(y), "E": sum(r["p3"] for r in rows)}
    json.dump(out, open(os.path.join(out_dir, "cv-results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({k: out[k] for k in ("chosen", "blocks_better_than_m0", "blocks_better_than_mc_best", "gate_open_confirm", "m0_mean_loss")}, ensure_ascii=False))
    for r in table[:6]:
        print(r["set"], r["lambda"], round(r["mean_loss"], 6))


def run_fix(out_dir, cache_dir):
    cv = json.load(open(os.path.join(out_dir, "cv-results.json"), encoding="utf-8"))
    if not cv["gate_open_confirm"]:
        print("確認を開く条件を満たしていない。scores-coef.json は作らない。")
        return 1
    races = pickle.load(open(os.path.join(cache_dir, "explore_races.pkl"), "rb"))
    stats = Fe.make_stats(races)
    rows = [r for race in races for r in race["cands"]]
    names = Fe.SETS[cv["chosen"]["set"]]
    X = Fe.matrix(rows, names, stats)
    w = Fi.fit(X, [r["y"] for r in rows], [K.logit(r["p3"]) for r in rows], cv["chosen"]["lambda"])
    prep = Fe.load_prep(PREP_PATH)
    out = {"set": cv["chosen"]["set"], "lambda": cv["chosen"]["lambda"], "features": ["切片"] + names, "beta": w, "stats": stats,
           "offset_coef": prep["coef"], "prep_path": "docs/investigations/pace-fit-687/prep-results.json", "n_rows": len(rows)}
    json.dump(out, open(os.path.join(out_dir, "scores-coef.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"features": out["features"], "beta": [round(v, 4) for v in w]}, ensure_ascii=False))
    return 0


def _filter(pr, sbr, pred):
    keep = [i for i, (race, _) in enumerate(pr) if pred(race)]
    return [pr[i] for i in keep], [sbr[i] for i in keep]


def run_confirm(tab, h2021, h, csv_path, out_dir, scores_out):
    sc_path = os.path.join(out_dir, "scores-coef.json")
    if not os.path.exists(sc_path):
        print("scores-coef.json が無い。確認の期間は開かない。")
        return 1
    sc = json.load(open(sc_path, encoding="utf-8"))
    prep = Fe.load_prep(PREP_PATH)
    assert sc["offset_coef"] == prep["coef"]
    races = Fe.build(tab, [h2021, h], csv_path, prep, K.CONFIRM)
    names = sc["features"][1:]
    beta = sc["beta"]
    scores, xb_only = {}, {}
    for race in races:
        for r in race["cands"]:
            x = [1.0] + [Fe.column(r, n, sc["stats"]) for n in names]
            z = sum(b * v for b, v in zip(beta, x))
            scores[(r["raceId"], r["umaban"])] = K.sigmoid(K.logit(r["p3"]) + z)
            xb_only[(r["raceId"], r["umaban"])] = z - beta[0]
    pr = V.prepare(races)
    sbr = V.scores_list(pr, scores)
    cells = V.cells(pr, sbr)
    names5 = ["c1", "c2", "c3", "c4", "c5"]
    ns = {"c1": cells["c1"]["n"], "c2": cells["c2"]["n"], "c3": cells["c3"]["n"], "c4": cells["c4"]["n_races"], "c5": cells["c5"]["n"]}
    pv = {k: V.p_one_sided(cells[k]["z"]) for k in names5 if cells[k]["z"] is not None}
    hol = V.holm(pv, K.HOLM_ALPHA)
    verdict = {k: {"n": ns[k], "z": cells[k]["z"], "p_one": pv.get(k), "p_holm": hol[k][0] if k in hol else None,
                   "survived": bool(k in hol and hol[k][1] and ns[k] >= K.MIN_N)} for k in names5}
    out = {"cells": cells, "verdict": verdict, "baseline": V.baseline_cells(pr), "n_races": len(races)}
    # 記述: 選んだ馬の帯別・前半後半・ハンデ別・xβ のみの順位
    picked_band = {"6-9": [], "10+": []}
    for (race, a), s in zip(pr, sbr):
        i = V.picks_for(a, s, "all", 1)[0]
        picked_band[race["cands"][i]["band"]].append((a["y"][i], a["p"][i]))
    out["desc_picked_band"] = {k: V.oe_from(v) for k, v in picked_band.items()}
    halves = {}
    for nm, pred in (("前半(〜2024-08-04)", lambda r: r["date"] <= K.SPLIT_DATE), ("後半(2024-08-05〜)", lambda r: r["date"] > K.SPLIT_DATE),
                     ("ハンデ戦", lambda r: r["hcp"]), ("非ハンデ戦", lambda r: not r["hcp"])):
        p2, s2 = _filter(pr, sbr, pred)
        c = V.cells(p2, s2)
        halves[nm] = {"races": len(p2), "c1": c["c1"], "c2": c["c2"], "c3": c["c3"], "base_all": V.baseline_cells(p2)["all"]}
    out["desc_splits"] = halves
    sbr_x = V.scores_list(pr, xb_only)
    cx = V.cells(pr, sbr_x)
    out["desc_xbeta_only_rank"] = {k: cx[k] for k in ("c1", "c2", "c3")}
    out["roi"] = {
        "pick_all": V.roi(pr, sbr, "all"), "base_all": V.roi(pr, sbr, "all", baseline=True),
        "pick_6-9": V.roi(pr, sbr, "6-9"), "pick_10+": V.roi(pr, sbr, "10+"), "base_10+": V.roi(pr, sbr, "10+", baseline=True),
    }
    obs = max(cells[k]["z"] for k in names5 if cells[k]["z"] is not None)
    null = sorted(V.shuffle_null(pr, K.N_SHUFFLE, K.SEED))
    out["shuffle"] = {"observed_max_z": obs, "null_median": null[len(null) // 2], "null_p95": null[int(0.95 * len(null)) - 1],
                      "empirical_p": sum(1 for v in null if v >= obs) / len(null), "n_rep": K.N_SHUFFLE, "seed": K.SEED}
    json.dump(out, open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    with gzip.open(scores_out, "wt", encoding="utf-8") as f:
        for (rid, u), v in scores.items():
            f.write(json.dumps({"raceId": rid, "umaban": u, "phat": round(v, 6)}) + "\n")
    print(json.dumps({"verdict": verdict, "shuffle": out["shuffle"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    cmd, a = sys.argv[1], sys.argv[2:]
    sys.exit({"cv": lambda: run_cv(*a), "fix": lambda: run_fix(*a), "confirm": lambda: run_confirm(*a)}[cmd]() or 0)
