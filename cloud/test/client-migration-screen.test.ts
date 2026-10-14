import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createMigrationScreen, type MigrationScreen } from "../client/migration-screen";
import type { PickedFile } from "../client/vnode";
import { createFakeTimers, deferred } from "./client-fakes";
import { GOLDEN_TEXT } from "./migration-fixture";

/**
 * Issue #222(#167-B2): 移行画面の制御(進捗の取得・ポーリング・ファイルの検証・アップロード)。偽の fetch・偽のタイマー・偽の可視状態。
 * 守ること:
 *  - 開くと `GET /api/migration` を 1 回だけ取る(他の API に出ない)。取り込み中の間だけ控えめな間隔で更新する(verifying・importing は 10 秒、waiting-* は 60 秒)。終端の状態では止める
 *  - 非表示の間は止め、表示に戻ったら即時に 1 回取って再開する。通信の失敗が 3 回続いたら止めて「再読込」を促す(最後に取れた進捗は残す)
 *  - ファイルは選んだらブラウザで検証し、通らなければアップロードさせない。アップロードは検証したファイルそのもの。二重に送らない。取り込み中は選べず始められない
 *  - 画面を離れたら、検証・ポーリング・遅れて届く応答を捨てる。開き直すと今の進捗を取り直す
 */

// Windows のチェックアウトの CRLF は LF にそろえてある(`migration-fixture.ts`)。
const FIXTURE = GOLDEN_TEXT;

function pickedFile(text: string, name = "keiba-cloud-migration.ndjson.gz"): PickedFile {
  return Object.assign(new Blob([new Uint8Array(gzipSync(Buffer.from(text, "utf-8")))]), { name });
}

const BASE = {
  ok: true,
  state: "idle",
  upload: null,
  analyses: { total: null, processed: 0, imported: 0, alreadyImported: 0, conflicts: 0 },
  results: { total: null, processed: 0 },
  resumeAt: null,
  failure: null,
  conflictSamples: [],
  attempts: 0,
  budget: { day: "20261009", usedRows: 0, limitRows: 60000 },
};
const UPLOAD = { size: 1000, uploadedAt: "2026-10-09T01:02:03.000Z", exportedAt: null, appVersion: null };
const status = (state: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...BASE, state, upload: state === "idle" ? null : UPLOAD, ...over });

/** 結果の補完の進捗(Issue #217。`GET /api/results/backfill`)。 */
const BACKFILL_BODY = {
  ok: true,
  state: "ready",
  migrationState: "completed",
  remaining: 321,
  undated: 0,
  imported: 100,
  abandoned: { total: 4, byClass: { "no-payout": 4 } },
  tonight: { night: "20261010", dispatched: 0, limit: 150 },
  inflight: null,
  nextRunAt: null,
  window: { startHour: 1, endHour: 6 },
};

type Resp = { status: number; json: () => Promise<unknown> };
const reply = (code: number, body: unknown): Resp => ({ status: code, json: async () => body });

interface Harness {
  readonly screen: MigrationScreen;
  readonly timers: ReturnType<typeof createFakeTimers>;
  readonly calls: { method: string; url: string; body?: unknown }[];
  /** GET /api/migration の応答(呼ばれるたびに先頭から消費する。残りが無ければ最後のものを繰り返す)。 */
  statuses: (Resp | "throw")[];
  /** GET /api/results/backfill の応答(Issue #217。移行が完了していたときだけ取る)。 */
  backfill: Resp | "throw";
  /** 次の 1 回の補完の進捗の取得だけ、この Promise で返す(遅れて届く応答の再現。使うと null に戻る)。 */
  backfillOnce: Promise<Resp> | null;
  /** POST /api/migration/upload の応答。 */
  uploadResponder: () => Promise<Resp>;
  visible: boolean;
  changes: number;
  /** GET /api/migration の回数(結果の補完の進捗の取得は数えない)。 */
  gets(): number;
  /** GET /api/results/backfill の回数。 */
  backfillGets(): number;
  posts(): number;
  settle(): Promise<void>;
}

