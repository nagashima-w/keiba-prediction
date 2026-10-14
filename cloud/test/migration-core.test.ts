import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { MigrationFormatError } from "../../packages/core/src/ev/cloud-migration-format";
import { clipForKv, D1_FREE_DAILY_WRITE_ROWS, FREE_QUERIES_PER_INVOCATION, MigrationCore, MIGRATION_DAILY_ROW_LIMIT, parseLimitOverride, MIGRATION_MAX_ATTEMPTS, MIGRATION_TICK_QUERY_LIMIT, type MigrationCoreDeps, type MigrationStatus } from "../src/migration-core";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { D1ResultStore } from "../src/result-repository";
import { GOLDEN_ANALYSES, GOLDEN_TEXT, gz, streamOf } from "./migration-fixture";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #216(#167-B1): 取り込みの状態機械(`MigrationCore`)。本物のローカル(workerd)の D1・R2 と、本物の保存経路で、
 * 検証 → 少しずつ取り込み → 完了、予算待ち、R2 の柵、中断からの再開、冪等性、失敗を確かめる。時計とアラームは偽物(アラームの時刻まで時計を進めて呼ぶ)。
 */

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

const T0 = Date.UTC(2026, 9, 9, 3, 0, 0); // 2026-10-09 03:00 UTC
const KEY = "migration/test-1.ndjson.gz";

interface Harness {
  core: MigrationCore;
  kv: Map<string, unknown>;
  clock: { ms: number };
  files: Map<string, Uint8Array>;
  alarm: { at: number | null };
  opens: { n: number };
  prepared: string[];
  puts: () => number;
  /** アラームが張られている間、その時刻まで時計を進めて 1 ステップずつ呼ぶ。1 ステップごとの状態を返す。 */
  run(maxSteps?: number): Promise<MigrationStatus[]>;
  /** 条件を満たす状態になるステップまで進めて止める(そのステップで張られたアラームは残す)。 */
  runUntil(predicate: (status: MigrationStatus) => boolean, maxSteps?: number): Promise<MigrationStatus[]>;
  rebuild(): Harness;
}

interface HarnessOptions {
  readonly deps?: Partial<MigrationCoreDeps>;
  readonly bucketOptions?: Parameters<typeof spyBucket>[1];
  readonly options?: ConstructorParameters<typeof MigrationCore>[1];
  readonly files?: Map<string, Uint8Array>;
  readonly kv?: Map<string, unknown>;
  readonly clock?: { ms: number };
}

function harness(h: HarnessOptions = {}): Harness {
  const kv = h.kv ?? new Map<string, unknown>();
  const clock = h.clock ?? { ms: T0 };
  const files = h.files ?? new Map<string, Uint8Array>();
  const alarm: { at: number | null } = { at: null };
  const opens = { n: 0 };
  const spy = spyDb(local.db);
  const bucket = spyBucket(local.r2, h.bucketOptions);
  const now = () => new Date(clock.ms);
  const analyses = new D1AnalysisStore({ db: spy.db, bucket: bucket.bucket, now });
  const results = new D1ResultStore({ db: spy.db });
  const core = new MigrationCore(
    {
      kv: { get: <T,>(k: string) => kv.get(k) as T | undefined, put: (k, v) => void kv.set(k, structuredClone(v)) },
      now: () => clock.ms,
      setAlarm: (at) => {
        alarm.at = at;
      },
      getAlarm: async () => alarm.at,
      openFile: async (key) => {
        opens.n += 1;
        const bytes = files.get(key);
        return bytes === undefined ? null : streamOf(bytes, 8192);
      },
      deleteFile: async (key) => void files.delete(key),
      analyses,
      results,
      ...h.deps,
    },
    h.options,
  );
  const self: Harness = {
    core,
    kv,
    clock,
    files,
    alarm,
    opens,
    prepared: spy.prepared,
    puts: () => bucket.calls.filter((c) => c.op === "put").length,
    async run(maxSteps = 500) {
      const states: MigrationStatus[] = [];
      for (let i = 0; i < maxSteps && alarm.at !== null; i += 1) {
        clock.ms = Math.max(clock.ms, alarm.at);
        alarm.at = null;
        await core.runNextStep();
        states.push(core.getStatus());
      }
      return states;
    },
    async runUntil(predicate, maxSteps = 500) {
      const states: MigrationStatus[] = [];
      for (let i = 0; i < maxSteps && alarm.at !== null; i += 1) {
        clock.ms = Math.max(clock.ms, alarm.at);
        alarm.at = null;
        await core.runNextStep();
        const status = core.getStatus();
        states.push(status);
        if (predicate(status)) break;
      }
      return states;
    },
    rebuild: () => harness({ ...h, files, kv, clock }),
  };
  return self;
}

