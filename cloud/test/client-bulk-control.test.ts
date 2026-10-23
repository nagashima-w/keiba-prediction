import { describe, expect, it } from "vitest";
import type { BoardRow, FetchLike, RaceRow } from "../client/api";
import { createBulkControl } from "../client/bulk-control";
import type { BulkUi } from "../client/bulk";
import { groupKeys, type ListSource } from "../client/list";
import { listKey } from "../client/keys";
import { parseHash } from "../client/route";
import { deferred } from "./client-fakes";

/**
 * Issue #400 R-11: 場ごとの一括実行の制御(`bulk-control.ts`)の単体テスト。偽の fetch・偽の道具(板のオーバーレイ・追跡の開始・再描画・一覧/板の読み取り)を使う。
 * `createApp` を通した振る舞いは `client-app-bulk.test.ts`・`client-app-settings-run-details.test.ts` が固定している。ここは、`createApp` からは見えない契約
 * (閲覧者は何もしない・画面が一覧でなければ何もしない・送信中/0 件/不明なキーでの無視・道具を呼ぶ**順序と引数**・取得中の待ち)を固定する。
 */

type Resp = { status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });
const DATE = "20260628";
const NOW = Date.parse("2026-06-28T00:00:00Z"); // 09:00 JST
const F1 = "202602020101";
const F2 = "202602020102";
const race = (raceId: string, n: number): RaceRow => ({ raceId, venueName: "福島", raceNumber: n, raceName: `福島${n}R`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: "12:00" });
const RACES = [race(F1, 1), race(F2, 2)];
const GROUP = groupKeys(RACES)[0]!;
const KEY = listKey(DATE, "central");
const boardRow = (raceId: string, status: BoardRow["status"]): BoardRow => ({ raceId, mode: "morning", status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null });
const accepted = (): Resp => resp(202, { ok: true, accepted: true, kaisai_date: DATE, mode: "morning", results: [{ race_id: F1, result: "accepted" }, { race_id: F2, result: "already-running", status: "fetched" }] });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function make(over: { admin?: boolean; list?: ListSource; board?: readonly BoardRow[] | null; listScreen?: boolean; hash?: string; now?: number; respond?: () => Promise<Resp> | Resp } = {}) {
  const events: string[] = [];
  const posts: unknown[] = [];
  let nowMs = over.now ?? NOW;
  const route = parseHash(over.hash ?? `#date=${DATE}&venue=central`, DATE);
  const fetchLike: FetchLike = (url, init) => {
    events.push(`fetch ${init.method} ${url}`);
    posts.push(JSON.parse(init.body as string));
    return Promise.resolve((over.respond ?? accepted)());
  };
  const control = createBulkControl({
    fetch: fetchLike,
    now: () => new Date(nowMs),
    admin: over.admin ?? true,
    onChange: () => void events.push("change"),
    route: () => route,
    isListScreen: () => over.listScreen ?? true,
    listSource: () => over.list ?? { kind: "ready", races: RACES },
    boardRows: () => (over.board === undefined ? [] : over.board),
    setOverlay: (date, raceId, mode, status, at) => {
      events.push(`overlay ${date} ${raceId} ${mode} ${status} ${at}`);
      return 1;
    },
    forceTrack: (date) => void events.push(`track ${date}`),
  });
  return { control, events, posts, setNow: (ms: number) => (nowMs = ms) };
}
const stateOf = (c: ReturnType<typeof make>["control"]): BulkUi | undefined => c.statesOf(KEY).get(GROUP);

