/**
 * 同レース(重賞)の過去10年結果傾向の集計(タスク機能B)。
 *
 * fetch-grade-winner.ts が取得・parse-grade-winner.ts がパースした過去回配列(GradeWinnerEntry[])
 * から、分析対象レースの条件(trackCode/track/kyori)に一致する回だけを対象に、決定論的な純関数
 * として傾向を集計する。ネットワーク・DBには一切依存しない。
 *
 * 条件フィルタ(2026-07-28 boss着手前ゲート合意・同日の要修正8で場一致の方式を訂正):
 * - trackCode(場コード。raceId.slice(4,6))+track(コース種別)+kyori(距離)の完全一致のみで
 *   絞り込む。場一致は当初 jyo(競馬場名の文字列)同士の比較にしていたが、
 *   venueNameFromRaceId(表示用の会場名解決)は未知の地方場コードで「地方(コードNN)」を返す
 *   ため API 側の jyo(実測: 地方は漢字の会場名、例「大井」)と永久に不一致になり、
 *   未知場コード(門別・水沢等)で機能しない欠陥があった。race_id 由来の場コード同士の比較なら
 *   VENUE_BY_NAR_TRACK_CODE 等の会場名テーブルに一切依存せず、未知の場コードでも正しく動く
 *   (raceId.slice(4,6) は ids.ts の parseRaceId/venueKindOfRaceId と同じ切り出し方)。
 *   なお過去回エントリ側の jyo_cd(payback.jyo_cd 等)は中央が文字列 "03" 型である一方、
 *   地方側の型を実測未確認のため使わず、GradeWinnerEntry.raceId(常に文字列として保持)から
 *   自前で切り出す(型の取り違えによる静かな不一致を避ける)。
 * - coursekubun_cd(柵)はフィルタに使わない(年ごとに柵は動きサンプルが不必要に減るため)。
 *   材料として提示するだけに留める(内訳を出す)。
 * - 条件一致が3回未満ならブロック全体を非表示(null)にする(同一レースの過去10年の結果傾向は
 *   標本が少なすぎると誤誘導になるため、same-day-trend.ts の「データ不足なら出さない」流儀を踏襲)。
 *
 * 複勝圏内馬の判定: 確定着順(kakutei)を正とする(入線順位nyusenは降着前で信頼できない)。
 * ijyo(取消・除外・中止等)が非nullの馬は、kakuteiが数値であっても防御的に除外する。
 *
 * 記述統計(脚質・上がり・内外)は same-day-trend.ts と性質が異なり、4着以下の対照群が
 * 無いため「内有利/外有利」等のラベルは一切付けない(複勝圏内馬の記述統計として、
 * サンプル数併記のみで中立に提示する。2026-07-28 boss着手前ゲート合意)。
 * 脚質(通過順相対)の算出は leg-style.ts の classifyRunLegStyleFull を再利用し、重複実装を作らない。
 *
 * レース名について(要修正7・2026-07-28 boss裁定): API の race_name とショウ馬表(出馬表)の
 * raceName には表記ゆれがある(実測: API「帝王賞競走」vs 出馬表「帝王賞」、中央は全角
 * 「ラジオＮＩＫＫＥＩ賞」)。このため本ファイル(条件フィルタ・集計)はレース名による照合・
 * 同定を一切行わない(trackCode/track/kyoriのみで絞り込む)。GradeWinnerEntry.raceName等の
 * レース名フィールドは現状どのブロックにも表示に使っていない(対象回数・条件一致/除外・
 * 頭数・馬場・柵・人気・複勝配当・記述統計のみで、レース名は出さない)。将来レース名を
 * 表示に使う場合は、出馬表側(build-prompt.ts の race.raceName。ユーザーが見ている画面と
 * 一致する)を正とし、API側の名称とは混在させないこと。
 */

import { classifyRunLegStyleFull } from "./leg-style.js";
import {
  fetchGradeWinnerEntries,
  type FetchGradeWinnerDeps,
} from "../scraper/fetch-grade-winner.js";
import type { RaceId } from "../scraper/ids.js";
import type {
  GradeWinnerEntry,
  GradeWinnerResultHorse,
} from "../scraper/parse-grade-winner.js";
import type { CourseType } from "../scraper/types.js";

