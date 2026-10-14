import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchReport, type ReportDetail } from "../client/api-report";
import {
  buildReportModel,
  CREATE_CAUTION,
  CREATE_TODAY_CAUTION,
  JOB_UNAVAILABLE_NOTICE,
  REGEN_CONFIRM_TEXT,
  REGEN_DONE_NOTICE,
  REGEN_FAILED_NOTICE,
  REGEN_LIMIT_MESSAGE,
  REGEN_REQUESTED_NOTICE,
  type ReportModelInput,
} from "../client/report-model";
import { createReportScreen, REPORT_POLL_MS, type ReportScreen } from "../client/report-screen";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { buildSavedRecord } from "./daily-report-fixtures";
import { createFakeTimers } from "./client-fakes";
import { noopActions } from "./client-fakes";

/**
 * Issue #268: 管理者による日報の作り直し(画面)。モデル(文言・出し分け)・制御(確認の段階 → 依頼 → 確認のポーリング)・VNode。
 * 守ること:
 *  - 日報がある日の管理者にだけボタンが出る(閲覧者・日報の無い日には出ない)。押すと確認の段階が挟まり、確認を経ない限り POST は出ない
 *  - 確認文には、費用・置き換え(元に戻せない)・回数の上限・Discord に送らないことが書いてある
 *  - 依頼のあとは、作成時刻が変わるか、作り直しのジョブが失敗するまで確認する。作成時刻が変わらない間は「完了」にしない
 */

const TODAY = "20261010";
const FIRST_AT = "2026-10-10T11:00:00.000Z";
const SECOND_AT = "2026-10-10T12:30:00.000Z";

type Reply = { status: number; body: unknown } | "throw";
const LIST_ROW = (date: string) => ({ date, created_at: FIRST_AT, model: null, race_count: 2, total_stake: 100, total_return: 0, summary: null });
const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, job_status: "ok", ...body } });

async function reportJson(date: string, createdAt: string): Promise<Record<string, unknown>> {
  const record = await buildSavedRecord();
  return { date, created_at: createdAt, model: record.model, race_count: record.raceCount, total_stake: record.totalStake, total_return: record.totalReturn, summary: record.summary, body: record.body };
}

/** サーバの応答をクライアントのパーサに通した、型の付いた日報(モデル・VNode のテスト用)。 */
async function parsedReport(): Promise<ReportDetail> {
  const body = { ok: true, report: await reportJson(TODAY, FIRST_AT), job: null, job_status: "ok" };
  const result = await fetchReport(async () => ({ status: 200, json: async () => body }), TODAY);
  if (!result.ok || result.report === null) throw new Error("日報を読めませんでした");
  return result.report;
}

interface Net {
  readonly fetch: FetchLike;
  readonly calls: string[];
  /** POST の本文(JSON を戻したもの)。 */
  readonly posts: unknown[];
  script: Record<string, Reply[]>;
}

function net(): Net {
  const n: Net = {
    calls: [],
    posts: [],
    script: {},
    fetch: async (url, init) => {
      const key = `${init.method} ${url}`;
      n.calls.push(key);
      if (init.method === "POST") n.posts.push(JSON.parse(init.body as string));
      const queue = n.script[key];
      if (queue === undefined || queue.length === 0) throw new Error(`応答の指定が無い: ${key}`);
      const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (reply === "throw") throw new Error("network");
      return { status: reply.status, json: async () => reply.body };
    },
  };
  return n;
}

const POST_OK: Reply = { status: 202, body: { ok: true, accepted: true, date: TODAY } };
const RUNNING_REGEN = { phase: "generate", status: "running", attempts: 0, regenerate: true };

/** 日報がある日(TODAY)を開いた管理者(または閲覧者)の画面。`details` は本文の応答(先頭から消費。尽きたら最後を繰り返す)。 */
async function openReportDay(details: Reply[], options: { readOnly?: boolean } = {}): Promise<{ n: Net; screen: ReportScreen; timers: ReturnType<typeof createFakeTimers> }> {
  const n = net();
  const timers = createFakeTimers();
  n.script["GET /api/reports"] = [ok({ reports: [LIST_ROW(TODAY)] })];
  n.script[`GET /api/reports/${TODAY}`] = details;
  const screen = createReportScreen({ fetch: n.fetch, timers, isVisible: () => true, today: () => TODAY, onChange: () => {}, ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }) });
  screen.enter(TODAY);
  await timers.flush();
  return { n, screen, timers };
}

