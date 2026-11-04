import { afterEach, describe, expect, it } from "vitest";
import { RESULT_RUN_VERSION } from "../../packages/core/src/scraper/race-record-to-runs";
import type { RaceRecord } from "../../packages/core/src/scraper/race-record";
import { DB_SIZE_LIMIT_BYTES, type RaceArchiveCatalogEntry, type ReadRaceArchivesResult } from "../src/race-archive-repository";
import type { ConvertBatchResult, ConvertTarget } from "../src/race-archive-runs";
import {
  ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT,
  ARCHIVE_RUNS_MAX_NIGHTS,
  ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT,
  ARCHIVE_RUNS_READ_COUNT_ROWS,
  RaceArchiveRunsCore,
  isArchiveRunsDisabled,
  type ArchiveRunsOptions,
  type RunsNotice,
} from "../src/race-archive-runs-core";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #590(#549-B3-2): 毎晩の変換の純ロジック `RaceArchiveRunsCore`。偽の目録・偽の読み出し・偽の変換・偽の時計で、
 * 時間帯・1 晩の書き込み行数の上限・走査(カーソル)・失敗の分類・停止と翌晩の自動再開・通知(1 回だけ)・状態を固定する。
 * 本物の D1・R2 の上の動きは race-archive-runs.test.ts(変換)と race-archive-bulk.test.ts(列挙・一括の読み出し)が固定している。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const JST = 9 * HOUR;
/** JST の日付と時刻 → エポックミリ秒。 */
const at = (y: number, mo: number, d: number, h: number, m = 0): number => Date.UTC(y, mo - 1, d, h, m) - JST;
const NIGHT1 = at(2026, 11, 5, 1, 0); // 11/5 1:00 JST(時間帯の開始)
const NIGHT2 = at(2026, 11, 6, 1, 0);

const idOf = (n: number): string => `2021010${String(10000 + n)}`;
const entryOf = (n: number, over: Partial<RaceArchiveCatalogEntry> = {}): RaceArchiveCatalogEntry => ({
  raceId: idOf(n),
  kind: "central",
  raceDate: "2021-11-01",
  parserVersion: 2,
  r2Key: `race-results/${idOf(n)}.json.gz`,
  rawBytes: 1000 + n,
  fetchedAt: "2026-11-01T00:00:00.000Z",
  runsVersion: null,
  ...over,
});

class Harness {
  readonly sql: NodeSql = openNodeSql();
  now = NIGHT1;
  alarm: number | null = null;
  catalog: RaceArchiveCatalogEntry[] = [];
  /** 目録の列挙の呼び出し(カーソルと limit)。 */
  pages: Array<{ after: string; limit: number }> = [];
  reads: string[][] = [];
  converts: ConvertTarget[][] = [];
  notices: RunsNotice[] = [];
  logs: string[] = [];
  /** 読み出しの上書き(レース ID → 結果)。 */
  readOutcome = new Map<string, "missing" | "error">();
  readSkipped = false;
  /** 次の convert が投げる回数。 */
  convertThrows = 0;
  rowsPerRace = 14;
  convertSize: number | null = 24_000_000;
  rejectIds = new Set<string>();
  /** 変換が済み印を付けた扱いにする(目録の runsVersion を更新する)。 */
  markOnConvert = true;
  dbSize: number | null = 24_000_000;
  notifyFailures = 0;
  options: ArchiveRunsOptions = {};
  core: RaceArchiveRunsCore;

  constructor(options: ArchiveRunsOptions = {}) {
    this.options = options;
    this.core = this.makeCore();
  }

