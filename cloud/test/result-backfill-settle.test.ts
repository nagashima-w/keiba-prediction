import { afterEach, describe, expect, it } from "vitest";

import { BACKFILL_ERROR_RETRY_MS, BACKFILL_POLL_MS, ResultBackfillCore, type BackfillDayStub, type BackfillStore } from "../src/result-backfill-core";
import type { ResultImportProgress } from "../src/race-day-core";
import type { UnimportedRace } from "../src/result-repository";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #597: 補完の DO(`ResultBackfillCore`)と D1 の状態(`race_backfill`)の間の、済み・諦めの写しと整合検査。
 *  - 写し: DO の記録(`backfill_race`・`backfill_class`・`backfill_payout`)の済み・諦めを、段階ごとの D1 の状態に写す。**写されるまで列挙しない**。失敗したら次のステップが全部を写し直す
 *  - 増分の写し: 取り込み・諦めのたびに、段階ごとの規則(下の表)で写す
 *  - 整合検査: 1 晩 1 回、最初のステップで。食い違いの件数が 0 でなければ警告に出す。失敗しても補完は続ける
 * D1 の側は偽物(呼び出しを記録するだけ)。DO の SQLite は本物の SQLite(`node:sqlite`)。D1 の状態そのものの検証は `result-backfill-state.test.ts`。
 */

const JST = 9 * 3600_000;
const jst = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour, minute) - JST;
const T0 = jst(10, 10, 2);
const YESTERDAY = "20261009";
const idOf = (date: string, n: number): string => `2026${"05"}${date.slice(6, 8)}${String(Math.floor((n - 1) / 12)).padStart(2, "0")}${String(((n - 1) % 12) + 1).padStart(2, "0")}`;
const race = (n: number): UnimportedRace => ({ raceId: idOf(YESTERDAY, n), kaisaiDate: YESTERDAY });

type Stage = 1 | 2 | 3 | 4;
type SettleCall = Array<{ stage: Stage; raceIds: string[] }>;

class Fake {
  now = T0;
  alarm: number | null = null;
  /** 段階ごとの対象(列挙で返す)。依頼が済んだら呼び出し側が空にする。 */
  pending: Record<Stage, UnimportedRace[]> = { 1: [], 2: [], 3: [], 4: [] };
  /** 呼び出しの記録(順序つき)。 */
  log: string[] = [];
  settleCalls: SettleCall[] = [];
  settleFail = 0; // この回数だけ settleBackfill を失敗させる
  reconcileCalls = 0;
  reconcileArgs: Array<string | undefined> = [];
  reconcileResult: number | Error = 0;
  warns: string[] = [];
  infos: string[] = [];
  dayRows = new Map<string, { state: "queued" | "imported" | "gave_up"; lastClass: string | null }>();

  store: BackfillStore = {
    listBackfillRaces: async ({ limit }) => (this.log.push("list1"), this.pending[1].slice(0, limit)),
    countBackfill: async () => ({ dated: 0, undated: 0 }),
    listWinOddsBackfillRaces: async ({ limit }) => (this.log.push("list2"), this.pending[2].slice(0, limit)),
    countWinOddsBackfill: async () => ({ dated: 0, undated: 0, scratchedMissing: 0 }),
    listClassBackfillRaces: async ({ limit }) => (this.log.push("list3"), this.pending[3].slice(0, limit)),
    countClassBackfill: async () => ({ dated: 0, undated: 0, stillNull: 0 }),
    listPayoutBackfillRaces: async ({ limit }) => (this.log.push("list4"), this.pending[4].slice(0, limit)),
    countPayoutBackfill: async () => ({ dated: 0, undated: 0, stillNull: 0 }),
    settleBackfill: async (stages) => {
      this.log.push("settle");
      if (this.settleFail > 0) {
        this.settleFail -= 1;
        throw new Error("D1 SECRET-SETTLE");
      }
      this.settleCalls.push(stages.map((s) => ({ stage: s.stage, raceIds: [...s.raceIds] })));
      return { 1: 0, 2: 0, 3: 0, 4: 0 };
    },
    reconcileBackfillState: async (since?: string) => {
      this.log.push("reconcile");
      this.reconcileArgs.push(since);
      this.reconcileCalls += 1;
      if (this.reconcileResult instanceof Error) throw this.reconcileResult;
      return this.reconcileResult;
    },
  };

