import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchTargets, parseTargetsResponse } from "../client/api-targets";

/**
 * Issue #336 段階 B: 今日の狙い目の API 応答のパーサと取得関数(`GET /api/targets`)。純関数・偽の fetch。
 * パーサは応答を信用しない(型違い・キーの欠落は「想定外の応答」。一部の行だけを黙って落とさない)。
 * サーバの本物の応答の形のドリフトは `targets-api.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */

const RACE = { race_id: "202605050811", analysis_id: 11, start_ms: 1_000_000, start_time: "15:40", place: "東京11R", pick: "◎7", skipped: false, detail: "5点 1,200円 EV 1.42・分析時", bet_count: 5, total_stake: 1200, max_ev: 1.42, source: "analysis", round: null };
const BODY = { ok: true, kaisai_date: "20261017", now_ms: 999_000, summary: "分析済み 1 レース中、狙い目 1", races: [RACE] };

describe("parseTargetsResponse", () => {
  it("正しい応答を、値を保って camelCase に写す(UI が使う項目だけ。未知のキーは無視)", () => {
    expect(parseTargetsResponse(200, BODY)).toEqual({
      ok: true,
      data: {
        date: "20261017",
        nowMs: 999_000,
        summary: "分析済み 1 レース中、狙い目 1",
        ledger: null,
        races: [{ raceId: "202605050811", analysisId: 11, startMs: 1_000_000, startTime: "15:40", place: "東京11R", pick: "◎7", skipped: false, detail: "5点 1,200円 EV 1.42・分析時", resultState: null, result: null }],
      },
    });
  });

  it("収支の途中経過(Issue #361): 上部の合計と各行の結果(状態と文言)を、サーバの文言のまま写す。キーが無い(旧い応答)・null は null", () => {
    const withLedger = { ...BODY, ledger: "確定 1R: 投資 300円 / 回収 4,500円 / 回収率 1500.0%", races: [{ ...RACE, result_state: "settled", result: "的中 +4,200円" }] };
    const parsed = parseTargetsResponse(200, withLedger);
    expect(parsed.ok && parsed.data.ledger).toBe("確定 1R: 投資 300円 / 回収 4,500円 / 回収率 1500.0%");
    expect(parsed.ok && parsed.data.races[0]).toMatchObject({ resultState: "settled", result: "的中 +4,200円" });
    const nulls = parseTargetsResponse(200, { ...BODY, ledger: null, races: [{ ...RACE, result_state: null, result: null }] });
    expect(nulls.ok && [nulls.data.ledger, nulls.data.races[0]!.resultState, nulls.data.races[0]!.result]).toEqual([null, null, null]);
    // BODY / RACE はこれらのキーを持たない(前提)。キーが無くても null として読める
    expect("ledger" in BODY || "result" in RACE).toBe(false);
    const absent = parseTargetsResponse(200, BODY);
    expect(absent.ok && [absent.data.ledger, absent.data.races[0]!.resultState, absent.data.races[0]!.result]).toEqual([null, null, null]);
  });

  it("時刻なし・◎なし(null)は null のまま。races が空の配列でも成功", () => {
    const result = parseTargetsResponse(200, { ...BODY, races: [{ ...RACE, start_ms: null, start_time: null, pick: null, skipped: true }] });
    expect(result.ok && result.data.races[0]).toMatchObject({ startMs: null, startTime: null, pick: null, skipped: true });
    expect(parseTargetsResponse(200, { ...BODY, races: [] })).toMatchObject({ ok: true, data: { races: [] } });
  });

  it.each([
    ["ok が true でない", { ...BODY, ok: false }],
    ["body が配列", []],
    ["body が文字列", "x"],
    ["kaisai_date が欠落", { ...BODY, kaisai_date: undefined }],
    ["now_ms が文字列", { ...BODY, now_ms: "1" }],
    ["now_ms が有限でない", { ...BODY, now_ms: null }],
    ["summary が欠落", { ...BODY, summary: undefined }],
    ["races が配列でない", { ...BODY, races: {} }],
    ["race_id が数値", { ...BODY, races: [{ ...RACE, race_id: 1 }] }],
    ["analysis_id が小数", { ...BODY, races: [{ ...RACE, analysis_id: 1.5 }] }],
    ["analysis_id が 0", { ...BODY, races: [{ ...RACE, analysis_id: 0 }] }],
    ["start_ms が文字列", { ...BODY, races: [{ ...RACE, start_ms: "1" }] }],
    ["start_ms が欠落(undefined)", { ...BODY, races: [{ ...RACE, start_ms: undefined }] }],
    ["start_time が数値", { ...BODY, races: [{ ...RACE, start_time: 1540 }] }],
    ["place が欠落", { ...BODY, races: [{ ...RACE, place: undefined }] }],
    ["pick が数値", { ...BODY, races: [{ ...RACE, pick: 7 }] }],
    ["skipped が文字列", { ...BODY, races: [{ ...RACE, skipped: "false" }] }],
    ["detail が欠落", { ...BODY, races: [{ ...RACE, detail: undefined }] }],
    ["2 行目だけが不正(一部の行だけを黙って落とさない)", { ...BODY, races: [RACE, { ...RACE, race_id: undefined }] }],
    ["行が null", { ...BODY, races: [null] }],
    ["ledger が数値", { ...BODY, ledger: 1 }],
    ["result が数値", { ...BODY, races: [{ ...RACE, result_state: "settled", result: 1 }] }],
    ["result_state が数値", { ...BODY, races: [{ ...RACE, result_state: 1, result: "x" }] }],
  ])("想定外: %s", (_name, body) => {
    expect(parseTargetsResponse(200, body)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("200 以外は種類に分類する(403 → forbidden・400 → bad-request・503 → server-error)。サーバの文面は持たない", () => {
    expect(parseTargetsResponse(403, { ok: false, error: { type: "origin-mismatch" } })).toEqual({ ok: false, error: { kind: "origin-mismatch" } });
    expect(parseTargetsResponse(403, "forbidden")).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(parseTargetsResponse(400, { ok: false, error: "x" })).toEqual({ ok: false, error: { kind: "bad-request" } });
    expect(parseTargetsResponse(503, { ok: false, error: { type: "d1-error" } })).toEqual({ ok: false, error: { kind: "server-error" } });
    expect(parseTargetsResponse(404, {})).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 404 } });
  });
});

describe("fetchTargets", () => {
  it("GET /api/targets?kaisai_date=YYYYMMDD を 1 回だけ呼ぶ", async () => {
    const calls: string[] = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return { status: 200, json: async () => BODY };
    };
    const result = await fetchTargets(fetchLike, "20261017");
    expect(calls).toEqual(["GET /api/targets?kaisai_date=20261017"]);
    expect(result.ok).toBe(true);
  });

  it("通信の失敗は network(例外にしない)", async () => {
    const fetchLike: FetchLike = async () => {
      throw new Error("offline");
    };
    expect(await fetchTargets(fetchLike, "20261017")).toEqual({ ok: false, error: { kind: "network" } });
  });
});
