import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseRaceList } from "../../packages/core/src/scraper/parse-race-list";
import { DEFAULT_RACE_LIST_TTL_MS } from "../../packages/core/src/scraper/scrape-race";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { CACHE_RETENTION_MS, PURGE_MARGIN_MS, RaceDayCore, type RaceDayDeps } from "../src/race-day-core";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #183(#165-a): 日単位の DO の一覧の取得 `RaceDayCore.getRaceList(kaisaiDate, venue)`。
 * 取得は既存の gate 経由のキャッシュ(TTL は core の既定 6 時間)。**単一アラームの共有**(掃除専用アラームを、タスクのアラームを潰さずに仕掛ける)が主題。
 * ゲートは偽(フィクスチャを返す)。ストレージは `node:sqlite`(本物の SQLite)。実 netkeiba には触れない。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const CENTRAL_DATE = "20260628";
const CENTRAL_HTML = fixture("race_list_sub_20260628.html");
const NAR_DATE = "20260927";
const NAR_HTML = fixture("nar_race_list_sub_20260927.html");
const RACE_A = "202603020211";
const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

function response(body: string, status = 200): GateResult {
  return { kind: "response", status, contentType: "text/html; charset=UTF-8", body: bytes(body), queuedMs: 0, elapsedMs: 1 };
}

interface ListGate extends GateLike {
  readonly urls: string[];
  /** 一覧の URL に対する応答を差し替える(null なら既定のフィクスチャ)。 */
  listResponder: ((url: string) => Promise<GateResult> | GateResult) | null;
}

function listGate(): ListGate {
  const gate: ListGate = {
    urls: [],
    listResponder: null,
    async fetchRaw(url) {
      gate.urls.push(url);
      if (url.includes("race_list_sub")) {
        if (gate.listResponder !== null) {
          return gate.listResponder(url);
        }
        return response(url.startsWith("https://nar.netkeiba.com/") ? NAR_HTML : CENTRAL_HTML);
      }
      await Promise.resolve();
      return response(fixtureForUrl(url));
    },
  };
  return gate;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: ListGate;
  readonly clock: { now: number };
  readonly alarms: number[];
  readonly alarm: { at: number | null };
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) {
    sql.close();
  }
});

function harness(overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const gate = listGate();
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarms: number[] = [];
  const alarm: { at: number | null } = { at: null };
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarms.push(at);
      alarm.at = at;
    },
    onWarn: () => {},
    ...overrides,
  });
  return { core, sql, gate, clock, alarms, alarm };
}

async function runAll(h: Harness, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const outcome = await h.core.runNextStep();
    if (outcome.kind === "idle") {
      return;
    }
  }
  throw new Error("ステップが終わらない(上限超過)");
}

/** アラームだけで進める(DO と同じく、鳴った時刻に時計を進め、鳴ったアラームは空にしてから `runNextStep`)。上限つき。 */
async function driveByAlarms(h: Harness, max = 50): Promise<void> {
  for (let i = 0; i < max; i++) {
    const at = h.alarm.at;
    if (at === null) {
      return;
    }
    h.clock.now = Math.max(h.clock.now, at);
    h.alarm.at = null;
    await h.core.runNextStep();
  }
  throw new Error("アラームが止まらない(上限超過)");
}

const cacheKeys = (h: Harness, like: string): string[] =>
  (h.sql.exec("SELECT key FROM fetch_cache WHERE key LIKE ?", like).toArray() as { key: string }[]).map((r) => r.key);
const cacheCount = (h: Harness): number => (h.sql.exec("SELECT COUNT(*) AS n FROM fetch_cache").toArray() as { n: number }[])[0]!.n;
const metaWrites = (h: Harness): number => h.sql.statements.filter((s) => /race_day_meta/.test(s) && /^\s*(INSERT|UPDATE|DELETE)/i.test(s)).length;
const LIST_LIKE = "%race_list_sub%";

