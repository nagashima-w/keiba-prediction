"""
#653(2 本目の探索): 1 頭 1 行の特徴量の表を作る。計画は docs/investigations/market-blindspots-653-fable/plan.md。

入力(リポジトリに入れない):
  hist.ndjson.gz   中央の過去の結果(1 行 1 レース。RaceRecord の JSON)
  horse_runs.csv   馬ごとの戦績(horse_id,data。data は 26 スロットのタプル。packages/core/src/scraper/horse-run-record.ts)
出力: 1 頭 1 行の CSV(走った馬・オッズあり・5 頭以上のレースだけ)。市場の予測(期間ごとのロジスティック回帰)と残差、
      当日の馬場の指標 F・G も含む。

先読みの防ぎ方:
  - 馬の戦績は、対象レースの日付より前(厳密に小さい)の走だけ。
  - 当日の指標は、同じ日・同じ競馬場・同じ芝ダで、発走が 40 分以上前のレースだけ。
  - 市場の予測は期間(前半・後半)ごとに当てはめる(計画 §3)。これは「全体の水準」を合わせるためで、条件ごとの差には使わない。

使い方: python3 -I features.py <hist.ndjson.gz> <horse_runs.csv または "-"> <出力.csv>
  (既定の分析は "-"。horse_runs.csv の有無が将来に依存するため。計画 §10)
"""

import csv
import gzip
import json
import re
import sys
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

DISCOVERY = ("2024-08-10", "2025-09-30")
CONFIRM = ("2025-10-01", "2026-10-31")

CLASS_BY_NAME = [
    ("新馬", 0), ("未勝利", 1), ("1勝", 2), ("2勝", 3), ("3勝", 4),
    ("GI", 8), ("GII", 7), ("GIII", 6), ("G1", 8), ("G2", 7), ("G3", 6),
    ("(L)", 5), ("L)", 5), ("OP", 5), ("オープン", 5),
]
# 正規表現で "GI" が "GII"/"GIII" に先に当たらないよう、長いものから試す。
CLASS_RE = re.compile(r"(新馬|未勝利|1勝|2勝|3勝|GIII|GII|GI|G3|G2|G1|\(L\)|L\)|OP|オープン)")
CLASS_VALUE = {k: v for k, v in CLASS_BY_NAME}


def class_from_name(name):
    if not name:
        return None
    m = CLASS_RE.search(name)
    return CLASS_VALUE[m.group(1)] if m else None


def class_today(rec):
    rc = rec["raceClass"]
    base = {"新馬": 0, "未勝利": 1, "1勝クラス": 2, "2勝クラス": 3, "3勝クラス": 4}.get(rc)
    if base is not None:
        return base
    g = rec["grade"]
    if g in ("G1", "JG1"):
        return 8
    if g in ("G2", "JG2"):
        return 7
    if g in ("G3", "JG3"):
        return 6
    return 5


def ran(h):
    return h["finishStatus"] not in ("取消", "除外")


def minutes(t):
    hh, mm = t.split(":")
    return int(hh) * 60 + int(mm)


def read_hist(path):
    out = []
    with gzip.open(path, "rt") as f:
        for line in f:
            if line.strip():
                out.append(json.loads(line))
    out.sort(key=lambda r: (r["date"], r["raceId"]))
    return out


def hist_runs(records):
    """hist の全レースから、馬ごとの走(戦績の形)を作る。"""
    runs = defaultdict(list)
    for rec in records:
        ran_h = [h for h in rec["horses"] if ran(h)]
        n = len(ran_h)
        win_time = None
        for h in ran_h:
            if h["finish"] == 1 and h["timeSec"] is not None:
                win_time = h["timeSec"]
        for h in ran_h:
            margin = None
            if win_time is not None and h["timeSec"] is not None:
                margin = round(h["timeSec"] - win_time, 1)
            runs[h["horseId"]].append({
                "date": rec["date"], "raceId": rec["raceId"], "venue": rec["venueName"],
                "courseType": rec["courseType"], "distance": rec["distance"], "going": rec["going"],
                "finish": h["finish"], "ninki": h["ninki"], "odds": h["winOdds"], "margin": margin,
                "n": n, "jockeyId": h["jockeyId"], "kinryo": h["burden"], "passing": h["passing"] or [],
                "last3f": h["last3f"], "bw": h["bodyWeight"], "cls": class_today(rec),
            })
    return runs


