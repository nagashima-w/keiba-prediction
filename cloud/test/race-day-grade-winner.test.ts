import { afterEach, describe, expect, it } from "vitest";

import type { AnthropicMessageResponse, AnthropicRequestParams, ModelInfoLite } from "@keiba/core/llm";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { collectGradeWinnerTrend } from "../../packages/core/src/analyzer/grade-winner-trend";
import { gradeWinnerCacheKey } from "../../packages/core/src/scraper/fetch-grade-winner";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import type { GatePostRequest, GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { CloudLlm } from "../src/llm-sender";
import { RaceDayCore, type AnalysisSink } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl, GRADE_WINNER_RESPONSE, loadFixture } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #181 段階2(AC-5): 重賞の「同レース過去10年傾向」を、発走前の分析に入れる配線。
 *  - POST は**取得ステップ**で、出馬表に重賞のバッジがある(`hasGradeBadge !== false`)ときだけ、LLM を使う構成のときだけ、1 本。結果は DO のキャッシュに載る。
 *  - **計算ステップは netkeiba に出ない**(gate は GET も POST も 0 回)。キャッシュだけを引いて、基準日(分析日。#153)を素通しする。
 *  - POST の失敗(拒否・`post-blocked`・通信の失敗・壊れた応答)は、取得ステップの失敗にしない。警告を残して、傾向なしで保存まで進む。
 *  - 同じレースを再実行しても POST は増えない(キャッシュ。壊れた応答は残さない)。
 * ゲートは偽(出馬表は実フィクスチャ。POST は重賞の実フィクスチャ)。実ネットワークには出ない。
 */

const DATE = "20260628";
const RACE = "202603020211"; // 出馬表に重賞のバッジがある(フィクスチャ)
const BLOCK_HEADING = "同レース過去傾向(";
const FIXED_MODEL = "claude-sonnet-5-5";
const SETTINGS: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5, includeComboOdds: false };

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (body: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(body), queuedMs: 0, elapsedMs: 1 });

/** 出馬表から重賞のバッジ(`Icon_GradeType`)だけを除いたもの(非重賞のレースの出馬表として使う)。 */
const SHUTUBA_WITHOUT_BADGE = (): string => loadFixture("shutuba_202603020211.html").replaceAll("Icon_GradeType", "Icon_Other");

interface FakeGate extends GateLike {
  readonly urls: string[];
  readonly posts: GatePostRequest[];
  /** POST の応答(既定は重賞の実フィクスチャ)。 */
  postHandler: (request: GatePostRequest) => GateResult | Promise<GateResult>;
  /** 出馬表を非重賞にする。 */
  badge: boolean;
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    posts: [],
    badge: true,
    postHandler: () => ok(GRADE_WINNER_RESPONSE()),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const body = url.includes("shutuba.html") && !gate.badge ? SHUTUBA_WITHOUT_BADGE() : fixtureForUrl(url);
      return ok(body);
    },
    async postRaw(request): Promise<GateResult> {
      gate.posts.push(request);
      await Promise.resolve();
      return gate.postHandler(request);
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
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: ReturnType<typeof fakeSink>;
  readonly llm: FakeLlm | undefined;
  readonly warnings: string[];
}
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(options: { llm?: boolean } = {}): Harness {
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
  });
  return { core, sql, gate, sink, llm, warnings };
}

interface Counts {
  readonly gets: number;
  readonly posts: number;
}
const counts = (h: Harness): Counts => ({ gets: h.gate.urls.length, posts: h.gate.posts.length });

/** pre_race を予約して取得 → 計算を進める。各ステップの結果と、取得ステップの後・計算ステップの後の gate の呼び出し数を返す。 */
async function runPreRace(h: Harness, raceId: string = RACE, kaisaiDate: string = DATE) {
  await h.core.schedule({ raceId, kaisaiDate, mode: "pre_race" });
  const fetchOutcome = await h.core.runNextStep();
  const afterFetch = counts(h);
  const computeOutcome = await h.core.runNextStep();
  const afterCompute = counts(h);
  const label = (o: typeof fetchOutcome): string => (o.kind === "idle" ? "idle" : `${o.mode}:${o.step}:${o.result}`);
  return { fetch: label(fetchOutcome), compute: label(computeOutcome), afterFetch, afterCompute };
}

