/**
 * analysis-record — `runAnalysis`(`analysis-pipeline.ts`)が返す結果行・保存レコード・結果を組み立てる関数群(Issue #400〈R-10a。親は #390〉)。
 *
 * `runAnalysis` の手順 (5) 結果行の組み立て・(7) 保存レコードの組み立て・結果オブジェクトの組み立てを、振る舞いを変えずにここへ移した。
 * いずれも副作用のない写像で、`now()` や deps は呼ばない(時刻は呼び出し側が `analyzedAt` として渡す)。
 * 出力が変わらないことは、`pipeline-golden.json` がバイト同一であることと、既存の `analysis-pipeline*.test.ts` が固定する。
 *
 * - {@link buildAnalysisRows}: `AnalysisResult.rows`(馬番昇順)
 * - {@link buildAnalysisRecord}: `deps.saveAnalysis` に渡す `AnalysisRecord`
 * - {@link buildAnalysisResult}: `runAnalysis` の戻り値(`AnalysisResult`)
 *
 * core の名前は `runAnalysis` と同じく、狭い入口 `../pipeline.js` から取る(閉包は `cloud/test/import-guard.test.ts` が固定する)。
 */

import {
  computeConditionChangeTags,
  type AnalysisAllocationRecord,
  type AnalysisRecord,
  type KaisaiDate,
  type PredictionMark,
  type RaceData,
  type RaceId,
} from "../pipeline.js";

import type { AnalysisResult, AnalysisRow } from "./analysis-types.js";
import { buildRaceSnapshot } from "./analysis-export.js";
import { COMBO_STATS_SNAPSHOT_KEY, type ComboStats } from "./combo-stats.js";
import { conditionChangeRunsOf, winOddsOf } from "./analysis-llm-materials.js";
import type { RaceIdVenueKind } from "../scraper/ids.js";
import type { PriorResult } from "../scorer/prior.js";
import type { DayBaba } from "../analyzer/day-baba.js";
import type { HorseEv } from "../ev/expected-value.js";

/** LLM分析後の1頭分(補正後確率と根拠)。 */
export interface AdjustedHorse {
  readonly adjustedProb: number;
  readonly reason: string | null;
  /** 強調材料(Issue #197)。LLM未使用・prior採用・分析結果に含まれない馬は `[]`。 */
  readonly highlights: readonly string[];
  /** 懸念事項(Issue #197)。仕様は highlights と同じ。 */
  readonly concerns: readonly string[];
  /** 予想印(Task#23)。LLM未使用・分析結果に含まれない馬番は null。 */
  readonly mark: PredictionMark | null;
}

/** {@link buildAnalysisRows} の入力。 */
export interface BuildAnalysisRowsArgs {
  /** 先読み遮断済みのレースデータ。 */
  readonly race: RaceData;
  readonly venueKind: RaceIdVenueKind;
  /** 馬番 → prior(寄与度ログを含む)。 */
  readonly priorByUmaban: ReadonlyMap<number, PriorResult>;
  /** 馬番 → LLM 分析後の1頭分。 */
  readonly adjustedByUmaban: ReadonlyMap<number, AdjustedHorse>;
  /** 馬番 → EV。 */
  readonly evByUmaban: ReadonlyMap<number, HorseEv>;
  /** 発売前(yoso)の推定 EV か(レース単位)。 */
  readonly evEstimated: boolean;
}

/**
 * 結果行の組み立て(馬番昇順)。本来は保存の後の手順だったが、Issue #59で
 * 配分提案の算出がこの rows(MixedCandidateBuildInput の構造的最小型)を必要と
 * するため、保存(旧手順5)より前へ移動した。record 自体には依存しない純粋な写像のため、
 * 位置を上げても挙動は変わらない(#59着手前確認済み)。
 */