async function count(table: string): Promise<number> {
  return (await local.db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
}

async function upload(h: Harness, text = GOLDEN_TEXT, key = KEY): Promise<ReturnType<MigrationCore["start"]>> {
  const bytes = gz(text);
  h.files.set(key, bytes);
  return h.core.start({ key, size: bytes.length });
}

describe("正常系: アップロード → 検証 → 取り込み → 完了", () => {
  it("実物のファイル: 状態は verifying → importing … → completed。分析5件・結果5レースが D1 に入り、アップロードしたファイルは消える", async () => {
    const h = harness();
    expect(h.core.getStatus().state).toBe("idle");
    const started = await upload(h);
    expect(started).toEqual({ accepted: true });
    expect(h.core.getStatus().state).toBe("verifying");
    expect(h.alarm.at).not.toBeNull();

    const states = await h.run();
    const seq = states.map((s) => s.state);
    expect(seq[0]).toBe("importing"); // 検証が終わった最初のステップ
    expect(seq[seq.length - 1]).toBe("completed");
    expect(h.alarm.at).toBeNull(); // 完了後はアラームを張らない

    const status = h.core.getStatus();
    expect(status.analyses).toMatchObject({ total: 5, processed: 5, imported: 5, alreadyImported: 0, conflicts: 0 });
    expect(status.results).toMatchObject({ total: 5, processed: 5 });
    expect(status.failure).toBeNull();
    expect(await count("analyses")).toBe(5);
    expect(await count("analysis_horses")).toBe(9);
    expect(await count("race_results")).toBe(4);
    expect(await count("race_result_meta")).toBe(2);
    // 詳細(R2)は5件分
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses WHERE detail_key IS NOT NULL").first<{ c: number }>())!.c).toBe(5);
    expect(h.files.has(KEY)).toBe(false);
    // 元の値: 分析日時は過去のまま(今日の日付になっていない)
    const at = (await local.db.prepare("SELECT analyzed_at AS a FROM analyses ORDER BY analyzed_at").all<{ a: string }>()).results.map((r) => r.a);
    expect(at[0]).toBe("2026-03-02T01:00:00.000Z");
  });

  it("1 回のステップ(alarm)の問い合わせ数(D1 の文 + R2 の操作)は、上限(MIGRATION_TICK_QUERY_LIMIT)以内。取り込みは複数のステップに分かれる", async () => {
    const h = harness();
    await upload(h);
    let previousPrepared = 0;
    let previousPuts = 0;
    let previousOpens = 0;
    const perStep: number[] = [];
    while (h.alarm.at !== null) {
      h.clock.ms = Math.max(h.clock.ms, h.alarm.at);
      h.alarm.at = null;
      await h.core.runNextStep();
      // D1 の文(prepare した数。batch の文も 1 つずつ prepare される)+ R2 の put + ファイルの読み出し
      perStep.push(h.prepared.length - previousPrepared + h.puts() - previousPuts + h.opens.n - previousOpens);
      previousPrepared = h.prepared.length;
      previousPuts = h.puts();
      previousOpens = h.opens.n;
    }
    expect(h.core.getStatus().state).toBe("completed");
    // 検証のステップ(ファイルを読むだけ)を除く取り込みのステップが 2 つ以上ある(全部を 1 回で済ませていない)
    expect(perStep.filter((n) => n > 1).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...perStep)).toBeLessThanOrEqual(MIGRATION_TICK_QUERY_LIMIT);
    expect(MIGRATION_TICK_QUERY_LIMIT).toBe(40);
  });

  it("上限を小さくすると 1 ステップの処理が減り、ステップ数が増える(上限が実際に効いている対照)", async () => {
    const wide = harness();
    await upload(wide);
    const wideSteps = (await wide.run()).length;
    await local.reset();
    const narrow = harness({ options: { tickQueryLimit: 14 } });
    await upload(narrow);
    const narrowSteps = (await narrow.run()).length;
    expect(narrow.core.getStatus().state).toBe("completed");
    expect(narrowSteps).toBeGreaterThan(wideSteps);
    expect(await count("analyses")).toBe(5);
  });

  it("status: 取り込み中は処理済みの件数が増える(待機・検証中・取り込み中・完了の件数と、全体の件数)", async () => {
    const h = harness({ options: { tickQueryLimit: 14 } });
    await upload(h);
    const states = await h.run();
    const importing = states.filter((s) => s.state === "importing");
    expect(importing.length).toBeGreaterThan(1);
    const processed = states.map((s) => s.analyses.processed + s.results.processed);
    expect(processed).toEqual([...processed].sort((a, b) => a - b)); // 単調増加
    expect(new Set(processed).size).toBeGreaterThan(2);
    expect(states[0]!.analyses.total).toBe(5);
    expect(states[0]!.upload).toMatchObject({ appVersion: "1.27.0", exportedAt: "2026-10-09T00:00:00.000Z" });
  });
});

describe("冪等性", () => {
  it("同じファイルをもう一度アップロードしても壊れない: 分析は取り込み済みとして飛ばし、行は増えず、D1 の書き込みは 0", async () => {
    const first = harness();
    await upload(first);
    await first.run();
    const before = { a: await count("analyses"), h: await count("analysis_horses"), r: await count("race_results"), c: await count("race_combo_payouts") };
    expect(before.a).toBe(5);

    const second = first.rebuild();
    expect(await upload(second, GOLDEN_TEXT, "migration/test-2.ndjson.gz")).toEqual({ accepted: true });
    await second.run();
    const status = second.core.getStatus();
    expect(status.state).toBe("completed");
    expect(status.analyses).toMatchObject({ total: 5, processed: 5, imported: 0, alreadyImported: 5, conflicts: 0 });
    expect({ a: await count("analyses"), h: await count("analysis_horses"), r: await count("race_results"), c: await count("race_combo_payouts") }).toEqual(before);
    // 詳細の put も増えない(2回目は R2 に書かない)
    expect(second.puts()).toBe(0);
  });

  it("exe の id が同じで race_id・分析日時が違う分析(exe の DB を作り直した等)は、飛ばして『衝突』として数える。失敗にしない・上書きしない", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, exe_analysis_id) VALUES ('OTHER-RACE', '2025-01-01T00:00:00.000Z', 2)").run();
    const h = harness();
    await upload(h);
    await h.run();
    const status = h.core.getStatus();
    expect(status.state).toBe("completed");
    expect(status.analyses).toMatchObject({ total: 5, processed: 5, imported: 4, alreadyImported: 0, conflicts: 1 });
    expect(status.conflictSamples).toHaveLength(1);
    expect(status.conflictSamples[0]).toContain("2");
    expect(await count("analyses")).toBe(5); // 既存の1件 + 取り込んだ4件
    expect((await local.db.prepare("SELECT race_id AS r FROM analyses WHERE exe_analysis_id = 2").first<{ r: string }>())!.r).toBe("OTHER-RACE");
  });
});

