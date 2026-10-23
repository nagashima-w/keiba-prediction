import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * 日報・月報の API(`/api/reports`・`/api/monthly-reports`)の、**応答の生テキスト**と**検査の順序**。Issue #446(H-5)で、
 * 削除した特性テスト(`handler-boilerplate-characterization.test.ts`)のうち、挙動に関わる 2 点(202 の本文のキーの並び・
 * 日付/月の 404 とクエリの 400 の順序)を、小さなテストとして移した。応答の中身(JSON の値)の確認は `handler-reports.test.ts`・
 * `handler-monthly-reports.test.ts`・`handler-monthly-run.test.ts` にある(それらは JSON をパースして比べるので、キーの並びは見ない)。
 */

const ORIGIN = "https://cloud.invalid";
const boom = (): never => {
  throw new Error("呼ばれない想定");
};

/** 日報・月報の DO は依頼を受理する偽物。D1(DB)は呼ばれると throw する(検査だけで終わる経路は D1 に触れない)。 */
function env(result: unknown = { accepted: true }): Env {
  const stub = {
    requestReport: async () => result,
    requestMonthlyReport: async () => result,
    getStatus: async () => null,
  };
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: boom, get: boom },
    RACE_DAY: { idFromName: boom, get: boom },
    DB: { prepare: boom, batch: boom },
    DAILY_REPORT: { idFromName: (name: string) => name, get: () => stub },
    MONTHLY_REPORT: { idFromName: (name: string) => name, get: () => stub },
  } as unknown as Env;
}

async function setup() {
  const key = await makeKey("k1");
  return { deps: { keys: () => localKeys(key), now: () => NOW, log: () => {} }, token: await signToken(key) };
}

const get = (path: string, token: string): Request => new Request(`${ORIGIN}${path}`, { method: "GET", headers: { "Cf-Access-Jwt-Assertion": token } });
const post = (path: string, body: unknown, token: string): Request =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

const NOT_FOUND = '{"ok":false,"error":{"type":"not-found"}}';
const NO_QUERY = '{"ok":false,"error":{"type":"bad-request","message":"このパスにクエリは指定できません"}}';

describe("手動の作成(POST)の 202: 本文のキーの並びは ok → accepted → date/month", () => {
  it.each([
    ["日報", "/api/reports/run", { date: "20261006" }, '{"ok":true,"accepted":true,"date":"20261006"}'],
    ["日報(作り直し)", "/api/reports/run", { date: "20261006", regenerate: true }, '{"ok":true,"accepted":true,"date":"20261006"}'],
    ["月報", "/api/monthly-reports/run", { month: "202609" }, '{"ok":true,"accepted":true,"month":"202609"}'],
    ["月報(作り直し)", "/api/monthly-reports/run", { month: "202609", regenerate: true }, '{"ok":true,"accepted":true,"month":"202609"}'],
  ])("%s: 生テキストが完全に一致する", async (_name, path, body, expected) => {
    const { deps, token } = await setup();
    const res = await handle(post(path, body, token), env(), {}, deps);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(expected);
  });
});

