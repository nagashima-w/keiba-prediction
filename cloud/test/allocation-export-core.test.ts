import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import {
  AllocationExportCore,
  ALLOCATION_EXPORT_BATCH_SIZE,
  ALLOCATION_EXPORT_DAILY_LIMIT,
  ALLOCATION_EXPORT_MAX_ATTEMPTS,
  ALLOCATION_EXPORT_TICK_OVERHEAD_QUERIES,
  ALLOCATION_EXPORT_TICK_QUERY_LIMIT,
  type AllocationDetailOutcome,
  type AllocationExportStorePort,
  type AllocationRaceDataBatch,
} from "../src/allocation-export-core";
import { ALLOCATION_EXPORT_KEY, toAllocationSnapshot, type AllocationRaceRow } from "../src/allocation-export-format";
import type { CandidateRow } from "../src/prior-export-format";

/**
 * Issue #463: 書き出しのジョブ(`AllocationExportCore`)。D1・R2・時計・アラームは偽物(`cloudflare:workers` なしで Node で動く)。
 * 流れ: 要求(download / refresh / status)→ アラームの tick(計画 → 処理を batch ごと → 仕上げ)。柵は 1 日(JST)3 回・R2 の柵・二重に始めない。
 * 仕上げは塊を 1 つずつ流す(全体を 1 つのバッファに連結しない)。
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

interface PutRecord {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
  readonly info: { generatedAt: string; rows: number; races: number };
}

class FakeStore implements AllocationExportStorePort {
  candidates: CandidateRow[] = [];
  usage = { classA: 0, classB: 0 };
  noDetail = new Set<number>();
  noMeta = new Set<number>();
  failFetch = 0;
  failCandidates = 0;
  readonly calls: string[] = [];
  readonly fetchSizes: number[] = [];
  readonly raceDataSizes: number[] = [];
  readonly puts: PutRecord[] = [];
  /** put の途中で一度に保持した塊の最大数(全体を連結せず 1 つずつ流していることの検査)。 */
  maxPartsHeld = 0;
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
  async readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<AllocationRaceDataBatch> {
    this.calls.push("raceData");
    this.raceDataSizes.push(analysisIds.length);
    const horses = analysisIds.flatMap((analysisId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({ analysisId, umaban: k + 1, prior: 0.3 - k * 0.05, adjustedProb: 0.3, placeOddsMin: 2, ev: 1.1 })),
    );
    const results = raceIds.flatMap((raceId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({
        raceId, umaban: k + 1, finishPosition: k + 1, placePayout: 120, winPayout: 300, scratched: 0, wakuban: k + 1, winOdds: 3 + k, ninki: k + 1,
      })),
    );
    const metas = analysisIds
      .filter((id) => !this.noMeta.has(id))
      .map((analysisId) => ({
        analysisId, route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: "present", comboOddsTrio: "present",
        bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: 1, includeWide: 1, includeTrio: 1, includeQuinella: 1,
        includeExacta: 1, includeTrifecta: 1, includeBracketQuinella: 1, betUnit: 100, greedySteps: 1000, candidateCap: 2000, modelId: "plackett-luce",
        modelApproximate: 0, oddsStatus: "result", minHitProb: 0, belowFloorCount: null, missedJson: null, maxWinBets: 0, maxPlaceBets: 0,
      }));
    // 買い目・払戻は分析(レース)ごとに値を変える(取り違えを検出できるように)
    const bets = metas.map((m) => ({ analysisId: m.analysisId, betType: "place", comboKey: "01", stake: 100 + m.analysisId, odds: 2, ev: 1.1 }));
    const payouts = raceIds.map((raceId) => ({ raceId, betType: "wide", comboKey: "0102", payout: 400 + Number(raceId.slice(8, 10)) }));
    const imports = raceIds.map((raceId) => ({ raceId, betType: "wide" }));
    return { horses, results, metas, bets, payouts, imports, rowsRead: horses.length + results.length + metas.length + bets.length + payouts.length + imports.length };
  }
  async fetchDetails(items: ReadonlyArray<{ id: number; raceId: string; detailKey: string | null }>): Promise<{ outcomes: AllocationDetailOutcome[]; gets: number }> {
    this.calls.push("details");
    this.fetchSizes.push(items.length);
    if (this.failFetch > 0) {
      this.failFetch -= 1;
      return { outcomes: items.map(() => ({ kind: "failed" as const })), gets: items.length };
    }
    return {
      outcomes: items.map((it) => (this.noDetail.has(it.id) ? { kind: "none" as const } : { kind: "ok" as const, snapshot: toAllocationSnapshot(this.rawSnapshot()) })),
      gets: items.length,
    };
  }
  rawSnapshot(): unknown {
    return {
      race: { raceName: "SECRET-RACENAME", courseType: "芝", distance: 1600, grade: "G3" },
      horses: Array.from({ length: this.horsesPerRace }, (_, k) => ({
        umaban: k + 1, wakuban: k + 1, name: "SECRET-NAME", jockeyName: "SECRET-JOCKEY", trainerName: "SECRET-TRAINER", winOdds: 3.5 + k, popularity: k + 1, placeOddsMin: 1.5, placeOddsMax: 2.5,
      })),
      wideCombo: { "0102": 8.5, "0103": null },
    };
  }
  async countReads(gets: number) {
    this.calls.push("count");
    this.readCounted += gets;
  }
  async putFileStream(key: string, parts: () => Iterable<Uint8Array>, totalBytes: number, info: { generatedAt: string; rows: number; races: number }) {
    this.calls.push("put");
    const chunks: Uint8Array[] = [];
    let held = 0;
    for (const p of parts()) {
      chunks.push(p);
      held += 1;
    }
    this.maxPartsHeld = Math.max(this.maxPartsHeld, held);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    this.puts.push({ key, bytes, totalBytes, info });
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
  core(options?: ConstructorParameters<typeof AllocationExportCore>[1]): AllocationExportCore;
  drain(core: AllocationExportCore, max?: number): Promise<number>;
}

