import { afterEach, describe, expect, it } from "vitest";

import type { OddsSnapshot } from "../../packages/core/src/scraper/types";
import {
  ODDS_SNAPSHOT_EARLY_LEAD_MS,
  ODDS_SNAPSHOT_LEAD_MS,
  OddsSnapshotStore,
  horsesOfSnapshot,
  oddsSnapshotDueMs,
  oddsSnapshotSupersedeMs,
  parseOddsSnapshotPayload,
  type OddsSnapshotPayload,
} from "../src/race-day-odds-snapshot";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #732: 発走 10 分前・5 分前の単勝・複勝の全頭のオッズの記録。ここは、DO の表(予定)と、頁の値から馬ごとの配列を作る関数。
 */
const START = Date.parse("2026-11-15T06:45:00Z");
const DUE5 = START - ODDS_SNAPSHOT_LEAD_MS;
const DUE10 = START - ODDS_SNAPSHOT_EARLY_LEAD_MS;

let sql: NodeSql | null = null;
afterEach(() => {
  sql?.close();
  sql = null;
});
const store = (): OddsSnapshotStore => {
  sql = openNodeSql();
  return new OddsSnapshotStore(sql);
};
// 既定の now は 10 分前の時刻(#787: 前日の夜〈-1〉と当日の朝〈-2〉は、この時刻にはもう積まない。10・5 分前だけを見る既存の検査はそのまま)
const reg = (raceId: string, startMs = START, now = startMs - ODDS_SNAPSHOT_EARLY_LEAD_MS) => ({ raceId, kaisaiDate: "20261115", startMs, now });

describe("horsesOfSnapshot(頁の値 → 馬ごとの [馬番, 単勝, 人気, 複勝下限, 複勝上限, 馬の ID])", () => {
  const snapshot: OddsSnapshot = {
    officialDatetime: "2026-11-15 15:40:00",
    oddsStatus: "middle",
    win: { 3: { odds: 12.3, ninki: 5 }, 1: { odds: 2.1, ninki: 1 }, 2: { odds: null, ninki: null } },
    place: { 1: { oddsMin: 1.2, oddsMax: 1.5, ninki: 1 }, 3: { oddsMin: 3.4, oddsMax: 5.6, ninki: 5 } },
  };
  const ids = { 1: "2023101645", 3: "2023104567" };
  it("馬番の昇順。複勝の下限・上限の両方と馬の ID を残す。値が無い馬は null(ID が無い馬も落とさない)", () => {
    expect(horsesOfSnapshot(snapshot, ids)).toEqual([
      [1, 2.1, 1, 1.2, 1.5, "2023101645"],
      [2, null, null, null, null, null],
      [3, 12.3, 5, 3.4, 5.6, "2023104567"],
    ]);
  });
  it("馬の ID を渡さなければ、全馬の ID が null。複勝が空(予想の頁など)でも単勝の馬を全部残す。複勝・ID にだけある馬番も落とさない", () => {
    expect(horsesOfSnapshot(snapshot).every((h) => h[5] === null)).toBe(true);
    const yoso: OddsSnapshot = { ...snapshot, place: { 9: { oddsMin: 1.1, oddsMax: 1.3, ninki: 2 } } };
    const horses = horsesOfSnapshot(yoso, { 7: "2023100007" });
    expect(horses.map((h) => h[0])).toEqual([1, 2, 3, 7, 9]);
    expect(horses[3]).toEqual([7, null, null, null, null, "2023100007"]);
    expect(horses[4]).toEqual([9, null, null, 1.1, 1.3, null]);
    expect(horsesOfSnapshot({ ...snapshot, place: {} }).every((h) => h[3] === null && h[4] === null)).toBe(true);
  });
});

