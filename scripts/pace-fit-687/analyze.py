#!/usr/bin/env python3
"""#687: 馬ごとの展開の向き不向き × 予想した展開。標準ライブラリだけ。計画は docs/investigations/pace-fit-687/plan.md。
#683 の common.py・analyze.py の関数(係数の当て直し・BH・Holm・O/E)を再利用する。

使い方(<table> は build_table.py の出力):
  prep <table> <out_dir>                      前処理(結果の 3着内と確定オッズの較正・ペース区分の基準率・展開の予想の当てはめ・k・D の信頼性)
                                              → prep-results.json(馬の3着内と向き不向き・展開の予想の関係は集計しない)
  explore <table> <out_dir> <scores_out>      探索 B の集計 → explore-results.json、馬ごとの点 <scores_out>(ndjson.gz)
  fix <out_dir>                               explore-results.json から candidates.json(計画 §5 の規則)
  confirm <table> <out_dir> <scores_out>      確認の期間(candidates.json が無い・候補 0 件なら動かない)→ confirm-results.json
"""
from __future__ import annotations

import collections
import gzip
import importlib.util
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
D683 = os.path.join(HERE, "..", "pace-mismatch-683")
sys.path.insert(0, D683)
import common as c  # noqa: E402

_spec = importlib.util.spec_from_file_location("a683", os.path.join(D683, "analyze.py"))
a683 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(a683)

EXPLORE = ("2022-01-01", "2023-12-31")
WARM = ("2021-06-20", "2023-12-31")  # π・展開の予想の当てはめ・k の推定に使う(助走を含む)
CONFIRM = ("2024-01-01", "2026-11-01")
SPLIT_DATE = "2024-08-04"  # 確認の前半の最終日(記述用)
MIN_N = 300
BH_Q = 0.05
HOLM_ALPHA = 0.05
N_SHUFFLE = 1000
SEED = 687
K_MIN, K_MAX = 1.0, 20.0
COEF_B_REF = [2.6574, 0.8926, -0.5093]
FEAT_NAMES = ["f", "nesc", "n1", "n2", "t3f", "t3b", "favf", "n", "hcp"]
CELLS = [(g, b) for g in ("fit", "unfit") for b in c.BANDS]
EXPECT_OVER = {"fit": True, "unfit": False}  # 計画 §5 の予想の向き(向く: O/E>1、向かない: O/E<1)


def cname(k):
    return f"{k[0]}|{k[1]}"


def dist6(d):
    return 0 if d <= 1200 else 1 if d <= 1400 else 2 if d <= 1600 else 3 if d <= 1800 else 4 if d <= 2000 else 5


M_SHRINK = 30  # 縮めの強さ m(計画 追記 1-1・追記 2-1)


def root_key(r):
    return f"{r['courseType']}|{dist6(r['distance'])}"


def v_key(r):
    return f"{r['courseType']}|{r['venue']}|{r['distance']}"


def vr_key(r):
    return v_key(r) + ("|外" if "外" in (r.get("detail") or "") else "|内")


def class3(r):
    if r.get("grade") in ("G1", "G2", "G3"):
        return "重賞"
    return "OP" if r.get("raceClass") == "オープン" else "他"


def cls_key(r):
    return f"{root_key(r)}|{class3(r)}"


def in_period(r, p):
    return c.in_period(r, p)


def eligible(table, p):
    return [r for r in table if in_period(r, p) and c.exclusion_reason(r) is None]


def band_of(ninki):
    if ninki is None:
        return None
    for name, (lo, hi) in c.BANDS.items():
        if lo <= ninki <= hi:
            return name
    return None


# ---------- 線形代数・ロジスティック(リッジ) ----------
def solve(A, y):
    n = len(y)
    M = [A[i][:] + [y[i]] for i in range(n)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[piv] = M[piv], M[i]
        for r in range(n):
            if r != i:
                f = M[r][i] / M[i][i]
                if f != 0.0:
                    for k in range(i, n + 1):
                        M[r][k] -= f * M[i][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def fit_ridge_logit(X, y, lam=1.0, iters=40):
    p = len(X[0])
    w = [0.0] * p
    for _ in range(iters):
        g = [-lam * wi for wi in w]
        H = [[lam if i == j else 0.0 for j in range(p)] for i in range(p)]
        for x, yy in zip(X, y):
            z = sum(wi * xi for wi, xi in zip(w, x))
            pr = a683.sigmoid(z)
            e = yy - pr
            wt = pr * (1 - pr)
            for i in range(p):
                xi = x[i]
                if xi == 0.0:
                    continue
                g[i] += e * xi
                wx = wt * xi
                row = H[i]
                for j in range(p):
                    row[j] += wx * x[j]
        d = solve(H, g)
        w = [w[i] + d[i] for i in range(p)]
        if max(abs(v) for v in d) < 1e-8:
            break
    return w


def corr(a, b):
    n = len(a)
    if n < 3:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((x - mb) ** 2 for x in b))
    if sa == 0 or sb == 0:
        return None
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb)


