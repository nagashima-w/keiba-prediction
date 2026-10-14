"""#66 の集計を一括で再実行し、馬名・騎手名を含まない summary.json にまとめる。

使い方:
  python3 -I run_all.py --zip-dir <dir> --fixtures <fixtures> --raw-dir <netkeiba 取得物> --out docs/investigations/keibago-66/summary.json
入力(ZIP・取得物)はリポジトリの外に置く。ネットワークには出ない。
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MONTHS = ["202607", "202609"]


def run(script, args, out):
    r = subprocess.run([sys.executable, "-I", "-B", os.path.join(HERE, script)] + args + ["--json-out", out], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"{script} が失敗: {r.stderr}")
    return json.load(open(out, encoding="utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    z = ["--zip-dir", a.zip_dir, "--months"] + MONTHS
    zf = ["--zip-dir", a.zip_dir, "--fixtures", a.fixtures, "--months"] + MONTHS
    zfr = ["--zip-dir", a.zip_dir, "--fixtures", a.fixtures, "--raw-dir", a.raw_dir, "--months"] + MONTHS
    with tempfile.TemporaryDirectory() as t:
        summary = {
            "入力": {
                "ZIP": {ym: {k: hashlib.sha256(open(os.path.join(a.zip_dir, ym, "extracted", f"{ym}_{k}.csv"), "rb").read()).hexdigest()[:16]
                              for k in ("racelist", "horselist", "payback")} for ym in MONTHS},
                "注": "値は CSV の SHA-256 の先頭 16 桁。同じ ZIP を取り直したときに同一の入力か確かめるため。",
            },
            "項目3_race_idの一致": run("check_ids.py", zf, os.path.join(t, "ids.json")),
            "項目5_ABC_レースと出走馬と結果": run("compare_races.py", zfr, os.path.join(t, "races.json")),
            "項目5_戦績の行との突き合わせ": run("compare_history_rows.py", zfr, os.path.join(t, "hist_rows.json")),
            "項目5_D_E_成績の再構成": run("reconstruct_history.py", zfr, os.path.join(t, "recon.json")),
            "項目5_着順が空で体重が数字・人気なしの行": run(
                "check_blank_rank.py",
                ["--zip-dir", a.zip_dir, "--raw-dir", a.raw_dir, "--months"] + MONTHS
                + [x for r in ("202630070206", "202648070204", "202642071410") for x in ("--race", r)],
                os.path.join(t, "blank.json")),
            "項目5_F_回りの表": run("turn_table.py", z, os.path.join(t, "turn.json")),
            "ZIPだけで分かること": run("zip_stats.py", z, os.path.join(t, "zipstats.json")),
        }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(summary, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("書き出し:", a.out)


if __name__ == "__main__":
    main()
