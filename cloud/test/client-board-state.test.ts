import { describe, expect, it } from "vitest";
import type { BoardRow, TaskMode, TaskStatus } from "../client/api";
import { createBoardStore } from "../client/board-state";

/**
 * Issue #186 段階2: 板の状態(開催日ごとの行・要求の通し番号・起動直後のオーバーレイ・完了の検知)。純ロジック。
 * 守ること:
 *  - **古い応答が新しい状態を上書きしない**(応答は、自分の通し番号が適用済みの最大より大きいときだけ採用する)
 *  - オーバーレイ(202 の直後に重ねる「待ち」)は、**202 より後に出した取得の応答**が届いたときだけ外れる(POST より前に出した取得の応答では消えない)
 *  - 完了(queued・fetched → done)の検知は、(開催日, race_id, mode, queued_at)ごとに 1 回。最初から done の行は遷移ではない
 */

const DATE = "20260628";
const RACE = "202603020211";
const row = (status: TaskStatus, over: Partial<BoardRow> & { mode?: TaskMode } = {}): BoardRow => ({
  raceId: RACE,
  mode: "morning",
  status,
  attempts: 0,
  error: null,
  queuedAt: 1000,
  updatedAt: 2000,
  prior: false,
  analysisId: null,
  ...over,
});
const statusOf = (store: ReturnType<typeof createBoardStore>, mode: TaskMode = "morning", raceId = RACE, date = DATE): TaskStatus | undefined =>
  store.effectiveRows(date)?.find((r) => r.raceId === raceId && r.mode === mode)?.status;

describe("通し番号(古い応答が新しい状態を上書きしない)", () => {
  it("番号は単調に増える。より大きい番号の応答だけが適用され、古い(小さい・同じ)番号の応答は捨てられる", () => {
    const store = createBoardStore();
    const a = store.nextSeq();
    const b = store.nextSeq();
    expect(b).toBeGreaterThan(a);
    expect(store.apply(DATE, [row("done")], b).applied).toBe(true);
    expect(store.apply(DATE, [row("queued")], a).applied).toBe(false); // 先に出した取得が後から届いた
    expect(statusOf(store)).toBe("done");
    expect(store.apply(DATE, [row("queued")], b).applied).toBe(false); // 同じ番号も採用しない
    expect(statusOf(store)).toBe("done");
    const c = store.nextSeq();
    expect(store.apply(DATE, [row("failed")], c).applied).toBe(true);
    expect(statusOf(store)).toBe("failed");
  });

  it("番号は開催日ごと。別の日の応答は互いに影響しない", () => {
    const store = createBoardStore();
    const a = store.nextSeq();
    const b = store.nextSeq();
    store.apply("20260628", [row("done")], b);
    expect(store.apply("20260629", [row("queued")], a).applied).toBe(true); // 別の日(適用済みの最大は 0)
    expect(statusOf(store, "morning", RACE, "20260629")).toBe("queued");
  });

  it("clear(手動の取り直しの前)は行を消すが、適用済みの番号は覚えている(消す前に出した古い取得が、あとから行を復活させない)", () => {
    const store = createBoardStore();
    const old = store.nextSeq();
    const fresh = store.nextSeq();
    store.apply(DATE, [row("queued")], fresh);
    expect(store.has(DATE)).toBe(true);
    store.clear(DATE);
    expect(store.has(DATE)).toBe(false);
    expect(store.effectiveRows(DATE)).toBeNull();
    expect(store.apply(DATE, [row("done")], old).applied).toBe(false);
    expect(store.has(DATE)).toBe(false);
    expect(store.apply(DATE, [row("done")], store.nextSeq()).applied).toBe(true);
    expect(store.has(DATE)).toBe(true);
  });
});