describe("createBulkControl(場ごとの一括実行)", () => {
  it("前提: 偽のデータで、確認画面は開ける(以下の「何もしない」の対照)", () => {
    const { control, events } = make();
    control.onOpen(GROUP, "morning");
    expect(stateOf(control)).toEqual({ kind: "confirm", mode: "morning", raceIds: [F1, F2], excluded: { running: 0, done: 0, started: 0, timeUnknown: 0 } });
    expect(events).toEqual(["change"]);
  });

  it("閲覧者(admin が false)は、開く・実行する・やめるのどれも何もしない(状態も再描画も POST も無い)。開けないので、状態が無いまま", async () => {
    const viewer = make({ admin: false });
    viewer.control.onOpen(GROUP, "morning");
    expect(stateOf(viewer.control)).toBeUndefined(); // 対照(管理者なら上の前提のとおり開く)
    viewer.control.onGo(GROUP);
    viewer.control.onDismiss(GROUP);
    await settle();
    expect(viewer.events).toEqual([]);
    expect(viewer.posts).toEqual([]);
    expect(viewer.control.statesOf(KEY).size).toBe(0);
  });

  it("画面が一覧でないとき(閲覧者でない)、開いても何もしない", () => {
    const { control, events } = make({ listScreen: false });
    control.onOpen(GROUP, "morning");
    expect(events).toEqual([]);
    expect(stateOf(control)).toBeUndefined();
  });

  it("過去の開催日・板が取れていない・一覧が取れていない・不明な場のキーでは開かない(例外も投げない)", () => {
    const past = make({ now: Date.parse("2026-06-29T00:00:00Z") }); // 開催日の翌日
    past.control.onOpen(GROUP, "morning");
    expect(stateOf(past.control)).toBeUndefined();
    const noBoard = make({ board: null });
    noBoard.control.onOpen(GROUP, "morning");
    expect(stateOf(noBoard.control)).toBeUndefined();
    const noList = make({ list: { kind: "loading" } });
    noList.control.onOpen(GROUP, "morning");
    expect(stateOf(noList.control)).toBeUndefined();
    const unknown = make();
    expect(() => unknown.control.onOpen("存在しない場のキー", "morning")).not.toThrow();
    expect(unknown.control.statesOf(KEY).size).toBe(0);
    expect(unknown.events).toEqual([]);
  });

  it("対象が 0 件(全レースが実行中)のときは開かない", () => {
    const { control, events } = make({ board: [boardRow(F1, "queued"), boardRow(F2, "done")] });
    control.onOpen(GROUP, "morning");
    expect(stateOf(control)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("送信中は開き直せない(送信中の状態を確認画面で上書きしない)", async () => {
    const gate = deferred<Resp>();
    const { control } = make({ respond: () => gate.promise });
    control.onOpen(GROUP, "morning");
    control.onGo(GROUP);
    expect(stateOf(control)).toEqual({ kind: "sending", mode: "morning" });
    control.onOpen(GROUP, "pre_race");
    expect(stateOf(control)).toEqual({ kind: "sending", mode: "morning" });
    gate.resolve(accepted());
    await settle();
  });

  it("送信中は「やめる」「閉じる」で消せない。結果が出たあとは消せる", async () => {
    const gate = deferred<Resp>();
    const { control } = make({ respond: () => gate.promise });
    control.onOpen(GROUP, "morning");
    control.onGo(GROUP);
    control.onDismiss(GROUP);
    expect(stateOf(control)?.kind).toBe("sending");
    gate.resolve(accepted());
    await settle();
    expect(stateOf(control)?.kind).toBe("result");
    control.onDismiss(GROUP);
    expect(stateOf(control)).toBeUndefined();
  });

  it("受理: 再描画(送信中)→ POST(確認した対象)→ レースごとのオーバーレイ(受理は queued・実行中は応答の status)→ 追跡の開始 → 結果 → 再描画 の順", async () => {
    const { control, events, posts } = make();
    control.onOpen(GROUP, "morning");
    events.length = 0;
    control.onGo(GROUP);
    expect(stateOf(control)).toEqual({ kind: "sending", mode: "morning" }); // 同期の印
    await settle();
    expect(events).toEqual(["change", "fetch POST /api/analyses/run/bulk", `overlay ${DATE} ${F1} morning queued ${NOW}`, `overlay ${DATE} ${F2} morning fetched ${NOW}`, `track ${DATE}`, "change"]);
    expect(posts).toEqual([{ kaisai_date: DATE, mode: "morning", race_ids: [F1, F2] }]);
    const state = stateOf(control);
    expect(state?.kind === "result" ? state.tone : null).toBe("ok");
  });

  it("本文が想定外(202 の形違い): 追跡は始め、オーバーレイは重ねず、失敗の結果を出す。1 日の上限(409)・失敗は追跡もオーバーレイもしない", async () => {
    const malformed = make({ respond: () => resp(202, { ok: true }) });
    malformed.control.onOpen(GROUP, "morning");
    malformed.events.length = 0;
    malformed.control.onGo(GROUP);
    await settle();
    expect(malformed.events).toEqual(["change", "fetch POST /api/analyses/run/bulk", `track ${DATE}`, "change"]);
    expect(stateOf(malformed.control)).toMatchObject({ kind: "result", tone: "error" });

    const cap = make({ respond: () => resp(409, { ok: false, error: { type: "day-cap", limit: 100, used: 99, needed: 2 } }) });
    cap.control.onOpen(GROUP, "morning");
    cap.events.length = 0;
    cap.control.onGo(GROUP);
    await settle();
    expect(cap.events).toEqual(["change", "fetch POST /api/analyses/run/bulk", "change"]);
    expect(stateOf(cap.control)).toMatchObject({ kind: "result", tone: "error" });

    const failed = make({ respond: () => resp(500, { ok: false }) });
    failed.control.onOpen(GROUP, "morning");
    failed.events.length = 0;
    failed.control.onGo(GROUP);
    await settle();
    expect(failed.events).toEqual(["change", "fetch POST /api/analyses/run/bulk", "change"]);
    expect(stateOf(failed.control)).toMatchObject({ kind: "result", tone: "error" });
  });

  it("確認画面でない状態(状態なし・結果)で「実行する」を押しても何もしない", async () => {
    const { control, events, posts } = make();
    control.onGo(GROUP); // 状態なし
    expect(events).toEqual([]);
    control.onOpen(GROUP, "morning");
    control.onGo(GROUP);
    await settle();
    expect(stateOf(control)?.kind).toBe("result");
    events.length = 0;
    control.onGo(GROUP); // 結果の状態
    await settle();
    expect(events).toEqual([]);
    expect(posts).toHaveLength(1);
  });

  it("実行の直前に対象を取り直す: 確認のあとで実行中になったレースは外れ、全部外れたら POST せず結果(エラー)にする", async () => {
    let board: readonly BoardRow[] = [];
    const events: string[] = [];
    const posts: unknown[] = [];
    const route = parseHash(`#date=${DATE}&venue=central`, DATE);
    const control = createBulkControl({
      fetch: (url, init) => {
        events.push(`fetch ${url}`);
        posts.push(JSON.parse(init.body as string));
        return Promise.resolve(accepted());
      },
      now: () => new Date(NOW),
      admin: true,
      onChange: () => void events.push("change"),
      route: () => route,
      isListScreen: () => true,
      listSource: () => ({ kind: "ready", races: RACES }),
      boardRows: () => board,
      setOverlay: () => 1,
      forceTrack: () => {},
    });
    control.onOpen(GROUP, "morning");
    board = [boardRow(F1, "queued")]; // 確認のあとで F1 が実行中になった
    control.onGo(GROUP);
    await settle();
    expect(posts).toEqual([{ kaisai_date: DATE, mode: "morning", race_ids: [F2] }]);

    control.onDismiss(GROUP);
    board = [];
    control.onOpen(GROUP, "morning");
    board = [boardRow(F1, "done"), boardRow(F2, "queued")]; // 全部外れた
    posts.length = 0;
    control.onGo(GROUP);
    await settle();
    expect(posts).toEqual([]);
    expect(stateOf(control)).toMatchObject({ kind: "result", tone: "error", text: "対象のレースがなくなったため、何も予約していません。" });
  });

  it("確認のあとで日付が変わって過去の開催日になったら、POST せず結果(エラー)にする", async () => {
    const { control, posts, setNow } = make();
    control.onOpen(GROUP, "morning");
    setNow(Date.parse("2026-06-29T00:00:00Z")); // 翌日 09:00 JST
    control.onGo(GROUP);
    await settle();
    expect(posts).toEqual([]);
    expect(stateOf(control)).toMatchObject({ kind: "result", tone: "error" });
  });

  it("pending() は POST の完了まで入っていて、終わると空になる(whenIdle が待てる)。statesOf は読むだけで作らない", async () => {
    const gate = deferred<Resp>();
    const { control } = make({ respond: () => gate.promise });
    expect(control.statesOf(KEY).size).toBe(0);
    control.onOpen(GROUP, "morning");
    control.onGo(GROUP);
    expect(control.pending()).toHaveLength(1);
    gate.resolve(accepted());
    await settle();
    expect(control.pending()).toEqual([]);
    expect(control.statesOf("無い鍵").size).toBe(0);
  });

  it("状態は (開催日, 区分) ごと: 別の区分の鍵には出ない", () => {
    const { control } = make();
    control.onOpen(GROUP, "morning");
    expect(control.statesOf(KEY).size).toBe(1);
    expect(control.statesOf(listKey(DATE, "nar")).size).toBe(0);
    expect(control.statesOf(listKey("20260629", "central")).size).toBe(0);
  });
});
