import json, sys, random
from collections import defaultdict
res = json.load(open(sys.argv[1])); names = list(res[0]["v"].keys())
rows = [r for r in res if all(r["v"][k] is not None for k in names)]
dates = sorted({r["date"] for r in rows}); mid = dates[len(dates)//2]
print(f"レース {len(rows)}・開催日 {len(dates)}(前半 〜{dates[len(dates)//2-1]}・後半 {mid}〜)。判定できない買い目(基準の設定): {sum(r['v']['base']['unj'] for r in rows)}")
byd = defaultdict(list)
for r in rows: byd[r["date"]].append(r)
def roi(rs, k):
    s = sum(r["v"][k]["stake"] for r in rs); return (sum(r["v"][k]["ret"] for r in rs) / s) if s else float("nan")
random.seed(543)
print("候補 | 賭け金 | 回収率 | 前半 | 後半 | 収支 | 点数 | 的中 | 1日平均 | 1日最大 | 差(基準比)の95%区間 | 基準を満たすか")
for k in names:
    st = sum(r["v"][k]["stake"] for r in rows); rt = sum(r["v"][k]["ret"] for r in rows)
    first = [r for r in rows if r["date"] < mid]; second = [r for r in rows if r["date"] >= mid]
    dsum = [sum(r["v"][k]["stake"] for r in byd[d]) for d in dates]
    if k == "base": ci = "—"; ok = "—"
    else:
        diffs = []
        for _ in range(5000):
            smp = [r for d in (random.choice(dates) for _ in dates) for r in byd[d]]
            a, b = roi(smp, k), roi(smp, "base")
            if a == a and b == b: diffs.append(a - b)
        diffs.sort(); lo, hi = diffs[int(.025*len(diffs))], diffs[int(.975*len(diffs))]
        ci = f"{lo*100:+.1f}〜{hi*100:+.1f}pt"
        ok = "満たす" if (roi(first, k) > roi(first, "base") and roi(second, k) > roi(second, "base") and lo > 0) else "満たさない"
    print(f"{k} | {st} | {rt/st*100:.1f}% | {roi(first,k)*100:.1f}% | {roi(second,k)*100:.1f}% | {rt-st:+.0f} | {sum(r['v'][k]['n'] for r in rows)} | {sum(r['v'][k]['hits'] for r in rows)} | {sum(dsum)/len(dsum):.0f} | {max(dsum)} | {ci} | {ok}")
