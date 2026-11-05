# Issue #612: 本番の D1 の SQL ごとの回数・読み取り行数・書き込み行数を GraphQL(d1QueriesAdaptiveGroups)で取る。読み取り専用。
# 使い方: python3 fetch-d1-queries.py <アカウント ID> <database_id> <開始 UTC> <終了 UTC> <出力 JSON>
#   例: python3 fetch-d1-queries.py $ACCT c52e97fc-d495-4395-8141-80d20ef57a16 2026-10-06T00:00:00Z 2026-11-05T15:00:00Z q30d.json
# 認証: Cloudflare のトークンは CF_API_TOKEN に置く(読み取りの権限だけで足りる)。作業環境によっては proxy が認証を足すので、未設定なら "dummy" を送る。
# 期間は 4 週と 4 日(4w4d)まで。dimensions に date を入れているので、返りは UTC の日ごと(JST の 09:00 〜 翌 09:00)。
import json,sys,subprocess
acct,db,since,until,out_f=sys.argv[1:6]
q='''query($a:String!,$db:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
 d1q:d1QueriesAdaptiveGroups(limit:5000,filter:{databaseId:$db,datetime_geq:$s,datetime_lt:$u},orderBy:[sum_rowsRead_DESC]){count sum{rowsRead rowsWritten} dimensions{query date}}
}}}'''
body=json.dumps({"query":q,"variables":{"a":acct,"db":db,"s":since,"u":until}})
out=subprocess.run(["curl","-sS","-X","POST","https://api.cloudflare.com/client/v4/graphql","-H","Authorization: Bearer "+__import__("os").environ.get("CF_API_TOKEN","dummy"),"-H","Content-Type: application/json","-d",body],capture_output=True,text=True).stdout
d=json.loads(out)
if d.get("errors"): print(d["errors"])
rows=d["data"]["viewer"]["accounts"][0]["d1q"]
json.dump(rows,open(out_f,"w"),ensure_ascii=False)
print(len(rows), sum(r["sum"]["rowsRead"] for r in rows))
