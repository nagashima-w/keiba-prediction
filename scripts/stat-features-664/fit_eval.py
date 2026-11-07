"""#664 段階 1: #663 の条件を #649 の学習モデルの特徴量に足し、保留(2026-08〜10)で足す前と比べる。

使い方:
  python3 -I fit_eval.py --repro <replay.ndjson.gz> <extras.ndjson.gz> <feat664.ndjson.gz> <fit.py の importance.json>
      保留を読み込まずに、足す前の 2 モデルを学び直し、fit.py(保留なし)の標準化した係数との最大差を出す(同じ学習の再現の確認)。
  python3 -I fit_eval.py <replay.ndjson.gz> <extras.ndjson.gz> <feat664.ndjson.gz> <出力ディレクトリ>
      保留を開けて評価する(1 回だけ。docs/investigations/stat-features-664/plan.md の規則どおり)。

前処理・学習は scripts/stat-model-649/fit.py と同じ(標準化 + L2 C=1.0、使うレースの条件、MIN_FIELD)。
学習は 2025-02〜2026-07 に固定し、保留の 3 か月を一度に予測する(月ごとに学び直さない)。
"""
import gzip, json, math, os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

FEATURE_START, HOLDOUT_START, LAST_MONTH, MIN_FIELD, LR_C = '2025-02', '2026-08', '2026-10', 5, 1.0
OBJS = {'win': 1, 'top2': 2, 'top3': 3}
BOOT, SEED = 1000, 664
FLAGS = ['noprev', 'turf2dirt', 'dirt2turf', 'rest180', 'mid1w', 'distUp400', 'filly', 'age7', 'wLight', 'wHeavy',
         'eastInWest', 'westInEast', 'foreignJC', 'foreignJCnoLemaire', 'gain4']
MK = ['mk_▲', 'mk_△', 'mk_☆', 'mk_◇', 'mk_★']
PREV_BASED = {'turf2dirt', 'dirt2turf', 'rest180', 'mid1w', 'distUp400', 'foreignJC', 'foreignJCnoLemaire', 'gain4'}

repro = sys.argv[1] == '--repro'
args = sys.argv[2:] if repro else sys.argv[1:]
src, extra_src, feat_src, last = args

rows = []
for line in gzip.open(src, 'rt'):
    r = json.loads(line)
    m = r['date'][:7]
    if m < FEATURE_START or m > LAST_MONTH:
        continue
    if repro and m >= HOLDOUT_START:
        continue
    rows.append(r)
