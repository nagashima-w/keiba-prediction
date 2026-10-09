import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore } from "../src/race-day-core";
import { ResultBackfillCore, type BackfillDayStub, type BackfillOptions } from "../src/result-backfill-core";
import { D1ResultStore } from "../src/result-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #217(#167-C): 結果の補完の結合テスト。**本物の `ResultBackfillCore`・本物の `RaceDayCore`(開催日ごと。`node:sqlite`)・本物の D1(ローカルの workerd)**を繋ぎ、
 * gate・移行の状態・時計だけを偽物にする(netkeiba には出ない。結果ページは保存済みのフィクスチャ)。補完が日単位の DO に依頼 → DO が取得・保存 → 補完が回収、までを通す。
 * 守ること: 未取込のレースの結果が D1 に入る・1 晩の上限と時間帯・飛行中は常に 1 チャンク(gate に並ぶ呼び出しは同時に 1 本)・取得できないレースは記録して翌晩以降に再び取得しない・開催日不明は対象外で件数だけ。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULT_HTML = readFileSync(path.join(ROOT, "fixtures", "result_202603020211.html"), "utf-8");
const EMPTY_HTML = "<html><body></body></html>";
const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};

const JST = 9 * 3600_000;
const jst = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour, minute) - JST;
/** 検証を通る中央のレースID(年 + 場コード 05 + 日 + 0 + 0 + レース番号)。 */
const idOf = (day: number, race: number): string => `2026${"05"}${String(day).padStart(2, "0")}00${String(race).padStart(2, "0")}`;

let local: LocalBindings;
const opened: NodeSql[] = [];
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

async function addAnalysis(raceId: string, kaisaiDate: string | null, i: number): Promise<void> {
  await local.db
    .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)")
    .bind(raceId, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, kaisaiDate)
    .run();
}

interface Alarm {
  at: number | null;
}

function world(startAt: number, options: { badRaceIds?: ReadonlySet<string>; backfill?: BackfillOptions } = {}) {
  const clock = { now: startAt };
  const gate: GateLike & { inFlight: number; maxInFlight: number; urls: string[] } = {
    inFlight: 0,
    maxInFlight: 0,
    urls: [],
    async fetchRaw(url: string): Promise<GateResult> {
      gate.inFlight += 1;
      gate.maxInFlight = Math.max(gate.maxInFlight, gate.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      gate.inFlight -= 1;
      gate.urls.push(url);
      const bad = [...(options.badRaceIds ?? [])].some((id) => url.includes(id));
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(bad ? EMPTY_HTML : RESULT_HTML), queuedMs: 0, elapsedMs: 1 };
    },
  };
  const days = new Map<string, { core: RaceDayCore; alarm: Alarm }>();
  const stubFor = (date: string): BackfillDayStub => {
    let entry = days.get(date);
    if (entry === undefined) {
      const sql = openNodeSql();
      opened.push(sql);
      const alarm: Alarm = { at: null };
      entry = {
        alarm,
        core: new RaceDayCore({ sql, now: () => clock.now, gate, setAlarm: (at) => void (alarm.at = at), onWarn: () => undefined, resultStore: new D1ResultStore({ db: local.db }) }),
      };
      days.set(date, entry);
    }
    return entry.core as unknown as BackfillDayStub;
  };
  const backfillAlarm: Alarm = { at: null };
  const sql = openNodeSql();
  opened.push(sql);
  const migration = { state: "completed" as "completed" | "importing" };
  const core = new ResultBackfillCore(
    {
      sql,
      now: () => clock.now,
      setAlarm: (at) => void (backfillAlarm.at = at),
      getAlarm: async () => backfillAlarm.at,
      migrationState: async () => migration.state,
      gateStatus: async () => ({ blockedUntil: null, pending: 0 }),
      store: new D1ResultStore({ db: local.db }),
      stubFor,
      log: () => undefined,
      onWarn: () => undefined,
    },
    options.backfill ?? {},
  );

  /** アラームを時刻順に動かす(補完と全日の DO を、時計を進めながら)。`until` までに起きるものだけ。 */
  async function run(until: number, maxSteps = 400): Promise<number> {
    let steps = 0;
    for (; steps < maxSteps; steps += 1) {
      const candidates: Array<{ at: number; fire: () => Promise<void>; clear: () => void }> = [];
      if (backfillAlarm.at !== null) candidates.push({ at: backfillAlarm.at, fire: () => core.runNextStep(), clear: () => (backfillAlarm.at = null) });
      for (const { core: day, alarm } of days.values()) {
        if (alarm.at !== null) candidates.push({ at: alarm.at, fire: () => day.runNextStep().then(() => undefined), clear: () => (alarm.at = null) });
      }
      candidates.sort((a, b) => a.at - b.at);
      const next = candidates[0];
      if (next === undefined || next.at > until) break;
      next.clear();
      clock.now = Math.max(clock.now, next.at);
      await next.fire();
    }
    return steps;
  }
  return { clock, gate, days, core, backfillAlarm, migration, run };
}

