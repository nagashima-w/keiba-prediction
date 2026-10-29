/**
 * 配分の再計算用の書き出し(Issue #463)を、開発側で読み込んで型つきの行にするローダと、1 レースぶんを本番の配分の関数に渡して計算し直す関数、一致しない理由の集計・設定の上書き・回収額の集計(Issue #494)。
 * #468 の対策案の試算・#53・#386 の材料。
 *
 * ファイルは管理者が `GET /api/export/allocation-dataset` でダウンロードした `allocation-dataset-YYYYMMDD-HHMM.ndjson.gz`(NDJSON を gzip の複数メンバーで連結したもの。形式は
 * `cloud/src/allocation-export-format.ts`)。先頭行がメタ(`{"_meta": {...}}`)、以降が 1 行 1 レース。
 *
 * **黙って捨てない**: 読めない版・メタ行の無いファイル・件数の食い違い・壊れた行(JSON でない・列の過不足・型の違い)は、行番号つきの例外にする。
 *
 * ## 計算し直し(`replayRace`)
 * 行の分析時点のオッズ・確率・実効設定を、本番と同じ関数(`recomputeAllocationFromProbs`。分析時の配分も締切直前の再計算も呼ぶ関数)に渡す。D1 の NULL は
 * ここで解釈する(書き出しは NULL のまま): 券種の `include_*` が NULL は OFF、`min_hit_prob` が NULL は 0(下限なし)、`max_win_bets`・`max_place_bets`(Issue #533。1 レースあたりの単勝・複勝の点数の上限)が NULL は 0(上限なし。旧い Worker は上限なしで配分した)。それで分析時の提案と食い違ったときの理由の分類は、下の「一致しない理由の分類」。
 * 組合せの取得診断(`comboOdds`)は渡さない(買い目の金額には効かず、配分のコードの診断にだけ使われる。往復のテストで、渡さなくても買い目が一致することを確かめている)。
 * 下限で外した買い目(`missed`)は、`recomputeAllocationFromProbs` が記録のための 2 回目の配分を呼ばないので、ここでは比べない。
 *
 * ## 設定の上書き(`ReplayOverrides`。Issue #494)
 * `replayRace(row, overrides)` は、NULL の解釈のあとに設定を上書きして計算し直す(#468 の試算用)。本番の配分の関数は変えず、**設定で表せる候補だけ**が試せる:
 * 総資金・1 レースの上限・ケリー係数・EV 閾値・的中確率の下限・単勝と複勝の点数の上限・組合せオッズの取得・6 券種の ON/OFF。確率を変える候補は `adjustProb`(馬ごとの補正後の確率を差し替える。寄せ方の式は作らない)。
 * **確率ごとに閾値やケリー係数を変える・低確率の買い目に回す額に上限を付ける・100 円の救済をやめる、は本番の関数の変更が要るので、ここでは試せない。**
 * 上書きをすると分析時の提案とは一致しなくて当然なので、一致率の集計(`summarizeReplay`)は上書きなしだけに使う。
 *
 * ## 同時分布のモデルの上書き(`ReplayOverrides.model`。Issue #524)
 * 3 着内率から単勝・組合せ・複勝の確率を出すモデル(`PlaceJointModel`)を差し替えて計算し直す。`REPLAY_MODELS` の 2 つ(`plackett-luce`〈本番の既定〉・`conditional-bernoulli`)を `--override model=<id>` で選べる。
 * **条件付きベルヌーイは順序がないので、組合せの経路〈単勝の候補を常に作る〉では例外になり route=invalid になる。比べられるのは複勝だけの経路〈`includeComboOdds=false`〉。**
 * モデルを上書きして invalid になった行は、`replayedBets` が null を返す(計算し直せなかった行)。CLI は回収額の集計から外し、その行数(全体・中央・地方)を必ず出す。
 * 分析時から invalid だった行(例: 枠連を含めて枠番が無い)も、モデルを上書きしたときはこの行数に入る(原因がモデル以外のこともある)。
 * 買い目の見積もりの当たり具合を比べるときは、この行数が 0 でないモデルの結果を「買い目なし」と読まないこと。
 *
 * ## 一致しない理由の分類(`classifyReplay`)
 * 上から順に、先に当てはまったものを理由にする(1 行に理由は 1 つ): `no-allocation-record`(配分の記録なし)→ `no-odds`(分析時のオッズを再構成できない)→ 一致なら `match` →
 * `invalid`(計算し直しが例外・route=invalid、または分析時が route=invalid で一致しない)→ `code-drift`(保存した実効値 5 つ〈bet_unit・greedy_steps・candidate_cap・model_id・model_approximate〉が今のコードの値と違う)→
 * `legacy-settings`(設定の列に NULL がある。NULL の解釈〈OFF・下限なし〉が原因だと証明はしない)→ `mismatch`(それ以外。調べる対象)。
 *
 * 使い方(リポジトリのルートで):
 * - `pnpm tsx scripts/allocation-dataset.ts <ファイル>`: 要約(レース数・区分別・オッズなし・配分の記録なし)と、計算し直した買い目が分析時の提案と一致した件数。
 * - `pnpm tsx scripts/allocation-dataset.ts <ファイル> --replay [--override key=value ...]`: 理由別・区分別の一致率と、回収額(分析時の提案・計算し直した提案)。
 *   `--override` のキーは `bankroll`・`perRaceCap`・`kellyFraction`・`evThreshold`・`minHitProb`・`maxWinBetsPerRace`・`maxPlaceBetsPerRace`(整数 0〜18。0 は上限なし。Issue #533)・`includeComboOdds`・`include.wide`(`trio`・`quinella`・`exacta`・`trifecta`・`bracketQuinella` も)。真偽は true/false/on/off。`model=plackett-luce|conditional-bernoulli`(Issue #524)。
 *
 * スクリプトからは、`loadAllocationDataset`・`replayRace`・`replayedBets`・`judgeRaceBets`・`summarizePayouts`・`payoutReport` を直接呼べる(CLI の `runCli` は表示だけ)。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { recomputeAllocationFromProbs, type RecomputeAllocationResult } from "../packages/core/src/analysis/recompute-allocation.js";
import { CONDITIONAL_BERNOULLI_MODEL, type PlaceJointModel } from "../packages/core/src/ev/place-joint-model.js";
import { PLACKETT_LUCE_MODEL } from "../packages/core/src/ev/plackett-luce-model.js";
import type { RaceData } from "../packages/core/src/scraper/scrape-race.js";
import { createRaceBetJudge, judgmentPayout, PROPOSED_BET_TYPES, type BetJudgment, type JudgedHorse } from "../packages/core/src/ev/proposed-bet-judgment.js";
import type { ComboBetType } from "../packages/core/src/scraper/combo-odds-key.js";
import {
  ALLOCATION_ALLOCATION_KEYS,
  ALLOCATION_BET_KEYS,
  ALLOCATION_CODES_KEYS,
  ALLOCATION_EXPORT_FORMAT,
  ALLOCATION_HORSE_KEYS,
  ALLOCATION_RESULT_HORSE_KEYS,
  ALLOCATION_RESULT_KEYS,
  ALLOCATION_ROW_KEYS,
  ALLOCATION_SETTINGS_KEYS,
  type AllocationExcludedCounts,
  type AllocationRaceRow,
  type AllocationRowBet,
  type AllocationRowCodes,
} from "../cloud/src/allocation-export-format.js";

export type { AllocationRaceRow } from "../cloud/src/allocation-export-format.js";

/** メタ行の中身(書き出し時に付けたもの)。 */
export interface AllocationDatasetMeta {
  readonly format: number;
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
  readonly missingOdds: number;
  readonly noAllocation: number;
  readonly excluded: AllocationExcludedCounts;
  readonly columns: readonly string[];
  readonly notes: readonly string[];
}

