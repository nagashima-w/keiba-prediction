/**
 * 枠連(bracketQuinella)の買い目の返還判定(Issue #269。#72 の残り)。取消・除外の馬がいるレースで、
 * 枠番の組の買い目が返還になるかを、結果の各馬の枠番と取消・除外の印から決める純関数。
 *
 * 検証画面の配分ベースの回収率(`verify.ts`)と、クラウド版の日報・月報(`cloud/src/daily-report-bets.ts` の `judgeBets`)が
 * **この1つの関数を共有する**(2つの数字が食い違わないようにするため。一致はテストで固定している)。
 * `better-sqlite3` に依存しない(Workers に載る)。
 *
 * ## 規定(JRA。原文の逐語。2026-10-13 に取得)
 * 出典: https://www.jra.go.jp/kouza/baken/ 「勝馬投票券の返還について」
 *   「ただし、枠連では組合せの関係で、次の例のように返還ができない場合がありますので、あらかじめご承知おきください。」
 *   「例1：出走しない馬の同枠に他馬がいない場合、その枠との組合せの勝馬投票券は返還となります。」
 *   「例2：出走しない馬の同枠に他馬が1頭いる場合、同枠のゾロ目のみ返還となります。」
 *   「例3：出走しない馬の同枠に他馬が2頭いる場合、同枠のゾロ目を含むすべての組合せで返還はございません。」
 * 地方競馬(地方競馬情報サイト https://www.keiba.go.jp/beginner/step6.html)も同趣旨:
 *   「ただし枠単・枠連について、当該枠の馬が全ていなくなった場合および当該枠のゾロ目の組番が消滅する場合に限り返還されます。」
 * 枠は詰めない(出馬表確定時の枠番のまま。JRA の別ページ「同枠取消に伴う取替えを含めて…お取替えは一切行いません」と、
 * 発売後に頭数が減っても発売開始時の内容で払戻す、という運用)。
 *
 * ## ここでの規則(枠 a ≤ b の組。各枠の「残り」 = 結果の行の数 − 取消・除外の数)
 *  - a ≠ b: 片方の枠の残りが 0(その枠の行が1つ以上あり、全員が取消・除外)なら返還(例1)。
 *  - a = b(ゾロ目): その枠に取消・除外が1頭以上いて、残りが 1 以下なら返還(例1・例2)。残りが 2 以上なら返還しない(例3)。
 *    「1枠に3頭いて2頭が取り消された(残り1)」は原文に例が無く、例2の一般化として扱う(ゾロ目は残りが2頭以上なければ成立しない)。
 *
 * ## 判定しない(返還にしない = 従来どおり不的中)ケース。保守的に倒す
 *  - そのレースに、`wakuban` が 1〜8 の整数でない行(null・未記録・範囲外)が1つでもある → レース全体を判定しない(`buildBracketFrameCensus` が null)。
 *    枠番を保存する前に取り込んだ旧い行は NULL で、頭数から枠番を導くことはしない(除外・地方で確かめていないため。ユーザー決定 2026-10-13)。
 *  - `scratched` が未記録(undefined。旧い行)の行が1つでもある → 同じくレース全体を判定しない。
 *  - 買い目のキーが枠番の2つ組として読めない → 返還にしない。
 *  - 買い目の枠に、結果の行が1つも無い → 返還にしない(行が結果表から落ちているのか、そもそも無い枠かを区別できない)。
 *
 * ## 観測の範囲
 * 取消・除外の馬の行に枠番があることは、中央の実フィクスチャで確認した(取消: result_202606040901 の6番〈枠3〉、
 * 除外: result_202605040205 の10番〈枠7〉)。地方の取消・除外は未観測(フィクスチャに無い。結果表に行が残るか、枠番が付くかは確かめていない)。
 */

import { MAX_WAKUBAN, parseComboOddsKey } from "../scraper/combo-odds-key.js";

/** 判定が読む1頭分(`RaceResultEntry` と日報の `ResultHorse` が、構造的に満たす)。 */
export interface BracketFrameHorse {
  /** 枠番(1〜8)。null・未記録(旧い行)は判定しない。 */
  readonly wakuban?: number | null;
  /** 取消・除外か。未記録(undefined。旧い行)は判定しない。 */
  readonly scratched?: boolean;
}

/** 1つの枠の集計。 */
export interface BracketFrameCount {
  /** その枠の結果の行の数(取消・除外の馬を含む)。 */
  readonly total: number;
  /** そのうち取消・除外の馬の数。 */
  readonly scratched: number;
}

/** 1レースの枠ごとの集計。 */
export interface BracketFrameCensus {
  readonly frames: ReadonlyMap<number, BracketFrameCount>;
}

function isValidWakuban(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_WAKUBAN;
}

/**
 * 1レースの結果の馬から、枠ごとの集計を作る。判定に使えない構成(馬が0頭・枠番が1〜8の整数でない行がある・
 * `scratched` が未記録の行がある)なら null。
 */
export function buildBracketFrameCensus(horses: readonly BracketFrameHorse[]): BracketFrameCensus | null {
  if (horses.length === 0) {
    return null;
  }
  const frames = new Map<number, { total: number; scratched: number }>();
  for (const horse of horses) {
    const wakuban = horse.wakuban;
    if (!isValidWakuban(wakuban) || horse.scratched === undefined) {
      return null;
    }
    const count = frames.get(wakuban) ?? { total: 0, scratched: 0 };
    count.total += 1;
    if (horse.scratched) {
      count.scratched += 1;
    }
    frames.set(wakuban, count);
  }
  return { frames };
}

/**
 * 枠連の買い目(`comboKey` は枠番の組。`"0407"` = 枠4と枠7)が返還になるか。`census` が null(判定できないレース)なら false。
 * 規則と、判定しないケースは、このファイルのヘッダ。
 */
export function isBracketQuinellaRefund(comboKey: string, census: BracketFrameCensus | null): boolean {
  if (census === null) {
    return false;
  }
  const wakubans = parseComboOddsKey(comboKey);
  if (wakubans === null || wakubans.length !== 2) {
    return false;
  }
  const first = wakubans[0]!;
  const second = wakubans[1]!;
  const a = census.frames.get(Math.min(first, second));
  const b = census.frames.get(Math.max(first, second));
  if (a === undefined || b === undefined) {
    // 枠番が 1〜8 の範囲外、または結果の行が無い枠(census の枠は 1〜8 に限る)。
    return false;
  }
  if (first === second) {
    // ゾロ目: 取消・除外があり、残りが 1 頭以下ならゾロ目が成立しなくなる。
    return a.scratched >= 1 && a.total - a.scratched <= 1;
  }
  return a.total - a.scratched === 0 || b.total - b.scratched === 0;
}
