"""#688 共通: 定数・#683〜#687 の道具の読み込み・表の読み込み。"""
from __future__ import annotations

import gzip
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
D683 = os.path.join(HERE, "..", "pace-mismatch-683")
D687 = os.path.join(HERE, "..", "pace-fit-687")
sys.path.insert(0, D683)
sys.path.insert(0, HERE)
import common as c  # noqa: E402  (#683)

_spec = importlib.util.spec_from_file_location("a687", os.path.join(D687, "analyze.py"))
a687 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(a687)
a683 = a687.a683

WARM = ("2021-06-20", "2021-12-31")
EXPLORE = ("2022-01-01", "2023-12-31")
CONFIRM = ("2024-01-01", "2026-11-01")
SPLIT_DATE = "2024-08-04"
BLOCKS = [("2022-01-01", "2022-06-30"), ("2022-07-01", "2022-12-31"), ("2023-01-01", "2023-06-30"), ("2023-07-01", "2023-12-31")]
LAMBDAS = [1.0, 10.0, 100.0, 1000.0]
MIN_N = 300
HOLM_ALPHA = 0.05
N_SHUFFLE = 1000
SEED = 688
WINDOW_DAYS = 730
EDGE_SHRINK = 30
EDGE_MIN_FIELD = 5


def load_ndjson(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [json.loads(l) for l in f]


def in_period(d, p):
    return p[0] <= d <= p[1]


def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def sigmoid(z):
    z = max(min(z, 35.0), -35.0)
    return 1.0 / (1.0 + math.exp(-z))


def p3_fixed(coef, q, n):
    return sigmoid(coef[0] + coef[1] * logit(q) + coef[2] * math.log(n))


def race_q(r):
    """レース内で割り戻した q(馬ごと。オッズのある馬だけ)。{horseId: q}、n = オッズのある馬の数。"""
    inv = {h["horseId"]: 1.0 / h["odds"] for h in r["horses"] if h["odds"]}
    tot = sum(inv.values())
    return {k: v / tot for k, v in inv.items()}
