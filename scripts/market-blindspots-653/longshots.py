"""#653 2 本目 B: 来た人気薄と来なかった人気薄(馬単位)。単勝 20 倍以上の馬だけで、3着内の読み残しを説明する条件の組み合わせを、
前半だけで決定木(深さ 3・葉の件数 300 以上・葉 8 枚まで)と XGBoost + SHAP で探し、前半の木の葉をそのまま後半に当てて確かめる(plan.md)。
使い方: python3 longshots.py <horses.ndjson.gz> <出力.json> [オッズの閾値(既定 20)]
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd
import xgboost as xgb
import shap
from scipy import stats
from sklearn.tree import DecisionTreeRegressor, export_text
from common import load_horses, Market3, bh

horses_path, out_path = sys.argv[1:3]
THRESH = float(sys.argv[3]) if len(sys.argv) > 3 else 20.0
df = load_horses(horses_path)
mk = Market3().fit(df[df.half == '1'])
df['p3'] = mk.predict(df)
df['res3'] = df['place3'] - df['p3']

# 見つかった走の数(priorRunCount)・騎手/調教師の件数(jN)・調教師の指標(tEdge)は入れない: 手元の記録が 2024-08 から始まるため、時期が進むほど大きくなる(前半と後半で意味が変わる)。
NUM = ['n', 'winOdds', 'q', 'oddsRank', 'distance', 'raceClass', 'month', 'wakuban', 'age', 'burden', 'bodyWeightDiff', 'jEdge',
       'bdMean', 'bdRank', 'style', 'daysSince', 'prevFinish', 'prevPosRatio', 'prevMargin', 'prevLast3fRank', 'prevN', 'prevNinki',
       'prevClassDelta', 'distDelta', 'jockeyChanged', 'df60', 'di60']
d = df.copy()
d['is_turf'] = (d.courseType == '芝').astype(float)
d['going_rank'] = d.going.map({'良': 0, '稍重': 1, '重': 2, '不良': 3})
d['is_female'] = (d.sex == '牝').astype(float)
d['is_gelding'] = (d.sex == 'セ').astype(float)
d['has_mark'] = d.mark.notna().astype(float)
d['wt_handicap'] = (d.weightType == 'ハンデ').astype(float)
d['wt_allowance'] = (d.weightType == '馬齢').astype(float)
d['shift_heavier'] = d.shift60.map({'heavier': 1.0, 'lighter': -1.0, 'same': 0.0})
for v in sorted(d.venue.dropna().unique()):
    d['venue_' + v] = (d.venue == v).astype(float)
cond_cols = [c for c in d.columns if c.startswith('c_') and '_m40' not in c and '_any' not in c]
for c in cond_cols:
    d[c] = d[c].astype(float)
FEATS = NUM + ['is_turf', 'going_rank', 'is_female', 'is_gelding', 'has_mark', 'wt_handicap', 'wt_allowance', 'shift_heavier'] + [c for c in d.columns if c.startswith('venue_')] + cond_cols
for c in FEATS:
    d[c] = pd.to_numeric(d[c], errors='coerce')

ls = d[d.winOdds >= THRESH]
tr = ls[ls.half == '1']
te = ls[ls.half == '2']
print('閾値', THRESH, '前半の人気薄', len(tr), '3着内', int(tr.place3.sum()), '勝ち', int(tr.win.sum()), '後半', len(te), '3着内', int(te.place3.sum()))
out = dict(threshold=THRESH, n_h1=len(tr), place_h1=int(tr.place3.sum()), n_h2=len(te), place_h2=int(te.place3.sum()))

# 1) 浅い決定木。
tree = DecisionTreeRegressor(max_depth=3, min_samples_leaf=300, max_leaf_nodes=8, random_state=0)
tree.fit(tr[FEATS], tr['res3'])
rules = export_text(tree, feature_names=FEATS)
leaf1 = tree.apply(tr[FEATS])
leaf2 = tree.apply(te[FEATS])
def leaf_rule(lf):
    t = tree.tree_
    path = tree.decision_path(tr[FEATS].iloc[[int(np.where(leaf1 == lf)[0][0])]]).indices
    parts = []
    for a, b in zip(path[:-1], path[1:]):
        f = FEATS[t.feature[a]]
        parts.append(f'{f} <= {t.threshold[a]:.4g}' if t.children_left[a] == b else f'{f} > {t.threshold[a]:.4g}')
    return ' かつ '.join(parts)


leaves = []
for lf in sorted(set(leaf1)):
    a = tr[leaf1 == lf]
    b = te[leaf2 == lf]
    def st(s):
        if len(s) == 0:
            return dict(N=0)
        v = (s.p3 * (1 - s.p3)).sum()
        r = s.res3.sum()
        return dict(N=len(s), exp3=float(s.p3.mean()), act3=float(s.place3.mean()), res3_pt=float(100 * r / len(s)), z3=float(r / np.sqrt(v)),
                    roi_pct=float(100 * ((s.win * s.winOdds).mean() - 1)))
    L = dict(leaf=int(lf), rule=leaf_rule(lf), h1=st(a), h2=st(b))
    z = L['h2'].get('z3', 0.0) * np.sign(L['h1']['res3_pt'])
    L['h2']['p_onesided'] = float(stats.norm.sf(z)) if L['h2']['N'] >= 100 else 1.0
    leaves.append(L)
ok, q = bh([l['h2']['p_onesided'] for l in leaves], 0.10)
for l, o, qq in zip(leaves, ok, q):
    l['h2']['q_bh'] = float(qq)
    l['h2']['remain'] = bool(o)
out['tree_rules'] = rules
out['leaves'] = leaves
print(rules)
for l in leaves:
    print(l)

# 2) XGBoost(市場のロジットを base_margin にして、読み残しだけを学習)+ SHAP。
def margin(s):
    return np.log(s.p3 / (1 - s.p3)).values
fit = tr[tr.date < '2025-07-01']
val = tr[tr.date >= '2025-07-01']
dtr = xgb.DMatrix(fit[FEATS], label=fit.place3, base_margin=margin(fit))
dva = xgb.DMatrix(val[FEATS], label=val.place3, base_margin=margin(val))
params = dict(objective='binary:logistic', eval_metric='logloss', max_depth=3, eta=0.03, min_child_weight=30, subsample=0.8, colsample_bytree=0.7,
              reg_lambda=20.0, seed=0, nthread=4)
bst = xgb.train(params, dtr, num_boost_round=600, evals=[(dva, 'val')], early_stopping_rounds=40, verbose_eval=False)
out['xgb_best_iteration'] = int(bst.best_iteration)
def ll(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
dte = xgb.DMatrix(te[FEATS], label=te.place3, base_margin=margin(te))
p_te = bst.predict(dte, iteration_range=(0, bst.best_iteration + 1))
out['xgb_logloss_h2'] = dict(market=ll(te.p3.values, te.place3.values), xgb=ll(p_te, te.place3.values))
out['xgb_logloss_val'] = dict(market=ll(val.p3.values, val.place3.values),
                              xgb=ll(bst.predict(dva, iteration_range=(0, bst.best_iteration + 1)), val.place3.values))
sv = shap.TreeExplainer(bst).shap_values(tr[FEATS])
imp = pd.Series(np.abs(sv).mean(axis=0), index=FEATS).sort_values(ascending=False)
out['shap_top'] = {k: float(v) for k, v in imp.head(15).items()}
print('best_iter', bst.best_iteration, out['xgb_logloss_val'], out['xgb_logloss_h2'])
print(imp.head(15))
json.dump(out, open(out_path, 'w'), ensure_ascii=False, indent=1, default=float)
