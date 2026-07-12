/**
 * スクレイパのパース結果として得られるドメイン型。
 *
 * これらは今後 scorer(期待値計算)が参照する中心データ構造になるため、
 * 1ファイルに明確に定義して index.ts から公開する。
 */

import type { HorseId, RaceId } from "./ids.js";

/** コース種別。芝・ダート・障害の3種。 */
export type CourseType = "芝" | "ダ" | "障";

/** 厩舎所在地(トレセン)。 */
export type StableLocation = "美浦" | "栗東";

/**
 * レース一覧サブHTML(race_list_sub)から得られる1レース分の要約。
 * 注: レース名(name)はサーバ側で切り詰められている場合がある(full名は出馬表から取る)。
 */
export interface RaceListEntry {
  /** レースID(12桁)。 */
  readonly raceId: RaceId;
  /** レース名(切り詰められている場合あり)。 */
  readonly name: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 距離(メートル)。 */
  readonly distance: number;
  /** 出走頭数。 */
  readonly entryCount: number;
  /** 会場名(福島・小倉など)。取得できない構造では未定義。 */
  readonly venue?: string;
  /** レース番号(1〜12)。 */
  readonly raceNumber: number;
}

/** 馬体重とその増減(前走比)。未発表の場合は null で表す。 */
export interface BodyWeight {
  /** 馬体重(kg)。 */
  readonly weight: number;
  /** 前走からの増減(kg)。増は正、減は負、変わらずは0。 */
  readonly diff: number;
}

/** 出馬表の各出走馬。 */
export interface ShutubaHorse {
  /** 枠番(1〜8)。 */
  readonly wakuban: number;
  /** 馬番(1〜18)。 */
  readonly umaban: number;
  /** 馬名。 */
  readonly name: string;
  /** 馬ID(10桁)。 */
  readonly horseId: HorseId;
  /** 性別(牡/牝/セ)。 */
  readonly sex: string;
  /** 年齢。 */
  readonly age: number;
  /** 斤量(kg)。 */
  readonly kinryo: number;
  /** 騎手名。 */
  readonly jockeyName: string;
  /** 騎手ID。騎手未定・リンク欠損などで抽出できない場合は null。 */
  readonly jockeyId: string | null;
  /**
   * 厩舎所在地。中央は美浦/栗東が代表値だが、地方(NAR)では所属会場名(例: 高知・浦和)が
   * 入るため、値を丸めず取得した文字列をそのまま保持する(HorseProfile.stableLocation と
   * 同じ方針。中央限定の輸送バイアス計算では StableLocation 型に絞り込んで利用する)。
   */
  readonly stableLocation: string;
  /** 調教師名。 */
  readonly trainerName: string;
  /** 調教師ID。リンク欠損などで抽出できない場合は null。 */
  readonly trainerId: string | null;
  /** 馬体重(増減)。未発表の場合は null。 */
  readonly bodyWeight: BodyWeight | null;
}

/** 出馬表ページ上部のレース情報。 */
export interface ShutubaRaceInfo {
  /** レース名。 */
  readonly raceName: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 距離(メートル)。 */
  readonly distance: number;
  /** 発走時刻(HH:MM)。取得できない場合は未定義。 */
  readonly startTime?: string;
  /** 天候。取得できない場合は未定義。 */
  readonly weather?: string;
  /** 馬場状態。取得できない場合は未定義。 */
  readonly trackCondition?: string;
}

/** 出馬表のパース結果(レース情報+出走馬)。 */
export interface Shutuba {
  /** レース情報。 */
  readonly race: ShutubaRaceInfo;
  /** 出走馬(馬番昇順にソート済み)。 */
  readonly horses: ShutubaHorse[];
}

/**
 * 馬プロフィール(db.netkeiba.com/horse/{id}/ の db_prof_table + 見出し)。
 *
 * 取れない項目は null で表す(通算成績のように未出走馬では空になり得るため)。
 * comment パーサーは実装しない: 陣営コメント本文はプレミアム限定で無料では取得できない
 * (docs/phase1-scraping-plan.md「厩舎コメント」参照)。
 */
export interface HorseProfile {
  /** 馬ID(10桁)。 */
  readonly horseId: HorseId;
  /** 馬名(ページ見出し)。 */
  readonly name: string;
  /** 生年月日(例: 2023年2月17日)。取得できない場合は null。表記はそのまま保持する。 */
  readonly birthDate: string | null;
  /** 調教師名。取得できない場合は null。 */
  readonly trainerName: string | null;
  /** 調教師ID。リンク欠損などで抽出できない場合は null。 */
  readonly trainerId: string | null;
  /**
   * 厩舎所在地。美浦/栗東が代表値だが、地方・海外所属では他の表記があり得るため、
   * 既知値に丸めず取得した文字列をそのまま保持する(取得不可時のみ null)。
   */
  readonly stableLocation: string | null;
  /** 通算成績テキスト(例: 4戦2勝 [2-0-0-2])。取得できない場合は null。 */
  readonly totalResults: string | null;
}

