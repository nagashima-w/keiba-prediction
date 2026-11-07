"""export_coef.py の JSON から、本番に埋め込む係数の TypeScript(packages/core/src/ev/stat-shadow-coef.ts)を作る。
使い方: python3 -I gen_coef_ts.py <coef.json> <出力.ts> <版の名前の日付 例 2026-11-07>
"""
import json, sys
c = json.load(open(sys.argv[1])); out = sys.argv[2]; date = sys.argv[3]
def arr(xs):
    return '[\n' + ''.join(f'      {x!r},\n' for x in xs) + '    ]'
lines = []
lines.append('/**')
lines.append(' * 本番の並走(影の計算。Issue #649)に埋め込む、学習済みのロジスティック回帰の係数。**手で書き換えない**(`scripts/stat-model-649/export_coef.py` と `gen_coef_ts.py` が作る)。')
lines.append(' *')
lines.append(f' * 学習: 中央の過去の結果 {c["trainedMonths"][0]}〜{c["trainedMonths"][1]}、{c["races"]} レース・{c["horses"]} 頭(replay.ts の出力。走った馬が 5 頭以上で全頭に確定単勝オッズがあるレース)。')
lines.append(' * 標準化 + L2(C=1.0)のロジスティック回帰を目的(勝率・2着内率・3着内率)ごとに当て、標準化の平均・尺度を畳み込んで元の単位の重みにした。')
lines.append(' * score = 切片 + Σ 重み × 特徴量。特徴量の並びは `features`(odds 版の先頭 3 つは logit(q)・log(頭数)・logit(prior)、noodds 版は log(頭数)・logit(prior)、残りは 15 項目の寄与を名前の昇順で並べたもの)。')
lines.append(' * 保留(2026-08〜10)を開けた評価(#649 のコメント)で使った学習と同じ係数(fit.py --open-holdout の importance.json と標準化した係数が一致することを確かめた)。')
lines.append(' * 学習に使った特徴量の作り方と、本番の作り方が同じであることは `packages/core/test/ev/stat-shadow.test.ts` の突き合わせ(Python で計算した値)が固定する。')
lines.append(' */')
lines.append('')
lines.append(f'/** 影の計算のモデルの版(表 `analysis_shadow_probs.model` に入る名前)。係数を学び直したら、新しい名前にする(古い名前の行は書き換えない)。 */')
lines.append(f'export const SHADOW_MODEL_ODDS = "lr649-odds-{date}";')
lines.append(f'export const SHADOW_MODEL_NODDS = "lr649-noodds-{date}";')
lines.append('')
lines.append('/** 15 項目の寄与の名前(昇順)。学習で使った並び。 */')
lines.append('export const SHADOW_CONTRIB_NAMES: readonly string[] = ' + json.dumps(c['contribNames'], ensure_ascii=False) + ';')
lines.append('')
lines.append('export interface ShadowObjectiveCoef {')
lines.append('  readonly intercept: number;')
lines.append('  readonly weights: readonly number[];')
lines.append('}')
lines.append('')
lines.append('export interface ShadowModelCoef {')
lines.append('  readonly features: readonly string[];')
lines.append('  readonly win: ShadowObjectiveCoef;')
lines.append('  readonly top2: ShadowObjectiveCoef;')
lines.append('  readonly top3: ShadowObjectiveCoef;')
lines.append('}')
lines.append('')
for key, const in (('odds', 'SHADOW_COEF_ODDS'), ('noodds', 'SHADOW_COEF_NODDS')):
    m = c['models'][key]
    lines.append(f'export const {const}: ShadowModelCoef = {{')
    lines.append('  features: ' + json.dumps(m['features'], ensure_ascii=False) + ',')
    for obj in ('win', 'top2', 'top3'):
        o = m['objectives'][obj]
        lines.append(f'  {obj}: {{')
        lines.append(f'    intercept: {o["intercept"]!r},')
        lines.append('    weights: ' + arr(o['weights']) + ',')
        lines.append('  },')
    lines.append('};')
    lines.append('')
open(out, 'w').write('\n'.join(lines))
