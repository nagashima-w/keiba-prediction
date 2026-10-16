import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalysisRecord, RaceComboPayoutsSaveInput, RaceResultDetail, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { CourseType } from "../../packages/core/src/scraper/types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { MAX_ATTEMPTS, RaceDayCore, REPORT_HOLD_KEY, RETRY_DELAY_MS, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #291: 手動の分析だけの日は、先に分析したレースの結果がそろった時点で「静か」になり、日報が依頼されて、あとから分析したレースが抜けていた。
 * 対応: 手動で分析したレースの開催(競馬場・日)の最終レースの発走時刻までは、日報を依頼しない(下限の時刻)。
 * 下限は発走前の取得ステップで、その日のレース一覧(`getRaceList`)から求めて meta に記録する。下限になったらアラームで起きて、日報を依頼する。
 * ゲートは偽(一覧・結果・出馬表はフィクスチャ)、保存先は偽、ストレージは `node:sqlite`。`race-day-manual-sameday-result.test.ts` と同じ流儀。
 *
 * 地方(川崎。2026-10-13 の実際の事例)の race_id は `2026451013NN`、中央の手動の対象は `202603020211`(出馬表の発走 15:45)。
 * 川崎の一覧は 10R 19:40・11R 20:15・12R 20:50(最終)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20261013";
const jst = (time: string, date = "2026-10-13"): number => Date.parse(`${date}T${time}:00+09:00`);
const JST_0900 = jst("09:00");
const MIN = 60_000;

const EMPTY_HTML = "<html><body></body></html>";
/** 地方の結果ページ(実フィクスチャ。12 頭・単勝の払戻あり。どの地方のレースにも使い回す)。 */
const NAR_RESULT = fixture("nar_result_202654071210.html");
/** 中央の 16 頭の確定した結果ページ。 */
const CENTRAL_RESULT = fixture("result_202603020211.html");
const WARN_TEXT = "日報の時刻の下限を求められませんでした";

interface ListRow {
  readonly raceId: string;
  readonly venue: string;
  readonly raceNumber: number;
  readonly name: string;
  readonly time: string | null;
}
function listHtml(rows: readonly ListRow[]): string {
  const venues = [...new Set(rows.map((r) => r.venue))];
  return venues
    .map((venue) => {
      const items = rows
        .filter((r) => r.venue === venue)
        .map(
          (r) => `<li class="RaceList_DataItem">
<a href="../race/shutuba.html?race_id=${r.raceId}&rf=race_list">
<div class="Race_Num"><span>${r.raceNumber}R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle"><span class="ItemTitle">${r.name}</span></div>
<div class="RaceData"><span class="RaceList_Itemtime">${r.time ?? ""} </span><span class="Dart">ダ1200m</span>16頭</div>
</div>
</a>
</li>`,
        )
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

/** 地方の race_id: 場コード 45(川崎)・44(大井)+ 月日 1013 + レース番号。 */
const kawasaki = (n: number): string => `2026451013${String(n).padStart(2, "0")}`;
const ooi = (n: number): string => `2026441013${String(n).padStart(2, "0")}`;
const KAWASAKI_HEAD = "2026451013";
const OOI_HEAD = "2026441013";
const nar = (id: string, venue: string, n: number, time: string | null): ListRow => ({ raceId: id, venue, raceNumber: n, name: `${venue}${n}R`, time });
const KAWASAKI_ROWS: readonly ListRow[] = [nar(kawasaki(9), "川崎", 9, "19:05"), nar(kawasaki(10), "川崎", 10, "19:40"), nar(kawasaki(11), "川崎", 11, "20:15"), nar(kawasaki(12), "川崎", 12, "20:50")];
const KAWASAKI_LAST = jst("20:50");
/** 中央の手動の対象 202603020211 と同じ開催(先頭 10 桁 2026030202)の一覧。11R が手動の対象で、最終は 12R 16:25。 */
const CENTRAL_HEAD = "2026030202";
const CENTRAL_ROWS: readonly ListRow[] = [
  { raceId: "202603020211", venue: "福島", raceNumber: 11, name: "福島11R", time: "15:45" },
  { raceId: "202603020212", venue: "福島", raceNumber: 12, name: "福島12R", time: "16:25" },
];

// ---- 偽のゲート ----

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okPage = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "拒否(本文は状態・警告に入れない)SECRET-MESSAGE" });

const RESULT_URL = /\/race\/result\.html\?race_id=(\d{12})$/;

interface FakeGate extends GateLike {
  readonly urls: string[];
  /** 一覧の URL だけを数える(中央・地方別)。 */
  listUrls(kind: "central" | "nar"): string[];
  /** 出馬表などの分析用のページを返すか(false のあいだは、分析の取得を拒否する)。 */
  analysis: boolean;
  centralList: string;
  narList: string;
  /** 地方の一覧を拒否する(失敗の模擬)。 */
  narListRefused: boolean;
  /** 地方の出馬表の発走時刻(race_id → HH:MM)。一覧の時刻と揃える。 */
  readonly narStart: Map<string, string>;
}
function fakeGate(centralList: string, narList: string, narRows: readonly ListRow[]): FakeGate {
  const gate: FakeGate = {
    urls: [],
    analysis: false,
    centralList,
    narList,
    narListRefused: false,
    narStart: new Map(narRows.filter((r) => r.time !== null).map((r) => [r.raceId, r.time!])),
    listUrls: (kind) => gate.urls.filter((u) => u.startsWith(kind === "central" ? "https://race.netkeiba.com/top/race_list_sub" : "https://nar.netkeiba.com/top/race_list_sub")),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return okPage(gate.centralList);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return gate.narListRefused ? blocked() : okPage(gate.narList);
      const m = RESULT_URL.exec(url);
      if (m !== null) return okPage(Number(m[1]!.slice(4, 6)) >= 30 ? NAR_RESULT : CENTRAL_RESULT);
      if (!gate.analysis) return blocked();
      try {
        if (url.includes("nar.netkeiba.com")) {
          if (url.includes("shutuba.html")) {
            const id = /race_id=(\d{12})/.exec(url)![1]!;
            return okPage(fixture("nar_shutuba_202654071210.html").replace("20:50発走", `${gate.narStart.get(id) ?? "20:50"}発走`));
          }
          if (url.includes("type=b1&")) return okPage(fixture("nar_odds_b1_202654071210.html"));
          throw new Error(`未知のURL(NAR): ${url}`);
        }
        return okPage(fixtureForUrl(url));
      } catch {
        return blocked();
      }
    },
  };
  return gate;
}

