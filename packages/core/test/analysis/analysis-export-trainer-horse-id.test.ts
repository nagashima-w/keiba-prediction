/**
 * レース情報スナップショットの馬ごとの調教師 ID `horses[].trainerId` と馬の ID `horses[].horseId`(Issue #540)。
 *
 * 出馬表の `ShutubaHorse.trainerId`(`string | null`)と `ShutubaHorse.horseId`(10 桁の文字列)の写し。
 * 出馬表を読めた分析では全馬が両方のキーを持ち、調教師のリンクが無い馬は `trainerId` が null。
 * このキーを保存する前に作った過去のスナップショットはキー自体が無い(null と区別できる)。
 * 統計モデル・LLM・画面・配分には使わない(書き出しの列に載せるだけ)。
 */

import { describe, expect, it } from "vitest";
import { buildRaceSnapshot } from "../../src/analysis/analysis-export.js";
import type { RaceData } from "../../src/pipeline.js";

function horse(umaban: number, ids: { trainerName?: string | null; trainerId?: string | null; horseId?: string }): unknown {
  return {
    shutuba: { umaban, wakuban: 1, name: `馬${umaban}`, sex: "牡", age: 3, kinryo: 55, jockeyName: null, trainerName: null, bodyWeight: null, ...ids },
    results: [],
    oikiri: null,
  };
}

function raceDataWith(horses: unknown[]): RaceData {
  return {
    raceId: "202603020211",
    race: { raceName: "テスト", courseType: "芝", distance: 1800 },
    horses,
    odds: { officialDatetime: null, oddsStatus: "result", win: {}, place: {} },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
  } as unknown as RaceData;
}

describe("buildRaceSnapshot: horses[].trainerId・horses[].horseId", () => {
  it("出馬表の trainerId・horseId が、馬ごとに別の値で入る(取り違えの検知。JSON の往復を含む)", () => {
    const snap = buildRaceSnapshot(
      raceDataWith([
        horse(1, { trainerName: "藤野", trainerId: "01200", horseId: "2024104976" }),
        horse(2, { trainerName: "西山裕貴", trainerId: "a030b", horseId: "2020106686" }),
      ]),
    );
    expect(snap.horses).toHaveLength(2);
    expect(snap.horses.map((h) => [h.trainerName, h.trainerId, h.horseId])).toEqual([
      ["藤野", "01200", "2024104976"],
      ["西山裕貴", "a030b", "2020106686"],
    ]);
    const back = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(back.horses.map((h) => [h.trainerId, h.horseId])).toEqual([
      ["01200", "2024104976"],
      ["a030b", "2020106686"],
    ]);
  });

  it("調教師のリンクが無い馬(trainerId が null)は、キーを残したまま null(キーが無い旧スナップショットと区別できる)。馬の ID は入る", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, { trainerName: "藤野", trainerId: "01200", horseId: "2024104976" }), horse(2, { trainerName: "", trainerId: null, horseId: "2021105857" })]));
    expect(snap.horses).toHaveLength(2);
    expect(snap.horses[0]!.trainerId).toBe("01200"); // 前提: 値のある馬は値が入る
    for (const h of snap.horses) {
      expect("trainerId" in h).toBe(true);
      expect("horseId" in h).toBe(true);
    }
    expect(snap.horses[1]!.trainerId).toBeNull();
    expect(snap.horses[1]!.horseId).toBe("2021105857");
    const back = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect("trainerId" in back.horses[1]!).toBe(true); // JSON に null として残る(省略されない)
  });

  it("出馬表がどちらの ID も持たない形(undefined)でも、キーは残して null にする(全馬がキーを持つ)", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, {})]));
    expect("trainerId" in snap.horses[0]!).toBe(true);
    expect("horseId" in snap.horses[0]!).toBe(true);
    expect(snap.horses[0]!.trainerId).toBeNull();
    expect(snap.horses[0]!.horseId).toBeNull();
  });

  it("既存の騎手の列は変わらない(jockeyName・jockeyId・trainerName は従来どおり。ID の追加が他のキーを動かさない)", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, { trainerName: "藤野", trainerId: "01200", horseId: "2024104976", ...{ jockeyName: "戸崎圭", jockeyId: "05386" } })]));
    const h = snap.horses[0]!;
    expect([h.jockeyName, h.jockeyId, h.trainerName, h.name]).toEqual(["戸崎圭", "05386", "藤野", "馬1"]);
  });
});
