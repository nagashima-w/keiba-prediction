#!/usr/bin/env python3
"""#654 report.md の表を results-first.json・results-second.json・candidates.json・judgement-second.json から出す。

  python3 -I scripts/payout-patterns-654/report-tables.py docs/investigations/payout-patterns-654

テストは付けない(表の整形だけ。数は run.ts の出力をそのまま写す)。
"""

import json
import re
import sys
from collections import defaultdict

d = sys.argv[1]
first = json.load(open(f"{d}/results-first.json", encoding="utf-8"))
second = json.load(open(f"{d}/results-second.json", encoding="utf-8"))
cand = json.load(open(f"{d}/candidates.json", encoding="utf-8"))
judge = json.load(open(f"{d}/judgement-second.json", encoding="utf-8"))["judgement"]

F1 = {x["id"]: x for x in first["forms"]}
F2 = {x["id"]: x for x in second["forms"]}
C1 = {x["id"]: x for x in first["conditions"]}
C2 = {x["id"]: x for x in second["conditions"]}
J = {(x["family"], x["id"]): x for x in judge}
CAND = {(x["family"], x["id"]): x for x in cand["candidates"]}


def f(x, n=3):
    return "-" if x is None or (isinstance(x, float) and x != x) else f"{x:.{n}f}"


def ci(x):
    return f"[{f(x['lo'])}, {f(x['hi'])}]"


def ae(x):
    return f"{x['hits']}/{f(x['expectedHits'], 0)} ({f(x['hits'] / x['expectedHits'], 2)})"


def aed(x):
    return f"{f(x['hits'] / x['expectedHitsDiscounted'], 2)}"


print("### 水準(的中組合せの R·p/100 の平均。1−t に近ければ控除率の仮定と q の水準が合っている)")
print("| 券種 | 1−t | 前半 的中 | 前半 平均 | 後半 的中 | 後半 平均 |")
print("|---|---|---|---|---|---|")
for bet in ["quinella", "wide", "exacta", "trio", "trifecta"]:
    a = first["levelCheck"][bet]
    b = second["levelCheck"][bet]
    print(f"| {bet} | {f(a['oneMinusT'])} | {a['n']} | {f(a['meanRp'])} | {b['n']} | {f(b['meanRp'])} |")

