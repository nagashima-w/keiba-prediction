"""#657-0b 用: 本番 R2 の分析の詳細を GET だけで読み、馬ごとの属性(騎手・調教師・性齢・斤量・馬体重・人気)だけを 1 ファイルにまとめる。
使い方: PYTHONDONTWRITEBYTECODE=1 python3 -I pull_r2.py <ids.txt> <out.ndjson> <acc.txt>  (認証は環境のプロキシが付ける。429 は待って再試行)"""
import gzip, json, ssl, sys, time, urllib.error, urllib.request
ids_f, out_f, acc_f = sys.argv[1:4]
ctx = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
acc = open(acc_f).read().strip()
def get(url):
    for k in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer dummy"}), context=ctx, timeout=60) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(5 * (k + 1)); continue
            raise
    raise RuntimeError("429 が続いた")
ok = miss = 0
with open(out_f, "w") as out:
    for aid in [l.strip() for l in open(ids_f) if l.strip()]:
        try:
            raw = get(f"https://api.cloudflare.com/client/v4/accounts/{acc}/r2/buckets/keiba-cloud-r2/objects/analyses/{aid}.json.gz")
            try: raw = gzip.decompress(raw)
            except OSError: pass
            d = json.loads(raw)
            keep = ["umaban", "sex", "age", "kinryo", "jockeyName", "trainerName", "bodyWeight", "popularity", "winOdds"]
            out.write(json.dumps({"analysis_id": int(aid), "raceId": d.get("raceId"), "horses": [{k: h.get(k) for k in keep} for h in d["raceSnapshot"]["horses"]]}, ensure_ascii=False) + "\n"); ok += 1
        except Exception as e:
            miss += 1; print("miss", aid, e, file=sys.stderr)
        time.sleep(0.2)
print("GET 件数", ok + miss, "ok", ok, "miss", miss)
