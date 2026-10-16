/**
 * 統計モデルの見直し用の書き出し(Issue #266)のジョブの純ロジック。**`cloudflare:workers` を import しない**(Node でテストできる)。本物の `ctx.storage.kv`・時計・アラーム・D1・R2 は
 * `prior-export-do.ts`(DO `PriorExportDO`)が配線する。netkeiba にも LLM にも出ない。
 *
 * ## なぜ多段のジョブか
 * 項目ごとの補正(`contributions`)は D1 に無く、R2 の詳細オブジェクト(1 分析 約 129KB の gzip)にしかない。1,300 件超を 1 回の呼び出しでは読めない
 * (Free は 1 回の呼び出しで 50 クエリ。R2 の GET も数える)。そこで発走時刻の補完(`verify-core.ts` の `runBackfillTick`)と同じく、アラームで少しずつ進める。
 *
 * ## 流れ
 *  1. 要求(`request`): `download`(通常の GET)・`refresh`(`?refresh=1`)・`status`(`?status=1`。副作用なし)。ジョブを始める条件は下の「柵」。
 *  2. tick(`runTick`。アラーム): 計画(適格な分析を選んで batch に分ける)→ 処理(1 tick に {@link PRIOR_EXPORT_BATCH_SIZE} 件。D1 で馬・結果・面を読み、R2 から詳細を取り、
 *     行を整形して **その tick ぶんだけ gzip** し kv に置く)→ 仕上げ(メタ行 + 各 tick のメンバーを連結して R2 に put。固定キーを原子的に上書き)。
 *     gzip のメンバーの連結は 1 回の gunzip で読めるので、全体を 1 文字列にしない(DO のメモリ 128MB のため)。
 *
 * ## 取り決め(ユーザーとの合意)
 *  - 作成中は、通常の `download` も古いファイルを返さず `building`(進捗つき)を返す(作り直しを始めた管理者が、古いファイルを新しいものと取り違えないように)。
 *    完成後の `download` は新しいファイルを返す(`ready`)。
 *  - 作成中の `refresh` は二重に始めず `building` を返し、1 日の回数を消費しない。
 *  - 失敗(`failed`)のあとの通常の `download` は勝手に始め直さず `failed` を返す。`refresh` で始め直す(回数を消費する)。
 *
 * ## 柵
 *  - 始める回数は 1 日(JST)に {@link PRIOR_EXPORT_DAILY_LIMIT} 回まで(始めたときに数える)。根拠: 1 回の D1 の読み取りは 53,324 行(ローカルの実測。合成データ 分析 2,225・結果 1,301 レース・1 レース 14 頭。
 *    再現: `pnpm tsx scripts/measure-prior-export.ts`。`docs/current-spec.md` の「統計モデルの見直し用の書き出し」)で、3 回で 159,972 行。Free の 500 万行/日の約 3.2%。本番の実数は未確認
 *    (最初の作成の `?status=1` の `file.diag.rowsRead` で確かめ、必要なら上限を下げる)。
 *  - 始めるとき R2 の読み出し(Class B)の柵、仕上げの put の前に書き込み(Class A)の柵を見る(`r2-fence.ts`)。Class B は tick ごとに取得を試みた回数をそのまま数える。
 *
 * ## 失敗
 * tick の例外・R2 の取得の失敗は、退避の間隔で同じ batch を再試行し、連続 {@link PRIOR_EXPORT_MAX_ATTEMPTS} 回で止まる(`failed`/`tick-failed`)。例外の本文は状態に入れない(固定の理由だけ)。
 * 詳細(R2)が無い・壊れているレースは失敗ではない(行は出し、`contributions` は null、メタ行の `missingDetail` に数える)。
 */

import { isReadAllowed, isWriteAllowed, type R2Usage } from "./r2-fence";
import {
  assembleFile,
  buildRaceRows,
  encodeChunk,
  PRIOR_EXPORT_KEY,
  selectPriorExportAnalyses,
  toContributions,
  type CandidateRow,
  type ChosenAnalysis,
  type ExcludedCounts,
  type PriorContribution,
  type PriorHorseInput,
  type PriorResultInput,
  type PriorSnapshotColumns,
} from "./prior-export-format";

