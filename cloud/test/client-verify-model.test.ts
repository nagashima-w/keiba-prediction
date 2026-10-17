import { describe, expect, it } from "vitest";
import type { ProposedSummaryView, VerifyOutcome, VerifyReportView } from "../client/api-verify";
import { exclusionRows, formatRate, formatUnknownBetTypeNotice, formatYen, PROPOSED_BET_LABELS, venueLabel } from "../client/verify-format";
import { buildVerifyModel, type VerifyModelInput } from "../client/verify-model";
import { calibrationFixture, closeFixture, priorCalibrationFixture, LONG_INSTRUCTION, trendFixture, versionsFixture } from "./verify-fixtures";

/** Issue #219: 検証画面の表示用データ。数値の整形は exe と同じ(一致は scripts/test/cloud-verify-format.test.ts が exe の関数と比べる)。 */

const summary = (over: Partial<ProposedSummaryView> = {}): ProposedSummaryView => ({ betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null, unjudgedCount: 0, refundedCount: 0, refundedStake: 0, flatStake: 0, flatReturn: 0, flatRecoveryRate: null, ...over });

function report(over: Partial<VerifyReportView> = {}): VerifyReportView {
  return {
    includedAnalysisCount: 120,
    excludedAnalysisCount: 7,
    supersededAnalysisCount: 30,
    excludedEstimatedCount: 4,
    excludedLookaheadSuspectCount: 0,
    excludedLookaheadUnknownCount: 0,
    bet: { betCount: 52, totalStake: 5200, totalReturn: 4994, recoveryRate: 0.9603846, actualPayoutCount: 20, approximatePayoutCount: 1 },
    calibration: calibrationFixture(),
    priorCalibration: priorCalibrationFixture(),
    trend: trendFixture(),
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
  kind: "ready", venue: "all", report: r, promptVersions: versionsFixture(), closeComparison: null, computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, startTimeGaps: { lost: 0, affecting: 0 }, ...over,
});

