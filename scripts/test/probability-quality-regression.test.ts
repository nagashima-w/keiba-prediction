/**
 * probability-quality の回帰テスト + リーク遮断の前後比較(#40「#35-1a」受け入れ条件3・4・8)。
 *
 * `packages/core` 単体では完結できない(理由): `buildPriorInput`/`computeFieldPriors` を
 * 正しく駆動するには `analysis-pipeline.ts` の `runAnalysis` と同等の組み立て
 * (venueName/venueKind/isWet の導出等)が必要で、それを `packages/core` 側で再実装すると
 * ロジックの二重化になる。既存の `scripts/bench-mixed-allocation.ts`・
 * `scripts/test/investigate-combo-odds-real-fetch.test.ts` の前例に倣い、`runAnalysis` を
 * 保存済みフィクスチャで駆動する回帰テストとしてここに置く(ネットワークには一切出ない)。
 *
 * 配置(Issue #38の教訓): `packages/app/test/`・`packages/core/test/` のヘルパを相対 import
 * しない。フィクスチャ読み込みは本ファイル内で完結させる。
 *
 * ## 計測条件(必ず併記する)
 * - フィクスチャ: `docs/investigations/combo-odds-real-fetch/central-on.json`
 *   (中央16頭・raceId=202603020211・実レース日 2026/06/28・oddsStatus="result"〈確定〉)、
 *   `nar-on.json`(地方12頭・raceId=202654071210・実レース日 2026/07/12・
 *   oddsStatus="middle"〈発売中の暫定〉)。**中央と地方は oddsStatus が異なる**(確定 vs 暫定)。
 *   着手前ゲートの実測比較(中央 vs 地方)はこの oddsStatus の違いも交絡していた点に注意
 *   (boss自己申告・鉄則7)。
 * - `runAnalysis` は `deps.analyze: null`(LLM未使用)で実行し、`priorSource: "prior-only"`。
 * - `kaisaiDate` を明示する(中央="20260628"・地方="20260712")。`dateApproximate` が
 *   `false` であることをテストで固定する(受け入れ条件3)。
 * - リーク遮断の前後比較(受け入れ条件4)は、同一 `kaisaiDate` を渡したまま
 *   `filterRaceDataBefore` の適用有無だけを変える(変数を1つだけ変える)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseKaisaiDate, type RaceData } from "../../packages/core/src/index.js";
import { filterRaceDataBefore } from "../../packages/core/src/scorer/snapshot-filter.js";
import {
  buildProbabilityQualityReport,
  type ProbabilityQualityReport,
  type ProbabilityQualityReportInput,
} from "../../packages/core/src/ev/probability-quality.js";
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../../packages/app/src/main/analysis-pipeline.js";
import type { AnalysisResult } from "../../packages/app/src/shared/analysis-types.js";

interface FixtureCase {
  readonly label: string;
  readonly fixtureFileName: string;
  /** 実レース日(YYYYMMDD)。#40 Issue本文・着手前ゲートで確認済みの実測値。 */
  readonly kaisaiDate: string;
  /**
   * 固定する期待値(受け入れ条件8: boss着手前ゲートの数値をコピーせず、本テストを実際に
   * 実行して得た値)。着手前ゲートの数値(中央 sd比0.38・ρ0.129等)とは一致しない
   * (計測条件が異なるため: ゲートは kaisaiDate=null で dateApproximate=true だった)。
   */
  readonly expected: {
    readonly spearmanRho: number;
    readonly sdRatio: number;
    readonly klModel: number;
    readonly klMarket: number;
  };
}

const FIXTURES: readonly FixtureCase[] = [
  {
    label: "中央16頭",
    fixtureFileName: "central-on.json",
    kaisaiDate: "20260628",
    expected: { spearmanRho: 0.21044891642963054, sdRatio: 0.3951025495418664, klModel: 0.015556379406077249, klMarket: 0.10397453475016975 },
  },
  {
    label: "地方12頭",
    fixtureFileName: "nar-on.json",
    kaisaiDate: "20260712",
    expected: { spearmanRho: 0.6094580274543612, sdRatio: 0.9049975491693671, klModel: 0.04075294702889696, klMarket: 0.053251532406149917 },
  },
];

/** フィクスチャ(保存済みRaceData)を読み込む。ネットワークには出ない。 */
function loadFixtureRaceData(fileName: string): RaceData {
  const url = new URL(
    `../../docs/investigations/combo-odds-real-fetch/${fileName}`,
    import.meta.url,
  );
  const raw = readFileSync(fileURLToPath(url), "utf-8");
  return JSON.parse(raw) as RaceData;
}