  stubFor = (): BackfillDayStub =>
    ({
      requestResultImport: async ({ raceIds }: { raceIds: readonly string[] }) => {
        for (const id of raceIds) this.dayRows.set(id, { state: "queued", lastClass: null });
        return { accepted: raceIds.length, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } };
      },
      getResultImportProgress: async (): Promise<ResultImportProgress> => {
        const races = [...this.dayRows].map(([raceId, r]) => ({ raceId, state: r.state, attempts: 0, deferrals: 0, requestedOn: "20261010", nextTryAt: null, lastClass: r.lastClass as never, updatedAt: 0 }));
        return { total: races.length, queued: races.filter((r) => r.state === "queued").length, imported: 0, gaveUp: 0, races };
      },
    }) as unknown as BackfillDayStub;
}

let opened: NodeSql[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  opened = [];
});

function make(w: Fake, sql: NodeSql = openNodeSql()): { core: ResultBackfillCore; sql: NodeSql } {
  if (!opened.includes(sql)) opened.push(sql);
  const core = new ResultBackfillCore({
    sql,
    now: () => w.now,
    setAlarm: (at) => void (w.alarm = at),
    getAlarm: async () => w.alarm,
    gateStatus: async () => ({ blockedUntil: null, pending: 0 }),
    store: w.store,
    stubFor: w.stubFor,
    log: (line) => w.infos.push(line),
    onWarn: (m) => w.warns.push(m),
  });
  return { core, sql };
}

const seed = (sql: NodeSql, table: "backfill_race" | "backfill_class" | "backfill_payout", raceId: string, state: string, lastNight = "20261001"): void =>
  void sql.exec(`INSERT INTO ${table} (race_id, nights, defers, last_night, last_class, state) VALUES (?, 1, 0, ?, 'x', ?)`, raceId, lastNight, state);

describe("初回の写し: DO の記録の済み・諦めを、段階ごとの規則で D1 の状態に写す。写されるまで列挙しない", () => {
  it("段階 1 = abandoned / 段階 2 = odds_abandoned・fill_done / 段階 3 = odds_abandoned・class_abandoned・class_done / 段階 4 = odds_abandoned・class_abandoned・payout_abandoned・payout_done。旧い odds_done・tried は写さない", async () => {
    const w = new Fake();
    const { core, sql } = make(w);
    const [A, B, C, D, E, F, G, H, I] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => idOf(YESTERDAY, n));
    seed(sql, "backfill_race", A!, "abandoned");
    seed(sql, "backfill_race", B!, "odds_abandoned");
    seed(sql, "backfill_race", C!, "fill_done");
    seed(sql, "backfill_race", D!, "odds_done"); // 旧い印: 写さない
    seed(sql, "backfill_race", E!, "odds_tried"); // 試しただけ: 写さない
    seed(sql, "backfill_class", F!, "class_abandoned");
    seed(sql, "backfill_class", G!, "class_done");
    seed(sql, "backfill_payout", H!, "payout_abandoned");
    seed(sql, "backfill_payout", I!, "payout_done");
    w.pending[1] = [race(20)];
    await core.runNextStep();
    // 設定の確認(空振り防止): 写しは 1 回で、列挙より前に呼ばれ、列挙は実際に行われた
    expect(w.settleCalls).toHaveLength(1);
    expect(w.log.indexOf("settle")).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf("settle")).toBeLessThan(w.log.indexOf("list1"));
    const byStage = Object.fromEntries(w.settleCalls[0]!.map((c) => [c.stage, c.raceIds]));
    expect(byStage).toEqual({
      1: [A],
      2: [B, C].sort(),
      3: [B, F, G].sort(),
      4: [B, F, H, I].sort(),
    });
    // 件数の記録(本番での確認用)は固定の形で、レース ID を含まない。
    const line = w.infos.find((l) => l.includes("d1-settled-synced"));
    expect(line).toBeDefined();
    expect(line).toContain("stage1=1/0");
    expect(line).toContain("stage4=4/0");
    expect(line).not.toContain(A!);
  });

  it("写しが失敗する間は列挙しない(10 分後に再試行)。成功したら列挙する。写したあとの 2 回目以降のステップは写さない", async () => {
    const w = new Fake();
    w.settleFail = 1;
    w.pending[1] = [race(1)];
    const { core } = make(w);
    await core.runNextStep();
    expect(w.log).toEqual(["settle"]); // 列挙も整合検査も流れない
    expect(w.alarm).toBe(T0 + BACKFILL_ERROR_RETRY_MS);
    expect(w.warns.some((m) => m.includes("step failed"))).toBe(true);
    expect(w.warns.join("\n")).not.toContain("SECRET");
    w.now = T0 + BACKFILL_ERROR_RETRY_MS;
    await core.runNextStep();
    expect(w.log.filter((l) => l === "settle")).toHaveLength(2);
    expect(w.log).toContain("list1");
    const settles = w.log.filter((l) => l === "settle").length;
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.log.filter((l) => l === "settle")).toHaveLength(settles); // 印が立ったので、以後は全量の写しをしない
  });

  it("写しの印は DO の SQLite に残る: 新しいインスタンス(同じ SQLite)は全量の写しをやり直さない", async () => {
    const w = new Fake();
    const first = make(w);
    await first.core.runNextStep();
    expect(w.settleCalls).toHaveLength(1);
    const second = make(w, first.sql);
    w.now += BACKFILL_POLL_MS;
    await second.core.runNextStep();
    expect(w.settleCalls).toHaveLength(1);
  });
});

