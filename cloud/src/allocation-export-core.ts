/**
 * 配分の再計算用の書き出し(Issue #463)のジョブの純ロジック。**`cloudflare:workers` を import しない**(Node でテストできる)。本物の `ctx.storage.kv`・時計・アラーム・D1・R2 は
 * `allocation-export-do.ts`(DO `AllocationExportDO`)が配線する。netkeiba にも LLM にも出ない。
 *
 * 状態機械(計画 → 処理 → 仕上げ・1 日の回数の柵・R2 の柵・失敗と退避・`download` / `refresh` / `status`)は、統計モデル用の書き出しと共有する `export-job-core.ts`
 * (Issue #495。#463 では統計モデル用〈`prior-export-core.ts`。Issue #266〉を写して新設し、#495 で 1 つにまとめた)にある。ここに残るのは、この書き出しだけの差:
 *  - 1 tick は {@link ALLOCATION_EXPORT_BATCH_SIZE} 件(組合せオッズで 1 件が大きいため。塊が 1 つあたり 1 MiB 未満に収まる上界は、`allocation-export-format.ts` のテストが固定する)。
 *  - 1 tick で D1 から読むもの(馬・結果・配分のメタ・買い目・払戻・取込印)と、1 レース 1 行の組み立て。
 *  - ファイルの情報に足す数(`missingOdds`・`noAllocation`)。
 *  - 行の中身・母集団は `allocation-export-format.ts`。
 *
 * ## 流れ(この書き出しの tick)
 * 計画(適格な分析を選んで batch に分ける)→ 処理(D1 で馬・結果・配分のメタ・買い目・払戻を読み、R2 から詳細を取り、行を整形して
 * その tick ぶんだけ gzip し kv に置く)→ 仕上げ(メタ行 + 各 tick のメンバーを**1 つずつ流して** R2 に put。固定キーを原子的に上書き。
 * 全体を 1 つのバッファに連結しない。ファイルが数十 MB になっても DO のメモリ 128MB に収まるように)。
 * 取り決め・柵・失敗は統計モデル用の書き出しと同じ(作成中は古いファイルを返さず building、作成中の refresh は二重に始めない、失敗後の download は勝手に始め直さない。
 * 1 日(JST)3 回まで、R2 の読み書きの柵、連続 5 回の失敗で止まる)。このジョブは別の DO インスタンスなので、回数も状態も統計モデル用の書き出しとは独立。
 */

import {
  EXPORT_DAILY_LIMIT,
  EXPORT_MAX_ATTEMPTS,
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
  ALLOCATION_EXPORT_KEY,
  buildAllocationHead,
  buildAllocationRaceRow,
  encodeAllocationChunk,
  selectAllocationExportAnalyses,
  type AllocationBetInput,
  type AllocationExcludedCounts,
  type AllocationHorseInput,
  type AllocationMetaInput,
  type AllocationPayoutInput,
  type AllocationResultInput,
  type AllocationSnapshotColumns,
  type ChosenAllocationAnalysis,
} from "./allocation-export-format";

/** 1 日(JST)に始められる回数の既定(上限)。統計モデル用の書き出しと同じ値。上書きは下げる方向にだけ。 */
export const ALLOCATION_EXPORT_DAILY_LIMIT = EXPORT_DAILY_LIMIT;
/** 1 tick で処理する分析の数(= R2 の GET の数)。組合せオッズ込みの 1 件は最大約 90KB(JSON。18 頭・全 6 券種)なので、1 つの塊を 1 MiB 未満に保つために 10 件。 */
export const ALLOCATION_EXPORT_BATCH_SIZE = 10;
/** 1 tick の問い合わせ数(D1 の文 + R2 の操作)の上限。統計モデル用の書き出しと同じ(Free の 50 の手前)。 */
export const ALLOCATION_EXPORT_TICK_QUERY_LIMIT = EXPORT_TICK_QUERY_LIMIT;
/** 1 tick の固定の問い合わせ数: 使用量 1 + 馬・結果・配分のメタ・買い目・組合せ払戻・取込印の batch 6 文 + Class B の加算 1。 */
export const ALLOCATION_EXPORT_TICK_OVERHEAD_QUERIES = 8;
/** 連続して失敗してよい回数。超えたら止まる。 */
export const ALLOCATION_EXPORT_MAX_ATTEMPTS = EXPORT_MAX_ATTEMPTS;

export type AllocationDetailOutcome =
  | {
      readonly kind: "ok";
      /** 詳細の `raceSnapshot` から取り出した、配分の再計算に要る分。追加の取得ではなく、同じ詳細の中身。 */
      readonly snapshot: AllocationSnapshotColumns;
    }
  /** 詳細が無い(`detail_key` が NULL・R2 に無い・壊れている・別のレースのもの)。失敗ではない。 */
  | { readonly kind: "none" }
  /** 取得が例外になった(再試行する)。 */
  | { readonly kind: "failed" };