/** KaisaiDate(YYYYMMDD)を HorseRaceResult.date と同じ YYYY/MM/DD 形式に変換する。 */
function kaisaiDateToSlash(kaisaiDate: string): string {
  return `${kaisaiDate.slice(0, 4)}/${kaisaiDate.slice(4, 6)}/${kaisaiDate.slice(6, 8)}`;
}

/** runAnalysisをLLM未使用(deps.analyze:null)で実行する。 */
async function runWithFixture(raceData: RaceData, kaisaiDate: string): Promise<AnalysisResult> {
  const deps: AnalysisPipelineDeps = {
    scrape: async () => raceData,
    analyze: null,
    saveAnalysis: () => 0,
  };
  return runAnalysis(raceData.raceId, parseKaisaiDate(kaisaiDate), deps);
}

/** AnalysisResult + 生のRaceData(市場含意確率用)から ProbabilityQualityReportInput を組み立てる。 */
function toReportInput(
  result: AnalysisResult,
  rawRaceData: RaceData,
  leakFilter: ProbabilityQualityReportInput["leakFilter"],
): ProbabilityQualityReportInput {
  return {
    horses: result.rows.map((row) => ({
      umaban: row.umaban,
      // prior(LLM未使用のためadjustedProbと同値。priorSource:"prior-only"と整合させる)。
      modelProb: row.prior,
      // 生の OddsSnapshot.place から直接引く(AnalysisRow.placeOddsMinはyosoで推定値に
      // 置き換わるため使わない。probability-quality.tsのJSDoc「AnalysisRow.placeOddsMinは
      // 生の市場データではない」参照)。
      placeOddsMin: rawRaceData.odds.place[row.umaban]?.oddsMin ?? null,
    })),
    oddsStatus: result.oddsStatus,
    trioComboOdds: new Map(Object.entries(rawRaceData.odds.trioCombo ?? {})),
    priorSource: "prior-only",
    leakFilter,
  };
}

