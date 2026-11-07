#!/usr/bin/env python3
"""#663: BASHIRA の get_stats の応答(scratchpad に保存した JSON)から、条件 × 人気の帯ごとの
実際/期待・z・回収率を計算する。標準ライブラリだけで動く。

使い方:
  explore <raw_dir> <out_dir>                  探索の期間の走査。候補を out_dir/candidates.json に書く
  confirm <raw_dir> <candidates.json> <out_dir> 確認の期間。固定した候補に Holm の補正を当てる

raw_dir には 1 呼び出し 1 ファイルの JSON(id・label・baseline・columns・rows)を置く。
ALL(芝ダ全馬)と ALL_TURF(芝の全馬)は必ず置く。ALL_DIRT は ALL − ALL_TURF で作る。
"""
from __future__ import annotations

import json
import math
import os
import sys

BANDS = [("1-3", 1, 3), ("4-9", 4, 9), ("10+", 10, 99)]
COLS = ["race_condition", "win_odds_rank", "starts", "wins", "top3", "win_return", "place_return", "avg_odds"]
HYPOTHESIS_PREFIXES = ("H",)  # 候補の対象(C は対照、X は事前登録の外。表には出すが候補にしない)
MIN_N = 300
Z_MIN = 3.0
BH_Q = 0.05
HOLM_ALPHA = 0.05