function harness(): Harness {
  const timers = createFakeTimers();
  const calls: Harness["calls"] = [];
  const h: Harness = {
    timers,
    calls,
    statuses: [reply(200, status("idle"))],
    backfill: reply(200, BACKFILL_BODY),
    backfillOnce: null,
    uploadResponder: async () => reply(202, status("verifying")),
    visible: true,
    changes: 0,
    gets: () => calls.filter((c) => c.method === "GET" && c.url === "/api/migration").length,
    backfillGets: () => calls.filter((c) => c.method === "GET" && c.url === "/api/results/backfill").length,
    posts: () => calls.filter((c) => c.method === "POST").length,
    // 取得・検証・アップロードの完了を待つ(検証は gzip の展開がスレッドプールで走るので、固定回数の I/O の巡では足りないことがある)。
    settle: async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.all(h.screen.pending());
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    screen: undefined as never,
  };
  const fetchLike: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body === undefined ? {} : { body: init.body }) });
    if (url === "/api/migration" && init.method === "GET") {
      const next = h.statuses.length > 1 ? h.statuses.shift()! : h.statuses[0]!;
      if (next === "throw") throw new TypeError("Failed to fetch");
      return next;
    }
    if (url === "/api/results/backfill" && init.method === "GET") {
      if (h.backfillOnce !== null) {
        const once = h.backfillOnce;
        h.backfillOnce = null;
        return once;
      }
      if (h.backfill === "throw") throw new TypeError("Failed to fetch");
      return h.backfill;
    }
    if (url === "/api/migration/upload" && init.method === "POST") return h.uploadResponder();
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  (h as { screen: MigrationScreen }).screen = createMigrationScreen({
    fetch: fetchLike,
    now: () => timers.now(),
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => h.visible,
    yieldToUi: async () => {},
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

/** ファイルを選んで、検証が終わるまで待つ。 */
async function pick(h: Harness, file: PickedFile): Promise<void> {
  h.screen.onFile(file);
  await h.settle();
}

describe("画面を開く", () => {
  it("開くと GET /api/migration を 1 回だけ取る(取得中は loading。他の API には出ない)", async () => {
    const h = harness();
    h.screen.enter();
    expect(h.screen.model().loading).toBe(true);
    await h.settle();
    expect(h.calls).toEqual([{ method: "GET", url: "/api/migration" }]);
    const m = h.screen.model();
    expect(m.loading).toBe(false);
    expect(m.progress!.headline).toContain("まだ");
    expect(m.canPick).toBe(true);
  });

  it("enter を重ねて呼んでも取得は増えない(再描画のたびに取らない)", async () => {
    const h = harness();
    h.screen.enter();
    h.screen.enter();
    await h.settle();
    h.screen.enter();
    await h.settle();
    expect(h.gets()).toBe(1);
  });

  it("idle・completed・failed では、ポーリングのタイマーを張らない", async () => {
    for (const state of ["idle", "completed", "failed"]) {
      const h = harness();
      h.statuses = [reply(200, status(state, state === "failed" ? { failure: { phase: "verify", message: "m" } } : {}))];
      await open(h);
      expect(h.timers.pending(), state).toBe(0);
    }
  });

  it("取得に失敗したら、エラーの文言を出す。自動で再試行せず、ファイルは選べない。再読込で取り直せる", async () => {
    const h = harness();
    h.statuses = [reply(503, { ok: false, error: { type: "migration-error" } }), reply(200, status("idle"))];
    await open(h);
    const failed = h.screen.model();
    expect(failed.error).toContain("サーバでエラー");
    expect(failed.canPick).toBe(false);
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(120_000);
    expect(h.gets()).toBe(1);
    h.screen.onReload();
    await h.settle();
    expect(h.gets()).toBe(2);
    expect(h.screen.model().error).toBeNull();
    expect(h.screen.model().canPick).toBe(true);
  });

  it("取得中の再読込は無視する(同じものを同時に 2 本取らない)", async () => {
    const h = harness();
    h.screen.enter();
    h.screen.onReload();
    h.screen.onReload();
    await h.settle();
    expect(h.gets()).toBe(1);
  });

  it("画面を離れて開き直すと、今の進捗を取り直して見える(画面を開き直したときも進捗が見える)", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing", { analyses: { total: 10, processed: 4, imported: 4, alreadyImported: 0, conflicts: 0 }, results: { total: 3, processed: 0 } }))];
    await open(h);
    expect(h.screen.model().progress!.lines.join("\n")).toContain("4 / 10");
    h.screen.leave();
    expect(h.screen.model().loading).toBe(true);
    expect(h.screen.model().progress).toBeNull();
    await open(h);
    expect(h.gets()).toBe(2);
    expect(h.screen.model().progress!.lines.join("\n")).toContain("4 / 10");
  });
});

describe("遅れて届く応答(画面を離れた・開き直した)", () => {
  it("離れる前に出した取得の応答は、離れたあとに届いても、今の状態に反映しない(タイマーも張らない)", async () => {
    const h = harness();
    const late = deferred<unknown>();
    h.statuses = [{ status: 200, json: () => late.promise }];
    h.screen.enter();
    await h.timers.flush();
    h.screen.leave();
    late.resolve(status("importing"));
    await h.settle();
    expect(h.timers.pending()).toBe(0);
    expect(h.screen.model().progress).toBeNull();
    expect(h.screen.model().loading).toBe(true);
  });

  it("離れて開き直したあとに古い応答が届いても、新しい取得の最中の印を壊さない(取得が二重にならない)・古い応答の内容を採らない", async () => {
    const h = harness();
    const oldReply = deferred<unknown>();
    const newReply = deferred<unknown>();
    h.statuses = [{ status: 200, json: () => oldReply.promise }, { status: 200, json: () => newReply.promise }];
    h.screen.enter();
    await h.timers.flush();
    h.screen.leave();
    h.screen.enter();
    await h.timers.flush();
    expect(h.gets()).toBe(2);
    oldReply.resolve(status("completed"));
    await h.timers.flush();
    expect(h.screen.model().loading).toBe(true); // 古い応答(completed)は採らない
    h.screen.onReload(); // 新しい取得の最中なので無視される(古い応答が最中の印を落としていれば、ここで 3 本目が出る)
    expect(h.gets()).toBe(2);
    newReply.resolve(status("idle"));
    await h.settle();
    expect(h.screen.model().progress!.headline).toContain("まだ");
  });
});

describe("ポーリング(画面を開いている間だけ・控えめな間隔)", () => {
  it("importing: 10 秒おきに取り、完了(completed)になったら止める", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing")), reply(200, status("importing")), reply(200, status("completed"))];
    await open(h);
    expect(h.timers.nextIn()).toBe(10_000);
    await h.timers.advance(9_999);
    expect(h.gets()).toBe(1);
    await h.timers.advance(1);
    expect(h.gets()).toBe(2);
    await h.timers.advance(10_000);
    expect(h.gets()).toBe(3);
    expect(h.screen.model().progress!.headline).toContain("完了");
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(600_000);
    expect(h.gets()).toBe(3);
  });

  it("verifying も 10 秒、waiting-budget・waiting-r2 は 60 秒", async () => {
    for (const [state, ms] of [["verifying", 10_000], ["importing", 10_000], ["waiting-budget", 60_000], ["waiting-r2", 60_000]] as const) {
      const h = harness();
      h.statuses = [reply(200, status(state, { resumeAt: "2026-10-10T00:05:00.000Z" }))];
      await open(h);
      expect(h.timers.nextIn(), state).toBe(ms);
    }
  });

  it("取り込み中でなくなったら(failed)止める。取り込み中に変わったら(idle から verifying)再開する", async () => {
    const h = harness();
    h.statuses = [reply(200, status("waiting-budget")), reply(200, status("failed", { failure: { phase: "import", message: "m" } }))];
    await open(h);
    await h.timers.advance(60_000);
    expect(h.screen.model().progress!.failure).not.toBeNull();
    expect(h.timers.pending()).toBe(0);
  });

  it("非表示にするとタイマーを消し、表示に戻したら即時に 1 回取って再開する", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing"))];
    await open(h);
    expect(h.timers.pending()).toBe(1);
    h.visible = false;
    h.screen.onVisibilityChange();
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(120_000);
    expect(h.gets()).toBe(1);
    h.visible = true;
    h.screen.onVisibilityChange();
    await h.settle();
    expect(h.gets()).toBe(2);
    expect(h.timers.pending()).toBe(1);
  });

  it("非表示の間に取得が終わっても、タイマーは張らない", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing"))];
    h.visible = false;
    await open(h);
    expect(h.screen.model().progress!.headline).toContain("取り込み中");
    expect(h.timers.pending()).toBe(0);
  });

  it("表示に戻したとき、終端の状態なら取らない", async () => {
    const h = harness();
    await open(h);
    h.visible = false;
    h.screen.onVisibilityChange();
    h.visible = true;
    h.screen.onVisibilityChange();
    await h.settle();
    expect(h.gets()).toBe(1);
  });

  it("通信の失敗が 3 回続いたら止めて、「再読込」を促す。最後に取れた進捗は残す。再読込で再開する", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing")), "throw", "throw", "throw", reply(200, status("importing"))];
    await open(h);
    await h.timers.advance(10_000);
    await h.timers.advance(10_000);
    expect(h.screen.model().pollNotice).toBeNull();
    await h.timers.advance(10_000);
    expect(h.gets()).toBe(4);
    const m = h.screen.model();
    expect(m.pollNotice).toContain("再読込");
    expect(m.progress!.headline).toContain("取り込み中");
    expect(h.timers.pending()).toBe(0);
    h.screen.onReload();
    await h.settle();
    expect(h.screen.model().pollNotice).toBeNull();
    expect(h.timers.pending()).toBe(1);
  });

  it("失敗が途中で成功すれば、失敗の数え直し(連続でなければ止めない)", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing")), "throw", "throw", reply(200, status("importing")), "throw", "throw", reply(200, status("importing"))];
    await open(h);
    for (let i = 0; i < 6; i += 1) await h.timers.advance(10_000);
    expect(h.screen.model().pollNotice).toBeNull();
    expect(h.timers.pending()).toBe(1);
  });

  it("画面を離れると止まり、タイマーが消える。離れる前に出した取得の応答は反映しない", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing"))];
    await open(h);
    h.screen.leave();
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(120_000);
    expect(h.gets()).toBe(1);
  });
});

