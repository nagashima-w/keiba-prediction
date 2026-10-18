/**
 * コースの回り(右・左)。Issue #311(レース再生の演出)でコース図の向きを決めるのに使った。#362 でレース再生を廃止したあとは、API の `race.turn` として残るだけでクライアントでは使わない(整理は別の Issue)。
 *
 * raceId の場コード(5〜6桁目)から決める純関数。出典:
 *  - 中央 10 場: core の `COURSE_TRAITS`(`packages/core/src/scorer/course-traits.ts`。左回りは東京・中京・新潟、それ以外は右回り)。
 *  - 地方: `docs/keibago-zip-investigation.md` §6.6 の実測(14 競馬場の回り。右=佐賀・名古屋・園田・大井・水沢・笠松・金沢・門別・高知、左=川崎・浦和・盛岡・船橋)。
 *    **大井だけは 1650m が左回り**(他の距離は右。2026 年 7・9 月の 2 か月・84 通りの範囲の結果で、他の月・距離は確かめていない)。姫路は §6.6 の表に無い(2 か月の ZIP に出なかった)が、右として扱う(同ドキュメントの注記: 姫路 1400m の行は右と見なすと合う)。
 *  - 不明(地方の未知の場コード・12 桁でない raceId)は右回り。演出の向きが違うだけで、確率・配分には影響しない。
 * サーバだけが持つ表(クライアントの束には入れない。API の `race.turn` で渡す)。
 */
import { VENUE_BY_NAR_TRACK_CODE, VENUE_BY_TRACK_CODE } from "../../packages/core/src/analysis/venue-codes";
import { COURSE_TRAITS } from "../../packages/core/src/scorer/course-traits";

export type CourseTurn = "right" | "left";

/** 地方で左回りの競馬場(大井を除く。§6.6)。 */
const NAR_LEFT_VENUES: ReadonlySet<string> = new Set(["川崎", "浦和", "盛岡", "船橋"]);

/** 大井で左回りになる距離(m)。 */
const OI_LEFT_DISTANCE = 1650;

export function courseTurnOf(raceId: string, distance: number | null): CourseTurn {
  if (!/^[0-9]{12}$/.test(raceId)) {
    return "right";
  }
  const trackCode = raceId.slice(4, 6);
  const central = VENUE_BY_TRACK_CODE.get(trackCode);
  if (central !== undefined) {
    return COURSE_TRAITS[central]?.turn === "左" ? "left" : "right";
  }
  const nar = VENUE_BY_NAR_TRACK_CODE.get(trackCode);
  if (nar === undefined) {
    return "right";
  }
  if (nar === "大井") {
    return distance === OI_LEFT_DISTANCE ? "left" : "right";
  }
  return NAR_LEFT_VENUES.has(nar) ? "left" : "right";
}
