import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AnthropicMessageResponse, AnthropicRequestParams, ModelInfoLite } from "@keiba/core/llm";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { KaisaiDayRow } from "../../packages/core/src/analyzer/turf-wear";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { D1KaisaiDaysStore, type KaisaiDaysStore } from "../src/kaisai-days-repository";
import type { CloudLlm } from "../src/llm-sender";
import { RaceDayCore, type AnalysisSink } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #519: 開催日ごとの記録 `kaisai_days` の配線(`RaceDayCore` の `kaisaiDaysStore`)。
 *  - 書き込み: 発走前の計算ステップで、中央のレースごとに (場コード, 年, 回, 日次)・開催日・柵を書く(LLM の有無に関係なく。失敗は握る)。
 *  - 読み出し: LLM を使う中央の芝のレースで、同じ場の過去の行を読み、プロンプトの「芝コースの開催進行」の行に通算の日数・柵の日数を足す。
 * フィクスチャのレースは 202603020211(中央・場コード 03・2026 年 2 回 2 日目・芝・柵 A・16 頭)、開催日 20260628。**gate は 0 回のまま**(D1 は netkeiba に出ない)。LLM はスタブ、実 API には触れない。
 */

const DATE = "20260628";
const RACE = "202603020211";
const SECRET = "sk-ant-SECRET-D1-BODY";
const FIXED_MODEL = "claude-sonnet-5-5";
const SETTINGS: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5, includeComboOdds: false };

const meeting = (kai: number, dates: readonly string[], fence: string | null): KaisaiDayRow[] =>
  dates.map((kaisaiDate, i) => ({ trackCode: "03", year: 2026, kai, nichi: i + 1, kaisaiDate, fence }));
/** 1回(8 日。最終日 6/21)と、2回の 1 日目(6/27)。1回の最終日から 2回の初日は 6 日で、連続している。1回は柵 B、2回の 1 日目は柵 A。 */
const PAST: KaisaiDayRow[] = [
  ...meeting(1, ["20260606", "20260607", "20260613", "20260614", "20260615", "20260619", "20260620", "20260621"], "B"),
  ...meeting(2, ["20260627"], "A"),
];
const SENTENCE = "芝コースの開催進行: 中央2回2日目(1回から連続開催で通算10日目。柵Aは2日目)。";

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
interface FakeGate extends GateLike {
  readonly urls: string[];
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(fixtureForUrl(url)), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}
interface FakeLlm extends CloudLlm {
  readonly calls: AnthropicRequestParams[];
}
function fakeLlm(): FakeLlm {
  const horses = Array.from({ length: 16 }, (_, i) => ({ number: i + 1, place_prob: 0.5, reason: `根拠${i + 1}`, mark: i === 0 ? "◎" : null }));
  const response: AnthropicMessageResponse = { content: [{ type: "text", text: JSON.stringify({ horses }) }], stop_reason: "end_turn", model: FIXED_MODEL };
  const models: readonly ModelInfoLite[] = [{ id: FIXED_MODEL, created_at: "2026-01-01T00:00:00Z" }];
  const llm: FakeLlm = {
    calls: [],
    sender: async (params) => {
      llm.calls.push(params);
      return response;
    },
    lister: async () => models,
  };
  return llm;
}
const promptOf = (llm: FakeLlm): string => llm.calls[0]!.messages[0]!.content as string;

function fakeSink(): AnalysisSink & { readonly saved: AnalysisRecord[] } {
  const saved: AnalysisRecord[] = [];
  return {
    saved,
    async save(record) {
      saved.push(record);
      return { id: saved.length, detail: "stored" };
    },
    async findByAnalyzedAt() {
      return null;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
}

/** 偽の保存先: 書いた行と、読んだ引数を記録する。 */
function fakeStore(options: { rows?: readonly KaisaiDayRow[]; failRecord?: boolean; failLoad?: boolean } = {}): KaisaiDaysStore & { readonly recorded: KaisaiDayRow[]; readonly loads: [string, string][] } {
  const store = {
    recorded: [] as KaisaiDayRow[],
    loads: [] as [string, string][],
    async record(row: KaisaiDayRow) {
      store.recorded.push(row);
      if (options.failRecord === true) {
        throw new Error(`D1_ERROR: no such table kaisai_days ${SECRET}`);
      }
    },
    async load(trackCode: string, date: string) {
      store.loads.push([trackCode, date]);
      if (options.failLoad === true) {
        throw new Error(`D1_ERROR: no such table kaisai_days ${SECRET}`);
      }
      return options.rows ?? [];
    },
  };
  return store;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly gate: FakeGate;
  readonly sink: ReturnType<typeof fakeSink>;
  readonly llm: FakeLlm | undefined;
  readonly warnings: string[];
}
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(options: { store?: KaisaiDaysStore; llm?: boolean }): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const gate = fakeGate();
  const sink = fakeSink();
  const llm = options.llm === false ? undefined : fakeLlm();
  const warnings: string[] = [];
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: () => undefined,
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => SETTINGS,
    ...(llm === undefined ? {} : { llm }),
    ...(options.store === undefined ? {} : { kaisaiDaysStore: options.store }),
  });
  return { core, gate, sink, llm, warnings };
}

async function runPreRace(h: Harness): Promise<{ readonly outcome: string; readonly gateBeforeCompute: number; readonly gateAfterCompute: number }> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  await h.core.runNextStep(); // fetch
  const gateBeforeCompute = h.gate.urls.length;
  const out = await h.core.runNextStep(); // compute
  return { outcome: out.kind === "idle" ? "idle" : `${out.mode}:${out.step}:${out.result}`, gateBeforeCompute, gateAfterCompute: h.gate.urls.length };
}

