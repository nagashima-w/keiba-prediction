import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import type { AppScreen } from "../client/admin-only";
import { createRaceData, type RaceData } from "../client/race-data";
import type { Route } from "../client/route";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #400 R-11b: 読み込みと追跡(`race-data.ts` の `createRaceData`)の単体テスト。`createApp` を通した振る舞いは
 * `client-app*.test.ts`・`client-app-r11b-characterization.test.ts` が固定する。ここは、切り出した部品そのものの契約
 * (取得の冪等・取得中の「更新」の無視・route と画面の判定を依存から受け取ること・待ち対象・再描画の要求)を、偽の fetch・偽のタイマーで確かめる。
 */

const DATE = "20260628";
const RACE_ID = "202603020211";
const RACES_URL = `/api/races?kaisai_date=${DATE}&venue=central`;
const BOARD_URL = `/api/analyses/status?kaisai_date=${DATE}`;
const STATUS_URL = `${BOARD_URL}&race_id=${RACE_ID}`;
const PAST_URL = `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`;
const ANALYSIS_URL = "/api/analyses/5";

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const fail503: Resp = { status: 503, json: async () => ({ ok: false, error: { type: "race-day-error", message: "サーバの文面" } }) };
const boardRow = (mode: string, status: string, over: Record<string, unknown> = {}) => ({ race_id: RACE_ID, mode, status, attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: null, detail: null, children_ok: null, ...over });
const racesBody = { ok: true, kaisai_date: DATE, venue: "central", races: [{ race_id: RACE_ID, venue_name: "福島", race_number: 11, race_name: "福島民報杯", course_type: "芝", distance: 1800, entry_count: 16, grade: null }] };

interface Fixture {
  readonly data: RaceData;
  readonly calls: string[];
  readonly changes: { count: number };
  readonly timers: ReturnType<typeof createFakeTimers>;
  /** 保留中の応答(URL → 解決用)。登録した URL は 1 回だけ保留する。 */
  hold(url: string): { resolve: (r: Resp) => void };
  replies: Map<string, () => Resp>;
  setRoute(route: Partial<Route>): void;
  setScreen(screen: AppScreen): void;
}

function fixture(): Fixture {
  const calls: string[] = [];
  const changes = { count: 0 };
  const timers = createFakeTimers();
  const held = new Map<string, Promise<Resp>>();
  const replies = new Map<string, () => Resp>();
  let route: Route = { date: DATE, venue: "central", race: null, analysis: null, settings: false };
  let screen: AppScreen = "list";
  const fetchLike: FetchLike = (url) => {
    calls.push(url);
    const h = held.get(url);
    if (h !== undefined) {
      held.delete(url);
      return h;
    }
    const reply = replies.get(url);
    if (reply === undefined) throw new Error(`想定外の取得: ${url}`);
    return Promise.resolve(reply());
  };
  const data = createRaceData({
    fetch: fetchLike,
    now: () => new Date(Date.parse("2026-06-28T00:00:00Z") + timers.now()),
    timers: { set: (fn, ms) => timers.set(fn, ms), clear: (handle) => timers.clear(handle) },
    isVisible: () => true,
    route: () => route,
    currentScreen: () => screen,
    onChange: () => {
      changes.count += 1;
    },
  });
  return {
    data,
    calls,
    changes,
    timers,
    replies,
    hold: (url) => {
      const d = deferred<Resp>();
      held.set(url, d.promise);
      return { resolve: d.resolve };
    },
    setRoute: (r) => {
      route = { ...route, ...r };
    },
    setScreen: (s) => {
      screen = s;
    },
  };
}

