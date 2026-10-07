import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseRaceList } from "../../packages/core/src/scraper/parse-race-list";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { MAX_ATTEMPTS, MAX_TASKS_PER_DAY, RETRY_DELAY_MS, RaceDayCore, type AnalysisSink, type RaceDayDeps, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #203 段階2(B2。親 #166): 日単位の DO の朝の計画。`requestPlan` → 計画の段階(中央・地方の一覧 → 確定)→ 計画の表(期限)と morning の投入 → 期限が来たら pre_race の投入。
 * ゲートは偽(一覧は HTML を返し、それ以外は拒否か既存のフィクスチャ)、ストレージは `node:sqlite`(本物の SQLite)。実 netkeiba には触れない。
 * 混在日のフィクスチャ: 中央 20260927(実測)+ 地方は**合成**(`synthetic_nar_race_list_sub_20260927_jpn3.html`。実測の地方一覧に Jpn3 を1件足したもの)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20260927";
/** JST 9:00:00(= UTC 0:00。cron の時刻)。 */
const JST_0900 = Date.parse("2026-09-27T09:00:00+09:00");
const jst = (time: string): number => Date.parse(`2026-09-27T${time}:00+09:00`);
const MIN = 60_000;

const CENTRAL_HTML = fixture("race_list_sub_20260927.html");
const NAR_HTML_SYNTHETIC = fixture("synthetic_nar_race_list_sub_20260927_jpn3.html");
const NAR_HTML_REAL = fixture("nar_race_list_sub_20260927.html");
const EMPTY_HTML = "<html><body></body></html>";

// ---- 一覧の HTML を組み立てる(時刻・グレードを自由に決める。実物のマークアップの最小の写し)----

interface ListRow {
  readonly raceId: string;
  readonly venue: string;
  readonly raceNumber: number;
  readonly name: string;
  /** `HH:MM`。null は空(発走後に取得した中央の一覧に出る形)。 */
  readonly time: string | null;
  readonly grade?: string;
  readonly kind: "central" | "nar";
}

function listHtml(rows: readonly ListRow[]): string {
  const venues = [...new Set(rows.map((r) => r.venue))];
  return venues
    .map((venue) => {
      const items = rows
        .filter((r) => r.venue === venue)
        .map((r) => {
          const timeMarkup = r.kind === "central" ? `<span class="RaceList_Itemtime">${r.time ?? ""} </span>` : r.time === null ? "<span></span>" : `<span>${r.time}</span>`;
          const grade = r.grade === undefined ? "" : `<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType19 Icon_GradePos01">${r.grade}</span>`;
          return `<li class="RaceList_DataItem">
<a href="../race/shutuba.html?race_id=${r.raceId}&rf=race_list">
<div class="Race_Num"><span>${r.raceNumber}R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle"><span class="ItemTitle">${r.name}</span>${grade}</div>
<div class="RaceData">${timeMarkup}<span class="Dart">ダ1200m</span>16頭</div>
</div>
</a>
</li>`;
        })
        .join("\n");
      return `<dl class="RaceList_DataList">
<dt class="RaceList_DataHeader"><p class="RaceList_DataTitle"><small>1回</small> ${venue} <small>1日目</small></p></dt>
<dd class="RaceList_Data"><ul>
${items}
</ul></dd>
</dl>`;
    })
    .join("\n");
}

const central = (n: number, time: string | null, extra: Partial<ListRow> = {}): ListRow => ({
  raceId: `2026060409${String(n).padStart(2, "0")}`,
  venue: "中山",
  raceNumber: n,
  name: `中央${n}R`,
  time,
  kind: "central",
  ...extra,
});
const nar = (n: number, time: string | null, grade: string | undefined, extra: Partial<ListRow> = {}): ListRow => ({
  raceId: `2026360927${String(n).padStart(2, "0")}`,
  venue: "水沢",
  raceNumber: n,
  name: `地方${n}R`,
  time,
  ...(grade === undefined ? {} : { grade }),
  kind: "nar",
  ...extra,
});

// ---- 偽のゲート ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const httpError = (): GateResult => ({ kind: "response", status: 500, contentType: "text/html; charset=UTF-8", body: bytes("error"), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });
const queueFull = (): GateResult => ({ kind: "refused", reason: "queue-full", message: "待ち行列が上限" });

interface ListScript {
  html: string;
  /** 先頭から1回ずつ消費する失敗(空になれば html を返す)。 */
  failures: GateResult[];
  /** この一覧を取りに来た回数。 */
  calls: number;
  /** 取得の最中に呼ぶ(途中の状態の観測用)。 */
  onFetch: (() => void) | null;
}

interface FakeGate extends GateLike {
  readonly urls: string[];
  readonly lists: { central: ListScript; nar: ListScript };
  /** 一覧以外: blocked(既定。取得の本体は、このテストの主題ではないので、すぐ失敗にする)か、既存のフィクスチャ。 */
  others: "blocked" | "fixture";
}

function fakeGate(centralHtml: string, narHtml: string): FakeGate {
  const script = (html: string): ListScript => ({ html, failures: [], calls: 0, onFetch: null });
  const gate: FakeGate = {
    urls: [],
    lists: { central: script(centralHtml), nar: script(narHtml) },
    others: "blocked",
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const which = url.startsWith("https://race.netkeiba.com/top/race_list_sub") ? gate.lists.central : url.startsWith("https://nar.netkeiba.com/top/race_list_sub") ? gate.lists.nar : null;
      if (which !== null) {
        which.calls += 1;
        which.onFetch?.();
        return which.failures.shift() ?? ok(which.html);
      }
      return gate.others === "blocked" ? blocked() : ok(fixtureForUrl(url));
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
  readonly alarms: number[];
  readonly warnings: string[];
  settings: CloudSettings;
  /** loadSettings が呼ばれた回数。 */
  settingsLoads: number;
  /** true の間、loadSettings は投げる(D1 の失敗)。 */
  settingsFail: boolean;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(centralHtml = CENTRAL_HTML, narHtml = NAR_HTML_SYNTHETIC, overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: JST_0900 };
  const alarm: { at: number | null } = { at: null };
  const alarms: number[] = [];
  const warnings: string[] = [];
  const gate = fakeGate(centralHtml, narHtml);
  const h = { sql, gate, clock, alarm, alarms, warnings, settings: DEFAULT_CLOUD_SETTINGS, settingsLoads: 0, settingsFail: false } as Harness;
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarms.push(at);
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink: unusedSink,
    loadSettings: async () => {
      h.settingsLoads += 1;
      if (h.settingsFail) throw new Error("D1 の失敗");
      return h.settings;
    },
    ...overrides,
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);

/** 鳴ったアラームの時刻に時計を進め、1ステップ進める(DO と同じく、鳴ったアラームは空にしてから呼ぶ)。 */
async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}

/** 計画の段階(会場2つの一覧 + 確定)の3ステップを進める。 */
async function planThrough(h: Harness): Promise<string[]> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toMatchObject({ accepted: true });
  return [await tick(h), await tick(h), await tick(h)];
}

