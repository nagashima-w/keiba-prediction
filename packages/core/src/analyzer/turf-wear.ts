/**
 * 芝の傷み目安(タスク#26-P3a)。
 *
 * 「開催回・日次・柵letter」という事実のみを中立な材料文として組み立てる決定論的な純関数。
 * 段階分け(level)は設けない。「開催が進むほど芝は傷みやすい」という一般論の方向・程度の
 * 解釈は一切行わず、LLM(プロンプト側)へ完全に委任する(2026-07-22 boss着手前ゲート合意)。
 * fence・round は事実併記のみで、傷みの強弱の断定表現には使わない。
 *
 * ネットワーク・DB には一切依存しない(centralVenueInfoFromRaceId を内部で使うだけ)。
 *
 * ## 連続開催の通算の日数と、いまの柵の日数(Issue #519)
 * 前の回から続けて芝を使っているとき、その通算の日数と、いまの柵(A・B・C…)になってから何日目かを、事実として足す。
 * 入力の過去の行(`KaisaiDayRow`。D1 の `kaisai_days`)は呼び出し側が読んで渡す。この関数は読まない。
 * 規則(ゲートで合意):
 *  - 今の回の 1〜N−1 日目が全部そろわなければ、新しい値は両方とも出さない(いまの文のまま)。N=1 なら今の回の初日は今日。
 *  - 今の回の初日より前で一番新しい行を P とする。P の日付から今の回の初日までが {@link CONTINUITY_MAX_GAP_DAYS} 日以内なら「続いている」とみなす。
 *    続いているときは、P の回の 1〜P.日次がすべてそろっていることを確かめ(そろっていなければ両方とも出さない)、P の回の初日についても同じ判定を繰り返す(年をまたいでよい)。
 *  - 回 K が 2 以上のとき、前の回は (同じ年, K−1) でなければならない。違う(または無い)ときはデータの欠落とみなし、両方とも出さない。
 *    「続いていない」と言うのは、P が (同じ年, K−1) で、その回の 1〜P.日次がそろっていて、間隔が 7 日を超えるときだけ。
 *  - K=1 は前の回の番号が分からない。P が無い、または間隔が 7 日を超えるなら「続いていない」。P が前年の回で 7 日以内なら続いている(1〜P.日次がそろっていることが前提)。
 *  - 柵の日数は、連続の範囲の中で今日から遡り、今日の柵と同じ日を数える(今日を 1 とする)。違う柵の日に当たったら止めてその数を出す。柵が NULL の日に当たったら出さない(推測しない)。
 *
 * 限界(許容済み): 行から分かるのは「ある」日だけで、前の回が何日あるかは分からない。そのため前の回の最終日の行だけが欠けていると、
 * 最終日の手前の日を P とみなして通算が 1 日少なく出る(最終日の行は、間隔の判定にも通算にも入らない)。
 * K=1 でも同じ種類の限界がある。K=1 は前の回の番号が分からないので、前年の最後の回の行が丸ごと欠けていると、実際は年をまたいで続いていても
 * 「前の行が無い=続いていない」と読む。この場合は通算が出ず、柵の日数も今の回の中だけで数えた小さい値になる(欠落とは判定できないので、新しい値を出さない側には倒れない)。
 */

import { centralVenueInfoFromRaceId } from "../scraper/ids.js";
import type { CourseType } from "../scraper/types.js";

/**
 * 過去の開催日の行 1 件(D1 の `kaisai_days` の 1 行。Issue #519)。
 * (場コード, 年, 回, 日次)で 1 日を表し、開催日と、その日の芝の柵(読めなかった・芝以外は null)を持つ。
 */
export interface KaisaiDayRow {
  /** 場コード(2 桁。中央は 01〜10)。 */
  readonly trackCode: string;
  /** 開催年(西暦 4 桁)。 */
  readonly year: number;
  /** 開催回(1 以上)。 */
  readonly kai: number;
  /** 開催日次(1 以上)。 */
  readonly nichi: number;
  /** 開催日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  /** その日の芝の柵(例: "A")。芝で読めたときだけ。読めない・芝以外は null。 */
  readonly fence: string | null;
}

/**
 * 通算の日数と柵の日数を数えるための履歴(Issue #519)。
 * `rows` が null は「過去の行を読めなかった」(いまの文のまま)。
 */
export interface TurfWearHistory {
  /** 今日の開催日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  /** 同じ場の過去の行(開催日より前のもの。順不同でよい)。読めなかったときは null。 */
  readonly rows: readonly KaisaiDayRow[] | null;
}

/** 前の回の最終日から今の回の初日までの間隔が、この日数以内なら「続いている」とみなす(Issue #519)。 */
export const CONTINUITY_MAX_GAP_DAYS = 7;

/**
 * 芝の傷み目安ヒント。
 * 常に同じキー構成の構造化オブジェクトに固定する(same-day-trend.ts 等と同じ方針)。
 */
