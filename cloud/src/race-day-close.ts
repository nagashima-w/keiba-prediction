/**
 * 締切の直前の再計算(Issue #338〈#335-A1〉)の、DO(`RaceDayCore`)の SQLite の表と、入力の検証。純ロジック(`cloudflare:workers` を import しない)。時計・gate・D1 は持たない
 * (呼び出し側の `RaceDayCore` が持つ)。ここは SQL の読み書きと形の検査だけ。新しい表だけ(`CREATE TABLE IF NOT EXISTS`。既存の表には ALTER しない)。
 *
 * ## 表
 *  - `race_day_close_input`: レースごとに 1 行。**発走前の分析の保存と同じ同期区間で積む**、再計算に要る最小の入力(`input_json`。{@link CloseInput})。
 *    `instance` は発走前のタスクの `queued_at`(再予約で新しくなる=別の実行)、`analysis_id` は D1 に保存した分析の id、`start_ms` は発走の瞬間(UTC のエポックミリ秒)。
 *  - `race_day_close`: (レース, 回) ごとに 1 行。回 1 = 発走 {@link CLOSE_FIRST_LEAD_MS} 前、回 2 = {@link CLOSE_FINAL_LEAD_MS} 前(暫定)。
 *    `state`: `pending`(未了)→ `done`(D1 に保存した)| `abandoned`(保存を諦めた)。`attempts` は取得の試行回数、`save_attempts` は D1 への保存の試行回数。
 *    `next_try_at` は再試行の時刻(無ければ `due_ms` に起こす)。`fired_at` は最初に動き始めた時刻(遅れ `late_ms` の基準。再試行では進めない)。
 *    `payload_json` は、D1 に書く結果({@link CloseSavePayload})。**再計算が済んだ(または行わないと決めた)ら、保存の前に書く**=保存の再試行・再実行で取り直さない。
 *
 * **起きたときに必ず状態が変わる**(アラームの候補になる pending の行は、起きた処理が必ず `fired_at`・`attempts`・`next_try_at`・`state` のどれかを進める。進まないと、期限が過去のまま即時に起き続ける)。
 * 同じレースの発走前の分析を予約し直す(`enqueueTask`)と、そのレースの行と入力は消える({@link CloseStore.clear})=古い実行の再計算は起きない。
 */
import type { AnalysisAllocationSettings } from "../../packages/core/src/analysis/allocation-record.js";
import { assertClosePayload, CLOSE_ROUNDS, type CloseSavePayload } from "./analysis-close";
import type { SqlLike } from "./sql-like";

/** 取得の試行回数の上限(初回 + 再試行 1 回)。 */
export const CLOSE_FETCH_MAX_ATTEMPTS = 2;
/** 取得の再試行までの待ち(ミリ秒)。次の回の時刻・発走を超えるなら再試行しない。 */
export const CLOSE_FETCH_RETRY_DELAY_MS = 15_000;
/** D1 への保存の試行回数の上限。尽きたらその回は諦める(abandoned。D1 に行が残らない=画面は結果なし)。 */
export const CLOSE_SAVE_MAX_ATTEMPTS = 3;
/** D1 への保存の再試行までの待ち(ミリ秒)。 */
export const CLOSE_SAVE_RETRY_DELAY_MS = 20_000;

export type CloseState = "pending" | "done" | "abandoned";

/** `race_day_close` の行。 */
export interface CloseTaskRow {
  readonly race_id: string;
  readonly round: number;
  readonly analysis_id: number;
  readonly due_ms: number;
  readonly state: CloseState;
  readonly attempts: number;
  readonly save_attempts: number;
  readonly next_try_at: number | null;
  readonly fired_at: number | null;
  readonly payload_json: string | null;
}

/** `race_day_close_input` の行。 */
export interface CloseInputRow {
  readonly race_id: string;
  readonly instance: number;
  readonly analysis_id: number;
  readonly start_ms: number;
  readonly input_json: string;
}

/** 再計算に要る、馬ごとの最小の入力。 */
export interface CloseInputHorse {
  readonly umaban: number;
  readonly wakuban: number;
  readonly horseName: string;
  /** 統計モデルの事前確率。 */
  readonly prior: number;
  /** 分析時の補正後の3着内率(再計算では変えない)。 */
  readonly adjustedProb: number;
  /** 分析時に単勝オッズがあったか(締切時に無くなっていたら、取消などの馬の集合の食い違いとみなす)。 */
  readonly hadWinOdds: boolean;
  /** 分析時に複勝オッズの下限があったか(同上)。 */
  readonly hadPlaceOdds: boolean;
}

