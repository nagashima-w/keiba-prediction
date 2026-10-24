import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BabaFetchError, type BabaResultClass, type BabaVenueRecord } from "../src/baba-conditions";
import {
  BABA_FETCH_JST,
  BABA_META_ATTEMPTED,
  BABA_META_CLAIM_TRIES,
  BABA_META_RESULT,
  BABA_META_RETRY_AT,
  BabaStage,
  type BabaFacts,
  type BabaFetcher,
  type BabaFinish,
  type BabaStore,
} from "../src/race-day-baba";
import { openNodeSql, type NodeSql } from "./node-sql";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #294: 馬場の API の取得ステップ(`BabaStage`)の単体。いつ動けるか(期限と条件)・「試みた」を先に永続化して 1 日 1 回に収めること・失敗の扱い。
 * 保存先(D1)・取得口(API)は偽。**実際の API には一切アクセスしない**。ストレージは `node:sqlite`(本物の SQLite)。
 * 使う URL・ホストは登場しない(取得口は関数で、URL はその外にある)。
 */

installFetchTrap();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE_TEXT = readFileSync(path.join(ROOT, "fixtures", "baba_latest_20261012.json"), "utf-8");
const DATE = "20261012";
const jst = (s: string): number => Date.parse(`${s}+09:00`);
const AT_0930 = jst("2026-10-12T09:30:00");

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

interface FakeStore extends BabaStore {
  readonly claims: { date: string; at: number }[];
  readonly claimed: Set<string>;
  readonly finishes: { date: string; finish: BabaFinish }[];
  /** 先頭から 1 回ずつ消費する claim の失敗。 */
  claimFailures: number;
  finishFails: boolean;
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    claims: [],
    claimed: new Set(),
    finishes: [],
    claimFailures: 0,
    finishFails: false,
    async claim(date, at) {
      await Promise.resolve();
      store.claims.push({ date, at });
      if (store.claimFailures > 0) {
        store.claimFailures -= 1;
        throw new Error("D1 が応答しません https://d1.test.invalid/secret");
      }
      if (store.claimed.has(date)) return "exists";
      store.claimed.add(date);
      return "claimed";
    },
    async finish(date, finish) {
      await Promise.resolve();
      if (store.finishFails) throw new Error("D1 の保存に失敗 https://d1.test.invalid/secret");
      store.finishes.push({ date, finish });
    },
  };
  return store;
}

interface Harness {
  readonly stage: BabaStage;
  readonly sql: NodeSql;
  readonly store: FakeStore;
  readonly clock: { now: number };
  readonly facts: BabaFacts;
  readonly warns: string[];
  readonly fetchCalls: { n: number };
  /** 取得口の挙動(省略時は見本を返す)。 */
  behavior: { respond: () => Promise<string> | string };
  /** 取得口が呼ばれた瞬間の、永続化の状態(「試みた」が先か)。 */
  readonly atFetch: { claimRowExists: boolean; metaAttempted: string | null }[];
}

const GOOD_FACTS: BabaFacts = { kaisaiDate: DATE, planFinalized: true, centralListed: true };

function harness(options: { facts?: Partial<BabaFacts>; sql?: NodeSql; store?: FakeStore; noFetcher?: boolean; noStore?: boolean; now?: number } = {}): Harness {
  const sql = options.sql ?? openNodeSql();
  if (options.sql === undefined) {
    opened.push(sql);
  }
  sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store = options.store ?? fakeStore();
  const clock = { now: options.now ?? AT_0930 };
  const facts: BabaFacts = { ...GOOD_FACTS, ...options.facts };
  const warns: string[] = [];
  const fetchCalls = { n: 0 };
  const atFetch: Harness["atFetch"] = [];
  const h = { behavior: { respond: (): Promise<string> | string => SAMPLE_TEXT } } as Pick<Harness, "behavior">;
  const fetcher: BabaFetcher = async () => {
    fetchCalls.n += 1;
    atFetch.push({
      claimRowExists: store.claimed.has(DATE),
      metaAttempted: (sql.exec("SELECT value FROM race_day_meta WHERE key = ?", BABA_META_ATTEMPTED).toArray() as { value: string }[])[0]?.value ?? null,
    });
    return h.behavior.respond();
  };
  const stage = new BabaStage({
    sql,
    now: () => clock.now,
    fetcher: options.noFetcher === true ? undefined : fetcher,
    store: options.noStore === true ? undefined : store,
    onWarn: (m) => warns.push(m),
    facts: () => facts,
    retryDelayMs: 60_000,
    maxClaimAttempts: 3,
  });
  return { stage, sql, store, clock, facts, warns, fetchCalls, behavior: h.behavior, atFetch };
}

