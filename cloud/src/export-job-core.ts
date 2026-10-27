/**
 * 書き出しのジョブの共通の部品(Issue #495)。統計モデルの見直し用(`prior-export-core.ts`。Issue #266)と、配分の再計算用(`allocation-export-core.ts`。Issue #463)の
 * 2 つの書き出しは、同じ状態機械を持つ。それをここに 1 つにまとめた。**`cloudflare:workers` を import しない**(Node でテストできる)。
 * 本物の `ctx.storage.kv`・時計・アラーム・D1・R2 は、各書き出しの DO が配線する。netkeiba にも LLM にも出ない。
 *
 * ## 書き出しの種別ごとの差(`ExportKindSpec`)
 * 次のものだけを、種別ごとに差し込む。ほかはすべてここで決まる。
 *  - 母集団の選別(`select`)・1 つの塊の組み立て(`buildChunk`)・メタ行(`buildHead`)
 *  - ファイルの情報に足す数(`counterKeys`。統計モデル用は `missingDetail`、配分用は `missingOdds`・`noAllocation`)
 *  - R2 の固定キー・1 tick の件数の既定・警告の文
 * 1 tick で D1 から何を読むか(`readRaceData`)と、詳細(R2)の取り方(`fetchDetails`)は、種別ごとの窓口(`ExportStorePort`)が決める。
 *
 * ## なぜ多段のジョブか
 * 項目ごとの補正・分析時点のオッズは D1 に無く、R2 の詳細オブジェクトにしかない。1,300 件超を 1 回の呼び出しでは読めない
 * (Free は 1 回の呼び出しで 50 クエリ。R2 の GET も数える)。そこで発走時刻の補完(`verify-core.ts` の `runBackfillTick`)と同じく、アラームで少しずつ進める。
 *
 * ## 流れ
 *  1. 要求(`request`): `download`(通常の GET)・`refresh`(`?refresh=1`)・`status`(`?status=1`。副作用なし)。ジョブを始める条件は下の「柵」。
 *  2. tick(`runTick`。アラーム): 計画(適格な分析を選んで batch に分ける)→ 処理(1 tick に batch の件数。D1 で読み、R2 から詳細を取り、行を整形して
 *     **その tick ぶんだけ gzip** し kv に置く)→ 仕上げ(メタ行 + 各 tick のメンバーを**1 つずつ流して** R2 に put。固定キーを原子的に上書き)。
 *     gzip のメンバーの連結は 1 回の gunzip で読める。全体を 1 つのバッファに連結しない(DO のメモリ 128MB のため)。
 *     総バイト数は、各塊を kv に置いたときの長さの和で、流す前に窓口へ渡す(`FixedLengthStream` に先に渡すため)。
 *
 * ## 取り決め(ユーザーとの合意)
 *  - 作成中は、通常の `download` も古いファイルを返さず `building`(進捗つき)を返す(作り直しを始めた管理者が、古いファイルを新しいものと取り違えないように)。
 *    完成後の `download` は新しいファイルを返す(`ready`)。
 *  - 作成中の `refresh` は二重に始めず `building` を返し、1 日の回数を消費しない。
 *  - 失敗(`failed`)のあとの通常の `download` は勝手に始め直さず `failed` を返す。`refresh` で始め直す(回数を消費する)。
 *
 * ## 柵
 *  - 始める回数は 1 日(JST)に {@link EXPORT_DAILY_LIMIT} 回まで(始めたときに数える)。
 *  - 始めるとき R2 の読み出し(Class B)の柵、仕上げの put の前に書き込み(Class A)の柵を見る(`r2-fence.ts`)。Class B は tick ごとに取得を試みた回数をそのまま数える。
 *
 * ## 失敗
 * tick の例外・R2 の取得の失敗は、退避の間隔で同じ batch を再試行し、連続 {@link EXPORT_MAX_ATTEMPTS} 回で止まる(`failed`/`tick-failed`)。例外の本文は状態に入れない(固定の理由だけ)。
 *
 * ## kv の状態(本番に残るものを、そのまま読める)
 * キーは `job`・`file`・`runs`・`plan:i`・`chunk:i`。`job` の `chunkBytes`(処理を終えた塊ごとのバイト数)は、統計モデル用には Issue #495 で足した。
 * それより前に始まった `job` には無いので、仕上げ(と、処理の途中で残っていたジョブの次の処理)で、kv の塊の長さを読んで数え直す。
 */

