# 事前登録(#526 2026-10-30 のコメント)どおり: 開催日を 1 日ずつ抜く交差検証で、prior の logit に相性・乗り替わりを足したときの Δ を測る。
import json, sys, math, random
exec(open(sys.argv[2] + "/logit_fit.py").read())
R = json.load(open(sys.argv[1]))
lg = lambda p: math.log(min(1-1e-6, max(1e-6, p)) / (1 - min(1-1e-6, max(1e-6, p))))
base = lambda r: [1, lg(r['prior'])]
cands = {'相性': lambda r: [r['aff'] or 0.0, 1 if r['aff'] is not None else 0], '乗り替わり': lambda r: [r['switch']]}
def prob(b, x): return min(1-1e-9, max(1e-9, 1/(1+math.exp(-sum(bj*xj for bj, xj in zip(b, x))))))
D = sorted({r['date'] for r in R}); byd = {d: [i for i, r in enumerate(R) if r['date'] == d] for d in D}
def cv(feat):
    ll = [0.0]*len(R); br = [0.0]*len(R)
    for d in D:
        tr = [r for r in R if r['date'] != d]
        b = fit([feat(r) for r in tr], [r['y'] for r in tr])
        for i in byd[d]:
            p = prob(b, feat(R[i])); y = R[i]['y']
            ll[i] = -(y*math.log(p) + (1-y)*math.log(1-p)); br[i] = (p - y)**2
    return ll, br
l0, b0 = cv(base)
print(f"rows={len(R)} days={len(D)} top3率={sum(r['y'] for r in R)/len(R):.3f} 基準の対数損失={sum(l0)/len(R):.5f}")
random.seed(5260)
for name, f in cands.items():
    feat = lambda r, f=f: base(r) + f(r)
    l1, b1 = cv(feat)
    d = [a - b for a, b in zip(l1, l0)]; db = [a - b for a, b in zip(b1, b0)]
    bs = []
    for _ in range(2000):
        idx = [i for _ in D for i in byd[random.choice(D)]]
        bs.append(sum(d[i] for i in idx) / len(idx))
    bs.sort()
    ball = fit([feat(r) for r in R], [r['y'] for r in R])
    print(f"{name}: Δlogloss={sum(d)/len(d):+.5f} 95%CI=[{bs[50]:+.5f},{bs[1949]:+.5f}] ΔBrier={sum(db)/len(db):+.5f} 係数(全行)={[round(v,3) for v in ball[2:]]} 基準の係数={[round(v,3) for v in ball[:2]]}")
