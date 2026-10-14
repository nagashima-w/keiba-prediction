import { describe, expect, it } from "vitest";
import type { MonthlyDetail, MonthlyListItem } from "../client/api-monthly";
import {
  buildMonthlyModel,
  MONTHLY_DISCREPANCY_NOTE,
  MONTHLY_LAST_DAY_PENDING_NOTE,
  MONTHLY_NO_TEXT_NOTE,
  MONTHLY_VERSION_NOTE,
  monthLabel,
  type MonthlyDetailState,
  type MonthlyListState,
} from "../client/monthly-model";

/**
 * Issue #279(#265-A): 月報の画面の表示用データ(純関数)。文言・数値の整形だけ(DOM・fetch・時計に触れない)。
 * 数値の整形は日報・検証画面と同じ関数を通す。サーバ由来の「文」は無い(段階 A は LLM の文章を持たない)ので、文言はすべてクライアントの固定の文言。
 */

const TODAY = "20261105";

const item = (month: string): MonthlyListItem => ({ month, createdAt: "2026-10-31T13:00:00.000Z", model: null, raceCount: 3, totalStake: 300, totalReturn: 800, summary: null });
const list = (...months: string[]): MonthlyListState => ({ kind: "ready", items: months.map(item) });

function detail(over: Partial<MonthlyDetail> = {}, statsOver: Partial<MonthlyDetail["stats"]> = {}): MonthlyDetail {
  return {
    month: "202610",
    createdAt: "2026-10-31T13:05:00.000Z",
    model: null,
    raceCount: 3,
    totalStake: 300,
    totalReturn: 800,
    summary: null,
    lastDayPending: false,
    narrative: null,
    narrativeRaw: null,
    note: null,
    promptVersion: null,
    stats: {
      raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1,
      refundedBetCount: 0, refundedStake: 0, unjudgedBetCount: 0, unjudgedStake: 0, expectedBetCount: 2, expectedHits: 0.8, expectedBaseHits: 1, maxPayout: 800, maxPayoutStake: 200,
      byBetType: { win: { betCount: 2, hitCount: 1, stake: 300, payout: 800, refundCount: 0, expectedBetCount: 2, expectedHits: 0.8, expectedBaseHits: 1 } },
      byMark: [{ mark: "◎", count: 3, win: 1, top3: 2 }],
      whatIf: null,
      fromDate: "20261001", toDate: "20261031", dayCount: 2,
      days: [
        { date: "20261003", raceCount: 2, resultRaceCount: 2, noResultRaceCount: 0, totalStake: 200, totalReturn: 800, recoveryRate: 4, judgedBetCount: 1, hitBetCount: 1, refundedBetCount: 0 },
        { date: "20261031", raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, totalStake: 100, totalReturn: 0, recoveryRate: 0, judgedBetCount: 1, hitBetCount: 0, refundedBetCount: 0 },
      ],
      byVersion: [{ promptVersion: "v1", raceCount: 3, resultRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1 }],
      ...statsOver,
    },
    ...over,
  };
}

const ready = (report: MonthlyDetail | null): MonthlyDetailState => ({ kind: "ready", report });
const input = (over: { shownMonth?: string; list?: MonthlyListState; detail?: MonthlyDetailState | null } = {}) => ({
  today: TODAY,
  shownMonth: over.shownMonth ?? "202610",
  list: over.list ?? list("202610", "202609"),
  detail: over.detail === undefined ? ready(detail()) : over.detail,
});

describe("monthLabel", () => {
  it("YYYYMM → 2026年10月。形が違えばそのまま", () => {
    expect(monthLabel("202610")).toBe("2026年10月");
    expect(monthLabel("202601")).toBe("2026年1月");
    expect(monthLabel("abc")).toBe("abc");
  });
});

