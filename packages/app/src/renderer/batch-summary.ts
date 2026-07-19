/**
 * 一括分析のサマリ(純関数)。
 *
 * 複数レースを一括分析した結果(BatchRaceOutcome[])から、
 * - レース別ハイライト(印あり ∪ EVプラス馬。レースごとにまとめ、妙味スコア降順。Task#29)
 * - 妙味レースランキング(レース単位の妙味スコア降順)
 * - 全レース横断の「EVプラス馬サマリ」(EV降順。Discordサマリ等で引き続き使用)
 * - 成功/失敗/スキップの件数(部分失敗の集計)
 * を副作用なく導出する。表示(JSX)から集計ロジックを切り離し、単体テストで固定する。
 */

import {
  computeRaceOpportunity,
  DEFAULT_RACE_OPPORTUNITY_CONFIG,
  type RaceOpportunity,
  type RaceOpportunityConfig,
} from "@keiba/core/ev/race-opportunity";

import type {
  AnalysisResult,
  ConditionChangeTagView,
  EvPlusSummaryRow,
  PredictionMark,
} from "../shared/analysis-types.js";

/**
 * レースID(12桁)の末尾2桁からレース番号(1〜12)を取り出す(Task#29)。
 * netkeibaのレースID体系(YYYY+場コード2桁+□□2桁+□□2桁+レース番号2桁)に従い、
 * 末尾2桁を単純に数値化するだけの純関数(core の parseRaceId のような形式検証は行わない。
 * 呼び出し元は既に検証済みの AnalysisResult.raceId を渡す前提のため)。
 */
export function raceNumberFromRaceId(raceId: string): number {
  return Number(raceId.slice(10, 12));
}

/**
 * 集計が必要とする最小構造。共有の BatchRaceOutcome と renderer の BatchRaceEntry
 * (status に "pending" を含む)の双方を受け付けられるよう、構造的な型で受ける。
 */
export interface EvSummarySource {
  /** 実行状態。"success" 以外は集計対象外。 */
  readonly status: "success" | "failure" | "skipped" | "pending";
  /** 成功時の分析結果(それ以外は null)。 */
  readonly result: AnalysisResult | null;
}

/**
 * 成功レースのEVプラス馬(isPositive かつ EV が算出済み)だけを1つに集約し、EV降順に並べる。
 * EVが同値のときはレースID昇順→馬番昇順で安定に整列する(表示のブレを防ぐ)。
 * 失敗・スキップのレースは対象に含めない。
 */
export function collectEvPlusSummary(
  outcomes: readonly EvSummarySource[],
): EvPlusSummaryRow[] {
  const rows: EvPlusSummaryRow[] = [];
  for (const outcome of outcomes) {
    if (outcome.status !== "success" || outcome.result === null) {
      continue;
    }
    const result = outcome.result;
    for (const row of result.rows) {
      // EV=null(オッズ欠損)の馬は isPositive でも金額評価できないため除外する(安全側)。
      if (!row.isPositive || row.ev === null) {
        continue;
      }
      rows.push({
        raceId: result.raceId,
        venueName: result.venueName,
        raceNumber: raceNumberFromRaceId(result.raceId),
        raceName: result.raceName,
        umaban: row.umaban,
        horseName: row.horseName,
        adjustedProb: row.adjustedProb,
        placeOddsMin: row.placeOddsMin,
        ev: row.ev,
        mark: row.mark,
        evEstimated: row.evEstimated,
      });
    }
  }
  return rows.sort((a, b) => {
    if (b.ev !== a.ev) {
      return b.ev - a.ev;
    }
    if (a.raceId !== b.raceId) {
      return a.raceId < b.raceId ? -1 : 1;
    }
    return a.umaban - b.umaban;
  });
}

/** 一括分析の件数集計(部分失敗の内訳)。 */
export interface BatchSummaryCounts {
  /** 対象レース総数。 */
  readonly total: number;
  /** 成功したレース数。 */
  readonly success: number;
  /** 失敗したレース数。 */
  readonly failure: number;
  /** 中断でスキップしたレース数。 */
  readonly skipped: number;
  /** 横断でのEVプラス馬の総数。 */
  readonly evPlusCount: number;
}