const meta = (h: Pick<Harness, "sql">, key: string): string | null =>
  (h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[])[0]?.value ?? null;

describe("期限(dueAtMs): 開催日の 09:30 JST で固定(最初の発走前の分析の期限には左右されない)", () => {
  it("定数: 09:30", () => {
    expect(BABA_FETCH_JST).toBe("09:30");
  });

  // 取得は 09:30 に固定する。外部の API は 08:00 の時点でも 09:00 の時点でも当日 7:00 の計測値をまだ載せていなかった(Issue #360・#475)ので、値が載る前に取りに行かないことを、最初の数レースの分析に間に合うことより優先する。
  // 最初の発走前の分析の期限(計画の行)が 09:30 より前でも 09:30 より後でも、取得は 09:30(`BabaFacts` に最初の期限は渡さない)。
  it("開催日が確定していれば、どの時刻から数えても期限は 09:30(前夜の計画の段階から候補になる)", () => {
    for (const now of [jst("2026-10-11T21:30:00"), jst("2026-10-12T06:00:00"), jst("2026-10-12T09:00:00"), jst("2026-10-12T09:29:59")]) {
      const h = harness({ now });
      expect(h.stage.dueAtMs()).toBe(AT_0930);
    }
  });

  it("BabaFacts は最初の発走前の分析の期限を持たない(期限の式から外した)", () => {
    expect(Object.keys(GOOD_FACTS).sort()).toEqual(["centralListed", "kaisaiDate", "planFinalized"]);
  });

  const none: { name: string; options: Parameters<typeof harness>[0] }[] = [
    { name: "計画が確定していない", options: { facts: { planFinalized: false } } },
    { name: "中央の一覧が無い(地方だけの日・一覧の取得に失敗した日)", options: { facts: { centralListed: false } } },
    { name: "開催日が未確定", options: { facts: { kaisaiDate: null } } },
    { name: "取得口が無い(secret 未登録)", options: { noFetcher: true } },
    { name: "保存先が無い", options: { noStore: true } },
    { name: "開催日が過去(今日 JST が開催日より後)", options: { now: jst("2026-10-13T00:00:00") } },
  ];
  for (const c of none) {
    it(`${c.name} → null(アラームの候補にならない)`, () => {
      const h = harness({ now: AT_0930, ...c.options });
      expect(h.stage.dueAtMs()).toBeNull();
      expect(h.stage.runnable()).toBe(false);
    });
  }

  it("試みの印があれば null(取得の後に候補が残って即時のアラームが続かない)", () => {
    const h = harness();
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?)", BABA_META_ATTEMPTED, "1");
    expect(h.stage.dueAtMs()).toBeNull();
    expect(h.stage.runnable()).toBe(false);
  });

  it("claim の再試行待ちがあれば、期限と再試行の時刻の遅いほう", () => {
    const h = harness();
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?)", BABA_META_RETRY_AT, String(AT_0930 + 60_000));
    expect(h.stage.dueAtMs()).toBe(AT_0930 + 60_000);
  });

  it("secret 未登録のとき、何度確かめても印を書かない(後から登録した同じ日に取得できる)", async () => {
    const h = harness({ noFetcher: true });
    expect(h.stage.runnable()).toBe(false);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull();
  });
});

describe("動ける時刻(runnable)", () => {
  it("09:30 の 1ms 前は動けず、09:30 ちょうどから動ける。09:00 ちょうどはまだ動けない(Issue #475)", () => {
    const early = harness({ now: jst("2026-10-12T09:00:00") });
    expect(early.stage.runnable()).toBe(false);
    const h = harness({ now: AT_0930 - 1 });
    expect(h.stage.runnable()).toBe(false);
    h.clock.now = AT_0930;
    expect(h.stage.runnable()).toBe(true);
  });

  it("前夜(21:00 の計画の直後)は、期限が翌朝でも動けない", () => {
    const h = harness({ now: jst("2026-10-11T21:30:00") });
    expect(h.stage.dueAtMs()).toBe(AT_0930); // 前提: 候補(アラーム)にはなる
    expect(h.stage.runnable()).toBe(false);
  });

  it("開催日の当日の夕方でも、まだ試みていなければ動ける(同日の遅い計画・取り残し)", () => {
    const h = harness({ now: jst("2026-10-12T17:05:00") });
    expect(h.stage.runnable()).toBe(true);
  });
});

