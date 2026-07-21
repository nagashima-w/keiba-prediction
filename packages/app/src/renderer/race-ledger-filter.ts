/**
 * 検証画面: レース一覧(state.raceLedger)の検索/絞り込み(純関数)。
 *
 * 分析が貯まるとレース一覧が縦に無限に長くなるため、目的のレースを見つけやすくする表示専用の
 * 絞り込み。ここでの絞り込みは**表示のみに効き**、verify レポート集計(#32 VerifyVenueFilter)・
 * #31 一括取込の母集団・#33 版不明削除の対象には一切影響しない(state.raceLedger 自体は
 * 変更せず、表示直前に filterRaceLedger を通すだけ)。
 *
 * #32 の venueFilter(検証レポート集計の母集団を中央/地方で切替。VerifyState.venueFilter)とは
 * 役割が異なる: あちらは累積回収率・キャリブレーション等の**集計対象**を絞り込み、こちらは
 * 既に取得済みのレース一覧の**見た目の表示件数**を絞り込むだけ。両者を混同しないよう、
 * VerifyView 側でも別セクション・別文言で配置する(コメント参照)。
 *
 * 絞り込み軸は3つ(ユーザー合意):
 * 1. 日付・期間(開催日 from/to)
 * 2. 会場(中央/地方の別、および競馬場名)
 * 3. レースID/会場名のキーワード部分一致
 * すべてAND(複数条件を同時に満たすエントリのみ残す)。
 */

import type { RaceLedgerView, VerifyVenueFilter } from "../shared/analysis-types.js";

/**
 * レース一覧の絞り込み条件。空条件(EMPTY_RACE_LEDGER_FILTER)は絞り込みなし(全件表示)。
 *
 * venueKind の型は検証レポートの地域フィルタ(VerifyVenueFilter。"all"|"central"|"nar")と
 * 完全に同じ概念(raceId の場コードによる中央/地方の判定)のため、新しい型を起こさず再利用する
 * (役割は別だが、値の意味・表示ラベルは venueFilterLabel がそのまま使い回せる)。
 */
export interface RaceLedgerFilter {
  /** 開催日の下限(YYYYMMDD)。未指定は null。 */
  readonly dateFrom: string | null;
  /** 開催日の上限(YYYYMMDD)。未指定は null。 */
  readonly dateTo: string | null;
  /** 中央/地方の別。既定 "all"(絞り込みなし)。 */
  readonly venueKind: VerifyVenueFilter;
  /**
   * 競馬場名(完全一致)。ドロップダウンでの選択を想定し、distinctVenueNames が返す
   * 実在の会場名のいずれかと完全一致するエントリのみ残す。未指定(すべて)は null。
   * 自由入力の部分一致は keyword が担う(役割が重複しないよう完全一致に限定する)。
   */
  readonly venueName: string | null;
  /**
   * レースID・会場名を対象にした部分一致キーワード(大文字小文字は無視、前後空白はトリム)。
   * RaceLedgerView にレース名フィールドが無いため対象は raceId・venueName の2つのみ
   * (レース名の新規配管はスコープ外)。空文字列(前後空白のみを含む)は絞り込みなし。
   */
  readonly keyword: string;
}

/** 絞り込み条件なし(初期状態・クリアボタン押下後)。 */
export const EMPTY_RACE_LEDGER_FILTER: RaceLedgerFilter = {
  dateFrom: null,
  dateTo: null,
  venueKind: "all",
  venueName: null,
  keyword: "",
};

/**
 * レースIDの場コード(5〜6桁目)から中央/地方を判定する。
 *
 * 中央/地方の判定ロジック自体は core venueKindOfRaceId(scraper/ids.ts)・main
 * venueNameFromRaceId(main/venue-codes.ts)と同じ場コード範囲(中央01〜10)によるが、
 * renderer層は core のバレル(@keiba/core)をそのまま import すると native依存
 * (better-sqlite3等。core/package.json の exports コメント参照)をバンドルに巻き込んでしまい、
 * この判定だけの狭い subpath も無いため、この一行の閾値判定のみをここに複製する
 * (RaceLedgerView.raceId は main の buildRaceLedgerView が venueNameFromRaceId を通した
 * 検証済み12桁の値のみを持つため、ここで形式検証をやり直す必要はない)。
 */