describe("発走前の計算ステップ: 開催日の記録の書き込み(偽の保存先)", () => {
  it("そのレースの (場コード, 年, 回, 日次)・開催日・柵(芝で読めた A)を 1 回だけ書く。gate は 0 回のまま", async () => {
    const store = fakeStore();
    const h = harness({ store });
    const r = await runPreRace(h);
    expect(r.outcome).toBe("pre_race:compute:ok");
    expect(r.gateAfterCompute).toBe(r.gateBeforeCompute);
    expect(store.recorded).toEqual([{ trackCode: "03", year: 2026, kai: 2, nichi: 2, kaisaiDate: DATE, fence: "A" }]);
  });

  it("LLM を使わない経路(キー未登録)でも書く。読まない(LLM が見ない材料は読まない)", async () => {
    const store = fakeStore({ rows: PAST });
    const h = harness({ store, llm: false });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(store.recorded).toHaveLength(1);
    expect(store.loads).toEqual([]);
  });

  it("書き込みが失敗しても分析は止めない: 保存まで完了し、警告は固定の語(例外の文面・秘密は出さない)", async () => {
    const store = fakeStore({ failRecord: true });
    const h = harness({ store });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(h.sink.saved).toHaveLength(1);
    const warn = h.warnings.filter((w) => w.includes("開催日の記録を書けなかった"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(RACE);
    expect(h.warnings.join("\n")).not.toContain(SECRET);
    expect(h.warnings.join("\n")).not.toContain("no such table");
  });

  it("保存先が無い構成は、何も書かず、警告もない", async () => {
    const h = harness({});
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(h.warnings.filter((w) => w.includes("開催日の記録を書けなかった"))).toEqual([]);
  });
});

describe("発走前の計算ステップ: 過去の行の読み出しとプロンプト(偽の保存先)", () => {
  it("場コード(03)と開催日(YYYYMMDD)で 1 回だけ読む。続いているとき、プロンプトの行に通算の日数と柵の日数が入る", async () => {
    const store = fakeStore({ rows: PAST });
    const h = harness({ store });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(store.loads).toEqual([["03", DATE]]);
    expect(promptOf(h.llm!)).toContain(SENTENCE);
  });

  it("行が無い(空)・保存先が無い構成は、従来の文のまま(プロンプトはバイト一致)", async () => {
    const plain = harness({});
    expect((await runPreRace(plain)).outcome).toBe("pre_race:compute:ok");
    const empty = harness({ store: fakeStore() });
    expect((await runPreRace(empty)).outcome).toBe("pre_race:compute:ok");
    expect(promptOf(plain.llm!)).toContain("芝コースの開催進行: 中央2回2日目(柵A)。");
    expect(promptOf(empty.llm!)).toBe(promptOf(plain.llm!));
  });

  it("読み出しが失敗しても分析は止めない: 従来の文で保存し、警告は固定の語(例外の文面・秘密は出さない)", async () => {
    const plain = harness({});
    await runPreRace(plain);
    const h = harness({ store: fakeStore({ failLoad: true }) });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(h.sink.saved).toHaveLength(1);
    expect(promptOf(h.llm!)).toBe(promptOf(plain.llm!));
    const warn = h.warnings.filter((w) => w.includes("過去の開催日の記録"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(RACE);
    expect(h.warnings.join("\n")).not.toContain(SECRET);
    expect(h.warnings.join("\n")).not.toContain("no such table");
  });
});

describe("統合(本物の D1KaisaiDaysStore。ローカルの workerd の D1)", () => {
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

  it("D1 に貯めた過去の行から、プロンプトに通算の日数・柵の日数が入り、今日の行(20260628・03・2回2日目・柵 A)が書かれる。別の場の行・翌日以降の行は影響しない", async () => {
    const store = new D1KaisaiDaysStore({ db: local.db });
    for (const row of [...PAST, ...meeting(2, ["20260627"], "A").map((r) => ({ ...r, trackCode: "05", kai: 9 })), { trackCode: "03", year: 2026, kai: 2, nichi: 3, kaisaiDate: "20260629", fence: "A" }]) {
      await store.record(row);
    }
    const h = harness({ store });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(promptOf(h.llm!)).toContain(SENTENCE);
    const today = await local.db.prepare("SELECT track_code, year, kai, nichi, kaisai_date, fence FROM kaisai_days WHERE track_code = '03' AND kai = 2 AND nichi = 2").all();
    expect(today.results).toEqual([{ track_code: "03", year: 2026, kai: 2, nichi: 2, kaisai_date: DATE, fence: "A" }]);
  });

  it("migration が未適用の D1(表が無い)でも、書き込み・読み出しの失敗を握って分析は完了する(Worker が migration より先に出ても動く)", async () => {
    await local.db.prepare("DROP TABLE kaisai_days").run();
    try {
      const h = harness({ store: new D1KaisaiDaysStore({ db: local.db }) });
      expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
      expect(h.sink.saved).toHaveLength(1);
      expect(h.warnings.filter((w) => w.includes("開催日の記録を書けなかった"))).toHaveLength(1);
      expect(h.warnings.filter((w) => w.includes("過去の開催日の記録"))).toHaveLength(1);
      expect(promptOf(h.llm!)).toContain("芝コースの開催進行: 中央2回2日目(柵A)。");
    } finally {
      await local.db.prepare("CREATE TABLE kaisai_days (track_code TEXT NOT NULL, year INTEGER NOT NULL, kai INTEGER NOT NULL, nichi INTEGER NOT NULL, kaisai_date TEXT NOT NULL, fence TEXT, PRIMARY KEY (track_code, year, kai, nichi)) WITHOUT ROWID").run();
    }
  });
});