describe("buildMonthlyModel: 枠(見出し・タブ・月の移動)", () => {
  it("日報の画面の中の『月』: 見出し・戻るリンク・タブ(日は #report、月は表示中の月)・表示中の月の見出し", () => {
    const m = buildMonthlyModel(input());
    expect(m.kind).toBe("monthly");
    expect(m.heading).toBe("月報");
    expect(m.backHref).toBe("#");
    expect(m.tabs).toStrictEqual({ dayHref: "#report", monthHref: "#report=202610" });
    expect(m.shownLabel).toBe("2026年10月");
  });

  it("前の月報・次の月報は、一覧(月報のある月)の中で表示中の月の直前・直後。無ければ null", () => {
    const l = list("202610", "202608", "202606");
    expect(buildMonthlyModel(input({ shownMonth: "202608", list: l })).monthNav).toStrictEqual({ prevHref: "#report=202606", nextHref: "#report=202610", latestHref: "#report=202610" });
    expect(buildMonthlyModel(input({ shownMonth: "202610", list: l })).monthNav).toStrictEqual({ prevHref: "#report=202608", nextHref: null, latestHref: null });
    expect(buildMonthlyModel(input({ shownMonth: "202606", list: l })).monthNav).toStrictEqual({ prevHref: null, nextHref: "#report=202608", latestHref: "#report=202610" });
  });

  it("表示中の月が一覧に無くても(月報の無い月)、その月を基準に前後を出す。最新へのリンクは一覧の先頭", () => {
    const l = list("202610", "202608");
    expect(buildMonthlyModel(input({ shownMonth: "202609", list: l, detail: ready(null) })).monthNav).toStrictEqual({ prevHref: "#report=202608", nextHref: "#report=202610", latestHref: "#report=202610" });
  });

  it("一覧が読み込み中・失敗のときは前後・最新のリンクなし", () => {
    for (const l of [{ kind: "loading" } as const, { kind: "error", message: "x" } as const]) {
      expect(buildMonthlyModel(input({ list: l })).monthNav).toStrictEqual({ prevHref: null, nextHref: null, latestHref: null });
    }
  });

  it("読み込み中: 一覧か本文が読み込み中の間 loading・更新は無効。本文を取り始める前(null)も読み込み中", () => {
    expect(buildMonthlyModel(input({ detail: null })).loading).toBe(true);
    expect(buildMonthlyModel(input({ detail: { kind: "loading" } })).loading).toBe(true);
    expect(buildMonthlyModel(input({ list: { kind: "loading" } })).loading).toBe(true);
    const done = buildMonthlyModel(input());
    expect(done.loading).toBe(false);
    expect(done.refreshDisabled).toBe(false);
    expect(buildMonthlyModel(input({ detail: null })).refreshDisabled).toBe(true);
  });

  it("取得の失敗は error に固定の文言(一覧の失敗・本文の失敗のどちらも)", () => {
    expect(buildMonthlyModel(input({ list: { kind: "error", message: "一覧の失敗" } })).error).toBe("一覧の失敗");
    expect(buildMonthlyModel(input({ detail: { kind: "error", message: "本文の失敗" } })).error).toBe("本文の失敗");
    expect(buildMonthlyModel(input()).error).toBeNull();
  });
});

describe("buildMonthlyModel: 月報が無い月", () => {
  it("今月: 最終日の夜に自動で作られると案内する(本文なし)", () => {
    const m = buildMonthlyModel(input({ shownMonth: "202611", detail: ready(null) }));
    expect(m.body).toBeNull();
    expect(m.notice?.tone).toBe("info");
    expect(m.notice?.text).toContain("今月");
    expect(m.notice?.text).toContain("最終日");
  });

  it("過去の月: 無い旨と、分析したレースが無い月は作られない旨", () => {
    const m = buildMonthlyModel(input({ shownMonth: "202607", detail: ready(null) }));
    expect(m.body).toBeNull();
    expect(m.notice?.tone).toBe("info");
    expect(m.notice?.text).toContain("まだありません");
    expect(m.notice?.text).toContain("分析したレースが無い月");
  });

  it("先の月: まだ先の月である旨", () => {
    const m = buildMonthlyModel(input({ shownMonth: "202701", detail: ready(null) }));
    expect(m.notice?.text).toContain("先の月");
  });
});