describe("衝突の判定は race_id と analyzed_at の両方を見る", () => {
  // 取り込み済みの exe の id 2(race 202603020211・2026-03-02T02:00:00.000Z)と、どちらか一方だけ違う行がある場合。
  it.each([
    ["race_id だけが違う(分析日時は同じ)", "OTHER-RACE", "2026-03-02T02:00:00.000Z"],
    ["分析日時だけが違う(race_id は同じ)", "202603020211", "2025-01-01T00:00:00.000Z"],
  ])("%s → 衝突として飛ばす", async (_name, raceId, analyzedAt) => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, exe_analysis_id) VALUES (?, ?, 2)").bind(raceId, analyzedAt).run();
    const h = harness();
    await upload(h);
    await h.run();
    expect(h.core.getStatus().analyses).toMatchObject({ imported: 4, alreadyImported: 0, conflicts: 1 });
  });

  it("対照: race_id も分析日時も同じなら、取り込み済み(衝突ではない)", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, exe_analysis_id) VALUES ('202603020211', '2026-03-02T02:00:00.000Z', 2)").run();
    const h = harness();
    await upload(h);
    await h.run();
    expect(h.core.getStatus().analyses).toMatchObject({ imported: 4, alreadyImported: 1, conflicts: 0 });
  });
});

describe("検証: 書き始める前に全体を検証する", () => {
  const lines = GOLDEN_TEXT.trimEnd().split("\n");

  it("フッタの無い(途中で切れた)ファイル: failed(phase: verify)。D1 には何も書かれず、ファイルは削除される", async () => {
    const h = harness();
    await upload(h, `${lines.slice(0, -1).join("\n")}\n`);
    await h.run();
    const status = h.core.getStatus();
    expect(status.state).toBe("failed");
    expect(status.failure?.phase).toBe("verify");
    expect(status.failure?.message).toMatch(/フッタ/);
    expect(await count("analyses")).toBe(0);
    expect(await count("race_results")).toBe(0);
    expect(h.files.has(KEY)).toBe(false);
    expect(h.alarm.at).toBeNull();
  });

  it("取り込み時刻 + 7 日より後の分析日時を含むファイル(Issue #308): failed(phase: verify)。D1 には何も書かれない。ちょうど 7 日後は通る", async () => {
    const withStamp = (iso: string): string => `${lines.map((l, i) => (i === 1 ? l.replace('"analyzed_at":"2026-03-02T01:00:00.000Z"', `"analyzed_at":"${iso}"`) : l)).join("\n")}\n`;
    expect(withStamp("2099-01-01T00:00:00.000Z")).not.toBe(`${lines.join("\n")}\n`); // 置換が効いている
    const limit = T0 + 7 * 24 * 60 * 60 * 1000;
    const over = harness();
    await upload(over, withStamp(new Date(limit + 1).toISOString()));
    await over.run();
    expect(over.core.getStatus().state).toBe("failed");
    expect(over.core.getStatus().failure?.phase).toBe("verify");
    expect(over.core.getStatus().failure?.message).toMatch(/analyzed_at/);
    expect(await count("analyses")).toBe(0);
    await local.reset();
    const exact = harness();
    await upload(exact, withStamp(new Date(limit).toISOString()));
    await exact.run();
    expect(exact.core.getStatus().state).toBe("completed");
  });

  it("最後の分析の行が壊れているファイル(前の分析の行は正常): 最初の行も書かれない(全体を先に検証している)", async () => {
    const h = harness();
    const broken = lines.map((l, i) => (i === 5 ? l.replace('"model":', '"modelx":') : l)); // 5 行目 = 分析 5
    expect(broken[5]).not.toBe(lines[5]); // 置換が効いている
    await upload(h, `${broken.join("\n")}\n`);
    await h.run();
    expect(h.core.getStatus().state).toBe("failed");
    expect(h.core.getStatus().failure?.message).toMatch(/6 行目|分析/);
    expect(await count("analyses")).toBe(0);
  });

  it("アップロードしたファイルが R2 に無い: failed", async () => {
    const h = harness();
    await h.core.start({ key: "migration/none.ndjson.gz", size: 1 });
    await h.run();
    expect(h.core.getStatus().state).toBe("failed");
    expect(h.core.getStatus().failure?.phase).toBe("verify");
  });

  it("失敗のあとは、新しいアップロードを受け付ける(failed は『忙しい』にならない)", async () => {
    const h = harness();
    await upload(h, "壊れたファイル");
    await h.run();
    expect(h.core.getStatus().state).toBe("failed");
    expect(await upload(h, GOLDEN_TEXT, "migration/test-2.ndjson.gz")).toEqual({ accepted: true });
    await h.run();
    expect(h.core.getStatus().state).toBe("completed");
    expect(h.core.getStatus().failure).toBeNull();
  });
});

describe("受付: 取り込み中は 409 相当", () => {
  it("検証中・取り込み中・予算待ち・R2 待ちの間は受け付けない(busy)。完了後は受け付ける", async () => {
    const h = harness({ options: { tickQueryLimit: 14 } });
    await upload(h);
    expect(await h.core.start({ key: "migration/other.ndjson.gz", size: 1 })).toEqual({ accepted: false, reason: "busy" });
    // 1 ステップ進めて取り込み中でも同じ
    h.clock.ms = Math.max(h.clock.ms, h.alarm.at!);
    h.alarm.at = null;
    await h.core.runNextStep();
    expect(h.core.getStatus().state).toBe("importing");
    expect(await h.core.start({ key: "migration/other.ndjson.gz", size: 1 })).toEqual({ accepted: false, reason: "busy" });
    await h.run();
    expect(h.core.getStatus().state).toBe("completed");
    expect(await h.core.start({ key: "migration/other.ndjson.gz", size: 1 })).toEqual({ accepted: true });
  });

  it("busy のときは、受け付けなかったファイルの削除を呼び出し側ができるよう、現在の状態を変えない", async () => {
    const h = harness();
    await upload(h);
    const before = h.core.getStatus();
    await h.core.start({ key: "migration/other.ndjson.gz", size: 1 });
    expect(h.core.getStatus()).toEqual(before);
  });
});

