/**
 * 配分の再計算用の書き出し(Issue #463)の形式。**純関数だけ**で、D1・R2・Worker の型に触れない
 * (DO の側〈`allocation-export-core.ts`〉と、開発側のローダ〈`scripts/allocation-dataset.ts`〉が同じ定義を使う)。
 *
 * ## 目的
 * 過去のレースの配分を、分析時点のオッズ・実効設定のまま**計算し直せる**ようにする(#468 の対策案の試算、#53・#386 の材料)。
 * 統計モデル用の書き出し(prior-dataset。`prior-export-format.ts`)とは別のファイルにしてある(組合せオッズでファイルが数倍になるため。形式もローダも別)。
 *
 * ## ファイル
 * NDJSON(**1 行 1 レース**)を gzip したもの。**gzip の複数メンバーの連結**で、先頭メンバーがメタ行(`{"_meta": {...}}`)、続くメンバーが処理の 1 回ぶん
 * (`encodeAllocationChunk`)の行。1 度に全部を 1 文字列にしない(DO のメモリ 128MB のため。仕上げは塊を 1 つずつ流す)。
 *
 * ## 母集団(`selectAllocationExportAnalyses`)
 * **検証画面の母集団に合わせる**(`computeVerifyReport` の `selectIncludedAnalyses`。`PRODUCTION_VERIFY_CONFIG`)。順序も同じ:
 *  1. 先読みの分類。遮断済み(`isLookaheadGuarded`。`history_cutoff_date` あり、**かつ**〈LLM 未使用または LLM のプロンプトも遮断〉)は clean。
 *     それ以外は発走の前後で clean / suspect / unknown(`classifyLookaheadSuspicion`)。`start_time` が NULL(発走時刻の補完待ち)の行は判定できないので `unchecked`。
 *  2. **clean の中で**レースごとに最新 1 件(`analyzed_at` の降順、同じなら id が大きい方)。それ以外の clean は `superseded`。
 *  3. 最新が推定 EV(`ev_estimated`)なら、そのレースは**丸ごと除外**(`estimated`。古い分析に代わらない)。
 * 結果の無いレースは候補の段階で除かれる(SQL)。除外の内訳の和 + 採用 = 候補の総数。
 * prior-dataset の母集団との違い: 遮断済みの定義(prior-dataset は `history_cutoff_date` ありだけ)と、推定 EV(prior-dataset は行を残す)。
 * このため同じレースでも、選ばれる分析が違うことがある。
 *
 * ## 行の中身(`ALLOCATION_ROW_KEYS`。許可リスト。テストが完全一致を固定する)
 * 追加指示・LLM の生応答・`reason` などの自由文・馬名・騎手名・調教師名・寄与度・レース名は含めない。
 *  - 馬ごと: 馬番・枠番・prior・補正後の確率・分析時点の単勝と複勝のオッズ(R2 の `raceSnapshot` から)・保存済みの複勝下限と EV(再計算の照合用)
 *  - `combos`: 券種ごとの組合せオッズ(スナップショットのまま。キーは券種別の順序方針で正規化済み。馬単・三連単は順序つき。**キーが無い = 取得していない**、`{}` = 取得したが空)
 *  - `allocation`: 分析時の実効設定・配分のコード・提案した買い目・下限で外した買い目。**D1 の NULL は NULL のまま**(旧い行の解釈は読み手の責務)。メタ行が無ければ null
 *  - `result`: 馬ごとの着順・取消・払戻、組合せの払戻、払戻の取込印(検証画面の判定〈`createRaceBetJudge`〉と同じ入力)
 */

