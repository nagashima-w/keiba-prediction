/**
 * 配分の再計算用の書き出し(Issue #463)のジョブの純ロジック。**`cloudflare:workers` を import しない**(Node でテストできる)。本物の `ctx.storage.kv`・時計・アラーム・D1・R2 は
 * `allocation-export-do.ts`(DO `AllocationExportDO`)が配線する。netkeiba にも LLM にも出ない。
 *
 * 統計モデル用の書き出し(`prior-export-core.ts`。Issue #266)と同じ作りの別のジョブ(状態機械を写して新設した。統合は後続の課題)。違い:
 *  - 1 tick は {@link ALLOCATION_EXPORT_BATCH_SIZE} 件(組合せオッズで 1 件が大きいため。塊が 1 つあたり 1 MiB 未満に収まる上界は、`allocation-export-format.ts` のテストが固定する)。
 *  - 仕上げは**塊を 1 つずつ流して** R2 に put する(全体を 1 つのバッファに連結しない。ファイルが数十 MB になっても DO のメモリ 128MB に収まるように)。
 *    総バイト数は、各塊を kv に置いたときの長さの和で、`FixedLengthStream` に先に渡す。
 *  - 行の中身・母集団は `allocation-export-format.ts`。
 *
 * ## 流れ
 *  1. 要求(`request`): `download`(通常の GET)・`refresh`(`?refresh=1`)・`status`(`?status=1`。副作用なし)。
 *  2. tick(`runTick`。アラーム): 計画(適格な分析を選んで batch に分ける)→ 処理(D1 で馬・結果・配分のメタ・買い目・払戻を読み、R2 から詳細を取り、行を整形して
 *     その tick ぶんだけ gzip し kv に置く)→ 仕上げ(メタ行 + 各 tick のメンバーを流して R2 に put。固定キーを原子的に上書き)。
 *
 * ## 取り決め・柵・失敗
 * prior-dataset の書き出しと同じ(作成中は古いファイルを返さず building、作成中の refresh は二重に始めない、失敗後の download は勝手に始め直さない。
 * 1 日(JST)3 回まで、R2 の読み書きの柵、連続 5 回の失敗で止まる)。このジョブは別の DO インスタンスなので、回数も状態も prior-dataset の書き出しとは独立。
 */

import { jstIsoDate, nextJstMidnight } from "../../packages/core/src/common/jst";
import { isReadAllowed, isWriteAllowed, type R2Usage } from "./r2-fence";
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
import {
  PRIOR_EXPORT_BACKOFF_MS,
  PRIOR_EXPORT_DAILY_LIMIT,
  PRIOR_EXPORT_MAX_ATTEMPTS,
  PRIOR_EXPORT_TICK_DELAY_MS,
  PRIOR_EXPORT_TICK_QUERY_LIMIT,
  type DetailRequest,
  type ExportKv,
  type ExportMode,
} from "./prior-export-core";
import type { CandidateRow } from "./prior-export-format";

/** 1 日(JST)に始められる回数の既定(上限)。統計モデル用の書き出しと同じ値。上書きは下げる方向にだけ。 */
export const ALLOCATION_EXPORT_DAILY_LIMIT = PRIOR_EXPORT_DAILY_LIMIT;
/** 1 tick で処理する分析の数(= R2 の GET の数)。組合せオッズ込みの 1 件は最大約 90KB(JSON。18 頭・全 6 券種)なので、1 つの塊を 1 MiB 未満に保つために 10 件。 */
export const ALLOCATION_EXPORT_BATCH_SIZE = 10;
/** 1 tick の問い合わせ数(D1 の文 + R2 の操作)の上限。統計モデル用の書き出しと同じ(Free の 50 の手前)。 */
export const ALLOCATION_EXPORT_TICK_QUERY_LIMIT = PRIOR_EXPORT_TICK_QUERY_LIMIT;
/** 1 tick の固定の問い合わせ数: 使用量 1 + 馬・結果・配分のメタ・買い目・組合せ払戻・取込印の batch 6 文 + Class B の加算 1。 */
export const ALLOCATION_EXPORT_TICK_OVERHEAD_QUERIES = 8;
/** 連続して失敗してよい回数。超えたら止まる。 */
export const ALLOCATION_EXPORT_MAX_ATTEMPTS = PRIOR_EXPORT_MAX_ATTEMPTS;

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
export interface AllocationExportStorePort {
  readUsage(): Promise<R2Usage>;
  /** 結果のあるレースの分析をすべて読む(選別は {@link selectAllocationExportAnalyses})。 */
  readCandidates(): Promise<{ readonly rows: CandidateRow[]; readonly rowsRead: number }>;
  readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<AllocationRaceDataBatch>;
  /** 詳細(R2)を取る。取得を試みた回数 `gets` を返す。 */
  fetchDetails(items: readonly DetailRequest[]): Promise<{ readonly outcomes: AllocationDetailOutcome[]; readonly gets: number }>;
  /** R2 の Class B を `gets` 回ぶん数える(D1 の `r2_ops`)。 */
  countReads(gets: number): Promise<void>;
  /**
   * 完成したファイルを固定キーに流して put する(Class A を数える)。`parts` は先頭から順に 1 つずつ取り出す遅延の列挙で、`totalBytes` は全部の長さの和
   * (`FixedLengthStream` に先に渡す)。流している途中の例外は put の失敗(固定キーは古いファイルのまま)。
   */
  putFileStream(key: string, parts: () => Iterable<Uint8Array>, totalBytes: number, info: { readonly generatedAt: string; readonly rows: number; readonly races: number }): Promise<void>;
}

