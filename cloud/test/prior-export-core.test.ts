import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import {
  PriorExportCore,
  PRIOR_EXPORT_BATCH_SIZE,
  PRIOR_EXPORT_DAILY_LIMIT,
  PRIOR_EXPORT_MAX_ATTEMPTS,
  PRIOR_EXPORT_TICK_OVERHEAD_QUERIES,
  PRIOR_EXPORT_TICK_QUERY_LIMIT,
  type DetailOutcome,
  type PriorExportStorePort,
  type RaceDataBatch,
} from "../src/prior-export-core";
import { PRIOR_EXPORT_KEY, type CandidateRow, type PriorDatasetRow } from "../src/prior-export-format";

/**
 * Issue #266: 書き出しのジョブ(`PriorExportCore`)。D1・R2・時計・アラームは偽物(`cloudflare:workers` なしで Node で動く)。
 * 流れ: 要求(download / refresh / status)→ アラームの tick(計画 → 処理を batch ごと → 仕上げ)。柵は 1 日(JST)3 回・R2 の柵・二重に始めない。
 */

const T0 = Date.parse("2026-10-10T03:00:00.000Z"); // JST 12:00
const BEFORE_START = "2026-10-10T00:00:00.000Z";

function cand(id: number, raceId: string, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id, raceId, analyzedAt: BEFORE_START, kaisaiDate: "20261010", promptVersion: "v9", detailKey: `analyses/${id}.json.gz`,
    evEstimated: 0, promptLookaheadGuarded: 1, historyCutoffDate: "20261009", startTime: "10:05", ...over,
  };
}

const raceIdOf = (n: number): string => `20260603${String(n).padStart(2, "0")}01`;

class FakeStore implements PriorExportStorePort {
  candidates: CandidateRow[] = [];
  usage = { classA: 0, classB: 0 };
  /** 詳細が無いレース(分析 id)。 */
  noDetail = new Set<number>();
  /** 次の fetchDetails を失敗させる回数。 */
  failFetch = 0;
  failCandidates = 0;
  readonly calls: string[] = [];
  readonly fetchSizes: number[] = [];
  readonly puts: Array<{ key: string; bytes: Uint8Array; info: { generatedAt: string; rows: number; races: number } }> = [];
  readCounted = 0;
  horsesPerRace = 3;

  async readUsage() {
    this.calls.push("usage");
    return this.usage;
  }
  async readCandidates() {
    this.calls.push("candidates");
    if (this.failCandidates > 0) {
      this.failCandidates -= 1;
      throw new Error("D1 SECRET-CAND");
    }
    return { rows: this.candidates, rowsRead: this.candidates.length * 2 };
  }
  async readRaceData(analysisIds: number[], raceIds: string[]): Promise<RaceDataBatch> {
    this.calls.push("raceData");
    const horses = analysisIds.flatMap((analysisId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({ analysisId, umaban: k + 1, prior: 0.3 - k * 0.05, adjustedProb: 0.3, placeOddsMin: 2 })),
    );
    const results = raceIds.flatMap((raceId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({ raceId, umaban: k + 1, finishPosition: k + 1, winOdds: 3 + k, ninki: k + 1 })),
    );
    return { horses, results, courseTypes: raceIds.map((raceId) => ({ raceId, courseType: "芝" })), rowsRead: horses.length + results.length + raceIds.length };
  }
  async fetchDetails(items: ReadonlyArray<{ id: number; raceId: string; detailKey: string | null }>): Promise<{ outcomes: DetailOutcome[]; gets: number }> {
    this.calls.push("details");
    this.fetchSizes.push(items.length);
    if (this.failFetch > 0) {
      this.failFetch -= 1;
      return { outcomes: items.map(() => ({ kind: "failed" as const })), gets: items.length };
    }
    return {
      outcomes: items.map((it) =>
        this.noDetail.has(it.id)
          ? { kind: "none" as const }
          : { kind: "ok" as const, contributions: Object.fromEntries(Array.from({ length: this.horsesPerRace }, (_, k) => [String(k + 1), [{ biasName: "a", applied: true, reason: "SECRET-REASON", weight: 0.1, correction: 0.01 * (k + 1) }]])) },
      ),
      gets: items.length,
    };
  }
  async countReads(gets: number) {
    this.calls.push("count");
    this.readCounted += gets;
  }
  async putFile(key: string, bytes: Uint8Array, info: { generatedAt: string; rows: number; races: number }) {
    this.calls.push("put");
    this.puts.push({ key, bytes, info });
  }
}

