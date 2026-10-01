/**
 * #41 の観測(馬ごと・レースごと)の型と、着順の分類
 * (`docs/investigations/probability-quality-41/measurement-plan.md` §3)。
 *
 * 観測 JSON は取得(ネットワーク)と集計(オフライン)の境界であり、集計はこの JSON だけから
 * 再計算できる。純関数・型だけを持つ(I/O なし)。
 */

import type { FinishPosition, RaceResult } from "../../packages/core/src/index.js";
import type { OddsStatus } from "../../packages/core/src/scraper/types.js";

/** 観測 JSON のスキーマ版。 */
export const OBSERVATION_SCHEMA_VERSION = 1;

/** 取消・除外: 観測から除く(出走していない)。 */
export const SCRATCHED_TEXTS: readonly string[] = ["取消", "除外"];
/** 中止・失格: 3着以内でない(0)として残す(出走した)。 */
export const NOT_PLACED_TEXTS: readonly string[] = ["中止", "失格"];

/** 着順の分類。 */
export type FinishClass = "placed" | "notPlaced" | "scratched" | "unclassified";

/** 1頭の着順の分類と、結果に載せる元の文言。 */
export function classifyFinish(finish: FinishPosition | null): {
  readonly cls: FinishClass;
  readonly text: string;
} {
  if (finish === null) {
    return { cls: "unclassified", text: "" };
  }
  if (finish.kind === "順位") {
    return {
      cls: finish.value <= 3 ? "placed" : "notPlaced",
      text: finish.demoted === true ? `${finish.value}(降)` : String(finish.value),
    };
  }
  if (SCRATCHED_TEXTS.includes(finish.text)) {
    return { cls: "scratched", text: finish.text };
  }
  if (NOT_PLACED_TEXTS.includes(finish.text)) {
    return { cls: "notPlaced", text: finish.text };
  }
  return { cls: "unclassified", text: finish.text };
}

/** レースを観測から外した理由。 */
export type ExcludedReason =
  | "result-fetch-error"
  | "result-not-confirmed"
  | "result-parse-error"
  | "scrape-error"
  | "unclassified-finish"
  | "horse-mismatch"
  | "too-few-runners"
  | "no-placed-horse"
  | "analysis-error"
  | "date-approximate";

/** 出走した馬の着順と結果(3着以内=1)。 */
export interface RunnerFinish {
  readonly umaban: number;
  readonly finish: FinishPosition;
  /** 3着以内なら 1、そうでなければ 0。 */
  readonly outcome: 0 | 1;
}

/** 取消・除外の馬。 */
export interface ScratchedHorse {
  readonly umaban: number;
  readonly text: string;
  /** 出馬表に載っていたか(false なら取得した出馬表には最初からいなかった)。 */
  readonly inShutuba: boolean;
}

/** classifyRaceFinishes の結果。 */
export type FinishClassification =
  | {
      readonly ok: true;
      readonly runners: readonly RunnerFinish[];
      readonly scratched: readonly ScratchedHorse[];
    }
  | { readonly ok: false; readonly reason: ExcludedReason; readonly detail: string };

/**
 * 結果ページの全着順を分類する。次のいずれかならレースを観測から外す(`ok: false`。理由と詳細を残す):
 * 未知の着順文言・空の着順欄 / 出馬表と結果の馬が対応しない / 出走頭数が3頭未満 / 3着以内が0頭。
 *
 * @param startingUmabans 取得した出馬表の馬番(取消馬を除く前)
 */
