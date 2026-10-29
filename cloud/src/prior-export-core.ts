/**
 * 統計モデルの見直し用の書き出し(Issue #266)のジョブの純ロジック。**`cloudflare:workers` を import しない**(Node でテストできる)。本物の `ctx.storage.kv`・時計・アラーム・D1・R2 は
 * `prior-export-do.ts`(DO `PriorExportDO`)が配線する。netkeiba にも LLM にも出ない。
 *
 * 状態機械(計画 → 処理 → 仕上げ・1 日の回数の柵・R2 の柵・失敗と退避・`download` / `refresh` / `status`)は、配分用の書き出しと共有する `export-job-core.ts`
 * (Issue #495)にある。ここに残るのは、この書き出しだけの差: 母集団の選別・1 tick の行の組み立て(D1 で馬・結果・面を読み、R2 の詳細の寄与度と出馬表の列を足す)・
 * メタ行・ファイルの情報に足す数(`missingDetail`)・定数。
 *
 * ## 流れ(この書き出しの tick)
 * 計画(適格な分析を選んで batch に分ける。**形式 v5 から、同じ tick で騎手名 → 騎手 ID の対応〈`jockey_names` 表で ID がちょうど 1 つの名前〉も 1 回読み**、kv の `lookups` に置いて全 batch で使う。
 * スナップショットに騎手 ID が無い行を、これで埋める。Issue #526 段階 1b)→ 処理(1 tick に {@link PRIOR_EXPORT_BATCH_SIZE} 件。D1 で馬・結果・面を読み、R2 から詳細を取り、
 * 行を整形して **その tick ぶんだけ gzip** し kv に置く)→ 仕上げ(メタ行 + 各 tick のメンバーを**1 つずつ流して** R2 に put。固定キーを原子的に上書き)。
 * gzip のメンバーの連結は 1 回の gunzip で読めるので、全体を 1 文字列にも 1 つのバッファにもしない(DO のメモリ 128MB のため)。
 *
 * ## 柵の根拠(1 日 {@link PRIOR_EXPORT_DAILY_LIMIT} 回)
 * 1 回の D1 の読み取りは 53,324 行(ローカルの実測。形式 v5 の対応の読み出しで、`jockey_names` 表の行数ぶんだけ増える〈1 回の作成につき 1 回。本番の行数は未測定〉。合成データ 分析 2,225・結果 1,301 レース・1 レース 14 頭。
 * 再現: `pnpm tsx scripts/measure-prior-export.ts`。`docs/current-spec.md` の「統計モデルの見直し用の書き出し」)で、3 回で 159,972 行。Free の 500 万行/日の約 3.2%。本番の実数は未確認
 * (最初の作成の `?status=1` の `file.diag.rowsRead` で確かめ、必要なら上限を下げる)。
 *
 * ## 失敗
 * 詳細(R2)が無い・壊れているレースは失敗ではない(行は出し、`contributions` は null、メタ行の `missingDetail` に数える)。
 */

import {
  EXPORT_BACKOFF_MS,
  EXPORT_DAILY_LIMIT,
  EXPORT_MAX_ATTEMPTS,
  EXPORT_TICK_DELAY_MS,
  EXPORT_TICK_QUERY_LIMIT,
  ExportJobCore,
  groupBy,
  type ExportDeps,
  type ExportJobFileInfo,
  type ExportJobResponse,
  type ExportKindSpec,
  type ExportOptions,
  type ExportStorePort,
} from "./export-job-core";
import {
  buildPriorHead,
  buildRaceRows,
  encodeChunk,
  PRIOR_EXPORT_KEY,
  selectPriorExportAnalyses,
  toContributions,
  type ChosenAnalysis,
  type ExcludedCounts,
  type PriorContribution,
  type PriorHorseInput,
  type PriorResultInput,
  type PriorSnapshotColumns,
} from "./prior-export-format";

export type { DetailRequest, ExportFailReason, ExportKv, ExportMode } from "./export-job-core";

/** 1 日(JST)に始められる回数の既定(上限)。上書きは下げる方向にだけ。 */
export const PRIOR_EXPORT_DAILY_LIMIT = EXPORT_DAILY_LIMIT;
/** 1 tick で処理する分析の数(= R2 の GET の数)。 */
export const PRIOR_EXPORT_BATCH_SIZE = 30;
/** 1 tick の問い合わせ数(D1 の文 + R2 の操作)の上限。`VERIFY_TICK_QUERY_LIMIT` と同じ(Free の 50 の手前)。 */
export const PRIOR_EXPORT_TICK_QUERY_LIMIT = EXPORT_TICK_QUERY_LIMIT;
/** 1 tick の固定の問い合わせ数: 使用量 1 + 馬・結果・面の batch 3 文 + Class B の加算 1。 */
export const PRIOR_EXPORT_TICK_OVERHEAD_QUERIES = 5;
/** 次の tick までの間隔。 */
export const PRIOR_EXPORT_TICK_DELAY_MS = EXPORT_TICK_DELAY_MS;
/** 連続して失敗してよい回数。超えたら止まる。 */
export const PRIOR_EXPORT_MAX_ATTEMPTS = EXPORT_MAX_ATTEMPTS;
/** 失敗後の再試行までの待ち。n 回目の失敗の後は `[n-1]`(最後の値を繰り返す)。 */
export const PRIOR_EXPORT_BACKOFF_MS: readonly number[] = EXPORT_BACKOFF_MS;

