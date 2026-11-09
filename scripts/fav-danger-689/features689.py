"""#689: 対象馬(対象レースの 1 番人気で単勝 1.0〜2.9 倍)の材料を作る。#688 の features.build と同じ部品(4 印・騎手調教師の差・g)。
材料はそのレースより前の走だけから。結果(3着内・勝ち)は y・w に載せるが、材料の作成では使わない。
"""
from __future__ import annotations

import collections
import math

import common689 as K689
import common688 as K
import edges as E
import flags as F
import runs as R
import features as Fe688

a687, c = K.a687, K.c


def pick_favorite(horses):
    """確定の人気 1 でオッズのある馬(複数なら馬番の小さい方)。いなければ None。"""
    fav = [h for h in horses if h["ninki"] == 1 and h["odds"]]
    return min(fav, key=lambda h: h["umaban"]) if fav else None


def second_odds(horses):
    sec = [h["odds"] for h in horses if h["ninki"] == 2 and h["odds"]]
    return min(sec) if sec else None


def box_umabans(horses, lo, hi):
    return sorted(h["umaban"] for h in horses if h["ninki"] is not None and lo <= h["ninki"] <= hi)


def build(table_path, hist_paths, csv_path, prep, period):
    """period の対象レースの対象馬を作る。戻り: [race dict](対象馬のいるレースだけ。race["fav"] が対象馬)。"""
    table = {r["raceId"]: r for r in K.load_ndjson(table_path)}
    races = R.load_hist(hist_paths)
    csvr = R.load_csv_runs(csv_path)
    coef = prep["coef"]
    edge_of = E.compute_edges(races, coef)
    targets = {rid for rid, r in table.items() if K.in_period(r["date"], period) and c.exclusion_reason(r) is None}
    hist_by_horse = collections.defaultdict(dict)
    out = []
    fm, pi = prep["forecast"], prep["pi"]
    for hr in races:
        st = [h for h in hr["horses"] if h["finishStatus"] not in ("取消", "除外")]
        if hr["raceId"] in targets:
            t = table[hr["raceId"]]
            th = pick_favorite(t["horses"])
            o2 = second_odds(t["horses"])
            if th is not None and K689.band_of(th["odds"]) is not None and o2 is not None:
                qs = K.race_q(t)
                g = a687.g_of(t, fm, pi)
                tf, _tb = c.top3_comp(t)
                h = {x["horseId"]: x for x in st}[th["horseId"]]
                q = qs[th["horseId"]]
                runs = R.merged_runs(csvr.get(th["horseId"], {}), hist_by_horse.get(th["horseId"], {}))
                lr, sc, fr, sl = F.compute_flags(runs, hr["date"].replace("-", "/"), t["courseType"], q)
                no_prior = 1.0 if (lr, sc, fr, sl) == F.NO_FLAGS else 0.0
                style = th["style"]
                is_front = 1.0 if style in c.FRONT else 0.0
                is_back = 1.0 if style in c.BACK else 0.0
                je, te = edge_of[hr["raceId"]][th["horseId"]]
                payouts = hr["payouts"]
                wide, trio = {}, {}
                for key, dst in (("wide", wide), ("trio", trio)):
                    w = payouts.get(key)
                    if isinstance(w, dict):
                        for x in w.get("payouts", []):
                            dst[frozenset(x["umabans"])] = x["payout"]
                out.append({
                    "raceId": hr["raceId"], "date": hr["date"], "hcp": t["weightType"] == "ハンデ",
                    "g": g,
                    "fav": {
                        "raceId": hr["raceId"], "umaban": th["umaban"], "horseId": th["horseId"], "odds": th["odds"],
                        "band": K689.band_of(th["odds"]), "q": q, "p3": K.p3_fixed(coef, q, t["nStart"]),
                        "y": 1 if (th["finish"] is not None and th["finish"] <= 3) else 0,
                        "w": 1 if th["finish"] == 1 else 0,
                        "f": {"lq": K.logit(q), "longRest": float(lr or 0), "surf": float(sc or 0), "front": float(fr or 0),
                              "slump": float(sl or 0), "noPrior": no_prior, "hcp": 1.0 if t["weightType"] == "ハンデ" else 0.0,
                              "jedge": je, "tedge": te, "isFront": is_front, "isBack": is_back, "g": g,
                              "backTop3": 1.0 if (is_back and tf >= 2) else 0.0,
                              "turf": 1.0 if t["courseType"] == "芝" else 0.0, "logDist": math.log(t["distance"]),
                              "bigField": 1.0 if t["nStart"] >= 16 else 0.0,
                              "kokFuku": 1.0 if t["venue"] in ("小倉", "福島") else 0.0,
                              "mare": 1.0 if h["sex"] == "牝" else 0.0,
                              "oddsGap": math.log(o2) - math.log(th["odds"])},
                    },
                    "info": {"wide": wide, "trio": trio,
                             "box_2_6": box_umabans(t["horses"], 2, 6), "box_2_4": box_umabans(t["horses"], 2, 4)},
                })
        for h in st:
            hist_by_horse[h["horseId"]][hr["raceId"]] = R.hist_run(hr, h, len(st))
    return out


CONT = ("lq", "jedge", "tedge", "logDist", "oddsGap")


def column(row, name, stats):
    f = row["f"]
    if name in CONT:
        return (f[name] - stats["mean"][name]) / stats["sd"][name]
    if name == "gFront":
        return f["isFront"] * (f["g"] - stats["mean"]["g"]) / stats["sd"]["g"]
    if name == "gBack":
        return f["isBack"] * (f["g"] - stats["mean"]["g"]) / stats["sd"]["g"]
    return f[name]


_M1 = ["lq", "longRest", "surf", "front", "slump", "noPrior", "hcp"]
_M2 = _M1 + ["jedge", "tedge", "isFront", "isBack", "gFront", "gBack", "backTop3", "turf", "logDist"]
_C = ["bigField", "kokFuku", "mare", "oddsGap"]
SETS = {"Mc": ["lq"], "M1": _M1, "M2": _M2, "M1c": _M1 + _C, "M2c": _M2 + _C}
CAND_SETS = ("M1", "M2", "M1c", "M2c")


def make_stats(races):
    """標準化の平均・標準偏差(探索の対象馬から。g はレース単位)。"""
    rows = [r["fav"] for r in races]
    mean, sd = {}, {}
    for k in CONT:
        v = [r["f"][k] for r in rows]
        mu = sum(v) / len(v)
        mean[k], sd[k] = mu, math.sqrt(sum((x - mu) ** 2 for x in v) / len(v)) or 1.0
    gv = [race["g"] for race in races]
    mu = sum(gv) / len(gv)
    mean["g"], sd["g"] = mu, math.sqrt(sum((x - mu) ** 2 for x in gv) / len(gv)) or 1.0
    return {"mean": mean, "sd": sd}


def matrix(rows, names, stats):
    return [[1.0] + [column(r, n, stats) for n in names] for r in rows]


load_prep = Fe688.load_prep
