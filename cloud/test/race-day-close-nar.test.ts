import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { narOddsPageUrl } from "../../packages/core/src/scraper/urls";
import { CLOSE_FINAL_LEAD_MS, CLOSE_FIRST_LEAD_MS, type CloseSavePayload } from "../src/analysis-close";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { parseCloseInput } from "../src/race-day-close";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #379(#335-N): 締切の直前の再計算を地方にも広げる。
 *  - 組合せ OFF: 単勝・複勝のページ(`odds/index.html?type=b1`)の 1 本だけを取り直して配分を作り直す。
 *  - 組合せ ON(部分的な取り直し): 単勝・複勝だけネットワークから取り直し、**組合せは分析時のオッズ**(DO の `fetch_cache` に残っているもの。分析の計算ステップが読んだのと同じ)で配分を作り直す。
 *    組合せのページは 1 本も取りに行かない。キャッシュから分析時のものを読めないときは failed(combo-missing)で、再試行しない。
 * 地方のレースは 202654071210(発走 20:50 JST)。フィクスチャと軸馬別の合成オッズは `race-day-pre-race.test.ts` の地方のケースと同じ。ゲート・保存先は偽、ストレージは `node:sqlite`。
 */

const DATE = "20260712";
const NAR_RACE = "202654071210";
const START_MS = Date.parse("2026-07-12T11:50:00Z"); // 20:50 JST
const DUE1 = START_MS - CLOSE_FIRST_LEAD_MS;
const DUE2 = START_MS - CLOSE_FINAL_LEAD_MS;
const encoder = new TextEncoder();
const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name), "utf-8");

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

/** 軸馬別(3連複 b7)の最小限の合成オッズ(`race-day-pre-race.test.ts` と同じ)。 */
const axisHtml = (axis: number): string => `<div id="odds_view_form"><table class="Odds_Table"><tr><td class="Odds" id="chk_x_b7_c0_${axis}_11_12">900.0</td></tr></table></div>`;
/** 三連単(b8)の軸馬別(同上)。 */
const trifectaAxisHtml = (axis: number): string => {
  const second = axis === 11 ? 12 : 11;
  const third = axis === 1 ? 2 : 1;
  return `<div id="odds_view_form"><table class="Odds_Table"><tr><td class="Odds" id="chk_x_b8_c0_${axis}_${second}_${third}">90000.0</td></tr></table></div>`;
};

/** 地方の応答(分析時)。 */
function narBody(url: string): string {
  if (url.includes("shutuba.html")) return fixture("nar_shutuba_202654071210.html");
  if (url.includes("ajax_horse_results")) return fixture("horse_results_2021104387.json");
  if (url.includes("odds_get_form.html")) {
    const axis = Number(/[?&]jiku=(\d+)/.exec(url)![1]);
    return url.includes("type=b8") ? trifectaAxisHtml(axis) : axisHtml(axis);
  }
  if (url.includes("type=b1&")) return fixture("nar_odds_b1_202654071210.html");
  if (url.includes("type=b4&")) return fixture("nar_odds_b4_202654071210.html");
  if (url.includes("type=b5&")) return fixture("nar_odds_b5_202654071210.html");
  if (url.includes("type=b6&")) return fixture("nar_odds_b6_202654071210.html");
  if (url.includes("type=b7&")) return fixture("nar_odds_b7_202654071210.html");
  if (url.includes("type=b3&")) return `<div id="odds_view_form"></div>`;
  throw new Error(`未知のURL(NAR): ${url}`);
}

/** 単勝・複勝のページの数値(単勝の倍率と複勝の下限・上限)を factor 倍にする(最後の動きの想定)。1.1 を下回らない。 */
function scaledB1(factor: number): string {
  const scale = (v: string): string => Math.max(1.1, Math.round(Number(v) * factor * 10) / 10).toFixed(1);
  return fixture("nar_odds_b1_202654071210.html").replace(/<span class="Odds ">([^<]*)<\/span>/g, (_m, text: string) => {
    const parts = text.split(" - ");
    return `<span class="Odds ">${parts.map(scale).join(" - ")}</span>`;
  });
}