describe("run: 試みを先に永続化して、1 回だけ取得する", () => {
  it("成功: claim → 印を書く → 取得 → 解析 → 保存。取得口が呼ばれた瞬間に、claim の行も DO の印もある", async () => {
    const h = harness();
    const outcome = await h.stage.run();
    expect(outcome).toEqual({ kind: "ran", raceId: DATE, mode: "baba", step: "fetch", result: "ok" });
    expect(h.fetchCalls.n).toBe(1);
    expect(h.atFetch).toEqual([{ claimRowExists: true, metaAttempted: String(AT_0930) }]);
    expect(h.store.claims).toEqual([{ date: DATE, at: AT_0930 }]);
    expect(h.store.finishes).toHaveLength(1);
    const finish = h.store.finishes[0]!.finish;
    expect(finish.result).toBe("ok");
    expect(finish.venues.map((v: BabaVenueRecord) => v.venueCode)).toEqual(["05", "08"]); // 札幌(9/6)は捨てる
    expect(finish.dropped).toBe(1);
    expect(finish.droppedDetails).toEqual([{ venue: "01", reason: "not-today", measured: "9月6日（日曜）8時20分" }]);
    expect(finish.finishedAt).toBe(AT_0930);
    expect(meta(h, BABA_META_ATTEMPTED)).toBe(String(AT_0930));
    expect(meta(h, BABA_META_RESULT)).toBe("ok");
    expect(h.warns).toEqual([]);
    // 動けなくなる(再度の実行・アラームの候補にならない)
    expect(h.stage.runnable()).toBe(false);
    expect(h.stage.dueAtMs()).toBeNull();
  });

  // 結果が何であっても、2 回目は送らない(M2・M3)。
  const outcomes: { name: string; result: BabaResultClass; setup: (h: Harness) => void; stepResult: "ok" | "failed" }[] = [
    { name: "成功", result: "ok", setup: () => undefined, stepResult: "ok" },
    { name: "HTTP 500", result: "http-500", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("http-500"))), stepResult: "failed" },
    { name: "タイムアウト", result: "timeout", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("timeout"))), stepResult: "failed" },
    { name: "通信の失敗", result: "network", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("network"))), stepResult: "failed" },
    { name: "リダイレクト", result: "redirect", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("redirect"))), stepResult: "failed" },
    { name: "JSON でない本文", result: "not-json", setup: (h) => (h.behavior.respond = () => "<html>Bad Gateway</html>"), stepResult: "failed" },
    { name: "形の不一致", result: "shape-mismatch", setup: (h) => (h.behavior.respond = () => '{"venues":[]}'), stepResult: "failed" },
    { name: "古いキャッシュ(stale)", result: "stale", setup: (h) => (h.behavior.respond = () => JSON.stringify({ ...JSON.parse(SAMPLE_TEXT), fetchedAt: "2026-10-11T08:00:00.000Z" })), stepResult: "failed" },
    { name: "当日の競馬場が無い", result: "no-today-venues", setup: (h) => (h.behavior.respond = () => JSON.stringify({ ...JSON.parse(SAMPLE_TEXT), venues: [JSON.parse(SAMPLE_TEXT).venues[2]] })), stepResult: "failed" },
    { name: "想定外の例外(BabaFetchError でない)", result: "other", setup: (h) => (h.behavior.respond = () => Promise.reject(new TypeError("想定外 https://secret.test.invalid/x"))), stepResult: "failed" },
    { name: "D1 への結果の保存の失敗", result: "ok", setup: (h) => (h.store.finishFails = true), stepResult: "failed" },
  ];
  for (const c of outcomes) {
    it(`${c.name}: 取得は 1 回だけ。同じ stage・新しい stage(DO の再起動)・並行の run のどれでも 2 回目を送らない`, async () => {
      const h = harness();
      c.setup(h);
      const first = await h.stage.run();
      expect(first.result).toBe(c.stepResult);
      expect(h.fetchCalls.n).toBe(1);
      if (!h.store.finishFails) {
        expect(h.store.finishes[0]?.finish.result).toBe(c.result);
      }
      // 同じ stage で動けない・run を直接呼んでも取得しない
      expect(h.stage.runnable()).toBe(false);
      // 再起動: 同じ SQLite(DO の永続)・同じ保存先で新しい stage
      const restarted = harness({ sql: h.sql, store: h.store });
      restarted.behavior.respond = () => {
        throw new Error("2 回目の取得が送られた");
      };
      expect(restarted.stage.runnable()).toBe(false);
      expect(restarted.stage.dueAtMs()).toBeNull();
      expect(restarted.fetchCalls.n).toBe(0);
      expect(h.fetchCalls.n).toBe(1);
    });
  }

  it("印が消えていても(claim の後・印を書く前のクラッシュ)、D1 の claim が exists なので取得しない。印は書き直し、以後は D1 を引かない", async () => {
    const h = harness();
    await h.stage.run();
    expect(h.fetchCalls.n).toBe(1);
    h.sql.exec("DELETE FROM race_day_meta WHERE key = ?", BABA_META_ATTEMPTED); // DO の印だけが無い状態
    const restarted = harness({ sql: h.sql, store: h.store });
    expect(restarted.stage.runnable()).toBe(true); // DO の印が無いので動ける
    const outcome = await restarted.stage.run();
    expect(outcome.result).toBe("failed");
    expect(restarted.fetchCalls.n).toBe(0); // 取得口は呼ばれない
    expect(meta(restarted, BABA_META_ATTEMPTED)).not.toBeNull();
    expect(restarted.stage.runnable()).toBe(false);
    const claimCountAfter = h.store.claims.length;
    expect(claimCountAfter).toBe(2); // 最初の claim と、印が消えた後の 1 回だけ
    await restarted.stage.run().catch(() => undefined);
    expect(h.store.claims.length).toBe(claimCountAfter); // 以後は D1 を引かない
  });

  it("DO の SQLite が消えて(新しい SQLite)D1 の claim だけが残っていても、取得しない", async () => {
    const first = harness();
    await first.stage.run();
    const fresh = harness({ store: first.store }); // 新しい SQLite・同じ保存先
    expect(fresh.stage.runnable()).toBe(true);
    await fresh.stage.run();
    expect(fresh.fetchCalls.n).toBe(0);
    expect(first.fetchCalls.n).toBe(1);
  });

  it("並行して run を呼んでも、取得口は 1 回だけ(実行中は動けない)", async () => {
    const h = harness();
    const a = h.stage.run();
    expect(h.stage.runnable()).toBe(false); // 実行中
    const results = await Promise.all([a, h.stage.run()]);
    expect(h.fetchCalls.n).toBe(1);
    expect(results.filter((r) => r.result === "ok")).toHaveLength(1);
    expect(h.store.claims).toHaveLength(1);
  });

  it("クラッシュの模擬: 取得口が戻らないまま stage を捨てても、新しい stage は取得しない(印は取得の前に書かれている)", async () => {
    const h = harness();
    h.behavior.respond = () => new Promise<string>(() => undefined); // 応答が返らない
    void h.stage.run();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(h.fetchCalls.n).toBe(1);
    expect(meta(h, BABA_META_ATTEMPTED)).toBe(String(AT_0930));
    const restarted = harness({ sql: h.sql, store: h.store });
    expect(restarted.stage.runnable()).toBe(false);
    expect(restarted.fetchCalls.n).toBe(0);
  });
});

