import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createVerifyScreen, VERIFY_BACKFILL_POLL_MS, VERIFY_MAX_POLLS, VERIFY_PREPARING_POLL_MS, type VerifyScreen } from "../client/verify-screen";
import { createFakeTimers, deferred } from "./client-fakes";
import { calibrationFixture, trendFixture, versionsFixture } from "./verify-fixtures";

/**
 * Issue #219: 検証画面の制御(取得・区分の切替・更新・ポーリング)。偽の fetch・偽のタイマー・偽の可視状態。
 * 守ること:
 *  - 開くと `GET /api/verify?venue=all` を 1 回だけ取る(他の API に出ない)。区分の切替は取り直す。「更新」は `refresh=1`
 *  - 補完中(preparing・stale の backfilling)だけ自動で取り直す(preparing は 3 秒・backfilling は 5 秒)。それ以外(通常の集計・柵・エラー)では止める。回数の上限がある
 *  - 非表示の間は止め、表示に戻ったら即時に 1 回取って再開する。通信の失敗が 3 回続いたら止める
 *  - 区分を切り替えたあとに、前の区分の遅れた応答が届いても反映しない。画面を離れたら、タイマー・遅れて届く応答を捨てる
 */

type Resp = { status: number; json: () => Promise<unknown> };
const reply = (code: number, body: unknown): Resp => ({ status: code, json: async () => body });

const SUMMARY = { betCount: 1, totalStake: 100, totalReturn: 150, recoveryRate: 1.5, unjudgedCount: 0 };
const REPORT = {
  includedAnalysisCount: 3, excludedAnalysisCount: 0, supersededAnalysisCount: 0, excludedEstimatedCount: 0, excludedLookaheadSuspectCount: 0, excludedLookaheadUnknownCount: 0,
  bet: { betCount: 1, totalStake: 100, totalReturn: 150, recoveryRate: 1.5, actualPayoutCount: 1, approximatePayoutCount: 0 },
  calibration: calibrationFixture(),
  trend: trendFixture(),
  proposedBet: {
    population: { allocated: 1, skipped: 0, unreached: 0, noRecord: 0 },
    overall: SUMMARY, place: SUMMARY, win: SUMMARY, wide: SUMMARY, trio: SUMMARY, quinella: SUMMARY, exacta: SUMMARY, trifecta: SUMMARY, bracketQuinella: SUMMARY,
    unknownBetType: { count: 0, totalStake: 0, betTypes: [] },
  },
};
const ready = (venue: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true, status: "ready", venue, report: REPORT, promptVersions: versionsFixture(), computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null,
  diag: { startTimeGaps: { lost: 0, affecting: 0 } }, ...over,
});
const preparing = (remaining: number, blocked: string | null = null): Record<string, unknown> => ({ ok: true, status: "preparing", remaining, blocked, resumeAt: null });

interface Harness {
  readonly screen: VerifyScreen;
  readonly timers: ReturnType<typeof createFakeTimers>;
  readonly urls: string[];
  /** 呼ばれるたびに先頭から消費する応答(残りが無ければ最後のものを繰り返す)。 */
  responses: (Resp | "throw")[];
  /** 次の 1 回の取得だけ、この Promise で返す(遅れて届く応答の再現。使うと null に戻る)。 */
  once: Promise<Resp> | null;
  visible: boolean;
  changes: number;
  settle(): Promise<void>;
}

