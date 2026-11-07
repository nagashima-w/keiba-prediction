"""再現した prior(replay.ts の出力)と、本番の prior(prior-dataset)の一致の度合い。
使い方: python3 -I agree.py <replay.ndjson.gz> <prior-dataset.ndjson.gz>
重なるレース・馬は (race_id, umaban) で突き合わせる。本番の prior は当時の設定の重み・馬の全戦績・netkeiba の年別成績で作られたもので、
再現側は手元の過去のレコードだけから作るため、完全には一致しない(差の大きさを測るのがこの表の目的)。
"""
import gzip, json, sys, math
import numpy as np

rep = {}
for line in gzip.open(sys.argv[1], 'rt'):
    r = json.loads(line)
    rep[(r['raceId'], r['umaban'])] = r
prod = []
for i, line in enumerate(gzip.open(sys.argv[2], 'rt')):
    r = json.loads(line)
    if i == 0:
        continue
    prod.append(r)

pairs = []
for r in prod:
    k = (r['race_id'], r['umaban'])
    # 本番の重みは時期で変わる(10 月に 近走着順 0.2→0.7 など)。再現は現行の既定(cloud の DEFAULT_CLOUD_SETTINGS)で作るので、
    # 現行の重みの版(近走着順 0.7 かつ タイム指数あり)の分析だけと突き合わせる。
    cur = r['contributions'] and any(c['biasName'] == '近走着順' and abs(c['weight'] - 0.7) < 1e-9 for c in r['contributions']) \
        and any(c['biasName'] == 'タイム指数' for c in r['contributions'])
    if k in rep and cur:
        pairs.append((r, rep[k]))
print('本番の行', len(prod), '重なる行', len(pairs), '重なるレース', len(set(p[0]['race_id'] for p in pairs)))

a = np.array([p[0]['prior'] for p in pairs]); b = np.array([p[1]['prior'] for p in pairs])
print('prior: 相関 %.3f  平均絶対差 %.4f  平均差(再現-本番) %+.4f  本番の sd %.4f 再現の sd %.4f' % (np.corrcoef(a, b)[0, 1], np.abs(a - b).mean(), (b - a).mean(), a.std(), b.std()))
# レース内の順位の一致(スピアマン)
from collections import defaultdict
by = defaultdict(list)
for p in pairs:
    by[p[0]['race_id']].append((p[0]['prior'], p[1]['prior']))
def rank(x):
    o = np.argsort(np.argsort(x)); return o
rs = []
for k, v in by.items():
    if len(v) >= 5:
        x = np.array([t[0] for t in v]); y = np.array([t[1] for t in v])
        rs.append(np.corrcoef(rank(x), rank(y))[0, 1])
print('レース内の順位相関(スピアマン)の中央値 %.3f  平均 %.3f  (n=%d レース)' % (np.median(rs), np.mean(rs), len(rs)))

# 項目別
names = [c['biasName'] for c in pairs[0][0]['contributions']]
print('%-14s %7s %7s %9s %9s %8s' % ('項目', '相関', '平均絶対差', '本番の適用率', '再現の適用率', '同値の率'))
for nm in names:
    if not any(nm in p[1]['contrib'] for p in pairs[:50]):
        print('%-14s (再現側に同名の項目なし)' % nm); continue
    xs = []; ys = []; ap = 0; ar = 0
    for p in pairs:
        c = next((c for c in p[0]['contributions'] if c['biasName'] == nm), None)
        if c is None or nm not in p[1]['contrib']: continue
        xs.append(c['correction']); ys.append(p[1]['contrib'][nm]); ap += 1 if c['applied'] else 0
        ar += 1 if p[1]['contrib'][nm] != 0 else 0
    xs = np.array(xs); ys = np.array(ys)
    corr = np.corrcoef(xs, ys)[0, 1] if xs.std() > 0 and ys.std() > 0 else float('nan')
    print('%-14s %7.3f %9.4f %9.3f %9.3f %8.3f' % (nm, corr, np.abs(xs - ys).mean(), ap / len(xs), ar / len(xs), (np.abs(xs - ys) < 1e-9).mean()))
