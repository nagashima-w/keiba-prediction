/**
 * 芝の傷み目安(タスク#26-P3a)。
 *
 * 「開催回・日次・柵letter」という事実のみを中立な材料文として組み立てる決定論的な純関数。
 * 段階分け(level)は設けない。「開催が進むほど芝は傷みやすい」という一般論の方向・程度の
 * 解釈は一切行わず、LLM(プロンプト側)へ完全に委任する(2026-07-22 boss着手前ゲート合意)。
 * fence・round は事実併記のみで、傷みの強弱の断定表現には使わない。
 *
 * ネットワーク・DB には一切依存しない(centralVenueInfoFromRaceId を内部で使うだけ)。
 */

import { centralVenueInfoFromRaceId } from "../scraper/ids.js";
import type { CourseType } from "../scraper/types.js";

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
  /** 方向を断定しない中立の材料文(プロンプトへそのまま1行として載せる想定)。 */
  readonly note: string;
}

/** 中立の材料文の共通末尾(内外・前後の有利は断定しない旨)。 */
const NEUTRAL_SUFFIX =
  "開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。";

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
 * @returns 組み立てたヒント。上記いずれかに該当すれば null
 */
export function assessTurfWear(
  raceId: string,
  courseType: CourseType,
  fence: string | null | undefined,
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

  const roundPrefix = 開催回次 !== null ? `中央${開催回次}回${dayNumber}日目` : `中央${dayNumber}日目`;
  const fenceClause = 柵 !== null ? `(柵${柵})` : "";
  const note = `${roundPrefix}${fenceClause}。${NEUTRAL_SUFFIX}`;

  return {
    開催日次: dayNumber,
    開催回次,
    柵,
    note,
  };
}