export interface AllocationDataset {
  readonly meta: AllocationDatasetMeta;
  readonly rows: AllocationRaceRow[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v);
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isBoolOrNull = (v: unknown): boolean => v === null || typeof v === "boolean";

/** 読める形式の版。 */
const READABLE_FORMATS: readonly number[] = [ALLOCATION_EXPORT_FORMAT];

/** 列の過不足(同じ順序まで)。問題があれば理由、なければ null。 */
function keyProblem(label: string, value: unknown, expected: readonly string[]): string | null {
  if (!isObject(value)) return `${label} がオブジェクトではありません`;
  const keys = Object.keys(value);
  const missing = expected.filter((k) => !keys.includes(k));
  if (missing.length > 0) return `${label} の列が足りません(${missing.join("・")})`;
  const extra = keys.filter((k) => !expected.includes(k));
  if (extra.length > 0) return `${label} に知らない列があります(${extra.join("・")})`;
  return null;
}

/** 点数の上限の列(Issue #533 で足した。形式の版は 1 のまま)。これが無い古い書き出しは null とみなす(Issue #535-D)。 */
const LEGACY_LIMIT_COLUMNS = ["max_win_bets", "max_place_bets"] as const;

/**
 * 点数の上限の 2 列(`max_win_bets`・`max_place_bets`)が無い古い書き出し(Issue #533 より前)を読めるようにする。`allocation.settings` がオブジェクトで、この 2 列が
 * キーとして無いときだけ、無い列を null で補う(NULL は『上限なし』と解釈する既存の規則に乗る)。ほかの列の欠落・型の違いは補わず、そのあとの検査で拒まれる。
 * 検査の前に呼ぶ。`parsed` は書き換える。
 */
function fillLegacyLimitColumns(parsed: unknown): void {
  if (!isObject(parsed) || !isObject(parsed["allocation"])) return;
  const settings = parsed["allocation"]["settings"];
  if (!isObject(settings)) return;
  for (const k of LEGACY_LIMIT_COLUMNS) {
    if (!(k in settings)) settings[k] = null;
  }
}

/** 行 1 つの列・型を検査する。問題があれば理由の文字列、なければ null。 */
function rowProblem(row: unknown): string | null {
  const top = keyProblem("行", row, ALLOCATION_ROW_KEYS);
  if (top !== null) return top;
  const r = row as Record<string, unknown>;
  const checks: Array<[string, boolean]> = [
    ["analysis_id", Number.isInteger(r["analysis_id"])],
    ["race_id", typeof r["race_id"] === "string"],
    ["kaisai_date", isStrOrNull(r["kaisai_date"])],
    ["venue_kind", r["venue_kind"] === "central" || r["venue_kind"] === "nar"],
    ["field_size", Number.isInteger(r["field_size"])],
    ["analyzed_at", typeof r["analyzed_at"] === "string"],
    ["prompt_version", isStrOrNull(r["prompt_version"])],
    ["prompt_lookahead_guarded", isBoolOrNull(r["prompt_lookahead_guarded"])],
    ["leak_class", r["leak_class"] === "guarded" || r["leak_class"] === "pre_race"],
    ["course_type", isStrOrNull(r["course_type"])],
    ["distance", isNumOrNull(r["distance"])],
    ["grade", isStrOrNull(r["grade"])],
    ["has_odds", typeof r["has_odds"] === "boolean"],
    ["horses", Array.isArray(r["horses"])],
    ["combos", isObject(r["combos"]) && Object.values(r["combos"]).every((c) => isObject(c) && Object.values(c).every(isNumOrNull))],
    ["combo_states", isObject(r["combo_states"]) && Object.values(r["combo_states"]).every((s) => typeof s === "string")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length > 0) return `型が違います(${bad.join("・")})`;
  for (const [i, h] of (r["horses"] as unknown[]).entries()) {
    const p = keyProblem(`horses[${i}]`, h, ALLOCATION_HORSE_KEYS);
    if (p !== null) return p;
    const hh = h as Record<string, unknown>;
    if (!Number.isInteger(hh["umaban"]) || !isNum(hh["prior"]) || !isNum(hh["adjusted_prob"])) return `horses[${i}] の型が違います`;
    for (const k of ["wakuban", "win_odds", "ninki", "place_min", "place_max", "place_odds_min", "ev"]) {
      if (!isNumOrNull(hh[k])) return `horses[${i}].${k} の型が違います`;
    }
  }
  if (r["allocation"] !== null) {
    const a = keyProblem("allocation", r["allocation"], ALLOCATION_ALLOCATION_KEYS);
    if (a !== null) return a;
    const alloc = r["allocation"] as Record<string, unknown>;
    for (const [label, value, keys] of [["allocation.settings", alloc["settings"], ALLOCATION_SETTINGS_KEYS], ["allocation.codes", alloc["codes"], ALLOCATION_CODES_KEYS]] as const) {
      const p = keyProblem(label, value, keys);
      if (p !== null) return p;
    }
    const s = alloc["settings"] as Record<string, unknown>;
    if (![s["bankroll"], s["per_race_cap"], s["kelly_fraction"], s["ev_threshold"]].every(isNum) || !isNumOrNull(s["min_hit_prob"]) || !isNumOrNull(s["max_win_bets"]) || !isNumOrNull(s["max_place_bets"])) return "allocation.settings の数の列の型が違います";
    if (!Array.isArray(alloc["bets"])) return "allocation.bets が配列ではありません";
    for (const [i, b] of (alloc["bets"] as unknown[]).entries()) {
      const p = keyProblem(`allocation.bets[${i}]`, b, ALLOCATION_BET_KEYS);
      if (p !== null) return p;
      const bb = b as Record<string, unknown>;
      if (typeof bb["bet_type"] !== "string" || typeof bb["combo_key"] !== "string" || !isNum(bb["stake"]) || !isNumOrNull(bb["odds"]) || !isNumOrNull(bb["ev"])) return `allocation.bets[${i}] の型が違います`;
    }
    if (typeof alloc["odds_status"] !== "string") return "allocation.odds_status が文字列ではありません";
    if (alloc["missed"] !== null && !Array.isArray(alloc["missed"])) return "allocation.missed が配列でも null でもありません";
  }
  const res = keyProblem("result", r["result"], ALLOCATION_RESULT_KEYS);
  if (res !== null) return res;
  const result = r["result"] as Record<string, unknown>;
  if (!Array.isArray(result["horses"])) return "result.horses が配列ではありません";
  for (const [i, h] of (result["horses"] as unknown[]).entries()) {
    const p = keyProblem(`result.horses[${i}]`, h, ALLOCATION_RESULT_HORSE_KEYS);
    if (p !== null) return p;
    const hh = h as Record<string, unknown>;
    if (!Number.isInteger(hh["umaban"]) || !isBoolOrNull(hh["scratched"])) return `result.horses[${i}] の型が違います`;
    for (const k of ["finish_position", "wakuban", "place_payout", "win_payout", "win_odds", "ninki"]) {
      if (!isNumOrNull(hh[k])) return `result.horses[${i}].${k} の型が違います`;
    }
  }
  if (!isObject(result["combo_payouts"]) || !Object.values(result["combo_payouts"]).every((list) => Array.isArray(list) && list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && isNum(e[1])))) {
    return "result.combo_payouts の形が違います";
  }
  if (!Array.isArray(result["payout_imports"]) || !result["payout_imports"].every((x) => typeof x === "string")) return "result.payout_imports の形が違います";
  return null;
}

/** gzip(複数メンバー可)のバイト列から読む。 */
export function parseAllocationDataset(bytes: Uint8Array): AllocationDataset {
  const lines = new TextDecoder().decode(gunzipSync(bytes)).split("\n");
  if (lines.at(-1) === "") lines.pop();
  let head: unknown;
  try {
    head = lines.length === 0 ? undefined : JSON.parse(lines[0]!);
  } catch {
    head = undefined;
  }
  if (!isObject(head) || !isObject(head["_meta"])) {
    throw new Error("先頭行がメタ行(_meta)ではありません。書き出しのファイルではない可能性があります");
  }
  const meta = head["_meta"] as unknown as AllocationDatasetMeta;
  if (!READABLE_FORMATS.includes(meta.format)) {
    throw new Error(`読めない版のファイルです(format ${String(meta.format)}。このローダは ${READABLE_FORMATS.join("・")} を読みます)`);
  }
  const rows: AllocationRaceRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      throw new Error(`${i + 1} 行目が JSON ではありません`);
    }
    fillLegacyLimitColumns(parsed);
    const problem = rowProblem(parsed);
    if (problem !== null) {
      throw new Error(`${i + 1} 行目: ${problem}`);
    }
    rows.push(parsed as AllocationRaceRow);
  }
  if (rows.length !== meta.rows) {
    throw new Error(`件数が合いません(メタ行は ${String(meta.rows)} 行、実際は ${rows.length} 行。途中で切れたか、別のファイルが混ざった可能性があります)`);
  }
  return { meta, rows };
}

