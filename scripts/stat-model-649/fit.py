"""#649 段階 1: 勝率・2着内率・3着内率のモデルを時間順に学習して、各馬のスコア(ログオッズ)を書き出す。

使い方: python3 -I fit.py <replay.ndjson.gz> <出力ディレクトリ> [--open-holdout]
  入力は replay.ts の出力。出力は scores.csv(評価は eval.ts)・importance.json(LR の係数・xgboost の SHAP)。

モデル(目的 = win / top2 / top3 ごとに別々に学習):
  market   : 市場だけ。 logit(q) + log(頭数)             q = 1/確定単勝オッズをレース内で合計 1 に割り戻した値(#548・market-edge-calc.ts と同じ)
  lr_odds  : 案 L。 logit(q) + log(頭数) + logit(prior) + 15 項目の寄与
  lr_noodds: オッズなし版。 log(頭数) + logit(prior) + 15 項目の寄与
  xgb_odds : 勾配ブースティング木(lr_odds と同じ入力)。手元の比較だけ。
  現行(prior の Plackett–Luce 換算)は学習が無いので replay.ts の出力をそのまま eval.ts が使う。

時間順の検証: 特徴量が使える期間(FEATURE_START〜)の月ごとに、その月より前の全部で学習 → その月を予測(拡大窓)。
  試験の月は TEST_START 以降。保留(HOLDOUT_START 以降)は、--open-holdout を付けない限り **読み込みの時点で捨てる**(学習にも評価にも入らない)。
ハイパーパラメータは固定(調整しない。事前登録 docs/investigations/stat-model-649/preregistration.md)。
"""
import gzip, json, math, os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
import xgboost as xgb

FEATURE_START = '2025-02'   # これより前は、手元の過去の結果が 2024-08 からしか無く、馬の戦績が短すぎる
TEST_START = '2025-08'      # 最初の試験の月(学習は 2025-02〜2025-07 の 6 か月分から)
HOLDOUT_START = '2026-08'   # 保留(2026-08〜10)。2026-11 は月の途中なので使わない
LAST_MONTH = '2026-10'
MIN_FIELD = 5               # #548 と同じ: 走った馬が 5 頭未満のレースは使わない
OBJECTIVES = {'win': 1, 'top2': 2, 'top3': 3}
LR_C = 1.0
XGB_PARAMS = dict(n_estimators=300, max_depth=3, learning_rate=0.03, subsample=0.8, colsample_bytree=0.8,
                  min_child_weight=50, reg_lambda=5.0, objective='binary:logistic', tree_method='hist', random_state=649, n_jobs=4)

args = [a for a in sys.argv[1:] if not a.startswith('--')]
OPEN_HOLDOUT = '--open-holdout' in sys.argv
src, outdir = args
os.makedirs(outdir, exist_ok=True)

rows = []
for line in gzip.open(src, 'rt'):
    r = json.loads(line)
    m = r['date'][:7]
    if m < FEATURE_START or m > LAST_MONTH:
        continue
    if m >= HOLDOUT_START and not OPEN_HOLDOUT:
        continue   # 保留は黙って捨てる(読み込んだ時点で、以降のどの処理にも渡らない)
    rows.append(r)
CONTRIB = sorted({k for r in rows[:2000] for k in r['contrib']})
df = pd.DataFrame({
    'raceId': [r['raceId'] for r in rows], 'month': [r['date'][:7] for r in rows], 'date': [r['date'] for r in rows],
    'umaban': [r['umaban'] for r in rows], 'n': [r['n'] for r in rows], 'finish': [r['finish'] for r in rows],
    'winOdds': [r['winOdds'] for r in rows], 'prior': [r['prior'] for r in rows],
    'plWin': [r['plWin'] for r in rows], 'plTop2': [r['plTop2'] for r in rows], 'histLen': [r['histLen'] for r in rows],
})
for k in CONTRIB:
    df['c_' + k] = [r['contrib'].get(k, 0.0) for r in rows]
del rows

