"""#689 の道具のテスト(手計算)。python3 -I scripts/fav-danger-689/test_689.py"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common689 as K689  # noqa: E402
import evaluate689 as V  # noqa: E402
import features689 as F  # noqa: E402


def t_band():
    assert K689.band_of(0.99) is None
    assert K689.band_of(1.0) == "1.0-1.9"
    assert K689.band_of(1.9) == "1.0-1.9"
    assert K689.band_of(1.99) == "1.0-1.9"
    assert K689.band_of(2.0) == "2.0-2.9"
    assert K689.band_of(2.9) == "2.0-2.9"
    assert K689.band_of(2.99) == "2.0-2.9"
    assert K689.band_of(3.0) is None
    assert K689.band_of(None) is None


def t_pick():
    hs = [{"ninki": 2, "odds": 3.0, "umaban": 1}, {"ninki": 1, "odds": 2.5, "umaban": 7}, {"ninki": 1, "odds": 2.5, "umaban": 4},
          {"ninki": 1, "odds": None, "umaban": 2}]
    assert F.pick_favorite(hs)["umaban"] == 4  # 同順位は馬番の小さい方、オッズ無しは除く
    assert F.pick_favorite([{"ninki": 2, "odds": 3.0, "umaban": 1}]) is None
    assert F.second_odds(hs) == 3.0
    assert F.box_umabans([{"ninki": n, "umaban": 10 + n} for n in (1, 2, 3, 4, 5, 6, 7)], 2, 4) == [12, 13, 14]


def mk(y, w, p3, q, band):
    return {"y": y, "w": w, "p3": p3, "q": q, "band": band}


def t_oe():
    sel = [mk(1, 0, 0.8, 0.5, "1.0-1.9"), mk(0, 0, 0.6, 0.4, "2.0-2.9"), mk(1, 1, 0.7, 0.5, "2.0-2.9")]
    r = V.oe(sel, "y")
    assert r["n"] == 3 and r["O"] == 2 and abs(r["E"] - 2.1) < 1e-9
    assert abs(r["oe"] - 2 / 2.1) < 1e-12
    v = 0.8 * 0.2 + 0.6 * 0.4 + 0.7 * 0.3
    assert abs(r["z"] - (2 - 2.1) / math.sqrt(v)) < 1e-12
    rw = V.oe(sel, "w")  # 勝ちの E は q の合計
    assert rw["O"] == 1 and abs(rw["E"] - 1.4) < 1e-9
    cs = V.four_cells(sel)
    assert cs["c2"]["n"] == 1 and cs["c3"]["n"] == 2 and cs["c1"]["n"] == 3 and cs["c4"]["O"] == 1
    assert abs(V.p_lower(0.0) - 0.5) < 1e-12 and V.p_lower(-1.645) < 0.05 < V.p_lower(-1.6)


def t_verdict():
    cells = {"c1": {"n": 400, "z": -3.0}, "c2": {"n": 100, "z": -3.5}, "c3": {"n": 400, "z": -0.5}, "c4": {"n": 400, "z": None}}
    v = V.verdict(cells)
    assert v["c2"]["n_short"] and not v["c2"]["survived"]  # 件数不足は残ったと判定しない
    assert v["c1"]["survived"] and not v["c3"]["survived"] and v["c4"]["p_holm"] is None
    # Holm: 3 セルの p を小さい順に ×3, ×2, ×1(単調化)
    p2, p1, p3 = V.p_lower(-3.5), V.p_lower(-3.0), V.p_lower(-0.5)
    assert abs(v["c2"]["p_holm"] - 3 * p2) < 1e-12 and abs(v["c1"]["p_holm"] - max(3 * p2, 2 * p1)) < 1e-12


def t_box():
    race = {"info": {"box_2_6": [3, 4, 5, 6, 7], "box_2_4": [3, 4, 5],
                     "trio": {frozenset((3, 4, 7)): 5000, frozenset((1, 3, 4)): 999},  # 後者は 1 番人気(馬番 1)を含むので買い目に無い
                     "wide": {frozenset((3, 4)): 300, frozenset((4, 5)): 450, frozenset((1, 3)): 200}}}
    r = V.box_roi([race], "box_2_6", "trio")
    assert r["tickets"] == 10 and r["roi"] == 5000 / 1000 and r["hit_races"] == 1
    w = V.box_roi([race, {"info": {"box_2_6": [], "box_2_4": [3, 4, 5], "trio": {}, "wide": {}}}], "box_2_4", "wide")
    assert w["tickets"] == 6 and w["roi"] == 750 / 600 and w["hit_races"] == 1
    # 頭数が足りないレース(2〜4 番人気が 2 頭): ワイド 1 点、3 連複 0 点
    r2 = V.box_roi([{"info": {"box_2_6": [3, 4], "box_2_4": [3, 4], "trio": {}, "wide": {frozenset((3, 4)): 120}}}], "box_2_6", "trio")
    assert r2["tickets"] == 0 and r2["roi"] is None


def t_shuffle():
    races = [{"fav": mk(i % 2, 0, 0.5, 0.5, "2.0-2.9")} for i in range(40)]
    ph = [i / 40 for i in range(40)]
    a = V.shuffle_null(races, ph, 0.5, 5, 689)
    b = V.shuffle_null(races, ph, 0.5, 5, 689)
    assert a == b and len(a) == 5  # seed で再現する


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("t_"):
            f()
            print("ok", n)
