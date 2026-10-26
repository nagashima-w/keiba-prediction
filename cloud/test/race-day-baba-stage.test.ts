import { afterEach, describe, expect, it } from "vitest";

import { BabaFetchError, type BabaFetchOutcome, type BabaResultClass, type BabaVenueRecord } from "../src/baba-conditions";
import {
  BABA_FETCH_INTERVAL_MIN,
  BABA_FETCH_LAST_JST,
  BABA_FETCH_SLOTS,
  BABA_FETCH_START_JST,
  BABA_META_ATTEMPTED,
  BABA_META_CLAIM_TRIES,
  BABA_META_COMPLETE,
  BABA_META_DONE,
  BABA_META_RESULT,
  BABA_META_RETRY_AT,
  BABA_META_SLOT,
  BabaStage,
  type BabaFacts,
  type BabaFetcher,
  type BabaFinish,
  type BabaStore,
} from "../src/race-day-baba";
import { openNodeSql, type NodeSql } from "./node-sql";
import { installFetchTrap } from "./fetch-trap";
import { SAMPLE_DATE, sampleOutcome } from "./baba-sample";

/**
 * Issue #294: 馬場の取得ステップ(`BabaStage`)の単体。いつ動けるか(枠と条件)・「試みた」を先に永続化して 1 枠 1 回に収めること・失敗の扱い。
 * Issue #478 で取得先を JRA のページに替えた(取得口は読み取り済みの結果 `BabaFetchOutcome` を返す)。
 * Issue #480 で「1 日 1 回」を「1 枠(09:00 から 15 分おき、12:00 まで)につき 1 回」に広げた(当日の値がそろうまで取り直す)。
 * 保存先(D1)・取得口は偽。**実際の JRA には一切アクセスしない**。ストレージは `node:sqlite`(本物の SQLite)。
 * 使う URL・ホストは登場しない(取得口は関数で、URL はその外にある)。
 */

installFetchTrap();

const DATE = SAMPLE_DATE;
const jst = (s: string): number => Date.parse(`${s}+09:00`);
const at = (hhmmss: string): number => jst(`2026-10-25T${hhmmss}`);
const AT_0900 = at("09:00:00");
const MIN = 60_000;
/** 枠 k の時刻(09:00 + 15 分 × k)。 */
const slotAt = (k: number): number => AT_0900 + k * 15 * MIN;
/** 取得口が失敗の分類だけを返した結果(保存する場は無い)。 */
const failureOutcome = (result: BabaResultClass, dropped = 0): BabaFetchOutcome => ({ result, venues: [], dropped, droppedDetails: [], apiFetchedAt: null, listedVenueCodes: [] });

/** 見本(東京05・京都08・新潟04)のうち、指定の場だけを返した結果。`cushionLess` の場はクッション値を欠かす(含水率だけ・「そろっていない」行)。 */
function partial(codes: readonly string[], cushionLess: readonly string[] = []): BabaFetchOutcome {
  const base = sampleOutcome();
  const venues: BabaVenueRecord[] = base.venues.filter((v) => codes.includes(v.venueCode)).map((v) => (cushionLess.includes(v.venueCode) ? { ...v, cushion: null } : v));
  return { ...base, venues };
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

interface FakeStore extends BabaStore {
  readonly claims: { date: string; slot: number; at: number }[];
  readonly claimed: Set<string>;
  readonly finishes: { date: string; finish: BabaFinish }[];
  /** `complete: true` で finish された日(D1 の「この日 complete = 1 の回がある」)。 */
  readonly doneDates: Set<string>;
  /** 先頭から 1 回ずつ消費する claim の失敗。 */
  claimFailures: number;
  finishFails: boolean;
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    claims: [],
    claimed: new Set(),
    finishes: [],
    doneDates: new Set(),
    claimFailures: 0,
    finishFails: false,
    async claim(date, slot, attemptedAt) {
      await Promise.resolve();
      store.claims.push({ date, slot, at: attemptedAt });
      if (store.claimFailures > 0) {
        store.claimFailures -= 1;
        throw new Error("D1 が応答しません https://d1.test.invalid/secret");
      }
      if (store.doneDates.has(date)) return "done";
      if (store.claimed.has(`${date}:${slot}`)) return "exists";
      store.claimed.add(`${date}:${slot}`);
      return "claimed";
    },
    async finish(date, finish) {
      await Promise.resolve();
      if (store.finishFails) throw new Error("D1 の保存に失敗 https://d1.test.invalid/secret");
      store.finishes.push({ date, finish });
      if (finish.complete) store.doneDates.add(date);
    },
  };
  return store;
}