interface FakeStore {
  readonly saved: string[];
  saveResult(raceId: string, entries: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
  saveWinOdds(raceId: string, entries: readonly RaceResultEntry[]): Promise<{ readonly rowsWritten: number }>;
  saveScratched(raceId: string, entries: readonly RaceResultEntry[]): Promise<{ readonly rowsWritten: number }>;
  getRaceResultDetails(raceIds: readonly string[]): Promise<Map<string, RaceResultDetail>>;
}
function fakeStore(): FakeStore {
  const store: FakeStore = {
    saved: [],
    async saveResult(raceId) {
      store.saved.push(raceId);
    },
    async saveWinOdds() {
      return { rowsWritten: 0 };
    },
    async saveScratched() {
      return { rowsWritten: 0 };
    },
    async getRaceResultDetails() {
      return new Map();
    },
  };
  return store;
}

interface RecordingSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
}
function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    saved: [],
    async save(record) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt() {
      return null;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly store: FakeStore;
  readonly sink: RecordingSink;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  /** 日報の依頼の開催日と、依頼したときの時計。 */
  readonly reports: string[];
  readonly reportTimes: number[];
}
const opened: NodeSql[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const sql of opened.splice(0)) sql.close();
});

interface HarnessOptions {
  readonly narRows?: readonly ListRow[];
  readonly centralRows?: readonly ListRow[];
  readonly start?: number;
  /** false なら結果ストアを渡さない(結果の仕組みが無効)。 */
  readonly resultStore?: boolean;
  /** false なら日報の依頼先を渡さない。 */
  readonly requestReport?: boolean;
  /** true なら日報の依頼先が常に例外を投げる(依頼の失敗の模擬)。呼び出しの開催日は `reports` に残る。 */
  readonly failReport?: boolean;
}
function harness(options: HarnessOptions = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const narRows = options.narRows ?? KAWASAKI_ROWS;
  const clock = { now: options.start ?? JST_0900 };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const reports: string[] = [];
  const reportTimes: number[] = [];
  const gate = fakeGate(listHtml(options.centralRows ?? []), listHtml(narRows), narRows);
  const store = fakeStore();
  const sink = recordingSink();
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(options.resultStore === false ? {} : { resultStore: store }),
    ...(options.requestReport === false
      ? {}
      : {
          requestReport: async (kaisaiDate: string) => {
            reports.push(kaisaiDate);
            reportTimes.push(clock.now);
            if (options.failReport === true) {
              throw new Error("依頼先の失敗(本文は警告に出さない)SECRET-REPORT");
            }
          },
        }),
  });
  return { core, sql, gate, store, sink, clock, alarm, warnings, reports, reportTimes };
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);
async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}
/** アラームの時刻が `until` 以前のあいだ、1 ステップずつ進める。 */
async function driveUntil(h: Harness, until: number, max = 400): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const at = h.alarm.at;
    if (at === null || at > until) return out;
    out.push(await tick(h));
  }
  throw new Error("アラームが止まらない(上限超過)");
}
/** 計画を依頼して、確定まで進める(自動の対象は中央だけ・地方は Jpn だけ。この一覧には無いので、手動の分析だけの日)。 */
async function planned(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toMatchObject({ accepted: true });
  await driveUntil(h, JST_0900);
  expect(h.core.getPlanProgress().stage).toBe("done"); // 前提: 確定した
}
/** 時刻を `at` にして分析用のページを返すようにし、手動の発走前の分析を予約して、`until` まで進める。 */
async function manualPreRace(h: Harness, at: number, until: number, raceId: string): Promise<string[]> {
  h.clock.now = at;
  h.gate.analysis = true;
  await h.core.schedule({ raceId, kaisaiDate: DATE, mode: "pre_race" });
  return driveUntil(h, until);
}

interface ResultRow {
  race_id: string;
  state: string;
  next_try_at: number;
}
const resultRows = (h: Harness): ResultRow[] => h.sql.exec("SELECT race_id, state, next_try_at FROM race_day_result ORDER BY race_id").toArray() as ResultRow[];
const resultRowOf = (h: Harness, raceId: string): ResultRow | undefined => resultRows(h).find((r) => r.race_id === raceId);
const taskStatus = (h: Harness, raceId: string): string | undefined =>
  (h.sql.exec("SELECT status FROM race_day_tasks WHERE race_id = ? AND mode = 'pre_race'", raceId).toArray() as { status: string }[])[0]?.status;