export interface AllocationExportDeps {
  readonly kv: ExportKv;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly store: AllocationExportStorePort;
  readonly onWarn?: (message: string) => void;
}

export interface AllocationExportOptions {
  readonly dailyLimit?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
}

/** 完成したファイルの情報(kv の `file`。状態の応答にも載せる)。 */
export interface AllocationExportFileInfo {
  /** 完成の時刻(ISO)。 */
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
  /** 分析時点のオッズを再構成できなかったレース(R2 の詳細が無い・壊れている)の数。 */
  readonly missingOdds: number;
  /** 配分のメタ行が無い分析の数。 */
  readonly noAllocation: number;
  readonly excluded: AllocationExcludedCounts;
  /** ファイルのバイト数(gzip 後)。 */
  readonly bytes: number;
  /** 実測用の診断: D1 が報告した読み取り行数の合計と、R2 の取得を試みた回数(再試行を含む)。 */
  readonly diag: { readonly rowsRead: number; readonly gets: number };
}

export type AllocationExportFailReason = "tick-failed" | "r2-fence";

export type AllocationExportResponse =
  | { readonly status: "empty"; readonly file: null }
  | { readonly status: "ready"; readonly file: AllocationExportFileInfo }
  | {
      readonly status: "building";
      readonly phase: JobPhase;
      /** 処理を終えたレースの数と、全体(計画の前は null)。 */
      readonly racesDone: number;
      readonly races: number | null;
      readonly startedAt: string;
      /** 前回の完成したファイル(作成中は返さない。取り違えを避けるため情報だけ)。 */
      readonly file: AllocationExportFileInfo | null;
    }
  | { readonly status: "failed"; readonly reason: AllocationExportFailReason; readonly file: AllocationExportFileInfo | null }
  | { readonly status: "throttled"; readonly nextAt: string; readonly file: AllocationExportFileInfo | null }
  | { readonly status: "blocked"; readonly reason: "r2-fence"; readonly file: AllocationExportFileInfo | null };

type JobPhase = "planning" | "building" | "finalizing";

interface Job {
  state: "running" | "failed";
  phase: JobPhase;
  startedAt: number;
  /** 計画で決めた batch の数(planning の前は 0)と、処理を終えた batch の数。 */
  batches: number;
  done: number;
  races: number;
  rows: number;
  missingOdds: number;
  noAllocation: number;
  excluded: AllocationExcludedCounts | null;
  /** 処理を終えた塊ごとのバイト数(仕上げで総バイト数を先に決めるため)。 */
  chunkBytes: number[];
  rowsRead: number;
  gets: number;
  attempts: number;
  failReason?: AllocationExportFailReason;
}

interface Runs {
  /** JST の日付(YYYY-MM-DD)。 */
  day: string;
  count: number;
}

const planKey = (i: number): string => `plan:${i}`;
const chunkKey = (i: number): string => `chunk:${i}`;