const input = (over: Partial<VerifyModelInput> = {}): VerifyModelInput => ({ load: { kind: "ready", outcome: ready() }, venue: "all", busy: false, pollStopped: false, expandedVersions: [], calibrationTarget: "adjusted", admin: true, ...over });

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

  it("Issue #72: 返還が 1 点でもあれば、合算の点数と賭け金を「うち返還 N点(金額)」の 1 行で出す。無ければ出さない", () => {
    expect(model.proposed?.refund).toBeNull();
    const r = report();
    const withRefund = report({ proposedBet: { ...r.proposedBet, overall: summary({ ...r.proposedBet.overall, refundedCount: 3, refundedStake: 1200 }), byType: { ...r.proposedBet.byType, wide: summary({ refundedCount: 3, refundedStake: 1200 }) } } });
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, withRefund) } }));
    expect(m.proposed?.refund).toBe("うち返還 3点(1,200円)");
    // 返還は賭け金にも回収額にも含まれる(タイルの値は overall のまま。返還を足し引きして見せない)
    expect(m.proposed?.tiles.map((t) => t.value)).toEqual(["300点", "123,456円", "130,000円", "105.3%"]);
  });

  it("Issue #72: 説明文が、2 つの系の取消・除外の扱いの違い(一律 100 円は集計に入れない/配分ベースは返還として賭け金を払戻に含める)を言う", () => {
    expect(model.bet?.description).toContain("取消・除外・中止など着順が出ていない馬は集計に入れません");
    expect(model.proposed?.description).toContain("取消・除外の馬への買い目は返還として、賭け金を払戻に含めます");
    // 既存の説明(賭け金の仮定が違うので合算しない)は残る
    expect(model.proposed?.description).toContain("合算しません");
    expect(model.bet?.description).toContain("一律 100 円");
  });

  it("Issue #16: 一律 100 円の比較は、合算の値で「同じ買い目に一律 100 円なら 回収率 X(投資額 / 回収額)」の 1 行にする。一律の賭け金が 0 なら出さない", () => {
    expect(model.proposed?.flat).toBeNull(); // 既定の summary は一律の賭け金 0
    const r = report();
    const withFlat = report({ proposedBet: { ...r.proposedBet, overall: summary({ ...r.proposedBet.overall, flatStake: 30000, flatReturn: 29490, flatRecoveryRate: 0.983 }), byType: { ...r.proposedBet.byType, place: summary({ flatStake: 999900, flatReturn: 1, flatRecoveryRate: 0.5 }) } } });
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, withFlat) } }));
    // 合算(overall)の値を使う(券種別の値を取り違えない)
    expect(m.proposed?.flat).toBe("同じ買い目に一律 100 円なら 回収率 98.3%(投資額 30,000円 / 回収額 29,490円)");
    // タイルは配分ベースのまま(一律の値を混ぜない)
    expect(m.proposed?.tiles.map((t) => t.value)).toEqual(["300点", "123,456円", "130,000円", "105.3%"]);
  });

  it("Issue #16: 一律の回収率が丸めて 100.0% になる値は、100.0% と出さない(配分ベースのタイルと同じ整形)", () => {
    const r = report();
    const almost = report({ proposedBet: { ...r.proposedBet, overall: summary({ ...r.proposedBet.overall, flatStake: 10000, flatReturn: 9999, flatRecoveryRate: 0.9999 }) } });
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, almost) } }));
    expect(m.proposed?.flat).not.toContain("100.0%");
    expect(m.proposed?.flat).toContain("99.99%");
  });

  it("Issue #16: 配分ベースの説明文が、「同じ買い目に一律 100 円」の意味(買い目の集合が同じ・返還を含み判定不能を除く)と、累積回収率とは集合が違うことを言う", () => {
    const d = model.proposed?.description ?? "";
    expect(d).toContain("「同じ買い目に一律 100 円」は、この配分ベースと同じ買い目");
    expect(d).toContain("返還を含み、判定不能を除く");
    expect(d).toContain("買い目の集合が違います");
    // 既存の文は残る
    expect(d).toContain("合算しません");
    expect(d).toContain("取消・除外の馬への買い目は返還として、賭け金を払戻に含めます");
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

describe("buildVerifyModel: 補正方向×結果・キャリブレーション・印別的中率(Issue #220)", () => {
  const model = buildVerifyModel(input());

  it("補正方向×結果: 上げ・下げ・据え置きの 3 行(件数・実複勝率・平均補正幅。件数 0 の群は率も補正幅も -)", () => {
    expect(model.direction?.heading).toBe("補正方向×結果");
    expect(model.direction?.rows).toEqual([
      { label: "上げ", bar: null, cells: [{ name: "件数", value: "40件" }, { name: "実複勝率", value: "55.0%" }, { name: "平均補正幅", value: "+5.2pt" }] },
      { label: "下げ", bar: null, cells: [{ name: "件数", value: "30件" }, { name: "実複勝率", value: "20.0%" }, { name: "平均補正幅", value: "-3.1pt" }] },
      { label: "据え置き", bar: null, cells: [{ name: "件数", value: "0件" }, { name: "実複勝率", value: "-" }, { name: "平均補正幅", value: "-" }] },
    ]);
  });

  it("印別的中率: 6 つの印+印なしの 7 行(件数・複勝率・勝率)", () => {
    expect(model.marks?.heading).toBe("印別的中率");
    expect(model.marks?.rows).toHaveLength(7);
    expect(model.marks?.rows.map((r) => r.label)).toEqual(["◎", "〇", "▲", "△", "☆", "注", "印なし"]);
    expect(model.marks?.rows[0]).toEqual({ label: "◎", bar: null, cells: [{ name: "件数", value: "20件" }, { name: "複勝率", value: "65.0%" }, { name: "勝率", value: "30.0%" }] });
    expect(model.marks?.rows[1]?.cells[2]).toEqual({ name: "勝率", value: "16.7%" }); // 0.1666 → 小数第 1 位
    expect(model.marks?.rows[2]?.cells).toEqual([{ name: "件数", value: "0件" }, { name: "複勝率", value: "-" }, { name: "勝率", value: "-" }]);
  });

  it("キャリブレーション: 20 帯の行。帯・予測件数・複勝件数・実複勝率・予測−実績(符号と過信/過小評価/一致)と、帯グラフ(実複勝率 ×1000 の整数/1000)", () => {
    const rows = model.calibration?.rows ?? [];
    expect(model.calibration?.heading).toBe("キャリブレーション(推定確率帯ごとの実複勝率・過信バイアス)");
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.label).slice(0, 3)).toEqual(["0〜5%", "5〜10%", "10〜15%"]);
    expect(rows[19]?.label).toBe("95〜100%");
    // 件数 0 の帯: 実複勝率・予測−実績は -。帯グラフは 0
    // (Issue #254: 先頭の 4 つの cell は旧版と同じ。末尾に 平均予測・95%区間・判定 の 3 つが付く)
    expect(rows[0]).toEqual({ label: "0〜5%", bar: { value: 0, max: 1000, label: "実複勝率 -" }, cells: [{ name: "予測件数", value: "0件" }, { name: "複勝件数", value: "0件" }, { name: "実複勝率", value: "-" }, { name: "予測−実績", value: "-" }, { name: "平均予測", value: "-" }, { name: "95%区間", value: "-" }, { name: "判定", value: "-" }] });
    // 過信(Issue #254: 予測 = 帯内の平均予測 12.0% > 実 0%。帯の中央 12.5% ではない)
    expect(rows[2]?.cells.slice(0, 4)).toEqual([{ name: "予測件数", value: "4件" }, { name: "複勝件数", value: "0件" }, { name: "実複勝率", value: "0.0%" }, { name: "予測−実績", value: "+12.0pt(過信)" }]);
    expect(rows[2]?.bar).toEqual({ value: 0, max: 1000, label: "実複勝率 0.0%" });
    // 過小評価(平均予測 53.0% < 実 70%)
    expect(rows[10]?.cells[3]).toEqual({ name: "予測−実績", value: "-17.0pt(過小評価)" });
    expect(rows[10]?.bar).toEqual({ value: 700, max: 1000, label: "実複勝率 70.0%" });
    // 実複勝率がちょうど平均予測(62.5%)= 一致
    expect(rows[12]?.cells[3]).toEqual({ name: "予測−実績", value: "+0.0pt(一致)" });
    // 41.7%(5/12)の帯グラフは四捨五入して 417
    expect(rows[8]?.bar?.value).toBe(417);
    expect(rows[19]?.bar).toEqual({ value: 1000, max: 1000, label: "実複勝率 100.0%" });
  });

  it("Issue #254: 予測−実績は core の過信バイアス(trend.calibrationBias。帯の中央値ベース)を使わない。短い配列・食い違う値を渡しても行は変わらない", () => {
    const r = report();
    const base = buildVerifyModel(input()).calibration?.rows;
    const short = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ trend: { ...r.trend, calibrationBias: r.trend.calibrationBias.slice(0, 8) } })) } })).calibration?.rows;
    const wrong = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ trend: { ...r.trend, calibrationBias: r.trend.calibrationBias.map(() => ({ overconfidenceGap: 0.5 })) } })) } })).calibration?.rows;
    expect(base?.[8]?.cells[3]).toEqual({ name: "予測−実績", value: "+1.3pt(過信)" }); // 前提: 平均予測 43.0% − 実 41.7%。core の値〈中央 42.5% − 41.7% = +0.8〉とは別の値なので、core の値を使うと下の比較が崩れる
    expect(short).toEqual(base);
    expect(wrong).toEqual(base);
  });

  it("集計対象が 0 件でも(exe と同じく)表は出す。帯が 0 本なら『データがありません。』", () => {
    const zero = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ includedAnalysisCount: 0 })) } }));
    expect(zero.direction?.rows).toHaveLength(3);
    expect(zero.marks?.rows).toHaveLength(7);
    expect(zero.calibration?.rows).toHaveLength(20);
    expect(zero.calibration?.empty).toBeNull();
    const noBins = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ calibration: [] })) } }));
    expect(noBins.calibration?.empty).toBe("データがありません。");
    expect(noBins.calibration?.rows).toEqual([]);
  });

  it("集計が出せないとき・取得中は出さない", () => {
    for (const load of [{ kind: "loading" }, { kind: "error", message: "x" }, { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" } }] as const) {
      const m = buildVerifyModel(input({ load }));
      expect([m.direction, m.calibration, m.marks]).toEqual([null, null, null]);
    }
  });
});