describe("D1 の 1 日の書き込み上限(予算)", () => {
  it("上限に達したら waiting-budget になり、翌 UTC 日の 00:05 に再開する。その前にアラームが来ても何も処理しない", async () => {
    const h = harness({ options: { dailyRowLimit: 40 } });
    await upload(h);
    const states = await h.runUntil((s) => s.state === "waiting-budget");
    const waiting = states[states.length - 1]!;
    expect(waiting.state).toBe("waiting-budget");
    const resumeAt = Date.UTC(2026, 9, 10, 0, 5, 0);
    expect(waiting.resumeAt).toBe(new Date(resumeAt).toISOString());
    expect(h.alarm.at).toBe(resumeAt);
    // 前提: 一部は取り込めていて、全部ではない(上限が効いている)
    const done = (await count("analyses"));
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(5);
    // 1 回のアラームの途中でも止まる: 実物の分析 1(16 行)・分析 2(23 行)で、読み出しの計上 1 行を足して 40 行に達するので、同じアラームの 3 件目(15 行)は取り込まない。
    expect(done).toBe(2);
    expect(waiting.budget.usedRows).toBe(1 + 16 + 23);
    // 早すぎるアラーム(再開時刻の前)は何もしない
    h.clock.ms = resumeAt - 60_000;
    h.alarm.at = null;
    await h.core.runNextStep();
    expect(await count("analyses")).toBe(done);
    expect(h.core.getStatus().state).toBe("waiting-budget");
    expect(h.alarm.at).toBe(resumeAt);
  });

  it("翌日に再開すると、その日の上限の分だけ進み(また待ち)、最終的に全件が取り込まれる。重複しない", async () => {
    const h = harness({ options: { dailyRowLimit: 40 } });
    await upload(h);
    const states = await h.run();
    expect(h.core.getStatus().state).toBe("completed");
    expect(states.filter((s) => s.state === "waiting-budget").length).toBeGreaterThanOrEqual(2);
    expect(await count("analyses")).toBe(5);
    expect(await count("race_results")).toBe(4);
    expect(h.core.getStatus().analyses).toMatchObject({ imported: 5, alreadyImported: 0 });
  });

  it("使った行数は meta.rows_written の実測の合計で数える(status.budget.usedRows)。日付が変わると 0 から数え直す", async () => {
    const h = harness();
    await upload(h);
    await h.run();
    const used = h.core.getStatus().budget.usedRows;
    expect(used).toBeGreaterThan(50);
    // 実際の書き込み: 分析5件+結果5レースの全表の行数(索引分は含まない)より、索引・カウンタ分だけ多い
    const tableRows = (await count("analyses")) + (await count("analysis_horses")) + (await count("analysis_bets")) + (await count("analysis_allocation_meta")) + (await count("race_results")) + (await count("race_result_meta")) + (await count("race_combo_payouts")) + (await count("race_combo_payout_imports"));
    expect(used).toBeGreaterThan(tableRows);
    expect(h.core.getStatus().budget.limitRows).toBe(MIGRATION_DAILY_ROW_LIMIT);
    // 翌日の status では、その日の使用量は 0
    h.clock.ms = Date.UTC(2026, 9, 10, 1, 0, 0);
    expect(h.core.getStatus().budget.usedRows).toBe(0);
    expect(h.core.getStatus().budget.day).toBe("20261010");
  });
});

