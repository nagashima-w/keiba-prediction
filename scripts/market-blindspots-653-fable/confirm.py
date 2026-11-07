"""
#653(2 本目): 後半(確認)の評価。候補(candidates.json)を機械的に後半へ当てて、後半の件数・差・z・片側 p・回収率を出す。
計画 §7。**候補を固定してから 1 回だけ流す。** 判断(Holm 補正・向き・差の下限)は judge.ts が行う。

使い方: python3 -I confirm.py <features.csv> <candidates.json> <出力 results.json>
"""

import json
import math
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I で動かすため
from common import apply_clauses, one_sided_p, race_bootstrap, stats  # noqa: E402


def main():
    feat_path, cand_path, out_path = sys.argv[1:4]
    df = pd.read_csv(feat_path, low_memory=False)
    A = df[df["period"] == "A"].reset_index(drop=True)
    B = df[df["period"] == "B"].reset_index(drop=True)
    with open(cand_path) as f:
        cand = json.load(f)
    out = []
    for c in cand["candidates"]:
        mA = apply_clauses(A, c["clauses"])
        mB = apply_clauses(B, c["clauses"])
        sA = stats(A, mA)
        sB = stats(B, mB)
        assert sA["n"] == c["A"]["n"], (c["name"], sA["n"], c["A"]["n"])  # 候補の前半の値が再現すること
        tests = {}
        for t in c["metrics"]:
            sign = 1 if c["A"][f"d_{t}"] > 0 else -1
            zb = sB[f"z_{t}"]
            tests[t] = {"sign": sign, "p_one_sided_B": one_sided_p(zb, sign) if not math.isnan(zb) else 1.0,
                        "ci_A": race_bootstrap(A, mA, t), "ci_B": race_bootstrap(B, mB, t) if sB["n"] > 0 else [float("nan")] * 2}
        out.append({"family": c["family"], "name": c["name"], "clauses": c["clauses"], "metrics": c["metrics"],
                    "A": sA, "B": sB, "tests": tests})
    with open(out_path, "w") as f:
        json.dump({"M": cand["M"], "K": cand["K"], "results": out}, f, ensure_ascii=False, indent=1)
    print(f"候補 {len(out)} 件を後半({len(B)} 頭・{B['raceId'].nunique()} レース)に当てた")


if __name__ == "__main__":
    main()
