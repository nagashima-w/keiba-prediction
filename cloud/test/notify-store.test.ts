import { afterEach, describe, expect, it } from "vitest";

import { NotifyStore } from "../src/notify-store";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #205(#166-D) G-D1: 通知の表(`race_day_notify`)。`ready`(材料)→ `sending`(送る前)→ `sent`/`failed`。
 * 多くとも1回: 既に `sending`・`sent`・`failed` の行は、二度と `sending` にならない・巻き戻らない。
 */

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function store(): { store: NotifyStore; sql: NodeSql } {
  const sql = openNodeSql();
  opened.push(sql);
  sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return { store: new NotifyStore(sql), sql };
}

describe("NotifyStore(通知の表)", () => {
  it("材料を ready で積む → begin で sending(材料の embed は残る)→ finish で sent。状態の遷移ごとに行を確かめる", () => {
    const { store: s } = store();
    s.putReady("race:a", '{"title":"t"}', 7, 100);
    expect(s.row("race:a")).toMatchObject({ kind: "analysis", state: "ready", payload_json: '{"title":"t"}', analysis_id: 7, error_class: null });
    expect(s.begin("race:a", "analysis", null, 7, 200)).toBe(true);
    expect(s.row("race:a")).toMatchObject({ state: "sending", payload_json: '{"title":"t"}', updated_at: 200 });
    s.finish("race:a", "sent", null, 300);
    expect(s.row("race:a")).toMatchObject({ state: "sent", error_class: null, updated_at: 300 });
  });

  it("材料の無い通知(失敗・まとめ)は、begin が行を sending で作る。finish(failed)は分類だけを残す", () => {
    const { store: s } = store();
    expect(s.begin("summary", "summary", '{"title":"s"}', null, 10)).toBe(true);
    expect(s.row("summary")).toMatchObject({ kind: "summary", state: "sending", payload_json: '{"title":"s"}' });
    s.finish("summary", "failed", "http-404", 20);
    expect(s.row("summary")).toMatchObject({ state: "failed", error_class: "http-404" });
  });

  it("多くとも1回: sending・sent・failed の行には begin できない(false)。putReady は巻き戻さない(再実行で、送信中・送信済みの行を ready に戻さない)", () => {
    const { store: s } = store();
    for (const final of ["sending", "sent", "failed"] as const) {
      const key = `race:${final}`;
      s.putReady(key, "{}", 1, 1);
      expect(s.begin(key, "analysis", null, 1, 2)).toBe(true);
      if (final !== "sending") s.finish(key, final, final === "failed" ? "other" : null, 3);
      expect(s.begin(key, "analysis", null, 1, 4), final).toBe(false);
      s.putReady(key, '{"別の材料":1}', 2, 5);
      expect(s.row(key), final).toMatchObject({ state: final, payload_json: "{}", analysis_id: 1 });
    }
  });

  it("finish は sending の行だけを更新する(ready や sent を書き換えない)", () => {
    const { store: s } = store();
    s.putReady("race:a", "{}", 1, 1);
    s.finish("race:a", "sent", null, 2);
    expect(s.row("race:a")!.state).toBe("ready"); // sending でないので無視
    s.begin("race:a", "analysis", null, 1, 3);
    s.finish("race:a", "sent", null, 4);
    s.finish("race:a", "failed", "other", 5);
    expect(s.row("race:a")).toMatchObject({ state: "sent", error_class: null });
  });

  it("ペースの時刻(メタ)は、無ければ 0。書いた値を読める。壊れた値は 0", () => {
    const { store: s, sql } = store();
    expect(s.paceUntil()).toBe(0);
    s.setPaceUntil(12345);
    expect(s.paceUntil()).toBe(12345);
    sql.exec("UPDATE race_day_meta SET value = 'x' WHERE key = 'notify_pace_until'");
    expect(s.paceUntil()).toBe(0);
  });

  it("stateMap は、キー → 種類・状態(計画の入力の形)", () => {
    const { store: s } = store();
    s.putReady("race:a", "{}", 1, 1);
    s.begin("summary", "summary", "{}", null, 2);
    expect([...s.stateMap()]).toEqual([
      ["race:a", { kind: "analysis", state: "ready" }],
      ["summary", { kind: "summary", state: "sending" }],
    ]);
  });
});