function world(races = 5): World {
  const kv = new FakeKv();
  const store = new FakeStore();
  store.candidates = Array.from({ length: races }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
  const clock = { now: T0 };
  const alarms: number[] = [];
  return {
    kv, store, clock, alarms,
    core: (options) =>
      new AllocationExportCore(
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
}

function readFile(bytes: Uint8Array): { meta: Record<string, unknown>; rows: AllocationRaceRow[] } {
  const lines = new TextDecoder().decode(gunzipSync(bytes)).split("\n").filter((l) => l !== "");
  return { meta: (JSON.parse(lines[0]!) as { _meta: Record<string, unknown> })._meta, rows: lines.slice(1).map((l) => JSON.parse(l) as AllocationRaceRow) };
}

describe("定数: 1 回の tick の問い合わせ数は Free の手前に収まる", () => {
  it(`処理の batch(${ALLOCATION_EXPORT_BATCH_SIZE} 件の R2 GET)+ 固定の問い合わせ(${ALLOCATION_EXPORT_TICK_OVERHEAD_QUERIES})が上限(${ALLOCATION_EXPORT_TICK_QUERY_LIMIT}。Free の 1 呼び出し 50 の手前)以内`, () => {
    expect(ALLOCATION_EXPORT_BATCH_SIZE + ALLOCATION_EXPORT_TICK_OVERHEAD_QUERIES).toBeLessThanOrEqual(ALLOCATION_EXPORT_TICK_QUERY_LIMIT);
    expect(ALLOCATION_EXPORT_DAILY_LIMIT).toBe(3);
  });

  it("1 tick の batch は 10 件(1 つの塊の大きさの上界〈format のテスト〉を 1 MiB 未満に保つ前提。増やすときは塊の上界のテストも見直す)", () => {
    expect(ALLOCATION_EXPORT_BATCH_SIZE).toBe(10);
  });
});

describe("要求と状態", () => {
  it("何も無いとき status は empty(副作用なし)。download は作成を始めて building を返す", async () => {
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

  it("最後まで回すと ready。ファイルはメタ行 + 1 レース 1 行(race 昇順)で、R2 の固定キーに 1 回だけ流して put される。塊は 1 つずつ流れる", async () => {
    const w = world(5);
    const core = w.core({ batchSize: 2 });
    await core.request("download");
    const ticks = await w.drain(core);
    expect(ticks).toBe(1 + 3 + 1); // 計画 1 + 処理 3(5 レース / 2 件) + 仕上げ 1
    const res = await core.request("download");
    expect(res).toMatchObject({ status: "ready", file: { rows: 5, races: 5, missingOdds: 0, noAllocation: 0 } });
    expect(w.store.puts).toHaveLength(1);
    const put = w.store.puts[0]!;
    expect(put.key).toBe(ALLOCATION_EXPORT_KEY);
    // 総バイト数(FixedLengthStream に渡す長さ)が、実際に流したバイト数と一致する。状態の bytes も同じ
    expect(put.totalBytes).toBe(put.bytes.length);
    expect(res).toMatchObject({ file: { bytes: put.bytes.length } });
    // メタ行 + 塊 3 つ = 4 つのメンバーを、まとめて持たずに 1 つずつ渡した(ここでは偽のストアが列挙するだけ。生成器が遅延評価であることは別のテストで見る)
    expect(put.info).toMatchObject({ rows: 5, races: 5 });
    const { meta, rows } = readFile(put.bytes);
    expect(meta).toMatchObject({ format: 1, rows: 5, races: 5, missingOdds: 0, noAllocation: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, uncheckedRaces: 0, superseded: 0, estimated: 0 } });
    expect(rows.map((r) => r.race_id)).toEqual(Array.from({ length: 5 }, (_, i) => raceIdOf(i + 1)));
    expect(rows[0]).toMatchObject({ analysis_id: 100, field_size: 3, has_odds: true, course_type: "芝", leak_class: "guarded" });
    expect(rows[0]!.horses.map((h) => [h.umaban, h.win_odds, h.wakuban])).toEqual([[1, 3.5, 1], [2, 4.5, 2], [3, 5.5, 3]]);
    expect(rows[0]!.allocation!.bets).toEqual([{ bet_type: "place", combo_key: "01", stake: 200, odds: 2, ev: 1.1 }]);
    expect(rows[0]!.combos).toEqual({ wide: { "0102": 8.5, "0103": null } });
    expect(rows[0]!.result.combo_payouts).toEqual({ wide: [["0102", 401]] });
    // 分析 id・レースごとに自分の買い目・払戻が付く(取り違えない。偽のストアは分析 id・レース番号で値を変えている)
    expect(rows.map((r) => r.analysis_id)).toEqual([100, 101, 102, 103, 104]);
    expect(rows.map((r) => r.allocation!.bets[0]!.stake)).toEqual([200, 201, 202, 203, 204]);
    expect(rows.map((r) => r.result.combo_payouts["wide"]![0]![1])).toEqual([401, 402, 403, 404, 405]);
    // 名前・自由文はファイルのどこにも出ない
    const text = new TextDecoder().decode(gunzipSync(put.bytes));
    for (const secret of ["SECRET-NAME", "SECRET-JOCKEY", "SECRET-TRAINER", "SECRET-RACENAME"]) {
      expect(text, `ファイルに ${secret} が無い`).not.toContain(secret);
    }
    // 仕上げのあとは中間データを残さない
    expect([...w.kv.map.keys()].filter((k) => k.startsWith("plan:") || k.startsWith("chunk:"))).toEqual([]);
    expect(w.kv.get("job")).toBeUndefined();
  });

  it("仕上げは塊を 1 つずつ読む(生成器。ストアが次を要求するまで kv から読まない)", async () => {
    const w = world(5);
    const core = w.core({ batchSize: 2 });
    await core.request("download");
    await w.drain(core, 1 + 3); // 計画 + 処理 3(仕上げの前まで)
    const reads: string[] = [];
    const original = w.kv.get.bind(w.kv);
    w.kv.get = ((key: string) => {
      if (key.startsWith("chunk:")) reads.push(key);
      return original(key);
    }) as typeof w.kv.get;
    let observed: string[] | null = null;
    w.store.putFileStream = async (_key, parts, total) => {
      const iterator = parts()[Symbol.iterator]();
      iterator.next(); // メタ行
      observed = [...reads]; // 先頭を取っただけでは塊は読まれていない
      for (let r = iterator.next(); r.done !== true; r = iterator.next());
      expect(total).toBeGreaterThan(0);
    };
    await w.drain(core);
    expect(observed).toEqual([]);
    expect(reads).toEqual(["chunk:0", "chunk:1", "chunk:2"]);
  });

  it("1 tick で扱う R2 GET と D1 の分析数は batch の件数以内(既定は定数)。件数が多いレース数でも超えない", async () => {
    const w = world(ALLOCATION_EXPORT_BATCH_SIZE * 2 + 1);
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    expect(w.store.fetchSizes).toEqual([ALLOCATION_EXPORT_BATCH_SIZE, ALLOCATION_EXPORT_BATCH_SIZE, 1]);
    expect(w.store.raceDataSizes).toEqual([ALLOCATION_EXPORT_BATCH_SIZE, ALLOCATION_EXPORT_BATCH_SIZE, 1]);
    expect(w.store.readCounted).toBe(ALLOCATION_EXPORT_BATCH_SIZE * 2 + 1);
  });

  it("1 tick の D1 の呼び出し(使用量・レースの読み・Class B の加算)の数と順序: 処理の tick は usage → raceData → details → count", async () => {
    const w = world(3);
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    expect(w.store.calls).toEqual(["usage", "candidates", "usage", "raceData", "details", "count", "usage", "put"]); // 先頭の usage は始めるときの柵の確認
  });

  it("除外の内訳(推定 EV・unchecked など)はメタ行と状態の両方に出る。候補が 0 件でもメタ行だけのファイルができる", async () => {
    const w = world(0);
    w.store.candidates = [
      cand(1, raceIdOf(1), { historyCutoffDate: null, startTime: null }),
      cand(2, raceIdOf(2), { historyCutoffDate: null, startTime: "10:05", analyzedAt: "2026-10-10T03:00:00.000Z" }),
      cand(3, raceIdOf(3), { evEstimated: 1 }),
    ];
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    const res = await core.request("status");
    expect(res).toMatchObject({ status: "ready", file: { rows: 0, races: 0, excluded: { unchecked: 1, uncheckedRaces: 1, suspect: 1, unknown: 0, superseded: 0, estimated: 1 } } });
    const { meta, rows } = readFile(w.store.puts[0]!.bytes);
    expect(rows).toEqual([]);
    expect(meta).toMatchObject({ excluded: { unchecked: 1, uncheckedRaces: 1, suspect: 1, estimated: 1 } });
  });

  it("詳細(R2)が無いレースも行は出し(has_odds は false)、missingOdds に数える。配分のメタが無い分析は allocation が null で、noAllocation に数える", async () => {
    const w = world(3);
    w.store.noDetail = new Set([101]);
    w.store.noMeta = new Set([102]);
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    const { meta, rows } = readFile(w.store.puts[0]!.bytes);
    expect(meta).toMatchObject({ missingOdds: 1, noAllocation: 1, rows: 3 });
    expect(rows.map((r) => [r.analysis_id, r.has_odds, r.allocation === null])).toEqual([[100, true, false], [101, false, false], [102, true, true]]);
    expect(rows[1]!.horses.every((h) => h.win_odds === null)).toBe(true);
    expect(rows[1]!.combos).toEqual({});
    expect(await core.request("status")).toMatchObject({ file: { missingOdds: 1, noAllocation: 1 } });
  });
});

describe("作成中の扱い(prior-dataset の書き出しと同じ取り決め)", () => {
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
    expect(during).toMatchObject({ file: { generatedAt: oldFile.file.generatedAt } });
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
    await w.drain(core, 2);
    w.alarms.length = 0;
    const res = await core.request("status");
    expect(res).toMatchObject({ status: "building", phase: "building", racesDone: 2, races: 5 });
    expect(w.alarms).toEqual([]);
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
  });

  it("同時の 2 つの要求でも、始めるのは 1 回だけで、回数も 1 しか消費しない", async () => {
    const w = world(2);
    const core = w.core();
    const [a, b] = await Promise.all([core.request("download"), core.request("refresh")]);
    expect([a.status, b.status]).toEqual(["building", "building"]);
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });
    expect(w.alarms).toHaveLength(1);
  });

  it("作成中なのにアラームが無ければ張り直す(自己回復)。DO が作り直された後も続きから進む", async () => {
    const w = world(5);
    const first = w.core({ batchSize: 2 });
    await first.request("download");
    await w.drain(first, 2);
    w.alarms.length = 0;
    const second = w.core({ batchSize: 2 });
    expect((await second.request("download")).status).toBe("building");
    expect(w.alarms).toHaveLength(1);
    await w.drain(second);
    expect((await second.request("status")).status).toBe("ready");
    expect(readFile(w.store.puts[0]!.bytes).rows).toHaveLength(5);
    expect(w.store.puts).toHaveLength(1);
  });
});