/** 1 日(JST)に始められる回数の既定(上限)。上書きは下げる方向にだけ。 */
export const PRIOR_EXPORT_DAILY_LIMIT = 3;
/** 1 tick で処理する分析の数(= R2 の GET の数)。 */
export const PRIOR_EXPORT_BATCH_SIZE = 30;
/** 1 tick の問い合わせ数(D1 の文 + R2 の操作)の上限。`VERIFY_TICK_QUERY_LIMIT` と同じ(Free の 50 の手前)。 */
export const PRIOR_EXPORT_TICK_QUERY_LIMIT = 40;
/** 1 tick の固定の問い合わせ数: 使用量 1 + 馬・結果・面の batch 3 文 + Class B の加算 1。 */
export const PRIOR_EXPORT_TICK_OVERHEAD_QUERIES = 5;
/** 次の tick までの間隔。 */
export const PRIOR_EXPORT_TICK_DELAY_MS = 1_000;
/** 連続して失敗してよい回数。超えたら止まる。 */
export const PRIOR_EXPORT_MAX_ATTEMPTS = 5;
/** 失敗後の再試行までの待ち。n 回目の失敗の後は `[n-1]`(最後の値を繰り返す)。 */
export const PRIOR_EXPORT_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

const JST_OFFSET_MS = 9 * 60 * 60_000;

/** `ctx.storage.kv`(同期 API)のうち、ここで使う部分。 */
export interface ExportKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
}

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

export interface DetailRequest {
  readonly id: number;
  readonly raceId: string;
  readonly detailKey: string | null;
}

/** D1・R2 の窓口(`D1PriorExportStore` がこれを満たす。テストでは偽物)。 */
export interface PriorExportStorePort {
  readUsage(): Promise<R2Usage>;
  /** 結果のあるレースの分析をすべて読む(選別は {@link selectPriorExportAnalyses})。 */
  readCandidates(): Promise<{ readonly rows: CandidateRow[]; readonly rowsRead: number }>;
  readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<RaceDataBatch>;
  /** 詳細(R2)を取る。取得を試みた回数 `gets` を返す。 */
  fetchDetails(items: readonly DetailRequest[]): Promise<{ readonly outcomes: DetailOutcome[]; readonly gets: number }>;
  /** R2 の Class B を `gets` 回ぶん数える(D1 の `r2_ops`)。 */
  countReads(gets: number): Promise<void>;
  /** 完成したファイルを固定キーに put する(Class A を数える)。 */
  putFile(key: string, bytes: Uint8Array, info: { readonly generatedAt: string; readonly rows: number; readonly races: number }): Promise<void>;
}

export interface PriorExportDeps {
  readonly kv: ExportKv;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly store: PriorExportStorePort;
  readonly onWarn?: (message: string) => void;
}

export interface PriorExportOptions {
  readonly dailyLimit?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
}

export type ExportMode = "download" | "refresh" | "status";

/** 完成したファイルの情報(kv の `file`。状態の応答にも載せる)。 */
export interface ExportFileInfo {
  /** 完成の時刻(ISO)。 */
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
  readonly missingDetail: number;
  readonly excluded: ExcludedCounts;
  /** ファイルのバイト数(gzip 後)。 */
  readonly bytes: number;
  /** 実測用の診断: D1 が報告した読み取り行数の合計と、R2 の取得を試みた回数(再試行を含む)。 */
  readonly diag: { readonly rowsRead: number; readonly gets: number };
}

export type ExportFailReason = "tick-failed" | "r2-fence";

export type ExportResponse =
  | { readonly status: "empty"; readonly file: null }
  | { readonly status: "ready"; readonly file: ExportFileInfo }
  | {
      readonly status: "building";
      readonly phase: JobPhase;
      /** 処理を終えたレースの数と、全体(計画の前は null)。 */
      readonly racesDone: number;
      readonly races: number | null;
      readonly startedAt: string;
      /** 前回の完成したファイル(作成中は返さない。取り違えを避けるため情報だけ)。 */
      readonly file: ExportFileInfo | null;
    }
  | { readonly status: "failed"; readonly reason: ExportFailReason; readonly file: ExportFileInfo | null }
  | { readonly status: "throttled"; readonly nextAt: string; readonly file: ExportFileInfo | null }
  | { readonly status: "blocked"; readonly reason: "r2-fence"; readonly file: ExportFileInfo | null };

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
  missingDetail: number;
  excluded: ExcludedCounts | null;
  rowsRead: number;
  gets: number;
  attempts: number;
  failReason?: ExportFailReason;
}