function venueKindOfRaceLedgerRaceId(raceId: string): "central" | "nar" {
  const trackCode = Number(raceId.slice(4, 6));
  return trackCode <= 10 ? "central" : "nar";
}

/**
 * 開催日(kaisaiDate)が期間内かどうかを判定する。
 *
 * 開催日不明(kaisaiDate=null)の扱い(設計判断・要仕様確認事項への回答が来るまでの暫定ではなく
 * 確定仕様): 期間(from/toのいずれか)を指定した場合は「範囲内か判定できない」ため除外し、
 * 期間を未指定(from/toとも null)の場合は開催日不明も含めて全件通す。
 */
function matchesDateRange(
  kaisaiDate: string | null,
  dateFrom: string | null,
  dateTo: string | null,
): boolean {
  if (dateFrom === null && dateTo === null) {
    return true;
  }
  if (kaisaiDate === null) {
    return false;
  }
  if (dateFrom !== null && kaisaiDate < dateFrom) {
    return false;
  }
  if (dateTo !== null && kaisaiDate > dateTo) {
    return false;
  }
  return true;
}

/** 中央/地方の別(venueKind)が条件に一致するか。"all" は常に一致。 */
function matchesVenueKind(raceId: string, venueKind: VerifyVenueFilter): boolean {
  if (venueKind === "all") {
    return true;
  }
  return venueKindOfRaceLedgerRaceId(raceId) === venueKind;
}

/** 競馬場名(完全一致)が条件に一致するか。null(すべて)は常に一致。 */
function matchesVenueName(entryVenueName: string, venueName: string | null): boolean {
  return venueName === null || entryVenueName === venueName;
}

/**
 * キーワード(raceId・venueNameの部分一致)が条件に一致するか。
 * 大文字小文字は無視(toLowerCase)。全角/半角の正規化までは行わない(過度に凝らない)。
 * 前後空白をトリムし、トリム後に空文字列なら絞り込みなし(常に一致)扱いにする。
 */
function matchesKeyword(entry: RaceLedgerView, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (normalized === "") {
    return true;
  }
  return (
    entry.raceId.toLowerCase().includes(normalized) ||
    entry.venueName.toLowerCase().includes(normalized)
  );
}

/**
 * レース一覧を絞り込み条件で絞り込む(表示のみに効く純関数)。
 * 4つの軸(日付、中央/地方、競馬場名、キーワード)はすべてAND。
 *
 * @param entries 検証画面のレース一覧(state.raceLedger)
 * @param filter 絞り込み条件
 * @returns 条件に一致するエントリのみの新しい配列(entries は変更しない)
 */
export function filterRaceLedger(
  entries: readonly RaceLedgerView[],
  filter: RaceLedgerFilter,
): RaceLedgerView[] {
  return entries.filter(
    (entry) =>
      matchesDateRange(entry.kaisaiDate, filter.dateFrom, filter.dateTo) &&
      matchesVenueKind(entry.raceId, filter.venueKind) &&
      matchesVenueName(entry.venueName, filter.venueName) &&
      matchesKeyword(entry, filter.keyword),
  );
}

/**
 * 絞り込み条件が何か入力されているか(EMPTY_RACE_LEDGER_FILTERから変化しているか)を判定する。
 *
 * 検証画面のレース一覧は、デフォルト(絞り込み未入力)では1件も表示しない仕様(Task#25)の
 * ゲート条件として使う。5つの軸のいずれか1つでも既定値から変化していればtrue(絞り込み中)。
 * keywordの空判定はmatchesKeywordと同じtrim()基準を使う(空白のみの入力は未入力扱い)。
 */
export function isRaceLedgerFilterActive(filter: RaceLedgerFilter): boolean {
  return (
    filter.dateFrom !== null ||
    filter.dateTo !== null ||
    filter.venueKind !== "all" ||
    filter.venueName !== null ||
    filter.keyword.trim() !== ""
  );
}

/**
 * レース一覧に登場する会場名を重複なく列挙する(競馬場名ドロップダウンの選択肢生成用)。
 * 五十音順(ja ロケール)で安定した並びにする。
 */
export function distinctVenueNames(entries: readonly RaceLedgerView[]): string[] {
  return Array.from(new Set(entries.map((e) => e.venueName))).sort((a, b) =>
    a.localeCompare(b, "ja"),
  );
}
