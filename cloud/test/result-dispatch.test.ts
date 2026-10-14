import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type RequestResultImportResult } from "../src/race-day-core";
import {
  addDaysToKaisaiDate,
  CRON_RESULT_MAX_DAYS,
  dispatchResultImports,
  MANUAL_RESULT_MAX_DAYS,
  RESULT_PER_DAY_LIMIT,
  RESULT_TOTAL_LIMIT,
  RESULT_WINDOW_DAYS,
  resultWindowFor,
  type DispatchStore,
  type ResultDayStub,
} from "../src/result-dispatch";
import { checkRaceDate } from "../src/race-date";
import { D1ResultStore } from "../src/result-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Issue #208(#182-B): `dispatchResultImports`(cron の `scheduled` と手動の `POST /api/results/import` が共有する、結果の取り込みの依頼)。
 * 窓の計算・列挙の呼び出しの引数・日ごとの依頼・失敗の扱い(例外にしない)・同時に並ぶ gate の呼び出しの上限を確かめる。
 */

describe("定数と窓の計算", () => {
  it("定数: 窓 7 日・cron は最大 2 日・手動は最大 3 日・1 日あたり 60 レース・合計 120 レース", () => {
    expect(RESULT_WINDOW_DAYS).toBe(7);
    expect(CRON_RESULT_MAX_DAYS).toBe(2);
    expect(MANUAL_RESULT_MAX_DAYS).toBe(3);
    expect(RESULT_PER_DAY_LIMIT).toBe(60);
    expect(RESULT_TOTAL_LIMIT).toBe(120);
  });

  it("addDaysToKaisaiDate: 月・年・うるう日をまたぐ(JST は夏時間が無く、暦日の足し引きだけ)", () => {
    expect(addDaysToKaisaiDate("20261008", -1)).toBe("20261007");
    expect(addDaysToKaisaiDate("20261001", -1)).toBe("20260930");
    expect(addDaysToKaisaiDate("20260101", -1)).toBe("20251231");
    expect(addDaysToKaisaiDate("20240301", -1)).toBe("20240229");
    expect(addDaysToKaisaiDate("20260301", -1)).toBe("20260228");
    expect(addDaysToKaisaiDate("20261231", 1)).toBe("20270101");
    expect(addDaysToKaisaiDate("20260105", -7)).toBe("20251229");
  });

  it("resultWindowFor(今日): 前日までの 7 日(今日は含めない)。窓の幅は両端を含めて 7 日", () => {
    expect(resultWindowFor("20261008")).toEqual({ from: "20261001", to: "20261007" });
    expect(resultWindowFor("20260105")).toEqual({ from: "20251229", to: "20260104" });
    const w = resultWindowFor("20261008");
    expect(w.to < "20261008").toBe(true); // 今日を含めない
    // 幅: from から to まで 7 日(両端を含む)
    let d = w.from;
    let days = 1;
    while (d !== w.to) {
      d = addDaysToKaisaiDate(d, 1);
      days += 1;
    }
    expect(days).toBe(RESULT_WINDOW_DAYS);
  });
});

// ---- 偽の依存 ----

interface FakeStore extends DispatchStore {
  readonly calls: Array<{ from: string; to: string; perDay: number; maxDays: number; total: number }>;
  list: Array<{ raceId: string; kaisaiDate: string }>;
  failWith: Error | null;
}
function fakeStore(): FakeStore {
  const s: FakeStore = {
    calls: [],
    list: [],
    failWith: null,
    async listUnimportedRacesByDay(options) {
      s.calls.push({ ...options });
      if (s.failWith !== null) throw s.failWith;
      return s.list;
    },
  };
  return s;
}

interface FakeStubs {
  readonly requests: Array<{ date: string; kaisaiDate: string; raceIds: string[]; winOddsOnly?: boolean }>;
  /** 依頼の入力そのもの(キーの有無を調べる: Issue #259)。 */
  readonly inputs: Array<Record<string, unknown>>;
  readonly opened: string[];
  failDates: Set<string>;
  stubFor(date: string): ResultDayStub;
}
function fakeStubs(): FakeStubs {
  const f: FakeStubs = {
    requests: [],
    inputs: [],
    opened: [],
    failDates: new Set(),
    stubFor(date) {
      f.opened.push(date);
      return {
        async requestResultImport(input) {
          f.inputs.push({ ...input });
          f.requests.push({ date, kaisaiDate: input.kaisaiDate, raceIds: [...input.raceIds], ...(input.winOddsOnly === undefined ? {} : { winOddsOnly: input.winOddsOnly }) });
          if (f.failDates.has(date)) throw new Error(`SECRET-RPC-${date}`);
          return { accepted: input.raceIds.length, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } };
        },
      };
    },
  };
  return f;
}
const logger = () => {
  const lines: Array<{ line: string; level: string }> = [];
  return { lines, log: (line: string, level: "info" | "error") => lines.push({ line, level }), text: () => lines.map((l) => l.line).join("\n") };
};