/**
 * 妙味レースランキングの1行(1レース分の妙味スコアと筆頭候補)。
 * BatchAnalysisView の最上部と Discord サマリで共有する。
 */
export interface RaceOpportunityRankRow {
  /** レースID。 */
  readonly raceId: string;
  /** 会場名(レース見出しの組み立てに使う。Task#29)。 */
  readonly venueName: string;
  /** レース番号(1〜12。レース見出しの組み立てに使う。Task#29)。 */
  readonly raceNumber: number;
  /** レース名(表示用)。空文字の場合があるため、識別には venueName+raceNumber も併用する(Task#29)。 */
  readonly raceName: string;
  /** そのレースの妙味スコア計算結果(スコア・筆頭候補・除外理由など)。 */
  readonly opportunity: RaceOpportunity;
  /**
   * このレースのEVが推定値(発売前・単勝オッズからの複勝下限概算)によるものか(Task#25)。
   * true のときUIは「発売前推定」の備考を表示し、確定EVレースと区別する。
   */
  readonly evEstimated: boolean;
  /**
   * 筆頭候補馬(opportunity.bestPick)自身の条件替わり(妙味材料)タグ(妙味レースランキング用)。
   * raceId+umaban で当該レースの result.rows から筆頭候補馬自身の行を引いて取り出す。
   * bestPick が無い(スコア算出不可)、または該当馬にタグが無い場合は空配列(UIはこの場合バッジ等の
   * ノイズを出さず、筆頭候補セルを従来どおりの表示のままにする)。
   */
  readonly bestPickConditionChangeTags: readonly ConditionChangeTagView[];
}

/**
 * 成功レースそれぞれの妙味スコアを計算し、ランキング(降順)にして返す。
 * - スコアが算出できたレースをスコア降順で先頭に、算出できないレース(EVプラス0頭・yoso)を
 *   末尾に理由つきで置く。
 * - 同スコア(または双方スコアnull)は raceId 昇順で決定的に並べる(表示のブレを防ぐ)。
 * - 失敗・スキップ・未実行(pending)のレースは対象に含めない。
 * @param outcomes レースごとのアウトカム
 * @param config 妙味スコア設定(省略時は core の既定)
 */
export function rankRaceOpportunities(
  outcomes: readonly EvSummarySource[],
  config: RaceOpportunityConfig = DEFAULT_RACE_OPPORTUNITY_CONFIG,
): RaceOpportunityRankRow[] {
  const rows: RaceOpportunityRankRow[] = [];
  for (const outcome of outcomes) {
    if (outcome.status !== "success" || outcome.result === null) {
      continue;
    }
    const result = outcome.result;
    const opportunity = computeRaceOpportunity(
      result.rows.map((r) => ({
        umaban: r.umaban,
        horseName: r.horseName,
        ev: r.ev,
        adjustedProb: r.adjustedProb,
        isPositive: r.isPositive,
        careerRunCount: r.careerRunCount,
      })),
      { oddsStatus: result.oddsStatus },
      config,
    );
    // 筆頭候補馬自身の条件替わりタグを、同じレースの result.rows から raceId+umaban で引く
    // (bestPickが無ければ空配列。UIはこの場合ノイズを出さず筆頭候補セルを従来どおりにする)。
    const bestPickConditionChangeTags =
      opportunity.bestPick !== null
        ? (result.rows.find((r) => r.umaban === opportunity.bestPick!.umaban)
            ?.conditionChangeTags ?? [])
        : [];
    rows.push({
      raceId: result.raceId,
      venueName: result.venueName,
      raceNumber: raceNumberFromRaceId(result.raceId),
      raceName: result.raceName,
      opportunity,
      evEstimated: result.oddsStatus === "yoso",
      bestPickConditionChangeTags,
    });
  }
  return rows.sort((a, b) => {
    const sa = a.opportunity.score;
    const sb = b.opportunity.score;
    // スコアありをスコアなしより前に置く。
    if (sa !== null && sb === null) {
      return -1;
    }
    if (sa === null && sb !== null) {
      return 1;
    }
    // 双方スコアありならスコア降順。
    if (sa !== null && sb !== null && sa !== sb) {
      return sb - sa;
    }
    // 同スコア(または双方null)は raceId 昇順で決定的に。
    return a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0;
  });
}

