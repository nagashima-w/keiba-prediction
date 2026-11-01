import json, sys, random
from collections import defaultdict
res = json.load(open(sys.argv[1]))
keys = list(res[0]["v"].keys())
base = "20000|row"
# 全設定で再計算できたレースだけ(対にして比べる)
rows = [r for r in res if all(r["v"][k] is not None for k in keys)]
print("races", len(res), "comparable", len(rows), "days", len({r["date"] for r in rows}))
def summ(k):
    st = sum(r["v"][k]["stake"] for r in rows); rt = sum(r["v"][k]["ret"] for r in rows)
    n = sum(r["v"][k]["n"] for r in rows); hit = sum(r["v"][k]["hits"] for r in rows)
    bet_races = sum(1 for r in rows if r["v"][k]["stake"] > 0)
    day = defaultdict(lambda: [0, 0])
    for r in rows:
        day[r["date"]][0] += r["v"][k]["stake"]; day[r["date"]][1] += r["v"][k]["ret"]
    ds = [v[0] for v in day.values()]; dl = [v[0] - v[1] for v in day.values()]
    return dict(stake=st, ret=rt, roi=rt / st if st else 0, n=n, hit=hit, races=bet_races,
                day_mean=sum(ds) / len(ds), day_max=max(ds), worst_day_loss=max(dl), days=len(ds))
random.seed(1)
def boot(k, B=2000):
    idx = range(len(rows)); diffs = []
    for _ in range(B):
        smp = [rows[random.randrange(len(rows))] for _ in idx]
        s1 = sum(r["v"][k]["stake"] for r in smp); r1 = sum(r["v"][k]["ret"] for r in smp)
        s0 = sum(r["v"][base]["stake"] for r in smp); r0 = sum(r["v"][base]["ret"] for r in smp)
        if s1 and s0: diffs.append(r1 / s1 - r0 / s0)
    diffs.sort(); return diffs[int(0.025 * len(diffs))], diffs[int(0.975 * len(diffs))]
print("設定 | 賭け金 | 払戻 | 回収率 | 点数 | 買ったレース | 1日平均 | 1日最大 | 最悪の日の負け | 回収率の差(20000|row 比 95%)")
for k in keys:
    s = summ(k); lo, hi = (0, 0) if k == base else boot(k)
    print(f"{k} | {s['stake']} | {s['ret']:.0f} | {s['roi']*100:.1f}% | {s['n']} | {s['races']} | {s['day_mean']:.0f} | {s['day_max']} | {s['worst_day_loss']:.0f} | {lo*100:+.1f}〜{hi*100:+.1f}pt")
