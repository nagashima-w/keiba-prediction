import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CachedFetcher } from "../../packages/core/src/scraper/cached-fetcher";
import { DoSqlCacheStore, MAX_CACHE_VALUE_BYTES } from "../src/do-cache-store";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #177(#164-b)・#170 の AC-c1〜c5: 取得キャッシュ(Durable Object の SQLite に置く CacheStore。`DoSqlCacheStore`)。
 * 契約(`packages/core/test/fixtures/cache-store-contract.json`)は、exe の ScrapeCache(core のテスト)と共有する。
 */

type Step =
  | { op: "set"; key: string; value: string; at: number }
  | { op: "get"; key: string; at: number; maxAgeMs?: number; expect: { value: string; fetchedAt: number } | null };

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../packages/core/test/fixtures/cache-store-contract.json", import.meta.url)), "utf-8"),
) as { cases: { name: string; steps: Step[] }[] };

const opened: NodeSql[] = [];
function openStore(clock: { now: number }): { store: DoSqlCacheStore; sql: NodeSql } {
  const sql = openNodeSql();
  opened.push(sql);
  return { store: new DoSqlCacheStore({ sql, now: () => clock.now }), sql };
}
afterEach(() => {
  for (const sql of opened.splice(0)) {
    sql.close();
  }
});

describe("DoSqlCacheStore が CacheStore の契約を満たす(AC-b1・#170 AC-c1)", () => {
  it("前提(空振り防止): 契約に複数のケースと、ヒット・ミス両方の期待がある", () => {
    expect(contract.cases.length).toBeGreaterThanOrEqual(8);
    const gets = contract.cases.flatMap((c) => c.steps).filter((s): s is Extract<Step, { op: "get" }> => s.op === "get");
    expect(gets.some((g) => g.expect === null)).toBe(true);
    expect(gets.some((g) => g.expect !== null)).toBe(true);
  });

  it.each(contract.cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    const clock = { now: 0 };
    const { store } = openStore(clock);
    for (const step of testCase.steps) {
      clock.now = step.at;
      if (step.op === "set") {
        store.set(step.key, step.value);
        continue;
      }
      const actual = store.get(step.key, step.maxAgeMs === undefined ? {} : { maxAgeMs: step.maxAgeMs });
      expect(actual === undefined ? null : actual).toEqual(step.expect);
    }
  });

  it("キーは大文字小文字・前後の空白を区別する(別の行になる。AC-c3)", () => {
    const clock = { now: 1000 };
    const { store } = openStore(clock);
    store.set("A", "大");
    store.set("a", "小");
    store.set("a ", "空白つき");
    expect(store.get("A")?.value).toBe("大");
    expect(store.get("a")?.value).toBe("小");
    expect(store.get("a ")?.value).toBe("空白つき");
  });

  it("同じ DO で、同じストレージに再度 DoSqlCacheStore を作っても、保存済みの行を読める(DO の作り直しで消えない。表は IF NOT EXISTS)", () => {
    const clock = { now: 1000 };
    const sql = openNodeSql();
    opened.push(sql);
    new DoSqlCacheStore({ sql, now: () => clock.now }).set("k", "v");
    const second = new DoSqlCacheStore({ sql, now: () => clock.now });
    expect(second.get("k")?.value).toBe("v");
  });
});

describe("期限切れの掃除(AC-b1・#170 AC-c2)", () => {
  it("purgeOlderThan(retentionMs): 経過が retentionMs を超えた行だけを消し、ちょうど・新しい行は残す。消した件数を返す", () => {
    const clock = { now: 0 };
    const { store } = openStore(clock);
    clock.now = 1000;
    store.set("古い", "x");
    clock.now = 2000;
    store.set("ちょうど", "y");
    clock.now = 2500;
    store.set("新しい", "z");
    clock.now = 3000; // 経過: 古い=2000・ちょうど=1000・新しい=500
    const deleted = store.purgeOlderThan(1000);
    expect(deleted).toBe(1);
    expect(store.get("古い")).toBeUndefined();
    expect(store.get("ちょうど")?.value).toBe("y");
    expect(store.get("新しい")?.value).toBe("z");
    expect(store.count()).toBe(2);
  });

  it("何も期限切れでなければ 0 件で、全部残る(全消しではない)", () => {
    const clock = { now: 1000 };
    const { store } = openStore(clock);
    store.set("a", "1");
    store.set("b", "2");
    expect(store.purgeOlderThan(60_000)).toBe(0);
    expect(store.count()).toBe(2);
  });

  it("retentionMs が負・非有限なら、何も消さずに拒否する(全消しの事故を防ぐ)", () => {
    const clock = { now: 1000 };
    const { store } = openStore(clock);
    store.set("a", "1");
    for (const bad of [-1, Number.NaN]) {
      expect(() => store.purgeOlderThan(bad)).toThrow();
    }
    expect(store.count()).toBe(1);
  });
});