describe("詳細(GET)の検査の順序: 日付・月の形が先(404)、クエリは次(400)。どちらも D1 を引かない", () => {
  it.each([
    ["日報", ["/api/reports/20261340", "/api/reports/abc", "/api/reports/2026100"], "/api/reports/20261005"],
    ["月報", ["/api/monthly-reports/202613", "/api/monthly-reports/abc", "/api/monthly-reports/20261"], "/api/monthly-reports/202609"],
  ])("%s: 不正な日付・月は、クエリが付いていても 404。正しければ、クエリは 400(固定の文言)", async (_name, invalidPaths, validPath) => {
    const { deps, token } = await setup();
    for (const path of invalidPaths) {
      const res = await handle(get(`${path}?x=1`, token), env(), {}, deps); // D1 に触れると boom で throw して、このテストが落ちる
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(NOT_FOUND);
    }
    const res = await handle(get(`${validPath}?x=1`, token), env(), {}, deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(NO_QUERY);
  });
});

describe("手動の作成(POST)の本文の上限は 1024 バイト(ちょうどは通り、1 バイト超えは 413)", () => {
  /** 余計なキー `pad` を足して、本文をちょうど `bytes` バイト(ASCII だけ)にする。 */
  const bodyOf = (base: Record<string, unknown>, bytes: number): string => {
    const empty = JSON.stringify({ ...base, pad: "" });
    return JSON.stringify({ ...base, pad: "x".repeat(bytes - empty.length) });
  };
  const rawPost = (path: string, text: string, token: string): Request =>
    new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, origin: ORIGIN, "content-type": "application/json" }, body: text });

  it.each([
    ["日報", "/api/reports/run", { date: "20261006" }, "本文のキーは date と regenerate だけです"],
    ["月報", "/api/monthly-reports/run", { month: "202609" }, "本文のキーは month と regenerate だけです"],
  ])("%s: 1024 バイトちょうどは本文として読まれる(余計なキーで 400)。1025 バイトは 413(文言に上限の 1024 が入る)", async (_name, path, base, keyMessage) => {
    const { deps, token } = await setup();
    const exact = bodyOf(base, 1024);
    expect(new TextEncoder().encode(exact).byteLength).toBe(1024); // 前提
    const ok = await handle(rawPost(path, exact, token), env(), {}, deps);
    expect(ok.status).toBe(400);
    expect(await ok.text()).toBe(JSON.stringify({ ok: false, error: { type: "bad-request", message: keyMessage } }));

    const over = bodyOf(base, 1025);
    expect(new TextEncoder().encode(over).byteLength).toBe(1025); // 前提
    const tooLarge = await handle(rawPost(path, over, token), env(), {}, deps);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toBe('{"ok":false,"error":{"type":"payload-too-large","message":"本文は 1024 バイトまでです"}}');
  });
});

describe("DO が依頼を断った理由の写し(reportRunRefusal): 契約の理由だけを 409/429、それ以外は 503 report-error(本文は完全一致)", () => {
  const REPORT_ERROR = '{"ok":false,"error":{"type":"report-error"}}';
  const err = (type: string): string => JSON.stringify({ ok: false, error: { type } });

  const CASES = [
    { name: "日報", path: "/api/reports/run", body: { date: "20261006" }, reasons: ["invalid-date", "future-date", "too-old", "bogus"] },
    { name: "月報", path: "/api/monthly-reports/run", body: { month: "202609" }, reasons: ["invalid-month", "not-ended", "too-old", "bogus"] },
  ];

  for (const c of CASES) {
    it(`${c.name}: 検証で弾いたはずの理由・未知の理由(${c.reasons.join("・")})は、通常の作成でも作り直しでも 503 report-error`, async () => {
      const { deps, token } = await setup();
      for (const reason of c.reasons) {
        for (const regenerate of [false, true]) {
          const res = await handle(post(c.path, regenerate ? { ...c.body, regenerate: true } : c.body, token), env({ accepted: false, reason }), {}, deps);
          expect(res.status, `${reason} regenerate=${regenerate}`).toBe(503);
          expect(await res.text(), `${reason} regenerate=${regenerate}`).toBe(REPORT_ERROR);
        }
      }
    });

    it(`${c.name}: 契約の理由の写し(通常の作成 × 作り直し × 理由)を、ステータスと本文で固定する`, async () => {
      const { deps, token } = await setup();
      const table: Array<[string, boolean, number, string]> = [
        ["exists", false, 409, err("already-exists")],
        ["exists", true, 503, REPORT_ERROR], // 作り直しは日報・月報がある日が前提なので、exists は食い違い
        ["in-progress", false, 409, err("in-progress")],
        ["in-progress", true, 409, err("in-progress")],
        ["not-exists", false, 503, REPORT_ERROR], // 通常の作成に not-exists は返らない
        ["not-exists", true, 409, err("not-exists")],
        ["daily-limit", false, 503, REPORT_ERROR], // 通常の作成に daily-limit は返らない
        ["daily-limit", true, 429, err("daily-limit")],
      ];
      for (const [reason, regenerate, status, body] of table) {
        const res = await handle(post(c.path, regenerate ? { ...c.body, regenerate: true } : c.body, token), env({ accepted: false, reason }), {}, deps);
        expect(res.status, `${reason} regenerate=${regenerate}`).toBe(status);
        expect(await res.text(), `${reason} regenerate=${regenerate}`).toBe(body);
      }
    });
  }
});