/** 期待する傾向の行。実フィクスチャを、分析日(開催日 2026/06/28。#153 の基準日)で `collectGradeWinnerTrend` に通して作る(実装の組み立てとは独立)。 */
async function expectedBlockLine(cutoffDate: string, raceId: string = RACE): Promise<string | null> {
  // 条件は出馬表のコース(芝・距離)と race_id の場コード。出馬表を実装と別に読む。
  const { parseShutuba } = await import("../../packages/core/src/scraper/parse-shutuba");
  const race = parseShutuba(loadFixture("shutuba_202603020211.html")).race;
  const summary = await collectGradeWinnerTrend(
    parseRaceId(raceId),
    { trackCode: raceId.slice(4, 6), track: race.courseType, kyori: race.distance },
    cutoffDate,
    { fetcher: { fetchText: async () => GRADE_WINNER_RESPONSE() } },
  );
  return summary === null ? null : `${BLOCK_HEADING}対象${summary.対象回数}回中 条件一致${summary.条件一致回数}回・除外${summary.条件除外回数}回)`;
}

describe("重賞(バッジあり)の発走前の分析", () => {
  it("取得ステップで POST が 1 本だけ出て(core が組み立てた宛先・Referer・Origin・本文)、計算ステップは gate を 1 回も呼ばない。傾向がプロンプトに入る", async () => {
    const h = harness();
    const r = await runPreRace(h);
    expect(r.fetch).toBe("pre_race:fetch:ok");
    expect(r.compute).toBe("pre_race:compute:ok");
    expect(r.afterFetch.posts).toBe(1);
    expect(h.gate.posts[0]).toEqual({
      url: "https://race.netkeiba.com/race_api/",
      referer: "https://race.netkeiba.com/race/past10.html?race_id=202603020211",
      origin: "https://race.netkeiba.com",
      body: "input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=202603020211",
    });
    // 計算ステップ: GET も POST も増えない(netkeiba に出ない)
    expect(r.afterCompute).toEqual(r.afterFetch);
    expect(h.sink.saved).toHaveLength(1);
    expect(promptOf(h.llm!)).toContain((await expectedBlockLine("2026/06/28"))!);
    // 結果は DO のキャッシュに、レースごとのキーで載っている
    const rows = h.sql.exec("SELECT key FROM fetch_cache WHERE key = ?", gradeWinnerCacheKey(parseRaceId(RACE))).toArray();
    expect(rows).toHaveLength(1);
  });

  it("基準日(分析日)を素通しする: 2024 年の回(202403020211。2024/06/30 開催)を、その開催日で分析すると、当該回と、基準日以降の 2025 年の回が傾向から除かれる。基準日が違えば数字が変わる", async () => {
    const RACE_2024 = "202403020211";
    const withCutoff = await expectedBlockLine("2024/06/30", RACE_2024);
    const otherCutoff = await expectedBlockLine("2026/06/28", RACE_2024); // 基準日が今日(2026 年)なら、2025 年の回は残る
    expect(withCutoff).not.toBeNull();
    expect(otherCutoff).not.toBeNull();
    expect(withCutoff).not.toBe(otherCutoff); // 前提: 基準日の違いが、このフィクスチャでは数字の違いになる
    const h = harness();
    const r = await runPreRace(h, RACE_2024, "20240630");
    expect(r.compute).toBe("pre_race:compute:ok");
    const prompt = promptOf(h.llm!);
    expect(prompt).toContain(withCutoff!);
    expect(prompt).not.toContain(otherCutoff!);
  });

  it("同じレースの再実行(done のあとに予約し直す)でも、POST は増えない(キャッシュ)。取得ステップごとに GET のオッズなどは取り直すが、POST は 1 本のまま", async () => {
    const h = harness();
    await runPreRace(h);
    expect(h.gate.posts).toHaveLength(1);
    const again = await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(again).toMatchObject({ accepted: true });
    const getsBefore = h.gate.urls.length;
    const fetchOutcome = await h.core.runNextStep();
    expect(fetchOutcome).toMatchObject({ step: "fetch", result: "ok" });
    expect(h.gate.urls.length).toBeGreaterThan(getsBefore); // 前提: 2 回目の取得ステップも GET は出ている(空振りでない)
    await h.core.runNextStep();
    expect(h.gate.posts).toHaveLength(1);
    expect(h.sink.saved).toHaveLength(2);
  });
});

describe("POST が出ない場合", () => {
  it("非重賞(出馬表にバッジが無い)は POST を出さず、傾向もプロンプトに入らない。分析は保存まで進む", async () => {
    const h = harness();
    h.gate.badge = false;
    const r = await runPreRace(h);
    expect(r.fetch).toBe("pre_race:fetch:ok");
    expect(r.compute).toBe("pre_race:compute:ok");
    expect(h.gate.posts).toHaveLength(0);
    expect(promptOf(h.llm!)).not.toContain(BLOCK_HEADING);
    expect(h.sink.saved).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("過去10年傾向"))).toEqual([]);
  });

  it("対照: 同じ構成でバッジがあれば POST が出る(上のテストが、バッジの有無だけで分かれていることの確認)", async () => {
    const h = harness();
    await runPreRace(h);
    expect(h.gate.posts).toHaveLength(1);
  });

  it("LLM を使わない構成(API キー未登録)は、傾向が使われないので POST を出さない。分析は統計だけで保存まで進む", async () => {
    const h = harness({ llm: false });
    const r = await runPreRace(h);
    expect(r.compute).toBe("pre_race:compute:ok");
    expect(h.gate.posts).toHaveLength(0);
    expect(h.sink.saved).toHaveLength(1);
  });
});

