import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseBabaResponse, type BabaVenueRecord } from "../src/baba-conditions";
import { D1BabaStore } from "../src/baba-repository";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #294: 馬場の API の取得の試み(`baba_fetches`)と、競馬場ごとの当日の値(`baba_conditions`)の D1 への保存(`D1BabaStore`。migration 0017)。
 * ローカル(workerd)の D1 で、`wrangler d1 migrations apply --local`(CI と同じ実コマンド)で適用した表に対して確かめる。本番の D1 には触れない。
 */

installFetchTrap();

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE_TEXT = readFileSync(path.join(ROOT, "fixtures", "baba_latest_20261012.json"), "utf-8");
const NOW = Date.parse("2026-10-12T08:05:52.863Z");
const DATE = "20261012";

const parsed = (): { venues: readonly BabaVenueRecord[]; apiFetchedAt: string | null; dropped: number } => parseBabaResponse(SAMPLE_TEXT, NOW);

async function all(sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  return (await local.db.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
}

describe("claim(試みの先行記録)", () => {
  it("最初の 1 回だけ claimed。行は試みの時刻だけを持つ(結果の列は NULL)", async () => {
    const store = new D1BabaStore({ db: local.db });
    expect(await store.claim(DATE, 1_000)).toBe("claimed");
    expect(await all("SELECT * FROM baba_fetches")).toEqual([
      { kaisai_date: DATE, attempted_at: 1_000, finished_at: null, result: null, api_fetched_at: null, venues_saved: null, venues_dropped: null },
    ]);
  });

  it("2 回目以降は exists(行は最初のまま。試みの時刻を上書きしない)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 1_000);
    expect(await store.claim(DATE, 2_000)).toBe("exists");
    expect(await store.claim(DATE, 3_000)).toBe("exists");
    expect((await all("SELECT attempted_at FROM baba_fetches"))).toEqual([{ attempted_at: 1_000 }]);
  });

  it("結果が記録された後でも exists(完了した日の再 claim は通らない)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 1_000);
    const p = parsed();
    await store.finish(DATE, { finishedAt: 5_000, result: "ok", apiFetchedAt: p.apiFetchedAt, venues: p.venues, dropped: p.dropped });
    expect(await store.claim(DATE, 6_000)).toBe("exists");
  });

  it("並行して claim しても、claimed は 1 つだけ", async () => {
    const store = new D1BabaStore({ db: local.db });
    const results = await Promise.all([store.claim(DATE, 1), store.claim(DATE, 2), store.claim(DATE, 3), store.claim(DATE, 4)]);
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "exists")).toHaveLength(3);
    expect(await all("SELECT COUNT(*) AS n FROM baba_fetches")).toEqual([{ n: 1 }]);
  });

  it("開催日が違えば別の行(それぞれ claimed)", async () => {
    const store = new D1BabaStore({ db: local.db });
    expect(await store.claim("20261010", 1)).toBe("claimed");
    expect(await store.claim("20261011", 2)).toBe("claimed");
  });
});

describe("finish(結果の記録)", () => {
  it("成功: 試みの行に結果を書き、競馬場ごとに 1 行を保存する(見本の東京・京都)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 1_000);
    const p = parsed();
    expect(p.venues).toHaveLength(2); // 前提: 保存する競馬場がある(空振りでない)
    await store.finish(DATE, { finishedAt: 9_000, result: "ok", apiFetchedAt: p.apiFetchedAt, venues: p.venues, dropped: p.dropped });

    expect(await all("SELECT * FROM baba_fetches")).toEqual([
      { kaisai_date: DATE, attempted_at: 1_000, finished_at: 9_000, result: "ok", api_fetched_at: "2026-10-12T08:05:52.863Z", venues_saved: 2, venues_dropped: 1 },
    ]);
    const rows = await all("SELECT * FROM baba_conditions ORDER BY venue_code");
    expect(rows.map((r) => [r["kaisai_date"], r["venue_code"], r["venue_name"]])).toEqual([
      [DATE, "05", "東京"],
      [DATE, "08", "京都"],
    ]);
    expect(rows[0]).toMatchObject({
      measured_at: "2026-10-12T07:00+09:00",
      cushion: 9.6,
      turf_condition: "良",
      turf_goal_condition: "良",
      turf_corner4_condition: "良",
      turf_goal_moisture: 13.2,
      turf_corner4_moisture: 11.8,
      dirt_condition: "良",
      dirt_goal_condition: "良",
      dirt_corner4_condition: "良",
      dirt_goal_moisture: 1.7,
      dirt_corner4_moisture: 1.7,
      rainfall_mm: null,
      used_course: "Aコース（内柵を最内に設置）",
      turf_length: "芝丈(cm) 芝野芝10から12・洋芝10から14 障害野芝10から12",
      turf_state_text: "1週使用しましたが、傷みは少なく概ね良好な状態です。",
      saved_at: 9_000,
    });
    expect(JSON.parse(rows[0]!["raw_json"] as string)).toMatchObject({ venueCode: "05", cushion: 9.6 });
    expect(rows[1]).toMatchObject({ cushion: 10.7, dirt_goal_moisture: 2 });
  });

  it("失敗: 競馬場の行は作らず、分類だけを記録する(venues_saved = 0)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 1_000);
    await store.finish(DATE, { finishedAt: 2_000, result: "http-503", apiFetchedAt: null, venues: [], dropped: 0 });
    expect(await all("SELECT result, finished_at, api_fetched_at, venues_saved, venues_dropped FROM baba_fetches")).toEqual([
      { result: "http-503", finished_at: 2_000, api_fetched_at: null, venues_saved: 0, venues_dropped: 0 },
    ]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_conditions")).toEqual([{ n: 0 }]);
  });

  it("原子的: 競馬場の行の 1 つが書けなければ、結果の更新も他の競馬場の行も残らない(batch)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 1_000);
    const p = parsed();
    const broken = { ...p.venues[1]!, venueName: null as unknown as string }; // NOT NULL の違反
    await expect(store.finish(DATE, { finishedAt: 9_000, result: "ok", apiFetchedAt: p.apiFetchedAt, venues: [p.venues[0]!, broken], dropped: 0 })).rejects.toThrow();
    expect(await all("SELECT result, finished_at FROM baba_fetches")).toEqual([{ result: null, finished_at: null }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_conditions")).toEqual([{ n: 0 }]);
  });

  it("同じ競馬場を 2 回書いても、行は 1 つのまま(最初の値を残し、壊れない)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 1_000);
    const p = parsed();
    await store.finish(DATE, { finishedAt: 2_000, result: "ok", apiFetchedAt: p.apiFetchedAt, venues: p.venues, dropped: p.dropped });
    const changed = { ...p.venues[0]!, cushion: 1.1 };
    await store.finish(DATE, { finishedAt: 3_000, result: "ok", apiFetchedAt: p.apiFetchedAt, venues: [changed], dropped: 0 });
    expect(await all("SELECT venue_code, cushion FROM baba_conditions ORDER BY venue_code")).toEqual([
      { venue_code: "05", cushion: 9.6 },
      { venue_code: "08", cushion: 10.7 },
    ]);
  });
});