  makeCore(): RaceArchiveRunsCore {
    return new RaceArchiveRunsCore(
      {
        sql: this.sql,
        now: () => this.now,
        setAlarm: (t) => {
          this.alarm = t;
        },
        getAlarm: async () => this.alarm,
        archive: {
          listCatalogPage: async (after, limit) => {
            this.pages.push({ after, limit });
            return this.catalog.filter((e) => e.raceId > after).sort((a, b) => (a.raceId < b.raceId ? -1 : 1)).slice(0, limit);
          },
          readRaceArchives: async (ids): Promise<ReadRaceArchivesResult> => {
            this.reads.push([...ids]);
            if (this.readSkipped) return { status: "skipped", reason: "r2-fence" };
            return {
              status: "read",
              items: ids.map((raceId) => {
                const o = this.readOutcome.get(raceId);
                if (o === "missing") return { raceId, outcome: { status: "missing" as const } };
                if (o === "error") return { raceId, outcome: { status: "error" as const } };
                return { raceId, outcome: { status: "found" as const, archive: { format: 1 as const, parserVersion: 2, fetchedAt: "x", html: "", record: { raceId, parserVersion: 2 } as unknown as RaceRecord } } };
              }),
            };
          },
        },
        convert: async (targets): Promise<ConvertBatchResult> => {
          this.converts.push([...targets]);
          if (this.convertThrows > 0) {
            this.convertThrows -= 1;
            throw new Error("D1 down");
          }
          const outcomes = targets.map((t) =>
            this.rejectIds.has(t.raceId)
              ? ({ raceId: t.raceId, status: "rejected" as const, reason: `行数(3)がページの頭数の宣言(5)と合いません` })
              : ({ raceId: t.raceId, status: "converted" as const, runs: this.rowsPerRace, skippedNonStart: 0, skippedNoHorseId: 0 }),
          );
          if (this.markOnConvert) {
            for (const t of targets) {
              const e = this.catalog.find((c) => c.raceId === t.raceId);
              if (e !== undefined) this.catalog[this.catalog.indexOf(e)] = { ...e, runsVersion: RESULT_RUN_VERSION };
            }
          }
          const converted = outcomes.filter((o) => o.status === "converted").length;
          return { outcomes, rowsWritten: converted * this.rowsPerRace + 1, markedRaces: this.markOnConvert ? targets.length : 0, dbSizeBytes: this.convertSize };
        },
        dbSize: async () => this.dbSize,
        catalogCounts: async () => ({ total: this.catalog.length, byVersion: { null: this.catalog.filter((e) => e.runsVersion === null).length } }),
        notify: async (notice) => {
          if (this.notifyFailures > 0) {
            this.notifyFailures -= 1;
            throw new Error("discord down");
          }
          this.notices.push(notice);
        },
        log: (line) => this.logs.push(line),
      },
      this.options,
    );
  }

  seed(count: number, over: (n: number) => Partial<RaceArchiveCatalogEntry> = () => ({})): void {
    this.catalog = Array.from({ length: count }, (_, i) => entryOf(i + 1, over(i + 1)));
  }

  /** アラームを 1 回だけ発火する(時計をアラームの時刻まで進める)。 */
  async fire(): Promise<boolean> {
    if (this.alarm === null) return false;
    this.now = Math.max(this.now, this.alarm);
    this.alarm = null;
    await this.core.runNextStep();
    return true;
  }

  async runUntil(untilMs: number, maxSteps = 3000): Promise<number> {
    let steps = 0;
    while (this.alarm !== null && this.alarm <= untilMs && steps < maxSteps) {
      await this.fire();
      steps += 1;
    }
    return steps;
  }

  convertedIds(): string[] {
    return this.converts.flat().map((t) => t.raceId);
  }
}

let h: Harness;
afterEach(() => h?.sql.close());

describe("設定", () => {
  it("var の判定: 文字列 \"0\" だけが無効(前後の空白は無視)。未設定・空・\"00\"・数でない値は無効にしない", () => {
    expect(isArchiveRunsDisabled("0")).toBe(true);
    expect(isArchiveRunsDisabled(" 0 ")).toBe(true);
    for (const v of [undefined, "", "00", "1", "off", "false"]) expect(isArchiveRunsDisabled(v), String(v)).toBe(false);
  });

  it("既定の 1 晩の書き込み行数は 30,000(Free の 1 日 10 万行の内側。ユーザーの決定)", () => {
    expect(ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT).toBe(30_000);
  });
});