interface PlanRow {
  race_id: string;
  venue: string;
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
  h.sql.exec("SELECT race_id, venue, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, promoted_at FROM race_day_plan ORDER BY race_id").toArray() as PlanRow[];
const taskRows = (h: Harness): { race_id: string; mode: string; status: string }[] =>
  h.sql.exec("SELECT race_id, mode, status FROM race_day_tasks ORDER BY race_id, mode").toArray() as { race_id: string; mode: string; status: string }[];
const venueRows = (h: Harness): { venue: string; state: string; attempts: number; next_try_at: number; reason: string | null; listed: number | null; targeted: number | null; entries_json: string | null }[] =>
  h.sql.exec("SELECT venue, state, attempts, next_try_at, reason, listed, targeted, entries_json FROM race_day_plan_venue ORDER BY venue").toArray() as never;
const meta = (h: Harness, key: string): string | null => {
  const rows = h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
  return rows[0]?.value ?? null;
};

// ---------------------------------------------------------------------------

describe("requestPlan(計画の依頼。cron から呼ぶ入口)", () => {
  it("受理すると、会場2つ(中央・地方)を pending で作り、アラームを now に張る。この時点では gate に出ず、タスクも作らない", async () => {
    const h = harness();
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
    expect(venueRows(h).map((r) => [r.venue, r.state, r.attempts, r.next_try_at])).toEqual([
      ["central", "pending", 0, JST_0900],
      ["nar", "pending", 0, JST_0900],
    ]);
    expect(meta(h, "plan_requested_at")).toBe(String(JST_0900));
    expect(h.alarm.at).toBe(JST_0900);
    expect(h.gate.urls).toEqual([]);
    expect(taskRows(h)).toEqual([]);
    expect(planRows(h)).toEqual([]);
  });

  it("冪等: 2回目(cron の重複配信)は受理せず(already-planned)、何も変えない(行・アラーム・meta)", async () => {
    const h = harness();
    await h.core.requestPlan({ kaisaiDate: DATE });
    const before = JSON.stringify(venueRows(h));
    const alarmsBefore = h.alarms.length;
    h.clock.now += 5 * MIN;
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: false, reason: "already-planned" });
    expect(JSON.stringify(venueRows(h))).toBe(before);
    expect(meta(h, "plan_requested_at")).toBe(String(JST_0900)); // 最初の依頼の時刻のまま
    expect(h.alarms).toHaveLength(alarmsBefore); // アラームも触らない
  });

  it("冪等: 計画が確定し、朝の準備が済んだあとの重複配信でも、done の morning を作り直さず、計画の行・タスクも増えない", async () => {
    const h = harness();
    await planThrough(h);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
    const tasksBefore = JSON.stringify(taskRows(h));
    const plansBefore = JSON.stringify(planRows(h));
    expect(taskRows(h).length).toBeGreaterThan(0); // 前提: タスクがある
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: false, reason: "already-planned" });
    expect(JSON.stringify(taskRows(h))).toBe(tasksBefore);
    expect(JSON.stringify(planRows(h))).toBe(plansBefore);
  });

  it("開催日を固定する(pin)。別の日の schedule は拒否され、不正な開催日の依頼は何も作らない", async () => {
    const h = harness();
    await h.core.requestPlan({ kaisaiDate: DATE });
    await expect(h.core.schedule({ raceId: "202603020211", kaisaiDate: "20260628" })).rejects.toThrow(/開催日 20260927 専用/);
    const h2 = harness();
    await expect(h2.core.requestPlan({ kaisaiDate: "2026-09-27" })).rejects.toThrow();
    await expect(h2.core.requestPlan({ kaisaiDate: "20260230" })).rejects.toThrow();
    expect(venueRows(h2)).toEqual([]);
    expect(h2.alarm.at).toBeNull();
    expect(meta(h2, "kaisai_date")).toBeNull();
  });

  it("別の日に固定済みの DO への依頼は拒否する(何も作らない)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: "202603020211", kaisaiDate: "20260628" });
    await expect(h.core.requestPlan({ kaisaiDate: DATE })).rejects.toThrow(/開催日 20260628 専用/);
    expect(venueRows(h)).toEqual([]);
  });

  it("発走前の保存先・設定が無い構成では、依頼を拒否する(pre_race を予約できない計画は作らない)。何も作らない", async () => {
    const h = harness(CENTRAL_HTML, NAR_HTML_SYNTHETIC, { sink: undefined, loadSettings: undefined });
    await expect(h.core.requestPlan({ kaisaiDate: DATE })).rejects.toThrow(/発走前/);
    expect(venueRows(h)).toEqual([]);
    expect(h.alarm.at).toBeNull();
    expect(meta(h, "kaisai_date")).toBeNull();
  });
});

