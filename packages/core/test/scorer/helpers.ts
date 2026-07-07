/**
 * scorer バイアステスト用の共通ヘルパ。
 *
 * バイアス計算は前処理層 deriveRaceFeatures の出力(DerivedRaceFeature[])を入力に取るため、
 * テストでは合成戦績(HorseRaceResult)を最小構成で組み立て、deriveRaceFeatures に通して
 * 派生特徴量を得る。実ネットワークやフィクスチャHTMLには依存しない。
 */

import type {
  FinishPosition,
  HorseRaceResult,
  RaceVenue,
} from "../../src/scraper/types.js";

/** 着順(順位)を組み立てる小ヘルパ。 */
export function rank(value: number, demoted?: boolean): FinishPosition {
  return demoted ? { kind: "順位", value, demoted } : { kind: "順位", value };
}

/** 会場名だけを持つ RaceVenue を組み立てる。 */
export function venue(name: string): RaceVenue {
  return { round: null, name, day: null, raw: name };
}

/** 合成戦績1走分を最小構成で組み立てる。date は必須(季節・間隔計算に使う)。 */
export function makeResult(
  overrides: Partial<HorseRaceResult> & { date: string | null },
): HorseRaceResult {
  return {
    venue: null,
    weather: null,
    raceNumber: null,
    raceName: null,
    raceId: null,
    raceIdRaw: null,
    venueKind: "中央",
    entryCount: null,
    wakuban: null,
    umaban: null,
    odds: null,
    ninki: null,
    finishPosition: null,
    jockeyName: null,
    jockeyId: null,
    kinryo: null,
    courseType: null,
    distance: null,
    trackCondition: null,
    time: null,
    margin: null,
    passing: [],
    pace: null,
    last3f: null,
    bodyWeight: null,
    winnerName: null,
    ...overrides,
  };
}
