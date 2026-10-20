/**
 * analysis-llm-materials — `runAnalysis`(`analysis-pipeline.ts`)が LLM に渡す材料を集める・組み立てる関数群(Issue #400〈R-10a。親は #390〉)。
 *
 * `runAnalysis` の手順 (3) LLM 分析のうち、LLM を呼ぶ前までの部分(当日傾向・重賞の過去傾向・当日の馬場の読み出しと、
 * `BuildPromptInput` の組み立て)を、振る舞いを変えずにここへ移した。出力が変わらないことは、`pipeline-golden.json` が
 * バイト同一であることと、既存の `analysis-pipeline*.test.ts` が固定する。
 *
 * - {@link loadSameDayTrend}: 当日の同一場・同一面傾向(タスク#27-C。Issue #153・#176・#177)
 * - {@link loadGradeWinnerTrend}: 同レース(重賞)の過去10年結果傾向(タスク機能B。Issue #153)
 * - {@link loadDayBaba}: 当日の馬場の値(Issue #295)
 * - {@link buildPromptInput}: 上の 3 つと prior から `BuildPromptInput` を作る純関数
 * - {@link conditionChangeRunsOf}・{@link winOddsOf}: 結果行の組み立て(`analysis-record.ts`)も使う共有のヘルパ
 *
 * deps は `AnalysisPipelineDeps` の必要な項目だけを `Pick` で受ける(`analysis-pipeline.ts` を値で import すると循環するため、型だけ import する)。
 * core の名前は `runAnalysis` と同じく、狭い入口 `../pipeline.js` から取る(閉包は `cloud/test/import-guard.test.ts` が固定する)。
 */

import {
  assessTurfWear,
  classifyRotationInterval,
  collectSameDayTrend,
  computeReferenceEv,
  daysBetweenDates,
  precedingRaceIdsSameDay,
  summarizeBestWeight,
  summarizeBodyWeightTrend,
  summarizeJockeyChange,
  summarizeMarginTrend,
  summarizeMarketGap,
  summarizeRestRecord,
  type BuildPromptInput,
  type ClipVariantId,
  type ConditionChangeRun,
  type GradeWinnerTrendSummary,
  type HorseRaceResult,
  type JockeyChangePrevRunInput,
  type KaisaiDate,
  type RaceData,
  type RaceId,
  type RaceResultDetail,
} from "../pipeline.js";

import type { AnalysisPipelineDeps } from "./analysis-pipeline.js";
import { centralVenueInfoFromRaceId, type RaceIdVenueKind } from "../scraper/ids.js";
import type { PriorResult } from "../scorer/prior.js";
import { normalizeDayBaba, selectDayBabaForCourse, type DayBaba } from "../analyzer/day-baba.js";

/** 当日の同一場・同一面傾向(`collectSameDayTrend` の戻り値。材料が足りなければ null)。 */
export type SameDayTrend = ReturnType<typeof collectSameDayTrend>;

/** 直近走(戦績の先頭)から開催日までの間隔を分類テキストにする。判定不能なら null。 */
function restIntervalOf(
  results: readonly HorseRaceResult[],
  analysisDate: string,
): string | null {
  const last = results[0];
  if (last === undefined) {
    return null;
  }
  const days = daysBetweenDates(last.date, analysisDate);
  const interval = classifyRotationInterval(days);
  return interval === "不明" ? null : interval;
}

/**
 * 戦績(新しい順)の先頭(前走=results[0])から、乗り替わり(騎手の継続/変更、タスク#8)判定用の
 * 入力を作る。戦績が取得できなかった/空(results=null/undefined/[])の馬は前走なし相当として
 * null を返す(summarizeJockeyChange側の「前走なし→null」仕様どおり)。前走(results[0])の
 * jockeyId/jockeyNameが判定不能でも、さらに過去へ遡ることはしない(「前走」ラベルに忠実。
 * summarizeJockeyChange側の設計に合わせる)。
 */
function jockeyChangePrevRunOf(
  results: readonly HorseRaceResult[] | null | undefined,
): JockeyChangePrevRunInput | null {
  const last = (results ?? [])[0];
  if (last === undefined) {
    return null;
  }
  return { jockeyId: last.jockeyId, jockeyName: last.jockeyName };
}

