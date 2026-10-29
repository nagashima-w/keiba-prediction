/**
 * 統計モデルの見直し用の書き出し(Issue #266。#258 の第 2 段で重みを当て直すための標本)の形式。**純関数だけ**で、D1・R2・Worker の型に触れない
 * (DO の側〈`prior-export-core.ts`〉と、開発側のローダ〈`scripts/prior-dataset.ts`〉が同じ定義を使う)。
 *
 * ## ファイル
 * NDJSON(1 行 1 頭)を gzip したもの。**gzip の複数メンバーの連結**で、先頭メンバーがメタ行(`{"_meta": {...}}`)、続くメンバーが処理の 1 回ぶん(`encodeChunk`)の行。
 * 複数メンバーの gzip は 1 回の gunzip で読める(Node の `gunzipSync`・`gunzip` コマンドとも)。1 度に全部を 1 文字列にしない(DO のメモリ 128MB のため)ための形。
 * CSV にしないのは、項目ごとの補正(`contributions`)が入れ子だから。
 *
 * ## 母集団(`selectPriorExportAnalyses`)
 * 「先読みの遮断済み」(`history_cutoff_date` あり)**または**「遮断なしでも、分析が発走より前」(検証画面と同じ `classifyLookaheadSuspicion` が clean)の分析を、レースごとに最新 1 件。
 *  - 遮断済みは検証画面の clean の部分集合ではなく、`history_cutoff_date` があれば LLM のプロンプトの遮断(`prompt_lookahead_guarded`)を問わず入れる。prior・寄与度は履歴だけから決まり、
 *    プロンプトに依らないため。`adjusted_prob` を使うときは `prompt_lookahead_guarded` で絞ること。
 *  - 遮断なしで `start_time` が NULL(検証の DO の補完待ち)の行は判定できないので入れず、`excluded.unchecked` に数える。
 *  - `leak_class`: `guarded` = `history_cutoff_date` あり(ブリーフの A の母集団)、`pre_race` = 遮断なしだが発走前の分析。
 *
 * ## 行の列(`PRIOR_ROW_KEYS`。許可リスト。テストが完全一致を固定する)
 * 追加指示・LLM の生応答・`reason` などの自由文・馬名・調教師名・設定・買い目は列にない。騎手名は format 4 から入れる(ユーザーの決定・2026-10-29、Issue #526。騎手と馬の相性・乗り替わりの検証のため)。
 *
 * ## 形式の版
 *  - v1(Issue #266): 19 列(`PRIOR_ROW_KEYS_V1`)。
 *  - v2(Issue #341): v1 の 19 列の**後ろに** 11 列(`PRIOR_ROW_KEYS_V2_ADDED`)を足した。出どころは R2 の詳細に既にある `raceSnapshot`(分析時点の出馬表。{@link toSnapshotColumns})で、
 *    **追加の R2 の取得・D1 の読み取りはない**(`decodeDetail` が既にスナップショットを持っている)。スナップショットの市場の値(単勝オッズ・人気・複勝オッズ)は取り出さない
 *    (既存の `win_odds`・`ninki` は結果ページの確定値、`place_odds_min` は分析が EV に使った値。#340 の方針「市場の値は特徴量に混ぜない」)。
 *  - v3(Issue #421 段階 1): v2 の 30 列の**後ろに** 2 列(`PRIOR_ROW_KEYS_V3_ADDED`: `weight_type`・`fillies_only`)を足した。出どころは同じく R2 の詳細の `raceSnapshot.race`
 *    (出馬表の `.RaceData02` から読んだ、負担重量の種別と牝馬限定)で、追加の取得はない。中央のレースだけ(地方・読めなかったレース・この項目を保存する前の旧スナップショットは null で、区別できない)。
 *    前走の条件の列は足していない(効果測定の時点で、スナップショットから導出して足す)。
 *  - v4(Issue #526 段階 1): v3 の 32 列の**後ろに** 2 列(`PRIOR_ROW_KEYS_V4_ADDED`: `jockey_name`・`jockey_id`)を足した。出どころは同じく R2 の詳細の `raceSnapshot.horses[]`
 *    (出馬表の今回の騎手。`jockeyName`・`jockeyId`)で、追加の取得はない。**分析時点の出馬表の騎手で、実際に乗った騎手とは限らない**(発走前の乗り替わりは反映されない)。
 *    `jockeyId` を保存し始めたのは 2026-10-29 からなので、それより前の分析は `jockey_id` だけ null(`jockey_name` は入る)。
 *    これで「馬名・騎手名・調教師名は含めない」としていた方針を、騎手名に限って変えた(馬名・調教師名は引き続き含めない)。
 */

