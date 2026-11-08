"""#688: 候補馬(対象レースの、確定の人気が 6 以下でオッズのある馬)の材料を作る。
材料はすべて、そのレースより前の走だけから(4 印は flags.py、騎手調教師の差は edges.py、g は #687 の固定係数)。
結果の 3着内(y)は行に載せるが、材料の作成では使わない。
"""
from __future__ import annotations

import collections
import json
import math

import common688 as K
import edges as E
import flags as F
import runs as R

a687, c = K.a687, K.c


def load_prep(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build(table_path, hist_paths, csv_path, prep, period):
    """period の対象レース(c.exclusion_reason が None)の候補馬を作る。戻り: [race dict]。"""
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
            qs = K.race_q(t)
            g = a687.g_of(t, fm, pi)
            tf, _tb = c.top3_comp(t)
            hmap = {h["horseId"]: h for h in st}
            cands = []
            for th in t["horses"]:
                if th["ninki"] is None or th["ninki"] < 6 or not th["odds"]:
                    continue
                h = hmap[th["horseId"]]
                q = qs[th["horseId"]]
                runs = R.merged_runs(csvr.get(th["horseId"], {}), hist_by_horse.get(th["horseId"], {}))
                lr, sc, fr, sl = F.compute_flags(runs, hr["date"].replace("-", "/"), t["courseType"], q)
                no_prior = 1.0 if (lr, sc, fr, sl) == F.NO_FLAGS else 0.0
                style = th["style"]
                is_front = 1.0 if style in c.FRONT else 0.0
                is_back = 1.0 if style in c.BACK else 0.0
                je, te = edge_of[hr["raceId"]][th["horseId"]]
                cands.append({
                    "raceId": hr["raceId"], "umaban": th["umaban"], "horseId": th["horseId"], "ninki": th["ninki"],
                    "band": "6-9" if th["ninki"] <= 9 else "10+", "q": q, "odds": th["odds"],
                    "p3": K.p3_fixed(coef, q, t["nStart"]),
                    "y": 1 if (th["finish"] is not None and th["finish"] <= 3) else 0,
                    "f": {"lq": K.logit(q), "b10": 1.0 if th["ninki"] >= 10 else 0.0,
                          "longRest": float(lr or 0), "surf": float(sc or 0), "front": float(fr or 0), "slump": float(sl or 0),
                          "noPrior": no_prior, "hcp": 1.0 if t["weightType"] == "ハンデ" else 0.0,
                          "jedge": je, "tedge": te, "isFront": is_front, "isBack": is_back, "g": g,
                          "backTop3": 1.0 if (is_back and tf >= 2) else 0.0,
                          "turf": 1.0 if t["courseType"] == "芝" else 0.0, "logDist": math.log(t["distance"])},
                })
            payouts = hr["payouts"]
            wide = {}
            w = payouts.get("wide")
            if isinstance(w, dict):
                for x in w.get("payouts", []):
                    wide[frozenset(x["umabans"])] = x["payout"]
            favs = sorted([(th["ninki"], th["umaban"]) for th in t["horses"] if th["ninki"] in (1, 2)])
            out.append({
                "raceId": hr["raceId"], "date": hr["date"], "hcp": t["weightType"] == "ハンデ", "g": g,
                "cands": cands,
                "info": {"place": {x["umaban"]: x["payout"] for x in payouts["place"]}, "wide": wide,
                         "fav": [u for _, u in favs]},
            })
        for h in st:
            hist_by_horse[h["horseId"]][hr["raceId"]] = R.hist_run(hr, h, len(st))
    return out


CONT = ("lq", "jedge", "tedge", "logDist")  # 標準化する連続の特徴量


def column(row, name, stats):
    """行の特徴量 name の値(標準化・交互作用を含む)。"""
    f = row["f"]
    if name in CONT:
        return (f[name] - stats["mean"][name]) / stats["sd"][name]
    if name == "gFront":
        return f["isFront"] * (f["g"] - stats["mean"]["g"]) / stats["sd"]["g"]
    if name == "gBack":
        return f["isBack"] * (f["g"] - stats["mean"]["g"]) / stats["sd"]["g"]
    return f[name]


SETS = {
    "Mc": ["lq", "b10"],
    "M1": ["lq", "b10", "longRest", "surf", "front", "slump", "noPrior", "hcp"],
    "M2": ["lq", "b10", "longRest", "surf", "front", "slump", "noPrior", "hcp",
           "jedge", "tedge", "isFront", "isBack", "gFront", "gBack", "backTop3", "turf", "logDist"],
}


def make_stats(races):
    """標準化の平均・標準偏差(探索の候補馬から。g はレース単位)。"""
    rows = [r for race in races for r in race["cands"]]
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
    """設計行列(先頭が切片)。"""
    return [[1.0] + [column(r, n, stats) for n in names] for r in rows]