const holdMeta = (h: Harness): unknown => {
  const rows = h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", REPORT_HOLD_KEY).toArray() as { value: string }[];
  return rows[0] === undefined ? null : JSON.parse(rows[0].value);
};
const holdWarnings = (h: Harness): string[] => h.warnings.filter((w) => w.includes(WARN_TEXT));
const listSpy = (h: Harness) => vi.spyOn(h.core, "getRaceList");

// ---------------------------------------------------------------------------

describe("AC6: 手動の分析の開催の最終レースの発走まで、日報を依頼しない(シナリオ。地方の川崎 10〜12R)", () => {
  it("10R だけを分析 → 10R の結果の取り込みが済んでも 12R の発走(20:50)より前は依頼しない。その間に 11R・12R の分析が入れば、その結果がそろうまで依頼せず、そろった時点で 1 回だけ依頼する", async () => {
    const h = harness();
    await planned(h);
    await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
    expect(taskStatus(h, kawasaki(10))).toBe("done"); // 前提: 10R の分析は終わっている
    expect(resultRowOf(h, kawasaki(10))).toMatchObject({ state: "queued", next_try_at: jst("19:40") + 15 * MIN }); // 前提: 結果の取り込みは 19:55 から
    await driveUntil(h, jst("19:59")); // 10R の結果の取り込み(19:55)
    expect(resultRowOf(h, kawasaki(10))!.state).toBe("imported"); // 前提: 10R の結果は済んだ(今までなら、ここで日報が依頼される)
    expect(h.core.getPlanProgress().stage).toBe("done"); // 前提: 計画は確定のまま(静かの他の条件は揃っている)
    expect(h.reports).toEqual([]);
    expect(h.alarm.at).toBe(KAWASAKI_LAST); // 12R の発走時刻のアラームが張られている(他に起きる理由は無い)

    await manualPreRace(h, jst("20:00"), jst("20:04"), kawasaki(11));
    await manualPreRace(h, jst("20:05"), jst("20:49"), kawasaki(12));
    expect(taskStatus(h, kawasaki(11))).toBe("done"); // 前提: 11R・12R の分析は終わっている
    expect(taskStatus(h, kawasaki(12))).toBe("done");
    expect(resultRowOf(h, kawasaki(11))!.state).toBe("imported"); // 前提: 11R の結果は 20:30 に取り込まれた
    expect(resultRowOf(h, kawasaki(12))!.state).toBe("queued"); // 前提: 12R の結果は 21:05 から
    expect(h.reports).toEqual([]);

    await driveUntil(h, jst("21:04")); // 12R の発走(20:50)を過ぎる。12R の結果はまだ
    expect(h.reports).toEqual([]); // 発走を過ぎても、分析したレースの結果が待ちなら依頼しない
    await driveUntil(h, jst("21:10")); // 12R の結果(21:05)
    expect(resultRowOf(h, kawasaki(12))!.state).toBe("imported");
    expect(h.reports).toEqual([DATE]);
    expect(h.reportTimes).toEqual([jst("21:05")]); // 結果がそろった時点
    await driveUntil(h, jst("23:59"));
    expect(h.reports).toEqual([DATE]); // 1 回だけ
  });

  it("分析が 10R だけなら、12R の発走時刻のアラームで起きて依頼される(12R の結果は待たない。下限ちょうどで依頼する)", async () => {
    const h = harness();
    await planned(h);
    await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
    await driveUntil(h, jst("19:59"));
    expect(resultRowOf(h, kawasaki(10))!.state).toBe("imported"); // 前提
    expect(h.reports).toEqual([]);
    expect(resultRowOf(h, kawasaki(12))).toBeUndefined(); // 前提: 12R は分析していない(結果の行が無い)
    expect(h.alarm.at).toBe(KAWASAKI_LAST);

    const labels = await driveUntil(h, jst("20:55"));
    expect(labels).toEqual(["idle"]); // 仕事の無い起床(結果の取り込みの行は無い)の経路で依頼される
    expect(h.reports).toEqual([DATE]);
    expect(h.reportTimes).toEqual([KAWASAKI_LAST]); // 下限ちょうど(now < 下限 は偽)で依頼
    await driveUntil(h, jst("23:59"));
    expect(h.reports).toEqual([DATE]); // 1 回だけ
  });

  it("下限の直前(19:59〜20:49)は何度起きても依頼しない。下限の 1 ミリ秒前では依頼せず、ちょうどで依頼する", async () => {
    const h = harness();
    await planned(h);
    await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
    await driveUntil(h, jst("19:59"));
    expect(h.reports).toEqual([]); // 前提
    h.clock.now = KAWASAKI_LAST - 1;
    await h.core.runNextStep(); // 下限の 1 ミリ秒前に起きても(早起きの掃除の起床など)
    expect(h.reports).toEqual([]);
    h.clock.now = KAWASAKI_LAST;
    await h.core.runNextStep();
    expect(h.reports).toEqual([DATE]);
  });
});