import { classifyLookaheadSuspicion } from "../../packages/core/src/ev/lookahead-suspicion.js";
import { kaisaiDateFromNarRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import type { RaceId } from "../../packages/core/src/scraper/ids.js";
import { finiteOrNull, isRecord } from "../../packages/core/src/common/guards.js";
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst.js";
import { gzipSync } from "node:zlib";

/** ファイルの形式の版。列を足す・意味を変えるときに上げる(ローダは読めない版を例外にする)。2 = Issue #341 で出馬表の列を足した。3 = Issue #421 でレースの条件の列を足した。4 = Issue #526 で騎手名・騎手 ID の列を足した。 */
export const PRIOR_EXPORT_FORMAT = 4;

/** R2 のキー。固定(完成のたびに原子的に上書きする)。 */
export const PRIOR_EXPORT_KEY = "exports/prior-dataset.ndjson.gz";

export type LeakClass = "guarded" | "pre_race";

/** D1 の `analyses` から読む候補の行(結果のあるレースの分析だけ)。数値の真偽は D1 の 0/1/NULL のまま。 */
export interface CandidateRow {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly promptVersion: string | null;
  readonly detailKey: string | null;
  readonly evEstimated: number | null;
  readonly promptLookaheadGuarded: number | null;
  readonly historyCutoffDate: string | null;
  /** 発走時刻の写し(migration 0009): NULL = 未確認・'' = 時刻なし・'?' = 確認できず・'HH:MM'。 */
  readonly startTime: string | null;
}

/** 書き出す対象に選んだ分析。 */
export interface ChosenAnalysis {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly promptVersion: string | null;
  readonly detailKey: string | null;
  readonly evEstimated: boolean;
  readonly promptLookaheadGuarded: boolean | null;
  readonly leakClass: LeakClass;
}

export interface ExcludedCounts {
  /** 遮断なしで、分析が発走より後(先読みの疑い)。 */
  readonly suspect: number;
  /** 遮断なしで、発走の前後を判定できない(時刻なしで開催日の当日中・日付や分析日時が読めない)。 */
  readonly unknown: number;
  /** 遮断なしで、`start_time` が NULL(発走時刻の補完待ち)。 */
  readonly unchecked: number;
  /** 同じレースの、より新しい適格な分析がある。 */
  readonly superseded: number;
}

/** `start_time` が検証の読み(`verify-read.ts` の GLOB '[0-9]*:[0-9][0-9]')で時刻として使われる形か。 */
const START_TIME_LIKE = /^[0-9].*:[0-9][0-9]$/s;

/**
 * 候補から書き出す分析を選ぶ。母集団の規則はファイル先頭の説明。結果は レースID の昇順(1 レース 1 件)。
 * 除外の内訳の和 + 採用 = 候補の総数。
 */
export function selectPriorExportAnalyses(candidates: readonly CandidateRow[]): { readonly chosen: ChosenAnalysis[]; readonly excluded: ExcludedCounts } {
  let suspect = 0;
  let unknown = 0;
  let unchecked = 0;
  const eligible: ChosenAnalysis[] = [];
  for (const c of candidates) {
    const guarded = c.historyCutoffDate !== null;
    if (!guarded) {
      if (c.startTime === null) {
        unchecked += 1;
        continue;
      }
      const verdict = classifyLookaheadSuspicion({
        raceId: c.raceId,
        analyzedAt: c.analyzedAt,
        kaisaiDate: c.kaisaiDate,
        promptVersion: c.promptVersion,
        historyCutoffDate: c.historyCutoffDate,
        promptLookaheadGuarded: c.promptLookaheadGuarded === null ? null : c.promptLookaheadGuarded === 1,
        raceSnapshot: START_TIME_LIKE.test(c.startTime) ? { race: { startTime: c.startTime } } : null,
      });
      if (verdict === "suspect") {
        suspect += 1;
        continue;
      }
      if (verdict === "unknown") {
        unknown += 1;
        continue;
      }
    }
    eligible.push({
      id: c.id,
      raceId: c.raceId,
      analyzedAt: c.analyzedAt,
      kaisaiDate: c.kaisaiDate,
      promptVersion: c.promptVersion,
      detailKey: c.detailKey,
      evEstimated: c.evEstimated === 1,
      promptLookaheadGuarded: c.promptLookaheadGuarded === null ? null : c.promptLookaheadGuarded === 1,
      leakClass: guarded ? "guarded" : "pre_race",
    });
  }
  const latest = new Map<string, ChosenAnalysis>();
  for (const a of eligible) {
    const current = latest.get(a.raceId);
    if (current === undefined || a.analyzedAt > current.analyzedAt || (a.analyzedAt === current.analyzedAt && a.id > current.id)) {
      latest.set(a.raceId, a);
    }
  }
  const chosen = [...latest.values()].sort((x, y) => (x.raceId < y.raceId ? -1 : x.raceId > y.raceId ? 1 : 0));
  return { chosen, excluded: { suspect, unknown, unchecked, superseded: eligible.length - chosen.length } };
}

/** 項目ごとの補正(寄与度ログの 1 項目)。自由文の `reason` は含めない。 */
export interface PriorContribution {
  readonly biasName: string;
  readonly applied: boolean;
  readonly weight: number | null;
  readonly correction: number | null;
  readonly sampleCount: number | null;
  readonly targetRate: number | null;
  readonly overallRate: number | null;
}

/**
 * R2 の詳細に入っている馬 1 頭の寄与度(core の `ScoreContribution[]`)を、書き出す形にする。
 * 配列でない・項目が壊れている(オブジェクトでない・`biasName` が文字列でない)ときは null(想定外の形を推測で直さない)。
 */
export function toContributions(raw: unknown): PriorContribution[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: PriorContribution[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>)["biasName"] !== "string") {
      return null;
    }
    const o = item as Record<string, unknown>;
    out.push({
      biasName: o["biasName"] as string,
      applied: o["applied"] === true,
      weight: finiteOrNull(o["weight"]),
      correction: finiteOrNull(o["correction"]),
      sampleCount: finiteOrNull(o["sampleCount"]),
      targetRate: finiteOrNull(o["targetRate"]),
      overallRate: finiteOrNull(o["overallRate"]),
    });
  }
  return out;
}

