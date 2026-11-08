#!/usr/bin/env python3
"""#688 の事後の記述(確認の結果を見たあとに加えたもの。検定の family には入れない)。
確認の結果で c4(上位 2 頭)が残ったため、「それは市場の見込みだけで選んだ上位 2 頭にも共通か」を見る。
使い方: posthoc.py <tab> <h2021> <h> <csv> <out_dir> <scores_confirm.ndjson.gz>
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common688 as K  # noqa: E402
import evaluate as V  # noqa: E402
import features as Fe  # noqa: E402
import run as Rn  # noqa: E402


def main(tab, h2021, h, csv_path, out_dir, scores_path):
    prep = Fe.load_prep(Rn.PREP_PATH)
    races = Fe.build(tab, [h2021, h], csv_path, prep, K.CONFIRM)
    scores = {}
    for r in K.load_ndjson(scores_path):
        scores[(r["raceId"], r["umaban"])] = r["phat"]
    pr = V.prepare(races)
    sm = V.scores_list(pr, scores)
    sq = [list(a["q"]) for _, a in pr]  # 基準: q の順位
    cm, cb = V.cells(pr, sm), V.cells(pr, sq)
    rows = [x for race in races for x in race["cands"]]
    out = {"all_candidates": {}}
    for nm, sel in (("全体", rows), ("6-9", [x for x in rows if x["band"] == "6-9"]), ("10+", [x for x in rows if x["band"] == "10+"])):
        out["all_candidates"][nm] = V.oe_from([(x["y"], x["p3"]) for x in sel])
    out["model_top1"], out["base_top1"] = cm["c1"], cb["c1"]
    out["model_top2"], out["base_top2"] = cm["c4"], cb["c4"]
    # 上位 2 頭: モデルと基準の y の合計の、レースごとの差
    d, same2, same1 = [], 0, 0
    for (race, a), s1, s2 in zip(pr, sm, sq):
        m2 = V.picks_for(a, s1, "all", 2)
        b2 = V.picks_for(a, s2, "all", 2)
        same2 += set(m2) == set(b2)
        same1 += m2[0] == b2[0]
        d.append(sum(a["y"][i] for i in m2) - sum(a["y"][i] for i in b2))
    n = len(d)
    mean = sum(d) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in d) / (n - 1))
    out["top2_model_minus_base"] = {"n_races": n, "mean_diff_hits": mean, "z": mean / (sd / math.sqrt(n)),
                                    "races_same_top2_set": same2, "races_same_top1": same1}
    json.dump(out, open(os.path.join(out_dir, "posthoc-results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main(*sys.argv[1:])
