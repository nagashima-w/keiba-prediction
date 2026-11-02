import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RETRY_DELAY_MS, RaceDayCore, type AnalysisSink, type RaceDayDeps, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #566: 地方の交流重賞以外のレースも、事前分析(morning)が完了したら発走前の分析(pre_race)を自動で始める。
 * 完了の時点で計画の行を足し、中央と同じ期限・すぐ実行・スキップの判定(`planPreRaceDue`。offset は設定の値)に乗せる。地方の普通のレースの morning は自動では積まない。
 * 地方の対象は実フィクスチャの 202654071210(高知・開催 2026-07-12・10R「ファイナルレース(C1)」・発走 20:50・12 頭)。中央の対照は 202603020211(開催 2026-06-28・発走 15:45)。
 * ゲートは偽(出馬表・戦績・オッズ・一覧はフィクスチャ)、ストレージは `node:sqlite`。実 netkeiba には触れない。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");

const NAR_ID = "202654071210";
const NAR_DATE = "20260712";
const jstNar = (time: string): number => Date.parse(`2026-07-12T${time}:00+09:00`);
const NAR_START = jstNar("20:50");
const CENTRAL_ID = "202603020211";
const CENTRAL_DATE = "20260628";

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const httpError = (): GateResult => ({ kind: "response", status: 500, contentType: "text/html; charset=UTF-8", body: bytes("error"), queuedMs: 0, elapsedMs: 1 });

/** 地方の一覧(合成。1 行だけ。実物のマークアップの最小の写し)。 */
function narListHtml(raceId: string, name: string, time: string, grade?: string): string {
  const gradeMarkup = grade === undefined ? "" : `<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType19 Icon_GradePos01">${grade}</span>`;
  return `<dl class="RaceList_DataList">
<dt class="RaceList_DataHeader"><p class="RaceList_DataTitle"><small>1回</small> 高知 <small>1日目</small></p></dt>
<dd class="RaceList_Data"><ul>
<li class="RaceList_DataItem">
<a href="../race/shutuba.html?race_id=${raceId}&rf=race_list">
<div class="Race_Num"><span>10R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle"><span class="ItemTitle">${name}</span>${gradeMarkup}</div>
<div class="RaceData"><span>${time}</span><span class="Dart">ダ1400m</span>12頭</div>
</div>
</a>
</li>
</ul></dd>
</dl>`;
}
const EMPTY_HTML = "<html><body></body></html>";

interface FakeGate extends GateLike {
  readonly urls: string[];
  narList: { html: string; calls: number; failures: GateResult[] };
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    narList: { html: EMPTY_HTML, calls: 0, failures: [] },
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) {
        gate.narList.calls += 1;
        return gate.narList.failures.shift() ?? ok(gate.narList.html);
      }
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) {
        return ok(EMPTY_HTML);
      }
      if (url.includes("shutuba.html") && url.includes(NAR_ID)) return ok(fixture(`nar_shutuba_${NAR_ID}.html`));
      if (url.includes("nar.netkeiba.com") && /type=b1/.test(url)) return ok(fixture(`nar_odds_b1_${NAR_ID}.html`));
      return ok(fixtureForUrl(url));
    },
  };
  return gate;
}

const unusedSink: AnalysisSink = {
  save: async () => {
    throw new Error("保存先は使わない");
  },
  findByAnalyzedAt: async () => {
    throw new Error("保存先は使わない");
  },
  findRecentByRace: async () => {
    throw new Error("保存先は使わない");
  },
  countChildren: async () => {
    throw new Error("保存先は使わない");
  },
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  /** 設定すると、DO の SQL の実行の前に呼ばれる(故障注入。投げれば、その文は実行されない)。 */
  fault: ((query: string) => void) | null;
}
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(startMs: number, offsetMinutes = 45, overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: startMs };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const gate = fakeGate();
  const h = { sql, gate, clock, alarm, warnings, fault: null } as Harness;
  const core = new RaceDayCore({
    sql: {
      exec(query, ...bindings) {
        h.fault?.(query);
        return sql.exec(query, ...bindings);
      },
    },
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink: unusedSink,
    loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: offsetMinutes }),
    ...overrides,
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);
async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}

/** 手動で事前分析(morning)を予約し、完了(取得 → 計算)まで進める。 */
async function runMorning(h: Harness, raceId: string, date: string): Promise<string[]> {
  await h.core.schedule({ raceId, kaisaiDate: date, mode: "morning" });
  return [await tick(h), await tick(h)];
}