import { classifyLookaheadSuspicion, isLookaheadGuarded } from "../../packages/core/src/ev/lookahead-suspicion.js";
import { kaisaiDateFromNarRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import type { RaceId } from "../../packages/core/src/scraper/ids.js";
import { finiteOrNull, isRecord } from "../../packages/core/src/common/guards.js";
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst.js";
import { gzipSync } from "node:zlib";
import type { CandidateRow } from "./prior-export-format.js";

/** ファイルの形式の版。列を足す・意味を変えるときに上げる(ローダは読めない版を例外にする)。 */
export const ALLOCATION_EXPORT_FORMAT = 1;

/** R2 のキー。固定(完成のたびに原子的に上書きする)。 */
export const ALLOCATION_EXPORT_KEY = "exports/allocation-dataset.ndjson.gz";

/** 組合せ券種(スナップショットの `…Combo` と同じ名前の券種コード)。 */
export const ALLOCATION_COMBO_KINDS = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
export type AllocationComboKind = (typeof ALLOCATION_COMBO_KINDS)[number];

/** スナップショットの組合せオッズのフィールド名(券種 → フィールド名)。 */
const SNAPSHOT_COMBO_FIELD: Readonly<Record<AllocationComboKind, string>> = {
  wide: "wideCombo",
  trio: "trioCombo",
  quinella: "quinellaCombo",
  exacta: "exactaCombo",
  trifecta: "trifectaCombo",
  bracketQuinella: "bracketQuinellaCombo",
};

export type AllocationLeakClass = "guarded" | "pre_race";

/** 書き出す対象に選んだ分析。 */
export interface ChosenAllocationAnalysis {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly promptVersion: string | null;
  readonly detailKey: string | null;
  readonly promptLookaheadGuarded: boolean | null;
  /** `guarded` = 検証画面の「遮断済み」(`isLookaheadGuarded`)、`pre_race` = 遮断なしだが分析が発走より前。 */
  readonly leakClass: AllocationLeakClass;
}

export interface AllocationExcludedCounts {
  /** 遮断済みでなく、分析が発走より後(先読みの疑い)。 */
  readonly suspect: number;
  /** 遮断済みでなく、発走の前後を判定できない。 */
  readonly unknown: number;
  /** 遮断済みでなく、`start_time` が NULL(発走時刻の補完待ち)。 */
  readonly unchecked: number;
  /** clean だが、同じレースのより新しい clean な分析がある。 */
  readonly superseded: number;
  /** 最新の clean が推定 EV だったレース(検証画面と同じく、丸ごと除外。古い分析には代わらない)。 */
  readonly estimated: number;
}

/** `start_time` が検証の読み(`verify-read.ts` の GLOB '[0-9]*:[0-9][0-9]')で時刻として使われる形か。 */
const START_TIME_LIKE = /^[0-9].*:[0-9][0-9]$/s;

/** 候補から書き出す分析を選ぶ。母集団の規則はファイル先頭の説明。結果は レースID の昇順(1 レース 1 件)。 */
export function selectAllocationExportAnalyses(candidates: readonly CandidateRow[]): {
  readonly chosen: ChosenAllocationAnalysis[];
  readonly excluded: AllocationExcludedCounts;
} {
  let suspect = 0;
  let unknown = 0;
  let unchecked = 0;
  const clean: Array<{ readonly c: CandidateRow; readonly guarded: boolean }> = [];
  for (const c of candidates) {
    const promptLookaheadGuarded = c.promptLookaheadGuarded === null ? null : c.promptLookaheadGuarded === 1;
    const guarded = isLookaheadGuarded({ historyCutoffDate: c.historyCutoffDate, promptVersion: c.promptVersion, promptLookaheadGuarded });
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
        promptLookaheadGuarded,
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
    clean.push({ c, guarded });
  }
  const latest = new Map<string, { readonly c: CandidateRow; readonly guarded: boolean }>();
  for (const entry of clean) {
    const current = latest.get(entry.c.raceId);
    if (current === undefined || entry.c.analyzedAt > current.c.analyzedAt || (entry.c.analyzedAt === current.c.analyzedAt && entry.c.id > current.c.id)) {
      latest.set(entry.c.raceId, entry);
    }
  }
  let estimated = 0;
  const chosen: ChosenAllocationAnalysis[] = [];
  for (const { c, guarded } of latest.values()) {
    if (c.evEstimated === 1) {
      estimated += 1;
      continue;
    }
    chosen.push({
      id: c.id,
      raceId: c.raceId,
      analyzedAt: c.analyzedAt,
      kaisaiDate: c.kaisaiDate,
      promptVersion: c.promptVersion,
      detailKey: c.detailKey,
      promptLookaheadGuarded: c.promptLookaheadGuarded === null ? null : c.promptLookaheadGuarded === 1,
      leakClass: guarded ? "guarded" : "pre_race",
    });
  }
  chosen.sort((x, y) => (x.raceId < y.raceId ? -1 : x.raceId > y.raceId ? 1 : 0));
  return { chosen, excluded: { suspect, unknown, unchecked, superseded: clean.length - latest.size, estimated } };
}

// ---------------------------------------------------------------------------
// R2 の詳細(raceSnapshot)から取り出すもの
// ---------------------------------------------------------------------------

export interface AllocationSnapshotHorse {
  readonly wakuban: number | null;
  readonly win_odds: number | null;
  readonly ninki: number | null;
  readonly place_min: number | null;
  readonly place_max: number | null;
}

export type AllocationComboOdds = Readonly<Record<string, number | null>>;

export interface AllocationSnapshotColumns {
  /** スナップショットがあり、馬が 1 頭以上読めた(オッズを再構成できる)。 */
  readonly present: boolean;
  readonly race: { readonly course_type: string | null; readonly distance: number | null; readonly grade: string | null };
  readonly horses: ReadonlyMap<number, AllocationSnapshotHorse>;
  /** 券種ごとの組合せオッズ。**キーが無い券種は取得していない**(`{}` は取得したが空)。 */
  readonly combos: Readonly<Partial<Record<AllocationComboKind, AllocationComboOdds>>>;
  /** 券種ごとの取得の状態(`comboOdds.<券種>.state`。診断の本体〈リクエスト・衝突の標本〉は載せない)。 */
  readonly comboStates: Readonly<Partial<Record<AllocationComboKind, string>>>;
}

const EMPTY_SNAPSHOT: AllocationSnapshotColumns = {
  present: false,
  race: { course_type: null, distance: null, grade: null },
  horses: new Map(),
  combos: {},
  comboStates: {},
};

const nonEmptyStringOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const integerOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** 組合せオッズとして読める形(オブジェクトで、値がすべて有限の数か null)なら返す。そうでなければ undefined(推測で直さない: 取得していない扱い)。 */
function readComboOdds(raw: unknown): AllocationComboOdds | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * R2 の詳細の `raceSnapshot`(`buildRaceSnapshot` の形。型は未検証の unknown)から、配分の再計算に要る分を取り出す。純関数。
 * 想定外の形・型は例外にせず、その部分だけ null / 無し(`toSnapshotColumns` と同じ「推測で直さない」)。
 * 馬名・騎手名・調教師名は読まない。
 */
export function toAllocationSnapshot(raw: unknown): AllocationSnapshotColumns {
  if (!isRecord(raw)) {
    return EMPTY_SNAPSHOT;
  }
  const raceRaw = raw["race"];
  const race = isRecord(raceRaw)
    ? { course_type: nonEmptyStringOrNull(raceRaw["courseType"]), distance: integerOrNull(raceRaw["distance"]), grade: nonEmptyStringOrNull(raceRaw["grade"]) }
    : EMPTY_SNAPSHOT.race;
  const horses = new Map<number, AllocationSnapshotHorse>();
  if (Array.isArray(raw["horses"])) {
    for (const h of raw["horses"] as unknown[]) {
      if (!isRecord(h)) {
        continue;
      }
      const umaban = integerOrNull(h["umaban"]);
      if (umaban === null || horses.has(umaban)) {
        continue;
      }
      horses.set(umaban, {
        wakuban: integerOrNull(h["wakuban"]),
        win_odds: finiteOrNull(h["winOdds"]),
        ninki: integerOrNull(h["popularity"]),
        place_min: finiteOrNull(h["placeOddsMin"]),
        place_max: finiteOrNull(h["placeOddsMax"]),
      });
    }
  }
  const combos: Partial<Record<AllocationComboKind, AllocationComboOdds>> = {};
  const comboStates: Partial<Record<AllocationComboKind, string>> = {};
  const diagnostics = raw["comboOdds"];
  for (const kind of ALLOCATION_COMBO_KINDS) {
    const odds = readComboOdds(raw[SNAPSHOT_COMBO_FIELD[kind]]);
    if (odds !== undefined) {
      combos[kind] = odds;
    }
    const outcome = isRecord(diagnostics) ? diagnostics[kind] : undefined;
    const state = isRecord(outcome) ? outcome["state"] : undefined;
    if (state === "available" || state === "unavailable" || state === "failed") {
      comboStates[kind] = state;
    }
  }
  return { present: horses.size > 0, race, horses, combos, comboStates };
}

// ---------------------------------------------------------------------------
// 行
// ---------------------------------------------------------------------------

/** D1 `analysis_horses` から読む行。 */
export interface AllocationHorseInput {
  readonly umaban: number;
  readonly prior: number;
  readonly adjustedProb: number;
  readonly placeOddsMin: number | null;
  readonly ev: number | null;
}

/** D1 `race_results` から読む行。`scratched` は 1 / 0 / NULL(記録なし)。 */
export interface AllocationResultInput {
  readonly umaban: number;
  readonly finishPosition: number | null;
  readonly placePayout: number | null;
  readonly winPayout: number | null;
  readonly scratched: number | null;
  readonly wakuban: number | null;
  readonly winOdds: number | null;
  readonly ninki: number | null;
}

/** D1 `analysis_allocation_meta` から読む行(真偽の列は 1 / 0 / NULL)。 */
export interface AllocationMetaInput {
  readonly route: string;
  readonly unavailableReason: string | null;
  readonly fallbackReason: string | null;
  readonly skipReasonCode: string | null;
  readonly comboOddsWide: string | null;
  readonly comboOddsTrio: string | null;
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly evThreshold: number;
  readonly includeComboOdds: number | null;
  readonly includeWide: number | null;
  readonly includeTrio: number | null;
  readonly includeQuinella: number | null;
  readonly includeExacta: number | null;
  readonly includeTrifecta: number | null;
  readonly includeBracketQuinella: number | null;
  readonly betUnit: number | null;
  readonly greedySteps: number | null;
  readonly candidateCap: number | null;
  readonly modelId: string | null;
  readonly modelApproximate: number | null;
  readonly oddsStatus: string;
  readonly minHitProb: number | null;
  readonly belowFloorCount: number | null;
  readonly missedJson: string | null;
}

export interface AllocationBetInput {
  readonly betType: string;
  readonly comboKey: string;
  readonly stake: number;
  readonly odds: number | null;
  readonly ev: number | null;
}

export interface AllocationPayoutInput {
  readonly betType: string;
  readonly comboKey: string;
  readonly payout: number;
}

export interface AllocationRowHorse {
  readonly umaban: number;
  readonly wakuban: number | null;
  readonly prior: number;
  readonly adjusted_prob: number;
  /** 分析時点の単勝オッズ・人気・複勝の下限と上限(スナップショットから。無ければ null)。 */
  readonly win_odds: number | null;
  readonly ninki: number | null;
  readonly place_min: number | null;
  readonly place_max: number | null;
  /** 保存済みの複勝下限と EV(`analysis_horses`。再計算の照合用)。 */
  readonly place_odds_min: number | null;
  readonly ev: number | null;
}

export interface AllocationRowSettings {
  readonly bankroll: number;
  readonly per_race_cap: number;
  readonly kelly_fraction: number;
  readonly ev_threshold: number;
  readonly include_combo_odds: boolean | null;
  readonly include_wide: boolean | null;
  readonly include_trio: boolean | null;
  readonly include_quinella: boolean | null;
  readonly include_exacta: boolean | null;
  readonly include_trifecta: boolean | null;
  readonly include_bracket_quinella: boolean | null;
  readonly min_hit_prob: number | null;
}

export interface AllocationRowCodes {
  readonly route: string;
  readonly unavailable_reason: string | null;
  readonly fallback_reason: string | null;
  readonly skip_reason_code: string | null;
  readonly combo_odds_wide: string | null;
  readonly combo_odds_trio: string | null;
  readonly bet_unit: number | null;
  readonly greedy_steps: number | null;
  readonly candidate_cap: number | null;
  readonly model_id: string | null;
  readonly model_approximate: boolean | null;
  readonly below_floor_count: number | null;
}

export interface AllocationRowBet {
  readonly bet_type: string;
  readonly combo_key: string;
  readonly stake: number;
  readonly odds: number | null;
  readonly ev: number | null;
}

/** 下限で外した買い目(`missed_json` の要素。許可リストの 6 キーだけを写す)。 */
export interface AllocationRowMissed {
  readonly bet_type: string | number | null;
  readonly combo_key: string | number | null;
  readonly hit_prob: string | number | null;
  readonly odds: string | number | null;
  readonly ev: string | number | null;
  readonly would_stake: string | number | null;
}

export interface AllocationRowAllocation {
  readonly settings: AllocationRowSettings;
  readonly codes: AllocationRowCodes;
  readonly odds_status: string;
  readonly bets: AllocationRowBet[];
  /** NULL = 記録していない(旧い行・下限なし・外れた候補なし)、`[]` = 外れた候補はあったが賭け金が付くものは無かった。 */
  readonly missed: AllocationRowMissed[] | null;
}

export interface AllocationRowResultHorse {
  readonly umaban: number;
  readonly finish_position: number | null;
  /** 取消・除外か。NULL = 記録なし(旧い行)。 */
  readonly scratched: boolean | null;
  readonly wakuban: number | null;
  readonly place_payout: number | null;
  readonly win_payout: number | null;
  /** 確定の単勝オッズ・人気(結果ページの値。分析時点の値ではない)。 */
  readonly win_odds: number | null;
  readonly ninki: number | null;
}

export interface AllocationRowResult {
  readonly horses: AllocationRowResultHorse[];
  /** 券種ごとの確定払戻(100 円あたり)。`[comboKey, payout]` の配列。取込済みでも 0 件の券種はキーが無い(`payout_imports` で区別する)。 */
  readonly combo_payouts: Record<string, Array<[string, number]>>;
  /** 払戻を取り込んだ券種(0 件でも取込済み)。 */
  readonly payout_imports: string[];
}

export interface AllocationRaceRow {
  readonly analysis_id: number;
  readonly race_id: string;
  readonly kaisai_date: string | null;
  readonly venue_kind: "central" | "nar";
  readonly field_size: number;
  readonly analyzed_at: string;
  readonly prompt_version: string | null;
  readonly prompt_lookahead_guarded: boolean | null;
  readonly leak_class: AllocationLeakClass;
  readonly course_type: string | null;
  readonly distance: number | null;
  readonly grade: string | null;
  /** 分析時点のオッズを再構成できるか(R2 の詳細が無い・壊れている・馬が読めないときは false。そのとき馬のオッズ・組合せは空)。 */
  readonly has_odds: boolean;
  readonly horses: AllocationRowHorse[];
  /** 券種 → 組合せオッズ。キーが無い券種は取得していない。 */
  readonly combos: Record<string, AllocationComboOdds>;
  readonly combo_states: Record<string, string>;
  readonly allocation: AllocationRowAllocation | null;
  readonly result: AllocationRowResult;
}

/** 行の列(この順で JSON にする)。許可リスト。 */
export const ALLOCATION_ROW_KEYS = [
  "analysis_id", "race_id", "kaisai_date", "venue_kind", "field_size", "analyzed_at", "prompt_version", "prompt_lookahead_guarded", "leak_class",
  "course_type", "distance", "grade", "has_odds", "horses", "combos", "combo_states", "allocation", "result",
] as const;
export const ALLOCATION_HORSE_KEYS = ["umaban", "wakuban", "prior", "adjusted_prob", "win_odds", "ninki", "place_min", "place_max", "place_odds_min", "ev"] as const;
export const ALLOCATION_SETTINGS_KEYS = [
  "bankroll", "per_race_cap", "kelly_fraction", "ev_threshold", "include_combo_odds", "include_wide", "include_trio", "include_quinella", "include_exacta",
  "include_trifecta", "include_bracket_quinella", "min_hit_prob",
] as const;
export const ALLOCATION_CODES_KEYS = [
  "route", "unavailable_reason", "fallback_reason", "skip_reason_code", "combo_odds_wide", "combo_odds_trio", "bet_unit", "greedy_steps", "candidate_cap",
  "model_id", "model_approximate", "below_floor_count",
] as const;
export const ALLOCATION_ALLOCATION_KEYS = ["settings", "codes", "odds_status", "bets", "missed"] as const;
export const ALLOCATION_BET_KEYS = ["bet_type", "combo_key", "stake", "odds", "ev"] as const;
export const ALLOCATION_MISSED_KEYS = ["bet_type", "combo_key", "hit_prob", "odds", "ev", "would_stake"] as const;
export const ALLOCATION_RESULT_KEYS = ["horses", "combo_payouts", "payout_imports"] as const;
export const ALLOCATION_RESULT_HORSE_KEYS = ["umaban", "finish_position", "scratched", "wakuban", "place_payout", "win_payout", "win_odds", "ninki"] as const;

const flag = (v: number | null): boolean | null => (v === null ? null : v === 1);

/** `missed_json` を読む。配列でない・壊れているときは null(記録なしと同じ。推測で直さない)。要素は許可リストの 6 キーだけを写す(数・文字列以外は null)。 */
function readMissed(json: string | null): AllocationRowMissed[] | null {
  if (json === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const scalar = (v: unknown): string | number | null => (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? v : null);
  const out: AllocationRowMissed[] = [];
  for (const item of parsed as unknown[]) {
    if (!isRecord(item)) {
      continue;
    }
    out.push({
      bet_type: scalar(item["bet_type"]),
      combo_key: scalar(item["combo_key"]),
      hit_prob: scalar(item["hit_prob"]),
      odds: scalar(item["odds"]),
      ev: scalar(item["ev"]),
      would_stake: scalar(item["would_stake"]),
    });
  }
  return out;
}

export interface BuildAllocationRowInput {
  readonly analysis: ChosenAllocationAnalysis;
  readonly horses: readonly AllocationHorseInput[];
  /** 詳細が無いレースは null(`has_odds` が false になる)。 */
  readonly snapshot: AllocationSnapshotColumns | null;
  readonly meta: AllocationMetaInput | null;
  readonly bets: readonly AllocationBetInput[];
  readonly results: readonly AllocationResultInput[];
  readonly payouts: readonly AllocationPayoutInput[];
  /** 払戻を取り込んだ券種。 */
  readonly imports: readonly string[];
}

/**
 * 分析 1 件ぶんの行。馬は馬番の昇順、買い目・払戻は入力の並び(D1 の主キーの順)。
 * 引数を省略可にしないのは、呼び出し側の配線漏れをコンパイルで検出するため。
 */
export function buildAllocationRaceRow(input: BuildAllocationRowInput): AllocationRaceRow {
  const { analysis, meta } = input;
  const snapshot = input.snapshot !== null && input.snapshot.present ? input.snapshot : null;
  const horses = [...input.horses]
    .sort((a, b) => a.umaban - b.umaban)
    .map((h): AllocationRowHorse => {
      const s = snapshot?.horses.get(h.umaban);
      return {
        umaban: h.umaban,
        wakuban: s?.wakuban ?? null,
        prior: h.prior,
        adjusted_prob: h.adjustedProb,
        win_odds: s?.win_odds ?? null,
        ninki: s?.ninki ?? null,
        place_min: s?.place_min ?? null,
        place_max: s?.place_max ?? null,
        place_odds_min: h.placeOddsMin,
        ev: h.ev,
      };
    });
  const combos: Record<string, AllocationComboOdds> = {};
  const comboStates: Record<string, string> = {};
  if (snapshot !== null) {
    for (const kind of ALLOCATION_COMBO_KINDS) {
      const odds = snapshot.combos[kind];
      if (odds !== undefined) {
        combos[kind] = odds;
      }
      const state = snapshot.comboStates[kind];
      if (state !== undefined) {
        comboStates[kind] = state;
      }
    }
  }
  const comboPayouts: Record<string, Array<[string, number]>> = {};
  for (const p of input.payouts) {
    (comboPayouts[p.betType] ??= []).push([p.comboKey, p.payout]);
  }
  const allocation: AllocationRowAllocation | null =
    meta === null
      ? null
      : {
          settings: {
            bankroll: meta.bankroll,
            per_race_cap: meta.perRaceCap,
            kelly_fraction: meta.kellyFraction,
            ev_threshold: meta.evThreshold,
            include_combo_odds: flag(meta.includeComboOdds),
            include_wide: flag(meta.includeWide),
            include_trio: flag(meta.includeTrio),
            include_quinella: flag(meta.includeQuinella),
            include_exacta: flag(meta.includeExacta),
            include_trifecta: flag(meta.includeTrifecta),
            include_bracket_quinella: flag(meta.includeBracketQuinella),
            min_hit_prob: meta.minHitProb,
          },
          codes: {
            route: meta.route,
            unavailable_reason: meta.unavailableReason,
            fallback_reason: meta.fallbackReason,
            skip_reason_code: meta.skipReasonCode,
            combo_odds_wide: meta.comboOddsWide,
            combo_odds_trio: meta.comboOddsTrio,
            bet_unit: meta.betUnit,
            greedy_steps: meta.greedySteps,
            candidate_cap: meta.candidateCap,
            model_id: meta.modelId,
            model_approximate: flag(meta.modelApproximate),
            below_floor_count: meta.belowFloorCount,
          },
          odds_status: meta.oddsStatus,
          bets: input.bets.map((b) => ({ bet_type: b.betType, combo_key: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })),
          missed: readMissed(meta.missedJson),
        };
  return {
    analysis_id: analysis.id,
    race_id: analysis.raceId,
    kaisai_date: analysis.kaisaiDate ?? kaisaiDateFromNarRaceId(analysis.raceId),
    venue_kind: venueKindOfRaceId(analysis.raceId as RaceId),
    field_size: input.horses.length,
    analyzed_at: analysis.analyzedAt,
    prompt_version: analysis.promptVersion,
    prompt_lookahead_guarded: analysis.promptLookaheadGuarded,
    leak_class: analysis.leakClass,
    course_type: snapshot?.race.course_type ?? null,
    distance: snapshot?.race.distance ?? null,
    grade: snapshot?.race.grade ?? null,
    has_odds: snapshot !== null,
    horses,
    combos,
    combo_states: comboStates,
    allocation,
    result: {
      horses: [...input.results]
        .sort((a, b) => a.umaban - b.umaban)
        .map((r) => ({
          umaban: r.umaban,
          finish_position: r.finishPosition,
          scratched: flag(r.scratched),
          wakuban: r.wakuban,
          place_payout: r.placePayout,
          win_payout: r.winPayout,
          win_odds: r.winOdds,
          ninki: r.ninki,
        })),
      combo_payouts: comboPayouts,
      payout_imports: [...input.imports],
    },
  };
}

/** 行を NDJSON(末尾改行つき)にして、gzip の 1 メンバーにする。 */
export function encodeAllocationChunk(rows: readonly AllocationRaceRow[]): Uint8Array {
  return gzipSync(new TextEncoder().encode(rows.map((r) => `${JSON.stringify(r)}\n`).join("")), { level: 1 });
}

export interface AllocationExportMetaInput {
  readonly generatedAt: string;
  /** 行の数(= レースの数)。 */
  readonly rows: number;
  readonly races: number;
  /** 分析時点のオッズを再構成できなかったレース(`has_odds` が false)の数。 */
  readonly missingOdds: number;
  /** 配分のメタ行が無い(`allocation` が null)レースの数。 */
  readonly noAllocation: number;
  readonly excluded: AllocationExcludedCounts;
}

/** メタ行の注記。読み手が誤解しやすい点(この形式で分からないこと)を書く。 */
const NOTES: readonly string[] = [
  "1 行 1 レース。母集団は検証画面と同じ規則(先読みの疑い・発走の前後を判定できない・補完待ちを除き、clean の中でレースごとに最新 1 件。最新が推定 EV のレースは丸ごと除外)。excluded の和 + races = 結果のあるレースの分析の総数。",
  "has_odds が false のレースは、R2 の詳細が無い・壊れている・別のレースのものだった(馬のオッズ・組合せは空。配分を計算し直せない)。",
  "allocation の settings・codes は analysis_allocation_meta の値で、D1 の NULL は NULL のまま(旧い行〈include_quinella などは #118 より前、min_hit_prob は #470 より前〉の解釈は読み手の責務)。allocation が null の分析は配分の記録が無い。",
  "bet_unit・greedy_steps・candidate_cap・model_id は分析時の実効値。コードの既定値が変わった後の分析は、計算し直しても一致しないことがある。",
  "horses の win_odds・ninki・place_min・place_max は分析時点のオッズ(R2 の raceSnapshot)。place_odds_min・ev は保存済みの値(再計算の照合用)。result の win_odds・ninki は結果ページの確定値で、別物。",
  "combos は券種ごとの組合せオッズ(スナップショットのまま)。キーが無い券種は取得していない、{} は取得したが空。馬単・三連単のキーは順序つき(1 桁目が 1 着)、枠連のキーは枠番。combo_states は取得の状態(診断の本体は載せない)。",
  "result.combo_payouts は 100 円あたりの確定払戻。payout_imports にある券種は、払戻が 0 件でも取込済み(未取込の判定不能と、取込済みの不的中を区別する)。scratched は取消・除外(1 = true)、NULL は記録なし(旧い行)。返還の判定は createRaceBetJudge と同じ。",
  "馬名・騎手名・調教師名・レース名・寄与度・reason などの自由文・LLM の応答・追加指示は含めない。下限で外した買い目(missed)は許可リストの 6 キーだけを写す。",
];

/** メタ行のメンバー(先頭)。 */
export function buildAllocationHead(meta: AllocationExportMetaInput): Uint8Array {
  return gzipSync(
    new TextEncoder().encode(`${JSON.stringify({ _meta: { format: ALLOCATION_EXPORT_FORMAT, ...meta, columns: [...ALLOCATION_ROW_KEYS], notes: [...NOTES] } })}\n`),
    { level: 1 },
  );
}

/** ダウンロードのファイル名(JST の日時)。 */
export function allocationExportFilename(generatedAtIso: string): string {
  const jst = new Date(Date.parse(generatedAtIso) + JST_OFFSET_MS).toISOString();
  return `allocation-dataset-${jst.slice(0, 10).replaceAll("-", "")}-${jst.slice(11, 16).replace(":", "")}.ndjson.gz`;
}