describe("buildVerifyModel: プロンプト版別の比較(Issue #220)", () => {
  const model = buildVerifyModel(input());
  const SUMMARY_30 = `${LONG_INSTRUCTION.slice(0, 30)}…`;

  it("見出し・説明(全体の集計で区分の切替に連動しないこと)・版不明の注記。版の並びはサーバのまま", () => {
    expect(model.versions?.heading).toBe("プロンプト版別比較");
    expect(model.versions?.description).toContain("全体の集計");
    expect(model.versions?.description).toContain("区分の切替には連動しません");
    expect(model.versions?.cards.map((c) => c.title)).toEqual(["2026-10-09.2", "2026-10-09.2-clip015", "版不明"]);
    // 版不明の行があるときだけ、その内訳(旧データと LLM 未使用の両方を含む)の注記を出す
    expect(model.versions?.unknownNote).toContain("版記録導入前の旧データ");
    expect(model.versions?.unknownNote).toContain("APIキー未設定");
    const known = buildVerifyModel(input({ load: { kind: "ready", outcome: { ...(ready() as Extract<VerifyOutcome, { kind: "ready" }>), promptVersions: versionsFixture().slice(0, 2) } } }));
    expect(known.versions?.unknownNote).toBeNull();
  });

  it("版ごとのカード: 追加指示の要約(30 文字で切る・null は『なし』・複数は ' / ')、集計件数、4 タイル(賭け数・投資額・回収額・回収率)", () => {
    const [first, second, third] = model.versions?.cards ?? [];
    expect(first?.instructions).toBe(`追加指示: ${SUMMARY_30} / なし`);
    expect(first?.included).toBe("集計件数 80件");
    expect(first?.tiles).toEqual([
      { label: "賭け数", value: "52点", strong: false },
      { label: "投資額", value: "5,200円", strong: false },
      { label: "回収額", value: "4,994円", strong: false },
      { label: "回収率", value: "96.0%", strong: true },
    ]);
    expect(second?.instructions).toBe("追加指示: なし");
    expect(second?.tiles.map((t) => t.value)).toEqual(["10点", "1,000円", "1,250円", "125.0%"]);
    // 賭けが 0 点の版: 回収率は -
    expect(third?.tiles.map((t) => t.value)).toEqual(["0点", "0円", "0円", "-"]);
    expect(third?.included).toBe("集計件数 15件");
  });

  it("既定は全部たたんでいる(キャリブレーションの行・全文を持たない)。開いた版だけが、見出し・追加指示の全文・20 帯を持つ", () => {
    expect(model.versions?.cards.every((c) => !c.expanded && c.calibrationRows.length === 0 && c.fullInstructions === null)).toBe(true);
    expect(model.versions?.cards.map((c) => c.toggleLabel)).toEqual(Array(3).fill("キャリブレーションを表示"));
    const keys = model.versions?.cards.map((c) => c.key) ?? [];
    expect(new Set(keys).size).toBe(3);
    const opened = buildVerifyModel(input({ expandedVersions: [keys[0]!] }));
    const [a, b] = opened.versions?.cards ?? [];
    expect(a?.expanded).toBe(true);
    expect(a?.toggleLabel).toBe("キャリブレーションを閉じる");
    expect(a?.calibrationHeading).toBe(`2026-10-09.2 (追加指示: ${SUMMARY_30} / なし)`);
    expect(a?.fullInstructions).toBe(`追加指示(全文): ${LONG_INSTRUCTION} / なし`);
    expect(a?.calibrationRows).toHaveLength(20);
    // 主表と同じ行の作り(Issue #254: 予測−実績は帯内の平均予測 − 実複勝率。版別の overconfidenceGaps〈帯の中央値ベース〉は使わない)
    expect(a?.calibrationRows[2]?.cells[3]).toEqual({ name: "予測−実績", value: "+12.0pt(過信)" });
    expect(a?.calibrationRows).toEqual(buildVerifyModel(input()).calibration?.rows);
    expect(a?.calibrationRows[10]?.bar?.value).toBe(700);
    // 開いていない版は閉じたまま
    expect(b?.expanded).toBe(false);
    expect(b?.calibrationRows).toEqual([]);
  });

  it("開いた版でも帯の件数がすべて 0 なら 20 行は出す(件数 0・率 -)。帯が 0 本なら『データがありません。』", () => {
    const keys = model.versions?.cards.map((c) => c.key) ?? [];
    const second = buildVerifyModel(input({ expandedVersions: [keys[1]!] })).versions?.cards[1];
    expect(second?.calibrationRows).toHaveLength(20);
    expect(second?.calibrationRows.every((r) => r.cells[0]?.value === "0件" && r.cells[3]?.value === "-")).toBe(true);
    const noBins = { ...(ready() as Extract<VerifyOutcome, { kind: "ready" }>), promptVersions: [{ ...versionsFixture()[0]!, calibration: [], overconfidenceGaps: [] }] };
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: noBins }, expandedVersions: [keys[0]!] }));
    expect(m.versions?.cards[0]?.calibrationEmpty).toBe("データがありません。");
    expect(m.versions?.cards[0]?.calibrationRows).toEqual([]);
  });

  it("追加指示がなし(null のみ)なら全文の行は『追加指示(全文): なし』", () => {
    const keys = model.versions?.cards.map((c) => c.key) ?? [];
    expect(buildVerifyModel(input({ expandedVersions: [keys[1]!] })).versions?.cards[1]?.fullInstructions).toBe("追加指示(全文): なし");
  });

  it("版別が 0 件なら『集計対象がありません。』。集計が出せないとき・取得中は節ごと出さない", () => {
    const none = { ...(ready() as Extract<VerifyOutcome, { kind: "ready" }>), promptVersions: [] };
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: none } }));
    expect(m.versions?.empty).toBe("集計対象がありません。");
    expect(m.versions?.cards).toEqual([]);
    expect(model.versions?.empty).toBeNull();
    for (const load of [{ kind: "loading" }, { kind: "error", message: "x" }, { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" } }] as const) {
      expect(buildVerifyModel(input({ load })).versions).toBeNull();
    }
  });

  it("区分を替えても版別は同じ(全体のまま)", () => {
    const nar = buildVerifyModel(input({ venue: "nar" }));
    expect(model.versions?.cards).toHaveLength(3); // 前提(空振り防止): 版別がある
    expect(nar.versions).toEqual(model.versions);
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
    // 原因を断定しない(詳細が無いとは限らない。書き込み中・壊れている場合もある)
    expect(affecting.notices[0]?.text).not.toContain("保存されていません");
    expect(affecting.notices[0]?.text).toContain("読めませんでした");
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
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" } } }));
    expect(m.unavailable?.text).toContain("2026-10-11 00:00");
    expect(m.bet).toBeNull();
  });

  it("Issue #254(#255 からの申し送り) throttled の文言は柵の種類で変わる: 1 日の上限のときだけ『1 日の集計の上限』と言い、最短間隔(5 分)のときは言わない", () => {
    const daily = buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T15:00:00.000Z", reason: "daily-limit" } } }));
    const interval = buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T03:05:00.000Z", reason: "min-interval" } } }));
    expect(daily.unavailable?.text).toContain("1 日の集計の上限");
    expect(daily.unavailable?.text).toContain("2026-10-11 00:00");
    expect(interval.unavailable?.text).not.toContain("1 日の集計の上限");
    expect(interval.unavailable?.text).toContain("5 分に 1 回");
    expect(interval.unavailable?.text).toContain("2026-10-10 12:05"); // 03:05Z = JST 12:05
    expect(interval.unavailable?.tone).toBe("wait");
    expect(interval.bet).toBeNull();
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

/** Issue #254: 対応表(キャリブレーション)の信頼区間・判定・補正前/補正後の切替。 */
describe("対応表の信頼区間と判定(Issue #254)", () => {
  const calib = (over: Partial<VerifyModelInput> = {}) => buildVerifyModel(input(over)).calibration!;
  const cellsOf = (row: { cells: readonly { name: string; value: string }[] } | undefined) => Object.fromEntries((row?.cells ?? []).map((c) => [c.name, c.value]));

  it("各行に 平均予測・95%区間・判定 の 3 つの cell が末尾に付き、先頭の 4 つ(予測件数・複勝件数・実複勝率・予測−実績)は旧版と同じ順", () => {
    const rows = calib().rows;
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.cells.map((c) => c.name).join() === "予測件数,複勝件数,実複勝率,予測−実績,平均予測,95%区間,判定")).toBe(true);
  });

  it("判定は 4 通り(整合・予測が高い=過信・予測が低い=過小評価・件数不足)と、件数 0 の帯の『-』。区間は Wilson(小数第 1 位のパーセント)", () => {
    const rows = calib().rows;
    // 前提(空振り防止): 4 通りすべての帯が見本にある(件数 200・120・40・4)
    expect([rows[4], rows[6], rows[14], rows[2]].map((r) => cellsOf(r)["予測件数"])).toEqual(["200件", "120件", "40件", "4件"]);
    expect(cellsOf(rows[4])).toMatchObject({ 平均予測: "22.6%", "95%区間": "17.7〜29.3%", 判定: "整合" });
    expect(cellsOf(rows[6])).toMatchObject({ 平均予測: "33.1%", "95%区間": "13.8〜28.0%", 判定: "予測が高い(過信)" });
    expect(cellsOf(rows[14])).toMatchObject({ 平均予測: "72.0%", "95%区間": "76.9〜96.0%", 判定: "予測が低い(過小評価)" });
    // 件数 4: 区間は出す(幅が広いこと自体が情報)が、判定は『件数不足』
    expect(cellsOf(rows[2])).toMatchObject({ 平均予測: "12.0%", "95%区間": "0.0〜49.0%", 判定: "件数不足(30件未満)" });
    // 件数 0: すべて -
    expect(cellsOf(rows[0])).toMatchObject({ 平均予測: "-", "95%区間": "-", 判定: "-" });
  });

  it("区間の幅は件数で決まる: 同じ実複勝率でも、件数が多い帯ほど区間が狭い(前提: 幅が 0 でない)", () => {
    const widthOf = (text: string | undefined): number => {
      const m = /^([\d.]+)〜([\d.]+)%$/.exec(text ?? "");
      if (m === null) throw new Error(`区間の形式でない: ${text}`);
      return Number(m[2]) - Number(m[1]);
    };
    const rows = calib().rows;
    // 帯 4(200 件)・帯 6(120 件)・帯 14(40 件)・帯 2(4 件)
    const widths = [4, 6, 14, 2].map((i) => widthOf(cellsOf(rows[i])["95%区間"]));
    expect(widths[0]).toBeGreaterThan(0);
    expect(widths[0]!).toBeLessThan(widths[1]!);
    expect(widths[1]!).toBeLessThan(widths[2]!);
    expect(widths[2]!).toBeLessThan(widths[3]!);
  });

  it("既定は補正後(AI)。切替の候補は 補正後(AI)・補正前(統計) の 2 つで、今のほうが current", () => {
    const m = calib();
    expect(m.targets).toEqual([
      { target: "adjusted", label: "補正後(AI)", current: true },
      { target: "prior", label: "補正前(統計)", current: false },
    ]);
    const p = calib({ calibrationTarget: "prior" });
    expect(p.targets.map((t) => t.current)).toEqual([false, true]);
  });

  it("補正前を選ぶと、priorCalibration の帯で表を作る(補正後の表とは別の件数・別の判定)。見出しは同じで、説明が変わる", () => {
    const adjusted = calib();
    const prior = calib({ calibrationTarget: "prior" });
    expect(prior.heading).toBe(adjusted.heading);
    expect(prior.rows).toHaveLength(20);
    expect(prior.rows).not.toEqual(adjusted.rows);
    expect(prior.description).not.toBe(adjusted.description);
    expect(adjusted.description).toContain("補正後");
    expect(prior.description).toContain("補正前");
    // prior の見本: 帯 3(300 件・整合)・帯 5(100 件・予測が低い)
    expect(cellsOf(prior.rows[3])).toMatchObject({ 予測件数: "300件", 実複勝率: "16.0%", 平均予測: "17.2%", "95%区間": "12.3〜20.6%", 判定: "整合" });
    expect(cellsOf(prior.rows[5])).toMatchObject({ 予測件数: "100件", 平均予測: "27.5%", "95%区間": "30.9〜49.8%", 判定: "予測が低い(過小評価)" });
    // 補正後の表で件数のある帯(4)は、補正前の表では空
    expect(cellsOf(prior.rows[4])).toMatchObject({ 予測件数: "0件", 判定: "-" });
  });

  it("件数 29 は判定しない・30 は判定する(境界)。補正前の見本の帯 9(29 件)と帯 10(30 件)", () => {
    const prior = calib({ calibrationTarget: "prior" });
    expect(cellsOf(prior.rows[9])).toMatchObject({ 予測件数: "29件", "95%区間": "19.9〜52.7%", 判定: "件数不足(30件未満)" });
    expect(cellsOf(prior.rows[10])).toMatchObject({ 予測件数: "30件", "95%区間": "7.3〜33.6%", 判定: "予測が高い(過信)" });
  });

  it("補正前の表の『予測−実績』も、補正後と同じ定義(平均予測 − 実複勝率)", () => {
    const prior = calib({ calibrationTarget: "prior" });
    // 帯 5(25〜30%): 平均予測 27.5% − 実 40.0% = -12.5pt(過小評価)
    expect(cellsOf(prior.rows[5])["予測−実績"]).toBe("-12.5pt(過小評価)");
    // 帯 3(15〜20%): 平均予測 17.2% − 実 16.0% = +1.2pt(過信)。帯の中央〈17.5%〉なら +1.5pt
    expect(cellsOf(prior.rows[3])["予測−実績"]).toBe("+1.2pt(過信)");
    expect(cellsOf(prior.rows[0])["予測−実績"]).toBe("-");
  });

  it("Issue #254(レビュー指摘): 帯の中央と平均予測がずれる行でも、『予測−実績』の向きと『判定』の向きが一致する(同じ行の『平均予測』と同じ基準で差を取る)", () => {
    // 5〜10% 帯: 中央 7.5%、平均予測 6.0%、実 7.2%(3,000 件中 216 件)。中央値基準なら +0.3pt(過信)、平均予測基準なら -1.2pt(過小評価)で、後者が判定(平均予測が区間の下)と同じ向き
    const bin = { lowerBound: 0.05, upperBound: 0.1, predictedCount: 3000, placedCount: 216, actualPlaceRate: 216 / 3000, meanPredictedProb: 0.06 };
    expect((bin.lowerBound + bin.upperBound) / 2 - bin.actualPlaceRate).toBeGreaterThan(0); // 前提: 中央値基準だと過信側(向きが逆になる入力)
    const r = report({ calibration: [bin], priorCalibration: [bin] });
    for (const target of ["adjusted", "prior"] as const) {
      const row = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, r) }, calibrationTarget: target })).calibration!.rows[0];
      expect(cellsOf(row)).toMatchObject({ "予測−実績": "-1.2pt(過小評価)", 平均予測: "6.0%", 判定: "予測が低い(過小評価)" });
    }
  });

  it("Issue #254: 判定が『予測が高い』なら予測−実績は『過信』、『予測が低い』なら『過小評価』(件数・実際の率・平均予測を総当たり。向きが逆になる行が無い)", () => {
    const counts = { high: 0, low: 0, consistent: 0, insufficient: 0 };
    for (const predicted of [29, 30, 50, 100, 400, 1000]) {
      for (let placed = 0; placed <= predicted; placed += Math.max(1, Math.floor(predicted / 20))) {
        for (let m = 0; m <= 100; m += 2) {
          const bin = { lowerBound: 0.2, upperBound: 0.25, predictedCount: predicted, placedCount: placed, actualPlaceRate: placed / predicted, meanPredictedProb: m / 100 };
          const row = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ calibration: [bin] })) } })).calibration!.rows[0];
          const c = cellsOf(row);
          if (c["判定"] === "予測が高い(過信)") {
            counts.high += 1;
            expect(c["予測−実績"], JSON.stringify(bin)).toMatch(/^\+.*\(過信\)$/);
          } else if (c["判定"] === "予測が低い(過小評価)") {
            counts.low += 1;
            expect(c["予測−実績"], JSON.stringify(bin)).toMatch(/^-.*\(過小評価\)$/);
          } else if (c["判定"] === "整合") counts.consistent += 1;
          else counts.insufficient += 1;
        }
      }
    }
    // 前提(空振り防止): 4 通りすべてが走査に十分に現れる
    expect(counts.high).toBeGreaterThan(100);
    expect(counts.low).toBeGreaterThan(100);
    expect(counts.consistent).toBeGreaterThan(100);
    expect(counts.insufficient).toBeGreaterThan(10);
  });

  it("説明文に、区間の読み方と注意(同じレースの馬は独立でないので目安・20 帯のうち 1 帯程度は偶然に区間を外れる)が入る", () => {
    for (const target of ["adjusted", "prior"] as const) {
      const d = calib({ calibrationTarget: target }).description;
      expect(d).toContain("95%区間");
      expect(d).toContain("30件未満");
      expect(d).toContain("独立");
      expect(d).toContain("1 帯程度は偶然");
    }
  });

  it("補正前の表が空(帯が 0 本)なら『データがありません。』。補正後の表は別に出せる", () => {
    const r = report({ priorCalibration: [] });
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, r) }, calibrationTarget: "prior" })).calibration!;
    expect(m.empty).toBe("データがありません。");
    expect(m.rows).toEqual([]);
    expect(buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, r) } })).calibration?.empty).toBeNull();
  });

  it("版別カードの対応表にも 平均予測・95%区間・判定 が付く(補正後の帯。補正前/補正後の切替には連動しない)", () => {
    const keys = buildVerifyModel(input()).versions?.cards.map((c) => c.key) ?? [];
    for (const target of ["adjusted", "prior"] as const) {
      const a = buildVerifyModel(input({ expandedVersions: [keys[0]!], calibrationTarget: target })).versions?.cards[0];
      expect(cellsOf(a?.calibrationRows[4])).toMatchObject({ 予測件数: "200件", "95%区間": "17.7〜29.3%", 判定: "整合" });
      expect(cellsOf(a?.calibrationRows[6])["判定"]).toBe("予測が高い(過信)");
    }
  });
});

