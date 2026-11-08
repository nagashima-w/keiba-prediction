"""#694: 市場の見込み(単勝オッズ → 3着内の確率)の式の較正。読み込み・式・当てはめ・ずらし・評価。"""
from __future__ import annotations

import gzip
import json
import math

import numpy as np

PROD_COEF = [2.857, 0.9216, -0.5561]
MIN_ODDS_HORSES = 5
FIT = ("2021-06-20", "2023-12-31")
EVAL = ("2024-01-01", "2026-11-01")
FORMULAS = ["F_prod", "F0", "F1", "F2", "F3"]
CANDIDATE_ORDER = ["F0", "F1", "F3", "F2"]  # 単純さの順
KNOT_PCTS = [0.2, 0.5, 0.8]
BANDS = [("1", 1, 1), ("2-3", 2, 3), ("4-5", 4, 5), ("6-9", 6, 9), ("10+", 10, 10**9)]
EPS = 1e-6


def clip_logit(p):
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35.0, 35.0)))


def load_races(paths):
    """対象レースの行。戻り: (races, stats)。races = [{raceId, date, n, odds[], q[], ninki[], y[]}]。"""
    seen = set()
    races = []
    st = {"dup": 0, "not_target_course": 0, "lt5_odds": 0, "lt3_top3": 0, "races_with_oddsless": 0, "ninki_null": 0}
    for path in paths:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                if r["raceId"] in seen:
                    st["dup"] += 1
                    continue
                seen.add(r["raceId"])
                if r["courseType"] not in ("芝", "ダ"):
                    st["not_target_course"] += 1
                    continue
                hs = [h for h in r["horses"] if h.get("finishStatus") not in ("取消", "除外")]
                od = [h for h in hs if h.get("winOdds") and h["winOdds"] > 0]
                if len(od) < MIN_ODDS_HORSES:
                    st["lt5_odds"] += 1
                    continue
                if sum(1 for h in hs if h.get("finish") is not None and 1 <= h["finish"] <= 3) < 3:
                    st["lt3_top3"] += 1
                    continue
                if len(od) < len(hs):
                    st["races_with_oddsless"] += 1
                inv = np.array([1.0 / h["winOdds"] for h in od])
                order = np.argsort(np.array([h["winOdds"] for h in od]), kind="stable")
                rank_by_odds = np.empty(len(od), dtype=int)
                # 同じオッズは最小の順位を共有
                sorted_odds = [od[i]["winOdds"] for i in order]
                for pos, i in enumerate(order):
                    first = pos
                    while first > 0 and sorted_odds[first - 1] == sorted_odds[pos]:
                        first -= 1
                    rank_by_odds[i] = first + 1
                ninki = []
                for i, h in enumerate(od):
                    if h.get("ninki"):
                        ninki.append(int(h["ninki"]))
                    else:
                        st["ninki_null"] += 1
                        ninki.append(int(rank_by_odds[i]))
                races.append({
                    "raceId": r["raceId"], "date": r["date"], "n": len(od),
                    "odds": np.array([h["winOdds"] for h in od]),
                    "q": inv / inv.sum(),
                    "ninki": np.array(ninki),
                    "y": np.array([1.0 if (h.get("finish") is not None and 1 <= h["finish"] <= 3) else 0.0 for h in od]),
                })
    races.sort(key=lambda r: (r["date"], r["raceId"]))
    return races, st


def in_period(races, p):
    return [r for r in races if p[0] <= r["date"] <= p[1]]


def features(name, L, lnn, knots=None):
    """特徴量の行列。L = logit q、lnn = ln 頭数(馬ごと)。"""
    one = np.ones_like(L)
    if name in ("F_prod", "F0"):
        cols = [one, L, lnn]
    elif name == "F1":
        cols = [one, L, lnn, L * L]
    elif name == "F3":
        cols = [one, L, lnn, L * L, L * lnn]
    elif name == "F2":
        cols = [one, L, lnn] + [np.maximum(0.0, L - k) for k in knots]
    else:
        raise ValueError(name)
    return np.stack(cols, axis=1)