describe("アラーム・時間帯(JST 1:00〜8:30)", () => {
  it("kick: アラームが無ければ次の時間帯の開始に張る。あれば張り直さない。無効なら張らない", async () => {
    h = new Harness();
    h.now = at(2026, 11, 5, 12, 0);
    await h.core.kick();
    expect(h.alarm).toBe(at(2026, 11, 6, 1, 0));
    h.alarm = 123;
    await h.core.kick();
    expect(h.alarm).toBe(123);
    const off = new Harness({ disabled: true });
    await off.core.kick();
    expect(off.alarm).toBeNull();
    off.sql.close();
  });

  it("時間帯の外で起きたら、目録にも R2 にも触れず、次の開始に張る(8:30 ちょうどは外、1:00 ちょうどは中)", async () => {
    h = new Harness();
    h.seed(3);
    h.now = at(2026, 11, 5, 8, 30);
    h.alarm = h.now;
    await h.fire();
    expect(h.alarm).toBe(at(2026, 11, 6, 1, 0));
    expect(h.pages).toEqual([]);
    h.now = at(2026, 11, 5, 0, 59);
    h.alarm = h.now;
    await h.fire();
    expect(h.alarm).toBe(at(2026, 11, 5, 1, 0));
    expect(h.pages).toEqual([]);
    h.now = at(2026, 11, 5, 1, 0);
    h.alarm = h.now;
    await h.fire();
    expect(h.pages.length).toBe(1);
  });

  it("無効のとき、起きても何もしない(アラームを張らない)", async () => {
    h = new Harness({ disabled: true });
    h.seed(3);
    h.alarm = NIGHT1;
    await h.fire();
    expect(h.pages).toEqual([]);
    expect(h.alarm).toBeNull();
    expect((await h.core.getStatus()).state).toBe("disabled");
  });
});