describe("累積回収率の丸め(Issue #254・#255 からの申し送り)", () => {
  const tileValue = (rate: number | null): string | undefined => buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ bet: { betCount: 5, totalStake: 500, totalReturn: 500, recoveryRate: rate, actualPayoutCount: 1, approximatePayoutCount: 0 } })) } })).bet?.tiles.find((t) => t.label === "回収率")?.value;

  it.each([
    [0.99996, "99.99%"], // 小数第 1 位に丸めると 100.0% になる(1 未満)値は、100.0% と出さない
    [0.9996, "99.96%"],
    [1, "100.0%"], // ちょうど 1 だけが 100.0%
    [1.00004, "100.01%"], // 1 を超えて丸めると 100.0% になる値
    [1.0004, "100.04%"],
    [0.9603846, "96.0%"], // 従来どおり
    [0, "0.0%"],
    [null, "-"],
  ] as const)("累積回収率 %s → %s", (rate, expected) => {
    expect(tileValue(rate)).toBe(expected);
  });

  it("配分ベースの回収率(合算のタイルと券種別の行)も同じ丸めを使う", () => {
    const r = report({
      proposedBet: {
        ...report().proposedBet,
        overall: summary({ betCount: 300, totalStake: 100000, totalReturn: 99996, recoveryRate: 0.99996 }),
        byType: { ...report().proposedBet.byType, place: summary({ betCount: 100, recoveryRate: 1.00004 }), win: summary({ betCount: 50, recoveryRate: 0.9603846 }) },
      },
    });
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, r) } }));
    expect(m.proposed?.tiles.find((t) => t.label === "回収率")?.value).toBe("99.99%");
    expect(m.proposed?.types.find((t) => t.label === "複勝")?.rate).toBe("100.01%");
    expect(m.proposed?.types.find((t) => t.label === "単勝")?.rate).toBe("96.0%"); // 従来どおり
  });

  it("実複勝率・的中率は従来どおり formatRate(exe と同じ。丸めて 100.0% になる値もそのまま)", () => {
    expect(formatRate(0.99996)).toBe("100.0%");
  });
});