interface Harness {
  readonly stage: BabaStage;
  readonly sql: NodeSql;
  readonly store: FakeStore;
  readonly clock: { now: number };
  readonly facts: { -readonly [K in keyof BabaFacts]: BabaFacts[K] };
  readonly warns: string[];
  readonly fetchCalls: { n: number };
  /** 取得口の挙動(省略時は見本を返す)。 */
  behavior: { respond: () => Promise<BabaFetchOutcome> | BabaFetchOutcome };
  /** 取得口が呼ばれた瞬間の、永続化の状態(「試みた」が先か)。 */
  readonly atFetch: { claimRowExists: boolean; metaAttempted: string | null; metaSlot: string | null }[];
}

/** 計画の場コード(中央の行から出す。見本の東京・京都・新潟)。 */
const GOOD_FACTS: BabaFacts = { kaisaiDate: DATE, planFinalized: true, centralListed: true, venueCodes: ["05", "08", "04"] };

function harness(options: { facts?: Partial<BabaFacts>; sql?: NodeSql; store?: FakeStore; noFetcher?: boolean; noStore?: boolean; now?: number } = {}): Harness {
  const sql = options.sql ?? openNodeSql();
  if (options.sql === undefined) {
    opened.push(sql);
  }
  sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store = options.store ?? fakeStore();
  const clock = { now: options.now ?? AT_0900 };
  const facts = { ...GOOD_FACTS, ...options.facts };
  const warns: string[] = [];
  const fetchCalls = { n: 0 };
  const atFetch: Harness["atFetch"] = [];
  const h = { behavior: { respond: (): Promise<BabaFetchOutcome> | BabaFetchOutcome => sampleOutcome() } } as Pick<Harness, "behavior">;
  const metaOf = (key: string): string | null => (sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[])[0]?.value ?? null;
  const fetcher: BabaFetcher = async () => {
    fetchCalls.n += 1;
    atFetch.push({
      claimRowExists: [...store.claimed].some((k) => k.startsWith(`${DATE}:`)),
      metaAttempted: metaOf(BABA_META_ATTEMPTED),
      metaSlot: metaOf(BABA_META_SLOT),
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
    retryDelayMs: MIN,
    maxClaimAttempts: 3,
  });
  return { stage, sql, store, clock, facts, warns, fetchCalls, behavior: h.behavior, atFetch };
}

const meta = (h: Pick<Harness, "sql">, key: string): string | null =>
  (h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[])[0]?.value ?? null;
const setMeta = (h: Pick<Harness, "sql">, key: string, value: string): void => {
  h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
};

describe("枠の定数(置き値。10/31 の実測の後に見直す。定数 1 か所で変えられる)", () => {
  it("09:00 から 15 分おき、12:00 まで(9:00・9:15・…・12:00 の 13 枠)", () => {
    expect(BABA_FETCH_START_JST).toBe("09:00");
    expect(BABA_FETCH_INTERVAL_MIN).toBe(15);
    expect(BABA_FETCH_LAST_JST).toBe("12:00");
    expect(BABA_FETCH_SLOTS).toBe(13);
  });
});

describe("期限(dueAtMs): 次の枠の時刻(最初の発走前の分析の期限には左右されない)", () => {
  // 取得は 09:00 から。値が載る前の枠は空振りに終わるだけ(2 本で止まる)ので、載るまで 15 分おきに取り直す。
  it("開催日が確定していれば、どの時刻から数えても最初の期限は 09:00(前夜の計画の段階から候補になる)", () => {
    for (const now of [jst("2026-10-24T21:30:00"), at("06:00:00"), at("08:59:59"), AT_0900]) {
      const h = harness({ now });
      expect(h.stage.dueAtMs()).toBe(AT_0900);
    }
  });

  it("最後に試みた枠 k の次の枠(k+1)の時刻が期限になる(全 13 枠。最後の枠 12 の後は null)", () => {
    for (let k = 0; k < BABA_FETCH_SLOTS; k++) {
      const h = harness({ now: slotAt(k) });
      setMeta(h, BABA_META_SLOT, String(k));
      expect(h.stage.dueAtMs()).toBe(k + 1 < BABA_FETCH_SLOTS ? slotAt(k + 1) : null);
    }
    expect(slotAt(BABA_FETCH_SLOTS - 1)).toBe(at("12:00:00")); // 前提: 枠 12 は 12:00(置き値の整合)
  });

  it("BabaFacts は最初の発走前の分析の期限を持たない(期限の式から外した)。計画の場コードを持つ", () => {
    expect(Object.keys(GOOD_FACTS).sort()).toEqual(["centralListed", "kaisaiDate", "planFinalized", "venueCodes"]);
  });

  const none: { name: string; options: Parameters<typeof harness>[0] }[] = [
    { name: "計画が確定していない", options: { facts: { planFinalized: false } } },
    { name: "中央の一覧が無い(地方だけの日・一覧の取得に失敗した日)", options: { facts: { centralListed: false } } },
    { name: "開催日が未確定", options: { facts: { kaisaiDate: null } } },
    { name: "取得口が無い(本番は常に渡す。無ければ機能全体が止まる)", options: { noFetcher: true } },
    { name: "保存先が無い", options: { noStore: true } },
    { name: "開催日が過去(今日 JST が開催日より後)", options: { now: jst("2026-10-26T00:00:00") } },
  ];
  for (const c of none) {
    it(`${c.name} → null(アラームの候補にならない)`, () => {
      const h = harness({ now: AT_0900, ...c.options });
      expect(h.stage.dueAtMs()).toBeNull();
      expect(h.stage.runnable()).toBe(false);
    });
  }

  it("その日の値がそろった印(DONE)があれば null(以後の枠は動かない・候補にならない)", () => {
    const h = harness({ now: at("09:20:00") });
    expect(h.stage.dueAtMs()).not.toBeNull(); // 前提: 印が無ければ候補はある
    setMeta(h, BABA_META_DONE, "1");
    expect(h.stage.dueAtMs()).toBeNull();
    expect(h.stage.runnable()).toBe(false);
  });

  it("最後の枠の窓(12:00 以上 12:15 未満)を過ぎたら、未実行の枠があっても null。窓の内側は候補のまま", () => {
    const inside = harness({ now: at("12:14:59") });
    expect(inside.stage.dueAtMs()).not.toBeNull();
    expect(inside.stage.runnable()).toBe(true);
    const outside = harness({ now: at("12:15:00") });
    expect(outside.stage.dueAtMs()).toBeNull();
    expect(outside.stage.runnable()).toBe(false);
  });

  it("claim の再試行待ちがあれば、期限と再試行の時刻の遅いほう", () => {
    const h = harness();
    setMeta(h, BABA_META_RETRY_AT, String(AT_0900 + MIN));
    expect(h.stage.dueAtMs()).toBe(AT_0900 + MIN);
  });

  it("取得口が無いとき、何度確かめても印を書かない(取得口が付いた同じ日に取得できる)", () => {
    const h = harness({ noFetcher: true });
    expect(h.stage.runnable()).toBe(false);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull();
    expect(meta(h, BABA_META_SLOT)).toBeNull();
  });
});

describe("動ける時刻(runnable)", () => {
  it("09:00 の 1ms 前は動けず、09:00 ちょうどから動ける", () => {
    const h = harness({ now: AT_0900 - 1 });
    expect(h.stage.runnable()).toBe(false);
    h.clock.now = AT_0900;
    expect(h.stage.runnable()).toBe(true);
  });

  it("前夜(21:00 の計画の直後)は、期限が翌朝でも動けない", () => {
    const h = harness({ now: jst("2026-10-24T21:30:00") });
    expect(h.stage.dueAtMs()).toBe(AT_0900); // 前提: 候補(アラーム)にはなる
    expect(h.stage.runnable()).toBe(false);
  });

  it("開催日の当日の昼前でも、まだ試みていなければ動ける(同日の遅い計画・取り残し)。12:15 以降は動けない", () => {
    expect(harness({ now: at("11:50:00") }).stage.runnable()).toBe(true);
    expect(harness({ now: at("17:05:00") }).stage.runnable()).toBe(false);
  });

  it("次の枠の時刻まで動けない(試みた直後は、同じ枠の中では動けない)", async () => {
    const h = harness();
    h.behavior.respond = () => failureOutcome("no-today-venues", 3);
    await h.stage.run();
    h.clock.now = slotAt(1) - 1;
    expect(h.stage.runnable()).toBe(false);
    h.clock.now = slotAt(1);
    expect(h.stage.runnable()).toBe(true);
  });
});

describe("run: 試みを先に永続化して、1 枠に 1 回だけ取得する", () => {
  it("成功(3 場ともそろう): claim(枠 0)→ 印を書く → 取得 → 保存。取得口が呼ばれた瞬間に、claim の行も DO の印(枠 0)もある。そろったので以後は動かない", async () => {
    const h = harness();
    const outcome = await h.stage.run();
    expect(outcome).toEqual({ kind: "ran", raceId: DATE, mode: "baba", step: "fetch", result: "ok" });
    expect(h.fetchCalls.n).toBe(1);
    expect(h.atFetch).toEqual([{ claimRowExists: true, metaAttempted: String(AT_0900), metaSlot: "0" }]);
    expect(h.store.claims).toEqual([{ date: DATE, slot: 0, at: AT_0900 }]);
    expect(h.store.finishes).toHaveLength(1);
    const finish = h.store.finishes[0]!.finish;
    expect(finish.slot).toBe(0);
    expect(finish.complete).toBe(true);
    expect(finish.result).toBe("ok");
    expect(finish.venues.map((v: BabaVenueRecord) => v.venueCode)).toEqual(["05", "08", "04"]); // 東京・京都・新潟(取得口が返した順のまま保存先に渡す)
    expect(finish.apiFetchedAt).toBe(sampleOutcome().apiFetchedAt);
    expect(finish.dropped).toBe(0);
    expect(finish.droppedDetails).toEqual([]);
    expect(finish.finishedAt).toBe(AT_0900);
    expect(meta(h, BABA_META_ATTEMPTED)).toBe(String(AT_0900));
    expect(meta(h, BABA_META_SLOT)).toBe("0");
    expect(meta(h, BABA_META_RESULT)).toBe("ok");
    expect(meta(h, BABA_META_DONE)).toBe("1");
    expect(h.warns).toEqual([]);
    // 動けなくなる(再度の実行・アラームの候補にならない)
    h.clock.now = slotAt(1);
    expect(h.stage.runnable()).toBe(false);
    expect(h.stage.dueAtMs()).toBeNull();
  });

  // 結果が何であっても、同じ枠では 2 回目を送らない(M2・M3)。次の枠は別(取り直し)。
  const outcomes: { name: string; result: BabaResultClass; setup: (h: Harness) => void; stepResult: "ok" | "failed"; saves: boolean }[] = [
    { name: "成功", result: "ok", setup: () => undefined, stepResult: "ok", saves: true },
    { name: "HTTP 500(取得口が投げた失敗)", result: "http-500", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("http-500"))), stepResult: "failed", saves: true },
    { name: "タイムアウト(取得口が投げた失敗)", result: "timeout", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("timeout"))), stepResult: "failed", saves: true },
    { name: "通信の失敗(取得口が投げた失敗)", result: "network", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("network"))), stepResult: "failed", saves: true },
    { name: "リダイレクト(取得口が投げた失敗)", result: "redirect", setup: (h) => (h.behavior.respond = () => Promise.reject(new BabaFetchError("redirect"))), stepResult: "failed", saves: true },
    { name: "HTTP 503(取得口が結果として返した失敗)", result: "http-503", setup: (h) => (h.behavior.respond = () => failureOutcome("http-503")), stepResult: "failed", saves: true },
    { name: "形の不一致(取得口が結果として返した失敗)", result: "shape-mismatch", setup: (h) => (h.behavior.respond = () => failureOutcome("shape-mismatch")), stepResult: "failed", saves: true },
    { name: "当日の競馬場が無い", result: "no-today-venues", setup: (h) => (h.behavior.respond = () => failureOutcome("no-today-venues", 3)), stepResult: "failed", saves: true },
    { name: "想定外の例外(BabaFetchError でない)", result: "other", setup: (h) => (h.behavior.respond = () => Promise.reject(new TypeError("想定外 https://secret.test.invalid/x"))), stepResult: "failed", saves: true },
    { name: "D1 への結果の保存の失敗", result: "ok", setup: (h) => (h.store.finishFails = true), stepResult: "failed", saves: false },
  ];
  for (const c of outcomes) {
    it(`${c.name}: 同じ枠の取得は 1 回だけ。同じ stage・新しい stage(DO の再起動)・並行の run のどれでも、同じ枠の 2 回目を送らない`, async () => {
      const h = harness();
      c.setup(h);
      const first = await h.stage.run();
      expect(first.result).toBe(c.stepResult);
      expect(h.fetchCalls.n).toBe(1);
      if (c.saves) {
        expect(h.store.finishes[0]?.finish.result).toBe(c.result);
      }
      // 同じ枠の間は動けない(枠の中の別の時刻でも)
      h.clock.now = AT_0900 + 14 * MIN;
      expect(h.stage.runnable()).toBe(false);
      // 再起動: 同じ SQLite(DO の永続)・同じ保存先で新しい stage
      const restarted = harness({ sql: h.sql, store: h.store, now: AT_0900 + 14 * MIN });
      restarted.behavior.respond = () => {
        throw new Error("同じ枠の 2 回目の取得が送られた");
      };
      expect(restarted.stage.runnable()).toBe(false);
      expect(restarted.fetchCalls.n).toBe(0);
      expect(h.fetchCalls.n).toBe(1);
    });
  }

  it("印(枠)が消えていても(claim の後・印を書く前のクラッシュ)、D1 の claim が exists なので取得しない。印は書き直し、以後は D1 を引かない", async () => {
    const h = harness();
    h.behavior.respond = () => failureOutcome("no-today-venues", 3); // そろわない回(次の枠が残る)
    await h.stage.run();
    expect(h.fetchCalls.n).toBe(1);
    h.sql.exec("DELETE FROM race_day_meta WHERE key IN (?, ?)", BABA_META_ATTEMPTED, BABA_META_SLOT); // DO の印だけが無い状態
    const restarted = harness({ sql: h.sql, store: h.store });
    expect(restarted.stage.runnable()).toBe(true); // DO の印が無いので動ける
    const outcome = await restarted.stage.run();
    expect(outcome.result).toBe("failed");
    expect(restarted.fetchCalls.n).toBe(0); // 取得口は呼ばれない
    expect(meta(restarted, BABA_META_SLOT)).toBe("0"); // 印は書き直した
    expect(restarted.stage.runnable()).toBe(false);
    const claimCountAfter = h.store.claims.length;
    expect(claimCountAfter).toBe(2); // 最初の claim と、印が消えた後の 1 回だけ
    await restarted.stage.run().catch(() => undefined);
    expect(h.store.claims.length).toBe(claimCountAfter); // 同じ枠では D1 を引かない
  });

  it("DO の SQLite が消えて(新しい SQLite)D1 の claim だけが残っていても、同じ枠は取得しない。D1 に complete の回があれば以後の枠も取得しない", async () => {
    const first = harness();
    first.behavior.respond = () => failureOutcome("no-today-venues", 3);
    await first.stage.run();
    const fresh = harness({ store: first.store }); // 新しい SQLite・同じ保存先(枠 0 は D1 に claim 済み)
    expect(fresh.stage.runnable()).toBe(true);
    await fresh.stage.run();
    expect(fresh.fetchCalls.n).toBe(0);
    expect(first.fetchCalls.n).toBe(1);

    const complete = harness();
    await complete.stage.run(); // 3 場そろう → D1 の complete
    expect(complete.store.doneDates.has(DATE)).toBe(true);
    const lost = harness({ store: complete.store, now: slotAt(3) }); // DO の SQLite が消えた(印なし)
    expect(lost.stage.runnable()).toBe(true);
    const outcome = await lost.stage.run();
    expect(lost.fetchCalls.n).toBe(0); // 取得しない
    expect(outcome.result).toBe("ok");
    expect(meta(lost, BABA_META_DONE)).toBe("1"); // 完了の印を書き直した
    expect(lost.stage.dueAtMs()).toBeNull();
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

  it("クラッシュの模擬: 取得口が戻らないまま stage を捨てても、新しい stage は同じ枠を取得しない(印は取得の前に書かれている)。次の枠は動ける", async () => {
    const h = harness();
    h.behavior.respond = () => new Promise<BabaFetchOutcome>(() => undefined); // 応答が返らない
    void h.stage.run();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(h.fetchCalls.n).toBe(1);
    expect(meta(h, BABA_META_ATTEMPTED)).toBe(String(AT_0900));
    expect(meta(h, BABA_META_SLOT)).toBe("0");
    const restarted = harness({ sql: h.sql, store: h.store });
    expect(restarted.stage.runnable()).toBe(false);
    expect(restarted.fetchCalls.n).toBe(0);
    restarted.clock.now = slotAt(1);
    expect(restarted.stage.runnable()).toBe(true); // 次の枠は取り直せる
  });
});