/** 形式 v1 の行の列(19 列。凍結: v1 のファイルを読むローダが使う。変えない)。 */
export const PRIOR_ROW_KEYS_V1 = [
  "analysis_id",
  "race_id",
  "kaisai_date",
  "venue_kind",
  "course_type",
  "field_size",
  "umaban",
  "prior",
  "adjusted_prob",
  "place_odds_min",
  "contributions",
  "finish_position",
  "win_odds",
  "ninki",
  "prompt_version",
  "analyzed_at",
  "ev_estimated",
  "prompt_lookahead_guarded",
  "leak_class",
] as const;

/** 形式 v2 で足した列(11 列。v1 の列の後ろに、この順で並ぶ)。馬名・騎手名・調教師名・市場の値は含めない。 */
export const PRIOR_ROW_KEYS_V2_ADDED = [
  "race_name",
  "grade",
  "distance",
  "track_condition",
  "wakuban",
  "sex",
  "age",
  "body_weight",
  "kinryo",
  "oikiri_rank",
  "oikiri_critic",
] as const;

/** 形式 v3 で足した列(2 列。v2 の列の後ろに、この順で並ぶ)。レースの条件(Issue #421 段階 1)。 */
export const PRIOR_ROW_KEYS_V3_ADDED = ["weight_type", "fillies_only"] as const;

/** 形式 v4 で足した列(2 列。v3 の列の後ろに、この順で並ぶ)。今回の騎手(Issue #526 段階 1)。 */
export const PRIOR_ROW_KEYS_V4_ADDED = ["jockey_name", "jockey_id"] as const;

