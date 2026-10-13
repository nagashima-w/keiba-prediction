"""項目5(A〜C)と項目3(馬の対応): ZIP の racelist/horselist/payback と、netkeiba の結果ページ・出馬表ページを突き合わせる。

使い方:
  python3 -I compare_races.py --zip-dir <dir> --fixtures <fixtures> --raw-dir <netkeiba 取得物> --months 202607 202609 [--json-out summary_part.json]
ネットワークには出ない。出力に馬名・騎手名は含めない(食い違いは「馬番・項目・両方の値(数値/記号のみ)」)。
"""
import argparse
import json
import os
import sys
import unicodedata
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_zip_month, race_id_of  # noqa: E402
from netkeiba_pages import parse_result, parse_shutuba  # noqa: E402

# (race_id, 出馬表の入手先, 結果ページの入手先)  fixtures/ か raw-dir かは接頭辞で区別する
RACES = [
    ("202654071201", None, "fx:nar_result_202654071201.html"),
    ("202642071301", "fx:nar_shutuba_202642071301.html", "raw:result_202642071301.html"),
    ("202654071210", "fx:nar_shutuba_202654071210.html", "fx:nar_result_202654071210.html"),
    ("202644070111", "fx:nar_shutuba_grade_202644070111.html", "raw:result_202644070111.html"),
    ("202646071203", None, "fx:nar_result_202646071203.html"),
    ("202654092706", None, "fx:nar_result_202654092706.html"),
    ("202654092711", None, "fx:nar_result_202654092711.html"),
]


def nfkc(s):
    return unicodedata.normalize("NFKC", s or "")


def time4_to_text(t):
    """ZIP の '1232' (=1:23.2)・'574' (=0:57.4) を netkeiba の '1:23.2'・'0:57.4' に。"""
    if not t or not t.isdigit() or len(t) < 3:
        return t
    return f"{int(t[:-3] or 0)}:{t[-3:-1]}.{t[-1]}"


MARKS = "△▲☆◇★"


def norm_sexage(s):
    """netkeiba は騸馬を『セ』、ZIP は『セン』と書く。"""
    return s.replace("セン", "セ")


def norm_margin(s):
    """着差の『大差』を netkeiba は『大』と書く。"""
    return "大差" if s == "大" else s