/** `input_json` の中身。 */
export interface CloseInput {
  readonly v: 1;
  /** 開催日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  readonly horses: readonly CloseInputHorse[];
  /** 設定のスナップショットのうち、配分に使う 10 項目(分析時と同じ値)。 */
  readonly allocationSettings: AnalysisAllocationSettings;
  /** EV の閾値(分析時の設定の `evThreshold`)。 */
  readonly evThreshold: number;
  /** 分析時の配分の route(`unset` なら再計算しても出ないので、オッズを取らない)。配分が無かったときは null。 */
  readonly baseRoute: string | null;
}

export interface CloseRegistration {
  readonly raceId: string;
  /** 発走前のタスクの `queued_at`。 */
  readonly instance: number;
  readonly analysisId: number;
  readonly startMs: number;
  readonly now: number;
  readonly input: CloseInput;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const SETTING_BOOLEANS = [
  "includeComboOdds",
  "includeWideInAllocation",
  "includeTrioInAllocation",
  "includeQuinellaInAllocation",
  "includeExactaInAllocation",
  "includeTrifectaInAllocation",
  "includeBracketQuinellaInAllocation",
] as const;

/** `input_json` の文字列を検証して {@link CloseInput} にする。JSON でない・形が違う(型・欠け・馬の重複)なら null(呼び出し側は `analysis-failed` にする)。 */
export function parseCloseInput(text: string): CloseInput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1 || typeof raw.kaisaiDate !== "string" || !Array.isArray(raw.horses) || raw.horses.length === 0) {
    return null;
  }
  if (!isNum(raw.evThreshold) || !(raw.baseRoute === null || typeof raw.baseRoute === "string")) {
    return null;
  }
  const settings = raw.allocationSettings;
  if (!isObj(settings) || !isNum(settings.bankroll) || !isNum(settings.perRaceCap) || !isNum(settings.kellyFraction)) {
    return null;
  }
  for (const key of SETTING_BOOLEANS) {
    if (typeof settings[key] !== "boolean") {
      return null;
    }
  }
  const seen = new Set<number>();
  const horses: CloseInputHorse[] = [];
  for (const h of raw.horses as unknown[]) {
    if (!isObj(h) || !isNum(h.umaban) || !isNum(h.wakuban) || typeof h.horseName !== "string" || !isNum(h.prior) || !isNum(h.adjustedProb) || typeof h.hadWinOdds !== "boolean" || typeof h.hadPlaceOdds !== "boolean") {
      return null;
    }
    if (seen.has(h.umaban)) {
      return null;
    }
    seen.add(h.umaban);
    horses.push({ umaban: h.umaban, wakuban: h.wakuban, horseName: h.horseName, prior: h.prior, adjustedProb: h.adjustedProb, hadWinOdds: h.hadWinOdds, hadPlaceOdds: h.hadPlaceOdds });
  }
  return {
    v: 1,
    kaisaiDate: raw.kaisaiDate,
    horses,
    allocationSettings: {
      bankroll: settings.bankroll,
      perRaceCap: settings.perRaceCap,
      kellyFraction: settings.kellyFraction,
      includeComboOdds: settings.includeComboOdds as boolean,
      includeWideInAllocation: settings.includeWideInAllocation as boolean,
      includeTrioInAllocation: settings.includeTrioInAllocation as boolean,
      includeQuinellaInAllocation: settings.includeQuinellaInAllocation as boolean,
      includeExactaInAllocation: settings.includeExactaInAllocation as boolean,
      includeTrifectaInAllocation: settings.includeTrifectaInAllocation as boolean,
      includeBracketQuinellaInAllocation: settings.includeBracketQuinellaInAllocation as boolean,
    },
    evThreshold: raw.evThreshold,
    baseRoute: raw.baseRoute,
  };
}

/** 保存の前に DO に持つ結果(`payload_json`)を読む。形が違う・不整合なら null(呼び出し側は、持っていないものとして取り直す)。 */
export function parseClosePayload(text: string): CloseSavePayload | null {
  try {
    const payload = JSON.parse(text) as CloseSavePayload;
    assertClosePayload(payload);
    return payload;
  } catch {
    return null;
  }
}