describe("Issue #263: 閲覧者(admin: false)の検証画面のモデル", () => {
  const viewer = (over: Partial<VerifyModelInput> = {}): VerifyModelInput => input({ admin: false, ...over });

  it("更新ボタンを出さない(canRefresh が false)。管理者(既定)は出す。集計の中身(タイル・対応表など)は管理者と同じ", () => {
    expect(buildVerifyModel(input()).canRefresh).toBe(true);
    const m = buildVerifyModel(viewer());
    expect(m.canRefresh).toBe(false);
    const admin = buildVerifyModel(input());
    expect(admin.bet).not.toBeNull(); // 前提(空振り防止): 集計がある
    expect(m.bet).toEqual(admin.bet);
    expect(m.proposed).toEqual(admin.proposed);
    expect(m.calibration).toEqual(admin.calibration);
    expect(m.direction).toEqual(admin.direction);
    expect(m.marks).toEqual(admin.marks);
    expect(m.computedAt).toBe(admin.computedAt);
    expect(m.venueTabs).toEqual(admin.venueTabs);
  });

  it("集計時点を出し、『管理者が更新したときの内容』であることを注記する(管理者には出さない)。古いとは言わない(stale でない)", () => {
    const m = buildVerifyModel(viewer());
    expect(m.computedAt).toBe("2026-10-10 12:00(JST)");
    const notice = m.notices.find((n) => n.text.includes("管理者が更新したときの内容"));
    expect(notice?.tone).toBe("info");
    expect(buildVerifyModel(input()).notices.some((n) => n.text.includes("管理者が更新した"))).toBe(false);
    // 集計が出ていないとき(取得中・失敗)は注記を出さない(集計時点が無いので)
    expect(buildVerifyModel(viewer({ load: { kind: "loading" } })).notices).toEqual([]);
  });

  it("集計がまだ無い(not-computed): 『まだ集計されていません』と管理者が集計することを案内する。集計・タイルは出さない。更新を促さない", () => {
    const m = buildVerifyModel(viewer({ load: { kind: "ready", outcome: { kind: "not-computed" } } }));
    expect(m.unavailable?.text).toContain("まだ集計されていません");
    expect(m.unavailable?.text).toContain("管理者");
    expect(m.unavailable?.text).not.toContain("「更新」");
    expect(m.unavailable?.tone).toBe("info");
    expect(m.bet).toBeNull();
    expect(m.proposed).toBeNull();
    expect(m.versions).toBeNull();
    expect(m.computedAt).toBeNull();
    expect(m.notices).toEqual([]);
    expect(m.canRefresh).toBe(false);
  });

  it("追加指示の全文を出さない: 要約は『あり/なし』だけ(複数あれば種類数)。版別のキャリブレーションを開いても全文の行は出ない。管理者には全文が出る(対照)", () => {
    const keys = buildVerifyModel(viewer()).versions?.cards.map((c) => c.key) ?? [];
    expect(keys).toHaveLength(3); // 前提(空振り防止): 版が 3 つ
    const closed = buildVerifyModel(viewer());
    expect(closed.versions?.cards.map((c) => c.instructions)).toEqual(["追加指示: あり / なし", "追加指示: なし", "追加指示: なし"]);
    const opened = buildVerifyModel(viewer({ expandedVersions: keys }));
    expect(opened.versions?.cards.every((c) => c.expanded && c.fullInstructions === null)).toBe(true);
    expect(opened.versions?.cards[0]?.calibrationHeading).toBe("2026-10-09.2 (追加指示: あり / なし)");
    // 生の文字列がモデルのどこにも出ない(サーバが全文を返してしまった場合でも、閲覧者の画面に出さない)
    expect(JSON.stringify(opened)).not.toContain("逃げ馬");
    // 対照: 管理者には全文が出る
    const admin = buildVerifyModel(input({ expandedVersions: keys }));
    expect(admin.versions?.cards[0]?.fullInstructions).toContain("逃げ馬を重視");
    // 追加指示が複数の種類ならその数
    const two = { ...(ready() as Extract<VerifyOutcome, { kind: "ready" }>), promptVersions: [{ ...versionsFixture()[0]!, additionalInstructions: ["a", "b", null] }] };
    expect(buildVerifyModel(viewer({ load: { kind: "ready", outcome: two } })).versions?.cards[0]?.instructions).toBe("追加指示: あり(2種類) / なし");
  });

  it("自動更新を止めた注記に、存在しない『更新』ボタンを案内しない(再読み込みを案内する)。管理者の文言は従来のまま", () => {
    expect(buildVerifyModel(viewer({ pollStopped: true })).pollNotice).not.toContain("「更新」");
    expect(buildVerifyModel(viewer({ pollStopped: true })).pollNotice).toContain("再読み込み");
    expect(buildVerifyModel(input({ pollStopped: true })).pollNotice).toContain("「更新」");
  });
});