export interface TurfWearHint {
  /** 開催日次(1以上の整数)。中央raceIdのday部をNumber化した値。 */
  readonly 開催日次: number;
  /** 開催回次(1以上の整数)。round部が0以下・非有限なら null(その回次情報のみ欠落扱い)。 */
  readonly 開催回次: number | null;
  /** 柵letter(例: "A")。芝だが柵を判別できない場合は null。 */
  readonly 柵: string | null;
  /**
   * 連続開催の通算の日数(Issue #519。今日を含む)。前の回から続けて芝を使っていると判定できたときだけ。続いていない・判定できないときは null。
   */
  readonly 通算日次: number | null;
  /** 連続の最初の回の開催年(Issue #519)。`通算日次` が null のときは null。 */
  readonly 連続開始年: number | null;
  /** 連続の最初の回(Issue #519。例: 3 回から続いていれば 3)。`通算日次` が null のときは null。 */
  readonly 連続開始回: number | null;
  /**
   * いまの柵になってから何日目か(Issue #519。今日を 1 とする)。連続の範囲の中で数え、今日の柵が分からない・柵が NULL の日に当たった・欠けがあるときは null。
   */
  readonly 柵日数: number | null;
  /** 方向を断定しない中立の材料文(プロンプトへそのまま1行として載せる想定)。 */
  readonly note: string;
}

/** 中立の材料文の共通末尾(内外・前後の有利は断定しない旨)。 */
const NEUTRAL_SUFFIX =
  "開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。";

/** YYYYMMDD(実在日)を UTC の通し日数にする。形が違う・実在しない日は null。 */
function dayNumberOf(ymd: string): number | null {
  if (!/^\d{8}$/.test(ymd)) {
    return null;
  }
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return Math.round(time / 86_400_000);
}

interface DatedRow {
  readonly row: KaisaiDayRow;
  /** 開催日の通し日数。 */
  readonly dayNumber: number;
}

const keyOf = (year: number, kai: number, nichi: number): string => `${year}-${kai}-${nichi}`;

/**
 * 1 つの回の 1〜count 日目の行を日次の順に返す。1 日でも欠けている、または日付が日次の順に増えていなければ null。
 */
function collectMeeting(byKey: ReadonlyMap<string, DatedRow>, year: number, kai: number, count: number): DatedRow[] | null {
  const out: DatedRow[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let nichi = 1; nichi <= count; nichi += 1) {
    const found = byKey.get(keyOf(year, kai, nichi));
    if (found === undefined || found.dayNumber <= previous) {
      return null;
    }
    out.push(found);
    previous = found.dayNumber;
  }
  return out;
}

/** {@link analyzeContinuity} の結果(欠けがなかったときだけ作る)。 */
interface Continuity {
  /** 続いているときだけ、通算の日数(今日を含む)。続いていなければ null。 */
  readonly total: number | null;
  readonly startYear: number | null;
  readonly startKai: number | null;
  /** いまの柵の日数。分からなければ null。 */
  readonly fenceDays: number | null;
}

/**
 * 連続開催の通算の日数と柵の日数を数える(Issue #519。規則はこのファイルの冒頭を参照)。
 * 欠け・矛盾があって判定できないときは null(新しい値を両方とも出さない)。
 */
function analyzeContinuity(
  trackCode: string,
  year: number,
  kai: number,
  nichi: number,
  todayFence: string | null,
  history: TurfWearHistory,
): Continuity | null {
  const today = dayNumberOf(history.kaisaiDate);
  if (today === null || history.rows === null) {
    return null;
  }
  // 同じ場の、今日より前の行だけを使う(別の場・今日以降の行は無視する)。
  const byKey = new Map<string, DatedRow>();
  for (const row of history.rows) {
    const dayNumber = dayNumberOf(row.kaisaiDate);
    if (row.trackCode !== trackCode || dayNumber === null || dayNumber >= today) {
      continue;
    }
    byKey.set(keyOf(row.year, row.kai, row.nichi), { row, dayNumber });
  }
  const datedRows = [...byKey.values()];

  // 今の回の 1〜N−1 日目が全部そろっていなければ判定できない。
  const current = collectMeeting(byKey, year, kai, nichi - 1);
  if (current === null) {
    return null;
  }
  // 今日から遡った順の柵(今日が先頭)。
  const fencesBack: (string | null)[] = [todayFence, ...current.map((d) => d.row.fence).reverse()];
  let start = current.length === 0 ? today : current[0]!.dayNumber;
  let currentYear = year;
  let currentKai = kai;
  let total = nichi;
  let startYear = year;
  let startKai = kai;
  let continuing = false;

  for (;;) {
    // 今の回の初日より前で一番新しい行 P。
    let p: DatedRow | null = null;
    for (const dated of datedRows) {
      if (dated.dayNumber < start && (p === null || dated.dayNumber > p.dayNumber)) {
        p = dated;
      }
    }
    if (currentKai >= 2) {
      // 前の回は (同じ年, K−1) でなければならない。違う・無いときはデータの欠落とみなす。
      if (p === null || p.row.year !== currentYear || p.row.kai !== currentKai - 1) {
        return null;
      }
    } else if (p === null) {
      break; // K=1 で前の行が無い: 続いていない
    } else if (p.row.year >= currentYear) {
      return null; // K=1 なのに同じ年以降の回が前にある: 矛盾
    }

    const previous = collectMeeting(byKey, p.row.year, p.row.kai, p.row.nichi);
    if (start - p.dayNumber > CONTINUITY_MAX_GAP_DAYS) {
      // 続いていない。K≥2 では、前の回がそろっていることを確かめてから断定する(K=1 は前の回の番号が分からないので確かめない)。
      if (currentKai >= 2 && previous === null) {
        return null;
      }
      break;
    }
    // 続いている。前の回の 1〜P.日次がそろっていなければ判定できない。
    if (previous === null || (currentKai === 1 && p.row.year !== currentYear - 1)) {
      return null;
    }
    fencesBack.push(...previous.map((d) => d.row.fence).reverse());
    total += previous.length;
    startYear = p.row.year;
    startKai = p.row.kai;
    start = previous[0]!.dayNumber;
    currentYear = p.row.year;
    currentKai = p.row.kai;
    continuing = true;
  }

  let fenceDays: number | null = null;
  if (todayFence !== null) {
    fenceDays = 1;
    for (const fence of fencesBack.slice(1)) {
      if (fence === null) {
        fenceDays = null; // 柵が分からない日に当たった: 推測しない
        break;
      }
      if (fence !== todayFence) {
        break;
      }
      fenceDays += 1;
    }
  }
  return {
    total: continuing ? total : null,
    startYear: continuing ? startYear : null,
    startKai: continuing ? startKai : null,
    fenceDays,
  };
}