describe("増分の写し: 取り込み・諦めのたびに、段階ごとの規則で写す(Q6: 失敗したら次のステップが全量を写し直す)", () => {
  // [段階の名前, 段階, 取り込めたとき写す段階, 永久に諦めたとき写す段階]
  const cases: Array<[string, Stage, Stage[], Stage[]]> = [
    ["段階 1(結果の取り込み)", 1, [], [1]],
    ["段階 2(オッズ・scratched)", 2, [2], [2, 3, 4]],
    ["段階 3(クラス)", 3, [3], [3, 4]],
    ["段階 4(単勝の払戻)", 4, [4], [4]],
  ];

  async function run(stage: Stage, outcome: "imported" | "gave_up"): Promise<{ w: Fake; sql: NodeSql }> {
    const w = new Fake();
    const r = race(1);
    const other = race(2); // 同じチャンクで取り込めるレース(取り込みが 0 件で失敗が全件同じ分類だと、系統的な障害として一時的な扱いになり諦めない)
    w.pending[stage] = [r, other];
    const { core, sql } = make(w);
    await core.runNextStep(); // 初回の全量の写し → 列挙 → 依頼
    expect(w.dayRows.get(r.raceId)?.state).toBe("queued"); // 前提: 依頼された
    w.settleCalls.length = 0;
    w.pending[stage] = []; // 取り込めたら D1 の条件から外れる(諦めたときも、その晩は再列挙されない)
    w.dayRows.set(other.raceId, { state: "imported", lastClass: "imported" });
    w.dayRows.set(r.raceId, outcome === "imported" ? { state: "imported", lastClass: "imported" } : { state: "gave_up", lastClass: "not-confirmed" });
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 回収
    return { w, sql };
  }

  it.each(cases)("%s: 取り込めたとき", async (_name, stage, expectedStages) => {
    const { w } = await run(stage, "imported");
    const written = w.settleCalls.flat();
    expect(written.map((c) => c.stage).sort()).toEqual([...expectedStages].sort());
    for (const c of written) expect(c.raceIds).toEqual([idOf(YESTERDAY, 1), idOf(YESTERDAY, 2)]); // 取り込めた 2 レース
  });

  it.each(cases)("%s: 永久に諦めたとき(not-confirmed)。同じチャンクで取り込めたレースは、取り込めたときの規則で写る", async (_name, stage, importedStages, expectedStages) => {
    const { w } = await run(stage, "gave_up");
    const written = w.settleCalls.flat();
    const byStage = new Map<Stage, string[]>();
    for (const s of expectedStages) byStage.set(s, [...(byStage.get(s) ?? []), idOf(YESTERDAY, 1)]);
    for (const s of importedStages) byStage.set(s, [...(byStage.get(s) ?? []), idOf(YESTERDAY, 2)]);
    expect(written.map((c) => c.stage).sort()).toEqual([...byStage.keys()].sort());
    for (const c of written) expect(c.raceIds).toEqual(byStage.get(c.stage)!.sort());
  });

  it("一時的な失敗(fetch-failed。まだ諦めない)は写さない", async () => {
    const w = new Fake();
    const r = race(1);
    w.pending[1] = [r];
    const { core } = make(w);
    await core.runNextStep();
    w.settleCalls.length = 0;
    w.pending[1] = [];
    w.dayRows.set(r.raceId, { state: "gave_up", lastClass: "fetch-failed" });
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.settleCalls).toEqual([]);
  });

  it("不正なレース(invalid-race)は依頼の前に諦め、同じステップで写す", async () => {
    const w = new Fake();
    w.pending[1] = [{ raceId: "12345", kaisaiDate: YESTERDAY }];
    const { core } = make(w);
    await core.runNextStep(); // 全量の写し(空)→ 列挙 → 不正な 1 件を諦める
    expect(w.settleCalls.flat().find((c) => c.stage === 1 && c.raceIds.includes("12345"))).toBeDefined();
  });

  it("増分の写しが失敗すると settle_dirty が残り、次のステップが DO の記録の全量を写し直す(写し直したら dirty を下ろす)", async () => {
    const w = new Fake();
    const r = race(1);
    w.pending[1] = [r, race(2)];
    const { core, sql } = make(w);
    await core.runNextStep(); // 初回の全量の写し(成功)→ 依頼
    w.settleCalls.length = 0;
    w.pending[1] = [];
    w.dayRows.set(race(2).raceId, { state: "imported", lastClass: "imported" }); // 1 つは取り込めた(系統的な障害ではない)
    w.dayRows.set(r.raceId, { state: "gave_up", lastClass: "not-confirmed" });
    const dirty = (): string | undefined => (sql.exec("SELECT value FROM backfill_meta WHERE key = 'settle_dirty'").toArray() as Array<{ value: string }>)[0]?.value;
    w.settleFail = 2; // 増分の写しも、続く全量の写し直しも失敗させる
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep(); // 回収(諦め)→ 増分の写しの失敗は握る → 全量の写し直しも失敗 → ステップの失敗(10 分後に再試行)
    expect(w.warns.some((m) => m.includes("settle flush failed"))).toBe(true);
    expect(dirty()).toBe("1"); // 写せていない印が残る
    expect(w.settleCalls).toEqual([]);
    expect(w.alarm).toBe(w.now + BACKFILL_ERROR_RETRY_MS);
    w.now += BACKFILL_ERROR_RETRY_MS;
    await core.runNextStep(); // 次のステップ: 全量を写し直す(成功)
    const full = w.settleCalls[0]!;
    expect(full.find((c) => c.stage === 1)?.raceIds).toEqual([r.raceId]); // DO の abandoned の全量
    expect(dirty()).toBeUndefined();
  });

  it("増分の写しだけが失敗したときは、同じステップの中で続けて全量を写し直す(次の晩まで待たない)", async () => {
    const w = new Fake();
    const r = race(1);
    w.pending[1] = [r, race(2)];
    const { core } = make(w);
    await core.runNextStep();
    w.settleCalls.length = 0;
    w.pending[1] = [];
    w.dayRows.set(race(2).raceId, { state: "imported", lastClass: "imported" });
    w.dayRows.set(r.raceId, { state: "gave_up", lastClass: "not-confirmed" });
    w.settleFail = 1; // 増分の写しだけ失敗
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.settleCalls).toHaveLength(1); // 全量の写し直し
    expect(w.settleCalls[0]!.find((c) => c.stage === 1)?.raceIds).toEqual([r.raceId]);
  });
});

