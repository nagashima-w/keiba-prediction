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
 *
 * ## #39 での改訂(production が先読みリークを自分で遮断するようになった)
 * #39 で `runAnalysis` が scrape 直後に戦績を絞る(自レースの走・施行日以降の走を除く)ようになった。
 * このため本ファイルの3テストは次のとおり書き換えた。旧版が保証していたことと新版の対応:
 *
 * | 旧版の保証(#40) | 新版 |
 * |---|---|
 * | [固定値] 中央16頭・地方12頭の指標値(ρ・sd比・KL)を実行して得た値で固定。**その値はリークありの値**(中央 ρ=0.2104・klModel=0.0156、地方 ρ=0.6095・sd比=0.9050・klModel=0.0408) | 同じテストで、**遮断後(production の現在の値)**へ更新して固定(中央 ρ=-0.0059・klModel=0.0236、地方 ρ=0.5464)。klMarket は市場側でリークと無関係のため値が不変であることも同じ固定値で確認している。他の assert(dateApproximate=false・oddsStatus・conditions の導出・KL算出可・三連複EVの診断値0)は無改変 |
 * | [前後比較・前提] フィクスチャに実際にリークが混入(除去21走=自走16+施行日より後5、全頭が該当)を数えて固定 | **無改変**(生フィクスチャの事実であり、production の遮断後も変わらない) |
 * | [前後比較・主張] `runAnalysis` に生を渡した値と、`filterRaceDataBefore` 済みを渡した値が**異なる**(ρ・klModel。空振り防止に両方 null でないことも固定) | **反転**して「**同値**」(=production が既に遮断している)。空振り防止として、リークありの参照値(core の `buildPriorInput`+`computeFieldPriors` を生の戦績で直接呼んで作った prior。**コミット済みコードから再現できる**)が遮断後と**異なる**こと、かつ旧版の固定値(ρ=0.2104489…・klModel=0.0155563…)に一致することを固定。旧版が `runAnalysis` の生入力から得ていた「リークあり」の値は、`runAnalysis` からは作れなくなったため参照実装に置き換えた |
 * | [前後比較・固定値] リークあり(ρ=0.2104489…・klModel=0.0155563…)・遮断後(ρ=-0.0058866…・klModel=0.0235949…)の値を固定 | **無改変**の値を固定(リークあり側は上の参照実装から、遮断後は `runAnalysis` の生入力・絞り済み入力の両方から) |
 * | [前後比較・conditions] 遮断側で `leakFilterApplied=true`・`removedResultCount` が診断値と一致、生側で false | **無改変**(`leakFilter` は計測側が渡す診断値であり、production の遮断とは独立。#39 以降 production は常に遮断するので、生入力側の false は「診断値を渡していない」の意味) |
 * | [戦績0走] 全走を除外した馬でも完走・Σprior≈3 | 無改変 |
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPriorInput,
  classifyTrackWetness,
  computeFieldPriors,
  parseKaisaiDate,
  type RaceData,
} from "../../packages/core/src/index.js";
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
   * **#39 で更新した値**: production が先読みリークを遮断するようになったため、遮断後の値
   * (以前はリークありの値だった。詳細は冒頭の対応表)。
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
    expected: { spearmanRho: -0.007358353721315753, sdRatio: 0.4521232078462746, klModel: 0.02292214278492964, klMarket: 0.10397453475016975 },
  },
  {
    label: "地方12頭",
    fixtureFileName: "nar-on.json",
    kaisaiDate: "20260712",
    expected: { spearmanRho: 0.5288974835954514, sdRatio: 0.9879264735332672, klModel: 0.06043880053025523, klMarket: 0.053251532406149917 },
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
    // Issue #59: この回帰テストでは配分提案を検証しない(この呼び出しでは配分計算を行わない)。
    allocationSettings: null,
  };
  return runAnalysis(raceData.raceId, parseKaisaiDate(kaisaiDate), deps);
}

