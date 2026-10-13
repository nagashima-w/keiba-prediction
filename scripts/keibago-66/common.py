"""#66 調査の共通部品(標準ライブラリのみ)。

入力はすべてリポジトリの外に置く(コミットしない)。
  --zip-dir  : <dir>/<YYYYMM>/extracted/<YYYYMM>_{racelist,horselist,payback}.csv
  --raw-dir  : netkeiba から取得した戦績 JSON(horse_results_<id>.json)と結果ページ
  --fixtures : リポジトリの fixtures/(既存のフィクスチャ)
外部から来たファイルを読むので、実行は `python3 -I` で行うこと。
"""
import csv
import json
import os
import re
from collections import defaultdict

# netkeiba の地方場コード(docs/nar-scraping-plan.md)と keiba.go.jp の競馬場名の対応。
VENUE_CODE = {
    "門別": "30", "盛岡": "35", "水沢": "36", "浦和": "42", "船橋": "43", "大井": "44",
    "川崎": "45", "金沢": "46", "笠松": "47", "名古屋": "48", "園田": "50", "姫路": "51",
    "高知": "54", "佐賀": "55", "帯広ば": "65",
}
CODE_VENUE = {v: k for k, v in VENUE_CODE.items()}


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_zip_month(zip_dir, ym):
    base = os.path.join(zip_dir, ym, "extracted")
    return {k: read_csv(os.path.join(base, f"{ym}_{k}.csv")) for k in ("racelist", "horselist", "payback")}


def race_id_of(row):
    """ZIP の行(競馬場・競走年月日・レース番号)から netkeiba の地方 race_id を組み立てる。"""
    d = row["競走年月日"]
    return d[:4] + VENUE_CODE[row["競馬場"]] + d[4:8] + row["レース番号"].zfill(2)


def parse_record(s):
    """'着-着-着-着外' を (1着,2着,3着,着外) に。空は None。"""
    if s is None or s == "":
        return None
    p = s.split("-")
    if len(p) != 4 or not all(x.isdigit() for x in p):
        raise ValueError(f"成績の形式が不正: {s!r}")
    return tuple(int(x) for x in p)


def time_to_sec(s):
    """'1:14.9' -> 74.9 。空は None。"""
    if not s:
        return None
    m = re.fullmatch(r"(\d+):(\d+)\.(\d)", s)
    if not m:
        raise ValueError(f"タイムの形式が不正: {s!r}")
    return int(m.group(1)) * 60 + int(m.group(2)) + int(m.group(3)) / 10


def strip_tags(h):
    return re.sub(r"<[^>]+>", "", h).replace("&nbsp;", " ").strip()


def parse_results_table(json_path):
    """netkeiba の ajax_horse_results.html の JSON から、戦績の行(辞書のリスト、新しい順)を返す。"""
    d = json.load(open(json_path, encoding="utf-8"))
    if d.get("status") != "OK":
        raise ValueError(f"status が OK ではない: {json_path}")
    html = d["data"]
    head = re.search(r"<thead>(.*?)</thead>", html, re.S).group(1)
    cols = [strip_tags(re.sub(r"<br\s*/?>", "", c)) for c in re.findall(r"<th[^>]*>(.*?)</th>", head, re.S)]
    body = html.split("<tbody>", 1)[1]
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", body, re.S):
        cells = [strip_tags(re.sub(r"<br\s*/?>", "", c)) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if len(cells) < len(cols):
            continue
        rows.append(dict(zip(cols, cells)))
    return rows


def group_by(rows, key):
    g = defaultdict(list)
    for r in rows:
        g[key(r)].append(r)
    return g
