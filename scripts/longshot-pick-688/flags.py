"""#653 の 4 印の Python 移植。本番の packages/core/src/ev/stat-shadow-flags.ts の computeShadowFlags と同じ定義。
走(run)は dict: date(YYYY/MM/DD または None)、courseType(None 可)、passing(list)、entryCount(None 可)、finish(数値順位または None)。
戻りは (longRest, surfaceChange, frontRunner, longshotSlump)。各 1/0/None。
本番の TS との一致は xcheck_flags.py で確かめる(学習の前)。
"""
from __future__ import annotations

import datetime
import re

LONG_REST_DAYS = 180
FRONT_RUNNER_MAX_POS = 0.125
LONGSHOT_MAX_Q = 0.05
SLUMP_MIN_AVG_FINISH = 11.5
NO_FLAGS = (None, None, None, None)
_YMD = re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})$")


def days_between(prev, cur):
    """日数差(cur - prev)。どちらかが None・解釈不能なら None。本番の daysBetweenDates と同じ(UTC 基準の暦日)。"""
    if prev is None or cur is None:
        return None
    a, b = _YMD.match(prev.strip()), _YMD.match(cur.strip())
    if not a or not b:
        return None
    try:
        da = datetime.date(int(a[1]), int(a[2]), int(a[3]))
        db = datetime.date(int(b[1]), int(b[2]), int(b[3]))
    except ValueError:
        return None  # 本番の Date.UTC は 2/30 などをくり上げるが、実データに現れない。合成ケースでも作らない
    return (db - da).days


def compute_flags(runs, today_date, today_course, q):
    prior = []
    for r in runs:
        d = days_between(r["date"], today_date)
        if d is not None and d > 0:
            prior.append((d, r))
    prior.sort(key=lambda x: -x[0])  # 古い順(安定ソート。本番の Array.sort も安定)
    prior = [r for _, r in prior]
    if not prior:
        return NO_FLAGS
    last = prior[-1]
    days = days_between(last["date"], today_date)
    long_rest = 1 if days > LONG_REST_DAYS else 0
    if last["courseType"] is None:
        surface = None
    else:
        surface = 1 if last["courseType"] != today_course else 0
    passing = last["passing"]
    first = passing[0] if len(passing) > 0 else None
    ec = last["entryCount"]
    if first is None or ec is None or ec <= 0:
        front = None
    else:
        front = 1 if first / ec <= FRONT_RUNNER_MAX_POS else 0
    fins = [r["finish"] for r in prior[-3:] if r["finish"] is not None]
    avg = sum(fins) / len(fins) if fins else None
    if q is None or avg is None:
        slump = None
    else:
        slump = 1 if (q < LONGSHOT_MAX_Q and avg >= SLUMP_MIN_AVG_FINISH) else 0
    return (long_rest, surface, front, slump)