export function buildAnalysisRows(args: BuildAnalysisRowsArgs): AnalysisRow[] {
  const { race, venueKind, priorByUmaban, adjustedByUmaban, evByUmaban, evEstimated } = args;
  return race.horses
    .map((h) => {
      const umaban = h.shutuba.umaban;
      const prior = priorByUmaban.get(umaban)!;
      const adjusted = adjustedByUmaban.get(umaban)!;
      const ev = evByUmaban.get(umaban)!;
      return {
        umaban,
        wakuban: h.shutuba.wakuban,
        horseName: h.shutuba.name,
        prior: prior.prior,
        adjustedProb: adjusted.adjustedProb,
        placeOddsMin: ev.placeOddsMin,
        // 単勝オッズ(Issue #90・#23-B2)。yosoでも予想オッズ値が入るためそのまま渡す
        // (promptInput.horses側と同じヘルパを共有する。winOddsOfのJSDoc参照)。
        winOdds: winOddsOf(race, umaban),
        ev: ev.ev,
        isPositive: ev.isPositive,
        reason: adjusted.reason,
        highlights: adjusted.highlights,
        concerns: adjusted.concerns,
        // 戦績走数(低データ判定用)。戦績取得失敗(results=null)は不明として null にし、
        // 新馬(results=[] → 0走)と区別する(妙味スコアの低データ集計から除外させる)。
        careerRunCount: h.results === null ? null : h.results.length,
        mark: adjusted.mark,
        evEstimated,
        // 条件替わり(妙味材料)。promptInput.horses[].runConditions と同一の元データ
        // (race.race.courseType/distance・venueKind・h.results)から算出するため、
        // LLM分析を使った場合のプロンプト行(【出走馬】の「条件替わり=」)と必ず一致する。
        conditionChangeTags: computeConditionChangeTags({
          currentCourseType: race.race.courseType,
          currentDistance: race.race.distance,
          currentVenueKind: venueKind,
          pastRuns: conditionChangeRunsOf(h.results),
        }),
      };
    })
    .sort((a, b) => a.umaban - b.umaban);
}

/** {@link buildAnalysisRecord} の入力。 */
export interface BuildAnalysisRecordArgs {
  readonly raceId: RaceId;
  readonly analyzedAt: string;
  readonly evEstimated: boolean;
  /** LLM を実際に使ったか(プロンプトを送ったか)。 */
  readonly llmUsed: boolean;
  /** 使ったクリップ幅版の promptVersion(`ClipVariant.promptVersion`)。 */
  readonly promptVersion: string;
  /** トリム済みの追加指示(空文字は注入なし)。 */
  readonly trimmedInstruction: string;
  /** 選択済み開催日(必須)。 */
  readonly kaisaiDate: KaisaiDate;
  /** 戦績の絞り込みに使った基準日(YYYYMMDD)。 */
  readonly historyCutoffDate: string;
  readonly modelUsed: string | null;
  readonly rawResponse: string | null;
  /** 先読み遮断済みのレースデータ。 */
  readonly race: RaceData;
  /** LLM に渡した馬場の値(絞った後)。LLM を使わない・地方・値なしは null。 */
  readonly baba: DayBaba | null;
  /** 組合せの券種ごとの EV プラスの点数。配分の候補を作った経路だけ非 null。 */
  readonly comboStats: ComboStats | null;
  readonly priorByUmaban: ReadonlyMap<number, PriorResult>;
  readonly adjustedByUmaban: ReadonlyMap<number, AdjustedHorse>;
  readonly evByUmaban: ReadonlyMap<number, HorseEv>;
  /** 配分提案。計算しない呼び出しでは undefined(キー自体を持たせない)。 */
  readonly allocation: AnalysisAllocationRecord | undefined;
}