interface FakeGate extends GateLike {
  readonly urls: string[];
  body: (url: string) => string | null;
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    body: narBody,
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const text = gate.body(url);
      if (text === null) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
  readonly closes: { readonly analysisId: number; readonly payload: CloseSavePayload }[];
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    closes: [],
    async save(record) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
    async saveClose(analysisId, payload) {
      sink.closes.push({ analysisId, payload });
    },
  };
  return sink;
}

const SETTINGS_ON: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  // Issue #470: このファイルは地方の部分的な取り直し(取得の本数・組合せの買い目の再現)を調べる。既定の下限(0.05)は三連複・三連単の買い目をほぼ全て外してしまい、
  // 『分析時の配分に組合せの買い目が入る』前提が成り立たなくなるので、下限なしにする(下限そのものは race-day-close.test.ts と min-hit-prob 系のテストが調べる)。
  minHitProb: 0,
  includeComboOdds: true,
  baseScoreWeightJockey: 0, // 騎手の成績を取らない(取得の本数を固定する。race-day-close.test.ts と同じ理由)
  baseScoreWeightTrainer: 0,
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly warnings: string[];
  settings: CloudSettings;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(settings: CloudSettings): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-07-12T09:00:00Z") };
  const warnings: string[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const h = { sql, gate, sink, clock, warnings, settings } as Harness;
  (h as { core: RaceDayCore }).core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: () => {},
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => h.settings,
  });
  return h;
}

/** 発走前の分析(手動)を、取得 → 地方三連単の段階 → 計算まで回す(`race-day-pre-race.test.ts` の `narFetchThenCompute` と同じ段取り。組合せ OFF なら段階は無い)。 */
async function analyze(h: Harness): Promise<void> {
  await h.core.schedule({ raceId: NAR_RACE, kaisaiDate: DATE, mode: "pre_race" });
  for (let i = 0; i < 6; i++) {
    const out = await h.core.runNextStep();
    if (out.kind === "ran" && out.mode === "pre_race" && out.step === "compute") {
      expect(out.result).toBe("ok");
      return;
    }
  }
  throw new Error("計算ステップに到達しませんでした");
}

type CloseOutcome = Extract<StepOutcome, { mode: "close" }>;

async function fire(h: Harness, at: number): Promise<CloseOutcome> {
  h.clock.now = at;
  const outcome = await h.core.runNextStep();
  expect(outcome).toMatchObject({ kind: "ran", mode: "close", step: "recompute" });
  return outcome as CloseOutcome;
}

const betTypesOf = (bets: readonly { betType: string }[]): string[] => [...new Set(bets.map((b) => b.betType))].sort();
const b1Url = narOddsPageUrl(parseRaceId(NAR_RACE));
const closeRows = (h: Harness): { round: number; state: string; attempts: number }[] => h.sql.exec("SELECT round, state, attempts FROM race_day_close ORDER BY round").toArray() as never;

