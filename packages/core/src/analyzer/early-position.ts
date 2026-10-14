/**
 * スタート直後の位置の指標(Issue #311。レース再生の演出用)。
 *
 * 近走の第1コーナーの通過順位を出走頭数で割った相対位置(0〜1。小さいほど前)の平均。
 * 脚質の分類(`leg-style.ts`)は道中の全コーナーの平均を使うが、こちらは「スタート直後にどこにいるか」だけを見る
 * (終いに動く馬の位置を後ろに引っ張らないため)。LLM のプロンプト・確率・配分には使わない(画面の演出だけ)。
 *
 * 純関数。戦績は新しい順(HTML 上の並び)を前提とする。
 */

/** 参照する走数(新しい順に、採用できた走をこの数まで)。 */
export const EARLY_POSITION_RUNS = 3;

/** 指標の計算に使う戦績の1走分(`HorseRaceResult` の部分)。 */
export interface EarlyPositionRun {
  /** 通過順位(例: 2-3-4-3 → [2,3,4,3])。空は不明。 */
  readonly passing: readonly number[];
  /** 出走頭数。取得できなければ null。 */
  readonly entryCount: number | null;
}

/** 1走分の相対位置。通過順位が無い・頭数が2頭未満・位置が 1〜頭数の整数でない走は null(採らない)。 */
function relativeFirstCorner(run: EarlyPositionRun): number | null {
  const pos = run.passing[0];
  const n = run.entryCount;
  if (pos === undefined || n === null || !Number.isInteger(n) || n < 2) {
    return null;
  }
  if (!Number.isInteger(pos) || pos < 1 || pos > n) {
    return null;
  }
  return pos / n;
}

/**
 * 新しい順に、採用できた走を最大 {@link EARLY_POSITION_RUNS} 走集め、相対位置の平均(小数3桁に丸める)を返す。
 * 採用できる走が1つも無い(戦績 null・空・通過順位なし・頭数不明など)は null。1走だけでも採用する。
 */
export function computeEarlyPosition(results: readonly EarlyPositionRun[] | null): number | null {
  if (results === null) {
    return null;
  }
  const ratios: number[] = [];
  for (const run of results) {
    if (ratios.length >= EARLY_POSITION_RUNS) {
      break;
    }
    const r = relativeFirstCorner(run);
    if (r !== null) {
      ratios.push(r);
    }
  }
  if (ratios.length === 0) {
    return null;
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.round(mean * 1000) / 1000;
}