interface Runs {
  /** JST の日付(YYYY-MM-DD)。 */
  day: string;
  count: number;
}

const jstDay = (ms: number): string => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
const nextJstMidnight = (ms: number): number => Date.parse(`${jstDay(ms)}T00:00:00.000Z`) - JST_OFFSET_MS + 24 * 60 * 60_000;

const planKey = (i: number): string => `plan:${i}`;
const chunkKey = (i: number): string => `chunk:${i}`;

export class PriorExportCore {
  private readonly dailyLimit: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly deps: PriorExportDeps,
    options: PriorExportOptions = {},
  ) {
    this.dailyLimit = options.dailyLimit ?? PRIOR_EXPORT_DAILY_LIMIT;
    this.batchSize = options.batchSize ?? PRIOR_EXPORT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts ?? PRIOR_EXPORT_MAX_ATTEMPTS;
  }

  // -------------------------------------------------------------------------
  // 要求
  // -------------------------------------------------------------------------

  async request(mode: ExportMode): Promise<ExportResponse> {
    const { kv } = this.deps;
    const file = kv.get<ExportFileInfo>("file") ?? null;
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

  private building(job: Job, file: ExportFileInfo | null): ExportResponse {
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

  private failed(job: Job, file: ExportFileInfo | null): ExportResponse {
    return { status: "failed", reason: job.failReason ?? "tick-failed", file };
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.deps.getAlarm()) === null) {
      await this.deps.setAlarm(this.deps.now());
    }
  }

  private async start(file: ExportFileInfo | null): Promise<ExportResponse> {
    const { kv, now, store, setAlarm } = this.deps;
    const t = now();
    const runs = kv.get<Runs>("runs");
    if (runs !== undefined && runs.day === jstDay(t) && runs.count >= this.dailyLimit) {
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
    const day = jstDay(t);
    kv.put("runs", { day, count: runs !== undefined && runs.day === day ? runs.count + 1 : 1 } satisfies Runs);
    const job: Job = {
      state: "running", phase: "planning", startedAt: t, batches: 0, done: 0, races: 0, rows: 0, missingDetail: 0,
      excluded: null, rowsRead: 0, gets: 0, attempts: 0,
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
      this.deps.onWarn?.("統計モデル用の書き出しで例外が起きました(再試行します)");
      await this.recordFailure(job);
    }
  }

  private async plan(job: Job): Promise<void> {
    const { kv, now, store, setAlarm } = this.deps;
    const { rows, rowsRead } = await store.readCandidates();
    const { chosen, excluded } = selectPriorExportAnalyses(rows);
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
    const items = kv.get<ChosenAnalysis[]>(planKey(job.done));
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
    const courseTypes = new Map(data.courseTypes.map((c) => [c.raceId, c.courseType] as const));
    let missing = 0;
    const rows = items.flatMap((analysis, i) => {
      const outcome = details.outcomes[i]!;
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
        outcome.kind === "ok" ? outcome.snapshot : null,
      );
    });
    kv.put(chunkKey(job.done), encodeChunk(rows));
    const done = job.done + 1;
    this.save({
      ...job, done, phase: done >= job.batches ? "finalizing" : "building", rows: job.rows + rows.length, missingDetail: job.missingDetail + missing, gets, rowsRead, attempts: 0,
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
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < job.batches; i += 1) {
      const chunk = kv.get<Uint8Array>(chunkKey(i));
      if (chunk === undefined) {
        throw new Error("処理済みの塊が失われています");
      }
      chunks.push(chunk);
    }
    const generatedAt = new Date(now()).toISOString();
    const excluded = job.excluded ?? { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 };
    const bytes = assembleFile({ generatedAt, rows: job.rows, races: job.races, missingDetail: job.missingDetail, excluded }, chunks);
    await store.putFile(PRIOR_EXPORT_KEY, bytes, { generatedAt, rows: job.rows, races: job.races });
    kv.put("file", {
      generatedAt, rows: job.rows, races: job.races, missingDetail: job.missingDetail, excluded, bytes: bytes.length, diag: { rowsRead: job.rowsRead, gets: job.gets },
    } satisfies ExportFileInfo);
    this.cleanup(job);
    kv.delete("job");
  }

  private save(job: Job): void {
    this.deps.kv.put("job", job);
  }

  private fail(job: Job, reason: ExportFailReason): void {
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