describe("オーバーレイ(202・409 の直後に重ねる実行中の状態)", () => {
  it("板に重ねて、その (race_id, mode) の行を待ち(または取得済み)にする。ほかの行・もう一方のモードは変えない", () => {
    const store = createBoardStore();
    store.apply(DATE, [row("done"), row("done", { mode: "pre_race" }), row("done", { raceId: "202603020212" })], store.nextSeq());
    store.setOverlay(DATE, RACE, "pre_race", "queued", 5000);
    expect(statusOf(store, "pre_race")).toBe("queued");
    expect(statusOf(store, "morning")).toBe("done");
    expect(statusOf(store, "morning", "202603020212")).toBe("done");
    store.setOverlay(DATE, RACE, "morning", "fetched", 5000);
    expect(statusOf(store, "morning")).toBe("fetched"); // 409 の status をそのまま使える
    // 重ねた行の中身(待ちの行として自然な値)
    const overlay = store.effectiveRows(DATE)!.find((r) => r.mode === "pre_race")!;
    expect(overlay).toMatchObject({ raceId: RACE, mode: "pre_race", status: "queued", attempts: 0, error: null, analysisId: null, queuedAt: 5000, updatedAt: 5000 });
  });

  it("板が無い日には重ならない(行を作らない=他のレースを「未実行」に見せない)。板が届けば、そのとき重なる", () => {
    const store = createBoardStore();
    const early = store.nextSeq(); // POST より前に出した取得
    store.setOverlay(DATE, RACE, "morning", "queued", 5000);
    expect(store.effectiveRows(DATE)).toBeNull();
    expect(store.apply(DATE, [row("done")], early).applied).toBe(true);
    expect(statusOf(store)).toBe("queued"); // 板の行(done)の上に、起動した状態が重なる
  });

  it("202 より後に出した取得の応答が届くと、オーバーレイが外れ、板の行が真実になる(板の行は 1 つだけ)", () => {
    const store = createBoardStore();
    store.apply(DATE, [row("done")], store.nextSeq()); // 前提: 古い行(完了)が板にある
    store.setOverlay(DATE, RACE, "morning", "queued", 5000);
    expect(statusOf(store)).toBe("queued"); // 前提: 重なっている
    const after = store.nextSeq(); // POST より後に出した取得
    expect(store.apply(DATE, [row("fetched", { queuedAt: 5000 })], after).applied).toBe(true);
    expect(statusOf(store)).toBe("fetched"); // オーバーレイが外れ、板の行(取得済み)になった
    expect(store.effectiveRows(DATE)!.filter((r) => r.mode === "morning")).toHaveLength(1);
  });

  it("202 より前に出した取得の応答は、(適用済みの最大より大きければ)適用されて板の他の行は更新されるが、オーバーレイは消さない", () => {
    const store = createBoardStore();
    store.apply(DATE, [row("done")], store.nextSeq());
    const early = store.nextSeq(); // POST より前に出した取得(まだ届いていない)
    store.setOverlay(DATE, RACE, "morning", "queued", 5000);
    expect(store.apply(DATE, [row("done"), row("queued", { raceId: "202603020212" })], early).applied).toBe(true);
    expect(statusOf(store)).toBe("queued"); // 重なったまま(古い「完了」に戻らない)
    expect(statusOf(store, "morning", "202603020212")).toBe("queued"); // 板の他の行は更新された
  });
});

describe("実行中の日の検出(追跡の対象)", () => {
  it("queued・fetched の行(またはオーバーレイ)がある日だけが対象。done・failed だけの日は対象でない。日付の昇順", () => {
    const store = createBoardStore();
    store.apply("20260629", [row("queued")], store.nextSeq());
    store.apply("20260628", [row("fetched")], store.nextSeq());
    store.apply("20260627", [row("done"), row("failed", { mode: "pre_race" })], store.nextSeq());
    expect(store.activeDates()).toEqual(["20260628", "20260629"]);
    store.apply("20260628", [row("done")], store.nextSeq());
    expect(store.activeDates()).toEqual(["20260629"]);
    store.setOverlay("20260627", RACE, "morning", "queued", 1);
    expect(store.activeDates()).toEqual(["20260627", "20260629"]);
  });
});

