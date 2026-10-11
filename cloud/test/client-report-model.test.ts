import { describe, expect, it } from "vitest";
import type { ReportDetail, ReportListItem } from "../client/api-report";
import { buildReportModel, CREATE_CAUTION, CREATE_TODAY_CAUTION, dateLabel, JOB_UNAVAILABLE_NOTICE, MAX_CHIPS, NO_REPORT_NOTICE, type ReportModelInput } from "../client/report-model";

/** Issue #235: 日報画面の表示用データ。文言は固定(LLM の文章以外にサーバの文は出さない)・数値の整形・状態ごとの出し分け。 */

const item = (date: string): ReportListItem => ({ date, createdAt: "2026-10-10T11:00:00.000Z", model: "claude-sonnet-5-5", raceCount: 3, totalStake: 1000, totalReturn: 1300, summary: "総括" });

function report(over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    date: "20261010", createdAt: "2026-10-10T11:12:00.000Z", model: "claude-sonnet-5-5", raceCount: 2, totalStake: 1000, totalReturn: 1300, summary: "総括",
    stats: {
      raceCount: 2, resultRaceCount: 1, noResultRaceCount: 1, betRaceCount: 2, llmUsedRaceCount: 2, totalStake: 1000, totalReturn: 1300, recoveryRate: 1.3, judgedBetCount: 4, hitBetCount: 1, unjudgedBetCount: 1, unjudgedStake: 300,
      byBetType: { win: { betCount: 2, hitCount: 1, stake: 600, payout: 1300 }, wide: { betCount: 2, hitCount: 0, stake: 400, payout: 0 }, future: { betCount: 1, hitCount: 0, stake: 100, payout: 0 } },
      byMark: [{ mark: "◎", count: 2, win: 1, top3: 1 }],
    },
    races: [
      { raceId: "202605030801", analysisId: 1, title: "東京1R 3歳未勝利(11:00 芝1600m良)", llmUsed: true, hasResult: true, top3: [{ umaban: 1, name: "アルファ", finishPosition: 1 }, { umaban: 3, name: null, finishPosition: 2 }], marks: [{ mark: "◎", umaban: 1, name: "アルファ", finishPosition: 1 }, { mark: "〇", umaban: 2, name: null, finishPosition: null }], totalStake: 700, totalReturn: 1300, judgedBetCount: 3, hitCount: 1, unjudgedBetCount: 0, allocationNote: null, comment: "◎が快勝" },
      { raceId: "202605030802", analysisId: 2, title: "東京2R", llmUsed: false, hasResult: false, top3: [], marks: [], totalStake: 0, totalReturn: 0, judgedBetCount: 0, hitCount: 0, unjudgedBetCount: 1, allocationNote: null, comment: null },
    ],
    narrative: { summary: "総括の文章", good: ["良い点1"], improve: ["改善点1", "改善点2"] },
    narrativeRaw: null,
    note: null,
    ...over,
  };
}

const input = (over: Partial<ReportModelInput> = {}): ReportModelInput => ({
  today: "20261010", shownDate: "20261010", list: { kind: "ready", items: [item("20261010"), item("20261009")] }, detail: { kind: "ready", report: report(), job: null }, run: { kind: "idle" }, pollStopped: false, ...over,
});

describe("dateLabel", () => {
  it("曜日つきの日本語表記にする。形が違えばそのまま", () => {
    expect(dateLabel("20261010")).toBe("2026年10月10日(土)");
    expect(dateLabel("20261011")).toBe("2026年10月11日(日)");
    expect(dateLabel("abc")).toBe("abc");
  });
});

