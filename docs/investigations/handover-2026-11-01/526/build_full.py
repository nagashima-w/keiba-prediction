# #526 の測り直し用。prior の書き出しの中央の行に、#532 の結果(NDJSON)から馬 ID・今回の騎手 ID を付け、
# 履歴は #532 の結果と horse_runs の和(レース ID で重複を除く)から作る。定義は build.py(事前登録)と同じ。
# 使い方: python3 -I build_full.py <prior.ndjson.gz> <horse_runs.csv> <hist532.ndjson.gz> <out.json>
import csv, json, gzip, sys, collections
prior_p, hr_p, h532_p, out = sys.argv[1:5]
runs = collections.defaultdict(dict)  # horse_id -> {race_id: run}
cur = {}                               # (race_id, umaban) -> (horse_id, jockey_id)
for r in csv.DictReader(open(hr_p, encoding='utf-8')):
    t = json.loads(r['data'])
    if not t[0] or len(t[0]) != 10 or not t[5]: continue
    fin = t[12][0] if isinstance(t[12], list) else t[12]
    runs[r['horse_id']][t[5]] = dict(key=t[5], date=t[0].replace('/', ''), n=t[7], fin=fin if isinstance(fin, int) else None, jockey=t[14])
    if t[9] is not None: cur.setdefault((t[5], int(t[9])), (r['horse_id'], t[14]))
src = collections.Counter()
for l in gzip.open(h532_p, 'rt'):
    rc = json.loads(l)
    n = rc.get('fieldSizeDeclared') or len(rc['horses'])
    for h in rc['horses']:
        if not h.get('horseId'): continue
        runs[h['horseId']][rc['raceId']] = dict(key=rc['raceId'], date=rc['date'].replace('-', ''), n=n, fin=h['finish'], jockey=h['jockeyId'])
        cur[(rc['raceId'], int(h['umaban']))] = (h['horseId'], h['jockeyId'])  # 結果ページを優先
f = gzip.open(prior_p, 'rt'); f.readline()
rows = []; miss = collections.Counter()
for l in f:
    d = json.loads(l)
    if d['venue_kind'] != 'central' or d['prior'] is None or d['finish_position'] is None: continue
    k = (d['race_id'], int(d['umaban']))
    if k not in cur: miss['つながらない'] += 1; continue
    h, jockey = cur[k]
    if not jockey: miss['騎手なし'] += 1; continue
    prev = sorted((p for p in runs[h].values() if p['date'] < d['kaisai_date'] and p['fin'] is not None and p['n'] and p['n'] >= 2), key=lambda p: (p['date'], p['key']))
    if not prev: miss['前の走なし'] += 1; continue
    rel = lambda p: (p['fin'] - 1) / (p['n'] - 1)
    same = [rel(p) for p in prev if p['jockey'] == jockey]
    other = [rel(p) for p in prev if p['jockey'] and p['jockey'] != jockey]
    aff = (sum(other)/len(other) - sum(same)/len(same)) * len(same)/(len(same)+2) if same and other else None
    switch = 1 if prev[-1]['jockey'] and prev[-1]['jockey'] != jockey else 0
    rows.append(dict(date=d['kaisai_date'], race=d['race_id'], prior=d['prior'], y=1 if d['finish_position'] <= 3 else 0, aff=aff, switch=switch))
json.dump(rows, open(out, 'w'))
print('rows', len(rows), 'days', len({r['date'] for r in rows}), dict(miss))
