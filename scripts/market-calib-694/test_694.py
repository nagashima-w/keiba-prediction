"""#694 の道具のテスト。python3 -I scripts/market-calib-694/test_694.py"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calib as C  # noqa: E402


def test_fit_recovers_known_coef():
    rng = np.random.default_rng(1)
    n = 200000
    L = rng.normal(-2, 1.2, n)
    lnn = np.log(rng.integers(8, 19, n))
    w_true = np.array([2.5, 0.9, -0.5, 0.05])
    X = C.features("F1", L, lnn)
    y = (rng.random(n) < C.sigmoid(X @ w_true)).astype(float)
    w = C.fit_logit(X, y)
    assert np.max(np.abs(w - w_true)) < 0.05, w
    # 係数がゼロでない(前提の固定): L² の係数は 0.05 で、0 と区別できる
    assert abs(w[3]) > 0.02


def test_features_hand_calc():
    L = np.array([-1.0, 0.5])
    lnn = np.array([2.0, 2.0])
    assert np.allclose(C.features("F0", L, lnn), [[1, -1, 2], [1, 0.5, 2]])
    assert np.allclose(C.features("F1", L, lnn)[:, 3], [1.0, 0.25])
    assert np.allclose(C.features("F3", L, lnn)[:, 4], [-2.0, 1.0])
    f2 = C.features("F2", L, lnn, [-2.0, 0.0, 1.0])
    assert np.allclose(f2[:, 3:], [[1.0, 0.0, 0.0], [2.5, 0.5, 0.0]])


def test_prod_matches_hand_value():
    # n=10 の一様な q=0.1: sigmoid(2.857 + 0.9216*logit(0.1) − 0.5561*ln10)
    r = {"q": np.full(10, 0.1), "n": 10}
    m = C.predict("F_prod", C.PROD_COEF, None, [r])[0]
    z = 2.857 + 0.9216 * math.log(0.1 / 0.9) - 0.5561 * math.log(10)
    assert abs(m[0] - 1 / (1 + math.exp(-z))) < 1e-12
    assert abs(m[0] - 0.3) > 0.01  # 一様(0.3)とは区別できる値になっている


def test_shift_hits_target_and_is_nontrivial():
    m = np.array([0.5, 0.4, 0.3, 0.2, 0.1, 0.1])  # 合計 1.6
    s = C.shift_to_sum(m, 3.0)
    assert abs(s.sum() - 3.0) < 1e-9
    assert (s > m).all()  # ずらしが 0 でない(前提)
    # 順序は保たれる
    assert all(s[i] >= s[i + 1] - 1e-12 for i in range(len(s) - 1))


def test_band_and_deviation():
    r = {"ninki": np.array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), "odds": np.array([1.5, 3, 4, 5, 6, 7, 8, 9, 10, 11.0]),
         "y": np.array([1, 1, 1, 0, 0, 0, 0, 0, 0, 0.0])}
    p = np.array([0.5, 0.5, 0.5, 0.2, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1])
    bs = C.band_stats([r], [p])
    assert bs["1"]["n"] == 1 and bs["1"]["O"] == 1 and abs(bs["1"]["OE"] - 2.0) < 1e-12
    assert bs["2-3"]["n"] == 2 and abs(bs["2-3"]["OE"] - 2.0) < 1e-12
    assert bs["fav1.0-1.9"]["n"] == 1
    assert bs["10+"]["n"] == 1 and bs["6-9"]["n"] == 4
    d = C.deviation(bs, ["1", "2-3"])
    assert abs(d - 1.0) < 1e-12  # どちらも |2−1|=1


def test_loader_filters(tmp_path=None):
    import gzip, json, tempfile
    def horse(u, odds, fin, status=None, ninki=None):
        return {"umaban": u, "winOdds": odds, "finish": fin, "finishStatus": status, "ninki": ninki}
    ok = {"raceId": "A", "date": "2022-01-05", "courseType": "芝", "horses": [horse(i, 2.0 + i, i, None, i) for i in range(1, 7)] + [horse(7, None, 7)]}
    jump = {**ok, "raceId": "B", "courseType": "障"}
    few = {**ok, "raceId": "C", "horses": [horse(i, 2.0 + i, i) for i in range(1, 5)]}
    nocanc = {**ok, "raceId": "D", "horses": [horse(i, 2.0 + i, i) for i in range(1, 6)] + [horse(9, 3.0, None, "取消")]}
    dup = dict(ok)
    d = tempfile.mkdtemp()
    p = d + "/h.ndjson.gz"
    with gzip.open(p, "wt", encoding="utf-8") as f:
        for r in (ok, jump, few, nocanc, dup):
            f.write(json.dumps(r) + "\n")
    races, st = C.load_races([p])
    assert [r["raceId"] for r in races] == ["A", "D"], [r["raceId"] for r in races]
    assert st["dup"] == 1 and st["not_target_course"] == 1 and st["lt5_odds"] == 1 and st["races_with_oddsless"] == 1
    a = races[0]
    assert a["n"] == 6 and abs(a["q"].sum() - 1) < 1e-12 and a["y"].tolist() == [1, 1, 1, 0, 0, 0]
    assert races[1]["n"] == 5  # 取消の馬は数えない


def test_knots():
    L = np.arange(101, dtype=float)
    assert C.knots_from(L) == [20.0, 50.0, 80.0]


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f()
            print("ok", k)