describe("ファイルの選択と検証", () => {
  it("正しいファイルを選ぶと検証され、分析の件数・結果のレース数が出て、開始できる。この間アップロードしない", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    const m = h.screen.model();
    expect(m.check!.tone).toBe("ok");
    expect(m.check!.lines.join("\n")).toContain("分析 5 件・結果 5 レース");
    expect(m.file!.name).toBe("keiba-cloud-migration.ndjson.gz");
    expect(m.start).toEqual({ visible: true, enabled: true, label: "取り込みを始める" });
    expect(h.posts()).toBe(0);
  });

  it("選んだ直後(検証中)は checking で、選び直し・開始はできず、取り消せる", async () => {
    const h = harness();
    await open(h);
    h.screen.onFile(pickedFile(FIXTURE));
    const m = h.screen.model();
    expect(m.check!.tone).toBe("info");
    expect(m.canPick).toBe(false);
    expect(m.canCancelCheck).toBe(true);
    expect(m.start.visible).toBe(false);
    await h.settle();
  });

  it("壊れたファイルは、理由を出してアップロードさせない(開始しても POST しない)", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE.split("\n").slice(0, 6).join("\n")));
    const m = h.screen.model();
    expect(m.check!.tone).toBe("error");
    expect(m.check!.lines.join("\n")).toContain("フッタが無い");
    expect(m.start.visible).toBe(false);
    h.screen.onStart();
    await h.settle();
    expect(h.posts()).toBe(0);
  });

  it("検証の進捗の再描画は間引かれる(行ごとに描画しない)", async () => {
    const h = harness();
    await open(h);
    const before = h.changes;
    await pick(h, pickedFile(FIXTURE));
    expect(h.changes - before).toBeLessThanOrEqual(4);
  });

  it("検証中に取り消すと、ファイルの選択を捨てて元に戻る。遅れて終わる検証の結果は反映しない", async () => {
    const h = harness();
    await open(h);
    h.screen.onFile(pickedFile(FIXTURE));
    h.screen.onCancelCheck();
    await h.settle();
    const m = h.screen.model();
    expect(m.file).toBeNull();
    expect(m.check).toBeNull();
    expect(m.canPick).toBe(true);
  });

  it("検証中に別のファイルは選べない(無視する)。選択が空(ダイアログのキャンセル)は何も変えない", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE, "first.gz"));
    h.screen.onFile(null);
    expect(h.screen.model().file!.name).toBe("first.gz");
    expect(h.screen.model().check!.tone).toBe("ok");
    h.screen.onFile(pickedFile(FIXTURE, "second.gz"));
    h.screen.onFile(pickedFile(FIXTURE, "third.gz"));
    await h.settle();
    expect(h.screen.model().file!.name).toBe("second.gz");
  });

  it("選び直すと、前の検証の結果は消えて新しいファイルの結果になる", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile("{壊れた", "bad.gz"));
    expect(h.screen.model().check!.tone).toBe("error");
    await pick(h, pickedFile(FIXTURE, "good.gz"));
    expect(h.screen.model().check!.tone).toBe("ok");
    expect(h.screen.model().file!.name).toBe("good.gz");
  });

  it("画面を離れたら、検証を捨てる(戻ったとき、選択も結果も残っていない)", async () => {
    const h = harness();
    await open(h);
    h.screen.onFile(pickedFile(FIXTURE));
    h.screen.leave();
    await h.settle();
    await open(h);
    expect(h.screen.model().file).toBeNull();
    expect(h.screen.model().check).toBeNull();
  });

  it("取り込み中(サーバ)は、ファイルを選んでも無視する", async () => {
    const h = harness();
    h.statuses = [reply(200, status("importing"))];
    await open(h);
    h.screen.onFile(pickedFile(FIXTURE));
    await h.settle();
    expect(h.screen.model().file).toBeNull();
    expect(h.screen.model().pickNote).toContain("取り込み中");
  });

  it("進捗の取得前・取得失敗のときも、ファイルを選んでも無視する(状態が分からない間は始めさせない)", async () => {
    const h = harness();
    h.screen.enter();
    h.screen.onFile(pickedFile(FIXTURE));
    await h.settle();
    expect(h.screen.model().file).toBeNull();
  });
});

