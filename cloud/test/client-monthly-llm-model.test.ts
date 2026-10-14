import { describe, expect, it } from "vitest";
import type { MonthlyDetail, MonthlyJob } from "../client/api-monthly";
import {
  buildMonthlyModel,
  MONTHLY_CREATE_CAUTION,
  MONTHLY_CREATE_FAILED_NOTICE,
  MONTHLY_CREATE_REQUESTED_NOTICE,
  MONTHLY_CREATING_NOTICE,
  MONTHLY_NO_REPORT_NOTICE,
  MONTHLY_NO_TEXT_NOTE,
  MONTHLY_RAW_NOTE,
  MONTHLY_REGEN_CONFIRM_TEXT,
  MONTHLY_REGEN_DONE_NOTICE,
  MONTHLY_REGEN_FAILED_NOTICE,
  MONTHLY_REGEN_REQUESTED_NOTICE,
  type MonthlyDetailState,
  type MonthlyModelInput,
} from "../client/monthly-model";
import { JOB_UNAVAILABLE_NOTICE, REGEN_LIMIT_MESSAGE } from "../client/report-model";

/**
 * Issue #280(#265-B / B-2): 月報の画面の表示用データのうち、LLM の文章と、管理者の「この月の月報を作る」「月報を作り直す」(確認つき)・進行状況の出し分け。
 * 期待値の文言は、このファイルにリテラルで持つ箇所と、定数を参照する箇所がある(定数は「その状態でその文言が出ること」を確かめるため。文言自体は下の固定の確認で別に固定する)。
 */

const TODAY = "20261105"; // 今月は 2026 年 11 月。2026 年 10 月は終わった月。

function detail(over: Partial<MonthlyDetail> = {}): MonthlyDetail {
  return {
    month: "202610", createdAt: "2026-10-31T13:05:00.000Z", model: "claude-sonnet-5-5", raceCount: 3, totalStake: 300, totalReturn: 800, summary: "総括", lastDayPending: false,
    narrative: { summary: "10 月は 3 レースを分析した。", good: ["良い点 1", "良い点 2"], improve: ["改善点 1"], outlook: ["来月に見ておく数字"] },
    narrativeRaw: null, note: null, promptVersion: "monthly-2026-10-13.1",
    stats: {
      raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1,
      refundedBetCount: 0, refundedStake: 0, unjudgedBetCount: 0, unjudgedStake: 0, expectedBetCount: 2, expectedHits: 0.8, expectedBaseHits: 1, maxPayout: 800, maxPayoutStake: 200,
      byBetType: {}, byMark: [], whatIf: null, fromDate: "20261001", toDate: "20261031", dayCount: 1,
      days: [{ date: "20261003", raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1, refundedBetCount: 0 }],
      byVersion: [],
    },
    ...over,
  };
}

const ready = (report: MonthlyDetail | null, job: MonthlyJob | null = null, jobUnavailable = false): MonthlyDetailState => ({ kind: "ready", report, job, jobUnavailable });
const input = (over: Partial<MonthlyModelInput> = {}): MonthlyModelInput => ({
  today: TODAY, shownMonth: "202610", list: { kind: "ready", items: [] }, detail: ready(detail()), ...over,
});
const model = (over: Partial<MonthlyModelInput> = {}) => buildMonthlyModel(input(over));