CONTRIB = sorted({k for r in rows[:2000] for k in r['contrib']})
df = pd.DataFrame({
    'raceId': [r['raceId'] for r in rows], 'month': [r['date'][:7] for r in rows], 'umaban': [r['umaban'] for r in rows],
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
for v in ['▲', '△', '☆', '◇', '★']:
    df['mk_' + v] = (mk == v).astype(float)
feat = {}
for line in gzip.open(feat_src, 'rt'):
    r = json.loads(line)
    feat[(r['raceId'], r['umaban'])] = r
nofeat = sum(1 for k in keys if k not in feat)
print('特徴量の行が無い馬', nofeat, '/', len(keys), flush=True)
assert nofeat <= 0.001 * len(keys), '特徴量の行が多く欠けている'
for f in FLAGS:
    df[f] = [float(feat[k][f]) if k in feat else (1.0 if f == 'noprev' else 0.0) for k in keys]

g = df.groupby('raceId')
ok = g['winOdds'].transform(lambda s: s.notna().all() and (s > 0).all()) & (df['n'] >= MIN_FIELD) & g['plWin'].transform(lambda s: s.notna().all())
df = df[ok].copy().sort_values(['raceId', 'umaban'], kind='mergesort').reset_index(drop=True)
fin = df['finish']
for nm, k in OBJS.items():
    df['y_' + nm] = (fin <= k).astype(int)
inv = 1.0 / df['winOdds']
df['q'] = inv / inv.groupby(df['raceId']).transform('sum')
df['m_logit'] = np.log(df['q'] / (1 - df['q']))
df['log_n'] = np.log(df['n'])
pr = df['prior'].clip(1e-4, 1 - 1e-4)
df['prior_logit'] = np.log(pr / (1 - pr))
df['oddsRank'] = df.groupby('raceId')['winOdds'].rank(method='min')
CF = ['c_' + k for k in CONTRIB]
BASE_L, BASE_NO = ['m_logit', 'log_n', 'prior_logit'] + CF, ['log_n', 'prior_logit'] + CF
train = df[df.month < HOLDOUT_START]
print('学習 レース', train.raceId.nunique(), '馬', len(train), flush=True)

def fit(feats, obj, tr):
    X = tr[feats].values
    sc = StandardScaler().fit(X)
    m = LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(X), tr['y_' + obj].values)
    return sc, m

if repro:
    ref = json.load(open(last))
    worst = {}
    for name, feats in (('lr_noodds', BASE_NO), ('lr_odds', BASE_L)):
        w = 0.0
        for obj in OBJS:
            _, m = fit(feats, obj, train)
            w = max(w, max(abs(float(c) - ref[name][obj][f]) for c, f in zip(m.coef_[0], feats)))
        worst[name] = w
    print('標準化した係数の最大差(fit.py の importance.json との)', worst)
    sys.exit(0)

test = df[df.month >= HOLDOUT_START].reset_index(drop=True)
print('保留 レース', test.raceId.nunique(), '馬', len(test), flush=True)
starts = np.r_[0, np.flatnonzero(test['raceId'].values[1:] != test['raceId'].values[:-1]) + 1]
ends = np.r_[starts[1:], len(test)]
nh = (ends - starts).astype(float)
R = len(starts)

def normalize(s, k):
    """レースごとに共通のロジットシフトを足して、確率の合計を k にする(lib.ts の normalizeLogitShift と同じ)。"""
    lo, hi = np.full(R, -30.0), np.full(R, 30.0)
    rid = np.repeat(np.arange(R), ends - starts)
    for _ in range(60):
        c = (lo + hi) / 2
        p = 1 / (1 + np.exp(-(s + c[rid])))
        tot = np.add.reduceat(p, starts)
        big = tot > k
        hi = np.where(big, c, hi)
        lo = np.where(big, lo, c)
    return np.clip(1 / (1 + np.exp(-(s + ((lo + hi) / 2)[rid]))), 1e-6, 1 - 1e-6)

ALL_ADD = [f for f in FLAGS if f != 'foreignJCnoLemaire'] + MK
NO_MK = [f for f in FLAGS if f != 'foreignJCnoLemaire']
MODELS = {}
for odds, base in (('noodds', BASE_NO), ('odds', BASE_L)):
    MODELS[f'{odds}_base'] = base
    MODELS[f'{odds}_all'] = base + ALL_ADD
    # 単独追加(参考。決め方には使わない)
    MODELS[f'{odds}_all_noLemaire'] = base + [('foreignJCnoLemaire' if f == 'foreignJC' else f) for f in ALL_ADD]
    MODELS[f'{odds}_all_noMk'] = base + NO_MK
    MODELS[f'{odds}_only_mk'] = base + MK
    for f in FLAGS:
        if f == 'noprev':
            continue
        MODELS[f'{odds}_only_{f}'] = base + ([f, 'noprev'] if f in PREV_BASED else [f])

P = {}
for name, feats in MODELS.items():
    for obj, k in OBJS.items():
        sc, m = fit(feats, obj, train)
        P[(name, obj)] = normalize(m.decision_function(sc.transform(test[feats].values)), k)
    print('学習済み', name, flush=True)

Y = {obj: test['y_' + obj].values.astype(float) for obj in OBJS}
def horse_loss(p, y):
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))
race_loss = {key: np.add.reduceat(horse_loss(p, Y[key[1]]), starts) for key, p in P.items()}
rng = np.random.default_rng(SEED)
counts = rng.multinomial(R, np.full(R, 1.0 / R), size=BOOT).astype(float)
den = counts @ nh