class FakeKv {
  readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  put(key: string, value: unknown): void {
    this.map.set(key, structuredClone(value));
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
}

interface World {
  readonly kv: FakeKv;
  readonly store: FakeStore;
  readonly clock: { now: number };
  readonly alarms: number[];
  core(options?: ConstructorParameters<typeof PriorExportCore>[1]): PriorExportCore;
  /** アラームが張られている限り tick を回す(上限つき)。回した tick の数を返す。 */
  drain(core: PriorExportCore, max?: number): Promise<number>;
}

function world(races = 5): World {
  const kv = new FakeKv();
  const store = new FakeStore();
  store.candidates = Array.from({ length: races }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
  const clock = { now: T0 };
  const alarms: number[] = [];
  const w: World = {
    kv, store, clock, alarms,
    core: (options) =>
      new PriorExportCore(
        { kv, now: () => clock.now, setAlarm: (at) => { alarms.push(at); }, getAlarm: async () => (alarms.length === 0 ? null : alarms[alarms.length - 1]!), store, onWarn: () => {} },
        options,
      ),
    drain: async (core, max = 200) => {
      let ticks = 0;
      while (alarms.length > 0 && ticks < max) {
        clock.now = Math.max(clock.now, alarms.pop()!);
        alarms.length = 0;
        await core.runTick();
        ticks += 1;
      }
      return ticks;
    },
  };
  return w;
}

function readFile(bytes: Uint8Array): { meta: Record<string, unknown>; rows: PriorDatasetRow[] } {
  const lines = new TextDecoder().decode(gunzipSync(bytes)).split("\n").filter((l) => l !== "");
  return { meta: (JSON.parse(lines[0]!) as { _meta: Record<string, unknown> })._meta, rows: lines.slice(1).map((l) => JSON.parse(l) as PriorDatasetRow) };
}

describe("定数: 1 回の tick の問い合わせ数は Free の手前に収まる", () => {
  it(`処理の batch(${PRIOR_EXPORT_BATCH_SIZE} 件の R2 GET)+ 固定の問い合わせ(${PRIOR_EXPORT_TICK_OVERHEAD_QUERIES})が上限(${PRIOR_EXPORT_TICK_QUERY_LIMIT}。Free の 1 呼び出し 50 の手前)以内`, () => {
    expect(PRIOR_EXPORT_BATCH_SIZE + PRIOR_EXPORT_TICK_OVERHEAD_QUERIES).toBeLessThanOrEqual(PRIOR_EXPORT_TICK_QUERY_LIMIT);
    expect(PRIOR_EXPORT_DAILY_LIMIT).toBe(3);
  });
});

describe("要求と状態", () => {
  it("何も無いとき status は empty(副作用なし: アラームも作成の回数も使わない)。download は作成を始めて building を返す", async () => {
    const w = world();
    const core = w.core();
    expect(await core.request("status")).toEqual({ status: "empty", file: null });
    expect(w.alarms).toEqual([]);
    expect(w.kv.get("runs")).toBeUndefined();

    const res = await core.request("download");
    expect(res).toMatchObject({ status: "building", phase: "planning", file: null });
    expect(w.alarms).toEqual([T0]);
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
  });

  it("最後まで回すと ready。ファイルはメタ行 + 全馬の行(race 昇順・馬番昇順)で、R2 の固定キーに 1 回だけ put される", async () => {
    const w = world(5);
    const core = w.core({ batchSize: 2 });
    await core.request("download");
    const ticks = await w.drain(core);
    expect(ticks).toBe(1 + 3 + 1); // 計画 1 + 処理 3(5 レース / 2 件) + 仕上げ 1
    const res = await core.request("download");
    expect(res).toMatchObject({ status: "ready", file: { rows: 15, races: 5, missingDetail: 0 } });
    expect(w.store.puts).toHaveLength(1);
    expect(w.store.puts[0]!.key).toBe(PRIOR_EXPORT_KEY);
    const { meta, rows } = readFile(w.store.puts[0]!.bytes);
    expect(meta).toMatchObject({ format: 1, rows: 15, races: 5, missingDetail: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 } });
    expect(rows).toHaveLength(15);
    expect(rows.map((r) => r.race_id)).toEqual(Array.from({ length: 15 }, (_, i) => raceIdOf(Math.floor(i / 3) + 1)));
    expect(rows.slice(0, 3).map((r) => r.umaban)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ prior: 0.3, finish_position: 1, win_odds: 3, ninki: 1, course_type: "芝", field_size: 3, leak_class: "guarded" });
    expect(rows[0]!.contributions).toEqual([{ biasName: "a", applied: true, weight: 0.1, correction: 0.01, sampleCount: null, targetRate: null, overallRate: null }]);
    // 自由文(reason)はファイルのどこにも出ない
    expect(new TextDecoder().decode(gunzipSync(w.store.puts[0]!.bytes))).not.toContain("SECRET-REASON");
    // 仕上げのあとは中間データを残さない
    expect([...w.kv.map.keys()].filter((k) => k.startsWith("plan:") || k.startsWith("chunk:"))).toEqual([]);
    expect(w.kv.get("job")).toBeUndefined();
  });

  it("1 tick で扱う R2 GET は batch の件数以内(既定は定数 PRIOR_EXPORT_BATCH_SIZE)。件数が多いレース数でも超えない", async () => {
    const w = world(PRIOR_EXPORT_BATCH_SIZE * 2 + 1);
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    expect(w.store.fetchSizes).toEqual([PRIOR_EXPORT_BATCH_SIZE, PRIOR_EXPORT_BATCH_SIZE, 1]);
    // R2 の Class B は取得を試みた回数をそのまま数える
    expect(w.store.readCounted).toBe(PRIOR_EXPORT_BATCH_SIZE * 2 + 1);
  });

  it("除外の内訳(unchecked など)はメタ行と状態の両方に出る。候補が 0 件でもメタ行だけのファイルができる", async () => {
    const w = world(0);
    w.store.candidates = [cand(1, raceIdOf(1), { historyCutoffDate: null, startTime: null }), cand(2, raceIdOf(2), { historyCutoffDate: null, startTime: "10:05", analyzedAt: "2026-10-10T03:00:00.000Z" })];
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    const res = await core.request("status");
    expect(res).toMatchObject({ status: "ready", file: { rows: 0, races: 0, excluded: { unchecked: 1, suspect: 1, unknown: 0, superseded: 0 } } });
    const { meta, rows } = readFile(w.store.puts[0]!.bytes);
    expect(rows).toEqual([]);
    expect(meta).toMatchObject({ excluded: { unchecked: 1, suspect: 1 } });
  });

  it("詳細(R2)が無いレースも行は出し(contributions は null)、missingDetail に数える", async () => {
    const w = world(3);
    w.store.noDetail = new Set([101]);
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    const { meta, rows } = readFile(w.store.puts[0]!.bytes);
    expect(meta["missingDetail"]).toBe(1);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.contributions === null).map((r) => r.race_id)).toEqual(Array(3).fill(raceIdOf(2)));
  });
});

