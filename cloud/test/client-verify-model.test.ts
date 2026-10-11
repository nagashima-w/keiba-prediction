import { describe, expect, it } from "vitest";
import type { ProposedSummaryView, VerifyOutcome, VerifyReportView } from "../client/api-verify";
import { exclusionRows, formatRate, formatUnknownBetTypeNotice, formatYen, PROPOSED_BET_LABELS, venueLabel } from "../client/verify-format";
import { buildVerifyModel, type VerifyModelInput } from "../client/verify-model";
import { calibrationFixture, priorCalibrationFixture, LONG_INSTRUCTION, trendFixture, versionsFixture } from "./verify-fixtures";

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
  kind: "ready", venue: "all", report: r, promptVersions: versionsFixture(), computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, startTimeGaps: { lost: 0, affecting: 0 }, ...over,
});

const input = (over: Partial<VerifyModelInput> = {}): VerifyModelInput => ({ load: { kind: "ready", outcome: ready() }, venue: "all", busy: false, pollStopped: false, expandedVersions: [], calibrationTarget: "adjusted", ...over });

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
    // 過信(予測 12.5% > 実 0%)
    expect(rows[2]?.cells.slice(0, 4)).toEqual([{ name: "予測件数", value: "4件" }, { name: "複勝件数", value: "0件" }, { name: "実複勝率", value: "0.0%" }, { name: "予測−実績", value: "+12.5pt(過信)" }]);
    expect(rows[2]?.bar).toEqual({ value: 0, max: 1000, label: "実複勝率 0.0%" });
    // 過小評価(予測 52.5% < 実 70%)
    expect(rows[10]?.cells[3]).toEqual({ name: "予測−実績", value: "-17.5pt(過小評価)" });
    expect(rows[10]?.bar).toEqual({ value: 700, max: 1000, label: "実複勝率 70.0%" });
    // 実複勝率がちょうど代表予測値(62.5%)= 一致
    expect(rows[12]?.cells[3]).toEqual({ name: "予測−実績", value: "+0.0pt(一致)" });
    // 41.7%(5/12)の帯グラフは四捨五入して 417
    expect(rows[8]?.bar?.value).toBe(417);
    expect(rows[19]?.bar).toEqual({ value: 1000, max: 1000, label: "実複勝率 100.0%" });
  });

  it("過信バイアスの配列が帯より短いときは、足りない帯の予測−実績を - にする(exe と同じ添字の対応)", () => {
    const r = report();
    const m = buildVerifyModel(input({ load: { kind: "ready", outcome: ready({}, report({ trend: { ...r.trend, calibrationBias: r.trend.calibrationBias.slice(0, 8) } })) } }));
    expect(m.calibration?.rows[8]?.cells[3]).toEqual({ name: "予測−実績", value: "-" });
    expect(m.calibration?.rows[2]?.cells[3]?.value).toBe("+12.5pt(過信)");
    expect(m.calibration?.rows[8]?.cells[2]?.value).toBe("41.7%"); // 実複勝率は出る
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
    // 主表と同じ行の作り(過信バイアスは版ごとの添字で対応づける)
    expect(a?.calibrationRows[2]?.cells[3]).toEqual({ name: "予測−実績", value: "+12.5pt(過信)" });
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

  it("補正前の表の『予測−実績』は、補正後の表と同じ定義(帯の中央 − 実複勝率)でクライアントが出す", () => {
    const prior = calib({ calibrationTarget: "prior" });
    // 帯 5(25〜30%): 中央 27.5% − 実 40.0% = -12.5pt(過小評価)
    expect(cellsOf(prior.rows[5])["予測−実績"]).toBe("-12.5pt(過小評価)");
    // 帯 3(15〜20%): 中央 17.5% − 実 16.0% = +1.5pt(過信)
    expect(cellsOf(prior.rows[3])["予測−実績"]).toBe("+1.5pt(過信)");
    expect(cellsOf(prior.rows[0])["予測−実績"]).toBe("-");
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