/**
 * 妙味レースランキングの備考列に表示する文言を組み立てる(Task#25)。
 * - 発売前推定(evEstimated=true)なら「発売前推定」を含める。
 * - 除外理由(excludedReason)があればそれを優先して含める(低データ注記より優先。
 *   除外レースでは「なぜ算出できなかったか」の説明の方が重要なため、既存挙動を維持する)。
 * - 除外理由が無く低データ割合が0.5以上ならその注記を含める。
 * - 該当する注記が無ければ空文字(表示側は空欄にする)。
 * 複数該当する場合は " / " で連結する。
 */
export function raceOpportunityRemark(row: RaceOpportunityRankRow): string {
  const parts: string[] = [];
  if (row.evEstimated) {
    parts.push("発売前推定");
  }
  const op = row.opportunity;
  if (op.excludedReason !== null) {
    parts.push(op.excludedReason);
  } else if (op.lowDataRatio >= 0.5) {
    parts.push(`低データ馬${Math.round(op.lowDataRatio * 100)}%(推定不確実)`);
  }
  return parts.join(" / ");
}

/**
 * レース別ハイライトの1頭分(Task#29)。
 * 表示対象は「印あり(mark≠null)」∪「EVプラス(isPositive かつ ev≠null)」の和集合。
 */
export interface RaceHighlightHorseRow {
  /** 馬番。 */
  readonly umaban: number;
  /** 馬名。 */
  readonly horseName: string;
  /** 予想印(◎〇▲△☆注のいずれか。印なし・LLM未使用時は null)。 */
  readonly mark: PredictionMark | null;
  /** 補正後複勝確率(0〜1)。 */
  readonly adjustedProb: number;
  /** 複勝オッズ下限(欠損なら null)。 */
  readonly placeOddsMin: number | null;
  /** 期待値。オッズ欠損なら null(印だけで表示対象になった馬はこちらに該当し得る)。 */
  readonly ev: number | null;
  /**
   * EVが閾値を上回るか(EVプラス判定)。表示対象馬は「印あり ∪ EVプラス」の和集合のため、
   * 印はあるがEVプラスではない馬(isPositive=false かつ ev≠null。例: 本命だが過剰人気でEV1.0未満)
   * も含まれ得る。表示側のハイライト(緑背景・太字)はこの値を条件にし、ev≠null だけを条件に
   * すると「印はあるがEVプラスでない馬」を誤って妙味ありと示唆してしまうため区別する。
   */
  readonly isPositive: boolean;
  /** このEVが推定値(発売前・単勝オッズからの複勝下限概算)によるものか(Task#25)。 */
  readonly evEstimated: boolean;
  /** 条件替わり(妙味材料)タグ(サーフェス→距離→開催の固定順)。該当なしは空配列。 */
  readonly conditionChangeTags: readonly ConditionChangeTagView[];
}

/**
 * レース別ハイライトの1レース分(Task#29)。
 * ユーザー実機で「EVプラス馬サマリ(横断)」が全レース混在で見えづらいと判明したため、
 * レースごとにブロック化して表示できるよう、レース識別情報+表示対象馬をまとめて返す。
 */
export interface RaceHighlight {
  /** レースID。 */
  readonly raceId: string;
  /** 会場名。 */
  readonly venueName: string;
  /** レース名(空文字の場合がある。識別には venueName+raceNumber も併用する)。 */
  readonly raceName: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: string;
  /** 距離(m)。 */
  readonly distance: number;
  /** レース番号(1〜12)。 */
  readonly raceNumber: number;
  /** このレースのEVが推定値(発売前・単勝オッズからの複勝下限概算)によるものか(Task#25)。 */
  readonly evEstimated: boolean;
  /** このレースの妙味スコア計算結果(スコア・筆頭候補・除外理由など)。 */
  readonly opportunity: RaceOpportunity;
  /**
   * 表示対象馬(印あり ∪ EVプラス)。レース内はEV降順、EVがnull(印だけの馬)は末尾。
   * 同EV(またはEVが双方null)は馬番昇順で安定に並べる。
   */
  readonly horses: readonly RaceHighlightHorseRow[];
}