describe("POST の失敗は分析を止めない", () => {
  const cases: readonly [string, (gate: FakeGate) => void, RegExp][] = [
    ["netkeiba が 403 で拒否", (g) => (g.postHandler = () => ({ kind: "response", status: 403, contentType: null, body: bytes(""), queuedMs: 0, elapsedMs: 1 })), /403/],
    ["POST のブレーカーが開いている(post-blocked)", (g) => (g.postHandler = () => ({ kind: "refused", reason: "post-blocked", message: "POST を止めています(あと 1800 秒)" })), /POST を止めています/],
    ["GET のブレーカーが開いている(blocked)", (g) => (g.postHandler = () => ({ kind: "refused", reason: "blocked", message: "取得を止めています" })), /取得を止めています/],
    ["通信の失敗(network-error)", (g) => (g.postHandler = () => ({ kind: "refused", reason: "network-error", message: "切断されました" })), /切断されました/],
    ["ゲートの呼び出し自体が例外(RPC の失敗)", (g) => (g.postHandler = () => { throw new Error("DO が落ちた"); }), /DO が落ちた/],
  ];
  it.each(cases)("%s: 取得ステップは失敗にならず、原因つきの警告を残し、計算ステップも保存まで進む(傾向なし)", async (_label, arrange, cause) => {
    const h = harness();
    arrange(h.gate);
    const r = await runPreRace(h);
    expect(r.fetch).toBe("pre_race:fetch:ok");
    expect(r.compute).toBe("pre_race:compute:ok");
    expect(h.gate.posts).toHaveLength(1);
    expect(r.afterCompute).toEqual(r.afterFetch); // 計算ステップは POST を再送しない
    expect(h.sink.saved).toHaveLength(1);
    expect(promptOf(h.llm!)).not.toContain(BLOCK_HEADING);
    const warning = h.warnings.find((w) => w.includes("取得ステップ") || (w.includes("取得") && w.includes("過去10年傾向")));
    expect(warning, h.warnings.join("\n")).toBeDefined();
    expect(warning).toMatch(cause);
    // 計算ステップの警告(キャッシュに無かった)も残る
    expect(h.warnings.some((w) => w.includes(`発走前の分析(${RACE})`) && w.includes("傾向なしで続けます"))).toBe(true);
  });

  it("壊れた応答(200 だが JSON でない)は、キャッシュに残さない: 取得ステップが警告を出し、キャッシュの行は無く、次の取得ステップでもう一度 POST する", async () => {
    const h = harness();
    h.gate.postHandler = () => ok("<html>maintenance</html>");
    const r = await runPreRace(h);
    expect(r.fetch).toBe("pre_race:fetch:ok");
    expect(r.compute).toBe("pre_race:compute:ok");
    expect(h.gate.posts).toHaveLength(1);
    expect(h.sql.exec("SELECT key FROM fetch_cache WHERE key = ?", gradeWinnerCacheKey(parseRaceId(RACE))).toArray()).toHaveLength(0);
    expect(promptOf(h.llm!)).not.toContain(BLOCK_HEADING);
    // 直ったあとの再実行: もう一度 POST して、傾向が入る
    h.gate.postHandler = () => ok(GRADE_WINNER_RESPONSE());
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.gate.posts).toHaveLength(2);
    expect(h.llm!.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.llm!.calls[h.llm!.calls.length - 1]!.messages[0]!.content as string).toContain(BLOCK_HEADING);
  });

  it("警告の原因は redactSecrets を通した先頭 200 文字だけ(API キーの形は伏せ、長い本文は切る)", async () => {
    const h = harness();
    h.gate.postHandler = () => ({ kind: "refused", reason: "bad-response", message: `sk-ant-SECRET123 ${"あ".repeat(500)}` });
    await runPreRace(h);
    const joined = h.warnings.join("\n");
    expect(joined).not.toContain("SECRET123");
    const warning = h.warnings.find((w) => w.includes("sk-ant-***"))!;
    expect(warning).toBeDefined();
    const cause = warning.slice(warning.indexOf("sk-ant-***"));
    expect(cause.length).toBeLessThan(260); // 200 文字 + 閉じ括弧など
    expect(warning).not.toContain("あ".repeat(250));
  });
});
