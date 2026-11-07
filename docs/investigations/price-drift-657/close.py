"""#657-0 項目 4: 分析時 → 締め切り直前(回 1・回 2)→ 確定のオッズ。
使い方: PYTHONDONTWRITEBYTECODE=1 python3 -I close.py <dataset.ndjson.gz> <closebets.json> <closemeta.json>
closebets.json・closemeta.json は D1 の SELECT の結果(analysis_close_bets・analysis_close の全行)。
単勝は確定オッズ(result.horses[].win_odds)も使う。複勝・組合せの確定は的中時の払戻のみ(分析→締め切り直前の比だけ全点で見る)。"""
import gzip, json, sys, statistics as st, collections
ds, cb, cm = sys.argv[1:4]
rows = {}
for i, l in enumerate(gzip.open(ds, "rt")):
    if i == 0: continue
    r = json.loads(l)
    if r["allocation"]: rows[r["analysis_id"]] = r
close = collections.defaultdict(dict)
for b in json.load(open(cb)): close[(b["analysis_id"], b["round"])][(b["bet_type"], b["combo_key"])] = b
meta = {(m["analysis_id"], m["round"]): m for m in json.load(open(cm))}
ids = sorted({a for a, _ in meta if a in rows})
print("締め切り直前の再計算(ok)がある分析のうち配分の記録がある:", len(ids), "件(締め切り直前の ok は", len({a for a, _ in meta}), "件)")
def q(xs, p):
    s = sorted(xs); k = (len(s) - 1) * p; lo = int(k); hi = min(lo + 1, len(s) - 1); return s[lo] + (s[hi] - s[lo]) * (k - lo)
def summ(name, xs):
    print(f"| {name} | {len(xs)} | " + (" | ".join(f"{v:.3f}" for v in (st.mean(xs), q(xs, .1), q(xs, .5), q(xs, .9))) if xs else "- | - | -") + " |")
for rd in (1, 2):
    print(f"\n### 回 {rd}: 分析時の買い目と同じ (券種, キー) が締め切り直前の買い目にもあるもの(再計算で消えた買い目は含まれない。生き残りの偏り)")
    print("| 券種 | N | 平均 | p10 | 中央値 | p90 |\n|---|---|---|---|---|---|")
    by = collections.defaultdict(list); gone = collections.Counter(); tot = collections.Counter()
    for a in ids:
        if (a, rd) not in meta: continue
        cl = close[(a, rd)]
        for b in rows[a]["allocation"]["bets"]:
            tot[b["bet_type"]] += 1
            c = cl.get((b["bet_type"], b["combo_key"]))
            if c is None: gone[b["bet_type"]] += 1; continue
            if b["odds"] and c["odds"]: by[b["bet_type"]].append(c["odds"] / b["odds"])
    for t in sorted(by): summ(t, by[t])
    summ("全体", [x for v in by.values() for x in v])
    print("分析時の買い目のうち締め切り直前に消えた点数/全点数:", {t: f"{gone[t]}/{tot[t]}" for t in sorted(tot)})
print("\n### 単勝: 分析時 → 回 2 → 確定(3 つとも揃う買い目)")
rs = []
for a in ids:
    if (a, 2) not in meta: continue
    fin = {h["umaban"]: h["win_odds"] for h in rows[a]["result"]["horses"]}
    for b in rows[a]["allocation"]["bets"]:
        if b["bet_type"] != "win": continue
        c = close[(a, 2)].get(("win", b["combo_key"]))
        f = fin.get(int(b["combo_key"]))
        if c and f and b["odds"]: rs.append((c["odds"] / b["odds"], f / c["odds"], f / b["odds"]))
print("| 区間 | N | 平均 | p10 | 中央値 | p90 |\n|---|---|---|---|---|---|")
for i, n in enumerate(["分析→締め切り直前", "締め切り直前→確定", "分析→確定"]): summ(n, [x[i] for x in rs])
