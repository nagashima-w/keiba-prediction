"""#688: 騎手・調教師の「市場との差」(#642 の式。cloud/src/market-edge-calc.ts)を、そのレースの日付より前の走だけから作る。

指標 = Σ(y − p) ÷ (件数 + 30)。窓 = そのレースの日付の 730 日前から前日まで(前日を含む。同じ日の走は入れない)。
p = #687 の固定係数による p3(その過去レースの q と、計算に入った馬の数)。計算に入る馬 = 単勝オッズが正で着順が数字の馬。5 頭未満のレースは使わない。
"""
from __future__ import annotations

import bisect
import collections
import datetime
import math

SHRINK = 30
WINDOW_DAYS = 730
MIN_FIELD = 5


class EdgeBook:
    """キーごとに (日付の通し番号, 読み残し) を日付順に積み、窓の合計を接頭和で引く。"""

    def __init__(self):
        self.dates = collections.defaultdict(list)
        self.cum = collections.defaultdict(lambda: [0.0])

    def add(self, key, dord, resid):
        ds = self.dates[key]
        if ds and dord < ds[-1]:
            raise ValueError("日付の昇順で add すること")
        ds.append(dord)
        cu = self.cum[key]
        cu.append(cu[-1] + resid)

    def edge(self, key, today, inclusive=False):
        """today の日付より前(inclusive=True は変異: 同じ日を含む)で、today − 730 日以降の走の (合計, 件数) から指標を返す。"""
        ds = self.dates.get(key)
        if not ds:
            return 0.0
        hi = bisect.bisect_right(ds, today) if inclusive else bisect.bisect_left(ds, today)
        lo = bisect.bisect_left(ds, today - WINDOW_DAYS)
        n = hi - lo
        if n <= 0:
            return 0.0
        cu = self.cum[key]
        return (cu[hi] - cu[lo]) / (n + SHRINK)


def _p3(coef, q, n):
    z = coef[0] + coef[1] * math.log(q / (1 - q)) + coef[2] * math.log(n)
    z = max(min(z, 35.0), -35.0)
    return 1.0 / (1.0 + math.exp(-z))


def compute_edges(races, coef, inclusive=False):
    """races: 日付・raceId 順の hist のレース。戻り: {raceId: {horseId: (騎手の差, 調教師の差)}}(取消・除外を除く全出走馬)。"""
    jb, tb = EdgeBook(), EdgeBook()
    out = {}
    for r in races:
        today = datetime.date.fromisoformat(r["date"]).toordinal()
        out[r["raceId"]] = {h["horseId"]: (jb.edge(h["jockeyId"], today, inclusive) if h["jockeyId"] else 0.0,
                                           tb.edge(h["trainerId"], today, inclusive) if h["trainerId"] else 0.0)
                            for h in r["horses"] if h["finishStatus"] not in ("取消", "除外")}
        used = [h for h in r["horses"] if isinstance(h["finish"], int) and h["winOdds"] and h["winOdds"] > 0]
        if len(used) < MIN_FIELD:
            continue
        inv = [1.0 / h["winOdds"] for h in used]
        tot = sum(inv)
        for h, v in zip(used, inv):
            resid = (1.0 if h["finish"] <= 3 else 0.0) - _p3(coef, v / tot, len(used))
            if h["jockeyId"]:
                jb.add(h["jockeyId"], today, resid)
            if h["trainerId"]:
                tb.add(h["trainerId"], today, resid)
    return out
