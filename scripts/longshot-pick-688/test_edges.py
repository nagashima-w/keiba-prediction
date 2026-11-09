"""騎手・調教師の差が「そのレースの日付より前の走だけ」であることのテスト(unittest)。
実行: python3 -I scripts/longshot-pick-688/test_edges.py(リポジトリのルートで)。
変異の確認: edges.py の hi を常に bisect_right(<= に相当)にすると test_同じ日の走は入れない が赤になる。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import edges  # noqa: E402

COEF = [0.0, 1.0, 0.0]  # 例の p3 = q


def horse(i, fin, odds, jk="JA", tr="TA"):
    return {"horseId": f"h{i}", "jockeyId": jk if i == 0 else f"J{i}", "trainerId": tr if i == 0 else f"T{i}",
            "finish": fin, "finishStatus": None, "winOdds": odds}


def race(rid, date, fin0):
    # 5 頭、オッズ全部 5.0(q = 0.2、p = 0.2)。馬 0 の着順だけ指定。
    hs = [horse(0, fin0, 5.0)] + [horse(i, i + 1, 5.0) for i in range(1, 5)]
    return {"raceId": rid, "date": date, "horses": hs}


class TestEdges(unittest.TestCase):
    def test_手計算の値(self):
        # 日 1: 馬 0 が 1 着(y=1, p=0.2 → 残差 0.8)。日 2: 馬 0 の同日 2 レース目。
        rs = [race("r1", "2024-01-10", 1), race("r2", "2024-02-10", 9)]
        e = edges.compute_edges(rs, COEF)
        self.assertAlmostEqual(e["r1"]["h0"][0], 0.0)
        self.assertAlmostEqual(e["r2"]["h0"][0], 0.8 / (1 + 30))
        self.assertAlmostEqual(e["r2"]["h0"][1], 0.8 / (1 + 30))

    def test_同じ日の走は入れない(self):
        # 同じ日の 2 レース(r1 → r2)。r2 の指標に r1 の結果が入ってはならない。
        rs = [race("r1", "2024-01-10", 1), race("r2", "2024-01-10", 9)]
        e = edges.compute_edges(rs, COEF)
        self.assertEqual(e["r2"]["h0"][0], 0.0)
        # 変異(<=)に相当する inclusive=True では入ってしまう = このテストは変異を検出できる
        e2 = edges.compute_edges(rs, COEF, inclusive=True)
        self.assertNotEqual(e2["r2"]["h0"][0], 0.0)

    def test_今回より後の走は入れない(self):
        rs = [race("r1", "2024-01-10", 9), race("r2", "2024-03-10", 1)]
        e = edges.compute_edges(rs, COEF)
        self.assertEqual(e["r1"]["h0"][0], 0.0)

    def test_窓は730日(self):
        rs = [race("r1", "2022-01-01", 1), race("r2", "2023-12-31", 9), race("r3", "2024-01-01", 9)]
        e = edges.compute_edges(rs, COEF)
        # r2 の日付(2023-12-31)から 2022-01-01 は 729 日前(窓の中)、r3 からは 730 日前(窓の下限を含む)
        self.assertGreater(e["r2"]["h0"][0], 0.0)
        self.assertGreater(e["r3"]["h0"][0], 0.0)
        rs = [race("r1", "2021-12-30", 1), race("r3", "2023-12-31", 9)]
        e = edges.compute_edges(rs, COEF)
        self.assertEqual(e["r3"]["h0"][0], 0.0)  # 731 日前は窓の外

    def test_5頭未満のレースは使わない(self):
        r1 = race("r1", "2024-01-10", 1)
        r1["horses"] = r1["horses"][:4]
        e = edges.compute_edges([r1, race("r2", "2024-02-10", 9)], COEF)
        self.assertEqual(e["r2"]["h0"][0], 0.0)


if __name__ == "__main__":
    unittest.main()
