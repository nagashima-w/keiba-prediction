import { describe, expect, it } from "vitest";

import type { AnalysisResult, AnalysisRow } from "../src/shared/analysis-types.js";
import {
  BET_ALLOCATION_UNSET_NOTE,
  buildAllocationNotices,
  buildRaceAllocation,
  CROSS_RACE_OVERBET_NOTE,
  evThresholdFootnote,
  formatAllocationSummary,
  formatBetLabel,
  isBetAllocationUnset,
  KELLY_CAP_EXPLANATION_NOTE,
  placeBetUnavailableMessage,
  probabilitySumWarning,
  resolvePlaceBetTarget,
  type BetAllocationSettings,
} from "../src/renderer/bet-allocation-view.js";

/** テスト用のAnalysisRowを組み立てる補助関数。 */
function row(overrides: Partial<AnalysisRow> & { umaban: number }): AnalysisRow {
  return {
    umaban: overrides.umaban,
    wakuban: 1,
    horseName: `${overrides.umaban}番`,
    prior: 0.3,
    adjustedProb: overrides.adjustedProb ?? 0.3,
    placeOddsMin: overrides.placeOddsMin ?? 3,
    ev: overrides.ev ?? 0.9,
    isPositive: overrides.isPositive ?? false,
    reason: null,
    careerRunCount: 5,
    mark: null,
    evEstimated: overrides.evEstimated ?? false,
    conditionChangeTags: [],
  };
}