def stack(races):
    L = np.concatenate([clip_logit(r["q"]) for r in races])
    lnn = np.concatenate([np.full(len(r["q"]), math.log(r["n"])) for r in races])
    y = np.concatenate([r["y"] for r in races])
    return L, lnn, y


def fit_logit(X, y, iters=30, tol=1e-8):
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = sigmoid(X @ w)
        g = X.T @ (y - p)
        W = p * (1 - p)
        H = (X * W[:, None]).T @ X
        step = np.linalg.solve(H, g)
        w = w + step
        if np.max(np.abs(step)) < tol:
            break
    return w


def knots_from(L, pcts=KNOT_PCTS):
    s = np.sort(L)
    return [float(s[int(math.floor(p * (len(s) - 1)))]) for p in pcts]


def predict(name, coef, knots, races):
    """レースごとの m(リスト)。"""
    out = []
    for r in races:
        L = clip_logit(r["q"])
        lnn = np.full(len(L), math.log(r["n"]))
        out.append(sigmoid(features(name, L, lnn, knots) @ np.array(coef)))
    return out


def shift_to_sum(m, target, lo=-20.0, hi=20.0, iters=100):
    """logit(m) に共通の定数 d を足して合計を target に合わせた値(本番 shrinkTowardMarket の最後の段と同じ二分法)。"""
    z = clip_logit(m)
    for _ in range(iters):
        mid = (lo + hi) / 2
        if sigmoid(z + mid).sum() < target:
            lo = mid
        else:
            hi = mid
    return sigmoid(z + (lo + hi) / 2)


def logloss_terms(p, y):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def band_stats(races, preds):
    """帯ごとの n, O, E, O/E, z。帯 '1.0-1.9' は 1 番人気で単勝 1.0〜1.9 倍。"""
    keys = [b[0] for b in BANDS] + ["fav1.0-1.9"]
    acc = {k: [0, 0.0, 0.0, 0.0] for k in keys}
    for r, p in zip(races, preds):
        for i in range(len(p)):
            ks = [b[0] for b in BANDS if b[1] <= r["ninki"][i] <= b[2]]
            if r["ninki"][i] == 1 and 1.0 <= r["odds"][i] < 2.0:
                ks.append("fav1.0-1.9")
            for k in ks:
                a = acc[k]
                a[0] += 1
                a[1] += r["y"][i]
                a[2] += p[i]
                a[3] += p[i] * (1 - p[i])
    res = {}
    for k, (n, o, e, v) in acc.items():
        res[k] = {"n": n, "O": o, "E": e, "OE": (o / e if e > 0 else None), "z": ((o - e) / math.sqrt(v) if v > 0 else None)}
    return res


def deviation(bs, keys):
    """|O/E − 1| の、帯の対象馬数による重み付き平均。"""
    tot = sum(bs[k]["n"] for k in keys)
    return sum(bs[k]["n"] * abs(bs[k]["OE"] - 1) for k in keys) / tot


def summarize(races, preds):
    ll_by_race = np.array([logloss_terms(p, r["y"]).sum() for r, p in zip(races, preds)])
    nh = sum(len(p) for p in preds)
    bs = band_stats(races, preds)
    five = [b[0] for b in BANDS]
    return {
        "logloss": float(ll_by_race.sum() / nh), "n_horses": nh, "n_races": len(races),
        "bands": bs,
        "D6": deviation(bs, five + ["fav1.0-1.9"]), "D5": deviation(bs, five),
    }, ll_by_race


def paired_se(ll_a, ll_b, nh):
    """レース単位の損失合計の差(a − b)の、1 馬あたりの平均と標準誤差。"""
    d = ll_a - ll_b
    return float(d.sum() / nh), float(d.std(ddof=1) * math.sqrt(len(d)) / nh)
