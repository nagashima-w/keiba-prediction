/**
 * 配分の再計算用の書き出し(Issue #463)を、開発側で読み込んで型つきの行にするローダと、1 レースぶんを本番の配分の関数に渡して計算し直す最小の骨格。
 * #468 の対策案の試算・#53・#386 の材料。理由別の一致率の集計・設定の上書き・回収額の集計は Issue #494(このファイルは、その土台)。
 *
 * ファイルは管理者が `GET /api/export/allocation-dataset` でダウンロードした `allocation-dataset-YYYYMMDD-HHMM.ndjson.gz`(NDJSON を gzip の複数メンバーで連結したもの。形式は
 * `cloud/src/allocation-export-format.ts`)。先頭行がメタ(`{"_meta": {...}}`)、以降が 1 行 1 レース。
 *
 * **黙って捨てない**: 読めない版・メタ行の無いファイル・件数の食い違い・壊れた行(JSON でない・列の過不足・型の違い)は、行番号つきの例外にする。
 *
 * ## 計算し直し(`replayRace`)
 * 行の分析時点のオッズ・確率・実効設定を、本番と同じ関数(`recomputeAllocationFromProbs`。分析時の配分も締切直前の再計算も呼ぶ関数)に渡す。D1 の NULL は
 * ここで解釈する(書き出しは NULL のまま): 券種の `include_*` が NULL は OFF、`min_hit_prob` が NULL は 0(下限なし)。それで分析時の提案と食い違ったとき、理由の分類は #494。
 * 組合せの取得診断(`comboOdds`)は渡さない(買い目の金額には効かず、配分のコードの診断にだけ使われる。往復のテストで、渡さなくても買い目が一致することを確かめている)。
 * 下限で外した買い目(`missed`)は、`recomputeAllocationFromProbs` が記録のための 2 回目の配分を呼ばないので、ここでは比べない。
 *
 * 使い方(リポジトリのルートで): `pnpm tsx scripts/allocation-dataset.ts <ファイル>` で要約(レース数・区分別・オッズなし・配分の記録なし)と、計算し直した買い目が分析時の提案と一致した件数を出す。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { recomputeAllocationFromProbs, type RecomputeAllocationResult } from "../packages/core/src/analysis/recompute-allocation.js";
import type { RaceData } from "../packages/core/src/scraper/scrape-race.js";
import { createRaceBetJudge, judgmentPayout, type BetJudgment, type JudgedHorse } from "../packages/core/src/ev/proposed-bet-judgment.js";
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
    if (![s["bankroll"], s["per_race_cap"], s["kelly_fraction"], s["ev_threshold"]].every(isNum) || !isNumOrNull(s["min_hit_prob"])) return "allocation.settings の数の列の型が違います";
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

/**
 * 1 レースの配分を、分析時の入力のまま本番の関数で計算し直す。D1 の NULL の解釈はファイル先頭の説明。
 * 枠番が分析時のスナップショットに無い馬は、結果の枠番(確定した事実)で補う。それも無ければ 0(枠連が配分に入る設定のときだけ、本番の関数が例外を投げ、route が invalid になる)。
 */
export function replayRace(row: AllocationRaceRow): ReplayOutcome {
  const allocation = row.allocation;
  if (allocation === null) return { kind: "no-allocation-record" };
  if (!row.has_odds) return { kind: "no-odds" };
  const s = allocation.settings;
  const wakubanOfResult = new Map(row.result.horses.map((h) => [h.umaban, h.wakuban] as const));
  const result = recomputeAllocationFromProbs({
    raceId: row.race_id,
    horses: row.horses.map((h) => ({ umaban: h.umaban, wakuban: h.wakuban ?? wakubanOfResult.get(h.umaban) ?? 0, horseName: "", prior: h.prior, adjustedProb: h.adjusted_prob })),
    odds: oddsOf(row, allocation.odds_status as OddsLike["oddsStatus"]),
    allocationSettings: {
      bankroll: s.bankroll,
      perRaceCap: s.per_race_cap,
      kellyFraction: s.kelly_fraction,
      includeComboOdds: s.include_combo_odds ?? false,
      includeWideInAllocation: s.include_wide ?? false,
      includeTrioInAllocation: s.include_trio ?? false,
      includeQuinellaInAllocation: s.include_quinella ?? false,
      includeExactaInAllocation: s.include_exacta ?? false,
      includeTrifectaInAllocation: s.include_trifecta ?? false,
      includeBracketQuinellaInAllocation: s.include_bracket_quinella ?? false,
      minHitProb: s.min_hit_prob ?? 0,
    },
    evConfig: { threshold: s.ev_threshold },
  });
  return { kind: "replayed", result };
}

export interface ReplayComparison {
  readonly same: boolean;
  /** 食い違った項目(空なら一致)。理由別の分類は #494。 */
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

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("使い方: pnpm tsx scripts/allocation-dataset.ts <allocation-dataset-*.ndjson.gz>");
    process.exitCode = 1;
  } else {
    const { meta, rows } = loadAllocationDataset(file);
    console.log(`生成 ${meta.generatedAt}(形式 ${meta.format})`);
    console.log(`要約: ${JSON.stringify(summarize(rows))}`);
    console.log(`除外: ${JSON.stringify(meta.excluded)}`);
    let replayed = 0;
    let same = 0;
    for (const row of rows) {
      const outcome = replayRace(row);
      if (outcome.kind !== "replayed") continue;
      replayed += 1;
      if (compareReplay(row, outcome).same) same += 1;
    }
    console.log(`計算し直し: ${replayed} レース中 ${same} レースが分析時の提案と一致(一致しない理由の分類は Issue #494)`);
  }
}