/** 条件フィルタに使う、分析対象レース自身の条件。 */
export interface GradeWinnerConditions {
  /**
   * 場コード(2桁文字列。例: 福島なら"03")。分析対象の raceId.slice(4,6) をそのまま渡す。
   * 過去回エントリ側は raceId から同じ切り出し方で導出した場コードと比較する(要修正8:
   * jyo〈会場名の文字列〉同士の比較から変更。venueNameFromRaceId は未知の地方場コードで
   * 「地方(コードNN)」を返すためAPIのjyoと永久に不一致になる欠陥があった)。
   */
  readonly trackCode: string;
  /** コース種別(芝/ダ/障)。過去回の track と完全一致で比較する。 */
  readonly track: CourseType;
  /** 距離(m)。過去回の kyori と完全一致で比較する。 */
  readonly kyori: number;
}

/**
 * レースID文字列から場コード(5〜6桁目の2桁)を取り出す。
 * ids.ts の parseRaceId/venueKindOfRaceId と同じ切り出し方だが、GradeWinnerEntry.raceId は
 * パース失敗時 null になり得る未検証の文字列のため、検証済み RaceId 型は要求せず、
 * 6文字未満・nullは判定不能として null を返す(呼び出し側で自然に不一致=除外になる)。
 */
function trackCodeOfEntryRaceId(raceId: string | null): string | null {
  if (raceId === null || raceId.length < 6) {
    return null;
  }
  return raceId.slice(4, 6);
}

/** 値ごとの出現回数(馬場内訳・柵内訳に使う)。 */
export interface GradeWinnerValueCount {
  readonly 値: string;
  readonly 回数: number;
}

/** 最小〜最大のレンジ。 */
export interface GradeWinnerRange {
  readonly min: number;
  readonly max: number;
}

/** summarizeGradeWinnerTrend の出力。常に同じキー構成の構造化オブジェクトに固定する。 */
export interface GradeWinnerTrendSummary {
  /** APIから取得できた過去回の総数(条件一致・除外を問わない。10とは限らない)。 */
  readonly 対象回数: number;
  /** jyo+track+kyoriが一致した回数。 */
  readonly 条件一致回数: number;
  /** 条件不一致で除外した回数(= 対象回数 - 条件一致回数)。 */
  readonly 条件除外回数: number;
  /** 条件一致した回の出走頭数レンジ。集計対象が無ければ null。 */
  readonly 頭数レンジ: GradeWinnerRange | null;
  /** 条件一致した回の馬場状態の内訳。 */
  readonly 馬場内訳: readonly GradeWinnerValueCount[];
  /** 条件一致した回の柵の内訳(フィルタには使わず材料として提示するのみ)。 */
  readonly 柵内訳: readonly GradeWinnerValueCount[];
  /** 条件一致した回の複勝圏内(確定着順3着以内、降着は確定着順で判定)馬の延べ頭数。 */
  readonly 複勝圏内馬数: number;
  /** 複勝圏内馬の単勝人気レンジ。算出不能なら null。 */
  readonly 人気レンジ: GradeWinnerRange | null;
  /** 複勝圏内馬のうち単勝人気が二桁(10番人気以上)だった回数。 */
  readonly 二桁人気回数: number;
  /** 複勝配当(fuku_pay1〜3)のレンジ。算出不能なら null。 */
  readonly 複勝配当レンジ: GradeWinnerRange | null;
  /** 複勝配当(fuku_pay1〜3)の中央値。算出不能なら null。 */
  readonly 複勝配当中央値: number | null;
  /**
   * 複勝圏内馬の平均通過順相対(コーナー通過順の平均÷頭数。leg-style.ts の
   * classifyRunLegStyleFull による算出を再利用)。ラベル化はしない(参考値)。算出不能なら null。
   */
  readonly 平均通過順相対: number | null;
  /** 平均通過順相対の算出に使えたサンプル数。 */
  readonly 通過順相対サンプル数: number;
  /** 複勝圏内馬の平均上がり3F(秒)。算出不能なら null。 */
  readonly 平均上がり: number | null;
  /** 平均上がりの算出に使えたサンプル数。 */
  readonly 上がりサンプル数: number;
  /**
   * 複勝圏内馬の平均馬番相対(umaban÷頭数。ラベル化はしない=内有利/外有利という判定値を持たない)。
   *
   * 命名について(code-reviewer指摘・要修正1対応): 当初「平均枠相対」としていたが、実装は
   * wakuban(枠番。1〜8)ではなく umaban(馬番)を使っている。日本の競馬用語で「枠」と「馬番」は
   * 別概念(既存の scorer 側「枠順バイアス」は実際の枠番ベース)であり、「枠」を名乗ると
   * LLMや将来の読者が実際の枠番グループのバイアスと誤読するため、名称を実装(umaban)に
   * 合わせて「馬番相対」へ改称した(wakuban側の実装への変更は行わない: 頭数が少ないレースでは
   * 枠番と馬番がほぼ一致し、かつ馬番の方が粒度が細かく相対位置の指標として情報量が多いため)。
   */
  readonly 平均馬番相対: number | null;
  /** 平均馬番相対の算出に使えたサンプル数。 */
  readonly 馬番相対サンプル数: number;
}

