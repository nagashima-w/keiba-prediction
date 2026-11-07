"""#652(#649 の続き): 新しい材料(騎手の市場比・斤量の相対値・重量の種別・減量の印・性齢)を足して、時間順に学習し、各馬のスコアを書き出す。

使い方: python3 -I fit2.py <replay.ndjson.gz> <extras.ndjson.gz> <relative.ndjson.gz> <出力ディレクトリ>
  **保留(2026-08〜)は、このスクリプトには読み込む口が無い**(#649 で一度開けたので、#652 の探索では使わない)。

以下は fit.py(#649 段階 1)の説明のまま:

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
from scipy.optimize import minimize, minimize_scalar
from scipy.special import logsumexp

FEATURE_START = '2025-02'   # これより前は、手元の過去の結果が 2024-08 からしか無く、馬の戦績が短すぎる
TEST_START = '2025-08'      # 最初の試験の月(学習は 2025-02〜2025-07 の 6 か月分から)
HOLDOUT_START = '2026-08'   # 保留(2026-08〜10)。2026-11 は月の途中なので使わない
LAST_MONTH = '2026-10'
MIN_FIELD = 5               # #548 と同じ: 走った馬が 5 頭未満のレースは使わない
OBJECTIVES = {'win': 1, 'top2': 2, 'top3': 3}
LR_C = 1.0
XGB_PARAMS = dict(n_estimators=300, max_depth=3, learning_rate=0.03, subsample=0.8, colsample_bytree=0.8,
                  min_child_weight=50, reg_lambda=5.0, objective='binary:logistic', tree_method='hist', random_state=649, n_jobs=4)

args = sys.argv[1:]
src, extra_src, rel_src, outdir = args
os.makedirs(outdir, exist_ok=True)

rows = []
for line in gzip.open(src, 'rt'):
    r = json.loads(line)
    m = r['date'][:7]
    if m < FEATURE_START or m > LAST_MONTH:
        continue
    if m >= HOLDOUT_START:
        continue   # 保留は読み込んだ時点で捨てる(口自体を持たない)
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
ex = {}
for line in gzip.open(extra_src, 'rt'):
    r = json.loads(line)
    ex[(r['raceId'], r['umaban'])] = r
keys = list(zip(df['raceId'], df['umaban']))
def col(name, default=None):
    return [ex[k].get(name, default) if k in ex else default for k in keys]
for nm in ['jEdge', 'tEdge', 'bdMean', 'bdMin', 'bdRank']:
    df[nm] = pd.to_numeric(col(nm), errors='coerce')
df['jN'] = pd.to_numeric(col('jN'), errors='coerce')
df['age'] = pd.to_numeric(col('age'), errors='coerce')
wt = pd.Series(col('weightType'), index=df.index); mk = pd.Series(col('mark'), index=df.index); sx = pd.Series(col('sex'), index=df.index)
df['weightType'] = wt
for v in ['定量', '別定', 'ハンデ']:
    df['wt_' + v] = (wt == v).astype(float)
df['hcap'] = (wt == 'ハンデ').astype(int)
df['hcap_bdMean'] = df['hcap'] * df['bdMean']
df['hcap_bdRank'] = df['hcap'] * (df['bdRank'] - 0.5)
for v in ['▲', '△', '☆', '◇', '★']:
    df['mk_' + v] = (mk == v).astype(float)
for v in ['牝', 'セ']:
    df['sx_' + v] = (sx == v).astype(float)
rel = {}
for line in gzip.open(rel_src, 'rt'):
    r = json.loads(line)
    rel[(r['raceId'], r['umaban'])] = r
REL = [k for k in next(iter(rel.values())).keys() if k.startswith('rel_')]
for k in REL:
    df[k] = [rel[key][k] if key in rel else 0.0 for key in keys]
miss = df[['jEdge', 'bdMean', 'age']].isna().any(axis=1)
print('追加の材料が欠けた馬', int(miss.sum()), flush=True)
df['age'] = df['age'].fillna(df['age'].median())
for nm in ['jEdge', 'tEdge', 'bdMean', 'bdMin', 'bdRank']:
    df[nm] = df[nm].fillna(0.0)

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
BASE_L = ['m_logit', 'log_n', 'prior_logit'] + CFEATS
BASE_NO = ['log_n', 'prior_logit'] + CFEATS
GROUPS = {
    'jedge': ['jEdge'],
    'tedge': ['tEdge'],
    'bd': ['bdMean', 'bdMin', 'bdRank'],
    'wt': ['wt_定量', 'wt_別定', 'wt_ハンデ', 'hcap_bdMean', 'hcap_bdRank'],
    'mark': ['mk_▲', 'mk_△', 'mk_☆', 'mk_◇', 'mk_★'],
    'sexage': ['sx_牝', 'sx_セ', 'age'],
}
ALL_NEW = [f for g in GROUPS.values() for f in g]
FEATS = {'market': ['m_logit', 'log_n'], 'lr_odds': BASE_L, 'lr_noodds': BASE_NO,
         'lr_odds_all': BASE_L + ALL_NEW, 'lr_noodds_all': BASE_NO + ALL_NEW,
         'xgb_odds': BASE_L, 'xgb_odds_all': BASE_L + ALL_NEW,
         'lr_odds_rel': BASE_L + REL, 'lr_noodds_rel': BASE_NO + REL,
         'lr_odds_allrel': BASE_L + ALL_NEW + REL, 'lr_noodds_allrel': BASE_NO + ALL_NEW + REL,
         'xgb_odds_allrel': BASE_L + ALL_NEW + REL, 'xgb_noodds_allrel': BASE_NO + ALL_NEW + REL}
for g, fs in GROUPS.items():
    FEATS['lr_odds_' + g] = BASE_L + fs
    FEATS['lr_noodds_' + g] = BASE_NO + fs

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
out = df[df.month.isin(test_months)][['raceId', 'month', 'date', 'umaban', 'n', 'winOdds', 'q', 'prior', 'plWin', 'plTop2', 'y_win', 'y_top2', 'y_top3', 'histLen', 'hcap']].copy()
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

# ---- レース単位で学習するモデル(勝率だけ): 条件付きロジットと XGBoost のランキング学習 ----
# 出力は確率(レース内のソフトマックス)。列名は p_<モデル>_win。ランキングの温度 T は、各試験の月の学習側だけで決める
# (学習期間の最後の 2 か月を温度の当てはめに回し、残りで学習したランカーの出力で、その 2 か月の勝率の対数損失が最小になる T)。
CL_L2 = 1.0
RACE_MODELS = {
    'cl_odds_base': ('cl', BASE_L),
    'cl_odds_allrel': ('cl', BASE_L + ALL_NEW + REL),
    'cl_noodds_allrel': ('cl', BASE_NO + ALL_NEW + REL),
    'rkpair_odds_base': ('rank:pairwise', BASE_L),
    'rkpair_odds_allrel': ('rank:pairwise', BASE_L + ALL_NEW + REL),
    'rkpair_noodds_allrel': ('rank:pairwise', BASE_NO + ALL_NEW + REL),
    'rkndcg_odds_allrel': ('rank:ndcg', BASE_L + ALL_NEW + REL),
    'rkndcg_noodds_allrel': ('rank:ndcg', BASE_NO + ALL_NEW + REL),
}

def race_groups(d):
    """d は raceId 順に並べたもの。各レースの [開始, 終了) を返す。"""
    ids = d['raceId'].values
    starts = [0] + [i for i in range(1, len(ids)) if ids[i] != ids[i - 1]]
    return np.array(starts), np.array(starts[1:] + [len(ids)])

def softmax_by_race(score, starts, ends):
    p = np.empty_like(score)
    for a, b in zip(starts, ends):
        z = score[a:b] - score[a:b].max()
        e = np.exp(z)
        p[a:b] = e / e.sum()
    return p

def cl_fit(X, y, starts, ends):
    """条件付きロジット: レースごとのソフトマックス。同着 1 着が複数いるレースは、勝ち馬の対数確率の平均。勝ち馬のいないレースは飛ばす。"""
    keep = [(a, b) for a, b in zip(starts, ends) if y[a:b].sum() > 0]
    def f(w):
        loss = 0.0
        g = np.zeros_like(w)
        for a, b in keep:
            sc = X[a:b] @ w
            lz = logsumexp(sc)
            pr = np.exp(sc - lz)
            wi = y[a:b] / y[a:b].sum()
            loss -= (wi * sc).sum() - lz
            g -= X[a:b].T @ wi - X[a:b].T @ pr
        loss += 0.5 * CL_L2 * (w @ w)
        g += CL_L2 * w
        return loss, g
    return minimize(f, np.zeros(X.shape[1]), jac=True, method='L-BFGS-B', options={'maxiter': 200}).x

def relevance(d):
    f = d['finish'].values
    return np.where(f == 1, 3, np.where(f == 2, 2, np.where(f == 3, 1, 0))).astype(int)

def fit_ranker(kind, X, rel_, starts, ends):
    m = xgb.XGBRanker(**{**{k: v for k, v in XGB_PARAMS.items() if k != 'objective'}, 'objective': kind})
    m.fit(X, rel_, group=(ends - starts))
    return m

def race_loglik(p, y, starts, ends):
    t = 0.0; c = 0
    for a, b in zip(starts, ends):
        for i in range(a, b):
            q = min(1 - 1e-6, max(1e-6, p[i]))
            t += -math.log(q) if y[i] == 1 else -math.log(1 - q); c += 1
    return t / c

df = df.sort_values(['raceId', 'umaban']).reset_index(drop=True)
out = out.sort_values(['raceId', 'umaban']).reset_index(drop=True)
for name in RACE_MODELS:
    out['p_' + name + '_win'] = np.nan
for tm in test_months:
    tr = df[df.month < tm]
    te_mask = (out.month == tm).values
    te = df[df.month == tm]
    # 試験の月の行の並びは out と df で同じ(raceId, umaban 順)
    ts, te_ = race_groups(te)
    trs, tre = race_groups(tr)
    for name, (kind, feats) in RACE_MODELS.items():
        sc = StandardScaler().fit(tr[feats].values)
        Xtr = sc.transform(tr[feats].values); Xte = sc.transform(te[feats].values)
        ytr = tr['y_win'].values.astype(float)
        if kind == 'cl':
            w = cl_fit(Xtr, ytr, trs, tre)
            p = softmax_by_race(Xte @ w, ts, te_)
        else:
            tr_months = sorted(tr.month.unique())
            inner_val_months = tr_months[-2:]
            inner_tr = tr[~tr.month.isin(inner_val_months)]
            inner_va = tr[tr.month.isin(inner_val_months)]
            its, ite = race_groups(inner_tr); vas, vae = race_groups(inner_va)
            isc = StandardScaler().fit(inner_tr[feats].values)
            rk = fit_ranker(kind, isc.transform(inner_tr[feats].values), relevance(inner_tr), its, ite)
            vs = rk.predict(isc.transform(inner_va[feats].values))
            yva = inner_va['y_win'].values
            res = minimize_scalar(lambda lt: race_loglik(softmax_by_race(vs / math.exp(lt), vas, vae), yva, vas, vae), bounds=(-4, 4), method='bounded')
            T = math.exp(res.x)
            rk2 = fit_ranker(kind, Xtr, relevance(tr), trs, tre)
            p = softmax_by_race(rk2.predict(Xte) / T, ts, te_)
        out.loc[te_mask, 'p_' + name + '_win'] = p
    print('レース単位 試験', tm, flush=True)
out.to_csv(os.path.join(outdir, 'scores.csv'), index=False)

# 重要度: 非保留の全期間で学習し直して、LR の標準化した係数と xgboost の SHAP(平均絶対値)を出す
import shap
imp = {'lr_odds_allrel': {}, 'lr_noodds_allrel': {}, 'xgb_shap_all': {}, 'xgb_shap_allrel': {}, 'xgb_shap_noodds_allrel': {}, 'xgb_shap_base': {}}
for obj in OBJECTIVES:
    for model in ('lr_odds_allrel', 'lr_noodds_allrel'):
        X = df[FEATS[model]].values
        sc = StandardScaler().fit(X)
        m = LogisticRegression(C=LR_C, max_iter=2000).fit(sc.transform(X), df['y_' + obj].values)
        imp[model][obj] = dict(zip(FEATS[model], map(float, m.coef_[0])))
    for key, model in (('xgb_shap_all', 'xgb_odds_all'), ('xgb_shap_allrel', 'xgb_odds_allrel'), ('xgb_shap_noodds_allrel', 'xgb_noodds_allrel'), ('xgb_shap_base', 'xgb_odds')):
        m = xgb.XGBClassifier(**XGB_PARAMS).fit(df[FEATS[model]].values, df['y_' + obj].values)
        samp = df.sample(min(20000, len(df)), random_state=649)
        sv = shap.TreeExplainer(m).shap_values(samp[FEATS[model]].values)
        imp[key][obj] = dict(zip(FEATS[model], map(float, np.abs(sv).mean(axis=0))))
json.dump(imp, open(os.path.join(outdir, 'importance.json'), 'w'), ensure_ascii=False, indent=1)
print('done')