describe("dispatchResultImports(列挙 → 日ごとの依頼)", () => {
  const window = { from: "20261001", to: "20261007" };

  it("列挙は 1 回・引数は窓と上限(1 日 60・日数・合計 120)。日ごとに、その日の DO へ、その日のレースだけを依頼する(新しい日が先)", async () => {
    const store = fakeStore();
    store.list = [
      { raceId: "202603020211", kaisaiDate: "20261007" },
      { raceId: "202603020212", kaisaiDate: "20261007" },
      { raceId: "202603020111", kaisaiDate: "20261005" },
    ];
    const stubs = fakeStubs();
    const out = logger();
    const result = await dispatchResultImports({ ...window, maxDays: CRON_RESULT_MAX_DAYS, store, stubFor: stubs.stubFor, log: out.log });
    expect(store.calls).toEqual([{ ...window, perDay: 60, maxDays: 2, total: 120 }]);
    expect(stubs.requests).toEqual([
      { date: "20261007", kaisaiDate: "20261007", raceIds: ["202603020211", "202603020212"] },
      { date: "20261005", kaisaiDate: "20261005", raceIds: ["202603020111"] },
    ]);
    expect(result).toEqual({ listed: 3, days: 2, accepted: 3, failedDays: 0, invalid: 0, listFailed: false });
    expect(out.lines.every((l) => l.level === "info")).toBe(true);
    expect(out.text()).toContain("days=2");
  });

  // Issue #259: 過去分の補完(結果の補完の段階 2)は winOddsOnly: true を渡して、確定の単勝オッズ・人気だけを保存させる。
  it("winOddsOnly を渡さない依頼(cron・手動・段階 1)の入力に winOddsOnly のキーは無い(従来の依頼とバイトが同じ)", async () => {
    const store = fakeStore();
    store.list = [{ raceId: "202603020211", kaisaiDate: "20261007" }];
    const stubs = fakeStubs();
    await dispatchResultImports({ ...window, maxDays: CRON_RESULT_MAX_DAYS, store, stubFor: stubs.stubFor, log: logger().log });
    expect(stubs.inputs).toEqual([{ kaisaiDate: "20261007", raceIds: ["202603020211"] }]);
    expect(Object.keys(stubs.inputs[0]!)).toEqual(["kaisaiDate", "raceIds"]);
  });

  it("winOddsOnly: true を渡すと、日ごとの依頼のすべてに winOddsOnly: true が付く(日の分け方・件数・失敗の扱いは変わらない)", async () => {
    const store = fakeStore();
    store.list = [
      { raceId: "202603020211", kaisaiDate: "20261007" },
      { raceId: "202603020111", kaisaiDate: "20261005" },
    ];
    const stubs = fakeStubs();
    const result = await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: stubs.stubFor, log: logger().log, winOddsOnly: true });
    expect(stubs.requests).toEqual([
      { date: "20261007", kaisaiDate: "20261007", raceIds: ["202603020211"], winOddsOnly: true },
      { date: "20261005", kaisaiDate: "20261005", raceIds: ["202603020111"], winOddsOnly: true },
    ]);
    expect(result).toEqual({ listed: 2, days: 2, accepted: 2, failedDays: 0, invalid: 0, listFailed: false });
  });

  it("手動は maxDays = 3 で列挙する", async () => {
    const store = fakeStore();
    await dispatchResultImports({ ...window, maxDays: MANUAL_RESULT_MAX_DAYS, store, stubFor: fakeStubs().stubFor, log: logger().log });
    expect(store.calls[0]!.maxDays).toBe(3);
  });

  it("未取込が無ければ、DO のスタブを開かず(DO を作らない)、依頼もしない", async () => {
    const store = fakeStore();
    const stubs = fakeStubs();
    const result = await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: stubs.stubFor, log: logger().log });
    expect(stubs.opened).toEqual([]);
    expect(stubs.requests).toEqual([]);
    expect(result).toEqual({ listed: 0, days: 0, accepted: 0, failedDays: 0, invalid: 0, listFailed: false });
  });

  it("ある日の DO への依頼が失敗しても、他の日の依頼は続ける。例外にせず、失敗した日の数を返す。ログは日付と分類だけ(例外の文面を含まない)", async () => {
    const store = fakeStore();
    store.list = [
      { raceId: "202603020211", kaisaiDate: "20261007" },
      { raceId: "202603020111", kaisaiDate: "20261006" },
      { raceId: "202603010111", kaisaiDate: "20261005" },
    ];
    const stubs = fakeStubs();
    stubs.failDates.add("20261006");
    const out = logger();
    const result = await dispatchResultImports({ ...window, maxDays: 3, store, stubFor: stubs.stubFor, log: out.log });
    expect(stubs.requests.map((r) => r.date)).toEqual(["20261007", "20261006", "20261005"]);
    expect(result).toEqual({ listed: 3, days: 3, accepted: 2, failedDays: 1, invalid: 0, listFailed: false });
    expect(out.lines.filter((l) => l.level === "error")).toHaveLength(1);
    expect(out.text()).toContain("20261006");
    expect(out.text()).not.toContain("SECRET");
  });

  it("列挙(D1)の失敗は例外にせず、listFailed を返し、DO を呼ばない。ログは分類だけ", async () => {
    const store = fakeStore();
    store.failWith = new Error("D1 SECRET-D1");
    const stubs = fakeStubs();
    const out = logger();
    const result = await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: stubs.stubFor, log: out.log });
    expect(result).toEqual({ listed: 0, days: 0, accepted: 0, failedDays: 0, invalid: 0, listFailed: true });
    expect(stubs.opened).toEqual([]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.level).toBe("error");
    expect(out.text()).not.toContain("SECRET");
  });

  // ---- Issue #307(#302-A): 不正なレースは、DO を呼ぶ前に除外する(補完〈result-backfill-core.ts〉と同じ checkRaceDate) ----
  // 日単位の DO の requestResultImport は、不正なレースが 1 件でもあると依頼全体を拒否する。毒の行 1 件で、その日の本物のレースまで取り込めなくなるのを防ぐ。

  describe("不正なレースの事前除外(checkRaceDate)", () => {
    // 年が違う・桁が違う・地方の月日が開催日と違う、の 3 種類(有効な ID は中央 202603020211・地方 202644100701〈2026-10-07〉)
    const POISON = [
      { raceId: "202503020211", kaisaiDate: "20261007" }, // 年が開催日と違う
      { raceId: "2026030202", kaisaiDate: "20261007" }, // 12 桁でない
      { raceId: "202644100801", kaisaiDate: "20261007" }, // 地方の月日(10/08)が開催日(10/07)と違う
    ];

    it("前提: 毒の 3 件は実際に checkRaceDate を通らず、有効な 2 件は通る(テストの入力が空振りでない)", () => {
      for (const p of POISON) expect(checkRaceDate(p.raceId, p.kaisaiDate).ok).toBe(false);
      expect(checkRaceDate("202603020211", "20261007").ok).toBe(true);
      expect(checkRaceDate("202644100701", "20261007").ok).toBe(true);
    });

    it("同じ日に不正なレースが混ざっていても、その日の依頼は有効なレースだけで出す(毒の行で、その日の全部が失敗しない)。除外した数を invalid で返す", async () => {
      const store = fakeStore();
      store.list = [
        { raceId: "202603020211", kaisaiDate: "20261007" },
        ...POISON,
        { raceId: "202644100701", kaisaiDate: "20261007" },
      ];
      const stubs = fakeStubs();
      const result = await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: stubs.stubFor, log: logger().log });
      expect(stubs.requests).toEqual([{ date: "20261007", kaisaiDate: "20261007", raceIds: ["202603020211", "202644100701"] }]);
      expect(result).toEqual({ listed: 5, days: 1, accepted: 2, failedDays: 0, invalid: 3, listFailed: false });
    });

    it("開催日そのものが不正(例: 20261001x。文字列比較で窓に入ってしまう)なら、その日の DO のスタブを開かない。他の日は依頼する", async () => {
      const store = fakeStore();
      store.list = [
        { raceId: "202603020211", kaisaiDate: "20261007" },
        { raceId: "202603020111", kaisaiDate: "20261001x" },
        { raceId: "202603020112", kaisaiDate: "20261001x" },
      ];
      const stubs = fakeStubs();
      const result = await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: stubs.stubFor, log: logger().log });
      expect(stubs.opened).toEqual(["20261007"]);
      expect(stubs.requests.map((r) => r.date)).toEqual(["20261007"]);
      expect(result).toEqual({ listed: 3, days: 1, accepted: 1, failedDays: 0, invalid: 2, listFailed: false });
    });

    it("全部が不正なら、DO のスタブを開かず依頼もしない。失敗(failedDays・listFailed)としては数えない", async () => {
      const store = fakeStore();
      store.list = [...POISON];
      const stubs = fakeStubs();
      const result = await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: stubs.stubFor, log: logger().log });
      expect(stubs.opened).toEqual([]);
      expect(stubs.requests).toEqual([]);
      expect(result).toEqual({ listed: 3, days: 0, accepted: 0, failedDays: 0, invalid: 3, listFailed: false });
    });

    it("対照: 不正が無ければ invalid は 0 で、除外のログは出ない", async () => {
      const store = fakeStore();
      store.list = [{ raceId: "202603020211", kaisaiDate: "20261007" }];
      const out = logger();
      const result = await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: fakeStubs().stubFor, log: out.log });
      expect(result.invalid).toBe(0);
      expect(out.text()).not.toContain("invalid-race");
    });

    it("除外のログは固定の分類名と件数だけ(レースID・開催日の値を出さない)", async () => {
      const store = fakeStore();
      store.list = [{ raceId: "202603020211", kaisaiDate: "20261007" }, ...POISON, { raceId: "SECRET-ID", kaisaiDate: "SECRET-DATE" }];
      const out = logger();
      await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: fakeStubs().stubFor, log: out.log });
      const skipped = out.lines.filter((l) => l.line.includes("invalid-race"));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.line).toContain("count=4");
      const all = out.text();
      for (const secret of ["SECRET", "202503020211", "202644100801", "2026030202 "]) expect(all).not.toContain(secret);
    });

    it("winOddsOnly の依頼でも同じ除外をする(段階 2 の依頼にキーが付いたまま、有効なレースだけが行く)", async () => {
      const store = fakeStore();
      store.list = [{ raceId: "202603020211", kaisaiDate: "20261007" }, POISON[0]!];
      const stubs = fakeStubs();
      await dispatchResultImports({ ...window, maxDays: 2, store, stubFor: stubs.stubFor, log: logger().log, winOddsOnly: true });
      expect(stubs.requests).toEqual([{ date: "20261007", kaisaiDate: "20261007", raceIds: ["202603020211"], winOddsOnly: true }]);
    });
  });

  it("スタブの取得(stubFor)が投げても、その日の失敗として数える(例外にしない)", async () => {
    const store = fakeStore();
    store.list = [{ raceId: "202603020211", kaisaiDate: "20261007" }];
    const result = await dispatchResultImports({
      ...window,
      maxDays: 2,
      store,
      stubFor: () => {
        throw new Error("binding なし");
      },
      log: logger().log,
    });
    expect(result).toMatchObject({ days: 1, failedDays: 1, accepted: 0 });
  });
});