export class CloseStore {
  constructor(private readonly sql: SqlLike) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_close_input (
         race_id TEXT PRIMARY KEY, instance INTEGER NOT NULL, analysis_id INTEGER NOT NULL, start_ms INTEGER NOT NULL, input_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_close (
         race_id TEXT NOT NULL, round INTEGER NOT NULL, analysis_id INTEGER NOT NULL, due_ms INTEGER NOT NULL, state TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0, save_attempts INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER, fired_at INTEGER, payload_json TEXT,
         PRIMARY KEY (race_id, round))`,
    );
  }

  /**
   * 入力と回の行を積む(**同期**。発走前の分析の保存と同じ同期区間)。**発走を過ぎていれば何も積まない**(false)。
   * 既に積んである行・入力は変えない(`ON CONFLICT DO NOTHING`。計算ステップの再実行で巻き戻さない)。
   */
  register(reg: CloseRegistration): boolean {
    if (reg.startMs <= reg.now) {
      return false;
    }
    this.sql.exec(
      "INSERT INTO race_day_close_input (race_id, instance, analysis_id, start_ms, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(race_id) DO NOTHING",
      reg.raceId,
      reg.instance,
      reg.analysisId,
      reg.startMs,
      JSON.stringify(reg.input),
      reg.now,
    );
    for (const { round, leadMs } of CLOSE_ROUNDS) {
      this.sql.exec(
        "INSERT INTO race_day_close (race_id, round, analysis_id, due_ms, state) VALUES (?, ?, ?, ?, 'pending') ON CONFLICT(race_id, round) DO NOTHING",
        reg.raceId,
        round,
        reg.analysisId,
        reg.startMs - leadMs,
      );
    }
    return true;
  }

  /** そのレースの行と入力を消す(発走前の分析の予約し直し)。 */
  clear(raceId: string): void {
    this.sql.exec("DELETE FROM race_day_close WHERE race_id = ?", raceId);
    this.sql.exec("DELETE FROM race_day_close_input WHERE race_id = ?", raceId);
  }

  inputRow(raceId: string): CloseInputRow | null {
    const rows = this.sql.exec("SELECT * FROM race_day_close_input WHERE race_id = ?", raceId).toArray() as CloseInputRow[];
    return rows[0] ?? null;
  }

  /** 起こす時刻が来ている pending の行のうち、最も早いもの(同じ時刻は回・レース ID の順)。 */
  nextDue(now: number): CloseTaskRow | null {
    const rows = this.sql
      .exec("SELECT * FROM race_day_close WHERE state = 'pending' AND COALESCE(next_try_at, due_ms) <= ? ORDER BY COALESCE(next_try_at, due_ms), round, race_id LIMIT 1", now)
      .toArray() as CloseTaskRow[];
    return rows[0] ?? null;
  }

  /** アラームの候補: pending の行の、起こす時刻の最小(無ければ null。過去の時刻でもそのまま返す。呼び出し側が `max(…, now)` を取る)。 */
  nextAtMs(): number | null {
    const rows = this.sql.exec("SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day_close WHERE state = 'pending'").toArray() as { t: number | null }[];
    return rows[0]?.t ?? null;
  }

  /** 同じレースの、この回より後の回の `due_ms`(無ければ null)。1 回目が「次の回の時刻を過ぎたら意味が無い」の判定に使う。 */
  nextRoundDueMs(raceId: string, round: number): number | null {
    const rows = this.sql.exec("SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ? AND round > ?", raceId, round).toArray() as { t: number | null }[];
    return rows[0]?.t ?? null;
  }

  /** 最初に動き始めた時刻を書く(既にあれば変えない)。 */
  markFired(raceId: string, round: number, now: number): void {
    this.sql.exec("UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND round = ? AND fired_at IS NULL", now, raceId, round);
  }

  setPayload(raceId: string, round: number, payloadJson: string): void {
    this.sql.exec("UPDATE race_day_close SET payload_json = ? WHERE race_id = ? AND round = ?", payloadJson, raceId, round);
  }

  /** 取得の再試行を待つ(試行回数を書き、`next_try_at` に起こす)。 */
  markFetchRetry(raceId: string, round: number, attempts: number, nextTryAt: number): void {
    this.sql.exec("UPDATE race_day_close SET attempts = ?, next_try_at = ? WHERE race_id = ? AND round = ?", attempts, nextTryAt, raceId, round);
  }

  /** 取得の試行を数える(結果が決まって保存に進むとき。再試行の待ちではない)。 */
  setAttempts(raceId: string, round: number, attempts: number): void {
    this.sql.exec("UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND round = ?", attempts, raceId, round);
  }

  /** 保存の再試行を待つ。 */
  markSaveRetry(raceId: string, round: number, saveAttempts: number, nextTryAt: number): void {
    this.sql.exec("UPDATE race_day_close SET save_attempts = ?, next_try_at = ? WHERE race_id = ? AND round = ?", saveAttempts, nextTryAt, raceId, round);
  }

  markDone(raceId: string, round: number): void {
    this.sql.exec("UPDATE race_day_close SET state = 'done', next_try_at = NULL WHERE race_id = ? AND round = ?", raceId, round);
  }

  markAbandoned(raceId: string, round: number, saveAttempts: number): void {
    this.sql.exec("UPDATE race_day_close SET state = 'abandoned', save_attempts = ?, next_try_at = NULL WHERE race_id = ? AND round = ?", saveAttempts, raceId, round);
  }

  /** 行の数(テスト・診断用)。 */
  rows(): CloseTaskRow[] {
    return this.sql.exec("SELECT * FROM race_day_close ORDER BY race_id, round").toArray() as CloseTaskRow[];
  }
}