/**
 * 戦績(新しい順)から条件替わり(妙味材料)判定用の ConditionChangeRun 配列を作る。
 * courseType/distance/venueKind をそのまま写すだけの薄いマッピング(条件替わりタグの実際の判定は
 * core computeConditionChangeTags が行う)。戦績が取得できなかった(results=null/undefined)馬は
 * 空配列を返し、新馬相当(全タグなし)として扱う(computeConditionChangeTags側の仕様どおり)。
 */
export function conditionChangeRunsOf(
  results: readonly HorseRaceResult[] | null | undefined,
): ConditionChangeRun[] {
  return (results ?? []).map((r) => ({
    courseType: r.courseType,
    distance: r.distance,
    venueKind: r.venueKind,
  }));
}

/**
 * race.odds.win から馬番の単勝オッズを取り出す唯一のヘルパ(Issue #90・#23-B2)。
 * `promptInput.horses`(【出走馬】プロンプト用。{@link buildPromptInput} の horses の map)と
 * `rows`(`AnalysisResult.rows`。`analysis-record.ts` の `buildAnalysisRows`)の**両方**が
 * この関数を経由することで、`race.odds.win[umaban]?.odds ?? null` という式のリテラルな
 * 重複を増やさない(A-1是正・D-1・boss裁定)。`analysis-export.ts:139`にも同一の式が
 * 独立に存在するが、そちらは別プロセス境界・別責務のため統合しない(boss裁定によりスコープ外)。
 * オッズ未発売(oddsStatus="yoso")でも予想オッズ値が入ることがある(scraper側の仕様。
 * 呼び出し元コメント参照)。
 */
export function winOddsOf(race: RaceData, umaban: number): number | null {
  return race.odds.win[umaban]?.odds ?? null;
}

/**
 * 当日の同一場・同一面傾向(タスク#27-C)。getRaceResultDetail(s) が注入されているときだけ算出する
 * (未注入・prior採用のLLMスキップ経路では呼び出し側が呼ばない=無駄なDB読み出しを増やさない)。
 * 集計対象は自レースより前のレース番号だけ(Issue #153。collectSameDayTrend が
 * precedingRaceIdsSameDay で列挙する。過去のレースを後から分析しても、取込済みの後続レースの
 * 結果〈自レースの発走時点では存在しない〉は混ざらない。当日運用では後続は未取込のため不変)。
 * Issue #176: collectSameDayTrend の lookup は同期なので、前のレース分(precedingRaceIdsSameDay。collectSameDayTrend が
 * 引くのと同じ ID 列)を先に(非同期でも)読んで Map にし、それを同期の lookup として渡す。
 * 単発の getRaceResultDetail(同期。旧 exe の束縛)は従来どおり ID ごとに1回ずつ(同じ順序で)呼ぶ。非同期にしたい呼び出し側(クラウド版)は
 * バッチの getRaceResultDetails を使う。両方あればバッチを優先する。
 */
