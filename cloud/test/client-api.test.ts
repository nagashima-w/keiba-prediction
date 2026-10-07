import { describe, expect, it } from "vitest";
import { failureMessage, fetchBoard, fetchRaces, parseRacesResponse, parseStatusResponse, type ApiFailure, type FetchLike } from "../client/api";

/**
 * Issue #184: スマホ画面の API 応答のパーサと取得関数(races・status〈race_id なし〉)。純関数・偽の fetch。
 * パーサは応答を信用しない(型違い・欠損は「想定外の応答」。一部の行だけを黙って落とさない)。サーバの文面は画面に出さず、固定の文言にする。
 * 応答の形のドリフトは client-api-contract.test.ts(実際の handle() の応答を通す)が検出する。
 */

const RACE_ROW = { race_id: "202603020211", venue_name: "福島", race_number: 11, race_name: "福島民報杯", course_type: "芝", distance: 1800, entry_count: 16, grade: null };
const BOARD_ROW = { race_id: "202603020211", mode: "morning", status: "done", attempts: 1, error: null, queued_at: 1000, updated_at: 2000, prior: true, analysis_id: null, detail: null, children_ok: null };

describe("parseRacesResponse", () => {
  it("正常な応答を、camelCase の行に写す(grade・venue_name の null を保つ)", () => {
    const result = parseRacesResponse(200, { ok: true, kaisai_date: "20260628", venue: "central", races: [RACE_ROW, { ...RACE_ROW, race_id: "202603020212", venue_name: null, grade: "Jpn1" }] });
    expect(result).toEqual({
      ok: true,
      races: [
        { raceId: "202603020211", venueName: "福島", raceNumber: 11, raceName: "福島民報杯", courseType: "芝", distance: 1800, entryCount: 16, grade: null },
        { raceId: "202603020212", venueName: null, raceNumber: 11, raceName: "福島民報杯", courseType: "芝", distance: 1800, entryCount: 16, grade: "Jpn1" },
      ],
    });
  });

  it("開催なし(races: [])は成功の空配列", () => {
    expect(parseRacesResponse(200, { ok: true, kaisai_date: "20260628", venue: "nar", races: [] })).toEqual({ ok: true, races: [] });
  });

  const malformed: readonly [string, unknown][] = [
    ["本文なし", undefined],
    ["null", null],
    ["ok が false", { ok: false, races: [] }],
    ["races が配列でない", { ok: true, races: {} }],
    ["races が無い", { ok: true }],
    ["race_id が数値", { ok: true, races: [{ ...RACE_ROW, race_id: 202603020211 }] }],
    ["race_number が文字列", { ok: true, races: [{ ...RACE_ROW, race_number: "11" }] }],
    ["distance が NaN 相当(null)", { ok: true, races: [{ ...RACE_ROW, distance: null }] }],
    ["venue_name が数値", { ok: true, races: [{ ...RACE_ROW, venue_name: 5 }] }],
    ["grade が数値", { ok: true, races: [{ ...RACE_ROW, grade: 1 }] }],
    ["2 行目だけ不正(1 行目だけを黙って返さない)", { ok: true, races: [RACE_ROW, { ...RACE_ROW, race_name: null }] }],
  ];
  for (const [name, body] of malformed) {
    it(`想定外の形(${name})は unexpected`, () => {
      expect(parseRacesResponse(200, body)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    });
  }
});

describe("parseStatusResponse", () => {
  it("正常な応答を、camelCase の行に写す(1 レースの 2 つのモードを別の行として保つ)", () => {
    const result = parseStatusResponse(200, {
      ok: true,
      kaisai_date: "20260628",
      races: [BOARD_ROW, { ...BOARD_ROW, mode: "pre_race", status: "failed", attempts: 3, error: "取得に失敗", prior: false, analysis_id: 7 }],
    });
    expect(result).toEqual({
      ok: true,
      rows: [
        { raceId: "202603020211", mode: "morning", status: "done", attempts: 1, error: null, queuedAt: 1000, updatedAt: 2000, prior: true, analysisId: null },
        { raceId: "202603020211", mode: "pre_race", status: "failed", attempts: 3, error: "取得に失敗", queuedAt: 1000, updatedAt: 2000, prior: false, analysisId: 7 },
      ],
    });
  });

  it("板が空(まだ何も予約されていない日)は成功の空配列", () => {
    expect(parseStatusResponse(200, { ok: true, kaisai_date: "20260628", races: [] })).toEqual({ ok: true, rows: [] });
  });

  const malformed: readonly [string, unknown][] = [
    ["mode が未知", { ok: true, races: [{ ...BOARD_ROW, mode: "evening" }] }],
    ["status が未知", { ok: true, races: [{ ...BOARD_ROW, status: "running" }] }],
    ["attempts が文字列", { ok: true, races: [{ ...BOARD_ROW, attempts: "1" }] }],
    ["prior が真偽値でない", { ok: true, races: [{ ...BOARD_ROW, prior: 1 }] }],
    ["analysis_id が文字列", { ok: true, races: [{ ...BOARD_ROW, analysis_id: "7" }] }],
    ["error が数値", { ok: true, races: [{ ...BOARD_ROW, error: 5 }] }],
    ["races が無い", { ok: true }],
  ];
  for (const [name, body] of malformed) {
    it(`想定外の形(${name})は unexpected`, () => {
      expect(parseStatusResponse(200, body)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
    });
  }
});

describe("エラー応答の分類(races・status 共通)", () => {
  const parsers = [
    ["races", (s: number, b: unknown) => parseRacesResponse(s, b)],
    ["status", (s: number, b: unknown) => parseStatusResponse(s, b)],
  ] as const;
  for (const [name, parse] of parsers) {
    it(`${name}: 403 は本文が JSON でなくても forbidden(Worker の関門の応答は text/plain の forbidden)`, () => {
      expect(parse(403, undefined)).toEqual({ ok: false, error: { kind: "forbidden" } });
      expect(parse(403, { ok: false, error: { type: "origin-mismatch" } })).toEqual({ ok: false, error: { kind: "forbidden" } });
    });
    it(`${name}: 400 は bad-request(サーバの文面は持ち込まない)`, () => {
      const result = parse(400, { ok: false, error: { type: "bad-request", message: "秘密の文面<script>" } });
      expect(result).toEqual({ ok: false, error: { kind: "bad-request" } });
    });
    it(`${name}: 503 race-day-error / d1-error は server-error`, () => {
      expect(parse(503, { ok: false, error: { type: "race-day-error" } })).toEqual({ ok: false, error: { kind: "server-error" } });
      expect(parse(503, { ok: false, error: { type: "d1-error" } })).toEqual({ ok: false, error: { kind: "server-error" } });
      expect(parse(503, undefined)).toEqual({ ok: false, error: { kind: "server-error" } });
    });
    it(`${name}: その他の HTTP ステータスは unexpected(ステータスを保つ)`, () => {
      expect(parse(500, undefined)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 500 } });
      expect(parse(404, { ok: false })).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 404 } });
    });
  }

  it("503 netkeiba-unavailable は reason(blocked・busy・failed)を保ち、未知の reason は failed に倒す", () => {
    for (const reason of ["blocked", "busy", "failed"] as const) {
      expect(parseRacesResponse(503, { ok: false, error: { type: "netkeiba-unavailable", reason } })).toEqual({ ok: false, error: { kind: "netkeiba-unavailable", reason } });
    }
    for (const reason of ["???", 5, null, undefined]) {
      expect(parseRacesResponse(503, { ok: false, error: { type: "netkeiba-unavailable", reason } })).toEqual({ ok: false, error: { kind: "netkeiba-unavailable", reason: "failed" } });
    }
  });
});

