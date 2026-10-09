import { afterEach, describe, expect, it } from "vitest";

import {
  FALLBACK_REASON_INVOCATION_ERROR,
  FALLBACK_REASON_PARSE_ERROR,
  FALLBACK_REASON_REFUSED,
  FALLBACK_REASON_TRUNCATED,
  type AnthropicMessageResponse,
  type AnthropicRequestParams,
  type ModelInfoLite,
} from "@keiba/core/llm";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { buildPreviewText } from "../client/prompt-preview";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { LlmCallRecord } from "../src/llm-calls";
import { LLM_NOTE_MARKS_DROPPED, LLM_NOTE_NO_KEY } from "../src/llm-run";
import type { CloudLlm } from "../src/llm-sender";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #194(#179-b。b1): 発走前の分析(`pre_race`)で LLM を使う。LLM の呼び出しは計算ステップの中(`analyze`)。ゲート・保存先・LLM(sender・モデル一覧)はすべて偽。
 * **実 API には出ない**(sender は偽の関数。SDK も呼ばない)。ストレージは `node:sqlite`。
 * AC: e1 成功 / e2 キー未登録 / e3 API エラー / e4 連続失敗 / e5 切り詰め・拒否・解析失敗・印の救済 / e6 clipVariant / e7 追加指示の切り詰め / e8 朝は LLM なし / e9 モデルの降格 /
 *     e11 分析モデルの設定(Issue #158) /
 *     d4 回数 / d5 記録と再生 / c6 サブリクエスト / 秘密(エラーの本文はどこにも出ない)。
 */

const DATE = "20260628";
const RACE = "202603020211";
const encoder = new TextEncoder();
const SECRET = "sk-ant-SECRET-BODY";

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

interface FakeGate extends GateLike {
  readonly urls: string[];
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const text = fixtureForUrl(url);
      if (text === null) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

interface SaveExtra {
  readonly llmNote: string | null;
  /** LLM を呼んだ1回ごとの記録(Issue #197 段2)。キー未登録は null。 */
  readonly llmCalls?: readonly LlmCallRecord[] | null;
}

/** 保存の追加情報のうち、理由(llmNote)だけを取り出す(llmCalls は別に確かめる。ほかのキーが増えたら、この比較が落ちる)。 */
const noteOnly = (extra: SaveExtra | undefined): { readonly llmNote: string | null } => {
  const { llmCalls: _calls, ...rest } = extra as SaveExtra;
  return rest;
};

interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
  readonly extras: SaveExtra[];
  readonly calls: string[];
  failBeforeSave: number;
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    extras: [],
    calls: [],
    failBeforeSave: 0,
    async save(record, extra) {
      sink.calls.push("save");
      if (sink.failBeforeSave > 0) {
        sink.failBeforeSave -= 1;
        throw new Error("D1 の一時的な失敗");
      }
      sink.saved.push(record);
      sink.extras.push(extra as SaveExtra);
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      sink.calls.push("find");
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      sink.calls.push("count");
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

// ---- 偽の LLM ----

type Script = (callIndex: number, params: AnthropicRequestParams) => AnthropicMessageResponse | Promise<AnthropicMessageResponse>;

interface FakeLlm extends CloudLlm {
  readonly calls: AnthropicRequestParams[];
  listCalls: number;
}

const FIXED_MODEL = "claude-sonnet-5-5";

function fakeLlm(script: Script, models: readonly ModelInfoLite[] = [{ id: FIXED_MODEL, created_at: "2026-01-01T00:00:00Z" }]): FakeLlm {
  const llm: FakeLlm = {
    calls: [],
    listCalls: 0,
    sender: async (params) => {
      const index = llm.calls.length;
      llm.calls.push(params);
      return script(index, params);
    },
    lister: async () => {
      llm.listCalls += 1;
      return models;
    },
  };
  return llm;
}

const ok = (text: string, extra: Partial<AnthropicMessageResponse> = {}): AnthropicMessageResponse => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  model: FIXED_MODEL,
  ...extra,
});

/** 16 頭すべてに同じ place_prob を返す応答。◎ は 1 番だけ(印の制約を満たす)。 */
function llmJson(placeProb: number, markOf: (n: number) => string | null = (n) => (n === 1 ? "◎" : null)): string {
  const horses = Array.from({ length: 16 }, (_, i) => ({ number: i + 1, place_prob: placeProb, reason: `根拠${i + 1}`, mark: markOf(i + 1) }));
  return JSON.stringify({ horses });
}

const apiError = (status: number | undefined, message = `${String(status)} {"error":{"message":"${SECRET}"}}`): Error => Object.assign(new Error(message), status === undefined ? {} : { status });

// ---- ハーネス(race-day-pre-race.test.ts と同じ形) ----

const ALL_ON: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5, includeComboOdds: false };

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  settings: CloudSettings;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(llm: CloudLlm | undefined, settings: CloudSettings = ALL_ON, overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const h = { sql, gate, sink, clock, alarm, warnings, settings } as Harness;
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => h.settings,
    ...(llm === undefined ? {} : { llm }),
    ...overrides,
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

/** 発走前の分析を予約して、取得 → 計算の2ステップを回す(計算の結果を返す)。 */
async function runPreRace(h: Harness) {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  await h.core.runNextStep(); // fetch
  return h.core.runNextStep(); // compute
}

async function drive(h: Harness, max = 20): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i++) {
    const at = h.alarm.at;
    if (at === null) return outcomes;
    h.clock.now = Math.max(h.clock.now, at);
    h.alarm.at = null;
    const outcome = await h.core.runNextStep();
    outcomes.push(outcome.kind === "idle" ? "idle" : `${outcome.mode}:${outcome.step}:${outcome.result}`);
    if (outcome.kind === "idle") return outcomes;
  }
  throw new Error("アラームが止まらない(上限超過)");
}

