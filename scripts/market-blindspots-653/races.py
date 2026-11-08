"""#653 2 本目 A: 荒れやすいレース(レース単位)。市場の見込みとの差(R1・R2・R3)を水準ごとに見る(plan.md)。
使い方: python3 races.py <horses.ndjson.gz> <races.ndjson.gz> <出力.json>
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd
from scipy import stats
from common import load_horses, load_races, Market3, bh

horses_path, races_path, out_path = sys.argv[1:4]
hs = load_horses(horses_path)
rs = load_races(races_path)
mk = Market3().fit(hs[hs.half == '1'])
hs['p3'] = mk.predict(hs)
hs['qp3'] = hs['q'] * hs['p3']
hs['qpl'] = hs['q'] * hs['place3']
agg = hs.groupby('raceId').agg(exp_q3=('qp3', 'sum'), act_q3=('qpl', 'sum')).reset_index()
rs = rs.merge(agg, on='raceId')
# R1: 勝ち馬の意外さ(市場が正しければ期待値 0)。
rs['R1'] = np.where(rs.winnerQ.notna(), -np.log(rs.winnerQ) - rs.entropy, np.nan)
# R2: 3着内の馬の q の合計 − 期待。3 頭ちょうどが 3着内のレースだけ。
rs['R2'] = np.where(rs.placedCount == 3, rs.act_q3 - rs.exp_q3, np.nan)
# R3: log(三連単配当/100) の読み残し。前半だけで当てはめた線形回帰(q1・qTop3・エントロピー・log 頭数)。
rs['logT'] = np.log(rs.trifecta / 100)
X = np.column_stack([np.ones(len(rs)), rs.q1, rs.qTop3, rs.entropy, np.log(rs.n)])
m1 = ((rs.half == '1') & rs.logT.notna()).values
beta, *_ = np.linalg.lstsq(X[m1], rs.logT.values[m1], rcond=None)
rs['R3'] = rs.logT - X @ beta
rs['nb'] = pd.cut(rs.n, [0, 9, 13, 99], labels=['頭数<=9', '頭数10-13', '頭数>=14']).astype(str)
rs['season'] = rs.month.map(lambda m: '春3-5' if 3 <= m <= 5 else '夏6-8' if 6 <= m <= 8 else '秋9-11' if 9 <= m <= 11 else '冬12-2')
rs['bandn'] = rs.band.map({0: '距離<=1200', 1: '距離1201-1600', 2: '距離1601-2000', 3: '距離>2000'})
sgn = lambda v: '傾向なし(対象外)' if pd.isna(v) else ('>=+0.10' if v >= 0.10 else '<=-0.10' if v <= -0.10 else '中間')
rs['dfs'] = rs.t60_df.map(sgn)
rs['dis'] = rs.t60_di.map(lambda v: '傾向なし(対象外)' if pd.isna(v) else ('>=+0.12' if v >= 0.12 else '<=-0.12' if v <= -0.12 else '中間'))
rs['gchg'] = rs.t60_shift.map(lambda v: '先のレースなし' if pd.isna(v) else ('変わった' if v != 'same' else '変わらず'))
dims = {'頭数': 'nb', 'クラス': 'raceClass', '重量種別': 'weightType', '馬場': 'going', '距離帯': 'bandn', '芝ダ': 'courseType',
        '季節': 'season', '競馬場': 'venue', '前残り度Δf': 'dfs', '内有利度Δi': 'dis', '馬場の変わり目': 'gchg'}
METRICS = ['R1', 'R2', 'R3']
MIN1, MIN2 = 100, 50


def level_stats(sub, metric):
    v = sub[metric].dropna()
    n = len(v)
    if n < 2:
        return dict(N=n)
    se = v.std(ddof=1) / np.sqrt(n)
    return dict(N=n, mean=float(v.mean()), se=float(se), z=float(v.mean() / se))


h1 = rs[rs.half == '1']
h2 = rs[rs.half == '2']
cells = []
for dname, col in dims.items():
    for lvl in sorted(rs[col].dropna().astype(str).unique()):
        for met in METRICS:
            s1 = level_stats(h1[h1[col].astype(str) == lvl], met)
            cells.append(dict(dim=dname, level=lvl, metric=met, h1=s1))
tested = [c for c in cells if c['h1']['N'] >= MIN1]
p = [2 * stats.norm.sf(abs(c['h1']['z'])) for c in tested]
ok, q = bh(p, 0.10)
passed = []
for c, o, qq in zip(tested, ok, q):
    c['h1']['q_bh'] = float(qq)
    c['h1']['pass'] = bool(o and abs(c['h1']['z']) >= 2)
    if c['h1']['pass']:
        passed.append(c)
for c in passed:
    col = dims[c['dim']]
    c['h2'] = level_stats(h2[h2[col].astype(str) == c['level']], c['metric'])
    z = c['h2'].get('z', np.nan) * np.sign(c['h1']['z'])
    c['h2']['p_onesided'] = float(stats.norm.sf(z)) if c['h2']['N'] >= MIN2 and not np.isnan(z) else 1.0
if passed:
    ok2, q2 = bh([c['h2']['p_onesided'] for c in passed], 0.10)
    for c, o, qq in zip(passed, ok2, q2):
        c['h2']['q_bh'] = float(qq)
        c['h2']['remain'] = bool(o and np.sign(c['h2']['z']) == np.sign(c['h1']['z']))
json.dump(dict(cells=cells, beta_R3=beta.tolist(), n_races_h1=len(h1), n_races_h2=len(h2),
               overall={m: {'h1': level_stats(h1, m), 'h2': level_stats(h2, m)} for m in METRICS},
               tested=len(tested), passed=len(passed)), open(out_path, 'w'), ensure_ascii=False, indent=1, default=float)
print('レース 前半', len(h1), '後半', len(h2), '検定した', len(tested), '前半で通った', len(passed))
for m in METRICS:
    print(m, '全体', level_stats(h1, m), level_stats(h2, m))
for c in passed:
    print(c['dim'], c['level'], c['metric'], c['h1'], c.get('h2'))