describe("完了の検知(queued・fetched → done を、同じ完了につき 1 回)", () => {
  const completionsOf = (store: ReturnType<typeof createBoardStore>, rows: BoardRow[], date = DATE) => store.apply(date, rows, store.nextSeq()).completions;

  it("queued → done で 1 回。次に同じ done を見ても 0 回", () => {
    const store = createBoardStore();
    expect(completionsOf(store, [row("queued")])).toEqual([]);
    expect(completionsOf(store, [row("done")])).toEqual([{ date: DATE, raceId: RACE, mode: "morning" }]);
    expect(completionsOf(store, [row("done")])).toEqual([]);
  });

  it("fetched → done も完了。failed への遷移は完了でない", () => {
    const store = createBoardStore();
    completionsOf(store, [row("fetched")]);
    expect(completionsOf(store, [row("done")])).toHaveLength(1);
    const other = createBoardStore();
    completionsOf(other, [row("queued")]);
    expect(completionsOf(other, [row("failed")])).toEqual([]);
  });

  it("最初から done の行(ページを開いたとき・初めて見た板)は遷移でない", () => {
    const store = createBoardStore();
    expect(completionsOf(store, [row("done"), row("done", { mode: "pre_race" })])).toEqual([]);
  });

  it("再実行: 前の done を見たあと、オーバーレイ(待ち)を経て done になると、新しい完了として 1 回(前の done を見ていても)", () => {
    const store = createBoardStore();
    completionsOf(store, [row("done", { queuedAt: 1000 })]); // 前提: 前の実行の完了を見ている(最初から done=遷移でない)
    store.setOverlay(DATE, RACE, "pre_race", "queued", 5000);
    store.setOverlay(DATE, RACE, "morning", "queued", 5000);
    // 速く終わって、待ちの板を一度も見ずに done になった(オーバーレイが待ちの印)
    expect(completionsOf(store, [row("done", { queuedAt: 5000 })])).toEqual([{ date: DATE, raceId: RACE, mode: "morning" }]);
    expect(completionsOf(store, [row("done", { queuedAt: 5000 })])).toEqual([]);
  });

  it("再実行の完了は、前の完了とは別(queued_at が違う)。同じ queued_at の done は 2 回数えない", () => {
    const store = createBoardStore();
    completionsOf(store, [row("queued", { queuedAt: 1000 })]);
    expect(completionsOf(store, [row("done", { queuedAt: 1000 })])).toHaveLength(1);
    completionsOf(store, [row("queued", { queuedAt: 7000 })]);
    expect(completionsOf(store, [row("done", { queuedAt: 7000 })])).toHaveLength(1);
  });

  it("POST より前に出した取得の古い done(前の実行の完了)を、新しい完了と取り違えない(オーバーレイがある間は、その done を数えない)", () => {
    const store = createBoardStore();
    const early = store.nextSeq(); // POST より前に出した取得
    store.setOverlay(DATE, RACE, "pre_race", "queued", 5000);
    // その取得が(前の実行の)done を載せて届く。前提: 適用はされる
    const result = store.apply(DATE, [row("done", { mode: "pre_race", queuedAt: 1000, analysisId: 3 })], early);
    expect(result.applied).toBe(true);
    expect(result.completions).toEqual([]);
    // POST より後の取得が queued を見せ、その後 done になれば、完了は 1 回
    expect(completionsOf(store, [row("queued", { mode: "pre_race", queuedAt: 5000 })])).toEqual([]);
    expect(completionsOf(store, [row("done", { mode: "pre_race", queuedAt: 5000, analysisId: 4 })])).toEqual([{ date: DATE, raceId: RACE, mode: "pre_race" }]);
  });

  it("捨てられた(古い番号の)応答では、完了を検知しない", () => {
    const store = createBoardStore();
    const old = store.nextSeq();
    completionsOf(store, [row("queued")]);
    const result = store.apply(DATE, [row("done")], old);
    expect(result.applied).toBe(false);
    expect(result.completions).toEqual([]);
  });

  it("レース・モード・開催日が違えば別のもの(2 つのモード・2 つの日の完了を、それぞれ検知する)", () => {
    const store = createBoardStore();
    completionsOf(store, [row("queued"), row("queued", { mode: "pre_race" })]);
    completionsOf(store, [row("queued")], "20260629");
    const done = completionsOf(store, [row("done"), row("done", { mode: "pre_race" })]);
    expect(done.map((c) => `${c.date}:${c.mode}`).sort()).toEqual([`${DATE}:morning`, `${DATE}:pre_race`]);
    expect(completionsOf(store, [row("done")], "20260629")).toEqual([{ date: "20260629", raceId: RACE, mode: "morning" }]);
  });
});