const responseRows = (h: Harness): number => (h.sql.exec("SELECT COUNT(*) AS n FROM race_day_llm_responses").toArray() as { n: number }[])[0]!.n;
const prRow = (h: Harness) => h.core.getBoard().races.find((r) => r.mode === "pre_race")!;
const promptOf = (llm: FakeLlm, index = 0): string => llm.calls[index]!.messages[0]!.content;

/** 全表(キャッシュを除く)・警告・保存内容の文字列(秘密が出ていないことの検査用)。 */
function everythingVisible(h: Harness): string {
  const tables = ["race_day_meta", "race_day_tasks", "race_day_morning_prior", "race_day_llm_responses"].map((t) => JSON.stringify(h.sql.exec(`SELECT * FROM ${t}`).toArray()));
  return [...tables, JSON.stringify(h.core.getBoard()), JSON.stringify(h.sink.saved), JSON.stringify(h.sink.extras), ...h.warnings].join("\n");
}

describe("e1: LLM が成功すると、補正後の確率・印・根拠・モデルが保存される", () => {
  it("LLM は計算ステップの中だけで呼ぶ(取得ステップでは0回)。応答の補正が EV に効き、モデル・promptVersion・生の応答が記録される。理由は無し", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness(llm);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep(); // fetch
    expect(llm.calls).toHaveLength(0);
    expect(llm.listCalls).toBe(0);
    const gateBefore = h.gate.urls.length;
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(gateBefore); // gate(netkeiba)は0回のまま
    expect(llm.calls).toHaveLength(1);
    expect(llm.listCalls).toBe(1);
    expect(h.sink.saved).toHaveLength(1);
    const record = h.sink.saved[0]!;
    expect(record.model).toBe(FIXED_MODEL);
    expect(record.promptVersion).not.toBeNull();
    expect(record.rawResponse).toContain('"place_prob"');
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: null });
    // LLM を呼んだ1回ごとの記録(Issue #197 段2): 1回・成功・再生ではない
    expect(h.sink.extras[0]!.llmCalls).toHaveLength(1);
    expect(h.sink.extras[0]!.llmCalls![0]).toMatchObject({ ok: true, stopReason: "end_turn", model: FIXED_MODEL, replayed: false, error: null });
    // 前提(空振り防止): 16 頭で、補正が実際に効いている(prior から動いている)
    expect(record.horses).toHaveLength(16);
    const moved = record.horses.filter((x) => x.adjustedProb !== x.prior);
    expect(moved.length).toBeGreaterThan(8);
    expect(record.horses.find((x) => x.umaban === 1)!.mark).toBe("◎");
    expect(record.horses.find((x) => x.umaban === 2)!.reason).toBe("根拠2");
    // EV は補正後の確率から(prior ではなく)計算されている
    const withOdds = record.horses.find((x) => x.placeOddsMin !== null && x.ev !== null)!;
    expect(withOdds.ev!).toBeCloseTo(withOdds.adjustedProb * withOdds.placeOddsMin!, 9);
    expect(withOdds.adjustedProb).not.toBe(withOdds.prior);
    expect(prRow(h)).toMatchObject({ status: "done", analysisId: 1, error: null });
  });

  it("プロンプトに出走馬(16 頭)が入り、同じレースの朝のキャッシュ・オッズが使われている(送るのは user メッセージ1つ)", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.3)));
    const h = harness(llm);
    await runPreRace(h);
    const params = llm.calls[0]!;
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]!.role).toBe("user");
    expect(promptOf(llm)).toContain("place_prob");
    expect(params.model).toBe(FIXED_MODEL);
  });
});

describe("e2: API キーが未登録(llm なし)なら、LLM なしで保存し、理由を残す", () => {
  it("prior のまま・モデル null・promptVersion null。理由は固定文言(未登録)。分析は止まらず done", async () => {
    const h = harness(undefined);
    expect(await runPreRace(h)).toMatchObject({ result: "ok" });
    const record = h.sink.saved[0]!;
    expect(record.model).toBeNull();
    expect(record.promptVersion).toBeNull();
    expect(record.rawResponse).toBeNull();
    expect(record.horses.every((x) => x.adjustedProb === x.prior)).toBe(true);
    expect(record.horses.every((x) => x.mark === null)).toBe(true);
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: LLM_NOTE_NO_KEY });
    expect(h.sink.extras[0]!.llmCalls).toBeNull(); // LLM を呼んでいない(Issue #197 段2: 記録なし)
    expect(prRow(h)).toMatchObject({ status: "done", error: null });
  });
});