describe("走査と変換", () => {
  it("未変換(runsVersion が null か現行の版より小さい)だけを読んで変換する。変換済み・より新しい版の印は読まない。1 ステップは最大 20 レース", async () => {
    h = new Harness();
    h.catalog = [
      entryOf(1),
      entryOf(2, { runsVersion: RESULT_RUN_VERSION }),
      entryOf(3, { runsVersion: RESULT_RUN_VERSION + 1 }),
      entryOf(4, { runsVersion: RESULT_RUN_VERSION - 1 }),
      ...Array.from({ length: 30 }, (_, i) => entryOf(10 + i)),
    ];
    h.alarm = NIGHT1;
    await h.fire();
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toHaveLength(20); // 前提: 20 件ちょうどが上限
    expect(h.reads[0]!.slice(0, 2)).toEqual([idOf(1), idOf(4)]); // 変換済み(2)・新しい版(3)は飛ばす
    expect(h.converts[0]!.map((t) => t.raceId)).toEqual(h.reads[0]);
    expect(h.converts[0]![0]).toMatchObject({ raceId: idOf(1), rawBytes: 1001, parserVersion: 2 }); // 目録の行の値が、印を付ける条件として渡る
  });

  it("目録の列挙は主キー順のカーソルで続く: 次のステップは前のステップの最後に見た race_id より後から読む。カーソルは DO の再生成後も続く", async () => {
    h = new Harness();
    h.seed(250);
    h.alarm = NIGHT1;
    await h.fire();
    await h.fire();
    expect(h.pages.map((p) => p.after)).toEqual(["", idOf(20)]);
    expect(h.converts.map((c) => c.length)).toEqual([20, 20]);
    expect(h.convertedIds()).toEqual(Array.from({ length: 40 }, (_, i) => idOf(i + 1)));
    // 同じ SQLite の上で別のインスタンスを作っても、カーソルは続く
    h.core = h.makeCore();
    await h.fire();
    expect(h.pages[2]!.after).toBe(idOf(40));
  });

  it("全件を変換すると、状態は caught-up になって 1 時間後に見直す。新しく増えたレースは次の周で拾う", async () => {
    h = new Harness();
    h.seed(45);
    h.alarm = NIGHT1;
    await h.runUntil(NIGHT1 + 3 * HOUR);
    expect(new Set(h.convertedIds()).size).toBe(45);
    expect((await h.core.getStatus()).waitReason).toBe("caught-up");
    const before = h.convertedIds().length;
    expect(h.alarm).not.toBeNull();
    // 取得が進んで、先頭より前の race_id のレースが増えた
    h.catalog.push(entryOf(0));
    await h.runUntil(NIGHT1 + 8 * HOUR);
    expect(h.convertedIds().slice(before)).toEqual([idOf(0)]);
  });

  it("周の終わりで何も変換しなかったときだけ休む(1 時間)。変換があった周のあとは続けて見直す", async () => {
    h = new Harness();
    h.seed(25);
    h.alarm = NIGHT1;
    await h.fire(); // 20 件
    await h.fire(); // 5 件 + 末尾(周の終わりは同じステップか次のステップ)
    let guard = 0;
    while ((await h.core.getStatus()).waitReason !== "caught-up" && guard < 10) {
      await h.fire();
      guard += 1;
    }
    expect((await h.core.getStatus()).waitReason).toBe("caught-up");
    expect(h.alarm! - h.now).toBe(HOUR);
  });

  it("1 晩の書き込み行数の上限に達したら、その晩はもう読まない。次の晩の開始に張る。次の晩は続きから", async () => {
    h = new Harness({ nightlyRows: 600 });
    h.seed(200);
    h.rowsPerRace = 14; // 1 ステップ = 変換 20×14+1 = 281 行 + Class B の計数 1 行 = 282 行
    expect(ARCHIVE_RUNS_READ_COUNT_ROWS).toBe(1);
    h.alarm = NIGHT1;
    await h.fire();
    await h.fire();
    expect((await h.core.getStatus()).night.rows).toBe(564);
    await h.fire(); // 562 < 600: もう 1 ステップ(上限を超えるのは最後の 1 ステップぶんだけ)
    expect((await h.core.getStatus()).night.rows).toBe(846);
    const readsSoFar = h.reads.length;
    await h.fire();
    expect(h.reads.length).toBe(readsSoFar); // 上限に達したので読まない
    expect((await h.core.getStatus()).waitReason).toBe("night-limit");
    expect(h.alarm).toBe(NIGHT2);
    await h.fire();
    expect(h.reads.length).toBe(readsSoFar + 1);
    expect(h.reads[h.reads.length - 1]![0]).toBe(idOf(61)); // 続きから
    expect((await h.core.getStatus()).night.rows).toBe(282); // 晩が変わったので数え直す
  });

  it("上限は下げる方向の上書きだけ: nightlyRows を指定すればそれが上限。指定が無ければ既定", async () => {
    h = new Harness({ nightlyRows: 1 });
    h.seed(100);
    h.alarm = NIGHT1;
    await h.fire();
    await h.fire();
    expect(h.reads).toHaveLength(1);
    expect((await h.core.getStatus()).nightlyRowLimit).toBe(1);
    h.sql.close();
    h = new Harness();
    expect((await h.core.getStatus()).nightlyRowLimit).toBe(ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT);
  });

  it("拒否されたレースは書かずに印を付けた扱い: 理由の分類ごとに数え、再試行しない(失敗に数えない)", async () => {
    h = new Harness();
    h.seed(5);
    h.rejectIds = new Set([idOf(2)]);
    h.alarm = NIGHT1;
    await h.runUntil(NIGHT1 + 2 * HOUR);
    const s = await h.core.getStatus();
    expect(s.rejectedByClass).toEqual({ "count-mismatch": 1 });
    expect(s.night.failed).toBe(0);
    expect(h.convertedIds().filter((id) => id === idOf(2))).toHaveLength(1); // 一度だけ
  });

  it("印が付かなかったレース(目録が変換の途中で更新された)は、その周では再試行せず、次の周で読み直す。無限に回らない", async () => {
    h = new Harness();
    h.seed(3);
    h.markOnConvert = false;
    h.alarm = NIGHT1;
    await h.runUntil(NIGHT1 + 3 * HOUR, 200);
    expect(h.alarm).not.toBeNull();
    expect(h.converts.length).toBeLessThan(10); // 打ち切りの 200 ステップまで回り続けていない
    expect((await h.core.getStatus()).waitReason).toBe("caught-up");
  });
});

