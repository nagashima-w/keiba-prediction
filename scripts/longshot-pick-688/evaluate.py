"""#688: 「レースの中で候補馬から点の最大の 1 頭(上位 2 頭)を選ぶ」評価。点を引数で受け取る(#681 でも使える)。

入力: races = features.build の戻り(race dict: raceId, date, hcp, cands[{umaban, band, q, p3, y, ...}], info)。
      scores = {(raceId, umaban): 点}。点が大きいほど選ぶ。同点は馬番の小さい方。
"""
from __future__ import annotations

import math
import random


def ncdf(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def p_one_sided(z):
    return 1.0 - ncdf(z)


def holm(pvals, alpha=0.05):
    """Holm 補正。pvals: {name: p}。戻り: {name: (補正後 p, 棄却か)}。"""
    names = sorted(pvals, key=lambda k: pvals[k])
    m = len(names)
    out, run = {}, 0.0
    for i, k in enumerate(names):
        adj = min(1.0, (m - i) * pvals[k])
        run = max(run, adj)
        out[k] = (run, run < alpha)
    return out


def _arr(race):
    cs = race["cands"]
    return {
        "u": [x["umaban"] for x in cs], "p": [x["p3"] for x in cs], "y": [x["y"] for x in cs], "q": [x["q"] for x in cs],
        "a": list(range(len(cs))),
        "b": [i for i, x in enumerate(cs) if x["band"] == "6-9"], "t": [i for i, x in enumerate(cs) if x["band"] == "10+"],
    }


def prepare(races):
    return [(r, _arr(r)) for r in races]


def _top(idx, key, u, k):
    return sorted(idx, key=lambda i: (-key[i], u[i]))[:k]


def picks_for(a, s, pool, k):
    idx = a[{"all": "a", "6-9": "b", "10+": "t"}[pool]]
    return _top(idx, s, a["u"], k) if idx else []


def base_for(a, pool):
    idx = a[{"all": "a", "6-9": "b", "10+": "t"}[pool]]
    return _top(idx, a["q"], a["u"], 1) if idx else []


def oe_from(sel):
    """sel: [(y, p3)] → O/E の統計。"""
    n = len(sel)
    if n == 0:
        return {"n": 0, "O": 0, "E": 0.0, "oe": None, "z": None}
    O = sum(y for y, _ in sel)
    E = sum(p for _, p in sel)
    V = sum(p * (1 - p) for _, p in sel)
    return {"n": n, "O": O, "E": round(E, 3), "oe": O / E if E else None, "z": (O - E) / math.sqrt(V) if V > 0 else None}


def cells(pr, scores_by_race):
    """5 セル + 記述の元になる集計。pr = prepare(races)。scores_by_race: 各レースの候補と同じ並びの点のリストのリスト。"""
    c1, c2, c3 = [], [], []
    d4 = []
    t2n = t2E = t2O = 0
    diffs = []
    for (race, a), s in zip(pr, scores_by_race):
        p1 = picks_for(a, s, "all", 1)
        if p1:
            i = p1[0]
            c1.append((a["y"][i], a["p"][i]))
            b = base_for(a, "all")[0]
            if b != i:
                diffs.append(a["y"][i] - a["y"][b])
        p2 = picks_for(a, s, "6-9", 1)
        if p2:
            c2.append((a["y"][p2[0]], a["p"][p2[0]]))
        p3_ = picks_for(a, s, "10+", 1)
        if p3_:
            c3.append((a["y"][p3_[0]], a["p"][p3_[0]]))
        t2 = picks_for(a, s, "all", 2)
        if t2:
            d4.append(sum(a["y"][i] - a["p"][i] for i in t2))
            t2n += len(t2)
            t2O += sum(a["y"][i] for i in t2)
            t2E += sum(a["p"][i] for i in t2)
    out = {"c1": oe_from(c1), "c2": oe_from(c2), "c3": oe_from(c3)}
    n4 = len(d4)
    sq = sum(d * d for d in d4)
    out["c4"] = {"n_races": n4, "n": t2n, "O": t2O, "E": round(t2E, 3), "oe": t2O / t2E if t2E else None,
                 "z": (sum(d4) / math.sqrt(sq)) if sq > 0 else None}
    nd = len(diffs)
    if nd >= 1:
        m = sum(diffs) / nd
        v = sum((d - m) ** 2 for d in diffs) / (nd - 1) if nd > 1 else 0.0
        out["c5"] = {"n": nd, "mean_diff": m, "z": m / math.sqrt(v / nd) if v > 0 else None}
    else:
        out["c5"] = {"n": nd, "mean_diff": None, "z": None}
    return out


def baseline_cells(pr):
    """基準(q が最大の 1 頭)の O/E。all・6-9・10+ の別。"""
    out = {}
    for pool in ("all", "10+"):
        sel = []
        for race, a in pr:
            b = base_for(a, pool)
            if b:
                sel.append((a["y"][b[0]], a["p"][b[0]]))
        out[pool] = oe_from(sel)
    out["6-9"] = out["all"]
    return out


def scores_list(pr, scores):
    return [[scores[(race["raceId"], x["umaban"])] for x in race["cands"]] for race, _ in pr]


def roi(pr, scores_by_race, pool="all", baseline=False):
    """選んだ 1 頭(または基準の 1 頭)の複勝と、1・2 番人気とのワイド 2 点の回収率(100 円あたり)。"""
    place_stake = place_ret = wide_stake = wide_ret = 0
    n = 0
    for (race, a), s in zip(pr, scores_by_race):
        pk = base_for(a, pool) if baseline else picks_for(a, s, pool, 1)
        if not pk:
            continue
        u = a["u"][pk[0]]
        info = race["info"]
        n += 1
        place_stake += 100
        place_ret += info["place"].get(u, 0)
        for f in info["fav"]:
            wide_stake += 100
            wide_ret += info["wide"].get(frozenset((u, f)), 0)
    return {"n": n, "place_roi": place_ret / place_stake if place_stake else None,
            "wide_roi": wide_ret / wide_stake if wide_stake else None, "wide_tickets": wide_stake // 100}


def shuffle_null(pr, n_rep, seed):
    """レース内で点をシャッフルして選び直し、5 セルの z の最大(片側の最大 z)の帰無を作る。"""
    rng = random.Random(seed)
    maxz = []
    for _ in range(n_rep):
        sbr = [[rng.random() for _ in a["u"]] for _, a in pr]
        cs = cells(pr, sbr)
        zs = [cs[k]["z"] for k in ("c1", "c2", "c3", "c4", "c5") if cs[k]["z"] is not None]
        maxz.append(max(zs))
    return maxz
