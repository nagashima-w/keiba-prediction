import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FALLBACK_REASON_INVOCATION_ERROR, FALLBACK_REASON_TRUNCATED, type AnthropicMessageResponse } from "@keiba/core/llm";
import { buildAnalysisView } from "../src/analysis-view";
import { D1AnalysisStore } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import type { CloudLlm } from "../src/llm-sender";
import { RaceDayCore } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql } from "./node-sql";
import { fixtureForUrl } from "./pipeline-fixtures";

/**
 * Issue #197(#196-a 段2): DO(RaceDayCore。発走前の分析)→ 本物の保存先 → 本物の(ローカルの workerd の)D1 → 読み出し(`AnalysisView.llmCalls`)を通しで確かめる。
 * LLM を呼んだ1回ごとの記録(所要時間・usage・stop_reason・失敗の説明)が、`analyses.llm_calls_json` に入り、API の応答に載る。LLM は偽の sender(実 API には出ない)。
 * 所要時間は、偽の sender が DO の時計(`now`)を進めて作る(実時間は測らない)。
 */

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

const DATE = "20260628";
const RACE = "202603020211";
const SETTINGS: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, includeComboOdds: false };
const encoder = new TextEncoder();
const SECRET = "sk-ant-SECRET-BODY";
const MODEL = "claude-sonnet-5-5";

const llmJson = (): string => JSON.stringify({ horses: Array.from({ length: 16 }, (_, i) => ({ number: i + 1, place_prob: 0.5, reason: `根拠${i + 1}`, mark: i === 0 ? "◎" : null })) });
const reply = (text: string, extra: Partial<AnthropicMessageResponse> = {}): AnthropicMessageResponse => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  model: MODEL,
  usage: { input_tokens: 15_001, output_tokens: 6_020 },
  ...extra,
});

interface Harness {
  readonly core: RaceDayCore;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly store: D1AnalysisStore;
  close(): void;
}

/** sink を差し替えられる RaceDayCore。`sender` は、呼び出しごとに時計を進められるよう、時計を受け取る。 */
function harness(makeLlm: (clock: { now: number }) => CloudLlm | undefined, wrapSink?: (inner: ReturnType<typeof createAnalysisSink>) => ReturnType<typeof createAnalysisSink>): Harness {
  const store = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
  const sql = openNodeSql();
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarm: { at: number | null } = { at: null };
  const sink = createAnalysisSink(store);
  const llm = makeLlm(clock);
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate: {
      fetchRaw: async (url) => {
        const view = encoder.encode(fixtureForUrl(url));
        const body = new Uint8Array(view.length);
        body.set(view);
        return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: body.buffer, queuedMs: 0, elapsedMs: 1 };
      },
    },
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: () => undefined,
    sink: wrapSink === undefined ? sink : wrapSink(sink),
    loadSettings: async () => SETTINGS,
    ...(llm === undefined ? {} : { llm }),
  });
  return { core, clock, alarm, store, close: () => sql.close() };
}

async function runToDone(h: Harness): Promise<number> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  await h.core.runNextStep();
  expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
  const board = h.core.getBoard().races.find((r) => r.mode === "pre_race")!;
  expect(board.analysisId).not.toBeNull();
  return board.analysisId!;
}

const rowOf = async (id: number) => local.db.prepare("SELECT model, llm_note AS note, llm_calls_json AS calls FROM analyses WHERE id = ?").bind(id).first<{ model: string | null; note: string | null; calls: string | null }>();
const viewOf = async (h: Harness, id: number) => buildAnalysisView((await h.store.getAnalysisDetail(id))!, undefined);

