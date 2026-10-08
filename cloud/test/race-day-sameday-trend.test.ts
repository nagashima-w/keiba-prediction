import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AnthropicMessageResponse, AnthropicRequestParams, ModelInfoLite } from "@keiba/core/llm";
import type { AnalysisRecord, RaceResultDetail, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { CloudLlm } from "../src/llm-sender";
import { RaceDayCore, type AnalysisSink } from "../src/race-day-core";
import { D1ResultStore } from "../src/result-repository";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl, sameDayDetailOf } from "./pipeline-fixtures";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #209(AC-C4): 当日傾向を発走前の分析に入れる配線。pre_race の計算ステップの `getRaceResultDetails` を、結果ストア(D1)の読み出しにつなぎ、
 * `onSameDayTrendError` を onWarn につなぐ。**gate は 0 回のまま**(D1 の読み出しは netkeiba に出ない)。LLM を使わない経路(キー未登録)では呼ばない。
 * 統合テスト: 本物の `D1ResultStore`(ローカルの workerd の D1)に結果を保存 → pre_race を LLM スタブで走らせ → プロンプトの文字列を、
 * exe と同じ golden の経路(`sameDayDetailOf` を返す偽のストア)で作った文字列と照合する。自レース・後続のレースの結果が D1 にあっても混ざらない(リークの対照)。
 */

const DATE = "20260628";
const RACE = "202603020211"; // 芝・16 頭(フィクスチャ)。前のレースは 202603020201〜202603020210 の 10 件
const BLOCK_HEADING = "当日の同場・同面傾向(芝、確定10R)";
const SECRET = "sk-ant-SECRET-D1-BODY";
const FIXED_MODEL = "claude-sonnet-5-5";
const ALL_ON: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5, includeComboOdds: false };

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

type ResultStoreLike = NonNullable<ConstructorParameters<typeof RaceDayCore>[0]["resultStore"]>;

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

function harness(options: { store?: ResultStoreLike; llm?: boolean }): Harness {
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
    loadSettings: async () => ALL_ON,
    ...(llm === undefined ? {} : { llm }),
    ...(options.store === undefined ? {} : { resultStore: options.store }),
  });
  return { core, gate, sink, llm, warnings };
}

/** pre_race を予約して、取得 → 計算を進める。計算ステップの前後の gate の呼び出し数も返す。 */
async function runPreRace(h: Harness): Promise<{ readonly computeOutcome: string; readonly gateBeforeCompute: number; readonly gateAfterCompute: number }> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  await h.core.runNextStep(); // fetch
  const gateBeforeCompute = h.gate.urls.length;
  const outcome = await h.core.runNextStep(); // compute
  return { computeOutcome: outcome.kind === "idle" ? "idle" : `${outcome.mode}:${outcome.step}:${outcome.result}`, gateBeforeCompute, gateAfterCompute: h.gate.urls.length };
}

/** golden と同じ式の前走の結果(`sameDayDetailOf`)を返す偽のストア。exe の getRaceResultDetail を束縛した経路と同じ値を返す。 */
function goldenStore(requested: (readonly string[])[]): ResultStoreLike {
  return {
    saveResult: async () => undefined,
    getRaceResultDetails: async (ids) => {
      requested.push([...ids]);
      const map = new Map<string, RaceResultDetail>();
      for (const id of ids) {
        const detail = sameDayDetailOf(id);
        if (detail !== undefined) map.set(id, detail);
      }
      return map;
    },
  };
}

const PRECEDING = Array.from({ length: 10 }, (_, i) => `2026030202${String(i + 1).padStart(2, "0")}`);