def horse_runs_csv(path, runs):
    """horse_runs.csv の走を足す(レース ID が重なる走は hist を優先)。"""
    have = {(hid, r["raceId"]) for hid, lst in runs.items() for r in lst}
    added = 0
    with open(path, newline="") as f:
        rd = csv.reader(f)
        next(rd)
        for hid, data in rd:
            t = json.loads(data)
            rid = t[5] or ("X" + t[0].replace("/", ""))
            if (hid, rid) in have:
                continue
            fp = t[12]
            finish = fp if isinstance(fp, int) else (fp[0] if isinstance(fp, list) else None)
            runs[hid].append({
                "date": t[0].replace("/", "-"), "raceId": rid, "venue": t[1][1] if t[1] else None,
                "courseType": t[16], "distance": t[17], "going": t[18],
                "finish": finish, "ninki": t[11], "odds": t[10], "margin": t[20],
                "n": t[7], "jockeyId": t[14], "kinryo": t[15], "passing": t[21] or [],
                "last3f": t[23], "bw": t[24][0] if t[24] else None, "cls": class_from_name(t[4]),
            })
            added += 1
    for lst in runs.values():
        lst.sort(key=lambda r: r["date"])
    return added


def days_between(a, b):
    return (pd.Timestamp(a) - pd.Timestamp(b)).days


def rel_pos(passing, n, idx):
    if not passing or not n:
        return None
    return passing[idx] / n


def horse_features(prior, rec, h):
    """対象レースより前の走(prior。日付順)から、馬の特徴量を作る。"""
    f = {}
    f["nPrior"] = len(prior)
    if not prior:
        return f
    p = prior[-1]
    f["daysSince"] = days_between(rec["date"], p["date"])
    f["pFinish"] = p["finish"]
    f["pNinki"] = p["ninki"]
    f["pOdds"] = p["odds"]
    f["pMargin"] = p["margin"]
    f["pN"] = p["n"]
    f["pCourseType"] = p["courseType"]
    f["pDistance"] = p["distance"]
    f["pVenue"] = p["venue"]
    f["pJockeyId"] = p["jockeyId"]
    f["pKinryo"] = p["kinryo"]
    f["pLastPos"] = rel_pos(p["passing"], p["n"], -1)
    f["pFirstPos"] = rel_pos(p["passing"], p["n"], 0)
    f["pLast3f"] = p["last3f"]
    f["pBw"] = p["bw"]
    f["pCls"] = p["cls"]
    # 替わり
    f["distDiff"] = (rec["distance"] - p["distance"]) if p["distance"] else None
    f["surfaceChange"] = int(p["courseType"] != rec["courseType"]) if p["courseType"] else None
    f["venueChange"] = int(p["venue"] != rec["venueName"]) if p["venue"] else None
    f["jockeyChange"] = int(p["jockeyId"] != h["jockeyId"]) if (p["jockeyId"] and h["jockeyId"]) else None
    f["kinryoDiff"] = (h["burden"] - p["kinryo"]) if (p["kinryo"] is not None and h["burden"] is not None) else None
    f["clsDiff"] = (class_today(rec) - p["cls"]) if p["cls"] is not None else None
    # 前走の負け方
    if p["finish"] is not None and p["margin"] is not None:
        f["pCloseButLost"] = int(p["margin"] <= 0.5 and p["finish"] >= 6)
    if p["finish"] is not None and p["ninki"] is not None:
        f["pNinkiMinusFinish"] = p["ninki"] - p["finish"]
    if p["finish"] is not None and f["pLastPos"] is not None and p["n"]:
        f["pLastPosMinusFinish"] = f["pLastPos"] - p["finish"] / p["n"]
    # 通算
    fins = [r["finish"] for r in prior if r["finish"] is not None]
    f["careerWins"] = sum(1 for x in fins if x == 1)
    f["careerPlaceRate"] = (sum(1 for x in fins if x <= 3) / len(fins)) if fins else None
    last3 = [r for r in prior[-3:] if r["finish"] is not None]
    f["avgFinish3"] = (sum(r["finish"] for r in last3) / len(last3)) if last3 else None
    nm = [r["ninki"] - r["finish"] for r in prior[-3:] if r["finish"] is not None and r["ninki"] is not None]
    f["avgNinkiMinusFinish3"] = (sum(nm) / len(nm)) if nm else None
    same = [r for r in prior[-5:] if r["finish"] is not None and r["courseType"] == rec["courseType"]
            and r["distance"] and dist_band(r["distance"]) == dist_band(rec["distance"])]
    f["samePlaceRate5"] = (sum(1 for r in same if r["finish"] <= 3) / len(same)) if same else None
    f["nSame5"] = len(same)
    # 脚質(直近 3 走の最初のコーナーの相対位置)
    fp = [rel_pos(r["passing"], r["n"], 0) for r in prior[-3:]]
    fp = [x for x in fp if x is not None]
    f["style"] = (sum(fp) / len(fp)) if fp else None
    # 直近 3 走の最終コーナーの相対位置
    lp = [rel_pos(r["passing"], r["n"], -1) for r in prior[-3:]]
    lp = [x for x in lp if x is not None]
    f["lastPos3"] = (sum(lp) / len(lp)) if lp else None
    return f