describe("時点(10 分前・5 分前)", () => {
  it("5 分前は 5 分、10 分前は 10 分。取得が意味を持つ最後の時刻は、5 分前が発走、10 分前が 5 分前の時刻(5 分前を優先する)", () => {
    expect(ODDS_SNAPSHOT_LEAD_MS).toBe(5 * 60_000);
    expect(ODDS_SNAPSHOT_EARLY_LEAD_MS).toBe(10 * 60_000);
    expect(oddsSnapshotSupersedeMs(START, 5, "20261115")).toBe(START);
    expect(oddsSnapshotSupersedeMs(START, 10, "20261115")).toBe(DUE5);
  });
  it("#787: 前日の夜(-1)は前日 21:00 JST から、最後の時刻は開催日の 05:00 JST。当日の朝(-2)は 09:30 JST から、最後の時刻は発走の 10 分前", () => {
    expect(oddsSnapshotDueMs(-1, START, "20261115")).toBe(Date.parse("2026-11-14T21:00:00+09:00"));
    expect(oddsSnapshotDueMs(-2, START, "20261115")).toBe(Date.parse("2026-11-15T09:30:00+09:00"));
    expect(oddsSnapshotDueMs(10, START, "20261115")).toBe(DUE10);
    expect(oddsSnapshotDueMs(5, START, "20261115")).toBe(DUE5);
    expect(oddsSnapshotSupersedeMs(START, -1, "20261115")).toBe(Date.parse("2026-11-15T05:00:00+09:00"));
    expect(oddsSnapshotSupersedeMs(START, -2, "20261115")).toBe(DUE10);
    expect(oddsSnapshotDueMs(-1, START, "20261101")).toBe(Date.parse("2026-10-31T21:00:00+09:00")); // 月をまたぐ
  });
});