describe("AC1: 下限の記録(取得ステップ。一覧から開催の最終レースの発走時刻を求めて meta に記録する)", () => {
  it("同じ開催(先頭 10 桁が同じ)の行の最大の発走時刻を、epoch ms で記録する。取得ステップは ok のまま、メッセージの警告は無い", async () => {
    const h = harness();
    h.clock.now = jst("19:30");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
    expect(await tick(h)).toBe(`${kawasaki(10)}:pre_race:fetch:ok`);
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: KAWASAKI_LAST });
    expect(holdWarnings(h)).toEqual([]);
  });

  it("複数の開催を分析した日は、いちばん遅い時刻が下限になる(大井の最終は 18:30、川崎の最終は 20:50)", async () => {
    const rows = [...KAWASAKI_ROWS, nar(ooi(11), "大井", 11, "17:55"), nar(ooi(12), "大井", 12, "18:30")];
    const h = harness({ narRows: rows });
    await planned(h);
    await manualPreRace(h, jst("17:00"), jst("17:20"), ooi(11)); // 先に大井
    await manualPreRace(h, jst("17:30"), jst("17:40"), kawasaki(10)); // あとから川崎
    expect(taskStatus(h, ooi(11))).toBe("done"); // 前提: 2 つの開催の分析が済んだ
    expect(taskStatus(h, kawasaki(10))).toBe("done");
    expect(holdMeta(h)).toEqual({ [OOI_HEAD]: jst("18:30"), [KAWASAKI_HEAD]: KAWASAKI_LAST });
    expect(jst("18:30")).toBeLessThan(KAWASAKI_LAST); // 前提: 最大の取り方が効く(2 つの時刻が違う)
    await driveUntil(h, jst("20:40"));
    expect(h.reports).toEqual([]); // 大井の最終(18:30)を過ぎ、結果がそろっても、川崎の最終(20:50)まで待つ
    await driveUntil(h, jst("20:55"));
    expect(h.reports).toEqual([DATE]);
    expect(h.reportTimes).toEqual([KAWASAKI_LAST]);
  });

  it("あとから分析した開催が早い時刻でも、すでにある遅い下限を下げない", async () => {
    const rows = [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "18:30")];
    const h = harness({ narRows: rows });
    await planned(h);
    await manualPreRace(h, jst("17:00"), jst("17:20"), kawasaki(10)); // 先に川崎(20:50)
    await manualPreRace(h, jst("17:30"), jst("17:40"), ooi(12)); // あとから大井(18:30)
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: KAWASAKI_LAST, [OOI_HEAD]: jst("18:30") });
    await driveUntil(h, jst("20:40"));
    expect(h.reports).toEqual([]);
    await driveUntil(h, jst("20:55"));
    expect(h.reportTimes).toEqual([KAWASAKI_LAST]);
  });

  it("中央も同じ(先頭 10 桁は 年+場+回次+日次)。手動の対象 202603020211(福島 11R)の開催の最終 12R 16:25 が下限", async () => {
    const h = harness({ centralRows: CENTRAL_ROWS });
    await planned(h);
    await manualPreRace(h, jst("15:00"), jst("15:20"), "202603020211");
    expect(holdMeta(h)).toEqual({ [CENTRAL_HEAD]: jst("16:25") });
  });

  it("同じ開催の一覧の参照は 1 回まで: 同じ開催の 3 レースを分析しても getRaceList は 1 回。別の開催を分析したときだけもう 1 回", async () => {
    const rows = [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "18:30")];
    const h = harness({ narRows: rows });
    await planned(h);
    const spy = listSpy(h);
    await manualPreRace(h, jst("17:00"), jst("17:01"), kawasaki(10));
    await manualPreRace(h, jst("17:02"), jst("17:03"), kawasaki(11));
    await manualPreRace(h, jst("17:04"), jst("17:05"), kawasaki(12));
    expect(taskStatus(h, kawasaki(12))).toBe("done"); // 前提: 3 レースとも分析した
    expect(spy.mock.calls.filter((c) => c[1] === "nar")).toHaveLength(1);
    await manualPreRace(h, jst("17:06"), jst("17:07"), ooi(12));
    expect(spy.mock.calls.filter((c) => c[1] === "nar")).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("通常は取得キャッシュに載っていて、ゲートに出るリクエストが増えない(計画の一覧を 6 時間以内に使い回す)。中央は central、地方は nar の一覧を引く", async () => {
    const h = harness({ centralRows: CENTRAL_ROWS });
    await planned(h);
    const narBefore = h.gate.listUrls("nar").length;
    const centralBefore = h.gate.listUrls("central").length;
    expect(narBefore).toBeGreaterThan(0); // 前提: 計画が両方の一覧を取っている
    expect(centralBefore).toBeGreaterThan(0);
    const spy = listSpy(h);
    await manualPreRace(h, jst("10:00"), jst("10:05"), kawasaki(10)); // 計画の一覧から 6 時間以内
    await manualPreRace(h, jst("10:10"), jst("10:15"), "202603020211");
    expect(spy.mock.calls.map((c) => c[1]).sort()).toEqual(["central", "nar"]);
    expect(h.gate.listUrls("nar")).toHaveLength(narBefore);
    expect(h.gate.listUrls("central")).toHaveLength(centralBefore);
  });
});