describe("一覧の取得とキャッシュ(Issue #183)", () => {
  it("中央は race.netkeiba.com・地方は nar.netkeiba.com の race_list_sub を、ちょうど1本取る(venue の取り違えなし)", async () => {
    const h = harness();
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.gate.urls).toEqual([`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${CENTRAL_DATE}`]);
    const n = harness();
    await n.core.getRaceList(NAR_DATE, "nar");
    expect(n.gate.urls).toEqual([`https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=${NAR_DATE}`]);
  });

  it("結果は core の parseRaceList と同じ(件数は、テスト内で独立にパースして比べる)。地方の帯広(場コード65)は含まれない", async () => {
    const central = parseRaceList(CENTRAL_HTML);
    expect(central.length).toBeGreaterThan(0); // 前提(空振り防止)
    const h = harness();
    const result = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(result).toEqual({ ok: true, races: central });

    const nar = parseRaceList(NAR_HTML);
    expect(nar.length).toBeGreaterThan(0);
    expect(NAR_HTML).toMatch(/race_id=\d{4}65\d{6}/); // 前提: フィクスチャに帯広が実際にある
    const r = await harness().core.getRaceList(NAR_DATE, "nar");
    expect(r).toEqual({ ok: true, races: nar });
    expect(nar.filter((e) => e.raceId.slice(4, 6) === "65")).toEqual([]);
  });

  it("TTL(既定 6 時間): ちょうどはキャッシュのまま(gate 0 本)、1 ミリ秒超えると取り直す。中央と地方は別のキー", async () => {
    const h = harness();
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.gate.urls).toHaveLength(1);
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.gate.urls).toHaveLength(1);
    h.clock.now += DEFAULT_RACE_LIST_TTL_MS;
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.gate.urls).toHaveLength(1);
    h.clock.now += 1;
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.gate.urls).toHaveLength(2);
    // 同じ日付でも、地方は別の URL(別のキー)なので取りに行く
    await h.core.getRaceList(CENTRAL_DATE, "nar");
    expect(h.gate.urls).toHaveLength(3);
    expect(h.gate.urls[2]!.startsWith("https://nar.netkeiba.com/")).toBe(true);
  });

  it("無効な venue・開催日は throw し、gate を呼ばない(RPC を直接呼ばれても守る)", async () => {
    const h = harness();
    for (const [date, venue] of [
      ["20260231", "central"],
      ["2026062", "central"],
      [CENTRAL_DATE, "foo"],
      [CENTRAL_DATE, ""],
    ] as const) {
      await expect(h.core.getRaceList(date, venue as never), `${date}/${venue}`).rejects.toThrow();
    }
    expect(h.gate.urls).toEqual([]);
  });
});

describe("DO の開催日の pin(Issue #183 D1: 一覧では pin しない。pin 済みで違う日は拒否)", () => {
  it("未 pin の DO で一覧を取っても、開催日は pin されない(getBoard().kaisaiDate が null のまま。meta に行を作らない)", async () => {
    const h = harness();
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.core.getBoard().kaisaiDate).toBeNull();
  });

  it("pin 済みの DO では、別の日は throw(gate 0 本)・同じ日は通る", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: CENTRAL_DATE });
    expect(h.core.getBoard().kaisaiDate).toBe(CENTRAL_DATE);
    await expect(h.core.getRaceList("20260629", "central")).rejects.toThrow(/20260628/);
    expect(h.gate.urls).toEqual([]);
    const ok = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(ok.ok).toBe(true);
  });
});