def dist_band(d):
    if d <= 1400:
        return "S"
    if d <= 1800:
        return "M"
    if d <= 2200:
        return "L"
    return "XL"


def period_of(date):
    if DISCOVERY[0] <= date <= DISCOVERY[1]:
        return "A"
    if CONFIRM[0] <= date <= CONFIRM[1]:
        return "B"
    return None


def build_rows(records, runs):
    rows = []
    for rec in records:
        per = period_of(rec["date"])
        if per is None:
            continue
        ran_h = [h for h in rec["horses"] if ran(h)]
        n = len(ran_h)
        if n < 5 or any(h["winOdds"] is None for h in ran_h):
            continue
        inv = np.array([1.0 / h["winOdds"] for h in ran_h])
        q = inv / inv.sum()
        burdens = [h["burden"] for h in ran_h if h["burden"] is not None]
        mean_burden = sum(burdens) / len(burdens) if burdens else None
        for h, qi in zip(ran_h, q):
            prior = [r for r in runs.get(h["horseId"], []) if r["date"] < rec["date"]]
            row = {
                "period": per, "date": rec["date"], "raceId": rec["raceId"], "venueCode": rec["venueCode"],
                "venueName": rec["venueName"], "raceNumber": rec["raceNumber"], "startMin": minutes(rec["startTime"]),
                "courseType": rec["courseType"], "distance": rec["distance"], "distBand": dist_band(rec["distance"]),
                "direction": rec["direction"], "going": rec["going"], "raceClass": rec["raceClass"], "clsToday": class_today(rec),
                "weightType": rec["weightType"], "filliesOnly": int(bool(rec["filliesOnly"])), "n": n, "month": int(rec["date"][5:7]),
                "horseId": h["horseId"], "umaban": h["umaban"], "wakuban": h["wakuban"], "umabanRel": h["umaban"] / n,
                "sex": h["sex"], "age": h["age"], "burden": h["burden"],
                "burdenRel": (h["burden"] - mean_burden) if (h["burden"] is not None and mean_burden is not None) else None,
                "apprentice": int(h["jockeyMark"] is not None), "jockeyMark": h["jockeyMark"] or "",
                "trainerArea": h["trainerArea"], "bw": h["bodyWeight"], "bwDiff": h["bodyWeightDiff"],
                "jockeyId": h["jockeyId"], "odds": h["winOdds"], "q": qi, "ninki": h["ninki"],
                "finish": h["finish"], "win": int(h["finish"] == 1), "place": int(h["finish"] is not None and h["finish"] <= 3),
                "lastCorner": (h["passing"][-1] if h["passing"] else None),
            }
            row.update(horse_features(prior, rec, h))
            rows.append(row)
    return pd.DataFrame(rows)