describe("計画の段階: 混在日(中央 24 件 + 地方の Jpn3 の 1 件)", () => {
  it("3ステップ(中央の一覧 → 地方の一覧 → 確定)で、計画の行が 25 件・morning のタスクが 25 件になる。race_id は衝突せず、すべて同じ1つの DO に入る", async () => {
    const h = harness();
    const outcomes = await planThrough(h);
    expect(outcomes).toEqual(["central:plan:list:ok", "nar:plan:list:ok", "plan:plan:finalize:ok"]);
    const plans = planRows(h);
    expect(plans).toHaveLength(25);
    expect(new Set(plans.map((p) => p.race_id)).size).toBe(25);
    expect(plans.filter((p) => p.venue === "central")).toHaveLength(24);
    const narPlans = plans.filter((p) => p.venue === "nar");
    expect(narPlans.map((p) => p.race_id)).toEqual(["202636092710"]);
    // 地方の Jpn3(16:55 発走)の期限は 16:10 JST(offset 45)
    expect(narPlans[0]).toMatchObject({ start_time: "16:55", start_ms: jst("16:55"), due_ms: jst("16:10"), offset_minutes: 45, disposition: "scheduled", state: "planned" });
    const tasks = taskRows(h);
    expect(tasks).toHaveLength(25);
    expect(tasks.every((t) => t.mode === "morning" && t.status === "queued")).toBe(true);
    expect(new Set(tasks.map((t) => t.race_id))).toEqual(new Set(plans.map((p) => p.race_id)));
    expect(h.core.getBoard().races.filter((r) => r.raceId.slice(4, 6) >= "30")).toHaveLength(1); // 地方(場コード 30 以上)は Jpn の1件だけ
    // 確定: 会場の状態・件数・offset
    expect(venueRows(h).map((r) => [r.venue, r.state, r.listed, r.targeted])).toEqual([
      ["central", "ok", 24, 24],
      ["nar", "ok", 33, 1],
    ]);
    expect(meta(h, "plan_offset")).toBe("45");
    expect(meta(h, "plan_offset_source")).toBe("settings");
    expect(meta(h, "plan_finalized_at")).toBe(String(JST_0900));
    // 一覧の本体(entries_json)は、確定したら捨てる(DO の保存を膨らませない)
    expect(venueRows(h).every((r) => r.entries_json === null)).toBe(true);
    // gate に出たのは一覧の2本だけ(出馬表の追加取得は無い。発走時刻は一覧から取る)
    expect(h.gate.urls).toHaveLength(2);
  });

  it("実測の地方一覧(Jpn が無い。重賞が1件ある)では、地方からは1件も入らない。中央の 24 件だけ", async () => {
    const h = harness(CENTRAL_HTML, NAR_HTML_REAL);
    await planThrough(h);
    expect(planRows(h)).toHaveLength(24);
    expect(planRows(h).every((p) => p.venue === "central")).toBe(true);
    expect(venueRows(h).map((r) => [r.venue, r.listed, r.targeted])).toEqual([
      ["central", 24, 24],
      ["nar", 33, 0],
    ]);
  });

  it("ボードと scrape の対象が同じ: 計画が積んだ morning は、既存の予約(手動)と同じタスク(同じ表・同じ並び)", async () => {
    const h = harness();
    await planThrough(h);
    const rows = h.sql.exec("SELECT race_id, mode, status, attempts, compute_attempts FROM race_day_tasks LIMIT 1").toArray() as { mode: string; status: string; attempts: number; compute_attempts: number }[];
    expect(rows[0]).toMatchObject({ mode: "morning", status: "queued", attempts: 0, compute_attempts: 0 });
  });
});

