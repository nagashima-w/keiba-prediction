import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GatePostRequest, GateResult } from "../src/gate-core";
import { runGradeWinnerCheck, runShutubaCheck, validateRaceId } from "../src/netkeiba-check";
import { parseRaceId } from "../../packages/core/src/scraper/ids.js";

/**
 * Issue #162 段階2b: 確認用のチェック処理。race_id の検証と、`fetchRaw` を受け取る関数としての取得・パース。
 * ゲートは偽(fixture のバイト列を返す)。実ネットワークには出ない。
 */

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURES}${name}`));

function response(body: Uint8Array, init: { status?: number; queuedMs?: number; elapsedMs?: number } = {}): GateResult {
  const copy = new Uint8Array(body.length);
  copy.set(body);
  return {
    kind: "response",
    status: init.status ?? 200,
    contentType: "text/html; charset=UTF-8",
    body: copy.buffer,
    queuedMs: init.queuedMs ?? 0,
    elapsedMs: init.elapsedMs ?? 1,
  };
}

function recorder(handler: (url: string) => GateResult | Promise<GateResult>) {
  const urls: string[] = [];
  return {
    urls,
    fetchRaw: async (url: string): Promise<GateResult> => {
      urls.push(url);
      return handler(url);
    },
  };
}

describe("validateRaceId(AC-14。中央・地方とも)", () => {
  it.each([
    ["中央(場コード 06)", "202606010101", "central"],
    ["中央の fixture(場コード 03)", "202603020211", "central"],
    ["中央の下限(場コード 01)", "202601010101", "central"],
    ["中央の上限(場コード 10)", "202610010101", "central"],
    ["地方(場コード 54)", "202654071210", "nar"],
    ["地方の下限(場コード 30)", "202630062407", "nar"],
    ["地方の上限(場コード 64)", "202664010101", "nar"],
  ])("有効: %s", (_label, input, kind) => {
    const checked = validateRaceId(input);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.kind).toBe(kind);
    expect(checked.ok && checked.raceId).toBe(parseRaceId(input));
  });

  it.each([
    ["null(パラメータなし)", null],
    ["空文字列", ""],
    ["11 桁", "20260302021"],
    ["13 桁", "2026030202111"],
    ["英字", "abcdefghijkl"],
    ["前に空白", " 202603020211"],
    ["後ろに空白", "202603020211 "],
    ["全角の数字", "２０２６０３０２０２１１"],
    ["符号つき", "+202603020211"],
    ["小数点つき", "2026030202.1"],
    ["クエリの注入", "202603020211&x=1"],
    ["URL の注入", "202603020211/../x"],
    ["帯広(場コード 65。対象外)", "202665010101"],
    ["場コード 00", "202600010101"],
    ["場コード 11(中央でも地方でもない)", "202611010101"],
    ["場コード 29", "202629010101"],
    ["場コード 66", "202666010101"],
    ["地方で実在しない日付(2月30日)", "202642023001"],
    ["地方で月が 13", "202642130101"],
  ])("無効: %s", (_label, input) => {
    const checked = validateRaceId(input);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.message).toBeTruthy();
  });

  it("非常に長い入力でも、メッセージは短い(入力をそのまま長く返さない)", () => {
    const checked = validateRaceId("9".repeat(5000));
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.message.length).toBeLessThan(300);
  });
});

describe("runShutubaCheck", () => {
  it("中央: 出馬表を取得して、頭数(16)・ステータス・kind・所要時間を返す。取得先は shutubaUrl が組み立てた URL", async () => {
    const gate = recorder(() => response(fixtureBytes("shutuba_202603020211.html"), { queuedMs: 2000, elapsedMs: 431 }));
    const result = await runShutubaCheck(parseRaceId("202603020211"), gate.fetchRaw);
    expect(gate.urls).toEqual(["https://race.netkeiba.com/race/shutuba.html?race_id=202603020211"]);
    expect(result.httpStatus).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      kind: "central",
      raceId: "202603020211",
      status: 200,
      horses: 16,
      queuedMs: 2000,
      elapsedMs: 431,
    });
  });

  it("地方: nar のホストで取得し、頭数(12)・kind=nar を返す", async () => {
    const gate = recorder(() => response(fixtureBytes("nar_shutuba_202654071210.html")));
    const result = await runShutubaCheck(parseRaceId("202654071210"), gate.fetchRaw);
    expect(gate.urls).toEqual(["https://nar.netkeiba.com/race/shutuba.html?race_id=202654071210"]);
    expect(result.body).toMatchObject({ ok: true, kind: "nar", horses: 12 });
  });

  it("取得は 1 回だけ(再試行しない)", async () => {
    const gate = recorder(() => response(new Uint8Array(), { status: 503 }));
    await runShutubaCheck(parseRaceId("202603020211"), gate.fetchRaw);
    expect(gate.urls).toHaveLength(1);
  });

  it.each([[400], [403], [404], [429], [500], [503]])("HTTP %i は ok:false(http-error。受信したステータスと所要時間を添える)・502", async (status) => {
    const gate = recorder(() => response(new Uint8Array(), { status, queuedMs: 5, elapsedMs: 7 }));
    const result = await runShutubaCheck(parseRaceId("202603020211"), gate.fetchRaw);
    expect(result.httpStatus).toBe(502);
    expect(result.body).toMatchObject({ ok: false, kind: "central", raceId: "202603020211", status, queuedMs: 5, elapsedMs: 7 });
    expect(result.body.ok === false && result.body.error.type).toBe("http-error");
  });

  it.each([
    ["blocked", 503],
    ["queue-full", 503],
    ["network-error", 502],
    ["timeout", 502],
    ["bad-response", 502],
    ["disallowed-url", 502],
  ] as const)("ゲートの拒否(%s)は ok:false(gate-refused。理由を添える)・HTTP %i", async (reason, httpStatus) => {
    const gate = recorder(() => ({ kind: "refused", reason, message: `理由: ${reason}`, blockedUntil: 123 }));
    const result = await runShutubaCheck(parseRaceId("202603020211"), gate.fetchRaw);
    expect(result.httpStatus).toBe(httpStatus);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.type).toBe("gate-refused");
      expect(result.body.error.reason).toBe(reason);
      expect(result.body.error.message).toContain(`理由: ${reason}`);
      expect(result.body.status).toBeUndefined();
    }
  });

  it("ゲートの呼び出し自体が例外(RPC の失敗)でも、ok:false(fetch-failed)・502 で、例外を外へ投げない", async () => {
    const result = await runShutubaCheck(parseRaceId("202603020211"), async () => {
      throw new Error("RPC が切れた");
    });
    expect(result.httpStatus).toBe(502);
    expect(result.body.ok === false && result.body.error.type).toBe("fetch-failed");
    expect(result.body.ok === false && result.body.error.message).toContain("RPC が切れた");
  });

  it("200 でも出馬表として読めなければ ok:false(parse-error)・502。受信したステータスは添える", async () => {
    const gate = recorder(() => response(new TextEncoder().encode("<html><body>empty</body></html>")));
    const result = await runShutubaCheck(parseRaceId("202603020211"), gate.fetchRaw);
    expect(result.httpStatus).toBe(502);
    expect(result.body).toMatchObject({ ok: false, status: 200 });
    expect(result.body.ok === false && result.body.error.type).toBe("parse-error");
  });

  it("本文は UTF-8 として読む(中央・地方の出馬表は UTF-8)", async () => {
    const gate = recorder(() => response(fixtureBytes("shutuba_202603020211.html")));
    const result = await runShutubaCheck(parseRaceId("202603020211"), gate.fetchRaw);
    expect(result.body.ok).toBe(true); // 文字化けしていればコース種別・距離を読めずに parse-error になる
  });
});

describe("runGradeWinnerCheck(Issue #181。POST を1本試す)", () => {
  function postRecorder(handler: (request: GatePostRequest) => GateResult | Promise<GateResult>) {
    const requests: GatePostRequest[] = [];
    return {
      requests,
      postRaw: async (request: GatePostRequest): Promise<GateResult> => {
        requests.push(request);
        return handler(request);
      },
    };
  }

  it("中央: POST を1本だけ送り(core が組み立てた宛先・Referer・Origin・本文)、過去回の数(10)・ステータス・kind・所要時間を返す", async () => {
    const gate = postRecorder(() => response(fixtureBytes("grade_winner_202603020211.json"), { queuedMs: 2000, elapsedMs: 312 }));
    const result = await runGradeWinnerCheck(parseRaceId("202603020211"), gate.postRaw);
    expect(gate.requests).toEqual([
      {
        url: "https://race.netkeiba.com/race_api/",
        referer: "https://race.netkeiba.com/race/past10.html?race_id=202603020211",
        origin: "https://race.netkeiba.com",
        body: "input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=202603020211",
      },
    ]);
    expect(result.httpStatus).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      kind: "central",
      raceId: "202603020211",
      target: "grade-winner",
      status: 200,
      entries: 10,
      queuedMs: 2000,
      elapsedMs: 312,
    });
  });

  it("地方: nar のホストへ POST し、kind=nar・過去回の数を返す(fixture: grade_winner_nar_202644070111)", async () => {
    const gate = postRecorder(() => response(fixtureBytes("grade_winner_nar_202644070111.json")));
    const result = await runGradeWinnerCheck(parseRaceId("202644070111"), gate.postRaw);
    expect(gate.requests.map((r) => r.url)).toEqual(["https://nar.netkeiba.com/race_api/"]);
    expect(result.body).toMatchObject({ ok: true, kind: "nar", target: "grade-winner", status: 200 });
    const entries = result.body.ok ? (result.body as { entries: number | null }).entries : null;
    expect(entries).toBeGreaterThan(0);
  });

  it("対象データなし(status:NG。非重賞)は、ok:true で過去回の数が null(通信とパースは成功した)", async () => {
    const gate = postRecorder(() => response(fixtureBytes("grade_winner_ng_202602010607.json")));
    const result = await runGradeWinnerCheck(parseRaceId("202602010607"), gate.postRaw);
    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({ ok: true, target: "grade-winner", status: 200, entries: null });
  });

  it("取得は 1 回だけ(再試行しない)", async () => {
    const gate = postRecorder(() => response(new Uint8Array(), { status: 503 }));
    await runGradeWinnerCheck(parseRaceId("202603020211"), gate.postRaw);
    expect(gate.requests).toHaveLength(1);
  });

  it.each([[400], [403], [404], [429], [500]])("HTTP %i は ok:false(http-error。ステータスと所要時間を添える)・502。target を添える", async (status) => {
    const gate = postRecorder(() => response(new Uint8Array(), { status, queuedMs: 5, elapsedMs: 7 }));
    const result = await runGradeWinnerCheck(parseRaceId("202603020211"), gate.postRaw);
    expect(result.httpStatus).toBe(502);
    expect(result.body).toMatchObject({ ok: false, kind: "central", raceId: "202603020211", target: "grade-winner", status, queuedMs: 5, elapsedMs: 7 });
    expect(result.body.ok === false && result.body.error.type).toBe("http-error");
  });

  it.each([
    ["blocked", 503],
    ["post-blocked", 503],
    ["queue-full", 503],
    ["network-error", 502],
    ["timeout", 502],
    ["bad-response", 502],
    ["disallowed-url", 502],
  ] as const)("ゲートの拒否(%s)は ok:false(gate-refused。理由を添える)・HTTP %i", async (reason, httpStatus) => {
    const gate = postRecorder(() => ({ kind: "refused", reason, message: `理由: ${reason}`, blockedUntil: 123 }));
    const result = await runGradeWinnerCheck(parseRaceId("202603020211"), gate.postRaw);
    expect(result.httpStatus).toBe(httpStatus);
    expect(result.body).toMatchObject({ ok: false, target: "grade-winner" });
    if (!result.body.ok) {
      expect(result.body.error.type).toBe("gate-refused");
      expect(result.body.error.reason).toBe(reason);
      expect(result.body.error.message).toContain(`理由: ${reason}`);
      expect(result.body.status).toBeUndefined();
    }
  });

  it("ゲートの呼び出し自体が例外(RPC の失敗)でも、ok:false(fetch-failed)・502 で、例外を外へ投げない", async () => {
    const result = await runGradeWinnerCheck(parseRaceId("202603020211"), async () => {
      throw new Error("RPC が切れた");
    });
    expect(result.httpStatus).toBe(502);
    expect(result.body.ok === false && result.body.error.type).toBe("fetch-failed");
    expect(result.body.ok === false && result.body.error.message).toContain("RPC が切れた");
  });

  it("200 でも JSON として読めなければ ok:false(parse-error)・502。受信したステータスは添える", async () => {
    const gate = postRecorder(() => response(new TextEncoder().encode("<html>not json</html>")));
    const result = await runGradeWinnerCheck(parseRaceId("202603020211"), gate.postRaw);
    expect(result.httpStatus).toBe(502);
    expect(result.body).toMatchObject({ ok: false, status: 200, target: "grade-winner" });
    expect(result.body.ok === false && result.body.error.type).toBe("parse-error");
  });

  it("出馬表の確認(runShutubaCheck)の本文には target が付かない(これまでの形のまま)", async () => {
    const gate = recorder(() => response(fixtureBytes("shutuba_202603020211.html")));
    const result = await runShutubaCheck(parseRaceId("202603020211"), gate.fetchRaw);
    expect("target" in result.body).toBe(false);
  });
});
