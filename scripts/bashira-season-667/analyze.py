#!/usr/bin/env python3
"""#667: 季節・性別・斤量の変化などの条件を、BASHIRA の get_stats の応答(scratchpad に保存した JSON)から
条件 × 人気の帯ごとに評価する。#663 の analyze.py の関数(層の作成・引き算・評価・BH・Holm)を読み込んで使い、
基準はファイルの "baseline" に書いた id(ALL・H34・HEAVY・HANDI・MIX など、同じディレクトリにあるもの)を使う。
標準ライブラリだけで動く。

使い方:
  explore <raw_dir> <out_dir>
  confirm <raw_dir> <candidates.json> <out_dir>
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

HYPOTHESIS_PREFIX = "S"  # 候補の対象(C は対照、それ以外は基準)
BASELINE_IDS = ("ALL", "H34", "HEAVY", "HANDI", "MIX")


def run_all(raw: dict[str, dict]) -> tuple[list[dict], dict]:
    strata = {hid: a663.to_strata(d) for hid, d in raw.items()}
    table = []
    for hid in sorted(raw):
        d = raw[hid]
        if hid in BASELINE_IDS or not (hid.startswith(HYPOTHESIS_PREFIX) or hid.startswith("C")):
            continue
        base_id = d.get("baseline", "ALL")
        if base_id not in strata:
            print(f"{hid}: 基準 {base_id} が無いので飛ばす", file=sys.stderr)
            continue
        for row in a663.evaluate(strata[hid], strata[base_id]):
            table.append({"id": hid, "label": d["label"], "baseline": base_id, **row})
    base_tot = {}
    for bid in BASELINE_IDS:
        if bid not in strata:
            continue
        base_tot[bid] = {}
        for band, lo, hi in a663.BANDS:
            n = w = t = wr = pr = 0
            for (_, rank), v in strata[bid].items():
                if lo <= rank <= hi:
                    n += v["starts"]; w += v["wins"]; t += v["top3"]; wr += v["win_return"]; pr += v["place_return"]
            base_tot[bid][band] = {"n": n, "win_rate": round(w / n, 4) if n else None, "top3_rate": round(t / n, 4) if n else None,
                                   "win_roi": round(wr / (n * 100), 3) if n else None, "place_roi": round(pr / (n * 100), 3) if n else None}
    return table, base_tot


def cmd_explore(raw_dir: str, out_dir: str) -> None:
    raw = a663.load_raw(raw_dir)
    table, base_tot = run_all(raw)
    tests = [(i, key) for i, row in enumerate(table) if row["id"].startswith(HYPOTHESIS_PREFIX) for key in ("win", "top3")]
    pvals = [table[i][key]["p_two_sided"] for i, key in tests]
    qvals = a663.benjamini_hochberg(pvals)
    cands = []
    for (i, key), q in zip(tests, qvals):
        row = table[i]
        stat = row[key]
        stat["q_bh"] = round(q, 6)
        if row["n"] >= a663.MIN_N and abs(stat["z"]) >= a663.Z_MIN and q < a663.BH_Q:
            cands.append({"id": row["id"], "label": row["label"], "baseline": row["baseline"], "band": row["band"], "outcome": key,
                          "direction": "over" if stat["z"] > 0 else "under",
                          "explore": {"n": row["n"], "obs": stat["obs"], "exp": stat["exp"], "ratio": stat["ratio"], "z": stat["z"],
                                      "q_bh": round(q, 6), "win_roi": row["win_roi"], "place_roi": row["place_roi"], "avg_odds": row["avg_odds"]}})
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "explore-results.json"), "w", encoding="utf-8") as f:
        json.dump({"tests": len(tests), "baselines": base_tot, "rows": table}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump({"criteria": {"min_n": a663.MIN_N, "z_min": a663.Z_MIN, "bh_q": a663.BH_Q, "tests": len(tests)}, "candidates": cands},
                  f, ensure_ascii=False, indent=1)
    print(f"検定 {len(tests)} 件、候補 {len(cands)} 件")
    for c in cands:
        e = c["explore"]
        print(f"  {c['id']} {c['label']} [{c['band']}] {c['outcome']} {c['direction']}: n={e['n']} 実/期={e['ratio']} z={e['z']} q={e['q_bh']}")
    a663.print_table(table)
    print(json.dumps(base_tot, ensure_ascii=False))


def cmd_confirm(raw_dir: str, cand_path: str, out_dir: str) -> None:
    raw = a663.load_raw(raw_dir)
    table, base_tot = run_all(raw)
    with open(cand_path, encoding="utf-8") as f:
        cands = json.load(f)["candidates"]
    index = {(r["id"], r["band"]): r for r in table}
    pvals = []
    for c in cands:
        row = index.get((c["id"], c["band"]))
        if row is None:
            raise SystemExit(f"確認の期間の集計が無い: {c['id']} {c['band']}")
        stat = row[c["outcome"]]
        z = stat["z"]
        same = (z > 0) == (c["direction"] == "over")
        p_one = a663.norm_sf(abs(z)) if same else 1.0 - a663.norm_sf(abs(z))
        c["confirm"] = {"n": row["n"], "obs": stat["obs"], "exp": stat["exp"], "ratio": stat["ratio"], "z": z,
                        "same_direction": same, "p_one_sided": p_one, "win_roi": row["win_roi"], "place_roi": row["place_roi"],
                        "avg_odds": row["avg_odds"]}
        pvals.append(p_one)
    adj = a663.holm(pvals)
    for c, a in zip(cands, adj):
        c["confirm"]["p_holm"] = round(a, 6)
        c["survived"] = bool(c["confirm"]["n"] >= a663.MIN_N and c["confirm"]["same_direction"] and a < a663.HOLM_ALPHA)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8") as f:
        json.dump({"holm_alpha": a663.HOLM_ALPHA, "k": len(cands), "baselines": base_tot, "candidates": cands, "rows": table},
                  f, ensure_ascii=False, indent=1)
    print(f"候補 {len(cands)} 件、残った {sum(c['survived'] for c in cands)} 件")
    for c in cands:
        e, k = c["explore"], c["confirm"]
        print(f"{'残' if c['survived'] else '　'} {c['id']} {c['label']} [{c['band']}] {c['outcome']} {c['direction']}: "
              f"探索 n={e['n']} 実/期={e['ratio']} z={e['z']} | 確認 n={k['n']} 実/期={k['ratio']} z={k['z']} "
              f"Holm p={k['p_holm']} 単勝{k['win_roi']} 複勝{k['place_roi']} オッズ{k['avg_odds']}")
    a663.print_table(table)
    print(json.dumps(base_tot, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "explore":
        cmd_explore(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 5 and sys.argv[1] == "confirm":
        cmd_confirm(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(__doc__)
        sys.exit(2)