describe("e3: API のエラー(spend limit・認証・過負荷・タイムアウト・接続)でも止めず、prior で保存する", () => {
  it.each([[401], [402], [429], [500], [529], [undefined]])("status=%s: sender は2回(analyzeRace の2試行)で、prior・モデル null・固定の理由。エラーの本文・鍵はどこにも出ない", async (status) => {
    const llm = fakeLlm(() => {
      throw apiError(status);
    });
    const h = harness(llm);
    const outcome = await runPreRace(h);
    expect(outcome).toMatchObject({ step: "compute", result: "ok" });
    expect(llm.calls).toHaveLength(2); // d4: 解析の再送の1回だけ(SDK の内部再試行は無い)
    const record = h.sink.saved[0]!;
    expect(record.horses.every((x) => x.adjustedProb === x.prior)).toBe(true);
    expect(record.model).toBeNull();
    expect(record.rawResponse).toBeNull();
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: FALLBACK_REASON_INVOCATION_ERROR });
    // 失敗した2回の呼び出しが、どちらも記録される(Issue #197 段2)。説明は status(または種別)だけ
    expect(h.sink.extras[0]!.llmCalls!.map((c) => [c.ok, c.replayed])).toEqual([[false, false], [false, false]]);
    expect(h.sink.extras[0]!.llmCalls!.every((c) => (status === undefined ? /^種別=/.test(c.error ?? "") : c.error === `status=${status}`))).toBe(true);
    expect(prRow(h)).toMatchObject({ status: "done", error: null });
    // 診断ログは status(または種別)だけ。鍵・本文は出ない
    expect(h.warnings.some((w) => (status === undefined ? w.includes("種別=") : w.includes(`status=${status}`)))).toBe(true);
    expect(everythingVisible(h)).not.toContain("sk-ant-");
    expect(everythingVisible(h)).not.toContain("SECRET");
  });
});

describe("e4: 連続して失敗しても壊れない(#166 の自動実行で多数のレースが続けて失敗する状況)", () => {
  it("同じ DO で5回続けて失敗しても、毎回 done で prior のまま保存され、DO の状態・記録は溜まらない", async () => {
    const llm = fakeLlm(() => {
      throw apiError(429);
    });
    const h = harness(llm);
    for (let i = 0; i < 5; i++) {
      await runPreRace(h);
      h.clock.now += 5 * 60_000;
    }
    expect(h.sink.saved).toHaveLength(5);
    expect(h.sink.saved.every((r) => r.horses.every((x) => x.adjustedProb === x.prior))).toBe(true);
    expect(llm.calls).toHaveLength(10); // 毎回2回
    expect(prRow(h)).toMatchObject({ status: "done" });
    expect(responseRows(h)).toBe(0);
    expect(new Set(h.sink.saved.map((r) => r.analyzedAt)).size).toBe(5);
  });
});

describe("e5: 切り詰め・拒否・解析失敗・印の救済", () => {
  it.each([
    ["切り詰め(max_tokens)", () => ok("途中", { stop_reason: "max_tokens" }), FALLBACK_REASON_TRUNCATED],
    ["拒否(refusal)", () => ok("", { stop_reason: "refusal" }), FALLBACK_REASON_REFUSED],
    ["JSON として読めない応答", () => ok("これは JSON ではありません"), FALLBACK_REASON_PARSE_ERROR],
  ])("%s: 2回(再送の1回)で諦め、prior で保存。理由は固有の固定文言。モデルは null", async (_name, script, reason) => {
    const llm = fakeLlm(script);
    const h = harness(llm);
    await runPreRace(h);
    expect(llm.calls).toHaveLength(2);
    const record = h.sink.saved[0]!;
    expect(record.horses.every((x) => x.adjustedProb === x.prior)).toBe(true);
    expect(record.model).toBeNull();
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: reason });
    expect(prRow(h)).toMatchObject({ status: "done", error: null });
  });

  it("1回目が解析できず、2回目が正しければ、2回目を採用する(LLM は効いている・理由なし)", async () => {
    const llm = fakeLlm((i) => (i === 0 ? ok("壊れた応答") : ok(llmJson(0.99))));
    const h = harness(llm);
    await runPreRace(h);
    expect(llm.calls).toHaveLength(2);
    expect(h.sink.saved[0]!.model).toBe(FIXED_MODEL);
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: null });
    expect(h.sink.saved[0]!.horses.some((x) => x.adjustedProb !== x.prior)).toBe(true);
  });

  it("印の制約違反が続いたとき(◎が16頭)は、確率の補正は採用し、印は付けない。LLM は効いている(モデルは保存)・理由は印の救済の固定文", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99, () => "◎")));
    const h = harness(llm);
    await runPreRace(h);
    expect(llm.calls).toHaveLength(2);
    const record = h.sink.saved[0]!;
    expect(record.model).toBe(FIXED_MODEL);
    expect(record.horses.every((x) => x.mark === null)).toBe(true);
    expect(record.horses.some((x) => x.adjustedProb !== x.prior)).toBe(true);
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: LLM_NOTE_MARKS_DROPPED });
  });
});

describe("e6: clipVariant の id と maxAdjust は、1回の解決から両方に渡る", () => {
  async function runWith(clipVariant: "default" | "wide15") {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness(llm, { ...ALL_ON, clipVariant });
    await runPreRace(h);
    return { llm, record: h.sink.saved[0]! };
  }

  it("default: プロンプトの許容幅は ±10%、補正は prior+0.10 にクリップされる", async () => {
    const { llm, record } = await runWith("default");
    expect(promptOf(llm)).toContain("±10%(絶対値0.10)");
    expect(promptOf(llm)).not.toContain("±15%(絶対値0.15)");
    const low = record.horses.filter((x) => x.prior < 0.85);
    expect(low.length).toBeGreaterThan(8); // 前提(空振り防止): 差を見られる馬が十分いる
    for (const x of low) expect(x.adjustedProb - x.prior, `馬番${x.umaban}`).toBeCloseTo(0.1, 9);
  });

  it("wide15: プロンプトの許容幅は ±15%、補正は prior+0.15 までクリップ(同じ応答で、default と幅が違う)。promptVersion も default と違う", async () => {
    const wide = await runWith("wide15");
    const normal = await runWith("default");
    expect(promptOf(wide.llm)).toContain("±15%(絶対値0.15)");
    expect(promptOf(wide.llm)).not.toContain("±10%(絶対値0.10)");
    const low = wide.record.horses.filter((x) => x.prior < 0.8);
    expect(low.length).toBeGreaterThan(8);
    for (const x of low) expect(x.adjustedProb - x.prior, `馬番${x.umaban}`).toBeCloseTo(0.15, 9);
    expect(wide.record.promptVersion).not.toBe(normal.record.promptVersion);
  });
});