describe("締切の直前の再計算(地方・組合せ OFF)", () => {
  it("回 1: 取り直すのは単勝・複勝のページ 1 本だけ。出馬表・戦績には出ない。同じオッズなら分析時の配分と一致する。オッズの時刻は無い(null)", async () => {
    const h = harness({ ...SETTINGS_ON, includeComboOdds: false });
    await analyze(h);
    const base = h.sink.saved[0]!.allocation!;
    expect(base.bets.length).toBeGreaterThan(3); // 前提: 多点
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1 + 4_000)).toMatchObject({ round: 1, result: "ok", reason: null });
    expect(h.gate.urls.slice(before)).toEqual([b1Url]);
    const { analysisId, payload } = h.sink.closes[0]!;
    expect(analysisId).toBe(1);
    expect(payload).toMatchObject({ round: 1, status: "ok", reason: null, dueAtMs: DUE1, firedAtMs: DUE1 + 4_000, lateMs: 4_000, oddsOfficialDatetime: null });
    expect(JSON.stringify(payload.allocation)).toBe(JSON.stringify(base));
  });

  it("オッズが動けば配分が変わる(分析時と違う配分・買い目のオッズ)。回 2 も 1 本だけ取る", async () => {
    const h = harness({ ...SETTINGS_ON, includeComboOdds: false });
    await analyze(h);
    const base = h.sink.saved[0]!.allocation!;
    h.gate.body = (url) => (url.includes("type=b1&") ? scaledB1(1.4) : narBody(url));
    await fire(h, DUE1);
    const before = h.gate.urls.length;
    expect(await fire(h, DUE2)).toMatchObject({ round: 2, result: "ok" });
    expect(h.gate.urls.slice(before)).toEqual([b1Url]);
    const second = h.sink.closes[1]!.payload.allocation!;
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(base));
    const oddsOf = (bets: readonly { betType: string; comboKey: string; odds: number | null }[]) => new Map(bets.map((b) => [`${b.betType}:${b.comboKey}`, b.odds]));
    const baseOdds = oddsOf(base.bets);
    const shared = second.bets.filter((b) => baseOdds.has(`${b.betType}:${b.comboKey}`));
    expect(shared.length).toBeGreaterThan(0); // 前提: 比べられる買い目がある
    expect(shared.some((b) => b.odds !== baseOdds.get(`${b.betType}:${b.comboKey}`))).toBe(true);
  });

  it("出走取消(単勝のセルが非数値)になった馬がいれば failed(horse-set-mismatch)", async () => {
    const h = harness({ ...SETTINGS_ON, includeComboOdds: false });
    await analyze(h);
    h.gate.body = (url) => (url.includes("type=b1&") ? fixture("nar_odds_b1_202654071210.html").replace('<span class="Odds ">24.8</span>', '<span class="Odds ">取消</span>') : narBody(url));
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "horse-set-mismatch" });
  });

  it("発走を過ぎて起きたら too-late(オッズは取らない)", async () => {
    const h = harness({ ...SETTINGS_ON, includeComboOdds: false });
    await analyze(h);
    await fire(h, START_MS);
    const before = h.gate.urls.length;
    expect(await fire(h, START_MS)).toMatchObject({ round: 2, result: "failed", reason: "too-late" });
    expect(h.gate.urls.length).toBe(before);
  });
});

