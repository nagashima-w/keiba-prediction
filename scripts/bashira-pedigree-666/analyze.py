#!/usr/bin/env python3
"""#666: 血統(種牡馬・母父)× 条件の組み合わせを、BASHIRA の get_stats の応答(scratchpad に保存した JSON)から評価する。
層は人気順(1〜18)だけ。基準(条件に当たる全馬)は #663 の形(クラス × 人気順)の応答をクラスで足し上げて使う。
標準ライブラリだけで動く。

使い方:
  explore <raw_dir> <out_dir>                   探索。候補を out_dir/candidates.json に書く
  confirm <raw_dir> <candidates.json> <out_dir> 確認。固定した候補に Holm の補正を当てる

raw_dir のファイル:
  基準(#663 の形): ALL, ALL_TURF, H12, H32, HEAVY, JUV。columns は [race_condition, win_odds_rank, starts, wins, top3, win_return, place_return, avg_odds]
  血統(族ごと): F0〜F6。columns は [<name>, win_odds_rank, starts, wins, top3, win_return, place_return, avg_odds]
  任意(参考): <族>_<名前の添字> など、#663 の形で 1 頭分を引いたもの(baseline を書いておく)
"""
from __future__ import annotations

import json
import math
import os
import sys

MIN_N = 300
Z_MIN = 3.0
BH_Q = 0.05
HOLM_ALPHA = 0.05
BANDS = [("1-3", 1, 3), ("4-9", 4, 9), ("10+", 10, 99)]
# 族 → 基準の id(ALL_DIRT は ALL − ALL_TURF で作る)
FAMILY_BASE = {"F0": "ALL", "F1": "H32", "F2": "HEAVY", "F3": "ALL_DIRT", "F4": "H12", "F5": "JUV", "F6": "ALL"}
FAMILY_LABEL = {"F0": "種牡馬(条件なし)", "F1": "種牡馬 × 芝→ダート替わり", "F2": "種牡馬 × 重・不良",
                "F3": "母父 × ダート", "F4": "種牡馬 × 距離延長 400m 以上", "F5": "種牡馬 × 2歳戦", "F6": "母父(条件なし)"}
MAIN_OF = {"F1": "F0", "F2": "F0", "F3": "F6", "F4": "F0", "F5": "F0"}  # 主効果の族


def norm_sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def load_raw(raw_dir: str) -> dict[str, dict]:
    out = {}
    for name in sorted(os.listdir(raw_dir)):
        if name.endswith(".json"):
            with open(os.path.join(raw_dir, name), encoding="utf-8") as f:
                d = json.load(f)
            out[d["id"]] = d
    return out


def cell(row) -> dict:
    _, _, starts, wins, top3, win_ret, place_ret, avg_odds = row
    return {"starts": starts, "wins": wins, "top3": top3, "win_return": win_ret or 0,
            "place_return": place_ret or 0, "odds_sum": (avg_odds or 0.0) * starts}


def add(a: dict, b: dict) -> dict:
    return {k: a[k] + b[k] for k in a}


def by_rank(d: dict) -> dict[int, dict]:
    """#663 の形(クラス × 人気順)を人気順に足し上げる。"""
    out = {}
    for row in d.get("rows") or []:
        if row[1] is None or row[2] == 0:
            continue
        r = int(row[1])
        out[r] = add(out[r], cell(row)) if r in out else cell(row)
    return out


def by_name_rank(d: dict) -> dict[str, dict[int, dict]]:
    """血統 × 人気順 → {名前: {人気順: cell}}。"""
    out: dict[str, dict[int, dict]] = {}
    for row in d.get("rows") or []:
        if row[0] is None or row[1] is None or row[2] == 0:
            continue
        out.setdefault(row[0], {})[int(row[1])] = cell(row)
    return out


def subtract_rank(a: dict[int, dict], b: dict[int, dict]) -> dict[int, dict]:
    out = {}
    for r, va in a.items():
        vb = b.get(r)
        out[r] = dict(va) if vb is None else {k: va[k] - vb[k] for k in va}
        if out[r]["starts"] < 0:
            raise SystemExit(f"人気順 {r} で引き算が負になった")
    return out