describe("AC4: フェイルオープン(下限を記録できないときは今と同じ動き。取得ステップは失敗にしない)", () => {
  it("一覧が取れない(ゲートの拒否)とき: 下限を記録せず、固定の警告(拒否の本文を含まない)を残す。取得ステップは ok で、10R の結果で今までどおり依頼される", async () => {
    const h = harness();
    await planned(h);
    h.gate.narListRefused = true;
    h.clock.now = jst("19:30"); // 計画の一覧(09:00)から 6 時間を過ぎている = 取得キャッシュに無い
    h.gate.analysis = true;
    await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
    expect(await tick(h)).toBe(`${kawasaki(10)}:pre_race:fetch:ok`);
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: { failures: 1 } }); // 時刻は記録しない(失敗の回数だけ)
    expect(holdWarnings(h)).toHaveLength(1);
    expect(holdWarnings(h)[0]).not.toContain("SECRET-MESSAGE");
    expect(taskStatus(h, kawasaki(10))).toBe("fetched");
    await driveUntil(h, jst("19:59"));
    expect(taskStatus(h, kawasaki(10))).toBe("done");
    expect(resultRowOf(h, kawasaki(10))!.state).toBe("imported");
    expect(h.reports).toEqual([DATE]); // 待たない(今と同じ)
    expect(h.reportTimes).toEqual([jst("19:55")]);
  });

  it("getRaceList が例外を投げても、取得ステップの外へ漏らさない(戻り値は ok のまま。固定の警告。例外の本文は出さない)", async () => {
    const h = harness();
    await planned(h);
    vi.spyOn(h.core, "getRaceList").mockRejectedValue(new Error("想定外の例外 SECRET-THROWN"));
    h.clock.now = jst("19:30");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
    expect(await tick(h)).toBe(`${kawasaki(10)}:pre_race:fetch:ok`);
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: { failures: 1 } }); // 時刻は記録しない(失敗の回数だけ)
    expect(holdWarnings(h)).toHaveLength(1);
    expect(h.warnings.join("\n")).not.toContain("SECRET-THROWN");
    expect(taskStatus(h, kawasaki(10))).toBe("fetched");
  });

  it.each([
    ["該当の開催が一覧に無い", [nar(ooi(12), "大井", 12, "18:30")]],
    ["その開催の行の発走時刻がすべて読めない", [nar(kawasaki(10), "川崎", 10, null), nar(kawasaki(12), "川崎", 12, null)]],
    ["一覧が空", []],
  ] as const)("%s: 下限を記録せず固定の警告を残し、取得ステップは ok のまま", async (_name, rows) => {
    const h = harness({ narRows: rows });
    await planned(h);
    h.clock.now = jst("19:30");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
    h.gate.narStart.set(kawasaki(10), "19:40"); // 出馬表の発走時刻は読める(結果の行は積まれる)
    expect(await tick(h)).toBe(`${kawasaki(10)}:pre_race:fetch:ok`);
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: { failures: 1 } }); // 時刻は記録しない(失敗の回数だけ)
    expect(holdWarnings(h)).toHaveLength(1);
    expect(taskStatus(h, kawasaki(10))).toBe("fetched");
  });

  it("一部の行の時刻が読めなくても、読める行の最大を下限にする(最大番号の行が読めないと下限は早まる = 部分的な保護)", async () => {
    const rows = [nar(kawasaki(10), "川崎", 10, "19:40"), nar(kawasaki(11), "川崎", 11, "20:15"), nar(kawasaki(12), "川崎", 12, null)];
    const h = harness({ narRows: rows });
    await planned(h);
    await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: jst("20:15") });
    expect(holdWarnings(h)).toEqual([]);
  });

  it(`記録できなかった試行は先頭 10 桁ごとに ${MAX_ATTEMPTS} 回まで数え、上限を過ぎたらその日はもう一覧を引かない(ゲートに一覧の URL が出ない)`, async () => {
    const h = harness();
    await planned(h);
    h.gate.narListRefused = true;
    const spy = listSpy(h);
    const nowBase = jst("19:30"); // 計画の一覧の取得キャッシュは切れている = 引くたびにゲートに出る
    const before = h.gate.listUrls("nar").length;
    for (let n = 1; n <= MAX_ATTEMPTS + 2; n += 1) {
      await manualPreRace(h, nowBase + n * MIN, nowBase + n * MIN, `2026451013${String(n).padStart(2, "0")}`); // 同じ開催の別のレース
    }
    expect(MAX_ATTEMPTS).toBe(3); // 前提: 上限の値(下の数と揃える)
    expect(spy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(h.gate.listUrls("nar").length - before).toBe(MAX_ATTEMPTS); // 上限後は一覧の URL がゲートに出ない
    expect(holdWarnings(h)).toHaveLength(MAX_ATTEMPTS);
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: { failures: MAX_ATTEMPTS } });
  });

  it("上限は開催ごと: 別の開催(先頭 10 桁が違う)は、先の開催が上限に達していても引く", async () => {
    const h = harness({ narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "18:30")] });
    await planned(h);
    h.gate.narListRefused = true;
    const spy = listSpy(h);
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      await manualPreRace(h, jst("19:30") + n * MIN, jst("19:30") + n * MIN, kawasaki(n));
    }
    expect(spy).toHaveBeenCalledTimes(MAX_ATTEMPTS); // 前提: 川崎は上限
    h.gate.narListRefused = false;
    await manualPreRace(h, jst("19:40"), jst("19:40"), ooi(12));
    expect(spy).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: { failures: MAX_ATTEMPTS }, [OOI_HEAD]: jst("18:30") });
  });

  it("失敗してから一覧が取れた場合は、そこで記録する(失敗の回数は記録に置き換わる)", async () => {
    const h = harness();
    await planned(h);
    h.gate.narListRefused = true;
    await manualPreRace(h, jst("19:30"), jst("19:30"), kawasaki(10));
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: { failures: 1 } }); // 前提: 1 回失敗
    h.gate.narListRefused = false;
    await manualPreRace(h, jst("19:32"), jst("19:32"), kawasaki(11));
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: KAWASAKI_LAST });
  });
});

