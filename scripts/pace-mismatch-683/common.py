"""#683 共通: 表の読み込み・対象レースの判定・レース単位の特徴量(結果の列は読まない関数と読む関数を分ける)。"""
from __future__ import annotations

import gzip
import json
import math

EXPLORE = ("2024-08-10", "2025-08-31")
CONFIRM = ("2025-09-01", "2026-11-01")
MIN_START = 8
MIN_KNOWN_SHARE = 0.7
FRONT = ("逃げ", "先行")
BACK = ("差し", "追込")
BANDS = {"1-3": (1, 3), "4-9": (4, 9), "10+": (10, 99)}


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [json.loads(l) for l in f]


def in_period(race, period):
    return period[0] <= race["date"] <= period[1]


def exclusion_reason(race):
    """対象外の理由(対象なら None)。順序: 障害 → 新馬 → 頭数 → 判定率。"""
    if race["courseType"] == "障":
        return "障害"
    if race["raceClass"] == "新馬":
        return "新馬"
    if race["nStart"] < MIN_START:
        return "頭数<8"
    hs = race["horses"]
    known = sum(1 for h in hs if h["style"])
    if known / len(hs) < MIN_KNOWN_SHARE:
        return "判定率<0.7"
    return None


def front_share(race):
    kn = [h for h in race["horses"] if h["style"]]
    return sum(1 for h in kn if h["style"] in FRONT) / len(kn)


def top3_comp(race, styles=None):
    """人気 1〜3 番人気のうち脚質判定済みの馬の (front 数, back 数)。styles は馬の並びと同じ長さの上書き。"""
    f = b = 0
    for i, h in enumerate(race["horses"]):
        s = styles[i] if styles is not None else h["style"]
        if h["ninki"] is not None and h["ninki"] <= 3 and s:
            if s in FRONT:
                f += 1
            else:
                b += 1
    return f, b


def percentile(sorted_vals, p):
    """線形補間の分位点(numpy の既定と同じ)。"""
    k = (len(sorted_vals) - 1) * p
    lo = math.floor(k)
    hi = math.ceil(k)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)
