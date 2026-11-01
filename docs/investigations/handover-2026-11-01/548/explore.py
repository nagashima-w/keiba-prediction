# #548 掛け合わせの指標の探索(1 回目)。標準ライブラリだけで書く(numpy が無い)。
# 使い方: python3 -I explore.py <hist.ndjson.gz> [m(縮める強さ。既定 30)]
import gzip, json, math, sys, random
from collections import defaultdict

path = sys.argv[1]
M = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0

def dist_band(d):
    if d is None: return None
    return "S" if d <= 1400 else "M" if d <= 1800 else "I" if d <= 2200 else "L"

def frame_group(w):
    if w is None: return None
    return "in" if w <= 3 else "mid" if w <= 6 else "out"

def season(date):
    m = int(date[5:7]); return "spring" if m in (3,4,5) else "summer" if m in (6,7,8) else "autumn" if m in (9,10,11) else "winter"

races = [json.loads(l) for l in gzip.open(path, "rt")]
races = [r for r in races if r["kind"] == "central"]
races.sort(key=lambda r: (r["date"], r["raceId"]))

rows = []
last_run = {}  # horseId -> date(前走の日。データ内だけ)
for r in races:
    hs = [h for h in r["horses"] if h.get("finish") is not None and h.get("winOdds")]
    if len(hs) < 5: continue
    inv = sum(1 / h["winOdds"] for h in hs)
    for h in hs:
        q = (1 / h["winOdds"]) / inv
        prev = last_run.get(h["horseId"])
        interval = None
        if prev is not None:
            from datetime import date
            d0 = date.fromisoformat(prev); d1 = date.fromisoformat(r["date"])
            g = (d1 - d0).days; interval = "short" if g <= 21 else "mid" if g <= 56 else "long"
        rows.append(dict(
            date=r["date"], race=r["raceId"], venue=r["venueName"], surf=r["courseType"], dist=dist_band(r["distance"]),
            going=r["going"], cls=r["raceClass"], field=len(hs), jockey=h["jockeyId"], trainer=h["trainerId"], horse=h["horseId"],
            frame=frame_group(h["wakuban"]), interval=interval, season=season(r["date"]),
            q=q, odds=h["winOdds"], y=1 if h["finish"] <= 3 else 0, win=1 if h["finish"] == 1 else 0))
    for h in hs: last_run[h["horseId"]] = r["date"]

def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6); return math.log(p / (1 - p))
sig = lambda z: 1 / (1 + math.exp(-max(min(z, 35), -35)))

def fit_logreg(X, y, iters=25, ridge=1e-6):
    """ニュートン法。X は行ごとの特徴のリスト(切片を含む)。係数と標準誤差を返す。"""
    k = len(X[0]); b = [0.0] * k
    for _ in range(iters):
        g = [0.0] * k; H = [[0.0] * k for _ in range(k)]
        for xi, yi in zip(X, y):
            p = sig(sum(bj * xj for bj, xj in zip(b, xi))); w = p * (1 - p)
            for a in range(k):
                g[a] += (yi - p) * xi[a]
                for c in range(k): H[a][c] += w * xi[a] * xi[c]
        for a in range(k): H[a][a] += ridge
        step = solve(H, g)
        b = [bj + sj for bj, sj in zip(b, step)]
        if max(abs(s) for s in step) < 1e-8: break
    inv = invert(H)
    se = [math.sqrt(max(inv[a][a], 0)) for a in range(k)]
    return b, se

def solve(A, v):
    n = len(v); M_ = [row[:] + [v[i]] for i, row in enumerate(A)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(M_[r][i])); M_[i], M_[piv] = M_[piv], M_[i]
        if abs(M_[i][i]) < 1e-12: continue
        for r in range(n):
            if r != i:
                f = M_[r][i] / M_[i][i]
                for c in range(i, n + 1): M_[r][c] -= f * M_[i][c]
    return [M_[i][n] / M_[i][i] if abs(M_[i][i]) > 1e-12 else 0.0 for i in range(n)]

def invert(A):
    n = len(A); cols = []
    for j in range(n):
        e = [1.0 if i == j else 0.0 for i in range(n)]; cols.append(solve([r[:] for r in A], e))
    return [[cols[j][i] for j in range(n)] for i in range(n)]

def logloss(X, y, b):
    s = 0.0
    for xi, yi in zip(X, y):
        p = min(max(sig(sum(bj * xj for bj, xj in zip(b, xi))), 1e-9), 1 - 1e-9)
        s -= yi * math.log(p) + (1 - yi) * math.log(1 - p)
    return s / len(y)

# 1. 基準の予測(市場): y ~ 1 + logit(q) + log(頭数)
Xb = [[1.0, logit(r["q"]), math.log(r["field"])] for r in rows]
yb = [r["y"] for r in rows]
bb, _ = fit_logreg(Xb, yb)
for r, x in zip(rows, Xb):
    r["base"] = sum(a * c for a, c in zip(bb, x)); r["pb"] = sig(r["base"]); r["res"] = r["y"] - r["pb"]