const savedRaceIds = async (): Promise<string[]> =>
  ((await local.db.prepare("SELECT DISTINCT race_id AS id FROM race_results ORDER BY race_id").all<{ id: string }>()).results ?? []).map((r) => r.id);

describe("結果の補完の結合(本物の補完 + 本物の日単位の DO + 本物の D1。gate は偽物)", () => {
  it("未取込の過去のレースの結果が、夜間に D1 へ入る。取り込み済み・今日以降・開催日不明は取得しない。飛行中は常に 1 チャンクなので gate に並ぶ呼び出しは同時に 1 本", async () => {
    // 20261008: 3 レース / 20261007: 1 レース / 20261001: 1 レース(5 レースが対象)。今日(20261010)の 1 レースと、開催日不明の 1 レースは対象外。取り込み済みの 1 レースは取得しない。
    const targets = [idOf(8, 1), idOf(8, 2), idOf(8, 3), idOf(7, 1), idOf(1, 1)];
    await addAnalysis(idOf(8, 1), "20261008", 1);
    await addAnalysis(idOf(8, 2), "20261008", 2);
    await addAnalysis(idOf(8, 3), "20261008", 3);
    await addAnalysis(idOf(7, 1), "20261007", 4);
    await addAnalysis(idOf(1, 1), "20261001", 5);
    await addAnalysis(idOf(10, 1), "20261010", 6); // 今日
    await addAnalysis(idOf(5, 1), null, 7); // 開催日不明
    await addAnalysis(idOf(6, 1), "20261006", 8);
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES (?, 1, 1)").bind(idOf(6, 1)).run(); // 取り込み済み
    const w = world(jst(10, 10, 2));
    await w.core.kick();
    expect(w.backfillAlarm.at).toBe(w.clock.now); // 窓の中なので今
    const steps = await w.run(jst(10, 11, 0, 59));
    expect(steps).toBeGreaterThan(5); // 前提: 実際に動いた(空振りでない)
    expect(await savedRaceIds()).toEqual([...targets, idOf(6, 1)].sort());
    expect(w.gate.urls).toHaveLength(5); // 5 レース × 1 リクエスト。取り込み済み・今日・開催日不明は取得しない
    expect(w.gate.urls.every((u) => targets.some((id) => u.includes(id)))).toBe(true);
    expect(w.gate.maxInFlight).toBe(1);
    expect([...w.days.keys()].sort()).toEqual(["20261001", "20261007", "20261008"]); // 対象の日の DO だけを開く
    const status = await w.core.getStatus();
    expect(status).toMatchObject({ state: "done", remaining: 0, undated: 1, imported: 5, abandoned: { total: 0 } });
    expect(status.tonight).toMatchObject({ night: "20261010", dispatched: 5, limit: 150 });
    expect(w.backfillAlarm.at).toBe(jst(10, 11, 1)); // 翌晩の窓の開始(未取込が尽きたあとも、毎晩見に来る)
  });

  it("取得できない(中身が空のページ)レースは記録して除外し、翌晩以降に再び取得しない。他のレースは取り込まれる", async () => {
    const bad = idOf(8, 2);
    await addAnalysis(idOf(8, 1), "20261008", 1);
    await addAnalysis(bad, "20261008", 2);
    await addAnalysis(idOf(8, 3), "20261008", 3);
    const w = world(jst(10, 10, 2), { badRaceIds: new Set([bad]) });
    await w.core.kick();
    await w.run(jst(10, 11, 0, 59));
    expect(await savedRaceIds()).toEqual([idOf(8, 1), idOf(8, 3)]);
    const status = await w.core.getStatus();
    expect(status.imported).toBe(2);
    expect(status.abandoned.total).toBe(1);
    expect(Object.keys(status.abandoned.byClass)).toHaveLength(1);
    expect(["parse-error", "not-confirmed", "no-payout"]).toContain(Object.keys(status.abandoned.byClass)[0]);
    expect(status.remaining).toBe(0); // 除外したレースは残りに数えない
    const fetchedBad = w.gate.urls.filter((u) => u.includes(bad)).length;
    expect(fetchedBad).toBeGreaterThanOrEqual(1);
    expect(fetchedBad).toBeLessThanOrEqual(3); // 日単位の DO の 3 試行まで
    // 翌晩・翌々晩: 除外したレースは取得しない。
    for (const day of [11, 12]) {
      w.clock.now = jst(10, day, 2);
      await w.core.kick();
      await w.run(jst(10, day + 1, 0, 59));
    }
    expect(w.gate.urls.filter((u) => u.includes(bad)).length).toBe(fetchedBad);
  });

  it("1 晩の上限(下げた値 4・1 回 2 レース)に達したら止まり、翌晩に続きから取り込む。1 チャンクは 1 つの開催日だけ", async () => {
    for (let r = 1; r <= 3; r += 1) await addAnalysis(idOf(8, r), "20261008", r);
    for (let r = 1; r <= 3; r += 1) await addAnalysis(idOf(7, r), "20261007", 10 + r);
    const w = world(jst(10, 10, 2), { backfill: { nightlyLimit: 4, chunkSize: 2 } });
    await w.core.kick();
    await w.run(jst(10, 11, 0, 59));
    // 1 晩目: 20261008 の 2 + 1(1 つの開催日だけなので 2・1)、20261007 の 1(上限 4 の残り)。
    expect(await savedRaceIds()).toEqual([idOf(7, 1), idOf(8, 1), idOf(8, 2), idOf(8, 3)]);
    expect(w.gate.urls).toHaveLength(4);
    expect(w.gate.maxInFlight).toBe(1);
    expect((await w.core.getStatus()).state).toBe("waiting-window");
    expect(w.backfillAlarm.at).toBe(jst(10, 11, 1));
    // 翌晩: 続き(20261007 の残り 2 レース)。
    w.clock.now = jst(10, 11, 1, 5);
    await w.run(jst(10, 12, 0, 59));
    expect(await savedRaceIds()).toHaveLength(6);
    expect(w.gate.urls).toHaveLength(6);
    expect(await w.core.getStatus()).toMatchObject({ state: "done", imported: 6, remaining: 0 });
  });

  it("移行が完了していない間は取得しない(importing)。完了したら始まる", async () => {
    await addAnalysis(idOf(8, 1), "20261008", 1);
    const w = world(jst(10, 10, 2));
    w.migration.state = "importing";
    await w.core.kick();
    await w.run(jst(10, 10, 5)); // 窓の中の 3 時間のあいだ、30 分おきに見直すだけ
    expect(w.gate.urls).toEqual([]);
    expect(await savedRaceIds()).toEqual([]);
    w.migration.state = "completed";
    await w.run(jst(10, 10, 5, 59));
    expect(await savedRaceIds()).toEqual([idOf(8, 1)]);
  });
});