export function loadAllocationDataset(file: string): AllocationDataset {
  return parseAllocationDataset(new Uint8Array(readFileSync(file)));
}

// ---------------------------------------------------------------------------
// 計算し直し
// ---------------------------------------------------------------------------

export type ReplayOutcome =
  /** 配分のメタ行が無い分析(旧い分析など)。計算し直せない。 */
  | { readonly kind: "no-allocation-record" }
  /** 分析時点のオッズを再構成できない(R2 の詳細が無い・壊れている)。 */
  | { readonly kind: "no-odds" }
  | { readonly kind: "replayed"; readonly result: RecomputeAllocationResult };

type OddsLike = RaceData["odds"];
type WinOddsMap = OddsLike["win"];
type PlaceOddsMap = OddsLike["place"];

/** 行から、本番の再計算の関数の入力のオッズを再構成する。単勝・複勝は `{odds, ninki}` / `{oddsMin, oddsMax, ninki}`(複勝の人気は保存していないので null)。 */
function oddsOf(row: AllocationRaceRow, oddsStatus: OddsLike["oddsStatus"]): OddsLike {
  const win: Record<number, WinOddsMap[number]> = {};
  const place: Record<number, PlaceOddsMap[number]> = {};
  for (const h of row.horses) {
    if (h.win_odds !== null || h.ninki !== null) win[h.umaban] = { odds: h.win_odds, ninki: h.ninki };
    if (h.place_min !== null || h.place_max !== null) place[h.umaban] = { oddsMin: h.place_min, oddsMax: h.place_max, ninki: null };
  }
  const combo = (kind: string): Record<string, number | null> | undefined => (Object.hasOwn(row.combos, kind) ? { ...row.combos[kind]! } : undefined);
  const wide = combo("wide");
  const trio = combo("trio");
  const quinella = combo("quinella");
  const exacta = combo("exacta");
  const trifecta = combo("trifecta");
  const bracketQuinella = combo("bracketQuinella");
  return {
    officialDatetime: null,
    oddsStatus,
    win,
    place,
    ...(wide !== undefined ? { wideCombo: wide } : {}),
    ...(trio !== undefined ? { trioCombo: trio } : {}),
    ...(quinella !== undefined ? { quinellaCombo: quinella } : {}),
    ...(exacta !== undefined ? { exactaCombo: exacta } : {}),
    ...(trifecta !== undefined ? { trifectaCombo: trifecta } : {}),
    ...(bracketQuinella !== undefined ? { bracketQuinellaCombo: bracketQuinella } : {}),
  };
}

/** 計算し直しの設定の上書きで指定できる組合せの券種(`include`)。 */
export const REPLAY_INCLUDE_KINDS = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
export type ReplayIncludeKind = (typeof REPLAY_INCLUDE_KINDS)[number];

type RowHorse = AllocationRaceRow["horses"][number];

/** 計算し直しの設定の上書き(Issue #494)。省略した項目は、行に保存された設定(NULL は解釈したあと)のまま。 */
export interface ReplayOverrides {
  readonly bankroll?: number;
  readonly perRaceCap?: number;
  readonly kellyFraction?: number;
  readonly evThreshold?: number;
  /** 的中確率の下限(0〜1。0 は下限なし)。 */
  readonly minHitProb?: number;
  /** 単勝の点数の上限(1 レースあたり。整数 0〜18。0 は上限なし。Issue #533)。複勝だけの経路には単勝がないので効かない。 */
  readonly maxWinBetsPerRace?: number;
  /** 複勝の点数の上限(1 レースあたり。整数 0〜18。0 は上限なし。Issue #533)。単勝とは別々に数える。 */
  readonly maxPlaceBetsPerRace?: number;
  /** 組合せオッズを取得する設定。false なら複勝だけの経路(組合せ券種が ON でも)。 */
  readonly includeComboOdds?: boolean;
  /** 券種ごとの「配分に含める」。 */
  readonly include?: Partial<Record<ReplayIncludeKind, boolean>>;
  /** 馬ごとの補正後の確率(3 着内率)の差し替え。0〜1 の有限値を返す。事前確率(prior)は変えない。 */
  readonly adjustProb?: (horse: RowHorse, row: AllocationRaceRow) => number;
  /**
   * 3 着内率から単勝・組合せ・複勝の同時の確率を出すモデルの差し替え(Issue #524)。省略 = 本番と同じ(`PLACKETT_LUCE_MODEL`)。
   * **順序のないモデル(条件付きベルヌーイ)は、組合せの経路〈単勝の候補を常に作る〉で例外になり、route=invalid になる**(本番の「順序のないモデルは例外」を保つ)。
   * その行は `replayedBets` が null を返し(計算し直せなかった行)、回収額の集計に入れない。条件付きベルヌーイで比べられるのは複勝だけの経路〈`includeComboOdds=false`〉。
   */
  readonly model?: PlaceJointModel;
}

