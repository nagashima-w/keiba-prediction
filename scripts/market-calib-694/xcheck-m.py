"""Python の式の m を、TS の `formulaM` と突き合わせるための入力を書く(評価期間の無作為 60 レース × 5 式)。
使い方: python3 -I xcheck-m.py <hist2021> <hist> <fit-coef.json> <out.json>"""
import json, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calib as C
h2021, hist, coef, out = sys.argv[1:5]
fc = json.load(open(coef))
races, _ = C.load_races([h2021, hist])
ev = C.in_period(races, C.EVAL)
random.Random(694).shuffle(ev)
ev = ev[:60]
res = []
for f in C.FORMULAS:
    for r, m in zip(ev, C.predict(f, fc["coef"][f], fc["knots"], ev)):
        res.append({"f": f, "odds": [float(x) for x in r["odds"]], "m": [float(x) for x in m]})
json.dump(res, open(out, "w"))
print(len(res), "cases")