describe("計画の段階: 片方の一覧の失敗と再試行", () => {
  it("中央が失敗(HTTP 500): 60 秒おきに最大 3 回(試行 3 回目で failed)。地方が成功していれば、地方だけで確定する", async () => {
    const h = harness();
    h.gate.lists.central.failures = [httpError(), httpError(), httpError()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    expect(await tick(h)).toBe("central:plan:list:retry");
    expect(venueRows(h)[0]).toMatchObject({ venue: "central", state: "pending", attempts: 1, next_try_at: JST_0900 + RETRY_DELAY_MS });
    // 次に起きるのは、地方の一覧(すぐ)。中央の再試行(60 秒後)ではない
    expect(h.alarm.at).toBe(JST_0900);
    expect(await tick(h)).toBe("nar:plan:list:ok");
    // 地方が済むと、残りは中央の再試行だけ(60 秒後)
    expect(h.alarm.at).toBe(JST_0900 + RETRY_DELAY_MS);
    expect(await tick(h)).toBe("central:plan:list:retry");
    expect(h.alarm.at).toBe(JST_0900 + 2 * RETRY_DELAY_MS);
    expect(await tick(h)).toBe("central:plan:list:failed");
    expect(venueRows(h)[0]).toMatchObject({ venue: "central", state: "failed", attempts: MAX_ATTEMPTS, reason: "failed" });
    expect(h.gate.lists.central.calls).toBe(3);
    expect(await tick(h)).toBe("plan:plan:finalize:ok");
    // 地方だけ(Jpn3 の 1 件)で確定
    expect(planRows(h).map((p) => [p.race_id, p.venue])).toEqual([["202636092710", "nar"]]);
    expect(taskRows(h)).toEqual([{ race_id: "202636092710", mode: "morning", status: "queued" }]);
    expect(venueRows(h).map((r) => [r.venue, r.state, r.reason, r.listed, r.targeted])).toEqual([
      ["central", "failed", "failed", null, null],
      ["nar", "ok", null, 33, 1],
    ]);
  });

  it("地方が失敗して、中央が成功: 中央の 24 件だけで確定する(逆の組み合わせ)", async () => {
    const h = harness();
    h.gate.lists.nar.failures = [httpError(), httpError(), httpError()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    const outcomes: string[] = [];
    for (let i = 0; i < 8 && h.alarm.at !== null; i++) {
      outcomes.push(await tick(h));
      if (outcomes[outcomes.length - 1] === "plan:plan:finalize:ok") break;
    }
    expect(outcomes).toEqual(["central:plan:list:ok", "nar:plan:list:retry", "nar:plan:list:retry", "nar:plan:list:failed", "plan:plan:finalize:ok"]);
    expect(planRows(h)).toHaveLength(24);
    expect(planRows(h).every((p) => p.venue === "central")).toBe(true);
    expect(venueRows(h).map((r) => [r.venue, r.state])).toEqual([
      ["central", "ok"],
      ["nar", "failed"],
    ]);
  });

  it("再試行で成功すれば ok(2回目で取れる)。attempts は 2", async () => {
    const h = harness();
    h.gate.lists.central.failures = [httpError()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    await tick(h); // 中央: 失敗(再試行へ)
    await tick(h); // 地方
    expect(await tick(h)).toBe("central:plan:list:ok");
    expect(venueRows(h)[0]).toMatchObject({ venue: "central", state: "ok", attempts: 2, listed: 24 });
  });

  it("ブレーカーが開いている(blocked)・許可リスト外は再試行せず直ちに failed(30 分のブレーカーの間に撃ち直さない)", async () => {
    const h = harness();
    h.gate.lists.central.failures = [blocked()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    expect(await tick(h)).toBe("central:plan:list:failed");
    expect(venueRows(h)[0]).toMatchObject({ venue: "central", state: "failed", attempts: 1, reason: "blocked" });
    expect(h.gate.lists.central.calls).toBe(1);
  });

  it("待ち行列が上限(queue-full)は busy として再試行する(上限 3 回)", async () => {
    const h = harness();
    h.gate.lists.nar.failures = [queueFull(), queueFull(), queueFull()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    await tick(h); // 中央
    expect(await tick(h)).toBe("nar:plan:list:retry");
    expect(await tick(h)).toBe("nar:plan:list:retry");
    expect(await tick(h)).toBe("nar:plan:list:failed");
    expect(venueRows(h)[1]).toMatchObject({ venue: "nar", state: "failed", attempts: 3, reason: "busy" });
  });

  it("両方の一覧が失敗: 計画の行・タスクは 0 件で確定する(会場の失敗の理由は残る)", async () => {
    const h = harness();
    h.gate.lists.central.failures = [blocked()];
    h.gate.lists.nar.failures = [blocked()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    expect(await tick(h)).toBe("central:plan:list:failed");
    expect(await tick(h)).toBe("nar:plan:list:failed");
    expect(await tick(h)).toBe("plan:plan:finalize:ok");
    expect(planRows(h)).toEqual([]);
    expect(taskRows(h)).toEqual([]);
    expect(venueRows(h).map((r) => [r.state, r.reason])).toEqual([
      ["failed", "blocked"],
      ["failed", "blocked"],
    ]);
    expect(meta(h, "plan_finalized_at")).not.toBeNull();
  });

  it("一覧の取得の前に、試行回数を永続化する(取得の途中でクラッシュしても、再実行が無限に続かない)", async () => {
    const h = harness();
    let seen: number | null = null;
    h.gate.lists.central.onFetch = () => {
      seen = (h.sql.exec("SELECT attempts FROM race_day_plan_venue WHERE venue = 'central'").toArray() as { attempts: number }[])[0]!.attempts;
    };
    await h.core.requestPlan({ kaisaiDate: DATE });
    await tick(h);
    expect(seen).toBe(1);
  });
});

describe("計画の段階: 空の日・上限・既存のタスク・offset", () => {
  it("両方の一覧が空(平日で地方の Jpn も無い日): 計画の行・タスクは 0 件。確定は済み、gate に出たのは一覧の2本だけ", async () => {
    const h = harness(EMPTY_HTML, EMPTY_HTML);
    expect(await planThrough(h)).toEqual(["central:plan:list:ok", "nar:plan:list:ok", "plan:plan:finalize:ok"]);
    expect(planRows(h)).toEqual([]);
    expect(taskRows(h)).toEqual([]);
    expect(venueRows(h).map((r) => [r.state, r.listed, r.targeted])).toEqual([
      ["ok", 0, 0],
      ["ok", 0, 0],
    ]);
    expect(h.gate.urls).toHaveLength(2);
    expect(h.core.getPlanProgress()).toMatchObject({ stage: "done", morningAllTerminal: true });
  });

  it.each([
    [96, 2],
    [97, 1],
    [98, 1],
    [99, 0],
    [100, 0],
  ])("1日の上限(%i 件のタスクが既にある): 対象は morning と pre_race の2行ぶんを使うので、受け入れるのは %i 件で、残りは skipped(cap)", async (existing, accepted) => {
    expect(MAX_TASKS_PER_DAY).toBe(100); // 前提: 上限の値(境界の計算の根拠)
    const h = harness();
    // 既存のタスク(手動の予約の代わり。別の race_id)を SQL で入れる
    for (let i = 0; i < existing; i++) {
      h.sql.exec(
        "INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at) VALUES (?, 'morning', 'done', 0, 0, 1, 1)",
        `2026010101${String(i).padStart(2, "0")}`,
      );
    }
    await planThrough(h);
    const plans = planRows(h);
    expect(plans).toHaveLength(25);
    const planned = plans.filter((p) => p.state === "planned");
    const capped = plans.filter((p) => p.skip_reason === "cap");
    expect(planned).toHaveLength(accepted);
    expect(capped).toHaveLength(25 - accepted);
    expect(capped.every((p) => p.state === "skipped" && p.disposition === "skip")).toBe(true);
    // 上限の超過分には morning を積まない(握りつぶさず、行に理由が残る)
    const morning = (h.sql.exec("SELECT race_id FROM race_day_tasks WHERE mode = 'morning' AND status = 'queued'").toArray() as { race_id: string }[]).map((r) => r.race_id);
    expect(morning.sort()).toEqual(planned.map((p) => p.race_id).sort());
    expect((h.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks").toArray() as { n: number }[])[0]!.n).toBeLessThanOrEqual(MAX_TASKS_PER_DAY);
  });

  it("既に morning の行がある(手動で先に実行した)レースは、状態に関係なく積み直さない(done・failed・queued のまま。計画の行は作る)", async () => {
    const h = harness();
    const ids = planRowsFromFixture();
    h.sql.exec("INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error) VALUES (?, 'morning', 'done', 1, 0, 5, 5, NULL)", ids[0]!);
    h.sql.exec("INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error) VALUES (?, 'morning', 'failed', 3, 0, 5, 5, '前の失敗')", ids[1]!);
    h.sql.exec("INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error) VALUES (?, 'morning', 'queued', 0, 0, 5, 5, NULL)", ids[2]!);
    await planThrough(h);
    const tasks = taskRows(h);
    expect(tasks).toHaveLength(25);
    expect(tasks.find((t) => t.race_id === ids[0])).toMatchObject({ status: "done" });
    expect(tasks.find((t) => t.race_id === ids[1])).toMatchObject({ status: "failed" });
    expect(tasks.find((t) => t.race_id === ids[2])).toMatchObject({ status: "queued" });
    expect((h.sql.exec("SELECT attempts, error FROM race_day_tasks WHERE race_id = ?", ids[1]).toArray() as { attempts: number; error: string }[])[0]).toEqual({ attempts: 3, error: "前の失敗" });
    expect(planRows(h)).toHaveLength(25);
  });

  it("offset のスナップショット: 設定の offset が計画の期限に効く(10 と 180 で期限は 170 分違う)。計画のあとで設定を変えても、行の期限は変わらない", async () => {
    const a = harness();
    a.settings = { ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: 10 };
    await planThrough(a);
    const b = harness();
    b.settings = { ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: 180 };
    await planThrough(b);
    const narA = planRows(a).find((p) => p.venue === "nar")!;
    const narB = planRows(b).find((p) => p.venue === "nar")!;
    expect(narA.due_ms).toBe(jst("16:45")); // 16:55 の 10 分前
    expect(narB.due_ms).toBe(jst("13:55")); // 16:55 の 180 分前
    expect(narA.due_ms! - narB.due_ms!).toBe(170 * MIN); // 差が 0 でないことを先に固定
    expect(narA.offset_minutes).toBe(10);
    expect(narB.offset_minutes).toBe(180);
    // 計画のあとで設定を変えても、行は変わらない
    const before = JSON.stringify(planRows(a));
    a.settings = { ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: 120 };
    await a.core.requestPlan({ kaisaiDate: DATE }); // 重複配信
    expect(JSON.stringify(planRows(a))).toBe(before);
    expect(meta(a, "plan_offset")).toBe("10");
  });

  it("設定が読めない(D1 の失敗): 60 秒おきに 3 回再試行し、それでも駄目なら既定の 45 分で確定する。plan_offset_source に default-fallback を残す", async () => {
    const h = harness();
    h.settingsFail = true;
    await h.core.requestPlan({ kaisaiDate: DATE });
    await tick(h);
    await tick(h);
    expect(await tick(h)).toBe("plan:plan:finalize:retry"); // 1回目の失敗
    expect(h.alarm.at).toBe(JST_0900 + RETRY_DELAY_MS);
    expect(planRows(h)).toEqual([]); // まだ確定していない
    expect(await tick(h)).toBe("plan:plan:finalize:retry");
    expect(await tick(h)).toBe("plan:plan:finalize:ok"); // 3回目: 既定で確定
    expect(h.settingsLoads).toBe(3);
    expect(meta(h, "plan_offset")).toBe("45");
    expect(meta(h, "plan_offset_source")).toBe("default-fallback");
    expect(planRows(h)).toHaveLength(25);
    expect(planRows(h).every((p) => p.offset_minutes === 45)).toBe(true);
    expect(h.warnings.some((w) => w.includes("既定"))).toBe(true);
    expect(h.core.getPlanProgress().offsetSource).toBe("default-fallback");
  });

  it("設定が2回目で読めれば、その値で確定する(source は settings)", async () => {
    const h = harness();
    h.settings = { ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: 90 };
    h.settingsFail = true;
    await h.core.requestPlan({ kaisaiDate: DATE });
    await tick(h);
    await tick(h);
    expect(await tick(h)).toBe("plan:plan:finalize:retry");
    h.settingsFail = false;
    expect(await tick(h)).toBe("plan:plan:finalize:ok");
    expect(meta(h, "plan_offset")).toBe("90");
    expect(meta(h, "plan_offset_source")).toBe("settings");
  });
});

/** 中央 20260927 の一覧の race_id(先頭から)。 */
function planRowsFromFixture(): string[] {
  return [...CENTRAL_HTML.matchAll(/race_id=(\d{12})/g)].map((m) => m[1]!).filter((id, i, all) => all.indexOf(id) === i);
}

describe("計画の段階: planPreRaceDue の結果が行に写る(期限・すぐ実行・スキップ)", () => {
  const lists = (times: readonly [string | null, string | null, string | null, string | null]): { central: string; nar: string } => ({
    central: listHtml([central(1, times[0]), central(2, times[1]), central(3, times[2]), central(4, times[3])]),
    nar: EMPTY_HTML,
  });

  it("朝 9:00:00 ちょうど: 最初の発走 9:45 の期限は 9:00(= now。過去ではない)で scheduled。9:00:01 以降に計画すれば immediate(中央 20260927 の実測の境界)", async () => {
    const at = harness(CENTRAL_HTML, EMPTY_HTML);
    await planThrough(at);
    const first = planRows(at).reduce((a, b) => (a.due_ms! <= b.due_ms! ? a : b));
    expect(first).toMatchObject({ start_time: "09:45", due_ms: JST_0900, disposition: "scheduled", state: "planned" });
    expect(planRows(at).every((p) => p.disposition === "scheduled")).toBe(true);

    const late = harness(CENTRAL_HTML, EMPTY_HTML);
    late.clock.now = JST_0900 + 1000; // DO のアラームの中で動くので、cron の時刻より後になる
    await planThrough(late);
    const lateFirst = planRows(late).reduce((a, b) => (a.due_ms! <= b.due_ms! ? a : b));
    expect(lateFirst).toMatchObject({ start_time: "09:45", due_ms: JST_0900, disposition: "immediate", state: "planned" });
  });

  it("期限が過去のとき: 発走まで 10 分以上なら immediate、10 分未満なら skip(too-late)、すでに発走なら skip(started)、時刻が無ければ skip(no-start-time)。skip は morning も積まない", async () => {
    const h = harness(lists(["09:45", "09:05", "08:50", null]).central, EMPTY_HTML);
    h.clock.now = JST_0900 + 1000; // 9:00:01
    await planThrough(h);
    const byId = new Map(planRows(h).map((p) => [p.race_id, p]));
    expect(byId.get("202606040901")).toMatchObject({ disposition: "immediate", state: "planned", skip_reason: null }); // 発走まで 43 分 59 秒
    expect(byId.get("202606040902")).toMatchObject({ disposition: "skip", state: "skipped", skip_reason: "too-late", due_ms: null }); // 発走まで 3 分 59 秒
    expect(byId.get("202606040903")).toMatchObject({ disposition: "skip", state: "skipped", skip_reason: "started" });
    expect(byId.get("202606040904")).toMatchObject({ disposition: "skip", state: "skipped", skip_reason: "no-start-time", start_time: null, start_ms: null, due_ms: null });
    // morning は、pre_race を走らせる(planned の)レースにだけ積む
    expect(taskRows(h)).toEqual([{ race_id: "202606040901", mode: "morning", status: "queued" }]);
  });

  it("発走まで 10 分ちょうど(最低余裕)は immediate、1ms 足りなければ skip(too-late)", async () => {
    const h = harness(listHtml([central(1, "09:10"), central(2, "09:10")]), EMPTY_HTML);
    h.clock.now = jst("09:00"); // 発走まで 10 分ちょうど。offset 45 の期限(8:25)は過去
    await planThrough(h);
    expect(planRows(h).map((p) => [p.race_id, p.disposition])).toEqual([
      ["202606040901", "immediate"],
      ["202606040902", "immediate"],
    ]);
    const g = harness(listHtml([central(1, "09:10")]), EMPTY_HTML);
    g.clock.now = jst("09:00") + 1;
    await planThrough(g);
    expect(planRows(g)[0]).toMatchObject({ disposition: "skip", skip_reason: "too-late" });
  });

  it("skip の行も、一覧の情報(会場名・R・レース名・グレード・発走時刻)を持つ(朝のまとめ用)", async () => {
    const h = harness(listHtml([central(7, null, { name: "テスト特別" })]), listHtml([nar(10, "20:00", "Jpn2", { name: "テスト記念" })]));
    await planThrough(h);
    const rows = h.sql.exec("SELECT race_id, venue_name, race_number, race_name, grade, start_time FROM race_day_plan ORDER BY race_id").toArray();
    expect(rows).toEqual([
      { race_id: "202606040907", venue_name: "中山", race_number: 7, race_name: "テスト特別", grade: null, start_time: null },
      { race_id: "202636092710", venue_name: "水沢", race_number: 10, race_name: "テスト記念", grade: "Jpn2", start_time: "20:00" },
    ]);
  });
});

describe("確定(finalize)の冪等性: 原子性に頼らず、途中で落ちても再実行で正しく続く", () => {
  it("確定の途中で落ちた状態(plan_finalized_at が無く、計画の行・morning が一部だけある)から再実行しても、全体が正しい最終形になり、既にある行・タスクの状態は保たれる", async () => {
    const clean = harness();
    clean.clock.now = jst("08:00"); // 全レースの期限が未来(再実行の起床で昇格が起きない)
    await planThrough(clean);
    const expectedPlans = JSON.stringify(planRows(clean));
    const expectedTasks = taskRows(clean).map((t) => t.race_id);

    const h = harness();
    h.clock.now = jst("08:00");
    await planThrough(h);
    // 途中で落ちた状態を作る: 確定の印・offset の記録を消し、行を半分だけ残し、会場の一覧(entries_json)を復元する
    const centralEntries = JSON.stringify(parseEntriesFor(CENTRAL_HTML));
    const narEntries = JSON.stringify(parseEntriesFor(NAR_HTML_SYNTHETIC));
    h.sql.exec("UPDATE race_day_plan_venue SET entries_json = ? WHERE venue = 'central'", centralEntries);
    h.sql.exec("UPDATE race_day_plan_venue SET entries_json = ? WHERE venue = 'nar'", narEntries);
    const keep = planRows(h).slice(0, 10).map((p) => p.race_id);
    h.sql.exec(`DELETE FROM race_day_plan WHERE race_id NOT IN (${keep.map(() => "?").join(",")})`, ...keep);
    h.sql.exec(`DELETE FROM race_day_tasks WHERE race_id NOT IN (${keep.map(() => "?").join(",")})`, ...keep);
    // 既にある morning の1件は、完了している(再実行で積み直されてはいけない)
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE race_id = ?", keep[0]);
    h.sql.exec("DELETE FROM race_day_meta WHERE key IN ('plan_finalized_at', 'plan_finalize_attempts', 'plan_finalize_next_try_at')");
    h.sql.exec("UPDATE race_day_plan_venue SET targeted = NULL");
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('plan_finalize_next_try_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(h.clock.now));
    h.alarm.at = h.clock.now;
    expect(await tick(h)).toBe("plan:plan:finalize:ok");
    expect(JSON.stringify(planRows(h))).toBe(expectedPlans);
    expect(taskRows(h).map((t) => t.race_id)).toEqual(expectedTasks);
    expect(taskRows(h).find((t) => t.race_id === keep[0])).toMatchObject({ status: "done" }); // 積み直していない
    expect(taskRows(h).filter((t) => t.race_id === keep[0])).toHaveLength(1);
    expect(meta(h, "plan_finalized_at")).not.toBeNull();
  });

  it("確定を2回続けて実行しても(印を消して再実行)、行・タスクは増えない", async () => {
    const h = harness();
    h.clock.now = jst("08:00"); // 全レースの期限が未来(再実行の起床で昇格が起きない)
    await planThrough(h);
    const plans = JSON.stringify(planRows(h));
    const tasks = JSON.stringify(taskRows(h));
    h.sql.exec("DELETE FROM race_day_meta WHERE key = 'plan_finalized_at'");
    h.sql.exec("UPDATE race_day_plan_venue SET entries_json = ? WHERE venue = 'central'", JSON.stringify(parseEntriesFor(CENTRAL_HTML)));
    h.sql.exec("UPDATE race_day_plan_venue SET entries_json = ? WHERE venue = 'nar'", JSON.stringify(parseEntriesFor(NAR_HTML_SYNTHETIC)));
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('plan_finalize_next_try_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(h.clock.now));
    h.alarm.at = h.clock.now;
    await tick(h);
    expect(JSON.stringify(planRows(h))).toBe(plans);
    expect(JSON.stringify(taskRows(h))).toBe(tasks);
  });
});

/** 会場の一覧の行(`entries_json` の形 = `RaceListEntry` の配列の JSON)。実装の保存形式は、core のパーサの出力そのまま。 */
function parseEntriesFor(html: string): unknown[] {
  return parseRaceList(html);
}

describe("期限が来たら pre_race を投入する(planned → promoted)と、アラームの合成", () => {
  /** 計画を確定し、morning を完了にして、gate の呼び出しを起こさない状態にする。 */
  async function planned(h: Harness): Promise<void> {
    await planThrough(h);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
  }

  it("確定したあと、アラームは最も近い期限(未来)に張られる。morning が queued のあいだは now(仕事が先)", async () => {
    const h = harness(listHtml([central(1, "10:00"), central(2, "12:00")]), EMPTY_HTML);
    await planThrough(h);
    expect(h.alarm.at).toBe(h.clock.now); // morning が積まれている(即時の仕事)
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
    expect(await tick(h)).toBe("idle"); // 仕事が無く、期限は未来 → 起きても何もせず、アラームを張り直す
    expect(h.alarm.at).toBe(jst("09:15")); // 10:00 の 45 分前
  });

  it("期限が来ると、planned の行が promoted になり、pre_race が queued で積まれる(queued_at は期限の時刻)。続けて、その pre_race の取得が走る", async () => {
    const h = harness(listHtml([central(1, "10:00"), central(2, "12:00")]), EMPTY_HTML);
    await planned(h);
    await tick(h); // idle(張り直し)
    expect(await tick(h)).toBe("202606040901:pre_race:fetch:failed"); // 取得は blocked で即 failed(このテストの主題は投入)
    const row = h.sql.exec("SELECT race_id, mode, queued_at FROM race_day_tasks WHERE mode = 'pre_race'").toArray();
    expect(row).toEqual([{ race_id: "202606040901", mode: "pre_race", queued_at: jst("09:15") }]);
    expect(planRows(h).map((p) => [p.race_id, p.state, p.promoted_at])).toEqual([
      ["202606040901", "promoted", jst("09:15")],
      ["202606040902", "planned", null],
    ]);
    expect(h.alarm.at).toBe(jst("11:15")); // 次の期限
  });

  it("【ループの防止】起きたときに、候補になっていた状態が必ず変わる: planned の行 → promoted/skipped、pending の会場 → attempts か state、確定待ち → attempts か確定。変わらないと即時に起き続ける", async () => {
    const h = harness(listHtml([central(1, "10:00")]), EMPTY_HTML);
    // (a) 会場の pending: 起きるたびに attempts が増えるか state が変わる
    await h.core.requestPlan({ kaisaiDate: DATE });
    const beforeVenue = JSON.stringify(venueRows(h));
    await tick(h);
    expect(JSON.stringify(venueRows(h))).not.toBe(beforeVenue);
    await tick(h);
    // (b) 確定待ち: 確定する
    expect(meta(h, "plan_finalized_at")).toBeNull();
    await tick(h);
    expect(meta(h, "plan_finalized_at")).not.toBeNull();
    // (c) planned の期限: 昇格する
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
    await tick(h); // idle(張り直し)
    expect(planRows(h)[0]!.state).toBe("planned");
    await tick(h); // 期限
    expect(planRows(h)[0]!.state).not.toBe("planned");
    // 状態が変わったので、期限で即時に起こす候補は残っていない(アラームは now ではない。pre_race の仕事か、掃除)
    expect(h.core.getPlanProgress().rows.every((r) => r.state !== "planned")).toBe(true);
  });

  it("【ループの防止】アラームだけで進めると、必ず止まる(上限つきの偽の時計で、最後は掃除のアラームだけが残り、それが鳴ると null になる)", async () => {
    const h = harness(listHtml([central(1, "10:00"), central(2, "12:00")]), listHtml([nar(10, "20:00", "Jpn1")]));
    await h.core.requestPlan({ kaisaiDate: DATE });
    let steps = 0;
    while (h.alarm.at !== null) {
      steps += 1;
      if (steps > 60) throw new Error("アラームが止まらない(上限超過)");
      await tick(h);
    }
    // 計画 3 ステップ + morning 3 件 + pre_race 3 件(取得は blocked で即 failed)+ 掃除など
    expect(steps).toBeGreaterThanOrEqual(9);
    expect(planRows(h).every((p) => p.state === "promoted")).toBe(true);
  });

  it("【M2】期限が未来の計画があるとき、掃除の期限を延ばす条件(キャッシュの一覧が古くなって取り直す)でも、一覧の取得(GET /api/races 相当の getRaceList)は掃除の期限を書かず、アラームも変えない", async () => {
    const h = harness(listHtml([central(1, "17:00"), central(2, "19:00")]), EMPTY_HTML);
    await planned(h);
    await tick(h); // idle(張り直し)
    const due = jst("16:15");
    expect(h.alarm.at).toBe(due);
    // 前提: 計画の段階の step のあとの armAlarm が、掃除の期限を 9:00 を基準に書いている
    const purgeBefore = meta(h, "purge_due_at");
    expect(purgeBefore).not.toBeNull();
    // 一覧のキャッシュ(TTL 6 時間。9:00 に取得)が切れた 15:30 に、誰かが一覧を開く → 取り直す。取り直した一覧の行から計算した掃除の期限は、書かれている期限より後ろになる
    h.clock.now = jst("15:30");
    const centralCalls = h.gate.lists.central.calls;
    const result = await h.core.getRaceList(DATE, "central");
    expect(result.ok).toBe(true);
    expect(h.gate.lists.central.calls).toBe(centralCalls + 1); // 前提: 実際に取り直した(キャッシュが切れていた)
    expect(planRows(h).filter((p) => p.state === "planned")).toHaveLength(2); // 前提: 計画はまだ残っている
    // 計画の仕事があるので、掃除の期限を書き換えず、アラームも変えない(仕事が無ければ、ここで後ろへ書き換わる)
    expect(meta(h, "purge_due_at")).toBe(purgeBefore);
    expect(h.alarm.at).toBe(due);
  });

  it("対照(M2): 計画の仕事が無い(全部昇格済み)あとで一覧のキャッシュが切れて取り直すと、掃除の期限が後ろへ延びる(上のテストが、期限を書く条件を満たしていたことの確認)", async () => {
    const h = harness(listHtml([central(1, "17:00")]), EMPTY_HTML);
    await planned(h);
    h.sql.exec("UPDATE race_day_plan SET state = 'promoted'"); // 計画の仕事を無くす
    h.sql.exec("DELETE FROM race_day_meta WHERE key = 'purge_due_at'");
    h.clock.now = jst("15:30");
    await h.core.getRaceList(DATE, "central"); // キャッシュが切れて取り直し、掃除の期限を書く
    expect(meta(h, "purge_due_at")).not.toBeNull();
  });

  it("【M1・端から端まで】日中に一覧を開いても、各期限に pre_race が積まれる。積まれた時刻の列が期限の列と一致する(中央の昼 3 件と地方のナイター 1 件の混在)", async () => {
    const h = harness(listHtml([central(1, "10:00"), central(2, "12:00"), central(3, "15:30")]), listHtml([nar(10, "20:00", "Jpn3")]));
    await h.core.requestPlan({ kaisaiDate: DATE });
    let listOpened = false;
    let steps = 0;
    while (h.alarm.at !== null) {
      steps += 1;
      if (steps > 60) throw new Error("アラームが止まらない(上限超過)");
      await tick(h);
      // 最初の pre_race の昇格のあと(次の期限は未来)に、誰かが日中に一覧を開く
      if (!listOpened && planRows(h).some((p) => p.state === "promoted") && h.alarm.at !== null && h.alarm.at > h.clock.now) {
        listOpened = true;
        const before = h.alarm.at;
        await h.core.getRaceList(DATE, "central");
        await h.core.getRaceList(DATE, "nar");
        expect(h.alarm.at).toBe(before);
      }
    }
    expect(listOpened).toBe(true);
    const queuedAt = h.sql.exec("SELECT race_id, queued_at FROM race_day_tasks WHERE mode = 'pre_race' ORDER BY queued_at").toArray() as { race_id: string; queued_at: number }[];
    expect(queuedAt.map((r) => [r.race_id, r.queued_at])).toEqual([
      ["202606040901", jst("09:15")],
      ["202606040902", jst("11:15")],
      ["202606040903", jst("14:45")],
      ["202636092710", jst("19:15")],
    ]);
  });

  it("期限が過去の immediate の行は、確定のあと最初の起床で昇格する(待たない)", async () => {
    const h = harness(listHtml([central(1, "09:45")]), EMPTY_HTML);
    h.clock.now = JST_0900 + 1000; // 9:00:01 → immediate
    await planned(h);
    expect(planRows(h)[0]!.disposition).toBe("immediate");
    expect(h.alarm.at).toBeLessThanOrEqual(h.clock.now); // 期限は過去 → すぐ
    expect(await tick(h)).toBe("202606040901:pre_race:fetch:failed");
    expect(planRows(h)[0]!.state).toBe("promoted");
  });

  it("昇格のとき、同じレースの pre_race が実行中(queued・fetched。手動の予約)なら、積み直さず(タスクを作り直さない)、行だけ promoted にする", async () => {
    const h = harness(listHtml([central(1, "10:00")]), EMPTY_HTML);
    await planned(h);
    h.clock.now = jst("09:10");
    await h.core.schedule({ raceId: "202606040901", kaisaiDate: DATE, mode: "pre_race" }); // 手動(期限 9:15 の前に予約)
    const queuedAt = (): number[] => (h.sql.exec("SELECT queued_at FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { queued_at: number }[]).map((r) => r.queued_at);
    expect(queuedAt()).toEqual([jst("09:10")]); // 前提: 手動の予約の時刻
    h.alarm.at = jst("09:15");
    await tick(h);
    expect(queuedAt()).toEqual([jst("09:10")]); // 積み直していない(queued_at が期限の時刻 9:15 に変わっていない)
    expect(planRows(h)[0]!.state).toBe("promoted");
  });

  it("昇格のとき、1日の上限に達していれば、行を skipped(cap)にする(投げず、ループもしない)", async () => {
    const h = harness(listHtml([central(1, "10:00")]), EMPTY_HTML);
    await planned(h);
    for (let i = 0; planRows(h).length > 0 && (h.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks").toArray() as { n: number }[])[0]!.n < MAX_TASKS_PER_DAY; i++) {
      h.sql.exec("INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at) VALUES (?, 'morning', 'done', 0, 0, 1, 1)", `2026010101${String(i).padStart(2, "0")}`);
    }
    expect((h.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks").toArray() as { n: number }[])[0]!.n).toBe(MAX_TASKS_PER_DAY); // 前提: 上限ちょうど
    await tick(h); // idle(張り直し)
    await tick(h); // 期限
    expect(planRows(h)[0]).toMatchObject({ state: "skipped", skip_reason: "cap" });
    expect(h.sql.exec("SELECT 1 FROM race_day_tasks WHERE mode = 'pre_race'").toArray()).toEqual([]);
  });
});

describe("getPlanProgress(朝のまとめ #205 のための読み取り)", () => {
  it("依頼の前: stage none。依頼後〜確定の前: pending(会場の状態を持つ)。確定後: done", async () => {
    const h = harness();
    expect(h.core.getPlanProgress()).toMatchObject({ stage: "none", venues: [], rows: [], morningAllTerminal: false, requestedAt: null, finalizedAt: null });
    await h.core.requestPlan({ kaisaiDate: DATE });
    expect(h.core.getPlanProgress()).toMatchObject({ stage: "pending", requestedAt: JST_0900, finalizedAt: null, morningAllTerminal: false });
    expect(h.core.getPlanProgress().venues.map((v) => [v.venue, v.state])).toEqual([
      ["central", "pending"],
      ["nar", "pending"],
    ]);
    await tick(h);
    await tick(h);
    await tick(h);
    const progress = h.core.getPlanProgress();
    expect(progress).toMatchObject({ stage: "done", finalizedAt: JST_0900, offsetMinutes: 45, offsetSource: "settings" });
    expect(progress.rows).toHaveLength(25);
    expect(progress.venues.map((v) => [v.venue, v.state, v.listed, v.targeted])).toEqual([
      ["central", "ok", 24, 24],
      ["nar", "ok", 33, 1],
    ]);
  });

  it("morningAllTerminal: morning が queued・fetched のあいだ false。すべて done か failed になったら true(一部が failed でも true)。skip の行は数えない", async () => {
    const h = harness(listHtml([central(1, "10:00"), central(2, "12:00"), central(3, null)]), EMPTY_HTML);
    await planThrough(h);
    expect(planRows(h).map((p) => p.state)).toEqual(["planned", "planned", "skipped"]);
    expect(h.core.getPlanProgress().morningAllTerminal).toBe(false);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE race_id = '202606040901'");
    expect(h.core.getPlanProgress().morningAllTerminal).toBe(false); // 2件目がまだ queued
    h.sql.exec("UPDATE race_day_tasks SET status = 'fetched' WHERE race_id = '202606040902'");
    expect(h.core.getPlanProgress().morningAllTerminal).toBe(false); // fetched も終端ではない
    h.sql.exec("UPDATE race_day_tasks SET status = 'failed', error = '失敗' WHERE race_id = '202606040902'");
    expect(h.core.getPlanProgress().morningAllTerminal).toBe(true); // 一部が failed でも true
    const rows = h.core.getPlanProgress().rows;
    expect(rows.map((r) => [r.raceId, r.morning])).toEqual([
      ["202606040901", "done"],
      ["202606040902", "failed"],
      ["202606040903", null], // skip の行には morning が無い
    ]);
  });

  it("確定の前は、morning が全部終わっていても morningAllTerminal は false(計画が未完)", async () => {
    const h = harness();
    await h.core.requestPlan({ kaisaiDate: DATE });
    await tick(h); // 中央だけ済み
    expect(h.core.getPlanProgress().morningAllTerminal).toBe(false);
  });
});

describe("朝の準備と発走前: 掃除の扱い(今の掃除は、キャッシュの行と孤立した LLM の応答の記録だけを消す。タスク・prior・計画は消さない)", () => {
  it("掃除のアラームが鳴ると、キャッシュの行は消えるが、計画の行・会場の状態・タスク・meta の計画のキーは残る(タスクの扱いと同じ)", async () => {
    const h = harness(listHtml([central(1, "10:00")]), EMPTY_HTML);
    await planThrough(h);
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
    // 計画が終わるまで(期限 → pre_race の取得 → 掃除)アラームで進める
    let steps = 0;
    while (h.alarm.at !== null) {
      steps += 1;
      if (steps > 30) throw new Error("アラームが止まらない");
      await tick(h);
    }
    expect(planRows(h)).toHaveLength(1);
    expect(venueRows(h)).toHaveLength(2);
    expect(taskRows(h).length).toBeGreaterThan(0);
    expect(meta(h, "plan_finalized_at")).not.toBeNull();
    expect(meta(h, "kaisai_date")).toBe(DATE);
  });
});
