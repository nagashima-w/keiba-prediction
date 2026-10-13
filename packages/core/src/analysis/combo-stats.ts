/**
 * combo-stats — 組合せの券種ごとの「EV プラスの点数」の記録(Issue #296)。
 *
 * 配分の計算(`buildMixedRaceAllocationWithOutcome`)は、候補の診断(券種ごとに EV プラス・非プラス・判定不能の点数)を作るが、
 * D1 の配分の記録(メタ行と stake>0 の明細)には残らない。レースの画面の「配分の提案」に券種ごとの点数を出すために、
 * 診断を券種ごとの `{ positive, judged }` に縮めて R2 のスナップショット(`raceSnapshot.comboStats`)に残す(#295 の `baba` と同じ置き場所。D1 の migration は要らない)。
 *
 * - `positive`: EV が閾値を超えた点数(`judged.positiveCount`)。
 * - `judged`: EV を判定できた点数(プラス + 非プラス)。**0 点のとき、「判定したがプラスが無い」(judged > 0)と「判定できなかった」(judged = 0。
 *   オッズが無い・不正、または順序の確率が定まらない形)を区別する**ために持つ。
 *
 * 入る券種は、候補を実際に作った券種だけ(`diagnostics.<券種>.kind === "built"`)。配分に含めない設定・発売前(yoso)の券種は入らない。
 * 単勝・複勝は対象外(組合せの券種ではない)。
 */
import type { MixedCandidateDiagnostics } from "./mixed-candidates.js";
import type { MixedRaceAllocationOutcome } from "./mixed-race-allocation.js";

/** スナップショットに入れるキー名(書き込み側〈パイプライン〉と読み出し側〈クラウドの API〉で共有する)。 */
export const COMBO_STATS_SNAPSHOT_KEY = "comboStats" as const;

/** 対象の券種(画面の並び順。ワイド → 馬連 → 枠連 → 馬単 → 三連複 → 三連単)。 */
export const COMBO_STATS_BET_TYPES = ["wide", "quinella", "bracketQuinella", "exacta", "trio", "trifecta"] as const;

export type ComboStatsBetType = (typeof COMBO_STATS_BET_TYPES)[number];

export interface ComboBetTypeStats {
  /** EV が閾値を超えた点数。 */
  readonly positive: number;
  /** EV を判定できた点数(プラス + 非プラス)。`positive` 以上。 */
  readonly judged: number;
}

export type ComboStats = { readonly [K in ComboStatsBetType]?: ComboBetTypeStats };

function statsOfDiagnostics(diagnostics: MixedCandidateDiagnostics): ComboStats {
  const result: { -readonly [K in ComboStatsBetType]?: ComboBetTypeStats } = {};
  for (const type of COMBO_STATS_BET_TYPES) {
    const view = diagnostics[type];
    if (view.kind === "built") {
      const { positiveCount, notPositiveCount } = view.build.judged;
      result[type] = { positive: positiveCount, judged: positiveCount + notPositiveCount };
    }
  }
  return result;
}

/**
 * 配分の結果(`candidateDiagnostics` を持つもの)から `comboStats` を作る。候補を作る前に決まった経路(unset・yoso・組合せの取得 OFF・券種すべて OFF)は診断が無いので null。
 */
export function buildComboStats(outcome: MixedRaceAllocationOutcome): ComboStats | null {
  return outcome.candidateDiagnostics === undefined ? null : statsOfDiagnostics(outcome.candidateDiagnostics);
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * R2 から読んだ `comboStats`(型は検証されていない)を整える。許可した券種だけを、`{ positive, judged }`(0 以上の整数・judged ≥ positive)の2項目だけで返す。
 * 不正な項目は捨てる。オブジェクトでない・有効な項目が 1 つも無いときは null(「記録なし」)。
 */
export function normalizeComboStats(raw: unknown): ComboStats | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const result: { -readonly [K in ComboStatsBetType]?: ComboBetTypeStats } = {};
  for (const type of COMBO_STATS_BET_TYPES) {
    const entry = record[type];
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { positive, judged } = entry as Record<string, unknown>;
    if (isCount(positive) && isCount(judged) && judged >= positive) {
      result[type] = { positive, judged };
    }
  }
  return Object.keys(result).length === 0 ? null : result;
}