def evaluate(cond: dict[int, dict], base: dict[int, dict]) -> dict:
    """名前 ∧ 条件(cond)を、条件の全馬(base)に対して評価する。全体と帯の内訳。"""
    rest = subtract_rank(base, cond)
    out = {}
    for band_name, lo, hi in [("all", 1, 99)] + BANDS:
        n = win_ret = place_ret = 0
        odds_sum = 0.0
        obs = {"win": 0, "top3": 0}
        exp = {"win": 0.0, "top3": 0.0}
        var = {"win": 0.0, "top3": 0.0}
        for r, c in cond.items():
            if not (lo <= r <= hi):
                continue
            b = rest.get(r)
            if b is None or b["starts"] == 0:
                continue
            n += c["starts"]; win_ret += c["win_return"]; place_ret += c["place_return"]; odds_sum += c["odds_sum"]
            for key, field in (("win", "wins"), ("top3", "top3")):
                p = b[field] / b["starts"]
                obs[key] += c[field]; exp[key] += c["starts"] * p; var[key] += c["starts"] * p * (1 - p)
        row = {"n": n, "win_roi": round(win_ret / (n * 100), 3) if n else None,
               "place_roi": round(place_ret / (n * 100), 3) if n else None,
               "avg_odds": round(odds_sum / n, 1) if n else None}
        for key in ("win", "top3"):
            o, e, v = obs[key], exp[key], var[key]
            z = (o - e) / math.sqrt(v) if v > 0 else 0.0
            row[key] = {"obs": o, "exp": round(e, 1), "ratio": round(o / e, 3) if e > 0 else None,
                        "z": round(z, 2), "p_two_sided": 2 * norm_sf(abs(z)) if v > 0 else 1.0}
        out[band_name] = row
    return out


def benjamini_hochberg(pvals: list[float]) -> list[float]:
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    q = [0.0] * m
    prev = 1.0
    for k_from_top, i in enumerate(reversed(order)):
        k = m - k_from_top
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


def run_all(raw: dict[str, dict]) -> tuple[list[dict], dict]:
    bases = {bid: by_rank(raw[bid]) for bid in ("ALL", "ALL_TURF", "H12", "H32", "HEAVY", "JUV") if bid in raw}
    if "ALL" in bases and "ALL_TURF" in bases:
        bases["ALL_DIRT"] = subtract_rank(bases["ALL"], bases["ALL_TURF"])
    table = []
    for fam in sorted(FAMILY_BASE):
        if fam not in raw:
            continue
        base_id = FAMILY_BASE[fam]
        if base_id not in bases:
            print(f"{fam}: 基準 {base_id} が無いので飛ばす", file=sys.stderr)
            continue
        for name, cond in sorted(by_name_rank(raw[fam]).items()):
            ev = evaluate(cond, bases[base_id])
            table.append({"family": fam, "label": FAMILY_LABEL[fam], "name": name, "baseline": base_id, **ev})
    base_tot = {}
    for bid, b in bases.items():
        n = sum(v["starts"] for v in b.values())
        base_tot[bid] = {"n": n, "win_rate": round(sum(v["wins"] for v in b.values()) / n, 4) if n else None,
                         "top3_rate": round(sum(v["top3"] for v in b.values()) / n, 4) if n else None,
                         "win_roi": round(sum(v["win_return"] for v in b.values()) / (n * 100), 3) if n else None,
                         "place_roi": round(sum(v["place_return"] for v in b.values()) / (n * 100), 3) if n else None}
    return table, base_tot