/** テスト用のAnalysisResultを組み立てる補助関数。 */
function race(overrides: Partial<AnalysisResult> & { rows: readonly AnalysisRow[] }): AnalysisResult {
  return {
    raceId: "202601010101",
    venueName: "東京",
    raceName: "テストレース",
    courseType: "芝",
    distance: 2000,
    date: "2026/07/30",
    dateApproximate: false,
    llmUsed: false,
    llmSkippedReason: null,
    fallback: false,
    fallbackReason: null,
    oddsStatus: "result",
    warnings: [],
    analyzedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

/** 候補馬(EVプラス)の行を作る補助関数。 */
function candidateRow(umaban: number, adjustedProb: number, placeOddsMin: number): AnalysisRow {
  const ev = adjustedProb * placeOddsMin;
  return row({ umaban, adjustedProb, placeOddsMin, ev, isPositive: ev > 1 });
}

/** 8頭立て(配分対象)の出走表を作る補助関数(1頭だけ候補、残りは非候補)。 */
function eightRunnersOneCandidate(): AnalysisRow[] {
  // 複勝圏内確率の合計が目標(placeCount=3)に近くなるよう、非候補7頭のadjustedProbを
  // 0.36に揃える(0.5+0.36*7=3.02、乖離0.02で確率合計警告の閾値0.3を超えない)。
  // 意図せず確率合計警告が発火するテストの汚染を避けるための調整(候補判定は
  // ev/isPositiveのデフォルト値に委ねているため、adjustedProbだけを変えても候補外のまま)。
  return [
    candidateRow(1, 0.5, 2.5),
    row({ umaban: 2, adjustedProb: 0.36 }),
    row({ umaban: 3, adjustedProb: 0.36 }),
    row({ umaban: 4, adjustedProb: 0.36 }),
    row({ umaban: 5, adjustedProb: 0.36 }),
    row({ umaban: 6, adjustedProb: 0.36 }),
    row({ umaban: 7, adjustedProb: 0.36 }),
    row({ umaban: 8, adjustedProb: 0.36 }),
  ];
}

const SETTINGS_OK: BetAllocationSettings = { bankroll: 100000, perRaceCap: 10000, kellyFraction: 0.5 };

describe("resolvePlaceBetTarget(頭数→複勝対象人数の判定。boss着手前ゲート2026-07-30で確定)", () => {
  it.each([
    { runnerCount: 0, expected: { available: false, reason: "unknown" } },
    { runnerCount: -1, expected: { available: false, reason: "unknown" } },
    { runnerCount: 7.5, expected: { available: false, reason: "unknown" } },
    { runnerCount: Number.NaN, expected: { available: false, reason: "unknown" } },
    { runnerCount: 1, expected: { available: false, reason: "not-sold" } },
    { runnerCount: 4, expected: { available: false, reason: "not-sold" } },
    { runnerCount: 5, expected: { available: false, reason: "two-place-only" } },
    { runnerCount: 7, expected: { available: false, reason: "two-place-only" } },
    { runnerCount: 8, expected: { available: true, placeCount: 3 } },
    { runnerCount: 18, expected: { available: true, placeCount: 3 } },
  ])("runnerCount=$runnerCount", ({ runnerCount, expected }) => {
    expect(resolvePlaceBetTarget(runnerCount)).toEqual(expected);
  });

  it("placeCountの型はnumber(リテラル3に固定しない。機能Dで券種ごとの発売条件を見直す余地を残す)", () => {
    const target = resolvePlaceBetTarget(8);
    if (target.available) {
      const placeCount: number = target.placeCount;
      expect(placeCount).toBe(3);
    } else {
      throw new Error("8頭はavailable:trueになるはず");
    }
  });
});

describe("placeBetUnavailableMessage(reasonコード→文言のマップ。renderer側1箇所に集約)", () => {
  it("two-place-onlyは複勝が2着までとなる旨のメッセージであること", () => {
    expect(placeBetUnavailableMessage("two-place-only")).toContain("2着まで");
  });

  it("not-soldは複勝が発売されない旨のメッセージであること", () => {
    expect(placeBetUnavailableMessage("not-sold")).toContain("発売されない");
  });

  it("unknownは取得失敗を判定結果として報告しない専用メッセージであること(「発売されない」に丸めない)", () => {
    const message = placeBetUnavailableMessage("unknown");
    expect(message).not.toContain("発売されない");
    expect(message).toContain("判定できない");
  });
});

describe("isBetAllocationUnset(総資金または1レース上限が未設定か)", () => {
  it("bankroll<=0またはperRaceCap<=0ならtrue", () => {
    expect(isBetAllocationUnset({ bankroll: 0, perRaceCap: 10000, kellyFraction: 0.5 })).toBe(true);
    expect(isBetAllocationUnset({ bankroll: 100000, perRaceCap: 0, kellyFraction: 0.5 })).toBe(true);
    expect(isBetAllocationUnset({ bankroll: -1, perRaceCap: 10000, kellyFraction: 0.5 })).toBe(true);
  });

  it("両方とも正ならfalse", () => {
    expect(isBetAllocationUnset(SETTINGS_OK)).toBe(false);
  });
});

describe("buildRaceAllocation(レース単位の配分ビュー状態)", () => {
  it("未設定(bankroll<=0またはperRaceCap<=0)ならkind='unset'を返すこと(oddsStatus・頭数に関わらず優先)", () => {
    const r = race({ rows: eightRunnersOneCandidate(), oddsStatus: "yoso" });
    const view = buildRaceAllocation(r, { bankroll: 0, perRaceCap: 10000, kellyFraction: 0.5 });
    expect(view.kind).toBe("unset");
  });

  it("oddsStatus='yoso'ならkind='yoso'を返すこと(設定は有効)", () => {
    const r = race({ rows: eightRunnersOneCandidate(), oddsStatus: "yoso" });
    const view = buildRaceAllocation(r, SETTINGS_OK);
    expect(view.kind).toBe("yoso");
  });

  it("7頭以下ならkind='unavailable'(reason='two-place-only')を返すこと", () => {
    const rows = eightRunnersOneCandidate().slice(0, 7);
    const r = race({ rows });
    const view = buildRaceAllocation(r, SETTINGS_OK);
    expect(view).toEqual({ kind: "unavailable", reason: "two-place-only" });
  });

  it("4頭以下ならkind='unavailable'(reason='not-sold')を返すこと", () => {
    const rows = eightRunnersOneCandidate().slice(0, 4);
    const r = race({ rows });
    const view = buildRaceAllocation(r, SETTINGS_OK);
    expect(view).toEqual({ kind: "unavailable", reason: "not-sold" });
  });

  it("8頭以上・oddsStatus有効・設定有効ならkind='computed'でBetAllocationResultを返すこと", () => {
    const r = race({ rows: eightRunnersOneCandidate() });
    const view = buildRaceAllocation(r, SETTINGS_OK);
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.allocations).toHaveLength(8);
      // AnalysisRow.adjustedProb が AllocationHorse.placeProb にマッピングされていること。
      const candidate = view.result.allocations.find((a) => a.umaban === 1)!;
      expect(candidate.placeProb).toBe(0.5);
    }
  });

  it("UIで妥当と判定した設定値がcoreで書き換えられないこと(result.kellyFraction===入力値)", () => {
    const r = race({ rows: eightRunnersOneCandidate() });
    const view = buildRaceAllocation(r, { bankroll: 50000, perRaceCap: 5000, kellyFraction: 0.3 });
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.kellyFraction).toBe(0.3);
      expect(view.result.bankrollInput).toBe(50000);
      expect(view.result.perRaceCapInput).toBe(5000);
    }
  });
});