# 使うレース: オッズが全頭そろう・走った馬が 5 頭以上・PL 換算ができた
g = df.groupby('raceId')
ok = g['winOdds'].transform(lambda s: s.notna().all() and (s > 0).all()) & (df['n'] >= MIN_FIELD) & g['plWin'].transform(lambda s: s.notna().all())
dropped_races = df.loc[~ok, 'raceId'].nunique()
df = df[ok].copy()
fin = df['finish']
df['y_win'] = (fin == 1).astype(int)
df['y_top2'] = (fin <= 2).astype(int)   # finish が null(中止・失格)は NaN <= 2 が偽 → 0
df['y_top3'] = (fin <= 3).astype(int)
inv = 1.0 / df['winOdds']
df['q'] = inv / inv.groupby(df['raceId']).transform('sum')
df['m_logit'] = np.log(df['q'] / (1 - df['q']))
df['log_n'] = np.log(df['n'])
pr = df['prior'].clip(1e-4, 1 - 1e-4)
df['prior_logit'] = np.log(pr / (1 - pr))
print(f'使うレース {df.raceId.nunique()}  馬 {len(df)}  除いたレース {dropped_races}  月 {df.month.min()}〜{df.month.max()}', flush=True)

CFEATS = ['c_' + k for k in CONTRIB]
FEATS = {
    'market': ['m_logit', 'log_n'],
    'lr_odds': ['m_logit', 'log_n', 'prior_logit'] + CFEATS,
    'lr_noodds': ['log_n', 'prior_logit'] + CFEATS,
    'xgb_odds': ['m_logit', 'log_n', 'prior_logit'] + CFEATS,
}

def fit_predict(model, obj, tr, te):
    X, Xt = tr[FEATS[model]].values, te[FEATS[model]].values
    y = tr['y_' + obj].values
    if model.startswith('xgb'):
        m = xgb.XGBClassifier(**XGB_PARAMS).fit(X, y)
        p = np.clip(m.predict_proba(Xt)[:, 1], 1e-6, 1 - 1e-6)
        return np.log(p / (1 - p))
    sc = StandardScaler().fit(X)
    m = LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(X), y)
    return m.decision_function(sc.transform(Xt))

months = sorted(df.month.unique())
test_months = [m for m in months if m >= TEST_START]
out = df[df.month.isin(test_months)][['raceId', 'month', 'date', 'umaban', 'n', 'winOdds', 'q', 'prior', 'plWin', 'plTop2', 'y_win', 'y_top2', 'y_top3', 'histLen']].copy()
for model in FEATS:
    for obj in OBJECTIVES:
        out[f'{model}_{obj}'] = np.nan
for tm in test_months:
    tr = df[df.month < tm]
    te_idx = out.index[out.month == tm]
    te = df.loc[te_idx]
    for model in FEATS:
        for obj in OBJECTIVES:
            out.loc[te_idx, f'{model}_{obj}'] = fit_predict(model, obj, tr, te)
    print('試験', tm, '学習', tr.raceId.nunique(), 'レース', flush=True)
out.to_csv(os.path.join(outdir, 'scores.csv'), index=False)

# 重要度: 非保留の全期間で学習し直して、LR の標準化した係数と xgboost の SHAP(平均絶対値)を出す
import shap
imp = {'lr_odds': {}, 'lr_noodds': {}, 'xgb_shap': {}}
for obj in OBJECTIVES:
    for model in ('lr_odds', 'lr_noodds'):
        X = df[FEATS[model]].values
        sc = StandardScaler().fit(X)
        m = LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(X), df['y_' + obj].values)
        imp[model][obj] = dict(zip(FEATS[model], map(float, m.coef_[0])))
    m = xgb.XGBClassifier(**XGB_PARAMS).fit(df[FEATS['xgb_odds']].values, df['y_' + obj].values)
    samp = df.sample(min(20000, len(df)), random_state=649)
    sv = shap.TreeExplainer(m).shap_values(samp[FEATS['xgb_odds']].values)
    imp['xgb_shap'][obj] = dict(zip(FEATS['xgb_odds'], map(float, np.abs(sv).mean(axis=0))))
json.dump(imp, open(os.path.join(outdir, 'importance.json'), 'w'), ensure_ascii=False, indent=1)
print('done')