describe("出し分け: ボタンは日報がある日の管理者にだけ出る", () => {
  it("管理者・日報がある日: ボタンが出る(確認はまだ開いていない)。作成のボタンは出ない", async () => {
    const { screen } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    const m = screen.model();
    expect(m.body).not.toBeNull();
    expect(m.regen).toStrictEqual({ label: "日報を作り直す", disabled: false, confirm: null });
    expect(m.create).toBeNull();
  });

  it("日報が無い日: 作り直しのボタンは出ない(作成のボタンが出る)", async () => {
    const { screen } = await openReportDay([ok({ report: null, job: null })]);
    expect(screen.model().regen).toBeNull();
    expect(screen.model().create).not.toBeNull();
  });

  it("閲覧者(readOnly): ボタンは出ず、操作しても POST は出ない。対照: 同じ状態で管理者は確認の段階を経て POST を出す", async () => {
    for (const readOnly of [true, false]) {
      const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })], { readOnly });
      n.script["POST /api/reports/run"] = [POST_OK];
      expect(screen.model().regen === null, `ボタン readOnly=${readOnly}`).toBe(readOnly);
      screen.onRegenOpen();
      expect(screen.model().regen?.confirm === null || screen.model().regen === null, `確認を開けるのは管理者だけ readOnly=${readOnly}`).toBe(readOnly);
      screen.onRegenGo();
      await timers.flush();
      expect(n.calls.includes("POST /api/reports/run"), `POST readOnly=${readOnly}`).toBe(!readOnly);
    }
  });

  it("読み込み中・取得の失敗: ボタンは出ない", async () => {
    const n = net();
    const timers = createFakeTimers();
    n.script["GET /api/reports"] = [ok({ reports: [] })];
    n.script[`GET /api/reports/${TODAY}`] = [{ status: 503, body: { ok: false, error: { type: "report-error" } } }];
    const screen = createReportScreen({ fetch: n.fetch, timers, isVisible: () => true, today: () => TODAY, onChange: () => {} });
    screen.enter(TODAY);
    expect(screen.model().regen).toBeNull(); // 読み込み中
    await timers.flush();
    expect(screen.model().error).not.toBeNull();
    expect(screen.model().regen).toBeNull();
  });
});

describe("確認の段階: 確認を経ない限り POST は出ない", () => {
  it("開くと確認が出る(POST なし)。やめると閉じる(POST なし)。確認の文面に、費用・置き換え・回数の上限・Discord に送らないことが書いてある", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    screen.onRegenOpen();
    const confirm = screen.model().regen!.confirm!;
    expect(confirm.text).toBe(REGEN_CONFIRM_TEXT);
    for (const fact of ["置き換え", "元に戻せません", "費用", "上限", "Discord には送りません"]) {
      expect(confirm.text, fact).toContain(fact);
    }
    expect(confirm.goLabel).toBe("作り直す");
    expect(confirm.cancelLabel).toBe("やめる");
    screen.onRegenCancel();
    await timers.flush();
    expect(screen.model().regen).toStrictEqual({ label: "日報を作り直す", disabled: false, confirm: null });
    expect(n.calls.includes("POST /api/reports/run")).toBe(false);
  });

  it("確認を開かずに実行(onRegenGo)しても POST は出ない", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    screen.onRegenGo();
    await timers.flush();
    expect(n.calls.includes("POST /api/reports/run")).toBe(false);
  });

  it("実行すると POST 1 回(本文は { date, regenerate: true })。依頼中はボタンが無効で『依頼中…』。実行の連打で POST は増えない", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    n.script["POST /api/reports/run"] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    expect(screen.model().regen).toStrictEqual({ label: "依頼中…", disabled: true, confirm: null });
    screen.onRegenGo();
    screen.onRegenOpen();
    await timers.flush();
    expect(n.posts).toStrictEqual([{ date: TODAY, regenerate: true }]);
  });
});

