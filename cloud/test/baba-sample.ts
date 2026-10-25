import type { BabaFetchOutcome } from "../src/baba-conditions";
import { assembleBabaVenues, parseAccessJson, parseCoursePage, parseCushionHtml, parseMoistHtml, type CoursePage } from "../src/jra-baba-parse";

import { FIXTURE_NAMES, NOW_SUNDAY, fixtureText } from "./jra-baba-samples";

/**
 * Issue #478: 馬場の保存・配線のテストが共有する「取得口が返す結果」の見本。
 * 実物のフィクスチャ(2026-10-25〈日〉に JRA から取得した東京・京都・新潟の 3 場)を、本番と同じ読み取り(`jra-baba-parse.ts`)に通して作る。
 * 場の並びは クッション値のページの順: 東京(05)・京都(08)・新潟(04)。計測日時は 2026-10-25 の朝。
 */

/** 見本を読むときの「今日」(2026-10-25 09:35 JST)。 */
export const SAMPLE_NOW = NOW_SUNDAY;
/** 見本の開催日(YYYYMMDD)。 */
export const SAMPLE_DATE = "20261025";

function must<T>(value: T | null): T {
  if (value === null) {
    throw new Error("フィクスチャを読めませんでした");
  }
  return value;
}

/** 実物の 3 場を読んだ結果(`result: "ok"`)。呼ぶたびに新しい値を返す。 */
export function sampleOutcome(): BabaFetchOutcome {
  const courses: CoursePage[] = [FIXTURE_NAMES.index1, FIXTURE_NAMES.index2, FIXTURE_NAMES.index3].map((name) => must(parseCoursePage(fixtureText(name))));
  const assembled = assembleBabaVenues({
    nowMs: SAMPLE_NOW,
    cushion: must(parseCushionHtml(fixtureText(FIXTURE_NAMES.cushion))),
    moist: must(parseMoistHtml(fixtureText(FIXTURE_NAMES.moist))),
    access: must(parseAccessJson(fixtureText(FIXTURE_NAMES.access))),
    courses,
    sources: { cushion: "ok", moist: "ok", access: "ok", course: "ok" },
  });
  return { result: "ok", venues: assembled.venues, dropped: assembled.dropped, droppedDetails: assembled.droppedDetails, apiFetchedAt: new Date(SAMPLE_NOW).toISOString() };
}
