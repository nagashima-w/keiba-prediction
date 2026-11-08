"""#694: 当てはめ(fit)・評価(eval、1 回だけ)・件数(counts)。
使い方: python3 -I scripts/market-calib-694/run.py counts|fit|eval <hist2021> <hist> <outDir>
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calib as C  # noqa: E402


def load(h2021, hist):
    races, st = C.load_races([h2021, hist])
    return races, st


def counts(races, st):
    fit = C.in_period(races, C.FIT)
    ev = C.in_period(races, C.EVAL)
    return {
        "load_stats": st, "fit_races": len(fit), "eval_races": len(ev),
        "fit_horses": int(sum(r["n"] for r in fit)), "eval_horses": int(sum(r["n"] for r in ev)),
        "all_races": len(races),
        "outside_periods": len(races) - len(fit) - len(ev),
    }


def cmd_fit(races, out):
    fit = C.in_period(races, C.FIT)
    L, lnn, y = C.stack(fit)
    knots = C.knots_from(L)
    res = {"fit_period": C.FIT, "n_races": len(fit), "n_horses": int(len(y)), "knots": knots, "coef": {"F_prod": C.PROD_COEF}}
    for name in ["F0", "F1", "F2", "F3"]:
        w = C.fit_logit(C.features(name, L, lnn, knots), y)
        res["coef"][name] = [float(v) for v in w]
    json.dump(res, open(os.path.join(out, "fit-coef.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(res, ensure_ascii=False, indent=1))


def cmd_eval(races, out):
    path = os.path.join(out, "eval-results.json")
    if os.path.exists(path):
        raise SystemExit("評価は 1 回だけ。eval-results.json が既にある")
    fc = json.load(open(os.path.join(out, "fit-coef.json")))
    ev = C.in_period(races, C.EVAL)
    res = {"eval_period": C.EVAL, "n_races": len(ev), "formulas": {}}
    lls = {}
    for name in C.FORMULAS:
        raw = C.predict(name, fc["coef"][name], fc["knots"], ev)
        shifted = [C.shift_to_sum(m, min(3, r["n"])) for r, m in zip(ev, raw)]
        s_raw, ll_raw = C.summarize(ev, raw)
        s_sh, ll_sh = C.summarize(ev, shifted)
        res["formulas"][name] = {"raw": s_raw, "shifted": s_sh}
        lls[name] = {"raw": ll_raw, "shifted": ll_sh}
    nh = res["formulas"]["F0"]["raw"]["n_horses"]
    res["paired_vs_F0"] = {}
    for name in C.FORMULAS:
        if name == "F0":
            continue
        res["paired_vs_F0"][name] = {}
        for k in ("raw", "shifted"):
            d, se = C.paired_se(lls[name][k], lls["F0"][k], nh)
            res["paired_vs_F0"][name][k] = {"diff": d, "se": se}
    # 合否
    f0 = res["formulas"]["F0"]["shifted"]
    verdict = {}
    for name in C.CANDIDATE_ORDER[1:]:
        s = res["formulas"][name]["shifted"]
        verdict[name] = {"logloss_smaller": bool(s["logloss"] < f0["logloss"]), "D6_smaller": bool(s["D6"] < f0["D6"])}
        verdict[name]["pass"] = verdict[name]["logloss_smaller"] and verdict[name]["D6_smaller"]
    chosen = next((n for n in C.CANDIDATE_ORDER[1:] if verdict[n]["pass"]), "F0")
    res["verdict"] = verdict
    res["chosen"] = chosen
    json.dump(res, open(path, "w"), ensure_ascii=False, indent=1)
    print(json.dumps({"verdict": verdict, "chosen": chosen}, ensure_ascii=False))


if __name__ == "__main__":
    cmd, h2021, hist, out = sys.argv[1:5]
    races, st = load(h2021, hist)
    if cmd == "counts":
        print(json.dumps(counts(races, st), ensure_ascii=False, indent=1))
    elif cmd == "fit":
        cmd_fit(races, out)
    elif cmd == "eval":
        cmd_eval(races, out)
    else:
        raise SystemExit("counts|fit|eval")