def cmd_explore(raw_dir: str, out_dir: str) -> None:
    raw = load_raw(raw_dir)
    table, base_tot = run_all(raw)
    tests = [(i, key) for i, _ in enumerate(table) for key in ("win", "top3")]
    pvals = [table[i]["all"][key]["p_two_sided"] for i, key in tests]
    qvals = benjamini_hochberg(pvals)
    cands = []
    for (i, key), q in zip(tests, qvals):
        row = table[i]
        stat = row["all"][key]
        stat["q_bh"] = round(q, 6)
        if row["all"]["n"] >= MIN_N and abs(stat["z"]) >= Z_MIN and q < BH_Q:
            cands.append({"family": row["family"], "label": row["label"], "name": row["name"], "outcome": key,
                          "direction": "over" if stat["z"] > 0 else "under",
                          "explore": {"n": row["all"]["n"], "obs": stat["obs"], "exp": stat["exp"], "ratio": stat["ratio"],
                                      "z": stat["z"], "q_bh": round(q, 6), "win_roi": row["all"]["win_roi"],
                                      "place_roi": row["all"]["place_roi"], "avg_odds": row["all"]["avg_odds"]}})
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "explore-results.json"), "w", encoding="utf-8") as f:
        json.dump({"tests": len(tests), "baselines": base_tot, "rows": table}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump({"criteria": {"min_n": MIN_N, "z_min": Z_MIN, "bh_q": BH_Q, "tests": len(tests)}, "candidates": cands},
                  f, ensure_ascii=False, indent=1)
    print(f"検定 {len(tests)} 件、候補 {len(cands)} 件")
    for c in cands:
        e = c["explore"]
        print(f"  {c['family']} {c['name']} {c['outcome']} {c['direction']}: n={e['n']} 実/期={e['ratio']} z={e['z']} q={e['q_bh']}")
    print_table(table)


def cmd_confirm(raw_dir: str, cand_path: str, out_dir: str) -> None:
    raw = load_raw(raw_dir)
    table, base_tot = run_all(raw)
    with open(cand_path, encoding="utf-8") as f:
        cands = json.load(f)["candidates"]
    index = {(r["family"], r["name"]): r for r in table}
    pvals = []
    for c in cands:
        row = index.get((c["family"], c["name"]))
        if row is None:
            c["confirm"] = {"n": 0, "missing": True}
            pvals.append(1.0)
            continue
        stat = row["all"][c["outcome"]]
        z = stat["z"]
        same = (z > 0) == (c["direction"] == "over")
        p_one = norm_sf(abs(z)) if same else 1.0 - norm_sf(abs(z))
        main = index.get((MAIN_OF.get(c["family"], ""), c["name"]))
        c["confirm"] = {"n": row["all"]["n"], "obs": stat["obs"], "exp": stat["exp"], "ratio": stat["ratio"], "z": z,
                        "same_direction": same, "p_one_sided": p_one, "win_roi": row["all"]["win_roi"],
                        "place_roi": row["all"]["place_roi"], "avg_odds": row["all"]["avg_odds"],
                        "bands": {b: {"n": row[b]["n"], "ratio": row[b][c["outcome"]]["ratio"], "z": row[b][c["outcome"]]["z"]} for b, _, _ in BANDS},
                        "main_effect": None if main is None else {"n": main["all"]["n"], "ratio": main["all"][c["outcome"]]["ratio"], "z": main["all"][c["outcome"]]["z"]}}
        pvals.append(p_one)
    adj = holm(pvals)
    for c, a in zip(cands, adj):
        k = c["confirm"]
        k["p_holm"] = round(a, 6)
        if k.get("missing") or k["n"] < MIN_N:
            c["verdict"] = "insufficient"
        elif k["same_direction"] and a < HOLM_ALPHA:
            c["verdict"] = "survived"
        else:
            c["verdict"] = "failed"
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8") as f:
        json.dump({"holm_alpha": HOLM_ALPHA, "k": len(cands), "baselines": base_tot, "candidates": cands, "rows": table},
                  f, ensure_ascii=False, indent=1)
    counts = {v: sum(c["verdict"] == v for c in cands) for v in ("survived", "failed", "insufficient")}
    print(f"候補 {len(cands)} 件: 残った {counts['survived']}、残らなかった {counts['failed']}、確認できない {counts['insufficient']}")
    for c in cands:
        e, k = c["explore"], c["confirm"]
        mark = {"survived": "残", "failed": "　", "insufficient": "不"}[c["verdict"]]
        if k.get("missing"):
            print(f"{mark} {c['family']} {c['name']} {c['outcome']}: 確認の集計が無い")
            continue
        print(f"{mark} {c['family']} {c['name']} {c['outcome']} {c['direction']}: 探索 n={e['n']} 実/期={e['ratio']} z={e['z']} | "
              f"確認 n={k['n']} 実/期={k['ratio']} z={k['z']} Holm p={k['p_holm']} 単勝{k['win_roi']} 複勝{k['place_roi']} 主効果={k['main_effect']}")
    print_table(table)


def print_table(table: list[dict]) -> None:
    print("family\tname\tn\ttop3 実/期\ttop3 z\twin 実/期\twin z\t単勝回収\t複勝回収\t平均オッズ")
    for r in table:
        a = r["all"]
        print(f"{r['family']}\t{r['name']}\t{a['n']}\t{a['top3']['ratio']}\t{a['top3']['z']}\t{a['win']['ratio']}\t{a['win']['z']}\t"
              f"{a['win_roi']}\t{a['place_roi']}\t{a['avg_odds']}")


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "explore":
        cmd_explore(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 5 and sys.argv[1] == "confirm":
        cmd_confirm(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(__doc__)
        sys.exit(2)
