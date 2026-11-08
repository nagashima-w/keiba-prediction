#!/usr/bin/env python3
"""#689(2回目): 1 番人気を、単勝オッズの小帯ごとに「条件に当たらない 1 番人気」と比べ、
3着内・勝ちの実際/期待・z・回収率を出す。BASHIRA の get_stats の応答(scratchpad の JSON)を読む。
標準ライブラリだけで動く。

使い方:
  analyze.py explore <raw_dir> <out_dir>                     探索。explore-results.json と candidates.json
  analyze.py confirm <raw_dir> <candidates.json> <out_dir>   確認。候補だけを片側・Holm で判定

raw_dir には {小帯}__{呼び出し id}.json(列 dims + starts,wins,top3,win_return,place_return,avg_odds)を置く。
呼び出しの仕様は calls.json。期待値の作り方・検定は plan.md §4〜§5。
"""
from __future__ import annotations

import json
import math
import os
import sys

BANDS = ["b1", "b2", "b3", "b4"]
GROUPS = {"all": BANDS, "1倍台": ["b1", "b2"], "2倍台": ["b3"], "3倍以上": ["b4"]}
MIN_N = 200
BH_Q = 0.05
HOLM_ALPHA = 0.05
TAIL = ["starts", "wins", "top3", "win_return", "place_return", "avg_odds"]
KEYS = ["starts", "wins", "top3", "win_return", "place_return", "odds_sum"]


def norm_sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def bh(pvals):
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    q = [0.0] * m
    prev = 1.0
    for rank_from_top, i in enumerate(reversed(order)):
        prev = min(prev, pvals[i] * m / (m - rank_from_top))
        q[i] = prev
    return q


def holm(pvals):
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    adj = [0.0] * m
    run = 0.0
    for j, i in enumerate(order):
        run = max(run, pvals[i] * (m - j))
        adj[i] = min(1.0, run)
    return adj


def truthy(v) -> bool:
    return v is True or v == 1 or v == "true" or v == "True"


def foreign(r) -> bool:
    v = r.get("jockey_foreigner")
    return v is not None and v != "日本人"


# 条件 id → (ラベル, 側, 呼び出し id, 行の述語)。側: 敗因 / 人気 / レース
ALLROWS = lambda r: True
CONDS = {
    "K01": ("休み明け(前走から 181 日以上)", "敗因", "DAYS_LONG", ALLROWS),
    "K02": ("間隔が詰まっている(前走から 21 日以内)", "敗因", "DAYS_SHORT", ALLROWS),
    "K03": ("芝ダ替わり(芝→ダートまたはダート→芝)", "敗因", "D1",
            lambda r: (r.get("prev_surface") == "芝" and r.get("surface") == "ダート")
            or (r.get("prev_surface") == "ダート" and r.get("surface") == "芝")),
    "K04": ("距離延長 400m 以上", "敗因", "DIST_UP", ALLROWS),
    "K05": ("外枠(枠番 7 以上)", "敗因", "D2", lambda r: (r.get("bracket_number") or 0) >= 7),
    "K06": ("馬体重が前走から 10kg 以上減", "敗因", "WT_DOWN", ALLROWS),
    "K07": ("出遅れ癖の近似(過去 5 走で 14 頭以上の 1 コーナー 10 番手以下が 2 回以上)", "敗因", "SLOW", ALLROWS),
    "K08": ("前走で先行(前走の 3 コーナー 2 番手以内)", "人気", "FRONT", ALLROWS),
    "K09": ("前走 4 着以下", "敗因", "PREV4", ALLROWS),
    "K10": ("前走 1 着", "人気", "PREV1", ALLROWS),
    "K11": ("前走 2〜3 着", "人気", "PREV23", ALLROWS),
    "K12": ("キャリアが浅い(通算 2 走以内)", "敗因", "CAR2", ALLROWS),
    "K13": ("2歳戦", "レース", "D2", lambda r: r.get("race_type") == "2歳"),
    "K14": ("乗り替わり", "レース", "D5", lambda r: truthy(r.get("is_jockey_change"))),
    "K15": ("ハンデ戦", "レース", "D3", lambda r: r.get("weight_type") == "ハンデ"),
    "K16": ("重・不良", "レース", "D3", lambda r: r.get("track_condition") in ("重", "不良")),
    "K17": ("小倉・福島", "レース", "D4", lambda r: r.get("race_track") in ("小倉", "福島")),
    "K18": ("牝馬", "レース", "D4", lambda r: r.get("horse_sex") == "牝馬"),
    "K19": ("16 頭以上", "レース", "H16", ALLROWS),
    "K20": ("外国人騎手(人気の騎手の近似)", "人気", "D5", foreign),
    "K21": ("乗り替わりで外国人騎手に", "人気", "D5", lambda r: truthy(r.get("is_jockey_change")) and foreign(r)),
}


