import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BabaDroppedDetail, BabaVenueRecord } from "../src/baba-conditions";
import { D1BabaStore, FETCH_LIST_LIMIT_DEFAULT } from "../src/baba-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { installFetchTrap } from "./fetch-trap";
import { SAMPLE_DATE, SAMPLE_NOW, sampleOutcome } from "./baba-sample";

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

const DATE = SAMPLE_DATE;
/** 捨てた競馬場の診断の見本(実物のフィクスチャでは捨てる場が無いので、保存・読み出しの往復の検査用に足す)。 */
const DROPPED: readonly BabaDroppedDetail[] = [{ venue: "01", reason: "not-today", measured: "9月6日（日曜）8時20分" }];

/** 実物の 3 場(東京・京都・新潟)に、捨てた場 1 件の診断を足した見本。 */
const parsed = (): { venues: readonly BabaVenueRecord[]; apiFetchedAt: string | null; dropped: number; droppedDetails: readonly BabaDroppedDetail[] } => ({
  ...sampleOutcome(),
  dropped: 1,
  droppedDetails: DROPPED,
});

async function all(sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  return (await local.db.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
}

/** finish の引数(枠・そろったか・結果)を省いて書くための組み立て。 */
const fin = (over: Partial<Parameters<D1BabaStore["finish"]>[1]> & Pick<Parameters<D1BabaStore["finish"]>[1], "finishedAt">): Parameters<D1BabaStore["finish"]>[1] => ({
  slot: 0,
  complete: false,
  result: "ok",
  apiFetchedAt: null,
  venues: [],
  dropped: 0,
  droppedDetails: [],
  ...over,
});

describe("claim(枠の試みの先行記録。Issue #480 で 1 日 1 回から 1 枠 1 回に)", () => {
  it("最初の 1 回だけ claimed。枠の行は試みの時刻だけを持つ(結果の列は NULL)。日の要約(baba_fetches)の行も、最初の試みの時刻で作る", async () => {
    const store = new D1BabaStore({ db: local.db });
    expect(await store.claim(DATE, 0, 1_000)).toBe("claimed");
    expect(await all("SELECT * FROM baba_fetch_attempts")).toEqual([
      { kaisai_date: DATE, slot: 0, attempted_at: 1_000, finished_at: null, result: null, api_fetched_at: null, venues_saved: null, venues_dropped: null, dropped_json: null, complete: null },
    ]);
    expect(await all("SELECT * FROM baba_fetches")).toEqual([
      { kaisai_date: DATE, attempted_at: 1_000, finished_at: null, result: null, api_fetched_at: null, venues_saved: null, venues_dropped: null, dropped_json: null },
    ]);
  });

  it("同じ枠の 2 回目以降は exists(行は最初のまま。試みの時刻を上書きしない)。次の枠は claimed で、日の要約の試みの時刻は最初のまま", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 0, 1_000);
    expect(await store.claim(DATE, 0, 2_000)).toBe("exists");
    expect(await store.claim(DATE, 0, 3_000)).toBe("exists");
    expect(await all("SELECT slot, attempted_at FROM baba_fetch_attempts")).toEqual([{ slot: 0, attempted_at: 1_000 }]);
    expect(await store.claim(DATE, 1, 4_000)).toBe("claimed");
    expect(await all("SELECT slot, attempted_at FROM baba_fetch_attempts ORDER BY slot")).toEqual([
      { slot: 0, attempted_at: 1_000 },
      { slot: 1, attempted_at: 4_000 },
    ]);
    expect(await all("SELECT attempted_at FROM baba_fetches")).toEqual([{ attempted_at: 1_000 }]);
  });

  it("結果が記録された後でも、同じ枠は exists(完了した枠の再 claim は通らない)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 0, 1_000);
    const p = parsed();
    await store.finish(DATE, fin({ finishedAt: 5_000, apiFetchedAt: p.apiFetchedAt, venues: p.venues, dropped: p.dropped, droppedDetails: p.droppedDetails }));
    expect(await store.claim(DATE, 0, 6_000)).toBe("exists");
  });

  it("並行して同じ枠を claim しても、claimed は 1 つだけ", async () => {
    const store = new D1BabaStore({ db: local.db });
    const results = await Promise.all([store.claim(DATE, 3, 1), store.claim(DATE, 3, 2), store.claim(DATE, 3, 3), store.claim(DATE, 3, 4)]);
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "exists")).toHaveLength(3);
    expect(await all("SELECT COUNT(*) AS n FROM baba_fetch_attempts")).toEqual([{ n: 1 }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_fetches")).toEqual([{ n: 1 }]);
  });

  it("開催日が違えば別の行(それぞれ claimed)", async () => {
    const store = new D1BabaStore({ db: local.db });
    expect(await store.claim("20261010", 0, 1)).toBe("claimed");
    expect(await store.claim("20261011", 0, 2)).toBe("claimed");
  });

  it("その日に complete = 1 の回があれば done(行は作らない)。ほかの日・complete = 0 の日には影響しない", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 0, 1_000);
    await store.finish(DATE, fin({ finishedAt: 2_000, complete: false }));
    expect(await store.claim(DATE, 1, 3_000)).toBe("claimed"); // complete = 0 の日は取り直せる
    await store.finish(DATE, fin({ slot: 1, finishedAt: 4_000, complete: true }));
    expect(await store.claim(DATE, 2, 5_000)).toBe("done");
    expect(await all("SELECT slot FROM baba_fetch_attempts ORDER BY slot")).toEqual([{ slot: 0 }, { slot: 1 }]); // done のときは枠の行を作らない
    expect(await store.claim("20261026", 0, 6_000)).toBe("claimed"); // 別の日は別
  });
});