describe("掃除のアラーム: 単一アラームを、タスクのアラームを潰さずに共有する(Issue #183)", () => {
  it("タスクが無く期限も無い: 取得した行の fetchedAt + 保持期間 + 余裕に1回だけ設定し、そのアラームで一覧の行が消える。以後アラームは無い", async () => {
    const h = harness();
    const fetchedAt = h.clock.now;
    await h.core.getRaceList(CENTRAL_DATE, "central");
    const due = fetchedAt + CACHE_RETENTION_MS + PURGE_MARGIN_MS;
    expect(h.alarms).toEqual([due]);
    expect(cacheKeys(h, LIST_LIKE)).toHaveLength(1);
    // アラームが鳴る(時計を進めて、鳴ったアラームを空にして runNextStep)
    h.clock.now = due;
    h.alarm.at = null;
    const outcome = await h.core.runNextStep();
    expect(outcome).toEqual({ kind: "idle", purged: 1 });
    expect(cacheCount(h)).toBe(0);
    expect(h.alarm.at).toBeNull();
    expect(h.alarms).toHaveLength(1);
  });

  it("【アラームの上書き】queued のタスクがある日の一覧は、アラームを触らない(タスクの setAlarm が最後のまま)。タスクを最後まで進めると、一覧の行も掃除される", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: CENTRAL_DATE });
    const taskAlarm = h.alarm.at;
    expect(taskAlarm).toBe(h.clock.now);
    expect(h.alarms).toHaveLength(1);
    const listed = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(listed.ok).toBe(true);
    expect(cacheKeys(h, LIST_LIKE)).toHaveLength(1); // 前提: 一覧の行は実際に書かれた
    expect(h.alarms).toHaveLength(1); // 一覧は setAlarm を呼んでいない
    expect(h.alarm.at).toBe(taskAlarm);
    // タスク(取得 → 計算)が、そのアラームで進んで done になる
    await driveByAlarms(h);
    expect(h.core.getBoard().races[0]).toMatchObject({ raceId: RACE_A, status: "done" });
    expect(cacheCount(h)).toBe(0); // 一覧の行を含めて掃除された
  });

  it("【判定は取得の後】一覧の取得中に schedule() が割り込んでも、そのアラームを潰さない", async () => {
    const h = harness();
    let release!: (r: GateResult) => void;
    const started = new Promise<void>((resolve) => {
      h.gate.listResponder = () => {
        resolve();
        return new Promise<GateResult>((r) => {
          release = r;
        });
      };
    });
    const pending = h.core.getRaceList(CENTRAL_DATE, "central");
    await started; // 前提: 一覧の取得が gate の中で止まっている(= 取得の前の判定ではタスクは無い)
    expect(h.core.getBoard().races).toEqual([]);
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: CENTRAL_DATE });
    expect(h.alarms).toHaveLength(1);
    const scheduledAlarm = h.alarm.at;
    release(response(CENTRAL_HTML));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(h.alarms).toHaveLength(1); // 一覧は上書きしていない
    expect(h.alarm.at).toBe(scheduledAlarm);
  });

  it("【期限が古い】タスク完了で決まった期限(t0)より後に一覧を取ると、期限を後ろへ動かす。旧期限で起きても一覧の行は残り、新しい期限で消える", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE_A, kaisaiDate: CENTRAL_DATE });
    await runAll(h); // タスク完了。最後の armAlarm が掃除の期限 D0 を設定
    const oldDue = h.alarm.at!;
    expect(h.core.getBoard().races[0]).toMatchObject({ status: "done" });
    h.clock.now += 10 * 60 * 60 * 1000;
    const fetchedAt = h.clock.now;
    await h.core.getRaceList(CENTRAL_DATE, "central");
    const newDue = fetchedAt + CACHE_RETENTION_MS + PURGE_MARGIN_MS;
    expect(newDue).toBeGreaterThan(oldDue); // 前提: 新しい期限は本当に後ろ(差が 0 でない)
    expect(h.alarm.at).toBe(newDue);
    // 旧期限で(早く)起きる: 一覧の行は新しいので消えず、同じ新期限にアラームを設定し直す
    h.clock.now = oldDue;
    h.alarm.at = null;
    const early = await h.core.runNextStep();
    expect(early).toEqual({ kind: "idle" });
    expect(cacheKeys(h, LIST_LIKE)).toHaveLength(1);
    expect(h.alarm.at).toBe(newDue);
    // 新期限で起きると消える
    h.clock.now = newDue;
    h.alarm.at = null;
    const late = await h.core.runNextStep();
    expect(late.kind).toBe("idle");
    expect(cacheKeys(h, LIST_LIKE)).toEqual([]);
    expect(h.alarm.at).toBeNull();
  });

  it("【期限は前へ戻さない】既に後ろの期限があるとき、古い行(キャッシュヒット)の一覧では期限を動かさない", async () => {
    const h = harness();
    const t0 = h.clock.now;
    await h.core.getRaceList(CENTRAL_DATE, "central"); // 期限 D0 = t0 + 保持 + 余裕
    h.clock.now += 5 * 60 * 60 * 1000; // TTL(6 時間)の内側
    await h.core.getRaceList(CENTRAL_DATE, "nar"); // 新しい行 → 期限 D1(D0 より後ろ)
    const d0 = t0 + CACHE_RETENTION_MS + PURGE_MARGIN_MS;
    expect(h.alarms).toEqual([d0, h.clock.now + CACHE_RETENTION_MS + PURGE_MARGIN_MS]);
    expect(h.alarms[1]!).toBeGreaterThan(d0); // 前提: D1 は D0 より後ろ(差が 0 でない)
    // 中央の一覧をもう一度(キャッシュヒット。行の fetchedAt は t0 のまま = needed は D0)。期限は D1 のまま、アラームの再設定も無い
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.alarms).toHaveLength(2);
    expect(h.alarm.at).toBe(h.alarms[1]);
  });

  it("キャッシュヒットでは、アラームも meta も書かない。TTL を超えて取り直したときだけ、期限を後ろへ動かす", async () => {
    const h = harness();
    await h.core.getRaceList(CENTRAL_DATE, "central");
    const writes = metaWrites(h);
    expect(writes).toBeGreaterThan(0); // 前提: 最初の取得では期限を書いている
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.alarms).toHaveLength(1);
    expect(metaWrites(h)).toBe(writes);
    h.clock.now += DEFAULT_RACE_LIST_TTL_MS + 1;
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.alarms).toHaveLength(2);
    expect(h.alarms[1]! - h.alarms[0]!).toBe(DEFAULT_RACE_LIST_TTL_MS + 1);
  });
});

