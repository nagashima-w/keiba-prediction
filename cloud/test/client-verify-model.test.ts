import { describe, expect, it } from "vitest";
import type { ProposedSummaryView, VerifyOutcome, VerifyReportView } from "../client/api-verify";
import { exclusionRows, formatRate, formatUnknownBetTypeNotice, formatYen, PROPOSED_BET_LABELS, venueLabel } from "../client/verify-format";
import { buildVerifyModel, type VerifyModelInput } from "../client/verify-model";

/** Issue #219: 検証画面の表示用データ。数値の整形は exe と同じ(一致は scripts/test/cloud-verify-format.test.ts が exe の関数と比べる)。 */

const summary = (over: Partial<ProposedSummaryView> = {}): ProposedSummaryView => ({ betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null, unjudgedCount: 0, ...over });

function report(over: Partial<VerifyReportView> = {}): VerifyReportView {
  return {
    includedAnalysisCount: 120,
    excludedAnalysisCount: 7,
    supersededAnalysisCount: 30,
    excludedEstimatedCount: 4,
    excludedLookaheadSuspectCount: 0,
    excludedLookaheadUnknownCount: 0,
    bet: { betCount: 52, totalStake: 5200, totalReturn: 4994, recoveryRate: 0.9603846, actualPayoutCount: 20, approximatePayoutCount: 1 },
    proposedBet: {
      population: { allocated: 90, skipped: 10, unreached: 15, noRecord: 5 },
      overall: summary({ betCount: 300, totalStake: 123456, totalReturn: 130000, recoveryRate: 1.0530 }),
      byType: {
        place: summary({ betCount: 100, recoveryRate: 0.9 }),
        win: summary({ betCount: 50, recoveryRate: 1.2 }),
        wide: summary({ betCount: 60, recoveryRate: null }),
        trio: summary({ betCount: 10, recoveryRate: 0 }),
        quinella: summary({ betCount: 40, recoveryRate: 1.5 }),
        exacta: summary({ betCount: 20, recoveryRate: 0.5 }),
        trifecta: summary({ betCount: 5, recoveryRate: 2.25 }),
        bracketQuinella: summary({ betCount: 15, recoveryRate: 0.75 }),
      },
      unknownBetType: { count: 0, totalStake: 0, betTypes: [] },
    },
    ...over,
  };
}

const ready = (over: Partial<Extract<VerifyOutcome, { kind: "ready" }>> = {}, r: VerifyReportView = report()): VerifyOutcome => ({
  kind: "ready", venue: "all", report: r, computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, startTimeGaps: { lost: 0, affecting: 0 }, ...over,
});

const input = (over: Partial<VerifyModelInput> = {}): VerifyModelInput => ({ load: { kind: "ready", outcome: ready() }, venue: "all", busy: false, pollStopped: false, ...over });

describe("整形(exe と同じ)", () => {
  it("率は小数第 1 位のパーセント(null は -)、金額は 3 桁区切りの円", () => {
    expect(formatRate(0.9603846)).toBe("96.0%");
    expect(formatRate(1)).toBe("100.0%");
    expect(formatRate(0)).toBe("0.0%");
    expect(formatRate(null)).toBe("-");
    expect(formatYen(1060)).toBe("1,060円");
    expect(formatYen(0)).toBe("0円");
    expect(formatYen(1234567)).toBe("1,234,567円");
  });
  it("区分の名前は 全体・中央のみ・地方のみ", () => {
    expect(["all", "central", "nar"].map((v) => venueLabel(v as "all"))).toEqual(["全体", "中央のみ", "地方のみ"]);
  });
  it("券種の並びは exe の内訳と同じ(複勝・単勝・ワイド・馬連・枠連・馬単・3連複・三連単)で、8 つすべて", () => {
    expect(PROPOSED_BET_LABELS.map((x) => x.label)).toEqual(["複勝", "単勝", "ワイド", "馬連", "枠連", "馬単", "3連複", "三連単"]);
    expect(new Set(PROPOSED_BET_LABELS.map((x) => x.type)).size).toBe(8);
  });
  it("未知の券種の注記: 0 点は null、あれば券種コード・点数・賭け金合計を含む", () => {
    expect(formatUnknownBetTypeNotice({ count: 0, totalStake: 0, betTypes: [] })).toBeNull();
    const text = formatUnknownBetTypeNotice({ count: 2, totalStake: 1500, betTypes: ["abc", "xyz"] })!;
    expect(text).toContain("abc、xyz");
    expect(text).toContain("2点");
    expect(text).toContain("1,500円");
  });
});

