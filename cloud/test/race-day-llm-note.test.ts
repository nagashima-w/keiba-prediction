import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FALLBACK_REASON_INVOCATION_ERROR, type AnthropicMessageResponse } from "@keiba/core/llm";
import { buildAnalysisView } from "../src/analysis-view";
import { D1AnalysisStore } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import { LLM_NOTE_NO_KEY } from "../src/llm-run";
import type { CloudLlm } from "../src/llm-sender";
import { RaceDayCore } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql } from "./node-sql";
import { fixtureForUrl } from "./pipeline-fixtures";

/**
 * Issue #194(#179-b。b2): DO(RaceDayCore。発走前の分析)→ 本物の保存先(`createAnalysisSink`)→ 本物の(ローカルの workerd の)D1 → 読み出し(`AnalysisView`)を通しで確かめる。
 * LLM が使われなかった理由(固定文言)が、`analyses.llm_note` に入り、API の応答(`/api/analyses/{id}` の `llmNote`)に載る。LLM は偽の sender(実 API には出ない)。
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

const llmJson = (): string => JSON.stringify({ horses: Array.from({ length: 16 }, (_, i) => ({ number: i + 1, place_prob: 0.5, reason: `根拠${i + 1}`, mark: i === 0 ? "◎" : null })) });
const ok = (text: string): AnthropicMessageResponse => ({ content: [{ type: "text", text }], stop_reason: "end_turn", model: "claude-sonnet-5-5" });

async function runPreRace(llm: CloudLlm | undefined) {
  const store = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
  const sql = openNodeSql();
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarm: { at: number | null } = { at: null };
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
    sink: createAnalysisSink(store),
    loadSettings: async () => SETTINGS,
    ...(llm === undefined ? {} : { llm }),
  });
  await core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  await core.runNextStep();
  expect(await core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
  const board = core.getBoard().races.find((r) => r.mode === "pre_race")!;
  expect(board.analysisId).not.toBeNull();
  const detail = (await store.getAnalysisDetail(board.analysisId!))!;
  sql.close();
  return { store, id: board.analysisId!, detail, view: buildAnalysisView(detail, undefined) };
}

const rowOf = async (id: number) => local.db.prepare("SELECT model, prompt_version AS promptVersion, llm_note AS note FROM analyses WHERE id = ?").bind(id).first<{ model: string | null; promptVersion: string | null; note: string | null }>();

describe("DO → 保存先 → D1 → API の応答: llmNote", () => {
  it("API キー未登録(llm なし): llm_note に『未登録』の固定文言。モデル null・promptVersion null。API の応答の llmNote にも載る", async () => {
    const { id, view } = await runPreRace(undefined);
    expect(await rowOf(id)).toEqual({ model: null, promptVersion: null, note: LLM_NOTE_NO_KEY });
    expect(view.llmNote).toBe(LLM_NOTE_NO_KEY);
    expect(view.model).toBeNull();
  });

  it("API のエラー(本文に鍵らしい文字列): prior で保存。llm_note は core の固定文言。モデルは null(promptVersion は LLM を呼んだので残る)。エラーの本文は D1 のどこにも入らない", async () => {
    const llm: CloudLlm = {
      sender: async () => {
        throw Object.assign(new Error(`429 {"message":"${SECRET}"}`), { status: 429 });
      },
    };
    const { id, view } = await runPreRace(llm);
    const row = await rowOf(id);
    expect(row).toMatchObject({ model: null, note: FALLBACK_REASON_INVOCATION_ERROR });
    expect(row!.promptVersion).not.toBeNull();
    expect(view.llmNote).toBe(FALLBACK_REASON_INVOCATION_ERROR);
    expect(view.model).toBeNull();
    // 全表の全行に、鍵らしい文字列が無い
    for (const table of ["analyses", "analysis_horses", "analysis_allocation_meta", "analysis_bets"]) {
      const rows = (await local.db.prepare(`SELECT * FROM ${table}`).all()).results;
      expect(JSON.stringify(rows), table).not.toContain("sk-ant-");
      expect(JSON.stringify(rows), table).not.toContain("SECRET");
    }
    // 補正は無く、prior のまま
    expect(view.horses.every((h) => h.adjustedProb === h.prior)).toBe(true);
  });

  it("LLM が成功: llm_note は NULL(理由なし)。モデルが残り、補正後の確率・印・根拠が API の応答に載る", async () => {
    const llm: CloudLlm = { sender: async () => ok(llmJson()) };
    const { id, view } = await runPreRace(llm);
    expect(await rowOf(id)).toMatchObject({ model: "claude-sonnet-5-5", note: null });
    expect(view.llmNote).toBeNull();
    expect(view.model).toBe("claude-sonnet-5-5");
    expect(view.horses.find((h) => h.umaban === 1)).toMatchObject({ mark: "◎", reason: "根拠1" });
    expect(view.horses.some((h) => h.adjustedProb !== h.prior)).toBe(true);
  });

  it("保存の失敗の再試行(D1 の一時的な失敗)でも、理由は1回だけ保存され、LLM は二重に送られない(b1 の記録・再生と、b2 の保存の組み合わせ)", async () => {
    let calls = 0;
    const llm: CloudLlm = {
      sender: async () => {
        calls += 1;
        return ok(llmJson());
      },
    };
    let failOnce = true;
    const base = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
    const flaky = {
      ...createAnalysisSink(base),
      async save(record: Parameters<ReturnType<typeof createAnalysisSink>["save"]>[0], extra?: Parameters<ReturnType<typeof createAnalysisSink>["save"]>[1]) {
        if (failOnce) {
          failOnce = false;
          throw new Error("D1 の一時的な失敗");
        }
        return createAnalysisSink(base).save(record, extra);
      },
      findByAnalyzedAt: createAnalysisSink(base).findByAnalyzedAt,
      countChildren: createAnalysisSink(base).countChildren,
    };
    const sql = openNodeSql();
    const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
    const alarm: { at: number | null } = { at: null };
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
      sink: flaky,
      loadSettings: async () => SETTINGS,
      llm,
    });
    await core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await core.runNextStep();
    expect(await core.runNextStep()).toMatchObject({ step: "compute", result: "retry" });
    clock.now = alarm.at!;
    expect(await core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(calls).toBe(1);
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses").first<{ c: number }>())!.c).toBe(1);
    sql.close();
  });
});
