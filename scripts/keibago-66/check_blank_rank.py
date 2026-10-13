"""段階B: ZIP の『着順が空・馬体重が数字・人気なし』の行が、netkeiba の結果ページでは何と書かれているかを確かめる。

使い方: python3 -I check_blank_rank.py --zip-dir <dir> --raw-dir <netkeiba 取得物> --months 202607 202609 --race 202630070206 --race ... [--json-out x.json]
ネットワークには出ない。出力に馬名は含めない。
"""
import argparse
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_zip_month, race_id_of  # noqa: E402
from netkeiba_pages import parse_result  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--race", action="append", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()
    zh, zr = defaultdict(dict), {}
    for ym in a.months:
        m = load_zip_month(a.zip_dir, ym)
        for x in m["horselist"]:
            zh[race_id_of(x)][x["馬番"]] = x
        for x in m["racelist"]:
            zr[race_id_of(x)] = x
    out = []
    for rid in a.race:
        res = parse_result(open(os.path.join(a.raw_dir, f"result_{rid}.html"), encoding="utf-8").read())
        nk = {r["馬番"]: r for r in res["rows"]}
        rows = zh[rid]
        blanks = [b for b, x in rows.items() if x["着順"] == ""]
        print(f"{rid}: ZIP 頭数={zr[rid]['頭数']} 行数={len(rows)} 着順が空={len(blanks)} | netkeiba 頭数(ヘッダ)={res['header']['頭数']} 結果の行数={len(res['rows'])}")
        for b in blanks:
            z = rows[b]
            n = nk.get(b)
            info = {"race": rid, "馬番": b, "ZIP": {"馬体重": z["馬体重"], "人気": z["人気"], "タイム": z["タイム"]},
                    "netkeiba": None if n is None else {"着順": n["着順"], "人気": n["人気"], "馬体重": n["馬体重"], "タイム": n["タイム"]}}
            out.append(info)
            print("   ", info)
    if a.json_out:
        json.dump(out, open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
