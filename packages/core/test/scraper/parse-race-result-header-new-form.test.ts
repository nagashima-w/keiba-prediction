/**
 * 結果ページの見出し(`div.RaceData01`)の新しい形で、コース種別(面)が引き続き読めること(Issue #521)。
 * 結果ページのパーサが見出しから読むのはコース種別だけ(天候・馬場状態・柵は読まない)。
 * 新しい形でも `芝1000m`・`ダ1600m`・`障3110m` の部分は同じなので読める、という実物での回帰テスト。
 */

import { describe, expect, it } from "vitest";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { loadFixture } from "../support/fixtures.js";

describe("parseRaceResult(新しい形の見出し・実フィクスチャ)", () => {
  it.each([
    ["result_202604040112.html", "芝"],
    ["result_202605040807.html", "ダ"],
    ["result_202605040709.html", "障"],
  ] as const)("%s のコース種別が %s になること", (file, courseType) => {
    const result = parseRaceResult(loadFixture(file));
    expect(result.horses.length).toBeGreaterThan(0);
    expect(result.courseType).toBe(courseType);
  });
});