/** `--override model=<id>` で選べるモデル(id は `PlaceJointModel.id`)。新しいモデルを試すときはここに足す。 */
export const REPLAY_MODELS: Readonly<Record<string, PlaceJointModel>> = {
  [PLACKETT_LUCE_MODEL.id]: PLACKETT_LUCE_MODEL,
  [CONDITIONAL_BERNOULLI_MODEL.id]: CONDITIONAL_BERNOULLI_MODEL,
};

const NUMBER_OVERRIDES = ["bankroll", "perRaceCap", "kellyFraction", "evThreshold", "minHitProb", "maxWinBetsPerRace", "maxPlaceBetsPerRace"] as const;

/** 点数の上限の上書きの最大(`cloud/src/settings.ts` の `MAX_BETS_PER_RACE_MAX` と同じ。中央競馬の最大頭数)。 */
const MAX_BETS_OVERRIDE = 18;

/**
 * 上書きの値を検査する(範囲外は例外)。**本番の配分の関数は、範囲外の値を黙って別の値に置き換える**(`resolveKellyFraction` は [0,1] の外を既定の 0.5 に、`resolveMinHitProb` は [0,1] に丸める、
 * `resolveBankroll`・`resolveEffectivePerRaceCap` は負の値を 0〈未設定〉にする)。試算の道具としては、指定した値で計算したように見えて別の値で計算するのが最も危ないので、範囲外は例外にする。
 * - `bankroll`・`perRaceCap`: 有限で 0 以上(0 は「未設定」で、そのとおりに計算される。`perRaceCap` は本番の関数が 100 円の倍数に切り捨てる)。
 * - `kellyFraction`・`minHitProb`: 有限で 0〜1。
 * - `maxWinBetsPerRace`・`maxPlaceBetsPerRace`: 整数で 0〜18(0 は上限なし。本番の関数は非整数を切り捨て、1 未満を上限なしにするので、1.5 などは指定した値と違う上限で計算してしまう)。
 * - `evThreshold`: 有限(負の閾値は本番の関数もそのまま使う)。
 */
export function validateOverrides(overrides: ReplayOverrides): void {
  for (const key of NUMBER_OVERRIDES) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) throw new Error(`上書き ${key} が有限の数ではありません(${String(value)})`);
    if ((key === "bankroll" || key === "perRaceCap") && value < 0) throw new Error(`上書き ${key} は 0 以上です(${value}。本番の関数は負の値を 0〈未設定〉に置き換えます)`);
    if ((key === "maxWinBetsPerRace" || key === "maxPlaceBetsPerRace") && (!Number.isInteger(value) || value < 0 || value > MAX_BETS_OVERRIDE)) {
      throw new Error(`上書き ${key} は 0〜${MAX_BETS_OVERRIDE} の整数です(${value}。0 は上限なし。本番の関数は非整数を切り捨てます)`);
    }
    if ((key === "kellyFraction" || key === "minHitProb") && (value < 0 || value > 1)) {
      throw new Error(`上書き ${key} は 0〜1 です(${value}。本番の関数は範囲外の値を ${key === "kellyFraction" ? "既定の 0.5" : "0〜1 の端"} に置き換えます)`);
    }
  }
}

/**
 * 1 レースの配分を、分析時の入力のまま本番の関数で計算し直す。D1 の NULL の解釈はファイル先頭の説明。`overrides` で設定を上書きできる(NULL の解釈より後に当たる)。
 * 枠番が分析時のスナップショットに無い馬は、結果の枠番(確定した事実)で補う。それも無ければ 0(枠連が配分に入る設定のときだけ、本番の関数が例外を投げ、route が invalid になる)。
 * 入力の行は書き換えない。
 */
export function replayRace(row: AllocationRaceRow, overrides: ReplayOverrides = {}): ReplayOutcome {
  const allocation = row.allocation;
  if (allocation === null) return { kind: "no-allocation-record" };
  if (!row.has_odds) return { kind: "no-odds" };
  validateOverrides(overrides);
  const s = allocation.settings;
  const include = overrides.include ?? {};
  const wakubanOfResult = new Map(row.result.horses.map((h) => [h.umaban, h.wakuban] as const));
  const adjustedProbOf = (h: RowHorse): number => {
    if (overrides.adjustProb === undefined) return h.adjusted_prob;
    const value = overrides.adjustProb(h, row);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`adjustProb が 0〜1 の有限の数を返しませんでした(馬 ${h.umaban}: ${String(value)})`);
    }
    return value;
  };
  const result = recomputeAllocationFromProbs({
    raceId: row.race_id,
    horses: row.horses.map((h) => ({ umaban: h.umaban, wakuban: h.wakuban ?? wakubanOfResult.get(h.umaban) ?? 0, horseName: "", prior: h.prior, adjustedProb: adjustedProbOf(h) })),
    odds: oddsOf(row, allocation.odds_status as OddsLike["oddsStatus"]),
    allocationSettings: {
      bankroll: overrides.bankroll ?? s.bankroll,
      perRaceCap: overrides.perRaceCap ?? s.per_race_cap,
      kellyFraction: overrides.kellyFraction ?? s.kelly_fraction,
      includeComboOdds: overrides.includeComboOdds ?? s.include_combo_odds ?? false,
      includeWideInAllocation: include.wide ?? s.include_wide ?? false,
      includeTrioInAllocation: include.trio ?? s.include_trio ?? false,
      includeQuinellaInAllocation: include.quinella ?? s.include_quinella ?? false,
      includeExactaInAllocation: include.exacta ?? s.include_exacta ?? false,
      includeTrifectaInAllocation: include.trifecta ?? s.include_trifecta ?? false,
      includeBracketQuinellaInAllocation: include.bracketQuinella ?? s.include_bracket_quinella ?? false,
      minHitProb: overrides.minHitProb ?? s.min_hit_prob ?? 0,
      maxWinBets: overrides.maxWinBetsPerRace ?? s.max_win_bets ?? 0,
      maxPlaceBets: overrides.maxPlaceBetsPerRace ?? s.max_place_bets ?? 0,
    },
    evConfig: { threshold: overrides.evThreshold ?? s.ev_threshold },
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
  });
  return { kind: "replayed", result };
}

export interface ReplayComparison {
  readonly same: boolean;
  /** 食い違った項目(空なら一致)。理由別の分類は `classifyReplay`。 */
  readonly differences: string[];
}

