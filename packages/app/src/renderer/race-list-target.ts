/**
 * レース選択画面の3択(中央/地方(全て)/地方(Jpnのみ))と、内部状態(venueKind, jpnOnly)の
 * 相互変換を行う純関数(タスクB1)。
 *
 * RaceVenueKind(shared/analysis-types.ts)は central/nar の2値のまま据え置く
 * (verify/scorer等の下流を無改修にするため)。3択目の「地方(Jpnのみ)」は
 * venueKind="nar" + jpnOnly=true という組み合わせで表現し、UI層だけがこの3択を意識する。
 */

import type { RaceVenueKind } from "../shared/analysis-types.js";

/** レース一覧の取得対象(UI表示用の3択)。 */
export type RaceListTarget = "central" | "nar-all" | "nar-jpn";

/** venueKind と jpnOnly の組(内部状態)。 */
export interface RaceListSelection {
  readonly venueKind: RaceVenueKind;
  readonly jpnOnly: boolean;
}

/**
 * 3択を内部状態(venueKind, jpnOnly)へ写像する。
 * "central" は常に jpnOnly=false を返す(中央+Jpn限定で一覧が全滅する事故を防ぐガード)。
 */
export function raceListTargetToSelection(
  target: RaceListTarget,
): RaceListSelection {
  switch (target) {
    case "central":
      return { venueKind: "central", jpnOnly: false };
    case "nar-all":
      return { venueKind: "nar", jpnOnly: false };
    case "nar-jpn":
      return { venueKind: "nar", jpnOnly: true };
  }
}

/**
 * 内部状態(venueKind, jpnOnly)を3択へ逆写像する(UIのトグル押下状態の算出に使う)。
 * venueKind="central" のときは jpnOnly の値に関わらず "central" を返す
 * (central+jpnOnly=trueという不整合値が万一渡っても、地方Jpnのみを誤って選択済み表示しない)。
 */
export function selectionToRaceListTarget(
  venueKind: RaceVenueKind,
  jpnOnly: boolean,
): RaceListTarget {
  if (venueKind === "central") {
    return "central";
  }
  return jpnOnly ? "nar-jpn" : "nar-all";
}
