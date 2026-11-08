# 段 1 の件数・検出力の目安の道具(結果の 3着内と材料の関係は集計しない)。使い方: SC=<scratchpad> python3 -I <このファイル>(リポジトリのルートで。table687 などのパスは SC 以下の想定)
# 市場のみ(結果は読まない): 選ぶ1頭の p3 の平均と、O/E の標準誤差の目安
import sys, os, math, json, collections
sys.path.insert(0, "scripts/pace-mismatch-683"); import common as c
SC = os.environ["SC"]
coef = json.load(open("docs/investigations/pace-fit-687/prep-results.json"))["coef"]; print("coef", coef)
tab = c.load(SC + "/h687/table687.ndjson.gz")
P = {"explore": ("2022-01-01", "2023-12-31"), "confirm": ("2024-01-01", "2026-11-01")}
a, b, cc = coef if isinstance(coef, list) else (coef["a"], coef["b"], coef["c"])
def p3(q, n): z = a + b * math.log(q / (1 - q)) + cc * math.log(n); return 1 / (1 + math.exp(-z))
for k, p in P.items():
    out = collections.defaultdict(lambda: [0, 0.0, 0.0])
    for r in tab:
        if not (p[0] <= r["date"] <= p[1]) or c.exclusion_reason(r): continue
        hs = [h for h in r["horses"] if h["odds"]]; tot = sum(1 / h["odds"] for h in hs); n = len(hs)
        cand = sorted([h for h in hs if h["ninki"] >= 6], key=lambda h: h["odds"])
        for name, sel in (("基準1頭(最小オッズ)", cand[:1]), ("基準1頭 6-9のみ", [h for h in cand if h["ninki"] <= 9][:1]), ("10+の最小オッズ1頭", [h for h in cand if h["ninki"] >= 10][:1])):
            for h in sel:
                pp = p3(1 / h["odds"] / tot, n); o = out[name]; o[0] += 1; o[1] += pp; o[2] += pp * (1 - pp)
    for name, (n, E, V) in out.items():
        print(k, name, "n", n, "E", round(E, 1), "meanp3", round(E / n, 4), "SE(O/E)", round(math.sqrt(V) / E, 4))