describe("依頼のあとの確認", () => {
  it("作成時刻が変わるまで作り直し中の表示を続け、変わったら完了の表示にしてボタンを戻す。確認の自動更新は止まる", async () => {
    const { n, screen, timers } = await openReportDay([
      ok({ report: await reportJson(TODAY, FIRST_AT), job: null }),
      ok({ report: await reportJson(TODAY, FIRST_AT), job: RUNNING_REGEN }), // 依頼の直後の確認: 作り直し中
      ok({ report: await reportJson(TODAY, FIRST_AT), job: RUNNING_REGEN }),
      ok({ report: await reportJson(TODAY, SECOND_AT), job: null }),
    ]);
    n.script["POST /api/reports/run"] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "wait", text: REGEN_REQUESTED_NOTICE });
    expect(screen.model().regen).toBeNull(); // 作り直し中はボタンを出さない
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS); // まだ作り直し中
    expect(screen.model().notice!.text).toBe(REGEN_REQUESTED_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS); // 新しい日報
    expect(screen.model().notice).toStrictEqual({ tone: "ok", text: REGEN_DONE_NOTICE });
    expect(screen.model().body!.meta).toContain("21:30"); // 新しい作成時刻(JST)の本文に替わっている
    expect(screen.model().regen).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("作成時刻が変わらないままジョブも見えない間は『完了』にしない(確認を続ける)", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]); // 最後の応答を繰り返す: 常に前の日報・ジョブなし
    n.script["POST /api/reports/run"] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    await timers.advance(REPORT_POLL_MS * 2);
    expect(screen.model().notice!.text).toBe(REGEN_REQUESTED_NOTICE);
    expect(screen.model().notice!.text).not.toBe(REGEN_DONE_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
  });

  it("作り直しのジョブが失敗(failed)したら、前の日報のままだと伝えて確認を止め、ボタンを戻す", async () => {
    const { n, screen, timers } = await openReportDay([
      ok({ report: await reportJson(TODAY, FIRST_AT), job: null }),
      ok({ report: await reportJson(TODAY, FIRST_AT), job: { phase: "save", status: "failed", attempts: 3, regenerate: true } }),
    ]);
    n.script["POST /api/reports/run"] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "error", text: REGEN_FAILED_NOTICE });
    expect(REGEN_FAILED_NOTICE).toContain("前の日報のまま");
    expect(screen.model().regen).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("依頼のあとで進行状況を取れなかった(unavailable)ときは、固定の案内を出して確認を続ける", async () => {
    const { n, screen, timers } = await openReportDay([
      ok({ report: await reportJson(TODAY, FIRST_AT), job: null }),
      ok({ report: await reportJson(TODAY, FIRST_AT), job: null, job_status: "unavailable" }),
      ok({ report: await reportJson(TODAY, SECOND_AT), job: null }),
    ]);
    n.script["POST /api/reports/run"] = [POST_OK];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice!.text).toBe(JOB_UNAVAILABLE_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    await timers.advance(REPORT_POLL_MS);
    expect(screen.model().notice!.text).toBe(REGEN_DONE_NOTICE);
  });

  it("サーバが『作成中』(409 in-progress)と答えたら、作り直し中の表示にして確認を始める", async () => {
    const { n, screen, timers } = await openReportDay([
      ok({ report: await reportJson(TODAY, FIRST_AT), job: null }),
      ok({ report: await reportJson(TODAY, FIRST_AT), job: RUNNING_REGEN }),
    ]);
    n.script["POST /api/reports/run"] = [{ status: 409, body: { ok: false, error: { type: "in-progress" } } }];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice!.text).toBe(REGEN_REQUESTED_NOTICE);
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
  });
});

describe("断られた・失敗したとき", () => {
  it("1 日の回数の上限(429 daily-limit)は固定の案内を出し、確認は始めず、ボタンを戻す。もう一度押せる", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    n.script["POST /api/reports/run"] = [{ status: 429, body: { ok: false, error: { type: "daily-limit" } } }];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).toStrictEqual({ tone: "error", text: REGEN_LIMIT_MESSAGE });
    expect(REGEN_LIMIT_MESSAGE).toContain("上限");
    expect(timers.pending()).toBe(0);
    expect(screen.model().regen).toStrictEqual({ label: "日報を作り直す", disabled: false, confirm: null });
    screen.onRegenOpen();
    expect(screen.model().regen!.confirm).not.toBeNull();
  });

  it.each([
    ["通信の失敗", "throw" as Reply],
    ["サーバのエラー(503)", { status: 503, body: { ok: false, error: { type: "report-error" } } } as Reply],
    ["Origin の不一致(403)", { status: 403, body: { ok: false, error: { type: "origin-mismatch" } } } as Reply],
  ])("%s: 固定の文言を出し、確認は始めない。ボタンは戻る", async (_name, reply) => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    n.script["POST /api/reports/run"] = [reply];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    const m = screen.model();
    expect(m.notice!.tone).toBe("error");
    expect(m.notice!.text.length).toBeGreaterThan(5);
    expect(timers.pending()).toBe(0);
    expect(m.regen).not.toBeNull();
    expect(m.regen!.disabled).toBe(false);
  });

  it("「更新」で、失敗・完了の表示を消す", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    n.script["POST /api/reports/run"] = [{ status: 429, body: { ok: false, error: { type: "daily-limit" } } }];
    screen.onRegenOpen();
    screen.onRegenGo();
    await timers.flush();
    expect(screen.model().notice).not.toBeNull();
    screen.onRefresh();
    await timers.flush();
    expect(screen.model().notice).toBeNull();
  });
});