describe("claim の失敗(API に何も送っていないので再試行してよい)", () => {
  it("失敗 → 60 秒後に再試行 → 成功。取得は 1 回", async () => {
    const h = harness();
    h.store.claimFailures = 1;
    const first = await h.stage.run();
    expect(first.result).toBe("retry");
    expect(h.fetchCalls.n).toBe(0);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull(); // 印は書かない(取得していない)
    expect(meta(h, BABA_META_RETRY_AT)).toBe(String(AT_0930 + 60_000));
    expect(meta(h, BABA_META_CLAIM_TRIES)).toBe("1");
    // 再試行の時刻まで動けない・候補はその時刻
    expect(h.stage.runnable()).toBe(false);
    expect(h.stage.dueAtMs()).toBe(AT_0930 + 60_000);
    h.clock.now = AT_0930 + 60_000;
    expect(h.stage.runnable()).toBe(true);
    const second = await h.stage.run();
    expect(second.result).toBe("ok");
    expect(h.fetchCalls.n).toBe(1);
  });

  it("3 回とも失敗 → 当日は諦める(印を書き、取得口は一度も呼ばない)。警告は固定の文で、例外の文面・URL を含まない", async () => {
    const h = harness();
    h.store.claimFailures = 3;
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      results.push((await h.stage.run()).result);
      h.clock.now += 60_000;
    }
    expect(results).toEqual(["retry", "retry", "failed"]);
    expect(h.fetchCalls.n).toBe(0);
    expect(meta(h, BABA_META_ATTEMPTED)).not.toBeNull();
    expect(meta(h, BABA_META_RESULT)).toBe("claim-failed");
    expect(h.stage.runnable()).toBe(false);
    expect(h.stage.dueAtMs()).toBeNull();
    expect(h.warns.length).toBeGreaterThan(0);
    expect(h.warns.join("\n")).not.toContain("secret");
    expect(h.warns.join("\n")).not.toContain("d1.test.invalid");
  });
});

