"""
#653(2 本目): 後半を見たあとの補足(**事前登録の外**。report.md では「新しい探索」として扱う)。
  1. 当日の馬場の傾向 × 脚質(族 C)の全条件の前半・後半の値(候補にならなかったものも含む。ユーザーの関心に答えるため)。
  2. 残った条件の重なりと、「負の条件のどれかに当たる」馬をまとめたときの差。
  3. 休み明け(181 日〜)のクラス別・齢別の内訳。
  4. 残った条件を本番の「分析の時点のオッズ」で使えるかの目安: 条件内の人気帯の分布。

使い方: python3 -I posthoc.py <features.csv> <results.json>
"""

import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I で動かすため
from common import apply_clauses, stats  # noqa: E402

pd.set_option("display.width", 250)


def table(df_by_period, clauses_by_name):
    rows = []
    for name, clauses in clauses_by_name.items():
        row = {"条件": name}
        for per, df in df_by_period.items():
            s = stats(df, apply_clauses(df, clauses))
            row[f"n{per}"] = s["n"]
            row[f"d_place{per}"] = round(s["d_place"], 2)
            row[f"z_place{per}"] = round(s["z_place"], 2)
            row[f"d_win{per}"] = round(s["d_win"], 2)
            row[f"z_win{per}"] = round(s["z_win"], 2)
            row[f"roi{per}"] = round(s["roi_win"], 2)
        rows.append(row)
    return pd.DataFrame(rows)


def main():
    feat_path, res_path = sys.argv[1:3]
    df = pd.read_csv(feat_path, low_memory=False)
    P = {"A": df[df["period"] == "A"].reset_index(drop=True), "B": df[df["period"] == "B"].reset_index(drop=True)}
    res = json.load(open(res_path))

    print("## 1. 当日の傾向 × 脚質(族 C)の全条件(scan_A と同じ条件を後半にも当てたもの)")
    scan = pd.read_csv(os.path.join(os.path.dirname(res_path), "scan_A.csv"))
    c = scan[scan["family"] == "C:当日の傾向×脚質"]
    print(table(P, {r["name"]: json.loads(r["clauses"]) for _, r in c.iterrows()}).to_string(index=False))
    # F・G の分布の確認(当日指標が作れたレースの割合)
    for per, d in P.items():
        print(f"{per}: F あり {d['F'].notna().mean():.1%}、G あり {d['G'].notna().mean():.1%}、Fprev あり {d['Fprev'].notna().mean():.1%}、style あり {d['style'].notna().mean():.1%}")

    print("\n## 2. 残った条件の重なりと、負の条件のまとめ")
    # 正式な判断は judge.ts。ここでは judge の出力(残った 5 件)を族と名前で固定する(同じ名前が「全体」と「人気薄」の両方にあるため族も要る)。
    keys = [("A:全体", "daysSince:181〜"), ("A:全体", "surfaceChange=1.0"), ("A:人気薄(q<0.05)", "avgFinish3:5分位5(11.5〜]"),
            ("A:全体", "pFirstPos:下位10%(≤0.125)"), ("A:人気薄(q<0.05)", "lastPos3:5分位2(0.334〜0.494]")]
    by_key = {(r["family"], r["name"]): r["clauses"] for r in res["results"]}
    picked = {f"{fam.split(':')[1]}/{name}": by_key[(fam, name)] for fam, name in keys}
    names = list(picked.keys())
    masks = {per: {n: apply_clauses(d, cl) for n, cl in picked.items()} for per, d in P.items()}
    for per, d in P.items():
        print(f"[{per}] 重なり(行 ∧ 列の件数):")
        m = pd.DataFrame({a: {b: int((masks[per][a] & masks[per][b]).sum()) for b in names} for a in names})
        print(m.to_string())
    neg = names[:4]
    for per, d in P.items():
        any_neg = pd.concat([masks[per][n] for n in neg], axis=1).any(axis=1)
        s = stats(d, any_neg)
        per_race = any_neg.groupby(d["raceId"]).sum()
        print(f"[{per}] 負の 4 条件のどれかに当たる: n={s['n']}({any_neg.mean():.1%})、3着内 d={s['d_place']:.2f} z={s['z_place']:.2f}、勝ち d={s['d_win']:.2f} z={s['z_win']:.2f}、単勝回収率 {s['roi_win']:.2f}、1 レースあたり {per_race.mean():.2f} 頭")
        rest = stats(d, ~any_neg)
        print(f"[{per}] 当たらない残り: n={rest['n']}、3着内 d={rest['d_place']:.2f} z={rest['z_place']:.2f}、勝ち d={rest['d_win']:.2f} z={rest['z_win']:.2f}、単勝回収率 {rest['roi_win']:.2f}")

    print("\n## 3. 休み明け(181 日〜)のクラス別・齢別・人気帯別")
    for per, d in P.items():
        base = masks[per]["全体/daysSince:181〜"]
        for col, bins in (("raceClass", None), ("age", None), ("qBand", [0, 0.05, 0.15, 0.3, 1.0])):
            key = pd.cut(d["q"], bins, labels=["q<0.05", "0.05〜0.15", "0.15〜0.3", "≥0.3"]) if col == "qBand" else d[col]
            rows = []
            for v in sorted(key.dropna().unique(), key=str):
                m = base & (key == v)
                if m.sum() < 50:
                    continue
                s = stats(d, m)
                rows.append({col: v, "n": s["n"], "d_place": round(s["d_place"], 2), "z_place": round(s["z_place"], 2), "roi": round(s["roi_win"], 2)})
            print(f"[{per}] {col}:")
            print(pd.DataFrame(rows).to_string(index=False))

    print("\n## 4. 残った条件の人気帯の分布(後半)")
    d = P["B"]
    band = pd.cut(d["q"], [0, 0.05, 0.15, 0.3, 1.0], labels=["q<0.05", "0.05〜0.15", "0.15〜0.3", "≥0.3"])
    for n in names:
        m = masks["B"][n]
        rows = []
        for v in band.cat.categories:
            mm = m & (band == v)
            s = stats(d, mm)
            rows.append({"帯": v, "n": s["n"], "d_place": round(s["d_place"], 2), "z_place": round(s["z_place"], 2), "roi": round(s["roi_win"], 2)})
        print(f"[{n}]")
        print(pd.DataFrame(rows).to_string(index=False))


if __name__ == "__main__":
    main()
