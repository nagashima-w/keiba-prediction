/**
 * レース一覧の3択(中央/地方(全て)/地方(Jpnのみ))と、内部状態(venueKind, jpnOnly)の
 * 相互変換を行う純関数のテスト(タスクB1)。
 *
 * RaceVenueKind は central/nar の2値のまま据え置くため(verify/scorer下流を無改修にするため)、
 * 3択目("地方(Jpnのみ)")は venueKind="nar" + jpnOnly=true という組み合わせで表現する。
 */

import { describe, expect, it } from "vitest";

import {
  raceListTargetToSelection,
  selectionToRaceListTarget,
} from "../src/shared/race-list-target.js";
import type { RaceListTarget } from "../src/shared/analysis-types.js";

describe("raceListTargetToSelection(3択→venueKind/jpnOnlyへの写像)", () => {
  const cases: Array<[RaceListTarget, { venueKind: "central" | "nar"; jpnOnly: boolean }]> = [
    ["central", { venueKind: "central", jpnOnly: false }],
    ["nar-all", { venueKind: "nar", jpnOnly: false }],
    ["nar-jpn", { venueKind: "nar", jpnOnly: true }],
  ];

  it.each(cases)("%s は %o に写像される", (target, expected) => {
    expect(raceListTargetToSelection(target)).toEqual(expected);
  });
});

describe("selectionToRaceListTarget(venueKind/jpnOnly→3択への逆写像)", () => {
  it("central + jpnOnly=false は 'central' になる", () => {
    expect(selectionToRaceListTarget("central", false)).toBe("central");
  });

  it("nar + jpnOnly=false は 'nar-all' になる", () => {
    expect(selectionToRaceListTarget("nar", false)).toBe("nar-all");
  });

  it("nar + jpnOnly=true は 'nar-jpn' になる", () => {
    expect(selectionToRaceListTarget("nar", true)).toBe("nar-jpn");
  });

  it("central + jpnOnly=true(本来到達しない不整合値)は central 扱いにフォールバックする", () => {
    // central時にjpnOnly=trueが渡ってくることはUI/IPC双方のガードにより通常起きないが、
    // 万一の不整合値でも「地方Jpnのみ」を誤って選択済み表示しないよう central 側に倒す。
    expect(selectionToRaceListTarget("central", true)).toBe("central");
  });
});

describe("central時はjpnOnlyを常にfalse固定するガード", () => {
  it("'central' への写像結果は常に jpnOnly=false である", () => {
    expect(raceListTargetToSelection("central").jpnOnly).toBe(false);
  });
});