describe("probability-quality × 実フィクスチャの回帰(#40)", () => {
  for (const fixtureCase of FIXTURES) {
    it(`${fixtureCase.label}: kaisaiDate明示でdateApproximate=falseになり、指標値が固定される`, async () => {
      const raceData = loadFixtureRaceData(fixtureCase.fixtureFileName);
      const result = await runWithFixture(raceData, fixtureCase.kaisaiDate);

      // 受け入れ条件3: kaisaiDateを明示したのでdateApproximateはfalse。
      expect(result.dateApproximate).toBe(false);
      expect(result.oddsStatus).not.toBe("yoso");

      const input = toReportInput(result, raceData, null);
      const report = buildProbabilityQualityReport(input);

      // 計測条件が自動導出されていることの確認(受け入れ条件5)。
      expect(report.conditions.oddsStatus).toBe(result.oddsStatus);
      expect(report.conditions.fieldSize).toBe(result.rows.length);
      expect(report.conditions.leakFilterApplied).toBe(false);
      expect(report.conditions.priorSource).toBe("prior-only");

      // 市場含意確率は算出できる(yosoではないため)。
      expect(report.marketImpliedPlaceProbabilities.values).not.toBeNull();

      // 正規化KL(モデル側・市場側)は両方とも算出でき、頭数の異なる2フィクスチャに
      // 同一関数が適用できることを示す(受け入れ条件・正規化KLのスケール不変性)。
      expect(report.normalizedJointKlModel.value).not.toBeNull();
      expect(report.normalizedJointKlMarket.value).not.toBeNull();

      // 三連複の全点平均EV÷払戻率(両フィクスチャとも組合せオッズがフル網羅のため算出できる)。
      expect(report.trioAllPointEvOverPayoutRate.diagnostics.unfetchedCount).toBe(0);
      expect(report.trioAllPointEvOverPayoutRate.diagnostics.missingCount).toBe(0);
      expect(report.trioAllPointEvOverPayoutRate.diagnostics.malformedCount).toBe(0);
      expect(report.trioAllPointEvOverPayoutRate.ratio).not.toBeNull();

      // 回帰: 自分で実行して得た値を固定する(受け入れ条件8)。
      expect(report.spearmanRho.value).toBeCloseTo(fixtureCase.expected.spearmanRho, 9);
      expect(report.sdRatio.value).toBeCloseTo(fixtureCase.expected.sdRatio, 9);
      expect(report.normalizedJointKlModel.value).toBeCloseTo(fixtureCase.expected.klModel, 9);
      expect(report.normalizedJointKlMarket.value).toBeCloseTo(fixtureCase.expected.klMarket, 9);

      // 参考出力(次にこの値を見る人が実行条件を追えるように残す)。
      // eslint-disable-next-line no-console
      console.log(
        `[${fixtureCase.label} raceId=${raceData.raceId} oddsStatus=${result.oddsStatus}] ` +
          `spearmanRho=${report.spearmanRho.value} sdRatio=${report.sdRatio.value} ` +
          `klModel=${report.normalizedJointKlModel.value} klMarket=${report.normalizedJointKlMarket.value} ` +
          `trioEvOverPayout=${report.trioAllPointEvOverPayoutRate.ratio}`,
      );
    });
  }

  it("中央16頭: リーク遮断の前後で指標値が変わる(受け入れ条件4。変数はリーク遮断の有無1つだけ)", async () => {
    const fixtureCase = FIXTURES[0]!;
    const rawRaceData = loadFixtureRaceData(fixtureCase.fixtureFileName);
    const cutoffDate = kaisaiDateToSlash(fixtureCase.kaisaiDate);

    // 前提: このフィクスチャには実際にリーク(当該レース自身の着順を含む戦績)が混入している
    // ことを無条件に固定する(#40 Issue本文の実測: 出走16頭全頭が該当)。これが0件だと
    // 以降の「前後で値が変わる」主張が自明に成立してしまう。
    const { raceData: filteredRaceData, diagnostics } = filterRaceDataBefore(rawRaceData, cutoffDate);
    expect(diagnostics.removedCount).toBeGreaterThan(0);
    expect(diagnostics.perHorse.every((h) => h.removedByCutoffCount > 0)).toBe(true);
    // 回帰(自分で実行して得た値。#40 Issue本文の実測「除去対象は21走」と一致): 出走16頭全頭が
    // 該当し、除去21走のうち16走が「当該レース自身(基準日と同日)」、残り5走は基準日より
    // 後の日付(データ収集タイミングの都合で混入した未来日の走)。両方を実際に数えて固定する
    // (コメントに書くだけで assert しない、という状態を作らない)。
    expect(diagnostics.removedCount).toBe(21);
    expect(diagnostics.removedByCutoffCount).toBe(21);
    expect(diagnostics.removedByInvalidDateCount).toBe(0);
    // 注意: ここでの日付比較は本フィクスチャ固有のクロスチェック用であり、production側
    // (snapshot-filter.ts)は文字列比較を使わずdaysBetweenDatesで比較する(受け入れ条件10)。
    // central-on.jsonの日付はすべてゼロ埋め("YYYY/MM/DD")であることを確認済みのため、
    // このテストに限り文字列比較で安全に集計できる。
    const sameDayCount = rawRaceData.horses.reduce(
      (s, h) => s + (h.results ?? []).filter((r) => r.date === cutoffDate).length,
      0,
    );
    const afterCutoffCount = rawRaceData.horses.reduce(
      (s, h) => s + (h.results ?? []).filter((r) => r.date !== null && r.date > cutoffDate).length,
      0,
    );
    expect(sameDayCount).toBe(16);
    expect(afterCutoffCount).toBe(5);
    expect(sameDayCount + afterCutoffCount).toBe(diagnostics.removedByCutoffCount);

    // 同一kaisaiDateで2回実行し、変数をリーク遮断の有無1つだけに保つ。
    const rawResult = await runWithFixture(rawRaceData, fixtureCase.kaisaiDate);
    const filteredResult = await runWithFixture(filteredRaceData, fixtureCase.kaisaiDate);
    expect(rawResult.dateApproximate).toBe(false);
    expect(filteredResult.dateApproximate).toBe(false);

    const rawReport = buildProbabilityQualityReport(
      toReportInput(rawResult, rawRaceData, null),
    );
    const filteredReport = buildProbabilityQualityReport(
      toReportInput(filteredResult, rawRaceData, diagnostics),
    );

    // 前提固定: 両方とも比較対象の指標が算出できていること(nullだと差の主張が空振りになる)。
    expect(rawReport.spearmanRho.value).not.toBeNull();
    expect(filteredReport.spearmanRho.value).not.toBeNull();
    expect(rawReport.normalizedJointKlModel.value).not.toBeNull();
    expect(filteredReport.normalizedJointKlModel.value).not.toBeNull();

    // 受け入れ条件4: リーク遮断の前後で値が変わること。
    expect(filteredReport.spearmanRho.value).not.toBeCloseTo(rawReport.spearmanRho.value!, 6);
    expect(filteredReport.normalizedJointKlModel.value).not.toBeCloseTo(
      rawReport.normalizedJointKlModel.value!,
      6,
    );

    // 回帰: 自分で実行して得た値を固定する(受け入れ条件8)。
    expect(rawReport.spearmanRho.value).toBeCloseTo(0.21044891642963054, 9);
    expect(filteredReport.spearmanRho.value).toBeCloseTo(-0.005886682977052603, 9);
    expect(rawReport.normalizedJointKlModel.value).toBeCloseTo(0.015556379406077249, 9);
    expect(filteredReport.normalizedJointKlModel.value).toBeCloseTo(0.023594955525432157, 9);

    // conditionsにリーク遮断の実際の診断値が反映されていること。
    expect(filteredReport.conditions.leakFilterApplied).toBe(true);
    expect(filteredReport.conditions.removedResultCount).toBe(diagnostics.removedCount);
    expect(rawReport.conditions.leakFilterApplied).toBe(false);

    // eslint-disable-next-line no-console
    console.log(
      `[リーク遮断前後比較] raw: spearmanRho=${rawReport.spearmanRho.value} klModel=${rawReport.normalizedJointKlModel.value} / ` +
        `filtered(removed=${diagnostics.removedCount}): spearmanRho=${filteredReport.spearmanRho.value} klModel=${filteredReport.normalizedJointKlModel.value}`,
    );
  });

  it("戦績0走の馬がいてもrunAnalysisが完走しΣpriorが目標付近に収まる(boss指摘・受け入れ条件の後件を実測で固定)", async () => {
    // 「全走が除外され戦績0走になる馬がいても例外を投げずpriorが計算できること」という
    // 受け入れ条件は、filterRaceDataBefore単体(前件)のテストだけでは検証されない。
    // 後件(下流のrunAnalysis/buildPriorInput/computeFieldPriorsが実際に完走すること)を
    // ここで固定する。0走になる馬の代表例は新馬・デビュー戦の馬で、#41(サンプル拡大)では
    // 日常的に現れる(boss指摘)。
    //
    // 極端に古い基準日("1900/01/01")でfilterRaceDataBeforeを適用し、出走16頭全頭の戦績を
    // 0走にする(実データはすべて2020年代のため、この基準日なら全走が除外される)。
    const fixtureCase = FIXTURES[0]!;
    const rawRaceData = loadFixtureRaceData(fixtureCase.fixtureFileName);
    const { raceData: emptiedRaceData, diagnostics } = filterRaceDataBefore(rawRaceData, "1900/01/01");

    // 前提固定: 全頭が実際に0走になっていること(空振り防止。数馬だけ0走では検証にならない)。
    expect(emptiedRaceData.horses.length).toBeGreaterThan(0);
    expect(emptiedRaceData.horses.every((h) => (h.results?.length ?? -1) === 0)).toBe(true);
    expect(diagnostics.perHorse.every((h) => h.originalCount > 0)).toBe(true); // 除去前は戦績があった

    // 例外を投げずrunAnalysisが完走すること。
    const result = await runWithFixture(emptiedRaceData, fixtureCase.kaisaiDate);
    expect(result.rows.length).toBe(emptiedRaceData.horses.length);

    // 全馬careerRunCount=0(新馬相当)であること。
    expect(result.rows.every((row) => row.careerRunCount === 0)).toBe(true);

    // Σpriorが目標(min(3,頭数)=3)付近に収まること(prior.tsの正規化仕様)。
    const priorSum = result.rows.reduce((s, row) => s + row.prior, 0);
    expect(priorSum).toBeCloseTo(3, 1);

    // 回帰: 自分で実行して得た値を固定する(受け入れ条件8)。
    expect(priorSum).toBeCloseTo(3.000000000000001, 9);
    expect(result.rows.every((row) => row.prior > 0 && row.prior < 1)).toBe(true);
    // 参考: boss実測(中継経由・#40会話)の範囲[0.1608, 0.2142]と一致する。
    expect(Math.min(...result.rows.map((r) => r.prior))).toBeCloseTo(0.16079376854599414, 9);
    expect(Math.max(...result.rows.map((r) => r.prior))).toBeCloseTo(0.214206231454006, 9);

    // eslint-disable-next-line no-console
    console.log(
      `[戦績0走]  Σprior=${priorSum} prior範囲=[${Math.min(...result.rows.map((r) => r.prior))}, ${Math.max(...result.rows.map((r) => r.prior))}]`,
    );
  });
});
