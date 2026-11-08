// 本番の computeShadowFlags を、xcheck_flags.py が書いた入力(JSON)に対して動かす。
// 使い方: node --experimental-strip-types --import ./scripts/longshot-pick-688/register-ts.mjs scripts/longshot-pick-688/xcheck_flags.mjs <cases.json>
import { computeShadowFlags } from "../../packages/core/src/ev/stat-shadow-flags.ts";
import fs from "fs";
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const toResult = (r) => ({
  date: r.date, venue: null, weather: null, raceNumber: null, raceName: null, raceId: null, raceIdRaw: null, venueKind: "中央",
  entryCount: r.entryCount, wakuban: null, umaban: null, odds: null, ninki: null,
  finishPosition: r.finish === null ? { kind: "非数値", text: "中" } : { kind: "順位", value: r.finish },
  jockeyName: null, jockeyId: null, kinryo: null, courseType: r.courseType, distance: null, trackCondition: null,
  passing: r.passing,
});
const out = cases.map((c) => {
  const f = computeShadowFlags(c.runs.map(toResult), { date: c.today.date, courseType: c.today.courseType }, c.q);
  return [f.longRest, f.surfaceChange, f.frontRunner, f.longshotSlump];
});
console.log(JSON.stringify(out));
