/**
 * 脚質分類 — 各馬の直近走の通過順位から逃げ/先行/差し/追込を粗く分類する決定論的な純関数群。
 *
 * 仕様「3. analyzer」: 「レース間隔、脚質と展開想定(逃げ馬の数からペースを推定)」をプロンプトに
 * 含めるための材料を用意する。分類は「粗く」でよい(LLMが最終解釈を担う)ため、第1コーナー通過順を
 * 頭数で正規化した相対位置で切る単純規則とする。頭数が取れない過去走は絶対位置でフォールバックする。
 *
 * 分類規則(第1コーナー通過順 pos、頭数 field):
 *   - pos === 1                → 逃げ(先頭)
 *   - field 判明時: r = pos/field で  r<=1/3 → 先行 / r<=2/3 → 差し / それ以外 → 追込
 *   - field 不明時(絶対位置):  pos<=4 → 先行 / pos<=8 → 差し / それ以外 → 追込
 */

/** 脚質(粗い4分類)。 */
export type LegStyle = "逃げ" | "先行" | "差し" | "追込";

/** 脚質分類の入力となる1走分の通過情報。 */
export interface HorseRunPassing {
  /** 通過順位(例: 2-3-4-3 → [2,3,4,3])。空配列は不明扱い。 */
  readonly passing: readonly number[];
  /** その走の出走頭数。取得できない場合は null。 */
  readonly fieldSize: number | null;
}

/** classifyHorseLegStyle の任意設定。 */
export interface ClassifyHorseOptions {
  /** 参照する直近走数(既定3)。新しい順に最大この数だけ見る。 */
  readonly recentRuns?: number;
}

/** 相対位置の閾値(先行/差しの上限)。 */
const LEAD_RATIO = 1 / 3;
const MID_RATIO = 2 / 3;

/** 絶対位置フォールバックの閾値(先行/差しの上限)。 */
const LEAD_POS = 4;
const MID_POS = 8;

/**
 * 1走分の脚質を分類する。通過順が空なら null(不明)。
 * @param passing 通過順位(第1コーナー = passing[0] を代表位置に使う)
 * @param fieldSize その走の頭数(null なら絶対位置でフォールバック)
 */
export function classifyRunLegStyle(
  passing: readonly number[],
  fieldSize: number | null,
): LegStyle | null {
  const pos = passing[0];
  if (pos === undefined) {
    return null;
  }
  if (pos === 1) {
    return "逃げ";
  }
  if (fieldSize !== null && fieldSize > 0) {
    const r = pos / fieldSize;
    if (r <= LEAD_RATIO) return "先行";
    if (r <= MID_RATIO) return "差し";
    return "追込";
  }
  // 頭数不明: 絶対位置でフォールバック。
  if (pos <= LEAD_POS) return "先行";
  if (pos <= MID_POS) return "差し";
  return "追込";
}

/**
 * 直近複数走から代表脚質を求める。通過順を持つ走が1つも無ければ null。
 * 最頻の脚質を採用し、同数のときは直近走(runs 先頭側)の脚質を優先する。
 * @param runs 過去走(新しい順を前提)
 */
export function classifyHorseLegStyle(
  runs: readonly HorseRunPassing[],
  options: ClassifyHorseOptions = {},
): LegStyle | null {
  const recentRuns = options.recentRuns ?? 3;
  // 新しい順に走を見て、脚質が取れたものだけ最大 recentRuns 件集める。
  const styles: LegStyle[] = [];
  for (const run of runs) {
    if (styles.length >= recentRuns) break;
    const s = classifyRunLegStyle(run.passing, run.fieldSize);
    if (s !== null) {
      styles.push(s);
    }
  }
  if (styles.length === 0) {
    return null;
  }
  // 出現数を数え、同数は「先に出現した(=より直近)」ものを優先する。
  const count = new Map<LegStyle, number>();
  const firstIndex = new Map<LegStyle, number>();
  styles.forEach((s, i) => {
    count.set(s, (count.get(s) ?? 0) + 1);
    if (!firstIndex.has(s)) firstIndex.set(s, i);
  });
  let best = styles[0]!;
  for (const s of count.keys()) {
    const c = count.get(s)!;
    const bestCount = count.get(best)!;
    if (c > bestCount || (c === bestCount && firstIndex.get(s)! < firstIndex.get(best)!)) {
      best = s;
    }
  }
  return best;
}

/** 脚質配列から逃げ馬の数を数える(null は無視)。 */
export function countFrontRunners(styles: readonly (LegStyle | null)[]): number {
  return styles.reduce((n, s) => (s === "逃げ" ? n + 1 : n), 0);
}

/**
 * 逃げ馬の数からペース想定の文言を作る(展開想定の材料)。
 * 粗い目安であり、最終的な解釈は LLM に委ねる。
 */
export function estimatePace(frontRunnerCount: number): string {
  if (frontRunnerCount <= 0) {
    return "逃げ馬不在でスロー(前残り)想定";
  }
  if (frontRunnerCount === 1) {
    return "逃げ馬1頭で平均ペース想定";
  }
  return "逃げ馬複数でハイペース想定";
}