/** AnalysisResult + 生のRaceData(市場含意確率用)から ProbabilityQualityReportInput を組み立てる。 */
function toReportInput(
  result: Pick<AnalysisResult, "oddsStatus"> & {
    readonly rows: readonly { readonly umaban: number; readonly prior: number }[];
  },
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

/**
 * リークありの参照 prior(#39)。production は先読みリークを遮断するため、`runAnalysis` からは
 * リークありの値を作れない。そこで core の公開関数(`buildPriorInput`+`computeFieldPriors`)を
 * **生の戦績のまま**直接呼んで作る(コミット済みコードから再現できる参照実装)。
 * 中央16頭(福島・芝・単勝確定)専用: 会場名・開催区分はフィクスチャの raceId=202603020211
 * (場コード03=福島・中央)から固定値で与える。
 */
function leakyPriorRows(
  rawRaceData: RaceData,
  kaisaiDate: string,
): { umaban: number; prior: number }[] {
  const inputs = rawRaceData.horses.map((h) =>
    buildPriorInput({
      horse: h.shutuba,
      raceResults: h.results ?? [],
      race: {
        courseType: rawRaceData.race.courseType,
        distance: rawRaceData.race.distance,
        venueName: "福島",
        isWet:
          classifyTrackWetness(rawRaceData.race.trackCondition ?? null, rawRaceData.race.courseType)?.isWet ??
          false,
        date: kaisaiDateToSlash(kaisaiDate),
        venueKind: "central",
      },
      fieldSize: rawRaceData.horses.length,
    }),
  );
  const priors = computeFieldPriors(inputs);
  return rawRaceData.horses.map((h, i) => ({ umaban: h.shutuba.umaban, prior: priors[i]!.prior }));
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

  it("中央16頭: 生の戦績を渡しても遮断済みを渡しても同値になる(production が先読みリークを遮断している。リークありの参照値とは異なる。#39で旧版「前後で値が変わる」から反転)", async () => {
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

    // 同一kaisaiDateで2回実行する(生の戦績を渡す場合と、filterRaceDataBefore 済みを渡す場合)。
    // #39 以降 production が自分で遮断するため、この2つは同値になる(旧版は「異なる」だった)。
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

    // 前提固定: 比較対象の指標が算出できていること(nullだと同値の主張が空振りになる)。
    expect(rawReport.spearmanRho.value).not.toBeNull();
    expect(filteredReport.spearmanRho.value).not.toBeNull();
    expect(rawReport.normalizedJointKlModel.value).not.toBeNull();
    expect(filteredReport.normalizedJointKlModel.value).not.toBeNull();

    // 反転した主張(#39): 生の戦績を渡しても、遮断済みを渡した場合と全馬で完全に同じ prior になる
    // (production が既に遮断している)。指標だけでなく prior そのものを馬ごとに比較する。
    expect(rawResult.rows.map((r) => r.prior)).toEqual(filteredResult.rows.map((r) => r.prior));
    expect(rawReport.spearmanRho.value).toBe(filteredReport.spearmanRho.value);
    expect(rawReport.normalizedJointKlModel.value).toBe(filteredReport.normalizedJointKlModel.value);

    // 空振り防止: リークありの参照値(生の戦績を core 公開関数で直接処理した prior)が、遮断後と
    // 実際に異なる(差が0でない)こと。旧版の固定値(リークあり側)もここで再現される。
    const leakyRows = leakyPriorRows(rawRaceData, fixtureCase.kaisaiDate);
    expect(leakyRows).toHaveLength(16);
    const cleanByUmaban = new Map(rawResult.rows.map((r) => [r.umaban, r.prior]));
    expect(leakyRows.filter((r) => r.prior !== cleanByUmaban.get(r.umaban))).toHaveLength(16);
    const leakyReport = buildProbabilityQualityReport(
      toReportInput({ rows: leakyRows, oddsStatus: rawResult.oddsStatus }, rawRaceData, null),
    );
    expect(leakyReport.spearmanRho.value).not.toBeNull();
    expect(leakyReport.normalizedJointKlModel.value).not.toBeNull();
    expect(leakyReport.spearmanRho.value).not.toBeCloseTo(rawReport.spearmanRho.value!, 6);
    expect(leakyReport.normalizedJointKlModel.value).not.toBeCloseTo(
      rawReport.normalizedJointKlModel.value!,
      6,
    );

    // 回帰: 自分で実行して得た値を固定する(受け入れ条件8。リークあり側は参照実装から)。
    // Issue #213 で scorer の馬体重の減点・休み明けの一律減点を撤去したため、値を実測し直した
    // (旧: リークあり ρ=0.2104489…・klModel=0.0155563…、遮断後 ρ=-0.0058866…・klModel=0.0235949…)。
    expect(leakyReport.spearmanRho.value).toBeCloseTo(0.23693898982636727, 9);
    expect(filteredReport.spearmanRho.value).toBeCloseTo(-0.007358353721315753, 9);
    expect(leakyReport.normalizedJointKlModel.value).toBeCloseTo(0.015346756614944555, 9);
    expect(filteredReport.normalizedJointKlModel.value).toBeCloseTo(0.02292214278492964, 9);

    // conditionsにリーク遮断の実際の診断値が反映されていること。
    // (leakFilter は計測側が渡す診断値。#39 以降 production は常に遮断するので、diagnostics を
    // 渡さない生入力側の false は「診断値を渡していない」の意味で、値が遮断済みでないことではない)
    expect(filteredReport.conditions.leakFilterApplied).toBe(true);
    expect(filteredReport.conditions.removedResultCount).toBe(diagnostics.removedCount);
    expect(rawReport.conditions.leakFilterApplied).toBe(false);

    // eslint-disable-next-line no-console
    console.log(
      `[リーク遮断前後比較] leaky参照: spearmanRho=${leakyReport.spearmanRho.value} klModel=${leakyReport.normalizedJointKlModel.value} / ` +
        `production(生入力・遮断済み入力とも同値, removed=${diagnostics.removedCount}): spearmanRho=${filteredReport.spearmanRho.value} klModel=${filteredReport.normalizedJointKlModel.value}`,
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

    // Σpriorが目標(min(3,頭数)=3)付近に収まること。
    // Issue #213 以前は、馬体重の減点で raw 合計が下振れして頭数正規化(許容10%)が発動し、Σ=3 ちょうどに
    // 揃っていた(固定値 3.000000000000001)。減点の撤去後は raw 合計が許容内(偏差 1.3%)に入り正規化は
    // 発動しないので、Σ=3.04(コースレベル枠順バイアスの加算分)になる。
    const priorSum = result.rows.reduce((s, row) => s + row.prior, 0);
    expect(priorSum).toBeCloseTo(3, 1);

    // 回帰: 自分で実行して得た値を固定する(受け入れ条件8)。
    expect(priorSum).toBeCloseTo(3.04, 9);
    expect(result.rows.every((row) => row.prior > 0 && row.prior < 1)).toBe(true);
    // 参考: Issue #213 以前の範囲は [0.1608, 0.2142](boss実測。正規化後の値)。正規化が発動しなくなったので変わった。
    expect(Math.min(...result.rows.map((r) => r.prior))).toBeCloseTo(0.1675, 9);
    expect(Math.max(...result.rows.map((r) => r.prior))).toBeCloseTo(0.2075, 9);

    // eslint-disable-next-line no-console
    console.log(
      `[戦績0走]  Σprior=${priorSum} prior範囲=[${Math.min(...result.rows.map((r) => r.prior))}, ${Math.max(...result.rows.map((r) => r.prior))}]`,
    );
  });
});