describe("meta の壊れた値: 空として扱い、例外を外へ出さない", () => {
  it.each([
    ["JSON として壊れている", "{これはJSONではない"],
    ["配列", "[1,2,3]"],
    ["null", "null"],
    ["値の形が想定外(文字列・負の回数・小数の失敗回数)", '{"2026451013":"abc","2026441013":{"failures":-1},"2026431013":{"failures":1.5}}'],
  ] as const)("%s: 空として扱う(取得ステップは ok・日報の依頼・アラームの張り直しも例外にならず、改めて記録できる)", async (_name, raw) => {
    const h = harness();
    await planned(h);
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?)", REPORT_HOLD_KEY, raw);
    // 読む経路(アラームの張り直し・日報の依頼)が壊れた値で落ちない。
    await expect(h.core.runNextStep()).resolves.toBeDefined();
    h.clock.now = jst("19:30");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
    expect(await tick(h)).toBe(`${kawasaki(10)}:pre_race:fetch:ok`);
    expect(holdMeta(h)).toEqual({ [KAWASAKI_HEAD]: KAWASAKI_LAST }); // 空として扱って、改めて記録した
    await driveUntil(h, jst("19:59"));
    expect(h.reports).toEqual([]); // 記録し直した下限が効く
  });
});

describe("取得ステップの位置と、一覧を引かない条件", () => {
  it("出馬表の取得が失敗した試行では一覧を引かない(取得が成功した後に引く)。ステップの戻り値は従来どおり(failed。ゲートの拒否は致命)", async () => {
    const h = harness();
    await planned(h);
    const spy = listSpy(h);
    h.clock.now = jst("19:30");
    h.gate.analysis = false; // 出馬表などを拒否する
    await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
    expect(await tick(h)).toBe(`${kawasaki(10)}:pre_race:fetch:failed`);
    expect(spy).not.toHaveBeenCalled();
    expect(holdMeta(h)).toBeNull();
  });

  it("朝(morning)の手動の分析では一覧を引かず、下限を記録しない(結果の行を積まないのと同じ)", async () => {
    const h = harness();
    await planned(h);
    const spy = listSpy(h);
    h.clock.now = jst("10:00");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: "202603020211", kaisaiDate: DATE, mode: "morning" });
    await driveUntil(h, jst("10:10"));
    expect(spy).not.toHaveBeenCalled();
    expect(holdMeta(h)).toBeNull();
  });

  it("日報の依頼済み(report_requested)の日は、一覧を引かず何も変えない(AC5。記録の無い別の開催〈大井〉の分析でも引かない)", async () => {
    const h = harness({ narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "21:30")] });
    await planned(h);
    await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
    await driveUntil(h, jst("20:55"));
    expect(h.reports).toEqual([DATE]); // 前提: 下限で依頼済み
    const metaBefore = holdMeta(h);
    const spy = listSpy(h);
    expect(Object.keys(metaBefore as object)).toEqual([KAWASAKI_HEAD]); // 前提: 大井の記録はまだ無い(依頼済みの条件だけが引かない理由になる)
    await manualPreRace(h, jst("21:00"), jst("21:20"), ooi(12)); // 依頼のあとに、別の開催を分析
    expect(taskStatus(h, ooi(12))).toBe("done"); // 前提: 分析は走った
    expect(spy).not.toHaveBeenCalled();
    expect(holdMeta(h)).toEqual(metaBefore);
    expect(h.reports).toEqual([DATE]); // 作り直さない
  });

  it("結果ストアが無い構成・日報の依頼先が無い構成では、一覧を引かない(下限は日報のためだけのもの)", async () => {
    for (const options of [{ resultStore: false }, { requestReport: false }] as const) {
      const h = harness(options);
      await planned(h);
      const spy = listSpy(h);
      await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
      expect(taskStatus(h, kawasaki(10))).toBe("done"); // 前提: 分析は走った
      expect(spy).not.toHaveBeenCalled();
      expect(holdMeta(h)).toBeNull();
    }
  });

  it("過去の開催日(開催日 < 今日 JST)の手動の分析では一覧を引かない(日報は後日の cron の経路)", async () => {
    const h = harness({ start: jst("09:00", "2026-10-14") });
    const spy = listSpy(h);
    h.clock.now = jst("09:00", "2026-10-14");
    h.gate.analysis = true;
    await h.core.schedule({ raceId: kawasaki(10), kaisaiDate: DATE, mode: "pre_race" });
    await driveUntil(h, jst("09:30", "2026-10-14"));
    expect(taskStatus(h, kawasaki(10))).toBe("done"); // 前提: 分析は走った
    expect(spy).not.toHaveBeenCalled();
    expect(holdMeta(h)).toBeNull();
  });
});