def sd(v):
    n = len(v)
    m = sum(v) / n
    return math.sqrt(sum((x - m) ** 2 for x in v) / (n - 1)) if n > 1 else 0.0


# ---------- 過去走の残差・δ ----------
def build_index(table):
    """raceId -> {horseId: (y, q)}(オッズのある馬のみ。q はレース内で割り戻した値)。"""
    idx = {}
    for r in table:
        inv = [1 / h["odds"] if h["odds"] else None for h in r["horses"]]
        tot = sum(v for v in inv if v)
        d = {}
        for h, v in zip(r["horses"], inv):
            if v:
                d[h["horseId"]] = (1 if h["finish"] is not None and h["finish"] <= 3 else 0, v / tot)
        idx[r["raceId"]] = d
    return idx


def p3_of(coef, q, n):
    return a683.sigmoid(coef[0] + coef[1] * a683.logit(q) + coef[2] * math.log(n))


def _shares(cnt):
    return {k: {p: v[p] / sum(v.values()) for p in "SMH"} for k, v in cnt.items()}


def _shrink(cnt, parent_of, parent):
    """区分ごとの割合を (n·p̂ + m·p_親)/(n + m) で親へ縮める。"""
    out = {}
    for k, v in cnt.items():
        n = sum(v.values())
        pp = parent(parent_of[k])
        out[k] = {p: (v[p] + M_SHRINK * pp[p]) / (n + M_SHRINK) for p in "SMH"}
    return out