describe("failureMessage(固定の文言。サーバの文面・例外の文面は出さない)", () => {
  const failures: ApiFailure[] = [
    { kind: "forbidden" },
    { kind: "bad-request" },
    { kind: "netkeiba-unavailable", reason: "blocked" },
    { kind: "netkeiba-unavailable", reason: "busy" },
    { kind: "netkeiba-unavailable", reason: "failed" },
    { kind: "server-error" },
    { kind: "unexpected", httpStatus: 502 },
    { kind: "network" },
  ];
  it("種類ごとに、空でない・互いに異なる文言になる", () => {
    const messages = failures.map(failureMessage);
    expect(messages.every((m) => m.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(failures.length);
  });
  it("ログインの期限切れの可能性を、forbidden と network の文言で案内する(再読み込みを促す)", () => {
    expect(failureMessage({ kind: "forbidden" })).toContain("再読み込み");
    expect(failureMessage({ kind: "network" })).toContain("再読み込み");
  });
  it("unexpected の文言に HTTP ステータスを含める", () => {
    expect(failureMessage({ kind: "unexpected", httpStatus: 502 })).toContain("502");
  });
});

/** 呼び出しを記録する偽の fetch。 */
function fakeFetch(respond: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>): { fetch: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return respond(url);
    },
  };
}

describe("fetchRaces・fetchBoard", () => {
  it("fetchRaces は GET /api/races?kaisai_date=&venue= を、同じオリジンの資格情報つきで呼び、結果を返す", async () => {
    const f = fakeFetch(async () => ({ status: 200, json: async () => ({ ok: true, kaisai_date: "20260628", venue: "nar", races: [RACE_ROW] }) }));
    const result = await fetchRaces(f.fetch, "20260628", "nar");
    expect(result.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/races?kaisai_date=20260628&venue=nar");
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(f.calls[0]!.init.credentials).toBe("same-origin");
  });

  it("fetchBoard は GET /api/analyses/status?kaisai_date= を、race_id なしで呼ぶ", async () => {
    const f = fakeFetch(async () => ({ status: 200, json: async () => ({ ok: true, kaisai_date: "20260628", races: [BOARD_ROW] }) }));
    const result = await fetchBoard(f.fetch, "20260628");
    expect(result.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/analyses/status?kaisai_date=20260628");
    expect(f.calls[0]!.url).not.toContain("race_id");
  });

  it("fetch が例外(通信失敗・Access のリダイレクトによる CORS 失敗)なら network。例外の文面は持ち込まない", async () => {
    const f = fakeFetch(async () => {
      throw new TypeError("Failed to fetch 秘密");
    });
    expect(await fetchRaces(f.fetch, "20260628", "central")).toEqual({ ok: false, error: { kind: "network" } });
    expect(await fetchBoard(f.fetch, "20260628")).toEqual({ ok: false, error: { kind: "network" } });
  });

  it("本文が JSON として読めない 403 は forbidden、200 は unexpected", async () => {
    const bad = (status: number) =>
      fakeFetch(async () => ({
        status,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }));
    expect(await fetchRaces(bad(403).fetch, "20260628", "central")).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await fetchRaces(bad(200).fetch, "20260628", "central")).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });
});
