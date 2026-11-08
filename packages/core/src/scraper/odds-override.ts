/**
 * 中央のオッズを別の取得元(JRA 公式サイト)に差し替える差し込み口の型と、採用してよいかの判定(Issue #673 段階 B。#668)。
 *
 * `scrapeRace` は `deps.oddsOverride` があるとき、**中央のレースだけ**、単勝・複勝と組合せ(券種ごと)を先に差し込み側へ問い合わせる。
 * 値が返り、出走馬と食い違っていなければ採用し(その券種の netkeiba への取得は行わない)、そうでなければ今までどおり netkeiba から取る。
 * 差し込みが無い(未指定)ときは、発行する URL 列も戻り値の形も今までと変わらない(`meta.oddsSources` のキーも付かない)。
 * 地方(NAR)は対象外(差し込みを呼ばない)。
 *
 * 取得そのもの(JRA への通信・パース・キャッシュ)は差し込み側の仕事で、ここは判定と記録の形だけを持つ(core は通信を持たない)。
 */
import { parseComboOddsKey, type ComboBetType, type ComboOddsCell } from "./combo-odds-key.js";
import type { OddsSnapshot } from "./types.js";

/** オッズの取得元。 */
export type OddsSourceName = "jra" | "netkeiba";

/** netkeiba に戻した理由。 */
export type OddsFallbackReason =
  /** 差し込みが null を返した(取れなかった・読めなかった・キャッシュに無かった)。 */
  | "override-unavailable"
  /** 差し込みが例外を投げた。 */
  | "override-error"
  /** 値が出走馬(取消を除く)と食い違っていた。 */
  | "horse-set-mismatch";

/** 記録の単位。単勝・複勝は同じ頁なので 1 つにまとめる。 */
export type OddsSourceKind = "winPlace" | ComboBetType;

/** 1 つの単位の取得元の記録。 */
export interface OddsSourceRecord {
  readonly source: OddsSourceName;
  /** そのオッズの時刻(`YYYY-MM-DD HH:MM:SS`)。分からなければ null(netkeiba の組合せは時刻を持たない)。 */
  readonly officialDatetime: string | null;
  /** netkeiba に戻したときだけ付く理由。 */
  readonly fallbackReason?: OddsFallbackReason;
}

/** `RaceDataMeta.oddsSources`。差し込みを渡し、中央のレースを取ったときだけ付く(問い合わせた単位だけ)。 */
export type OddsSourcesMeta = Partial<Record<OddsSourceKind, OddsSourceRecord>>;

/** 組合せ 1 券種ぶんの差し込みの値。 */
export interface OddsOverrideCombo {
  /** 組のキー(`buildComboOddsKey` / `buildOrderedComboOddsKey` 形式)→ セル。 */
  readonly odds: ReadonlyMap<string, ComboOddsCell>;
  /** その頁の時刻。分からなければ null。 */
  readonly officialDatetime: string | null;
}

/** 差し込み口。どちらの関数も「使えない」ときは null を返す(例外でもよい。`scrapeRace` が握って netkeiba に戻る)。 */
export interface OddsOverride {
  /** 記録に残す取得元の名前。 */
  readonly source: Exclude<OddsSourceName, "netkeiba">;
  /** 単勝・複勝。 */
  winPlace?(): Promise<OddsSnapshot | null>;
  /** 組合せ(`includeComboOdds` のときだけ問い合わせる)。 */
  combo?(betType: ComboBetType): Promise<OddsOverrideCombo | null>;
}

/**
 * 単勝・複勝の差し込みを採用してよいか。出走馬(取消を除く)の全員に単勝オッズがあり、出走馬以外の欄は
 * 取消馬の空欄(単勝が null。netkeiba も取消馬の欄を残す)だけであること。
 */
export function winPlaceMatchesRunners(snapshot: OddsSnapshot, runnerUmabans: readonly number[]): boolean {
  const runners = new Set(runnerUmabans);
  for (const umaban of runners) {
    if ((snapshot.win[umaban]?.odds ?? null) === null) return false;
  }
  for (const [key, win] of Object.entries(snapshot.win)) {
    if (!runners.has(Number(key)) && win.odds !== null) return false;
  }
  return true;
}

/**
 * 組合せの差し込みを採用してよいか。キーの番号がすべて有効な範囲(馬連系は出走馬、枠連は 1〜8)にあり、
 * 組の数が期待数(出走馬・枠の構成から導いた値)と一致すること。
 */
export function comboMatchesRunners(
  odds: ReadonlyMap<string, ComboOddsCell>,
  validNumbers: ReadonlySet<number>,
  expectedCount: number,
): boolean {
  if (odds.size !== expectedCount) return false;
  for (const key of odds.keys()) {
    const parts = parseComboOddsKey(key);
    if (parts === null || !parts.every((n) => validNumbers.has(n))) return false;
  }
  return true;
}
