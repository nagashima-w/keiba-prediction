/**
 * レース情報スナップショットの馬ごとの騎手 ID `horses[].jockeyId`(Issue #526 段階 1)。
 *
 * 出馬表の `ShutubaHorse.jockeyId`(`string | null`)の写し。出馬表を読めた分析では全馬がキーを持ち、騎手のリンクが無い馬(騎手未定など)は null。
 * このキーを保存する前に作った過去のスナップショットはキー自体が無い(null と区別できる)。
 * 統計モデル・LLM・画面・配分には使わない(書き出しの列に載せるだけ)。
 */

import { describe, expect, it } from "vitest";
import { buildRaceSnapshot } from "../../src/analysis/analysis-export.js";
import type { RaceData } from "../../src/pipeline.js";

function horse(umaban: number, jockey: { jockeyName?: string | null; jockeyId?: string | null }): unknown {
  return {
    shutuba: { umaban, wakuban: 1, name: `馬${umaban}`, sex: "牡", age: 3, kinryo: 55, jockeyName: null, trainerName: null, bodyWeight: null, ...jockey },
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

describe("buildRaceSnapshot: horses[].jockeyId", () => {
  it("出馬表の jockeyId が、jockeyName と並んで馬ごとに入る(JSON の往復を含む)", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, { jockeyName: "ルメール", jockeyId: "05339" }), horse(2, { jockeyName: "川田将雅", jockeyId: "01166" })]));
    expect(snap.horses).toHaveLength(2);
    expect(snap.horses.map((h) => [h.jockeyName, h.jockeyId])).toEqual([
      ["ルメール", "05339"],
      ["川田将雅", "01166"],
    ]);
    const back = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(back.horses.map((h) => h.jockeyId)).toEqual(["05339", "01166"]);
  });

  it("騎手のリンクが無い馬(jockeyId が null)は、キーを残したまま null(キーが無い旧スナップショットと区別できる)", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, { jockeyName: "", jockeyId: "05339" }), horse(2, { jockeyName: "", jockeyId: null })]));
    expect(snap.horses).toHaveLength(2);
    expect(snap.horses[0]!.jockeyId).toBe("05339"); // 前提: 値のある馬は値が入る
    for (const h of snap.horses) {
      expect("jockeyId" in h).toBe(true);
    }
    expect(snap.horses[1]!.jockeyId).toBeNull();
    const back = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect("jockeyId" in back.horses[1]!).toBe(true); // JSON に null として残る(省略されない)
  });

  it("出馬表が jockeyId を持たない形(undefined)でも、キーは残して null にする(全馬がキーを持つ)", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, {})]));
    expect("jockeyId" in snap.horses[0]!).toBe(true);
    expect(snap.horses[0]!.jockeyId).toBeNull();
  });
});