describe("formatBetLabel(買い目ラベルの純関数生成。umabanをJSXに直接埋め込まない)", () => {
  it("馬番から「N番」形式のラベル文字列を作ること", () => {
    expect(formatBetLabel(4)).toBe("4番");
    expect(formatBetLabel(12)).toBe("12番");
  });
});

describe("formatAllocationSummary(合計行。capAppliedで文言切替)", () => {
  it("非拘束時はケリー適正額と1レース上限を併記し「上限に未達」を含むこと", () => {
    const r = race({ rows: eightRunnersOneCandidate() });
    const view = buildRaceAllocation(r, { bankroll: 1000000, perRaceCap: 1000000, kellyFraction: 1 });
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.capApplied).toBe(false);
      const summary = formatAllocationSummary(view.result);
      expect(summary).toContain("上限に未達");
      expect(summary).toContain("ケリー適正額");
      expect(summary).toContain("1レース上限");
    }
  });

  it("拘束時は「打ち止め」を含み、上限額とケリー適正額を併記すること", () => {
    const r = race({ rows: eightRunnersOneCandidate() });
    const view = buildRaceAllocation(r, { bankroll: 1000000, perRaceCap: 100, kellyFraction: 1 });
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.capApplied).toBe(true);
      const summary = formatAllocationSummary(view.result);
      expect(summary).toContain("打ち止め");
      expect(summary).toContain("ケリー適正額");
    }
  });
});

describe("probabilitySumWarning(確率合計警告。閾値超過かつ有限のときのみ)", () => {
  function diagnosticsWith(deviation: number, target = 3) {
    return {
      placeProbSum: target + deviation,
      placeProbSumTarget: target,
      placeProbSumDeviation: deviation,
      marginalDeviationMax: 0,
      candidateCount: 1,
      excludedCount: 0,
    };
  }

  it("閾値(0.3)の直下では警告しないこと", () => {
    expect(probabilitySumWarning(diagnosticsWith(0.29))).toBeNull();
  });

  it("閾値ちょうどでは警告しないこと(境界は含まない)", () => {
    expect(probabilitySumWarning(diagnosticsWith(0.3))).toBeNull();
  });

  it("閾値の直上(正負とも)では警告すること", () => {
    expect(probabilitySumWarning(diagnosticsWith(0.31))).not.toBeNull();
    expect(probabilitySumWarning(diagnosticsWith(-0.31))).not.toBeNull();
  });

  it("警告文言に目標値・実測値が含まれること", () => {
    const warning = probabilitySumWarning(diagnosticsWith(0.5, 3));
    expect(warning).toContain("3.00");
    expect(warning).toContain("3.50");
  });

  it("非有限値(NaN/Infinity)は画面に出さない(null)こと", () => {
    expect(probabilitySumWarning(diagnosticsWith(Number.NaN))).toBeNull();
    expect(probabilitySumWarning(diagnosticsWith(Number.POSITIVE_INFINITY))).toBeNull();
    expect(probabilitySumWarning(diagnosticsWith(Number.NEGATIVE_INFINITY))).toBeNull();
  });
});