export function classifyRaceFinishes(
  startingUmabans: readonly number[],
  result: RaceResult,
): FinishClassification {
  const classified = result.horses.map((h) => ({ horse: h, ...classifyFinish(h.finishPosition) }));

  const unclassified = classified.filter((c) => c.cls === "unclassified");
  if (unclassified.length > 0) {
    return {
      ok: false,
      reason: "unclassified-finish",
      detail: unclassified
        .map((c) => `馬番${c.horse.umaban}: 「${c.text === "" ? "(空)" : c.text}」`)
        .join(" / "),
    };
  }

  const startingSet = new Set(startingUmabans);
  const seen = new Set<number>();
  for (const c of classified) {
    if (seen.has(c.horse.umaban)) {
      return { ok: false, reason: "horse-mismatch", detail: `結果に馬番${c.horse.umaban}が複数回現れる` };
    }
    seen.add(c.horse.umaban);
  }
  for (const c of classified) {
    if (c.cls !== "scratched" && !startingSet.has(c.horse.umaban)) {
      return {
        ok: false,
        reason: "horse-mismatch",
        detail: `結果で出走した馬番${c.horse.umaban}が出馬表にいない`,
      };
    }
  }
  for (const umaban of startingUmabans) {
    if (!seen.has(umaban)) {
      return { ok: false, reason: "horse-mismatch", detail: `出馬表の馬番${umaban}が結果に載っていない` };
    }
  }

  const runners: RunnerFinish[] = classified
    .filter((c) => c.cls === "placed" || c.cls === "notPlaced")
    .map((c) => ({
      umaban: c.horse.umaban,
      finish: c.horse.finishPosition!,
      outcome: c.cls === "placed" ? 1 : 0,
    }));
  const scratched: ScratchedHorse[] = classified
    .filter((c) => c.cls === "scratched")
    .map((c) => ({ umaban: c.horse.umaban, text: c.text, inShutuba: startingSet.has(c.horse.umaban) }));

  if (runners.length < 3) {
    return { ok: false, reason: "too-few-runners", detail: `出走頭数が${runners.length}頭(3頭未満)` };
  }
  const placedCount = runners.filter((r) => r.outcome === 1).length;
  if (placedCount === 0) {
    return { ok: false, reason: "no-placed-horse", detail: "3着以内の馬が0頭" };
  }
  return { ok: true, runners, scratched };
}

// ---------------------------------------------------------------------------
// 観測 JSON の型
// ---------------------------------------------------------------------------

/** 1頭分の観測。 */
export interface HorseObservation {
  readonly umaban: number;
  readonly horseName: string;
  /** prior(LLM なし。リーク遮断後。`runAnalysis` の出力)。 */
  readonly prior: number;
  /** 複勝オッズ下限(生の `OddsSnapshot.place`。取得できなければ null)。 */
  readonly placeOddsMin: number | null;
  /** 複勝オッズ上限。 */
  readonly placeOddsMax: number | null;
  /** 確定着順(結果ページの表記のまま)。 */
  readonly finish: FinishPosition;
  /** 3着以内なら 1。 */
  readonly outcome: 0 | 1;
  /** 戦績の取得に成功したか(false なら戦績0走として prior が計算された)。 */
  readonly resultsFetched: boolean;
  /** prior の計算に使った戦績の走数(遮断後。戦績を取得できなければ null)。 */
  readonly usedRunCount: number | null;
}

/** リーク遮断の診断値(計測側が `filterRaceDataBefore` を生の戦績に掛けた実際の戻り値の要約)。 */
export interface LeakFilterSummary {
  readonly cutoffDate: string;
  readonly totalResultCount: number;
  readonly removedCount: number;
  readonly removedByCutoffCount: number;
  readonly removedByInvalidDateCount: number;
}

/** 計測条件(数値と必ず同梱する)。 */
export interface ObservationConditions {
  readonly priorSource: "prior-only";
  readonly dateApproximate: false;
  readonly leakFilter: LeakFilterSummary;
  readonly placeOddsKind: "placeOddsMinLowerBound";
}

/** 取得中の警告(戦績の取得失敗など)。 */
export interface ObservationWarning {
  readonly kind: string;
  readonly message: string;
  readonly horseId?: string;
}

/** レースの識別情報(観測・除外のどちらにも付く)。 */
export interface RaceIdentity {
  readonly schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  readonly raceId: string;
  readonly region: "central" | "nar";
  /** 要求した開催日(YYYYMMDD)。 */
  readonly requestedDate: string;
  /** 実際に使った開催日(遡った場合は要求日と異なる)。 */
  readonly kaisaiDate: string;
  readonly venueCode: string;
  readonly raceNumber: number;
  readonly raceName: string;
  /** 一覧に載っていた頭数(取消前)。 */
  readonly listedEntryCount: number;
}

/** 観測に成功したレース。 */
export interface RaceObservationOk extends RaceIdentity {
  readonly status: "ok";
  readonly courseType: string;
  readonly distance: number;
  readonly runnerCount: number;
  readonly placedCount: number;
  readonly oddsStatus: OddsStatus;
  readonly horses: readonly HorseObservation[];
  readonly scratched: readonly ScratchedHorse[];
  readonly conditions: ObservationConditions;
  readonly warnings: readonly ObservationWarning[];
  /** 戦績の取得に失敗した馬の数(`horses[].resultsFetched===false` の数)。 */
  readonly resultsFailedHorseCount: number;
  readonly fetchedAt: string;
}

/** 観測から外したレース(理由と詳細を残す)。 */
export interface RaceObservationExcluded extends RaceIdentity {
  readonly status: "excluded";
  readonly reason: ExcludedReason;
  readonly detail: string;
  readonly fetchedAt: string;
}

export type RaceObservation = RaceObservationOk | RaceObservationExcluded;