describe("予定の表(OddsSnapshotStore)", () => {
  it("register: 開催日の 14:45 JST(前日の夜の最後の時刻を過ぎ、10 分前より前)に積むと、10 分前・5 分前・当日の朝(-2)の 3 行を pending で積む(前日の夜〈-1〉は最後の時刻を過ぎているので積まない)。2 回積んでも変わらない(既存の行を巻き戻さない)", () => {
    const s = store();
    const now = START - 3_600_000; // 14:45 JST
    expect(s.register(reg("202605010101", START, now))).toBe(true);
    s.markFired("202605010101", 5, START - 10);
    expect(s.register(reg("202605010101", START + 999, now))).toBe(true); // 2 回目は DO NOTHING
    const rows = s.rows();
    expect(rows.map((r) => [r.lead_min, r.due_ms, r.state, r.start_ms])).toEqual([
      [10, DUE10, "pending", START],
      [5, DUE5, "pending", START],
      [-2, Date.parse("2026-11-15T09:30:00+09:00"), "pending", START],
    ]);
    expect(rows.find((r) => r.lead_min === 5)).toMatchObject({ race_id: "202605010101", kaisai_date: "20261115", attempts: 0, fired_at: START - 10 });
    expect(rows.find((r) => r.lead_min === 10)!.fired_at).toBeNull(); // 時点ごとに別の行
  });
  it("#787 register: 前日の 21:10 JST に積むと 4 行(10・5・前日の夜〈-1〉・当日の朝〈-2〉)。時点ごとに別の行で、-1 の due は前日 21:00 JST", () => {
    const s = store();
    const now = Date.parse("2026-11-14T21:10:00+09:00");
    expect(s.register(reg("A", START, now))).toBe(true);
    expect(s.rows().map((r) => [r.lead_min, r.due_ms])).toEqual([
      [10, DUE10],
      [5, DUE5],
      [-1, Date.parse("2026-11-14T21:00:00+09:00")],
      [-2, Date.parse("2026-11-15T09:30:00+09:00")],
    ]);
  });
  it("#787 register: 前日の夜の最後の時刻(開催日 05:00 JST)ちょうど以降は -1 を積まない。当日の朝の最後の時刻(発走の 10 分前)ちょうど以降は -2 を積まない(境界)", () => {
    const at = (now: number) => {
      const s = store();
      s.register(reg("A", START, now));
      const leads = s.rows().map((r) => r.lead_min);
      sql?.close();
      sql = null;
      return leads;
    };
    const five = Date.parse("2026-11-15T05:00:00+09:00");
    expect(at(five - 1)).toContain(-1);
    expect(at(five)).not.toContain(-1);
    expect(at(DUE10 - 1)).toContain(-2);
    expect(at(DUE10)).not.toContain(-2);
    expect(at(DUE10)).toEqual([10, 5]); // 前提: 10・5 は積まれている(空振りでない)
  });
  it("#787 nextDue: 5 → 10 → 前日の夜(-1)→ 当日の朝(-2)の順に返す(lead_min の昇順では -2 が 5 より先に来る。それを避ける)。同じ優先の中では時刻の早い順", () => {
    const s = store();
    s.register(reg("A", START, Date.parse("2026-11-14T21:10:00+09:00")));
    const late = START + 3_600_000; // 全部の行が動ける時刻
    const order: [string, number][] = [];
    for (let i = 0; i < 4; i += 1) {
      const row = s.nextDue(late)!;
      order.push([row.race_id, row.lead_min]);
      s.markDone(row.race_id, row.lead_min);
    }
    expect(order.map((o) => o[1])).toEqual([5, 10, -1, -2]);
    expect(s.nextDue(late)).toBeNull();
    // 同じ優先の中では時刻の早い順(-2 の 2 レース)
    const t = store();
    t.register(reg("B", START + 3_600_000, Date.parse("2026-11-14T21:10:00+09:00")));
    t.register(reg("A", START, Date.parse("2026-11-14T21:10:00+09:00")));
    for (const [r, l] of [["A", 5], ["A", 10], ["B", 5], ["B", 10], ["A", -1], ["B", -1]] as const) t.markDone(r, l);
    expect(t.nextDue(START + 7_200_000)).toMatchObject({ race_id: "A", lead_min: -2 });
  });
  it("register: 発走を過ぎている(startMs <= now)なら積まない(false)", () => {
    const s = store();
    expect(s.register(reg("202605010101", START, START))).toBe(false);
    expect(s.register(reg("202605010102", START, START + 1))).toBe(false);
    expect(s.rows()).toEqual([]);
  });
  it("nextDue: 時刻が来ている pending のうち最も早いもの。5 分前の行が同時に動けるなら、時刻の早い 10 分前より先に返す(5 分前を優先する)", () => {
    const s = store();
    s.register(reg("A"));
    expect(s.nextDue(DUE10 - 1)).toBeNull();
    expect(s.nextDue(DUE10)).toMatchObject({ race_id: "A", lead_min: 10 });
    expect(s.nextDue(DUE5 - 1)).toMatchObject({ lead_min: 10 }); // 5 分前はまだ
    expect(s.nextDue(DUE5)).toMatchObject({ race_id: "A", lead_min: 5 }); // 10 分前も未実行だが、5 分前が先
    s.markDone("A", 5);
    expect(s.nextDue(DUE5)).toMatchObject({ lead_min: 10 }); // 5 分前が済めば 10 分前
  });
  it("nextAtMs は pending の最小(done は含めない)。再試行待ちの行は next_try_at の時刻で返る。同じ時点の中ではレース ID の順", () => {
    const s = store();
    s.register(reg("B", START));
    s.register(reg("A", START + 60_000));
    expect(s.nextAtMs()).toBe(DUE10);
    s.markFetchRetry("B", 10, 1, DUE10 + 15_000);
    expect(s.nextDue(DUE10 + 1)).toBeNull(); // B の 10 分前は再試行待ち。A の 10 分前の時刻(+60 秒)はまだ
    expect(s.nextAtMs()).toBe(DUE10 + 15_000);
    expect(s.nextDue(DUE10 + 60_000)?.race_id).toBe("B"); // 15 秒後には B が再び動ける
    s.markDone("B", 10);
    s.markDone("B", 5);
    s.markAbandoned("A", 10, 3);
    s.markDone("A", 5);
    expect(s.nextAtMs()).toBeNull();
    expect(s.nextDue(START + 10 * 60_000)).toBeNull();
    expect(s.rows().map((r) => [r.race_id, r.lead_min, r.state])).toEqual([["A", 10, "abandoned"], ["A", 5, "done"], ["B", 10, "done"], ["B", 5, "done"]]);
  });
  it("payload・試行回数・保存の試行回数・最初に動いた時刻(1 回だけ)を、時点ごとに永続する", () => {
    const s = store();
    s.register(reg("A"));
    s.markFired("A", 5, 100);
    s.markFired("A", 5, 200);
    s.setAttempts("A", 5, 2);
    s.setPayload("A", 5, '{"x":1}');
    s.markSaveRetry("A", 5, 1, 500);
    const five = s.rows().find((r) => r.lead_min === 5)!;
    expect(five).toMatchObject({ fired_at: 100, attempts: 2, payload_json: '{"x":1}', save_attempts: 1, next_try_at: 500, state: "pending" });
    expect(s.rows().find((r) => r.lead_min === 10)).toMatchObject({ fired_at: null, attempts: 0, payload_json: null, save_attempts: 0, next_try_at: null });
  });
});