describe("DO → 保存先 → D1 → API の応答: llmCalls(LLM 呼び出しの記録)", () => {
  it("LLM が成功: 1件。所要時間(DO の時計の差)・入力/出力トークン・stop_reason・モデル。replayed:false。llm_note は NULL。API の応答にも同じ値が載る", async () => {
    const h = harness((clock) => ({
      sender: async () => {
        clock.now += 41_234;
        return reply(llmJson());
      },
    }));
    const id = await runToDone(h);
    const expected = [{ ok: true, ms: 41_234, inputTokens: 15_001, outputTokens: 6_020, stopReason: "end_turn", model: MODEL, replayed: false, error: null }];
    const row = await rowOf(id);
    expect(row!.note).toBeNull();
    expect(JSON.parse(row!.calls!)).toEqual(expected);
    expect((await viewOf(h, id)).llmCalls).toEqual(expected);
    h.close();
  });

  it("API キー未登録(llm なし): 記録は NULL。API の応答の llmCalls は null(『呼んでいない』)", async () => {
    const h = harness(() => undefined);
    const id = await runToDone(h);
    expect((await rowOf(id))!.calls).toBeNull();
    expect((await viewOf(h, id)).llmCalls).toBeNull();
    h.close();
  });

  it("1回目が解析できず、再送(analyzeRace の再試行)で成功: 2件。呼び出しごとの所要時間・トークンが別々に残る(最後の1回だけにしない)", async () => {
    let n = 0;
    const h = harness((clock) => ({
      sender: async () => {
        n += 1;
        clock.now += n === 1 ? 10_000 : 20_000;
        return n === 1 ? reply("JSON ではない応答", { usage: { input_tokens: 15_001, output_tokens: 300 } }) : reply(llmJson());
      },
    }));
    const id = await runToDone(h);
    expect(n).toBe(2);
    expect((await rowOf(id))!.note).toBeNull(); // 再送で成功したので理由なし
    const calls = (await viewOf(h, id)).llmCalls!;
    expect(calls.map((c) => [c.ms, c.outputTokens, c.replayed])).toEqual([[10_000, 300, false], [20_000, 6_020, false]]);
    h.close();
  });

  it("【切り詰め】2回とも max_tokens: fallback の理由(core の固定文言)と、2件の記録(stop_reason=max_tokens・出力トークン 16000)。切り詰めの診断が D1 だけで分かる", async () => {
    const h = harness((clock) => ({
      sender: async () => {
        clock.now += 90_000;
        return reply("途中", { stop_reason: "max_tokens", usage: { input_tokens: 15_001, output_tokens: 16_000 } });
      },
    }));
    const id = await runToDone(h);
    const row = await rowOf(id);
    expect(row).toMatchObject({ model: null, note: FALLBACK_REASON_TRUNCATED });
    const calls = (await viewOf(h, id)).llmCalls!;
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.ok && c.stopReason === "max_tokens" && c.outputTokens === 16_000 && c.ms === 90_000 && !c.replayed)).toBe(true);
    h.close();
  });

  it("API のエラー(429)が2回: 2件の失敗の記録(所要時間・status=429 だけ)。エラーの本文・鍵は D1 のどこにも入らない", async () => {
    const h = harness((clock) => ({
      sender: async () => {
        clock.now += 1_500;
        throw Object.assign(new Error(`429 {"message":"${SECRET}"}`), { status: 429 });
      },
    }));
    const id = await runToDone(h);
    const row = await rowOf(id);
    expect(row).toMatchObject({ model: null, note: FALLBACK_REASON_INVOCATION_ERROR });
    expect((await viewOf(h, id)).llmCalls).toEqual([
      { ok: false, ms: 1_500, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "status=429" },
      { ok: false, ms: 1_500, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "status=429" },
    ]);
    for (const table of ["analyses", "analysis_horses", "analysis_allocation_meta", "analysis_bets"]) {
      const rows = (await local.db.prepare(`SELECT * FROM ${table}`).all()).results;
      expect(JSON.stringify(rows), table).not.toContain("sk-ant-");
      expect(JSON.stringify(rows), table).not.toContain("SECRET");
    }
    h.close();
  });
});

describe("保存の失敗の再試行: 記録した応答を再生した呼び出しは replayed:true。元の所要時間・トークンで、二重に数えない", () => {
  /** 最初の保存だけ失敗する sink(D1 の一時的な失敗)。 */
  const failFirstSave = () => {
    let failOnce = true;
    return (inner: ReturnType<typeof createAnalysisSink>) => ({
      ...inner,
      async save(record: Parameters<typeof inner.save>[0], extra?: Parameters<typeof inner.save>[1]) {
        if (failOnce) {
          failOnce = false;
          throw new Error("D1 の一時的な失敗");
        }
        return inner.save(record, extra);
      },
    });
  };

  it("実送信は1回のまま。保存された記録は1件で、replayed:true・元の所要時間(再実行の時計に依らない)・元のトークン。分析は1件だけ", async () => {
    let calls = 0;
    const h = harness(
      (clock) => ({
        sender: async () => {
          calls += 1;
          clock.now += 41_234;
          return reply(llmJson());
        },
      }),
      failFirstSave(),
    );
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "retry" });
    h.clock.now = h.alarm.at!; // 再試行の時刻(元の呼び出しの時計とは、まったく違う値)
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(calls).toBe(1);
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses").first<{ c: number }>())!.c).toBe(1);
    const id = h.core.getBoard().races.find((r) => r.mode === "pre_race")!.analysisId!;
    expect((await viewOf(h, id)).llmCalls).toEqual([{ ok: true, ms: 41_234, inputTokens: 15_001, outputTokens: 6_020, stopReason: "end_turn", model: MODEL, replayed: true, error: null }]);
    h.close();
  });

  it("【既知の限界】再実行の前に失敗した呼び出し(429 のあとに成功した最初の実行)は、記録(応答の記録)に残らないので、再実行の記録には出ない。成功の1件だけが replayed:true で残る", async () => {
    let calls = 0;
    const h = harness(
      (clock) => ({
        sender: async () => {
          calls += 1;
          clock.now += 1_000 * calls;
          if (calls === 1) {
            throw Object.assign(new Error("x"), { status: 529 });
          }
          return reply(llmJson());
        },
      }),
      failFirstSave(),
    );
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "retry" });
    h.clock.now = h.alarm.at!;
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(calls).toBe(2); // 失敗1回 + 成功1回(再実行では送らない)
    const id = h.core.getBoard().races.find((r) => r.mode === "pre_race")!.analysisId!;
    const saved = (await viewOf(h, id)).llmCalls!;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ ok: true, ms: 2_000, replayed: true });
    h.close();
  });
});