/**
 * 成功レースごとの表示対象馬(印あり ∪ EVプラス)をレース別にまとめる(Task#29)。
 *
 * - レースの並びは rankRaceOpportunities と同じ妙味スコア降順(算出不可レースは末尾、
 *   同スコア・双方nullは raceId 昇順で決定的)。ランキングの並び順をそのまま再利用することで、
 *   「妙味レースランキング」の並びとレース別ハイライトの並びが一致するようにする。
 * - 表示対象馬が1頭も無いレース(印なし・EVプラスなし)はハイライトに含めない
 *   (空ブロックを出さないため)。
 * - 失敗・スキップ・未実行(pending)のレースは対象に含めない(rankRaceOpportunities と同じ)。
 * @param outcomes レースごとのアウトカム
 * @param config 妙味スコア設定(省略時は core の既定。レースの並び順に影響する)
 */
export function collectPerRaceHighlights(
  outcomes: readonly EvSummarySource[],
  config: RaceOpportunityConfig = DEFAULT_RACE_OPPORTUNITY_CONFIG,
): RaceHighlight[] {
  const resultByRaceId = new Map<string, AnalysisResult>();
  for (const outcome of outcomes) {
    if (outcome.status === "success" && outcome.result !== null) {
      resultByRaceId.set(outcome.result.raceId, outcome.result);
    }
  }

  const highlights: RaceHighlight[] = [];
  for (const ranked of rankRaceOpportunities(outcomes, config)) {
    const result = resultByRaceId.get(ranked.raceId);
    if (result === undefined) {
      // rankRaceOpportunities は成功レースだけを返すため理論上到達しないが、安全側に読み飛ばす。
      continue;
    }
    const horses = result.rows
      .filter((r) => r.mark !== null || (r.isPositive && r.ev !== null))
      .map(
        (r): RaceHighlightHorseRow => ({
          umaban: r.umaban,
          horseName: r.horseName,
          mark: r.mark,
          adjustedProb: r.adjustedProb,
          placeOddsMin: r.placeOddsMin,
          ev: r.ev,
          isPositive: r.isPositive,
          evEstimated: r.evEstimated,
          conditionChangeTags: r.conditionChangeTags,
        }),
      )
      .sort((a, b) => {
        if (a.ev === null && b.ev === null) {
          return a.umaban - b.umaban;
        }
        if (a.ev === null) {
          return 1;
        }
        if (b.ev === null) {
          return -1;
        }
        if (b.ev !== a.ev) {
          return b.ev - a.ev;
        }
        return a.umaban - b.umaban;
      });

    if (horses.length === 0) {
      continue;
    }

    highlights.push({
      raceId: ranked.raceId,
      venueName: ranked.venueName,
      raceName: ranked.raceName,
      courseType: result.courseType,
      distance: result.distance,
      raceNumber: ranked.raceNumber,
      evEstimated: ranked.evEstimated,
      opportunity: ranked.opportunity,
      horses,
    });
  }
  return highlights;
}

/** 成功/失敗/スキップの件数とEVプラス総数を数える。 */
export function summarizeBatch(
  outcomes: readonly EvSummarySource[],
): BatchSummaryCounts {
  let success = 0;
  let failure = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    // 実行前(pending)はどのバケットにも数えない(完了後に呼ぶ想定。安全側)。
    if (outcome.status === "success") {
      success += 1;
    } else if (outcome.status === "failure") {
      failure += 1;
    } else if (outcome.status === "skipped") {
      skipped += 1;
    }
  }
  return {
    total: outcomes.length,
    success,
    failure,
    skipped,
    evPlusCount: collectEvPlusSummary(outcomes).length,
  };
}