def norm_sf(z: float) -> float:
    """標準正規分布の上側確率。"""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def load_raw(raw_dir: str) -> dict[str, dict]:
    out = {}
    for name in sorted(os.listdir(raw_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(raw_dir, name), encoding="utf-8") as f:
            d = json.load(f)
        if d.get("columns") and d["columns"] != COLS:
            raise SystemExit(f"{name}: 列の並びが想定と違う: {d['columns']}")
        out[d["id"]] = d
    return out


def to_strata(d: dict) -> dict[tuple[str, int], dict]:
    """rows → {(クラス, 人気順): {starts, wins, top3, win_return, place_return, odds_sum}}。"""
    strata = {}
    for row in d.get("rows") or []:
        cond, rank, starts, wins, top3, win_ret, place_ret, avg_odds = row
        if rank is None or starts == 0:
            continue
        strata[(cond, int(rank))] = {
            "starts": starts,
            "wins": wins,
            "top3": top3,
            "win_return": win_ret or 0,
            "place_return": place_ret or 0,
            "odds_sum": (avg_odds or 0.0) * starts,
        }
    return strata


def subtract(a: dict, b: dict) -> dict:
    """層ごとに a − b(ALL − ALL_TURF = ALL_DIRT、全馬 − 条件 = 条件に当たらない馬)。"""
    out = {}
    for key, va in a.items():
        vb = b.get(key)
        if vb is None:
            out[key] = dict(va)
            continue
        out[key] = {k: va[k] - vb[k] for k in va}
        if out[key]["starts"] < 0:
            raise SystemExit(f"層 {key} で引き算が負になった(条件が基準の部分集合でない)")
    return out


def evaluate(cond: dict, base: dict) -> list[dict]:
    """条件 cond を、基準 base(条件を含む全馬)に対して帯ごとに評価する。"""
    rest = subtract(base, cond)  # 条件に当たらない馬
    results = []
    for band_name, lo, hi in BANDS:
        n = 0
        obs = {"win": 0, "top3": 0}
        exp = {"win": 0.0, "top3": 0.0}
        var = {"win": 0.0, "top3": 0.0}
        win_ret = place_ret = 0
        odds_sum = 0.0
        for (klass, rank), c in cond.items():
            if not (lo <= rank <= hi):
                continue
            r = rest.get((klass, rank))
            if r is None or r["starts"] == 0:
                # 条件に当たらない馬がその層に 1 頭もいない(期待値が作れない)。層ごと落とす
                continue
            n += c["starts"]
            win_ret += c["win_return"]
            place_ret += c["place_return"]
            odds_sum += c["odds_sum"]
            for key, field in (("win", "wins"), ("top3", "top3")):
                p = r[field] / r["starts"]
                obs[key] += c[field]
                exp[key] += c["starts"] * p
                var[key] += c["starts"] * p * (1 - p)
        row = {"band": band_name, "n": n,
               "win_roi": round(win_ret / (n * 100), 3) if n else None,
               "place_roi": round(place_ret / (n * 100), 3) if n else None,
               "avg_odds": round(odds_sum / n, 1) if n else None}
        for key in ("win", "top3"):
            o, e, v = obs[key], exp[key], var[key]
            z = (o - e) / math.sqrt(v) if v > 0 else 0.0
            row[key] = {"obs": o, "exp": round(e, 1), "ratio": round(o / e, 3) if e > 0 else None,
                        "z": round(z, 2), "p_two_sided": 2 * norm_sf(abs(z)) if v > 0 else 1.0}
        results.append(row)
    return results


def benjamini_hochberg(pvals: list[float]) -> list[float]:
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    q = [0.0] * m
    prev = 1.0
    for rank_from_top, i in enumerate(reversed(order)):
        k = m - rank_from_top
        prev = min(prev, pvals[i] * m / k)
        q[i] = prev
    return q


def holm(pvals: list[float]) -> list[float]:
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    adj = [0.0] * m
    running = 0.0
    for j, i in enumerate(order):
        running = max(running, pvals[i] * (m - j))
        adj[i] = min(1.0, running)
    return adj


def run_all(raw: dict[str, dict]) -> list[dict]:
    bases = {"ALL": to_strata(raw["ALL"]), "ALL_TURF": to_strata(raw["ALL_TURF"])}
    bases["ALL_DIRT"] = subtract(bases["ALL"], bases["ALL_TURF"])
    table = []
    for hid in sorted(raw):
        if hid in ("ALL", "ALL_TURF"):
            continue
        d = raw[hid]
        cond = to_strata(d)
        base = bases[d.get("baseline", "ALL")]
        for row in evaluate(cond, base):
            table.append({"id": hid, "label": d["label"], "baseline": d.get("baseline", "ALL"), **row})
    return table


def cmd_explore(raw_dir: str, out_dir: str) -> None:
    raw = load_raw(raw_dir)
    table = run_all(raw)
    tests = []  # (table index, outcome)
    for i, row in enumerate(table):
        if row["id"].startswith(HYPOTHESIS_PREFIXES):
            for key in ("win", "top3"):
                tests.append((i, key))
    pvals = [table[i][key]["p_two_sided"] for i, key in tests]
    qvals = benjamini_hochberg(pvals)
    candidates = []
    for (i, key), q in zip(tests, qvals):
        row = table[i]
        row[key]["q_bh"] = round(q, 6)
        stat = row[key]
        if row["n"] >= MIN_N and abs(stat["z"]) >= Z_MIN and q < BH_Q:
            candidates.append({"id": row["id"], "label": row["label"], "band": row["band"], "outcome": key,
                               "direction": "over" if stat["z"] > 0 else "under",
                               "explore": {"n": row["n"], "obs": stat["obs"], "exp": stat["exp"],
                                           "ratio": stat["ratio"], "z": stat["z"], "q_bh": round(q, 6)}})
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "explore-results.json"), "w", encoding="utf-8") as f:
        json.dump({"tests": len(tests), "rows": table}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump({"criteria": {"min_n": MIN_N, "z_min": Z_MIN, "bh_q": BH_Q, "tests": len(tests)},
                   "candidates": candidates}, f, ensure_ascii=False, indent=1)
    print(f"検定 {len(tests)} 件、候補 {len(candidates)} 件")
    print_table(table)


def cmd_confirm(raw_dir: str, cand_path: str, out_dir: str) -> None:
    raw = load_raw(raw_dir)
    table = run_all(raw)
    with open(cand_path, encoding="utf-8") as f:
        cands = json.load(f)["candidates"]
    index = {(r["id"], r["band"]): r for r in table}
    pvals = []
    for c in cands:
        row = index.get((c["id"], c["band"]))
        if row is None:
            raise SystemExit(f"確認の期間の集計が無い: {c['id']} {c['band']}")
        stat = row[key := c["outcome"]]
        z = stat["z"]
        same_dir = (z > 0) == (c["direction"] == "over")
        p_one = norm_sf(abs(z)) if same_dir else 1.0 - norm_sf(abs(z))
        c["confirm"] = {"n": row["n"], "obs": stat["obs"], "exp": stat["exp"], "ratio": stat["ratio"], "z": z,
                        "same_direction": same_dir, "p_one_sided": p_one,
                        "win_roi": row["win_roi"], "place_roi": row["place_roi"], "avg_odds": row["avg_odds"]}
        pvals.append(p_one)
    adj = holm(pvals)
    for c, a in zip(cands, adj):
        c["confirm"]["p_holm"] = round(a, 6)
        c["survived"] = bool(c["confirm"]["n"] >= MIN_N and c["confirm"]["same_direction"] and a < HOLM_ALPHA)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8") as f:
        json.dump({"holm_alpha": HOLM_ALPHA, "k": len(cands), "candidates": cands, "rows": table},
                  f, ensure_ascii=False, indent=1)
    print(f"候補 {len(cands)} 件、残った {sum(c['survived'] for c in cands)} 件")
    for c in cands:
        e, k = c["explore"], c["confirm"]
        print(f"{'残' if c['survived'] else '　'} {c['id']} {c['label']} [{c['band']}] {c['outcome']} {c['direction']}: "
              f"探索 n={e['n']} 実/期={e['ratio']} z={e['z']} | 確認 n={k['n']} 実/期={k['ratio']} z={k['z']} "
              f"Holm p={k['p_holm']} 単勝{k['win_roi']} 複勝{k['place_roi']}")
    print_table(table)


def print_table(table: list[dict]) -> None:
    print("id\tlabel\tband\tn\ttop3 実/期\ttop3 z\twin 実/期\twin z\t単勝回収\t複勝回収\t平均オッズ")
    for r in table:
        print(f"{r['id']}\t{r['label']}\t{r['band']}\t{r['n']}\t{r['top3']['ratio']}\t{r['top3']['z']}\t"
              f"{r['win']['ratio']}\t{r['win']['z']}\t{r['win_roi']}\t{r['place_roi']}\t{r['avg_odds']}")


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "explore":
        cmd_explore(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 5 and sys.argv[1] == "confirm":
        cmd_confirm(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(__doc__)
        sys.exit(2)