export type DetailOutcome =
  | {
      readonly kind: "ok";
      readonly contributions: Readonly<Record<string, unknown>>;
      /** 詳細の `raceSnapshot` から取り出した v2 の列(Issue #341。スナップショットが null・壊れていれば全列 null)。追加の取得ではなく、同じ詳細の中身。 */
      readonly snapshot: PriorSnapshotColumns;
    }
  /** 詳細が無い(`detail_key` が NULL・R2 に無い・壊れている・別のレースのもの)。失敗ではない。 */
  | { readonly kind: "none" }
  /** 取得が例外になった(再試行する)。 */
  | { readonly kind: "failed" };

export interface RaceDataBatch {
  readonly horses: ReadonlyArray<PriorHorseInput & { readonly analysisId: number }>;
  readonly results: ReadonlyArray<PriorResultInput & { readonly raceId: string }>;
  readonly courseTypes: ReadonlyArray<{ readonly raceId: string; readonly courseType: string | null }>;
  /** D1 が報告した読み取り行数の合計。 */
  readonly rowsRead: number;
}

/**
 * 全 batch が共有する引き当て用の表(Issue #526 段階 1b)。騎手名 → 騎手 ID の対応で、**D1 の `jockey_names` で ID がちょうど 1 つの名前だけ**(2 つ以上ある名前は入れない)。
 * kv に置くので、`Map` ではなく組の配列(`[騎手名, 騎手 ID][]`)。名前をオブジェクトのキーにしない(`constructor` などの名前で継承されたプロパティを拾わないため)。
 */
export interface PriorLookups {
  readonly jockeyIds: ReadonlyArray<readonly [string, string]>;
}

/** D1・R2 の窓口(`D1PriorExportStore` がこれを満たす。テストでは偽物)。統計モデル用は、引き当て用の表の読み出し(`readLookups`)を**必ず**持つ(配線漏れをコンパイルで検出する)。 */
export type PriorExportStorePort = ExportStorePort<RaceDataBatch, DetailOutcome, PriorLookups> &
  Required<Pick<ExportStorePort<RaceDataBatch, DetailOutcome, PriorLookups>, "readLookups">>;

export type PriorExportDeps = ExportDeps<PriorExportStorePort>;

export type PriorExportOptions = ExportOptions;

/** 完成したファイルの情報(kv の `file`。状態の応答にも載せる)。`missingDetail` は、詳細(R2)が無い・壊れているレースの数。 */
export type ExportFileInfo = ExportJobFileInfo<"missingDetail", ExcludedCounts>;

export type ExportResponse = ExportJobResponse<ExportFileInfo>;

const PRIOR_SPEC: ExportKindSpec<ChosenAnalysis, ExcludedCounts, "missingDetail", RaceDataBatch, DetailOutcome, PriorLookups> = {
  key: PRIOR_EXPORT_KEY,
  warnMessage: "統計モデル用の書き出しで例外が起きました(再試行します)",
  counterKeys: ["missingDetail"],
  defaultBatchSize: PRIOR_EXPORT_BATCH_SIZE,
  emptyExcluded: { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 },
  select: selectPriorExportAnalyses,
  buildChunk(items, data, outcomes, lookups) {
    // 対応が無いジョブ(読む前のコードが始めたジョブ)は、空の対応で続ける(埋めない。スナップショットの ID はそのまま)。
    const jockeyIdByName = new Map(lookups?.jockeyIds ?? []);
    const horsesByAnalysis = groupBy(data.horses, (h) => h.analysisId);
    const resultsByRace = groupBy(data.results, (r) => r.raceId);
    const courseTypes = new Map(data.courseTypes.map((c) => [c.raceId, c.courseType] as const));
    let missing = 0;
    const rows = items.flatMap((analysis, i) => {
      const outcome = outcomes[i]!;
      const contributions = new Map<number, PriorContribution[] | null>();
      if (outcome.kind === "ok") {
        for (const [key, value] of Object.entries(outcome.contributions)) {
          contributions.set(Number(key), toContributions(value));
        }
      } else {
        missing += 1;
      }
      return buildRaceRows(
        analysis, horsesByAnalysis.get(analysis.id) ?? [], resultsByRace.get(analysis.raceId) ?? [], courseTypes.get(analysis.raceId) ?? null, contributions,
        outcome.kind === "ok" ? outcome.snapshot : null, jockeyIdByName,
      );
    });
    return { chunk: encodeChunk(rows), rows: rows.length, counts: { missingDetail: missing } };
  },
  // メタの引数のキーの並びは、ファイルのバイト列に出る(従来の仕上げと同じ並びにする)。
  buildHead: (m) => buildPriorHead({ generatedAt: m.generatedAt, rows: m.rows, races: m.races, missingDetail: m.counts.missingDetail, excluded: m.excluded }),
};

export class PriorExportCore extends ExportJobCore<ChosenAnalysis, ExcludedCounts, "missingDetail", RaceDataBatch, DetailOutcome, PriorLookups> {
  constructor(deps: PriorExportDeps, options: PriorExportOptions = {}) {
    super(PRIOR_SPEC, deps, options);
  }
}