import { jstIsoDate, nextJstMidnight } from "../../packages/core/src/common/jst";
import { isReadAllowed, isWriteAllowed, type R2Usage } from "./r2-fence";
import type { CandidateRow } from "./prior-export-format";

/** 1 日(JST)に始められる回数の既定(上限)。上書きは下げる方向にだけ。 */
export const EXPORT_DAILY_LIMIT = 3;
/** 1 tick の問い合わせ数(D1 の文 + R2 の操作)の上限。`VERIFY_TICK_QUERY_LIMIT` と同じ(Free の 50 の手前)。 */
export const EXPORT_TICK_QUERY_LIMIT = 40;
/** 次の tick までの間隔。 */
export const EXPORT_TICK_DELAY_MS = 1_000;
/** 連続して失敗してよい回数。超えたら止まる。 */
export const EXPORT_MAX_ATTEMPTS = 5;
/** 失敗後の再試行までの待ち。n 回目の失敗の後は `[n-1]`(最後の値を繰り返す)。 */
export const EXPORT_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

/** `ctx.storage.kv`(同期 API)のうち、ここで使う部分。 */
export interface ExportKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
}

export type ExportMode = "download" | "refresh" | "status";

export interface DetailRequest {
  readonly id: number;
  readonly raceId: string;
  readonly detailKey: string | null;
}

/** 計画で選ばれた分析(詳細を取るために要る 3 つ)。 */
export interface ChosenBase {
  readonly id: number;
  readonly raceId: string;
  readonly detailKey: string | null;
}

/** 詳細(R2)の取得の結果の分類。`ok` の中身は種別ごと。 */
export interface OutcomeBase {
  readonly kind: "ok" | "none" | "failed";
}

/** D1・R2 の窓口(各書き出しのストアがこれを満たす。テストでは偽物)。 */
export interface ExportStorePort<Batch extends { readonly rowsRead: number }, Outcome extends OutcomeBase> {
  readUsage(): Promise<R2Usage>;
  /** 結果のあるレースの分析をすべて読む(選別は種別ごとの `select`)。 */
  readCandidates(): Promise<{ readonly rows: CandidateRow[]; readonly rowsRead: number }>;
  readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<Batch>;
  /** 詳細(R2)を取る。取得を試みた回数 `gets` を返す。 */
  fetchDetails(items: readonly DetailRequest[]): Promise<{ readonly outcomes: Outcome[]; readonly gets: number }>;
  /** R2 の Class B を `gets` 回ぶん数える(D1 の `r2_ops`)。 */
  countReads(gets: number): Promise<void>;
  /**
   * 完成したファイルを固定キーに流して put する(Class A を数える)。`parts` は先頭から順に 1 つずつ取り出す遅延の列挙で、`totalBytes` は全部の長さの和
   * (`FixedLengthStream` に先に渡す)。流している途中の例外は put の失敗(固定キーは古いファイルのまま)。
   */
  putFileStream(key: string, parts: () => Iterable<Uint8Array>, totalBytes: number, info: { readonly generatedAt: string; readonly rows: number; readonly races: number }): Promise<void>;
}

export interface ExportDeps<Port> {
  readonly kv: ExportKv;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly store: Port;
  readonly onWarn?: (message: string) => void;
}

export interface ExportOptions {
  readonly dailyLimit?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
}

/** 完成したファイルの情報(kv の `file`。状態の応答にも載せる)。`Counter` の数だけ、種別ごとの数のフィールドが付く。 */
export type ExportJobFileInfo<Counter extends string, Excluded> = {
  /** 完成の時刻(ISO)。 */
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
  readonly excluded: Excluded;
  /** ファイルのバイト数(gzip 後)。 */
  readonly bytes: number;
  /** 実測用の診断: D1 が報告した読み取り行数の合計と、R2 の取得を試みた回数(再試行を含む)。 */
  readonly diag: { readonly rowsRead: number; readonly gets: number };
} & { readonly [K in Counter]: number };