describe("取り直し: そろうまで次の枠で取り直す(Issue #480)", () => {
  it("そろわない回(当日の値が無い)→ 次の枠(09:15)で取り直し → そろえば終わり。claim は枠ごと(0 → 1)", async () => {
    const h = harness();
    h.behavior.respond = () => failureOutcome("no-today-venues", 3);
    expect((await h.stage.run()).result).toBe("failed");
    expect(meta(h, BABA_META_DONE)).toBeNull();
    expect(h.stage.dueAtMs()).toBe(slotAt(1)); // 次の枠が候補
    h.clock.now = slotAt(1);
    h.behavior.respond = () => sampleOutcome();
    expect((await h.stage.run()).result).toBe("ok");
    expect(h.store.claims.map((c) => c.slot)).toEqual([0, 1]);
    expect(h.store.finishes.map((f) => [f.finish.slot, f.finish.complete])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(h.fetchCalls.n).toBe(2);
    expect(meta(h, BABA_META_DONE)).toBe("1");
    expect(h.stage.dueAtMs()).toBeNull();
    h.clock.now = slotAt(2);
    expect(h.stage.runnable()).toBe(false);
  });

  it("最後の枠(12:00)まで 13 回そろわなければ、取得は 13 回で打ち切り。以後は候補にならない", async () => {
    const h = harness();
    h.behavior.respond = () => failureOutcome("no-today-venues", 3);
    for (let k = 0; k < BABA_FETCH_SLOTS; k++) {
      h.clock.now = slotAt(k);
      expect(h.stage.runnable()).toBe(true);
      await h.stage.run();
    }
    expect(h.fetchCalls.n).toBe(BABA_FETCH_SLOTS);
    expect(h.store.claims.map((c) => c.slot)).toEqual(Array.from({ length: BABA_FETCH_SLOTS }, (_, k) => k));
    expect(h.stage.dueAtMs()).toBeNull();
    h.clock.now = at("12:05:00");
    expect(h.stage.runnable()).toBe(false);
    h.clock.now = at("13:00:00");
    expect(h.stage.runnable()).toBe(false);
    expect(h.fetchCalls.n).toBe(BABA_FETCH_SLOTS);
  });

  it("遅れて起きたら、いまの時刻の枠を 1 回だけ(飛ばした枠は埋めない)。10:07 に起きる → 枠 4(10:00)。次の期限は枠 5(10:15)", async () => {
    const h = harness();
    h.behavior.respond = () => failureOutcome("no-today-venues", 3);
    await h.stage.run(); // 枠 0
    h.clock.now = at("10:07:00");
    expect(h.stage.runnable()).toBe(true);
    await h.stage.run();
    expect(h.store.claims.map((c) => c.slot)).toEqual([0, 4]); // 枠 1〜3 は埋めない
    expect(meta(h, BABA_META_SLOT)).toBe("4");
    expect(h.stage.dueAtMs()).toBe(slotAt(5));
    expect(slotAt(5)).toBe(at("10:15:00"));
    expect(h.stage.runnable()).toBe(false); // 10:07 のうちはもう動かない
  });

  it("計画の確定が遅い日: まだ試みていない 11:47 に動ける → 枠 11(11:45)。最後の枠の窓(12:00〜12:15)は枠 12", async () => {
    const late = harness({ now: at("11:47:00") });
    await late.stage.run();
    expect(late.store.claims.map((c) => c.slot)).toEqual([11]);
    const last = harness({ now: at("12:14:59") });
    await last.stage.run();
    expect(last.store.claims.map((c) => c.slot)).toEqual([12]);
    expect(last.stage.dueAtMs()).toBeNull(); // 最後の枠の後は候補が無い
  });

  describe("「そろった」の分母と判定(計画の場コードを主、無ければページに載っている場)", () => {
    it("計画に場があるのにページ(取得口の結果)に出ない間は、そろわない(分母は計画の場)。出れば終わり", async () => {
      const h = harness({ facts: { venueCodes: ["05", "08", "04", "03"] } }); // 03(小倉)は計画にあるが、取得口の結果に出ない
      await h.stage.run();
      expect(h.store.finishes[0]!.finish.venues).toHaveLength(3); // 前提: 3 場はそろっている(空振りでない)
      expect(h.store.finishes[0]!.finish.complete).toBe(false);
      expect(meta(h, BABA_META_DONE)).toBeNull();
      expect(h.stage.dueAtMs()).toBe(slotAt(1));
      h.clock.now = slotAt(1);
      h.behavior.respond = () => ({ ...sampleOutcome(), venues: [...sampleOutcome().venues, { ...sampleOutcome().venues[0]!, venueCode: "03", venueName: "小倉" }] });
      await h.stage.run();
      expect(h.store.finishes[1]!.finish.complete).toBe(true);
      expect(meta(h, BABA_META_DONE)).toBe("1");
    });

    it("計画の場コードが空なら、ページに載っている場(listedVenueCodes)が分母。載っているのに当日の値が無い場があれば、そろわない", async () => {
      const h = harness({ facts: { venueCodes: [] } });
      h.behavior.respond = () => ({ ...partial(["05", "08"]), listedVenueCodes: ["05", "08", "04"] }); // 新潟はページに載っているが当日の値が無い
      await h.stage.run();
      expect(h.store.finishes[0]!.finish.venues.map((v) => v.venueCode)).toEqual(["05", "08"]);
      expect(h.store.finishes[0]!.finish.complete).toBe(false);
      h.clock.now = slotAt(1);
      h.behavior.respond = () => ({ ...sampleOutcome(), listedVenueCodes: ["05", "08", "04"] });
      await h.stage.run();
      expect(h.store.finishes[1]!.finish.complete).toBe(true);
    });

    it("分母が空(計画にも載っている場にも場が無い)なら、そろったとは判定しない(12:00 の枠まで取り直す)", async () => {
      const h = harness({ facts: { venueCodes: [] } });
      h.behavior.respond = () => ({ ...sampleOutcome(), listedVenueCodes: [] });
      await h.stage.run();
      expect(h.store.finishes[0]!.finish.venues).toHaveLength(3); // 前提: 保存した場はある
      expect(h.store.finishes[0]!.finish.complete).toBe(false);
      expect(meta(h, BABA_META_DONE)).toBeNull();
    });

    it("クッション値か含水率の片方だけの場は「そろった」に数えない(先に保存はする)。後の回で欠けが埋まればそろう", async () => {
      const h = harness();
      h.behavior.respond = () => partial(["05", "08", "04"], ["08"]); // 京都はクッション値が無い
      await h.stage.run();
      expect(h.store.finishes[0]!.finish.venues).toHaveLength(3); // 3 場とも保存に渡す(片方だけの行も先に保存する)
      expect(h.store.finishes[0]!.finish.complete).toBe(false);
      expect(meta(h, BABA_META_COMPLETE)).toBe(JSON.stringify(["05", "04"]));
      h.clock.now = slotAt(1);
      h.behavior.respond = () => sampleOutcome();
      await h.stage.run();
      expect(h.store.finishes[1]!.finish.complete).toBe(true);
      expect(meta(h, BABA_META_DONE)).toBe("1");
    });

    it("そろった場は回をまたいで覚える(1 回目に 05 だけ、2 回目に 08・04 だけ返っても、合わせて全部そろえば終わり)", async () => {
      const h = harness();
      h.behavior.respond = () => partial(["05"]);
      await h.stage.run();
      expect(h.store.finishes[0]!.finish.complete).toBe(false);
      h.clock.now = slotAt(1);
      h.behavior.respond = () => partial(["08", "04"]);
      await h.stage.run();
      expect(h.store.finishes[1]!.finish.complete).toBe(true);
      expect(meta(h, BABA_META_DONE)).toBe("1");
    });

    it("保存に失敗した回の場は、そろったと覚えない(D1 に入っていないので次の枠で取り直す)", async () => {
      const h = harness();
      h.store.finishFails = true;
      expect((await h.stage.run()).result).toBe("failed");
      expect(meta(h, BABA_META_COMPLETE)).toBeNull();
      expect(meta(h, BABA_META_DONE)).toBeNull();
      expect(h.stage.dueAtMs()).toBe(slotAt(1));
      h.store.finishFails = false;
      h.clock.now = slotAt(1);
      expect((await h.stage.run()).result).toBe("ok");
      expect(meta(h, BABA_META_DONE)).toBe("1");
    });
  });

  describe("旧版(1 日 1 回)の印からの移行", () => {
    it("枠の印が無く、試みた時刻(baba_attempted_at)だけがある日は、その時刻の枠を最後の枠として続ける(09:30 に試みた → 枠 2 → 次は枠 3〈09:45〉)", () => {
      const h = harness({ now: at("09:31:00") });
      setMeta(h, BABA_META_ATTEMPTED, String(at("09:30:00")));
      expect(meta(h, BABA_META_SLOT)).toBeNull(); // 前提: 枠の印は無い
      expect(h.stage.dueAtMs()).toBe(slotAt(3));
      expect(slotAt(3)).toBe(at("09:45:00"));
      expect(h.stage.runnable()).toBe(false);
      h.clock.now = at("09:45:00");
      expect(h.stage.runnable()).toBe(true);
    });

    it("枠の印があれば、そちらが正(試みた時刻の印と食い違っても)", () => {
      const h = harness({ now: at("10:00:00") });
      setMeta(h, BABA_META_ATTEMPTED, String(at("09:30:00")));
      setMeta(h, BABA_META_SLOT, "5");
      expect(h.stage.dueAtMs()).toBe(slotAt(6));
    });
  });
});

describe("claim の失敗(JRA に何も送っていないので再試行してよい)", () => {
  it("失敗 → 60 秒後に再試行 → 成功。取得は 1 回", async () => {
    const h = harness();
    h.store.claimFailures = 1;
    const first = await h.stage.run();
    expect(first.result).toBe("retry");
    expect(h.fetchCalls.n).toBe(0);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull(); // 印は書かない(取得していない)
    expect(meta(h, BABA_META_SLOT)).toBeNull();
    expect(meta(h, BABA_META_RETRY_AT)).toBe(String(AT_0900 + MIN));
    expect(meta(h, BABA_META_CLAIM_TRIES)).toBe("1");
    // 再試行の時刻まで動けない・候補はその時刻
    expect(h.stage.runnable()).toBe(false);
    expect(h.stage.dueAtMs()).toBe(AT_0900 + MIN);
    h.clock.now = AT_0900 + MIN;
    expect(h.stage.runnable()).toBe(true);
    const second = await h.stage.run();
    expect(second.result).toBe("ok");
    expect(h.fetchCalls.n).toBe(1);
    expect(meta(h, BABA_META_CLAIM_TRIES)).toBeNull(); // 成功したら数え直し
    expect(meta(h, BABA_META_RETRY_AT)).toBeNull();
  });

  it("3 回とも失敗 → その枠は諦める(印を書き、取得口は呼ばない)が、日は諦めない。次の枠(09:15)でまた試みる。警告は固定の文で、例外の文面・URL を含まない", async () => {
    const h = harness();
    h.store.claimFailures = 3;
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      results.push((await h.stage.run()).result);
      h.clock.now += MIN;
    }
    expect(results).toEqual(["retry", "retry", "failed"]);
    expect(h.fetchCalls.n).toBe(0);
    expect(meta(h, BABA_META_SLOT)).toBe("0");
    expect(meta(h, BABA_META_RESULT)).toBe("claim-failed");
    expect(meta(h, BABA_META_CLAIM_TRIES)).toBeNull();
    expect(meta(h, BABA_META_RETRY_AT)).toBeNull();
    expect(h.stage.runnable()).toBe(false); // 09:03 は枠 0 の中
    expect(h.stage.dueAtMs()).toBe(slotAt(1));
    expect(h.warns.length).toBeGreaterThan(0);
    expect(h.warns.join("\n")).not.toContain("secret");
    expect(h.warns.join("\n")).not.toContain("d1.test.invalid");
    h.clock.now = slotAt(1);
    expect((await h.stage.run()).result).toBe("ok"); // 次の枠は成功する
    expect(h.fetchCalls.n).toBe(1);
  });

  it("失敗の回数は枠ごと(枠をまたいだら数え直す): 枠 0 で 2 回失敗 → 枠 1 で 1 回失敗しても retry(諦めない)", async () => {
    const h = harness();
    h.store.claimFailures = 3;
    expect((await h.stage.run()).result).toBe("retry");
    h.clock.now += MIN;
    expect((await h.stage.run()).result).toBe("retry");
    expect(meta(h, BABA_META_CLAIM_TRIES)).toBe("2");
    h.clock.now = slotAt(1);
    expect((await h.stage.run()).result).toBe("retry"); // 3 回目の失敗だが、別の枠なので 1 回目として数える
    expect(meta(h, BABA_META_CLAIM_TRIES)).toBe("1");
    expect(meta(h, BABA_META_SLOT)).toBeNull();
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
    h.behavior.respond = () => ({ ...failureOutcome("no-today-venues", 1), droppedDetails: [{ venue: "05", reason: "unparsed", measured: "本文に含まれる語-CANARY" }] });
    await h.stage.run();
    expect(h.warns.length).toBeGreaterThan(0);
    expect(h.warns.join("\n")).not.toContain("CANARY");
  });

  it("保存先に渡す記録に、取得口の結果の余計な項目(本文の断片)を入れない(成功: 結果・取得時刻・競馬場・件数だけ。失敗: apiFetchedAt は null)", async () => {
    const ok = harness();
    ok.behavior.respond = () => ({ ...sampleOutcome(), text: "本文の断片-CANARY" }) as BabaFetchOutcome;
    await ok.stage.run();
    expect(ok.store.finishes).toHaveLength(1);
    expect(ok.store.finishes[0]!.finish.result).toBe("ok");
    expect(ok.store.finishes[0]!.finish.apiFetchedAt).toBe(sampleOutcome().apiFetchedAt);
    expect(JSON.stringify(ok.store.finishes)).not.toContain("CANARY");

    const ng = harness();
    ng.behavior.respond = () => ({ ...failureOutcome("shape-mismatch"), text: "本文の断片-CANARY" }) as BabaFetchOutcome;
    await ng.stage.run();
    expect(ng.store.finishes).toHaveLength(1);
    expect(ng.store.finishes[0]!.finish.result).toBe("shape-mismatch");
    expect(ng.store.finishes[0]!.finish.apiFetchedAt).toBeNull();
    expect(JSON.stringify([ng.store.finishes, ng.warns])).not.toContain("CANARY");
  });

  it("捨てた競馬場の件数と診断は、取得口の結果のまま保存先に渡す(件数 1・診断 1 件)", async () => {
    const h = harness();
    const detail = { venue: "01", reason: "not-today", measured: "9月6日（日曜）8時20分" } as const;
    h.behavior.respond = () => ({ ...sampleOutcome(), dropped: 1, droppedDetails: [detail] });
    await h.stage.run();
    expect(h.store.finishes[0]!.finish.dropped).toBe(1);
    expect(h.store.finishes[0]!.finish.droppedDetails).toEqual([detail]);
  });

  it("成功のとき警告は無く、一部の競馬場を捨てただけの応答も警告にしない(件数は D1 の記録に残る)", async () => {
    const h = harness();
    await h.stage.run();
    expect(h.warns).toEqual([]);
  });

  it("そろわない回の警告は固定の文で、次の枠で取り直すこと(最後の枠なら取り直さないこと)を伝える", async () => {
    const h = harness();
    h.behavior.respond = () => failureOutcome("no-today-venues", 3);
    await h.stage.run();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain("取り直し");
    h.clock.now = at("12:00:00");
    await h.stage.run();
    expect(h.warns).toHaveLength(2);
    expect(h.warns[1]).toContain("最後の枠");
  });
});