describe("parseOddsSnapshotPayload", () => {
  const ok: OddsSnapshotPayload = {
    raceId: "202605010101", leadMin: 5, kaisaiDate: "20261115", startMs: START, dueMs: DUE5, takenAtMs: START - 290_000,
    officialDatetime: "2026-11-15 15:40:00", oddsStatus: "middle", status: "ok", reason: null, attempts: 1, horses: [[1, 2.1, 1, 1.2, 1.5, "2023101645"]], combos: null,
  };
  it("正しい形はそのまま読める(ok・skipped)。壊れた JSON・形の違い・不整合は null", () => {
    expect(parseOddsSnapshotPayload(JSON.stringify(ok))).toEqual(ok);
    const skipped: OddsSnapshotPayload = { ...ok, leadMin: 10, officialDatetime: null, oddsStatus: null, status: "skipped", reason: "too-late", horses: null, combos: null };
    expect(parseOddsSnapshotPayload(JSON.stringify(skipped))).toEqual(skipped);
    expect(parseOddsSnapshotPayload("{")).toBeNull();
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, status: "weird" }))).toBeNull();
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, leadMin: 7 }))).toBeNull();
    // #787: 前日の夜(-1)・当日の朝(-2)も読める(組合せは null)。それ以外の負の値・0 は null
    for (const leadMin of [-1, -2] as const) expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, leadMin }))).toEqual({ ...ok, leadMin });
    for (const leadMin of [-3, 0, 1]) expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, leadMin }))).toBeNull();
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, horses: null }))).toBeNull(); // ok なのに馬が無い
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, status: "failed", reason: null, horses: null }))).toBeNull(); // failed なのに理由が無い
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, horses: [[1, 2]] }))).toBeNull();
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, horses: [[1, 2.1, 1, 1.2, 1.5]] }))).toBeNull(); // 馬の ID の要素が無い(旧い形)
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, horses: [[1, 2.1, 1, 1.2, 1.5, 123]] }))).toBeNull();
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, takenAtMs: null }))).toBeNull(); // 取った時刻は必ず残す
  });
  it("#751: combos の無い古い形(デプロイの前に DO に置かれた結果)も受け付け、combos は null として読む。拒まない", () => {
    const { combos: _omit, ...old } = ok;
    const parsed = parseOddsSnapshotPayload(JSON.stringify(old));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ ...ok, combos: null });
  });
  it("#751: combos は 頁ごとの {t,dt,st,o} か {err}。ok の行にだけ持てる。形の違いは null", () => {
    const page = { t: START - 289_000, dt: "2026-11-15 15:40:00", st: "middle", o: { "0102": 12.3, "0103": null } };
    const withCombos: OddsSnapshotPayload = { ...ok, combos: { umaren: page, wakuren: { err: "unavailable" } } };
    expect(parseOddsSnapshotPayload(JSON.stringify(withCombos))).toEqual(withCombos);
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, combos: { umaren: { t: "x", o: {} }, wakuren: { err: "unavailable" } } }))).toBeNull();
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, combos: { umaren: page } }))).toBeNull(); // 枠連が無い
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, combos: { umaren: { ...page, o: { "0102": "x" } }, wakuren: { err: "fetch-failed" } } }))).toBeNull();
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...ok, combos: { umaren: { err: 5 }, wakuren: { err: "fetch-failed" } } }))).toBeNull();
    const skipped = { ...ok, status: "skipped", reason: "too-late", oddsStatus: null, officialDatetime: null, horses: null };
    expect(parseOddsSnapshotPayload(JSON.stringify({ ...skipped, combos: withCombos.combos }))).toBeNull(); // ok 以外は combos を持たない
  });
  it("#751: 古い形(馬連・枠連だけ。デプロイの前に DO に置かれた結果)の combos は拒まず、そのまま読む(wide・sanrenpuku は無いまま)", () => {
    const page = { t: START - 289_000, dt: "2026-11-15 15:40:00", st: "middle", o: { "0102": 12.3 } };
    const oldCombos = { umaren: page, wakuren: { err: "unavailable" } };
    const parsed = parseOddsSnapshotPayload(JSON.stringify({ ...ok, combos: oldCombos }));
    expect(parsed).not.toBeNull();
    expect(parsed!.combos).toEqual(oldCombos);
    expect(parsed!.combos).not.toHaveProperty("wide");
  });
  it("#751: 新しい形(ワイド = 幅の配列、3連複 = 単一値)を読める。ワイドの値は [下限, 上限] だけ(単一値・長さの違う配列・文字列は null)。3連複は単一値だけ(配列は null)。票数なしの組は null", () => {
    const wide = { t: START - 288_000, dt: "2026-11-15 15:40:00", st: "middle", o: { "0102": [32.6, 35.2], "0103": [5, null], "0104": null } };
    const trio = { t: START - 287_000, dt: "2026-11-15 15:40:00", st: "middle", o: { "010203": 1058.5, "010204": null } };
    const full = { umaren: { t: 1, dt: null, st: null, o: {} }, wakuren: { err: "fetch-failed" }, wide, sanrenpuku: trio };
    const parsed = parseOddsSnapshotPayload(JSON.stringify({ ...ok, combos: full }));
    expect(parsed).not.toBeNull();
    expect(parsed!.combos).toEqual(full);
    const bad = (c: unknown) => parseOddsSnapshotPayload(JSON.stringify({ ...ok, combos: { ...full, ...(c as object) } }));
    expect(bad({ wide: { ...wide, o: { "0102": 32.6 } } })).toBeNull(); // 単一値は幅ではない
    expect(bad({ wide: { ...wide, o: { "0102": [1, 2, 3] } } })).toBeNull();
    expect(bad({ wide: { ...wide, o: { "0102": ["x", 2] } } })).toBeNull();
    expect(bad({ sanrenpuku: { ...trio, o: { "010203": [1, 2] } } })).toBeNull();
    expect(bad({ umaren: { t: 1, dt: null, st: null, o: { "0102": [1, 2] } } })).toBeNull(); // 馬連は単一値
    expect(bad({ wide: { err: "fetch-failed" }, sanrenpuku: { err: "parse-error" } })).not.toBeNull();
    expect(bad({ wide: { err: "weird" } })).toBeNull();
    expect(bad({ sanrenpuku: 5 })).toBeNull();
  });
});