def compute_pi(table):
    """π(コースの基準のペースの割合)。根 → 競馬場・実距離 V → 回り VR、と別にクラスの係数用 C。WARM の paceClass のあるレースだけ。"""
    cr, cv, cvr, cc = (collections.defaultdict(collections.Counter) for _ in range(4))
    pv, pvr, pc_ = {}, {}, {}
    for r in table:
        if r["pc"] and in_period(r, WARM):
            cr[root_key(r)][r["pc"]] += 1
            cv[v_key(r)][r["pc"]] += 1
            cvr[vr_key(r)][r["pc"]] += 1
            cc[cls_key(r)][r["pc"]] += 1
            pv[v_key(r)] = root_key(r)
            pvr[vr_key(r)] = v_key(r)
            pc_[cls_key(r)] = root_key(r)
    root = _shares(cr)
    V = _shrink(cv, pv, lambda k: root[k])
    VR = _shrink(cvr, pvr, lambda k: V[k])
    C = _shrink(cc, pc_, lambda k: root[k])

    def stats(cn):
        v = sorted(sum(x.values()) for x in cn.values())
        return {"cells": len(v), "median": v[len(v) // 2], "lt30": sum(1 for x in v if x < 30), "lt10": sum(1 for x in v if x < 10)}
    counts = {"root": stats(cr), "V": stats(cv), "VR": stats(cvr), "C": stats(cc)}
    return {"root": root, "V": V, "VR": VR, "C": C}, counts


def pi_for(pi, r, mode="new"):
    root = pi["root"][root_key(r)]
    if mode == "old":
        return root
    pv = pi["VR"].get(vr_key(r)) or pi["V"].get(v_key(r)) or root
    ck = pi["C"].get(cls_key(r))
    raw = {x: pv[x] * (ck[x] / root[x] if ck else 1.0) for x in "SMH"}
    t = sum(raw.values())
    return {x: raw[x] / t for x in "SMH"}


def build_res(table, idx, coef, pi, mode="new"):
    """raceId -> {horseId: (r, δ, pc)}。pc の無いレース・根の無い区分は入れない。"""
    res = {}
    for r in table:
        if not r["pc"] or root_key(r) not in pi["root"]:
            continue
        p = pi_for(pi, r, mode)
        delta = (1.0 if r["pc"] == "S" else -1.0 if r["pc"] == "H" else 0.0) - (p["S"] - p["H"])
        res[r["raceId"]] = {hid: (y - p3_of(coef, q, r["nStart"]), delta, r["pc"]) for hid, (y, q) in idx[r["raceId"]].items()}
    return res


def ridge2(ents, k):
    """ents: [(r, δ)]。(X'X + kI) b = X'r の (切片 L, 傾き D, Σδ²)。"""
    s1 = len(ents)
    if s1 == 0:
        return 0.0, 0.0, 0.0
    sd_ = sum(e[1] for e in ents)
    sdd = sum(e[1] ** 2 for e in ents)
    sr = sum(e[0] for e in ents)
    sdr = sum(e[1] * e[0] for e in ents)
    a, b, d = s1 + k, sd_, sdd + k
    det = a * d - b * b
    return (d * sr - b * sdr) / det, (a * sdr - b * sr) / det, sdd


def horse_ents(h, res):
    return [res[rid][h["horseId"]] for _d, rid in h["pri"] if rid in res and h["horseId"] in res[rid]]


def simple_diff(ents, k):
    """単純な S − H の差(記述用)。ペース区分ごとの残差の和を (走の数 + k) で縮めた値の差。"""
    sS = [e[0] for e in ents if e[2] == "S"]
    sH = [e[0] for e in ents if e[2] == "H"]
    return sum(sS) / (len(sS) + k) - sum(sH) / (len(sH) + k)


def estimate_k(table, res):
    """経験ベイズのモーメント法(計画 §4)。WARM の全走から、馬ごとに r を [1, δ] に最小二乗で当てる。"""
    runs = collections.defaultdict(list)
    for r in table:
        if r["raceId"] in res and in_period(r, WARM):
            for hid, (rr, dl, _pc) in res[r["raceId"]].items():
                runs[hid].append((r["date"], rr, dl))
    info = []
    sse_tot = df_tot = 0.0
    for hid, v in runs.items():
        n = len(v)
        if n < 4:
            continue
        md = sum(x[2] for x in v) / n
        mr = sum(x[1] for x in v) / n
        sxx = sum((x[2] - md) ** 2 for x in v)
        if sxx < 0.5:
            continue
        sxy = sum((x[2] - md) * (x[1] - mr) for x in v)
        b = sxy / sxx
        sse = sum((x[1] - mr) ** 2 for x in v) - b * b * sxx
        sse_tot += sse
        df_tot += n - 2
        info.append((b, sxx))
    sig2 = sse_tot / df_tot
    num = sum(sxx ** 2 * (b * b - sig2 / sxx) for b, sxx in info)
    den = sum(sxx ** 2 for b, sxx in info)
    tau2 = num / den
    k_raw = sig2 / tau2 if tau2 > 0 else None
    k = K_MAX if k_raw is None else min(K_MAX, max(K_MIN, k_raw))
    return {"horses": len(info), "sigma2": sig2, "tau2": tau2, "k_raw": k_raw, "k": k}, runs


def reliability(runs, k):
    """走が 4 本以上で Sxx ≥ 0.5 の馬の走を、日付順に交互に 2 つへ分け、D・L の相関を見る(過去走だけ)。"""
    da, db, la, lb = [], [], [], []
    for v in runs.values():
        if len(v) < 4:
            continue
        v = sorted(v)
        md = sum(x[2] for x in v) / len(v)
        if sum((x[2] - md) ** 2 for x in v) < 0.5:
            continue
        a = ridge2([(x[1], x[2]) for x in v[0::2]], k)
        b = ridge2([(x[1], x[2]) for x in v[1::2]], k)
        la.append(a[0]); da.append(a[1]); lb.append(b[0]); db.append(b[1])
    return {"horses": len(da), "corr_D": corr(da, db), "corr_L": corr(la, lb),
            "note": "走を日付順に交互に 2 つへ分けた D(傾き)・L(切片)の相関(縮めの強さ k を使ったリッジ)"}


# ---------- 展開の予想 ----------
def forecast_feats(r):
    hs = r["horses"]
    kn = [h for h in hs if h["style"]]
    f = sum(1 for h in kn if h["style"] in c.FRONT) / len(kn)
    nesc = sum(1 for h in kn if h["style"] == "逃げ")
    n1 = sum(1 for h in hs if h["d1"])
    n2 = sum(1 for h in hs if h["d2"])
    tf, tb = c.top3_comp(r)
    fav = [h for h in hs if h["ninki"] == 1]
    favf = 1.0 if fav and fav[0]["style"] in c.FRONT else 0.0
    hcp = 1.0 if r["weightType"] == "ハンデ" else 0.0
    return [f, float(nesc), float(n1), float(n2), float(tf), float(tb), favf, float(r["nStart"]), hcp]


def clip_logit(p):
    p = min(0.999, max(0.001, p))
    return math.log(p / (1 - p))


NB = 3  # 基準の列の数: [1, logit π_H, logit π_S]


def design(r, mu, sdv, pi):
    p = pi_for(pi, r, "new")
    x = [1.0, clip_logit(p["H"]), clip_logit(p["S"])]
    ft = forecast_feats(r)
    return x, [(v - m) / s for v, m, s in zip(ft, mu, sdv)]


def linpred(w, xb, xf, full):
    z = sum(wi * xi for wi, xi in zip(w[:NB], xb))
    if full:
        z += sum(wi * xi for wi, xi in zip(w[NB:], xf))
    return z


def fit_forecast(table, pi):
    rs = [r for r in eligible(table, WARM) if r["pc"]]
    fts = [forecast_feats(r) for r in rs]
    mu = [sum(f[i] for f in fts) / len(fts) for i in range(9)]
    sdv = [sd([f[i] for f in fts]) or 1.0 for i in range(9)]
    Xfull, Xbase = [], []
    for r in rs:
        xb, xf = design(r, mu, sdv, pi)
        Xfull.append(xb + xf)
        Xbase.append(xb)
    out = {"mu": mu, "sd": sdv, "n_races": len(rs)}
    for tgt in ("H", "S"):
        y = [1.0 if r["pc"] == tgt else 0.0 for r in rs]
        out["w_full_" + tgt] = fit_ridge_logit(Xfull, y)
        out["w_base_" + tgt] = fit_ridge_logit(Xbase, y)
    return out


def g_of(r, fm, pi):
    xb, xf = design(r, fm["mu"], fm["sd"], pi)
    zH = linpred(fm["w_full_H"], xb, xf, True) - linpred(fm["w_base_H"], xb, xf, False)
    zS = linpred(fm["w_full_S"], xb, xf, True) - linpred(fm["w_base_S"], xb, xf, False)
    return zH - zS


# ---------- レース記録 ----------
def build_recs(races, coef, res, res_old, k, fm, gcut, pi):
    recs = []
    for r in races:
        g = g_of(r, fm, pi)
        direction = -1 if g <= gcut[0] else (1 if g >= gcut[1] else 0)
        hs = []
        for h, x in zip(r["horses"], a683.feats(r)):
            p3 = None if x is None else a683.sigmoid(coef[0] + coef[1] * x[0] + coef[2] * x[1])
            ents = horse_ents(h, res)
            L, D, sdd = ridge2([(e[0], e[1]) for e in ents], k)
            hs.append({"band": band_of(h["ninki"]), "p3": p3, "y": 1 if a683.is_top3(h) else 0, "umaban": h["umaban"],
                       "L": L, "D": D, "sdd": sdd, "alt": simple_diff(ents, k) if ents else 0.0,
                       "Dold": ridge2([(e[0], e[1]) for e in horse_ents(h, res_old)], k)[1]})
        recs.append({"raw": r, "g": g, "dir": direction, "horses": hs})
    return recs


def fit_value(rec, h, key="D"):
    return -rec["dir"] * h[key]


def quantile_cuts(recs, key="D"):
    vals = sorted(fit_value(rec, h, key) for rec in recs if rec["dir"] != 0 for h in rec["horses"]
                  if h["p3"] is not None and h["band"] is not None)
    return [c.percentile(vals, 1 / 3), c.percentile(vals, 2 / 3)]


def group_of(v, cuts):
    if v >= cuts[1]:
        return "fit"
    if v <= cuts[0]:
        return "unfit"
    return None


def tally(recs, cuts, key="D", dvals=None, split=None):
    """セルごとの [n, O, E, V]。dvals(rec -> 並べ替えた値の列)があればそれを D の代わりに使う。split(rec) が真のレースだけ。"""
    acc = {k_: [0, 0, 0.0, 0.0] for k_ in CELLS}
    for ri, rec in enumerate(recs):
        if rec["dir"] == 0 or (split is not None and not split(rec)):
            continue
        vals = dvals(ri, rec) if dvals else None
        for hi, h in enumerate(rec["horses"]):
            if h["p3"] is None or h["band"] is None:
                continue
            v = -rec["dir"] * (vals[hi] if vals else h[key])
            gp = group_of(v, cuts)
            if gp is None:
                continue
            a = acc[(gp, h["band"])]
            a[0] += 1
            a[1] += h["y"]
            a[2] += h["p3"]
            a[3] += h["p3"] * (1 - h["p3"])
    return acc


def stat(a):
    return a683.stat(a)


# ---------- prep ----------
def run_prep(table_path, out_dir):
    table = c.load(table_path)
    idx = build_index(table)
    ex = eligible(table, EXPLORE)
    rows = []
    for r in ex:
        for h, x in zip(r["horses"], a683.feats(r)):
            if x is not None:
                rows.append((x[0], x[1], 1.0 if a683.is_top3(h) else 0.0))
    coef = a683.fit_logit(rows)
    cal_o = sum(r_[2] for r_ in rows)
    cal_e = sum(a683.sigmoid(coef[0] + coef[1] * r_[0] + coef[2] * r_[1]) for r_ in rows)
    pi, pi_counts = compute_pi(table)
    res = build_res(table, idx, coef, pi)
    res_old = build_res(table, idx, coef, pi, "old")
    kinfo, runs = estimate_k(table, res)
    k = kinfo["k"]
    rel = reliability(runs, k)
    fm = fit_forecast(table, pi)
    gs = sorted(g_of(r, fm, pi) for r in ex)
    gcut = [c.percentile(gs, 1 / 3), c.percentile(gs, 2 / 3)]
    recs = build_recs(ex, coef, res, res_old, k, fm, gcut, pi)
    cuts = quantile_cuts(recs, "D")
    cuts_alt = quantile_cuts(recs, "alt")
    cuts_old = quantile_cuts(recs, "Dold")
    # 展開の予想と実際の paceClass の一致(探索 B の中。当てはめ範囲を含むので当てはめ内)
    agree = {}
    for lab, d in (("S寄り", -1), ("中", 0), ("H寄り", 1)):
        sel = [rec for rec in recs if rec["dir"] == d and rec["raw"]["pc"]]
        n = len(sel)
        agree[lab] = {"races": n,
                      "actual": {p: round(sum(1 for rec in sel if rec["raw"]["pc"] == p) / n, 4) for p in "SMH"} if n else None}
    dir_counts = {lab: sum(1 for rec in recs if rec["dir"] == d) for lab, d in (("S寄り", -1), ("中", 0), ("H寄り", 1))}
    # 基準だけのモデルが予想する S・H の割合(群ごとの平均)
    for lab, d in (("S寄り", -1), ("中", 0), ("H寄り", 1)):
        sel = [rec for rec in recs if rec["dir"] == d and rec["raw"]["pc"]]
        if sel:
            ps, ph = [], []
            for rec in sel:
                xb, xf = design(rec["raw"], fm["mu"], fm["sd"], pi)
                ph.append(a683.sigmoid(linpred(fm["w_base_H"], xb, xf, False)))
                ps.append(a683.sigmoid(linpred(fm["w_base_S"], xb, xf, False)))
            agree[lab]["base_expected"] = {"S": round(sum(ps) / len(ps), 4), "H": round(sum(ph) / len(ph), 4)}
    # k の 0.5 倍・2 倍での D の変化(探索 B の全馬の点)
    sens = {}
    base_ds = None
    for lab, kk in (("0.5k", k * 0.5), ("1k", k), ("2k", k * 2)):
        ds = [ridge2([(e[0], e[1]) for e in horse_ents(h, res)], kk)[1] for r in ex for h in r["horses"]]
        if base_ds is None:
            base_ds = ds if lab == "1k" else None
        sens[lab] = {"k": kk, "sd_D": sd(ds), "ds": ds}
    ref = sens["1k"]["ds"]
    for lab in sens:
        sens[lab]["corr_with_1k"] = corr(sens[lab]["ds"], ref)
    for lab in sens:
        del sens[lab]["ds"]
    sdd_all = sorted(ridge2([(e[0], e[1]) for e in horse_ents(h, res)], k)[2] for r in ex for h in r["horses"])
    out = {
        "explore": EXPLORE, "warm": WARM, "confirm": CONFIRM,
        "coef": coef, "coef_B_ref": COEF_B_REF,
        "calibration_explore": {"horses": len(rows), "O": cal_o, "E": round(cal_e, 2)},
        "pi": pi, "pi_counts": pi_counts, "m_shrink": M_SHRINK,
        "k": kinfo, "k_sensitivity": sens, "reliability": rel,
        "forecast": fm, "feat_names": FEAT_NAMES, "g_cut": gcut,
        "forecast_agreement_in_sample": agree, "direction_counts": dir_counts,
        "fit_cut": cuts, "fit_cut_alt": cuts_alt, "fit_cut_old": cuts_old,
        "sdd_quantiles_explore": {str(p): round(c.percentile(sdd_all, p), 4) for p in (0.1, 0.25, 0.5, 0.75, 0.9)},
        "races_explore": len(ex),
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "prep-results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("coef", [round(x, 4) for x in coef], "cal", out["calibration_explore"])
    print("k", kinfo, "reliability", rel)
    print("g_cut", gcut, "fit_cut", cuts, "dirs", dir_counts)
    print("agree", json.dumps(agree, ensure_ascii=False))
    print("k sens", sens)


def load_prep(out_dir):
    with open(os.path.join(out_dir, "prep-results.json"), encoding="utf-8") as f:
        return json.load(f)


def make_recs(table, period, prep):
    idx = build_index(table)
    pi = prep["pi"]
    res = build_res(table, idx, prep["coef"], pi)
    res_old = build_res(table, idx, prep["coef"], pi, "old")
    return build_recs(eligible(table, period), prep["coef"], res, res_old, prep["k"]["k"], prep["forecast"], prep["g_cut"], pi)


# ---------- 点の書き出し・分布 ----------
def write_scores(recs, path, cuts):
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for rec in recs:
            for h in rec["horses"]:
                v = fit_value(rec, h) if rec["dir"] != 0 else None
                f.write(json.dumps({"raceId": rec["raw"]["raceId"], "umaban": h["umaban"], "band": h["band"],
                                    "g": round(rec["g"], 5), "D": round(h["D"], 5), "L": round(h["L"], 5),
                                    "sdd": round(h["sdd"], 4), "fit": None if v is None else round(v, 5),
                                    "group": None if v is None else group_of(v, cuts)}, ensure_ascii=False) + "\n")


def dist_summary(recs):
    gs = sorted(rec["g"] for rec in recs)
    ds = sorted(h["D"] for rec in recs for h in rec["horses"])
    sdd = sorted(h["sdd"] for rec in recs for h in rec["horses"])
    q = lambda v: {str(p): round(c.percentile(v, p), 4) for p in (0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99)}
    hist = lambda v, lo, hi, nb: [sum(1 for x in v if lo + (hi - lo) * i / nb <= x < lo + (hi - lo) * (i + 1) / nb) for i in range(nb)]
    return {"races": len(recs), "horses": len(ds), "g_quantiles": q(gs), "D_quantiles": q(ds), "sdd_quantiles": q(sdd),
            "g_hist_-4_4_by_0.5": hist(gs, -4, 4, 16), "D_hist_-0.3_0.3_by_0.03": hist(ds, -0.3, 0.3, 20),
            "dir_counts": {"S寄り": sum(1 for r in recs if r["dir"] == -1), "中": sum(1 for r in recs if r["dir"] == 0),
                           "H寄り": sum(1 for r in recs if r["dir"] == 1)}}


def merge_json(path, key, val):
    cur = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            cur = json.load(f)
    cur[key] = val
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cur, f, ensure_ascii=False, indent=1)


# ---------- explore ----------
def cells_report(acc, comp_acc=None):
    out = []
    for k_ in CELLS:
        s = stat(acc[k_])
        d = {"cell": cname(k_), "group": k_[0], "band": k_[1], **s}
        d["p"] = a683.two_p(s["z"]) if s["z"] is not None else None
        d["tested"] = s["n"] >= MIN_N and s["z"] is not None
        opp = ("unfit" if k_[0] == "fit" else "fit", k_[1])
        d["opposite"] = stat(acc[opp])
        out.append(d)
    return out


def run_explore(table_path, out_dir, scores_out):
    prep = load_prep(out_dir)
    table = c.load(table_path)
    recs = make_recs(table, EXPLORE, prep)
    cuts = prep["fit_cut"]
    acc = tally(recs, cuts)
    cells = cells_report(acc)
    tested = [d for d in cells if d["tested"]]
    for d, q in zip(tested, a683.bh([d["p"] for d in tested])):
        d["q_bh"] = q
    # 記述: S 寄り・H 寄り別、ハンデ別、単純な S−H の差で同じ手続き、参考の案 B 係数(O/E のみ)
    by_dir = {}
    for lab, dd in (("S寄り", -1), ("H寄り", 1)):
        a = tally(recs, cuts, split=lambda rec, dd=dd: rec["dir"] == dd)
        by_dir[lab] = {cname(k_): stat(a[k_]) for k_ in CELLS}
    alt = tally(recs, prep["fit_cut_alt"], key="alt")
    alt_cells = {cname(k_): stat(alt[k_]) for k_ in CELLS}
    old = tally(recs, prep["fit_cut_old"], key="Dold")
    old_cells = {cname(k_): stat(old[k_]) for k_ in CELLS}
    # シャッフル
    live = [(ri, rec) for ri, rec in enumerate(recs) if rec["dir"] != 0]
    tested_keys = [(d["group"], d["band"]) for d in tested]
    rng = random.Random(SEED)
    maxz = []
    for _ in range(N_SHUFFLE):
        sh = {}
        for ri, rec in live:
            idxs = [i for i, h in enumerate(rec["horses"]) if h["p3"] is not None]
            vals = [rec["horses"][i]["D"] for i in idxs]
            rng.shuffle(vals)
            full = [h["D"] for h in rec["horses"]]
            for i, v in zip(idxs, vals):
                full[i] = v
            sh[ri] = full
        a = tally(recs, cuts, dvals=lambda ri, rec: sh.get(ri))
        zs = []
        for k_ in tested_keys:
            n, o, e, v = a[k_]
            if n > 0 and v > 0:
                zs.append(abs((o - e) / math.sqrt(v)))
        maxz.append(max(zs) if zs else 0.0)
    obs = max((abs(d["z"]) for d in tested), default=0.0)
    srt = sorted(maxz)
    shuffle = {"n_shuffle": N_SHUFFLE, "seed": SEED, "observed_max_abs_z": round(obs, 4),
               "null_p95": round(c.percentile(srt, 0.95), 4), "null_median": round(c.percentile(srt, 0.5), 4),
               "empirical_p": sum(1 for z in maxz if z >= obs - a683.EPS) / N_SHUFFLE}
    out = {"period": EXPLORE, "races": len(recs), "coef": prep["coef"], "k": prep["k"]["k"], "fit_cut": cuts,
           "cells": cells, "m_tested": len(tested), "by_direction": by_dir, "alt_simple_SH_diff": alt_cells, "alt_old_pi_D": old_cells,
           "shuffle": shuffle, "min_n": MIN_N, "bh_q": BH_Q}
    with open(os.path.join(out_dir, "explore-results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    merge_json(os.path.join(out_dir, "score-dist.json"), "explore", dist_summary(recs))
    write_scores(recs, scores_out, cuts)
    for d in cells:
        print(d["cell"], "n", d["n"], "O/E", d["ratio"], "z", d["z"], "tested", d["tested"], "q", d.get("q_bh"),
              "| opp O/E", d["opposite"]["ratio"], "z", d["opposite"]["z"])
    print(shuffle)


def run_fix(out_dir):
    with open(os.path.join(out_dir, "explore-results.json"), encoding="utf-8") as f:
        ex = json.load(f)
    cand = []
    for d in ex["cells"]:
        if d["tested"] and d.get("q_bh", 1.0) < BH_Q:
            over = d["ratio"] > 1
            cand.append({"cell": d["cell"], "group": d["group"], "band": d["band"],
                         "direction": "over" if over else "under",
                         "hypothesis_direction": over == EXPECT_OVER[d["group"]],
                         "explore": {"n": d["n"], "ratio": d["ratio"], "z": d["z"], "q_bh": d["q_bh"]}})
    out = {"rule": "n>=300 かつ BH q<0.05(plan §5。向きは問わない)", "m_tested": ex["m_tested"], "candidates": cand}
    with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("candidates", len(cand), [x["cell"] for x in cand])


# ---------- confirm ----------
def payout_map(r, kind):
    return {p["umaban"]: p["payout"] for p in r["payouts"][kind]}


def run_confirm(table_path, out_dir, scores_out):
    cpath = os.path.join(out_dir, "candidates.json")
    if not os.path.exists(cpath):
        sys.exit("candidates.json が無い: 確認の期間は開かない")
    with open(cpath, encoding="utf-8") as f:
        cand = json.load(f)
    if not cand["candidates"]:
        sys.exit("候補が 0 件: 確認の期間は開かない(plan §5)")
    if os.path.exists(os.path.join(out_dir, "confirm-results.json")):
        sys.exit("confirm-results.json が既にある: 確認は 1 回だけ")
    prep = load_prep(out_dir)
    table = c.load(table_path)
    recs = make_recs(table, CONFIRM, prep)
    cuts = prep["fit_cut"]
    acc = tally(recs, cuts)
    K = len(cand["candidates"])
    rows = []
    for cd in cand["candidates"]:
        s = stat(acc[(cd["group"], cd["band"])])
        over = cd["direction"] == "over"
        if s["z"] is None:
            p1 = 1.0
        else:
            p1 = a683.norm_sf(s["z"]) if over else a683.norm_sf(-s["z"])
        same = s["ratio"] is not None and ((s["ratio"] > 1) == over)
        rows.append({"cell": cd["cell"], "direction": cd["direction"], "hypothesis_direction": cd["hypothesis_direction"],
                     "explore": cd["explore"], "confirm": s, "p_one_sided": p1, "same_direction": same})
    for d, h in zip(rows, a683.holm([d["p_one_sided"] for d in rows])):
        d["p_holm"] = h
        d["survived"] = d["confirm"]["n"] >= MIN_N and d["same_direction"] and h < HOLM_ALPHA
    # 記述(検定しない): 全 6 セル、期間分割、S 寄り・H 寄り別、ハンデ別
    all_cells = cells_report(acc)
    early = lambda rec: rec["raw"]["date"] <= SPLIT_DATE
    late = lambda rec: rec["raw"]["date"] > SPLIT_DATE
    a_e, a_l = tally(recs, cuts, split=early), tally(recs, cuts, split=late)
    by_dir = {}
    for lab, dd in (("S寄り", -1), ("H寄り", 1)):
        a = tally(recs, cuts, split=lambda rec, dd=dd: rec["dir"] == dd)
        by_dir[lab] = {cname(k_): stat(a[k_]) for k_ in CELLS}
    hcp = {}
    for lab, fn in (("handicap", lambda rec: rec["raw"]["weightType"] == "ハンデ"), ("non_handicap", lambda rec: rec["raw"]["weightType"] != "ハンデ")):
        a = tally(recs, cuts, split=fn)
        hcp[lab] = {cname(k_): stat(a[k_]) for k_ in CELLS}
    alt = tally(recs, prep["fit_cut_alt"], key="alt")
    old = tally(recs, prep["fit_cut_old"], key="Dold")
    # 回収率(候補のセルのみ)
    roi = []
    for cd in cand["candidates"]:
        grp, rest = [], []
        for rec in recs:
            win, plc = payout_map(rec["raw"], "win"), payout_map(rec["raw"], "place")
            for h in rec["horses"]:
                if h["p3"] is None or h["band"] != cd["band"]:
                    continue
                row = (win.get(h["umaban"], 0) / 100.0, plc.get(h["umaban"], 0) / 100.0)
                gp = group_of(fit_value(rec, h), cuts) if rec["dir"] != 0 else None
                (grp if gp == cd["group"] else rest).append(row)
        d = {"cell": cd["cell"], "group_n": len(grp), "rest_n": len(rest)}
        for name, i in (("win", 0), ("place", 1)):
            g_, r_ = a683.roi_stats(grp, i), a683.roi_stats(rest, i)
            d[name] = {"group": g_ and {k: v for k, v in g_.items() if k != "var"},
                       "rest": r_ and {k: v for k, v in r_.items() if k != "var"}, "diff_z": a683.diff_z(g_, r_)}
        roi.append(d)
    out = {"period": CONFIRM, "races": len(recs), "k_candidates": K, "candidate_results": rows,
           "descriptive_all_cells": all_cells,
           "descriptive_split_2024-01..08-04": {cname(k_): stat(a_e[k_]) for k_ in CELLS},
           "descriptive_split_2024-08-05..": {cname(k_): stat(a_l[k_]) for k_ in CELLS},
           "descriptive_by_direction": by_dir, "descriptive_handicap_split": hcp,
           "descriptive_alt_simple_SH_diff": {cname(k_): stat(alt[k_]) for k_ in CELLS},
           "descriptive_alt_old_pi_D": {cname(k_): stat(old[k_]) for k_ in CELLS}, "roi": roi}
    with open(os.path.join(out_dir, "confirm-results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    merge_json(os.path.join(out_dir, "score-dist.json"), "confirm", dist_summary(recs))
    write_scores(recs, scores_out, cuts)
    for d in rows:
        print(d["cell"], d["direction"], d["confirm"], "p1", d["p_one_sided"], "holm", d["p_holm"], "survived", d["survived"])


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "prep":
        run_prep(sys.argv[2], sys.argv[3])
    elif cmd == "explore":
        run_explore(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "fix":
        run_fix(sys.argv[2])
    elif cmd == "confirm":
        run_confirm(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        sys.exit(__doc__)
