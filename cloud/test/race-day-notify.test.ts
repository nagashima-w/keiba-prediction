import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { CLIP_VARIANTS } from "../../packages/core/src/analyzer/clip-variants";
import { DiscordNotifyError, type DiscordPayload } from "../../packages/core/src/notify/discord";
import { failureText, MANUAL_SKIP_TEXT } from "../src/notify-embeds";
import type { CloudEmbed } from "../src/notify-embeds";
import type { DiscordNotifier } from "../src/notify-send";
import { FAILURE_COOLDOWN_MS, SEND_SPACING_MS, SUMMARY_INSURANCE_MS } from "../src/notify-plan";
import type { RecentAnalysis } from "../src/analysis-save-extra";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { LLM_NOTE_NO_KEY } from "../src/llm-run";
import { nextAlarmAt, RaceDayCore, RETRY_DELAY_MS, type AlarmInputs, type AnalysisSink, type RaceDayDeps, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import type { SqlLike } from "../src/sql-like";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #205(#166-D): Discord の通知。通知は状態から作る(コールバックにしない)。送信は DO のアラームの中の1ステップで、**多くとも1回**(送る前に `sending` を書く)。
 * ゲート・保存先・送信(notifier)はすべて偽。ストレージは `node:sqlite`(本物の SQLite)。実 netkeiba・実 Discord には触れない。
 * 開催日 20260628(福島 11R の実フィクスチャ 202603020211 が、発走前の分析まで通る)。計画の一覧は、時刻・グレードを自由に決められる最小のマークアップ。
 */

const DATE = "20260628";
const RACE = "202603020211";
const jst = (time: string): number => Date.parse(`2026-06-28T${time}:00+09:00`);
const MIN = 60_000;
const EMPTY_HTML = "<html><body></body></html>";
/** 文書用のダミー(実在しない ID とトークン)。状態・ログ・応答のどこにも出てはいけない値。 */
const SECRET_URL = "https://discord.com/api/webhooks/123456789012345678/dummy-token-for-tests_ABC";

// ---- 一覧の HTML ----

interface ListRow {
  readonly raceId: string;
  readonly venue: string;
  readonly raceNumber: number;
  readonly name: string;
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
  raceId: `2026360628${String(n).padStart(2, "0")}`,
  venue: "水沢",
  raceNumber: n,
  name: `地方${n}R`,
  time,
  ...(grade === undefined ? {} : { grade }),
  kind: "nar",
  ...extra,
});
/** 実フィクスチャのあるレース(福島 11R)。 */
const fixtureRace = (time: string): ListRow => central(11, time, { raceId: RACE, venue: "福島", name: "福島記念テスト" });

const R1 = "202606040901";
const R2 = "202606040902";

// ---- 偽のゲート・保存先・送信 ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const httpError = (): GateResult => ({ kind: "response", status: 500, contentType: "text/html; charset=UTF-8", body: bytes("error"), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });

interface FakeGate extends GateLike {
  readonly urls: string[];
  central: { html: string; failures: GateResult[] };
  nar: { html: string; failures: GateResult[] };
  /** 一覧以外: blocked(取得ステップが即失敗)か、実フィクスチャ。 */
  others: "blocked" | "fixture";
}

function fakeGate(centralHtml: string, narHtml: string): FakeGate {
  const gate: FakeGate = {
    urls: [],
    central: { html: centralHtml, failures: [] },
    nar: { html: narHtml, failures: [] },
    others: "blocked",
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const list = url.startsWith("https://race.netkeiba.com/top/race_list_sub") ? gate.central : url.startsWith("https://nar.netkeiba.com/top/race_list_sub") ? gate.nar : null;
      if (list !== null) {
        return list.failures.shift() ?? ok(list.html);
      }
      if (gate.others === "blocked") return blocked();
      const text = fixtureForUrl(url);
      return text === null ? { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 } : ok(text);
    },
  };
  return gate;
}

interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
  /** save をこの回数だけ「保存してから例外」にする(D1 へ書いたあと、応答を受け取る前にクラッシュした状況)。 */
  crashAfterSave: number;
  /** 保存の直前に、record を書き換える(材料の構築に失敗する状況の再現)。 */
  mutate: ((record: AnalysisRecord) => void) | null;
  /** `findRecentByRace` が返す行(手動の分析)。 */
  recent: RecentAnalysis[];
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    crashAfterSave: 0,
    mutate: null,
    recent: [],
    async save(record) {
      sink.mutate?.(record);
      sink.saved.push(record);
      if (sink.crashAfterSave > 0) {
        sink.crashAfterSave -= 1;
        throw new Error("保存後のクラッシュ");
      }
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return sink.recent;
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

interface FakeNotifier extends DiscordNotifier {
  readonly sent: DiscordPayload[];
  /** 呼ばれた時刻(時計の値)。 */
  readonly at: number[];
  /** 次の送信の振る舞い(先頭から1回ずつ消費。空なら成功)。 */
  script: (Error | "hang" | "ok")[];
}

function fakeNotifier(clock: { now: number }): FakeNotifier {
  const n: FakeNotifier = {
    sent: [],
    at: [],
    script: [],
    async send(payload) {
      n.at.push(clock.now);
      const next = n.script.shift() ?? "ok";
      if (next === "hang") {
        await new Promise<never>(() => undefined);
      }
      if (next instanceof Error) {
        throw next;
      }
      n.sent.push(payload);
    },
  };
  return n;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly notifier: FakeNotifier;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly alarms: number[];
  readonly warnings: string[];
  settings: CloudSettings;
  fault: ((query: string, bindings: readonly unknown[]) => void) | null;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(rows: readonly ListRow[], options: { nar?: string; notifier?: boolean; overrides?: Partial<RaceDayDeps> } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: jst("08:00") };
  const alarm: { at: number | null } = { at: null };
  const alarms: number[] = [];
  const warnings: string[] = [];
  const gate = fakeGate(rows.length === 0 ? EMPTY_HTML : listHtml(rows), options.nar ?? EMPTY_HTML);
  const sink = fakeSink();
  const notifier = fakeNotifier(clock);
  const h = { sql, gate, sink, notifier, clock, alarm, alarms, warnings, settings: DEFAULT_CLOUD_SETTINGS, fault: null } as Harness;
  const faultingSql: SqlLike = {
    exec(query, ...bindings) {
      h.fault?.(query, bindings);
      return sql.exec(query, ...bindings);
    },
  };
  const core = new RaceDayCore({
    sql: faultingSql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarms.push(at);
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => h.settings,
    ...(options.notifier === false ? {} : { notifier }),
    ...options.overrides,
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

/** アラームが鳴る順に進める(`until` より後のアラームでは止まる。鳴らないアラームの無限ループは `max` で検出)。 */
async function drive(h: Harness, until = Number.POSITIVE_INFINITY, max = 120): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const at = h.alarm.at;
    if (at === null || at > until) return out;
    out.push(await tick(h));
  }
  throw new Error("アラームが止まらない(上限超過)");
}

/** 計画(一覧 2 つ + 確定)まで進める。morning は done にして(このテストの主題ではない)、発走前だけを動かす。 */
async function planned(h: Harness, doneMorning = true): Promise<void> {
  h.clock.now = jst("08:00");
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
  for (let i = 0; i < 3; i += 1) await tick(h);
  if (doneMorning) h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'");
}

async function wakeAt(h: Harness, at: number): Promise<string> {
  h.clock.now = at;
  h.alarm.at = at;
  return tick(h);
}

const planRows = (h: Harness): { race_id: string; state: string; skip_reason: string | null; due_ms: number | null }[] =>
  h.sql.exec("SELECT race_id, state, skip_reason, due_ms FROM race_day_plan ORDER BY race_id").toArray() as never;
const notifyRows = (h: Harness): { key: string; kind: string; state: string; error_class: string | null; analysis_id: number | null; payload_json: string | null }[] =>
  h.sql.exec("SELECT key, kind, state, error_class, analysis_id, payload_json FROM race_day_notify ORDER BY key").toArray() as never;
const embedOf = (payload: DiscordPayload): CloudEmbed => payload.embeds[0] as CloudEmbed;
const sentKeys = (h: Harness): string[] => h.notifier.sent.map((p) => embedOf(p).title ?? "");

/** DO のすべての表のすべての値を、1つの文字列にする(URL・トークンがどこにも入っていないことの検査に使う)。 */
function dumpAllTables(h: Harness): string {
  const tables = h.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as { name: string }[];
  return tables.map((t) => JSON.stringify(h.sql.exec(`SELECT * FROM ${t.name}`).toArray())).join("\n");
}

// ---------------------------------------------------------------------------

describe("AC-D1: 発走前の分析が保存されると、分析の embed が1通だけ送られる(材料は保存と同じ同期区間で積む)", () => {
  async function completedDay(): Promise<Harness> {
    const h = harness([fixtureRace("15:35")]);
    h.gate.others = "fixture";
    await planned(h);
    await drive(h, jst("16:00"));
    return h;
  }

  it("通る: 14:50 に昇格 → 取得 → 計算・保存 → 通知。送信は1通で、行は sent・kind=analysis・analysis_id つき。embed は core の形(タイトル・メタ行・LLM 補正の行)", async () => {
    const h = await completedDay();
    expect(h.sink.saved).toHaveLength(1);
    expect(h.notifier.sent).toHaveLength(2); // 朝のまとめ + 分析
    const rows = notifyRows(h);
    expect(rows.map((r) => [r.key, r.kind, r.state])).toEqual([
      [`race:${RACE}`, "analysis", "sent"],
      ["summary", "summary", "sent"],
    ]);
    expect(rows[0]!.analysis_id).toBe(1);
    const analysis = h.notifier.sent.map(embedOf).find((e) => e.title!.includes("福島"))!;
    expect(analysis.description).toContain("2026/06/28 / 福島 /"); // メタ行(日付・会場・コース距離)
    expect(analysis.description).toContain("LLM補正:");
    expect([0x2ecc71, 0x95a5a6]).toContain(analysis.color); // 緑(狙い目あり)か灰色(なし)
    expect(analysis.color === 0x2ecc71 ? !analysis.description!.includes("該当なし") : analysis.description!.includes("該当なし")).toBe(true); // 色と本文が一致
  });

  it("LLM が効かなかった(キー未登録)ときは、固定の理由文が embed に載る(AC-D1 の「LLM なし」)", async () => {
    const h = await completedDay();
    const analysis = h.notifier.sent.map(embedOf).find((e) => e.title!.includes("福島"))!;
    expect(analysis.description).toContain("LLM補正: スキップ");
    expect(analysis.description).toContain(`LLM補正の注記: ${LLM_NOTE_NO_KEY}`);
  });

  it("2通目が出ない: 再実行・アラームの再配信・計画の再依頼を重ねても、送信は増えない", async () => {
    const h = await completedDay();
    const before = h.notifier.sent.length;
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: false, reason: "already-planned" });
    for (let i = 0; i < 5; i += 1) {
      h.clock.now += 10 * MIN;
      h.alarm.at = h.clock.now;
      await tick(h);
    }
    expect(h.notifier.sent).toHaveLength(before);
  });

  it("保存したあと、応答を受け取る前に落ちた(D1 には保存済み、analysis_id は未永続): 再試行が保存済みを検出し、そのときに材料を積む。通知は1通", async () => {
    const h = harness([fixtureRace("15:35")]);
    h.gate.others = "fixture";
    h.sink.crashAfterSave = 1;
    await planned(h);
    const labels = await drive(h, jst("16:00"));
    expect(labels).toContain(`${RACE}:pre_race:compute:retry`); // 前提: 1回目の計算は失敗した
    expect(h.sink.saved).toHaveLength(1); // 再試行は2件目を保存していない
    expect(notifyRows(h).filter((r) => r.kind === "analysis").map((r) => r.state)).toEqual(["sent"]);
    expect(h.notifier.sent.map(embedOf).filter((e) => e.title!.includes("福島"))).toHaveLength(1);
  });

  it("材料の INSERT が例外になった(analysis_id より前に書く順序): analysis_id は永続されず、再試行が材料を書き直す。状態に「analysis_id あり・材料なし」が一瞬も現れない", async () => {
    const h = harness([fixtureRace("15:35")]);
    h.gate.others = "fixture";
    let thrown = 0;
    h.fault = (query) => {
      if (query.includes("INSERT INTO race_day_notify") && query.includes("'ready'") && thrown === 0) {
        thrown += 1;
        throw new Error("SQL の故障");
      }
    };
    await planned(h);
    const invariant: boolean[] = [];
    for (let i = 0; i < 40 && h.alarm.at !== null && h.alarm.at <= jst("16:00"); i += 1) {
      await tick(h);
      const task = h.sql.exec("SELECT analysis_id FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { analysis_id: number | null }[];
      const material = notifyRows(h).some((r) => r.key === `race:${RACE}`);
      if (task[0]?.analysis_id !== null && task[0] !== undefined) invariant.push(material);
    }
    expect(thrown).toBe(1); // 前提: 故障を実際に注入した
    expect(invariant.length).toBeGreaterThan(0); // 空振り防止: analysis_id が永続された状態を観測した
    expect(invariant.every(Boolean)).toBe(true); // analysis_id があるとき、材料は必ずある
    expect(h.notifier.sent.map(embedOf).filter((e) => e.title!.includes("福島"))).toHaveLength(1);
  });

  it("材料(embed)の構築に失敗しても、分析は done のまま。最小の embed(画面で確認)を代わりに送る(G-D7)", async () => {
    const h = harness([fixtureRace("15:35")]);
    h.gate.others = "fixture";
    h.sink.mutate = (record) => {
      // スナップショットが想定の形でない(record 本体は保存のためにコピーされるので、共有されているスナップショットのオブジェクトを壊す)。
      (record.raceSnapshot as { race?: unknown }).race = undefined;
    };
    await planned(h);
    await drive(h, jst("16:00"));
    const task = h.sql.exec("SELECT status FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { status: string }[];
    expect(task[0]!.status).toBe("done");
    const analysis = h.notifier.sent.map(embedOf).find((e) => e.title!.includes("福島"))!;
    expect(analysis.description).toContain("画面で確認");
    expect(h.warnings.some((w) => w.includes("通知の材料"))).toBe(true); // 警告が残る
  });

  it("手動の pre_race(自動の印が無い)は、材料も通知の行も作らない(手動の分析では通知しない。従来どおり)", async () => {
    const h = harness([]);
    h.gate.others = "fixture";
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await drive(h, jst("23:00"), 20);
    expect(h.sink.saved).toHaveLength(1); // 前提: 分析は走った
    expect(notifyRows(h)).toEqual([]);
    expect(h.notifier.sent).toEqual([]);
  });
});

describe("G-D6: webhook が無効(notifier が無い)なら、材料も行も積まず、通知のためのアラームも張らない", () => {
  it("同じ1日を notifier なしで回す: 分析は done になり、通知の表は空。最後のアラームは掃除(26 時間後)だけで、通知のための起床は無い", async () => {
    const h = harness([fixtureRace("15:35")], { notifier: false });
    h.gate.others = "fixture";
    await planned(h);
    await drive(h, jst("16:00"));
    expect(h.sink.saved).toHaveLength(1);
    expect(notifyRows(h)).toEqual([]);
    expect(h.sql.statements.filter((s) => s.includes("INSERT INTO race_day_notify"))).toEqual([]);
    expect(h.alarm.at).toBeGreaterThan(jst("16:00") + 20 * 60 * MIN); // 次のアラームは掃除(約 26 時間後)
    expect(h.core.getNotifications()).toEqual([]);
  });

  it("失敗の結果があっても、行を作らず、送らない(材料の積み上げもアラームの継続も無い)", async () => {
    const h = harness([central(1, "15:35")], { notifier: false });
    await planned(h);
    const labels = await drive(h, jst("16:00"));
    expect(labels).toContain(`${R1}:pre_race:fetch:failed`); // 前提: 失敗した
    expect(notifyRows(h)).toEqual([]);
    expect(h.alarm.at === null || h.alarm.at > jst("16:00")).toBe(true);
  });
});

describe("G-D6: webhook を後から登録した場合", () => {
  it("登録前に完了したレースは通知しない(材料を積んでいない)。登録後は、未送信の朝のまとめだけが送られる。分析・タスクの状態は変わらない", async () => {
    const h = harness([fixtureRace("15:35")], { notifier: false });
    h.gate.others = "fixture";
    await planned(h);
    await drive(h, jst("16:00"));
    expect(h.core.getAutoRunResults().results[0]!.outcome).toMatchObject({ kind: "completed" }); // 前提: 登録前に完了した
    const restarted = new RaceDayCore({
      sql: h.sql,
      now: () => h.clock.now,
      gate: h.gate,
      setAlarm: (at) => {
        h.alarm.at = at;
      },
      onWarn: (m) => h.warnings.push(m),
      sink: h.sink,
      loadSettings: async () => h.settings,
      notifier: h.notifier, // 登録した(DO が新しいデプロイで起き直した)
    });
    h.clock.now = jst("16:30");
    h.alarm.at = h.clock.now;
    for (let i = 0; i < 4; i += 1) await restarted.runNextStep();
    expect(notifyRows(h).map((r) => r.key)).toEqual(["summary"]); // 分析の通知の行は無い
    expect(h.notifier.sent).toHaveLength(1);
  });
});

describe("Issue #230: 分析の通知のタイトルのリンク(送信の直前に付ける)", () => {
  /** 文書用のダミー(example.test は実在しないホスト)。 */
  const BASE = "https://keiba.example.test";
  const withBase = (h: Harness, appBaseUrl: string | undefined): RaceDayCore =>
    new RaceDayCore({
      sql: h.sql,
      now: () => h.clock.now,
      gate: h.gate,
      setAlarm: (at) => {
        h.alarm.at = at;
      },
      onWarn: (m) => h.warnings.push(m),
      sink: h.sink,
      loadSettings: async () => h.settings,
      notifier: h.notifier,
      ...(appBaseUrl === undefined ? {} : { appBaseUrl }),
    });
  const analysisEmbed = (h: Harness): CloudEmbed => h.notifier.sent.map(embedOf).find((e) => e.title!.includes("福島"))!;

  async function dayWith(appBaseUrl: string | undefined, mutate?: (h: Harness) => void): Promise<Harness> {
    const h = harness([fixtureRace("15:35")], { overrides: appBaseUrl === undefined ? {} : { appBaseUrl } });
    h.gate.others = "fixture";
    await planned(h);
    mutate?.(h);
    await drive(h, jst("16:00"));
    return h;
  }

  it("APP_BASE_URL がある: 分析の embed のタイトルに url(オリジン/#date=…&venue=central&race=…&analysis=<保存した分析 id>)が付く。朝のまとめには付かない", async () => {
    const h = await dayWith(BASE);
    expect(h.notifier.sent).toHaveLength(2); // 前提: 朝のまとめ + 分析
    expect(analysisEmbed(h).url).toBe(`${BASE}/#date=${DATE}&venue=central&race=${RACE}&analysis=1`);
    const summary = h.notifier.sent.map(embedOf).find((e) => !e.title!.includes("福島"))!;
    expect(summary.url).toBeUndefined();
  });

  it("サイトの URL は、材料(payload_json)にも DO のどの表にも残らない(送信の直前に足すだけ)。分析の id は材料の行(analysis_id)にある", async () => {
    const h = await dayWith(BASE);
    expect(notifyRows(h).find((r) => r.key === `race:${RACE}`)!.analysis_id).toBe(1);
    expect(dumpAllTables(h)).not.toContain("keiba.example.test");
    expect(h.warnings.join("\n")).not.toContain("keiba.example.test");
  });

  it("APP_BASE_URL が無い: url は付かない(キーも無い)が、通知は送られる(分析の embed は 2 つの field を持つ)", async () => {
    const h = await dayWith(undefined);
    const embed = analysisEmbed(h);
    expect("url" in embed).toBe(false);
    expect(embed.fields?.map((f) => f.name.split("(")[0])).toEqual(["印", "買い目"]);
  });

  it("後から登録した: 登録前に積まれた未送信の材料(ready)にも、登録後の送信ではリンクが付く(材料は URL を持たない)", async () => {
    const h = harness([fixtureRace("15:35")]);
    h.gate.others = "fixture";
    await planned(h);
    const analysisRow = (): { state: string } | undefined => notifyRows(h).find((r) => r.key === `race:${RACE}`);
    for (let i = 0; i < 60 && analysisRow()?.state !== "ready"; i += 1) await tick(h);
    expect(analysisRow()?.state, "前提: 分析の材料が積まれ、まだ送られていない").toBe("ready");
    expect(h.notifier.sent.map(embedOf).some((e) => e.title!.includes("福島"))).toBe(false);
    const restarted = withBase(h, BASE); // 登録した(DO が新しいデプロイで起き直した)
    for (let i = 0; i < 20 && h.alarm.at !== null && h.alarm.at <= jst("16:00"); i += 1) {
      h.clock.now = Math.max(h.clock.now, h.alarm.at);
      h.alarm.at = null;
      await restarted.runNextStep();
    }
    expect(analysisRow()?.state).toBe("sent");
    expect(analysisEmbed(h).url).toBe(`${BASE}/#date=${DATE}&venue=central&race=${RACE}&analysis=1`);
    expect(dumpAllTables(h)).not.toContain("keiba.example.test");
  });

  it("地方のレース(計画の行の venue が nar)は venue=nar のリンクになる", async () => {
    const h = await dayWith(BASE, (x) => x.sql.exec("UPDATE race_day_plan SET venue = 'nar'"));
    expect(analysisEmbed(h).url).toBe(`${BASE}/#date=${DATE}&venue=nar&race=${RACE}&analysis=1`);
  });

  it("配分が未設定(既定)の分析: 買い目の field は固定文。印の field もある(印はキー未登録の LLM なしのため『ありません』)", async () => {
    const h = await dayWith(BASE);
    const embed = analysisEmbed(h);
    expect(embed.fields).toEqual([
      { name: "印", value: "印の付いた馬はありません" },
      { name: "買い目", value: "総資金と1レースの上限が未設定のため、配分の提案は出ていません" },
    ]);
  });
});

describe("G-D3: 失敗・スキップの通知(固定文)", () => {
  it("failed(blocked): 赤の通知が1通。本文は固定の理由文で、タスクのエラー文(ブレーカーの文面)は載せない。行は sent・kind=failed", async () => {
    const h = harness([central(1, "15:35")]);
    await planned(h);
    await drive(h, jst("14:49")); // 朝のまとめを先に送り終える(このテストの主題ではない)
    await wakeAt(h, jst("14:50")); // 昇格 + 取得 → blocked で failed
    expect(h.core.getAutoRunResults().results[0]!.outcome).toMatchObject({ kind: "failed", reason: "blocked" });
    await drive(h, jst("16:00"));
    const embeds = h.notifier.sent.map(embedOf);
    const red = embeds.find((e) => e.color === 0xe74c3c)!;
    expect(red.title).toBe("中山 1R 中央1R");
    expect(red.description).toContain(failureText("blocked"));
    expect(red.description).toContain("発走 15:35");
    expect(JSON.stringify(embeds)).not.toContain("ブレーカーが開いています"); // タスクのエラー文の生の値は載せない
    expect(notifyRows(h).find((r) => r.key === `race:${R1}`)).toMatchObject({ kind: "failed", state: "sent", error_class: null });
  });

  it("昇格の時点の skipped(started): 赤の通知が1通(期限が残っている行 = 昇格の時点のスキップ)", async () => {
    const h = harness([central(1, "15:35")]);
    await planned(h);
    await wakeAt(h, jst("15:35")); // アラームが発走まで遅れた → 昇格の時点で started
    expect(planRows(h)[0]).toMatchObject({ state: "skipped", skip_reason: "started" });
    expect(planRows(h)[0]!.due_ms).not.toBeNull(); // 昇格の時点のスキップは、期限が残る
    await drive(h, jst("16:00"));
    const red = h.notifier.sent.map(embedOf).filter((e) => e.color === 0xe74c3c);
    expect(red).toHaveLength(1);
    expect(red[0]!.description).toContain(failureText("started"));
  });

  it("昇格の時点の skipped(manual): 灰色の通知が1通(固定文)", async () => {
    const h = harness([central(1, "15:35")]);
    await planned(h);
    // 手動の pre_race が DO にある(done)と、D1 に聞く。現行の版で LLM が効いた手動の分析が窓の中にあれば、重複(スキップ)。
    h.sql.exec(
      "INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, analyzed_at, analysis_id, detail) VALUES (?, 'pre_race', 'done', 1, 1, ?, ?, ?, 3, 'stored')",
      R1,
      jst("14:40"),
      jst("14:41"),
      jst("14:40"),
    );
    h.sink.recent = [{ id: 1, analyzedAt: new Date(jst("14:45")).toISOString(), promptVersion: CLIP_VARIANTS.default.promptVersion, model: "m" }];
    await wakeAt(h, jst("14:50"));
    expect(planRows(h)[0]).toMatchObject({ state: "skipped", skip_reason: "manual" });
    await drive(h, jst("16:00"));
    const gray = h.notifier.sent.map(embedOf).filter((e) => e.description?.includes(MANUAL_SKIP_TEXT));
    expect(gray).toHaveLength(1);
    expect(gray[0]!.color).toBe(0x95a5a6);
    expect(notifyRows(h).find((r) => r.key === `race:${R1}`)).toMatchObject({ kind: "skipped-manual", state: "sent" });
  });

  it("計画の時点の skipped(started・too-late・no-start-time): レースごとの通知は送らず、朝のまとめにだけ載る。期限は無い(due_ms が null = 計画の時点)", async () => {
    // 計画は 12:00 に行う。中央 1R は 11:00 発走(started)、2R は 12:05 発走(期限は過ぎ、発走まで 5 分 = too-late)、3R は時刻なし。
    const h = harness([central(1, "11:00"), central(2, "12:05"), central(3, null)]);
    h.clock.now = jst("12:00");
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
    for (let i = 0; i < 3; i += 1) await tick(h);
    const rows = planRows(h);
    expect(rows.map((r) => [r.race_id, r.state, r.skip_reason, r.due_ms])).toEqual([
      ["202606040901", "skipped", "started", null],
      ["202606040902", "skipped", "too-late", null],
      ["202606040903", "skipped", "no-start-time", null],
    ]);
    await drive(h, jst("20:00"));
    expect(notifyRows(h).map((r) => r.key)).toEqual(["summary"]); // レースごとの行は無い
    const summary = embedOf(h.notifier.sent[0]!);
    expect(summary.description).toContain("スキップ: 発走済み 1・時刻不明 1・間に合わない 1");
  });

  it("superseded: 失敗のあと、通知の前に利用者が手動で再実行したら、通知しない(利用者が自分で再実行している)", async () => {
    const h = harness([central(1, "15:35")]);
    await planned(h);
    await drive(h, jst("14:49")); // 朝のまとめを先に送り終える
    h.clock.now = jst("14:50");
    h.alarm.at = h.clock.now;
    expect(await tick(h)).toBe(`${R1}:pre_race:fetch:failed`); // 次の起床で通知を送る前
    await h.core.schedule({ raceId: R1, kaisaiDate: DATE, mode: "pre_race" }); // 手動の再実行(自動の印が消える)
    expect(h.core.getAutoRunResults().results[0]!.outcome).toEqual({ kind: "superseded" });
    h.sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'pre_race'"); // 手動の実行は終わった(このテストの主題ではない)
    await drive(h, jst("16:00"));
    expect(notifyRows(h).filter((r) => r.key.startsWith("race:"))).toEqual([]);
  });

  it("waiting・running の間は、レースごとの通知を送らない(期限前・実行中)", async () => {
    const h = harness([central(1, "15:35")]);
    await planned(h);
    await drive(h, jst("14:49")); // 期限(14:50)の前
    expect(h.core.getAutoRunResults().results[0]!.outcome).toEqual({ kind: "waiting" });
    expect(notifyRows(h).filter((r) => r.key.startsWith("race:"))).toEqual([]);
  });
});

describe("AC-D3・G-D5: 朝のまとめ(1日に1回)", () => {
  it("全 morning が終端になったら送る: 中央の場ごとの field と「地方 交流重賞」の field が並ぶ。1通だけで、その後の起床で増えない", async () => {
    const h = harness([central(1, "15:35"), central(2, "15:40")], { nar: listHtml([nar(11, "20:10", "Jpn3")]) });
    await planned(h, false); // morning を実際に回す(gate は blocked → 取得で失敗。終端になる)
    await drive(h, jst("14:00"));
    const summaries = h.notifier.sent.map(embedOf).filter((e) => e.title!.startsWith("朝の準備"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.fields!.map((f) => f.name)).toEqual(["中山", "地方 交流重賞"]);
    expect(summaries[0]!.fields![0]!.value).toBe("1R 中央1R 15:35 準備失敗\n2R 中央2R 15:40 準備失敗");
    expect(summaries[0]!.fields![1]!.value).toBe("水沢 11R 地方11R 20:10 準備失敗");
    expect(summaries[0]!.color).toBe(0xe74c3c); // 全レース失敗でも送る(赤)
    // 以後の起床で増えない
    await drive(h, jst("16:00"));
    expect(h.notifier.sent.map(embedOf).filter((e) => e.title!.startsWith("朝の準備"))).toHaveLength(1);
  });

  it("未完了のまま保険の時刻(確定 + 60 分)になったら、「未完了 N 件」として送る。確定の 60 分後より前には送らない", async () => {
    const h = harness([central(1, "15:35"), central(2, "15:40")]);
    await planned(h, false);
    const finalizedAt = Number(h.sql.exec("SELECT value FROM race_day_meta WHERE key = 'plan_finalized_at'").toArray().map((r: any) => r.value)[0]);
    // morning を動かさず(時計だけ進める)、確定の 60 分後の 1ms 前: 送らない
    h.clock.now = finalizedAt + SUMMARY_INSURANCE_MS - 1;
    expect(h.core.peekNotifyPlan().sendNow).toBeNull();
    expect(h.core.peekNotifyPlan().nextAtMs).toBe(finalizedAt + SUMMARY_INSURANCE_MS);
    // ちょうど: 送る資格ができる(morning はまだ queued)
    h.clock.now = finalizedAt + SUMMARY_INSURANCE_MS;
    expect(h.core.peekNotifyPlan().sendNow).toEqual({ key: "summary", kind: "summary" });
    h.alarm.at = h.clock.now;
    expect(await tick(h)).toBe("summary:notify:send:ok");
    const summary = embedOf(h.notifier.sent[0]!);
    expect(summary.description).toContain("未完了 2 件のまま送信しています");
    expect(summary.fields![0]!.value).toContain("未完了");
  });

  it("対象が 0 件の日(全会場の一覧が取れて、対象が 0 件)は送らない。アラームも通知のためには張らない", async () => {
    const h = harness([]);
    await planned(h);
    await drive(h, jst("20:00"));
    expect(h.core.getPlanProgress().rows).toEqual([]);
    expect(h.core.getPlanProgress().morningAllTerminal).toBe(true); // 前提: 空の every は真(それでも送らない)
    expect(h.notifier.sent).toEqual([]);
    expect(notifyRows(h)).toEqual([]);
  });

  it("全会場の一覧の取得に失敗した日は、対象が 0 件でもまとめを送る(自動実行が壊れていることを知らせる)。中央・地方の取得失敗を載せる", async () => {
    const h = harness([]);
    h.gate.central.failures = [httpError(), httpError(), httpError()];
    h.gate.nar.failures = [httpError(), httpError(), httpError()];
    h.clock.now = jst("08:00");
    await h.core.requestPlan({ kaisaiDate: DATE });
    await drive(h, jst("20:00"));
    const progress = h.core.getPlanProgress();
    expect(progress.venues.map((v) => v.state)).toEqual(["failed", "failed"]); // 前提
    expect(progress.rows).toEqual([]);
    const summary = embedOf(h.notifier.sent[0]!);
    expect(h.notifier.sent).toHaveLength(1);
    expect(summary.description).toContain("中央の一覧を取得できませんでした");
    expect(summary.description).toContain("地方の一覧を取得できませんでした");
    expect(summary.color).toBe(0xe74c3c);
  });

  it("地方の一覧だけ失敗: 中央のレースと一緒に1通。「地方 交流重賞」の field に取得失敗が載る(AC-D5)", async () => {
    const h = harness([central(1, "15:35")]);
    h.gate.nar.failures = [httpError(), httpError(), httpError()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    await drive(h, jst("14:00"));
    expect(h.core.getPlanProgress().venues.map((v) => v.state)).toEqual(["ok", "failed"]); // 前提
    const summary = embedOf(h.notifier.sent[0]!);
    expect(summary.fields!.map((f) => f.name)).toEqual(["中山", "地方 交流重賞"]);
    expect(summary.fields![1]!.value).toContain("取得できませんでした");
  });
});

describe("AC-D2・G-D1: 送信の失敗・多くとも1回・URL を出さない", () => {
  const failing = (): Error => new DiscordNotifyError(`拒否されました ${SECRET_URL}`, { status: 404, responseBody: SECRET_URL });

  it("送信が失敗しても、分析のタスクは done のまま。失敗は状態から読める(行は failed・分類 http-404)。再送しない", async () => {
    const h = harness([fixtureRace("15:35")]);
    h.gate.others = "fixture";
    h.notifier.script = ["ok", failing()]; // 1通目(朝のまとめ)は成功、2通目(分析)が失敗
    await planned(h);
    await drive(h, jst("16:00"));
    const task = h.sql.exec("SELECT status FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { status: string }[];
    expect(task[0]!.status).toBe("done");
    expect(h.core.getAutoRunResults().results[0]!.outcome).toMatchObject({ kind: "completed" });
    expect(h.core.getNotifications().find((n) => n.key === `race:${RACE}`)).toMatchObject({ kind: "analysis", state: "failed", errorClass: "http-404" });
    const calls = h.notifier.at.length;
    for (let i = 0; i < 4; i += 1) {
      h.clock.now += 30 * MIN;
      h.alarm.at = h.clock.now;
      await tick(h);
    }
    expect(h.notifier.at).toHaveLength(calls); // 自動では再送しない
  });

  it("URL(秘密)は、DO のどの表にも、ログ(onWarn)にも、通知の一覧(getNotifications)にも出ない: URL を含む例外・応答本文を投げさせた後で、全表を走査する", async () => {
    const h = harness([central(1, "15:35")]);
    h.notifier.script = [failing(), new Error(`fetch failed ${SECRET_URL}`)];
    await planned(h);
    await drive(h, jst("16:00"));
    const failedRows = notifyRows(h).filter((r) => r.state === "failed");
    expect(failedRows.length).toBe(2); // 前提: 2通とも失敗した(= 例外を実際に通した)
    expect(failedRows.map((r) => r.error_class).sort()).toEqual(["http-404", "network"]);
    for (const text of [dumpAllTables(h), h.warnings.join("\n"), JSON.stringify(h.core.getNotifications()), JSON.stringify(h.core.getBoard()), JSON.stringify(h.core.getPlanProgress())]) {
      expect(text).not.toContain("dummy-token");
      expect(text).not.toContain("discord.com/api/webhooks");
    }
    expect(h.warnings.some((w) => w.includes("Discord"))).toBe(true); // 失敗は警告に残る(分類だけ)
  });

  it("多くとも1回: 送信の途中で落ちて(sending のまま)再起動しても、同じ通知(朝のまとめ)を再送しない。ほかの通知は送られる", async () => {
    const h = harness([central(1, "15:35")]);
    h.notifier.script = ["hang"]; // 最初の送信(朝のまとめ)が、応答の返らないまま止まる
    await planned(h);
    void h.core.runNextStep(); // 送信で止まる(DO が落ちた状況)
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifyRows(h).map((r) => [r.key, r.state])).toEqual([["summary", "sending"]]); // 前提: 送る前に sending が書かれている
    expect(h.notifier.at).toHaveLength(1);
    // 同じ DO のストレージで、新しいインスタンスが起きる(再起動)
    const restarted = new RaceDayCore({
      sql: h.sql,
      now: () => h.clock.now,
      gate: h.gate,
      setAlarm: (at) => {
        h.alarm.at = at;
      },
      onWarn: (m) => h.warnings.push(m),
      sink: h.sink,
      loadSettings: async () => h.settings,
      notifier: h.notifier,
    });
    for (let i = 0; i < 8; i += 1) {
      h.clock.now = Math.max(h.clock.now + 5 * MIN, jst("14:50") * (i === 1 ? 1 : 0));
      await restarted.runNextStep();
    }
    expect(h.notifier.at).toHaveLength(2); // 1 通目は止まった朝のまとめ。増えたのは失敗の通知 1 通だけ(まとめの再送は無い)
    const rows = notifyRows(h);
    expect(rows.find((r) => r.key === "summary")!.state).toBe("sending"); // 再送せず、sending のまま残る(欠落を選ぶ)
    expect(rows.find((r) => r.key === `race:${R1}`)!.state).toBe("sent");
  });

  it("失敗のクールダウン: 失敗した送信の 60 秒後まで、次の通知を送らない(Discord が止まっているときに、タスクを押しのけない)", async () => {
    const h = harness([central(1, "15:35"), central(2, "15:35")]); // 同じ発走(期限も同じ 14:50)
    h.notifier.script = ["ok", failing(), "ok"]; // 朝のまとめ(成功)→ 1R(失敗)→ 2R(成功)
    await planned(h);
    await drive(h, jst("14:49"));
    await wakeAt(h, jst("14:50"));
    await drive(h, jst("16:00"));
    const T = jst("14:50");
    expect(h.notifier.at.slice(1)).toEqual([T, T + FAILURE_COOLDOWN_MS]); // 2R は、失敗した 1R の 60 秒後
    expect(notifyRows(h).map((r) => [r.key, r.state])).toEqual([
      [`race:${R1}`, "failed"],
      [`race:${R2}`, "sent"],
      ["summary", "sent"],
    ]);
  });

  it("送信の間隔: 成功のあとは 1 秒空ける(連続する通知が同じ時刻に出ない)", async () => {
    const h = harness([central(1, "15:35"), central(2, "15:35")]);
    await planned(h);
    await drive(h, jst("14:49"));
    await wakeAt(h, jst("14:50"));
    await drive(h, jst("16:00"));
    const T = jst("14:50");
    expect(h.notifier.at.slice(1)).toEqual([T, T + SEND_SPACING_MS]);
  });
});

describe("G-D2: 順序とアラーム", () => {
  it("nextAlarmAt: notifyAtMs は計画と同じ候補(過去は now)。省略は null と同じ(既存の呼び出しを壊さない)", () => {
    const base: AlarmInputs = { nowMs: 1000, retryDelayMs: RETRY_DELAY_MS, immediateWork: false, retryWork: false, planNextTryAtMs: null, planNextDueMs: null, purgeDueMs: null };
    expect(nextAlarmAt(base)).toBeNull();
    expect(nextAlarmAt({ ...base, notifyAtMs: null })).toBeNull();
    expect(nextAlarmAt({ ...base, notifyAtMs: 5000 })).toBe(5000);
    expect(nextAlarmAt({ ...base, notifyAtMs: 10 })).toBe(1000); // 過去は now
    expect(nextAlarmAt({ ...base, notifyAtMs: 5000, purgeDueMs: 9000 })).toBe(5000); // 最も早いもの
    expect(nextAlarmAt({ ...base, immediateWork: true, notifyAtMs: 5000 })).toBe(1000);
    expect(nextAlarmAt({ ...base, retryWork: true, notifyAtMs: 5000 })).toBe(1000 + RETRY_DELAY_MS > 5000 ? 5000 : 1000 + RETRY_DELAY_MS);
  });

  it("通知はタスク(pickNext)の前に動く: 取得待ちの pre_race が残っていても、時刻が来た通知が先に送られる", async () => {
    const h = harness([central(1, "15:35"), central(2, "15:35")]);
    await planned(h); // morning は done
    await drive(h, jst("14:49")); // 朝のまとめを送る
    await wakeAt(h, jst("14:50")); // 昇格(両方)+ 1R の取得が failed
    const queued = h.sql.exec("SELECT race_id FROM race_day_tasks WHERE mode = 'pre_race' AND status = 'queued'").toArray();
    expect(queued).toHaveLength(1); // 前提: 2R の取得待ちが残っている
    expect(await tick(h)).toBe(`${R1}:notify:send:ok`); // 2R の取得より先に、1R の失敗の通知
    expect(await tick(h)).toBe(`${R2}:pre_race:fetch:failed`); // その後でタスク(間隔 1 秒のあいだ、通知は待つ)
  });

  it("offset = 180 分(immediate の行が多い日): 朝の 9:00 に計画すると、昼前の発走のレースは期限が過ぎて immediate になる。通知は壊れず、各レースの通知とまとめが1通ずつ出る", async () => {
    const h = harness([central(1, "10:00"), central(2, "10:30"), central(3, "15:35")]);
    h.settings = { ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: 180 };
    h.clock.now = jst("09:00");
    await h.core.requestPlan({ kaisaiDate: DATE });
    await drive(h, jst("20:00"));
    const dispositions = h.core.getPlanProgress().rows.map((r) => r.disposition);
    expect(dispositions).toEqual(["immediate", "immediate", "scheduled"]); // 前提: immediate が 2 件
    const keys = notifyRows(h).map((r) => r.key);
    expect(keys).toEqual([`race:${R1}`, `race:${R2}`, "race:202606040903", "summary"]);
    expect(notifyRows(h).every((r) => r.state === "sent")).toBe(true);
  });

  it("offset = 10 分(最小)で、アラームが期限より遅れても、昇格して失敗の通知が1通ずつ出る(通知が too-late に巻き込まれない)", async () => {
    const h = harness([central(1, "15:35")]);
    h.settings = { ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: 10 };
    await planned(h);
    await wakeAt(h, jst("15:25") + 1); // 期限(15:25)より 1ms 遅れて起きる
    expect(planRows(h)[0]).toMatchObject({ state: "promoted" });
    await drive(h, jst("16:00"));
    expect(notifyRows(h).filter((r) => r.key.startsWith("race:")).map((r) => [r.kind, r.state])).toEqual([["failed", "sent"]]);
  });
});

describe("G-D2: 即時ループ・停止がない(fuzz)", () => {
  /** 小さな乱数(再現のため種を固定)。 */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("60 通りの乱数(送信の成功・失敗・時計の飛び・手動の割り込み)で、起きても状態が変わらない即時の起床が 0、止まった時点で送るべき通知が残っていない", async () => {
    let wakes = 0;
    let sendsTotal = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = rng(seed);
      const rows: ListRow[] = [];
      const count = 1 + Math.floor(random() * 6);
      // 半分の種では、全レースの発走を同じ時刻にそろえる(通知が同時に何件も溜まり、送信の間隔・クールダウンの経路を通る)。
      const clustered = random() < 0.5;
      const clusterTime = `${String(13 + Math.floor(random() * 5)).padStart(2, "0")}:${random() < 0.5 ? "05" : "35"}`;
      for (let i = 1; i <= count; i += 1) {
        rows.push(central(i, clustered ? clusterTime : `${String(13 + Math.floor(random() * 5)).padStart(2, "0")}:${random() < 0.5 ? "05" : "35"}`));
      }
      const h = harness(rows);
      h.settings = { ...DEFAULT_CLOUD_SETTINGS, preRaceOffsetMinutes: [10, 45, 180][Math.floor(random() * 3)]! };
      h.notifier.script = Array.from({ length: 12 }, () => (random() < 0.3 ? new DiscordNotifyError("x", { status: 500 }) : "ok"));
      h.clock.now = jst("09:00");
      await h.core.requestPlan({ kaisaiDate: DATE });
      for (let step = 0; step < 150; step += 1) {
        const at = h.alarm.at;
        if (at === null) break;
        if (at > jst("23:00")) break;
        if (random() < 0.15) {
          // 手動の再実行が割り込む
          await h.core.schedule({ raceId: rows[Math.floor(random() * rows.length)]!.raceId, kaisaiDate: DATE, mode: "pre_race" }).catch(() => undefined);
        }
        const before = `${dumpAllTables(h)}|${h.notifier.at.length}`;
        h.clock.now = Math.max(h.clock.now, h.alarm.at ?? 0) + (random() < 0.2 ? Math.floor(random() * 10 * MIN) : 0);
        h.alarm.at = null;
        await h.core.runNextStep();
        wakes += 1;
        const after = `${dumpAllTables(h)}|${h.notifier.at.length}`;
        if (before === after && h.alarm.at !== null && h.alarm.at <= h.clock.now) {
          // 状態が変わらず、now 以前にアラームを張り直した = 即時ループ
          throw new Error(`seed ${seed}: 状態が変わらないのに now 以前へ張り直した`);
        }
      }
      const plan = h.core.peekNotifyPlan();
      if (h.alarm.at === null) {
        expect(plan.sendNow, `seed ${seed}: アラームが無いのに送るべき通知が残っている`).toBeNull();
      }
      sendsTotal += h.notifier.sent.length;
      // 送ったものは、行が sent のものと一致する(二重送信がない)
      expect(notifyRows(h).filter((r) => r.state === "sent")).toHaveLength(h.notifier.sent.length);
      for (const r of notifyRows(h)) {
        expect(["ready", "sending", "sent", "failed"]).toContain(r.state);
      }
    }
    expect(wakes).toBeGreaterThan(300); // 空振り防止: 十分な起床を観測した
    expect(sendsTotal).toBeGreaterThan(60); // 空振り防止: 送信の経路を多数通った
  });
});