describe("LLM の文章(総括・良かった点・改善点・来月に向けて)", () => {
  it("文章がある月報: 4 つがそのまま本文に載り、文章が無い旨の注記は出ない", () => {
    const b = model().body!;
    expect(b.summary).toBe("10 月は 3 レースを分析した。");
    expect(b.good).toEqual(["良い点 1", "良い点 2"]);
    expect(b.improve).toEqual(["改善点 1"]);
    expect(b.outlook).toEqual(["来月に見ておく数字"]);
    expect(b.raw).toBeNull();
    expect(b.textNote).toBeNull();
  });

  it("読めなかった応答(narrativeRaw だけ): 生の文章を出し、構造として読めなかった旨の固定の注記を出す。総括・各項目は空", () => {
    const b = model({ detail: ready(detail({ narrative: null, narrativeRaw: "これは生の文章" })) }).body!;
    expect(b.raw).toBe("これは生の文章");
    expect(b.textNote).toBe(MONTHLY_RAW_NOTE);
    expect(b.textNote).toBe("LLM の応答を構造として読めなかったため、生の文章を載せています。");
    expect(b.summary).toBeNull();
    expect([b.good, b.improve, b.outlook]).toEqual([[], [], []]);
  });

  it("文章が無い月報(キー未登録・LLM が失敗): 統計だけの月報である旨の固定の注記。文章の節は空", () => {
    const b = model({ detail: ready(detail({ narrative: null, narrativeRaw: null, model: null, summary: null })) }).body!;
    expect(b.textNote).toBe(MONTHLY_NO_TEXT_NOTE);
    expect(b.summary).toBeNull();
    expect(b.raw).toBeNull();
    expect([b.good, b.improve, b.outlook]).toEqual([[], [], []]);
  });

  it("文章と生の文章が両方ある(あり得ない)ときは、構造のある文章を優先し、生の文章は出さない", () => {
    const b = model({ detail: ready(detail({ narrativeRaw: "生" })) }).body!;
    expect(b.summary).not.toBeNull();
    expect(b.raw).toBeNull();
    expect(b.textNote).toBeNull();
  });

  it("メタ: 文章を書いたモデルを出す。文章が無いときは『LLM の文章なし』", () => {
    expect(model().body!.meta).toContain("モデル claude-sonnet-5-5");
    expect(model({ detail: ready(detail({ model: null, narrative: null })) }).body!.meta).toContain("LLM の文章なし");
  });
});

describe("固定の文言(リテラルで固定)", () => {
  it("作成の注意・作り直しの確認・通知文", () => {
    expect(MONTHLY_CREATE_CAUTION).toContain("押した時点の分析と結果で月報を作ります");
    expect(MONTHLY_CREATE_CAUTION).toContain("API の費用");
    expect(MONTHLY_CREATE_CAUTION).toContain("Discord には送りません");
    // 確認の文面: 費用・置き換え(元に戻せない)・回数の上限(日報とは別の枠)・Discord に送らない
    expect(MONTHLY_REGEN_CONFIRM_TEXT).toContain("API の費用がかかり");
    expect(MONTHLY_REGEN_CONFIRM_TEXT).toContain("元に戻せません");
    expect(MONTHLY_REGEN_CONFIRM_TEXT).toContain("1 日の回数に上限");
    expect(MONTHLY_REGEN_CONFIRM_TEXT).toContain("日報の作り直しとは別");
    expect(MONTHLY_REGEN_CONFIRM_TEXT).toContain("Discord には送りません");
    expect(MONTHLY_REGEN_FAILED_NOTICE).toContain("前の月報のまま");
    expect(MONTHLY_REGEN_REQUESTED_NOTICE).toContain("作り直しを依頼しました");
    expect(MONTHLY_REGEN_DONE_NOTICE).toBe("月報を作り直しました。");
  });
});

describe("「この月の月報を作る」: 管理者だけ・終わった月で月報が無い月だけ", () => {
  it("管理者・終わった月・月報なし・ジョブなし: ボタンが出る(注意つき)。作り直しのボタンは出ない", () => {
    const m = model({ detail: ready(null) });
    expect(m.create).toStrictEqual({ label: "この月の月報を作る", disabled: false, caution: MONTHLY_CREATE_CAUTION, todayCaution: null });
    expect(m.regen).toBeNull();
    expect(m.body).toBeNull();
  });

  it.each([
    ["今月(終わっていない月)", "202611"],
    ["先の月", "202612"],
  ])("%s は出ない(今月の月報は最終日の夜の自動作成でだけ作る)", (_name, shownMonth) => {
    expect(model({ shownMonth, detail: ready(null) }).create).toBeNull();
  });

  it("閲覧者(readOnly)には出ない。対照: 同じ状態で管理者には出る", () => {
    expect(model({ detail: ready(null), readOnly: true }).create).toBeNull();
    expect(model({ detail: ready(null), readOnly: false }).create).not.toBeNull();
  });

  it("月報がある月・読み込み中・取得の失敗では出ない", () => {
    expect(model().create).toBeNull();
    expect(model({ detail: { kind: "loading" } }).create).toBeNull();
    expect(model({ detail: { kind: "error", message: "x" } }).create).toBeNull();
    expect(model({ detail: null }).create).toBeNull();
  });

  it("依頼中(posting)は押せない表示『依頼中…』。依頼を受け付けたあと(requested)・作成中(job running)・作成されずに終わった(no-report)間は出さない", () => {
    expect(model({ detail: ready(null), run: { kind: "posting" } }).create).toStrictEqual({ label: "依頼中…", disabled: true, caution: MONTHLY_CREATE_CAUTION, todayCaution: null });
    expect(model({ detail: ready(null), run: { kind: "requested" } }).create).toBeNull();
    expect(model({ detail: ready(null, { phase: "generate", status: "running", attempts: 0 }) }).create).toBeNull();
    expect(model({ detail: ready(null), run: { kind: "no-report" } }).create).toBeNull();
  });

  it("作成が失敗した月・依頼が断られた月は、もう一度押せる", () => {
    const failed = model({ detail: ready(null, { phase: "read", status: "failed", attempts: 3 }) });
    expect(failed.create).not.toBeNull();
    expect(failed.notice).toStrictEqual({ tone: "error", text: MONTHLY_CREATE_FAILED_NOTICE });
    const refused = model({ detail: ready(null), run: { kind: "error", message: "月報を作れませんでした。" } });
    expect(refused.create).not.toBeNull();
    expect(refused.notice).toStrictEqual({ tone: "error", text: "月報を作れませんでした。" });
  });
});