const betKey = (b: { readonly bet_type: string; readonly combo_key: string }): string => `${b.bet_type}:${b.combo_key}`;

/** 計算し直した配分を、分析時に保存した提案(買い目の券種・キー・金額・オッズ・EV と、配分のコード)と、完全一致で比べる。 */
export function compareReplay(row: AllocationRaceRow, outcome: Extract<ReplayOutcome, { kind: "replayed" }>): ReplayComparison {
  const stored = row.allocation!;
  const replayed = outcome.result.allocation;
  const differences: string[] = [];
  const storedBets = new Map<string, AllocationRowBet>(stored.bets.map((b) => [betKey(b), b]));
  const replayedBets = new Map<string, (typeof replayed.bets)[number]>(replayed.bets.map((b) => [`${b.betType}:${b.comboKey}`, b]));
  for (const [key, b] of storedBets) {
    const r = replayedBets.get(key);
    if (r === undefined) differences.push(`買い目 ${key} が計算し直しに無い`);
    else if (r.stake !== b.stake) differences.push(`買い目 ${key} の金額が違う(${b.stake} → ${r.stake})`);
    else if (r.odds !== b.odds || r.ev !== b.ev) differences.push(`買い目 ${key} のオッズか EV が違う`);
  }
  for (const key of replayedBets.keys()) {
    if (!storedBets.has(key)) differences.push(`買い目 ${key} が分析時に無い`);
  }
  const m = replayed.meta;
  const c = stored.codes;
  const codePairs: Array<[string, unknown, unknown]> = [
    ["route", c.route, m.route],
    ["unavailable_reason", c.unavailable_reason, m.unavailableReason],
    ["fallback_reason", c.fallback_reason, m.fallbackReason],
    ["skip_reason_code", c.skip_reason_code, m.skipReasonCode],
    ["combo_odds_wide", c.combo_odds_wide, m.comboOddsWide],
    ["combo_odds_trio", c.combo_odds_trio, m.comboOddsTrio],
    ["bet_unit", c.bet_unit, m.betUnit],
    ["greedy_steps", c.greedy_steps, m.greedySteps],
    ["candidate_cap", c.candidate_cap, m.candidateCap],
    ["model_id", c.model_id, m.modelId],
    ["model_approximate", c.model_approximate, m.modelApproximate],
    ["below_floor_count", c.below_floor_count, m.belowFloorCount ?? null],
  ];
  for (const [name, a, b] of codePairs) {
    if (a !== b) differences.push(`${name} が違う(${String(a)} → ${String(b)})`);
  }
  // 馬ごとの複勝下限と EV(保存済みの値と、計算し直した値)
  const rows = new Map(outcome.result.rows.map((r) => [r.umaban, r] as const));
  for (const h of row.horses) {
    const r = rows.get(h.umaban);
    if (r === undefined || r.placeOddsMin !== h.place_odds_min || r.ev !== h.ev) differences.push(`馬 ${h.umaban} の複勝下限か EV が違う`);
  }
  return { same: differences.length === 0, differences };
}

// ---------------------------------------------------------------------------
// 一致しない理由の分類と、理由別の集計(Issue #494)
// ---------------------------------------------------------------------------

/** 配分のコードのうち、コードの既定値が変わると保存した値と食い違う実効値 5 つ(`code-drift` の判定に使う)。 */
const CODE_CONSTANT_PAIRS: ReadonlyArray<readonly [string, (c: AllocationRowCodes, m: RecomputeAllocationResult["allocation"]["meta"]) => readonly [unknown, unknown]]> = [
  ["bet_unit", (c, m) => [c.bet_unit, m.betUnit]],
  ["greedy_steps", (c, m) => [c.greedy_steps, m.greedySteps]],
  ["candidate_cap", (c, m) => [c.candidate_cap, m.candidateCap]],
  ["model_id", (c, m) => [c.model_id, m.modelId]],
  ["model_approximate", (c, m) => [c.model_approximate, m.modelApproximate]],
];

/**
 * 保存した実効値(bet_unit・greedy_steps・candidate_cap・model_id・model_approximate)のうち、計算し直した値と違うものの名前。
 * **保存した route と計算し直した route が同じときだけ比べる。** 実効値は経路ごとに決まる(複勝だけの経路には candidate_cap が無い、など)ので、
 * 設定の NULL の解釈で route が変わった行は、実効値が違って見えてもコードの変更によるものとは言えない。
 */
export function driftedConstants(row: AllocationRaceRow, outcome: Extract<ReplayOutcome, { kind: "replayed" }>): string[] {
  const codes = row.allocation!.codes;
  const meta = outcome.result.allocation.meta;
  if (codes.route !== meta.route) return [];
  return CODE_CONSTANT_PAIRS.filter(([, pair]) => {
    const [stored, replayed] = pair(codes, meta);
    return stored !== replayed;
  }).map(([name]) => name);
}

export const REPLAY_REASONS = ["match", "no-allocation-record", "no-odds", "invalid", "code-drift", "legacy-settings", "mismatch"] as const;
export type ReplayReason = (typeof REPLAY_REASONS)[number];

/** 設定の列のうち、D1 の NULL を読み手が解釈するもの(`replayRace` が OFF・下限なし・上限なしと解釈する列)。 */
const NULLABLE_SETTING_COLUMNS = ["include_combo_odds", "include_wide", "include_trio", "include_quinella", "include_exacta", "include_trifecta", "include_bracket_quinella", "min_hit_prob", "max_win_bets", "max_place_bets"] as const;

export interface ReplayClassification {
  readonly reason: ReplayReason;
  /** 保存した設定のうち NULL の列(配分の記録があれば、理由にかかわらず返す)。 */
  readonly nullSettings: string[];
  /** 食い違った実効値(計算し直せたときだけ。無ければ空)。 */
  readonly driftedConstants: string[];
  /** `code-drift` の行が、設定に NULL も持っているか(両方に当てはまる行。優先順で code-drift にした)。 */
  readonly alsoLegacySettings: boolean;
  /** 計算し直しが例外を投げたか(`reason` は invalid になる。route=invalid の記録と区別するため別に持つ)。 */
  readonly threw: boolean;
}

/**
 * 1 行を計算し直して、一致するか・しないときの理由を分類する(順序と各理由の意味はファイル先頭)。`replay` は計算し直しの関数(テストで例外を投げさせるために差し替えられる)。
 */