print(f"行 {len(rows)}・レース {len(set(r['race'] for r in rows))}・期間 {rows[0]['date']}〜{rows[-1]['date']}・基準の係数 {[round(v,3) for v in bb]}")

# 2. 族の定義: 名前 → (キーの関数, 片方の族の名前のタプル)
K = lambda *fs: (lambda r: None if any(r[f] is None for f in fs) else tuple(r[f] for f in fs))
FAMILIES = {
    "jockey": (K("jockey"), ()), "trainer": (K("trainer"), ()), "horse": (K("horse"), ()),
    "venue": (K("venue"), ()), "surf": (K("surf"), ()), "dist": (K("dist"), ()), "going": (K("going"), ()),
    "frame": (K("frame"), ()), "interval": (K("interval"), ()), "season": (K("season"), ()), "cls": (K("cls"), ()),
    "jockey×venue": (K("jockey", "venue"), ("jockey", "venue")),
    "jockey×surf": (K("jockey", "surf"), ("jockey", "surf")),
    "jockey×dist": (K("jockey", "dist"), ("jockey", "dist")),
    "jockey×going": (K("jockey", "going"), ("jockey", "going")),
    "jockey×frame": (K("jockey", "frame"), ("jockey", "frame")),
    "trainer×venue": (K("trainer", "venue"), ("trainer", "venue")),
    "trainer×surf": (K("trainer", "surf"), ("trainer", "surf")),
    "trainer×dist": (K("trainer", "dist"), ("trainer", "dist")),
    "trainer×interval": (K("trainer", "interval"), ("trainer", "interval")),
    "trainer×season": (K("trainer", "season"), ("trainer", "season")),
    "trainer×cls": (K("trainer", "cls"), ("trainer", "cls")),
    "jockey×trainer": (K("jockey", "trainer"), ("jockey", "trainer")),
    "jockey×horse": (K("jockey", "horse"), ("jockey", "horse")),
}

# 3. 日ごとに、前の日までの読み残しだけで指標を作る(同じ日のレースは使わない)
acc = {f: defaultdict(lambda: [0.0, 0]) for f in FAMILIES}
by_date = defaultdict(list)
for r in rows: by_date[r["date"]].append(r)
for d in sorted(by_date):
    day = by_date[d]
    for r in day:
        for f, (kf, _) in FAMILIES.items():
            k = kf(r)
            if k is None: r["f_" + f] = 0.0; r["n_" + f] = 0; continue
            s, n = acc[f][k]; r["f_" + f] = s / (n + M); r["n_" + f] = n
    for r in day:
        for f, (kf, _) in FAMILIES.items():
            k = kf(r)
            if k is not None: a = acc[f][k]; a[0] += r["res"]; a[1] += 1

# 4. 評価: 後半の日(履歴がある程度たまってから)
dates = sorted(by_date); cut = dates[len(dates) // 2]
ev = [r for r in rows if r["date"] >= cut]
print(f"評価の行 {len(ev)}({cut} 以降)")
y = [r["y"] for r in ev]
X0 = [[1.0, r["base"]] for r in ev]
b0, _ = fit_logreg(X0, y); ll0 = logloss(X0, y, b0)
out = []
for f, (_, comps) in FAMILIES.items():
    Xc = [[1.0, r["base"]] + [r["f_" + c] for c in comps] for r in ev]
    bc, _ = fit_logreg(Xc, y); llc = logloss(Xc, y, bc)
    Xf = [x + [r["f_" + f]] for x, r in zip(Xc, ev)]
    bf, sef = fit_logreg(Xf, y); llf = logloss(Xf, y, bf)
    z = bf[-1] / sef[-1] if sef[-1] > 0 else 0.0
    covered = sum(1 for r in ev if r["n_" + f] >= 5) / len(ev)
    # 上位 10%(履歴 5 件以上)の馬に単勝 100 円
    cand = sorted([r for r in ev if r["n_" + f] >= 5], key=lambda r: -r["f_" + f])
    top = cand[: max(1, len(cand) // 10)] if cand else []
    roi = sum(r["odds"] for r in top if r["win"]) / len(top) if top else float("nan")
    top3_obs = sum(r["y"] for r in top); top3_exp = sum(r["pb"] for r in top)
    out.append((f, comps, (llc - llf) * 1000, z, covered, len(top), roi, top3_obs, top3_exp))
print("族 | 上乗せ(対数損失の改善×1000。片方の族を入れた上で) | z | 履歴5件以上の割合 | 上位10%の頭数 | 単勝回収率 | 3着内 実際/基準")
for f, comps, dll, z, cov, nt, roi, o, e in sorted(out, key=lambda t: -abs(t[3])):
    print(f"{f} | {dll:+.3f} | {z:+.2f} | {cov:.2f} | {nt} | {roi*100:.0f}% | {o}/{e:.1f}")