describe("e7: 追加指示は 2,000 UTF-16 単位で切る(組み立て側。サロゲートペアを割らない)", () => {
  async function runWithInstruction(additionalInstruction: string) {
    const llm = fakeLlm(() => ok(llmJson(0.3)));
    const h = harness(llm, { ...ALL_ON, additionalInstruction });
    await runPreRace(h);
    return { llm, h, record: h.sink.saved[0]! };
  }

  it("2,000 単位ちょうどは切らない(プロンプトと保存に全部入る。警告なし)", async () => {
    const text = "あ".repeat(2000);
    const { llm, h, record } = await runWithInstruction(text);
    expect(promptOf(llm)).toContain(text);
    expect(record.additionalInstruction).toBe(text);
    expect(h.warnings.some((w) => w.includes("追加指示"))).toBe(false);
  });

  it("D1 へ直接入れた長い値(読む側に上限は無い)は、2,000 単位に切って送る。切ったことを警告に出す", async () => {
    const { llm, h, record } = await runWithInstruction("あ".repeat(5000));
    expect(promptOf(llm)).toContain("あ".repeat(2000));
    expect(promptOf(llm)).not.toContain("あ".repeat(2001));
    expect(record.additionalInstruction).toBe("あ".repeat(2000));
    expect(h.warnings.some((w) => w.includes("追加指示") && w.includes("2000"))).toBe(true);
  });

  it("2,000 単位目がサロゲートペアの途中なら、ペアごと落とす(プロンプトにも保存にも、孤立したサロゲートが無い)", async () => {
    const input = `${"あ".repeat(1999)}😀`;
    const { llm, record } = await runWithInstruction(input);
    expect(promptOf(llm)).toContain("あ".repeat(1999));
    expect(promptOf(llm)).not.toContain("😀");
    expect(record.additionalInstruction).toBe("あ".repeat(1999));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(promptOf(llm))).toBe(false);
  });

  it("追加指示が空なら、プロンプトに追加指示のブロックが入らず、保存も null", async () => {
    const { record } = await runWithInstruction("");
    expect(record.additionalInstruction).toBeNull();
  });
});

describe("e10: 設定画面のプレビューの文面は、実際に LLM へ渡った prompt と一致する(Issue #201)", () => {
  /** 【予想印】から末尾まで(追加指示のブロック・出力スキーマ)。レースの値に依らない部分なので、プレビュー(サンプルレース)と実送信(実レース)で同じになるはず。 */
  const fromMarks = (prompt: string): string => prompt.slice(prompt.indexOf("【予想印】"));
  /** 【指示】の許容幅の行(クリップ幅の版でだけ変わる)。 */
  const clipLineOf = (prompt: string): string | undefined => prompt.split("\n").find((line) => line.startsWith("補正は各馬の 3着内率"));

  const cases: { name: string; instruction: string; clipVariant: "default" | "wide15" }[] = [
    { name: "2,100 単位の追加指示(D1 へ直接入れた長い値)・wide15", instruction: "あ".repeat(2100), clipVariant: "wide15" },
    { name: "前後に空白・改行を含む追加指示・default", instruction: "  前後に空白  \n二行目  ", clipVariant: "default" },
    { name: "追加指示が空・wide15", instruction: "", clipVariant: "wide15" },
    { name: "2,000 単位目がサロゲートペアの途中・default", instruction: `${"あ".repeat(1999)}😀`, clipVariant: "default" },
  ];

  it.each(cases)("$name", async ({ instruction, clipVariant }) => {
    const llm = fakeLlm(() => ok(llmJson(0.3)));
    const h = harness(llm, { ...ALL_ON, additionalInstruction: instruction, clipVariant });
    await runPreRace(h);
    expect(llm.calls).toHaveLength(1); // 前提: 実際に LLM へ送られた
    const sent = promptOf(llm);
    const preview = buildPreviewText({ additionalInstruction: instruction, clipVariant }).text;
    expect(sent.indexOf("【予想印】"), "前提(送信側)").toBeGreaterThan(0);
    expect(preview.indexOf("【予想印】"), "前提(プレビュー側)").toBeGreaterThan(0);
    expect(fromMarks(preview)).toBe(fromMarks(sent));
    expect(clipLineOf(sent), "前提: 許容幅の行を拾えている").toBeDefined();
    expect(clipLineOf(preview)).toBe(clipLineOf(sent));
    expect(clipLineOf(preview)).toContain(clipVariant === "wide15" ? "±15%" : "±10%");
  });

  it("前提(空振り防止): 長い追加指示では、送信もプレビューも 2,000 単位に切っている(切らない文面とは違う)。空なら両方とも追加指示のブロックが無い", async () => {
    const long = "あ".repeat(2100);
    const llm = fakeLlm(() => ok(llmJson(0.3)));
    const h = harness(llm, { ...ALL_ON, additionalInstruction: long });
    await runPreRace(h);
    const preview = buildPreviewText({ additionalInstruction: long, clipVariant: "default" });
    expect(preview.clamped).toBe(true);
    for (const text of [promptOf(llm), preview.text]) {
      expect(text).toContain("あ".repeat(2000));
      expect(text).not.toContain("あ".repeat(2001));
    }
    const llm2 = fakeLlm(() => ok(llmJson(0.3)));
    await runPreRace(harness(llm2, { ...ALL_ON, additionalInstruction: "" }));
    expect(promptOf(llm2)).not.toContain("【追加指示");
    expect(buildPreviewText({ additionalInstruction: "", clipVariant: "default" }).text).not.toContain("【追加指示");
  });
});

