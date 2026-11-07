"""#649 段階 2・3: 本番の並走(影の計算)に埋め込む係数を、学習し直して書き出す。

使い方: python3 -I export_coef.py <replay.ndjson.gz> <出力.json>
  入力は replay.ts の出力。fit.py(--open-holdout)の重要度の計算と**同じ前処理・同じ学習**(LR: 標準化 + L2 C=1.0、2025-02〜2026-10 の全部で学習)。
  保留を開けた評価(fit.py --open-holdout)は流し直さない。ここは学習だけで、評価はしない。
  出力は、元の単位の特徴量に直した係数(score = 切片 + Σ 重み × 特徴量。標準化の平均・尺度を畳み込む)と、標準化した係数(fit.py の importance.json と突き合わせる用)。
"""
import gzip, json, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

FEATURE_START, LAST_MONTH, MIN_FIELD, LR_C = '2025-02', '2026-10', 5, 1.0
src, out = sys.argv[1:3]
# 任意: <hist.ndjson.gz> <golden 出力.json> → 本番の突き合わせ用の期待値(下の golden)も作る(環境変数 FEATURES_653 に #653 の features.py の場所)。
hist_path = sys.argv[3] if len(sys.argv) > 3 else None
golden_out = sys.argv[4] if len(sys.argv) > 4 else None
rows = [r for r in (json.loads(l) for l in gzip.open(src, 'rt')) if FEATURE_START <= r['date'][:7] <= LAST_MONTH]
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
inv = 1.0 / df['winOdds']
df['q'] = inv / inv.groupby(df['raceId']).transform('sum')
df['m_logit'] = np.log(df['q'] / (1 - df['q']))
df['log_n'] = np.log(df['n'])
pr = df['prior'].clip(1e-4, 1 - 1e-4)
df['prior_logit'] = np.log(pr / (1 - pr))
CF = ['c_' + k for k in CONTRIB]
FEATS = {'odds': ['m_logit', 'log_n', 'prior_logit'] + CF, 'noodds': ['log_n', 'prior_logit'] + CF}
result = {'trainedMonths': [df.month.min(), df.month.max()], 'races': int(df.raceId.nunique()), 'horses': int(len(df)), 'contribNames': CONTRIB, 'models': {}}
for model, feats in FEATS.items():
    X = df[feats].values
    sc = StandardScaler().fit(X)
    result['models'][model] = {'features': feats, 'objectives': {}}
    for obj in ('win', 'top2', 'top3'):
        m = LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(X), df['y_' + obj].values)
        w = m.coef_[0] / sc.scale_
        b0 = float(m.intercept_[0] - np.sum(m.coef_[0] * sc.mean_ / sc.scale_))
        result['models'][model]['objectives'][obj] = {'intercept': b0, 'weights': [float(x) for x in w], 'standardizedCoef': [float(x) for x in m.coef_[0]], 'standardizedIntercept': float(m.intercept_[0])}
golden = {'models': {}}
fitted = {}
for model, feats in FEATS.items():
    X = df[feats].values
    sc = StandardScaler().fit(X)
    fitted[model] = (sc, {obj: LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(X), df['y_' + obj].values) for obj in ('win', 'top2', 'top3')})
json.dump(result, open(out, 'w'), ensure_ascii=False, indent=1)

def shift(logits, target):
    # 二分法のロジットシフト(numpy。TS の normalizeLogitShift とは別に書いた独立の実装)
    lo, hi = -60.0, 60.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if (1 / (1 + np.exp(-(logits + mid)))).sum() > target:
            hi = mid
        else:
            lo = mid
    return 1 / (1 + np.exp(-(logits + (lo + hi) / 2)))