def diff(a, b, obj):
    d = race_loss[(a, obj)] - race_loss[(b, obj)]
    point = d.sum() / nh.sum()
    boot = (counts @ d) / den
    return float(point), float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))

bands = {'1-3': (1, 3), '4-9': (4, 9), '10+': (10, 99)}
def band_table(name, obj):
    out = {}
    for b, (lo, hi) in bands.items():
        msk = ((test['oddsRank'] >= lo) & (test['oddsRank'] <= hi)).values
        out[b] = {'n': int(msk.sum()), 'actual': float(Y[obj][msk].sum()), 'expected': float(P[(name, obj)][msk].sum())}
    return out

res = {'train': {'races': int(train.raceId.nunique()), 'horses': len(train)}, 'holdout': {'races': R, 'horses': len(test)},
       'logloss': {}, 'pairs': {}, 'bands': {}}
for name in MODELS:
    res['logloss'][name] = {obj: float(race_loss[(name, obj)].sum() / nh.sum()) for obj in OBJS}
    res['bands'][name] = {obj: band_table(name, obj) for obj in OBJS}
for odds in ('noodds', 'odds'):
    for add in ['all', 'all_noLemaire', 'all_noMk', 'only_mk'] + [f'only_{f}' for f in FLAGS if f != 'noprev']:
        res['pairs'][f'{odds}_{add}'] = {obj: dict(zip(('diff', 'lo', 'hi'), diff(f'{odds}_{add}', f'{odds}_base', obj))) for obj in OBJS}

os.makedirs(last, exist_ok=True)
json.dump(res, open(os.path.join(last, 'eval.json'), 'w'), ensure_ascii=False, indent=1)
L = [f"学習 {res['train']}  保留 {res['holdout']}  ブートストラップ {BOOT} 回・シード {SEED}", '', '対数損失(頭あたり)']
for name in MODELS:
    L.append(f"{name:28s} " + ' '.join(f"{o}={res['logloss'][name][o]:.5f}" for o in OBJS))
L += ['', '足した後 − 足す前(負が良い)。[95% 区間]']
for pair, v in res['pairs'].items():
    L.append(f"{pair:28s} " + ' '.join(f"{o}={v[o]['diff']:+.5f}[{v[o]['lo']:+.5f},{v[o]['hi']:+.5f}]" for o in OBJS))
L += ['', '人気の帯ごとの 実際 / 見込み(3着内)']
for name in ('noodds_base', 'noodds_all', 'odds_base', 'odds_all'):
    L.append(name + '  ' + '  '.join(f"{b}: {t['actual']:.0f}/{t['expected']:.1f}={t['actual']/t['expected']:.3f}(n={t['n']})" for b, t in res['bands'][name]['top3'].items()))
L += ['', '同(勝ち)']
for name in ('noodds_base', 'noodds_all', 'odds_base', 'odds_all'):
    L.append(name + '  ' + '  '.join(f"{b}: {t['actual']:.0f}/{t['expected']:.1f}={t['actual']/t['expected']:.3f}" for b, t in res['bands'][name]['win'].items()))
L += ['', '同(2着内)']
for name in ('noodds_base', 'noodds_all', 'odds_base', 'odds_all'):
    L.append(name + '  ' + '  '.join(f"{b}: {t['actual']:.0f}/{t['expected']:.1f}={t['actual']/t['expected']:.3f}" for b, t in res['bands'][name]['top2'].items()))
open(os.path.join(last, 'eval.txt'), 'w').write('\n'.join(L) + '\n')
print('\n'.join(L))