export type ExportFailReason = "tick-failed" | "r2-fence";

export type JobPhase = "planning" | "building" | "finalizing";

export type ExportJobResponse<File> =
  | { readonly status: "empty"; readonly file: null }
  | { readonly status: "ready"; readonly file: File }
  | {
      readonly status: "building";
      readonly phase: JobPhase;
      /** 処理を終えたレースの数と、全体(計画の前は null)。 */
      readonly racesDone: number;
      readonly races: number | null;
      readonly startedAt: string;
      /** 前回の完成したファイル(作成中は返さない。取り違えを避けるため情報だけ)。 */
      readonly file: File | null;
    }
  | { readonly status: "failed"; readonly reason: ExportFailReason; readonly file: File | null }
  | { readonly status: "throttled"; readonly nextAt: string; readonly file: File | null }
  | { readonly status: "blocked"; readonly reason: "r2-fence"; readonly file: File | null };

/** 書き出しの種別ごとの差(差し込む口)。 */
export interface ExportKindSpec<Chosen extends ChosenBase, Excluded, Counter extends string, Batch, Outcome> {
  /** R2 の固定キー。 */
  readonly key: string;
  /** 例外を握ったとき `onWarn` に渡す文(例外の本文は入れない)。 */
  readonly warnMessage: string;
  /** ファイルの情報(と `job`)に足す数の名前。`job` の最上位のフィールド名と同じ(本番の kv の形を変えない)。 */
  readonly counterKeys: readonly Counter[];
  /** 1 tick で処理する分析の数の既定。 */
  readonly defaultBatchSize: number;
  /** `job.excluded` が無いまま仕上げに来たときの既定。 */
  readonly emptyExcluded: Excluded;
  /** 母集団を選ぶ。 */
  select(rows: readonly CandidateRow[]): { readonly chosen: Chosen[]; readonly excluded: Excluded };
  /** 1 batch の行を組み立て、gzip の 1 メンバー(塊)にする。`rows` は行の数、`counts` は `counterKeys` ごとの数。 */
  buildChunk(items: readonly Chosen[], data: Batch, outcomes: readonly Outcome[]): { readonly chunk: Uint8Array; readonly rows: number; readonly counts: Record<Counter, number> };
  /** メタ行のメンバー(ファイルの先頭)。 */
  buildHead(meta: { readonly generatedAt: string; readonly rows: number; readonly races: number; readonly counts: Record<Counter, number>; readonly excluded: Excluded }): Uint8Array;
}

interface JobBase<Excluded> {
  state: "running" | "failed";
  phase: JobPhase;
  startedAt: number;
  /** 計画で決めた batch の数(planning の前は 0)と、処理を終えた batch の数。 */
  batches: number;
  done: number;
  races: number;
  rows: number;
  excluded: Excluded | null;
  /** 処理を終えた塊ごとのバイト数(仕上げで総バイト数を先に決めるため)。古いコードが始めたジョブには無い(読み直して数える)。 */
  chunkBytes?: number[];
  rowsRead: number;
  gets: number;
  attempts: number;
  failReason?: ExportFailReason;
}

type Job<Counter extends string, Excluded> = JobBase<Excluded> & { [K in Counter]: number };

interface Runs {
  /** JST の日付(YYYY-MM-DD)。 */
  day: string;
  count: number;
}

const planKey = (i: number): string => `plan:${i}`;
const chunkKey = (i: number): string => `chunk:${i}`;

export class ExportJobCore<
  Chosen extends ChosenBase,
  Excluded,
  Counter extends string,
  Batch extends { readonly rowsRead: number },
  Outcome extends OutcomeBase,
