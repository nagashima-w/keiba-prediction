# #689 段 1 の件数(結果の 3着内・払戻とは突き合わせない)。使い方: SC=<scratchpad> python3 -I <このファイル>(リポジトリのルートで)
import sys, os, collections
sys.path.insert(0, "scripts/pace-mismatch-683")
import common as c
SC = os.environ["SC"]
tab = c.load(SC + "/h687/table687.ndjson.gz")
P = {"explore": ("2022-01-01", "2023-12-31"), "confirm": ("2024-01-01", "2026-11-01")}
cnt = collections.defaultdict(collections.Counter)
for r in tab:
    k = next((n for n, p in P.items() if p[0] <= r["date"] <= p[1]), None)
    if not k or c.exclusion_reason(r):
        continue
    cnt[k]["races"] += 1
    fav = [h for h in r["horses"] if h["ninki"] == 1 and h["odds"]]
    cnt[k]["fav_n=%d" % len(fav)] += 1
    if not fav:
        continue
    f = min(fav, key=lambda h: h["umaban"])
    if 1.0 <= f["odds"] < 2.0: cnt[k]["band1"] += 1
    elif 2.0 <= f["odds"] < 3.0: cnt[k]["band2"] += 1
    else: continue
    cnt[k]["hcp"] += r["weightType"] == "ハンデ"
    cnt[k]["ge16"] += r["nStart"] >= 16
    cnt[k]["kok_fuku"] += r["venue"] in ("小倉", "福島")
    o2 = [h for h in r["horses"] if h["ninki"] == 2 and h["odds"]]
    cnt[k]["no_second"] += not o2
for k in P: print(k, dict(cnt[k]))