/** 条件一致とみなす最小回数未満ならブロック全体を非表示にする閾値。 */
const MIN_MATCHED_RACES = 3;

/** 二桁人気とみなす人気の下限。 */
const DOUBLE_DIGIT_NINKI_MIN = 10;

/** 数値配列の単純平均(空なら null)。 */
function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 数値配列のmin/max(空なら null)。 */
function rangeOf(values: readonly number[]): GradeWinnerRange | null {
  if (values.length === 0) {
    return null;
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** 数値配列の中央値(空なら null)。偶数個は中央2値の平均。 */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 文字列配列を値ごとの出現回数に集計する(出現順で安定ソート)。 */
function countByValue(values: readonly string[]): GradeWinnerValueCount[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!counts.has(v)) {
      order.push(v);
    }
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return order.map((値) => ({ 値, 回数: counts.get(値)! }));
}

/**
 * 複勝圏内(確定着順3着以内)馬かどうかを判定する。
 * 確定着順(kakutei)を正とする(入線順位nyusenは降着前で信頼できない)。
 * ijyo(取消・除外・中止等)が非nullの馬は、kakuteiが数値でも防御的に除外する。
 */
function isPlacedHorse(horse: GradeWinnerResultHorse): boolean {
  if (horse.ijyo !== null) {
    return false;
  }
  return horse.kakutei !== null && horse.kakutei >= 1 && horse.kakutei <= 3;
}

/** 有限の正数かどうか(頭数・馬番等の妥当性チェック)。 */
function isPositiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/**
 * 過去回配列から同レース(重賞)の過去傾向を集計する。
 * @param entries fetchGradeWinnerEntries が返す過去回配列(長さ10とは限らない)
 * @param conditions 分析対象レース自身の条件(trackCode/track/kyori)。この条件と一致する回だけを集計する
 * @returns 条件一致が3回未満なら null(ブロック非表示)。それ以外は集計結果
 */
export function summarizeGradeWinnerTrend(
  entries: readonly GradeWinnerEntry[],
  conditions: GradeWinnerConditions,
): GradeWinnerTrendSummary | null {
  const total = entries.length;
  const matched = entries.filter(
    (e) =>
      trackCodeOfEntryRaceId(e.raceId) === conditions.trackCode &&
      e.track === conditions.track &&
      e.kyori === conditions.kyori,
  );

  if (matched.length < MIN_MATCHED_RACES) {
    return null;
  }

  const tosuValues = matched
    .map((e) => e.tosu)
    .filter((v): v is number => isPositiveFinite(v));
  const babaValues = matched
    .map((e) => e.baba)
    .filter((v): v is string => v !== null);
  const fenceValues = matched
    .map((e) => e.fence)
    .filter((v): v is string => v !== null);

  const ninkiValues: number[] = [];
  const paybackValues: number[] = [];
  const positionRatios: number[] = [];
  const last3fs: number[] = [];
  const umabanRatios: number[] = [];
  let placedCount = 0;

  for (const race of matched) {
    const placedHorses = race.result.filter(isPlacedHorse);
    placedCount += placedHorses.length;

    for (const horse of placedHorses) {
      if (isPositiveFinite(horse.ninki)) {
        ninkiValues.push(horse.ninki);
      }
      if (isPositiveFinite(horse.haron3)) {
        last3fs.push(horse.haron3);
      }
      if (isPositiveFinite(horse.umaban) && isPositiveFinite(race.tosu)) {
        umabanRatios.push(horse.umaban / race.tosu);
      }
      if (horse.corner !== null && isPositiveFinite(race.tosu)) {
        const passing = horse.corner
          .split("-")
          .map(Number)
          .filter((n) => Number.isFinite(n));
        if (passing.length > 0) {
          const detail = classifyRunLegStyleFull(passing, race.tosu);
          if (detail.averagePosition !== null) {
            positionRatios.push(detail.averagePosition);
          }
        }
      }
    }

    if (race.payback !== null) {
      const p = race.payback;
      for (const v of [p.fukuPay1, p.fukuPay2, p.fukuPay3]) {
        if (isPositiveFinite(v)) {
          paybackValues.push(v);
        }
      }
    }
  }

  return {
    対象回数: total,
    条件一致回数: matched.length,
    条件除外回数: total - matched.length,
    頭数レンジ: rangeOf(tosuValues),
    馬場内訳: countByValue(babaValues),
    柵内訳: countByValue(fenceValues),
    複勝圏内馬数: placedCount,
    人気レンジ: rangeOf(ninkiValues),
    二桁人気回数: ninkiValues.filter((n) => n >= DOUBLE_DIGIT_NINKI_MIN).length,
    複勝配当レンジ: rangeOf(paybackValues),
    複勝配当中央値: medianOf(paybackValues),
    平均通過順相対: average(positionRatios),
    通過順相対サンプル数: positionRatios.length,
    平均上がり: average(last3fs),
    上がりサンプル数: last3fs.length,
    平均馬番相対: average(umabanRatios),
    馬番相対サンプル数: umabanRatios.length,
  };
}

// ---------------------------------------------------------------------------
// collectGradeWinnerTrend(タスク機能B: 取得〈fetch-grade-winner.ts〉+集計〈summarizeGradeWinnerTrend〉
// の合成。analysis-pipeline.ts からはこの1関数を deps.fetcher 越しに束縛して呼ぶだけでよい。
// same-day-trend.ts の collectSameDayTrend(収集+集計をまとめた関数)と同じ役割分担の考え方。
// ---------------------------------------------------------------------------

/**
 * 指定レースの過去10年結果を取得し、分析対象レース自身の条件で集計する(タスク機能B)。
 *
 * @param raceId 分析対象のレースID(検証済み)
 * @param conditions 分析対象レース自身の条件(trackCode/track/kyori)。summarizeGradeWinnerTrend の
 *   フィルタにそのまま使われる
 * @param deps 注入依存(fetcher。通常は CachedFetcher)
 * @returns 非重賞・対象データなし(fetchGradeWinnerEntriesがnullを返す)、または条件一致が
 *   3回未満なら null(呼び出し側はこれを異常とみなさず静かにスキップすること)。中央・地方
 *   (NAR)いずれのraceIdでも動作する(fetchGradeWinnerEntriesがホストを自動選択する)。
 * @throws GradeWinnerParseError status:OKであるにもかかわらず応答構造が壊れている場合
 */
export async function collectGradeWinnerTrend(
  raceId: RaceId,
  conditions: GradeWinnerConditions,
  deps: FetchGradeWinnerDeps,
): Promise<GradeWinnerTrendSummary | null> {
  const entries = await fetchGradeWinnerEntries(raceId, deps);
  if (entries === null) {
    return null;
  }
  return summarizeGradeWinnerTrend(entries, conditions);
}
