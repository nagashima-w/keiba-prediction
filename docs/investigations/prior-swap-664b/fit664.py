"""Issue #664 段階 1b: #664 の「足した後」のオッズなし版(noodds_all)の係数を、2026-07 までの学習で書き出す。

使い方: PYTHONDONTWRITEBYTECODE=1 python3 -I fit664.py <replay.ndjson.gz> <extras.ndjson.gz> <feat664.ndjson.gz> <出力.json> <eval.json>
前処理・学習は scripts/stat-features-664/fit_eval.py と同じ(標準化 + L2 C=1.0、使うレースの条件、MIN_FIELD、特徴量の順)。
係数の確認として、保留(2026-08〜10)の頭あたり対数損失を再計算し、eval.json の noodds_all と突き合わせて最大差を出す
(段階 1 で開けた値の再現の確認。新しい判断材料には使わない)。
出力は stat-shadow-coef.ts の `ShadowModelCoef` と同じ形(features・win/top2/top3 の intercept・weights)。本番の係数ファイルは変えない。
"""
import gzip, json, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

FEATURE_START, HOLDOUT_START, LAST_MONTH, MIN_FIELD, LR_C = '2025-02', '2026-08', '2026-10', 5, 1.0
OBJS = {'win': 1, 'top2': 2, 'top3': 3}
FLAGS = ['noprev', 'turf2dirt', 'dirt2turf', 'rest180', 'mid1w', 'distUp400', 'filly', 'age7', 'wLight', 'wHeavy',
         'eastInWest', 'westInEast', 'foreignJC', 'gain4']
MK_VALS = ['▲', '△', '☆', '◇', '★']
MK = ['mk_' + v for v in MK_VALS]
src, extra_src, feat_src, out, evalj = sys.argv[1:6]

rows = [r for r in (json.loads(l) for l in gzip.open(src, 'rt')) if FEATURE_START <= r['date'][:7] <= LAST_MONTH]
CONTRIB = sorted({k for r in rows[:2000] for k in r['contrib']})
df = pd.DataFrame({'raceId': [r['raceId'] for r in rows], 'month': [r['date'][:7] for r in rows], 'umaban': [r['umaban'] for r in rows],
                   'n': [r['n'] for r in rows], 'finish': [r['finish'] for r in rows], 'winOdds': [r['winOdds'] for r in rows],
                   'prior': [r['prior'] for r in rows], 'plWin': [r['plWin'] for r in rows]})
for k in CONTRIB:
    df['c_' + k] = [r['contrib'].get(k, 0.0) for r in rows]
del rows
keys = list(zip(df['raceId'], df['umaban']))
mark = {}
for line in gzip.open(extra_src, 'rt'):
    r = json.loads(line)
    mark[(r['raceId'], r['umaban'])] = r.get('mark')
mk = pd.Series([mark.get(k) for k in keys], index=df.index)
for v in MK_VALS:
    df['mk_' + v] = (mk == v).astype(float)
feat = {}
for line in gzip.open(feat_src, 'rt'):
    r = json.loads(line)
    feat[(r['raceId'], r['umaban'])] = r
nofeat = sum(1 for k in keys if k not in feat)
print('特徴量の行が無い馬', nofeat, '/', len(keys))
assert nofeat <= 0.001 * len(keys)
for f in FLAGS:
    df[f] = [float(feat[k][f]) if k in feat else (1.0 if f == 'noprev' else 0.0) for k in keys]
g = df.groupby('raceId')
ok = g['winOdds'].transform(lambda s: s.notna().all() and (s > 0).all()) & (df['n'] >= MIN_FIELD) & g['plWin'].transform(lambda s: s.notna().all())
df = df[ok].copy().sort_values(['raceId', 'umaban'], kind='mergesort').reset_index(drop=True)
for nm, k in OBJS.items():
    df['y_' + nm] = (df['finish'] <= k).astype(int)
df['log_n'] = np.log(df['n'])
pr = df['prior'].clip(1e-4, 1 - 1e-4)
df['prior_logit'] = np.log(pr / (1 - pr))
FEATS = ['log_n', 'prior_logit'] + ['c_' + k for k in CONTRIB] + FLAGS + MK
train = df[df.month < HOLDOUT_START]
test = df[df.month >= HOLDOUT_START].reset_index(drop=True)
sc = StandardScaler().fit(train[FEATS].values)
res = {'trainedMonths': [train.month.min(), train.month.max()], 'races': int(train.raceId.nunique()), 'horses': int(len(train)), 'features': FEATS}
starts = np.r_[0, np.flatnonzero(test['raceId'].values[1:] != test['raceId'].values[:-1]) + 1]
ends = np.r_[starts[1:], len(test)]
R = len(starts)
rid = np.repeat(np.arange(R), ends - starts)

def normalize(s, k):
    lo, hi = np.full(R, -30.0), np.full(R, 30.0)
    for _ in range(60):
        c = (lo + hi) / 2
        tot = np.add.reduceat(1 / (1 + np.exp(-(s + c[rid]))), starts)
        big = tot > k
        hi = np.where(big, c, hi); lo = np.where(big, lo, c)
    return np.clip(1 / (1 + np.exp(-(s + ((lo + hi) / 2)[rid]))), 1e-6, 1 - 1e-6)

ref = json.load(open(evalj))['logloss']['noodds_all']
worst = 0.0
for obj, k in OBJS.items():
    m = LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(train[FEATS].values), train['y_' + obj].values)
    w = m.coef_[0] / sc.scale_
    res[obj] = {'intercept': float(m.intercept_[0] - np.sum(m.coef_[0] * sc.mean_ / sc.scale_)), 'weights': [float(x) for x in w]}
    p = normalize(m.decision_function(sc.transform(test[FEATS].values)), k)
    y = test['y_' + obj].values
    ll = float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    print(obj, '保留の対数損失', f'{ll:.5f}', 'eval.json', f'{ref[obj]:.5f}', '差', f'{abs(ll - ref[obj]):.2e}')
    worst = max(worst, abs(ll - ref[obj]))
json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
print('学習', res['trainedMonths'], 'レース', res['races'], '馬', res['horses'], '特徴量', len(FEATS))
print('保留の対数損失と eval.json の最大差', worst)
