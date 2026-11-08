"""packages/core/src/analyzer/leg-style.ts の classifyHorseLegStyleFull(analyzeHorseLegStyle の style)の移植。

各走: 全コーナーの通過順の平均 / 頭数 = 相対位置。1 コーナー先頭かつ相対位置 <= 1/3 なら逃げ、
<= 1/3 なら先行、<= 2/3 なら差し、それ以外は追込。直近 3 走(通過順がある走のみ)の最頻値、同数は直近優先。
"""
from __future__ import annotations

LEAD = 1 / 3
MID = 2 / 3


def run_style(passing, field_size):
    if not passing:
        return None
    avg = sum(passing) / len(passing)
    if field_size is not None and field_size > 0:
        r = avg / field_size
        if passing[0] == 1 and r <= LEAD:
            return "逃げ"
        if r <= LEAD:
            return "先行"
        if r <= MID:
            return "差し"
        return "追込"
    # 頭数不明の絶対位置(本データでは通常発生しない)
    if passing[0] == 1 and avg <= 4:
        return "逃げ"
    if avg <= 4:
        return "先行"
    if avg <= 8:
        return "差し"
    return "追込"


def horse_style(runs, recent=3):
    """runs: [(passing, field_size), ...] 新しい順。"""
    styles = []
    for passing, fs in runs:
        if len(styles) >= recent:
            break
        s = run_style(passing, fs)
        if s is not None:
            styles.append(s)
    if not styles:
        return None
    count = {}
    first = {}
    for i, s in enumerate(styles):
        count[s] = count.get(s, 0) + 1
        first.setdefault(s, i)
    best = styles[0]
    for s in count:
        if count[s] > count[best] or (count[s] == count[best] and first[s] < first[best]):
            best = s
    return best
