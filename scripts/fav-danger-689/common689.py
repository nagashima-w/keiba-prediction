"""#689 共通: 定数。#688 の道具を import して使う(#688 のファイルは変えない)。"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
D688 = os.path.join(HERE, "..", "longshot-pick-688")
sys.path.insert(0, D688)
import common688 as K  # noqa: E402  (#688。内部で #683・#687 を読み込む)

SEED = 689
N_SHUFFLE = 1000
MIN_N = 300
HOLM_ALPHA = 0.05
ODDS_LO, ODDS_HI = 1.0, 3.0  # 1.0 <= odds < 3.0
BAND_SPLIT = 2.0             # 1.0〜1.9 と 2.0〜2.9
DANGER_SHARE = 1.0 / 3.0


def band_of(odds):
    """単勝オッズから帯。1.0 未満・3.0 以上は None(対象外)。"""
    if odds is None or odds < ODDS_LO or odds >= ODDS_HI:
        return None
    return "1.0-1.9" if odds < BAND_SPLIT else "2.0-2.9"
