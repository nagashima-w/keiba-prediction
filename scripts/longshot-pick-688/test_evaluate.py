"""評価の部分(選ぶ・O/E・Holm・対応のある差)の小さな手計算テスト。実行: python3 -I scripts/longshot-pick-688/test_evaluate.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate as V  # noqa: E402


def cand(u, band, q, p3, y):
    return {"umaban": u, "band": band, "q": q, "p3": p3, "y": y}


def mk(rid, cs):
    return {"raceId": rid, "date": "2024-01-01", "hcp": False, "cands": cs, "info": {"place": {}, "wide": {}, "fav": []}}


class T(unittest.TestCase):
    def test_選び方と同点は馬番(self):
        r = mk("a", [cand(5, "6-9", 0.1, 0.2, 0), cand(3, "6-9", 0.09, 0.2, 1), cand(9, "10+", 0.02, 0.1, 0)])
        pr = V.prepare([r])
        s = [[1.0, 1.0, 0.5]]  # 点が同じなら馬番の小さい 3 番
        c = V.cells(pr, s)
        self.assertEqual(c["c1"]["O"], 1)  # 馬番 3 が選ばれ y=1
        self.assertAlmostEqual(c["c1"]["E"], 0.2)
        # 10 番人気以下の中から選ぶ → 馬番 9
        self.assertEqual(c["c3"]["n"], 1)
        self.assertEqual(c["c3"]["O"], 0)
        # 基準は q 最大(馬番 5、y=0)。選んだ馬と違うので差 = 1 − 0
        self.assertEqual(c["c5"]["n"], 1)
        self.assertAlmostEqual(c["c5"]["mean_diff"], 1.0)

    def test_O_E_z(self):
        st = V.oe_from([(1, 0.5), (0, 0.5)])
        self.assertEqual(st["O"], 1)
        self.assertAlmostEqual(st["oe"], 1.0)
        self.assertAlmostEqual(st["z"], 0.0)
        st = V.oe_from([(1, 0.2)] * 4)
        self.assertAlmostEqual(st["z"], (4 - 0.8) / (4 * 0.16) ** 0.5)

    def test_Holm(self):
        h = V.holm({"a": 0.01, "b": 0.02, "c": 0.04, "d": 0.9, "e": 0.5})
        self.assertAlmostEqual(h["a"][0], 0.05)
        self.assertFalse(h["a"][1])  # 0.05 は < 0.05 でない
        self.assertAlmostEqual(h["b"][0], 0.08)
        self.assertAlmostEqual(h["c"][0], 0.12)

    def test_上位2頭のサンドイッチ(self):
        r = mk("a", [cand(1, "6-9", 0.1, 0.3, 1), cand(2, "6-9", 0.1, 0.2, 0), cand(3, "6-9", 0.1, 0.1, 1)])
        pr = V.prepare([r, mk("b", [cand(1, "6-9", 0.1, 0.3, 0), cand(2, "6-9", 0.1, 0.2, 0)])])
        c = V.cells(pr, [[3, 2, 1], [3, 2, 1]])["c4"]
        self.assertEqual(c["O"], 1)
        self.assertAlmostEqual(c["E"], 1.0)
        d = [(1 - 0.3) + (0 - 0.2), (0 - 0.3) + (0 - 0.2)]
        self.assertAlmostEqual(c["z"], sum(d) / (sum(x * x for x in d)) ** 0.5)


if __name__ == "__main__":
    unittest.main()