describe("createRaceData: 取得は冪等で、完了したら再描画を要求する", () => {
  it("ensureResult: 取得中に重ねて呼んでも、成功したあとに呼び直しても、取得は 1 本(成功した分析は取り直さない)。完了で onChange が 1 回呼ばれる", async () => {
    const f = fixture();
    const body = f.hold(ANALYSIS_URL);
    f.data.ensureResult(5);
    f.data.ensureResult(5);
    expect(f.calls).toEqual([ANALYSIS_URL]);
    expect(f.data.analysisSource(5).kind).toBe("loading");
    expect(f.changes.count).toBe(0);
    body.resolve(ok({ ok: true, analysis: { id: 5, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, llmNote: null, llmCalls: null, promptVersion: null, race: { venueName: "福島", raceNumber: 11, raceName: "テスト", startTime: null, courseType: null, distance: null, weather: null, trackCondition: null, oddsStatus: null, placeBasis: null }, horses: [], allocation: null, detail: "present" } }));
    await Promise.all(f.data.pending());
    expect(f.data.analysisSource(5).kind).toBe("ready");
    expect(f.changes.count).toBe(1);
    f.data.ensureResult(5);
    expect(f.calls).toHaveLength(1);
    // 成功した分析の「更新」は何もしない(R2 の操作回数を使わない)
    f.data.refreshResult(5);
    expect(f.calls).toHaveLength(1);
    expect(f.changes.count).toBe(1);
  });

  it("refreshResult: 失敗した分析だけを取り直す。取得中は無視する。押した直後に onChange を呼ぶ", async () => {
    const f = fixture();
    f.replies.set(ANALYSIS_URL, () => fail503);
    f.data.ensureResult(5);
    await Promise.all(f.data.pending());
    expect(f.data.analysisSource(5).kind).toBe("error");
    f.data.ensureResult(5);
    expect(f.calls, "失敗は自動では取り直さない").toHaveLength(1);
    const again = f.hold(ANALYSIS_URL);
    const before = f.changes.count;
    f.data.refreshResult(5);
    expect(f.calls).toHaveLength(2);
    expect(f.changes.count, "押した直後に再描画を要求する").toBe(before + 1);
    expect(f.data.analysisSource(5).kind).toBe("loading");
    f.data.refreshResult(5);
    expect(f.calls, "取得中の「更新」は無視する").toHaveLength(2);
    again.resolve(fail503);
    await Promise.all(f.data.pending());
  });

  it("ensureList: 一覧と板を 1 本ずつ取る。失敗は自動では取り直さず、refreshList が取り直す(取得中は無視)", async () => {
    const f = fixture();
    f.replies.set(RACES_URL, () => ok(racesBody));
    f.replies.set(BOARD_URL, () => fail503);
    f.data.ensureList(DATE, "central");
    f.data.ensureList(DATE, "central");
    expect(f.calls).toEqual([RACES_URL, BOARD_URL]);
    await Promise.all(f.data.pending());
    expect(f.data.listSource(DATE, "central").kind).toBe("ready");
    expect(f.data.boardSource(DATE).kind).toBe("error");
    expect(f.data.boardLoading(DATE)).toBe(false);
    f.data.ensureList(DATE, "central");
    expect(f.calls, "失敗した板は自動では取り直さない").toHaveLength(2);
    f.replies.set(BOARD_URL, () => ok({ ok: true, kaisai_date: DATE, races: [] }));
    const racesAgain = f.hold(RACES_URL);
    f.data.refreshList(DATE, "central");
    expect(f.calls).toEqual([RACES_URL, BOARD_URL, RACES_URL, BOARD_URL]);
    expect(f.data.boardLoading(DATE)).toBe(true);
    f.data.refreshList(DATE, "central");
    expect(f.calls, "取得中の「更新」は無視する").toHaveLength(4);
    racesAgain.resolve(ok(racesBody));
    await Promise.all(f.data.pending());
    expect(f.data.boardSource(DATE).kind).toBe("ready");
    expect(f.data.boardLoading(DATE)).toBe(false);
  });

  it("ensureRace: 状態と過去の分析を 1 本ずつ取り(一覧・板は取らない)、pending は取得中の間だけ待ち対象を返す", async () => {
    const f = fixture();
    f.replies.set(STATUS_URL, () => ok({ ok: true, kaisai_date: DATE, races: [], prior: null }));
    f.replies.set(PAST_URL, () => ok({ ok: true, analyses: [] }));
    expect(f.data.pending()).toHaveLength(0);
    f.data.ensureRace(DATE, RACE_ID);
    f.data.ensureRace(DATE, RACE_ID);
    expect(f.calls).toEqual([STATUS_URL, PAST_URL]);
    expect(f.data.pending()).toHaveLength(2);
    await Promise.all(f.data.pending());
    expect(f.data.pending()).toHaveLength(0);
    expect(f.data.raceStatusSource(DATE, RACE_ID).kind).toBe("ready");
    expect(f.data.pastSource(DATE, RACE_ID).kind).toBe("ready");
    expect(f.calls).toHaveLength(2);
  });
});

