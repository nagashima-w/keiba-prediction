/**
 * 終盤の位置の指標(Issue #363。想定隊列図〈#362〉の4コーナーの位置に使う画面の表示用)。
 *
 * 近走の最終コーナーの通過順位を出走頭数で割った相対位置(0〜1。小さいほど前)の平均。
 * 「最終コーナー」は `passing` の最後の要素で、通過点が 2〜3 個のレースでも末尾=最終コーナーとして扱う
 * (中央の多くのレースは 4 コーナーまで 4 個の通過点がある)。
 * 序盤の位置(`early-position.ts`)の作りに揃えた別の指標で、見る要素だけが「最初」から「最後」に変わる。
 * LLM のプロンプト・確率・配分には使わない(画面の演出だけ)。
 *
 * **通過点が 1 つしかない走は採らない**: 最後の要素が最初の要素と同じになり、終盤の位置として意味が崩れるため。
 *
 * 純関数。戦績は新しい順(HTML 上の並び)を前提とする。
 */

/** 参照する走数(新しい順に、採用できた走をこの数まで)。 */
export const LATE_POSITION_RUNS = 3;

/** 指標の計算に使う戦績の1走分(`HorseRaceResult` の部分)。 */
export interface LatePositionRun {
  /** 通過順位(例: 2-3-4-3 → [2,3,4,3])。空は不明。 */
  readonly passing: readonly number[];
  /** 出走頭数。取得できなければ null。 */
  readonly entryCount: number | null;
}

/**
 * 1走分の相対位置。通過順位が無い・通過点が1つだけ・頭数が2頭未満・位置が 1〜頭数の整数でない走は null(採らない)。
 */
function relativeLastCorner(run: LatePositionRun): number | null {
  if (run.passing.length < 2) {
    return null;
  }
  const pos = run.passing[run.passing.length - 1];
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
 * 新しい順に、採用できた走を最大 {@link LATE_POSITION_RUNS} 走集め、相対位置の平均(小数3桁に丸める)を返す。
 * 採用できる走が1つも無い(戦績 null・空・通過順位なし・通過点が1つだけ・頭数不明など)は null。1走だけでも採用する。
 */
export function computeLatePosition(results: readonly LatePositionRun[] | null): number | null {
  if (results === null) {
    return null;
  }
  const ratios: number[] = [];
  for (const run of results) {
    if (ratios.length >= LATE_POSITION_RUNS) {
      break;
    }
    const r = relativeLastCorner(run);
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
