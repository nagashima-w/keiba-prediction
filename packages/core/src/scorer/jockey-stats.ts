/**
 * 騎手の年度別成績(`parseJockeyResults`)から、scorer に渡す騎手成績(`JockeyCourseStats`)を作る(Issue #226)。
 *
 * ## 集計の窓(ユーザー決定 2026-10-11)
 * - **ライブ**(分析日が JST の今日以降。事前分析・発走前の分析): 分析日の年と前年の2年分。
 * - **過去日**(分析日が JST の今日より前。過去のレースを後から分析するとき): 分析日の年の前々年と前年の2年分。
 *   騎手の年度別成績は「いま」の値で、分析日の年の行には**分析日より後の騎乗**が含まれる(先読みリーク)ため、
 *   その年の行を使わない。前年以前の行は分析日の時点で確定している。
 *
 * 騎手のページは年度別の確定値しか持たないので、ライブでも当年の行には分析時点までの騎乗しか入っていない
 * (当日の開催が分析より前に終わっている再分析では、その日の騎乗が当年の行に入りうるが、2年分の数百走に対して
 * 数走の差で、補正の大きさ〈重み0.15〉では無視できる)。
 *
 * 「今日」の基準は **JST の暦日**(中央・地方とも日本の開催日で決まる。Worker の UTC でも JST の暦日で判定する)。
 */

import type { JockeyCourseStats } from "./base-score.js";
import type { JockeyYearRecord } from "../scraper/parse-jockey-results.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** YYYY/MM/DD の分析日から年を取り出す。形式が違えば失敗させる(黙って別の窓にしない)。 */
function yearOf(analysisDate: string): number {
  const m = /^(\d{4})\/\d{2}\/\d{2}$/.exec(analysisDate);
  if (m === null) {
    throw new Error(`分析日は YYYY/MM/DD の形式である必要があります(入力: "${analysisDate}")`);
  }
  return Number(m[1]);
}

/** JST の暦日(YYYY/MM/DD)。 */
function todayJst(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10).replaceAll("-", "/");
}

/**
 * 分析日がライブ(JST の今日以降)か、過去日か。
 * @param analysisDate 分析日(YYYY/MM/DD)
 * @param now 現在時刻
 */
export function isLiveAnalysisDate(analysisDate: string, now: Date): boolean {
  yearOf(analysisDate); // 形式の検査
  return analysisDate >= todayJst(now);
}

/** 集計する年の窓 `[古い年, 新しい年]`。 */
export function jockeyStatsWindow(analysisDate: string, live: boolean): readonly [number, number] {
  const y = yearOf(analysisDate);
  return live ? [y - 1, y] : [y - 2, y - 1];
}

/**
 * 騎手の年ごとの記録から、窓の年だけを足し合わせて `JockeyCourseStats` にする。
 * - 記録そのものが無い(取得できなかった・騎手IDが無い)ときは undefined(= 「データなし」)。
 * - 記録はあるが窓の年の行が無いときは騎乗数 0(scorer が「騎乗数が少ない」として補正しない)。
 * @param records `parseJockeyResults` の結果(取得できなかった騎手は undefined)
 * @param analysisDate 分析日(YYYY/MM/DD)
 * @param now 現在時刻(ライブか過去日かの判定に使う)
 */
export function selectJockeyStats(
  records: readonly JockeyYearRecord[] | undefined,
  analysisDate: string,
  now: Date,
): JockeyCourseStats | undefined {
  if (records === undefined) {
    return undefined;
  }
  const [from, to] = jockeyStatsWindow(analysisDate, isLiveAnalysisDate(analysisDate, now));
  let starts = 0;
  let placed = 0;
  for (const r of records) {
    if (r.year >= from && r.year <= to) {
      starts += r.starts;
      placed += r.placed;
    }
  }
  return { starts, placed };
}
