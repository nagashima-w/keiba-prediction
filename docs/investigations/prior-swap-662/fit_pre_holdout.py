"""Issue #662 段階 1: オッズなし版の係数を、保留(2026-08〜10)を捨てて学び直す。

使い方: PYTHONDONTWRITEBYTECODE=1 python3 -I fit_pre_holdout.py <replay.ndjson.gz> <出力.json> [<fit.py の importance.json>]
前処理・学習は scripts/stat-model-649/export_coef.py と同じ(標準化 + L2 C=1.0)。違いは学習の月が 2025-02〜2026-07 だけであること(HOLDOUT_START 以降は読み込みの時点で捨てる)。
3 つ目の引数(fit.py〈--open-holdout なし〉が書いた importance.json)を渡すと、標準化した係数を突き合わせて最大の差を出す(同じ学習の再現かの確認)。
出力は stat-shadow-coef.ts の `ShadowModelCoef` と同じ形(features・win/top2/top3 の intercept・weights)。本番の係数ファイルは変えない。
"""
import gzip, json, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

FEATURE_START, HOLDOUT_START, MIN_FIELD, LR_C = '2025-02', '2026-08', 5, 1.0
src, out = sys.argv[1:3]
cmp_path = sys.argv[3] if len(sys.argv) > 3 else None
rows = [r for r in (json.loads(l) for l in gzip.open(src, 'rt')) if FEATURE_START <= r['date'][:7] < HOLDOUT_START]
CONTRIB = sorted({k for r in rows[:2000] for k in r['contrib']})
df = pd.DataFrame({'raceId': [r['raceId'] for r in rows], 'month': [r['date'][:7] for r in rows], 'n': [r['n'] for r in rows],
                   'finish': [r['finish'] for r in rows], 'winOdds': [r['winOdds'] for r in rows], 'prior': [r['prior'] for r in rows],
                   'plWin': [r['plWin'] for r in rows]})
for k in CONTRIB:
    df['c_' + k] = [r['contrib'].get(k, 0.0) for r in rows]
g = df.groupby('raceId')
ok = g['winOdds'].transform(lambda s: s.notna().all() and (s > 0).all()) & (df['n'] >= MIN_FIELD) & g['plWin'].transform(lambda s: s.notna().all())
df = df[ok].copy()
fin = df['finish']
for nm, k in (('win', 1), ('top2', 2), ('top3', 3)):
    df['y_' + nm] = (fin <= k).astype(int)
df['log_n'] = np.log(df['n'])
pr = df['prior'].clip(1e-4, 1 - 1e-4)
df['prior_logit'] = np.log(pr / (1 - pr))
feats = ['log_n', 'prior_logit'] + ['c_' + k for k in CONTRIB]
X = df[feats].values
sc = StandardScaler().fit(X)
res = {'trainedMonths': [df.month.min(), df.month.max()], 'races': int(df.raceId.nunique()), 'horses': int(len(df)), 'features': feats}
std = {}
for obj in ('win', 'top2', 'top3'):
    m = LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(X), df['y_' + obj].values)
    w = m.coef_[0] / sc.scale_
    res[obj] = {'intercept': float(m.intercept_[0] - np.sum(m.coef_[0] * sc.mean_ / sc.scale_)), 'weights': [float(x) for x in w]}
    std[obj] = dict(zip(feats, map(float, m.coef_[0])))
json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
print('学習', res['trainedMonths'], 'レース', res['races'], '馬', res['horses'])
if cmp_path:
    ref = json.load(open(cmp_path))['lr_noodds']
    worst = max(abs(std[o][f] - ref[o][f]) for o in std for f in feats)
    print('fit.py(保留なし)の importance.json との標準化した係数の最大差', worst)
