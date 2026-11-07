"""#653 の分析の共通部分(手元の探索用。テストなし。判定の定義は conditions.ts / trend.ts が持つ)。"""
import gzip, json
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import LogisticRegression


def load_horses(path):
    rows = []
    for line in gzip.open(path, 'rt'):
        d = json.loads(line)
        cond = d.pop('cond')
        for k, v in cond.items():
            d['c_' + k] = v
        rows.append(d)
    df = pd.DataFrame(rows)
    df['log_n'] = np.log(df['n'])
    df['m_logit'] = np.log(df['q'] / (1 - df['q']))
    return df


def load_races(path):
    rows = []
    for line in gzip.open(path, 'rt'):
        d = json.loads(line)
        for k in ('t60', 't40', 'tAny'):
            t = d.pop(k)
            for kk, v in t.items():
                d[f'{k}_{kk}'] = v
        rows.append(d)
    return pd.DataFrame(rows)


class Market3:
    """3着内の市場の予測: 切片 + logit(q) + log(頭数)。前半の全頭で一度だけ当てはめる。"""

    def fit(self, df):
        self.m = LogisticRegression(C=1e12, max_iter=2000)
        self.m.fit(df[['m_logit', 'log_n']].values, df['place3'].values)
        return self

    def predict(self, df):
        return self.m.predict_proba(df[['m_logit', 'log_n']].values)[:, 1]


def bh(pvals, q=0.10):
    """Benjamini–Hochberg。通ったかどうかの配列と、調整後の p(q 値)を返す。"""
    p = np.asarray(pvals, dtype=float)
    m = len(p)
    order = np.argsort(p)
    ranked = p[order] * m / (np.arange(m) + 1)
    adj = np.minimum.accumulate(ranked[::-1])[::-1]
    adj = np.minimum(adj, 1.0)
    out = np.empty(m)
    out[order] = adj
    return out <= q, out


def cond_stats(sub):
    """条件に当たる馬の集計。res3 = 3着内の読み残し、resw = 勝ちの読み残し。"""
    n = len(sub)
    if n == 0:
        return dict(N=0)
    v3 = (sub['p3'] * (1 - sub['p3'])).sum()
    vw = (sub['q'] * (1 - sub['q'])).sum()
    r3 = (sub['place3'] - sub['p3']).sum()
    rw = (sub['win'] - sub['q']).sum()
    ret = sub['win'] * sub['winOdds']
    return dict(N=n, exp3=sub['p3'].mean(), act3=sub['place3'].mean(), res3_pt=100 * r3 / n,
                z3=r3 / np.sqrt(v3), expw=sub['q'].mean(), actw=sub['win'].mean(), resw_pt=100 * rw / n,
                zw=rw / np.sqrt(vw), roi_pct=100 * (ret.mean() - 1), roi_se=100 * ret.std(ddof=1) / np.sqrt(n) if n > 1 else np.nan)