export class AllocationExportCore {
  private readonly dailyLimit: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly deps: AllocationExportDeps,
    options: AllocationExportOptions = {},
  ) {
    this.dailyLimit = options.dailyLimit ?? ALLOCATION_EXPORT_DAILY_LIMIT;
    this.batchSize = options.batchSize ?? ALLOCATION_EXPORT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts ?? ALLOCATION_EXPORT_MAX_ATTEMPTS;
  }

  // -------------------------------------------------------------------------
  // 要求
  // -------------------------------------------------------------------------

  async request(mode: ExportMode): Promise<AllocationExportResponse> {
    const { kv } = this.deps;
    const file = kv.get<AllocationExportFileInfo>("file") ?? null;
    const job = kv.get<Job>("job");
    if (job?.state === "running") {
      if (mode !== "status") {
        await this.ensureAlarm();
      }
      return this.building(job, file);
    }
    if (mode === "status") {
      if (job?.state === "failed") return this.failed(job, file);
      return file === null ? { status: "empty", file: null } : { status: "ready", file };
    }
    if (mode === "download") {
      if (job?.state === "failed") return this.failed(job, file);
      if (file !== null) return { status: "ready", file };
    }
    return this.start(file);
  }

  private building(job: Job, file: AllocationExportFileInfo | null): AllocationExportResponse {
    const planned = job.phase !== "planning";
    return {
      status: "building",
      phase: job.phase,
      racesDone: Math.min(job.done * this.batchSize, job.races),
      races: planned ? job.races : null,
      startedAt: new Date(job.startedAt).toISOString(),
      file,
    };
  }

  private failed(job: Job, file: AllocationExportFileInfo | null): AllocationExportResponse {
    return { status: "failed", reason: job.failReason ?? "tick-failed", file };
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.deps.getAlarm()) === null) {
      await this.deps.setAlarm(this.deps.now());
    }
  }

  private async start(file: AllocationExportFileInfo | null): Promise<AllocationExportResponse> {
    const { kv, now, store, setAlarm } = this.deps;
    const t = now();
    const runs = kv.get<Runs>("runs");
    if (runs !== undefined && runs.day === jstIsoDate(t) && runs.count >= this.dailyLimit) {
      return { status: "throttled", nextAt: new Date(nextJstMidnight(t)).toISOString(), file };
    }
    const usage = await store.readUsage();
    if (!isReadAllowed(usage)) {
      return { status: "blocked", reason: "r2-fence", file };
    }
    // await の間に別の要求が始めていたら、二重に始めない(回数も消費しない)。
    const raced = kv.get<Job>("job");
    if (raced?.state === "running") {
      return this.building(raced, file);
    }
    if (raced !== undefined) {
      this.cleanup(raced);
    }
    const day = jstIsoDate(t);
    kv.put("runs", { day, count: runs !== undefined && runs.day === day ? runs.count + 1 : 1 } satisfies Runs);
    const job: Job = {
      state: "running", phase: "planning", startedAt: t, batches: 0, done: 0, races: 0, rows: 0, missingOdds: 0, noAllocation: 0,
      excluded: null, chunkBytes: [], rowsRead: 0, gets: 0, attempts: 0,
    };
    kv.put("job", job);
    await setAlarm(t);
    return this.building(job, file);
  }

  // -------------------------------------------------------------------------
  // tick(アラーム)
  // -------------------------------------------------------------------------

  /** アラーム: 次の段を 1 つ進める。例外は握る(失敗は退避の間隔で再試行し、上限で止まる)。 */
  async runTick(): Promise<void> {
    const { kv } = this.deps;
    const job = kv.get<Job>("job");
    if (job === undefined || job.state !== "running") {
      return;
    }
    try {
      if (job.phase === "planning") {
        await this.plan(job);
      } else if (job.phase === "building") {
        await this.processBatch(job);
      } else {
        await this.finalize(job);
      }
    } catch {
      // 例外の本文は状態に入れない(固定の理由だけ)。
      this.deps.onWarn?.("配分の再計算用の書き出しで例外が起きました(再試行します)");
      await this.recordFailure(job);
    }
  }

  private async plan(job: Job): Promise<void> {
    const { kv, now, store, setAlarm } = this.deps;
    const { rows, rowsRead } = await store.readCandidates();
    const { chosen, excluded } = selectAllocationExportAnalyses(rows);
    const batches = Math.ceil(chosen.length / this.batchSize);
    for (let i = 0; i < batches; i += 1) {
      kv.put(planKey(i), chosen.slice(i * this.batchSize, (i + 1) * this.batchSize));
    }
    this.save({ ...job, phase: batches === 0 ? "finalizing" : "building", batches, done: 0, races: chosen.length, excluded, rowsRead: job.rowsRead + rowsRead, attempts: 0 });
    await setAlarm(now() + PRIOR_EXPORT_TICK_DELAY_MS);
  }

  private async processBatch(job: Job): Promise<void> {
    const { kv, now, store, setAlarm } = this.deps;
    const usage = await store.readUsage();
    if (!isReadAllowed(usage)) {
      this.fail(job, "r2-fence");
      return;
    }
    const items = kv.get<ChosenAllocationAnalysis[]>(planKey(job.done));
    if (items === undefined) {
      throw new Error("計画が失われています");
    }
    const data = await store.readRaceData(items.map((a) => a.id), items.map((a) => a.raceId));
    const details = await store.fetchDetails(items.map((a) => ({ id: a.id, raceId: a.raceId, detailKey: a.detailKey })));
    // 取得を試みた回数は、失敗した取得も数える(R2 への要求は発生している)。
    await store.countReads(details.gets);
    const gets = job.gets + details.gets;
    const rowsRead = job.rowsRead + data.rowsRead;
    if (details.outcomes.some((o) => o.kind === "failed")) {
      await this.recordFailure({ ...job, gets, rowsRead });
      return;
    }

    const horsesByAnalysis = groupBy(data.horses, (h) => h.analysisId);
    const resultsByRace = groupBy(data.results, (r) => r.raceId);
    const metaByAnalysis = new Map(data.metas.map((m) => [m.analysisId, m] as const));
    const betsByAnalysis = groupBy(data.bets, (b) => b.analysisId);
    const payoutsByRace = groupBy(data.payouts, (p) => p.raceId);
    const importsByRace = groupBy(data.imports, (i) => i.raceId);
    let missingOdds = 0;
    let noAllocation = 0;
    const rows = items.map((analysis, i) => {
      const outcome = details.outcomes[i]!;
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
    const chunk = encodeAllocationChunk(rows);
    kv.put(chunkKey(job.done), chunk);
    const done = job.done + 1;
    this.save({
      ...job, done, phase: done >= job.batches ? "finalizing" : "building", rows: job.rows + rows.length, missingOdds: job.missingOdds + missingOdds,
      noAllocation: job.noAllocation + noAllocation, chunkBytes: [...job.chunkBytes, chunk.length], gets, rowsRead, attempts: 0,
    });
    await setAlarm(now() + PRIOR_EXPORT_TICK_DELAY_MS);
  }

  private async finalize(job: Job): Promise<void> {
    const { kv, now, store } = this.deps;
    const usage = await store.readUsage();
    if (!isWriteAllowed(usage)) {
      this.fail(job, "r2-fence");
      return;
    }
    const generatedAt = new Date(now()).toISOString();
    const excluded = job.excluded ?? { suspect: 0, unknown: 0, unchecked: 0, superseded: 0, estimated: 0 };
    const head = buildAllocationHead({ generatedAt, rows: job.rows, races: job.races, missingOdds: job.missingOdds, noAllocation: job.noAllocation, excluded });
    const totalBytes = job.chunkBytes.reduce((n, b) => n + b, head.length);
    // 塊は 1 つずつ kv から読んで流す(全体を連結しない)。失われている・長さが記録と違う塊は例外(流している途中の例外は put の失敗)。
    const parts = function* (): Generator<Uint8Array> {
      yield head;
      for (let i = 0; i < job.batches; i += 1) {
        const chunk = kv.get<Uint8Array>(chunkKey(i));
        if (chunk === undefined) {
          throw new Error("処理済みの塊が失われています");
        }
        if (chunk.length !== job.chunkBytes[i]) {
          throw new Error("処理済みの塊の長さが記録と違います");
        }
        yield chunk;
      }
    };
    await store.putFileStream(ALLOCATION_EXPORT_KEY, parts, totalBytes, { generatedAt, rows: job.rows, races: job.races });
    kv.put("file", {
      generatedAt, rows: job.rows, races: job.races, missingOdds: job.missingOdds, noAllocation: job.noAllocation, excluded, bytes: totalBytes,
      diag: { rowsRead: job.rowsRead, gets: job.gets },
    } satisfies AllocationExportFileInfo);
    this.cleanup(job);
    kv.delete("job");
  }

  private save(job: Job): void {
    this.deps.kv.put("job", job);
  }

  private fail(job: Job, reason: AllocationExportFailReason): void {
    this.cleanup(job);
    this.save({ ...job, state: "failed", failReason: reason });
  }

  private async recordFailure(job: Job): Promise<void> {
    const attempts = job.attempts + 1;
    if (attempts >= this.maxAttempts) {
      this.fail({ ...job, attempts }, "tick-failed");
      return;
    }
    this.save({ ...job, attempts });
    await this.deps.setAlarm(this.deps.now() + PRIOR_EXPORT_BACKOFF_MS[Math.min(attempts - 1, PRIOR_EXPORT_BACKOFF_MS.length - 1)]!);
  }

  /** 計画と処理済みの塊を消す。 */
  private cleanup(job: Job): void {
    for (let i = 0; i < job.batches; i += 1) {
      this.deps.kv.delete(planKey(i));
      this.deps.kv.delete(chunkKey(i));
    }
  }
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = map.get(key);
    if (group === undefined) map.set(key, [item]);
    else group.push(item);
  }
  return map;
}
