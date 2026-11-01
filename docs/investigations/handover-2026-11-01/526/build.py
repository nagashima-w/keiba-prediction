# prior の書き出しの中央の行を horse_runs の走と (race_id, 馬番) でつなぎ、#387 と同じ定義で相性・乗り替わりを作る。
# 着順は数えない(件数だけ)ときは --count。
import csv, json, gzip, sys, collections
prior_p, hr_p, out = sys.argv[1], sys.argv[2], sys.argv[3]
runs = collections.defaultdict(list); idx = {}
for r in csv.DictReader(open(hr_p, encoding='utf-8')):
    t = json.loads(r['data'])
    if not t[0] or len(t[0]) != 10: continue
    fin = t[12][0] if isinstance(t[12], list) else t[12]
    x = dict(key=t[5], date=t[0].replace('/', ''), n=t[7], fin=fin if isinstance(fin, int) else None, jockey=t[14], umaban=t[9])
    runs[r['horse_id']].append(x)
    if t[5] and t[9] is not None: idx[(t[5], int(t[9]))] = (r['horse_id'], x)
f = gzip.open(prior_p, 'rt'); f.readline()
rows = []
for l in f:
    d = json.loads(l)
    if d['venue_kind'] != 'central' or d['prior'] is None or d['finish_position'] is None: continue
    k = (d['race_id'], int(d['umaban']))
    if k not in idx: continue
    h, cur = idx[k]
    if not cur['jockey']: continue
    prev = [p for p in runs[h] if p['date'] < cur['date'] and p['fin'] is not None and p['n'] and p['n'] >= 2]
    prev.sort(key=lambda p: (p['date'], p['key']))
    if not prev: continue
    rel = lambda p: (p['fin'] - 1) / (p['n'] - 1)
    same = [rel(p) for p in prev if p['jockey'] == cur['jockey']]
    other = [rel(p) for p in prev if p['jockey'] and p['jockey'] != cur['jockey']]
    aff = (sum(other)/len(other) - sum(same)/len(same)) * len(same)/(len(same)+2) if same and other else None
    switch = 1 if prev[-1]['jockey'] and prev[-1]['jockey'] != cur['jockey'] else 0
    rows.append(dict(date=d['kaisai_date'], race=d['race_id'], prior=d['prior'], y=1 if d['finish_position'] <= 3 else 0, aff=aff, switch=switch))
json.dump(rows, open(out, 'w'))
tr = [r for r in rows if r['date'] < '20261001']; te = [r for r in rows if r['date'] >= '20261001']
print('rows', len(rows), 'train(7-9月)', len(tr), 'races', len({r['race'] for r in tr}), 'days', len({r['date'] for r in tr}),
      '| test(10月)', len(te), 'races', len({r['race'] for r in te}), 'days', len({r['date'] for r in te}),
      '| aff あり', sum(1 for r in rows if r['aff'] is not None), 'switch=1', sum(r['switch'] for r in rows))