describe("Issue #271: 版別カードに、補正前(統計モデル)の対応表と Brier を出す", () => {
  const cellsOf = (row: { cells: readonly { name: string; value: string }[] } | undefined) => Object.fromEntries((row?.cells ?? []).map((c) => [c.name, c.value]));
  const withVersions = (versions: ReturnType<typeof versionsFixture>, over: Partial<VerifyModelInput> = {}): VerifyModelInput =>
    input({ load: { kind: "ready", outcome: { ...(ready() as Extract<VerifyOutcome, { kind: "ready" }>), promptVersions: versions } }, ...over });
  const MIN_RACES = 30;

  it("閉じたカードにも Brier の 1 行を出す(補正前・補正後・頭数・レース数。レース数は集計件数)", () => {
    const [first] = buildVerifyModel(input()).versions?.cards ?? [];
    expect(first?.expanded).toBe(false); // 前提: 閉じている
    expect(first?.quality).toBe("Brier 補正前 0.1661 / 補正後 0.1655(395頭・80レース)");
  });

  it("レース数が 30 未満の版は値を隠し『レース数不足』と出す(値を持っていても出さない)", () => {
    const cards = buildVerifyModel(input()).versions?.cards ?? [];
    const insufficient = `Brier: レース数不足(${MIN_RACES}レース未満)`;
    expect(cards[1]?.quality).toBe(insufficient);
    expect(cards[2]?.quality).toBe(insufficient);
    // 前提(空振り防止): 版 3 は値を持っている=隠していることを検出できる
    expect(versionsFixture()[2]!.quality.priorBrier).toBe(0.1802);
    expect(cards[2]?.quality).not.toContain("0.18");
  });

  it.each([
    [29, false],
    [30, true],
    [31, true],
  ])("境界: レース数 %i は Brier を出す=%s", (races, shown) => {
    const v = { ...versionsFixture()[0]!, includedAnalysisCount: races };
    const card = buildVerifyModel(withVersions([v])).versions?.cards[0];
    expect(card?.quality.startsWith("Brier 補正前 0.1661")).toBe(shown);
    expect(card?.quality.includes("レース数不足")).toBe(!shown);
  });

  it("Brier は小数第 4 位に丸める。求められなかった方は - と出す(もう一方は出す)", () => {
    const v = { ...versionsFixture()[0]!, quality: { evaluatedCount: 12, priorBrier: 0.123456, adjustedBrier: null } };
    expect(buildVerifyModel(withVersions([v])).versions?.cards[0]?.quality).toBe("Brier 補正前 0.1235 / 補正後 -(12頭・80レース)");
    const w = { ...versionsFixture()[0]!, quality: { evaluatedCount: 12, priorBrier: null, adjustedBrier: 0 } };
    expect(buildVerifyModel(withVersions([w])).versions?.cards[0]?.quality).toBe("Brier 補正前 - / 補正後 0.0000(12頭・80レース)");
  });

  it("開いたカードは、補正後の表に続けて補正前の表(20 帯)を持つ。補正前の表の行は補正前の帯から作る(補正後の帯と取り違えない)", () => {
    const keys = buildVerifyModel(input()).versions?.cards.map((c) => c.key) ?? [];
    const [a] = buildVerifyModel(input({ expandedVersions: [keys[0]!] })).versions?.cards ?? [];
    expect(a?.calibrationLabel).toBe("補正後(AI)");
    expect(a?.priorCalibrationLabel).toBe("補正前(統計)");
    expect(a?.calibrationRows).toHaveLength(20);
    expect(a?.priorCalibrationRows).toHaveLength(20);
    // 補正前の帯 3(15〜20%): 300 件・複勝 48 件・区間 12.3〜20.6%・整合。補正後の帯 3 は 0 件
    expect(cellsOf(a?.priorCalibrationRows[3])).toMatchObject({ 予測件数: "300件", 複勝件数: "48件", 実複勝率: "16.0%", 平均予測: "17.2%", "95%区間": "12.3〜20.6%", 判定: "整合" });
    expect(cellsOf(a?.calibrationRows[3])["予測件数"]).toBe("0件");
    // 件数 29 は件数不足、件数 30 は判定が出る(全体の補正前の表と同じ行の作り)
    expect(cellsOf(a?.priorCalibrationRows[9])["判定"]).toBe("件数不足(30件未満)");
    expect(cellsOf(a?.priorCalibrationRows[10])["判定"]).toBe("予測が高い(過信)");
    // 全体の補正前の表(Issue #254)と同じ行の作り: 版の補正前の帯が全体のものと同じなら、行も同じ
    expect(a?.priorCalibrationRows).toEqual(buildVerifyModel(input({ calibrationTarget: "prior" })).calibration?.rows);
  });

  it("閉じたカードは補正前の表の行・ラベルを持たない。開いたカードだけが持つ", () => {
    const keys = buildVerifyModel(input()).versions?.cards.map((c) => c.key) ?? [];
    const cards = buildVerifyModel(input({ expandedVersions: [keys[0]!] })).versions?.cards ?? [];
    expect(cards[0]?.expanded).toBe(true); // 前提: 1 枚は開いている
    for (const c of cards.slice(1)) {
      expect(c.expanded).toBe(false);
      expect(c.priorCalibrationRows).toEqual([]);
      expect(c.calibrationLabel).toBeNull();
      expect(c.priorCalibrationLabel).toBeNull();
    }
  });

  it("帯が 0 本の版は『データがありません。』だけで、補正前の行・ラベルも出さない", () => {
    const v = { ...versionsFixture()[0]!, calibration: [], priorCalibration: [], overconfidenceGaps: [] };
    const key = buildVerifyModel(withVersions([v])).versions?.cards[0]?.key;
    const card = buildVerifyModel(withVersions([v], { expandedVersions: [key!] })).versions?.cards[0];
    expect(card?.calibrationEmpty).toBe("データがありません。");
    expect(card?.calibrationRows).toEqual([]);
    expect(card?.priorCalibrationRows).toEqual([]);
    expect(card?.calibrationLabel).toBeNull();
    expect(card?.priorCalibrationLabel).toBeNull();
  });

  it("版別の説明に、Brier の読み方(小さいほど良い)と、版ごとにレースが違うので差は目安であることを書く", () => {
    const description = buildVerifyModel(input()).versions?.description ?? "";
    expect(description).toContain("Brier");
    expect(description).toContain("小さいほど良い");
    expect(description).toContain("レースが違う");
  });

  it("閲覧者にも同じ Brier・補正前の表を出す(追加指示の全文だけを伏せる)", () => {
    const keys = buildVerifyModel(input()).versions?.cards.map((c) => c.key) ?? [];
    const admin = buildVerifyModel(input({ expandedVersions: [keys[0]!] })).versions?.cards[0];
    const viewer = buildVerifyModel(input({ admin: false, expandedVersions: [keys[0]!] })).versions?.cards[0];
    expect(viewer?.quality).toBe(admin?.quality);
    expect(viewer?.quality).toContain("0.1661"); // 前提(空振り防止)
    expect(viewer?.priorCalibrationRows).toEqual(admin?.priorCalibrationRows);
    expect(viewer?.priorCalibrationRows).toHaveLength(20);
    expect(admin?.fullInstructions).not.toBeNull();
    expect(viewer?.fullInstructions).toBeNull();
  });
});