describe("Issue #266 の取り決め: 作成中の扱い", () => {
  async function readyWorld() {
    const w = world(3);
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    return { w, core };
  }

  it("(a) 作成中は、通常の download も古いファイルを返さず building(進捗つき)を返す。完成すると新しいファイルを返す", async () => {
    const { w, core } = await readyWorld();
    expect((await core.request("download")).status).toBe("ready");
    const oldFile = (await core.request("status")) as { file: { generatedAt: string } };

    w.clock.now += 3_600_000;
    expect((await core.request("refresh")).status).toBe("building");
    const during = await core.request("download");
    expect(during.status).toBe("building");
    expect(during).toMatchObject({ file: { generatedAt: oldFile.file.generatedAt } }); // 古いファイルは「前回の情報」としてだけ載る
    expect(typeof (during as { racesDone: unknown }).racesDone).toBe("number");

    await w.drain(core);
    const after = (await core.request("download")) as { status: string; file: { generatedAt: string } };
    expect(after.status).toBe("ready");
    expect(after.file.generatedAt).not.toBe(oldFile.file.generatedAt);
  });

  it("(b) 作成中の refresh は二重に始めず building を返し、1 日の回数も消費しない(ジョブも作り直さない)", async () => {
    const w = world(3);
    const core = w.core();
    await core.request("download");
    const job = w.kv.get("job");
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
    for (let i = 0; i < 5; i += 1) {
      expect((await core.request("refresh")).status).toBe("building");
    }
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
    expect(w.kv.get("job")).toEqual(job);
  });

  it("作成中の status は副作用なし(アラームも回数も変えない)。進捗は処理したレース数", async () => {
    const w = world(5);
    const core = w.core({ batchSize: 2 });
    await core.request("download");
    await w.drain(core, 2); // 計画 + 処理 1 batch
    w.alarms.length = 0; // アラームが無い状況でも、status は張らない(副作用なし。張るのは download・refresh の自己回復)
    const res = await core.request("status");
    expect(res).toMatchObject({ status: "building", phase: "building", racesDone: 2, races: 5 });
    expect(w.alarms).toEqual([]);
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
  });

  it("同時の 2 つの要求(await の間に割り込む)でも、始めるのは 1 回だけで、回数も 1 しか消費しない", async () => {
    const w = world(2);
    const core = w.core();
    const [a, b] = await Promise.all([core.request("download"), core.request("refresh")]);
    expect([a.status, b.status]).toEqual(["building", "building"]);
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
    expect(w.alarms).toHaveLength(1); // 2 つ目が始め直していれば、アラームが 2 回張られる
  });

  it("作成中なのにアラームが無ければ張り直す(自己回復)。DO が作り直された(同じ kv の新しいインスタンス)後も続きから進む", async () => {
    const w = world(5);
    const first = w.core({ batchSize: 2 });
    await first.request("download");
    await w.drain(first, 2);
    w.alarms.length = 0; // アラームを失った状況
    const second = w.core({ batchSize: 2 }); // 新しいインスタンス(状態は kv だけ)
    expect((await second.request("download")).status).toBe("building");
    expect(w.alarms).toHaveLength(1);
    await w.drain(second);
    expect((await second.request("status")).status).toBe("ready");
    expect(readFile(w.store.puts[0]!.bytes).rows).toHaveLength(15);
    expect(w.store.puts).toHaveLength(1);
  });
});