export function classifyReplay(row: AllocationRaceRow, replay: (row: AllocationRaceRow) => ReplayOutcome = (r) => replayRace(r)): ReplayClassification {
  const nullSettings = row.allocation === null ? [] : NULLABLE_SETTING_COLUMNS.filter((k) => row.allocation!.settings[k] === null);
  const done = (reason: ReplayReason, drifted: string[] = [], threw = false): ReplayClassification => ({
    reason, nullSettings: [...nullSettings], driftedConstants: drifted, alsoLegacySettings: reason === "code-drift" && nullSettings.length > 0, threw,
  });
  let outcome: ReplayOutcome;
  try {
    outcome = replay(row);
  } catch {
    // 例外は invalid に数えるが、集計で別に数える(本番の関数は例外を route=invalid の記録に変えて返すので、ここまで例外が届くのは入力の行の異常か、この道具の不具合)。
    return done("invalid", [], true);
  }
  if (outcome.kind === "no-allocation-record") return done("no-allocation-record");
  if (outcome.kind === "no-odds") return done("no-odds");
  const drifted = driftedConstants(row, outcome);
  if (compareReplay(row, outcome).same) return done("match", drifted);
  if (row.allocation!.codes.route === "invalid" || outcome.result.allocation.meta.route === "invalid") return done("invalid", drifted);
  if (drifted.length > 0) return done("code-drift", drifted);
  if (nullSettings.length > 0) return done("legacy-settings", drifted);
  return done("mismatch", drifted);
}

/** 計算し直しの結果が出せる行(配分の記録があり、分析時のオッズを再構成できた行)。 */
export function replayableRows(rows: readonly AllocationRaceRow[]): AllocationRaceRow[] {
  return rows.filter((r) => r.allocation !== null && r.has_odds);
}

export interface ReplayTally {
  readonly rows: number;
  /** 計算し直せた行 = 行数 − 配分の記録なし − オッズなし。 */
  readonly replayed: number;
  /** 一致した行 ÷ 計算し直せた行(計算し直せた行が 0 なら null)。 */
  readonly matchRate: number | null;
  readonly reasons: Record<ReplayReason, number>;
  /** `invalid` のうち、計算し直しが例外を投げた行(route=invalid の記録との食い違いではない行)。 */
  readonly invalidThrown: number;
}

export interface ReplayReport {
  readonly total: ReplayTally;
  readonly byVenueKind: { readonly central: ReplayTally; readonly nar: ReplayTally };
  /** 一致しなかった(計算し直せた)行のうち、設定が NULL だった行の、NULL の列ごとの件数。 */
  readonly nullSettingColumns: Record<string, number>;
  /** `code-drift` の行のうち、設定にも NULL があった行の数(`legacy-settings` と両方に当てはまる行)。 */
  readonly codeDriftAlsoLegacy: number;
}

function emptyReasons(): Record<ReplayReason, number> {
  return Object.fromEntries(REPLAY_REASONS.map((r) => [r, 0])) as Record<ReplayReason, number>;
}

function tallyOf(reasons: Record<ReplayReason, number>, invalidThrown: number): ReplayTally {
  const rows = REPLAY_REASONS.reduce((n, r) => n + reasons[r], 0);
  const replayed = rows - reasons["no-allocation-record"] - reasons["no-odds"];
  return { rows, replayed, matchRate: replayed === 0 ? null : reasons.match / replayed, reasons, invalidThrown };
}

/** 全行を計算し直して(設定の上書きなし)、理由別・区分別に数える。`replay` は計算し直しの関数(テストで例外を投げさせるために差し替えられる)。 */
export function summarizeReplay(rows: readonly AllocationRaceRow[], replay?: (row: AllocationRaceRow) => ReplayOutcome): ReplayReport {
  const all = emptyReasons();
  const byKind = { central: emptyReasons(), nar: emptyReasons() };
  const thrown = { central: 0, nar: 0 };
  const nullSettingColumns: Record<string, number> = {};
  let codeDriftAlsoLegacy = 0;
  for (const row of rows) {
    const c = classifyReplay(row, replay);
    all[c.reason] += 1;
    if (c.threw) thrown[row.venue_kind] += 1;
    byKind[row.venue_kind][c.reason] += 1;
    if (c.reason !== "match" && c.reason !== "no-allocation-record" && c.reason !== "no-odds") {
      for (const column of c.nullSettings) nullSettingColumns[column] = (nullSettingColumns[column] ?? 0) + 1;
    }
    if (c.alsoLegacySettings) codeDriftAlsoLegacy += 1;
  }
  return { total: tallyOf(all, thrown.central + thrown.nar), byVenueKind: { central: tallyOf(byKind.central, thrown.central), nar: tallyOf(byKind.nar, thrown.nar) }, nullSettingColumns, codeDriftAlsoLegacy };
}

// ---------------------------------------------------------------------------
// 払戻の判定
// ---------------------------------------------------------------------------

export interface JudgedBet {
  readonly bet: AllocationRowBet;
  readonly judgment: BetJudgment;
  /** 払戻(円。賭け金を含む)。的中 = 100 円あたりの払戻 × 賭け金 / 100、返還 = 賭け金、外れ・判定不能 = 0。 */
  readonly payout: number;
}

/**
 * 買い目を、検証画面と同じ判定(`createRaceBetJudge`。返還・払戻表の取込ゲート・キーの完全一致)で判定する。入力は行の `result`。
 * `scratched` の NULL(旧い行の記録なし)は「未記録」として渡す(取消とも取消でないとも決めない)。
 */
export function judgeRaceBets(row: AllocationRaceRow, bets: readonly AllocationRowBet[]): JudgedBet[] {
  const horses: JudgedHorse[] = row.result.horses.map((h) => ({
    umaban: h.umaban,
    placePayout: h.place_payout,
    winPayout: h.win_payout,
    wakuban: h.wakuban,
    ...(h.scratched === null ? {} : { scratched: h.scratched }),
  }));
  const imported = new Set(row.result.payout_imports);
  const judge = createRaceBetJudge(horses, (betType: ComboBetType) =>
    imported.has(betType) ? { state: "imported", payouts: (row.result.combo_payouts[betType] ?? []).map(([comboKey, payout]) => ({ comboKey, payout })) } : { state: "not_imported" },
  );
  return bets.map((bet) => {
    const judgment = judge(bet.bet_type, bet.combo_key);
    return { bet, judgment, payout: judgmentPayout(judgment, bet.stake) };
  });
}

// ---------------------------------------------------------------------------
// 回収額の集計(Issue #494)
// ---------------------------------------------------------------------------

export interface PayoutSummary {
  /** 判定できた(的中・外れ・返還)買い目の点数。判定不能・知らない券種は含めない(検証画面の `betCount` と同じ)。 */
  readonly betCount: number;
  readonly totalStake: number;
  /** 払戻合計(円。賭け金を含む。返還は賭け金そのもの)。 */
  readonly totalReturn: number;
  /** 払戻合計 ÷ 賭け金合計(賭け金が 0 なら null)。 */
  readonly recoveryRate: number | null;
  /** 払戻表が未取込などで判定できなかった買い目の点数(賭け金・払戻に入れない)。 */
  readonly unjudgedCount: number;
  /** 知らない券種の買い目の点数(検証画面と同じく、点数・賭け金に入れず別に数える)。 */
  readonly unknownBetTypeCount: number;
  /** 取消・除外の馬を含むため返還した買い目の点数(`betCount` に含む)。 */
  readonly refundedCount: number;
  readonly refundedStake: number;
}

