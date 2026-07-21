/**
 * レース一覧の3択(中央/地方(全て)/地方(Jpnのみ))と、内部状態(venueKind, jpnOnly)の
 * 相互変換を行う純関数(タスクB1で導入、タスクB2b-1でrendererからshared層へ移設)。
 *
 * main(期間バッチの listDayRaces 呼び分け)・renderer(3択UI)双方から参照するため、
 * electron非依存のshared層に置く(型自体は analysis-types.ts の RaceListTarget/RaceListSelection)。
 *
 * RaceVenueKind(shared/analysis-types.ts)は central/nar の2値のまま据え置く
 * (verify/scorer等の下流を無改修にするため)。3択目の「地方(Jpnのみ)」は
 * venueKind="nar" + jpnOnly=true という組み合わせで表現し、UI層だけがこの3択を意識する。
 */

import type { RaceListSelection, RaceListTarget } from "./analysis-types.js";

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
  venueKind: RaceListSelection["venueKind"],
  jpnOnly: boolean,
): RaceListTarget {
  if (venueKind === "central") {
    return "central";
  }
  return jpnOnly ? "nar-jpn" : "nar-all";
}