describe("柵", () => {
  it("1 日(JST)3 回まで: 4 回目の refresh は throttled(次の JST 0 時)で、ファイル・ジョブは変わらず、翌日は始められる", async () => {
    const w = world(2);
    const core = w.core();
    for (let i = 0; i < PRIOR_EXPORT_DAILY_LIMIT; i += 1) {
      expect((await core.request("refresh")).status).toBe("building");
      await w.drain(core);
      w.clock.now += 60_000;
    }
    const putsBefore = w.store.puts.length;
    const blocked = await core.request("refresh");
    expect(blocked).toMatchObject({ status: "throttled", nextAt: "2026-10-10T15:00:00.000Z" });
    expect(blocked).toHaveProperty("file.rows", 6);
    expect(w.alarms).toEqual([]);
    // 通常の download は完成済みのファイルを返す(新たに始めない)
    expect((await core.request("download")).status).toBe("ready");
    expect(w.store.puts).toHaveLength(putsBefore);
    // 翌日(JST)
    w.clock.now = Date.parse("2026-10-10T15:00:01.000Z");
    expect((await core.request("refresh")).status).toBe("building");
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-11", count: 1 });
  });

  it("上限は下げる方向にだけ上書きできる(options.dailyLimit)", async () => {
    const w = world(1);
    const core = w.core({ dailyLimit: 1 });
    await core.request("refresh");
    await w.drain(core);
    expect((await core.request("refresh")).status).toBe("throttled");
  });

  it("R2 の読み出しの柵に達していたら始めない(blocked。回数も消費しない)", async () => {
    const w = world(1);
    w.store.usage = { classA: 0, classB: R2_FENCE_LIMITS.classB };
    const core = w.core();
    expect(await core.request("download")).toMatchObject({ status: "blocked", reason: "r2-fence" });
    expect(w.kv.get("runs")).toBeUndefined();
    expect(w.alarms).toEqual([]);
  });

  it("仕上げの時点で R2 の書き込みの柵に達していたら put せず failed(r2-fence)", async () => {
    const w = world(1);
    const core = w.core();
    await core.request("download");
    await w.drain(core, 2); // 計画 + 処理
    w.store.usage = { classA: R2_FENCE_LIMITS.classA, classB: 0 };
    await w.drain(core);
    expect(await core.request("status")).toMatchObject({ status: "failed", reason: "r2-fence" });
    expect(w.store.puts).toEqual([]);
  });
});

describe("失敗", () => {
  it("R2 の取得が失敗した batch は退避のあとに再試行し、成功すれば続きから完成する(失敗した取得も Class B に数える)", async () => {
    const w = world(3);
    w.store.failFetch = 2;
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    expect((await core.request("status")).status).toBe("ready");
    expect(readFile(w.store.puts[0]!.bytes).rows).toHaveLength(9);
    expect(w.store.readCounted).toBe(9); // 失敗 2 回(3 件ずつ)+ 成功 1 回(3 件)
  });

  it("失敗が続いて上限回数に達したら failed(固定の理由だけ。例外の文面は状態に入れない)。通常の download は再開せず failed を返し、refresh で再開できる", async () => {
    const w = world(2);
    w.store.failCandidates = PRIOR_EXPORT_MAX_ATTEMPTS;
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    const failed = await core.request("download");
    expect(failed).toMatchObject({ status: "failed", reason: "tick-failed" });
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
    expect((await core.request("download")).status).toBe("failed"); // 勝手に始め直さない
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });

    expect((await core.request("refresh")).status).toBe("building");
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 2 });
    await w.drain(core);
    expect((await core.request("status")).status).toBe("ready");
  });
});