/** 保存レコード(`deps.saveAnalysis` に渡す `AnalysisRecord`)を組み立てる。 */
export function buildAnalysisRecord(args: BuildAnalysisRecordArgs): AnalysisRecord {
  const {
    raceId,
    analyzedAt,
    evEstimated,
    llmUsed,
    promptVersion,
    trimmedInstruction,
    kaisaiDate,
    historyCutoffDate,
    modelUsed,
    rawResponse,
    race,
    baba,
    comboStats,
    priorByUmaban,
    adjustedByUmaban,
    evByUmaban,
    allocation,
  } = args;
  return {
    raceId,
    analyzedAt,
    evEstimated,
    // プロンプト版番号(Task#27。タスクD-2でクリップ幅版に対応): LLMを実際に使った(プロンプトを
    // 送った)分析のみ、実際に使った clipVariant の promptVersion を記録する(対照なら従来どおり
    // PROMPT_VERSION と同じ値。新版〈wide15〉ならその版専用の文字列になり、verifyの版別集計
    // 〈computeVerifyReportByPromptVersion〉で対照と自動的に別グループとして比較できる)。
    // LLMスキップ(prior採用)はプロンプト自体を使っていないため null(版不明とは別の「該当なし」だが、
    // verifyの版別集計では版不明と同じ null グループにまとめて扱う)。
    promptVersion: llmUsed ? promptVersion : null,
    // 追加指示(Task#28): プロンプトを実際に送った(LLMを使った)分析のみ記録する。
    // LLMスキップ(prior採用)はプロンプト自体を使っていないため null(promptVersionと同じ方針)。
    additionalInstruction:
      llmUsed && trimmedInstruction !== "" ? trimmedInstruction : null,
    // 開催日(Task#34): 選択済み開催日(kaisaiDate引数)をそのまま保存する。
    // (analysisDate は kaisaiDate から導いた表示用の形で、季節分類等のスコアリングに使う。DB保存は生の kaisaiDate 引数を参照する)。
    // `AnalysisRecord.kaisaiDate` の型が `KaisaiDate | null` なのは、D1 に開催日が無い旧データ(null)を読むため。
    kaisaiDate,
    // 戦績の絞り込みに使った基準日(Issue #39)。kaisaiDate と同じ日付(YYYYMMDD)になる。NULL の行は先読みリーク遮断より前に作られた分析(是正前)を意味する。
    historyCutoffDate,
    // LLMプロンプト側の先読みリーク遮断を通った印(Issue #153)。新規の分析は必ず true を書く
    // (LLM未使用でも true。当日傾向は自レースより前のレース番号だけ、同レース過去傾向は当該回自身と
    // 基準日以降の回を除く経路で作られたことを示す)。NULL の行は v1.14.x 以前に保存された分析で、
    // LLM使用の分析はプロンプト側のリークを含みうる。読み出しは StoredAnalysis に追加済み(#152 A)、検証画面の集計での扱いは #152 B で配線済み(ev/verify.ts の PRODUCTION_VERIFY_CONFIG。旧 exe の pipeline-deps.ts から #219 で移した)。
    promptLookaheadGuarded: true,
    // 使用したLLMモデル名(Issue#10)。LLMを実際に使った分析のみ記録する(promptVersionと同じ方針。
    // LLMスキップ時は deps.modelName が設定されていても null にし、偽値を混入させない)。
    model: llmUsed ? modelUsed : null,
    // LLMの生応答テキスト(Issue#10)。LLMスキップ時は null(rawResponse変数はLLM使用時のみ
    // analyzeRaceの結果で上書きされる)。
    rawResponse: llmUsed ? rawResponse : null,
    // 取得したレース情報のスナップショット(Issue#10。エクスポート用、過去戦績は含めない)。
    // LLM使用有無に関わらず保存する(取得済みレース情報のため)。
    // 当日の馬場の値(Issue #295)は、LLM に渡した値(絞った後)と同じものを載せる(画面に出すのは「そのとき LLM が見た値」)。
    // 組合せの券種ごとの EV プラスの点数(Issue #296)も同じ置き場所に残す(画面の「配分の提案」の券種ごとの行に使う)。
    raceSnapshot: {
      ...buildRaceSnapshot(race),
      ...(baba !== null ? { baba } : {}),
      ...(comboStats !== null ? { [COMBO_STATS_SNAPSHOT_KEY]: comboStats } : {}),
    },
    horses: race.horses.map((h) => {
      const umaban = h.shutuba.umaban;
      const prior = priorByUmaban.get(umaban)!;
      const adjusted = adjustedByUmaban.get(umaban)!;
      const ev = evByUmaban.get(umaban)!;
      return {
        umaban,
        prior: prior.prior,
        adjustedProb: adjusted.adjustedProb,
        placeOddsMin: ev.placeOddsMin,
        ev: ev.ev,
        isPositive: ev.isPositive,
        contributions: prior.contributions,
        mark: adjusted.mark,
        // LLMが返した和文根拠(Issue#10)。LLMスキップ時は adjusted.reason が既に null
        // (LLMスキップ経路の初期化ループ参照)のため、ここで追加のllmUsed分岐は不要。
        reason: adjusted.reason,
        // 強調材料・懸念事項(Issue #197)。空配列は DB に NULL で保存される(codec)。
        highlights: adjusted.highlights,
        concerns: adjusted.concerns,
      };
    }),
    // 配分提案(Issue #59)。deps.allocationSettings===nullのときはキー自体を持たせない
    // (`allocation: undefined`という明示的な代入はしない。wideCombo等と同じ流儀)。
    ...(allocation !== undefined ? { allocation } : {}),
  };
}