describe("失敗(R2 の読み出し・変換)", () => {
  it("R2 の get の失敗・R2 に無い: そのレースだけ失敗に数え、今夜はもう試さない(ほかは変換する)。3 晩で諦める", async () => {
    h = new Harness();
    h.seed(3);
    h.readOutcome = new Map([[idOf(2), "error"]]);
    h.alarm = NIGHT1;
    await h.runUntil(NIGHT1 + 3 * HOUR);
    expect(h.convertedIds().sort()).toEqual([idOf(1), idOf(3)]);
    const read = (): number => h.reads.flat().filter((id) => id === idOf(2)).length;
    expect(read()).toBe(1); // 今夜は 1 回だけ
    expect((await h.core.getStatus()).night.failed).toBe(1);
    // 2 晩目・3 晩目に試し、4 晩目は試さない
    for (let night = 2; night <= ARCHIVE_RUNS_MAX_NIGHTS + 1; night += 1) {
      h.alarm = at(2026, 11, 4 + night, 1, 0);
      await h.runUntil(at(2026, 11, 4 + night, 8, 0));
    }
    expect(read()).toBe(ARCHIVE_RUNS_MAX_NIGHTS);
    expect((await h.core.getStatus()).gaveUp).toBe(1);
  });

  it("「R2 に無い」(missing)も失敗に数える(取得の保存は R2 → D1 の順なので通常は起きない)", async () => {
    h = new Harness();
    h.seed(2);
    h.readOutcome = new Map([[idOf(1), "missing"]]);
    h.alarm = NIGHT1;
    await h.runUntil(NIGHT1 + 3 * HOUR);
    expect(h.convertedIds()).toEqual([idOf(2)]);
    expect((await h.core.getStatus()).failing).toBe(1);
  });

  it("変換の batch が失敗: 1 件ずつに切り分ける(次のステップは 1 レースだけ)。失敗が続くレースは失敗に数え、ほかのレースは進む", async () => {
    h = new Harness();
    h.seed(5);
    h.alarm = NIGHT1;
    h.convertThrows = 1;
    await h.fire(); // 5 件をまとめて変換 → 失敗
    expect(h.converts[0]).toHaveLength(5);
    expect((await h.core.getStatus()).night.rows).toBe(0);
    await h.fire(); // 1 件ずつ
    expect(h.converts[1]).toHaveLength(1);
    await h.runUntil(NIGHT1 + 3 * HOUR);
    expect(new Set(h.convertedIds()).size).toBe(5);
    // 成功のあとは、また複数をまとめる
    h.catalog.push(...Array.from({ length: 4 }, (_, i) => entryOf(50 + i)));
    await h.runUntil(NIGHT1 + 6 * HOUR);
    expect(h.converts[h.converts.length - 1]!.length).toBe(4);
  });

  it("1 件だけの変換が失敗し続ける: そのレースは失敗に数え(今夜は再試行しない)、ほかのレースは変換される", async () => {
    h = new Harness();
    h.seed(3);
    h.alarm = NIGHT1;
    h.convertThrows = 1000; // 常に失敗
    await h.fire();
    await h.fire();
    h.convertThrows = 0;
    await h.runUntil(NIGHT1 + 3 * HOUR);
    expect((await h.core.getStatus()).night.failed).toBeGreaterThanOrEqual(1);
  });

  it(`失敗が連続 ${ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT} 件で今夜は止める(9 件では止めない)。通知は 1 回。次の晩は自動で再開する`, async () => {
    h = new Harness();
    h.seed(500);
    h.alarm = NIGHT1;
    h.convertThrows = ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT - 1;
    for (let i = 0; i < ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT - 1; i += 1) await h.fire();
    expect(h.notices).toEqual([]);
    expect((await h.core.getStatus()).state).toBe("running");
    await h.fire(); // 10 件目は成功 → 連続が切れる
    h.convertThrows = ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT;
    for (let i = 0; i < ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT; i += 1) await h.fire();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ kind: "failures", count: ARCHIVE_RUNS_CONSECUTIVE_FAILURE_LIMIT });
    const s = await h.core.getStatus();
    expect(s.state).toBe("stopped");
    expect(s.stopReason).toBe("failures");
    expect(h.alarm).toBe(NIGHT2);
    const readsBefore = h.reads.length;
    h.convertThrows = 0;
    await h.fire();
    expect(h.reads.length).toBeGreaterThan(readsBefore); // 次の晩は普通に動く
    expect((await h.core.getStatus()).state).toBe("running");
  });
});