/**
 * 全戦績1走分の着順。
 * 数値順位のほか、中止・除外・取消・失格などの非数値もあり得るため判別可能にする
 * (スコアリングでの除外判定に使う)。
 * 降着(例: 5(降))は確定着順を value に保持し、demoted フラグで区別する。
 */
export type FinishPosition =
  | { readonly kind: "順位"; readonly value: number; readonly demoted?: boolean }
  | { readonly kind: "非数値"; readonly text: string };

/**
 * 開催の区分。レース名リンクのIDから判定する。
 * - 中央: 場コード01〜10の12桁数値ID(JRA)
 * - 地方: 上記以外の12桁数値ID(船橋・大井・門別など地方交流)
 * - 海外: 12桁数値IDとして取得できないもの(英字混じりID・リンク欠損)
 *
 * Phase2で馬場適性・ローテーション集計に地方・海外走も用いるため、区分は捨てず保持する。
 */
export type VenueKind = "中央" | "地方" | "海外";

/** 開催(例: 2福島2 → 2回・福島・2日目)。分解できない部分は null。 */
export interface RaceVenue {
  /** 回次(例: 2)。 */
  readonly round: number | null;
  /** 会場名(例: 福島)。 */
  readonly name: string | null;
  /** 日目(例: 2)。 */
  readonly day: number | null;
  /** 分解前の生テキスト。 */
  readonly raw: string;
}

/**
 * 全戦績(ajax_horse_results)の1走分。
 *
 * 空セル・欠損(海外・地方の変則行など)は個別に null 許容とする。
 * ただし行のセル数がヘッダ列数と一致しない「行全体が壊れている」場合は
 * silent に捨てず HorseResultsParseError で失敗させる(方針踏襲)。
 */
export interface HorseRaceResult {
  /** 日付(例: 2026/06/28)。 */
  readonly date: string | null;
  /** 開催(会場・回次・日目)。 */
  readonly venue: RaceVenue | null;
  /** 天候。 */
  readonly weather: string | null;
  /** レース番号(R)。 */
  readonly raceNumber: number | null;
  /** レース名。 */
  readonly raceName: string | null;
  /**
   * レースID(レース名リンクから)。中央として妥当な12桁ID(場コード01〜10)のみ入る。
   * 地方・海外走・リンク欠損は null。
   */
  readonly raceId: RaceId | null;
  /**
   * レース名リンクから取得できたレースIDの生値。
   * 中央・地方はそのままの12桁数値ID、海外(英字混じり)・リンク欠損は null。
   */
  readonly raceIdRaw: string | null;
  /** 開催区分(中央/地方/海外)。レース名リンクのIDから判定する。 */
  readonly venueKind: VenueKind;
  /** 出走頭数。 */
  readonly entryCount: number | null;
  /** 枠番。 */
  readonly wakuban: number | null;
  /** 馬番。 */
  readonly umaban: number | null;
  /** 単勝オッズ。 */
  readonly odds: number | null;
  /** 人気。 */
  readonly ninki: number | null;
  /** 着順(数値順位 or 非数値種別)。 */
  readonly finishPosition: FinishPosition | null;
  /** 騎手名。 */
  readonly jockeyName: string | null;
  /** 騎手ID(リンクから)。無い場合は null。 */
  readonly jockeyId: string | null;
  /** 斤量(kg)。 */
  readonly kinryo: number | null;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: CourseType | null;
  /** 距離(メートル)。 */
  readonly distance: number | null;
  /** 馬場状態。 */
  readonly trackCondition: string | null;
  /** タイム(例: 1:45.9)。 */
  readonly time: string | null;
  /** 着差(例: 1.1、勝ち馬は負値もあり得る)。 */
  readonly margin: number | null;
  /** 通過順位(例: 2-3-4-3 → [2,3,4,3])。取得できない場合は空配列。 */
  readonly passing: number[];
  /** ペース(例: 29.9-37.6)。 */
  readonly pace: string | null;
  /** 上がり3F(例: 35.0)。 */
  readonly last3f: number | null;
  /** 馬体重(増減)。未計量などは null。 */
  readonly bodyWeight: BodyWeight | null;
  /** 勝ち馬名(自身が勝った場合は2着馬名)。 */
  readonly winnerName: string | null;
}

/** レース結果(result.html)の全着順テーブルから得る1頭分。 */
export interface RaceResultHorse {
  /** 馬番。 */
  readonly umaban: number;
  /**
   * 着順(数値順位 or 非数値種別)。中止・除外などは非数値、着順表示が空の場合は null。
   * 判別方式は全戦績(HorseRaceResult.finishPosition)と同じ FinishPosition 流儀に揃える。
   */
  readonly finishPosition: FinishPosition | null;
  /** 馬名。 */
  readonly horseName: string;
}

