import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSaveResultStatements } from "../src/result-repository";
import { toResultEntries } from "../../packages/core/src/ev/result-import";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #217(#167-C): 結果 1 レースを D1 に新規保存するときの書き込み行数(`meta.rows_written`)の測定。結果の補完(`result-backfill-core.ts`)の 1 晩の上限(150 レース)が、
 * D1 の Free の書き込み枠(10 万行/日)に対してどれだけかを、**コミット済みの再現手段**で確定する。再現: `cd cloud && pnpm exec vitest run test/result-rows-written.test.ts`。
 *
 * 内訳(新規保存・`buildSaveResultStatements` の 5 文のうち、DELETE は消す行が無いので 0): 馬 2H(`race_results` は複合主キーの自動索引で行が 2 倍)・面 2(`race_result_meta` は `race_id TEXT PRIMARY KEY` で索引つき)・
 * 組合せの払戻 2C(C = 全券種の払戻の行数。同じく複合主キー)・取込マーカー 2M(M = parsed の券種の数)。合計 = 2H + 2 + 2C + 2M。
 * 保存済みの結果ページ 14 本(中央 8・地方 6)では 38〜62 行(最大は 16 頭の 2 本)。18 頭でも 2×18 + 2 + 2×8 + 12 = 66(組合せ 8 行は 14 本の最大〈2C = 16〉に合わせた仮定) で、150 レース/晩なら多くとも約 1 万行(10 万行の約 9〜10%)。
 *
 * 限界: ローカルの workerd の D1 が報告する値で、本番の D1 が数える行数と同じとは限らない(`rows-written.test.ts` と同じ。最初の本番の実保存で確かめる)。
 */

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

const FIXTURES = [
  "result_202602010605.html",
  "result_202602010607.html",
  "result_202603020203.html",
  "result_202603020211.html",
  "result_202606040810.html",
  "result_202607020501.html",
  "result_202607020502.html",
  "result_202607020505.html",
  "nar_result_202630062407.html",
  "nar_result_202646071203.html",
  "nar_result_202654071201.html",
  "nar_result_202654071210.html",
  "nar_result_202654092706.html",
  "nar_result_202654092711.html",
];
const load = (name: string): string => readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");

async function save(fixture: string) {
  const raceId = parseRaceId(/(\d{12})/.exec(fixture)![1]!);
  const parsed = parseRaceResult(load(fixture));
  const combos = { wide: parsed.widePayouts, trio: parsed.trioPayouts, quinella: parsed.quinellaPayouts, exacta: parsed.exactaPayouts, trifecta: parsed.trifectaPayouts, bracketQuinella: parsed.bracketQuinellaPayouts };
  const statements = buildSaveResultStatements(local.db, raceId, toResultEntries(parsed), parsed.courseType ?? null, combos as never);
  const results = await local.db.batch(statements);
  const parsedCombos = Object.values(combos).filter((c) => c?.state === "parsed");
  const comboRows = parsedCombos.reduce((n, c) => n + (c?.state === "parsed" ? c.payouts.length : 0), 0);
  return { perStatement: results.map((r) => r.meta.rows_written as number), horses: parsed.horses.length, comboRows, markers: parsedCombos.length, hasMeta: parsed.courseType != null };
}

describe("結果 1 レースの新規保存の D1 の書き込み行数(meta.rows_written)", () => {
  it.each(FIXTURES.map((f) => [f] as const))("%s: 文ごとに [2H, 面 2, 削除 0, 組合せ 2C, マーカー 2M]", async (fixture) => {
    const m = await save(fixture);
    // 前提(空振り防止): 馬・組合せ・マーカー・面がそろっている
    expect(m.horses).toBeGreaterThan(0);
    expect(m.comboRows).toBeGreaterThan(0);
    expect(m.markers).toBeGreaterThan(0);
    expect(m.hasMeta).toBe(true);
    expect(m.perStatement).toEqual([2 * m.horses, 2, 0, 2 * m.comboRows, 2 * m.markers]);
  });

  it("14 本の合計は 38〜62 行。150 レース/晩の上限(62 × 150)でも 9,300 行で、Free の 10 万行/日の約 9%", async () => {
    const totals: number[] = [];
    for (const fixture of FIXTURES) {
      await local.reset();
      totals.push((await save(fixture)).perStatement.reduce((a, b) => a + b, 0));
    }
    expect(totals).toHaveLength(14);
    expect(Math.min(...totals)).toBe(38);
    expect(Math.max(...totals)).toBe(62);
    expect(Math.max(...totals) * 150).toBe(9_300);
    expect(Math.max(...totals) * 150).toBeLessThan(100_000 * 0.1);
  });
});
