import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSaveResultStatements, buildScratchedStatement, buildWinOddsStatement } from "../src/result-repository";
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
 * **Issue #259 で 6 文目が加わった**: オッズを持つ馬がいると、馬の UPSERT の直後に確定の単勝オッズ・人気の UPDATE(`FILL_WIN_ODDS_SQL`)が入る。UPDATE の `rows_written` は更新した馬の数 O
 * (オッズか人気を持つ馬。除外などは含まない。複合主キーの索引は更新されないので 2 倍にならない)。したがって新規保存は 2H + O + 2 + 2C + 2M。過去分の補完(`saveWinOdds`)は、この UPDATE の 1 文だけで O 行。
 * 以下の「14 本」の数は、この 6 文目を含む値(旧い値〈38〜62 行〉は 5 文のときの値)。
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
  const oddsHorses = parsed.horses.filter((h) => h.winOdds != null || h.ninki != null).length;
  return { perStatement: results.map((r) => r.meta.rows_written as number), horses: parsed.horses.length, oddsHorses, comboRows, markers: parsedCombos.length, hasMeta: parsed.courseType != null };
}

describe("結果 1 レースの新規保存の D1 の書き込み行数(meta.rows_written)", () => {
  it.each(FIXTURES.map((f) => [f] as const))("%s: 文ごとに [2H, オッズ O, 面 2, 削除 0, 組合せ 2C, マーカー 2M]", async (fixture) => {
    const m = await save(fixture);
    // 前提(空振り防止): 馬・組合せ・マーカー・面がそろっている
    expect(m.horses).toBeGreaterThan(0);
    expect(m.comboRows).toBeGreaterThan(0);
    expect(m.markers).toBeGreaterThan(0);
    expect(m.hasMeta).toBe(true);
    expect(m.oddsHorses).toBeGreaterThan(0); // 前提: オッズの UPDATE が入る(6 文)
    expect(m.perStatement).toEqual([2 * m.horses, m.oddsHorses, 2, 0, 2 * m.comboRows, 2 * m.markers]);
  });

  it("14 本の合計は 43〜78 行(オッズの UPDATE を含む。旧い 5 文のときは 38〜62 行)。150 レース/晩の上限(78 × 150)でも 11,700 行で、Free の 10 万行/日の約 12%", async () => {
    const totals: number[] = [];
    for (const fixture of FIXTURES) {
      await local.reset();
      totals.push((await save(fixture)).perStatement.reduce((a, b) => a + b, 0));
    }
    expect(totals).toHaveLength(14);
    expect(Math.min(...totals)).toBe(43);
    expect(Math.max(...totals)).toBe(78);
    expect(Math.max(...totals) * 150).toBe(11_700);
    expect(Math.max(...totals) * 150).toBeLessThan(100_000 * 0.12);
  });

  // 過去分の補完(結果の補完の段階 2)は、この UPDATE の 1 文だけ。保存済みの結果(オッズの列を知らない入力で保存したもの)に対して、更新した馬の数だけ書く。
  it.each(FIXTURES.map((f) => [f] as const))("%s: 過去分の補完(saveWinOdds)の rows_written は O(更新した馬の数)で、2 回目は 0", async (fixture) => {
    const raceId = parseRaceId(/(\d{12})/.exec(fixture)![1]!);
    const parsed = parseRaceResult(load(fixture));
    const entries = toResultEntries(parsed);
    const old = entries.map(({ winOdds: _o, ninki: _n, ...rest }) => rest);
    await local.db.batch(buildSaveResultStatements(local.db, raceId, old, parsed.courseType ?? null));
    const oddsHorses = parsed.horses.filter((h) => h.winOdds != null || h.ninki != null).length;
    expect(oddsHorses).toBeGreaterThan(0); // 前提
    const statement = buildWinOddsStatement(local.db, raceId, entries)!;
    const [first] = await local.db.batch([statement]);
    expect(first!.meta.rows_written).toBe(oddsHorses);
    const [second] = await local.db.batch([buildWinOddsStatement(local.db, raceId, entries)!]);
    expect(second!.meta.rows_written).toBe(0);
  });
  // Issue #270: 取消・除外の記録の補完(saveScratched)は、着順が NULL で scratched が NULL の行の数だけ書く(着順のある馬は書かない)。2 回目は 0。
  // 取消・除外を含む実フィクスチャ 2 本(FIXTURES には無い)を足して測る。
  const SCRATCH_FIXTURES = ["result_202606040901.html", "result_202605040205.html"];
  it("過去分の補完(saveScratched、Issue #270)の rows_written は、着順の無い馬の数と等しい。2 回目は 0。取消・除外のフィクスチャ 2 本を含み、着順の無い馬が実在する", async () => {
    let totalNonFinishers = 0;
    for (const fixture of [...FIXTURES, ...SCRATCH_FIXTURES]) {
      await local.reset();
      const raceId = parseRaceId(/(\d{12})/.exec(fixture)![1]!);
      const parsed = parseRaceResult(load(fixture));
      const entries = toResultEntries(parsed);
      await local.db.batch(buildSaveResultStatements(local.db, raceId, entries, parsed.courseType ?? null));
      await local.db.prepare("UPDATE race_results SET scratched = NULL").run(); // 旧い行にする
      const nonFinishers = entries.filter((e) => e.finishPosition === null).length;
      totalNonFinishers += nonFinishers;
      const [first] = await local.db.batch([buildScratchedStatement(local.db, raceId, entries)!]);
      expect(first!.meta.rows_written, fixture).toBe(nonFinishers);
      const [second] = await local.db.batch([buildScratchedStatement(local.db, raceId, entries)!]);
      expect(second!.meta.rows_written, fixture).toBe(0);
    }
    expect(totalNonFinishers).toBeGreaterThan(0); // 前提(空振り防止): 着順の無い馬が実在する
  });
});