describe("日報がある日", () => {
  it("見出し・メタ・タイル(賭け金・払戻・回収率・的中)を出す。作成のボタンは出さない", () => {
    const m = buildReportModel(input());
    expect(m.kind).toBe("report");
    expect(m.body!.heading).toBe("2026年10月10日(土)の日報");
    expect(m.body!.meta).toContain("作成 2026-10-10 20:12");
    expect(m.body!.meta).toContain("モデル claude-sonnet-5-5");
    expect(m.body!.meta).toContain("結果なし 1 レース");
    expect(m.body!.meta).toContain("判定不能の買い目 1 点(賭け金 300円");
    expect(m.body!.tiles.map((t) => [t.label, t.value])).toEqual([["賭け金", "1,000円"], ["払戻", "1,300円"], ["回収率", "130.0%"], ["的中", "4 点中 1 点"]]);
    expect(m.body!.tiles.find((t) => t.strong)!.label).toBe("回収率");
    expect(m.create).toBeNull();
    expect(m.notice).toBeNull();
  });

  it("LLM の文章: 総括・良かった点・改善点をそのまま。説明文は出さない", () => {
    const b = buildReportModel(input()).body!;
    expect(b.summary).toBe("総括の文章");
    expect(b.good).toEqual(["良い点1"]);
    expect(b.improve).toEqual(["改善点1", "改善点2"]);
    expect(b.textNote).toBeNull();
    expect(b.raw).toBeNull();
  });

  it("文章が無い日報は固定の説明を出す(サーバの note は読まない)。生の文章の日報は生の文章と固定の説明", () => {
    const none = buildReportModel(input({ detail: { kind: "ready", report: report({ narrative: null, note: "SERVER-NOTE", model: null }), job: null } })).body!;
    expect(none.textNote).toContain("LLM の文章はありません");
    expect(JSON.stringify(none)).not.toContain("SERVER-NOTE");
    expect(none.summary).toBeNull();
    const raw = buildReportModel(input({ detail: { kind: "ready", report: report({ narrative: null, narrativeRaw: "生の文章です" }), job: null } })).body!;
    expect(raw.raw).toBe("生の文章です");
    expect(raw.textNote).toContain("構造として読めなかった");
  });

  it("券種別: 既知の券種は決まった順(単勝・複勝・ワイド…)、未知の券種はキーのまま末尾に出す。賭けの無い券種は出さない", () => {
    const rows = buildReportModel(input()).body!.typeRows;
    expect(rows.map((r) => r.label)).toEqual(["単勝", "ワイド", "future"]);
    expect(rows[0]!.value).toBe("2 点中 1 点的中・賭け金 600円・払戻 1,300円");
  });

  it("印別: 印・頭数・1着・3着内", () => {
    expect(buildReportModel(input()).body!.markRows).toEqual([{ label: "◎", value: "2 頭 / 1 / 1" }]);
  });

  it("Issue #246 M3: 印別は 1着 と 3着内 を取り違えない(1 着が 0 で 3 着内が 2 の印、1 着が 1 で 3 着内が 3 の印)", () => {
    const r = report();
    const byMark = [{ mark: "◎", count: 3, win: 1, top3: 3 }, { mark: "〇", count: 2, win: 0, top3: 2 }];
    const rows = buildReportModel(input({ detail: { kind: "ready", report: report({ stats: { ...r.stats, byMark } }), job: null } })).body!.markRows;
    expect(rows).toEqual([{ label: "◎", value: "3 頭 / 1 / 3" }, { label: "〇", value: "2 頭 / 0 / 2" }]);
    expect(buildReportModel(input()).body!.markHeading).toBe("印別の成績(結果のあるレース。頭数 / 1着 / 3着内)");
  });

  it("レースごと: 着順(馬名なしは番だけ)・印の馬と着順(着順不明は着順を省く)・買い目の成績・一言。結果なしは固定の文、判定不能だけの買い目はその旨", () => {
    const [r1, r2] = buildReportModel(input()).body!.races;
    expect(r1!.result).toBe("1着 1番 アルファ / 2着 3番");
    expect(r1!.marks).toBe("◎ 1番 アルファ → 1着 / 〇 2番");
    expect(r1!.bets).toBe("買い目: 3 点中 1 点的中・賭け金 700円・払戻 1,300円");
    expect(r1!.comment).toBe("◎が快勝");
    expect(r2!.result).toContain("結果なし");
    expect(r2!.marks).toBeNull();
    expect(r2!.bets).toBe("買い目: 判定不能 1 点");
    expect(r2!.comment).toBeNull();
  });

  it("買い目の無いレースは allocationNote か『買い目なし』", () => {
    const base = report().races[1]!;
    const noBet = { ...base, unjudgedBetCount: 0 };
    const races = (note: string | null) => buildReportModel(input({ detail: { kind: "ready", report: report({ races: [{ ...noBet, allocationNote: note }] }), job: null } })).body!.races;
    expect(races(null)[0]!.bets).toBe("買い目なし");
    expect(races("買い目なし(見送り: no-ev)")[0]!.bets).toBe("買い目なし(見送り: no-ev)");
  });

  it("Issue #245: 回収率のタイルは、丸めると 100.0% になる 1 以外の値を 100.0% と出さない(99.99% / 100.01%)。ちょうど 1 は 100.0%", () => {
    const r = report();
    const tile = (recoveryRate: number): string => buildReportModel(input({ detail: { kind: "ready", report: report({ stats: { ...r.stats, recoveryRate } }), job: null } })).body!.tiles.find((t) => t.label === "回収率")!.value;
    // 前提: 従来の表示(小数第 1 位)では、これらはすべて「100.0%」だった
    for (const rate of [0.9999, 1, 1.00001]) expect(`${(rate * 100).toFixed(1)}%`).toBe("100.0%");
    expect([tile(0.9999), tile(1), tile(1.00001), tile(1.3)]).toEqual(["99.99%", "100.0%", "100.01%", "130.0%"]);
  });

  it("賭け金が 0 の日の回収率は『-』(NaN を出さない)", () => {
    const r = report();
    const m = buildReportModel(input({ detail: { kind: "ready", report: report({ stats: { ...r.stats, totalStake: 0, totalReturn: 0, recoveryRate: null } }), job: null } }));
    expect(m.body!.tiles.find((t) => t.label === "回収率")!.value).toBe("-");
  });
});

