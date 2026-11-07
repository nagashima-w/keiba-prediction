#!/usr/bin/env python3
"""#665: 並走の「買われすぎの印」(前走で逃げた・人気薄で大敗続き)とブリンカーの傾向を、
BASHIRA の get_stats の応答(scratchpad に保存した JSON)から、条件 × 人気の帯ごとに評価する。
層の作成・引き算・評価・Holm は #663 の analyze.py の関数を読み込んで使う。標準ライブラリだけで動く。

使い方:
  analyze.py <raw_root> <out_dir>
    raw_root には p1624 / p1620 / p2126 のディレクトリを置く(1 呼び出し 1 ファイルの JSON)。
    out_dir/results.json に、派生の条件を含む全条件 × 帯の表と、計画 §4 の判定を書く。
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "analyze663", os.path.join(HERE, "..", "bashira-blindspots-663", "analyze.py"))
a663 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(a663)

MIN_N = 300
HOLM_ALPHA = 0.05

# 派生の条件: id → (作り方, 元の id の列)。sum は層ごとの足し算、diff は 1 つ目 − 2 つ目
DERIVED = {
    "FR1C": ("sum", ["FR1C_A", "FR1C_B"], "前走で逃げた(1 コーナー ≤ 頭数の 1/8)"),
    "FR3C": ("sum", ["FR3C_A", "FR3C_B"], "参考: 前走で 3 コーナー ≤ 頭数の 1/8"),
    "BL_RE": ("diff", ["BL_PREVOFF", "BL_FIRST"], "再装着(前走は未着用・それ以前の 20 走以内に着用あり)"),
}
# 期間ごとに評価する条件と基準
EVAL = {
    "p1624": [("FR1C", "ALL_1C"), ("FR3C", "ALL"), ("SLUMP", "ALL"), ("SLUMP", "ODDS16"),
              ("ODDS16", "ALL"), ("FR1C_A", "ALL_1C"), ("FR1C_B", "ALL_1C"), ("ALL_1C", "ALL")],
    "p1620": [("BL_FIRST", "ALL"), ("BL_RE", "ALL"), ("BL_CONT", "ALL"), ("BL_PREVOFF", "ALL")],
    "p2126": [("BL_FIRST", "ALL"), ("BL_RE", "ALL"), ("BL_CONT", "ALL"), ("BL_PREVOFF", "ALL")],
}
# 計画 §4.1 の主検定(片側。向きは under = 実際 < 期待)
PRIMARY_FLAGS = [
    ("T1", "FR1C", "ALL_1C", "1-3", "top3", "under"),
    ("T2", "FR1C", "ALL_1C", "4-9", "top3", "under"),
    ("T3", "FR1C", "ALL_1C", "10+", "top3", "under"),
    ("T4", "SLUMP", "ALL", "4-9", "top3", "under"),
    ("T5", "SLUMP", "ALL", "10+", "top3", "under"),
]
# 計画 §4.2 のブリンカーの向き(期間ごとに Holm)
PRIMARY_BLINKER = [
    ("B1", "BL_FIRST", "ALL", "4-9", "top3", "under"),
    ("B2", "BL_CONT", "ALL", "10+", "top3", "over"),
]


def load_period(raw_root: str, period: str) -> dict[str, dict]:
    d = os.path.join(raw_root, period)
    if not os.path.isdir(d):
        return {}
    raw = a663.load_raw(d)
    strata = {hid: a663.to_strata(r) for hid, r in raw.items()}
    labels = {hid: r.get("label", hid) for hid, r in raw.items()}
    for hid, (how, srcs, label) in DERIVED.items():
        if not all(s in strata for s in srcs):
            continue
        if how == "sum":
            out = {}
            for s in srcs:
                for key, v in strata[s].items():
                    if key in out:
                        out[key] = {k: out[key][k] + v[k] for k in v}
                    else:
                        out[key] = dict(v)
            strata[hid] = out
        else:
            strata[hid] = a663.subtract(strata[srcs[0]], strata[srcs[1]])
        labels[hid] = label
    return {"strata": strata, "labels": labels}


def band_totals(base: dict) -> dict[str, dict]:
    """基準の帯ごとの率・回収率(回収率の差を読むため)。"""
    out = {}
    for band, lo, hi in a663.BANDS:
        n = w = t = wr = pr = 0
        for (_, rank), v in base.items():
            if lo <= rank <= hi:
                n += v["starts"]; w += v["wins"]; t += v["top3"]; wr += v["win_return"]; pr += v["place_return"]
        out[band] = {"n": n, "win_rate": round(w / n, 4) if n else None, "top3_rate": round(t / n, 4) if n else None,
                     "win_roi": round(wr / (n * 100), 3) if n else None, "place_roi": round(pr / (n * 100), 3) if n else None}
    return out


def judge(rows_index: dict, tests: list, periods: list[str]) -> list[dict]:
    """片側 p を Holm で補正して判定する。tests の各要素は (id, cond, base, band, outcome, direction)。"""
    out = []
    for period in periods:
        pvals, items = [], []
        for tid, cond, base, band, outcome, direction in tests:
            row = rows_index.get((period, cond, base, band))
            if row is None:
                items.append({"id": tid, "period": period, "cond": cond, "base": base, "band": band,
                              "outcome": outcome, "direction": direction, "missing": True})
                pvals.append(1.0)
                continue
            z = row[outcome]["z"]
            same = (z > 0) == (direction == "over")
            p_one = a663.norm_sf(abs(z)) if same else 1.0 - a663.norm_sf(abs(z))
            items.append({"id": tid, "period": period, "cond": cond, "base": base, "band": band, "outcome": outcome,
                          "direction": direction, "n": row["n"], "obs": row[outcome]["obs"], "exp": row[outcome]["exp"],
                          "ratio": row[outcome]["ratio"], "z": z, "same_direction": same, "p_one_sided": p_one,
                          "win_roi": row["win_roi"], "place_roi": row["place_roi"], "avg_odds": row["avg_odds"]})
            pvals.append(p_one)
        adj = a663.holm(pvals)
        for it, a in zip(items, adj):
            it["p_holm"] = round(a, 6)
            it["passed"] = bool(not it.get("missing") and it["n"] >= MIN_N and it["same_direction"] and a < HOLM_ALPHA)
        out.extend(items)
    return out


def main(raw_root: str, out_dir: str) -> None:
    table = []
    base_tables = {}
    for period, pairs in EVAL.items():
        data = load_period(raw_root, period)
        if not data:
            continue
        strata, labels = data["strata"], data["labels"]
        for base_id in sorted({b for _, b in pairs} | {"ALL"}):
            if base_id in strata:
                base_tables[f"{period}/{base_id}"] = band_totals(strata[base_id])
        for cond, base in pairs:
            if cond not in strata or base not in strata:
                print(f"[{period}] {cond} vs {base}: 集計が無いので飛ばす", file=sys.stderr)
                continue
            for row in a663.evaluate(strata[cond], strata[base]):
                table.append({"period": period, "id": cond, "label": labels.get(cond, cond), "baseline": base, **row})
    index = {(r["period"], r["id"], r["baseline"], r["band"]): r for r in table}
    flags = judge(index, PRIMARY_FLAGS, ["p1624"])
    blinker = judge(index, PRIMARY_BLINKER, ["p1620", "p2126"])
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "results.json"), "w", encoding="utf-8") as f:
        json.dump({"min_n": MIN_N, "holm_alpha": HOLM_ALPHA, "flags": flags, "blinker": blinker,
                   "baselines": base_tables, "rows": table}, f, ensure_ascii=False, indent=1)
    print("== 主検定(並走の印。Holm は 5 検定)")
    for it in flags:
        print_judge(it)
    print("== ブリンカーの向き(期間ごとに Holm 2 検定)")
    for it in blinker:
        print_judge(it)
    print("== 全条件 × 帯")
    print("period\tid\tbase\tband\tn\ttop3 実/期\ttop3 z\twin 実/期\twin z\t単勝回収\t複勝回収\t平均オッズ")
    for r in table:
        print(f"{r['period']}\t{r['id']}\t{r['baseline']}\t{r['band']}\t{r['n']}\t{r['top3']['ratio']}\t{r['top3']['z']}\t"
              f"{r['win']['ratio']}\t{r['win']['z']}\t{r['win_roi']}\t{r['place_roi']}\t{r['avg_odds']}")
    print("== 基準の帯ごとの率")
    for k, v in base_tables.items():
        print(k, json.dumps(v, ensure_ascii=False))


def print_judge(it: dict) -> None:
    if it.get("missing"):
        print(f"　 {it['id']} {it['period']} {it['cond']} [{it['band']}]: 集計が無い")
        return
    print(f"{'残' if it['passed'] else '　'} {it['id']} {it['period']} {it['cond']} vs {it['base']} [{it['band']}] {it['outcome']} {it['direction']}: "
          f"n={it['n']} 実/期={it['ratio']} z={it['z']} 片側p={it['p_one_sided']:.2e} Holm p={it['p_holm']} "
          f"単勝{it['win_roi']} 複勝{it['place_roi']} 平均オッズ{it['avg_odds']}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
