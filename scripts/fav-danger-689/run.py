#!/usr/bin/env python3
"""#689: 断然の 1 番人気が 3着内を外すレースを見分ける。標準ライブラリだけ。計画は docs/investigations/fav-danger-689/plan.md。

使い方(リポジトリのルートで。<tab> = $SC/h687/table687.ndjson.gz、<h2021> = $SC/h685/hist2021.ndjson.gz、<h> = $SC/hist/hist.ndjson.gz、<csv> = $SC/hist/horse_runs.csv):
  cv      <tab> <h2021> <h> <csv> <out_dir> <cache_dir>   探索の期間だけで学習と選び方 → cv-results.json(確認を開く条件の判定を含む)
  fix     <out_dir> <cache_dir>                            条件を満たしたときだけ、探索全体で学習し直して scores-coef.json(t・tq を含む)
  confirm <tab> <h2021> <h> <csv> <out_dir> <scores_out>   scores-coef.json があるときだけ。確認の期間を 1 回だけ集計 → confirm-results.json
"""
from __future__ import annotations

import gzip
import json
import multiprocessing as mp
import os
import pickle
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common689 as K689  # noqa: E402
import common688 as K  # noqa: E402
import evaluate689 as V  # noqa: E402
import features689 as Fe  # noqa: E402
import fit as Fi  # noqa: E402

PREP_PATH = os.path.join(K689.HERE, "..", "..", "docs", "investigations", "pace-fit-687", "prep-results.json")
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


def quantile_low(vals, share):
    """下から share の分位点(昇順に並べた (n·share) 番目の値。n·share を切り捨て、0 始まりの添字 int(n·share))。"""
    s = sorted(vals)
    return s[int(len(s) * share)]