describe("e8: 朝(morning)の準備は LLM を使わない", () => {
  it("朝のタスクで、sender もモデル一覧も呼ばない。朝の prior は LLM なし。保存先にも触れない", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness(llm);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    await drive(h);
    expect(llm.calls).toHaveLength(0);
    expect(llm.listCalls).toBe(0);
    expect(h.sink.calls).toEqual([]);
    const prior = h.core.getMorningPrior(RACE);
    expect(prior).not.toBeNull();
    expect(prior!.result.llmUsed).toBe(false);
  });
});

describe("e9: モデルの自動選択と降格(HTTP 400/403/404 のときだけ、固定モデルでやり直す)", () => {
  const MODELS: ModelInfoLite[] = [
    { id: "claude-sonnet-9-9", created_at: "2030-01-01T00:00:00Z" },
    { id: FIXED_MODEL, created_at: "2026-01-01T00:00:00Z" },
  ];

  it("最新の Sonnet(9-9)が 404 なら、固定モデルでやり直して成功する。モデル一覧は1回だけで、次のレース(同じ DO)は最初から固定モデル", async () => {
    const llm = fakeLlm((_i, params) => {
      if (params.model === "claude-sonnet-9-9") throw apiError(404);
      return ok(llmJson(0.99), { model: params.model });
    }, MODELS);
    const h = harness(llm);
    await runPreRace(h);
    expect(llm.calls.map((c) => c.model)).toEqual(["claude-sonnet-9-9", FIXED_MODEL]);
    expect(h.sink.saved[0]!.model).toBe(FIXED_MODEL);
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: null });
    h.clock.now += 5 * 60_000;
    await runPreRace(h);
    expect(llm.calls.map((c) => c.model)).toEqual(["claude-sonnet-9-9", FIXED_MODEL, FIXED_MODEL]);
    expect(llm.listCalls).toBe(1); // 一覧の取得は DO の寿命で1回(メモ化。降格も覚えている)
  });

  it("d4: 降格(2回)+ 解析失敗の再送(1回)で、sender は最大の3回(それ以上は送らない)。prior で保存", async () => {
    const llm = fakeLlm((_i, params) => {
      if (params.model === "claude-sonnet-9-9") throw apiError(404);
      return ok("壊れた応答");
    }, MODELS);
    const h = harness(llm);
    await runPreRace(h);
    expect(llm.calls.map((c) => c.model)).toEqual(["claude-sonnet-9-9", FIXED_MODEL, FIXED_MODEL]);
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: FALLBACK_REASON_PARSE_ERROR });
    // 3回の呼び出しがすべて記録される(降格前の 404 の失敗・固定モデルの2回。Issue #197 段2)
    expect(h.sink.extras[0]!.llmCalls!.map((c) => [c.ok, c.error, c.model])).toEqual([[false, "status=404", null], [true, null, FIXED_MODEL], [true, null, FIXED_MODEL]]);
    expect(h.sink.saved[0]!.horses.every((x) => x.adjustedProb === x.prior)).toBe(true);
  });

  it("モデル一覧の取得が失敗しても、固定モデルで続ける(止めない)。一覧のエラーの本文・鍵はログに出ない", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    (llm as { lister: CloudLlm["lister"] }).lister = async () => {
      throw apiError(401);
    };
    const h = harness(llm);
    await runPreRace(h);
    expect(llm.calls.map((c) => c.model)).toEqual([FIXED_MODEL]);
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: null });
    expect(h.warnings.some((w) => w.includes("モデル一覧") && w.includes("status=401"))).toBe(true);
    expect(everythingVisible(h)).not.toContain("sk-ant-");
    expect(everythingVisible(h)).not.toContain("SECRET");
  });

  it("lister を持たない構成(テスト・将来の固定モデル運用)は、一覧を取らず、固定モデルで送る", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness({ sender: llm.sender });
    await runPreRace(h);
    expect(llm.calls.map((c) => c.model)).toEqual([FIXED_MODEL]);
    expect(llm.listCalls).toBe(0);
  });
});

/**
 * e11(Issue #158): 設定画面で選んだ分析モデル(`analysisModel`)に従って、LLM のモデルを選ぶ。
 * 保存するのは具体的な ID でなく系統(auto・sonnet・opus・haiku)で、分析のたびに Models API の一覧からその系統の最新を解決する。
 * auto = 最新の Sonnet(今までと同じ)。選んだモデルが 400/403/404 で拒否されたら、固定モデル(Sonnet)に切り替えて続ける(止めない)。
 * 実 API は使わない(sender・lister は偽)。**リクエストの形(max_tokens・effort・thinking)は系統によらず変えない**。
 */