describe("開いたときの状態", () => {
  it("作り直し中(regenerate のジョブが running)の日を開いたら、ボタンを出さず、自動で確認する。ジョブが消えて日報が替わっていれば止まる", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: RUNNING_REGEN }), ok({ report: await reportJson(TODAY, SECOND_AT), job: null })]);
    expect(screen.model().notice).toStrictEqual({ tone: "wait", text: REGEN_REQUESTED_NOTICE });
    expect(screen.model().regen).toBeNull();
    expect(timers.nextIn()).toBe(REPORT_POLL_MS);
    const before = n.calls.length;
    await timers.advance(REPORT_POLL_MS);
    expect(n.calls.length).toBe(before + 1);
    expect(screen.model().notice).toBeNull(); // 依頼したのはこの画面ではないので、完了の表示は出さない(新しい日報が見える)
    expect(screen.model().regen).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("通常の作成のジョブ(regenerate なし。通知の最中など)は作り直し中とみなさない: 確認の自動更新を張らず、ボタンも出る", async () => {
    const { screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: { phase: "notify", status: "running", attempts: 0 } })]);
    expect(screen.model().notice).toBeNull();
    expect(screen.model().regen).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("前回の作り直しの失敗(failed の regenerate のジョブが残っている)は、開いたときに伝える。確認は張らない", async () => {
    const { screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: { phase: "save", status: "failed", attempts: 3, regenerate: true } })]);
    expect(screen.model().notice).toStrictEqual({ tone: "error", text: REGEN_FAILED_NOTICE });
    expect(screen.model().regen).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("日付を替えると、開いていた確認は捨てる", async () => {
    const { n, screen, timers } = await openReportDay([ok({ report: await reportJson(TODAY, FIRST_AT), job: null })]);
    n.script["GET /api/reports/20261009"] = [ok({ report: await reportJson("20261009", FIRST_AT), job: null })];
    screen.onRegenOpen();
    expect(screen.model().regen!.confirm).not.toBeNull();
    screen.enter("20261009");
    await timers.flush();
    expect(screen.model().regen).toStrictEqual({ label: "日報を作り直す", disabled: false, confirm: null });
  });
});

describe("モデル(buildReportModel): 作り直しの文言と、作成のボタンの注意", () => {
  const base = async (over: Partial<ReportModelInput> = {}): Promise<ReportModelInput> => ({
    today: TODAY, shownDate: TODAY, list: { kind: "ready", items: [] }, detail: { kind: "ready", report: await parsedReport(), job: null }, run: { kind: "idle" }, pollStopped: false, ...over,
  });

  it("作成のボタンの注意は『作り直せません』ではない(作り直しを導入したので、事実と合わせる)。作り直しのボタンの存在と、回数の上限を伝える", () => {
    expect(CREATE_CAUTION).not.toContain("作り直せません");
    expect(CREATE_CAUTION).toContain("作り直");
    expect(CREATE_CAUTION).toContain("上限");
    expect(CREATE_TODAY_CAUTION).not.toContain("確定");
  });

  it("確認を開いている間は、ボタンの代わりに確認(文面・実行・やめる)を返す", async () => {
    const m = buildReportModel(await base({ regen: { kind: "confirm" } }));
    expect(m.regen!.confirm).toStrictEqual({ text: REGEN_CONFIRM_TEXT, goLabel: "作り直す", cancelLabel: "やめる" });
    expect(m.regen!.disabled).toBe(false);
  });

  it("作り直し中(依頼済み)は、日報の本文を出したまま待ちの案内を出す。作成の注意・ボタンは出さない", async () => {
    const m = buildReportModel(await base({ regen: { kind: "requested", since: FIRST_AT } }));
    expect(m.notice).toStrictEqual({ tone: "wait", text: REGEN_REQUESTED_NOTICE });
    expect(m.body).not.toBeNull();
    expect(m.create).toBeNull();
    expect(m.regen).toBeNull();
  });

  it("確認の自動更新を止めた(pollStopped)ときは、既存の止めた案内に替わる", async () => {
    const m = buildReportModel(await base({ regen: { kind: "requested", since: FIRST_AT }, pollStopped: true }));
    expect(m.notice!.tone).toBe("wait");
    expect(m.notice!.text).not.toBe(REGEN_REQUESTED_NOTICE);
    expect(m.notice!.text).toContain("自動更新を止めました");
  });

  it("日報が無い日の失敗した通常のジョブは、作り直しの失敗の文言にならない(従来どおり)", async () => {
    const m = buildReportModel(await base({ detail: { kind: "ready", report: null, job: { phase: "save", status: "failed", attempts: 3 } } }));
    expect(m.notice!.text).not.toBe(REGEN_FAILED_NOTICE);
    expect(m.regen).toBeNull();
  });
});