describe("整合検査: 1 晩 1 回、最初のステップで(写しのあと・列挙の前)", () => {
  it("同じ晩の 2 回目以降のステップでは流さず、翌晩にまた流す。順序は 写し → 整合検査 → 列挙", async () => {
    const w = new Fake();
    w.pending[1] = Array.from({ length: 90 }, (_, i) => race(i + 1)); // 30 件ずつ 3 チャンク = 3 ステップで依頼する(待ち行列は最初のステップで 1 回だけ作る)
    const { core } = make(w);
    await core.runNextStep();
    expect(w.log.slice(0, 3)).toEqual(["settle", "reconcile", "list1"]);
    for (let i = 0; i < 2; i += 1) {
      for (const row of w.dayRows.values()) row.state = "imported"; // 回収できるようにして、次のステップが列挙の段階まで進むようにする
      w.now += BACKFILL_POLL_MS;
      await core.runNextStep();
    }
    expect(w.dayRows.size).toBe(90); // 前提(空振り防止): 3 ステップとも依頼まで進んだ
    expect(w.reconcileCalls).toBe(1);
    w.now = jst(10, 11, 2);
    await core.runNextStep();
    expect(w.reconcileCalls).toBe(2);
  });

  it("直した行数が 0 でなければ警告に出す(件数だけ。書き込みの経路が再計算を呼んでいない兆し)。0 なら警告なし", async () => {
    const drifted = new Fake();
    drifted.reconcileResult = 3;
    await make(drifted).core.runNextStep();
    expect(drifted.warns).toContain("result-backfill: race_backfill drift fixed scope=full count=3");

    const clean = new Fake();
    clean.reconcileResult = 0;
    await make(clean).core.runNextStep();
    expect(clean.warns.filter((m) => m.includes("drift"))).toEqual([]);
    expect(clean.infos.some((l) => l.includes("reconciled scope=full drift=0"))).toBe(true);
  });

  it("整合検査が失敗しても補完は続ける(警告に出し、印は立てない=次のステップでやり直す)", async () => {
    const w = new Fake();
    w.reconcileResult = new Error("D1 SECRET-RECONCILE");
    w.pending[1] = [race(1)];
    const { core } = make(w);
    await core.runNextStep();
    expect(w.log).toContain("list1"); // 列挙まで進んだ
    expect(w.dayRows.size).toBe(1); // 依頼された
    expect(w.warns.some((m) => m.includes("reconcile failed"))).toBe(true);
    expect(w.warns.join("\n")).not.toContain("SECRET");
    w.reconcileResult = 0;
    for (const row of w.dayRows.values()) row.state = "imported"; // 回収できるようにする(飛行中のままだと次のステップは進行を見るだけ)
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(w.reconcileCalls).toBe(2); // 印が立たなかったので次のステップでやり直した
  });
});