describe("止まり方と通知", () => {
  it("D1 の大きさが上限を超えた(変換の結果の size_after): その場で止めて通知する。次の晩に大きさを読み直し、まだ超えていれば止まったまま(通知は繰り返さない)。下回れば再開する", async () => {
    h = new Harness();
    h.seed(200);
    h.alarm = NIGHT1;
    h.convertSize = DB_SIZE_LIMIT_BYTES + 1;
    await h.fire();
    const s = await h.core.getStatus();
    expect(s.state).toBe("stopped");
    expect(s.stopReason).toBe("capacity");
    expect(h.notices).toEqual([expect.objectContaining({ kind: "capacity", dbSizeBytes: DB_SIZE_LIMIT_BYTES + 1 })]);
    expect(h.alarm).toBe(NIGHT2);
    // 次の晩: まだ超えている
    h.dbSize = DB_SIZE_LIMIT_BYTES + 5;
    const reads = h.reads.length;
    await h.fire();
    expect(h.reads.length).toBe(reads);
    expect((await h.core.getStatus()).state).toBe("stopped");
    expect(h.notices).toHaveLength(1);
    expect(h.alarm).toBe(at(2026, 11, 7, 1, 0));
    // 3 日目: 下回った
    h.dbSize = 30_000_000;
    h.convertSize = 30_000_000;
    await h.fire();
    expect(h.reads.length).toBeGreaterThan(reads);
    expect((await h.core.getStatus()).state).toBe("running");
  });

  it("D1 の大きさが読めない(null)間は止まったまま(安全側)。ちょうど上限なら動く(超えたら止める)", async () => {
    h = new Harness();
    h.seed(200);
    h.alarm = NIGHT1;
    h.convertSize = DB_SIZE_LIMIT_BYTES; // ちょうど = 超えていない
    await h.fire();
    expect((await h.core.getStatus()).state).toBe("running");
    h.convertSize = DB_SIZE_LIMIT_BYTES + 1;
    await h.fire();
    expect((await h.core.getStatus()).stopReason).toBe("capacity");
    h.dbSize = null;
    await h.fire(); // 次の晩
    expect((await h.core.getStatus()).state).toBe("stopped");
  });

  it("R2 の柵(Class B)に達した: R2 を引かずに止めて通知する(1 回だけ)。次の晩に確かめ直し、まだ柵なら止まったまま通知は繰り返さない。解けたら再開", async () => {
    h = new Harness();
    h.seed(100);
    h.alarm = NIGHT1;
    h.readSkipped = true;
    await h.fire();
    expect(h.converts).toEqual([]);
    expect(h.notices).toEqual([expect.objectContaining({ kind: "r2-fence" })]);
    expect((await h.core.getStatus()).stopReason).toBe("r2-fence");
    expect(h.alarm).toBe(NIGHT2);
    await h.fire(); // 次の晩: まだ柵 → 1 回確かめて止まる
    expect(h.reads).toHaveLength(2);
    expect(h.notices).toHaveLength(1);
    h.readSkipped = false;
    await h.fire();
    expect(h.converts.length).toBeGreaterThan(0);
    expect((await h.core.getStatus()).state).toBe("running");
  });

  it("成功すると通知済みの印を消す: 柵で止まる(通知)→ 次の晩に再開して成功 → また柵で止まる、は再び通知する", async () => {
    h = new Harness();
    h.seed(300);
    h.alarm = NIGHT1;
    h.readSkipped = true;
    await h.fire(); // 1 晩目: 止まって通知(1 通目)
    h.readSkipped = false;
    await h.fire(); // 2 晩目: 再開して成功
    expect(h.converts.length).toBe(1); // 前提: 実際に成功している
    h.readSkipped = true;
    h.alarm = at(2026, 11, 7, 1, 0);
    await h.fire(); // 3 晩目: また柵
    expect(h.notices.filter((n) => n.kind === "r2-fence")).toHaveLength(2);
  });

  it("通知の送信が失敗したら 10 分後に再送し、3 回で諦める(状態は変わらない)", async () => {
    h = new Harness();
    h.seed(100);
    h.alarm = NIGHT1;
    h.readSkipped = true;
    h.notifyFailures = 100;
    await h.fire(); // 止まって 1 回目の送信失敗
    expect(h.notices).toEqual([]);
    expect(h.alarm).toBe(NIGHT1 + 10 * MIN); // 再送のために 10 分後
    await h.fire(); // 2 回目の失敗
    await h.fire(); // 3 回目の失敗 → 諦める
    h.notifyFailures = 0;
    await h.fire();
    expect(h.notices).toEqual([]); // 諦めたので再送されない
    expect((await h.core.getStatus()).state).toBe("stopped");
  });
});