describe("createRaceData: route と画面の判定は依存から受け取る", () => {
  it("完了を見つけたとき、currentScreen が race でなければ(route がそのレースを指していても)取り直さず、キャッシュを捨てるだけ。race なら取り直す", async () => {
    const f = fixture();
    f.setRoute({ race: RACE_ID });
    f.setScreen("race");
    let rows = [boardRow("pre_race", "queued")];
    f.replies.set(STATUS_URL, () => ok({ ok: true, kaisai_date: DATE, races: rows, prior: null }));
    f.replies.set(PAST_URL, () => ok({ ok: true, analyses: [] }));
    f.replies.set(BOARD_URL, () => ok({ ok: true, kaisai_date: DATE, races: rows }));
    f.data.ensureRace(DATE, RACE_ID);
    await Promise.all(f.data.pending());
    expect(f.calls).toEqual([STATUS_URL, PAST_URL]);
    expect(f.timers.pending(), "実行中の行があるので追跡が始まっている").toBe(1);
    // 画面は別の画面(admin-only など)だが、route はまだそのレースを指している
    f.setScreen("admin-only");
    rows = [boardRow("pre_race", "done", { analysis_id: 7 })];
    await f.timers.advance(3000);
    expect(f.calls.slice(2), "追跡の板の取得だけ。過去の分析は取り直さない").toEqual([BOARD_URL]);
    expect(f.data.pastSource(DATE, RACE_ID).kind, "キャッシュは捨てられている").toBe("loading");
    // 次の完了(再実行)は、画面がレースなら過去の分析を取り直す
    f.setScreen("race");
    rows = [boardRow("pre_race", "queued", { queued_at: 10 })];
    f.data.forceTrack(DATE);
    await f.timers.advance(3000);
    rows = [boardRow("pre_race", "done", { queued_at: 10, analysis_id: 8 })];
    await f.timers.advance(3000);
    expect(f.calls.filter((u) => u === PAST_URL), "画面がレースなら取り直す").toHaveLength(2);
  });

  it("forceTrack: 実行中の行が無くても、その開催日の追跡を始める(最初の取得は 3 秒後)。setOverlay は板のものがそのまま渡る", async () => {
    const f = fixture();
    f.replies.set(BOARD_URL, () => ok({ ok: true, kaisai_date: DATE, races: [] }));
    expect(f.timers.pending()).toBe(0);
    // 板が無い開催日にはオーバーレイを重ねない(行を作ると、他のレースが「未実行」に見える)。重ねた番号を返す関数であること
    expect(typeof f.data.setOverlay(DATE, RACE_ID, "morning", "queued", 0)).toBe("number");
    expect(f.data.boardSource(DATE).kind).toBe("none");
    f.data.forceTrack(DATE);
    expect(f.timers.nextIn()).toBe(3000);
    await f.timers.advance(2999);
    expect(f.calls).toEqual([]);
    await f.timers.advance(1);
    expect(f.calls).toEqual([BOARD_URL]);
  });

  it("trackingNotice: 止まっていて実行中の行があるときだけ注記を返す。onRetrack で再開する", async () => {
    const f = fixture();
    f.replies.set(BOARD_URL, () => ok({ ok: true, kaisai_date: DATE, races: [boardRow("morning", "queued")] }));
    f.data.ensureList(DATE, "central");
    f.replies.set(RACES_URL, () => ok(racesBody));
    f.data.ensureList(DATE, "central");
    await Promise.all(f.data.pending());
    expect(f.data.trackingNotice()).toBeNull();
    f.replies.set(BOARD_URL, () => fail503);
    await f.timers.advance(60_000); // 失敗が 3 回続いて止まる
    expect(f.calls.filter((u) => u === BOARD_URL)).toHaveLength(1 + 3);
    expect(f.data.trackingNotice()).toContain("止めました");
    f.replies.set(BOARD_URL, () => ok({ ok: true, kaisai_date: DATE, races: [boardRow("morning", "queued")] }));
    f.data.onRetrack();
    await f.timers.flush();
    expect(f.calls.filter((u) => u === BOARD_URL), "再開はすぐ 1 回取る").toHaveLength(1 + 3 + 1);
    expect(f.data.trackingNotice()).toBeNull();
  });
});