describe("失敗・空の一覧(Issue #183 D3・D4)", () => {
  const refused = (reason: string): GateResult => ({ kind: "refused", reason: reason as never, message: "gate の文面(返してはいけない)" });

  it.each([
    ["blocked", "blocked"],
    ["disallowed-url", "blocked"],
    ["queue-full", "busy"],
    ["network-error", "failed"],
    ["timeout", "failed"],
    ["bad-response", "failed"],
  ])("gate の拒否 %s は reason %s にする(gate の文面は載せない)。アラーム・meta・キャッシュ行は残さない", async (gateReason, expected) => {
    const h = harness();
    h.gate.listResponder = () => refused(gateReason);
    const result = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(result).toEqual({ ok: false, reason: expected });
    expect(JSON.stringify(result)).not.toContain("gate の文面");
    expect(h.alarms).toEqual([]);
    expect(metaWrites(h)).toBe(0);
    expect(cacheCount(h)).toBe(0);
  });

  it("netkeiba の HTTP エラー(403・500)は failed。リトライしない(gate は1本)", async () => {
    for (const status of [403, 500]) {
      const h = harness();
      h.gate.listResponder = () => response("error", status);
      expect(await h.core.getRaceList(CENTRAL_DATE, "central"), String(status)).toEqual({ ok: false, reason: "failed" });
      expect(h.gate.urls, String(status)).toHaveLength(1);
      expect(h.alarms).toEqual([]);
    }
  });

  it("失敗は保持しない: 失敗の直後の呼び出しは、もう一度取りに行って成功できる", async () => {
    const h = harness();
    h.gate.listResponder = () => refused("network-error");
    expect((await h.core.getRaceList(CENTRAL_DATE, "central")).ok).toBe(false);
    h.gate.listResponder = null;
    const retry = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(retry.ok).toBe(true);
    expect(h.gate.urls).toHaveLength(2);
  });

  it("D4: 空の一覧(開催なし・まだ公開前)はキャッシュ行を残さず、アラームも仕掛けない。次の呼び出しは取り直す。空でない一覧は残る", async () => {
    const h = harness();
    h.gate.listResponder = () => response("<html><body></body></html>");
    const first = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(first).toEqual({ ok: true, races: [] });
    expect(cacheKeys(h, LIST_LIKE)).toEqual([]);
    expect(h.alarms).toEqual([]);
    expect(metaWrites(h)).toBe(0);
    await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(h.gate.urls).toHaveLength(2);
    // 公開されたら、すぐ見える(空の結果を6時間持たない)
    h.gate.listResponder = null;
    const published = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(published.ok && published.races.length > 0).toBe(true);
    expect(cacheKeys(h, LIST_LIKE)).toHaveLength(1);
  });
});

describe("同じ一覧の同時取得の共有(Issue #183 in-flight)", () => {
  it("同じ日・同じ venue を同時に2回呼んでも、gate は1本。結果は同じ", async () => {
    const h = harness();
    let release!: (r: GateResult) => void;
    const started = new Promise<void>((resolve) => {
      h.gate.listResponder = () => {
        resolve();
        return new Promise<GateResult>((r) => {
          release = r;
        });
      };
    });
    const a = h.core.getRaceList(CENTRAL_DATE, "central");
    await started;
    const b = h.core.getRaceList(CENTRAL_DATE, "central");
    release(response(CENTRAL_HTML));
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.gate.urls).toHaveLength(1);
    expect(ra).toEqual(rb);
    expect(ra.ok && ra.races.length > 0).toBe(true);
  });

  it("別の venue は共有しない(同時でも、それぞれ1本)", async () => {
    const h = harness();
    await Promise.all([h.core.getRaceList(CENTRAL_DATE, "central"), h.core.getRaceList(CENTRAL_DATE, "nar")]);
    expect(h.gate.urls).toHaveLength(2);
  });

  it("失敗を保持しない: 同時の2回とも失敗になるが、その後の新しい呼び出しは取り直して成功できる(共有の記録が残らない)", async () => {
    const h = harness();
    h.gate.listResponder = () => refused("network-error");
    const [a, b] = await Promise.all([h.core.getRaceList(CENTRAL_DATE, "central"), h.core.getRaceList(CENTRAL_DATE, "central")]);
    expect(a).toEqual({ ok: false, reason: "failed" });
    expect(b).toEqual({ ok: false, reason: "failed" });
    expect(h.gate.urls).toHaveLength(1);
    h.gate.listResponder = null;
    const later = await h.core.getRaceList(CENTRAL_DATE, "central");
    expect(later.ok).toBe(true);
    expect(h.gate.urls).toHaveLength(2);
  });

  function refused(reason: string): GateResult {
    return { kind: "refused", reason: reason as never, message: "x" };
  }
});