describe("e11: 分析モデルの設定(auto・sonnet・opus・haiku)に従ってモデルを選ぶ", () => {
  // 3 系統の最新(Opus・Haiku は Sonnet と別の ID)に、旧版・日付付きスナップショットを混ぜた一覧
  const LIST: ModelInfoLite[] = [
    { id: "claude-sonnet-5-5", created_at: "2026-01-01T00:00:00Z" },
    { id: "claude-sonnet-4-6", created_at: "2025-09-01T00:00:00Z" },
    { id: "claude-opus-5-5", created_at: "2026-02-01T00:00:00Z" },
    { id: "claude-opus-4-1", created_at: "2025-08-05T00:00:00Z" },
    { id: "claude-opus-4-1-20250805", created_at: "2025-08-05T00:00:00Z" },
    { id: "claude-haiku-5-5", created_at: "2026-03-01T00:00:00Z" },
    { id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" },
  ];
  const withModel = (analysisModel: CloudSettings["analysisModel"]): CloudSettings => ({ ...ALL_ON, analysisModel });
  const echo: Script = (_i, params) => ok(llmJson(0.99), { model: params.model });
  const sentModels = (llm: FakeLlm): string[] => llm.calls.map((c) => c.model);

  it.each([
    ["auto", "claude-sonnet-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["opus", "claude-opus-5-5"],
    ["haiku", "claude-haiku-5-5"],
  ] as const)("%s を選ぶと、その系統の最新(%s)で送り、実際に応答したモデルが analyses.model に残る。理由は無し", async (id, expected) => {
    const llm = fakeLlm(echo, LIST);
    const h = harness(llm, withModel(id));
    await runPreRace(h);
    expect(sentModels(llm)).toEqual([expected]);
    expect(h.sink.saved[0]!.model).toBe(expected);
    expect(h.sink.extras[0]!.llmCalls![0]).toMatchObject({ ok: true, model: expected });
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: null });
  });

  it("後方互換: analysisModel が無い旧い設定(スナップショット)は auto = 最新の Sonnet で動く", async () => {
    const llm = fakeLlm(echo, LIST);
    const { analysisModel: _omit, ...old } = ALL_ON;
    const h = harness(llm, old as CloudSettings);
    expect("analysisModel" in h.settings).toBe(false); // 前提: 本当に項目が無い設定を渡している
    await runPreRace(h);
    expect(sentModels(llm)).toEqual(["claude-sonnet-5-5"]);
    expect(h.sink.saved[0]!.model).toBe("claude-sonnet-5-5");
  });

  it("リクエストの形は系統によらず同じ(max_tokens 16000・effort low・user 1メッセージ。temperature・thinking は送らない)", async () => {
    const shapes: unknown[] = [];
    for (const id of ["auto", "opus", "haiku"] as const) {
      const llm = fakeLlm(echo, LIST);
      const h = harness(llm, withModel(id));
      await runPreRace(h);
      expect(llm.calls).toHaveLength(1);
      const { model: _model, messages, ...rest } = llm.calls[0]!;
      expect(messages).toHaveLength(1);
      expect(Object.keys(llm.calls[0]!).sort()).toEqual(["max_tokens", "messages", "model", "output_config"]);
      shapes.push(rest);
    }
    expect(shapes[0]).toEqual({ max_tokens: 16000, output_config: { effort: "low" } });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it("設定を変えると、次の分析から別の系統になる(同じ DO)。モデル一覧の取得は系統をまたいで1回だけ", async () => {
    const llm = fakeLlm(echo, LIST);
    const h = harness(llm, withModel("opus"));
    await runPreRace(h);
    for (const id of ["haiku", "sonnet", "opus"] as const) {
      h.settings = withModel(id);
      h.clock.now += 5 * 60_000;
      await runPreRace(h);
    }
    expect(sentModels(llm)).toEqual(["claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(llm.listCalls).toBe(1);
    expect(h.sink.saved.map((r) => r.model)).toEqual(sentModels(llm));
  });

  it.each([400, 403, 404])("選んだ Opus が HTTP %i で拒否されたら、固定モデル(Sonnet)でやり直して分析を続ける。analyses.model には実際のモデルが残り、止まらない", async (status) => {
    const llm = fakeLlm((_i, params) => {
      if (params.model === "claude-opus-5-5") throw apiError(status);
      return ok(llmJson(0.99), { model: params.model });
    }, LIST);
    const h = harness(llm, withModel("opus"));
    await runPreRace(h);
    expect(sentModels(llm)).toEqual(["claude-opus-5-5", FIXED_MODEL]);
    expect(h.sink.saved).toHaveLength(1);
    expect(h.sink.saved[0]!.model).toBe(FIXED_MODEL); // Opus ではなく、実際に応答した固定モデル
    expect(h.sink.saved[0]!.horses.some((x) => x.adjustedProb !== x.prior)).toBe(true); // LLM が効いている(prior のままではない)
    expect(h.sink.extras[0]!.llmCalls!.map((c) => [c.ok, c.model])).toEqual([[false, null], [true, FIXED_MODEL]]);
    expect(h.warnings.some((w) => w.includes("claude-opus-5-5") && w.includes(String(status)) && w.includes("固定モデル"))).toBe(true);
  });

  it("降格は系統単位: Opus が拒否されたあと、Opus を選んだ分析は最初から固定モデル。Haiku を選べば Haiku は使える(Opus の降格が Haiku・Sonnet を巻き込まない)", async () => {
    const llm = fakeLlm((_i, params) => {
      if (params.model === "claude-opus-5-5") throw apiError(404);
      return ok(llmJson(0.99), { model: params.model });
    }, LIST);
    const h = harness(llm, withModel("opus"));
    await runPreRace(h); // opus 404 → 固定
    h.clock.now += 5 * 60_000;
    await runPreRace(h); // opus は降格済み → 最初から固定
    h.settings = withModel("haiku");
    h.clock.now += 5 * 60_000;
    await runPreRace(h);
    h.settings = withModel("auto");
    h.clock.now += 5 * 60_000;
    await runPreRace(h);
    expect(sentModels(llm)).toEqual(["claude-opus-5-5", FIXED_MODEL, FIXED_MODEL, "claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(h.sink.saved.map((r) => r.model)).toEqual([FIXED_MODEL, FIXED_MODEL, FIXED_MODEL, "claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(llm.listCalls).toBe(1);
  });

  it("401・429・500 はモデルのせいではないので降格しない(Opus のまま。解析の再送を含めて Opus で送り、prior で保存する)", async () => {
    for (const status of [401, 429, 500]) {
      const llm = fakeLlm(() => {
        throw apiError(status);
      }, LIST);
      const h = harness(llm, withModel("opus"));
      await runPreRace(h);
      expect(new Set(sentModels(llm)), String(status)).toEqual(new Set(["claude-opus-5-5"]));
      expect(llm.calls.length, String(status)).toBeGreaterThanOrEqual(1);
      expect(h.sink.saved[0]!.model, String(status)).toBeNull(); // LLM が効かなかった(モデルは残さない)
      expect(noteOnly(h.sink.extras[0]), String(status)).toEqual({ llmNote: FALLBACK_REASON_INVOCATION_ERROR });
    }
  });

  it("一覧にその系統が無い(Opus が無い)なら、固定モデルで送って続ける。警告に Opus の名前が出る", async () => {
    const llm = fakeLlm(echo, [{ id: "claude-sonnet-5-5", created_at: "2026-01-01T00:00:00Z" }]);
    const h = harness(llm, withModel("opus"));
    await runPreRace(h);
    expect(sentModels(llm)).toEqual([FIXED_MODEL]);
    expect(h.sink.saved[0]!.model).toBe(FIXED_MODEL);
    expect(h.warnings.some((w) => w.includes("Opus") && w.includes("固定モデル"))).toBe(true);
  });

  it("モデル一覧の取得が失敗しても、Opus を選んだ分析は固定モデルで続ける(止めない)。一覧の取得は系統をまたいで1回、本文・鍵はログに出ない", async () => {
    const llm = fakeLlm(echo);
    let listCalls = 0;
    (llm as { lister: CloudLlm["lister"] }).lister = async () => {
      listCalls += 1;
      throw apiError(401);
    };
    const h = harness(llm, withModel("opus"));
    await runPreRace(h);
    h.settings = withModel("haiku");
    h.clock.now += 5 * 60_000;
    await runPreRace(h);
    expect(sentModels(llm)).toEqual([FIXED_MODEL, FIXED_MODEL]);
    expect(listCalls).toBe(1);
    expect(h.sink.saved).toHaveLength(2);
    expect(everythingVisible(h)).not.toContain("SECRET");
  });

  it("lister を持たない構成は、Opus を選んでいても一覧を取らず固定モデルで送る", async () => {
    const llm = fakeLlm(echo, LIST);
    const h = harness({ sender: llm.sender }, withModel("opus"));
    await runPreRace(h);
    expect(sentModels(llm)).toEqual([FIXED_MODEL]);
    expect(llm.listCalls).toBe(0);
  });

  it("【記録の固定】Opus の応答が max_tokens で切れた場合は、Sonnet のときと同じく LLM が効かなかった扱い(モデルは残さず、理由は切り詰め)。呼び出しの記録には Opus と stop_reason が残る", async () => {
    const llm = fakeLlm((_i, params) => ok("{", { stop_reason: "max_tokens", model: params.model }), LIST);
    const h = harness(llm, withModel("opus"));
    await runPreRace(h);
    expect(new Set(sentModels(llm))).toEqual(new Set(["claude-opus-5-5"]));
    expect(h.sink.saved[0]!.model).toBeNull();
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: FALLBACK_REASON_TRUNCATED });
    const calls = h.sink.extras[0]!.llmCalls!;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c.stopReason === "max_tokens")).toBe(true);
    expect(calls.every((c) => c.model === "claude-opus-5-5")).toBe(true);
  });
});

describe("d5: 応答の記録と再生(アラームは少なくとも1回。保存の失敗の再試行で、LLM を二重に送らない)", () => {
  it("d5-1: 保存に失敗して計算ステップを再試行しても、sender は1回のまま(再試行は記録を再生)。保存された内容は同じ", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness(llm);
    h.sink.failBeforeSave = 1;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep(); // fetch
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "retry" });
    expect(llm.calls).toHaveLength(1);
    expect(responseRows(h)).toBe(1); // 保存の前に記録している
    h.clock.now = h.alarm.at!;
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(llm.calls).toHaveLength(1); // 二重に送っていない
    expect(h.sink.saved).toHaveLength(1);
    expect(h.sink.saved[0]!.model).toBe(FIXED_MODEL);
    expect(h.sink.saved[0]!.horses.some((x) => x.adjustedProb !== x.prior)).toBe(true);
    expect(h.sink.saved[0]!.rawResponse).toContain("根拠1");
    expect(responseRows(h)).toBe(0); // done で消える
  });

  it("d5-2: 1回目が解析できず2回目で成功(記録は2件)。保存の失敗の再試行では、2件とも再生し、送信は合計2回のまま", async () => {
    const llm = fakeLlm((i) => (i === 0 ? ok("壊れた応答") : ok(llmJson(0.99))));
    const h = harness(llm);
    h.sink.failBeforeSave = 1;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(llm.calls).toHaveLength(2);
    expect(responseRows(h)).toBe(2);
    h.clock.now = h.alarm.at!;
    await h.core.runNextStep();
    expect(llm.calls).toHaveLength(2);
    expect(h.sink.saved[0]!.model).toBe(FIXED_MODEL);
  });

  it("d5-2b: 1回目が失敗(例外)・2回目が成功。失敗は記録しない。再試行は、記録済みの成功を最初の呼び出しで再生し、送信は合計2回のまま", async () => {
    const llm = fakeLlm((i) => {
      if (i === 0) throw apiError(500);
      return ok(llmJson(0.99));
    });
    const h = harness(llm);
    h.sink.failBeforeSave = 1;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(llm.calls).toHaveLength(2);
    expect(responseRows(h)).toBe(1); // 成功の1件だけ
    h.clock.now = h.alarm.at!;
    await h.core.runNextStep();
    expect(llm.calls).toHaveLength(2);
    expect(h.sink.saved).toHaveLength(1);
    expect(h.sink.saved[0]!.model).toBe(FIXED_MODEL);
  });

  it("d5-3: あらためて予約した(新しい実行)ときは、前の実行の記録を消す(新しい分析として、実際に送る)", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness(llm);
    await runPreRace(h);
    expect(llm.calls).toHaveLength(1);
    // 前の実行の記録が(消し損ねて)残っていた状況
    h.sql.exec("INSERT INTO race_day_llm_responses (race_id, mode, seq, response_json) VALUES (?, 'pre_race', 0, ?)", RACE, JSON.stringify({ content: [{ type: "text", text: "古い応答" }], stop_reason: "end_turn", model: "古い" }));
    expect(responseRows(h)).toBe(1);
    h.clock.now += 5 * 60_000;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(responseRows(h)).toBe(0);
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(llm.calls).toHaveLength(2); // 古い記録を再生せず、実際に送った
    expect(h.sink.saved[1]!.model).toBe(FIXED_MODEL);
  });

  it("記録は、タスクが failed になったときにも消える(保存の失敗が続いて上限で諦めた)", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness(llm);
    h.sink.failBeforeSave = 99;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    const outcomes = await drive(h);
    expect(outcomes.filter((o) => o === "pre_race:compute:failed")).toHaveLength(1);
    expect(llm.calls).toHaveLength(1); // 3回再試行しても、送ったのは1回
    expect(prRow(h)).toMatchObject({ status: "failed" });
    expect(responseRows(h)).toBe(0);
  });

  it("掃除のアラームで、仕事の無い(進行中でない)タスクの孤立した記録を消す。進行中のタスクの記録は残す", async () => {
    const llm = fakeLlm(() => ok(llmJson(0.99)));
    const h = harness(llm);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await drive(h); // done まで進め、掃除のアラームまで回す
    h.sql.exec("INSERT INTO race_day_llm_responses (race_id, mode, seq, response_json) VALUES ('202603020299', 'pre_race', 0, '{}')");
    expect(responseRows(h)).toBe(1);
    // 掃除の時刻を直接起こす
    h.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('purge_due_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(h.clock.now));
    expect(await h.core.runNextStep()).toMatchObject({ kind: "idle" });
    expect(responseRows(h)).toBe(0);
  });
});

