"""#689: 「危ない側の 1 番人気」の集計。点(p̂)を引数で受け取る。
O/E < 1 の片側(z が負の側)を見る。p は ncdf(z)。
"""
from __future__ import annotations

import itertools
import math
import random

import common689 as K689
import evaluate as V688  # #688(holm・ncdf)

holm = V688.holm
ncdf = V688.ncdf


def p_lower(z):
    """O/E < 1 の片側 p。"""
    return ncdf(z)


def oe(sel, key):
    """sel: [fav]。key = 'y'(3着内。E は p3)または 'w'(勝ち。E は q)。"""
    n = len(sel)
    if n == 0:
        return {"n": 0, "O": 0, "E": 0.0, "oe": None, "z": None}
    pk = "p3" if key == "y" else "q"
    O = sum(x[key] for x in sel)
    E = sum(x[pk] for x in sel)
    Vr = sum(x[pk] * (1 - x[pk]) for x in sel)
    return {"n": n, "O": O, "E": round(E, 3), "oe": O / E if E else None, "z": (O - E) / math.sqrt(Vr) if Vr > 0 else None}


def four_cells(sel):
    """sel = 危ない側の対象馬。family の 4 セル。"""
    return {
        "c1": oe(sel, "y"),
        "c2": oe([x for x in sel if x["band"] == "1.0-1.9"], "y"),
        "c3": oe([x for x in sel if x["band"] == "2.0-2.9"], "y"),
        "c4": oe(sel, "w"),
    }


def verdict(cells):
    pv = {k: p_lower(cells[k]["z"]) for k in cells if cells[k]["z"] is not None}
    hol = holm(pv, K689.HOLM_ALPHA)
    out = {}
    for k in cells:
        n = cells[k]["n"]
        out[k] = {"n": n, "z": cells[k]["z"], "p_one": pv.get(k), "p_holm": hol[k][0] if k in hol else None,
                  "survived": bool(k in hol and hol[k][1] and n >= K689.MIN_N),
                  "n_short": n < K689.MIN_N}
    return out


def box_roi(races_sel, box_key, kind):
    """races_sel: 選んだレース。box_key: 'box_2_6'(3 連複 C(k,3) 点)か 'box_2_4'(ワイド C(k,2) 点)。kind: 'trio'|'wide'。
    戻り: 点数・賭け金・払戻・回収率・的中レース数。"""
    r = 3 if kind == "trio" else 2
    stake = ret = hit = n = 0
    for race in races_sel:
        info = race["info"]
        combos = list(itertools.combinations(info[box_key], r))
        n += 1
        stake += 100 * len(combos)
        got = sum(info[kind].get(frozenset(cb), 0) for cb in combos)
        ret += got
        hit += 1 if got else 0
    return {"races": n, "tickets": stake // 100, "roi": ret / stake if stake else None, "hit_races": hit}


def roi_all(races_sel):
    return {"trio_2_6": box_roi(races_sel, "box_2_6", "trio"), "wide_2_4": box_roi(races_sel, "box_2_4", "wide")}


def shuffle_null(races, phat, t, n_rep, seed):
    """対象馬の間で p̂ を並べ替え、同じ t で危ない側を選び直し、4 セルの max(−z) の帰無を作る。"""
    rng = random.Random(seed)
    favs = [r["fav"] for r in races]
    ph = list(phat)
    mx = []
    for _ in range(n_rep):
        rng.shuffle(ph)
        sel = [f for f, p in zip(favs, ph) if p < t]
        cs = four_cells(sel)
        zs = [-cs[k]["z"] for k in cs if cs[k]["z"] is not None]
        mx.append(max(zs))
    return mx
