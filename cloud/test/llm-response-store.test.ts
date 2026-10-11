import { afterEach, describe, expect, it } from "vitest";

import { SqlLlmResponseStore } from "../src/llm-response-store";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #194(#179-b): LLM の応答の記録(DO の SQLite の表 `race_day_llm_responses`)。冪等(アラームは少なくとも1回)のため、成功した応答を保存の前に記録し、
 * 再実行では再生して送り直さない。キーは (race_id, mode, 番号)。本物の SQLite の意味論(`node:sqlite`)で確かめる。
 */

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function db(): NodeSql {
  const sql = openNodeSql();
  opened.push(sql);
  SqlLlmResponseStore.ensureTable(sql);
  return sql;
}

const rows = (sql: NodeSql): number => (sql.exec("SELECT COUNT(*) AS n FROM race_day_llm_responses").toArray() as { n: number }[])[0]!.n;
const RESPONSE = { content: [{ type: "text" as const, text: "応答" }], stop_reason: "end_turn", model: "claude-sonnet-5-5" };

describe("SqlLlmResponseStore", () => {
  it("ensureTable は何度呼んでもよい(CREATE TABLE IF NOT EXISTS)", () => {
    const sql = db();
    expect(() => SqlLlmResponseStore.ensureTable(sql)).not.toThrow();
  });

  it("put した応答を、同じ (レース, mode, 番号) で get できる(JSON の往復)。無い番号は undefined", () => {
    const sql = db();
    const store = new SqlLlmResponseStore(sql, "202603020211", "pre_race");
    expect(store.get(0)).toBeUndefined();
    store.put(0, RESPONSE);
    expect(store.get(0)).toEqual(RESPONSE);
    expect(store.get(1)).toBeUndefined();
  });

  it("別のレース・別の mode の記録とは混ざらない", () => {
    const sql = db();
    new SqlLlmResponseStore(sql, "202603020211", "pre_race").put(0, RESPONSE);
    expect(new SqlLlmResponseStore(sql, "202603020212", "pre_race").get(0)).toBeUndefined();
    expect(new SqlLlmResponseStore(sql, "202603020211", "morning").get(0)).toBeUndefined();
  });

  it("同じ番号への put は、後のもので置き換える(主キー違反にしない)", () => {
    const sql = db();
    const store = new SqlLlmResponseStore(sql, "202603020211", "pre_race");
    store.put(0, RESPONSE);
    store.put(0, { ...RESPONSE, model: "別のモデル" });
    expect(rows(sql)).toBe(1);
    expect(store.get(0)?.model).toBe("別のモデル");
  });

  it("clear は、そのレース・mode の記録だけを消す", () => {
    const sql = db();
    new SqlLlmResponseStore(sql, "202603020211", "pre_race").put(0, RESPONSE);
    new SqlLlmResponseStore(sql, "202603020211", "pre_race").put(1, RESPONSE);
    new SqlLlmResponseStore(sql, "202603020212", "pre_race").put(0, RESPONSE);
    expect(rows(sql)).toBe(3);
    SqlLlmResponseStore.clear(sql, "202603020211", "pre_race");
    expect(rows(sql)).toBe(1);
    expect(new SqlLlmResponseStore(sql, "202603020212", "pre_race").get(0)).toEqual(RESPONSE);
  });

  it("壊れた JSON の行は、記録なしとして扱う(例外にしない。再生できないので実送信になる)", () => {
    const sql = db();
    sql.exec("INSERT INTO race_day_llm_responses (race_id, mode, seq, response_json) VALUES ('202603020211', 'pre_race', 0, '{壊れ')");
    expect(new SqlLlmResponseStore(sql, "202603020211", "pre_race").get(0)).toBeUndefined();
  });
});
