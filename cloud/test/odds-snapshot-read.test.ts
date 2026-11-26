import { describe, expect, it } from "vitest";
import { readWinOdds5, SELECT_ODDS_SNAPSHOT_WIN5_SQL } from "../src/odds-snapshot-repository";

/** Issue #796: 5 分前の単勝の読み出し(偽の D1)。SQL の計画は sql-plan-inventory が見る。 */
function fakeDb(row: { status: unknown; horses_json: unknown } | null, onBind?: (sql: string, values: unknown[]) => void) {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          onBind?.(sql, values);
          return { async first() { return row as never; } };
        },
      };
    },
  };
}

describe("readWinOdds5", () => {
  it("主キーで引く(lead_min は 5 に固定。race_id だけを束縛)", async () => {
    let seen: [string, unknown[]] | null = null;
    await readWinOdds5(fakeDb(null, (s, v) => (seen = [s, v])), "202603020211");
    expect(seen).toEqual([SELECT_ODDS_SNAPSHOT_WIN5_SQL, ["202603020211"]]);
    expect(SELECT_ODDS_SNAPSHOT_WIN5_SQL).toContain("lead_min = 5");
  });

  it("馬番 → 単勝の表にする。単勝が null・0・負の馬は載せない", async () => {
    const json = JSON.stringify([[1, 8.5, 3, 2, 3, "x"], [2, null, null, null, null, null], [3, 0, 1, 1, 1, null], [4, -1, 1, 1, 1, null], [5, 3, 1, 1, 1, null]]);
    const m = await readWinOdds5(fakeDb({ status: "ok", horses_json: json }), "202603020211");
    expect([...m!.entries()]).toEqual([[1, 8.5], [5, 3]]);
  });

  it.each([
    ["行なし", null],
    ["status が failed", { status: "failed", horses_json: "[[1,2]]" }],
    ["status が skipped", { status: "skipped", horses_json: null }],
    ["horses_json が NULL", { status: "ok", horses_json: null }],
    ["JSON が壊れている", { status: "ok", horses_json: "{" }],
    ["配列でない", { status: "ok", horses_json: "{}" }],
    ["単勝が 1 頭も読めない", { status: "ok", horses_json: "[[1,null]]" }],
  ])("%s は null", async (_n, row) => {
    expect(await readWinOdds5(fakeDb(row as never), "202603020211")).toBeNull();
  });

  it("D1 の失敗は投げる", async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("d1"); } }) }) };
    await expect(readWinOdds5(db as never, "202603020211")).rejects.toThrow("d1");
  });
});