describe("大きな本文は保存しない(AC-b1・#170 AC-c5)", () => {
  it("上限は 2 MiB(UTF-8 のバイト数)で、ちょうど 2 MiB は保存し、1 バイト超えたら保存しない(例外にもしない)", () => {
    expect(MAX_CACHE_VALUE_BYTES).toBe(2 * 1024 * 1024);
    const clock = { now: 1000 };
    const { store } = openStore(clock);
    store.set("ちょうど", "a".repeat(MAX_CACHE_VALUE_BYTES));
    expect(store.get("ちょうど")?.value.length).toBe(MAX_CACHE_VALUE_BYTES);
    expect(() => store.set("超過", "a".repeat(MAX_CACHE_VALUE_BYTES + 1))).not.toThrow();
    expect(store.get("超過")).toBeUndefined();
  });

  it("文字数ではなくバイト数で判定する: 日本語(1文字 3 バイト)で、文字数は上限以下でもバイト数が超えたら保存しない", () => {
    const clock = { now: 1000 };
    const { store } = openStore(clock);
    const chars = Math.floor(MAX_CACHE_VALUE_BYTES / 3) + 1; // 文字数は 2 MiB よりずっと少ないが、3 バイト × chars は 2 MiB を超える
    const value = "あ".repeat(chars);
    expect(value.length).toBeLessThan(MAX_CACHE_VALUE_BYTES);
    expect(Buffer.byteLength(value, "utf-8")).toBeGreaterThan(MAX_CACHE_VALUE_BYTES);
    store.set("k", value);
    expect(store.get("k")).toBeUndefined();
  });

  it("同じキーの古い本文があるとき、新しい本文が大きすぎて保存されないなら、古い本文も消す(古いデータを新しいものとして返さない)", () => {
    const clock = { now: 1000 };
    const { store } = openStore(clock);
    store.set("k", "古い");
    store.set("k", "a".repeat(MAX_CACHE_VALUE_BYTES + 1));
    expect(store.get("k")).toBeUndefined();
  });

  it("CachedFetcher 経由: 大きな本文は、取得の失敗にならず本文が返り、キャッシュされないので次も取得し直す", async () => {
    const clock = { now: 1000 };
    const { store } = openStore(clock);
    const big = "a".repeat(MAX_CACHE_VALUE_BYTES + 1);
    let fetches = 0;
    const fetcher = new CachedFetcher({
      fetcher: {
        fetchText: async () => {
          fetches += 1;
          return big;
        },
      },
      cache: store,
    });
    expect(await fetcher.fetchText("https://race.netkeiba.com/x")).toBe(big);
    expect(await fetcher.fetchText("https://race.netkeiba.com/x")).toBe(big);
    expect(fetches).toBe(2);
    // 対照: 小さな本文は2回目がヒットして、取得は1回だけ
    let smallFetches = 0;
    const small = new CachedFetcher({
      fetcher: {
        fetchText: async () => {
          smallFetches += 1;
          return "小さい";
        },
      },
      cache: store,
    });
    await small.fetchText("https://race.netkeiba.com/y");
    await small.fetchText("https://race.netkeiba.com/y");
    expect(smallFetches).toBe(1);
  });
});

describe("保存に失敗しても取得は失敗にしない(レビュー指摘。AC-c5 の趣旨。Issue #177)", () => {
  /** INSERT だけが失敗する SQL(本番の DO の SQLite の1行の上限を超えた、などの模擬)。 */
  function failingInsertSql(base: NodeSql): NodeSql {
    return {
      ...base,
      exec(query: string, ...bindings: unknown[]) {
        if (/^\s*INSERT INTO fetch_cache/i.test(query)) {
          throw new Error("SQLITE_TOOBIG: string or blob too big");
        }
        return base.exec(query, ...bindings);
      },
    };
  }

  it("INSERT が例外で失敗しても、set は投げず、警告を1回出す。何も保存されない", () => {
    const warnings: string[] = [];
    const base = openNodeSql();
    opened.push(base);
    const store = new DoSqlCacheStore({ sql: failingInsertSql(base), now: () => 1000, onWarn: (m) => warnings.push(m) });
    expect(() => store.set("k", "本文")).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("保存に失敗");
    expect(warnings[0]).toContain("TOOBIG");
    expect(warnings[0]).not.toContain("本文"); // 本文は警告に入れない
    expect(store.get("k")).toBeUndefined();
  });

  it("同じキーに古い本文があるとき、保存に失敗したら古い本文も消す(古い本文を新しい取得の結果として返さない)", () => {
    const base = openNodeSql();
    opened.push(base);
    new DoSqlCacheStore({ sql: base, now: () => 1000 }).set("k", "古い");
    const store = new DoSqlCacheStore({ sql: failingInsertSql(base), now: () => 2000, onWarn: () => {} });
    store.set("k", "新しい");
    expect(store.get("k")).toBeUndefined();
  });

  it("CachedFetcher 経由: 保存に失敗しても、取得した本文が返る(取得の失敗にならない)。次回もキャッシュに無いので取り直す", async () => {
    const base = openNodeSql();
    opened.push(base);
    const store = new DoSqlCacheStore({ sql: failingInsertSql(base), now: () => 1000, onWarn: () => {} });
    let fetches = 0;
    const fetcher = new CachedFetcher({
      fetcher: {
        fetchText: async () => {
          fetches += 1;
          return "取得した本文";
        },
      },
      cache: store,
    });
    expect(await fetcher.fetchText("https://race.netkeiba.com/x")).toBe("取得した本文");
    expect(await fetcher.fetchText("https://race.netkeiba.com/x")).toBe("取得した本文");
    expect(fetches).toBe(2);
  });

  it("onWarn を渡さなくても投げない。保存に成功したときは警告を出さない", () => {
    const base = openNodeSql();
    opened.push(base);
    expect(() => new DoSqlCacheStore({ sql: failingInsertSql(base), now: () => 1000 }).set("k", "v")).not.toThrow();
    const warnings: string[] = [];
    const ok = new DoSqlCacheStore({ sql: base, now: () => 1000, onWarn: (m) => warnings.push(m) });
    ok.set("k2", "v");
    expect(warnings).toEqual([]);
    expect(ok.get("k2")?.value).toBe("v");
  });
});
