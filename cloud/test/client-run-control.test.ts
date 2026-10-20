import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createRunControl } from "../client/run-control";
import { deferred } from "./client-fakes";

/**
 * Issue #400 R-11: 単体の起動の制御(`run-control.ts`)の単体テスト。偽の fetch・偽の道具(板のオーバーレイ・追跡の開始・再描画)の呼び出しを記録する。
 * `createApp` を通した振る舞いは `client-app-run.test.ts`・`client-app-r11-characterization.test.ts` が固定している。ここは、`createApp` からは見えない契約
 * (閲覧者は POST しない・道具を呼ぶ**順序と引数**・送信中の同期の印・取得中の待ち)を固定する。
 */

type Resp = { status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });
const DATE = "20260628";
const RACE = "202603020211";
const NOW = Date.parse("2026-06-28T00:00:00Z");
const accepted202 = (mode: string): Resp => resp(202, { ok: true, accepted: true, race_id: RACE, kaisai_date: DATE, mode, status: "queued" });

function make(over: { admin?: boolean; respond?: (mode: string) => Promise<Resp> | Resp } = {}) {
  const events: string[] = [];
  const posts: unknown[] = [];
  const fetchLike: FetchLike = (url, init) => {
    events.push(`fetch ${init.method} ${url}`);
    posts.push(JSON.parse(init.body as string));
    const mode = (posts[posts.length - 1] as { mode: string }).mode;
    return Promise.resolve((over.respond ?? accepted202)(mode));
  };
  const control = createRunControl({
    fetch: fetchLike,
    now: () => new Date(NOW),
    admin: over.admin ?? true,
    onChange: () => void events.push("change"),
    setOverlay: (date, raceId, mode, status, nowMs) => {
      events.push(`overlay ${date} ${raceId} ${mode} ${status} ${nowMs}`);
      return 1;
    },
    forceTrack: (date) => void events.push(`track ${date}`),
  });
  return { control, events, posts };
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("createRunControl(単体の起動)", () => {
  it("閲覧者(admin が false)は、押されても POST せず、状態も変えず、再描画も求めない", async () => {
    const { control, events } = make({ admin: false });
    control.onRun(DATE, RACE, "morning");
    await settle();
    expect(events).toEqual([]);
    expect(control.runsFor(DATE, RACE).size).toBe(0);
    expect(control.pending()).toEqual([]);
  });

  it("受理(202): 再描画(送信中)→ POST → オーバーレイ(queued・開始時刻)→ 追跡の開始 → 再描画 の順。状態は消える(待ちは板が表す)", async () => {
    const { control, events, posts } = make();
    control.onRun(DATE, RACE, "morning");
    expect(control.runsFor(DATE, RACE).get("morning")).toEqual({ kind: "sending" }); // 同期の印(await の前)
    await settle();
    expect(events).toEqual(["change", "fetch POST /api/analyses/run", `overlay ${DATE} ${RACE} morning queued ${NOW}`, `track ${DATE}`, "change"]);
    expect(posts).toEqual([{ race_id: RACE, kaisai_date: DATE, mode: "morning" }]);
    expect(control.runsFor(DATE, RACE).size).toBe(0);
  });

  it("実行中(409 already-running): 状態は「すでに実行中」。オーバーレイは応答の status(fetched など)で、追跡を始める", async () => {
    const { control, events } = make({ respond: () => resp(409, { ok: false, error: { type: "already-running", status: "fetched" } }) });
    control.onRun(DATE, RACE, "pre_race");
    await settle();
    expect(events).toEqual(["change", "fetch POST /api/analyses/run", `overlay ${DATE} ${RACE} pre_race fetched ${NOW}`, `track ${DATE}`, "change"]);
    expect(control.runsFor(DATE, RACE).get("pre_race")).toEqual({ kind: "already" });
  });

  it("受理したが本文が想定外(202 の形違い): 失敗の文言を出し、オーバーレイは重ねず、追跡は始める(板が真実を教える)", async () => {
    const { control, events } = make({ respond: () => resp(202, { ok: true }) });
    control.onRun(DATE, RACE, "morning");
    await settle();
    expect(events).toEqual(["change", "fetch POST /api/analyses/run", `track ${DATE}`, "change"]);
    const state = control.runsFor(DATE, RACE).get("morning");
    expect(state?.kind).toBe("error");
    expect(state?.kind === "error" ? state.message : "").toContain("HTTP 202");
  });

  it("失敗(500): 固定の失敗の文言を出し、オーバーレイも追跡もしない", async () => {
    const { control, events } = make({ respond: () => resp(500, { ok: false }) });
    control.onRun(DATE, RACE, "morning");
    await settle();
    expect(events).toEqual(["change", "fetch POST /api/analyses/run", "change"]);
    expect(control.runsFor(DATE, RACE).get("morning")?.kind).toBe("error");
  });

  it("送信中の二重押しは無視する(POST は 1 回)。別のモードは独立で、runsFor はモードごとに返す", async () => {
    const gate = deferred<Resp>();
    const { control, posts } = make({ respond: (mode) => (mode === "morning" ? gate.promise : accepted202(mode)) });
    control.onRun(DATE, RACE, "morning");
    control.onRun(DATE, RACE, "morning"); // 同期で続けて押す
    expect(posts).toHaveLength(1);
    control.onRun(DATE, RACE, "pre_race");
    expect(posts).toHaveLength(2);
    expect([...control.runsFor(DATE, RACE).keys()].sort()).toEqual(["morning", "pre_race"]);
    expect(control.runsFor(DATE, "202603020212").size).toBe(0); // 別のレースには出ない
    expect(control.runsFor("20260629", RACE).size).toBe(0); // 別の開催日には出ない
    gate.resolve(accepted202("morning"));
    await settle();
  });

  it("pending() は POST の完了まで入っていて、終わると空になる(whenIdle が待てる)", async () => {
    const gate = deferred<Resp>();
    const { control } = make({ respond: () => gate.promise });
    control.onRun(DATE, RACE, "morning");
    expect(control.pending()).toHaveLength(1);
    gate.resolve(accepted202("morning"));
    await settle();
    expect(control.pending()).toEqual([]);
  });
});
