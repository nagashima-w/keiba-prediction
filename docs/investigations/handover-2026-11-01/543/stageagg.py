import json, sys
from collections import defaultdict
R = json.load(open(sys.argv[1]))
H = [r for r in R if r["t"] == "horse"]
print("馬", len(H), "レース", len({r["race"] for r in H}))
def band(v, edges):
    for i, e in enumerate(edges):
        if v < e: return i
    return len(edges)
def lab(edges, i):
    lo = "" if i == 0 else edges[i-1]; hi = "" if i == len(edges) else edges[i]
    return f"{lo}〜{hi}"
def table(rows, key, edges, cols, title):
    print(f"\n### {title}")
    g = defaultdict(list)
    for r in rows: g[band(key(r), edges)].append(r)
    print("帯 | 件数 | " + " | ".join(c[0] for c in cols))
    for i in sorted(g):
        print(lab(edges, i), "|", len(g[i]), "|", " | ".join(c[1](g[i]) for c in cols))
f1 = lambda x: f"{x:.1f}"
# 1. 3 着内率
tot = lambda rs, k: sum(r[k] for r in rs if r[k] is not None)
table(H, lambda r: r["adj"], [0.1, 0.2, 0.3, 0.45, 0.6], [
    ("予測(3着内率)", lambda rs: f1(tot(rs, "adj"))), ("PL の 3 着内", lambda rs: f1(tot(rs, "pl_top3"))), ("実際", lambda rs: str(tot(rs, "placed")))], "馬ごと: 3 着内率の帯")
# 2. 単勝
Hw = [r for r in H if r["mkt"] is not None]
table(Hw, lambda r: r["win"], [0.03, 0.06, 0.1, 0.2, 0.35], [
    ("予測(PL の勝率)", lambda rs: f1(tot(rs, "win"))), ("市場", lambda rs: f1(tot(rs, "mkt"))), ("実際", lambda rs: str(tot(rs, "won")))], "馬ごと: 単勝の勝率(モデル)の帯")
table(Hw, lambda r: r["win"] / r["mkt"] if r["mkt"] else 0, [0.67, 0.9, 1.1, 1.5, 2.0, 3.0], [
    ("予測", lambda rs: f1(tot(rs, "win"))), ("市場", lambda rs: f1(tot(rs, "mkt"))), ("実際", lambda rs: str(tot(rs, "won")))], "馬ごと: 勝率 モデル ÷ 市場 の帯")
# 3. 組合せ
for t in ["wide", "quinella", "exacta", "trio", "trifecta"]:
    C = [r for r in R if r["t"] == t]
    if not C: continue
    print(f"\n## {t}: {len(C)} 組合せ・{len({r['race'] for r in C})} レース")
    table(C, lambda r: r["odds"], [5, 10, 20, 50, 100, 300], [
        ("予測", lambda rs: f1(tot(rs, "p"))), ("市場", lambda rs: f1(tot(rs, "mkt"))), ("実際", lambda rs: str(tot(rs, "hit")))], f"{t}: オッズの帯")
    table(C, lambda r: r["p"] / r["mkt"] if r["mkt"] else 0, [0.67, 0.9, 1.1, 1.5, 2.0, 3.0], [
        ("予測", lambda rs: f1(tot(rs, "p"))), ("市場", lambda rs: f1(tot(rs, "mkt"))), ("実際", lambda rs: str(tot(rs, "hit")))], f"{t}: 確率 モデル ÷ 市場 の帯")
# 4. EV の閾値ごとの仮想回収率(各組合せに 100 円ずつ。払戻があるレースだけ)
print("\n## EV の閾値ごとの仮想回収率(該当する全組合せに 100 円ずつ)")
print("券種 | " + " | ".join(f"EV≥{t}" for t in [1.0, 1.2, 1.5, 2.0, 3.0]))
def vr(rs):
    n = len(rs); pay = sum(r["pay"] or 0 for r in rs)
    return f"{pay/(100*n)*100:.0f}% ({n})" if n else "-"
for t in ["wide", "quinella", "exacta", "trio", "trifecta"]:
    C = [r for r in R if r["t"] == t and r["hasPay"]]
    print(t, "|", " | ".join(vr([r for r in C if r["p"] * r["odds"] >= th]) for th in [1.0, 1.2, 1.5, 2.0, 3.0]))
W = [r for r in Hw if r["final_odds"]]
print("win |", " | ".join((lambda rs: f"{sum(r['final_odds'] for r in rs if r['won'])/len(rs)*100:.0f}% ({len(rs)})" if rs else "-")([r for r in W if r["win"] * r["odds"] >= th]) for th in [1.0, 1.2, 1.5, 2.0, 3.0]))
P = [r for r in H if r["place_odds_min"] and r["place_payout"] is not None or (r["place_odds_min"] and not r["placed"])]
print("place |", " | ".join((lambda rs: f"{sum((r['place_payout'] or 0) for r in rs if r['placed'])/(100*len(rs))*100:.0f}% ({len(rs)})" if rs else "-")([r for r in P if r["adj"] * r["place_odds_min"] >= th]) for th in [1.0, 1.2, 1.5, 2.0, 3.0]))