> {
  private readonly dailyLimit: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly spec: ExportKindSpec<Chosen, Excluded, Counter, Batch, Outcome>,
    private readonly deps: ExportDeps<ExportStorePort<Batch, Outcome>>,
    options: ExportOptions = {},
  ) {
    this.dailyLimit = options.dailyLimit ?? EXPORT_DAILY_LIMIT;
    this.batchSize = options.batchSize ?? spec.defaultBatchSize;
    this.maxAttempts = options.maxAttempts ?? EXPORT_MAX_ATTEMPTS;
  }

  // -------------------------------------------------------------------------
  // 要求
  // -------------------------------------------------------------------------

  async request(mode: ExportMode): Promise<ExportJobResponse<ExportJobFileInfo<Counter, Excluded>>> {
    const { kv } = this.deps;
    const file = kv.get<ExportJobFileInfo<Counter, Excluded>>("file") ?? null;
    const job = kv.get<Job<Counter, Excluded>>("job");
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

  private building(job: Job<Counter, Excluded>, file: ExportJobFileInfo<Counter, Excluded> | null): ExportJobResponse<ExportJobFileInfo<Counter, Excluded>> {
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

  private failed(job: Job<Counter, Excluded>, file: ExportJobFileInfo<Counter, Excluded> | null): ExportJobResponse<ExportJobFileInfo<Counter, Excluded>> {
    return { status: "failed", reason: job.failReason ?? "tick-failed", file };
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.deps.getAlarm()) === null) {
      await this.deps.setAlarm(this.deps.now());
    }
  }

  private async start(file: ExportJobFileInfo<Counter, Excluded> | null): Promise<ExportJobResponse<ExportJobFileInfo<Counter, Excluded>>> {
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
    const raced = kv.get<Job<Counter, Excluded>>("job");
    if (raced?.state === "running") {
      return this.building(raced, file);
    }
    if (raced !== undefined) {
      this.cleanup(raced);
    }
    const day = jstIsoDate(t);
    kv.put("runs", { day, count: runs !== undefined && runs.day === day ? runs.count + 1 : 1 } satisfies Runs);
    const base: JobBase<Excluded> = {
      state: "running", phase: "planning", startedAt: t, batches: 0, done: 0, races: 0, rows: 0,
      excluded: null, chunkBytes: [], rowsRead: 0, gets: 0, attempts: 0,
    };
    const job: Job<Counter, Excluded> = { ...base, ...this.zeroCounts() };
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
    const job = kv.get<Job<Counter, Excluded>>("job");
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
      this.deps.onWarn?.(this.spec.warnMessage);
      await this.recordFailure(job);
    }
  }

  private async plan(job: Job<Counter, Excluded>): Promise<void> {
    const { kv, now, store, setAlarm } = this.deps;
    const { rows, rowsRead } = await store.readCandidates();
    const { chosen, excluded } = this.spec.select(rows);
    const batches = Math.ceil(chosen.length / this.batchSize);
    for (let i = 0; i < batches; i += 1) {
      kv.put(planKey(i), chosen.slice(i * this.batchSize, (i + 1) * this.batchSize));
    }
    this.save({ ...job, phase: batches === 0 ? "finalizing" : "building", batches, done: 0, races: chosen.length, excluded, rowsRead: job.rowsRead + rowsRead, attempts: 0 });
    await setAlarm(now() + EXPORT_TICK_DELAY_MS);
  }

  private async processBatch(job: Job<Counter, Excluded>): Promise<void> {
    const { kv, now, store, setAlarm } = this.deps;
    const usage = await store.readUsage();
    if (!isReadAllowed(usage)) {
      this.fail(job, "r2-fence");
      return;
    }
    const items = kv.get<Chosen[]>(planKey(job.done));
    if (items === undefined) {
      throw new Error("計画が失われています");
    }
    // 済んだ塊の長さの記録。古いコードが始めたジョブ(記録が無い・数が合わない)は、kv の塊から数え直す(添字をずらさないため)。
    const doneBytes = this.recordedChunkBytes(job, job.done);
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

    const built = this.spec.buildChunk(items, data, details.outcomes);
    kv.put(chunkKey(job.done), built.chunk);
    const done = job.done + 1;
    const next: Job<Counter, Excluded> = {
      ...job, done, phase: done >= job.batches ? "finalizing" : "building", rows: job.rows + built.rows, chunkBytes: [...doneBytes, built.chunk.length], gets, rowsRead, attempts: 0,
    };
    const counts = built.counts as Record<string, number>;
    for (const k of this.spec.counterKeys) {
      (next as Record<string, unknown>)[k] = (job as Record<string, number>)[k]! + counts[k]!;
    }
    this.save(next);
    await setAlarm(now() + EXPORT_TICK_DELAY_MS);
  }

  private async finalize(job: Job<Counter, Excluded>): Promise<void> {
    const { kv, now, store } = this.deps;
    const usage = await store.readUsage();
    if (!isWriteAllowed(usage)) {
      this.fail(job, "r2-fence");
      return;
    }
    const lengths = this.recordedChunkBytes(job, job.batches);
    const generatedAt = new Date(now()).toISOString();
    const excluded = job.excluded ?? this.spec.emptyExcluded;
    const counts = this.countsOf(job);
    const head = this.spec.buildHead({ generatedAt, rows: job.rows, races: job.races, counts, excluded });
    const totalBytes = lengths.reduce((n, b) => n + b, head.length);
    // 塊は 1 つずつ kv から読んで流す(全体を連結しない)。失われている・長さが記録と違う塊は例外(流している途中の例外は put の失敗)。
    const parts = function* (): Generator<Uint8Array> {
      yield head;
      for (let i = 0; i < job.batches; i += 1) {
        const chunk = kv.get<Uint8Array>(chunkKey(i));
        if (chunk === undefined) {
          throw new Error("処理済みの塊が失われています");
        }
        if (chunk.length !== lengths[i]) {
          throw new Error("処理済みの塊の長さが記録と違います");
        }
        yield chunk;
      }
    };
    await store.putFileStream(this.spec.key, parts, totalBytes, { generatedAt, rows: job.rows, races: job.races });
    kv.put("file", {
      generatedAt, rows: job.rows, races: job.races, ...counts, excluded, bytes: totalBytes, diag: { rowsRead: job.rowsRead, gets: job.gets },
    });
    this.cleanup(job);
    kv.delete("job");
  }

  /**
   * 先頭 `count` 個の塊のバイト数。`job.chunkBytes` が `count` 個そろっていればそれを使う。
   * 無い・数が合わないとき(古いコードが始めたジョブ)は、kv の塊を 1 つずつ読んで長さを数える(塊が無ければ例外)。
   */
  private recordedChunkBytes(job: Job<Counter, Excluded>, count: number): number[] {
    if (Array.isArray(job.chunkBytes) && job.chunkBytes.length === count) {
      return job.chunkBytes;
    }
    const lengths: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const chunk = this.deps.kv.get<Uint8Array>(chunkKey(i));
      if (chunk === undefined) {
        throw new Error("処理済みの塊が失われています");
      }
      lengths.push(chunk.length);
    }
    return lengths;
  }

  private zeroCounts(): { [K in Counter]: number } {
    return Object.fromEntries(this.spec.counterKeys.map((k) => [k, 0])) as { [K in Counter]: number };
  }

  private countsOf(job: Job<Counter, Excluded>): Record<Counter, number> {
    return Object.fromEntries(this.spec.counterKeys.map((k) => [k, (job as Record<string, number>)[k]!])) as Record<Counter, number>;
  }

  private save(job: Job<Counter, Excluded>): void {
    this.deps.kv.put("job", job);
  }

  private fail(job: Job<Counter, Excluded>, reason: ExportFailReason): void {
    this.cleanup(job);
    this.save({ ...job, state: "failed", failReason: reason });
  }

  private async recordFailure(job: Job<Counter, Excluded>): Promise<void> {
    const attempts = job.attempts + 1;
    if (attempts >= this.maxAttempts) {
      this.fail({ ...job, attempts }, "tick-failed");
      return;
    }
    this.save({ ...job, attempts });
    await this.deps.setAlarm(this.deps.now() + EXPORT_BACKOFF_MS[Math.min(attempts - 1, EXPORT_BACKOFF_MS.length - 1)]!);
  }

  /** 計画と処理済みの塊を消す。 */
  private cleanup(job: Job<Counter, Excluded>): void {
    for (let i = 0; i < job.batches; i += 1) {
      this.deps.kv.delete(planKey(i));
      this.deps.kv.delete(chunkKey(i));
    }
  }
}

/** キーごとに束ねる(入力の順を保つ)。 */
export function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = map.get(key);
    if (group === undefined) map.set(key, [item]);
    else group.push(item);
  }
  return map;
}
