import json, sys, random
from collections import defaultdict
res = json.load(open(sys.argv[1]))
caps = list(res[0]["v"].keys()); base = "3000"
for label, since in [("全期間 9/3〜10/25", "0"), ("上限 3,000 円の期間 10/17〜10/25", "20261017")]:
    rows = [r for r in res if r["date"] >= since and all(r["v"][c] is not None for c in caps)]
    print(f"\n## {label}: {len(rows)} レース・{len({r['date'] for r in rows})} 日")
    print("上限 | 賭け金 | 払戻 | 回収率 | 収支 | 点数 | 的中 | 1日平均 | 1日最大 | 最悪の日 | 回収率の差(3,000 円比 95%)")
    random.seed(1)
    for c in caps:
        st = sum(r["v"][c]["stake"] for r in rows); rt = sum(r["v"][c]["ret"] for r in rows)
        n = sum(r["v"][c]["n"] for r in rows); h = sum(r["v"][c]["hits"] for r in rows)
        day = defaultdict(lambda: [0, 0])
        for r in rows: day[r["date"]][0] += r["v"][c]["stake"]; day[r["date"]][1] += r["v"][c]["ret"]
        ds = [v[0] for v in day.values()]; worst = min(v[1] - v[0] for v in day.values())
        if c == base: ci = "(基準)"
        else:
            d = []
            for _ in range(2000):
                smp = [rows[random.randrange(len(rows))] for _ in rows]
                s1 = sum(x["v"][c]["stake"] for x in smp); r1 = sum(x["v"][c]["ret"] for x in smp)
                s0 = sum(x["v"][base]["stake"] for x in smp); r0 = sum(x["v"][base]["ret"] for x in smp)
                if s1 and s0: d.append(r1 / s1 - r0 / s0)
            d.sort(); ci = f"{d[int(.025*len(d))]*100:+.1f}〜{d[int(.975*len(d))]*100:+.1f}pt"
        print(f"{c} | {st} | {rt:.0f} | {rt/st*100:.1f}% | {rt-st:+.0f} | {n} | {h} | {sum(ds)/len(ds):.0f} | {max(ds)} | {worst:+.0f} | {ci}")