describe("日報が無い日", () => {
  it("job が無ければ『まだありません』の案内と作成のボタン", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: null } }));
    expect(m.body).toBeNull();
    expect(m.notice!.tone).toBe("info");
    expect(m.notice!.text).toContain("まだありません");
    expect(m.create).toMatchObject({ label: "この日の日報を作る", disabled: false });
  });

  it("案内は事実に合う: 分析したレースが無い日は作られない旨を書き、『分析と結果が揃うと自動で作られる』と無条件には言わない(R1)", () => {
    const text = buildReportModel(input({ detail: { kind: "ready", report: null, job: null } })).notice!.text;
    expect(text).toContain("分析したレースが無い日は作られません");
    expect(text).toContain("分析したレースがあれば");
    expect(text).not.toContain("その日の分析と結果が揃うと自動で作られます");
  });

  it("R3: ボタンには確定の注意(押した時点で作り、作り直せない)が常に付く。今日の日付のときだけ強めの注意も付く", () => {
    const other = buildReportModel(input({ shownDate: "20261009", detail: { kind: "ready", report: null, job: null } })).create!;
    expect(other.caution).toBe(CREATE_CAUTION);
    expect(other.caution).toContain("作り直せません");
    expect(other.todayCaution).toBeNull();
    const today = buildReportModel(input({ shownDate: "20261010", detail: { kind: "ready", report: null, job: null } })).create!;
    expect(today.caution).toBe(CREATE_CAUTION);
    expect(today.todayCaution).toBe(CREATE_TODAY_CAUTION);
    expect(today.todayCaution).toContain("含まないまま確定");
    // 失敗(job が failed)・依頼中・依頼の失敗のときも、ボタンが出るなら注意は付く
    expect(buildReportModel(input({ detail: { kind: "ready", report: null, job: { phase: "save", status: "failed", attempts: 3 } } })).create!.caution).toBe(CREATE_CAUTION);
    expect(buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, run: { kind: "posting" } })).create!.caution).toBe(CREATE_CAUTION);
  });

  it("Issue #246 K11: 確定の注意と、今日の強い注意の文言をリテラルで固定する(定数どうしの比較では、文面を弱めても通ってしまう)", () => {
    expect(CREATE_CAUTION).toBe("押した時点の分析と結果で日報を作り、その日は作り直せません。");
    expect(CREATE_TODAY_CAUTION).toBe(
      "今日の日報は、まだ分析していないレース(夜の地方など)や、結果の取り込みが終わっていないレースがあるうちに押すと、それらを含まないまま確定します。通常は、その日の分析と結果が揃うと自動で作られるので、急がなければ待ってください。",
    );
    // 画面のモデルが、その文言をそのまま出す(今日だけ強い注意。ほかの日は null)
    const today = buildReportModel(input({ shownDate: "20261010", detail: { kind: "ready", report: null, job: null } })).create!;
    expect(today.caution).toBe("押した時点の分析と結果で日報を作り、その日は作り直せません。");
    expect(today.todayCaution).toContain("まだ分析していないレース");
    expect(today.todayCaution).toContain("結果の取り込みが終わっていないレース");
    expect(today.todayCaution).toContain("含まないまま確定します");
    expect(today.todayCaution).toContain("急がなければ待ってください");
    expect(buildReportModel(input({ shownDate: "20261009", detail: { kind: "ready", report: null, job: null } })).create!.todayCaution).toBeNull();
  });

  it("R1: 依頼したが作られずに終わった(no-report)なら、固定の案内を出し、ボタンも『作成中』も出さない", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, run: { kind: "no-report" } }));
    expect(m.notice).toStrictEqual({ tone: "info", text: NO_REPORT_NOTICE });
    expect(NO_REPORT_NOTICE).toContain("分析したレースが無いため");
    expect(m.create).toBeNull();
    expect(m.notice!.text).not.toContain("作成中");
  });

  it("作成中(job が running)は『作成中』の案内で、ボタンは出さない", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: { phase: "gather", status: "running", attempts: 0 } } }));
    expect(m.notice!.tone).toBe("wait");
    expect(m.notice!.text).toContain("作成中");
    expect(m.create).toBeNull();
  });

  it("依頼を受け付けた直後(job はまだ無い)も『作成を依頼しました』で、ボタンは出さない", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, run: { kind: "requested" } }));
    expect(m.notice!.text).toContain("依頼しました");
    expect(m.create).toBeNull();
  });

  it("Issue #245: 依頼のあとに進行状況が取れなかった(jobUnavailable)なら、固定の『確認できませんでした。確認を続けます』を出す。作成中の表示は変えず、ボタンは出さない", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: null, jobUnavailable: true }, run: { kind: "requested" } }));
    expect(m.notice).toEqual({ tone: "wait", text: JOB_UNAVAILABLE_NOTICE });
    expect(JOB_UNAVAILABLE_NOTICE).toContain("確認を続けます");
    expect(m.create).toBeNull();
    // 対照: 取れていれば(jobUnavailable でない)従来の『作成を依頼しました』
    const ok = buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, run: { kind: "requested" } }));
    expect(ok.notice!.text).toContain("作成を依頼しました");
    expect(ok.notice!.text).not.toBe(JOB_UNAVAILABLE_NOTICE);
    // 依頼していないとき(最初に開いたとき)は、取れなくても従来の案内とボタン
    const idle = buildReportModel(input({ detail: { kind: "ready", report: null, job: null, jobUnavailable: true } }));
    expect(idle.notice!.text).toContain("まだありません");
    expect(idle.create).not.toBeNull();
    // 作成中の自動更新を止めたあとは、止めた旨の案内が優先される
    expect(buildReportModel(input({ detail: { kind: "ready", report: null, job: null, jobUnavailable: true }, run: { kind: "requested" }, pollStopped: true })).notice!.text).toContain("自動更新を止めました");
  });

  it("作成に失敗(job が failed)は失敗の案内と、もう一度作るボタン", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: { phase: "save", status: "failed", attempts: 3 } } }));
    expect(m.notice).toStrictEqual({ tone: "error", text: "日報の作成に失敗しました。もう一度作成を依頼できます。" });
    expect(m.create!.disabled).toBe(false);
  });

  it("依頼中(posting)はボタンを押せない・『依頼中…』。依頼の失敗はその固定の文言を出し、ボタンは残る", () => {
    const posting = buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, run: { kind: "posting" } }));
    expect(posting.create).toMatchObject({ label: "依頼中…", disabled: true });
    expect(posting.refreshDisabled).toBe(true);
    const failed = buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, run: { kind: "error", message: "失敗の文言" } }));
    expect(failed.notice).toStrictEqual({ tone: "error", text: "失敗の文言" });
    expect(failed.create).not.toBeNull();
  });

  it("自動更新を止めたあとの『作成中』は、更新ボタンで確認できる旨に変える", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: { phase: "gather", status: "running", attempts: 0 } }, pollStopped: true }));
    expect(m.notice!.text).toContain("自動更新を止めました");
  });
});

