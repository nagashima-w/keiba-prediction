"""netkeiba(nar.netkeiba.com)のレース結果ページ・出馬表ページを、突き合わせに必要な項目だけ読む(調査用の簡易パーサ)。

本体の `packages/core/src/scraper/` のパーサの代わりではない(あちらは TypeScript で、調査スクリプトから
呼ぶには tsx と依存の導入が要る)。ここで読む項目は、フィクスチャ上で目視確認済みの構造だけ。
"""
import re

from common import strip_tags


def _race_header(html):
    name = re.search(r'<div class="RaceName">\s*(.*?)\s*</div>', html, re.S)
    d1 = re.search(r'<div class="RaceData01">(.*?)</div>', html, re.S).group(1)
    d2 = re.search(r'<div class="RaceData02">(.*?)</div>', html, re.S).group(1)
    t = strip_tags(d1)
    m_start = re.search(r"(\d{1,2}:\d{2})発走", t)
    m_dist = re.search(r"(芝|ダ|障)\s*(\d+)m", t)
    m_turn = re.search(r"\((右|左|直)", t)
    m_weather = re.search(r"天候:(\S+)", t)
    m_going = re.search(r"馬場:(\S+)", t)
    m_heads = re.search(r"(\d+)頭", strip_tags(d2))
    return {
        "レース名": strip_tags(name.group(1)) if name else None,
        "発走": m_start.group(1) if m_start else None,
        "種別": m_dist.group(1) if m_dist else None,
        "距離": int(m_dist.group(2)) if m_dist else None,
        "回り": m_turn.group(1) if m_turn else None,
        "天候": m_weather.group(1) if m_weather else None,
        "馬場": m_going.group(1) if m_going else None,
        "頭数": int(m_heads.group(1)) if m_heads else None,
    }


def parse_result(html):
    """結果ページ。着順の行(馬番をキーにできる)と、単勝・複勝の払戻を返す。"""
    head = _race_header(html)
    i = html.find('id="All_Result_Table"')
    tbody = html[i:].split("<tbody>", 1)[1].split("</tbody>", 1)[0]
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody, re.S):
        tds = re.findall(r"<td([^>]*)>(.*?)</td>", tr, re.S)
        if len(tds) < 10:
            continue
        txt = [strip_tags(re.sub(r"<small>.*?</small>", "", c, flags=re.S)) for _, c in tds]
        link = re.search(r"db\.netkeiba\.com/horse/(\d{10})/?\"[^>]*title=\"([^\"]*)\"", tr)
        weight = re.search(r"<td class=\"Weight\">\s*([^<]*)<small>\(([^)]*)\)</small>", tr)
        odds = re.search(r"Odds_Ninki\">([^<]*)<", tr) or re.search(r'class="Odds Txt_R">\s*<span\s*>([^<]*)<', tr)
        rows.append({
            "着順": txt[0],
            "枠": txt[1],
            "馬番": txt[2],
            "horse_id": link.group(1) if link else None,
            "馬名": link.group(2) if link else None,
            "性齢": txt[4],
            "斤量": txt[5],
            "騎手": txt[6],
            "タイム": txt[7],
            "着差": txt[8],
            "人気": txt[9],
            "単勝オッズ": odds.group(1).strip() if odds else None,
            "後3F": txt[11],
            "馬体重": weight.group(1).strip() if weight else None,
            "増減": weight.group(2).strip() if weight else None,
        })
    # 払戻(単勝・複勝のみ)
    pay = {}
    for key, cls in (("単勝", "Tansho"), ("複勝", "Fukusho")):
        m = re.search(r'<tr class="%s">(.*?)</tr>' % cls, html, re.S)
        if not m:
            continue
        blk = m.group(1)
        nums = re.findall(r"<div><span>(\d+)</span></div>", blk)
        payout = re.search(r'<td class="Payout"><span>(.*?)</span>', blk, re.S).group(1)
        pay[key] = {"馬番": nums, "払戻": [int(x.replace(",", "")) for x in re.findall(r"([\d,]+)円", payout)]}
    return {"header": head, "rows": rows, "払戻": pay}


def parse_shutuba(html):
    """出馬表ページ。馬番・枠・馬名・horse_id・性齢・斤量・騎手の行を返す。"""
    head = _race_header(html)
    rows = []
    for m in re.finditer(r'<tr class="HorseList"[^>]*>(.*?)</tr>', html, re.S):
        tr = m.group(1)
        waku = re.search(r'<td class="Waku\d*">(\d+)</td>', tr)
        uma = re.search(r'<td class="Umaban\d*"[^>]*>(\d*)</td>', tr)
        link = re.search(r"db\.netkeiba\.com/horse/(\d{10})\"[^>]*title=\"([^\"]*)\"", tr)
        age = re.search(r'<span class="Age">([^<]*)</span>', tr)
        wt = re.search(r'<td class="Txt_C">\s*([\d.]+)\s*</td>', tr)
        jk = re.search(r'<span class="Jockey">.*?title="([^"]*)"', tr, re.S)
        if not link:
            continue
        rows.append({
            "枠": waku.group(1) if waku else None,
            "馬番": uma.group(1) if uma else None,
            "horse_id": link.group(1),
            "馬名": link.group(2),
            "性齢": age.group(1) if age else None,
            "斤量": wt.group(1) if wt else None,
            "騎手": jk.group(1) if jk else None,
        })
    return {"header": head, "rows": rows}