/** 判定した買い目の回収額を、検証画面(`computeVerifyReport` の `proposedBet`)と同じ数え方で足し上げる。 */
export function summarizePayouts(judged: readonly JudgedBet[]): PayoutSummary {
  let betCount = 0;
  let totalStake = 0;
  let totalReturn = 0;
  let unjudgedCount = 0;
  let unknownBetTypeCount = 0;
  let refundedCount = 0;
  let refundedStake = 0;
  for (const j of judged) {
    switch (j.judgment.outcome) {
      case "unjudged":
        unjudgedCount += 1;
        break;
      case "unknownBetType":
        unknownBetTypeCount += 1;
        break;
      case "refund":
        refundedCount += 1;
        refundedStake += j.bet.stake;
        betCount += 1;
        totalStake += j.bet.stake;
        totalReturn += j.payout;
        break;
      default:
        betCount += 1;
        totalStake += j.bet.stake;
        totalReturn += j.payout;
    }
  }
  return { betCount, totalStake, totalReturn, recoveryRate: totalStake === 0 ? null : totalReturn / totalStake, unjudgedCount, unknownBetTypeCount, refundedCount, refundedStake };
}

export interface PayoutReport {
  readonly overall: PayoutSummary;
  /** 検証画面の 8 券種(買い目が無い券種も 0 の行を持つ)。知らない券種は `overall.unknownBetTypeCount` だけに数える。 */
  readonly byBetType: Record<string, PayoutSummary>;
  readonly byVenueKind: { readonly central: PayoutSummary; readonly nar: PayoutSummary };
}

/** 行ごとの買い目(`betsOf`)を検証画面と同じ判定で判定して、全体・券種別・区分別の回収額を出す。 */
export function payoutReport(rows: readonly AllocationRaceRow[], betsOf: (row: AllocationRaceRow) => readonly AllocationRowBet[]): PayoutReport {
  const judged = rows.flatMap((row) => judgeRaceBets(row, betsOf(row)).map((j) => ({ j, venue: row.venue_kind })));
  return {
    overall: summarizePayouts(judged.map((x) => x.j)),
    byBetType: Object.fromEntries(PROPOSED_BET_TYPES.map((t) => [t, summarizePayouts(judged.filter((x) => x.j.bet.bet_type === t).map((x) => x.j))])),
    byVenueKind: {
      central: summarizePayouts(judged.filter((x) => x.venue === "central").map((x) => x.j)),
      nar: summarizePayouts(judged.filter((x) => x.venue === "nar").map((x) => x.j)),
    },
  };
}

/** 分析時に保存した提案の買い目(配分の記録が無い行は空)。 */
export function storedBets(row: AllocationRaceRow): readonly AllocationRowBet[] {
  return row.allocation?.bets ?? [];
}

/**
 * 計算し直した提案の買い目。計算し直せない行(配分の記録なし・オッズなし)は null。
 * **モデルを上書きしたとき(Issue #524)だけ、route=invalid になった行も null**(そのモデルでは計算し直せなかった行。例: 順序のないモデルは組合せの経路で例外になる)。
 * 分析時から invalid だった行(例: 枠連を含めて枠番が無い)も、モデルを上書きしたときはこの null に入る(原因がモデル以外のこともある)。
 * 回収額に「買い目なし」として混ぜると、計算に失敗した行が「買わなかった」ように見えるため。上書きなし・ほかの上書きだけのときの invalid は、これまでどおり買い目なし(空配列)。
 */
export function replayedBets(row: AllocationRaceRow, overrides: ReplayOverrides = {}): AllocationRowBet[] | null {
  const outcome = replayRace(row, overrides);
  if (outcome.kind !== "replayed") return null;
  if (overrides.model !== undefined && outcome.result.allocation.meta.route === "invalid") return null;
  return outcome.result.allocation.bets.map((b) => ({ bet_type: b.betType, combo_key: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev }));
}

// ---------------------------------------------------------------------------

export interface AllocationDatasetSummary {
  readonly races: number;
  readonly byVenueKind: { readonly central: number; readonly nar: number };
  readonly withoutOdds: number;
  readonly withoutAllocation: number;
}

export function summarize(rows: readonly AllocationRaceRow[]): AllocationDatasetSummary {
  return {
    races: rows.length,
    byVenueKind: { central: rows.filter((r) => r.venue_kind === "central").length, nar: rows.filter((r) => r.venue_kind === "nar").length },
    withoutOdds: rows.filter((r) => !r.has_odds).length,
    withoutAllocation: rows.filter((r) => r.allocation === null).length,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "使い方: pnpm tsx scripts/allocation-dataset.ts <allocation-dataset-*.ndjson.gz> [--replay [--override key=value ...]]";

function parseNumber(key: string, value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n)) throw new Error(`--override ${key} の値が数ではありません(${JSON.stringify(value)})`);
  return n;
}

function parseBoolean(key: string, value: string): boolean {
  if (value === "true" || value === "on") return true;
  if (value === "false" || value === "off") return false;
  throw new Error(`--override ${key} の値は true/false/on/off のどれかです(${JSON.stringify(value)})`);
}