export async function loadSameDayTrend(
  raceId: RaceId,
  courseType: RaceData["race"]["courseType"],
  deps: Pick<
    AnalysisPipelineDeps,
    "getRaceResultDetail" | "getRaceResultDetails" | "onSameDayTrendError"
  >,
): Promise<SameDayTrend> {
  let sameDayTrend: SameDayTrend = null;
  if (deps.getRaceResultDetails || deps.getRaceResultDetail) {
    const precedingIds = precedingRaceIdsSameDay(raceId);
    let detailsById: ReadonlyMap<string, RaceResultDetail | undefined> | null;
    if (deps.getRaceResultDetails) {
      // バッチの読み出しの失敗(クラウド版は D1)は、当日傾向なし(null)として分析を続ける(Issue #177 の決定)。当日傾向は補助情報で、
      // これが無いだけで LLM 分析全体(実課金を伴う)を止めない。警告フックに理由を渡す。単発の getRaceResultDetail(旧 exe の同期の束縛)が
      // throw したときは、従来どおり runAnalysis が reject する(旧 exe の挙動は変えない)。
      try {
        detailsById = await deps.getRaceResultDetails(precedingIds);
      } catch (error) {
        detailsById = null;
        deps.onSameDayTrendError?.({
          raceId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      const single = deps.getRaceResultDetail!;
      const loaded = new Map<string, RaceResultDetail | undefined>();
      for (const id of precedingIds) {
        loaded.set(id, single(id));
      }
      detailsById = loaded;
    }
    if (detailsById !== null) {
      const loadedDetails = detailsById;
      sameDayTrend = collectSameDayTrend(raceId, courseType, (id) => loadedDetails.get(id));
    }
  }
  return sameDayTrend;
}

/**
 * 同レース(重賞)の過去10年結果傾向(タスク機能B)。getGradeWinnerTrend が注入され、かつ
 * 出馬表に重賞グレードバッジが無いと判定できなかったとき(hasGradeBadge!==false。true/未定義
 * ならfail-open)だけ算出する(要修正2: 非重賞への無駄なPOSTを事前に避ける。期間バッチでは
 * 無視できない件数〈約1,800本/181日〉になるため)。中央・地方(NAR)いずれも対応する
 * (2026-07-28実測訂正: 当初「地方にはこのデータが存在しない」としていたが、地方専用ホスト
 * 〈nar.netkeiba.com〉に同一パラメータでPOSTすれば取得できると判明したため、venueKindによる
 * 事前フィルタは行わない。ホストの選択は、core の scraper/fetch-grade-winner.ts が
 * urls.ts の gradeWinnerApiUrl等でrace_idから自動選択する。deps.getGradeWinnerTrend の束縛側
 * 〈クラウド版は cloud/src/race-day-core.ts。旧 exe では pipeline-deps.ts(#287 で削除。3c1664e まで)〉は fetcher を渡すだけ)。
 * 条件フィルタに渡すtrackCodeはraceId由来(要修正8。venueName〈表示専用〉はAPIのjyoと
 * 表記が一致しない場合があるため使わない)。
 * ネットワーク越しの補助材料のため、失敗してもLLM本体の分析は継続させる(nullへフォールバック)。
 * ただし例外送出時のみ onGradeWinnerTrendError で警告として残す(要修正10。正常系の
 * null返却〈非重賞NG・条件一致3回未満〉は例外を投げないため、このcatchには到達しない)。
 *
 * @param analysisDate 先読みリークの遮断(Issue #153): 戦績の絞り込み(#39)と同じ基準日。
 *   取得した過去回のうち、当該回自身・基準日と同日以降の回は集計から除かれる。
 */
export async function loadGradeWinnerTrend(
  raceId: RaceId,
  raceInfo: RaceData["race"],
  analysisDate: string,
  deps: Pick<AnalysisPipelineDeps, "getGradeWinnerTrend" | "onGradeWinnerTrendError">,
): Promise<GradeWinnerTrendSummary | null> {
  let gradeWinnerTrend: GradeWinnerTrendSummary | null = null;
  if (deps.getGradeWinnerTrend && raceInfo.hasGradeBadge !== false) {
    try {
      gradeWinnerTrend = await deps.getGradeWinnerTrend(
        raceId,
        {
          trackCode: raceId.slice(4, 6),
          track: raceInfo.courseType,
          kyori: raceInfo.distance,
        },
        // 先読みリークの遮断(Issue #153): 戦績の絞り込み(#39)と同じ基準日(analysisDate)を渡す。
        // 取得した過去回のうち、当該回自身・基準日と同日以降の回は集計から除かれる。
        analysisDate,
      );
    } catch (error) {
      gradeWinnerTrend = null;
      deps.onGradeWinnerTrendError?.({
        raceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return gradeWinnerTrend;
}

/**
 * 当日の馬場の値(Issue #295): LLM を使う中央のレースで、開催日が渡っているときだけ読む。失敗は握って値なしで続ける。
 * 返すのは LLM に渡す値(コース種別で絞った後)。読まない・地方・値なしは null。
 */
export async function loadDayBaba(
  raceId: RaceId,
  courseType: RaceData["race"]["courseType"],
  kaisaiDate: KaisaiDate | null,
  deps: Pick<AnalysisPipelineDeps, "getBabaConditions" | "onBabaError">,
): Promise<DayBaba | null> {
  let baba: DayBaba | null = null;
  const centralVenue = centralVenueInfoFromRaceId(raceId);
  if (deps.getBabaConditions && centralVenue !== null && kaisaiDate !== null) {
    try {
      baba = selectDayBabaForCourse(
        normalizeDayBaba(await deps.getBabaConditions(centralVenue.trackCode, kaisaiDate)),
        courseType,
      );
    } catch (error) {
      baba = null;
      deps.onBabaError?.({
        raceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return baba;
}

/** {@link buildPromptInput} の入力。 */
export interface BuildPromptInputArgs {
  /** 先読み遮断済みのレースデータ。 */
  readonly race: RaceData;
  readonly raceId: RaceId;
  readonly venueName: string;
  readonly venueKind: RaceIdVenueKind;
  /** 分析日(YYYY/MM/DD)。 */
  readonly analysisDate: string;
  /** 馬番 → prior。 */
  readonly priorByUmaban: ReadonlyMap<number, PriorResult>;
  readonly sameDayTrend: SameDayTrend;
  readonly gradeWinnerTrend: GradeWinnerTrendSummary | null;
  readonly baba: DayBaba | null;
  /** トリム済みの追加指示(空文字は注入なし)。 */
  readonly trimmedInstruction: string;
  readonly clipVariantId: ClipVariantId;
}

/** LLM に渡す入力(`BuildPromptInput`)を組み立てる。 */
export function buildPromptInput(args: BuildPromptInputArgs): BuildPromptInput {
  const {
    race,
    raceId,
    venueName,
    venueKind,
    analysisDate,
    priorByUmaban,
    sameDayTrend,
    gradeWinnerTrend,
    baba,
    trimmedInstruction,
    clipVariantId,
  } = args;
  return {
    race: {
      raceName: race.race.raceName,
      courseType: race.race.courseType,
      distance: race.race.distance,
      venueName,
      weather: race.race.weather ?? null,
      trackCondition: race.race.trackCondition ?? null,
      // 条件替わり(妙味材料)の中央⇄地方替わり判定に使う(build-prompt.ts computeConditionChangeTags)。
      venueKind,
      // 芝の傷み目安(タスク#26-P3): 中央芝のときだけ開催回・日次・柵の事実を1行渡す
      // (turf-wear.ts の assessTurfWear。地方・ダート・障害は null になり行自体が出ない)。
      turfWearHint: assessTurfWear(raceId, race.race.courseType, race.race.fence),
      // 当日の同一場・同一面傾向(タスク#27-C。same-day-trend.ts の collectSameDayTrend)。
      sameDayTrend,
      // 同レース(重賞)の過去10年結果傾向(タスク機能B。grade-winner-trend.ts の
      // collectGradeWinnerTrend)。
      gradeWinnerTrend,
      // 当日の馬場の値(Issue #295。コース種別で絞った値。無ければキー自体を持たせない)。
      ...(baba !== null ? { baba } : {}),
    },
    horses: race.horses.map((horseData) => {
      const umaban = horseData.shutuba.umaban;
      const prior = priorByUmaban.get(umaban)!.prior;
      // 市場データ(Task#22: 予想印の判断材料)。oddsStatus="yoso"(複勝未発売)では
      // race.odds.place が空になるため placeOddsMin/referenceEv は自然に null になる。
      // winOdds(単勝)は yoso でも予想オッズ値が入るためそのまま渡す。
      const winOdds = winOddsOf(race, umaban);
      const popularity = race.odds.win[umaban]?.ninki ?? null;
      const placeOddsMin = race.odds.place[umaban]?.oddsMin ?? null;
      return {
        umaban,
        horseName: horseData.shutuba.name,
        prior,
        oikiri: horseData.oikiri
          ? { critic: horseData.oikiri.critic, rank: horseData.oikiri.rank }
          : null,
        // 展開想定の強化(脚質精緻化・過去のペース傾向)に使う材料。pace/last3f は
        // 未取得走(海外走・地方の変則行など)では null のことがあり、その走はペース傾向の
        // 集計から自然に除外される(core analyzeHorseLegStyle/summarizePastPaceTendency側で対応)。
        runs: (horseData.results ?? []).map((r) => ({
          passing: r.passing,
          fieldSize: r.entryCount,
          pace: r.pace,
          last3f: r.last3f,
        })),
        // 戦績の走数(Issue #261。初出走の明示)。0 のときだけプロンプトの行に「戦績=初出走(出走経験なし)」が出る。
        // 戦績の取得失敗(results=null)は null(不明)にして、初出走とは書かせない。結果の行の careerRunCount
        // (`buildAnalysisRows`)と同じ元データ・同じ式。除外・取消の行は scrapeRace が除き、分析日以降は #39 が除いた後の件数。
        careerRunCount: horseData.results === null ? null : horseData.results.length,
        // 条件替わり(妙味材料)判定用の過去走条件(既存runsとは別配列。互いに影響しない)。
        runConditions: conditionChangeRunsOf(horseData.results),
        // 馬体重トレンド(タスク#6): 過去走のbodyWeight(新しい順)と当日のshutuba.bodyWeightを
        // summarizeBodyWeightTrend(core)へそのまま写す。diff(前走比の増減)は既にscorerが
        // 使用済みのため、ここではweight(絶対値)の推移をプロンプト用に表出するだけで、
        // scorer側の計算には一切影響しない。
        bodyWeightTrend: summarizeBodyWeightTrend(
          (horseData.results ?? []).map((r) => r.bodyWeight),
          horseData.shutuba.bodyWeight,
        ),
        // 人気・着順の乖離(タスク#7): 過去走のninki/finishPosition/entryCount(新しい順)を
        // summarizeMarketGap(core)へそのまま写す。ninki/entryCountは既にscraperがパース済みだが
        // scorer側で未使用のパラメータであり、ここではLLMプロンプト用に表出するだけで、
        // scorer側の計算(prior.ts・base-score.ts・bias-*.ts等)には一切影響しない。
        // 当日オッズ(winOdds/popularity)への波及もない(②は過去走由来で別軸)。
        marketGap: summarizeMarketGap(
          (horseData.results ?? []).map((r) => ({
            ninki: r.ninki,
            finishPosition: r.finishPosition,
            entryCount: r.entryCount,
          })),
        ),
        // 乗り替わり(タスク#8): 今走騎手(shutuba.jockeyId/jockeyName)と前走(results[0])騎手を
        // summarizeJockeyChange(core)へそのまま写す。jockeyId/jockeyNameは既にscraperが
        // パース済みだがscorer側で未使用のパラメータであり、ここではLLMプロンプト用に
        // 表出するだけで、scorer側の計算(prior.ts・base-score.ts・bias-*.ts等)には
        // 一切影響しない(scorerは騎手継続性を判定材料として使っていない)。
        jockeyChange: summarizeJockeyChange(
          {
            jockeyId: horseData.shutuba.jockeyId,
            jockeyName: horseData.shutuba.jockeyName,
          },
          jockeyChangePrevRunOf(horseData.results),
        ),
        // 過去走の着差傾向(タスク#9): 過去走のfinishPosition/margin(新しい順)を
        // summarizeMarginTrend(core)へそのまま写す。marginは既にscraperがパース済みだが
        // scorer側で未使用のパラメータであり、ここではLLMプロンプト用に表出するだけで、
        // scorer側の計算(prior.ts・base-score.ts・bias-*.ts等)には一切影響しない。
        marginTrend: summarizeMarginTrend(
          (horseData.results ?? []).map((r) => ({
            finishPosition: r.finishPosition,
            margin: r.margin,
          })),
        ),
        // 直近走から開催日までの間隔(仕様L100「レース間隔」)。判定不能なら未指定(「不明」表記)。
        restInterval: restIntervalOf(horseData.results ?? [], analysisDate),
        // 休み明け実績(Issue #212・#210-A): 今回が前走から71日以上のときだけ、その馬の過去の休み明けでの
        // 成績(初戦は数えない)を写す。results は #39 の基準日フィルタ済み(先読みなし)。
        // 休み明けでない馬・戦績なしは null(プロンプトにこの項目を出さない)。scorer には影響しない。
        restRecord: summarizeRestRecord(horseData.results ?? [], analysisDate),
        // ベスト体重(Issue #212・#210-A): 過去の好走(3着以内)時の体重の中央値・範囲と、今回・前走の体重の
        // 位置。今回の馬体重が未発表なら null。scorer には影響しない。
        bestWeight: summarizeBestWeight(
          (horseData.results ?? []).map((r) => ({
            bodyWeight: r.bodyWeight,
            finishPosition: r.finishPosition,
          })),
          horseData.shutuba.bodyWeight,
        ),
        winOdds,
        popularity,
        placeOddsMin,
        referenceEv: computeReferenceEv(prior, placeOddsMin),
      };
    }),
    additionalInstruction:
      trimmedInstruction === "" ? undefined : trimmedInstruction,
    // クリップ幅版(タスクD-2)。buildPrompt の【指示】【追加指示】ブロックの許容幅表記に反映される。
    clipVariant: clipVariantId,
  };
}
