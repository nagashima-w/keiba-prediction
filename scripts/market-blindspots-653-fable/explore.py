"""
#653(2 本目): 前半(探索)の走査。計画 §5・§7。後半のデータは読まない(period == "A" だけ)。

使い方: python3 -I explore.py <features.csv> <出力ディレクトリ>
出力: scan_A.csv(走査した全条件の前半の指標)、candidates.json(候補: n ≥ 300 かつ |z| ≥ 2.5。後半へ機械的に当てられる節の並び)
"""

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeRegressor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I で動かすため
from common import SENTINEL, apply_clauses, stats  # noqa: E402

CATEGORICAL = [
    "courseType", "distBand", "direction", "going", "raceClass", "weightType", "filliesOnly", "sex", "wakuban",
    "apprentice", "jockeyMark", "trainerArea", "venueCode", "month", "age", "pCourseType", "surfaceChange",
    "venueChange", "jockeyChange", "pCloseButLost", "nSame5",
]
# 離散だが区分の意味が決まっているもの: 値の集合をそのまま区分にする。
ORDINAL_BANDS = {
    "clsDiff": {"降級(≤-1)": ("le", -1), "同級(0)": ("eq", 0), "昇級(≥1)": ("gt", 0)},
    "daysSince": {"連闘(≤7)": ("between", (None, 7)), "8〜14": ("between", (7, 14)), "15〜35": ("between", (14, 35)),
                  "36〜90": ("between", (35, 90)), "91〜180": ("between", (90, 180)), "181〜": ("between", (180, None))},
    "distDiff": {"短縮(≤-400)": ("between", (None, -400)), "短縮(-399〜-1)": ("between", (-400, -1)), "同距離": ("eq", 0),
                 "延長(1〜399)": ("between", (0, 399)), "延長(≥400)": ("between", (399, None))},
    "kinryoDiff": {"減(≤-2)": ("between", (None, -2)), "減(-1.9〜-0.1)": ("between", (-2, -0.1)), "同じ": ("eq", 0),
                   "増(0.1〜1.9)": ("between", (0, 1.9)), "増(≥2)": ("between", (1.9, None))},
    "bwDiff": {"減(≤-10)": ("between", (None, -10)), "減(-9〜-4)": ("between", (-10, -4)), "±3 以内": ("between", (-4, 3)),
               "増(4〜9)": ("between", (3, 9)), "増(≥10)": ("between", (9, None))},
    "nPrior": {"前走なし": ("eq", 0), "1": ("eq", 1), "2〜3": ("between", (1, 3)), "4〜9": ("between", (3, 9)), "10〜": ("between", (9, None))},
}
NUMERIC = [
    "distance", "n", "umabanRel", "burden", "burdenRel", "bw", "q", "raceNumber", "startMin",
    "pFinish", "pNinki", "pOdds", "pMargin", "pN", "pLastPos", "pFirstPos", "pLast3f", "pBw",
    "pNinkiMinusFinish", "pLastPosMinusFinish", "careerWins", "careerPlaceRate", "avgFinish3", "avgNinkiMinusFinish3",
    "samePlaceRate5", "style", "lastPos3",
]
TREE_FEATURES = NUMERIC + ["clsDiff", "daysSince", "distDiff", "kinryoDiff", "bwDiff", "nPrior", "age", "apprentice",
                           "surfaceChange", "venueChange", "jockeyChange", "pCloseButLost", "filliesOnly", "month"]
POPULATIONS = {"全体": [], "人気薄(q<0.05)": [{"feature": "q", "op": "le", "value": 0.05}],
               "人気馬(q≥0.30)": [{"feature": "q", "op": "gt", "value": 0.30}]}
MIN_N = 300
Z_MIN = 2.5


def numeric_bins(series):
    """前半の分位で 5 区分と、上下 10% の区分。区分は (lo, hi] の閾値で返す(後半へ同じ閾値を当てる)。"""
    s = series.dropna()
    out = {}
    qs = s.quantile([0.2, 0.4, 0.6, 0.8]).tolist()
    edges = [None] + sorted(set(qs)) + [None]
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        if lo is not None and hi is not None and lo == hi:
            continue
        out[f"5分位{i + 1}({'' if lo is None else round(lo, 3)}〜{'' if hi is None else round(hi, 3)}]"] = ("between", (lo, hi))
    lo10, hi10 = s.quantile(0.1), s.quantile(0.9)
    out[f"下位10%(≤{round(lo10, 3)})"] = ("between", (None, lo10))
    out[f"上位10%(>{round(hi10, 3)})"] = ("between", (hi10, None))
    return out