describe("締切の直前の再計算(地方・組合せ ON=部分的な取り直し)", () => {
  /** 組合せのキャッシュ行(単勝・複勝のページ以外の `/odds/` のキー)。 */
  const comboKeys = (h: Harness): string[] => (h.sql.exec("SELECT key FROM fetch_cache WHERE key LIKE '%/odds/%' AND key NOT LIKE '%type=b1&%'").toArray() as { key: string }[]).map((r) => r.key);

  it("回 1: 取るのは単勝・複勝のページ 1 本だけで、組合せのページには出ない。同じオッズなら分析時の配分(組合せの買い目を含む)と一致する", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    const base = h.sink.saved[0]!.allocation!;
    // 前提: 分析時の配分に組合せの買い目が入り、組合せのキャッシュが残っている
    expect(betTypesOf(base.bets)).toEqual(expect.arrayContaining(["trio", "wide", "trifecta"]));
    expect(comboKeys(h).length).toBeGreaterThan(20);
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "ok", reason: null });
    expect(h.gate.urls.slice(before)).toEqual([b1Url]);
    expect(JSON.stringify(h.sink.closes[0]!.payload.allocation)).toBe(JSON.stringify(base));
    expect(closeRows(h)).toEqual([
      { round: 1, state: "done", attempts: 1 },
      { round: 2, state: "pending", attempts: 0 },
    ]);
  });

  it("単勝・複勝だけが動く: 組合せの買い目のオッズは分析時のまま、単勝・複勝の買い目のオッズは新しい値になる", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    const base = h.sink.saved[0]!.allocation!;
    h.gate.body = (url) => (url.includes("type=b1&") ? scaledB1(1.4) : narBody(url));
    await fire(h, DUE1);
    const recalc = h.sink.closes[0]!.payload.allocation!;
    const key = (b: { betType: string; comboKey: string }): string => `${b.betType}:${b.comboKey}`;
    const baseBets = new Map(base.bets.map((b) => [key(b), b]));
    const isCombo = (b: { betType: string }): boolean => b.betType !== "win" && b.betType !== "place";
    const sharedCombo = recalc.bets.filter((b) => isCombo(b) && baseBets.has(key(b)));
    const sharedSingle = recalc.bets.filter((b) => !isCombo(b) && baseBets.has(key(b)));
    expect(sharedCombo.length).toBeGreaterThan(0); // 前提(空振り防止)
    expect(sharedSingle.length).toBeGreaterThan(0);
    for (const b of sharedCombo) expect(b.odds, key(b)).toBe(baseBets.get(key(b))!.odds);
    expect(sharedSingle.some((b) => b.odds !== baseBets.get(key(b))!.odds)).toBe(true);
    expect(JSON.stringify(recalc)).not.toBe(JSON.stringify(base));
  });

  it("回 2 も単勝・複勝の 1 本だけ", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    await fire(h, DUE1);
    const before = h.gate.urls.length;
    expect(await fire(h, DUE2)).toMatchObject({ round: 2, result: "ok" });
    expect(h.gate.urls.slice(before)).toEqual([b1Url]);
  });

  it("分析時の組合せがキャッシュに無い(掃除された・保存されなかった)なら failed(combo-missing)。再試行せず、組合せのページには出ない", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%type=b5&%'");
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "combo-missing" });
    expect(h.gate.urls.slice(before)).toEqual([b1Url]);
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "failed", reason: "combo-missing", allocation: null });
    expect(closeRows(h)[0]).toEqual({ round: 1, state: "done", attempts: 1 });
  });

  it("組合せのキャッシュが取得ステップの開始より古い(前の実行の残り)なら combo-missing", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    h.sql.exec("UPDATE fetch_cache SET fetched_at = fetched_at - 1000 WHERE key LIKE '%type=b5&%'");
    const started = (h.sql.exec("SELECT fetch_started_at AS t FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { t: number }[])[0]!.t;
    const stale = (h.sql.exec("SELECT fetched_at AS t FROM fetch_cache WHERE key LIKE '%type=b5&%'").toArray() as { t: number }[])[0]!.t;
    expect(stale).toBeLessThan(started); // 前提: 本当に取得の開始より古い
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "combo-missing" });
  });

  it("組合せのキャッシュが分析の保存より新しい(分析の後に別の取得で上書きされた)なら combo-missing(分析時のオッズではない)", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    h.sql.exec("UPDATE fetch_cache SET fetched_at = fetched_at + 1000 WHERE key LIKE '%type=b5&%'");
    const input = JSON.parse((h.sql.exec("SELECT input_json FROM race_day_close_input").toArray() as { input_json: string }[])[0]!.input_json) as { comboToMs: number };
    const newer = (h.sql.exec("SELECT fetched_at AS t FROM fetch_cache WHERE key LIKE '%type=b5&%'").toArray() as { t: number }[])[0]!.t;
    expect(newer).toBeGreaterThan(input.comboToMs); // 前提: 本当に上限より新しい
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "combo-missing" });
  });

  it("入力に期間(comboFromMs・comboToMs)が無い(この機能の前に積まれた入力)なら、何も取らずに combo-missing", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    const row = (h.sql.exec("SELECT input_json FROM race_day_close_input").toArray() as { input_json: string }[])[0]!;
    const legacy = JSON.parse(row.input_json) as Record<string, unknown>;
    expect(legacy["comboFromMs"]).toBeTypeOf("number"); // 前提: 今の入力には期間がある
    delete legacy["comboFromMs"];
    delete legacy["comboToMs"];
    h.sql.exec("UPDATE race_day_close_input SET input_json = ?", JSON.stringify(legacy));
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "combo-missing" });
    expect(h.gate.urls.length).toBe(before);
  });

  it("単勝・複勝の取得が失敗(404)したら、通常どおり 1 回だけ再試行する(組合せの欠落とは別)", async () => {
    const h = harness(SETTINGS_ON);
    await analyze(h);
    h.gate.body = (url) => (url.includes("type=b1&") ? null : narBody(url));
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "retry" });
    expect(closeRows(h)[0]).toMatchObject({ round: 1, state: "pending", attempts: 1 });
  });
});