def fit_market(df):
    """期間ごとに y ~ 1 + logit(q) + log(n) を当てはめ、p̂ と残差を足す。係数は返す。"""
    coefs = {}
    df["lq"] = np.log(df["q"] / (1 - df["q"]))
    df["ln"] = np.log(df["n"])
    for target in ("place", "win"):
        df[f"p_{target}"] = np.nan
        for per, sub in df.groupby("period"):
            X = sub[["lq", "ln"]].to_numpy()
            y = sub[target].to_numpy()
            m = LogisticRegression(C=1e6, max_iter=1000).fit(X, y)
            df.loc[sub.index, f"p_{target}"] = m.predict_proba(X)[:, 1]
            coefs[f"{target}/{per}"] = {"intercept": float(m.intercept_[0]), "logit_q": float(m.coef_[0][0]), "log_n": float(m.coef_[0][1]), "n": int(len(sub))}
        df[f"r_{target}"] = df[target] - df[f"p_{target}"]
    return coefs


def day_bias(df):
    """当日の指標 F(前 3 番手以内の 3着内の残差の平均)と G(最終コーナーの位置と着順のスピアマン相関の平均)。
    同じ日・競馬場・芝ダで、発走が 40 分以上前のレース(2 レース以上あるとき)。前日の F も作る(同じ競馬場・芝ダの前日の全レース)。"""
    from scipy.stats import spearmanr
    per_race = {}
    for rid, g in df.groupby("raceId"):
        front = g[g["lastCorner"].notna() & (g["lastCorner"] <= 3)]
        f = front["r_place"].mean() if len(front) > 0 else np.nan
        ok = g[g["lastCorner"].notna() & g["finish"].notna()]
        gcorr = spearmanr(ok["lastCorner"], ok["finish"]).correlation if len(ok) >= 5 else np.nan
        r0 = g.iloc[0]
        per_race[rid] = (r0["date"], r0["venueCode"], r0["courseType"], r0["startMin"], f, gcorr)
    by_key = defaultdict(list)
    for rid, (d, v, c, s, f, gcorr) in per_race.items():
        by_key[(d, v, c)].append((s, f, gcorr))
    F, G, nPrev, Fprev = [], [], [], []
    dates = sorted({d for d, _, _ in by_key})
    prev_date = {dates[i]: dates[i - 1] for i in range(1, len(dates))}
    for rid in df["raceId"]:
        d, v, c, s, _, _ = per_race[rid]
        earlier = [(f, g) for (s2, f, g) in by_key[(d, v, c)] if s2 <= s - 40]
        fs = [f for f, _ in earlier if not np.isnan(f)]
        gs = [g for _, g in earlier if not np.isnan(g)]
        nPrev.append(len(earlier))
        F.append(np.mean(fs) if len(fs) >= 2 else np.nan)
        G.append(np.mean(gs) if len(gs) >= 2 else np.nan)
        pd_ = prev_date.get(d)
        pf = [f for (_, f, _) in by_key.get((pd_, v, c), [])] if pd_ else []
        pf = [f for f in pf if not np.isnan(f)]
        Fprev.append(np.mean(pf) if len(pf) >= 2 else np.nan)
    df["nPrevRaces"] = nPrev
    df["F"] = F
    df["G"] = G
    df["Fprev"] = Fprev


def main():
    hist_path, runs_path, out_path = sys.argv[1:4]
    records = read_hist(hist_path)
    runs = hist_runs(records)
    # horse_runs.csv は「本番が 2026 年に分析した馬」の分しか無く、持っているかどうかが将来(その馬がまだ走っているか)に依存する。
    # 戦績の長さが生存バイアスの漏れになるので、既定では使わない("-" を渡す)。計画 §10。
    added = horse_runs_csv(runs_path, runs) if runs_path != "-" else 0
    df = build_rows(records, runs)
    coefs = fit_market(df)
    day_bias(df)
    df.to_csv(out_path, index=False)
    print(json.dumps({"races": int(df["raceId"].nunique()), "rows": int(len(df)), "addedRunsFromCsv": added,
                      "byPeriod": {k: int(v) for k, v in df.groupby("period")["raceId"].nunique().items()},
                      "coefs": coefs}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
