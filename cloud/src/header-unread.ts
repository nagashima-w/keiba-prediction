/**
 * 出馬表の見出し(`div.RaceData01`)から読めなかった項目の判定(Issue #522)。**純関数**: DO・SQL・時計・送信を持たない。
 *
 * netkeiba が見出しの形を変えると(Issue #521)、天候・馬場状態・柵が、エラーにならずに黙って欠ける。馬場状態が欠けると道悪の判定(`isWet`)が false になり、
 * 統計モデルの馬場状態の補正がかからなくなる。そこで、読めなかったレースを数えて、Discord に 1 日 1 回知らせる(送る側は `notify-plan.ts`・`race-day-notify-stage.ts`)。
 *
 * ## 通知のきっかけ(ユーザー決定・2026-10-29)
 *  - **馬場状態が読めない**(`trackCondition` が無い。芝・ダート・障害のすべて)
 *  - **芝で柵が読めない**(`fence === null`。ダート・障害は `undefined`〈概念が無い〉なので数えない)
 *  - **天候はきっかけにしない。** 当日の発表前は、天候も馬場状態も柵と同じく未発表のことがあり、天候だけでは偽の警告が増える。形が変われば馬場状態か柵も同時に読めなくなるはずなので、
 *    天候は「きっかけになったレースで、天候も読めなかった」と添える情報としてだけ記録する。
 *  - 馬場や柵が未発表のときも同じように読めない(区別できない)。この判定は未発表と形の変化を見分けない。
 */
import type { ShutubaRaceInfo } from "../../packages/core/src/scraper/types";

/** 読めなかった項目。 */
export type HeaderItem = "馬場状態" | "柵" | "天候";

/** 保存・表示の順序(馬場状態 → 柵 → 天候)。 */
const ITEM_ORDER: readonly HeaderItem[] = ["馬場状態", "柵", "天候"];

/** 判定に使う、見出しから読んだ値(出馬表のレース情報の一部)。 */
export type HeaderRead = Pick<ShutubaRaceInfo, "courseType" | "weather" | "trackCondition" | "fence">;

/**
 * 読めなかった項目。馬場状態・柵(芝)のどちらも読めていれば空(天候だけ読めなくても空)。きっかけがあれば、天候も読めなかったときに「天候」を末尾に足す。
 * 順序は 馬場状態 → 柵 → 天候。
 */
export function findUnreadHeaderItems(header: HeaderRead): readonly HeaderItem[] {
  const items: HeaderItem[] = [];
  if (header.trackCondition === undefined) {
    items.push("馬場状態");
  }
  if (header.courseType === "芝" && header.fence === null) {
    items.push("柵");
  }
  if (items.length > 0 && header.weather === undefined) {
    items.push("天候");
  }
  return items;
}

/** 表の文字列(カンマ区切り)に保存する形。 */
export function formatHeaderItems(items: readonly HeaderItem[]): string {
  return items.join(",");
}

/** 表の文字列を項目に戻す。知らない語は捨てる(順序は保存時のまま)。 */
export function parseHeaderItems(text: string): HeaderItem[] {
  return text
    .split(",")
    .filter((word): word is HeaderItem => (ITEM_ORDER as readonly string[]).includes(word));
}

export interface HeaderUnreadSummary {
  /** きっかけがあったレースの数。 */
  readonly races: number;
  /** うち馬場状態を読めなかったレースの数。 */
  readonly track: number;
  /** うち芝の柵を読めなかったレースの数。 */
  readonly fence: number;
  /** うち天候も読めなかったレースの数。 */
  readonly weather: number;
}

/** 表の行から件数を数える。 */
export function summarizeHeaderUnread(rows: readonly { readonly missing: string }[]): HeaderUnreadSummary {
  let track = 0;
  let fence = 0;
  let weather = 0;
  for (const row of rows) {
    const items = parseHeaderItems(row.missing);
    track += items.includes("馬場状態") ? 1 : 0;
    fence += items.includes("柵") ? 1 : 0;
    weather += items.includes("天候") ? 1 : 0;
  }
  return { races: rows.length, track, fence, weather };
}