describe("読み込み・エラー・日付の並び", () => {
  it("一覧か本文が読み込み中なら loading で、更新は押せない", () => {
    expect(buildReportModel(input({ list: { kind: "loading" } })).loading).toBe(true);
    expect(buildReportModel(input({ detail: { kind: "loading" } })).refreshDisabled).toBe(true);
    expect(buildReportModel(input({ detail: null })).loading).toBe(true);
    expect(buildReportModel(input()).loading).toBe(false);
  });

  it("一覧・本文の失敗は固定の文言をそのまま error に出す", () => {
    expect(buildReportModel(input({ list: { kind: "error", message: "一覧の失敗" } })).error).toBe("一覧の失敗");
    expect(buildReportModel(input({ detail: { kind: "error", message: "本文の失敗" } })).error).toBe("本文の失敗");
    expect(buildReportModel(input()).error).toBeNull();
  });

  it("日付の並び: 今日が先頭、続けて日報のある日の新しい順。表示中の日が current。href は #report=日付", () => {
    const chips = buildReportModel(input({ list: { kind: "ready", items: [item("20261009"), item("20261008")] }, shownDate: "20261009" })).dateChips;
    expect(chips.map((c) => [c.label, c.href, c.current])).toEqual([
      ["今日 10/10", "#report=20261010", false],
      ["10/09", "#report=20261009", true],
      ["10/08", "#report=20261008", false],
    ]);
  });

  it("日報が無い日を表示しているとき(並びに無い日)も、並びに足して current にする。今日が一覧にあっても重複しない", () => {
    const chips = buildReportModel(input({ list: { kind: "ready", items: [item("20261010")] }, shownDate: "20200101" })).dateChips;
    expect(chips.map((c) => c.href)).toEqual(["#report=20261010", "#report=20200101"]);
    expect(chips.filter((c) => c.current).map((c) => c.href)).toEqual(["#report=20200101"]);
  });

  it(`日付の並びは最大 ${MAX_CHIPS} 個(表示中の日は別に足す)`, () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`2026${String(Math.floor(i / 28) + 8).padStart(2, "0")}${String((i % 28) + 1).padStart(2, "0")}`));
    // 前提(Issue #255。空振り防止): 日付は今日と重ならない 40 個で、並びの上限より多い。
    expect(items).toHaveLength(40);
    expect(items.some((i) => i.date === "20261010")).toBe(false);
    expect(items.length).toBeGreaterThan(MAX_CHIPS);
    // 表示中の日が並びに入っている(今日)ときは、ちょうど MAX_CHIPS 個(上界だけの検査だと 0 個や MAX_CHIPS + 1 個でも通る)。
    const inside = buildReportModel(input({ list: { kind: "ready", items }, shownDate: "20261010" })).dateChips;
    expect(inside).toHaveLength(MAX_CHIPS);
    // 表示中の日が切り捨てられる日(並びの外)のときは、別に 1 つ足して MAX_CHIPS + 1 個。足した日が current。
    const outside = buildReportModel(input({ list: { kind: "ready", items }, shownDate: "20200101" })).dateChips;
    expect(outside).toHaveLength(MAX_CHIPS + 1);
    expect(outside.filter((c) => c.current).map((c) => c.href)).toEqual(["#report=20200101"]);
  });
});