describe("柵", () => {
  it("1 日(JST)3 回まで: 4 回目の refresh は throttled(次の JST 0 時)で、翌日は始められる", async () => {
    const w = world(2);
    const core = w.core();
    for (let i = 0; i < ALLOCATION_EXPORT_DAILY_LIMIT; i += 1) {
      expect((await core.request("refresh")).status).toBe("building");
      await w.drain(core);
      w.clock.now += 60_000;
    }
    const putsBefore = w.store.puts.length;
    const blocked = await core.request("refresh");
    expect(blocked).toMatchObject({ status: "throttled", nextAt: "2026-10-10T15:00:00.000Z" });
    expect(blocked).toHaveProperty("file.rows", 2);
    expect(w.alarms).toEqual([]);
    expect((await core.request("download")).status).toBe("ready");
    expect(w.store.puts).toHaveLength(putsBefore);
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
    await w.drain(core, 2);
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
    expect(readFile(w.store.puts[0]!.bytes).rows).toHaveLength(3);
    expect(w.store.readCounted).toBe(9);
  });

  it("失敗が続いて上限回数に達したら failed(固定の理由だけ。例外の文面は状態に入れない)。通常の download は再開せず、refresh で再開できる", async () => {
    const w = world(2);
    w.store.failCandidates = ALLOCATION_EXPORT_MAX_ATTEMPTS;
    const core = w.core();
    await core.request("download");
    await w.drain(core);
    const failed = await core.request("download");
    expect(failed).toMatchObject({ status: "failed", reason: "tick-failed" });
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    expect((await core.request("download")).status).toBe("failed");
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 1 });

    expect((await core.request("refresh")).status).toBe("building");
    expect(w.kv.get("runs")).toEqual({ day: "2026-10-10", count: 2 });
    await w.drain(core);
    expect((await core.request("status")).status).toBe("ready");
  });

  it("失敗で止まったら、計画と処理済みの塊を kv に残さない(R2 の柵・連続の失敗のどちらの止まり方でも)。止まる前には確かに残っている", async () => {
    const leftovers = (w: World): string[] => [...w.kv.map.keys()].filter((k) => k.startsWith("plan:") || k.startsWith("chunk:")).sort();
    // (a) 処理の途中で R2 の読み出しの柵に達して止まる
    const a = world(5);
    const coreA = a.core({ batchSize: 2 });
    await coreA.request("download");
    await a.drain(coreA, 2); // 計画 + 処理 1 batch
    expect(leftovers(a)).toEqual(["chunk:0", "plan:0", "plan:1", "plan:2"]); // 前提: 止まる前には残っている
    a.store.usage = { classA: 0, classB: R2_FENCE_LIMITS.classB };
    await a.drain(coreA, 1);
    expect(await coreA.request("status")).toMatchObject({ status: "failed", reason: "r2-fence" });
    expect(leftovers(a)).toEqual([]);
    // (b) 取得の失敗が続いて、上限の回数で止まる
    const b = world(5);
    const coreB = b.core({ batchSize: 2 });
    await coreB.request("download");
    await b.drain(coreB, 2);
    expect(leftovers(b)).toEqual(["chunk:0", "plan:0", "plan:1", "plan:2"]);
    b.store.failFetch = ALLOCATION_EXPORT_MAX_ATTEMPTS;
    await b.drain(coreB);
    expect(await coreB.request("status")).toMatchObject({ status: "failed", reason: "tick-failed" });
    expect(leftovers(b)).toEqual([]);
  });

  it("仕上げの塊が失われていたら(kv に無い)put は失敗として扱い、failed へ進む前に再試行する。完成したファイルは作られない", async () => {
    const w = world(3);
    const core = w.core({ batchSize: 2 });
    await core.request("download");
    await w.drain(core, 1 + 2); // 計画 + 処理 2(仕上げの前)
    w.kv.delete("chunk:1");
    // 偽のストアは生成器を最後まで読む。塊が無ければ例外 → 仕上げが失敗として記録される
    await w.drain(core, 1);
    expect(w.store.puts).toEqual([]);
    expect(w.kv.get("job")).toMatchObject({ state: "running", phase: "finalizing", attempts: 1 });
  });

  it("仕上げの塊の長さが、処理のときに記録した長さと違っていたら(kv の値が差し替わった・欠けた)put は失敗として扱い、完成したファイルは作られない。長さが同じなら通る", async () => {
    // 本番では FixedLengthStream も長さの違いで止める(守りは 2 重)。ここは core 自身の検査を、偽のストア(長さを検査しない)で固定する。
    const w = world(3);
    const core = w.core({ batchSize: 2 });
    await core.request("download");
    await w.drain(core, 1 + 2); // 計画 + 処理 2(仕上げの前)
    const chunk = w.kv.get<Uint8Array>("chunk:1")!;
    expect(chunk.length).toBeGreaterThan(1);
    // 長さが違う値に差し替える(1 バイト長い・1 バイト短い)。どちらも例外
    for (const replaced of [new Uint8Array([...chunk, 0]), chunk.slice(0, chunk.length - 1)]) {
      expect(replaced.length).not.toBe(chunk.length);
      w.kv.put("chunk:1", replaced);
      await w.drain(core, 1);
      expect(w.store.puts).toEqual([]);
      expect(w.kv.get("job")).toMatchObject({ state: "running", phase: "finalizing" });
    }
    // 長さが同じ(中身だけ別)なら、この検査では止まらない(長さの検査であって、中身の検査ではない)
    w.kv.put("chunk:1", new Uint8Array(chunk.length));
    await w.drain(core, 1);
    expect(w.store.puts).toHaveLength(1);
  });
});