describe("入力の期間(comboFromMs・comboToMs)の検査(parseCloseInput)", () => {
  const valid = {
    v: 1,
    kaisaiDate: DATE,
    horses: [{ umaban: 1, wakuban: 1, horseName: "テスト", prior: 0.3, adjustedProb: 0.3, hadWinOdds: true, hadPlaceOdds: true }],
    allocationSettings: {
      bankroll: 1000,
      perRaceCap: 1000,
      kellyFraction: 0.5,
      includeComboOdds: true,
      includeWideInAllocation: true,
      includeTrioInAllocation: true,
      includeQuinellaInAllocation: true,
      includeExactaInAllocation: true,
      includeTrifectaInAllocation: true,
      includeBracketQuinellaInAllocation: true,
    },
    evThreshold: 1.1,
    baseRoute: "mixed",
  };
  const parse = (extra: Record<string, unknown>) => parseCloseInput(JSON.stringify({ ...valid, ...extra }));

  it("期間が無い入力(旧い入力・組合せ OFF)も読める。期間は未設定のまま", () => {
    const input = parse({});
    expect(input).not.toBeNull();
    expect(input!.comboFromMs).toBeUndefined();
    expect(input!.comboToMs).toBeUndefined();
  });
  it("期間が両方あれば、そのまま読む", () => {
    expect(parse({ comboFromMs: 100, comboToMs: 200 })).toMatchObject({ comboFromMs: 100, comboToMs: 200 });
  });
  it("数でない値は壊れた入力として弾く(null)。片方だけのときは期間なしとして読む", () => {
    expect(parse({ comboFromMs: "100", comboToMs: 200 })).toBeNull();
    expect(parse({ comboFromMs: 100, comboToMs: null })).toBeNull();
    const half = parse({ comboFromMs: 100 });
    expect(half).not.toBeNull();
    expect(half!.comboFromMs).toBeUndefined();
  });
});

describe("入力の的中確率の下限(allocationSettings.minHitProb。Issue #470)の検査(parseCloseInput)", () => {
  const base = {
    v: 1,
    kaisaiDate: DATE,
    horses: [{ umaban: 1, wakuban: 1, horseName: "テスト", prior: 0.3, adjustedProb: 0.3, hadWinOdds: true, hadPlaceOdds: true }],
    evThreshold: 1.1,
    baseRoute: "mixed",
  };
  const settings = {
    bankroll: 1000,
    perRaceCap: 1000,
    kellyFraction: 0.5,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
  };
  const parse = (extra: Record<string, unknown>) => parseCloseInput(JSON.stringify({ ...base, allocationSettings: { ...settings, ...extra } }));

  it("あれば、そのまま読む(0.12 も 0 も)", () => {
    expect(parse({ minHitProb: 0.12 })!.allocationSettings.minHitProb).toBe(0.12);
    expect(parse({ minHitProb: 0 })!.allocationSettings.minHitProb).toBe(0);
  });
  it("旧い入力(デプロイをまたいだ、下限の無い分析時のスナップショット)は 0(下限なし)で読む。分析時に旧い Worker が下限なしで配分したのと揃える", () => {
    const input = parse({});
    expect(input).not.toBeNull();
    expect(input!.allocationSettings.minHitProb).toBe(0);
  });
  it("数でない・範囲外の値は壊れた入力として弾く(null)", () => {
    for (const bad of ["0.05", null, Number.NaN, -0.01, 1.01]) {
      expect(parse({ minHitProb: bad }), String(bad)).toBeNull();
    }
  });
});
