"""#653: 結果の JSON から、report.md に貼る表を作る(数字を手で写さないため)。使い方: python3 report_tables.py <hyp.json> <races.json> <ls.json> <horses.ndjson.gz>"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from common import load_horses, Market3

hyp, races, ls, horses = (json.load(open(p)) if p.endswith('.json') else p for p in sys.argv[1:5])
NAMES = {
 'P1': '前走 4角が後ろ1/3・上がり3位以内・4着以下', 'P2': '前走 4角が前1/3・4着以下', 'P3': '前走 着差≤0.5秒なのに着順が後ろ半分', 'P4': '前走 大敗(2.0秒以上)',
 'P5': '前走 上がり1位なのに4着以下', 'P6': '前走が重・不良 → 今回良', 'P7': '前走が良 → 今回 稍重以下', 'P8': '前走 1着',
 'K1': '昇級', 'K2': '降級', 'K3': '昇級かつ前走1着', 'K4': '距離延長 +400m以上', 'K5': '距離短縮 -400m以上', 'K6': '芝→ダート', 'K7': 'ダート→芝',
 'K8': '初めての競馬場', 'K9': '右回り→左回り', 'J1': '乗り替わり', 'J2': '乗り替わりで見習いへ', 'J3': '見習いから非見習いへ', 'J4': '調教師替わり',
 'J5': '乗り替わりで騎手の指標 +0.02以上', 'J6': '乗り替わりで騎手の指標 -0.02以下', 'J7': '見習い騎手が騎乗', 'W1': '馬体重 +10kg以上', 'W2': '馬体重 -10kg以下',
 'W3': '+10kg以上かつ休み明け', 'W4': '-10kg以下かつ休み明け', 'I1': '休み明け(120日以上)', 'I2': '休み明け×未勝利', 'I3': '休み明け×3勝・OP', 'I4': '休み明け×牝',
 'I5': '休み明け×5歳以上', 'I6': '連闘(7日以内)', 'I7': '中1週(8〜14日)', 'I9': '休み明け×前走3着内', 'S1': '夏(7〜8月)の牝', 'S2': '2歳', 'S3': '1〜5月の3歳未勝利',
 'S4': '6〜12月の3歳馬が3歳以上戦', 'S5': 'セン馬', 'S6': '7歳以上', 'F1': '1番人気', 'F2': '14頭以上の最低人気', 'F3': '16頭以上の1・2枠', 'F4': '16頭以上の7・8枠',
 'F5': '先行脚質×内枠×1400m以下', 'F6': '追込脚質×ダート×1200m以下', 'T1': '前残りの日×先行馬', 'T2': '前残りの日×差し馬', 'T3': '差し有利の日×先行馬', 'T4': '差し有利の日×差し馬',
 'T5': '内有利の日×内枠', 'T6': '内有利の日×外枠', 'T7': '外有利の日×外枠', 'T8': '外有利の日×内枠', 'T9': '馬場が重い方へ変わった', 'T10': '馬場が軽い方へ変わった', 'T11': '馬場が変わった日×先行馬'}
out = []
H = hyp
out.append('<!--HYP_TABLE-->')
out.append('| 条件 | 内容 | 前半の件数 | 3着内の読み残し(pt) | z | 勝ちの読み残し(pt) | z | 単勝回収率(±標準誤差) | q(BH) |')
out.append('|---|---|---:|---:|---:|---:|---:|---:|---:|')
rows = sorted(H['main'].items(), key=lambda kv: -abs(kv[1]['h1'].get('z3', 0)) if kv[1]['h1']['N'] >= 300 else 99)
for c, v in H['main'].items():
    d = v['h1']
    q = f"{d['q_bh']:.2f}" if 'q_bh' in d else '件数不足'
    out.append(f"| {c} | {NAMES[c]} | {d['N']:,} | {d['res3_pt']:+.2f} | {d['z3']:+.2f} | {d['resw_pt']:+.2f} | {d['zw']:+.2f} | {100 + d['roi_pct']:.0f}% (±{d['roi_se']:.0f}) | {q} |")
out.append('<!--/HYP_TABLE-->')
out.append('<!--SENS_TABLE-->')
out.append('| 条件 | 版 | 前半の件数 | 3着内の読み残し(pt) | z |')
out.append('|---|---|---:|---:|---:|')
for c in [k for k in H['main'] if k.startswith('T')]:
    d = H['main'][c]['h1']
    out.append(f"| {c} | 60分前(主) | {d['N']:,} | {d['res3_pt']:+.2f} | {d['z3']:+.2f} |" if d['N'] else f"| {c} | 60分前(主) | 0 | | |")
    for suf, lab in (('_m40', '40分前'), ('_any', 'すべて(直前まで)')):
        s = H['sens'].get(c + suf, {}).get('h1')
        if s and s['N']:
            out.append(f"| {c} | {lab} | {s['N']:,} | {s['res3_pt']:+.2f} | {s['z3']:+.2f} |")
        else:
            out.append(f"| {c} | {lab} | 0 | | |")
out.append('<!--/SENS_TABLE-->')

R = races
out.append('<!--RACE_TABLE-->')
out.append('| 切り口 | 水準 | 指標 | 前半のレース数 | 前半の平均(z) | q(BH) | 後半のレース数 | 後半の平均(z) | q(BH、片側) | 残った |')
out.append('|---|---|---|---:|---:|---:|---:|---:|---:|---|')
for c in R['cells']:
    if not c['h1'].get('pass'):
        continue
    h1, h2 = c['h1'], c['h2']
    out.append(f"| {c['dim']} | {c['level']} | {c['metric']} | {h1['N']} | {h1['mean']:+.3f} ({h1['z']:+.2f}) | {h1['q_bh']:.3f} | {h2['N']} | {h2['mean']:+.3f} ({h2['z']:+.2f}) | {h2['q_bh']:.3f} | {'残った' if h2['remain'] else '残らず'} |")
out.append('<!--/RACE_TABLE-->')
out.append('<!--RACE_OVERALL-->')
out.append('| 指標 | 前半 全体の平均(z) | 後半 全体の平均(z) |')
out.append('|---|---:|---:|')
for m, v in R['overall'].items():
    out.append(f"| {m} | {v['h1']['mean']:+.4f} ({v['h1']['z']:+.2f}) | {v['h2']['mean']:+.4f} ({v['h2']['z']:+.2f}) |")
out.append('<!--/RACE_OVERALL-->')

L = ls
out.append('<!--LEAF_TABLE-->')
out.append('| 葉 | 条件(前半の木) | 前半の件数 | 前半 3着内 実際/予測 | 前半の読み残し(pt, z) | 後半の件数 | 後半 3着内 実際/予測 | 後半の読み残し(pt, z) | q(BH、片側) | 残った | 後半の単勝回収率 |')
out.append('|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|')
for l in L['leaves']:
    a, b = l['h1'], l['h2']
    out.append(f"| {l['leaf']} | {l['rule']} | {a['N']:,} | {100*a['act3']:.1f}% / {100*a['exp3']:.1f}% | {a['res3_pt']:+.2f} ({a['z3']:+.2f}) | {b['N']:,} | {100*b['act3']:.1f}% / {100*b['exp3']:.1f}% | {b['res3_pt']:+.2f} ({b['z3']:+.2f}) | {b['q_bh']:.3f} | {'残った' if b['remain'] else '残らず'} | {100 + b['roi_pct']:.0f}% |")
out.append('<!--/LEAF_TABLE-->')
out.append('<!--SHAP-->')
out.append('| 特徴量 | 平均の SHAP 絶対値 |')
out.append('|---|---:|')
for k, v in L['shap_top'].items():
    out.append(f'| {k} | {v:.4f} |')
out.append('<!--/SHAP-->')
# 市場の予測の全体のずれ。
df = load_horses(horses)
mk = Market3().fit(df[df.half == '1'])
df['p3'] = mk.predict(df)
g = df.groupby('half').apply(lambda s: (s.place3 - s.p3).mean() * 100)
out.append('<!--DRIFT-->')
out.append(f"3着内の読み残しの全体の平均(pt): 前半 {g['1']:+.3f}、後半 {g['2']:+.3f}(係数は前半で当てはめ。1 頭あたり)")
out.append('<!--/DRIFT-->')
print('\n'.join(out))