describe("アップロード", () => {
  it("開始すると、検証したファイルそのものを POST し、受け付けられたら進捗を取り込みに切り替えてポーリングを始める", async () => {
    const h = harness();
    await open(h);
    const file = pickedFile(FIXTURE);
    await pick(h, file);
    h.screen.onStart();
    await h.settle();
    const post = h.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/migration/upload");
    expect(post.body).toBe(file);
    const m = h.screen.model();
    expect(m.uploadNotice!.tone).toBe("ok");
    expect(m.progress!.headline).toContain("検証");
    expect(m.file).toBeNull();
    expect(m.check).toBeNull();
    expect(m.canPick).toBe(false);
    expect(h.timers.nextIn()).toBe(10_000);
  });

  it("押した直後に同期で「アップロード中」になり、押し直しても二重に送らない", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    const d = deferred<Resp>();
    h.uploadResponder = () => d.promise;
    h.screen.onStart();
    expect(h.screen.model().start).toEqual({ visible: true, enabled: false, label: "アップロード中…" });
    h.screen.onStart();
    h.screen.onStart();
    expect(h.posts()).toBe(1);
    d.resolve(reply(202, status("verifying")));
    await h.settle();
    expect(h.posts()).toBe(1);
  });

  it.each<[string, Resp, string]>([
    ["409(取り込み中)", reply(409, { ok: false, error: { type: "migration-busy", message: "SECRET" } }), "取り込み中のため"],
    ["413(大きすぎる)", reply(413, { ok: false, error: { type: "payload-too-large" } }), "50MB"],
    ["503 r2-fence", reply(503, { ok: false, error: { type: "r2-fence" } }), "R2"],
    ["503 その他", reply(503, { ok: false, error: { type: "migration-error" } }), "サーバでエラー"],
    ["500", reply(500, {}), "HTTP 500"],
  ])("失敗: %s は固定の日本語の文言で出し、サーバの文面は出さない。検証済みのファイルは残り、再試行できる", async (_name, response, text) => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    h.uploadResponder = async () => response;
    h.screen.onStart();
    await h.settle();
    const m = h.screen.model();
    expect(m.uploadNotice!.tone).toBe("error");
    expect(m.uploadNotice!.text).toContain(text);
    expect(m.uploadNotice!.text).not.toContain("SECRET");
    expect(m.file).not.toBeNull();
    expect(m.start.enabled).toBe(true);
  });

  it("通信の失敗(例外)も失敗として出す", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    h.uploadResponder = async () => {
      throw new TypeError("Failed to fetch");
    };
    h.screen.onStart();
    await h.settle();
    expect(h.screen.model().uploadNotice!.text).toContain("通信に失敗");
  });

  it("409 のあとは、サーバの今の状態を取り直す(別のタブで取り込みが始まっていた場合に、進捗が見える)", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    h.statuses = [reply(200, status("importing"))];
    h.uploadResponder = async () => reply(409, { ok: false, error: { type: "migration-busy" } });
    const before = h.gets();
    h.screen.onStart();
    await h.settle();
    expect(h.gets()).toBe(before + 1);
    expect(h.screen.model().progress!.headline).toContain("取り込み中");
    expect(h.screen.model().start.enabled).toBe(false);
  });

  it("202 の本文が想定外でも、受け付け成功として扱い、進捗を取り直す", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    h.uploadResponder = async () => reply(202, { ok: true });
    h.statuses = [reply(200, status("verifying"))];
    const before = h.gets();
    h.screen.onStart();
    await h.settle();
    expect(h.gets()).toBe(before + 1);
    expect(h.screen.model().progress!.headline).toContain("検証");
    expect(h.screen.model().uploadNotice!.tone).toBe("ok");
  });

  it("サーバが取り込み中なら、検証済みでも開始できない(POST しない)", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    h.statuses = [reply(200, status("importing"))];
    h.screen.onReload();
    await h.settle();
    expect(h.screen.model().start.enabled).toBe(false);
    h.screen.onStart();
    await h.settle();
    expect(h.posts()).toBe(0);
  });

  it("アップロード中に画面を離れても、遅れて届く応答は今の画面に反映しない", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    const d = deferred<Resp>();
    h.uploadResponder = () => d.promise;
    h.screen.onStart();
    h.screen.leave();
    h.screen.enter();
    await h.timers.flush(); // 開き直しの取得(idle)が終わる。アップロードの応答はまだ保留
    d.resolve(reply(202, status("verifying")));
    await h.settle();
    expect(h.screen.model().uploadNotice).toBeNull();
    expect(h.screen.model().progress!.headline).toContain("まだ"); // 取り直した idle のまま
  });

  it("取り込みが終わった(completed・failed)ら、「アップロードしました」の通知を消す", async () => {
    const h = harness();
    await open(h);
    await pick(h, pickedFile(FIXTURE));
    h.statuses = [reply(200, status("completed"))];
    h.screen.onStart();
    await h.settle();
    expect(h.screen.model().uploadNotice!.tone).toBe("ok");
    await h.timers.advance(10_000);
    expect(h.screen.model().progress!.headline).toContain("完了");
    expect(h.screen.model().uploadNotice).toBeNull();
  });
});

