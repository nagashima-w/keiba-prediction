"""#653(2 本目): explore.py と confirm.py で共有する、条件の適用と指標の計算。計画 §4。"""

import math

import numpy as np
import pandas as pd

SENTINEL = -999.0  # 木に渡すときの欠損の埋め値(条件を機械的に後半へ適用するため)

TARGETS = ("place", "win")


def apply_clauses(df, clauses):
    """条件(節の並び。すべて AND)を df に当てて真偽の配列を返す。
    節: {"feature": 列名, "op": "eq"|"in"|"le"|"gt"|"between"|"notnull", "value": ...}
    "le"/"gt" は欠損を SENTINEL で埋めてから比べる(木の葉の条件)。"between" は (lo, hi] で欠損は偽。"""
    mask = pd.Series(True, index=df.index)
    for c in clauses:
        col = df[c["feature"]]
        op = c["op"]
        if op == "eq":
            m = col == c["value"]
        elif op == "in":
            m = col.isin(c["value"])
        elif op == "le":
            m = col.fillna(SENTINEL) <= c["value"]
        elif op == "gt":
            m = col.fillna(SENTINEL) > c["value"]
        elif op == "between":
            lo, hi = c["value"]
            m = (col > lo) & (col <= hi) if lo is not None else (col <= hi)
            if hi is None:
                m = col > lo
            m = m & col.notna()
        elif op == "notnull":
            m = col.notna()
        else:
            raise ValueError(op)
        mask &= m.fillna(False).astype(bool)
    return mask


def stats(df, mask):
    """条件内の件数・差(pt)・z・単勝の回収率。"""
    sub = df[mask]
    out = {"n": int(len(sub))}
    for t in TARGETS:
        r = sub[f"r_{t}"]
        p = sub[f"p_{t}"]
        s = float(r.sum())
        v = float((p * (1 - p)).sum())
        out[f"d_{t}"] = (s / len(sub) * 100) if len(sub) else float("nan")
        out[f"z_{t}"] = (s / math.sqrt(v)) if v > 0 else float("nan")
        out[f"rate_{t}"] = float(sub[t].mean() * 100) if len(sub) else float("nan")
        out[f"pred_{t}"] = float(p.mean() * 100) if len(sub) else float("nan")
    out["roi_win"] = float((sub["odds"] * sub["win"]).sum() / len(sub)) if len(sub) else float("nan")
    return out


def race_bootstrap(df, mask, target, iters=1000, seed=653):
    """レース単位のブートストラップで差(pt)の 95% 区間。"""
    sub = df[mask]
    g = sub.groupby("raceId")[f"r_{target}"].agg(["sum", "count"])
    sums = g["sum"].to_numpy()
    cnts = g["count"].to_numpy()
    rng = np.random.default_rng(seed)
    k = len(sums)
    vals = []
    for _ in range(iters):
        idx = rng.integers(0, k, k)
        vals.append(sums[idx].sum() / cnts[idx].sum() * 100)
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def one_sided_p(z, sign):
    """前半の向き(sign = ±1)に対する後半の片側 p 値。"""
    from scipy.stats import norm
    return float(norm.sf(z * sign))


def holm(pvals):
    """Holm 補正した p 値(順序は入力のまま)。"""
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    adj = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        val = min(1.0, (m - rank) * pvals[i])
        running = max(running, val)
        adj[i] = running
    return adj