describe("整合検査の範囲: 全件は前回の全件から 7 晩以上たったとき、それ以外は直近 14 日(Issue #614)", () => {
  /** 指定の晩(10 月 d 日の 2 時台 JST。夜 = 202610dd)に 1 ステップ進める。 */
  const stepOn = async (core: ResultBackfillCore, w: Fake, day: number): Promise<void> => {
    w.now = jst(10, day, 2);
    await core.runNextStep();
  };

  it("初回は全件(引数なし)、2〜7 晩目は直近 14 日、前回の全件から 7 晩後に全件。6 晩後は直近", async () => {
    const w = new Fake();
    const { core } = make(w);
    await stepOn(core, w, 1);
    await stepOn(core, w, 2);
    await stepOn(core, w, 7); // 全件の 6 晩後
    await stepOn(core, w, 8); // 7 晩後
    await stepOn(core, w, 9);
    expect(w.reconcileArgs).toEqual([undefined, "20260918", "20260923", undefined, "20260925"]);
  });

  it("検査が失敗した晩は全件をしたことにしない(翌ステップでまた全件)", async () => {
    const w = new Fake();
    w.reconcileResult = new Error("D1 SECRET");
    const { core } = make(w);
    await stepOn(core, w, 1);
    w.reconcileResult = 0;
    await stepOn(core, w, 1);
    await stepOn(core, w, 2);
    expect(w.reconcileArgs).toEqual([undefined, undefined, "20260918"]);
  });

  it("ログと警告にどちらの検査かが出る", async () => {
    const w = new Fake();
    w.reconcileResult = 3;
    const { core } = make(w);
    await stepOn(core, w, 1);
    w.reconcileResult = 0;
    await stepOn(core, w, 2);
    expect(w.warns).toContain("result-backfill: race_backfill drift fixed scope=full count=3");
    expect(w.infos.some((l) => l.includes("reconciled scope=recent drift=0"))).toBe(true);
  });
});