/** 書き出す行の列(この順で JSON にする)。許可リスト。v1 の 19 列 + v2 で足した 11 列 + v3 で足した 2 列 + v4 で足した 2 列。 */
export const PRIOR_ROW_KEYS = [...PRIOR_ROW_KEYS_V1, ...PRIOR_ROW_KEYS_V2_ADDED, ...PRIOR_ROW_KEYS_V3_ADDED, ...PRIOR_ROW_KEYS_V4_ADDED] as const;

/** レースごとの出馬表の列(スナップショットの `race`。全頭に同じ値が入る)。 */
export interface PriorRaceColumns {
  readonly race_name: string | null;
  /** グレード("G1"〜"G3"・"Jpn1"・"重賞" など)。キー自体が無い(グレードなし・#250 より前の旧スナップショット)ときは null で、この 2 つは区別できない。 */
  readonly grade: string | null;
  readonly distance: number | null;
  /** 分析時点の馬場状態(確定値ではない)。 */
  readonly track_condition: string | null;
}

/** 馬ごとの出馬表の列(スナップショットの `horses[]`)。 */
export interface PriorHorseColumns {
  readonly wakuban: number | null;
  readonly sex: string | null;
  readonly age: number | null;
  /** 馬体重(kg。増減は保存していない)。未発表(前日の分析など)は null。 */
  readonly body_weight: number | null;
  /** 斤量(kg)。 */
  readonly kinryo: number | null;
  /** 調教ランク(A・B・C)。地方は調教を取らないので常に null。 */
  readonly oikiri_rank: string | null;
  /** 調教の短評(netkeiba の定型句。{@link CRITIC_MAX_LENGTH} 文字を超えるものは自由文の疑いで null)。地方は常に null。 */
  readonly oikiri_critic: string | null;
}

/** レースの条件の列(v3。スナップショットの `race`。全頭に同じ値が入る)。 */
export interface PriorConditionColumns {
  /** 負担重量の種別("ハンデ"・"別定"・"定量"・"馬齢")。地方・読めなかったレース・旧スナップショットは null(区別できない)。 */
  readonly weight_type: string | null;
  /** 牝馬限定か。キーが無い(地方・読めなかった・旧スナップショット)ときは null で、false(牝馬限定でない)とは別。 */
  readonly fillies_only: boolean | null;
}

/** 今回の騎手の列(v4。スナップショットの `horses[]`)。 */
export interface PriorJockeyColumns {
  /** 今回の騎手名(分析時点の出馬表の値。実際に乗った騎手とは限らない)。騎手未定・型が違う値は null。 */
  readonly jockey_name: string | null;
  /** 今回の騎手の ID(netkeiba の騎手 ID)。2026-10-29 より前の旧スナップショット・騎手のリンクが無い馬・型が違う値は null(区別できない)。 */
  readonly jockey_id: string | null;
}

/** スナップショットから取り出した列: レースの列(v2)と、馬番 → 馬の列(v2)と、レースの条件の列(v3)と、馬番 → 騎手の列(v4。`horses` と同じ馬番の集合)。 */
export interface PriorSnapshotColumns {
  readonly race: PriorRaceColumns;
  readonly horses: ReadonlyMap<number, PriorHorseColumns>;
  readonly conditions: PriorConditionColumns;
  readonly jockeys: ReadonlyMap<number, PriorJockeyColumns>;
}

/** `oikiri_critic` の最大文字数(コードポイント)。超える値は自由文の疑いで null にする(実フィクスチャの 16 頭では 4 文字前後の定型句だった。語彙が閉じていることは確認していない)。 */
export const CRITIC_MAX_LENGTH = 16;

const NULL_RACE_COLUMNS: PriorRaceColumns = { race_name: null, grade: null, distance: null, track_condition: null };
const NULL_CONDITION_COLUMNS: PriorConditionColumns = { weight_type: null, fillies_only: null };
const NULL_JOCKEY_COLUMNS: PriorJockeyColumns = { jockey_name: null, jockey_id: null };
const NULL_HORSE_COLUMNS: PriorHorseColumns = { wakuban: null, sex: null, age: null, body_weight: null, kinryo: null, oikiri_rank: null, oikiri_critic: null };

const nonEmptyStringOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const integerOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * R2 の詳細の `raceSnapshot`(core の `buildRaceSnapshot` の形。型は未検証の unknown)から、v2・v3・v4 の列を取り出す。純関数。
 * **想定外の形・型は例外にせず、その列だけ null**(`toContributions` と同じ「推測で直さない」)。スナップショット全体が無い・壊れているときは全列 null・馬は 0 頭。
 * 取り出すのは {@link PRIOR_ROW_KEYS_V2_ADDED}・{@link PRIOR_ROW_KEYS_V3_ADDED}・{@link PRIOR_ROW_KEYS_V4_ADDED} の列だけ。馬名・調教師名・単勝オッズ・人気・複勝オッズ(分析時点の市場の値)は読まない。
 * 馬番が整数でない要素は飛ばし、馬番が重複したら最初の 1 頭を使う。
 */
export function toSnapshotColumns(raw: unknown): PriorSnapshotColumns {
  if (!isRecord(raw)) {
    return { race: NULL_RACE_COLUMNS, horses: new Map(), conditions: NULL_CONDITION_COLUMNS, jockeys: new Map() };
  }
  const race = isRecord(raw["race"])
    ? {
        race_name: nonEmptyStringOrNull(raw["race"]["raceName"]),
        grade: nonEmptyStringOrNull(raw["race"]["grade"]),
        distance: integerOrNull(raw["race"]["distance"]),
        track_condition: nonEmptyStringOrNull(raw["race"]["trackCondition"]),
      }
    : NULL_RACE_COLUMNS;
  const conditions: PriorConditionColumns = isRecord(raw["race"])
    ? {
        weight_type: nonEmptyStringOrNull(raw["race"]["weightType"]),
        fillies_only: typeof raw["race"]["filliesOnly"] === "boolean" ? raw["race"]["filliesOnly"] : null,
      }
    : NULL_CONDITION_COLUMNS;
  const horses = new Map<number, PriorHorseColumns>();
  const jockeys = new Map<number, PriorJockeyColumns>();
  if (Array.isArray(raw["horses"])) {
    for (const h of raw["horses"] as unknown[]) {
      if (!isRecord(h)) {
        continue;
      }
      const umaban = integerOrNull(h["umaban"]);
      if (umaban === null || horses.has(umaban)) {
        continue;
      }
      const critic = nonEmptyStringOrNull(h["oikiriCritic"]);
      horses.set(umaban, {
        wakuban: integerOrNull(h["wakuban"]),
        sex: nonEmptyStringOrNull(h["sex"]),
        age: integerOrNull(h["age"]),
        body_weight: finiteOrNull(h["bodyWeight"]),
        kinryo: finiteOrNull(h["kinryo"]),
        oikiri_rank: nonEmptyStringOrNull(h["oikiriRank"]),
        oikiri_critic: critic !== null && Array.from(critic).length <= CRITIC_MAX_LENGTH ? critic : null,
      });
      jockeys.set(umaban, { jockey_name: nonEmptyStringOrNull(h["jockeyName"]), jockey_id: nonEmptyStringOrNull(h["jockeyId"]) });
    }
  }
  return { race, horses, conditions, jockeys };
}

export interface PriorDatasetRow extends PriorRaceColumns, PriorHorseColumns, PriorConditionColumns, PriorJockeyColumns {
  readonly analysis_id: number;
  readonly race_id: string;
  readonly kaisai_date: string | null;
  readonly venue_kind: "central" | "nar";
  readonly course_type: string | null;
  /** その分析に載っている馬の数(`analysis_horses` の行数)。出馬表の取消・除外は分析前に除かれるが、分析後の取消は入りうる(そのとき着順は null)。 */
  readonly field_size: number;
  readonly umaban: number;
  readonly prior: number;
  readonly adjusted_prob: number;
  readonly place_odds_min: number | null;
  readonly contributions: PriorContribution[] | null;
  readonly finish_position: number | null;
  readonly win_odds: number | null;
  readonly ninki: number | null;
  readonly prompt_version: string | null;
  readonly analyzed_at: string;
  readonly ev_estimated: boolean;
  readonly prompt_lookahead_guarded: boolean | null;
  readonly leak_class: LeakClass;
}

export interface PriorHorseInput {
  readonly umaban: number;
  readonly prior: number;
  readonly adjustedProb: number;
  readonly placeOddsMin: number | null;
}