/** CLI の `--override key=value`(複数可)を、設定の上書きへ直す。同じキーは後が勝つ。知らないキー・値のない指定・不正な値は理由つきの例外。 */
export function parseOverrides(pairs: readonly string[]): ReplayOverrides {
  const out: { -readonly [K in keyof ReplayOverrides]: ReplayOverrides[K] } = {};
  const include: Partial<Record<ReplayIncludeKind, boolean>> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--override は key=value の形で指定してください(${JSON.stringify(pair)})`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if ((NUMBER_OVERRIDES as readonly string[]).includes(key)) {
      out[key as (typeof NUMBER_OVERRIDES)[number]] = parseNumber(key, value);
    } else if (key === "includeComboOdds") {
      out.includeComboOdds = parseBoolean(key, value);
    } else if (key === "model") {
      if (!Object.hasOwn(REPLAY_MODELS, value)) {
        throw new Error(`--override model: 知らないモデルです(${JSON.stringify(value)}。${Object.keys(REPLAY_MODELS).join("・")} のどれか)`);
      }
      out.model = REPLAY_MODELS[value]!;
    } else if (key.startsWith("include.")) {
      const kind = key.slice("include.".length);
      if (!(REPLAY_INCLUDE_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`--override ${key}: 知らない券種です(${kind}。${REPLAY_INCLUDE_KINDS.join("・")} のどれか)`);
      }
      include[kind as ReplayIncludeKind] = parseBoolean(key, value);
    } else {
      throw new Error(`--override のキーが知らないものです(${key}。${[...NUMBER_OVERRIDES, "includeComboOdds", "include.<券種>", "model"].join("・")})`);
    }
  }
  if (Object.keys(include).length > 0) out.include = include;
  validateOverrides(out);
  return out;
}

/** 上書きの内容を 1 行に書く(キーの並びは固定)。 */
export function describeOverrides(overrides: ReplayOverrides): string {
  const parts: string[] = [];
  for (const key of NUMBER_OVERRIDES) if (overrides[key] !== undefined) parts.push(`${key}=${overrides[key]}`);
  if (overrides.includeComboOdds !== undefined) parts.push(`includeComboOdds=${overrides.includeComboOdds}`);
  for (const kind of REPLAY_INCLUDE_KINDS) if (overrides.include?.[kind] !== undefined) parts.push(`include.${kind}=${overrides.include[kind]}`);
  if (overrides.model !== undefined) parts.push(`model=${overrides.model.id}`);
  if (overrides.adjustProb !== undefined) parts.push("adjustProb");
  return parts.join(", ");
}

const formatRate = (rate: number | null): string => (rate === null ? "なし" : `${(rate * 100).toFixed(1)}%`);

function formatTally(label: string, t: ReplayTally): string {
  const reasons = REPLAY_REASONS.map((r) => `${r} ${t.reasons[r]}`).join(", ");
  return `${label}: 全 ${t.rows} 行・計算し直せた ${t.replayed} 行・一致 ${t.reasons.match} 行(${formatRate(t.matchRate)}) [${reasons}]`;
}

function formatPayout(label: string, s: PayoutSummary): string {
  return `${label}: 点数 ${s.betCount}・賭け金 ${s.totalStake}・払戻 ${s.totalReturn}・回収率 ${formatRate(s.recoveryRate)}・判定不能 ${s.unjudgedCount}・返還 ${s.refundedCount}`;
}

function formatPayoutReport(label: string, report: PayoutReport): string[] {
  return [
    formatPayout(label, report.overall),
    ...PROPOSED_BET_TYPES.map((t) => formatPayout(`  ${t}`, report.byBetType[t]!)),
    formatPayout("  中央", report.byVenueKind.central),
    formatPayout("  地方", report.byVenueKind.nar),
  ];
}

/**
 * CLI の本体。出力の文字列と終了コードを返す(`load` はファイルの読み込み。テストで差し替える)。
 * `--replay` なしは要約と一致した件数、`--replay` ありは理由別・区分別の一致率と回収額(`--override` つきは一致率を出さない)。
 */
export function runCli(argv: readonly string[], load: (file: string) => AllocationDataset = loadAllocationDataset): { output: string; exitCode: number } {
  let file: string | undefined;
  let replay = false;
  const overridePairs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--replay") replay = true;
    else if (arg === "--override") {
      const value = argv[i + 1];
      if (value === undefined) return { output: `--override に key=value がありません\n${USAGE}`, exitCode: 1 };
      overridePairs.push(value);
      i += 1;
    } else if (arg.startsWith("--")) return { output: `知らないオプションです(${arg})\n${USAGE}`, exitCode: 1 };
    else if (file === undefined) file = arg;
    else return { output: `ファイルは 1 つだけ指定してください\n${USAGE}`, exitCode: 1 };
  }
  if (file === undefined) return { output: USAGE, exitCode: 1 };
  if (overridePairs.length > 0 && !replay) return { output: `--override は --replay と一緒に指定してください\n${USAGE}`, exitCode: 1 };
  let overrides: ReplayOverrides;
  try {
    overrides = parseOverrides(overridePairs);
  } catch (error) {
    return { output: (error as Error).message, exitCode: 1 };
  }
  let dataset: AllocationDataset;
  try {
    dataset = load(file);
  } catch (error) {
    return { output: `読み込めませんでした: ${(error as Error).message}`, exitCode: 1 };
  }
  const { meta, rows } = dataset;
  const lines = [`生成 ${meta.generatedAt}(形式 ${meta.format})`, `要約: ${JSON.stringify(summarize(rows))}`, `除外: ${JSON.stringify(meta.excluded)}`];
  if (!replay) {
    const report = summarizeReplay(rows);
    lines.push(`計算し直し: ${report.total.replayed} レース中 ${report.total.reasons.match} レースが分析時の提案と一致(理由別は --replay)`);
    return { output: lines.join("\n"), exitCode: 0 };
  }
  const overridden = Object.keys(overrides).length > 0;
  const target = replayableRows(rows);
  if (overridden) {
    lines.push("", `## 設定の上書き: ${describeOverrides(overrides)}(一致率は出さない)`);
  } else {
    const report = summarizeReplay(rows);
    lines.push("", "## 計算し直しの一致率(設定の上書きなし)", formatTally("全体", report.total), formatTally("中央", report.byVenueKind.central), formatTally("地方", report.byVenueKind.nar));
    const columns = Object.entries(report.nullSettingColumns).map(([k, n]) => `${k} ${n}`).join(", ");
    lines.push(
      `一致しない行のうち設定が NULL の列: ${columns === "" ? "なし" : columns}`,
      `code-drift のうち設定にも NULL がある行: ${report.codeDriftAlsoLegacy}`,
      `invalid のうち計算し直しが例外を投げた行(route=invalid の記録との食い違いではない): 全体 ${report.total.invalidThrown}・中央 ${report.byVenueKind.central.invalidThrown}・地方 ${report.byVenueKind.nar.invalidThrown}`,
    );
  }
  // モデルを上書きしたとき(Issue #524)は、そのモデルで route=invalid になった行を、計算し直せなかった行として回収額の集計から外す(行数は必ず出す)。
  // 分析時から invalid だった行(例: 枠連を含めて枠番が無い)も、モデルを上書きしたときはこの数に入る(原因がモデル以外のこともある)。
  // 計算は行ごとに 1 回で済ませる(配分の計算は重いので、判定と買い目の取得で二重にしない)。
  let counted = target;
  let betsOf: (row: AllocationRaceRow) => readonly AllocationRowBet[] = (r) => replayedBets(r, overrides) ?? [];
  if (overrides.model !== undefined) {
    const bets = new Map(target.map((r) => [r, replayedBets(r, overrides)] as const));
    counted = target.filter((r) => bets.get(r) !== null);
    betsOf = (r) => bets.get(r) ?? [];
    const dropped = target.filter((r) => bets.get(r) === null);
    const venue = (kind: AllocationRaceRow["venue_kind"]): number => dropped.filter((r) => r.venue_kind === kind).length;
    lines.push(`モデルの上書きで route=invalid になり計算し直せなかった行(回収額の集計に入れない): 全体 ${dropped.length}・中央 ${venue("central")}・地方 ${venue("nar")}`);
  }
  lines.push("", "## 回収額(円。検証画面と同じ判定。判定不能は賭け金・払戻に入れない)");
  lines.push(...formatPayoutReport(`分析時の提案(全 ${rows.length} 行)`, payoutReport(rows, storedBets)));
  lines.push(...formatPayoutReport(`分析時の提案(計算し直せた ${counted.length} 行)`, payoutReport(counted, storedBets)));
  lines.push(...formatPayoutReport(`計算し直した提案(計算し直せた ${counted.length} 行${overridden ? "・設定の上書きあり" : ""})`, payoutReport(counted, betsOf)));
  return { output: lines.join("\n"), exitCode: 0 };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output, exitCode } = runCli(process.argv.slice(2));
  (exitCode === 0 ? console.log : console.error)(output);
  process.exitCode = exitCode;
}