/**
 * 確定払戻の1点(複勝・単勝など)。
 * payout は「100円あたりの払戻額(円)」。netkeiba の払戻表記(例: 210円)がそのまま
 * 100円購入時の払戻であり、複勝オッズ=payout/100 に対応する。
 */
export interface RacePayoutEntry {
  /** 的中馬番。 */
  readonly umaban: number;
  /** 100円あたりの払戻額(円)。 */
  readonly payout: number;
}

/**
 * レース結果ページ(result.html)のパース結果。
 *
 * 全着順テーブル(#All_Result_Table)から各馬の着順を、払戻テーブルから複勝・単勝の
 * 確定払戻を取り出す。未確定レース等で払戻テーブルが無い場合、payout類は空配列になる。
 */
export interface RaceResult {
  /** 各馬の着順(全着順テーブルの並び順)。 */
  readonly horses: RaceResultHorse[];
  /** 複勝の確定払戻(払戻テーブル欠損時は空配列)。 */
  readonly placePayouts: RacePayoutEntry[];
  /** 単勝の確定払戻(払戻テーブル欠損時は空配列)。 */
  readonly winPayouts: RacePayoutEntry[];
}

/** 単勝オッズ(1頭分)。未確定・非数値は null。 */
export interface WinOdds {
  /** 単勝オッズ。未確定・非数値は null。 */
  readonly odds: number | null;
  /** 人気。取得できない場合は null。 */
  readonly ninki: number | null;
}

/** 複勝オッズ(1頭分)。下限・上限を持つ。未確定・非数値は null。 */
export interface PlaceOdds {
  /** 複勝オッズ下限。未確定・非数値は null。 */
  readonly oddsMin: number | null;
  /** 複勝オッズ上限。未確定・非数値は null。 */
  readonly oddsMax: number | null;
  /** 人気。取得できない場合は null。 */
  readonly ninki: number | null;
}

/**
 * オッズAPI(api_get_jra_odds)の発売状態。
 * - "result": 確定オッズ(レース確定後)。単勝・複勝ともに揃う。
 * - "middle": 発売中の暫定オッズ。単勝・複勝ともに揃う(EV計算は暫定値で可能)。
 * - "yoso":   前売り前の予想オッズ。単勝(odds[1])のみで複勝(odds[2])が存在しない。
 *
 * 発走前分析(翌日開催の事前分析)が本ツールの主用途のため、確定前の middle/yoso も受理する。
 * EV/UI 側が確定・暫定・予想を判別できるよう、この状態をスナップショットに保持する。
 */
export type OddsStatus = "result" | "middle" | "yoso";

/**
 * 単勝・複勝オッズのスナップショット(api_get_jra_odds)。
 * 馬番(数値)をキーに単勝・複勝を引ける。EV計算では複勝下限(oddsMin)を用いる。
 */
export interface OddsSnapshot {
  /** オッズ確定時刻(例: 2026-06-28 15:52:30)。取得できない場合は null。 */
  readonly officialDatetime: string | null;
  /** オッズの発売状態(確定/発売中/予想)。 */
  readonly oddsStatus: OddsStatus;
  /** 馬番 → 単勝オッズ。 */
  readonly win: Record<number, WinOdds>;
  /** 馬番 → 複勝オッズ。予想(yoso)では複勝未発売のため空オブジェクトになる。 */
  readonly place: Record<number, PlaceOdds>;
}

/**
 * 調教(追い切り)の1頭分。
 * 無料範囲では評価テキストと評価ランクのみ取得できる。
 * タイム・ラップはプレミアム領域のため今回スコープ外(将来 time? 等を足す余地を残す)。
 */
export interface OikiriEntry {
  /** 馬番。 */
  readonly umaban: number;
  /** 馬ID(10桁)。 */
  readonly horseId: HorseId;
  /** 馬名。 */
  readonly horseName: string;
  /** 調教評価テキスト(例: 動き良化)。空の場合は null。 */
  readonly critic: string | null;
  /** 調教評価ランク(例: B)。空の場合は null。 */
  readonly rank: string | null;
}

/** スキップした調教行の記録(silent に握りつぶさないための理由付き)。 */
export interface OikiriSkippedRow {
  /** 行位置(tr.HorseList の0始まりインデックス)。 */
  readonly rowIndex: number;
  /** スキップ理由(馬番範囲外・馬IDリンク欠損など)。 */
  readonly reason: string;
}

/**
 * 調教のパース結果。
 *
 * 調教は optional データ(analyzer は調教評価のみで動作する)であり、1行の異常で
 * 全頭分を破棄するのは過剰なため、異常行はスキップして正常行のみ返す。
 * ただし取りこぼしを silent にしないよう、スキップ件数と理由を保持する。
 */
export interface OikiriResult {
  /** 正常にパースできた各馬の調教評価(HTML上の並び順)。 */
  readonly entries: OikiriEntry[];
  /** スキップした行数(skipped.length と一致)。 */
  readonly skippedRowCount: number;
  /** スキップした行の内訳(理由付き)。 */
  readonly skipped: OikiriSkippedRow[];
}