describe("結果の補完の進捗(Issue #217)。移行が完了していたときだけ GET /api/results/backfill を 1 回取り、付随の 1 行として出す", () => {
  it("completed: 進捗の取得のあとに補完の進捗を 1 回取り、model().backfill に出す。ポーリングのタイマーは張らない", async () => {
    const h = harness();
    h.statuses = [reply(200, status("completed"))];
    await open(h);
    expect(h.gets()).toBe(1);
    expect(h.backfillGets()).toBe(1);
    const view = h.screen.model().backfill;
    expect(view).not.toBeNull();
    expect(view!.text).toContain("残り 321 レース");
    expect(h.timers.pending()).toBe(0);
  });

  it("completed 以外(idle・取り込み中の 4 状態・failed)では取らない(model().backfill は null)", async () => {
    const states = ["idle", "verifying", "importing", "waiting-budget", "waiting-r2", "failed"];
    expect(states).toHaveLength(6);
    for (const state of states) {
      const h = harness();
      h.statuses = [reply(200, status(state))];
      await open(h);
      expect(h.gets(), state).toBe(1);
      expect(h.backfillGets(), state).toBe(0);
      expect(h.screen.model().backfill, state).toBeNull();
    }
  });

  it("補完の進捗の取得が失敗(通信・503・形が違う)しても、移行の進捗は ready のまま・エラーを出さない。補完の行だけ出ない", async () => {
    for (const backfill of ["throw", reply(503, { ok: false, error: { type: "backfill-error" } }), reply(200, { ok: true, state: "ready" })] as const) {
      const h = harness();
      h.statuses = [reply(200, status("completed"))];
      h.backfill = backfill;
      await open(h);
      expect(h.backfillGets()).toBe(1);
      const m = h.screen.model();
      expect(m.error).toBeNull();
      expect(m.loading).toBe(false);
      expect(m.progress!.headline).toContain("完了");
      expect(m.backfill).toBeNull();
    }
  });

  it("「再読込」で移行の進捗と一緒に取り直す(補完の進捗も 1 回増える)", async () => {
    const h = harness();
    h.statuses = [reply(200, status("completed"))];
    await open(h);
    h.backfill = reply(200, { ...BACKFILL_BODY, remaining: 200 });
    h.screen.onReload();
    await h.settle();
    expect(h.backfillGets()).toBe(2);
    expect(h.screen.model().backfill!.text).toContain("残り 200 レース");
  });

  it("補完の進捗の取得中に画面を離れたら、遅れて届いた応答は(開き直した画面にも)反映しない", async () => {
    const h = harness();
    h.statuses = [reply(200, status("completed"))];
    const late = deferred<Resp>();
    h.backfillOnce = late.promise; // 1 回目の補完の取得だけ保留する。
    h.backfill = reply(200, { ...BACKFILL_BODY, remaining: 7 });
    h.screen.enter();
    await h.timers.flush();
    h.screen.leave();
    expect(h.screen.model().backfill).toBeNull();
    late.resolve(reply(200, { ...BACKFILL_BODY, remaining: 999 }));
    await h.settle();
    expect(h.screen.model().backfill).toBeNull(); // 古い世代の応答は採らない(画面を離れている)
    h.screen.enter();
    await h.settle();
    expect(h.screen.model().backfill!.text).toContain("残り 7 レース");
  });
});