describe("Issue #238: 閲覧者(readOnly)の日報画面: 作成のボタンと、ボタンに言及する案内を出さない", () => {
  const empty = { detail: { kind: "ready", report: null, job: null } } as const;

  it("日報の無い日: 管理者には作成のボタン(create)と『下のボタン』の案内、閲覧者には create が無く、案内からボタンの文が消える", () => {
    const admin = buildReportModel(input(empty));
    expect(admin.create).not.toBeNull();
    expect(admin.notice!.text).toContain("下のボタンで依頼できます");
    const viewer = buildReportModel(input({ ...empty, readOnly: true }));
    expect(viewer.create).toBeNull();
    expect(viewer.notice!.tone).toBe("info");
    expect(viewer.notice!.text).toContain("まだありません");
    expect(viewer.notice!.text).toContain("自動で作られます");
    expect(viewer.notice!.text).not.toContain("ボタン");
    expect(viewer.notice!.text).not.toContain("依頼");
  });

  it("作成に失敗した日: 管理者には『もう一度作成を依頼できます』、閲覧者には依頼に触れない固定文言。create は無い", () => {
    const failed = { detail: { kind: "ready", report: null, job: { phase: "gather", status: "failed", attempts: 3 } } } as const;
    const admin = buildReportModel(input(failed));
    expect(admin.notice).toStrictEqual({ tone: "error", text: "日報の作成に失敗しました。もう一度作成を依頼できます。" });
    expect(admin.create).not.toBeNull();
    const viewer = buildReportModel(input({ ...failed, readOnly: true }));
    expect(viewer.notice).toStrictEqual({ tone: "error", text: "日報の作成に失敗しました。" });
    expect(viewer.create).toBeNull();
  });

  it("日報がある日・作成中の日は、閲覧者も管理者と同じ表示(本文・『作成中です』)", () => {
    const withReport = buildReportModel(input({ readOnly: true }));
    expect(withReport.body).toEqual(buildReportModel(input()).body);
    expect(withReport.create).toBeNull();
    const running = { detail: { kind: "ready", report: null, job: { phase: "gather", status: "running", attempts: 0 } } } as const;
    expect(buildReportModel(input({ ...running, readOnly: true })).notice).toEqual(buildReportModel(input(running)).notice);
  });
});