interface PlanRow {
  race_id: string;
  venue: string;
  venue_name: string | null;
  race_number: number | null;
  race_name: string | null;
  start_time: string | null;
  start_ms: number | null;
  due_ms: number | null;
  offset_minutes: number;
  disposition: string;
  skip_reason: string | null;
  state: string;
  promoted_at: number | null;
}
const planRows = (h: Harness): PlanRow[] =>
  h.sql
    .exec("SELECT race_id, venue, venue_name, race_number, race_name, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, promoted_at FROM race_day_plan ORDER BY race_id")
    .toArray() as PlanRow[];
const taskRows = (h: Harness): { race_id: string; mode: string; status: string }[] =>
  h.sql.exec("SELECT race_id, mode, status FROM race_day_tasks ORDER BY race_id, mode").toArray() as { race_id: string; mode: string; status: string }[];
const autoMarks = (h: Harness): string[] => (h.sql.exec("SELECT race_id FROM race_day_auto_pre_race ORDER BY race_id").toArray() as { race_id: string }[]).map((r) => r.race_id);

describe("地方の普通のレースの事前分析が完了したら、計画の行を足す(Issue #566)", () => {
  it("期限前(9:00 に完了): scheduled の行が足される。値は出馬表から(高知・10R・20:50 発走・期限=発走−45 分=20:05)。未依頼の日でも足され、アラームは期限に張られる", async () => {
    const h = harness(jstNar("09:00"));
    expect(await runMorning(h, NAR_ID, NAR_DATE)).toEqual([`${NAR_ID}:morning:fetch:ok`, `${NAR_ID}:morning:compute:ok`]);
    expect(taskRows(h)).toEqual([{ race_id: NAR_ID, mode: "morning", status: "done" }]);
    const rows = planRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      race_id: NAR_ID,
      venue: "nar",
      venue_name: "高知",
      race_number: 10,
      race_name: "ファイナルレース(C1)",
      start_time: "20:50",
      start_ms: NAR_START,
      due_ms: jstNar("20:05"),
      offset_minutes: 45,
      disposition: "scheduled",
      skip_reason: null,
      state: "planned",
      promoted_at: null,
    });
    expect(h.alarm.at).toBe(jstNar("20:05"));
  });

  it("offset は設定の値(30 分)に従う: 期限=20:20", async () => {
    const h = harness(jstNar("09:00"), 30);
    await runMorning(h, NAR_ID, NAR_DATE);
    expect(planRows(h)[0]).toMatchObject({ offset_minutes: 30, due_ms: jstNar("20:20"), disposition: "scheduled" });
  });

  it("期限に起きると pre_race が積まれ(自動の印つき)、行は promoted になる(確定・依頼の無い日でも昇格する)", async () => {
    const h = harness(jstNar("09:00"));
    await runMorning(h, NAR_ID, NAR_DATE);
    h.clock.now = jstNar("20:05");
    h.alarm.at = jstNar("20:05");
    // 取得ステップ(ネットワーク)まで進む。昇格は runNextStep の先頭で行われる
    expect(await tick(h)).toBe(`${NAR_ID}:pre_race:fetch:ok`);
    expect(taskRows(h).map((t) => `${t.mode}:${t.status}`)).toEqual(["morning:done", "pre_race:fetched"]);
    expect(autoMarks(h)).toEqual([NAR_ID]);
    expect(planRows(h)[0]).toMatchObject({ state: "promoted", promoted_at: jstNar("20:05") });
  });

  it("期限を過ぎて完了(20:30。発走まで 20 分): immediate の行が足され、次のステップで pre_race が積まれる", async () => {
    const h = harness(jstNar("20:30"));
    await runMorning(h, NAR_ID, NAR_DATE);
    expect(planRows(h)[0]).toMatchObject({ disposition: "immediate", state: "planned", due_ms: jstNar("20:05") });
    expect(await tick(h)).toBe(`${NAR_ID}:pre_race:fetch:ok`);
    expect(autoMarks(h)).toEqual([NAR_ID]);
    expect(planRows(h)[0]).toMatchObject({ state: "promoted" });
  });

  it.each([
    ["発走まで 10 分未満(20:45。too-late)", "20:45"],
    ["発走済み(21:00。started)", "21:00"],
  ])("%s: 行を足さない(skipped の行も残さない)。pre_race も積まない", async (_name, time) => {
    const h = harness(jstNar(time));
    await runMorning(h, NAR_ID, NAR_DATE);
    expect(taskRows(h)).toEqual([{ race_id: NAR_ID, mode: "morning", status: "done" }]);
    expect(planRows(h)).toEqual([]);
    expect(autoMarks(h)).toEqual([]);
  });

  it("すでに計画の行があるレースは、足し直さず・変えない(最初の計画のまま)", async () => {
    const h = harness(jstNar("09:00"));
    const nowMs = h.clock.now;
    // 先に別の計画の行(offset 99・skipped)を書いておく
    h.sql.exec(
      `INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at)
       VALUES (?, 'nar', '高知', 10, '先の計画', NULL, '20:50', ?, NULL, 99, 'skip', 'manual', 'skipped', ?, NULL)`,
      NAR_ID,
      NAR_START,
      nowMs,
    );
    await runMorning(h, NAR_ID, NAR_DATE);
    const rows = planRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ race_name: "先の計画", offset_minutes: 99, state: "skipped", skip_reason: "manual" });
  });

  it("中央のレースの事前分析が完了しても、行は足さない(中央の動きは変えない)", async () => {
    const h = harness(Date.parse("2026-06-28T09:00:00+09:00"));
    expect(await runMorning(h, CENTRAL_ID, CENTRAL_DATE)).toEqual([`${CENTRAL_ID}:morning:fetch:ok`, `${CENTRAL_ID}:morning:compute:ok`]);
    expect(planRows(h)).toEqual([]);
  });

  it("地方の普通のレースの morning は、計画の確定でも自動では積まれない。手動で完了したあとに行が足されても、morning は 1 件のまま", async () => {
    const h = harness(jstNar("09:00"));
    h.gate.narList.html = narListHtml(NAR_ID, "ファイナルレース(C1)", "20:50"); // グレード無し = 普通のレース
    expect(await h.core.requestPlan({ kaisaiDate: NAR_DATE })).toMatchObject({ accepted: true });
    expect([await tick(h), await tick(h), await tick(h)]).toEqual(["central:plan:list:ok", "nar:plan:list:ok", "plan:plan:finalize:ok"]);
    // 前提: 地方の一覧に普通のレースが 1 件あったが、計画の行も morning も無い
    expect(h.gate.narList.calls).toBe(1);
    expect(planRows(h)).toEqual([]);
    expect(taskRows(h)).toEqual([]);
    // 手動の morning が完了すると行が足される。morning は手動の 1 件だけ
    await runMorning(h, NAR_ID, NAR_DATE);
    expect(taskRows(h)).toEqual([{ race_id: NAR_ID, mode: "morning", status: "done" }]);
    expect(planRows(h).map((r) => [r.race_id, r.state, r.disposition])).toEqual([[NAR_ID, "planned", "scheduled"]]);
    // 確定済みの日では期限に昇格する
    h.clock.now = jstNar("20:05");
    h.alarm.at = jstNar("20:05");
    expect(await tick(h)).toBe(`${NAR_ID}:pre_race:fetch:ok`);
    expect(taskRows(h).map((t) => `${t.mode}:${t.status}`)).toEqual(["morning:done", "pre_race:fetched"]);
  });

  it("依頼済みで未確定の日は、期限が過ぎた planned の行があっても昇格しない(確定を待つ。G-C3)。未依頼の日との違いはこの 1 点だけ", async () => {
    const h = harness(jstNar("20:10"));
    await h.core.requestPlan({ kaisaiDate: NAR_DATE }); // 会場の一覧の取得はまだ = 依頼済みで未確定
    h.sql.exec(
      `INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at)
       VALUES (?, 'nar', '高知', 10, 'x', NULL, '20:50', ?, ?, 45, 'scheduled', NULL, 'planned', ?, NULL)`,
      NAR_ID,
      NAR_START,
      jstNar("20:05"),
      jstNar("09:00"),
    );
    // 前提: 期限は過ぎていて、確定の印は無い
    expect(h.sql.exec("SELECT value FROM race_day_meta WHERE key = 'plan_finalized_at'").toArray()).toEqual([]);
    expect(label(await h.core.runNextStep())).toBe("central:plan:list:ok"); // 先に進むのは計画の段階(一覧)。昇格ではない
    expect(taskRows(h).filter((t) => t.mode === "pre_race")).toEqual([]);
    expect(planRows(h)[0]).toMatchObject({ state: "planned", promoted_at: null });
  });
});