/**
 * 芝の傷み目安(開催回・日次・柵の事実)を組み立てる。
 *
 * null に倒す条件:
 * 1. centralVenueInfoFromRaceId(raceId) が null(地方・非12桁・場コード範囲外・不正な raceId)。
 * 2. courseType が "芝" でない(ダート・障害には開催進行による芝の傷み概念が無い)。
 * 3. 開催日次(day を Number 化した値)が0以下、または非有限。
 *
 * @param raceId レースID(12桁数字の文字列。未検証でよい。centralVenueInfoFromRaceId に委譲)
 * @param courseType コース種別(芝/ダ/障)
 * @param fence ShutubaRaceInfo.fence の三状態(undefined=非芝相当/null=芝だが柵不明/柵letter)をそのまま受ける
 * @param history 連続開催の通算と柵の日数を数える履歴(Issue #519)。省略・null・`rows` が null・回次なし・欠けがあるときは、新しい値を出さず従来と同じ出力にする
 * @returns 組み立てたヒント。上記いずれかに該当すれば null
 */
export function assessTurfWear(
  raceId: string,
  courseType: CourseType,
  fence: string | null | undefined,
  history?: TurfWearHistory | null,
): TurfWearHint | null {
  const info = centralVenueInfoFromRaceId(raceId);
  if (info === null) {
    return null;
  }
  if (courseType !== "芝") {
    return null;
  }

  const dayNumber = Number(info.day);
  if (!Number.isFinite(dayNumber) || dayNumber <= 0) {
    return null;
  }

  const roundNumber = Number(info.round);
  const 開催回次 = Number.isFinite(roundNumber) && roundNumber > 0 ? roundNumber : null;
  const 柵 = fence ?? null;

  // 連続開催の通算と柵の日数(Issue #519)。回次が無い・履歴が無い・欠けがあるときは null(従来と同じ文)。
  const continuity =
    history != null && 開催回次 !== null
      ? analyzeContinuity(info.trackCode, Number(raceId.slice(0, 4)), 開催回次, dayNumber, 柵, history)
      : null;
  const 通算日次 = continuity?.total ?? null;
  const 連続開始年 = continuity?.startYear ?? null;
  const 連続開始回 = continuity?.startKai ?? null;
  const 柵日数 = continuity?.fenceDays ?? null;

  const roundPrefix = 開催回次 !== null ? `中央${開催回次}回${dayNumber}日目` : `中央${dayNumber}日目`;
  const clauses: string[] = [];
  if (通算日次 !== null && 連続開始回 !== null) {
    const startLabel = 連続開始年 !== null && 連続開始年 < Number(raceId.slice(0, 4)) ? `前年${連続開始回}回` : `${連続開始回}回`;
    clauses.push(`${startLabel}から連続開催で通算${通算日次}日目`);
  }
  if (柵 !== null) {
    clauses.push(柵日数 !== null ? `柵${柵}は${柵日数}日目` : `柵${柵}`);
  }
  const fenceClause = clauses.length > 0 ? `(${clauses.join("。")})` : "";
  const note = `${roundPrefix}${fenceClause}。${NEUTRAL_SUFFIX}`;

  return {
    開催日次: dayNumber,
    開催回次,
    柵,
    通算日次,
    連続開始年,
    連続開始回,
    柵日数,
    note,
  };
}