describe("VNode(view.ts): ボタンと確認の描画", () => {
  function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
    if (typeof node === "string") return [];
    return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
  }
  const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));
  const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
  const render = async (regen: ReportModelInput["regen"], actions = noopActions): Promise<VNode> =>
    renderScreen(buildReportModel({ today: TODAY, shownDate: TODAY, list: { kind: "ready", items: [] }, detail: { kind: "ready", report: await parsedReport(), job: null }, run: { kind: "idle" }, pollStopped: false, ...(regen === undefined ? {} : { regen }) }), actions);

  it("通常: 『日報を作り直す』ボタンが 1 つだけ出る。確認は出ない。押すと onReportRegenOpen", async () => {
    const calls: string[] = [];
    const tree = await render({ kind: "idle" }, { ...noopActions, onReportRegenOpen: () => void calls.push("open"), onReportRegenGo: () => void calls.push("go"), onReportRegenCancel: () => void calls.push("cancel") });
    const buttons = byClass(tree, "report-regen");
    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0]!)).toBe("日報を作り直す");
    expect(byClass(tree, "report-regen-go")).toHaveLength(0);
    buttons[0]!.on!.click!();
    expect(calls).toEqual(["open"]);
  });

  it("確認を開いているとき: 文面と『作り直す』『やめる』が出て、開くボタンは出ない。それぞれ onReportRegenGo・onReportRegenCancel", async () => {
    const calls: string[] = [];
    const tree = await render({ kind: "confirm" }, { ...noopActions, onReportRegenOpen: () => void calls.push("open"), onReportRegenGo: () => void calls.push("go"), onReportRegenCancel: () => void calls.push("cancel") });
    expect(byClass(tree, "report-regen")).toHaveLength(0);
    expect(textOf(byClass(tree, "report-regen-confirm")[0]!)).toContain(REGEN_CONFIRM_TEXT);
    const go = byClass(tree, "report-regen-go")[0]!;
    const cancel = byClass(tree, "report-regen-cancel")[0]!;
    expect(textOf(go)).toBe("作り直す");
    expect(textOf(cancel)).toBe("やめる");
    go.on!.click!();
    cancel.on!.click!();
    expect(calls).toEqual(["go", "cancel"]);
  });

  it("依頼中: ボタンは『依頼中…』で無効", async () => {
    const tree = await render({ kind: "posting" });
    const button = byClass(tree, "report-regen")[0]!;
    expect(textOf(button)).toBe("依頼中…");
    expect(button.attrs?.["disabled"]).toBe(true);
  });

  it("作り直し中・閲覧者(regen なし): ボタンも確認も出ない", async () => {
    const tree = await render({ kind: "requested", since: FIRST_AT });
    expect(byClass(tree, "report-regen")).toHaveLength(0);
    expect(byClass(tree, "report-regen-confirm")).toHaveLength(0);
    const viewer = renderScreen(
      buildReportModel({ today: TODAY, shownDate: TODAY, list: { kind: "ready", items: [] }, detail: { kind: "ready", report: await parsedReport(), job: null }, run: { kind: "idle" }, pollStopped: false, readOnly: true }),
      noopActions,
    );
    expect(byClass(viewer, "report-regen")).toHaveLength(0);
    expect(byClass(viewer, "report-regen-confirm")).toHaveLength(0);
  });
});