describe("DO の書き込みを増やさない・状態の読み取り", () => {
  it("変わらない値は書かない: 同じ状態の読み取りは DO の SQLite に書き込み文を出さない", async () => {
    h = new Harness();
    h.seed(40);
    h.alarm = NIGHT1;
    await h.fire();
    const before = h.sql.statements.length;
    await h.core.getStatus();
    await h.core.getStatus();
    expect(h.sql.statements.slice(before).filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s))).toEqual([]);
  });

  it("状態: 目録の件数(総数・版ごと)・今夜の数・次の実行・カーソル・上限を返す。D1 の大きさは直近の値", async () => {
    h = new Harness();
    h.seed(30);
    h.alarm = NIGHT1;
    await h.fire();
    const s = await h.core.getStatus();
    expect(s).toMatchObject({
      state: "running",
      night: { date: "2026-11-05", rows: 20 * 14 + 1 + 1, races: 20, failed: 0 },
      catalog: { total: 30 },
      nightlyRowLimit: ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT,
      dbSizeBytes: 24_000_000,
      cursor: idOf(20),
    });
    expect(s.nextRunAt).toBe(h.alarm);
    expect(s.catalog.byVersion).toEqual({ null: 10 });
  });
});

describe("DO の SQLite: 起床の経路の SQL は表の全部を読まない(EXPLAIN QUERY PLAN。#593 の事故を踏まえた決まり)", () => {
  /** 文の中の ? の数。 */
  const placeholders = (q: string): number => (q.match(/\?/g) ?? []).length;
  const plan = (q: string): string[] => (h.sql.exec(`EXPLAIN QUERY PLAN ${q}`, ...Array.from({ length: placeholders(q) }, () => null)).toArray() as Array<{ detail: string }>).map((r) => r.detail);

  it("起床のたびに流れる SQL(状態の読み取りを除く)のすべてが主キーの SEARCH で、SCAN も一時 B-tree(並べ替え・グループ化)も使わない。対照: 状態の読み取りの数え上げは SCAN になる", async () => {
    h = new Harness();
    h.seed(80);
    h.rejectIds = new Set([idOf(3)]);
    h.readOutcome = new Map([[idOf(5), "error"], [idOf(6), "missing"]]);
    h.alarm = NIGHT1;
    h.convertThrows = 1; // まとめの失敗 → 1 件ずつ
    await h.runUntil(NIGHT1 + 3 * HOUR); // 失敗・拒否・周の終わり・休みを通る
    h.convertSize = DB_SIZE_LIMIT_BYTES + 1; // 容量で止まる → 次の晩に確かめる(通知も送る)
    h.catalog.push(entryOf(500));
    h.alarm = NIGHT2;
    await h.fire();
    h.dbSize = 1;
    h.alarm = at(2026, 11, 7, 1, 0);
    await h.fire();

    const wake = [...new Set(h.sql.statements)].filter((q) => /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(q) && !q.startsWith("EXPLAIN"));
    expect(wake.length).toBeGreaterThanOrEqual(8); // 前提: 経路の SQL を実際に集められている(空なら下の検査が空振り)
    const tables = wake.filter((q) => /rr_(meta|fail|reject)/.test(q));
    expect(tables.length).toBe(wake.length); // 前提: 集めた文はすべて DO の状態の表への文
    for (const q of wake) {
      const rows = plan(q);
      if (!/^\s*INSERT/i.test(q)) expect(rows.length, q).toBeGreaterThan(0); // INSERT ... ON CONFLICT は読む表が無く、計画の行が空
      for (const detail of rows) {
        expect(detail, q).not.toMatch(/\bSCAN\b/);
        expect(detail, q).not.toMatch(/TEMP B-TREE/);
      }
    }
    // 前提の確認: 失敗の記録・拒否の記録・メタの 3 つの表すべてに触れる文が含まれている
    for (const table of ["rr_meta", "rr_fail", "rr_reject"]) expect(wake.some((q) => q.includes(table)), table).toBe(true);

    // 対照: 状態の読み取りの数え上げ(getStatus だけが流す)は SCAN / TEMP B-TREE になる。検出が空振りでないことの確認
    expect(plan("SELECT COUNT(*) AS n FROM rr_fail WHERE nights < ?").join("|")).toMatch(/\bSCAN\b/);
    expect(plan("SELECT class AS cls, COUNT(*) AS n FROM rr_reject GROUP BY class").join("|")).toMatch(/TEMP B-TREE|SCAN/);
    // 状態の読み取りの文は、起床の経路の集合に入っていない(getStatus を呼んでいないので、集合にこれらが無い)
    expect(wake.some((q) => q.includes("GROUP BY") || q.includes("nights <"))).toBe(false);
  });

  it("1 ステップが DO の SQLite に書く行数は、20 レースの変換で 10 行以下(カーソル・今夜の数・累計・周の数・D1 の大きさ。変わらない値は書かない)", async () => {
    h = new Harness();
    h.seed(100);
    h.alarm = NIGHT1;
    await h.fire(); // 初回(キーの作成を含む)
    const before = h.sql.statements.length;
    await h.fire();
    const writes = h.sql.statements.slice(before).filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q));
    expect(h.converts).toHaveLength(2); // 前提: 2 回目も実際に変換している
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.length).toBeLessThanOrEqual(10);
  });
});