/** {@link buildAnalysisResult} の入力。 */
export interface BuildAnalysisResultArgs {
  readonly raceId: RaceId;
  readonly venueName: string;
  /** 先読み遮断済みのレースデータ。 */
  readonly race: RaceData;
  /** 分析日(YYYY/MM/DD)。 */
  readonly analysisDate: string;
  readonly llmUsed: boolean;
  readonly llmSkippedReason: string | null;
  readonly fallback: boolean;
  readonly fallbackReason: string | null;
  readonly modelUsed: string | null;
  readonly rows: AnalysisRow[];
  readonly analyzedAt: string;
}

/** `runAnalysis` の戻り値(`AnalysisResult`)を組み立てる。 */
export function buildAnalysisResult(args: BuildAnalysisResultArgs): AnalysisResult {
  const {
    raceId,
    venueName,
    race,
    analysisDate,
    llmUsed,
    llmSkippedReason,
    fallback,
    fallbackReason,
    modelUsed,
    rows,
    analyzedAt,
  } = args;
  return {
    raceId,
    venueName,
    raceName: race.race.raceName,
    courseType: race.race.courseType,
    distance: race.race.distance,
    date: analysisDate,
    llmUsed,
    llmSkippedReason,
    fallback,
    fallbackReason,
    // 分析に使ったLLMモデル(Issue #157)。保存レコードの model と同じ値(LLMスキップ時は null)。
    model: llmUsed ? modelUsed : null,
    oddsStatus: race.odds.oddsStatus,
    rows,
    warnings: race.meta.warnings.map((w) => w.message),
    analyzedAt,
    // 組合せオッズ(ワイド・3連複・馬連・馬単・三連単・枠連、機能D-2c第1段・Issue #28。
    // 馬連はIssue #116・#24-D3b-1、馬単はIssue #122・#24-E2、三連単はIssue #137・#25-E2、
    // 枠連はIssue #148・#26-E2で追加): race.odds.wideCombo/trioCombo/quinellaCombo/exactaCombo/
    // trifectaCombo/bracketQuinellaCombo・race.meta.comboOdds はいずれも scrapeRace の
    // options.includeComboOdds が true のときだけ設定される optional フィールド(#33)。
    // ここでは「写し取るだけ」で新たな解釈・変換は行わない。条件付きspreadで、未設定
    // (undefined)のときはキー自体を持たせない(`wideCombo: undefined` という明示的な代入は
    // しない。`"wideCombo" in result` が false のままであることを型・値の両方で守るため。
    // scrape-race.ts の `...(wideCombo !== undefined ? { wideCombo } : {})` と同じ流儀)。
    ...(race.odds.wideCombo !== undefined ? { wideCombo: race.odds.wideCombo } : {}),
    ...(race.odds.trioCombo !== undefined ? { trioCombo: race.odds.trioCombo } : {}),
    ...(race.odds.quinellaCombo !== undefined ? { quinellaCombo: race.odds.quinellaCombo } : {}),
    ...(race.odds.exactaCombo !== undefined ? { exactaCombo: race.odds.exactaCombo } : {}),
    ...(race.odds.trifectaCombo !== undefined ? { trifectaCombo: race.odds.trifectaCombo } : {}),
    ...(race.odds.bracketQuinellaCombo !== undefined
      ? { bracketQuinellaCombo: race.odds.bracketQuinellaCombo }
      : {}),
    ...(race.meta.comboOdds !== undefined ? { comboOdds: race.meta.comboOdds } : {}),
  };
}