describe("失敗しても分析を止めず、秘匿を守る", () => {
  it("run は例外を投げない(取得口・保存先がどう失敗しても)。アラームの再実行を起こさない", async () => {
    const h = harness();
    h.behavior.respond = () => {
      throw new Error("同期の例外 https://secret.test.invalid/x");
    };
    h.store.finishFails = true;
    await expect(h.stage.run()).resolves.toMatchObject({ mode: "baba", result: "failed" });
  });

  it("警告・結果の記録に、例外の文面・URL・応答の本文を残さない(固定の文と分類だけ)", async () => {
    const h = harness();
    h.behavior.respond = () => Promise.reject(new TypeError("fetch failed https://secret.test.invalid/baba?token=ABC"));
    h.store.finishFails = true;
    await h.stage.run();
    const all = JSON.stringify([h.warns, h.store.finishes, meta(h, BABA_META_RESULT)]);
    expect(h.warns.length).toBeGreaterThan(0);
    expect(all).not.toContain("secret.test.invalid");
    expect(all).not.toContain("ABC");
    expect(meta(h, BABA_META_RESULT)).toBe("other");
  });

  it("応答の本文(競馬場の文章)を警告に出さない", async () => {
    const h = harness();
    h.behavior.respond = () => JSON.stringify({ fetchedAt: "2026-10-12T08:00:00Z", venues: [{ venueCode: "05", venueName: "本文に含まれる語-CANARY", measuredAt: "壊れた" }] });
    await h.stage.run();
    expect(h.warns.length).toBeGreaterThan(0);
    expect(h.warns.join("\n")).not.toContain("CANARY");
  });

  it("保存先に渡す記録に、応答の本文の断片を入れない(成功: API の fetchedAt と競馬場の値だけ。失敗: apiFetchedAt は null)", async () => {
    const ok = harness();
    ok.behavior.respond = () => JSON.stringify({ ...(JSON.parse(SAMPLE_TEXT) as object), text: "本文の断片-CANARY" });
    await ok.stage.run();
    expect(ok.store.finishes).toHaveLength(1);
    expect(ok.store.finishes[0]!.finish.result).toBe("ok");
    expect(ok.store.finishes[0]!.finish.apiFetchedAt).toBe((JSON.parse(SAMPLE_TEXT) as { fetchedAt: string }).fetchedAt);
    expect(JSON.stringify(ok.store.finishes)).not.toContain("CANARY");

    const ng = harness();
    ng.behavior.respond = () => "<html>Bad Gateway 本文の断片-CANARY</html>";
    await ng.stage.run();
    expect(ng.store.finishes).toHaveLength(1);
    expect(ng.store.finishes[0]!.finish.result).toBe("not-json");
    expect(ng.store.finishes[0]!.finish.apiFetchedAt).toBeNull();
    expect(JSON.stringify([ng.store.finishes, ng.warns])).not.toContain("CANARY");
  });

  it("成功のとき警告は無く、一部の競馬場を捨てただけの応答も警告にしない(件数は D1 の記録に残る)", async () => {
    const h = harness();
    await h.stage.run();
    expect(h.warns).toEqual([]);
  });
});