describe("Issue #246 項目 6: watching(running を見て確認を続けている途中)", () => {
  it("watching で進行状況が取れなかった(jobUnavailable)なら、依頼していなくても固定の『確認できませんでした』を出し、ボタンは出さない", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: null, jobUnavailable: true }, watching: true }));
    expect(m.notice).toEqual({ tone: "wait", text: JOB_UNAVAILABLE_NOTICE });
    expect(m.create).toBeNull();
  });

  it("対照: watching でなければ従来どおり(『まだありません』とボタン)。watching でも取れていれば(jobUnavailable でない)この案内は出さない", () => {
    const idle = buildReportModel(input({ detail: { kind: "ready", report: null, job: null, jobUnavailable: true }, watching: false }));
    expect(idle.notice!.text).toContain("まだありません");
    expect(idle.create).not.toBeNull();
    const ok = buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, watching: true }));
    // 取れている(jobUnavailable でない)なら、watching でも『まだありません』の通常の案内(文言を固定する。『依頼しました』など別の案内に化けない)とボタン
    expect(ok.notice).toEqual({
      tone: "info",
      text: "この日の日報はまだありません。その日に分析したレースがあれば、分析と結果が揃ったあとに自動で作られます(分析したレースが無い日は作られません)。すぐに作るときは、下のボタンで依頼できます。",
    });
    expect(ok.create).toMatchObject({ label: "この日の日報を作る", disabled: false });
  });

  it("watching で止めたあとは、止めた旨の案内が優先される", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: null, jobUnavailable: true }, watching: true, pollStopped: true }));
    expect(m.notice!.text).toContain("自動更新を止めました");
  });
});