def scan_univariate(df, pop_name, pop_clauses):
    base = apply_clauses(df, pop_clauses)
    sub = df[base]
    conds = []
    for f in CATEGORICAL:
        for v in sorted(sub[f].dropna().unique(), key=str):
            if v == "":
                continue
            val = v.item() if hasattr(v, "item") else v
            conds.append((f"{f}={val}", pop_clauses + [{"feature": f, "op": "eq", "value": val}]))
    for f, bands in ORDINAL_BANDS.items():
        for name, (op, val) in bands.items():
            conds.append((f"{f}:{name}", pop_clauses + [{"feature": f, "op": op, "value": val}]))
    for f in NUMERIC:
        if f == "q" and pop_name != "全体":
            continue
        for name, (op, val) in numeric_bins(sub[f]).items():
            conds.append((f"{f}:{name}", pop_clauses + [{"feature": f, "op": op, "value": val}]))
    return [("A:" + pop_name, name, clauses) for name, clauses in conds]


def tree_leaves(df, target):
    X = df[TREE_FEATURES].astype(float).fillna(SENTINEL).to_numpy()
    y = df[f"r_{target}"].to_numpy()
    tree = DecisionTreeRegressor(max_depth=3, min_samples_leaf=400, random_state=0).fit(X, y)
    t = tree.tree_
    out = []

    def walk(node, path):
        if t.children_left[node] == -1:
            name = " & ".join(f"{f}{'≤' if le else '>'}{round(v, 3)}" for f, le, v in path) or "(根)"
            clauses = [{"feature": f, "op": "le" if le else "gt", "value": float(v)} for f, le, v in path]
            out.append((f"B:木({target})", name, clauses))
            return
        f = TREE_FEATURES[t.feature[node]]
        v = float(t.threshold[node])
        walk(t.children_left[node], path + [(f, True, v)])
        walk(t.children_right[node], path + [(f, False, v)])

    walk(0, [])
    return out


def day_bias_conditions(df):
    conds = []
    styles = {"先行(style≤0.3)": ("le", 0.3), "後方(style>0.7)": ("gt", 0.7)}
    for idx in ("F", "G", "Fprev"):
        s = df[idx].dropna()
        lo, hi = s.quantile(1 / 3), s.quantile(2 / 3)
        thirds = {f"下位1/3(≤{round(lo, 4)})": ("between", (None, lo)), f"上位1/3(>{round(hi, 4)})": ("between", (hi, None))}
        for sname, (sop, sval) in styles.items():
            for tname, (top, tval) in thirds.items():
                clauses = [{"feature": "style", "op": sop, "value": sval}, {"feature": "style", "op": "notnull"},
                           {"feature": idx, "op": top, "value": tval}]
                conds.append(("C:当日の傾向×脚質", f"{sname} × {idx}{tname}", clauses))
    return conds


def main():
    feat_path, out_dir = sys.argv[1:3]
    os.makedirs(out_dir, exist_ok=True)
    df = pd.read_csv(feat_path, low_memory=False)
    df = df[df["period"] == "A"].reset_index(drop=True)
    conds = []
    for pop_name, pop_clauses in POPULATIONS.items():
        conds += scan_univariate(df, pop_name, pop_clauses)
    for target in ("place", "win"):
        conds += tree_leaves(df, target)
    conds += day_bias_conditions(df)

    rows = []
    for family, name, clauses in conds:
        st = stats(df, apply_clauses(df, clauses))
        rows.append({"family": family, "name": name, **st, "clauses": json.dumps(clauses, ensure_ascii=False)})
    scan = pd.DataFrame(rows)
    scan.to_csv(os.path.join(out_dir, "scan_A.csv"), index=False)

    cands = []
    for r in rows:
        if r["n"] < MIN_N:
            continue
        metrics = [t for t in ("place", "win") if abs(r[f"z_{t}"]) >= Z_MIN]
        if not metrics:
            continue
        cands.append({"family": r["family"], "name": r["name"], "clauses": json.loads(r["clauses"]), "metrics": metrics,
                      "A": {k: r[k] for k in r if k not in ("family", "name", "clauses")}})
    with open(os.path.join(out_dir, "candidates.json"), "w") as f:
        json.dump({"M": len(rows), "K": len(cands), "candidates": cands}, f, ensure_ascii=False, indent=1)
    print(f"走査した条件 M={len(rows)}(n≥{MIN_N} は {(scan['n'] >= MIN_N).sum()})、候補 K={len(cands)}(仮説の数 {sum(len(c['metrics']) for c in cands)})")
    show = scan[scan["n"] >= MIN_N].copy()
    show["zmax"] = show[["z_place", "z_win"]].abs().max(axis=1)
    pd.set_option("display.width", 250)
    pd.set_option("display.max_colwidth", 70)
    print(show.sort_values("zmax", ascending=False).head(60)[["family", "name", "n", "d_place", "z_place", "d_win", "z_win", "roi_win"]].to_string())


if __name__ == "__main__":
    main()