describe("buildVerifyModel: 集計があるとき", () => {
  const model = buildVerifyModel(input());

  it("累積回収率: 賭け数・投資額・回収額・回収率の 4 タイル(回収率が強調)と、払戻内訳・集計の内訳 6 行", () => {
    expect(model.bet?.tiles).toEqual([
      { label: "賭け数", value: "52点", strong: false },
      { label: "投資額", value: "5,200円", strong: false },
      { label: "回収額", value: "4,994円", strong: false },
      { label: "回収率", value: "96.0%", strong: true },
    ]);
    expect(model.bet?.payoutLine).toBe("払戻内訳: 実配当 20件 / 近似 1件(実配当が無い点は複勝下限で近似)");
    expect(model.bet?.exclusions).toEqual([
      { label: "集計", value: "120件" },
      { label: "結果未取込で除外", value: "7件" },
      { label: "旧分析除外", value: "30件" },
      { label: "発売前推定のため除外", value: "4件" },
      { label: "リーク疑い(発走後に分析・先読み未遮断)のため除外", value: "0件" },
      { label: "発走前後を判定できず除外", value: "0件" },
    ]);
    expect(model.bet?.empty).toBeNull();
  });

  it("配分ベース: 4 タイル・券種 8 行(点数と回収率)・母集団 4 行。判定不能が無ければ出さない", () => {
    expect(model.proposed?.tiles.map((t) => t.value)).toEqual(["300点", "123,456円", "130,000円", "105.3%"]);
    expect(model.proposed?.types).toEqual([
      { label: "複勝", count: "100点", rate: "90.0%" },
      { label: "単勝", count: "50点", rate: "120.0%" },
      { label: "ワイド", count: "60点", rate: "-" },
      { label: "馬連", count: "40点", rate: "150.0%" },
      { label: "枠連", count: "15点", rate: "75.0%" },
      { label: "馬単", count: "20点", rate: "50.0%" },
      { label: "3連複", count: "10点", rate: "0.0%" },
      { label: "三連単", count: "5点", rate: "225.0%" },
    ]);
    expect(model.proposed?.population).toEqual([
      { label: "配分あり", value: "90件" },
      { label: "見送り", value: "10件" },
      { label: "未到達", value: "15件" },
      { label: "記録なし", value: "5件" },
    ]);
    expect(model.proposed?.unjudged).toBeNull();
    expect(model.proposed?.unknownNotice).toBeNull();
  });

  it("判定不能(rule U)が 1 点でもあれば、券種別の点数の行を出す(0 点の券種も並ぶ)", () => {
    const r = report();
    const withUnjudged = report({ proposedBet: { ...r.proposedBet, overall: summary({ ...r.proposedBet.overall, unjudgedCount: 3 }), byType: { ...r.proposedBet.byType, wide: summary({ unjudgedCount: 3 }) } } });
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, withUnjudged) } }));
    expect(m.proposed?.unjudged?.rows).toHaveLength(8);
    expect(m.proposed?.unjudged?.rows.find((x) => x.label === "ワイド")).toEqual({ label: "ワイド", value: "3点" });
    expect(m.proposed?.unjudged?.rows.find((x) => x.label === "複勝")).toEqual({ label: "複勝", value: "0点" });
  });

  it("未知の券種があれば注記を出す", () => {
    const r = report();
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ proposedBet: { ...r.proposedBet, unknownBetType: { count: 1, totalStake: 100, betTypes: ["x"] } } })) } }));
    expect(m.proposed?.unknownNotice).toContain("x");
  });

  it("リーク疑い・判定不能の除外が 1 件でもあるときだけ、分析し直しの注記を出す", () => {
    expect(model.bet?.exclusionNote).toBeNull();
    for (const over of [{ excludedLookaheadSuspectCount: 1 }, { excludedLookaheadUnknownCount: 2 }]) {
      const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report(over)) } }));
      expect(m.bet?.exclusionNote).not.toBeNull();
    }
  });

  it("集計対象が 0 件なら『集計対象がありません。』(タイルは 0 のまま持つが、画面は文を出す)", () => {
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ includedAnalysisCount: 0 })) } }));
    expect(m.bet?.empty).toBe("集計対象がありません。");
    expect(m.proposed?.empty).toBe("集計対象がありません。");
  });

  it("集計時点を JST で出す。区分の切替の現在位置、通信中は更新を無効にする", () => {
    expect(model.computedAt).toBe("2026-10-10 12:00(JST)");
    expect(model.venueTabs).toEqual([
      { venue: "all", label: "全体", current: true },
      { venue: "central", label: "中央のみ", current: false },
      { venue: "nar", label: "地方のみ", current: false },
    ]);
    expect(buildVerifyModel(input({ venue: "nar" })).venueTabs.find((t) => t.current)?.venue).toBe("nar");
    expect(model.refreshDisabled).toBe(false);
    expect(buildVerifyModel(input({ busy: true })).refreshDisabled).toBe(true);
    expect(buildVerifyModel(input({ busy: true })).loading).toBe(true);
  });
});