def zero():
    return {k: 0.0 for k in KEYS}


def load(raw_dir: str) -> dict:
    """{(band, call_id): [行の辞書...]}。行の辞書は dims の値と KEYS。"""
    out = {}
    for name in sorted(os.listdir(raw_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(raw_dir, name), encoding="utf-8") as f:
            d = json.load(f)
        cols = d["columns"]
        dims = cols[:-len(TAIL)]
        if cols[len(dims):] != TAIL:
            raise SystemExit(f"{name}: 列の並びが想定と違う: {cols}")
        rows = []
        for row in d.get("rows") or []:
            r = {c: v for c, v in zip(dims, row[:len(dims)])}
            starts, wins, top3, wr, pr, ao = row[len(dims):]
            r.update({"starts": starts or 0, "wins": wins or 0, "top3": top3 or 0,
                      "win_return": wr or 0, "place_return": pr or 0, "odds_sum": (ao or 0.0) * (starts or 0)})
            rows.append(r)
        out[(d["band"], d["call"])] = rows
    return out


def sum_rows(rows, pred) -> dict:
    t = zero()
    for r in rows:
        if pred(r):
            for k in KEYS:
                t[k] += r[k]
    return t


def band_counts(data, band, cid):
    """(条件に当たる走, 条件に当たらない走)。無ければ None。"""
    base_rows = data.get((band, "B"))
    cond_rows = data.get((band, CONDS[cid][2]))
    if base_rows is None or cond_rows is None:
        return None
    base = sum_rows(base_rows, ALLROWS)
    cond = sum_rows(cond_rows, CONDS[cid][3])
    rest = {k: base[k] - cond[k] for k in KEYS}
    if rest["starts"] < 0:
        raise SystemExit(f"{band} {cid}: 条件が基準の部分集合でない")
    return cond, rest


def evaluate(data, cid, bands) -> dict:
    """小帯 bands を層にして、条件 vs 条件に当たらない 1 番人気を比べる(2 群の比較の分散。#682 と同じ)。"""
    n = 0
    obs = {"win": 0, "top3": 0}
    exp = {"win": 0.0, "top3": 0.0}
    var = {"win": 0.0, "top3": 0.0}
    cwr = cpr = rwr = rpr = 0.0
    codds = 0.0
    rn = 0
    skipped = []
    for b in bands:
        got = band_counts(data, b, cid)
        if got is None:
            skipped.append(b)
            continue
        c, r = got
        if c["starts"] == 0:
            continue
        if r["starts"] == 0:
            skipped.append(b)
            continue
        nc, m = c["starts"], r["starts"]
        n += nc
        rn += m
        cwr += c["win_return"]; cpr += c["place_return"]; codds += c["odds_sum"]
        rwr += r["win_return"]; rpr += r["place_return"]
        for key, field in (("win", "wins"), ("top3", "top3")):
            p_rest = r[field] / m
            p_pool = (c[field] + r[field]) / (nc + m)
            obs[key] += c[field]
            exp[key] += nc * p_rest
            var[key] += nc * p_pool * (1 - p_pool) * (1 + nc / m)
    row = {"n": int(n), "rest_n": int(rn), "skipped_bands": skipped,
           "win_roi": round(cwr / (n * 100), 3) if n else None,
           "place_roi": round(cpr / (n * 100), 3) if n else None,
           "rest_place_roi": round(rpr / (rn * 100), 3) if rn else None,
           "avg_odds": round(codds / n, 2) if n else None}
    for key in ("win", "top3"):
        z = (obs[key] - exp[key]) / math.sqrt(var[key]) if var[key] > 0 else 0.0
        row[key] = {"obs": int(obs[key]), "exp": round(exp[key], 1),
                    "ratio": round(obs[key] / exp[key], 3) if exp[key] > 0 else None,
                    "rate": round(obs[key] / n, 4) if n else None,
                    "z": round(z, 2), "p_two_sided": 2 * norm_sf(abs(z)) if var[key] > 0 else 1.0}
    return row


def base_summary(data) -> dict:
    out = {}
    for b in BANDS:
        rows = data.get((b, "B"))
        if rows is None:
            continue
        t = sum_rows(rows, ALLROWS)
        n = t["starts"]
        out[b] = {"n": int(n), "win_rate": round(t["wins"] / n, 4) if n else None,
                  "top3_rate": round(t["top3"] / n, 4) if n else None,
                  "win_roi": round(t["win_return"] / (n * 100), 3) if n else None,
                  "place_roi": round(t["place_return"] / (n * 100), 3) if n else None}
    return out


def full_table(data) -> list[dict]:
    table = []
    for cid, (label, side, _, _) in CONDS.items():
        for g, bands in GROUPS.items():
            table.append({"id": cid, "label": label, "side": side, "group": g, **evaluate(data, cid, bands)})
    return table


def dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def print_table(table):
    print("id\tgroup\tn\ttop3 率\ttop3 実/期\ttop3 z\twin 実/期\twin z\t複勝回収\t(他)複勝回収\t単勝回収")
    for r in table:
        print(f"{r['id']}\t{r['group']}\t{r['n']}\t{r['top3']['rate']}\t{r['top3']['ratio']}\t{r['top3']['z']}\t"
              f"{r['win']['ratio']}\t{r['win']['z']}\t{r['place_roi']}\t{r['rest_place_roi']}\t{r['win_roi']}")


def cmd_explore(raw_dir, out_dir):
    data = load(raw_dir)
    table = full_table(data)
    allrows = [r for r in table if r["group"] == "all"]
    tests = [(r, k) for r in allrows if r["n"] >= MIN_N for k in ("top3", "win")]
    q = bh([r[k]["p_two_sided"] for r, k in tests])
    cands = []
    for (r, k), qv in zip(tests, q):
        r[k]["q_bh"] = round(qv, 6)
        if qv < BH_Q:
            cands.append({"id": r["id"], "label": r["label"], "side": r["side"], "outcome": k,
                          "direction": "over" if r[k]["z"] > 0 else "under",
                          "explore": {"n": r["n"], "obs": r[k]["obs"], "exp": r[k]["exp"], "ratio": r[k]["ratio"],
                                      "z": r[k]["z"], "q_bh": round(qv, 6)}})
    untested = [r["id"] for r in allrows if r["n"] < MIN_N]
    os.makedirs(out_dir, exist_ok=True)
    dump(os.path.join(out_dir, "explore-results.json"),
         {"min_n": MIN_N, "tests": len(tests), "untested_n_lt_min": untested, "base": base_summary(data), "rows": table})
    dump(os.path.join(out_dir, "candidates.json"),
         {"criteria": {"min_n": MIN_N, "bh_q": BH_Q, "tests": len(tests)}, "candidates": cands})
    print(f"検定 {len(tests)} 件、候補 {len(cands)} 件、n<{MIN_N} で検定外 {untested}")
    print_table(table)
    print("基準", json.dumps(base_summary(data), ensure_ascii=False))
    for c in cands:
        print("候補", json.dumps(c, ensure_ascii=False))


def cmd_confirm(raw_dir, cand_path, out_dir):
    data = load(raw_dir)
    with open(cand_path, encoding="utf-8") as f:
        cands = json.load(f)["candidates"]
    table = full_table(data)
    idx = {(r["id"], r["group"]): r for r in table}
    items, pvals = [], []
    for c in cands:
        r = idx[(c["id"], "all")]
        s = r[c["outcome"]]
        same = (s["z"] > 0) == (c["direction"] == "over")
        p1 = norm_sf(abs(s["z"])) if same else 1.0 - norm_sf(abs(s["z"]))
        items.append({**c, "confirm": {"n": r["n"], "obs": s["obs"], "exp": s["exp"], "ratio": s["ratio"], "z": s["z"],
                                       "same_direction": same, "p_one_sided": p1, "place_roi": r["place_roi"],
                                       "rest_place_roi": r["rest_place_roi"], "win_roi": r["win_roi"]}})
        pvals.append(p1)
    adj = holm(pvals)
    for it, a in zip(items, adj):
        it["confirm"]["p_holm"] = round(a, 6)
        it["confirm"]["remained"] = bool(it["confirm"]["n"] >= MIN_N and it["confirm"]["same_direction"] and a < HOLM_ALPHA)
    os.makedirs(out_dir, exist_ok=True)
    dump(os.path.join(out_dir, "confirm-results.json"),
         {"min_n": MIN_N, "holm_alpha": HOLM_ALPHA, "k": len(cands), "judged": items, "base": base_summary(data), "rows": table})
    for it in items:
        c = it["confirm"]
        print(f"{'残' if c['remained'] else '　'} {it['id']} {it['label']} {it['outcome']} {it['direction']}: n={c['n']} "
              f"実/期={c['ratio']} z={c['z']} 片側p={c['p_one_sided']:.2e} Holm p={c['p_holm']} 複勝回収{c['place_roi']}(他{c['rest_place_roi']})")
    print_table([r for r in table if r["id"] in {i["id"] for i in items}])
    print("基準", json.dumps(base_summary(data), ensure_ascii=False))


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == "explore":
        cmd_explore(a[1], a[2])
    elif len(a) == 4 and a[0] == "confirm":
        cmd_confirm(a[1], a[2], a[3])
    else:
        print(__doc__)
        sys.exit(2)
