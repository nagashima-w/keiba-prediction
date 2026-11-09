#!/usr/bin/env python3
"""#684 計画用: ハナ候補の頭数 N の分布と、群の頭数(件数)だけを出す。
結果(finish・払戻・オッズ・人気から作る見込み)の列は読まない。人気(ninki)は帯の分類にだけ使う。
使い方: feature_counts.py <table.ndjson.gz>"""
import collections
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pace-mismatch-683"))
import common as c  # noqa: E402

DEFS = ("d1", "d2")


def band_of(ninki):
    if ninki is None:
        return None
    for name, (lo, hi) in c.BANDS.items():
        if lo <= ninki <= hi:
            return name
    return None


races = [r for r in c.load(sys.argv[1]) if c.in_period(r, c.EXPLORE) and c.exclusion_reason(r) is None]
print("探索の期間の対象レース", len(races))
for d in DEFS:
    ndist = collections.Counter(sum(1 for h in r["horses"] if h[d]) for r in races)
    print(d, "N の分布", sorted(ndist.items()))
    cnt = collections.Counter()
    for r in races:
        n = sum(1 for h in r["horses"] if h[d])
        for h in r["horses"]:
            b = band_of(h["ninki"])
            if b is None or not h["style"]:
                continue
            if n == 1 and h[d]:
                cnt[("H3a", b)] += 1
            if n <= 1 and h["style"] == "先行" and not h[d]:
                cnt[("H3b", b)] += 1
            if n >= 3 and h[d]:
                cnt[("H4a", b)] += 1
            if n >= 3 and h["style"] in c.BACK:
                cnt[("H4b", b)] += 1
    for k in sorted(cnt):
        print(d, k, cnt[k])

# H5: 1〜K 番人気のうち判定済みの馬に逃げ・先行がいない(判定済みが K=3 で 2 頭以上、K=5 で 3 頭以上)
MIN_KNOWN = {3: 2, 5: 3}
for K in (3, 5):
    cnt = collections.Counter()
    nrace = 0
    for r in races:
        top = [h for h in r["horses"] if h["ninki"] is not None and h["ninki"] <= K and h["style"]]
        if len(top) < MIN_KNOWN[K] or any(h["style"] in c.FRONT for h in top):
            continue
        nrace += 1
        for h in r["horses"]:
            b = band_of(h["ninki"])
            if b in ("4-9", "10+") and h["style"] in c.FRONT:
                cnt[b] += 1
    print("H5 K=%d" % K, "条件に当たるレース", nrace, dict(sorted(cnt.items())))