describe("finish(結果の記録)", () => {
  it("成功: 枠の行に結果を書き、競馬場ごとに 1 行を保存する(見本の東京・京都・新潟)。日の要約も同じ結果に更新する", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 0, 1_000);
    const p = parsed();
    expect(p.venues).toHaveLength(3); // 前提: 保存する競馬場がある(空振りでない)
    await store.finish(DATE, fin({ complete: true, finishedAt: 9_000, apiFetchedAt: p.apiFetchedAt, venues: p.venues, dropped: p.dropped, droppedDetails: p.droppedDetails }));

    expect(await all("SELECT * FROM baba_fetch_attempts")).toEqual([
      {
        kaisai_date: DATE,
        slot: 0,
        attempted_at: 1_000,
        finished_at: 9_000,
        result: "ok",
        api_fetched_at: new Date(SAMPLE_NOW).toISOString(),
        venues_saved: 3,
        venues_dropped: 1,
        dropped_json: JSON.stringify(DROPPED),
        complete: 1,
      },
    ]);
    expect(await all("SELECT * FROM baba_fetches")).toEqual([
      { kaisai_date: DATE, attempted_at: 1_000, finished_at: 9_000, result: "ok", api_fetched_at: new Date(SAMPLE_NOW).toISOString(), venues_saved: 3, venues_dropped: 1, dropped_json: JSON.stringify(DROPPED) },
    ]);
    const rows = await all("SELECT * FROM baba_conditions ORDER BY venue_code");
    expect(rows.map((r) => [r["kaisai_date"], r["venue_code"], r["venue_name"]])).toEqual([
      [DATE, "04", "新潟"],
      [DATE, "05", "東京"],
      [DATE, "08", "京都"],
    ]);
    expect(rows[1]).toMatchObject({
      measured_at: "2026-10-25T07:00+09:00",
      cushion: 9.5,
      turf_condition: "稍重",
      turf_goal_condition: "稍重",
      turf_corner4_condition: "稍重",
      turf_goal_moisture: 17.5,
      turf_corner4_moisture: 16.9,
      dirt_condition: "稍重",
      dirt_goal_condition: "稍重",
      dirt_corner4_condition: "稍重",
      dirt_goal_moisture: 7.4,
      dirt_corner4_moisture: 7.9,
      rainfall_mm: null,
      used_course: "Aコース（内柵を最内に設置）",
      turf_length: "芝丈(cm) 芝野芝10から12・洋芝10から14 障害野芝10から12",
      turf_state_text: "向正面直線から正面直線にかけての内柵沿いに傷みが見られます。",
      saved_at: 9_000,
    });
    expect(JSON.parse(rows[1]!["raw_json"] as string)).toMatchObject({ venueCode: "05", cushion: { value: 9.5 }, sources: { cushion: "ok", moist: "ok", access: "ok", course: "ok" } });
    expect(rows[2]).toMatchObject({ measured_at: "2026-10-25T06:00+09:00", cushion: 9.2, turf_condition: "稍重", dirt_condition: "重", dirt_goal_moisture: 13.3 });
    expect(rows[0]).toMatchObject({ cushion: 8.8, turf_condition: "不良", dirt_condition: "不良", rainfall_mm: 2.5 });
  });

  it("失敗: 競馬場の行は作らず、分類だけを記録する(venues_saved = 0、complete = 0)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 0, 1_000);
    await store.finish(DATE, fin({ finishedAt: 2_000, result: "http-503" }));
    expect(await all("SELECT result, finished_at, api_fetched_at, venues_saved, venues_dropped, dropped_json, complete FROM baba_fetch_attempts")).toEqual([
      { result: "http-503", finished_at: 2_000, api_fetched_at: null, venues_saved: 0, venues_dropped: 0, dropped_json: "[]", complete: 0 },
    ]);
    expect(await all("SELECT result, finished_at, venues_saved FROM baba_fetches")).toEqual([{ result: "http-503", finished_at: 2_000, venues_saved: 0 }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_conditions")).toEqual([{ n: 0 }]);
  });

  it("原子的: 競馬場の行の 1 つが書けなければ、結果の更新(枠・日の要約)も他の競馬場の行も残らない(batch)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await store.claim(DATE, 0, 1_000);
    const p = parsed();
    const broken = { ...p.venues[1]!, venueName: null as unknown as string }; // NOT NULL の違反
    await expect(store.finish(DATE, fin({ finishedAt: 9_000, apiFetchedAt: p.apiFetchedAt, venues: [p.venues[0]!, broken] }))).rejects.toThrow();
    expect(await all("SELECT result, finished_at, complete FROM baba_fetch_attempts")).toEqual([{ result: null, finished_at: null, complete: null }]);
    expect(await all("SELECT result, finished_at FROM baba_fetches")).toEqual([{ result: null, finished_at: null }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_conditions")).toEqual([{ n: 0 }]);
  });

  it("日の要約: 取り直しで一度 ok になった日は、後の回が失敗しても ok のまま(venues_saved は日の合計)。先に失敗した日は、後の ok に更新される", async () => {
    const store = new D1BabaStore({ db: local.db });
    const p = parsed();
    // 枠 0 が失敗 → 枠 1 が ok(2 場)→ 枠 2 が失敗
    await store.claim(DATE, 0, 1_000);
    await store.finish(DATE, fin({ finishedAt: 1_100, result: "no-today-venues", dropped: 3 }));
    expect(await all("SELECT result, venues_saved, venues_dropped FROM baba_fetches")).toEqual([{ result: "no-today-venues", venues_saved: 0, venues_dropped: 3 }]); // 先に失敗した日は失敗の要約
    await store.claim(DATE, 1, 2_000);
    await store.finish(DATE, fin({ slot: 1, finishedAt: 2_100, apiFetchedAt: p.apiFetchedAt, venues: [p.venues[0]!, p.venues[1]!] }));
    expect(await all("SELECT result, venues_saved, api_fetched_at FROM baba_fetches")).toEqual([{ result: "ok", venues_saved: 2, api_fetched_at: p.apiFetchedAt }]);
    await store.claim(DATE, 2, 3_000);
    await store.finish(DATE, fin({ slot: 2, finishedAt: 3_100, result: "http-503", dropped: 1 }));
    expect(await all("SELECT result, venues_saved, api_fetched_at, finished_at FROM baba_fetches")).toEqual([{ result: "ok", venues_saved: 2, api_fetched_at: p.apiFetchedAt, finished_at: 2_100 }]); // ok の要約を失敗で上書きしない
    expect(await all("SELECT slot, result, venues_saved FROM baba_fetch_attempts ORDER BY slot")).toEqual([
      { slot: 0, result: "no-today-venues", venues_saved: 0 },
      { slot: 1, result: "ok", venues_saved: 2 },
      { slot: 2, result: "http-503", venues_saved: 0 },
    ]);
  });
});