describe("秘密: API のエラーの本文・鍵は、画面(board)・D1(保存内容)・タスク行・ログのどこにも出ない", () => {
  it("sender のエラーの本文に鍵らしい文字列が入っていても、DO の全表・board・保存内容・警告のどこにも現れない", async () => {
    const llm = fakeLlm(() => {
      throw apiError(429, `429 {"type":"error","error":{"message":"rate limited ${SECRET}"}}`);
    });
    (llm as { lister: CloudLlm["lister"] }).lister = async () => {
      throw apiError(401, `401 {"message":"invalid x-api-key ${SECRET}"}`);
    };
    const h = harness(llm);
    await runPreRace(h);
    const visible = everythingVisible(h);
    expect(visible).not.toContain("sk-ant-");
    expect(visible).not.toContain("SECRET");
    expect(visible).not.toContain("rate limited");
    expect(visible).not.toContain("x-api-key");
    // 前提(空振り防止): 失敗は実際に起きていて、ログには status が残る
    expect(h.warnings.some((w) => w.includes("status=429"))).toBe(true);
    expect(h.warnings.some((w) => w.includes("status=401"))).toBe(true);
    expect(h.sink.saved).toHaveLength(1);
  });

  it("解析できない応答(本文に鍵らしい文字列)の診断も、ログに出さない(core の diagnosticMessage は使わない)", async () => {
    const llm = fakeLlm(() => ok(`これは JSON ではありません ${SECRET}`));
    const h = harness(llm);
    await runPreRace(h);
    expect(noteOnly(h.sink.extras[0])).toEqual({ llmNote: FALLBACK_REASON_PARSE_ERROR });
    expect(h.warnings.join("\n")).not.toContain("sk-ant-");
    expect(h.warnings.join("\n")).not.toContain("SECRET");
    // 保存内容(rawResponse は prior 採用のときは null)にも出ない
    expect(JSON.stringify(h.sink.saved)).not.toContain("SECRET");
  });
});

describe("c6: サブリクエストの数(LLM を含めても、1回の呼び出しで 45 未満。gate は0回)", () => {
  it("最悪(モデルの降格 + 解析失敗の再送)でも、sender 3 + 一覧 1 + 保存先 3 = 7。gate は0回", async () => {
    const llm = fakeLlm((_i, params) => {
      if (params.model === "claude-sonnet-9-9") throw apiError(404);
      return ok("壊れた応答");
    }, [{ id: "claude-sonnet-9-9", created_at: "2030-01-01T00:00:00Z" }]);
    const h = harness(llm);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    const gateBefore = h.gate.urls.length;
    h.sink.calls.length = 0;
    await h.core.runNextStep();
    expect(h.gate.urls).toHaveLength(gateBefore);
    expect(llm.calls).toHaveLength(3);
    expect(llm.listCalls).toBe(1);
    expect(h.sink.calls).toEqual(["find", "save", "count"]);
    expect(llm.calls.length + llm.listCalls + h.sink.calls.length).toBeLessThan(45);
  });
});