function harness(): Harness {
  const timers = createFakeTimers();
  const urls: string[] = [];
  const h: Harness = {
    timers,
    urls,
    responses: [reply(200, ready("all"))],
    once: null,
    visible: true,
    changes: 0,
    settle: async () => {
      for (let i = 0; i < 6; i += 1) {
        await Promise.all(h.screen.pending());
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    screen: undefined as never,
  };
  const fetchLike: FetchLike = async (url, init) => {
    if (init.method !== "GET" || !url.startsWith("/api/verify?")) throw new Error(`想定外の取得: ${init.method} ${url}`);
    urls.push(url);
    if (h.once !== null) {
      const o = h.once;
      h.once = null;
      return o;
    }
    const next = h.responses.length > 1 ? h.responses.shift()! : h.responses[0]!;
    if (next === "throw") throw new TypeError("Failed to fetch");
    return next;
  };
  (h as { screen: VerifyScreen }).screen = createVerifyScreen({
    fetch: fetchLike,
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => h.visible,
    onChange: () => {
      h.changes += 1;
    },
  });
  return h;
}

async function open(h: Harness): Promise<void> {
  h.screen.enter();
  await h.settle();
}

describe("開く", () => {
  it("GET /api/verify?venue=all を 1 回だけ取る。重ねて enter しても増えない。取得前は loading、取得後は集計", async () => {
    const h = harness();
    h.screen.enter();
    expect(h.screen.model().loading).toBe(true);
    h.screen.enter();
    await h.settle();
    expect(h.urls).toEqual(["/api/verify?venue=all"]);
    expect(h.screen.model().bet?.tiles[3]?.value).toBe("150.0%");
    expect(h.screen.model().loading).toBe(false);
    expect(h.timers.pending()).toBe(0);
  });

  it("取得に失敗すると固定の文言のエラーを出し、自動では再試行しない(更新で取り直す)", async () => {
    const h = harness();
    h.responses = [reply(503, { ok: false, error: { type: "verify-error" } }), reply(200, ready("all"))];
    await open(h);
    expect(h.screen.model().error).toContain("サーバでエラー");
    expect(h.timers.pending()).toBe(0);
    h.screen.onRefresh();
    await h.settle();
    expect(h.screen.model().error).toBeNull();
    expect(h.urls).toEqual(["/api/verify?venue=all&refresh=1".replace("&refresh=1", ""), "/api/verify?venue=all&refresh=1"]);
  });
});

describe("区分の切替と更新", () => {
  it("区分を切り替えると、その区分で取り直す(同じ区分なら何もしない)。更新は refresh=1 で、いまの区分", async () => {
    const h = harness();
    h.responses = [reply(200, ready("all")), reply(200, ready("nar")), reply(200, ready("nar"))];
    await open(h);
    h.screen.onVenue("all");
    await h.settle();
    expect(h.urls).toHaveLength(1);
    h.screen.onVenue("nar");
    await h.settle();
    h.screen.onRefresh();
    await h.settle();
    expect(h.urls).toEqual(["/api/verify?venue=all", "/api/verify?venue=nar", "/api/verify?venue=nar&refresh=1"]);
    expect(h.screen.model().venueTabs.find((t) => t.current)?.venue).toBe("nar");
  });

  it("切替の直後に、前の区分の遅れた応答が届いても反映しない(新しい区分の応答だけを採る)", async () => {
    const h = harness();
    await open(h);
    const late = deferred<Resp>();
    h.once = late.promise;
    h.screen.onVenue("central"); // 遅れる応答
    h.responses = [reply(200, ready("nar"))];
    h.screen.onVenue("nar");
    // 遅れる応答はまだ保留のまま(settle は保留を待つので使えない)。数巡だけ I/O を流す。
    for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.screen.model().bet?.tiles[0]?.value).toBe("1点"); // nar の応答は反映済み
    late.resolve(reply(200, ready("central", { report: { ...REPORT, includedAnalysisCount: 999 } })));
    await h.settle();
    const m = h.screen.model();
    expect(m.venueTabs.find((t) => t.current)?.venue).toBe("nar");
    expect(m.bet?.exclusions[0]).toEqual({ label: "集計", value: "3件" });
  });

  it("通信中の更新は無視する(同じものを同時に 2 本取らない)", async () => {
    const h = harness();
    await open(h);
    const slow = deferred<Resp>();
    h.once = slow.promise;
    h.screen.onRefresh();
    h.screen.onRefresh();
    expect(h.urls).toHaveLength(2);
    slow.resolve(reply(200, ready("all")));
    await h.settle();
    expect(h.screen.model().refreshDisabled).toBe(false);
  });
});

describe("ポーリング", () => {
  it("preparing は 3 秒ごとに取り直し、ready になったら止める。準備中は集計を出さない", async () => {
    const h = harness();
    h.responses = [reply(200, preparing(100)), reply(200, preparing(60)), reply(200, ready("all"))];
    await open(h);
    expect(h.screen.model().unavailable?.text).toContain("100件");
    expect(h.screen.model().bet).toBeNull();
    expect(h.timers.nextIn()).toBe(VERIFY_PREPARING_POLL_MS);
    expect(VERIFY_PREPARING_POLL_MS).toBe(3000);
    await h.timers.advance(VERIFY_PREPARING_POLL_MS);
    await h.settle();
    expect(h.screen.model().unavailable?.text).toContain("60件");
    await h.timers.advance(VERIFY_PREPARING_POLL_MS);
    await h.settle();
    expect(h.screen.model().bet).not.toBeNull();
    expect(h.timers.pending()).toBe(0);
    expect(h.urls).toHaveLength(3);
  });

  it("stale の backfilling(集計は出ている)は 5 秒ごとに取り直し、解消したら止める", async () => {
    const h = harness();
    h.responses = [reply(200, ready("all", { stale: true, staleReason: "backfilling" })), reply(200, ready("all"))];
    await open(h);
    expect(h.screen.model().bet).not.toBeNull();
    expect(h.timers.nextIn()).toBe(VERIFY_BACKFILL_POLL_MS);
    await h.timers.advance(VERIFY_BACKFILL_POLL_MS);
    await h.settle();
    expect(h.timers.pending()).toBe(0);
    expect(h.screen.model().notices).toEqual([]);
  });

  it.each([
    ["通常の集計", ready("all")],
    ["柵(min-interval)で古い集計", ready("all", { stale: true, staleReason: "min-interval", nextRecomputeAt: "2026-10-10T03:05:00.000Z" })],
    ["R2 の柵で止まっている準備中", preparing(5, "r2-fence")],
    ["エラーで止まっている準備中", preparing(5, "error")],
    ["throttled", { ok: true, status: "throttled", nextAt: "2026-10-10T15:00:00.000Z" }],
  ])("%s ではタイマーを張らない", async (_name, body) => {
    const h = harness();
    h.responses = [reply(200, body)];
    await open(h);
    expect(h.timers.pending()).toBe(0);
  });

  it("上限回数(VERIFY_MAX_POLLS)を超えたら止めて、自動更新を止めた旨を出す", async () => {
    const h = harness();
    h.responses = [reply(200, preparing(5))];
    await open(h);
    for (let i = 0; i < VERIFY_MAX_POLLS + 5 && h.timers.pending() > 0; i += 1) {
      await h.timers.advance(VERIFY_PREPARING_POLL_MS);
      await h.settle();
    }
    expect(h.urls).toHaveLength(1 + VERIFY_MAX_POLLS);
    expect(h.timers.pending()).toBe(0);
    expect(h.screen.model().pollNotice).not.toBeNull();
  });

  it("ポーリング中の通信の失敗は前の表示を残し、3 回続いたら止める。成功すれば回数は戻る", async () => {
    const h = harness();
    h.responses = [reply(200, preparing(5)), "throw", "throw", reply(200, preparing(4)), "throw", "throw", "throw"];
    await open(h);
    for (let i = 0; i < 6; i += 1) {
      if (h.timers.pending() === 0) break;
      await h.timers.advance(VERIFY_PREPARING_POLL_MS);
      await h.settle();
    }
    expect(h.urls).toHaveLength(7);
    expect(h.timers.pending()).toBe(0);
    expect(h.screen.model().pollNotice).not.toBeNull();
    expect(h.screen.model().unavailable?.text).toContain("4件"); // 最後に取れた表示が残る
    expect(h.screen.model().error).toBeNull();
  });
});

describe("可視状態", () => {
  it("非表示になるとタイマーを消し、表示に戻ると即時に 1 回取って再開する", async () => {
    const h = harness();
    h.responses = [reply(200, preparing(5)), reply(200, preparing(4)), reply(200, ready("all"))];
    await open(h);
    expect(h.timers.pending()).toBe(1);
    h.visible = false;
    h.screen.onVisibilityChange();
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(60_000);
    expect(h.urls).toHaveLength(1);
    h.visible = true;
    h.screen.onVisibilityChange();
    await h.settle();
    expect(h.urls).toHaveLength(2);
    expect(h.timers.pending()).toBe(1);
  });

  it("補完中でなければ、表示に戻っても取らない", async () => {
    const h = harness();
    await open(h);
    h.visible = false;
    h.screen.onVisibilityChange();
    h.visible = true;
    h.screen.onVisibilityChange();
    await h.settle();
    expect(h.urls).toHaveLength(1);
  });

  it("画面に居ない(enter 前・leave 後)間の可視状態の変化は何もしない", async () => {
    const h = harness();
    h.screen.onVisibilityChange();
    expect(h.urls).toEqual([]);
  });
});

describe("離れる", () => {
  it("leave でタイマー・状態を捨て、遅れて届く応答を反映しない。開き直すと取り直す(区分は全体に戻る)", async () => {
    const h = harness();
    h.responses = [reply(200, preparing(5))];
    await open(h);
    h.screen.onVenue("nar");
    await h.settle();
    const slow = deferred<Resp>();
    h.once = slow.promise;
    h.screen.onRefresh();
    h.screen.leave();
    expect(h.timers.pending()).toBe(0);
    const changes = h.changes;
    slow.resolve(reply(200, ready("nar")));
    await h.settle();
    expect(h.changes).toBe(changes);
    h.responses = [reply(200, ready("all"))];
    await open(h);
    expect(h.urls.at(-1)).toBe("/api/verify?venue=all");
    expect(h.screen.model().venueTabs.find((t) => t.current)?.venue).toBe("all");
  });
});

describe("版別キャリブレーションの開閉(Issue #220)", () => {
  const KEY = "v:2026-10-09.2";
  const card = (h: Harness, key = KEY) => h.screen.model().versions?.cards.find((c) => c.key === key);

  it("開く/閉じる: 取得は増えず、再描画を要求する。開いた版だけが行を持つ", async () => {
    const h = harness();
    await open(h);
    expect(card(h)?.expanded).toBe(false); // 前提(空振り防止): 既定は閉じている
    const urls = h.urls.length;
    const changes = h.changes;
    h.screen.onVersionToggle(KEY, true);
    expect(card(h)?.expanded).toBe(true);
    expect(card(h)?.calibrationRows).toHaveLength(20);
    expect(card(h, "unknown")?.expanded).toBe(false);
    expect(h.changes).toBe(changes + 1);
    h.screen.onVersionToggle(KEY, false);
    expect(card(h)?.expanded).toBe(false);
    expect(h.changes).toBe(changes + 2);
    expect(h.urls).toHaveLength(urls);
  });

  it("2 つの版を同時に開ける。同じ状態を重ねて指示しても壊れない", async () => {
    const h = harness();
    await open(h);
    h.screen.onVersionToggle(KEY, true);
    h.screen.onVersionToggle(KEY, true);
    h.screen.onVersionToggle("unknown", true);
    expect(h.screen.model().versions?.cards.map((c) => c.expanded)).toEqual([true, false, true]);
    h.screen.onVersionToggle(KEY, false);
    h.screen.onVersionToggle(KEY, false);
    expect(h.screen.model().versions?.cards.map((c) => c.expanded)).toEqual([false, false, true]);
  });

  it("区分の切替・更新をまたいで開いたまま(版別は区分に依らないので、取り直しても同じ版を開いておく)", async () => {
    const h = harness();
    await open(h);
    h.screen.onVersionToggle(KEY, true);
    h.screen.onVenue("nar");
    await h.settle();
    expect(card(h)?.expanded).toBe(true);
    h.screen.onRefresh();
    await h.settle();
    expect(card(h)?.expanded).toBe(true);
  });

  it("画面を離れると閉じた状態に戻る。画面に居ない間の指示は何もしない(再描画も要求しない)", async () => {
    const h = harness();
    const before = h.changes;
    h.screen.onVersionToggle(KEY, true); // enter 前
    expect(h.changes).toBe(before);
    await open(h);
    h.screen.onVersionToggle(KEY, true);
    h.screen.leave();
    const afterLeave = h.changes;
    h.screen.onVersionToggle(KEY, true); // leave 後
    expect(h.changes).toBe(afterLeave);
    await open(h);
    expect(card(h)?.expanded).toBe(false);
  });
});