print()
print("### 基準の形(前半 → 後半)")
print("| 形 | 点数/レース | 前半 N | 前半 ROI [95%] | 前半 A/E(Harville) | 前半 A/E(割引) | 後半 N | 後半 ROI [95%] | 後半 A/E(Harville) | 後半 A/E(割引) | 配当の比 前/後 |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
base_ids = [x["id"] for x in first["forms"] if not re.search(r":[RQ]:", x["id"])]
for i in base_ids:
    a, b = F1[i], F2[i]
    print(
        f"| {i} | {f(a['ticketsPerRace'], 1)} | {a['races']} | {f(a['roi'])} {ci(a)} | {ae(a)} | {aed(a)} | {b['races']} | {f(b['roi'])} {ci(b)} | {ae(b)} | {aed(b)} | {f(a['fairRatio'], 2)}/{f(b['fairRatio'], 2)} |"
    )

print()
print("### F2(的中数の比)の候補を人気帯の形でまとめたもの(候補 159。後半で残った数と、実際/見込みの和)")
print("| 帯の族 | 組合せの中で最も人気の低い帯 | 向き | 候補 | 残った | 前半 実際/見込み(比) | 後半 実際/見込み(比) | ROI の範囲(後半) |")
print("|---|---|---|---|---|---|---|---|")
tab = defaultdict(lambda: [0, 0, 0, 0.0, 0, 0.0, []])
for (fam, cid), x in CAND.items():
    if fam != "F2":
        continue
    jj = J[(fam, cid)]
    bands = re.findall(r"[RQ][1-5]", cid)
    worst = max(int(b[1]) for b in bands) if bands else 0
    bfam = bands[0][0] if bands else "帯によらない形"
    t = tab[(bfam, worst, x["direction"])]
    t[0] += 1
    t[1] += 1 if jj["survived"] else 0
    t[2] += x["firstHalf"]["hits"]
    t[3] += x["firstHalf"]["expectedHits"]
    t[4] += jj["hits"]
    t[5] += jj["expectedHits"]
    t[6].append(jj["roi"])
for key in sorted(tab, key=lambda k: (k[0], k[1], k[2])):
    t = tab[key]
    worst = {0: "-", 1: "1 番人気 / q≥0.30", 2: "2〜3 番 / 0.15〜0.30", 3: "4〜6 番 / 0.07〜0.15", 4: "7〜10 番 / 0.03〜0.07", 5: "11 番〜 / q<0.03"}[key[1]]
    print(
        f"| {key[0]} | {worst} | {'+' if key[2] > 0 else '−'} | {t[0]} | {t[1]} | {t[2]}/{f(t[3], 0)} ({f(t[2] / t[3], 2)}) | {t[4]}/{f(t[5], 0)} ({f(t[4] / t[5], 2)}) | {f(min(t[6]), 2)}〜{f(max(t[6]), 2)} |"
    )

print()
print("### F3(条件の万馬券の比)の候補 13 件(前半 → 後半)。参考に、期間全体の三連複・ワイドの比を最後に置く")
print("| 条件 | 券種 | 前半 N | 前半 実際/見込み(比) | 前半 割引の見込み | 後半 N | 後半 実際/見込み(比) | 後半 割引の見込み | z(後半) | BH q | 残る |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for (fam, cid), x in CAND.items():
    if fam != "F3":
        continue
    a, b, jj = C1[cid], C2[cid], J[(fam, cid)]
    print(
        f"| {a['condition']['key']}={a['condition']['value']} | {a['bet']} | {a['races']} | {a['bigHits']}/{f(a['bigHitsExpected'], 0)} ({f(a['bigHits'] / a['bigHitsExpected'], 2)}) | {f(a['bigHitsExpectedDiscounted'], 0)} | {b['races']} | {b['bigHits']}/{f(b['bigHitsExpected'], 0)} ({f(b['bigHits'] / b['bigHitsExpected'], 2)}) | {f(b['bigHitsExpectedDiscounted'], 0)} | {f(jj['z'], 2)} | {f(jj['bhQ'], 4)} | {'○' if jj['survived'] else '×'} {'・'.join(jj['reasons'])} |"
    )
for bet in ["trio", "wide", "quinella", "exacta", "trifecta"]:
    for label, res in [("前半", first), ("後半", second)]:
        s = [c for c in res["conditions"] if c["bet"] == bet and c["condition"]["key"] == "courseType"]
        n = sum(c["races"] for c in s)
        bh = sum(c["bigHits"] for c in s)
        be = sum(c["bigHitsExpected"] for c in s)
        bd = sum(c["bigHitsExpectedDiscounted"] for c in s)
        print(f"| (全体) | {bet} | {label} {n} | {bh}/{f(be, 0)} ({f(bh / be, 2)}) | {f(bd, 0)} ({f(bh / bd, 2)}) | | | | | | |")

print()
print("### 前半で ROI が高かった形(F1 の目安に届かなかったもの)の後半")
print("| 形 | 点数/レース | 前半 N | 前半 的中 | 前半 ROI [95%] | 前半 上位1/3/5 除外 | 後半 N | 後半 的中 | 後半 ROI [95%] | 後半 上位1/3/5 除外 |")
print("|---|---|---|---|---|---|---|---|---|---|")
top = sorted([x for x in first["forms"] if x["races"] >= 300 and x["hits"] >= 30], key=lambda x: -x["roi"])[:10]
for a in top:
    b = F2[a["id"]]
    print(
        f"| {a['id']} | {f(a['ticketsPerRace'], 1)} | {a['races']} | {a['hits']} | {f(a['roi'])} {ci(a)} | {f(a['roiTop1'], 2)}/{f(a['roiTop3'], 2)}/{f(a['roiTop5'], 2)} | {b['races']} | {b['hits']} | {f(b['roi'])} {ci(b)} | {f(b['roiTop1'], 2)}/{f(b['roiTop3'], 2)}/{f(b['roiTop5'], 2)} |"
    )

print()
print("### 後半で ROI が 1 を超えた形(事後の記述。候補ではない。N ≥ 300・的中 ≥ 30)")
print("| 形 | 点数/レース | 後半 N | 後半 的中 | 後半 ROI [95%] | 後半 上位1/3/5 除外 | 最大配当 | 前半 ROI [95%] | 前半 上位3 除外 |")
print("|---|---|---|---|---|---|---|---|---|")
for b in sorted([x for x in second["forms"] if x["races"] >= 300 and x["hits"] >= 30 and x["roi"] > 1], key=lambda x: -x["roi"]):
    a = F1[b["id"]]
    print(
        f"| {b['id']} | {f(b['ticketsPerRace'], 1)} | {b['races']} | {b['hits']} | {f(b['roi'])} {ci(b)} | {f(b['roiTop1'], 2)}/{f(b['roiTop3'], 2)}/{f(b['roiTop5'], 2)} | {b['maxPayout']} | {f(a['roi'])} {ci(a)} | {f(a['roiTop3'], 2)} |"
    )

print()
print("### 条件ごとの「全組合せ買い」の ROI(上位・下位 5。前半 → 後半。基準は 1−t)")
print("| 条件 | 券種 | 前半 N | 前半 ROI [95%] | 後半 N | 後半 ROI [95%] |")
print("|---|---|---|---|---|---|")
cs = [c for c in first["conditions"] if c["races"] >= 200]
for c in sorted(cs, key=lambda c: -c["allRoi"])[:5] + sorted(cs, key=lambda c: c["allRoi"])[:5]:
    b = C2[c["id"]]
    print(
        f"| {c['condition']['key']}={c['condition']['value']} | {c['bet']} | {c['races']} | {f(c['allRoi'])} [{f(c['allRoiLo'])}, {f(c['allRoiHi'])}] | {b['races']} | {f(b['allRoi'])} [{f(b['allRoiLo'])}, {f(b['allRoiHi'])}] |"
    )