describe("公開の時点で完了済みの分の見回し(アラームのたび。Issue #566)", () => {
  /** 事前分析が done 済みで計画の行が無い状態(公開の前に手動で走らせたレース)を作る。 */
  function doneWithoutPlan(h: Harness, raceId: string, date: string): void {
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", date);
    h.sql.exec(
      `INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok)
       VALUES (?, 'morning', 'done', 1, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      raceId,
      h.clock.now,
      h.clock.now,
    );
  }

  it("done で行の無い地方のレースを、一覧(発走時刻・レース名)から拾って行を足す。足した行は期限で昇格する", async () => {
    const h = harness(jstNar("09:00"));
    h.gate.narList.html = narListHtml(NAR_ID, "一覧のレース名", "20:50");
    doneWithoutPlan(h, NAR_ID, NAR_DATE);
    await h.core.runNextStep();
    expect(h.gate.narList.calls).toBe(1);
    expect(planRows(h)).toHaveLength(1);
    expect(planRows(h)[0]).toMatchObject({
      race_id: NAR_ID,
      venue: "nar",
      venue_name: "高知",
      race_number: 10,
      race_name: "一覧のレース名",
      start_ms: NAR_START,
      due_ms: jstNar("20:05"),
      offset_minutes: 45,
      disposition: "scheduled",
      state: "planned",
    });
    expect(h.alarm.at).toBe(jstNar("20:05"));
    // 足したあとは該当が無いので、次の起床では一覧を取りに行かない
    await h.core.runNextStep();
    expect(h.gate.narList.calls).toBe(1);
  });

  it("該当(done で行の無い地方のレース)が無いときは、一覧を取りに行かない。中央の done も対象外", async () => {
    const h = harness(jstNar("09:00"));
    doneWithoutPlan(h, CENTRAL_ID, NAR_DATE);
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.gate.narList.calls).toBe(0);
    expect(h.gate.urls.filter((u) => u.includes("race_list_sub"))).toEqual([]);
    expect(planRows(h)).toEqual([]);
  });

  it("一覧の取得に失敗しても例外にしない。間隔(再試行の間隔)をあけて取り直し、取れたら行を足す", async () => {
    const h = harness(jstNar("09:00"));
    h.gate.narList.html = narListHtml(NAR_ID, "一覧のレース名", "20:50");
    h.gate.narList.failures = [httpError(), httpError(), httpError(), httpError()];
    doneWithoutPlan(h, NAR_ID, NAR_DATE);
    await expect(h.core.runNextStep()).resolves.toBeDefined();
    expect(planRows(h)).toEqual([]);
    const callsAfterFirst = h.gate.narList.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // 間隔の内では取り直さない
    h.clock.now += RETRY_DELAY_MS - 1;
    await h.core.runNextStep();
    expect(h.gate.narList.calls).toBe(callsAfterFirst);
    // 間隔を過ぎると取り直す(失敗の残りが尽きるまで繰り返してよいので、成功するまで時計を進める)
    for (let i = 0; i < 6 && planRows(h).length === 0; i++) {
      h.clock.now += RETRY_DELAY_MS;
      await h.core.runNextStep();
    }
    expect(planRows(h).map((r) => r.race_id)).toEqual([NAR_ID]);
  });

  it("一覧に無いレース・発走済みのレースは足さない(例外にもならない)", async () => {
    const h = harness(jstNar("21:30"));
    h.gate.narList.html = narListHtml("202654071211", "別のレース", "20:50");
    doneWithoutPlan(h, NAR_ID, NAR_DATE);
    await expect(h.core.runNextStep()).resolves.toBeDefined();
    expect(planRows(h)).toEqual([]);
  });

  it("見回しの SQL が失敗しても、runNextStep は投げない(足す機能の失敗で、既存のステップを止めない)。警告を出す", async () => {
    const h = harness(jstNar("09:00"));
    doneWithoutPlan(h, NAR_ID, NAR_DATE);
    h.fault = (query) => {
      if (query.includes("LEFT JOIN race_day_plan")) throw new Error("SQL の故障");
    };
    await expect(h.core.runNextStep()).resolves.toBeDefined();
    expect(planRows(h)).toEqual([]);
    expect(h.warnings.some((w) => w.includes("SQL の故障"))).toBe(true);
  });

  it("過去の開催日の DO では見回さない: 発走済みで行を足せなかった morning done が残っても、掃除専用の起床で一覧を取らず、掃除の予約を延ばさず、掃除が走る", async () => {
    const nextDay = Date.parse("2026-07-14T09:00:00+09:00"); // 開催日(20260712)の 2 日後
    const h = harness(nextDay);
    h.gate.narList.html = narListHtml(NAR_ID, "一覧のレース名", "20:50");
    doneWithoutPlan(h, NAR_ID, NAR_DATE);
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('purge_due_at', ?)", String(nextDay)); // 掃除の時刻が来ている
    const outcome = await h.core.runNextStep();
    // 前提: 掃除が走った(掃除専用の起床。予約は消えた)
    expect(outcome.kind).toBe("idle");
    expect(h.sql.exec("SELECT value FROM race_day_meta WHERE key = 'purge_due_at'").toArray()).toEqual([]);
    // 一覧は取りに行かず、行も足さない
    expect(h.gate.narList.calls).toBe(0);
    expect(planRows(h)).toEqual([]);
  });
});
