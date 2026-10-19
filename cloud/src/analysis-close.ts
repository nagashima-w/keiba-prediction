/**
 * 締切の直前の再計算(Issue #338〈#335-A1〉)の、型・定数・D1 の文・行の写像。**型と純関数だけ**(Worker・DO・D1 の実体を import しない)。
 * `RaceDayCore`(DO。取り直しと再計算)・`D1AnalysisStore`(保存と読み出し)・`analysis-view.ts`(API の応答)が共有する。
 *
 * ## 何をするか
 * 発走前の分析(`pre_race`)が保存されたあと、発走の {@link CLOSE_FIRST_LEAD_MS} 前と {@link CLOSE_FINAL_LEAD_MS} 前の 2 回(回 1・回 2)、オッズだけを取り直し、
 * **確率は分析時のまま**(LLM は呼ばない)で EV と配分を作り直して D1 に残す。分析時の提案の行は上書きしない。通知はしない(画面は A-2)。
 *
 * ## D1 の表(migration 0019)
 * - `analysis_close`: (分析 id, 回) ごとに 1 行。`status` は `ok`(再計算できた)・`failed`(失敗)・`skipped`(行わなかった)。`reason` は {@link CloseReason} の固定の語彙(ok のときは NULL)。
 *   配分のメタ(`route` ほか 17 列)は `ok` のときだけ入る(`getStoredAllocation` が読むものと同じ列。`toStoredAllocation` で同じ形に戻す)。
 * - `analysis_close_bets`: `ok` の回の買い目(stake>0 の行だけ。`analysis_bets` と同じ形)。
 */
import { parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import { toStoredAllocation, type AllocationMetaRow } from "../../packages/core/src/ev/analysis-store-codec.js";
import type { AnalysisAllocationRecord, StoredAllocation, StoredAllocationBetDetail } from "../../packages/core/src/ev/analysis-store-types.js";

/** 1 回目: 発走の何ミリ秒前に起こすか(ユーザー決定 2026-10-16: 5 分前)。 */
export const CLOSE_FIRST_LEAD_MS = 5 * 60_000;
/**
 * 2 回目(締切の直前): 発走の何ミリ秒前に起こすか。**暫定値**(ユーザー決定 2026-10-16: 2 分前を暫定とする)。
 * 締切の正確な時刻はリポジトリに根拠が無く未確認で、後から変えられるよう定数にしている。
 */
export const CLOSE_FINAL_LEAD_MS = 2 * 60_000;

/** 回の番号と、その回の発走前のリード(ミリ秒)。回は 1 から始まる(D1 の `round` 列)。 */
export const CLOSE_ROUNDS: readonly { readonly round: CloseRound; readonly leadMs: number }[] = [
  { round: 1, leadMs: CLOSE_FIRST_LEAD_MS },
  { round: 2, leadMs: CLOSE_FINAL_LEAD_MS },
];

export type CloseRound = 1 | 2;

/** 再計算の結果の種類。 */
export type CloseStatus = "ok" | "failed" | "skipped";

/** 失敗(`failed`)の理由。固定の語彙(例外の文面・URL・本文は残さない)。 */
export const CLOSE_FAILED_REASONS = ["analysis-failed", "fetch-failed", "horse-set-mismatch", "compute-failed", "blocked", "combo-missing"] as const;
/** 行わなかった(`skipped`)理由。固定の語彙。 */
export const CLOSE_SKIPPED_REASONS = ["too-late", "unset", "nar-unsupported"] as const;

export type CloseFailedReason = (typeof CLOSE_FAILED_REASONS)[number];
export type CloseSkippedReason = (typeof CLOSE_SKIPPED_REASONS)[number];
export type CloseReason = CloseFailedReason | CloseSkippedReason;

/**
 * 理由の意味(コードの読み手向け。画面の文言は A-2)。
 *  - `too-late`: 起きたのが遅く、次の回の時刻(2 回目は発走)を過ぎていた。
 *  - `unset`: 分析時の提案が「総資金・1レース上限が未設定」で、配分が出ない(取り直しても変わらないので、オッズを取らない)。
 *  - `nar-unsupported`: **廃止した理由**(地方は Issue #379 から対象。新しくは書かない)。Issue #338 の時点で保存された旧い行(skipped)を読むために語彙には残す(消すと、理由が null に落ちる)。
 *  - `analysis-failed`: 再計算の入力(分析時に控えた確率)が無い・壊れている。
 *  - `fetch-failed`: オッズを取れなかった(通信の失敗・キャッシュに出馬表が無い・組合せオッズの取得の警告)。
 *  - `horse-set-mismatch`: 分析時にオッズのあった馬のオッズが無い(取消など)、または出馬表の馬の集合が分析時と違う。
 *  - `compute-failed`: 再計算が例外を投げた、または配分の計算が無効(route=invalid)になった。
 *  - `blocked`: ブレーカーが開いている・許可リスト外(再試行しない)。
 *  - `combo-missing`: 地方で組合せが ON の分析(部分的な取り直し。{@link closeComboBasis})で、分析時の組合せオッズを DO の取得キャッシュから読めなかった(掃除された・保存されなかった・
 *    分析の後に別の取得で上書きされた・入力に期間が無い)。待っても直らないので再試行しない。分析時にすでに組合せの取得に警告があった分析も同じ(中央の `fetch-failed` と同じ性質)。
 */

const REASONS: readonly string[] = [...CLOSE_FAILED_REASONS, ...CLOSE_SKIPPED_REASONS];
export function isCloseReason(value: unknown): value is CloseReason {
  return typeof value === "string" && REASONS.includes(value);
}

/**
 * 再計算で、組合せのオッズをどう扱ったか(Issue #379)。**新しい列は持たず、既存の値から導く**(migration なし): 場(race_id の場コード)と、分析時の設定 `includeComboOdds`。
 *  - `analysis`: 地方で組合せが ON。**単勝・複勝だけ取り直し、組合せは分析時のオッズ**のまま配分を作り直す(部分的な取り直し。地方の三連複・三連単は軸馬別でリクエストが多いため、取り直さない)。
 *  - `refetched`: それ以外。中央は組合せ ON なら組合せも取り直す。組合せ OFF なら配分に組合せが無いので、単勝・複勝だけの取り直しが全部。
 *
 * ★将来、地方の組合せも取り直すようにするなら、この導出は過去の行を誤分類する(過去の地方の ON の行も `refetched` になる)。そのときは、追加のみの列(例: `combo_basis`。
 * NULL = 旧い行は、この関数と同じ規則で導く)を足すこと。既存の列・制約は壊さない。
 */
export type CloseComboBasis = "refetched" | "analysis";

/** 場と分析時の設定から、組合せの扱い({@link CloseComboBasis})を導く。画面(サーバが文言を組み立てる)と検証の集計が同じ規則を使う。 */
export function closeComboBasis(venueKind: "central" | "nar", includeComboOdds: boolean): CloseComboBasis {
  return venueKind === "nar" && includeComboOdds ? "analysis" : "refetched";
}

/** race_id の場(中央/地方)。12 桁の形・場コードが不正なら `central`(画面・集計を落とさない。保存前に `parseRaceId` を通っているので通常は起きない)。 */
export function venueKindOfRaceIdSafe(raceId: string): "central" | "nar" {
  try {
    return venueKindOfRaceId(parseRaceId(raceId));
  } catch {
    return "central";
  }
}

/** D1 に書く 1 回ぶんの結果(DO が作り、`AnalysisSink.saveClose` に渡す)。 */
export interface CloseSavePayload {
  readonly round: CloseRound;
  readonly status: CloseStatus;
  /** `ok` のときは null。`failed` は {@link CloseFailedReason}、`skipped` は {@link CloseSkippedReason}。 */
  readonly reason: CloseReason | null;
  /** 本来起こすはずだった時刻(発走 − リード。UTC のエポックミリ秒)。 */
  readonly dueAtMs: number;
  /** 実際に動き始めた時刻。 */
  readonly firedAtMs: number;
  /** 起床の遅れ(`firedAtMs − dueAtMs`。負にはならない)。 */
  readonly lateMs: number;
  /** 取り直したオッズの netkeiba 側の時刻(`official_datetime`。`ok` のときだけ。取れなければ null)。 */
  readonly oddsOfficialDatetime: string | null;
  /** 再計算した配分(`status === "ok"` のときだけ。それ以外は null)。 */
  readonly allocation: AnalysisAllocationRecord | null;
}

/** 保存の前の形の検査(不整合は書かずに投げる)。`ok` ⇔ 配分あり・理由なし。`failed`・`skipped` ⇔ 配分なし・その区分の理由。 */
export function assertClosePayload(payload: CloseSavePayload): void {
  const { status, reason, allocation } = payload;
  if (!Number.isInteger(payload.round) || payload.round < 1) {
    throw new RangeError(`回は 1 以上の整数でなければなりません(${String(payload.round)})`);
  }
  if (status === "ok") {
    if (allocation === null || reason !== null) {
      throw new Error("ok の結果には配分が必要で、理由は付けられません");
    }
    return;
  }
  const allowed: readonly string[] = status === "failed" ? CLOSE_FAILED_REASONS : CLOSE_SKIPPED_REASONS;
  if (allocation !== null || reason === null || !allowed.includes(reason)) {
    throw new Error(`${status} の結果には、その区分の理由が必要で、配分は付けられません(理由: ${String(reason)})`);
  }
}

// ---------------------------------------------------------------------------
// D1 の文
// ---------------------------------------------------------------------------

/** 回の行の UPSERT(束縛値は {@link closeRowParams} の順)。主キーの衝突は上書き(DO のアラームは少なくとも 1 回は実行される=同じ結果の再保存で冪等)。 */
export const UPSERT_CLOSE_SQL = `INSERT INTO analysis_close
  (analysis_id, round, status, reason, due_at, fired_at, late_ms, odds_official_datetime,
   route, unavailable_reason, fallback_reason, skip_reason_code, bankroll, per_race_cap, kelly_fraction, ev_threshold,
   include_combo_odds, include_wide, include_trio, include_quinella, include_exacta, include_trifecta, include_bracket_quinella,
   bet_unit, odds_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(analysis_id, round) DO UPDATE SET
   status = excluded.status, reason = excluded.reason, due_at = excluded.due_at, fired_at = excluded.fired_at, late_ms = excluded.late_ms,
   odds_official_datetime = excluded.odds_official_datetime, route = excluded.route, unavailable_reason = excluded.unavailable_reason,
   fallback_reason = excluded.fallback_reason, skip_reason_code = excluded.skip_reason_code, bankroll = excluded.bankroll,
   per_race_cap = excluded.per_race_cap, kelly_fraction = excluded.kelly_fraction, ev_threshold = excluded.ev_threshold,
   include_combo_odds = excluded.include_combo_odds, include_wide = excluded.include_wide, include_trio = excluded.include_trio,
   include_quinella = excluded.include_quinella, include_exacta = excluded.include_exacta, include_trifecta = excluded.include_trifecta,
   include_bracket_quinella = excluded.include_bracket_quinella, bet_unit = excluded.bet_unit, odds_status = excluded.odds_status`;

/** 回の買い目の削除(再保存で、前の保存の買い目を残さない。束縛値は analysis_id・round)。 */
export const DELETE_CLOSE_BETS_SQL = "DELETE FROM analysis_close_bets WHERE analysis_id = ? AND round = ?";

/** 買い目を 1 文で入れる(束縛値は analysis_id・round・買い目の配列の JSON 文字列〈各要素は [betType, comboKey, stake, odds, ev]〉)。 */
export const INSERT_CLOSE_BETS_SQL = `INSERT INTO analysis_close_bets (analysis_id, round, bet_type, combo_key, stake, odds, ev)
  SELECT ?, ?, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]') FROM json_each(?)`;

/** 分析 1 件の回の行(回の昇順。束縛値は analysis_id)。 */
export const SELECT_CLOSE_SQL = `SELECT round, status, reason, due_at AS dueAt, fired_at AS firedAt, late_ms AS lateMs, odds_official_datetime AS oddsOfficialDatetime,
       route, unavailable_reason AS unavailableReason, fallback_reason AS fallbackReason, skip_reason_code AS skipReasonCode, bankroll, per_race_cap AS perRaceCap,
       kelly_fraction AS kellyFraction, ev_threshold AS evThreshold, include_combo_odds AS includeComboOdds, include_wide AS includeWide,
       include_trio AS includeTrio, include_quinella AS includeQuinella, include_exacta AS includeExacta, include_trifecta AS includeTrifecta,
       include_bracket_quinella AS includeBracketQuinella, bet_unit AS betUnit, odds_status AS oddsStatus
  FROM analysis_close WHERE analysis_id = ? ORDER BY round`;

/** 分析 1 件の買い目(回・券種・キーの昇順。束縛値は analysis_id)。 */
export const SELECT_CLOSE_BETS_SQL = `SELECT round, bet_type AS betType, combo_key AS comboKey, stake, odds, ev
  FROM analysis_close_bets WHERE analysis_id = ? ORDER BY round, bet_type, combo_key`;

const ms = (epochMs: number): string => new Date(epochMs).toISOString();

/** {@link UPSERT_CLOSE_SQL} の束縛値。配分のメタ列は `ok` のときだけ値、それ以外は NULL。 */
export function closeRowParams(analysisId: number, payload: CloseSavePayload): readonly (string | number | null)[] {
  const m = payload.allocation?.meta ?? null;
  const flag = (v: boolean | undefined): number | null => (v === undefined ? null : v ? 1 : 0);
  return [
    analysisId,
    payload.round,
    payload.status,
    payload.reason,
    ms(payload.dueAtMs),
    ms(payload.firedAtMs),
    payload.lateMs,
    payload.oddsOfficialDatetime,
    m?.route ?? null,
    m?.unavailableReason ?? null,
    m?.fallbackReason ?? null,
    m?.skipReasonCode ?? null,
    m?.bankroll ?? null,
    m?.perRaceCap ?? null,
    m?.kellyFraction ?? null,
    m?.evThreshold ?? null,
    flag(m?.includeComboOdds),
    flag(m?.includeWide),
    flag(m?.includeTrio),
    flag(m?.includeQuinella),
    flag(m?.includeExacta),
    flag(m?.includeTrifecta),
    flag(m?.includeBracketQuinella),
    m?.betUnit ?? null,
    m?.oddsStatus ?? null,
  ];
}

/** {@link INSERT_CLOSE_BETS_SQL} の 3 つ目の束縛値(買い目の配列の JSON 文字列)。 */
export function closeBetsJson(payload: CloseSavePayload): string {
  return JSON.stringify((payload.allocation?.bets ?? []).map((b) => [b.betType, b.comboKey, b.stake, b.odds, b.ev]));
}

// ---------------------------------------------------------------------------
// 読み出し
// ---------------------------------------------------------------------------

/** {@link SELECT_CLOSE_SQL} の行(列の別名どおり)。 */
export interface CloseRow {
  readonly round: number;
  readonly status: string;
  readonly reason: string | null;
  readonly dueAt: string;
  readonly firedAt: string;
  readonly lateMs: number;
  readonly oddsOfficialDatetime: string | null;
  readonly route: string | null;
  readonly unavailableReason: string | null;
  readonly fallbackReason: string | null;
  readonly skipReasonCode: string | null;
  readonly bankroll: number | null;
  readonly perRaceCap: number | null;
  readonly kellyFraction: number | null;
  readonly evThreshold: number | null;
  readonly includeComboOdds: number | null;
  readonly includeWide: number | null;
  readonly includeTrio: number | null;
  readonly includeQuinella: number | null;
  readonly includeExacta: number | null;
  readonly includeTrifecta: number | null;
  readonly includeBracketQuinella: number | null;
  readonly betUnit: number | null;
  readonly oddsStatus: string | null;
}

/** {@link SELECT_CLOSE_BETS_SQL} の行。 */
export interface CloseBetRow extends StoredAllocationBetDetail {
  readonly round: number;
}

/** 読み出した 1 回ぶん。`allocation` は `ok` のときだけ(分析時の提案と同じ形)。 */
export interface StoredCloseRound {
  readonly round: number;
  readonly status: CloseStatus;
  readonly reason: CloseReason | null;
  readonly dueAt: string;
  readonly firedAt: string;
  readonly lateMs: number;
  readonly oddsOfficialDatetime: string | null;
  readonly allocation: StoredAllocation | null;
}

const isStatus = (v: string): v is CloseStatus => v === "ok" || v === "failed" || v === "skipped";

/**
 * 行から {@link StoredCloseRound} を作る。状態が未知の行・`ok` なのにメタ列が欠けた行は捨てる(null)。理由が未知の値なら null にする(未知の語彙を画面に流さない)。
 * 配分は `toStoredAllocation`(分析時の提案と同じ復元)を通す。
 */
export function toStoredCloseRound(row: CloseRow, bets: readonly CloseBetRow[]): StoredCloseRound | null {
  if (!isStatus(row.status)) {
    return null;
  }
  const reason = isCloseReason(row.reason) ? row.reason : null;
  let allocation: StoredAllocation | null = null;
  if (row.status === "ok") {
    if (
      row.route === null ||
      row.bankroll === null ||
      row.perRaceCap === null ||
      row.kellyFraction === null ||
      row.evThreshold === null ||
      row.includeComboOdds === null ||
      row.includeWide === null ||
      row.includeTrio === null ||
      row.oddsStatus === null
    ) {
      return null;
    }
    const meta: AllocationMetaRow = {
      route: row.route,
      unavailableReason: row.unavailableReason,
      fallbackReason: row.fallbackReason,
      skipReasonCode: row.skipReasonCode,
      bankroll: row.bankroll,
      perRaceCap: row.perRaceCap,
      kellyFraction: row.kellyFraction,
      evThreshold: row.evThreshold,
      includeComboOdds: row.includeComboOdds,
      includeWide: row.includeWide,
      includeTrio: row.includeTrio,
      includeQuinella: row.includeQuinella,
      includeExacta: row.includeExacta,
      includeTrifecta: row.includeTrifecta,
      includeBracketQuinella: row.includeBracketQuinella,
      betUnit: row.betUnit,
      oddsStatus: row.oddsStatus,
    };
    allocation = toStoredAllocation(
      meta,
      bets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })),
    );
  }
  return {
    round: row.round,
    status: row.status,
    reason: row.status === "ok" ? null : reason,
    dueAt: row.dueAt,
    firedAt: row.firedAt,
    lateMs: row.lateMs,
    oddsOfficialDatetime: row.oddsOfficialDatetime,
    allocation,
  };
}

/** 行と買い目から、回の昇順の {@link StoredCloseRound} の配列を作る(捨てた行は除く)。 */
export function toStoredClose(rows: readonly CloseRow[], bets: readonly CloseBetRow[]): StoredCloseRound[] {
  const out: StoredCloseRound[] = [];
  for (const row of [...rows].sort((a, b) => a.round - b.round)) {
    const stored = toStoredCloseRound(
      row,
      bets.filter((b) => b.round === row.round),
    );
    if (stored !== null) {
      out.push(stored);
    }
  }
  return out;
}