describe("開催日が NULL の分析に開催日を入れる段(Issue #630)", () => {
  type FillResult = { races: number; analyses: number; undecided: number };
  /** 偽の Store に fillNullKaisaiDates を差す(既定の Fake には無い=従来の Store と同じ)。呼び出しを log に残す。 */
  function withFill(w: Fake, result: FillResult | Error): { calls: () => number } {
    let calls = 0;
    w.store.fillNullKaisaiDates = async () => {
      w.log.push("fill-kaisai");
      calls += 1;
      if (result instanceof Error) throw result;
      return result;
    };
    return { calls: () => calls };
  }

  it("順序は 写し → 開催日の補完 → 整合検査 → 列挙。件数 3 つ(レース・分析・決められず)をログに出し、警告は出さない", async () => {
    const w = new Fake();
    withFill(w, { races: 7, analyses: 11, undecided: 2 });
    w.pending[1] = [race(1)];
    await make(w).core.runNextStep();
    expect(w.log.slice(0, 4)).toEqual(["settle", "fill-kaisai", "reconcile", "list1"]);
    expect(w.infos).toContain("result-backfill: kaisai_date filled races=7 analyses=11 undecided=2");
    expect(w.warns.filter((m) => m.includes("kaisai_date"))).toEqual([]);
  });

  it("1 晩 1 回(同じ晩の 2 回目のステップでは呼ばない)。翌晩にまた呼ぶ(NULL が残っていても次の晩に試す)", async () => {
    const w = new Fake();
    const fill = withFill(w, { races: 0, analyses: 0, undecided: 3 });
    w.pending[1] = Array.from({ length: 90 }, (_, i) => race(i + 1));
    const { core } = make(w);
    await core.runNextStep();
    for (let i = 0; i < 2; i += 1) {
      for (const row of w.dayRows.values()) row.state = "imported";
      w.now += BACKFILL_POLL_MS;
      await core.runNextStep();
    }
    expect(w.dayRows.size).toBe(90); // 前提(空振り防止): 3 ステップとも進んだ
    expect(fill.calls()).toBe(1);
    w.now = jst(10, 11, 2);
    await core.runNextStep();
    expect(fill.calls()).toBe(2);
  });

  it("失敗しても補完は続ける(警告に出し、秘密を含めず、印は立てない=次のステップでやり直す)", async () => {
    const w = new Fake();
    const fill = withFill(w, new Error("D1 SECRET-FILL"));
    w.pending[1] = [race(1)];
    const { core } = make(w);
    await core.runNextStep();
    expect(w.log).toContain("list1"); // 前提: 失敗の後も列挙まで進んだ
    expect(w.warns.some((m) => m.startsWith("result-backfill: kaisai_date fill failed"))).toBe(true);
    expect(w.warns.join("\n")).not.toContain("SECRET-FILL");
    expect(w.dayRows.size).toBeGreaterThan(0); // 前提: 依頼まで進んだ(飛行中のチャンクがある)
    for (const row of w.dayRows.values()) row.state = "imported";
    w.now += BACKFILL_POLL_MS;
    await core.runNextStep();
    expect(fill.calls()).toBe(2);
  });

  it("fillNullKaisaiDates を持たない Store では何もしない", async () => {
    const w = new Fake();
    w.pending[1] = [race(1)];
    await make(w).core.runNextStep();
    expect(w.log).not.toContain("fill-kaisai");
    expect(w.infos.filter((l) => l.includes("kaisai_date"))).toEqual([]);
  });
});