export interface AllocationRaceDataBatch {
  readonly horses: ReadonlyArray<AllocationHorseInput & { readonly analysisId: number }>;
  readonly results: ReadonlyArray<AllocationResultInput & { readonly raceId: string }>;
  readonly metas: ReadonlyArray<AllocationMetaInput & { readonly analysisId: number }>;
  readonly bets: ReadonlyArray<AllocationBetInput & { readonly analysisId: number }>;
  readonly payouts: ReadonlyArray<AllocationPayoutInput & { readonly raceId: string }>;
  readonly imports: ReadonlyArray<{ readonly raceId: string; readonly betType: string }>;
  /** D1 が報告した読み取り行数の合計。 */
  readonly rowsRead: number;
}

/** D1・R2 の窓口(`D1AllocationExportStore` がこれを満たす。テストでは偽物)。 */
export type AllocationExportStorePort = ExportStorePort<AllocationRaceDataBatch, AllocationDetailOutcome>;

export type AllocationExportDeps = ExportDeps<AllocationExportStorePort>;

export type AllocationExportOptions = ExportOptions;

/** 完成したファイルの情報(kv の `file`。状態の応答にも載せる)。`missingOdds` は分析時点のオッズを再構成できなかったレース(R2 の詳細が無い・壊れている)の数、`noAllocation` は配分のメタ行が無い分析の数。 */
export type AllocationExportFileInfo = ExportJobFileInfo<"missingOdds" | "noAllocation", AllocationExcludedCounts>;

export type AllocationExportFailReason = "tick-failed" | "r2-fence";

export type AllocationExportResponse = ExportJobResponse<AllocationExportFileInfo>;

const ALLOCATION_SPEC: ExportKindSpec<ChosenAllocationAnalysis, AllocationExcludedCounts, "missingOdds" | "noAllocation", AllocationRaceDataBatch, AllocationDetailOutcome> = {
  key: ALLOCATION_EXPORT_KEY,
  warnMessage: "配分の再計算用の書き出しで例外が起きました(再試行します)",
  counterKeys: ["missingOdds", "noAllocation"],
  defaultBatchSize: ALLOCATION_EXPORT_BATCH_SIZE,
  emptyExcluded: { suspect: 0, unknown: 0, unchecked: 0, uncheckedRaces: 0, superseded: 0, estimated: 0 },
  select: selectAllocationExportAnalyses,
  buildChunk(items, data, outcomes) {
    const horsesByAnalysis = groupBy(data.horses, (h) => h.analysisId);
    const resultsByRace = groupBy(data.results, (r) => r.raceId);
    const metaByAnalysis = new Map(data.metas.map((m) => [m.analysisId, m] as const));
    const betsByAnalysis = groupBy(data.bets, (b) => b.analysisId);
    const payoutsByRace = groupBy(data.payouts, (p) => p.raceId);
    const importsByRace = groupBy(data.imports, (i) => i.raceId);
    let missingOdds = 0;
    let noAllocation = 0;
    const rows = items.map((analysis, i) => {
      const outcome = outcomes[i]!;
      const row = buildAllocationRaceRow({
        analysis,
        horses: horsesByAnalysis.get(analysis.id) ?? [],
        snapshot: outcome.kind === "ok" ? outcome.snapshot : null,
        meta: metaByAnalysis.get(analysis.id) ?? null,
        bets: betsByAnalysis.get(analysis.id) ?? [],
        results: resultsByRace.get(analysis.raceId) ?? [],
        payouts: payoutsByRace.get(analysis.raceId) ?? [],
        imports: (importsByRace.get(analysis.raceId) ?? []).map((x) => x.betType),
      });
      if (!row.has_odds) missingOdds += 1;
      if (row.allocation === null) noAllocation += 1;
      return row;
    });
    return { chunk: encodeAllocationChunk(rows), rows: rows.length, counts: { missingOdds, noAllocation } };
  },
  // メタの引数のキーの並びは、ファイルのバイト列に出る(従来の仕上げと同じ並びにする)。
  buildHead: (m) =>
    buildAllocationHead({ generatedAt: m.generatedAt, rows: m.rows, races: m.races, missingOdds: m.counts.missingOdds, noAllocation: m.counts.noAllocation, excluded: m.excluded }),
};

export class AllocationExportCore extends ExportJobCore<ChosenAllocationAnalysis, AllocationExcludedCounts, "missingOdds" | "noAllocation", AllocationRaceDataBatch, AllocationDetailOutcome> {
  constructor(deps: AllocationExportDeps, options: AllocationExportOptions = {}) {
    super(ALLOCATION_SPEC, deps, options);
  }
}