export interface PriorResultInput {
  readonly umaban: number;
  readonly finishPosition: number | null;
  readonly winOdds: number | null;
  readonly ninki: number | null;
}

/**
 * 分析 1 件ぶんの行(馬番の昇順)。結果の無い馬は着順・オッズ・人気が null。寄与度は馬番 → 書き出す形(無い・読めない馬は null)。
 * `snapshot`(v2・v3・v4 の列。{@link toSnapshotColumns})は、詳細(R2)が無いレースでは null(15 列とも null)。スナップショットに無い馬は、馬の列と騎手の列だけ null でレースの列は入る。
 * 引数を省略可にしないのは、呼び出し側の配線漏れをコンパイルで検出するため。
 */
export function buildRaceRows(
  analysis: ChosenAnalysis,
  horses: readonly PriorHorseInput[],
  results: readonly PriorResultInput[],
  courseType: string | null,
  contributions: ReadonlyMap<number, PriorContribution[] | null>,
  snapshot: PriorSnapshotColumns | null,
): PriorDatasetRow[] {
  const resultByUmaban = new Map(results.map((r) => [r.umaban, r] as const));
  const venueKind = venueKindOfRaceId(analysis.raceId as RaceId);
  const kaisaiDate = analysis.kaisaiDate ?? kaisaiDateFromNarRaceId(analysis.raceId);
  return [...horses]
    .sort((a, b) => a.umaban - b.umaban)
    .map((h): PriorDatasetRow => {
      const r = resultByUmaban.get(h.umaban);
      return {
        analysis_id: analysis.id,
        race_id: analysis.raceId,
        kaisai_date: kaisaiDate,
        venue_kind: venueKind,
        course_type: courseType,
        field_size: horses.length,
        umaban: h.umaban,
        prior: h.prior,
        adjusted_prob: h.adjustedProb,
        place_odds_min: h.placeOddsMin,
        contributions: contributions.get(h.umaban) ?? null,
        finish_position: r?.finishPosition ?? null,
        win_odds: r?.winOdds ?? null,
        ninki: r?.ninki ?? null,
        prompt_version: analysis.promptVersion,
        analyzed_at: analysis.analyzedAt,
        ev_estimated: analysis.evEstimated,
        prompt_lookahead_guarded: analysis.promptLookaheadGuarded,
        leak_class: analysis.leakClass,
        ...(snapshot?.race ?? NULL_RACE_COLUMNS),
        ...(snapshot?.horses.get(h.umaban) ?? NULL_HORSE_COLUMNS),
        ...(snapshot?.conditions ?? NULL_CONDITION_COLUMNS),
        ...(snapshot?.jockeys.get(h.umaban) ?? NULL_JOCKEY_COLUMNS),
      };
    });
}

/** 行を NDJSON(末尾改行つき)にして、gzip の 1 メンバーにする。 */
export function encodeChunk(rows: readonly PriorDatasetRow[]): Uint8Array {
  return gzipSync(new TextEncoder().encode(rows.map((r) => `${JSON.stringify(r)}\n`).join("")), { level: 1 });
}

export interface PriorExportMetaInput {
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
  /** 寄与度の詳細(R2)が無い・読めなかったレースの数(そのレースの行は `contributions: null`)。 */
  readonly missingDetail: number;
  readonly excluded: ExcludedCounts;
}

