/**
 * 出馬表・結果ページの HTML から、レースのクラスを読む(Issue #426〈#389 の案 B〉)。読み方は `race-class.ts`。
 *
 * `parseRaceFieldSize` と同じ流儀で、`parseRaceResult` とは別の純関数にしてある(`RaceResult` の形・既存の golden を変えない)。
 * `.RaceData02` が無い・クラスが読めない・曖昧なときは undefined(例外は投げない)。
 */

import * as cheerio from "cheerio";
import type { RaceIdVenueKind } from "./ids.js";
import { readRaceClass } from "./race-class.js";
import { SHUTUBA_SELECTORS as SEL } from "./selectors.js";

export function parseRaceClassFromHtml(html: string, kind: RaceIdVenueKind): string | undefined {
  const $ = cheerio.load(html);
  const $data02 = $(SEL.raceData02);
  if ($data02.length === 0) {
    return undefined;
  }
  return readRaceClass(
    $data02
      .find("span")
      .map((_, el) => $(el).text())
      .get(),
    kind,
  );
}