describe("finish: 既に入っている行の補完(Issue #480。欠けを埋めるときだけ更新する)", () => {
  /** 東京(05)の完全な行(クッション値・含水率とも当日)。 */
  const full = (): BabaVenueRecord => sampleOutcome().venues.find((v) => v.venueCode === "05")!;
  /** 含水率だけの行(クッション値が無い)。計測日時は含水率の時刻。 */
  const moistOnly = (): BabaVenueRecord => ({ ...full(), cushion: null, measuredAt: "2026-10-25T05:30+09:00" });
  /** クッション値だけの行(含水率が無い)。 */
  const cushionOnly = (): BabaVenueRecord => {
    const v = full();
    return { ...v, turf: { ...v.turf, goalMoisture: null, corner4Moisture: null }, dirt: { ...v.dirt, goalMoisture: null, corner4Moisture: null } };
  };
  const row = async (): Promise<Record<string, unknown>> => (await all("SELECT * FROM baba_conditions WHERE kaisai_date = ? AND venue_code = '05'", DATE))[0]!;

  async function seed(store: D1BabaStore, venue: BabaVenueRecord): Promise<void> {
    await store.claim(DATE, 0, 1_000);
    await store.finish(DATE, fin({ finishedAt: 2_000, venues: [venue] }));
  }

  it("前提: 見本の行は完全(クッション値も含水率もある)。含水率だけ・クッション値だけの行は、それぞれ片方が欠けている", () => {
    expect(full().cushion).not.toBeNull();
    expect(full().turf.goalMoisture).not.toBeNull();
    expect(moistOnly().cushion).toBeNull();
    expect(cushionOnly().cushion).not.toBeNull();
    expect([cushionOnly().turf.goalMoisture, cushionOnly().turf.corner4Moisture, cushionOnly().dirt.goalMoisture, cushionOnly().dirt.corner4Moisture]).toEqual([null, null, null, null]);
  });

  it("含水率だけの行 → 後の回でクッション値が来たら埋める(クッション値と、その計測日時)。既に入っている値は上書きしない(公式の馬場状態が後の回で変わっても、そのまま)。枠の venues_saved は 1", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store, moistOnly());
    const before = await row();
    expect(before).toMatchObject({ cushion: null, measured_at: "2026-10-25T05:30+09:00", turf_condition: "稍重", turf_goal_moisture: 17.5 }); // 前提
    const later: BabaVenueRecord = { ...full(), turf: { ...full().turf, condition: "良", goalMoisture: 1.1 }, rainfallMm: 9.9, usedCourse: "Bコース" };
    await store.claim(DATE, 1, 3_000);
    await store.finish(DATE, fin({ slot: 1, finishedAt: 4_000, venues: [later] }));
    const after = await row();
    expect(after["cushion"]).toBe(9.5); // 欠けを埋めた
    expect(after["measured_at"]).toBe("2026-10-25T07:00+09:00"); // クッション値の計測日時
    expect(after["turf_condition"]).toBe("稍重"); // 既に入っている値は上書きしない(後の回の「良」を採らない)
    expect(after["turf_goal_moisture"]).toBe(17.5); // 同上(後の回の 1.1 を採らない)
    expect(after["used_course"]).toBe(before["used_course"]); // 同上(後の回の「Bコース」を採らない)
    expect(before["rainfall_mm"]).toBeNull(); // 前提: 既存が NULL の値は、後の回に値があれば埋まる(NULL は「入っている値」ではない)
    expect(after["rainfall_mm"]).toBe(9.9);
    expect(await all("SELECT venues_saved FROM baba_fetch_attempts WHERE slot = 1")).toEqual([{ venues_saved: 1 }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_conditions")).toEqual([{ n: 1 }]); // 行は増えない
  });

  it("クッション値だけの行 → 後の回で含水率が来たら埋める(含水率と、それに付く状態)。既に入っているクッション値は、後の回の値が違っても変えない", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store, cushionOnly());
    expect(await row()).toMatchObject({ cushion: 9.5, turf_goal_moisture: null, dirt_corner4_moisture: null }); // 前提
    const later: BabaVenueRecord = { ...full(), cushion: 3.3 };
    await store.claim(DATE, 1, 3_000);
    await store.finish(DATE, fin({ slot: 1, finishedAt: 4_000, venues: [later] }));
    expect(await row()).toMatchObject({ cushion: 9.5, turf_goal_moisture: 17.5, turf_corner4_moisture: 16.9, dirt_goal_moisture: 7.4, dirt_corner4_moisture: 7.9, measured_at: "2026-10-25T07:00+09:00" });
    expect(await all("SELECT venues_saved FROM baba_fetch_attempts WHERE slot = 1")).toEqual([{ venues_saved: 1 }]);
  });

  it("含水率を補うときは、計測日時を変えない: 前の読みはクッション値あり・含水率なし(計測 7:00)、後の読みは計測時刻が違う(9:30)で含水率を補っても measured_at は 7:00 のまま", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store, cushionOnly());
    expect((await row())["measured_at"]).toBe("2026-10-25T07:00+09:00"); // 前提
    const later: BabaVenueRecord = { ...full(), measuredAt: "2026-10-25T09:30+09:00" };
    expect(later.measuredAt).not.toBe(cushionOnly().measuredAt); // 前提: 後の読みの計測日時は違う
    await store.claim(DATE, 1, 3_000);
    await store.finish(DATE, fin({ slot: 1, finishedAt: 4_000, venues: [later] }));
    const after = await row();
    expect(after["turf_goal_moisture"]).toBe(17.5); // 前提: 含水率は補われた(更新は起きた)
    expect(after["measured_at"]).toBe("2026-10-25T07:00+09:00");
  });

  it("完全な行は触らない(後の回の値が違っても、saved_at も変えない)。枠の venues_saved は 0", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store, full());
    const before = await row();
    await store.claim(DATE, 1, 3_000);
    await store.finish(DATE, fin({ slot: 1, finishedAt: 4_000, venues: [{ ...full(), cushion: 1.1, rainfallMm: 5, usedCourse: "Cコース" }] }));
    expect(await row()).toEqual(before);
    expect(await all("SELECT venues_saved FROM baba_fetch_attempts WHERE slot = 1")).toEqual([{ venues_saved: 0 }]);
  });

  it("欠けたままの行に、同じ欠けの読みが来ても何も変わらない(埋めるものが無いので更新しない)。枠の venues_saved は 0", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store, moistOnly());
    const before = await row();
    await store.claim(DATE, 1, 3_000);
    await store.finish(DATE, fin({ slot: 1, finishedAt: 4_000, venues: [{ ...moistOnly(), rainfallMm: 7 }] }));
    expect(await row()).toEqual(before);
    expect(await all("SELECT venues_saved FROM baba_fetch_attempts WHERE slot = 1")).toEqual([{ venues_saved: 0 }]);
  });

  it("後の読みで値が欠けていても、既に入っている値は消さない(クッション値を埋める読みに含水率が無くても、既存の含水率は残る)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store, moistOnly());
    const laterCushionOnly = cushionOnly();
    await store.claim(DATE, 1, 3_000);
    await store.finish(DATE, fin({ slot: 1, finishedAt: 4_000, venues: [laterCushionOnly] }));
    expect(await row()).toMatchObject({ cushion: 9.5, turf_goal_moisture: 17.5, turf_corner4_moisture: 16.9, dirt_goal_moisture: 7.4, turf_condition: "稍重" });
  });
});