describe("buildVerifyModel: 注記", () => {
  it("古い集計(stale)の理由ごとに、集計時点と次に更新できる時刻を含む固定の注記", () => {
    const base = { stale: true } as const;
    const backfilling = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({ ...base, staleReason: "backfilling" }) } }));
    expect(backfilling.notices[0]?.text).toContain("2026-10-10 12:00(JST)");
    expect(backfilling.notices[0]?.text).toContain("発走時刻を確認しています");
    const minInterval = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({ ...base, staleReason: "min-interval", nextRecomputeAt: "2026-10-10T03:05:00.000Z" }) } }));
    expect(minInterval.notices[0]?.text).toContain("12:05");
    const daily = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({ ...base, staleReason: "daily-limit", nextRecomputeAt: "2026-10-10T15:00:00.000Z" }) } }));
    expect(daily.notices[0]?.text).toContain("2026-10-11 00:00");
    expect(model0().notices).toEqual([]);
  });

  function model0() {
    return buildVerifyModel(input());
  }

  it("発走時刻の欠落: 判定に影響しうる件数があれば警告、影響しないなら info、0 なら出さない", () => {
    const affecting = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({ startTimeGaps: { lost: 5, affecting: 2 } }) } }));
    expect(affecting.notices).toHaveLength(1);
    expect(affecting.notices[0]?.tone).toBe("wait");
    expect(affecting.notices[0]?.text).toContain("5件");
    expect(affecting.notices[0]?.text).toContain("2件");
    const harmless = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({ startTimeGaps: { lost: 5, affecting: 0 } }) } }));
    expect(harmless.notices[0]?.tone).toBe("info");
    expect(harmless.notices[0]?.text).toContain("影響しません");
    expect(buildVerifyModel(input({ load: { kind: "ready", outcome: ready({ startTimeGaps: { lost: 0, affecting: 0 } }) } })).notices).toEqual([]);
  });
});

describe("buildVerifyModel: 集計が出せないとき・取得の状態", () => {
  it("preparing: 残り件数と自動更新の説明。柵(r2-fence)は再開時刻、error は更新の案内。集計・タイルは出さない", () => {
    const prep = buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "preparing", remaining: 321, blocked: null, resumeAt: null } } }));
    expect(prep.unavailable?.text).toContain("321件");
    expect(prep.unavailable?.tone).toBe("info");
    expect(prep.bet).toBeNull();
    expect(prep.proposed).toBeNull();
    expect(prep.computedAt).toBeNull();
    const fence = buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "preparing", remaining: 5, blocked: "r2-fence", resumeAt: "2026-11-01T00:05:00.000Z" } } }));
    expect(fence.unavailable?.text).toContain("2026-11-01 09:05");
    const err = buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "preparing", remaining: 5, blocked: "error", resumeAt: null } } }));
    expect(err.unavailable?.tone).toBe("error");
  });

  it("throttled: 次に開ける時刻を出す", () => {
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z" } } }));
    expect(m.unavailable?.text).toContain("2026-10-11 00:00");
    expect(m.bet).toBeNull();
  });

  it("取得中は loading、失敗は固定の文言(error)。自動更新を止めたら注記", () => {
    const loading = buildVerifyModel(input({ load: { kind: "loading" } }));
    expect(loading.loading).toBe(true);
    expect(loading.bet).toBeNull();
    const failed = buildVerifyModel(input({ load: { kind: "error", message: "取得できませんでした" } }));
    expect(failed.error).toBe("取得できませんでした");
    expect(failed.loading).toBe(false);
    expect(buildVerifyModel(input({ pollStopped: true })).pollNotice).not.toBeNull();
    expect(buildVerifyModel(input()).pollNotice).toBeNull();
  });
});

describe("exclusionRows", () => {
  it("6 項目で、合計は集計対象にした分析の総数の内訳(各分析がちょうど 1 つ)", () => {
    const r = report({ excludedLookaheadSuspectCount: 3, excludedLookaheadUnknownCount: 2 });
    const rows = exclusionRows(r);
    expect(rows).toHaveLength(6);
    expect(rows.reduce((n, x) => n + Number.parseInt(x.value, 10), 0)).toBe(120 + 7 + 30 + 4 + 3 + 2);
  });
});