def num_or_none(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class Tally:
    def __init__(self):
        self.n = Counter()
        self.eq = Counter()
        self.diffs = defaultdict(list)

    def add(self, field, a, b, race=None, ban=None, equal=None):
        self.n[field] += 1
        ok = (a == b) if equal is None else equal
        if ok:
            self.eq[field] += 1
        else:
            self.diffs[field].append((race, ban, a, b))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--json-out")
    a = ap.parse_args()

    zip_races, zip_horses, zip_pay = {}, defaultdict(dict), {}
    for ym in a.months:
        m = load_zip_month(a.zip_dir, ym)
        for x in m["racelist"]:
            zip_races[race_id_of(x)] = x
        for x in m["horselist"]:
            zip_horses[race_id_of(x)][x["馬番"]] = x
        for x in m["payback"]:
            zip_pay[race_id_of(x)] = x

    def load(src, parser):
        if src is None:
            return None
        kind, fn = src.split(":", 1)
        base = a.fixtures if kind == "fx" else a.raw_dir
        return parser(open(os.path.join(base, fn), encoding="utf-8").read())

    t = Tally()
    jk_len = Counter()
    matched_horses = 0
    name_eq = 0
    per_race = []
    for rid, shu_src, res_src in RACES:
        z = zip_races.get(rid)
        if z is None:
            print(f"{rid}: ZIP に該当レースなし(対象外)")
            continue
        shu = load(shu_src, parse_shutuba)
        res = load(res_src, parse_result)
        hs = zip_horses[rid]
        hdr = (res or shu)["header"]
        # --- A. レース属性 ---
        t.add("A距離", int(z["距離"]), hdr["距離"], rid)
        t.add("A回り", z["回り"], hdr["回り"], rid)
        t.add("A種別(ダ/芝)", {"ダート": "ダ", "芝": "芝"}.get(z["芝ダート区分"], z["芝ダート区分"]), hdr["種別"], rid)
        t.add("A頭数", int(z["頭数"]), hdr["頭数"], rid)
        t.add("A発走時刻", z["発走時刻"][:2] + ":" + z["発走時刻"][2:], hdr["発走"], rid)
        t.add("A馬場(前方一致)", z["馬場"], hdr["馬場"], rid, equal=bool(hdr["馬場"]) and z["馬場"].startswith(hdr["馬場"]))
        if res:
            t.add("A天候", z["天候"], hdr["天候"], rid)
        t.add("Aレース名(NFKC)", nfkc(z["レース名"]), nfkc(hdr["レース名"].split("\n")[0]), rid)
        # --- B/C. 出走馬 ---
        rows = {r["馬番"]: r for r in (res["rows"] if res else shu["rows"])}
        t.add("B出走頭数(馬番の集合)", sorted(hs, key=int), sorted(rows, key=int), rid)
        shu_rows = {r["馬番"]: r for r in shu["rows"]} if shu else {}
        for ban, r in rows.items():
            zh = hs.get(ban)
            if zh is None:
                t.add("B馬番の対応", None, ban, rid, ban)
                continue
            matched_horses += 1
            t.add("B馬名", zh["馬名"], r["馬名"], rid, ban)
            t.add("B枠", zh["枠番"], r["枠"], rid, ban)
            t.add("B性齢(表記のまま)", zh["性"] + zh["齢"], r["性齢"], rid, ban)
            t.add("B性齢(セン=セ に正規化)", norm_sexage(zh["性"] + zh["齢"]), norm_sexage(r["性齢"]), rid, ban)
            zk = zh["負担重量"].lstrip("△▲☆◇★")
            t.add("B斤量(減量記号を除く)", num_or_none(zk), num_or_none(r["斤量"]), rid, ban)
            jk_z, jk_n = nfkc(zh["騎手名"]), nfkc(r["騎手"])
            t.add("B騎手(完全一致)", jk_z, jk_n, rid, ban)
            jk_n2 = jk_n.lstrip(MARKS)
            jk_z2 = jk_z.lstrip(MARKS)
            t.add("B騎手(減量記号を除いて、ZIPがnetkeibaの前方一致)", True, None, rid, ban, equal=jk_n2.startswith(jk_z2))
            t.add("B騎手(減量記号の有無が一致)", jk_z[:1] in MARKS, jk_n[:1] in MARKS, rid, ban)
            jk_len.update([len(jk_z2)])
            if res:
                t.add("B馬体重", zh["馬体重"], r["馬体重"], rid, ban)
                inc = zh["馬体重増減"]
                t.add("B増減", num_or_none(inc), num_or_none(r["増減"]), rid, ban)
                t.add("C着順", zh["着順"], r["着順"], rid, ban)
                t.add("Cタイム", time4_to_text(zh["タイム"]), r["タイム"], rid, ban)
                t.add("C着差(表記のまま)", zh["着差"], r["着差"], rid, ban)
                t.add("C着差(大差=大 に正規化)", norm_margin(zh["着差"]), norm_margin(r["着差"]), rid, ban)
                t.add("C上がり3F", num_or_none(zh["上がり3F"]), num_or_none(r["後3F"]), rid, ban)
                t.add("C人気", zh["人気"], r["人気"], rid, ban)
        # --- C. 払戻(単勝・複勝) ---
        if res:
            pz = zip_pay.get(rid)
            if pz:
                tan = res["払戻"].get("単勝")
                t.add("C単勝の組番", [pz["単勝組番"]], tan["馬番"], rid)
                t.add("C単勝の払戻", [int(pz["単勝払戻金（円）"])], tan["払戻"], rid)
                fuku = res["払戻"].get("複勝")
                zf_num = [pz[f"複勝組番{i}"] for i in (1, 2, 3) if pz.get(f"複勝組番{i}")]
                zf_yen = [int(pz[f"複勝払戻金{i}（円）"]) for i in (1, 2, 3) if pz.get(f"複勝払戻金{i}（円）")]
                t.add("C複勝の組番", zf_num, fuku["馬番"], rid)
                t.add("C複勝の払戻", zf_yen, fuku["払戻"], rid)
        per_race.append({"race_id": rid, "頭数(ZIP)": len(hs), "出馬表": bool(shu), "結果": bool(res)})

    print("ZIP の騎手名の長さの分布(減量記号を除く):", dict(sorted(jk_len.items())))
    print(f"突き合わせたレース数={len(per_race)} 馬番で対応した馬={matched_horses}")
    for r in per_race:
        print("  ", r)
    print()
    summary = {}
    for f in sorted(t.n):
        print(f"{f}: 一致 {t.eq[f]}/{t.n[f]}")
        summary[f] = {"n": t.n[f], "一致": t.eq[f]}
        for race, ban, x, y in t.diffs[f][:8]:
            print(f"     食い違い race={race} 馬番={ban}  ZIP={x!r}  netkeiba={y!r}")
    if a.json_out:
        with open(a.json_out, "w", encoding="utf-8") as fp:
            json.dump({"races": per_race, "matched_horses": matched_horses, "fields": summary}, fp, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