// ---- 本物の D1・本物の RaceDayCore で、同時に並ぶ gate の呼び出しの最大数を固定する ----

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const resultHtml = readFileSync(path.join(ROOT, "fixtures", "result_202603020211.html"), "utf-8");
const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};

describe("同時に並ぶ gate の呼び出しの最大数(AC-A: 過去日の DO を絞る)", () => {
  let local: LocalBindings;
  const opened: NodeSql[] = [];
  beforeAll(async () => {
    local = await openLocalBindings();
  }, 180_000);
  afterAll(async () => {
    await local?.dispose();
  });
  beforeEach(async () => {
    await local.reset();
  });
  afterEach(() => {
    for (const sql of opened.splice(0)) sql.close();
  });

  async function addAnalysis(raceId: string, kaisaiDate: string, i: number): Promise<void> {
    await local.db
      .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)")
      .bind(raceId, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, kaisaiDate)
      .run();
  }

  /** 開催日ごとに別の RaceDayCore(別の SQLite)を作り、すべて同じ gate(同時に何本並んだかを記録)に繋ぐ。 */
  function world(now: number) {
    const gate: GateLike & { inFlight: number; maxInFlight: number; fetched: number } = {
      inFlight: 0,
      maxInFlight: 0,
      fetched: 0,
      async fetchRaw(): Promise<GateResult> {
        gate.inFlight += 1;
        gate.maxInFlight = Math.max(gate.maxInFlight, gate.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5)); // 取得中に他の DO が並べるようにする
        gate.inFlight -= 1;
        gate.fetched += 1;
        return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(resultHtml), queuedMs: 0, elapsedMs: 1 };
      },
    };
    const cores = new Map<string, { core: RaceDayCore; alarm: { at: number | null } }>();
    const clock = { now };
    const stubFor = (date: string) => {
      let entry = cores.get(date);
      if (entry === undefined) {
        const sql = openNodeSql();
        opened.push(sql);
        const alarm: { at: number | null } = { at: null };
        const core = new RaceDayCore({
          sql,
          now: () => clock.now,
          gate,
          setAlarm: (at) => {
            alarm.at = at;
          },
          onWarn: () => undefined,
          resultStore: new D1ResultStore({ db: local.db }),
        });
        entry = { core, alarm };
        cores.set(date, entry);
      }
      return entry.core as ResultDayStub;
    };
    return { gate, cores, stubFor, clock };
  }

  it("D1 に未取込が 8 日ぶんあっても、cron は新しい 2 日・手動は新しい 3 日だけを依頼し、全 DO のアラームを同時に動かしても、gate に並ぶ呼び出しは日数以下", async () => {
    // 20261001〜20261008 の 8 日 × 各 2 レース(同じフィクスチャのページを返すので、レースIDは年が合う中央のIDなら何でもよい)
    for (let d = 1; d <= 8; d += 1) {
      await addAnalysis(`20260604${String(d).padStart(2, "0")}01`, `2026100${d}`, d);
      await addAnalysis(`20260604${String(d).padStart(2, "0")}02`, `2026100${d}`, d + 10);
    }
    const store = new D1ResultStore({ db: local.db });
    for (const [maxDays, expectedDays] of [[CRON_RESULT_MAX_DAYS, ["20261008", "20261007"]], [MANUAL_RESULT_MAX_DAYS, ["20261008", "20261007", "20261006"]]] as const) {
      const w = world(Date.parse("2026-10-09T09:00:00+09:00"));
      const result = await dispatchResultImports({ from: "20261001", to: "20261008", maxDays, store, stubFor: w.stubFor, log: () => undefined });
      expect(result).toMatchObject({ days: maxDays, accepted: maxDays * 2, failedDays: 0, invalid: 0, listFailed: false });
      expect([...w.cores.keys()]).toEqual([...expectedDays]);
      // 全 DO のアラームを同時に動かす(本番では各 DO が独立にアラームで動く)
      const loops = [...w.cores.values()].map(async ({ core, alarm }) => {
        for (let i = 0; i < 10 && alarm.at !== null; i += 1) {
          const at = alarm.at;
          alarm.at = null;
          w.clock.now = Math.max(w.clock.now, at);
          await core.runNextStep();
        }
      });
      await Promise.all(loops);
      expect(w.gate.fetched).toBe(maxDays * 2); // 前提: 実際に取得が起きた(空振りでない)
      expect(w.gate.maxInFlight).toBeGreaterThan(1); // 前提: 実際に複数の DO が重なった
      expect(w.gate.maxInFlight).toBeLessThanOrEqual(maxDays);
      // 取り込んだレース(依頼した日のぶんだけ)が D1 に入り、次の列挙から外れる(取り込みが進めば先頭が進む)
      const saved = (await local.db.prepare("SELECT count(DISTINCT race_id) AS n FROM race_results").first<{ n: number }>())!.n;
      expect(saved).toBe(maxDays * 2);
      const next = await store.listUnimportedRacesByDay({ from: "20261001", to: "20261008", perDay: 60, maxDays: 31, total: 200 });
      expect(next).toHaveLength(16 - maxDays * 2);
      await local.reset();
      for (let d = 1; d <= 8; d += 1) {
        await addAnalysis(`20260604${String(d).padStart(2, "0")}01`, `2026100${d}`, d);
        await addAnalysis(`20260604${String(d).padStart(2, "0")}02`, `2026100${d}`, d + 10);
      }
    }
  });
});
