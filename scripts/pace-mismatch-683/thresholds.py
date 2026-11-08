#!/usr/bin/env python3
"""#683 計画用: 探索の期間の対象レースについて、前に行きたい割合 f の分位点と件数だけを出す。
結果(finish・払戻)の列は一切読まない。使い方: thresholds.py <table.ndjson.gz>"""
import collections
import sys

import common as c

races = [r for r in c.load(sys.argv[1]) if c.in_period(r, c.EXPLORE)]
reasons = collections.Counter()
elig = []
for r in races:
    why = c.exclusion_reason(r)
    reasons[why or "対象"] += 1
    if why is None:
        elig.append(r)
print("探索の期間の全レース", len(races), dict(reasons))
fs = sorted(c.front_share(r) for r in elig)
for p in (0.2, 1 / 3, 2 / 3, 0.8):
    print("f の分位点", round(p, 4), round(c.percentile(fs, p), 4))
comp = collections.Counter(c.top3_comp(r) for r in elig)
print("top3 (front,back)", comp.most_common())
# 参考: 確認の期間の件数だけ(特徴量のみ)
cr = [r for r in c.load(sys.argv[1]) if c.in_period(r, c.CONFIRM)]
rc = collections.Counter(c.exclusion_reason(r) or "対象" for r in cr)
print("確認の期間の全レース", len(cr), dict(rc))