describe("loadFetches(管理者の診断用の読み出し。Issue #360)", () => {
  async function seed(store: D1BabaStore): Promise<void> {
    // 10/10: 値あり(見本の東京・京都・新潟を保存)、10/17: 全部捨てた(no-today-venues)、10/18: 試みたが結果が無い(クラッシュ相当)。10/11: 旧版の行(dropped_json が NULL)
    await store.claim("20261010", 0, 100);
    const p = parsed();
    await store.finish("20261010", fin({ complete: true, finishedAt: 200, apiFetchedAt: p.apiFetchedAt, venues: p.venues, dropped: p.dropped, droppedDetails: p.droppedDetails }));
    await local.db.prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at, finished_at, result, api_fetched_at, venues_saved, venues_dropped) VALUES ('20261011', 300, 310, 'no-today-venues', '2026-10-10T23:00:00.000Z', 0, 3)").run();
    await store.claim("20261017", 0, 400);
    await store.finish("20261017", fin({ finishedAt: 410, result: "no-today-venues", apiFetchedAt: "2026-10-16T23:00:00.000Z", dropped: 1, droppedDetails: [{ venue: "01", reason: "not-today", measured: "10月17日（土曜）7時00分" }] }));
    await store.claim("20261018", 0, 500);
  }

  it("日付の新しい順に返す。結果・件数・捨てた詳細・保存した競馬場を持つ(旧版の行の詳細は null、結果の無い行は結果 null)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store);
    const rows = await store.loadFetches({ limit: 14 });
    expect(rows.map((r) => r.kaisaiDate)).toEqual(["20261018", "20261017", "20261011", "20261010"]);
    expect(rows[0]).toEqual({
      kaisaiDate: "20261018",
      attemptedAt: 500,
      finishedAt: null,
      result: null,
      apiFetchedAt: null,
      venuesSaved: null,
      venuesDropped: null,
      dropped: null,
      saved: [],
      attempts: [{ slot: 0, attemptedAt: 500, finishedAt: null, result: null, apiFetchedAt: null, venuesSaved: null, venuesDropped: null, dropped: null, complete: null }],
    });
    expect(rows[1]).toEqual({
      kaisaiDate: "20261017",
      attemptedAt: 400,
      finishedAt: 410,
      result: "no-today-venues",
      apiFetchedAt: "2026-10-16T23:00:00.000Z",
      venuesSaved: 0,
      venuesDropped: 1,
      dropped: [{ venue: "01", reason: "not-today", measured: "10月17日（土曜）7時00分" }],
      saved: [],
      attempts: [
        {
          slot: 0,
          attemptedAt: 400,
          finishedAt: 410,
          result: "no-today-venues",
          apiFetchedAt: "2026-10-16T23:00:00.000Z",
          venuesSaved: 0,
          venuesDropped: 1,
          dropped: [{ venue: "01", reason: "not-today", measured: "10月17日（土曜）7時00分" }],
          complete: false,
        },
      ],
    });
    expect(rows[2]!.dropped).toBeNull(); // 旧版の行
    expect(rows[2]!.venuesDropped).toBe(3);
    expect(rows[2]!.attempts).toEqual([]); // 旧版(1 日 1 回)の行には枠の記録が無い
    expect(rows[3]!.saved).toEqual([
      { venueCode: "04", venueName: "新潟", measuredAt: "2026-10-25T07:00+09:00" },
      { venueCode: "05", venueName: "東京", measuredAt: "2026-10-25T07:00+09:00" },
      { venueCode: "08", venueName: "京都", measuredAt: "2026-10-25T06:00+09:00" },
    ]);
    expect(rows[3]!.dropped).toEqual(DROPPED);
    expect(rows[3]!.attempts).toEqual([
      { slot: 0, attemptedAt: 100, finishedAt: 200, result: "ok", apiFetchedAt: new Date(SAMPLE_NOW).toISOString(), venuesSaved: 3, venuesDropped: 1, dropped: DROPPED, complete: true },
    ]);
  });

  it("枠の記録(attempts)は日ごとに枠の順で返す。別の日の枠は混ざらない。件数の上限で切った日の枠は返さない", async () => {
    const store = new D1BabaStore({ db: local.db });
    for (const slot of [2, 0, 1]) {
      await store.claim("20261024", slot, 1_000 + slot);
      await store.finish("20261024", fin({ slot, finishedAt: 2_000 + slot, result: slot === 2 ? "ok" : "no-today-venues" }));
    }
    await store.claim("20261025", 0, 5_000);
    const rows = await store.loadFetches({ limit: 14 });
    expect(rows.map((r) => [r.kaisaiDate, r.attempts.map((a) => a.slot)])).toEqual([
      ["20261025", [0]],
      ["20261024", [0, 1, 2]],
    ]);
    expect(rows[1]!.attempts.map((a) => a.result)).toEqual(["no-today-venues", "no-today-venues", "ok"]);
    const limited = await store.loadFetches({ limit: 1 });
    expect(limited.map((r) => r.kaisaiDate)).toEqual(["20261025"]);
    expect(limited[0]!.attempts.map((a) => a.slot)).toEqual([0]);
    const one = await store.loadFetches({ kaisaiDate: "20261024", limit: 14 });
    expect(one[0]!.attempts).toHaveLength(3);
  });

  it("開催日を指定すると、その日の 1 行だけ(無ければ空)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store);
    expect((await store.loadFetches({ kaisaiDate: "20261017", limit: 14 })).map((r) => r.kaisaiDate)).toEqual(["20261017"]);
    expect(await store.loadFetches({ kaisaiDate: "20250101", limit: 14 })).toEqual([]);
  });

  it("件数の上限で新しいほうから切る。saved は返した日の分だけ", async () => {
    const store = new D1BabaStore({ db: local.db });
    await seed(store);
    const rows = await store.loadFetches({ limit: 2 });
    expect(rows.map((r) => r.kaisaiDate)).toEqual(["20261018", "20261017"]);
    expect(rows.flatMap((r) => r.saved)).toEqual([]); // 10/10 の保存分は含めない
    expect(FETCH_LIST_LIMIT_DEFAULT).toBe(14);
  });

  it("dropped_json の場コードの文字列は 4 字に切って返す(D1 に直接入れた長い値でも、そのまま返さない。Issue #373)", async () => {
    const store = new D1BabaStore({ db: local.db });
    await local.db
      .prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at, finished_at, result, venues_saved, venues_dropped, dropped_json) VALUES ('20261003', 1, 2, 'no-today-venues', 0, 1, ?)")
      .bind(JSON.stringify([{ venue: "ABCDEFGH", reason: "invalid", measured: null }]))
      .run();
    const rows = await store.loadFetches({ limit: 14 });
    const row = rows.find((r) => r.kaisaiDate === "20261003");
    expect(row).toBeDefined();
    expect(row!.dropped).toEqual([{ venue: "ABCD", reason: "invalid", measured: null }]);
  });

  it("dropped_json が壊れている・想定外の形でも落とさず、読める要素だけ(想定外の理由の語は捨てる)。文字列は長さを切る", async () => {
    const store = new D1BabaStore({ db: local.db });
    await local.db.prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at, finished_at, result, venues_saved, venues_dropped, dropped_json) VALUES ('20261001', 1, 2, 'no-today-venues', 0, 2, ?)").bind("{壊れた").run();
    await local.db
      .prepare("INSERT INTO baba_fetches (kaisai_date, attempted_at, finished_at, result, venues_saved, venues_dropped, dropped_json) VALUES ('20261002', 1, 2, 'no-today-venues', 0, 3, ?)")
      .bind(JSON.stringify([{ venue: "05", reason: "unparsed", measured: "あ".repeat(100) }, { venue: "05", reason: "任意の語", measured: "x" }, "文字列", null]))
      .run();
    const rows = await store.loadFetches({ limit: 14 });
    expect(rows.map((r) => [r.kaisaiDate, r.dropped === null ? null : r.dropped.length])).toEqual([["20261002", 1], ["20261001", null]]);
    expect(rows[0]!.dropped![0]!.measured).toHaveLength(40);
  });
});
