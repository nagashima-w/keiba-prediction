"""#66 段階A: netkeiba から、突き合わせに要る結果ページ・馬ごとの戦績を取得する(1.7 秒間隔)。

取得物は --raw-dir(リポジトリの外)に保存する。台帳(日時・HTTP ステータス・サイズ・URL)を <raw-dir>/../netkeiba-ledger.tsv に追記する。
keiba.go.jp には一切アクセスしない(ZIP はユーザーがブラウザで取得したもの)。

使い方(段階A の 20 回の再現。既存フィクスチャにある戦績は取得しない):
  python3 -I fetch_netkeiba.py --fixtures <fixtures> --raw-dir <dir> \\
      --result 202642071301 \\
      --horses-from nar_result_202654071201.html --horses-from nar_shutuba_202642071301.html \\
      --have 2021104387
  # 失敗(HTTP 400 等)した 1 頭は --retry-horse <id> で 1 回だけやり直せる
"""
import argparse
import datetime
import os
import re
import subprocess
import time

UA = "keiba-ev-tool/0.1 (personal-use research; +https://github.com/keiba-ev-tool)"  # packages/core の DEFAULT_USER_AGENT と同じ
INTERVAL = 1.7  # 仕様の下限 1.5 秒より長く


def horse_ids(path):
    s = open(path, encoding="utf-8").read()
    seen = []
    for m in re.finditer(r"db\.netkeiba\.com/horse/(\d{10})", s):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def fetch(url, out, ledger):
    t = datetime.datetime.now(datetime.timezone.utc).isoformat()
    r = subprocess.run(["curl", "-sS", "-m", "30", "-A", UA, "-o", out, "-w", "%{http_code}", url], capture_output=True, text=True)
    code = r.stdout.strip()
    size = os.path.getsize(out) if os.path.exists(out) else -1
    with open(ledger, "a") as f:
        f.write(f"{t}\t{code}\t{size}\t{url}\n")
    time.sleep(INTERVAL)
    return code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--result", action="append", default=[], help="地方の race_id。結果ページを取得する")
    ap.add_argument("--horses-from", action="append", default=[], help="fixtures 内の出馬表/結果ページ。載っている馬の戦績を取得する")
    ap.add_argument("--have", action="append", default=[], help="取得済みとして飛ばす horse_id(既存フィクスチャにある馬)")
    ap.add_argument("--retry-horse", action="append", default=[])
    ap.add_argument("--dry-run", action="store_true", help="リクエストを送らず、取得する URL の一覧だけを出す")
    a = ap.parse_args()
    os.makedirs(a.raw_dir, exist_ok=True)
    ledger = os.path.join(os.path.dirname(os.path.abspath(a.raw_dir)), "netkeiba-ledger.tsv")
    jobs = [(f"https://nar.netkeiba.com/race/result.html?race_id={rid}", os.path.join(a.raw_dir, f"result_{rid}.html")) for rid in a.result]
    seen = set(a.have)
    ids = list(a.retry_horse)
    for fn in a.horses_from:
        for h in horse_ids(os.path.join(a.fixtures, fn)):
            if h not in seen and h not in ids:
                ids.append(h)
    for h in ids:
        jobs.append((f"https://db.netkeiba.com/horse/ajax_horse_results.html?input=UTF-8&output=json&id={h}",
                     os.path.join(a.raw_dir, f"horse_results_{h}.json")))
    print(len(jobs), "件を取得します", flush=True)
    if a.dry_run:
        for url, _ in jobs:
            print("(dry-run)", url)
        return
    for url, out in jobs:
        code = fetch(url, out, ledger)
        print(code, url, flush=True)
        if code != "200":
            # 失敗の手がかり: 応答本文の先頭 200 バイトを出す(再試行は呼び出し側が 1 回だけ行う)
            with open(out, "rb") as f:
                print("   応答本文の先頭:", f.read(200), flush=True)


if __name__ == "__main__":
    main()