describe("AC-C4: 配線(偽のストア)", () => {
  it("計算ステップで、前のレース(01〜10R の 10 件)をまとめて 1 回で読む。gate は 0 回のまま。プロンプトに当日傾向のブロックが入る", async () => {
    const requested: (readonly string[])[] = [];
    const h = harness({ store: goldenStore(requested) });
    const r = await runPreRace(h);
    expect(r.computeOutcome).toBe("pre_race:compute:ok");
    expect(r.gateAfterCompute).toBe(r.gateBeforeCompute); // gate(netkeiba)は 0 回
    expect(requested).toEqual([PRECEDING]); // 1 回・自レース(11R)と後続を含まない
    expect(promptOf(h.llm!)).toContain(BLOCK_HEADING);
    expect(h.sink.saved).toHaveLength(1);
  });

  it("結果ストアが無い構成は、当日傾向なしで保存される(ブロックが無い)", async () => {
    const h = harness({});
    expect((await runPreRace(h)).computeOutcome).toBe("pre_race:compute:ok");
    expect(promptOf(h.llm!)).not.toContain("当日の同場・同面傾向");
    expect(h.sink.saved).toHaveLength(1);
  });

  it("D1 の読み出しが失敗しても分析は止めない: 当日傾向なしで保存し、警告に固定の語(秘密・生の文面は出さない)", async () => {
    const store: ResultStoreLike = {
      saveResult: async () => undefined,
      getRaceResultDetails: async () => {
        throw new Error(`D1_ERROR: SELECT secret ${SECRET}`);
      },
    };
    const h = harness({ store });
    expect((await runPreRace(h)).computeOutcome).toBe("pre_race:compute:ok");
    expect(h.sink.saved).toHaveLength(1);
    expect(promptOf(h.llm!)).not.toContain("当日の同場・同面傾向");
    const warn = h.warnings.filter((w) => w.includes("当日傾向"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(RACE);
    expect(h.warnings.join("\n")).not.toContain(SECRET);
  });

  it("LLM を使わない経路(キー未登録)では、D1 を読まない", async () => {
    const requested: (readonly string[])[] = [];
    const h = harness({ store: goldenStore(requested), llm: false });
    expect((await runPreRace(h)).computeOutcome).toBe("pre_race:compute:ok");
    expect(requested).toEqual([]);
    expect(h.sink.saved).toHaveLength(1);
  });
});

describe("AC-C4: 統合(本物の D1ResultStore。ローカルの workerd の D1)", () => {
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

  const entriesOf = (detail: RaceResultDetail): RaceResultEntry[] =>
    detail.horses.map((x) => ({ umaban: x.umaban, finishPosition: x.finishPosition, passing: [...x.passing], last3f: x.last3f }));

  async function seed(store: D1ResultStore, ids: readonly string[], dataOf: (id: string) => RaceResultDetail | undefined): Promise<void> {
    for (const id of ids) {
      const detail = dataOf(id);
      if (detail !== undefined) await store.saveResult(id, entriesOf(detail), detail.courseType);
    }
  }

  /** 自レース・後続のレースのための、見分けやすい(前のレースとは違う)結果。混ざればプロンプトが変わる。 */
  const leakDetail = (): RaceResultDetail => ({
    courseType: "芝",
    horses: Array.from({ length: 10 }, (_, i) => ({ umaban: i + 1, finishPosition: i + 1, passing: [1, 1], last3f: 33 + i * 0.1 })),
  });

  it("D1 に保存した前のレースの結果から作ったプロンプトが、golden と同じ式の経路(偽のストア)で作ったプロンプトと文字列で一致する。自レース・後続の結果が D1 にあっても混ざらない", async () => {
    // 基準: golden 経路
    const golden = harness({ store: goldenStore([]) });
    await runPreRace(golden);
    const goldenPrompt = promptOf(golden.llm!);
    expect(goldenPrompt).toContain(BLOCK_HEADING); // 前提: ブロックが実際に入っている

    // D1: 前のレース 10 件 + 自レース + 後続(12R)の結果(後者 2 つはリークの対照)
    const store = new D1ResultStore({ db: local.db });
    await seed(store, PRECEDING, sameDayDetailOf);
    await seed(store, [RACE, "202603020212"], leakDetail);
    expect((await store.getRaceResultDetails([RACE, "202603020212"])).size).toBe(2); // 前提: リークの対照が D1 に実在する
    const viaD1 = harness({ store });
    expect((await runPreRace(viaD1)).computeOutcome).toBe("pre_race:compute:ok");
    expect(promptOf(viaD1.llm!)).toBe(goldenPrompt);
    expect(viaD1.sink.saved).toHaveLength(1);
  });

  it("対照: D1 に前のレースの結果が 1 件しか無ければ(同じ面で 2 レース未満)ブロックは入らない。D1 が空でも同じ", async () => {
    const store = new D1ResultStore({ db: local.db });
    const empty = harness({ store });
    await runPreRace(empty);
    expect(promptOf(empty.llm!)).not.toContain("当日の同場・同面傾向");
    await seed(store, [PRECEDING[0]!], sameDayDetailOf);
    const one = harness({ store });
    await runPreRace(one);
    expect(promptOf(one.llm!)).not.toContain("当日の同場・同面傾向");
    expect(promptOf(one.llm!)).toBe(promptOf(empty.llm!));
  });
});