describe("buildMonthlyModel: 月報の本文", () => {
  const body = () => buildMonthlyModel(input()).body!;

  it("見出し・メタ(作成時刻 JST・レース数・開催日数・期間)", () => {
    const b = body();
    expect(b.heading).toBe("2026年10月の月報");
    expect(b.meta).toContain("作成 2026-10-31 22:05");
    expect(b.meta).toContain("3 レース");
    expect(b.meta).toContain("開催 2 日");
    expect(b.meta).toContain("2026年10月1日〜2026年10月31日");
  });

  it("成績のタイル: 賭け金・払戻・回収率・的中・見込みと実際(日報と同じ書き方)", () => {
    expect(body().tiles).toStrictEqual([
      { label: "賭け金", value: "300円", strong: false },
      { label: "払戻", value: "800円", strong: false },
      { label: "回収率", value: "266.7%", strong: true },
      { label: "的中", value: "2 点中 1 点", strong: false },
      { label: "見込みと実際", value: "見込み 0.80 点・実際 1 点", strong: false },
    ]);
  });

  it("返還があれば的中のタイルに『うち返還』を添える。賭け金が 0 の月の回収率は『-』", () => {
    const refunded = buildMonthlyModel(input({ detail: ready(detail({}, { refundedBetCount: 1 })) })).body!;
    expect(refunded.tiles.find((t) => t.label === "的中")!.value).toBe("2 点中 1 点(うち返還 1 点)");
    const zero = buildMonthlyModel(input({ detail: ready(detail({}, { totalStake: 0, totalReturn: 0, recoveryRate: null })) })).body!;
    expect(zero.tiles.find((t) => t.label === "回収率")!.value).toBe("-");
  });

  it("日ごとの行: 昇順で、日付(曜日つき)・日報へのリンク(#report=YYYYMMDD)・レース数・回収率・的中・賭け金・払戻", () => {
    const rows = body().dayRows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toStrictEqual({ label: "2026年10月3日(土)", href: "#report=20261003", value: "2 レース・回収率 400.0%・1 点中 1 点的中・賭け金 200円・払戻 800円" });
    expect(rows[1]).toStrictEqual({ label: "2026年10月31日(土)", href: "#report=20261031", value: "1 レース・回収率 0.0%・1 点中 0 点的中・賭け金 100円・払戻 0円" });
  });

  it("日ごとの行: 結果なしのレースがあれば添える。返還があれば『うち返還』を添える。賭け金 0 の日の回収率は『-』", () => {
    const d = detail(
      {},
      {
        days: [{ date: "20261003", raceCount: 3, resultRaceCount: 2, noResultRaceCount: 1, totalStake: 0, totalReturn: 0, recoveryRate: null, judgedBetCount: 0, hitBetCount: 0, refundedBetCount: 0 }, { date: "20261004", raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, totalStake: 100, totalReturn: 100, recoveryRate: 1, judgedBetCount: 1, hitBetCount: 0, refundedBetCount: 1 }],
      },
    );
    const rows = buildMonthlyModel(input({ detail: ready(d) })).body!.dayRows;
    expect(rows[0]!.value).toBe("3 レース(結果なし 1)・回収率 -・0 点中 0 点的中・賭け金 0円・払戻 0円");
    expect(rows[1]!.value).toBe("1 レース・回収率 100.0%・1 点中 0 点的中(うち返還 1 点)・賭け金 100円・払戻 100円");
  });

  it("券種別・印別の行は日報と同じ書き方", () => {
    const b = body();
    expect(b.typeRows).toStrictEqual([{ label: "単勝", value: "2 点中 1 点的中・賭け金 300円・払戻 800円" }]);
    expect(b.markRows).toStrictEqual([{ label: "◎", value: "3 頭 / 1 / 2" }]);
  });

  it("もしも(印の定型): 成績があれば節を出す(月のぶんだけ)。無ければ null", () => {
    expect(body().whatIf).toBeNull();
    const w = buildMonthlyModel(input({ detail: ready(detail({}, { whatIf: { win: { betCount: 3, hitCount: 1, stake: 300, payout: 900, unjudgedCount: 0, inapplicableCount: 0 } } })) })).body!.whatIf;
    expect(w).not.toBeNull();
    expect(w!.heading).toContain("もしも");
    expect(w!.rows).toHaveLength(1);
  });

  it("版ごとの行: 版が 2 つ以上のときだけ出す(1 つの月は null)。版不明は『版不明』。版ごとの注意を添える", () => {
    expect(body().versions).toBeNull();
    const d = detail(
      {},
      {
        byVersion: [
          { promptVersion: "v1", raceCount: 2, resultRaceCount: 2, totalStake: 200, totalReturn: 800, recoveryRate: 4, judgedBetCount: 1, hitBetCount: 1 },
          { promptVersion: null, raceCount: 1, resultRaceCount: 1, totalStake: 100, totalReturn: 0, recoveryRate: 0, judgedBetCount: 1, hitBetCount: 0 },
        ],
      },
    );
    const v = buildMonthlyModel(input({ detail: ready(d) })).body!.versions;
    expect(v).not.toBeNull();
    expect(v!.rows).toStrictEqual([
      { label: "v1", value: "2 レース・回収率 400.0%・1 点中 1 点的中・賭け金 200円・払戻 800円" },
      { label: "版不明", value: "1 レース・回収率 0.0%・1 点中 0 点的中・賭け金 100円・払戻 0円" },
    ]);
    expect(v!.note).toBe(MONTHLY_VERSION_NOTE);
  });

  it("固定の注記: 日報の合計と一致しないことがある。LLM の文章はまだ無い(段階 A)。最終日の未確定の注記は lastDayPending のときだけ", () => {
    const b = body();
    expect(b.notes).toStrictEqual([MONTHLY_DISCREPANCY_NOTE]);
    expect(b.textNote).toBe(MONTHLY_NO_TEXT_NOTE);
    const pending = buildMonthlyModel(input({ detail: ready(detail({ lastDayPending: true })) })).body!;
    expect(pending.notes).toStrictEqual([MONTHLY_LAST_DAY_PENDING_NOTE, MONTHLY_DISCREPANCY_NOTE]);
  });

  it("結果なし・判定不能がある月は、メタに件数を添える(成績に含めない旨)", () => {
    const d = detail({}, { noResultRaceCount: 2, resultRaceCount: 1, unjudgedBetCount: 3, unjudgedStake: 500 });
    const meta = buildMonthlyModel(input({ detail: ready(d) })).body!.meta;
    expect(meta).toContain("結果なし 2 レース");
    expect(meta).toContain("判定不能の買い目 3 点(賭け金 500円。成績に含めません)");
  });

  it("本文が無い(ready でない)とき body は null", () => {
    expect(buildMonthlyModel(input({ detail: { kind: "loading" } })).body).toBeNull();
    expect(buildMonthlyModel(input({ detail: { kind: "error", message: "x" } })).body).toBeNull();
  });
});
