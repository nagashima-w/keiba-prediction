#!/usr/bin/env python3
"""#682: BASHIRA の get_stats の応答(scratchpad に保存した JSON)から、「1 番人気が 4 着以下」(主 A)の
水準別の実測/期待・z・BH/Holm を計算する。標準ライブラリだけで動く。

使い方:
  explore <raw_dir> <out_dir>                   探索の期間。候補を out_dir/candidates.json に書く
  confirm <raw_dir> <candidates.json> <out_dir> 確認の期間。固定した候補に Holm を当てる
  roi-explore <raw_dir> <out.json> / roi-confirm <raw_dir> <out.json>  人気薄の回収率・S1・S2(confirm は Holm 付き)

raw_dir の 1 ファイル = 1 呼び出し。{"id","label","columns":["race_condition",(X,)"starts","top3"],"rows"}。
ALL は全 1 番人気(クラス別)。X15*(1 番人気のオッズの帯)と X16*(頭数の帯)は帯ごとに 1 ファイル。
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

DIST_BINS = [("<=1400", 0, 1400), ("1500-1800", 1500, 1800), ("1900-2200", 1900, 2200), (">=2300", 2300, 99999)]
AGE_BINS = [("2", 2, 2), ("3", 3, 3), ("4", 4, 4), ("5", 5, 5), ("6+", 6, 99)]


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


def by_class(d: dict) -> dict[str, tuple[int, int]]:
    """クラスだけの集計 → {クラス: (レース数, 3着内)}"""
    return {r[0]: (r[1], r[2]) for r in d["rows"]}


def level_cells(d: dict, binner=None) -> dict[str, dict[str, tuple[int, int]]]:
    """クラス × 材料の集計 → {水準: {クラス: (レース数, 3着内)}}。binner で水準を束ねる/捨てる。"""
    levels: dict[str, dict[str, list[int]]] = {}
    for klass, x, n, top3 in d["rows"]:
        lv = binner(x) if binner else str(x)
        if lv is None:
            continue
        cell = levels.setdefault(lv, {}).setdefault(klass, [0, 0])
        cell[0] += n
        cell[1] += top3
    return {lv: {k: (v[0], v[1]) for k, v in cs.items()} for lv, cs in levels.items()}


def bin_by(bins):
    def f(x):
        for name, lo, hi in bins:
            if lo <= x <= hi:
                return name
        return None
    return f


def age_binner(x):
    return bin_by(AGE_BINS)(x)


def jockey_binner(x):
    return None if x is None else ("乗り替わり" if x else "継続騎乗")


def grade_binner(x):
    return {"平場": "平場", "G1": "G1", "G2": "G2", "G3": "G3", "L": "L", "その他重賞": "その他重賞"}.get(x)


def dist_binner(x):
    return bin_by(DIST_BINS)(x)


SPEC = [  # (id, 表示名, binner)  dimension で水準を持つ材料
    ("X01", "芝ダ", None), ("X02", "距離", dist_binner), ("X03", "馬場状態", None), ("X04", "天候", None),
    ("X05", "開催月", None), ("X06", "競馬場", None), ("X07", "重量種別", None), ("X08", "競走種別", None),
    ("X09", "曜日", None), ("X10", "格付け", grade_binner), ("X11", "柵", None), ("X12", "1番人気の馬齢", age_binner),
    ("X13", "1番人気の性別", None), ("X14", "1番人気の乗り替わり", jockey_binner),
]
BAND_SPEC = [  # 帯ごとに 1 ファイル。(材料, 表示名, [(ファイル id の接尾, 水準名)])
    ("X15", "1番人気の単勝オッズ", [("a", "<=1.9"), ("b", "2.0-2.9"), ("c", "3.0-3.9"), ("d", "4.0-5.9"), ("e", ">=6.0")]),
    ("X16", "頭数(出走予定)", [("a", "<=9"), ("b", "10-12"), ("c", "13-15"), ("d", ">=16")]),
]
# 事前登録からの変更(探索の集計を引く途中で分かったこと。計画 §9 に記録): 1 番人気が 6.0 倍以上のレースは
# 探索で 2 件しかなかったので、4.0-5.9 と束ねて「>=4.0」にする。重賞は G1〜その他重賞を束ねた水準も作る。
MERGES = {"X15": [(">=4.0", ["4.0-5.9", ">=6.0"])], "X10": [("重賞(G1-その他)", ["G1", "G2", "G3", "L", "その他重賞"])]}
DROP = {"X15": ["4.0-5.9", ">=6.0"]}  # 束ねたあとは元の水準は検定に使わない


def merge_cells(a: dict, b: dict) -> dict:
    out = {k: v for k, v in a.items()}
    for k, v in b.items():
        out[k] = (out[k][0] + v[0], out[k][1] + v[1]) if k in out else v
    return out


def evaluate(level: dict[str, tuple[int, int]], allc: dict[str, tuple[int, int]]) -> dict:
    """水準 level(クラス別の (n, top3))を、全体 allc から水準を引いた残りと比べる。失敗 = 4 着以下。"""
    n = o = 0
    e = var = 0.0
    for klass, (n1, t1) in level.items():
        na, ta = allc.get(klass, (0, 0))
        m, t2 = na - n1, ta - t1
        if m <= 0 or n1 <= 0:
            continue  # 残りが無い層は落とす
        f1, f2 = n1 - t1, m - t2
        p2 = f2 / m
        ph = (f1 + f2) / (n1 + m)
        n += n1
        o += f1
        e += n1 * p2
        var += n1 * ph * (1 - ph) * (1 + n1 / m)
    z = (o - e) / math.sqrt(var) if var > 0 else 0.0
    return {"n": n, "obs": o, "exp": round(e, 1), "fail_rate": round(o / n, 4) if n else None,
            "exp_rate": round(e / n, 4) if n else None, "ratio": round(o / e, 3) if e > 0 else None,
            "z": round(z, 2), "p_two_sided": 2 * norm_sf(abs(z)) if var > 0 else 1.0}


def all_levels(raw: dict[str, dict]) -> list[dict]:
    allc = by_class(raw["ALL"])
    rows = []
    for xid, label, binner in SPEC:
        if xid not in raw:
            continue  # 確認の期間は候補になった材料だけ引く
        cells = level_cells(raw[xid], binner)
        for g, parts in MERGES.get(xid, []):
            merged: dict = {}
            for p in parts:
                if p in cells:
                    merged = merge_cells(merged, cells[p])
            cells[g] = merged
        for lv in sorted(cells):
            rows.append({"x": xid, "x_label": label, "level": lv, **evaluate(cells[lv], allc)})
    for xid, label, bands in BAND_SPEC:
        cells = {name: by_class(raw[f"{xid}{suf}"]) for suf, name in bands if f"{xid}{suf}" in raw}
        for g, parts in MERGES.get(xid, []):
            merged = {}
            for p in parts:
                if p in cells:
                    merged = merge_cells(merged, cells[p])
            cells[g] = merged
        for lv in cells:
            if lv in DROP.get(xid, []):
                continue
            rows.append({"x": xid, "x_label": label, "level": lv, **evaluate(cells[lv], allc)})
    return rows


def control_rows(raw: dict[str, dict]) -> list[dict]:
    allc = by_class(raw["ALL"])
    cells = level_cells(raw["C01"])
    return [{"x": "C01", "x_label": "対照: 1番人気の毛色", "level": lv, **evaluate(cells[lv], allc)}
            for lv in ("芦毛", "栗毛") if lv in cells]


def benjamini_hochberg(p: list[float]) -> list[float]:
    m = len(p)
    order = sorted(range(m), key=lambda i: p[i])
    q = [0.0] * m
    prev = 1.0
    for rank_from_top, i in enumerate(reversed(order)):
        prev = min(prev, p[i] * m / (m - rank_from_top))
        q[i] = prev
    return q


def holm(p: list[float]) -> list[float]:
    m = len(p)
    order = sorted(range(m), key=lambda i: p[i])
    adj = [0.0] * m
    run = 0.0
    for j, i in enumerate(order):
        run = max(run, p[i] * (m - j))
        adj[i] = min(1.0, run)
    return adj


def fmt(r: dict) -> str:
    return (f"{r['x']} {r['x_label']} {r['level']}: n={r['n']} 4着以下率 {r['fail_rate']} (期待 {r['exp_rate']}) "
            f"実/期 {r['ratio']} z={r['z']}" + (f" q={r['q_bh']:.4g}" if 'q_bh' in r else ""))


def cmd_explore(raw_dir: str, out_dir: str) -> None:
    raw = load_raw(raw_dir)
    rows = all_levels(raw)
    tested = [r for r in rows if r["n"] >= MIN_N]
    q = benjamini_hochberg([r["p_two_sided"] for r in tested])
    for r, qq in zip(tested, q):
        r["q_bh"] = qq
    cands = [r for r in tested if abs(r["z"]) >= Z_MIN and r["q_bh"] < BH_Q]
    ctrl = control_rows(raw)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "explore-results.json"), "w", encoding="utf-8") as f:
        json.dump({"tests": len(tested), "rows": rows, "control": ctrl}, f, ensure_ascii=False, indent=1)
    out = [{"x": r["x"], "x_label": r["x_label"], "level": r["level"],
            "direction": "over" if r["z"] > 0 else "under",
            "explore": {k: r[k] for k in ("n", "obs", "exp", "fail_rate", "exp_rate", "ratio", "z", "q_bh")}}
           for r in cands]
    with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump({"criteria": {"min_n": MIN_N, "z_min": Z_MIN, "bh_q": BH_Q, "tests": len(tested)},
                   "candidates": out}, f, ensure_ascii=False, indent=1)
    print(f"検定 {len(tested)} 件(n<{MIN_N} で除外 {len(rows) - len(tested)} 件)、候補 {len(cands)} 件")
    for r in rows:
        print(("* " if r in cands else "  ") + fmt(r))
    print("対照:")
    for r in ctrl:
        print("  " + fmt(r))


def cmd_confirm(raw_dir: str, cand_path: str, out_dir: str) -> None:
    raw = load_raw(raw_dir)
    rows = all_levels(raw)
    index = {(r["x"], r["level"]): r for r in rows}
    with open(cand_path, encoding="utf-8") as f:
        cands = json.load(f)["candidates"]
    pv = []
    for c in cands:
        r = index.get((c["x"], c["level"]))
        if r is None:
            raise SystemExit(f"確認の集計が無い: {c['x']} {c['level']}")
        same = (r["z"] > 0) == (c["direction"] == "over")
        p1 = norm_sf(abs(r["z"])) if same else 1.0 - norm_sf(abs(r["z"]))
        c["confirm"] = {k: r[k] for k in ("n", "obs", "exp", "fail_rate", "exp_rate", "ratio", "z")}
        c["confirm"].update({"same_direction": same, "p_one_sided": p1})
        pv.append(p1)
    for c, a in zip(cands, holm(pv)):
        c["confirm"]["p_holm"] = round(a, 6)
        c["survived"] = bool(c["confirm"]["n"] >= MIN_N and c["confirm"]["same_direction"] and a < HOLM_ALPHA)
    ctrl = control_rows(raw)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8") as f:
        json.dump({"holm_alpha": HOLM_ALPHA, "k": len(cands), "candidates": cands, "rows": rows, "control": ctrl},
                  f, ensure_ascii=False, indent=1)
    print(f"候補 {len(cands)} 件、残った {sum(c['survived'] for c in cands)} 件")
    for c in cands:
        e, k = c["explore"], c["confirm"]
        print(f"{'残' if c['survived'] else '　'} {c['x']} {c['x_label']} {c['level']} {c['direction']}: "
              f"探索 n={e['n']} 実/期={e['ratio']} z={e['z']} | 確認 n={k['n']} 実/期={k['ratio']} z={k['z']} Holm p={k['p_holm']}")
    print("対照:")
    for r in ctrl:
        print("  " + fmt(r))


# ---- 回収率・副指標(S1/S2)。人気順別の集計(R_*)を読む ----
ROI_LEVELS = [("R_D1400", "距離1400m以下"), ("R_KOKURA", "小倉"), ("R_FUKUSHIMA", "福島"),
              ("R_HANDI", "ハンデ戦"), ("R_AGE3", "3歳限定戦"), ("R_N16", "頭数16以上")]
RBANDS = [("4-9", 4, 9), ("10+", 10, 99)]


def rank_cells(d: dict) -> dict[int, dict]:
    return {int(r[0]): dict(zip(d["columns"], r)) for r in d["rows"] if r[0] is not None and r[1]}


def roi_eval(level: dict[int, dict], allr: dict[int, dict]) -> dict:
    races = level[1]["starts"]
    races_rest = allr[1]["starts"] - races
    out = {"races": races}
    # S1: 勝ち馬が 6 番人気以下、S2: 1〜3 番人気の 3着内頭数 / レース
    def share(cells, races_n, fn):
        return sum(fn(r, c) for r, c in cells.items()) / races_n
    rest = {r: {k: allr[r][k] - level[r][k] for k in ("starts", "wins", "top3", "win_return", "place_return")}
            for r in level if r in allr}
    s1 = share(level, races, lambda r, c: c["wins"] if r >= 6 else 0)
    s1r = share(rest, races_rest, lambda r, c: c["wins"] if r >= 6 else 0)
    ph = (s1 * races + s1r * races_rest) / (races + races_rest)
    z1 = (s1 - s1r) / math.sqrt(ph * (1 - ph) * (1 / races + 1 / races_rest)) if 0 < ph < 1 else 0.0
    out["S1"] = {"level": round(s1, 4), "rest": round(s1r, 4), "z": round(z1, 2)}
    out["S2"] = {"level": round(share(level, races, lambda r, c: c["top3"] if r <= 3 else 0), 3),
                 "rest": round(share(rest, races_rest, lambda r, c: c["top3"] if r <= 3 else 0), 3)}
    f = races - level[1]["top3"]
    fr = races_rest - rest[1]["top3"]
    out["fav_fail"] = {"level": round(f / races, 4), "rest": round(fr / races_rest, 4)}
    for bname, lo, hi in RBANDS:
        for bet, ret, sd in (("win", "win_return", "sd_win"), ("place", "place_return", "sd_place")):
            n = o = 0
            e = var = 0.0
            rest_ret = 0
            rest_n = 0
            for r in sorted(level):
                if not lo <= r <= hi or r not in rest or rest[r]["starts"] <= 0:
                    continue
                c, q = level[r], rest[r]
                n += c["starts"]
                o += c[ret]
                e += c["starts"] * q[ret] / q["starts"]
                rest_ret += q[ret]
                rest_n += q["starts"]
                var += c["starts"] * (c[sd] or 0) ** 2 + c["starts"] ** 2 * (allr[r][sd] or 0) ** 2 / q["starts"]
            z = (o - e) / math.sqrt(var) if var > 0 else 0.0
            out[f"{bname}_{bet}"] = {"n": n, "roi": round(o / (100 * n), 3), "rest_roi": round(rest_ret / (100 * rest_n), 3),
                                     "exp_roi_same_rank": round(e / (100 * n), 3), "diff_pt": round((o - e) / n, 1),
                                     "z": round(z, 2), "p_one_sided_high": norm_sf(z)}
    return out


def cmd_roi(raw_dir: str, out_path: str, holm_on: bool, only: list[str] | None = None) -> None:
    raw = load_raw(raw_dir)
    allr = rank_cells(raw["R_ALL"])
    res = {}
    for rid, label in ROI_LEVELS:
        if rid in raw and (only is None or rid in only):
            res[rid] = {"label": label, **roi_eval(rank_cells(raw[rid]), allr)}
    keys = [(rid, k) for rid in res for k in ("4-9_win", "4-9_place", "10+_win", "10+_place")]
    if holm_on:
        adj = holm([res[r][k]["p_one_sided_high"] for r, k in keys])
        for (r, k), a in zip(keys, adj):
            res[r][k]["p_holm"] = round(a, 5)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    for rid, v in res.items():
        print(f"{rid} {v['label']}: レース {v['races']} 1番人気4着以下 {v['fav_fail']['level']} (他 {v['fav_fail']['rest']}) "
              f"S1 勝ち馬6番人気以下 {v['S1']['level']} (他 {v['S1']['rest']}, z={v['S1']['z']}) S2 {v['S2']['level']} (他 {v['S2']['rest']})")
        for k in ("4-9_win", "4-9_place", "10+_win", "10+_place"):
            x = v[k]
            print(f"   {k}: n={x['n']} 回収率 {x['roi']} (他 {x['rest_roi']} / 同人気順の期待 {x['exp_roi_same_rank']}) 差 {x['diff_pt']}pt z={x['z']}"
                  + (f" Holm p={x['p_holm']}" if 'p_holm' in x else ""))


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "explore":
        cmd_explore(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 5 and sys.argv[1] == "confirm":
        cmd_confirm(sys.argv[2], sys.argv[3], sys.argv[4])
    elif len(sys.argv) >= 4 and sys.argv[1] in ("roi-explore", "roi-confirm"):
        cmd_roi(sys.argv[2], sys.argv[3], sys.argv[1] == "roi-confirm")
    else:
        print(__doc__)
        sys.exit(2)