describe("AC5: 既存の挙動", () => {
  it("中央の開催日(自動の計画の行が最終レースまで残る日)の挙動は変わらない: 下限(最終レース 10:35)は記録されるが、依頼は全レースの結果がそろった時点(10:50)のまま", async () => {
    const rows: ListRow[] = [
      { raceId: "202606040901", venue: "中山", raceNumber: 1, name: "中央1R", time: "10:00" },
      { raceId: "202606040902", venue: "中山", raceNumber: 2, name: "中央2R", time: "10:35" },
    ];
    const h = harness({ centralRows: rows, narRows: [] });
    h.gate.analysis = true; // 自動の分析(朝・発走前)を成功させる
    await planned(h);
    await driveUntil(h, jst("10:30"));
    expect(taskStatus(h, "202606040901")).toBe("done"); // 前提: 自動の発走前の分析が走った
    expect(taskStatus(h, "202606040902")).toBe("done");
    expect(holdMeta(h)).toEqual({ "2026060409": jst("10:35") }); // 自動の分析も同じ取得ステップを通って、下限を記録する
    expect(resultRowOf(h, "202606040901")!.state).toBe("imported"); // 前提: 1R の結果は 10:15 に取り込まれた
    expect(resultRowOf(h, "202606040902")!.state).toBe("queued"); // 前提: 2R の結果は 10:50 から
    expect(h.reports).toEqual([]);
    await driveUntil(h, jst("11:30"));
    expect(h.reports).toEqual([DATE]);
    expect(h.reportTimes).toEqual([jst("10:50")]); // 下限(10:35)ではなく、結果がそろった時点
  });
});

// ---------------------------------------------------------------------------

/** Issue #298: 下限を過ぎたあとの判定の印(meta)。値は判定したときの下限(`String(下限)`)。 */
const JUDGED_KEY = "report_hold_judged";
const metaValue = (h: Harness, key: string): string | null => {
  const rows = h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
  return rows[0]?.value ?? null;
};
const taskAttempts = (h: Harness, raceId: string): number | undefined =>
  (h.sql.exec("SELECT attempts FROM race_day_tasks WHERE race_id = ? AND mode = 'morning'", raceId).toArray() as { attempts: number }[])[0]?.attempts;
/** 手動の 10R だけを分析し、10R の結果の取り込み(19:55)まで進めた状態(アラームは下限の 20:50 だけ)。 */
async function onlyTenAnalyzed(h: Harness): Promise<void> {
  await planned(h);
  await manualPreRace(h, jst("19:30"), jst("19:39"), kawasaki(10));
  await driveUntil(h, jst("19:59"));
  expect(resultRowOf(h, kawasaki(10))!.state).toBe("imported"); // 前提: 10R の結果は済んだ
  expect(h.reports).toEqual([]); // 前提: 下限の前なので未依頼
  expect(h.alarm.at).toBe(KAWASAKI_LAST); // 前提: 他に起きる理由が無い(下限のアラームだけ)
}
/** 下限の時刻に、結果の行を積まない手動の朝(morning)のタスクを予約する(下限の起床が、日報を判定しない仕事に消費される状況)。 */
async function scheduleMorningAtHold(h: Harness): Promise<void> {
  h.clock.now = KAWASAKI_LAST;
  h.gate.analysis = true;
  await h.core.schedule({ raceId: "202603020211", kaisaiDate: DATE, mode: "morning" });
}

describe("Issue #298 AC1: 下限の起床が別の仕事に消費されても、日報の判定の機会が来る", () => {
  it("下限の時刻に、結果の行を積まない仕事(朝のタスク)が重なっても、仕事が終わったあと短い遅れで依頼される(掃除のアラームを待たない)", async () => {
    const h = harness();
    await onlyTenAnalyzed(h);
    expect(metaValue(h, JUDGED_KEY)).toBeNull(); // 前提: 下限の前の判定(10R の結果の取り込み後)は印を付けない
    await scheduleMorningAtHold(h);
    const labels = await driveUntil(h, KAWASAKI_LAST + 2 * MIN);
    expect(labels.slice(0, 2)).toEqual(["202603020211:morning:fetch:ok", "202603020211:morning:compute:ok"]); // 前提: 朝のタスクが 2 ステップとも走った
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM race_day_result WHERE race_id = ?", "202603020211").toArray()).toEqual([{ n: 0 }]); // 前提: 朝は結果の行を積まない
    expect(h.reports).toEqual([DATE]);
    expect(h.reportTimes[0]! - KAWASAKI_LAST).toBeLessThan(MIN); // 短い遅れ(掃除のアラームは約 6 時間後)
    expect(metaValue(h, JUDGED_KEY)).toBe(String(KAWASAKI_LAST)); // 印は判定したときの下限
    await driveUntil(h, jst("23:59"));
    expect(h.reports).toEqual([DATE]); // 1 回だけ
  });

  // 注(Issue #300): このテストが固定するのは「新しい下限を過ぎたあとにもう一度判定が来て、印が新しい下限の値に書き換わる」こと。
  // 印の値の照合(`reportJudgePending` の `!== String(hold)`)そのものを固定してはいない: 下限が未来へ伸びたときは、未来の下限のアラーム(`pendingReportHoldAt`)が起床させ、
  // そこで判定されて印が書き換わるので、照合を `=== null` に変えても通る。照合が単独で効くのは「印が過去の下限の値のまま、下限を過ぎている」場合だけで、
  // 下限は後退しない(開催ごとに記録できたら再び引かず、下限はその最大なので、新しい開催の分析で伸びるだけ)ので構成上到達しない。
  it("下限が後から伸びたら(別の開催を分析した)、新しい下限を過ぎたあとにもう一度判定の機会が来て、印が新しい下限の値に書き換わる", async () => {
    const h = harness({ narRows: [...KAWASAKI_ROWS, nar(ooi(12), "大井", 12, "21:30")], failReport: true });
    await onlyTenAnalyzed(h);
    await scheduleMorningAtHold(h);
    await driveUntil(h, KAWASAKI_LAST + 2 * MIN);
    expect(metaValue(h, JUDGED_KEY)).toBe(String(KAWASAKI_LAST)); // 前提: 20:50 の下限で判定済み(依頼は失敗した。失敗する構成なので、依頼済みの印で候補が消えない)
    expect(h.reports).toEqual([DATE]);
    await manualPreRace(h, jst("21:00"), jst("21:01"), ooi(12)); // 大井 12R を分析 → 下限が 21:30 に伸びる
    expect(holdMeta(h)).toMatchObject({ [OOI_HEAD]: jst("21:30") }); // 前提
    expect(metaValue(h, JUDGED_KEY)).toBe(String(KAWASAKI_LAST)); // 前提: 印はまだ古い下限のまま(新しい下限は未判定)
    await driveUntil(h, jst("21:29"));
    expect(metaValue(h, JUDGED_KEY)).toBe(String(KAWASAKI_LAST)); // 新しい下限の前には判定しない(印は古いまま)
    await driveUntil(h, jst("21:31"));
    expect(metaValue(h, JUDGED_KEY)).toBe(String(jst("21:30"))); // 新しい下限のアラームで起きて、判定した(印が新しい下限に変わった)
    expect(h.reports).toEqual([DATE]); // 大井 12R の結果が待ち(21:45 から)なので静かでなく、依頼はしていない
  });
});