def run_cv(tab, h2021, h, csv_path, out_dir, cache_dir):
    prep = Fe.load_prep(PREP_PATH)
    cache = os.path.join(cache_dir, "explore_fav.pkl")
    if os.path.exists(cache):
        races = pickle.load(open(cache, "rb"))
    else:
        races = Fe.build(tab, [h2021, h], csv_path, prep, K.EXPLORE)
        pickle.dump(races, open(cache, "wb"))
    stats = Fe.make_stats(races)
    rows = [r["fav"] for r in races]
    blk = [block_of(r["date"]) for r in races]
    y = [r["y"] for r in rows]
    off = [K.logit(r["p3"]) for r in rows]
    _G.update({"X": {n: Fe.matrix(rows, names, stats) for n, names in Fe.SETS.items()}, "y": y, "off": off, "blk": blk})
    tasks = [(n, lam, f) for n in Fe.SETS for lam in K.LAMBDAS for f in range(len(K.BLOCKS))]
    with mp.get_context("fork").Pool(4) as pool:
        res = pool.map(_task, tasks)
    loss, pred = {}, {}
    for name, lam, fold, ll, p in res:
        loss.setdefault((name, lam), {})[fold] = ll
        pred.setdefault((name, lam), {})[fold] = p
    m0 = {}
    for f in range(len(K.BLOCKS)):
        idx = [i for i, b in enumerate(blk) if b == f]
        m0[f] = Fi.logloss([rows[i]["p3"] for i in idx], [y[i] for i in idx])
    table = [{"set": n, "lambda": lam, "block_loss": [d[f] for f in range(4)], "mean_loss": sum(d.values()) / 4} for (n, lam), d in loss.items()]
    table.sort(key=lambda r: (r["mean_loss"], len(Fe.SETS[r["set"]])))
    best = table[0]
    mc_best = min((r for r in table if r["set"] == "Mc"), key=lambda r: r["mean_loss"])
    better_m0 = sum(1 for f in range(4) if best["block_loss"][f] < m0[f])
    better_mc = sum(1 for f in range(4) if best["block_loss"][f] < mc_best["block_loss"][f])
    gate = best["set"] in Fe.CAND_SETS and better_m0 >= 3 and better_mc >= 3
    best_by_set = {n: min((r for r in table if r["set"] == n), key=lambda r: r["mean_loss"]) for n in Fe.SETS}
    out = {
        "block_ranges": K.BLOCKS, "n_races": len(races), "n_rows": len(rows),
        "m0_block_loss": [m0[f] for f in range(4)], "m0_mean_loss": sum(m0.values()) / 4,
        "table": table, "best_by_set": best_by_set, "chosen": {"set": best["set"], "lambda": best["lambda"]},
        "mc_best": {"lambda": mc_best["lambda"], "block_loss": mc_best["block_loss"], "mean_loss": mc_best["mean_loss"]},
        "blocks_better_than_m0": better_m0, "blocks_better_than_mc_best": better_mc,
        "gate_open_confirm": gate,
        "gate_rule": "選ばれた集合が M1・M2・M1c・M2c のいずれかで、保持ブロックの対数損失が M0 より小さいブロックが 4 つ中 3 つ以上、かつ Mc(最良の λ)より小さいブロックが 4 つ中 3 つ以上(plan.md §4)",
        "explore_base": {"O3": sum(y), "E3": sum(r["p3"] for r in rows), "n": len(rows)},
    }
    # 記述: 選ばれた設定の保持ブロックの予測(p̂)で、下から 3 分の 1 の O/E(当てはめの記述。検定しない)
    pk = (best["set"], best["lambda"])
    ph = [None] * len(rows)
    for f in range(4):
        idx = [i for i, b in enumerate(blk) if b == f]
        for i, p in zip(idx, pred[pk][f]):
            ph[i] = p
    t = quantile_low(ph, K689.DANGER_SHARE)
    sel = [r for r, p in zip(rows, ph) if p < t]
    out["descriptive_heldout_low_third"] = {"t": t, "cells": V.four_cells(sel)}
    tq = quantile_low([r["q"] for r in rows], K689.DANGER_SHARE)
    out["descriptive_heldout_q_low_third"] = {"tq": tq, "cells": V.four_cells([r for r in rows if r["q"] < tq])}
    json.dump(out, open(os.path.join(out_dir, "cv-results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({k: out[k] for k in ("chosen", "blocks_better_than_m0", "blocks_better_than_mc_best", "gate_open_confirm", "m0_mean_loss")}, ensure_ascii=False))
    for r in table[:8]:
        print(r["set"], r["lambda"], round(r["mean_loss"], 6))
    for n, r in best_by_set.items():
        print("best", n, r["lambda"], round(r["mean_loss"], 6))


def run_fix(out_dir, cache_dir):
    cv = json.load(open(os.path.join(out_dir, "cv-results.json"), encoding="utf-8"))
    if not cv["gate_open_confirm"]:
        print("確認を開く条件を満たしていない。scores-coef.json は作らない。")
        return 1
    races = pickle.load(open(os.path.join(cache_dir, "explore_fav.pkl"), "rb"))
    stats = Fe.make_stats(races)
    rows = [r["fav"] for r in races]
    names = Fe.SETS[cv["chosen"]["set"]]
    X = Fe.matrix(rows, names, stats)
    off = [K.logit(r["p3"]) for r in rows]
    w = Fi.fit(X, [r["y"] for r in rows], off, cv["chosen"]["lambda"])
    ph = Fi.predict(X, off, w)
    t = quantile_low(ph, K689.DANGER_SHARE)
    tq = quantile_low([r["q"] for r in rows], K689.DANGER_SHARE)
    prep = Fe.load_prep(PREP_PATH)
    out = {"set": cv["chosen"]["set"], "lambda": cv["chosen"]["lambda"], "features": ["切片"] + names, "beta": w, "stats": stats,
           "t": t, "tq": tq, "share": K689.DANGER_SHARE, "explore_share_below_t": sum(1 for p in ph if p < t) / len(ph),
           "offset_coef": prep["coef"], "prep_path": "docs/investigations/pace-fit-687/prep-results.json", "n_rows": len(rows)}
    json.dump(out, open(os.path.join(out_dir, "scores-coef.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"features": out["features"], "beta": [round(v, 4) for v in w], "t": t, "tq": tq}, ensure_ascii=False))
    return 0


def run_confirm(tab, h2021, h, csv_path, out_dir, scores_out):
    sc_path = os.path.join(out_dir, "scores-coef.json")
    if not os.path.exists(sc_path):
        print("scores-coef.json が無い。確認の期間は開かない。")
        return 1
    sc = json.load(open(sc_path, encoding="utf-8"))
    prep = Fe.load_prep(PREP_PATH)
    assert sc["offset_coef"] == prep["coef"]
    races = Fe.build(tab, [h2021, h], csv_path, prep, K.CONFIRM)
    names, beta, t, tq = sc["features"][1:], sc["beta"], sc["t"], sc["tq"]
    phat = []
    for race in races:
        r = race["fav"]
        z = sum(b * v for b, v in zip(beta, [1.0] + [Fe.column(r, n, sc["stats"]) for n in names]))
        phat.append(K.sigmoid(K.logit(r["p3"]) + z))
    favs = [r["fav"] for r in races]
    dang = [rc for rc, p in zip(races, phat) if p < t]
    base = [rc for rc in races if rc["fav"]["q"] < tq]
    safe_cut = sorted(phat)[int(len(phat) * 2 / 3)]  # 記述用(安全側)。確認の分布の上から 3 分の 1。検定しない
    safe = [rc for rc, p in zip(races, phat) if p >= safe_cut]
    mid = [rc for rc, p in zip(races, phat) if t <= p < safe_cut]
    cells = V.four_cells([rc["fav"] for rc in dang])
    verdict = V.verdict(cells)
    out = {
        "n_races": len(races), "t": t, "tq": tq,
        "share_danger": len(dang) / len(races), "share_q_base": len(base) / len(races),
        "all_targets": V.four_cells(favs), "all_targets_by_band": {b: V.four_cells([f for f in favs if f["band"] == b]) for b in ("1.0-1.9", "2.0-2.9")},
        "danger": cells, "verdict": verdict, "q_base": V.four_cells([rc["fav"] for rc in base]),
        "desc_mid_third_by_confirm_quantile": V.four_cells([rc["fav"] for rc in mid]),
        "desc_upper_third_by_confirm_quantile": V.four_cells([rc["fav"] for rc in safe]),
        "overlap_danger_and_q_base": sum(1 for rc, p in zip(races, phat) if p < t and rc["fav"]["q"] < tq),
    }
    halves = {}
    for nm, pred in (("前半(〜2024-08-04)", lambda r: r["date"] <= K.SPLIT_DATE), ("後半(2024-08-05〜)", lambda r: r["date"] > K.SPLIT_DATE),
                     ("ハンデ戦", lambda r: r["hcp"]), ("非ハンデ戦", lambda r: not r["hcp"])):
        halves[nm] = {"danger": V.four_cells([rc["fav"] for rc in dang if pred(rc)]), "all": V.four_cells([rc["fav"] for rc in races if pred(rc)])["c1"]}
    out["desc_splits"] = halves
    out["roi"] = {"danger": V.roi_all(dang), "q_base": V.roi_all(base), "all_targets": V.roi_all(races),
                  "danger_by_band": {b: V.roi_all([rc for rc in dang if rc["fav"]["band"] == b]) for b in ("1.0-1.9", "2.0-2.9")},
                  "not_danger": V.roi_all([rc for rc, p in zip(races, phat) if p >= t])}
    obs = max(-cells[k]["z"] for k in cells if cells[k]["z"] is not None)
    null = sorted(V.shuffle_null(races, phat, t, K689.N_SHUFFLE, K689.SEED))
    out["shuffle"] = {"observed_max_neg_z": obs, "null_median": null[len(null) // 2], "null_p95": null[int(0.95 * len(null)) - 1],
                      "empirical_p": sum(1 for v in null if v >= obs) / len(null), "n_rep": K689.N_SHUFFLE, "seed": K689.SEED}
    json.dump(out, open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    with gzip.open(scores_out, "wt", encoding="utf-8") as f:
        for rc, p in zip(races, phat):
            f.write(json.dumps({"raceId": rc["raceId"], "umaban": rc["fav"]["umaban"], "phat": round(p, 6)}) + "\n")
    print(json.dumps({"verdict": verdict, "shuffle": out["shuffle"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    cmd, a = sys.argv[1], sys.argv[2:]
    sys.exit({"cv": lambda: run_cv(*a), "fix": lambda: run_fix(*a), "confirm": lambda: run_confirm(*a)}[cmd]() or 0)