if golden_out is not None:
    import importlib.util, os
    spec = importlib.util.spec_from_file_location('features653', os.environ['FEATURES_653'])
    f653 = importlib.util.module_from_spec(spec); spec.loader.exec_module(f653)
    records = f653.read_hist(hist_path)
    runs = f653.hist_runs(records)
    byid = {r['raceId']: r for r in records}
    # 突き合わせに使うレース: 2026-10 後半の、頭数の違う中央のレース(印が 0・1・null の全部を含むまで足す)
    cand = df[(df.month == '2026-10')].groupby('raceId').agg(n=('n', 'first')).reset_index()
    picks = []
    for want in (18, 16, 12, 8, 6, 14, 10, 7, 15, 9, 13, 11):
        m = cand[(cand.n == want) & (~cand.raceId.isin(picks))]
        if len(m):
            picks.append(m.raceId.iloc[len(m) // 2])
    races_out = []
    seen = {'longRest': set(), 'surfaceChange': set(), 'frontRunner': set(), 'longshotSlump': set()}
    for rid in picks:
        rec = byid[rid]
        ran_h = [h for h in rec['horses'] if h['finishStatus'] not in ('取消', '除外')]
        sub = df[df.raceId == rid]
        sub = sub.set_index(sub.index)
        # df の並びは replay の出力順(馬番順)。馬番で引く。
        rr = [r for r in (json.loads(l) for l in gzip.open(src, 'rt')) if r['raceId'] == rid]
        by_um = {r['umaban']: r for r in rr}
        inv = np.array([1.0 / h['winOdds'] for h in ran_h]); q = inv / inv.sum()
        horses = []
        for h, qi in zip(ran_h, q):
            prior_runs = [r for r in runs.get(h['horseId'], []) if r['date'] < rec['date']]
            f = f653.horse_features(prior_runs, rec, h)
            if prior_runs:
                lr_ = f['daysSince'] > 180
                sc_ = (f['surfaceChange'] == 1) if f.get('surfaceChange') is not None else None
                fp = f.get('pFirstPos')
                fr_ = (fp <= 0.125) if fp is not None else None
                a3 = f.get('avgFinish3')
                ls_ = (bool(qi < 0.05 and a3 >= 11.5)) if a3 is not None else None
                flags = {'longRest': int(lr_), 'surfaceChange': None if sc_ is None else int(sc_), 'frontRunner': None if fr_ is None else int(fr_), 'longshotSlump': None if ls_ is None else int(ls_)}
            else:
                flags = {'longRest': None, 'surfaceChange': None, 'frontRunner': None, 'longshotSlump': None}
            for k, v in flags.items():
                seen[k].add(v)
            tail = prior_runs[-3:] if prior_runs else []
            def fin(x):
                return {'kind': '順位', 'value': x} if x is not None else {'kind': '非数値', 'text': '中'}
            horses.append({
                'umaban': h['umaban'], 'prior': by_um[h['umaban']]['prior'], 'contrib': by_um[h['umaban']]['contrib'], 'winOdds': h['winOdds'], 'q': float(qi),
                'courseTypeToday': rec['courseType'], 'dateToday': rec['date'].replace('-', '/'),
                'runs': [{'date': r['date'].replace('-', '/'), 'courseType': r['courseType'], 'finish': fin(r['finish']), 'passing': r['passing'], 'entryCount': r['n']} for r in tail],
                'flags': flags,
            })
        # 期待する確率(sklearn の decision_function → ロジットシフト)
        n = len(ran_h)
        exp = {}
        for model, feats in FEATS.items():
            sc, ms = fitted[model]
            rows_ = pd.DataFrame({'m_logit': [np.log(h['q'] / (1 - h['q'])) for h in horses], 'log_n': [np.log(n)] * n,
                                  'prior_logit': [np.log(np.clip(h['prior'], 1e-4, 1 - 1e-4) / (1 - np.clip(h['prior'], 1e-4, 1 - 1e-4))) for h in horses]})
            for k in CONTRIB:
                rows_['c_' + k] = [h['contrib'].get(k, 0.0) for h in horses]
            X = sc.transform(rows_[feats].values)
            exp[model] = {obj: [float(x) for x in np.clip(shift(ms[obj].decision_function(X), {'win': 1, 'top2': 2, 'top3': 3}[obj]), 1e-6, 1 - 1e-6)] for obj in ('win', 'top2', 'top3')}
        races_out.append({'raceId': rid, 'horses': horses, 'expected': exp})
    golden = {'races': races_out, 'flagValuesSeen': {k: sorted(map(str, v)) for k, v in seen.items()}}
    json.dump(golden, open(golden_out, 'w'), ensure_ascii=False)
    print('golden races', len(races_out), 'flags seen', golden['flagValuesSeen'])
print('races', result['races'], 'horses', result['horses'], 'months', result['trainedMonths'])