describe("作成の進行の表示(月報が無い月)", () => {
  it("サーバの作成中(job running): 作成中の案内(待ち)。最終日の夜の自動作成の最中に開いた管理者にも出る", () => {
    for (const phase of ["read", "generate", "save", "notify"] as const) {
      expect(model({ detail: ready(null, { phase, status: "running", attempts: 0 }) }).notice, phase).toStrictEqual({ tone: "wait", text: MONTHLY_CREATING_NOTICE });
    }
  });

  it("依頼を受け付けた直後(requested): 依頼した旨の案内。進行状況を取れなかった(jobUnavailable)ときは確認を続ける旨", () => {
    expect(model({ detail: ready(null), run: { kind: "requested" } }).notice).toStrictEqual({ tone: "wait", text: MONTHLY_CREATE_REQUESTED_NOTICE });
    expect(model({ detail: ready(null, null, true), run: { kind: "requested" } }).notice).toStrictEqual({ tone: "wait", text: JOB_UNAVAILABLE_NOTICE });
  });

  it("確認を続けている途中(watching)で進行状況を取れなかったときも、確認を続ける旨(依頼はしていない)", () => {
    expect(model({ detail: ready(null, null, true), watching: true }).notice).toStrictEqual({ tone: "wait", text: JOB_UNAVAILABLE_NOTICE });
    expect(model({ detail: ready(null, null, true), watching: false }).notice?.tone).toBe("info"); // 対照: 確認中でなければ通常の案内
  });

  it("作られずに終わった(no-report): 分析したレースが無い旨", () => {
    expect(model({ detail: ready(null), run: { kind: "no-report" } }).notice).toStrictEqual({ tone: "info", text: MONTHLY_NO_REPORT_NOTICE });
  });

  it("月報が無く、何も起きていない月の案内は従来どおり(自動で作られる旨)", () => {
    expect(model({ detail: ready(null) }).notice?.tone).toBe("info");
    expect(model({ detail: ready(null) }).notice?.text).toContain("最終日の夜に自動で作られます");
  });

  it("自動更新を止めたとき(pollStopped)は、待ちの案内を止めた旨に替える。待ち以外の案内は替えない", () => {
    expect(model({ detail: ready(null, { phase: "read", status: "running", attempts: 0 }), pollStopped: true }).notice).toStrictEqual({
      tone: "wait",
      text: "作成の確認の自動更新を止めました。「更新」を押すと、もう一度確認します。",
    });
    expect(model({ detail: ready(null), run: { kind: "no-report" }, pollStopped: true }).notice?.tone).toBe("info");
  });
});

