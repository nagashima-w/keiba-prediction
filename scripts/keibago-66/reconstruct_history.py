"""項目5-D/E: ZIP の成績列(全成績・ダート左/右・当競馬場・当距離・最高タイム)を、netkeiba の戦績の行から再構成して一致率を測る。

規則の大半は標本1(高知 7/12 1R・浦和 7/13 1R の 20 頭)で、不一致を見たあとに決めたもの。標本2(大井 7/1 11R 帝王賞の 13 頭)では
規則を**変えずに**当てはめ、不一致が出たら数と内訳をそのまま出す(過学習の確認)。ただし**海外の走の扱い**(全成績に数える・左右には数えない)は
標本1 に海外の行が無く、標本2 で確定した。そのため全成績・ダート左右の標本2 の一致は独立した検証ではない(`固定した規則`/`規則の由来` に書いた)。
参考として全成績の仮説の比較も出すが、規則の選択には使わない。
『ZIP の行は発走前の成績か』(E)は、参考の比較(<日付 か <=日付 か)に出る。

使い方:
  python3 -I reconstruct_history.py --zip-dir <dir> --fixtures <fixtures> --raw-dir <netkeiba 取得物> --months 202607 202609 [--json-out x.json]
ネットワークには出ない。出力に馬名は含めない(馬番だけ)。
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_zip_month, parse_record, parse_results_table, time_to_sec, race_id_of, VENUE_CODE  # noqa: E402
from netkeiba_pages import parse_result  # noqa: E402

# 調査対象のレース: (標本, race_id, 結果ページの入手先)。標本1 で規則を決め、標本2(帝王賞)では規則を変えずに当てはめる
# (ただし海外の扱いは標本1 に海外の行が無いため、標本2 で確定した)。
TARGETS = [
    ("標本1", "202654071201", "fx:nar_result_202654071201.html"),
    ("標本1", "202642071301", "raw:result_202642071301.html"),
    ("標本2", "202644070111", "raw:result_202644070111.html"),
]
NAR_NAMES = set(VENUE_CODE) | {"帯広"}
JRA_VENUES = {"札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"}
# 中央のダートの回り。出典はリポジトリの packages/core/src/scorer/course-traits.ts の COURSE_TRAITS(左回り: 東京・中京・新潟、他は右)。
# ZIP の成績列に中央の走が含まれるかどうかをこの表で検証する(含まれるなら、一致率が上がる)。
JRA_TURN = {"札幌": "右", "函館": "右", "福島": "右", "新潟": "左", "東京": "左", "中山": "右", "中京": "左", "京都": "右", "阪神": "右", "小倉": "右"}


def venue_of(kai):
    """戦績の『開催』欄から (種別, 競馬場名) を返す。地方は競馬場名そのまま、中央は『1中京9』→中京、それ以外は海外等。"""
    if kai in NAR_NAMES:
        return "nar", ("帯広ば" if kai == "帯広" else kai)
    m = re.fullmatch(r"\d+([^\d]+)\d+", kai)
    if m and m.group(1) in JRA_VENUES:
        return "jra", m.group(1)
    return "other", kai


def parse_dist(s):
    m = re.fullmatch(r"(芝|ダ|障)(\d+)", s)
    return (m.group(1), int(m.group(2))) if m else (None, None)


def rec(rows, mode):
    """mode: 'num' 数字の着順のみ / 'num+中' 競走中止も着外に数える / 'all' 取消・除外・空欄も着外に数える。"""
    c = [0, 0, 0, 0]
    for r in rows:
        k = r["着順"]
        if k.isdigit():
            n = int(k)
            c[n - 1 if n <= 3 else 3] += 1
        elif mode == "all" or (mode == "num+中" and k == "中"):
            c[3] += 1
    return tuple(c)




def best_time(rows):
    ts = [time_to_sec(x["タイム"]) for x in rows if x["タイム"] and x["着順"].isdigit()]
    ts = [t for t in ts if t is not None]
    return min(ts) if ts else None


def fmt_good(t):
    return "良" + f"{int(t // 60)}:{t % 60:04.1f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()

    zr, zh = {}, defaultdict(dict)
    for ym in a.months:
        m = load_zip_month(a.zip_dir, ym)
        for x in m["racelist"]:
            zr[race_id_of(x)] = x
        for x in m["horselist"]:
            zh[race_id_of(x)][x["馬番"]] = x
    # 回りの表: (競馬場, 種別, 距離) -> 回り(turn_table.py で関数であることを確認済み)
    turn = {}
    for r in zr.values():
        kind = {"ダート": "ダ", "芝": "芝"}.get(r["芝ダート区分"])
        if kind:
            turn[(r["競馬場"], kind, int(r["距離"]))] = r["回り"]
    # 競馬場ごとに回りが一意なら、距離が表に無い行にも当てる(大井のように複数ある競馬場は当てない)
    venue_turns = defaultdict(set)
    for (v, k, d), t in turn.items():
        venue_turns[(v, k)].add(t)

    def turn_of(x):
        if x["_sk"] not in ("ダ", "芝"):
            return None, "対象外"
        if x["_kind"] == "jra":
            return JRA_TURN.get(x["_venue"]), "中央の表"
        if x["_kind"] != "nar":
            return None, "海外等"
        t = turn.get((x["_venue"], x["_sk"], x["_dist"]))
        if t:
            return t, "地方の表(距離まで一致)"
        ts = venue_turns.get((x["_venue"], x["_sk"]), set())
        if len(ts) == 1:
            return next(iter(ts)), "地方の表(競馬場だけ一致)"
        return None, "判定不能"

    # 馬ごとの(ZIPの行, 戦績の行)
    horses = []
    for sample, rid, src in TARGETS:
        kind, fn = src.split(":", 1)
        res = parse_result(open(os.path.join(a.fixtures if kind == "fx" else a.raw_dir, fn), encoding="utf-8").read())
        date = zr[rid]["競走年月日"]
        date_slash = f"{date[:4]}/{date[4:6]}/{date[6:]}"
        for r in res["rows"]:
            z = zh[rid][r["馬番"]]
            p = os.path.join(a.raw_dir, f"horse_results_{r['horse_id']}.json")
            if not os.path.exists(p):
                p = os.path.join(a.fixtures, f"horse_results_{r['horse_id']}.json")
            rows = parse_results_table(p)
            for x in rows:
                x["_kind"], x["_venue"] = venue_of(x["開催"])
                x["_sk"], x["_dist"] = parse_dist(x["距離"])
                x["_turn"], x["_turn_src"] = turn_of(x)
            horses.append({"sample": sample, "race": rid, "ban": r["馬番"], "venue": zr[rid]["競馬場"], "dist": int(zr[rid]["距離"]),
                           "date": date_slash, "z": z, "rows": rows})
    samples = sorted(set(h["sample"] for h in horses))
    print("標本:", {s: sum(1 for h in horses if h["sample"] == s) for s in samples}, " 戦績の行=", sum(len(h["rows"]) for h in horses))
    row_kinds = Counter()
    for h in horses:
        for x in h["rows"]:
            if x["日付"] < h["date"]:
                row_kinds[(h["sample"], x["_kind"])] += 1
    print("発走前の戦績の行の種別(標本, 種別):", dict(row_kinds))

    def pre(h, strict=True):
        return [x for x in h["rows"] if (x["日付"] < h["date"] if strict else x["日付"] <= h["date"])]

    # ---- 規則(標本1で決めたものを、標本2でも変えずに使う。海外の扱いだけは標本2 で確定したもの) ----
    def base(h):
        return pre(h, True)

    def total(h):
        return rec(base(h), "num+中")

    def left(h):
        return rec([x for x in base(h) if x["_sk"] == "ダ" and x["_turn"] == "左"], "num+中")

    def right(h):
        return rec([x for x in base(h) if x["_sk"] == "ダ" and x["_turn"] == "右"], "num+中")

    def same_venue(h):
        return rec([x for x in base(h) if x["_kind"] == "nar" and x["_venue"] == h["venue"]], "num+中")

    def sel_vd(h):
        return [x for x in base(h) if x["_venue"] == h["venue"] and x["_dist"] == h["dist"] and x["_sk"] == "ダ"]

    def same_vd(h):
        return rec([x for x in sel_vd(h) if x["_kind"] == "nar"], "num+中")

    def best(h):
        return best_time(sel_vd(h))

    def good(h):
        g = best_time([x for x in sel_vd(h) if x["馬場"] == "良"])
        return "" if g is None else fmt_good(g)

    RULES = [
        ("全成績", "全成績", total, parse_record),
        ("ダート左成績", "ダート左成績", left, parse_record),
        ("ダート右成績", "ダート右成績", right, parse_record),
        ("当競馬場成績", "当競馬場成績", same_venue, parse_record),
        ("うち当距離成績", "うち当距離成績", same_vd, parse_record),
        ("最高タイム", "最高タイム", best, time_to_sec),
        ("最高タイム良馬場", "最高タイム良馬場", good, lambda s: s),
    ]
    out = {"固定した規則": {
        "全成績": "中央・地方・海外等の全ての行。日付が当日より前。数字の着順+`中`を着外に数える(`取`・`除外`・空欄は数えない)",
        "ダート左/右": "ダートの行。回りは地方=(競馬場,距離)の表(無ければ競馬場だけ)、中央=COURSE_TRAITS。着順の数え方は全成績と同じ",
        "当競馬場/当距離": "同じ地方競馬場の行 / 同じ地方競馬場・同じ距離のダートの行",
        "最高タイム": "同じ競馬場・同じ距離のダートで、数字の着順の行の最小タイム(馬場を問わない)",
        "最高タイム良馬場": "同じ競馬場・同じ距離のダートに良馬場の行があれば `良`+その最小タイム、無ければ空",
    }, "規則の由来": {
        "標本1で決めた": "中央の行を数える/`中`(競走中止)を着外に数える/`取`・空欄は数えない/中央の回りは COURSE_TRAITS/良馬場の規則(良馬場の行が無ければ空)",
        "標本2で確定した(標本1 には海外の行が 0 件で決められなかった)": "海外等の行を全成績に数える/海外のダートの行を左右には数えない",
        "標本2に当てはめて独立に検証できた": "中央の行を数える・`取`/`除`/空欄を数えない(`除` 1 行と空欄 1 行のみ。弱い)・当競馬場・当距離・最高タイム・良馬場の規則",
        "標本2では検証できていない": "`中` を着外に数える(標本2 に `中` の行が 0 件)",
        "注": "全成績・ダート左・ダート右の3列の標本2 の一致は、海外の扱いを標本2 で確定したため、独立した検証ではない",
    }, "標本": {}}
    for s in samples + ["全体"]:
        hs = [h for h in horses if s == "全体" or h["sample"] == s]
        print(f"\n=== {s}({len(hs)}頭)  固定した規則での一致")
        o = {"頭数": len(hs), "列": {}}
        for title, zfield, fn, parse in RULES:
            ok, bad = 0, []
            nz = 0
            for h in hs:
                zv = parse(h["z"][zfield])
                pv = fn(h)
                if zv not in (None, (0, 0, 0, 0), ""):
                    nz += 1
                if pv == zv:
                    ok += 1
                else:
                    bad.append((h["race"][-6:], h["ban"], zv, pv))
            print(f"  {title}: 一致 {ok}/{len(hs)}  (ZIP の値が空・0-0-0-0 でない馬={nz})")
            for b in bad:
                print("     食い違い(race末尾6桁, 馬番, ZIP, 再構成):", b)
            o["列"][title] = {"一致": ok, "n": len(hs), "ZIPの値が自明でない馬": nz, "不一致": len(bad)}
        out["標本"][s] = o

    # ---- 参考: 全成績の仮説の比較(規則の選択には使わない) ----
    scopes = {
        "全て": lambda x: True,
        "地方のみ": lambda x: x["_kind"] == "nar",
        "地方+中央": lambda x: x["_kind"] in ("nar", "jra"),
    }
    print("\n=== 参考: 全成績の仮説の比較(標本ごと)")
    cmp_out = {}
    for sn, sf in scopes.items():
        for st, strict in (("発走前(<)", True), ("結果込み(<=)", False)):
            for mode, mn in (("num", "数字のみ"), ("num+中", "数字+中"), ("all", "取消・除外・空欄も")):
                key = f"{sn} / {st} / {mn}"
                cnt = {}
                for s in samples:
                    hs = [h for h in horses if h["sample"] == s]
                    cnt[s] = sum(1 for h in hs if rec([x for x in pre(h, strict) if sf(x)], mode) == parse_record(h["z"]["全成績"]))
                cmp_out[key] = cnt
                print(f"  {key}: " + " ".join(f"{s}={cnt[s]}/{sum(1 for h in horses if h['sample'] == s)}" for s in samples))
    out["参考_全成績の仮説比較"] = cmp_out

    # 回りの表に無い行
    unk, tot = Counter(), 0
    for h in horses:
        for x in base(h):
            if x["_kind"] == "nar" and x["_sk"] == "ダ":
                tot += 1
                if x["_turn"] is None:
                    unk[(x["_venue"], x["_dist"])] += 1
    print(f"\n地方のダートの行={tot}, 回りの表に無い行={sum(unk.values())}  内訳(競馬場,距離)={dict(unk)}")
    out["回りの表に無い行"] = {"地方のダート行": tot, "表に無い行": sum(unk.values()), "内訳": {f'{k[0]}|{k[1]}': v for k, v in unk.items()}}
    # 規則の入力に、非数字の着順・海外等の行がどれだけあったか
    nn = Counter()
    for h in horses:
        for x in base(h):
            if not x["着順"].isdigit():
                nn[(h["sample"], x["_kind"], x["着順"])] += 1
    print("発走前の行のうち着順が数字でない行(標本, 種別, 着順):", dict(nn))
    out["着順が数字でない行(発走前)"] = {"|".join(k): v for k, v in nn.items()}
    out["発走前の戦績の行の種別"] = {"|".join(k): v for k, v in row_kinds.items()}

    if a.json_out:
        json.dump(out, open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
