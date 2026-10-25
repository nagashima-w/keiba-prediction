import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AnthropicMessageResponse, AnthropicRequestParams, ModelInfoLite } from "@keiba/core/llm";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { DayBaba } from "../../packages/core/src/analyzer/day-baba";
import { BABA_PROMPT_HEADING } from "../../packages/core/src/analyzer/day-baba";
import { sampleOutcome } from "./baba-sample";
import { D1BabaStore } from "../src/baba-repository";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { CloudLlm } from "../src/llm-sender";
import type { BabaReader } from "../src/race-day-baba";
import { RaceDayCore, type AnalysisSink } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #295: 当日の馬場の値(D1 の `baba_conditions`)を、発走前の分析の計算ステップで読み、LLM のプロンプトとスナップショットに渡す配線(`RaceDayCore` の `babaReader`)。
 * フィクスチャのレースは 202603020211(中央・場コード 03・芝・16 頭)、開催日 20260628。**gate は 0 回のまま**(D1 の読み出しは netkeiba に出ない)。LLM はスタブ、実 API には触れない。
 */

const DATE = "20260628";
const RACE = "202603020211";
const SECRET = "sk-ant-SECRET-D1-BODY";
const FIXED_MODEL = "claude-sonnet-5-5";
const SETTINGS: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5, includeComboOdds: false };

const TURF = { condition: "良", goalCondition: "良", corner4Condition: "良", goalMoisture: 13.2, corner4Moisture: 11.8 };
const BABA: DayBaba = {
  measuredAt: "2026-06-28T07:00+09:00",
  cushion: 9.6,
  turf: TURF,
  dirt: { condition: "稍重", goalCondition: "稍重", corner4Condition: "稍重", goalMoisture: 1.7, corner4Moisture: 2.5 },
  usedCourse: "Aコース（内柵を最内に設置）",
  turfStateText: "1週使用しましたが、傷みは少なく概ね良好な状態です。",
};

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

function harness(options: { reader?: BabaReader; llm?: boolean }): Harness {
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
    ...(options.reader === undefined ? {} : { babaReader: options.reader }),
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

const snapshotBaba = (h: Harness): unknown => (h.sink.saved[0]!.raceSnapshot as Record<string, unknown>)["baba"];

describe("発走前の計算ステップ: 当日の馬場の値の配線(偽の読み出し口)", () => {
  it("開催日(YYYYMMDD)と場コード(03)で 1 回だけ読む。プロンプトに節が入り、スナップショットの baba は芝の項目だけの同じ値。gate は 0 回のまま", async () => {
    const calls: [string, string][] = [];
    const reader: BabaReader = { load: async (date, venueCode) => (calls.push([date, venueCode]), BABA) };
    const h = harness({ reader });
    const r = await runPreRace(h);
    expect(r.outcome).toBe("pre_race:compute:ok");
    expect(r.gateAfterCompute).toBe(r.gateBeforeCompute);
    expect(calls).toEqual([[DATE, "03"]]);
    const prompt = promptOf(h.llm!);
    expect(prompt).toContain(BABA_PROMPT_HEADING);
    expect(prompt).toContain("クッション値: 9.6");
    expect(prompt).not.toContain("ダートの含水率"); // 芝のレース: ダートの面は渡さない
    expect(snapshotBaba(h)).toEqual({ ...BABA, dirt: null });
    expect(h.sink.saved).toHaveLength(1);
  });

  it("読み出し口が無い構成・行が無い(null)は、節もスナップショットの baba も無く、プロンプトは同じ(byte 一致)", async () => {
    const plain = harness({});
    expect((await runPreRace(plain)).outcome).toBe("pre_race:compute:ok");
    const empty = harness({ reader: { load: async () => null } });
    expect((await runPreRace(empty)).outcome).toBe("pre_race:compute:ok");
    expect(promptOf(plain.llm!)).not.toContain(BABA_PROMPT_HEADING);
    expect(promptOf(empty.llm!)).toBe(promptOf(plain.llm!));
    for (const h of [plain, empty]) {
      expect("baba" in (h.sink.saved[0]!.raceSnapshot as Record<string, unknown>)).toBe(false);
    }
  });

  it("読み出しが失敗しても分析は止めない: 節なしで保存し、警告は固定の語(例外の文面・秘密は出さない)", async () => {
    const reader: BabaReader = {
      load: async () => {
        throw new Error(`D1_ERROR: no such table baba_conditions ${SECRET}`);
      },
    };
    const h = harness({ reader });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(h.sink.saved).toHaveLength(1);
    expect(promptOf(h.llm!)).not.toContain(BABA_PROMPT_HEADING);
    expect("baba" in (h.sink.saved[0]!.raceSnapshot as Record<string, unknown>)).toBe(false);
    const warn = h.warnings.filter((w) => w.includes("馬場の値"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(RACE);
    expect(h.warnings.join("\n")).not.toContain(SECRET);
    expect(h.warnings.join("\n")).not.toContain("no such table");
  });

  it("LLM を使わない経路(キー未登録)では、読まない", async () => {
    let called = 0;
    const h = harness({ reader: { load: async () => (called += 1, BABA) }, llm: false });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    expect(called).toBe(0);
    expect("baba" in (h.sink.saved[0]!.raceSnapshot as Record<string, unknown>)).toBe(false);
  });
});

describe("統合(本物の D1BabaStore。ローカルの workerd の D1)", () => {
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

  it("D1 に貯めた 2 日 × 2 場の値から、このレースの日・場(20260628・03)の行だけがプロンプトとスナップショットに入る", async () => {
    const store = new D1BabaStore({ db: local.db });
    const tokyo = sampleOutcome().venues[0]!;
    const cell = (venueCode: string, cushion: number, day: string) => ({ ...tokyo, venueCode, cushion, measuredAt: `2026-06-${day}T07:00+09:00` });
    await store.claim("20260628", 1);
    await store.finish("20260628", { finishedAt: 2, result: "ok", apiFetchedAt: null, venues: [cell("03", 8.1, "28"), cell("05", 8.2, "28")], dropped: 0, droppedDetails: [] });
    await store.claim("20260627", 3);
    await store.finish("20260627", { finishedAt: 4, result: "ok", apiFetchedAt: null, venues: [cell("03", 8.3, "27"), cell("05", 8.4, "27")], dropped: 0, droppedDetails: [] });
    const h = harness({ reader: store });
    expect((await runPreRace(h)).outcome).toBe("pre_race:compute:ok");
    const prompt = promptOf(h.llm!);
    expect(prompt).toContain("クッション値: 8.1");
    for (const other of ["8.2", "8.3", "8.4"]) {
      expect(prompt).not.toContain(`クッション値: ${other}`);
    }
    expect((snapshotBaba(h) as DayBaba).cushion).toBe(8.1);
    expect((snapshotBaba(h) as DayBaba).measuredAt).toBe("2026-06-28T07:00+09:00");
  });
});
