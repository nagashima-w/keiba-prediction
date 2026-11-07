"""#653 仮説 1〜8: 59 個の条件を前半で測り、通ったものだけを後半で確かめる(plan.md の判断の目安)。
使い方: python3 hypotheses.py <horses.ndjson.gz> <出力.json> 
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import stats
from common import load_horses, Market3, bh, cond_stats

horses_path, out_path = sys.argv[1:3]
df = load_horses(horses_path)
h1 = df[df.half == '1'].copy()
h2 = df[df.half == '2'].copy()
mk = Market3().fit(h1)
h1['p3'] = mk.predict(h1)
h2['p3'] = mk.predict(h2)
ids = [c[2:] for c in df.columns if c.startswith('c_') and '_m40' not in c and '_any' not in c]
assert len(ids) == 59, len(ids)
MIN1, MIN2, ZMIN, QMAX = 300, 150, 2.0, 0.10

res = {}
for cid in ids:
    s1 = h1[h1['c_' + cid] == 1]
    s0 = int(h1['c_' + cid].isna().sum())
    d = cond_stats(s1)
    d['na1'] = s0
    res[cid] = {'h1': d}
tested = [c for c in ids if res[c]['h1']['N'] >= MIN1]
p = [2 * stats.norm.sf(abs(res[c]['h1']['z3'])) for c in tested]
ok, q = bh(p, QMAX)
passed = []
for c, qq, o in zip(tested, q, ok):
    res[c]['h1']['q_bh'] = float(qq)
    res[c]['h1']['pass'] = bool(o and abs(res[c]['h1']['z3']) >= ZMIN)
    if res[c]['h1']['pass']:
        passed.append(c)
for c in ids:
    if c not in tested:
        res[c]['h1']['pass'] = False
        res[c]['h1']['insufficient'] = True

# 後半: 前半で通った条件だけ。
def sens_ids(c):
    return [c + '_m40', c + '_any'] if c.startswith('T') else []

p2 = []
for c in passed:
    s2 = h2[h2['c_' + c] == 1]
    d = cond_stats(s2)
    d['na2'] = int(h2['c_' + c].isna().sum())
    res[c]['h2'] = d
    sign = np.sign(res[c]['h1']['z3'])
    if d['N'] >= MIN2:
        z = d['z3'] * sign
        d['p_onesided'] = float(stats.norm.sf(z))
    else:
        d['p_onesided'] = 1.0
    p2.append(d['p_onesided'])
if passed:
    ok2, q2 = bh(p2, QMAX)
    for c, o, qq in zip(passed, ok2, q2):
        res[c]['h2']['q_bh'] = float(qq)
        res[c]['h2']['remain'] = bool(o and res[c]['h2']['N'] >= MIN2 and np.sign(res[c]['h2']['z3']) == np.sign(res[c]['h1']['z3']))
# 感度の版(T の 40 分版・すべて版): 前半・後半を、通った T についてだけ。
sens = {}
for c in passed:
    for sc in sens_ids(c):
        sens[sc] = {'h1': cond_stats(h1[h1['c_' + sc] == 1]), 'h2': cond_stats(h2[h2['c_' + sc] == 1])}
# 通らなかった T も、感度の確認として前半の 60 分版と並べるため、40 分・すべて版の前半を出す。
for c in ids:
    if c.startswith('T') and c not in passed:
        for sc in sens_ids(c):
            sens.setdefault(sc, {})['h1'] = cond_stats(h1[h1['c_' + sc] == 1])
json.dump({'main': res, 'sens': sens, 'passed': passed, 'tested': tested,
           'n_h1': len(h1), 'n_h2': len(h2),
           'market': {'coef': mk.m.coef_.tolist(), 'intercept': mk.m.intercept_.tolist()}},
          open(out_path, 'w'), ensure_ascii=False, indent=1, default=float)
print('前半の馬', len(h1), '後半の馬', len(h2), '係数', mk.m.coef_, mk.m.intercept_)
print('検定した', len(tested), '前半で通った', len(passed), passed)
for c in passed:
    r = res[c]
    print(c, 'h1 N=%d res3=%.2fpt z=%.2f roi=%.1f%%' % (r['h1']['N'], r['h1']['res3_pt'], r['h1']['z3'], r['h1']['roi_pct']),
          '| h2 N=%d res3=%.2fpt z=%.2f q=%.3f remain=%s' % (r['h2']['N'], r['h2'].get('res3_pt', np.nan), r['h2'].get('z3', np.nan), r['h2'].get('q_bh', np.nan), r['h2'].get('remain')))
