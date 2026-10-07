import { describe, expect, it } from "vitest";
import { failureMessage, fetchRaceStatus, parseRaceStatusResponse, type ApiFailure, type FetchLike } from "../client/api";
import { fetchAnalysis, fetchPastAnalyses, parseAnalysisResponse, parsePastAnalysesResponse } from "../client/api-analysis";

/**
 * Issue #185: レース画面・結果画面の API 応答のパーサと取得関数(`status?race_id=`・`GET /api/analyses`・`GET /api/analyses/{id}`)。純関数・偽の fetch。
 * パーサは応答を信用しない(型違い・キーの欠落は「想定外の応答」。一部だけを黙って落とさない)。サーバの文面は画面に出さない。
 * 応答の形のドリフトは client-api-analysis-contract.test.ts(実際の handle() の応答を通す)が検出する。
 */

const BOARD_ROW = { race_id: "202603020211", mode: "morning", status: "done", attempts: 1, error: null, queued_at: 1000, updated_at: 2000, prior: true, analysis_id: null, detail: null, children_ok: null };
const PRIOR = {
  race_name: "福島民報杯",
  venue_name: "福島",
  date: "2026-06-28",
  computed_at: 5000,
  rows: [
    { rank: 1, umaban: 3, horse_name: "アルファ", prior: 0.52 },
    { rank: 2, umaban: 1, horse_name: null, prior: 0.31 },
  ],
};

describe("parseRaceStatusResponse(status?race_id=)", () => {
  it("板の行と朝の prior(順位つき)を、値を保って camelCase に写す。prior が null なら null", () => {
    const result = parseRaceStatusResponse(200, { ok: true, kaisai_date: "20260628", races: [BOARD_ROW], prior: PRIOR });
    expect(result).toEqual({
      ok: true,
      rows: [{ raceId: "202603020211", mode: "morning", status: "done", attempts: 1, error: null, queuedAt: 1000, updatedAt: 2000, prior: true, analysisId: null }],
      prior: {
        raceName: "福島民報杯",
        venueName: "福島",
        date: "2026-06-28",
        computedAt: 5000,
        rows: [
          { rank: 1, umaban: 3, horseName: "アルファ", prior: 0.52 },
          { rank: 2, umaban: 1, horseName: null, prior: 0.31 },
        ],
      },
    });
    const none = parseRaceStatusResponse(200, { ok: true, races: [], prior: null });
    expect(none).toEqual({ ok: true, rows: [], prior: null });
  });

  it("prior のレース名・場名・日付が null でも読める(R2 でなく DO に保存された JSON は検証されていない)", () => {
    const result = parseRaceStatusResponse(200, { ok: true, races: [], prior: { ...PRIOR, race_name: null, venue_name: null, date: null } });
    expect(result.ok && result.prior !== null && [result.prior.raceName, result.prior.venueName, result.prior.date]).toEqual([null, null, null]);
  });

  const malformed: readonly [string, unknown][] = [
    ["prior のキーが無い(race_id 付きの応答は必ず prior を持つ)", { ok: true, races: [] }],
    ["prior が配列", { ok: true, races: [], prior: [] }],
    ["prior.rows が無い", { ok: true, races: [], prior: { ...PRIOR, rows: undefined } }],
    ["prior の行の umaban が文字列", { ok: true, races: [], prior: { ...PRIOR, rows: [{ rank: 1, umaban: "3", horse_name: "a", prior: 0.5 }] } }],
    ["prior の行の prior が null", { ok: true, races: [], prior: { ...PRIOR, rows: [{ rank: 1, umaban: 3, horse_name: "a", prior: null }] } }],
    ["prior の行の rank が無い", { ok: true, races: [], prior: { ...PRIOR, rows: [{ umaban: 3, horse_name: "a", prior: 0.5 }] } }],
    ["2 行目だけ不正(1 行目だけを黙って返さない)", { ok: true, races: [], prior: { ...PRIOR, rows: [PRIOR.rows[0], { rank: 2, umaban: 1, horse_name: 5, prior: 0.3 }] } }],
    ["computed_at が文字列", { ok: true, races: [], prior: { ...PRIOR, computed_at: "5000" } }],
    ["板の行が不正", { ok: true, races: [{ ...BOARD_ROW, mode: "evening" }], prior: null }],
  ];
  for (const [name, body] of malformed) {
    it(`想定外の形(${name})は unexpected`, () => {
      expect(parseRaceStatusResponse(200, body)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    });
  }

  it("エラー応答は固定の種類に分類する(400・403・503)。サーバの文面は持ち込まない", () => {
    expect(parseRaceStatusResponse(400, { ok: false, error: { type: "bad-request", message: "秘密<script>" } })).toEqual({ ok: false, error: { kind: "bad-request" } });
    expect(parseRaceStatusResponse(403, undefined)).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(parseRaceStatusResponse(503, { ok: false, error: { type: "race-day-error" } })).toEqual({ ok: false, error: { kind: "server-error" } });
  });
});

describe("fetchRaceStatus", () => {
  it("race_id と開催日つきの URL を GET(同じオリジンの資格情報)で呼ぶ。通信失敗は network", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ ok: true, races: [], prior: null }) };
    };
    expect(await fetchRaceStatus(fetchLike, "20260628", "202603020211")).toEqual({ ok: true, rows: [], prior: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/analyses/status?kaisai_date=20260628&race_id=202603020211");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    const failing: FetchLike = async () => {
      throw new TypeError("Failed to fetch: 秘密の文面");
    };
    expect(await fetchRaceStatus(failing, "20260628", "202603020211")).toEqual({ ok: false, error: { kind: "network" } });
  });
});

