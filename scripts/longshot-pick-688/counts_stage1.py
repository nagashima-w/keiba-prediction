# 段 1 の件数・検出力の目安の道具(結果の 3着内と材料の関係は集計しない)。使い方: SC=<scratchpad> python3 -I <このファイル>(リポジトリのルートで。table687 などのパスは SC 以下の想定)
# 段 1 の件数だけの確認。finish は「過去走の特徴(休み明け・前走の逃げ・直近3走平均着順)」を作る目的でのみ読み、評価レースの結果とは突き合わせない。
import sys, os, gzip, json, csv, collections, datetime
sys.path.insert(0, "scripts/pace-mismatch-683")
import common as c
SC = os.environ["SC"]
tab = c.load(SC + "/h687/table687.ndjson.gz")
P = {"warm": ("2021-06-20", "2021-12-31"), "explore": ("2022-01-01", "2023-12-31"), "confirm": ("2024-01-01", "2026-11-01")}
def per(d):
    for k, p in P.items():
        if p[0] <= d <= p[1]: return k
# 1. 件数
cnt = collections.defaultdict(collections.Counter)
for r in tab:
    k = per(r["date"])
    if not k: continue
    cnt[k]["races"] += 1
    why = c.exclusion_reason(r)
    if why: cnt[k]["x:" + why] += 1; continue
    cnt[k]["eligible"] += 1
    cand = [h for h in r["horses"] if h["ninki"] is not None and h["ninki"] >= 6 and h["odds"] is not None]
    cnt[k]["cand"] += len(cand)
    cnt[k]["cand6-9"] += sum(1 for h in cand if h["ninki"] <= 9)
    cnt[k]["cand10+"] += sum(1 for h in cand if h["ninki"] >= 10)
    cnt[k]["races_with_cand"] += bool(cand)
    cnt[k]["races_with_cand6-9"] += any(h["ninki"] <= 9 for h in cand)
    cnt[k]["races_with_cand10+"] += any(h["ninki"] >= 10 for h in cand)
    cnt[k]["noninki"] += sum(1 for h in r["horses"] if h["ninki"] is None or h["odds"] is None)
    cnt[k]["horses"] += len(r["horses"])
    cnt[k]["handicap"] += r["weightType"] == "ハンデ"
    cnt[k]["race_cand_ge2"] += len(cand) >= 2
for k in P: print(k, dict(cnt[k]))
# 2. 生データ: 騎手・調教師ID、ワイドの状態、過去走(フラグ用)
def runs_iter():
    for p in [SC + "/h685/hist2021.ndjson.gz", SC + "/hist/hist.ndjson.gz"]:
        for line in gzip.open(p, "rt", encoding="utf-8"):
            yield json.loads(line)
hist = {}
for r in runs_iter(): hist.setdefault(r["raceId"], r)
races = sorted(hist.values(), key=lambda r: (r["date"], r["raceId"]))
wide = collections.defaultdict(collections.Counter); ids = collections.defaultdict(collections.Counter)
hrun = collections.defaultdict(list)   # horse -> [(date, raceId, courseType, first_pos, field, finish)]
csvr = collections.defaultdict(dict)
for row in csv.DictReader(open(SC + "/hist/horse_runs.csv", encoding="utf-8")):
    d = json.loads(row["data"])
    fin = d[12] if isinstance(d[12], int) else None
    csvr[row["horse_id"]][d[5]] = (d[0].replace("/", "-"), d[17], (d[21][0] if d[21] else None), d[7], fin)
cand_info = []
jk = collections.defaultdict(list); tr = collections.defaultdict(list)  # 騎手→[(date)] 過去騎乗日
flag = collections.defaultdict(collections.Counter)
mounts_prior = collections.defaultdict(list)
for r in races:
    k = per(r["date"])
    st = [h for h in r["horses"] if h["finishStatus"] not in ("取消", "除外")]
    if k:
        w = r["payouts"].get("wide"); wide[k][(w or {}).get("state") if isinstance(w, dict) else str(type(w))] += 1
        tt = r["payouts"].get("trio"); wide[k]["trio:" + str((tt or {}).get("state"))] += 1
        wide[k]["wide_n=" + str(len((w or {}).get("payouts", [])) if isinstance(w, dict) else -1)] += 1
    if k in ("explore", "confirm"):
        tr_race = next((x for x in tab if False), None)
    if k in ("explore", "confirm"):
        n = len(st); inv = {h["horseId"]: 1 / h["winOdds"] for h in st if h["winOdds"]}
        tot = sum(inv.values())
        today = datetime.date.fromisoformat(r["date"]).toordinal()
        for h in st:
            if not h["ninki"] or h["ninki"] < 6 or not h["winOdds"]: continue
            if r["courseType"] == "障" or r.get("raceClass") == "新馬" or n < 8: continue  # 簡略(脚質判定率の除外は未反映)
            ids[k]["cand"] += 1
            ids[k]["jockey_none"] += h["jockeyId"] is None
            ids[k]["trainer_none"] += h["trainerId"] is None
            q = inv[h["horseId"]] / tot
            runs = {}
            for rid, v in csvr.get(h["horseId"], {}).items():
                if v[0] < r["date"]: runs[rid] = v
            for v in hrun.get(h["horseId"], []):
                if v[0] < r["date"]: runs[v[1]] = (v[0], v[2], v[3], v[4], v[5])
            rs = sorted(runs.values(), key=lambda x: x[0])
            if not rs:
                flag[k]["no_prior"] += 1; continue
            last = rs[-1]; days = today - datetime.date.fromisoformat(last[0]).toordinal()
            flag[k]["has_prior"] += 1
            flag[k]["longRest"] += days > 180
            flag[k]["surfaceChange"] += (last[1] is not None and last[1] != r["courseType"])
            flag[k]["surface_null"] += last[1] is None
            fr = last[2] is not None and last[3] and last[2] / last[3] <= 0.125
            flag[k]["frontRunner"] += bool(fr); flag[k]["front_null"] += (last[2] is None or not last[3])
            f3 = [x[4] for x in rs[-3:] if x[4] is not None]
            if f3:
                flag[k]["slump_known"] += 1
                flag[k]["longshotSlump"] += (q < 0.05 and sum(f3) / len(f3) >= 11.5)
            else: flag[k]["slump_null"] += 1
            # 騎手・調教師の過去騎乗数(同じ hist 内、730日以内、日付が前)
            for nm, key, store in (("j", h["jockeyId"], jk), ("t", h["trainerId"], tr)):
                if key is None: continue
                lst = [d for d in store[key] if 0 < today - d <= 730]
                ids[k][nm + "_n"] += 1
                ids[k][nm + "_ge30"] += len(lst) >= 30
                ids[k][nm + "_ge100"] += len(lst) >= 100
                ids[k][nm + "_ge300"] += len(lst) >= 300
    # 履歴の更新(終わってから)
    d0 = datetime.date.fromisoformat(r["date"]).toordinal()
    for h in st:
        fin = h["finish"] if isinstance(h["finish"], int) else None
        first = h["passing"][0] if h["passing"] else None
        hrun[h["horseId"]].append((r["date"], r["raceId"], r["courseType"], first, len(st), fin))
        if h["jockeyId"]: jk[h["jockeyId"]].append(d0)
        if h["trainerId"]: tr[h["trainerId"]].append(d0)
print("--- wide/trio states"); [print(k, dict(v)) for k, v in wide.items()]
print("--- ids"); [print(k, dict(v)) for k, v in ids.items()]
print("--- flags"); [print(k, dict(v)) for k, v in flag.items()]