describe("Issue #352: 締切直前の再計算との比較の節(model.close)", () => {
  const withClose = (close = closeFixture(), over: Partial<VerifyModelInput> = {}) => buildVerifyModel(input({ load: { kind: "ready", outcome: ready({ closeComparison: close }) }, ...over }));

  it("比較が null(再計算の行が無い・表が読めない)なら節を出さない。集計が出せない状態でも出さない", () => {
    expect(buildVerifyModel(input()).close).toBeNull();
    expect(buildVerifyModel(input({ load: { kind: "loading" } })).close).toBeNull();
    expect(buildVerifyModel(input({ load: { kind: "ready", outcome: { kind: "throttled", nextAt: "2026-10-10T03:05:00.000Z", reason: "min-interval" } } })).close).toBeNull();
  });

  it("行は 5 分前・直前。ラベルは leadMinutes から作る(直前は暫定と明記)。件数は 「ok/対象」、回収率は分析時と再計算を別の項目に、投資額は分析時と再計算の両方", () => {
    const close = withClose().close!;
    expect(close.heading).toBe("締切直前の再計算との比較");
    expect(close.rows.map((r) => r.label)).toEqual(["5分前", "直前(発走2分前・暫定)"]);
    expect(close.rows[0]!.cells).toEqual([
      { name: "件数(再計算できた/対象)", value: "12/15件" },
      { name: "回収率(分析時)", value: "90.0%" },
      { name: "回収率(再計算)", value: "110.0%" },
      { name: "投資額(分析時→再計算)", value: "12,000円→11,000円" },
      { name: "注意", value: "参考(件数が少ない)" },
    ]);
    expect(close.rows[1]!.cells.map((c) => c.value)).toEqual(["30/31件", "110.0%", "90.0%", "30,000円→29,000円"]);
  });

  it("直前のリードがサーバの値で変わると、ラベルも変わる(クライアントに分を固定しない)", () => {
    const fx = closeFixture();
    const changed = { rounds: [fx.rounds[0]!, { ...fx.rounds[1]!, leadMinutes: 3 }] };
    expect(withClose(changed).close!.rows[1]!.label).toBe("直前(発走3分前・暫定)");
  });

  it("★「参考」の印は ok の件数が 30 件未満の行だけ(29 件は付き、30 件は付かない。置き値の境界)", () => {
    const fx = closeFixture();
    const at = (okCount: number) => ({ rounds: [{ ...fx.rounds[0]!, okCount, targetCount: okCount + 1 }] });
    const hasMark = (okCount: number) => withClose(at(okCount)).close!.rows[0]!.cells.some((c) => c.name === "注意");
    expect([hasMark(0), hasMark(29), hasMark(30), hasMark(31)]).toEqual([true, true, false, false]);
  });

  it("回収率が null(ok が 0 件・賭け金 0)は「-」。ok が 0 件でも行は出る", () => {
    const fx = closeFixture();
    const empty = { betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null };
    const close = withClose({ rounds: [{ ...fx.rounds[0]!, okCount: 0, targetCount: 4, base: empty, recalc: empty }] }).close!;
    expect(close.rows[0]!.cells.map((c) => c.value).slice(0, 4)).toEqual(["0/4件", "-", "-", "0円→0円"]);
  });

  it("説明と注記は日付に依らない固定の文(件数が少ないうちは回収率の差に意味がない旨・区分に依らず中央のみの旨)。閲覧者(admin=false)にも出る", () => {
    for (const admin of [true, false]) {
      const close = withClose(closeFixture(), { admin }).close!;
      expect(close.note).toBe("件数が少ないうちは、回収率の差に意味がありません。「参考」の行は、再計算できた件数が 30 件未満です。");
      expect(close.description).toContain("中央");
      expect(close.description).toContain("区分");
      expect(`${close.description}${close.note}`).not.toMatch(/\d{1,2}\/\d{1,2}|\d{4}|月/); // 日付を含まない(古くならない)
    }
  });

  it("区分のタブに依らない(全体・中央のみ・地方のみのどれでも同じ節が出る)", () => {
    const rows = (["all", "central", "nar"] as const).map((venue) => withClose(closeFixture(), { venue }).close!.rows);
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[2]).toEqual(rows[0]);
  });
});