describe("R2 の操作回数の柵(#173): 『要約だけ保存』にせず止めて、翌月に再開する", () => {
  it("Class A が柵に達している: waiting-r2 になり、D1・R2 に何も書かない。翌月 1 日の 00:05 UTC に再開し、柵が空けば全件を取り込む", async () => {
    await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (202610, ?, 0)").bind(R2_FENCE_LIMITS.classA).run();
    const h = harness();
    await upload(h);
    const states = await h.runUntil((s) => s.state === "waiting-r2");
    const waiting = states[states.length - 1]!;
    expect(waiting.state).toBe("waiting-r2");
    const resumeAt = Date.UTC(2026, 10, 1, 0, 5, 0);
    expect(waiting.resumeAt).toBe(new Date(resumeAt).toISOString());
    expect(h.alarm.at).toBe(resumeAt);
    expect(await count("analyses")).toBe(0);
    expect(h.puts()).toBe(0);
    // 翌月(11月は r2_ops の行が無い=0 回)に再開
    const rest = await h.run();
    expect(rest[rest.length - 1]!.state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses WHERE detail_key IS NULL").first<{ c: number }>())!.c).toBe(0);
  });

  it("Class B(読み出し)が柵に達している場合も waiting-r2(ファイルを読む前に止まる)", async () => {
    await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (202610, 0, ?)").bind(R2_FENCE_LIMITS.classB).run();
    const h = harness();
    await upload(h);
    const states = await h.runUntil((s) => s.state === "waiting-r2");
    expect(states[states.length - 1]!.state).toBe("waiting-r2");
    expect(await count("analyses")).toBe(0);
    expect(h.opens.n).toBe(1); // 開いたのは検証の 1 回だけ(取り込みは、ファイルを開く前に止まる)
  });
});

describe("中断・失敗からの再開", () => {
  it("DO が再起動(コアを作り直す。状態は kv から)しても、続きから取り込み、重複しない", async () => {
    const h = harness({ options: { tickQueryLimit: 14 } });
    await upload(h);
    await h.run(4); // 検証 + 数ステップ
    const mid = await count("analyses");
    expect(h.core.getStatus().state).toBe("importing");
    expect(mid).toBeLessThan(5);
    const restarted = h.rebuild();
    expect(restarted.core.getStatus().state).toBe("importing");
    restarted.alarm.at = h.alarm.at; // DO のアラームは再起動しても残る
    await restarted.run();
    expect(restarted.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    expect(restarted.core.getStatus().analyses).toMatchObject({ processed: 5 });
  });

  it("R2 の put が失敗した分析: ステップは失敗として記録され、再試行で詳細(R2)を作り直す(D1 の行は重複しない・詳細は欠けない)", async () => {
    const h = harness({ bucketOptions: { failPut: (n) => n <= 3 } }); // 最初の分析の put 3 回(初回+再試行2回)が失敗
    await upload(h);
    const states = await h.run();
    expect(states.some((s) => s.state === "importing" && s.failure === null && s.attempts > 0)).toBe(true);
    expect(h.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    for (const row of (await local.db.prepare("SELECT id, detail_key AS k FROM analyses").all<{ id: number; k: string }>()).results) {
      expect(await local.r2.get(row.k), `analyses/${row.id}`).not.toBeNull();
    }
    // 詳細の作り直しになった分析は、D1 には最初の試行で入っていたので『取り込み済み』に数える(取り込んだ + 取り込み済み = 5)。
    const analyses = h.core.getStatus().analyses;
    expect(analyses.imported + analyses.alreadyImported).toBe(5);
    expect(analyses.alreadyImported).toBe(1);
  });

  it("エラーが続くと再試行の上限で failed(phase: import)。ファイルは残し、アラームは止まる", async () => {
    const h = harness({
      deps: {
        results: { saveMigratedResult: async () => { throw new Error("D1 の障害 SECRET-DETAIL"); } } as never,
      },
    });
    await upload(h);
    const states = await h.run(60);
    const status = h.core.getStatus();
    expect(status.state).toBe("failed");
    expect(status.failure?.phase).toBe("import");
    expect(h.alarm.at).toBeNull();
    expect(h.files.has(KEY)).toBe(true);
    // 例外の本文は画面に出さない
    expect(JSON.stringify(status)).not.toContain("SECRET-DETAIL");
    // 失敗のたびに再試行する(上限まで)。検証 1 + 分析の取り込み数ステップ + 結果の失敗 8 回。
    expect(states.filter((s) => s.attempts > 0).length).toBe(MIGRATION_MAX_ATTEMPTS);
    // 分析は結果より先に取り込めている(ファイルの並び)
    expect(await count("analyses")).toBe(5);
    // 失敗のあとの再アップロード(別のキー)で続きを取り込める。分析は取り込み済みとして飛ばす。失敗した取り込みのファイルは、受付で削除される。
    const again = harness({ files: h.files, kv: h.kv, clock: h.clock });
    expect(h.files.has(KEY)).toBe(true);
    expect(await upload(again, GOLDEN_TEXT, "migration/retry.ndjson.gz")).toEqual({ accepted: true });
    expect(h.files.has(KEY)).toBe(false);
    await again.run();
    expect(again.core.getStatus().state).toBe("completed");
    expect(again.core.getStatus().analyses).toMatchObject({ imported: 0, alreadyImported: 5 });
    expect(await count("race_results")).toBe(4);
  });
});

describe("詳細(R2)が未完了の分析の記憶: ジョブの状態遷移に依存せず、取り込み済みとして飛ばされても詳細を作り直す", () => {
  /** 全分析の詳細(R2)が、D1 の detail_key の指すキーに実在する。 */
  async function missingDetails(): Promise<string[]> {
    const rows = (await local.db.prepare("SELECT id, detail_key AS k FROM analyses").all<{ id: number; k: string | null }>()).results;
    const missing: string[] = [];
    for (const r of rows) {
      if (r.k === null || (await local.r2.get(r.k)) === null) missing.push(`analyses/${r.id}`);
    }
    return missing;
  }

  it("中断(D1 の batch のあと、R2 の put の前に止まった)の再現: 未完了の記憶(kv の pending)がある分析は、取り込み済みでも詳細が作り直される。記憶が無ければ触れない(対照)", async () => {
    const h = harness({ options: { tickQueryLimit: 14 } });
    await upload(h);
    await h.runUntil((s) => s.analyses.processed >= 1);
    const first = (await local.db.prepare("SELECT id, detail_key AS k FROM analyses ORDER BY id LIMIT 1").first<{ id: number; k: string }>())!;
    expect(await local.r2.get(first.k)).not.toBeNull();
    // 中断を再現する: R2 の詳細を消し、位置を戻して(最初の分析の処理の途中で止まった状態)、未完了の記憶を立てる。
    await local.r2.delete(first.k);
    const job = h.kv.get("job") as Record<string, unknown>;
    h.kv.set("job", { ...job, offset: 0, analysesProcessed: 0, analysesImported: 0, analysesAlreadyImported: 0 });
    h.kv.set("pending", { [String(GOLDEN_ANALYSES[0]!.analysis["id"])]: 1 });
    await h.run();
    expect(h.core.getStatus().state).toBe("completed");
    expect(await local.r2.get(first.k)).not.toBeNull(); // 作り直された
    expect(await count("analyses")).toBe(5); // 重複しない
    expect(h.kv.get("pending")).toEqual({}); // 作り直したら、記憶から外れる
    // 対照: 記憶が無ければ、取り込み済みの分析の詳細には触れない(R2 の put を増やさない)。
    await local.reset();
    const again = harness({ options: { tickQueryLimit: 14 } });
    await upload(again);
    await again.run();
    const row = (await local.db.prepare("SELECT id, detail_key AS k FROM analyses ORDER BY id LIMIT 1").first<{ id: number; k: string }>())!;
    await local.r2.delete(row.k);
    const second = again.rebuild();
    await upload(second, GOLDEN_TEXT, "migration/test-2.ndjson.gz");
    await second.run();
    expect(second.core.getStatus().analyses).toMatchObject({ alreadyImported: 5 });
    expect(await local.r2.get(row.k)).toBeNull();
    expect(second.puts()).toBe(0);
  });

  it("正常に取り込めたあとは、未完了の記憶が空になる(分析ごとに、書く前に立て、put の成功で外す)", async () => {
    const h = harness();
    await upload(h);
    await h.run();
    expect(h.core.getStatus().state).toBe("completed");
    expect(h.kv.get("pending")).toEqual({});
    expect(await missingDetails()).toEqual([]);
  });

  it("S1: R2 の put が常に失敗 → 連続失敗で failed → R2 が直ってから再アップロードしても、詳細が欠けたままにならない", async () => {
    const broken = harness({ bucketOptions: { failPut: () => true } });
    await upload(broken);
    await broken.run(80);
    expect(broken.core.getStatus().state).toBe("failed");
    expect(broken.core.getStatus().failure?.phase).toBe("import");
    // 前提: D1 の行はできていて、詳細(R2)が欠けている(これを後で直せなければ、無音で欠ける)
    expect(await count("analyses")).toBeGreaterThan(0);
    expect((await missingDetails()).length).toBeGreaterThan(0);
    // R2 が直った。再アップロード(README の案内どおり)。
    const fixed = harness({ files: broken.files, kv: broken.kv, clock: broken.clock });
    expect(await upload(fixed, GOLDEN_TEXT, "migration/retry.ndjson.gz")).toEqual({ accepted: true });
    await fixed.run();
    expect(fixed.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    expect(await missingDetails()).toEqual([]);
  });

  it("S2: put が失敗したあとの再試行が日次予算に当たって waiting-budget になり、翌日に再開しても、詳細が欠けない", async () => {
    const h = harness({ bucketOptions: { failPut: (n) => n <= 3 }, options: { dailyRowLimit: 10 } });
    await upload(h);
    const states = await h.run();
    expect(states.some((s) => s.state === "waiting-budget")).toBe(true);
    expect(states.some((s) => s.attempts > 0 && s.state === "importing")).toBe(true); // put の失敗が実際に起きた
    expect(h.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    expect(await missingDetails()).toEqual([]);
  });

  it("S3: put が失敗したあとの再試行が R2 の柵に当たって waiting-r2 になり、翌月に再開しても、詳細が欠けない", async () => {
    const h = harness({ bucketOptions: { failPut: (n) => n <= 3 } });
    await upload(h);
    await h.runUntil((s) => s.attempts > 0); // 最初の分析の put が失敗した
    expect(await count("analyses")).toBe(1);
    expect((await missingDetails()).length).toBe(1);
    await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (202610, ?, 0) ON CONFLICT(ym) DO UPDATE SET class_a = excluded.class_a").bind(R2_FENCE_LIMITS.classA).run();
    const states = await h.run();
    expect(states.some((s) => s.state === "waiting-r2")).toBe(true);
    expect(h.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    expect(await missingDetails()).toEqual([]);
  });
});

describe("アラームの自己回復: 取り込み中なのにアラームが無い(Cloudflare の再試行の上限を超えて落ちた)状態を、観測と受付で直す", () => {
  it("検証中・取り込み中: アラームが無ければ、すぐのアラームを張り直す。アラームがあれば触らない", async () => {
    for (const phase of ["verifying", "importing"] as const) {
      const h = harness({ options: { tickQueryLimit: 14 } });
      await upload(h);
      if (phase === "importing") await h.runUntil((s) => s.state === "importing");
      expect(h.core.getStatus().state).toBe(phase);
      h.alarm.at = null; // hard crash で、アラームが失われた
      await h.core.ensureAlarm();
      expect(h.alarm.at, phase).not.toBeNull();
      expect(h.alarm.at!).toBeLessThanOrEqual(h.clock.ms + 1);
      // 対照: 既にあるアラームは上書きしない
      h.alarm.at = h.clock.ms + 123_456;
      await h.core.ensureAlarm();
      expect(h.alarm.at).toBe(h.clock.ms + 123_456);
    }
  });

  it("予算待ち・R2 待ち: アラームが無ければ、再開時刻(resumeAt)に張り直す", async () => {
    const h = harness({ options: { dailyRowLimit: 40 } });
    await upload(h);
    const states = await h.runUntil((s) => s.state === "waiting-budget");
    const resumeAt = Date.parse(states[states.length - 1]!.resumeAt!);
    h.alarm.at = null;
    await h.core.ensureAlarm();
    expect(h.alarm.at).toBe(resumeAt);
  });

  it("完了・失敗・idle: アラームを張らない", async () => {
    const idle = harness();
    await idle.core.ensureAlarm();
    expect(idle.alarm.at).toBeNull();
    const done = harness();
    await upload(done);
    await done.run();
    done.alarm.at = null;
    await done.core.ensureAlarm();
    expect(done.alarm.at).toBeNull();
    const failed = harness();
    await upload(failed, "壊れたファイル");
    await failed.run();
    expect(failed.core.getStatus().state).toBe("failed");
    await failed.core.ensureAlarm();
    expect(failed.alarm.at).toBeNull();
  });

  it("アップロードの受付(start)が busy で断るときも、アラームが無ければ張り直す(409 のまま回復手段が無い状態にしない)", async () => {
    const h = harness({ options: { tickQueryLimit: 14 } });
    await upload(h);
    await h.runUntil((s) => s.state === "importing");
    h.alarm.at = null;
    expect(await h.core.start({ key: "migration/other.ndjson.gz", size: 1 })).toEqual({ accepted: false, reason: "busy" });
    expect(h.alarm.at).not.toBeNull();
    // 張り直したアラームで、取り込みは最後まで進む
    await h.run();
    expect(h.core.getStatus().state).toBe("completed");
  });
});

describe("検証の実績", () => {
  it("検証の実績が status に出る(展開後のバイト数・行数・ミリ秒)", async () => {
    const h = harness();
    await upload(h);
    const [afterVerify] = await h.runUntil((s) => s.state === "importing");
    expect(afterVerify!.verified).toMatchObject({ bytes: new TextEncoder().encode(GOLDEN_TEXT).length, lines: 12 });
    expect(afterVerify!.verified!.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("parseLimitOverride(環境変数による上限の上書き)", () => {
  it.each([
    ["1", 100, 1],
    ["40", 50, 40],
    [" 50 ", 50, 50],
    ["100000", D1_FREE_DAILY_WRITE_ROWS, 100000],
  ])("%j(上限 %d)→ %d", (value, max, expected) => {
    expect(parseLimitOverride(value, max)).toBe(expected);
  });
  it.each([undefined, "", "0", "-1", "1.5", "abc", "1e3", "51", "０５"])("%j → 無視(null)", (value) => {
    expect(parseLimitOverride(value, FREE_QUERIES_PER_INVOCATION)).toBeNull();
  });
  it("Free の枠を超える値は受け付けない(日次 100,001 は null)", () => {
    expect(parseLimitOverride("100001", D1_FREE_DAILY_WRITE_ROWS)).toBeNull();
  });
});

describe("処理前の書き込み行数の見積もり(Issue #309): 上限を超える行は、処理する前に翌日へ回す", () => {
  it("上限 45: 3 件目(見積もり 15 行)を足すと 1 + 16 + 23 + 15 = 55 で超えるので、書く前に止まる(使用量 40、取り込み 2 件)", async () => {
    const h = harness({ options: { dailyRowLimit: 45 } });
    await upload(h);
    const states = await h.runUntil((s) => s.state === "waiting-budget");
    const waiting = states[states.length - 1]!;
    expect(waiting.state).toBe("waiting-budget");
    // 前提: 予算の残りは 5 行(= 45 − 40)あり、`budget.rows >= 上限` だけの判定では止まらない状況
    expect(waiting.budget.usedRows).toBe(1 + 16 + 23);
    expect(waiting.budget.usedRows).toBeLessThan(45);
    expect(await count("analyses")).toBe(2);
  });

  it("上限 45 のまま最後まで進める: どのステップでも使用量は上限以下で、翌日以降に全件が取り込まれる", async () => {
    const h = harness({ options: { dailyRowLimit: 45 } });
    await upload(h);
    const states = await h.run();
    expect(states.filter((s) => s.state === "waiting-budget").length).toBeGreaterThanOrEqual(2);
    for (const s of states) {
      expect(s.budget.usedRows, `${s.state} の時点の使用量`).toBeLessThanOrEqual(45);
    }
    expect(h.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    expect(await count("race_results")).toBe(4);
  });

  it("日の最初の行は、見積もりが上限を超えていても必ず処理する(上限 5): 毎日少なくとも 1 行は進み、最終的に全件が取り込まれる", async () => {
    const h = harness({ options: { dailyRowLimit: 5 } });
    await upload(h);
    const states = await h.run();
    const waits = states.filter((s) => s.state === "waiting-budget");
    // 前提: 実際に毎日待った(上限が効いている)。最初の日は 1 行(分析 1 件)だけ進んで、使用量は上限を超える(1 + 16)
    expect(waits.length).toBeGreaterThanOrEqual(5);
    expect(waits[0]!.analyses.processed).toBe(1);
    expect(waits[0]!.budget.usedRows).toBe(1 + 16);
    expect(waits[0]!.budget.usedRows).toBeGreaterThan(5);
    // 待つたびに、処理済みの行が増えている(日をまたいで空回りしない)
    const progress = waits.map((s) => s.analyses.processed + s.results.processed);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!, `${i} 回目の待ち`).toBeGreaterThan(progress[i - 1]!);
    }
    expect(h.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
    expect(await count("race_results")).toBe(4);
  });

  it("取り込み済みの分析は見積もり 0: 全件が取り込み済みのファイルを再アップロードすると、予算で待たずに最後まで進む(上限 22。式で見積もると分析 2 の 23 行が収まらない)", async () => {
    const first = harness();
    await upload(first);
    await first.run();
    expect(await count("analyses")).toBe(5);
    const again = harness({ options: { dailyRowLimit: 22 } });
    await upload(again, GOLDEN_TEXT, "migration/test-again.ndjson.gz");
    const states = await again.run();
    // 前提: 分析は全件が取り込み済みとして数えられた(式で見積もると、分析 2 は 1 + 23 > 22 で待ってしまう)
    expect(again.core.getStatus().analyses).toMatchObject({ imported: 0, alreadyImported: 5 });
    expect(states.some((s) => s.state === "waiting-budget")).toBe(false);
    expect(again.core.getStatus().state).toBe("completed");
  });

  it("古い保存値(lines が無い)の予算で、その日に既に 30 行使っている: 日の最初の行の例外は使わず、見積もりで翌日に回す(上限 45)", async () => {
    const h = harness({ options: { dailyRowLimit: 45 } });
    h.kv.set("budget", { day: "20261009", rows: 30 });
    await upload(h);
    const states = await h.runUntil((s) => s.state === "waiting-budget");
    // 30 + 1(読み出しの計上)+ 16 = 47 > 45 → 分析 1 を書く前に止まる
    expect(states[states.length - 1]!.state).toBe("waiting-budget");
    expect(await count("analyses")).toBe(0);
    expect(states[states.length - 1]!.budget.usedRows).toBe(31);
  });
});

describe("kv に保存する文字列の長さ(Issue #309): 切り詰めて、先頭の文言は保つ", () => {
  const KV_JOB_MAX_BYTES = 4096;
  const jobBytes = (h: Harness): number => JSON.stringify(h.kv.get("job")).length;
  const fakeAnalyses = (override: Partial<MigrationCoreDeps["analyses"]>): MigrationCoreDeps["analyses"] => {
    const store = new D1AnalysisStore({ db: local.db, bucket: spyBucket(local.r2).bucket, now: () => new Date(T0) });
    return {
      findMigrated: (ids) => store.findMigrated(ids),
      saveMigratedAnalysis: (imp) => store.saveMigratedAnalysis(imp),
      repairDetail: (id, rec) => store.repairDetail(id, rec),
      getR2Usage: () => store.getR2Usage(),
      countR2Read: () => store.countR2Read(),
      ...override,
    };
  };

  it.each([
    ["上限以下はそのまま", "あいう", 5, "あいう"],
    ["ちょうど上限はそのまま", "あいうえお", 5, "あいうえお"],
    ["上限を 1 超えると、先頭 max − 1 文字 + 省略記号", "あいうえおか", 5, "あいうえ…"],
    ["空文字", "", 5, ""],
  ])("clipForKv: %s", (_name, text, max, expected) => {
    expect(clipForKv(text, max)).toBe(expected);
  });

  it("clipForKv: サロゲートペアの途中で切らない(孤立したサロゲートを残さない)。長さは上限以下", () => {
    const text = `a${"😀".repeat(10)}`;
    for (const max of [2, 3, 4, 5, 6]) {
      const out = clipForKv(text, max);
      expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), `max=${max}`).toBe(false);
      expect(out.startsWith("a")).toBe(true);
    }
  });

  it("ヘッダの exportedAt・appVersion が 100 万文字でも、拒否せず取り込み、先頭を保って 64 文字以内に切り詰める", async () => {
    const lines = GOLDEN_TEXT.trimEnd().split("\n");
    const header = JSON.parse(lines[0]!);
    header.exportedAt = `2026-10-09T00:00:00Z-${"y".repeat(1_000_000)}`;
    header.appVersion = `v1.44.0-${"z".repeat(1_000_000)}`;
    const h = harness();
    await upload(h, `${[JSON.stringify(header), ...lines.slice(1)].join("\n")}\n`);
    await h.run();
    const status = h.core.getStatus();
    expect(status.state).toBe("completed");
    expect(status.upload!.exportedAt!.length).toBeLessThanOrEqual(64);
    expect(status.upload!.exportedAt!.startsWith("2026-10-09T00:00:00Z-yyy")).toBe(true);
    expect(status.upload!.appVersion!.length).toBeLessThanOrEqual(64);
    expect(status.upload!.appVersion!.startsWith("v1.44.0-zzz")).toBe(true);
    expect(jobBytes(h)).toBeLessThan(KV_JOB_MAX_BYTES);
  });

  it("対照: 通常のヘッダの値(ISO 日時・版数)は切り詰めない", async () => {
    const h = harness();
    await upload(h);
    await h.run();
    const header = JSON.parse(GOLDEN_TEXT.split("\n")[0]!);
    expect(String(header.exportedAt).length).toBeGreaterThan(10); // 空どうしの比較で一致していない
    expect(h.core.getStatus().upload).toMatchObject({ exportedAt: header.exportedAt, appVersion: header.appVersion });
  });

  it("形式の違反の message が 10 万文字でも、failure.message は 300 文字以内で、先頭の文言を保つ", async () => {
    const analyses = fakeAnalyses({
      saveMigratedAnalysis: async () => {
        throw new MigrationFormatError(`先頭の文言。${"x".repeat(100_000)}`);
      },
    });
    const h = harness({ deps: { analyses } });
    await upload(h);
    await h.run();
    const status = h.core.getStatus();
    expect(status.state).toBe("failed");
    expect(status.failure!.phase).toBe("import");
    expect(status.failure!.message.length).toBeLessThanOrEqual(300);
    expect(status.failure!.message.startsWith("先頭の文言。xxx")).toBe(true);
    expect(jobBytes(h)).toBeLessThan(KV_JOB_MAX_BYTES);
  });

  it("対照: 短い message はそのまま保存する", async () => {
    const h = harness();
    await upload(h, `${GOLDEN_TEXT.trimEnd().split("\n").slice(0, -1).join("\n")}\n`);
    await h.run();
    const message = h.core.getStatus().failure!.message;
    expect(message).toMatch(/フッタ/);
    expect(message.endsWith("…")).toBe(false);
  });

  it("衝突の例(conflictSamples)の raceId・分析日時が極端に長くても、各要素は 300 文字以内で、先頭の文言を保つ", async () => {
    const analyses = fakeAnalyses({
      findMigrated: async (ids) => new Map(ids.map((id) => [id, { id: 9000 + id, raceId: `R${"r".repeat(50_000)}`, analyzedAt: `A${"a".repeat(50_000)}` }])),
    });
    const h = harness({ deps: { analyses } });
    await upload(h);
    await h.run();
    const status = h.core.getStatus();
    expect(status.analyses.conflicts).toBe(5);
    expect(status.conflictSamples.length).toBe(5);
    for (const sample of status.conflictSamples) {
      expect(sample.length).toBeLessThanOrEqual(300);
      expect(sample.startsWith("exe の分析 id ")).toBe(true);
    }
    expect(jobBytes(h)).toBeLessThan(KV_JOB_MAX_BYTES);
  });
});

describe("深い入れ子の JSON 列(Issue #309): 検証の段階で形式の拒否にする", () => {
  const lines = GOLDEN_TEXT.trimEnd().split("\n");
  const DEEP = 5000;
  const nested = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;

  /** 分析の行(race_snapshot_json を持つ最初のもの)の列を差し替えたファイルと、その行番号(1 始まり)。 */
  function withColumn(edit: (obj: any) => void): { text: string; lineNo: number } {
    const index = lines.findIndex((l) => l.includes('"type":"analysis"') && l.includes('"race_snapshot_json":"'));
    expect(index).toBeGreaterThan(0); // 前提: 差し替える行が見つかっている
    const obj = JSON.parse(lines[index]!);
    edit(obj);
    return { text: `${lines.map((l, i) => (i === index ? JSON.stringify(obj) : l)).join("\n")}\n`, lineNo: index + 1 };
  }

  it.each([
    ["race_snapshot_json", (o: any) => void (o.analysis.race_snapshot_json = nested(DEEP))],
    ["contributions_json", (o: any) => void (o.horses[0].contributions_json = nested(DEEP))],
  ])("%s が深さ 5000 の入れ子: failed(phase: verify)。行番号と列名を含み、D1 には何も書かれず、再試行もしない", async (column, edit) => {
    const { text, lineNo } = withColumn(edit);
    const h = harness();
    await upload(h, text);
    await h.run();
    const status = h.core.getStatus();
    expect(status.state).toBe("failed");
    expect(status.failure!.phase).toBe("verify");
    expect(status.failure!.message).toContain(`${lineNo} 行目`);
    expect(status.failure!.message).toContain(column);
    expect(status.attempts).toBeLessThanOrEqual(1);
    expect(await count("analyses")).toBe(0);
    expect(h.files.has(KEY)).toBe(false);
  });

  it("対照: 深さ 50 の入れ子は通り、最後まで取り込まれる(閾値より十分に浅い)", async () => {
    const { text } = withColumn((o) => void (o.analysis.race_snapshot_json = nested(50)));
    const h = harness();
    await upload(h, text);
    await h.run();
    expect(h.core.getStatus().state).toBe("completed");
    expect(await count("analyses")).toBe(5);
  });
});
