# prior の書き出しの行を horse_runs の走と (race_id, 馬番) でつなぎ、つながる件数を数える。
import csv, json, gzip, sys, collections
prior_p, hr_p = sys.argv[1], sys.argv[2]
idx = {}
for r in csv.DictReader(open(hr_p, encoding='utf-8')):
    t = json.loads(r['data'])
    if t[5] and t[9] is not None: idx[(t[5], int(t[9]))] = (r['horse_id'], t)
f = gzip.open(prior_p, 'rt'); f.readline()
c = collections.Counter()
for l in f:
    d = json.loads(l)
    k = (d['race_id'], int(d['umaban']))
    hit = k in idx
    fp = d['finish_position']
    c[(d['venue_kind'], hit, fp is not None)] += 1
for k, v in sorted(c.items(), key=str): print(k, v)