describe("buildAllocationNotices(注記の表示順: advisory→確率合計警告→notDiversified)", () => {
  it("advisory有り・確率合計警告なし・notDiversifiedなしなら1件でadvisoryのみ", () => {
    // 単一候補・最低額が適用されadvisoryが出るケース(コアのbet-allocation.test.tsケース(a)相当)。
    const rows = eightRunnersOneCandidate();
    rows[0] = candidateRow(1, 0.5, 2.2);
    const r = race({ rows });
    const view = buildRaceAllocation(r, { bankroll: 100, perRaceCap: 100000, kellyFraction: 0.5 });
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.advisory).not.toBeNull();
      const notices = buildAllocationNotices(view.result);
      expect(notices[0]).toBe(view.result.advisory);
    }
  });

  it("advisoryがnullならnotDiversifiedより前に来ない(先頭がadvisoryでない)", () => {
    const rows = eightRunnersOneCandidate();
    const r = race({ rows });
    const view = buildRaceAllocation(r, { bankroll: 1000000, perRaceCap: 1000000, kellyFraction: 1 });
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.advisory).toBeNull();
      const notices = buildAllocationNotices(view.result);
      expect(notices).not.toContain(view.result.advisory);
    }
  });

  it("いずれの条件も満たさないときは空配列を返すこと", () => {
    const rows = eightRunnersOneCandidate();
    const r = race({ rows });
    const view = buildRaceAllocation(r, { bankroll: 1000000, perRaceCap: 1000000, kellyFraction: 1 });
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      expect(view.result.advisory).toBeNull();
      expect(view.result.notDiversified).toBe(false);
      const notices = buildAllocationNotices(view.result);
      expect(notices).toEqual([]);
    }
  });

  it("advisory!==null かつ notDiversified===true が同時成立するとき、2件とも表示されadvisoryが先頭に来ること(code-reviewer指摘: 従来は常に0/1件しか検証できていなかった)", () => {
    // 3頭が対称候補(EV=1.2)・残り5頭は非候補(確率合計が目標3に近くなるよう0.42に調整し、
    // 確率合計警告が余計に混入しないようにする)。低いbankrollで最低額ロジックが介入すると、
    // 3頭とも正のcontinuousFractionを持ちながら1頭のみに配分される(minimumStakeApplied=true
    // かつ betCount=1・positiveContinuousCount=3)ため、advisory(適正額超過)と
    // notDiversified(分散できたのに1点)が同時に成立する(tsx実測で校正済み)。
    const rows: AnalysisRow[] = [
      candidateRow(1, 0.3, 4),
      candidateRow(2, 0.3, 4),
      candidateRow(3, 0.3, 4),
      row({ umaban: 4, adjustedProb: 0.42 }),
      row({ umaban: 5, adjustedProb: 0.42 }),
      row({ umaban: 6, adjustedProb: 0.42 }),
      row({ umaban: 7, adjustedProb: 0.42 }),
      row({ umaban: 8, adjustedProb: 0.42 }),
    ];
    const r = race({ rows });
    const view = buildRaceAllocation(r, { bankroll: 100, perRaceCap: 100000, kellyFraction: 0.5 });
    expect(view.kind).toBe("computed");
    if (view.kind === "computed") {
      // 前提(無条件expect): このケースで実際に両条件が同時成立していること。
      expect(view.result.advisory).not.toBeNull();
      expect(view.result.notDiversified).toBe(true);
      const notices = buildAllocationNotices(view.result);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toBe(view.result.advisory);
      expect(notices[1]).not.toBe(view.result.advisory);
    }
  });
});

describe("固定注記3点(必ず表示。文言は数値込みで生成)", () => {
  it("KELLY_CAP_EXPLANATION_NOTEはケリー基準の説明を含むこと", () => {
    expect(KELLY_CAP_EXPLANATION_NOTE).toContain("ケリー基準");
  });

  it("CROSS_RACE_OVERBET_NOTEはレース横断オーバーベットの警告を含むこと", () => {
    expect(CROSS_RACE_OVERBET_NOTE).toContain("レースごとに独立");
  });

  it("evThresholdFootnoteはEV閾値の数値を小数第2位で埋め込むこと", () => {
    expect(evThresholdFootnote(1.05)).toContain("1.05");
    expect(evThresholdFootnote(1)).toContain("1.00");
  });
});

describe("BET_ALLOCATION_UNSET_NOTE(未設定時・画面全体で1点だけの注記)", () => {
  it("総資金・1レース上限の設定を促す文言であること", () => {
    expect(BET_ALLOCATION_UNSET_NOTE).toContain("総資金");
    expect(BET_ALLOCATION_UNSET_NOTE).toContain("1レースの上限");
  });
});
