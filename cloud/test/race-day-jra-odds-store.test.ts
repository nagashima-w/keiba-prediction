import { afterEach, describe, expect, it } from "vitest";

import { JraOddsStageStore, jraOddsPagesFor } from "../src/race-day-jra-odds";
import { openNodeSql, type NodeSql } from "./node-sql";

/** Issue #675 段階 A: JRA のオッズの段階(頁ごとの進み具合)の表。 */
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});
function store(): { s: JraOddsStageStore; sql: NodeSql } {
  const sql = openNodeSql();
  opened.push(sql);
  return { s: new JraOddsStageStore(sql), sql };
}

describe("取る頁の決め方", () => {
  it("組合せ OFF は単勝複勝だけ。ON は単勝複勝 + 6 式別で、三連単が最後", () => {
    expect(jraOddsPagesFor(false)).toEqual(["tanpuku"]);
    const on = jraOddsPagesFor(true);
    expect(on).toHaveLength(7);
    expect(on[0]).toBe("tanpuku");
    expect(on[on.length - 1]).toBe("sanrentan");
    expect(new Set(on).size).toBe(7);
  });
});

describe("次に取る頁(1 起床の分け方)", () => {
  it("三連単以外は 1 起床にまとめ、三連単は単独の起床にする(三連単は最後)", () => {
    const { s } = store();
    s.begin("R", 1, jraOddsPagesFor(true));
    expect(s.nextBatch("R", 1)).toEqual(["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku"]);
    for (const p of s.nextBatch("R", 1)) s.mark("R", 1, p, "done");
    expect(s.hasPending("R", 1)).toBe(true);
    expect(s.nextBatch("R", 1)).toEqual(["sanrentan"]);
    s.mark("R", 1, "sanrentan", "failed");
    expect(s.hasPending("R", 1)).toBe(false);
    expect(s.nextBatch("R", 1)).toEqual([]);
  });
  it("再開: done の頁は取り直さず、pending だけを返す。別の実行(instance)の行は見ない", () => {
    const { s } = store();
    s.begin("R", 1, jraOddsPagesFor(true));
    s.mark("R", 1, "tanpuku", "done");
    s.mark("R", 1, "wide", "failed");
    expect(s.nextBatch("R", 1)).toEqual(["wakuren", "umaren", "umatan", "sanrenpuku"]);
    expect(s.hasPending("R", 2)).toBe(false);
  });
  it("begin は同じレースの古い行を消す(再予約)。頁が空なら何も入れない", () => {
    const { s, sql } = store();
    s.begin("R", 1, jraOddsPagesFor(true));
    s.begin("R", 2, ["tanpuku"]);
    expect((sql.exec("SELECT COUNT(*) AS n FROM race_day_jra_odds").toArray() as { n: number }[])[0]!.n).toBe(1);
    s.begin("R", 3, []);
    expect(s.hasPending("R", 3)).toBe(false);
    expect((sql.exec("SELECT COUNT(*) AS n FROM race_day_jra_odds").toArray() as { n: number }[])[0]!.n).toBe(0);
  });
  it("failAllPending は pending だけを failed にし、変えた件数を返す。counts は状態ごとの件数", () => {
    const { s } = store();
    s.begin("R", 1, jraOddsPagesFor(true));
    s.mark("R", 1, "tanpuku", "done");
    expect(s.failAllPending("R", 1)).toBe(6);
    expect(s.counts("R", 1)).toEqual({ pending: 0, done: 1, failed: 6 });
  });
  it("clear はそのレースの行を消し、clearOrphans は進行中のタスク(queued・fetched の発走前)に一致しない行を消す", () => {
    const { s, sql } = store();
    sql.exec("CREATE TABLE race_day_tasks (race_id TEXT, mode TEXT, queued_at INTEGER, status TEXT)");
    sql.exec("INSERT INTO race_day_tasks VALUES ('A', 'pre_race', 10, 'fetched')");
    sql.exec("INSERT INTO race_day_tasks VALUES ('B', 'pre_race', 20, 'done')");
    s.begin("A", 10, ["tanpuku"]);
    s.begin("B", 20, ["tanpuku"]);
    s.begin("C", 30, ["tanpuku"]);
    s.begin("D", 40, ["tanpuku"]);
    s.clear("D");
    s.clearOrphans();
    const rows = (sql.exec("SELECT DISTINCT race_id FROM race_day_jra_odds ORDER BY race_id").toArray() as { race_id: string }[]).map((r) => r.race_id);
    expect(rows).toEqual(["A"]);
  });
});