describe("「月報を作り直す」: 管理者だけ・終わった月で月報がある月だけ・確認つき", () => {
  it("管理者・終わった月・月報あり: ボタンが出る(確認はまだ開いていない)。作成のボタンは出ない", () => {
    const m = model();
    expect(m.regen).toStrictEqual({ label: "月報を作り直す", disabled: false, confirm: null });
    expect(m.create).toBeNull();
  });

  it("確認が開いているとき: ボタンの代わりに確認(文面・実行・やめる)を出す", () => {
    const m = model({ regen: { kind: "confirm" } });
    expect(m.regen).toStrictEqual({ label: "月報を作り直す", disabled: false, confirm: { text: MONTHLY_REGEN_CONFIRM_TEXT, goLabel: "作り直す", cancelLabel: "やめる" } });
  });

  it("依頼中(posting)は押せない表示。更新ボタンも無効", () => {
    const m = model({ regen: { kind: "posting" } });
    expect(m.regen).toStrictEqual({ label: "依頼中…", disabled: true, confirm: null });
    expect(m.refreshDisabled).toBe(true);
    expect(model().refreshDisabled).toBe(false);
    expect(model({ detail: ready(null), run: { kind: "posting" } }).refreshDisabled).toBe(true);
  });

  it("閲覧者(readOnly)・今月/先の月・月報が無い月では出ない", () => {
    expect(model({ readOnly: true }).regen).toBeNull();
    expect(model({ shownMonth: "202611", detail: ready(detail({ month: "202611" })) }).regen).toBeNull();
    expect(model({ detail: ready(null) }).regen).toBeNull();
    expect(model({ detail: { kind: "loading" } }).regen).toBeNull();
  });

  it("作り直し中(requested、またはサーバの regenerate のジョブが running)は、待ちの案内を出し、ボタンを出さない", () => {
    const requested = model({ regen: { kind: "requested", since: "2026-10-31T13:05:00.000Z" } });
    expect(requested.notice).toStrictEqual({ tone: "wait", text: MONTHLY_REGEN_REQUESTED_NOTICE });
    expect(requested.regen).toBeNull();
    const server = model({ detail: ready(detail(), { phase: "generate", status: "running", attempts: 0, regenerate: true }) });
    expect(server.notice).toStrictEqual({ tone: "wait", text: MONTHLY_REGEN_REQUESTED_NOTICE });
    expect(server.regen).toBeNull();
    // 作り直しではない running のジョブ(通常の作成)は、月報がある月の表示に影響しない
    expect(model({ detail: ready(detail(), { phase: "generate", status: "running", attempts: 0 }) }).notice).toBeNull();
  });

  it("依頼したが進行状況を取れない間は、確認を続ける旨", () => {
    expect(model({ detail: ready(detail(), null, true), regen: { kind: "requested", since: "x" } }).notice).toStrictEqual({ tone: "wait", text: JOB_UNAVAILABLE_NOTICE });
  });

  it("完了(done): 作り直した旨(ok)。ボタンは出る。失敗(サーバの regenerate のジョブが failed): 前の月報のまま(error)。ボタンは出る(もう一度押せる)", () => {
    const done = model({ regen: { kind: "done" } });
    expect(done.notice).toStrictEqual({ tone: "ok", text: MONTHLY_REGEN_DONE_NOTICE });
    expect(done.regen).not.toBeNull();
    const failed = model({ detail: ready(detail(), { phase: "save", status: "failed", attempts: 0, regenerate: true }) });
    expect(failed.notice).toStrictEqual({ tone: "error", text: MONTHLY_REGEN_FAILED_NOTICE });
    expect(failed.regen).not.toBeNull();
    // 依頼中(posting)は、前回の失敗の案内を出さない
    expect(model({ detail: ready(detail(), { phase: "save", status: "failed", attempts: 0, regenerate: true }), regen: { kind: "posting" } }).notice).toBeNull();
    // 作り直しではない failed のジョブは、月報がある月では無視する
    expect(model({ detail: ready(detail(), { phase: "read", status: "failed", attempts: 3 }) }).notice).toBeNull();
  });

  it("断られた(error): 固定の文言を出す。上限(429)の案内は日報と同じ文言", () => {
    expect(model({ regen: { kind: "error", message: REGEN_LIMIT_MESSAGE } }).notice).toStrictEqual({ tone: "error", text: REGEN_LIMIT_MESSAGE });
  });

  it("自動更新を止めたとき(pollStopped)は、作り直しの待ちの案内を止めた旨に替える", () => {
    const m = model({ regen: { kind: "requested", since: "x" }, pollStopped: true });
    expect(m.notice).toStrictEqual({ tone: "wait", text: "作成の確認の自動更新を止めました。「更新」を押すと、もう一度確認します。" });
  });
});