/** メタ行の注記。読み手が誤解しやすい点(この形式で分からないこと)を書く。 */
const NOTES: readonly string[] = [
  "scorer の設定の版は記録されていない(D1・R2 のどこにも保存していない)。有効な重みは contributions[].weight(バイアスは減衰後の値)から読む。コードの版との対応は analyzed_at と prompt_version(scorer の変更を兼ねて上げた版がある)と git の履歴で引く。",
  "leak_class: guarded = history_cutoff_date あり(先読みの遮断済み)、pre_race = 遮断なしだが分析が発走より前(検証画面と同じ判定)。prior・contributions は履歴だけから決まる。adjusted_prob を使うときは prompt_lookahead_guarded で絞ること。",
  "field_size は分析に載っている馬の数。出馬表の取消・除外は分析前に除かれるが、分析後の取消は入りうる(着順は null)。着順が null の馬は中止・取消・除外のいずれか(区別できない)。",
  "win_odds・ninki は結果ページの確定値。取り込み前の旧い行・欄が空の馬は null(Issue #259)。",
  "contributions は寄与度ログ(自由文の reason は除く)。詳細(R2)が無い・読めないレースは null。",
  "format 2(v2。Issue #341): v1 の列の後ろに race_name・grade・distance・track_condition・wakuban・sex・age・body_weight・kinryo・oikiri_rank・oikiri_critic の 11 列を足した。出どころは R2 の詳細の raceSnapshot(分析時点の出馬表。追加の取得はしていない)。詳細が無い・スナップショットが壊れているレースは 11 列とも null。型が違う値はその列だけ null。馬名・調教師名と、スナップショットの市場の値(単勝オッズ・人気・複勝オッズ)は含めない(騎手名は format 4 から含める。下記)。",
  "grade は、グレードなしのレースと、グレードを保存する前(Issue #250 より前)の旧いスナップショットのどちらも null で、区別できない。track_condition は分析時点の値(確定ではない)。body_weight は馬体重の発表前(前日の分析など)は null で、増減は保存していない。",
  "format 3(v3。Issue #421): v2 の列の後ろに weight_type・fillies_only の 2 列を足した。出どころは R2 の詳細の raceSnapshot.race(出馬表の RaceData02 から読んだ、負担重量の種別〈ハンデ・別定・定量・馬齢〉と牝馬限定。追加の取得はしていない)。中央のレースだけで、地方・読めなかったレース・この項目を保存する前の旧スナップショットは両列とも null(区別できない)。weight_type は、出馬表に種別が見つからない・曖昧なときも null。fillies_only の false は「牝馬限定でない」で、null(不明)とは別。前走の条件の列は無い。",
  "format 4(v4。Issue #526): v3 の列の後ろに jockey_name・jockey_id の 2 列を足した。今回の騎手の名前と ID で、出どころは R2 の詳細の raceSnapshot.horses[](追加の取得はしていない)。騎手と馬の相性・乗り替わりの検証のために含める(ユーザーの決定・2026-10-29)。馬名・調教師名は引き続き含めない。分析時点の出馬表の騎手で、実際に乗った騎手とは限らない(発走前の乗り替わりは反映されない)。jockey_id は 2026-10-29 以降の分析だけで、それより前の分析、騎手のリンクが無い馬(騎手未定など)、詳細(R2)が無いレース、スナップショットに載っていない馬は null(区別できない)。jockey_name は、騎手未定・詳細が無いレース・スナップショットに載っていない馬が null。",
  "oikiri_rank・oikiri_critic: 調教は中央だけ取るので、地方は常に null。oikiri_critic は netkeiba の短評で、16 文字を超えるものは自由文の疑いで null にしている。実フィクスチャの 16 頭では 4 文字前後の定型句だったが、語彙が閉じていることは確認していない。",
];

/** メタ行のメンバー(ファイルの先頭)。 */
export function buildPriorHead(meta: PriorExportMetaInput): Uint8Array {
  return gzipSync(
    new TextEncoder().encode(`${JSON.stringify({ _meta: { format: PRIOR_EXPORT_FORMAT, ...meta, columns: [...PRIOR_ROW_KEYS], notes: [...NOTES] } })}\n`),
    { level: 1 },
  );
}

/**
 * ファイルを全部つなげて組み立てる: メタ行のメンバー + チャンクの連結。
 * 本番の仕上げは、塊を 1 つずつ流す(Issue #495。`export-job-core.ts`)ので、これは呼ばない。
 * 流す方式のバイト列が、全部つなげた従来の組み立てと完全に一致することの正解(テスト)と、ローダのテストの入力に使う。
 */
export function assembleFile(meta: PriorExportMetaInput, chunks: readonly Uint8Array[]): Uint8Array {
  const parts = [buildPriorHead(meta), ...chunks];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** ダウンロードのファイル名(JST の日時)。 */
export function exportFilename(generatedAtIso: string): string {
  const jst = new Date(Date.parse(generatedAtIso) + JST_OFFSET_MS).toISOString();
  return `prior-dataset-${jst.slice(0, 10).replaceAll("-", "")}-${jst.slice(11, 16).replace(":", "")}.ndjson.gz`;
}