describe("Issue #298 AC2: 即時のループを作らない", () => {
  /** 下限(を過ぎた時点)から `until` までの起床の回数と、最後に張られたアラームを返す。時計は進めず、アラームの時刻まで進める(tick と同じ)。 */
  async function wakesUntil(h: Harness, until: number): Promise<number> {
    return (await driveUntil(h, until)).length;
  }

  it("判定の結果が「静かでない」(分析したレースの結果が待ち)でも、起床は有界で、アラームは now に張られ続けない", async () => {
    const h = harness();
    await onlyTenAnalyzed(h);
    await manualPreRace(h, jst("20:45"), jst("20:49"), kawasaki(12)); // 12R を分析 → 結果の取り込みは 21:05 から
    expect(resultRowOf(h, kawasaki(12))!.state).toBe("queued"); // 前提: 待ちの結果がある(静かでない)
    await scheduleMorningAtHold(h);
    const wakes = await wakesUntil(h, KAWASAKI_LAST + 2 * MIN);
    expect(h.reports).toEqual([]); // 前提: 判定の結果は「静かでない」
    expect(metaValue(h, JUDGED_KEY)).toBe(String(KAWASAKI_LAST)); // 判定は行われた(印が付いた)
    expect(wakes).toBeLessThanOrEqual(3); // 朝の 2 ステップ + 判定の起床 1 回
    expect(h.alarm.at).not.toBeNull();
    expect(h.alarm.at!).toBeGreaterThan(h.clock.now); // 以後のアラームは now ではない(結果の取り込みの 21:05 など)
  });

  it("依頼が失敗し続けても、起床は有界で、アラームは now に張られ続けない(失敗の警告は固定文・本文なし。次の起床で再び依頼する既存の振る舞いは変わらない)", async () => {
    const h = harness({ failReport: true });
    await onlyTenAnalyzed(h);
    await scheduleMorningAtHold(h);
    const wakes = await wakesUntil(h, KAWASAKI_LAST + 2 * MIN);
    expect(wakes).toBeLessThanOrEqual(3); // 朝の 2 ステップ + 判定の起床 1 回
    expect(h.reports).toEqual([DATE]); // 判定の機会で 1 回依頼され、失敗した
    expect(metaValue(h, "report_requested")).toBeNull(); // 失敗なので依頼済みの印は書かない
    const failed = h.warnings.filter((w) => w.includes("日報の作成の依頼に失敗しました"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).not.toContain("SECRET-REPORT");
    expect(h.alarm.at).not.toBeNull();
    expect(h.alarm.at!).toBeGreaterThan(h.clock.now); // 掃除のアラーム(約 6 時間後)。now ではない
    // 次の起床(掃除専用のアラームなど)では、従来どおり再び依頼する。
    h.clock.now = jst("21:00");
    await h.core.runNextStep();
    expect(h.reports).toEqual([DATE, DATE]);
  });

  it("再試行待ちのタスクだけが残っているあいだは、未判定でも now を張らない(タスクの再試行の間隔を守る。タスクの分岐は印を付けないので、守らないと撃ち直しが間隔なしで続く)", async () => {
    const h = harness();
    await onlyTenAnalyzed(h);
    await scheduleMorningAtHold(h);
    h.gate.fetchRaw = async () => {
      throw new Error("通信の失敗(非致命)");
    };
    await tick(h); // 朝の取得が 1 回失敗 → 再試行待ち
    expect(taskStatus(h, "202603020211")).toBeUndefined(); // 前提: pre_race の行ではない
    expect(taskAttempts(h, "202603020211")).toBe(1); // 前提: 1 回試行して失敗した
    expect((h.sql.exec("SELECT status FROM race_day_tasks WHERE race_id = ? AND mode = 'morning'", "202603020211").toArray() as { status: string }[])[0]!.status).toBe("queued"); // 前提: 再試行待ち
    expect(metaValue(h, JUDGED_KEY)).toBeNull(); // 前提: 下限を過ぎて未判定(タスクの分岐は判定しない)
    expect(h.clock.now).toBeGreaterThanOrEqual(KAWASAKI_LAST); // 前提: 下限は過ぎている
    expect(h.alarm.at).toBe(h.clock.now + RETRY_DELAY_MS); // now ではなく、再試行の間隔の後
  });
});
