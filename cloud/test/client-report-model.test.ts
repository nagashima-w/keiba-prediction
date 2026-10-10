import { describe, expect, it } from "vitest";
import type { ReportDetail, ReportListItem } from "../client/api-report";
import { buildReportModel, dateLabel, MAX_CHIPS, type ReportModelInput } from "../client/report-model";

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
    expect(m.create).toStrictEqual({ label: "この日の日報を作る", disabled: false });
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

  it("作成に失敗(job が failed)は失敗の案内と、もう一度作るボタン", () => {
    const m = buildReportModel(input({ detail: { kind: "ready", report: null, job: { phase: "save", status: "failed", attempts: 3 } } }));
    expect(m.notice).toStrictEqual({ tone: "error", text: "日報の作成に失敗しました。もう一度作成を依頼できます。" });
    expect(m.create!.disabled).toBe(false);
  });

  it("依頼中(posting)はボタンを押せない・『依頼中…』。依頼の失敗はその固定の文言を出し、ボタンは残る", () => {
    const posting = buildReportModel(input({ detail: { kind: "ready", report: null, job: null }, run: { kind: "posting" } }));
    expect(posting.create).toStrictEqual({ label: "依頼中…", disabled: true });
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
    const chips = buildReportModel(input({ list: { kind: "ready", items }, shownDate: "20261010" })).dateChips;
    expect(chips.length).toBeLessThanOrEqual(MAX_CHIPS + 1);
  });
});