const SUMMARY = { id: 9, raceId: "202603020211", analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: "20260628", evEstimated: false, model: null, promptVersion: null, horses: [], hasDetail: true };

describe("parsePastAnalysesResponse(GET /api/analyses)", () => {
  it("要約の一覧を、サーバの並び(新しい順)のまま、必要な項目だけに写す。余計なキー(追加指示など)は持ち込まない", () => {
    const result = parsePastAnalysesResponse(200, {
      ok: true,
      analyses: [
        { ...SUMMARY, id: 9, additionalInstruction: "秘密の追加指示" },
        { ...SUMMARY, id: 4, analyzedAt: "2026-06-27T23:30:00.000Z", evEstimated: true, model: "claude-x" },
      ],
    });
    expect(result).toEqual({
      ok: true,
      analyses: [
        { id: 9, analyzedAt: "2026-06-28T05:00:00.000Z", evEstimated: false, model: null },
        { id: 4, analyzedAt: "2026-06-27T23:30:00.000Z", evEstimated: true, model: "claude-x" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("秘密");
  });

  it("空の一覧は成功の空配列", () => {
    expect(parsePastAnalysesResponse(200, { ok: true, analyses: [] })).toEqual({ ok: true, analyses: [] });
  });

  const malformed: readonly [string, unknown][] = [
    ["analyses が無い", { ok: true }],
    ["id が文字列", { ok: true, analyses: [{ ...SUMMARY, id: "9" }] }],
    ["id が 0", { ok: true, analyses: [{ ...SUMMARY, id: 0 }] }],
    ["id が小数", { ok: true, analyses: [{ ...SUMMARY, id: 1.5 }] }],
    ["analyzedAt が数値", { ok: true, analyses: [{ ...SUMMARY, analyzedAt: 5 }] }],
    ["evEstimated が文字列", { ok: true, analyses: [{ ...SUMMARY, evEstimated: "false" }] }],
    ["model が数値", { ok: true, analyses: [{ ...SUMMARY, model: 5 }] }],
    ["2 件目だけ不正", { ok: true, analyses: [SUMMARY, { ...SUMMARY, id: null }] }],
  ];
  for (const [name, body] of malformed) {
    it(`想定外の形(${name})は unexpected`, () => {
      expect(parsePastAnalysesResponse(200, body)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    });
  }

  it("400・403・503 の分類。503 は d1-error でも server-error", () => {
    expect(parsePastAnalysesResponse(400, { ok: false })).toEqual({ ok: false, error: { kind: "bad-request" } });
    expect(parsePastAnalysesResponse(403, undefined)).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(parsePastAnalysesResponse(503, { ok: false, error: { type: "d1-error" } })).toEqual({ ok: false, error: { kind: "server-error" } });
  });
});

describe("fetchPastAnalyses", () => {
  it("race_id・kaisai_date・limit(20)つきの URL を GET で呼ぶ(サーバの検証が許すキーだけ)", async () => {
    const urls: string[] = [];
    const fetchLike: FetchLike = async (url) => {
      urls.push(url);
      return { status: 200, json: async () => ({ ok: true, analyses: [] }) };
    };
    expect(await fetchPastAnalyses(fetchLike, "20260628", "202603020211")).toEqual({ ok: true, analyses: [] });
    expect(urls).toEqual(["/api/analyses?race_id=202603020211&kaisai_date=20260628&limit=20"]);
  });
});

const ALLOCATION = {
  route: "mixed",
  skipReasonCode: null,
  unavailableReason: null,
  fallbackReason: "no-combo-candidates",
  betUnit: 100,
  bankroll: 10000,
  perRaceCap: 3000,
  kellyFraction: 0.25,
  evThreshold: 1.1,
  includeComboOdds: true,
  includeWide: true,
  includeTrio: false,
  includeQuinella: null,
  includeExacta: true,
  includeTrifecta: false,
  includeBracketQuinella: null,
  oddsStatus: "result",
  bets: [
    { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
    { betType: "wide", comboKey: "0102", stake: 200, odds: null, ev: null },
  ],
};
const HORSE = { umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, mark: "◎", reason: "根拠" };
const RACE = { venueName: "福島", raceNumber: 11, raceName: "テストステークス", startTime: "15:45", courseType: "芝", distance: 1800, weather: "晴", trackCondition: "良" };
const ANALYSIS = { id: 7, raceId: "202603020211", analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: "20260628", evEstimated: false, model: null, promptVersion: null, llmNote: null, race: RACE, horses: [HORSE], allocation: ALLOCATION, detail: "present" };
const wrap = (analysis: unknown) => ({ ok: true, analysis });

describe("parseAnalysisResponse(GET /api/analyses/{id})", () => {
  it("分析を読む。配分は exe の表示関数(StoredAllocationView)の形にそのまま写す(fallbackReason・betUnit・null の券種を保つ)", () => {
    const result = parseAnalysisResponse(200, wrap(ANALYSIS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis).toMatchObject({
      id: 7,
      raceId: "202603020211",
      analyzedAt: "2026-06-28T05:00:00.000Z",
      kaisaiDate: "20260628",
      evEstimated: false,
      model: null,
      llmNote: null,
      detail: "present",
      race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス" },
    });
    expect(result.analysis.horses).toEqual([HORSE]);
    expect(result.analysis.allocation).toEqual(ALLOCATION);
  });

  it("llmNote(Issue #195): 固定文言はそのまま読む。null(問題なく効いた・LLM を使わない旧い分析)も読める。モデルの有無とは独立に保つ", () => {
    const note = "LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました";
    const read = (over: Record<string, unknown>) => {
      const result = parseAnalysisResponse(200, wrap({ ...ANALYSIS, ...over }));
      expect(result.ok, "前提: 読める").toBe(true);
      return result.ok ? [result.analysis.model, result.analysis.llmNote] : [];
    };
    expect(read({ model: null, llmNote: note })).toEqual([null, note]);
    expect(read({ model: "claude-x", llmNote: note })).toEqual(["claude-x", note]);
    expect(read({ model: null, llmNote: null })).toEqual([null, null]);
    expect(read({ model: "claude-x", llmNote: null })).toEqual(["claude-x", null]);
  });

  it("配分なし(null)・馬の null(名前・オッズ・EV・印)・detail の 3 値を保つ", () => {
    const horse = { ...HORSE, name: null, placeOddsMin: null, ev: null, isPositive: false, mark: null, reason: null };
    for (const detail of ["present", "missing", "none"] as const) {
      const result = parseAnalysisResponse(200, wrap({ ...ANALYSIS, allocation: null, horses: [horse], detail }));
      expect(result.ok && result.analysis.detail).toBe(detail);
      expect(result.ok && result.analysis.allocation).toBeNull();
      expect(result.ok && result.analysis.horses[0]).toEqual(horse);
    }
  });

  it("race の場名・R・レース名が null でも読める。kaisaiDate が null でも読める", () => {
    const result = parseAnalysisResponse(200, wrap({ ...ANALYSIS, kaisaiDate: null, race: { ...RACE, venueName: null, raceNumber: null, raceName: null } }));
    expect(result.ok && [result.analysis.kaisaiDate, result.analysis.race.venueName, result.analysis.race.raceNumber, result.analysis.race.raceName]).toEqual([null, null, null, null]);
  });

  // 配分のキーが 1 つ欠けても(サーバがキーを足し忘れる・名前を変える)、exe の表示関数に undefined を渡さない: unexpected にする
  const allocationKeys = Object.keys(ALLOCATION);
  for (const key of allocationKeys) {
    it(`配分のキー ${key} が欠けたら unexpected(undefined を表示関数に渡さない)`, () => {
      const { [key]: _drop, ...rest } = ALLOCATION as Record<string, unknown>;
      expect(parseAnalysisResponse(200, wrap({ ...ANALYSIS, allocation: rest }))).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    });
  }

  const malformed: readonly [string, unknown][] = [
    ["analysis が無い", { ok: true }],
    ["ok が false", { ok: false, analysis: ANALYSIS }],
    ["id が文字列", wrap({ ...ANALYSIS, id: "7" })],
    ["detail が未知", wrap({ ...ANALYSIS, detail: "stored" })],
    ["evEstimated が無い", wrap({ ...ANALYSIS, evEstimated: undefined })],
    ["model が数値", wrap({ ...ANALYSIS, model: 5 })],
    ["llmNote が無い(サーバがキーを足し忘れた・名前を変えた)", wrap({ ...ANALYSIS, llmNote: undefined })],
    ["llmNote が数値", wrap({ ...ANALYSIS, llmNote: 5 })],
    ["horses が配列でない", wrap({ ...ANALYSIS, horses: {} })],
    ["馬の umaban が文字列", wrap({ ...ANALYSIS, horses: [{ ...HORSE, umaban: "1" }] })],
    ["馬の prior が null", wrap({ ...ANALYSIS, horses: [{ ...HORSE, prior: null }] })],
    ["馬の isPositive が数値", wrap({ ...ANALYSIS, horses: [{ ...HORSE, isPositive: 1 }] })],
    ["馬の mark が数値", wrap({ ...ANALYSIS, horses: [{ ...HORSE, mark: 1 }] })],
    ["2 頭目だけ不正(1 頭だけを黙って返さない)", wrap({ ...ANALYSIS, horses: [HORSE, { ...HORSE, name: 5 }] })],
    ["配分の betUnit が文字列", wrap({ ...ANALYSIS, allocation: { ...ALLOCATION, betUnit: "100" } })],
    ["配分の bets の stake が文字列", wrap({ ...ANALYSIS, allocation: { ...ALLOCATION, bets: [{ ...ALLOCATION.bets[0], stake: "300" }] } })],
    ["配分の bets が配分の 2 行目だけ不正", wrap({ ...ANALYSIS, allocation: { ...ALLOCATION, bets: [ALLOCATION.bets[0], { ...ALLOCATION.bets[1], comboKey: null }] } })],
    ["配分の include が文字列", wrap({ ...ANALYSIS, allocation: { ...ALLOCATION, includeWide: "true" } })],
    ["race が無い", wrap({ ...ANALYSIS, race: undefined })],
  ];
  for (const [name, body] of malformed) {
    it(`想定外の形(${name})は unexpected`, () => {
      expect(parseAnalysisResponse(200, body)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    });
  }

  it("未知の route 文字列は読める(表示関数が「判定不能」に倒す。クライアントで落とさない)", () => {
    const result = parseAnalysisResponse(200, wrap({ ...ANALYSIS, allocation: { ...ALLOCATION, route: "future-route" } }));
    expect(result.ok && result.analysis.allocation?.route).toBe("future-route");
  });

  it("404 は not-found、400・403・503 は固定の分類。サーバの文面は持ち込まない", () => {
    expect(parseAnalysisResponse(404, { ok: false, error: { type: "not-found" } })).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(parseAnalysisResponse(404, undefined)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(parseAnalysisResponse(400, { ok: false, error: { type: "bad-request", message: "秘密<script>" } })).toEqual({ ok: false, error: { kind: "bad-request" } });
    expect(parseAnalysisResponse(403, undefined)).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(parseAnalysisResponse(503, { ok: false, error: { type: "d1-error" } })).toEqual({ ok: false, error: { kind: "server-error" } });
    expect(parseAnalysisResponse(500, undefined)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 500 } });
  });
});

describe("fetchAnalysis", () => {
  it("/api/analyses/{id} を GET で 1 回呼ぶ。通信失敗は network", async () => {
    const urls: string[] = [];
    const fetchLike: FetchLike = async (url) => {
      urls.push(url);
      return { status: 200, json: async () => wrap(ANALYSIS) };
    };
    const result = await fetchAnalysis(fetchLike, 7);
    expect(result.ok).toBe(true);
    expect(urls).toEqual(["/api/analyses/7"]);
    expect(
      await fetchAnalysis(async () => {
        throw new Error("x");
      }, 7),
    ).toEqual({ ok: false, error: { kind: "network" } });
  });
});

describe("failureMessage: not-found", () => {
  it("not-found の固定の文言があり、他の種類と区別できる", () => {
    const failures: ApiFailure[] = [{ kind: "not-found" }, { kind: "forbidden" }, { kind: "bad-request" }, { kind: "server-error" }, { kind: "network" }];
    const messages = failures.map(failureMessage);
    expect(new Set(messages).size).toBe(failures.length);
    expect(failureMessage({ kind: "not-found" })).toContain("見つかりません");
  });
});
