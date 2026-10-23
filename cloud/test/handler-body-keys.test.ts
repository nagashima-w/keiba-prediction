import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * POST の本文のキーの許可リスト(`handler.ts` の `*_KEYS`)を持つ**全 5 ルート**について、許可リストの外のキーは 400(文言込み)で、
 * 裏側(DO・D1)に触れないことを確かめる。Issue #446(H-5): クエリの許可リスト(`handler-query-keys.test.ts`)と同じ欠陥クラス
 * (許可リストへのキーの追加)が、本文のキーにも残っていたため足した。
 * キーの検査は本文のほかの検査より先なので、許可キーを欠いた本文でも、外のキー 1 つで同じ文言の 400 になる。
 * 許可リストに足された外のキーは、その先の検査(別の文言の 400)に進んでしまうので、文言の完全一致で検出できる。
 *
 * 網羅の保証: 最後の describe が `handler.ts` のソースを読み、`*_KEYS` 定数の名前・中身と、`Object.keys(record).some(… !X.has(k))` の
 * 呼び出しが、この表と一致することを固定する。
 */

const ORIGIN = "https://cloud.invalid";
const boom = (): never => {
  throw new Error("裏側は呼ばれない想定");
};

function env(): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: boom, get: boom },
    RACE_DAY: { idFromName: boom, get: boom },
    RESULT_BACKFILL: { idFromName: boom, get: boom },
    DAILY_REPORT: { idFromName: boom, get: boom },
    MONTHLY_REPORT: { idFromName: boom, get: boom },
    DB: { prepare: boom, batch: boom },
    ANALYSIS_DETAIL: { get: boom, put: boom },
  } as unknown as Env;
}

async function setup() {
  const key = await makeKey("k1");
  return { deps: { keys: () => localKeys(key), now: () => NOW, log: () => {} }, token: await signToken(key) };
}

const post = (path: string, body: unknown, token: string): Request =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

const bad = (message: string): string => JSON.stringify({ ok: false, error: { type: "bad-request", message } });

/** 全ルートの本文の許可キーの和集合(最後の describe が、ソースの `*_KEYS` の和集合と一致することを固定する)。 */
const ALL_KEYS = ["date", "from", "kaisai_date", "mode", "month", "race_id", "race_ids", "regenerate", "to"];

const ROUTES = [
  { name: "analyses/run", path: "/api/analyses/run", constant: "RUN_KEYS", allowed: ["race_id", "kaisai_date", "mode"], message: "本文のキーは race_id・kaisai_date・mode だけです" },
  { name: "analyses/run/bulk", path: "/api/analyses/run/bulk", constant: "BULK_KEYS", allowed: ["kaisai_date", "mode", "race_ids"], message: "本文のキーは kaisai_date・mode・race_ids だけです" },
  { name: "results/import", path: "/api/results/import", constant: "RESULTS_IMPORT_KEYS", allowed: ["from", "to"], message: "本文のキーは from・to だけです" },
  { name: "reports/run", path: "/api/reports/run", constant: "REPORT_RUN_KEYS", allowed: ["date", "regenerate"], message: "本文のキーは date と regenerate だけです" },
  { name: "monthly-reports/run", path: "/api/monthly-reports/run", constant: "MONTHLY_RUN_KEYS", allowed: ["month", "regenerate"], message: "本文のキーは month と regenerate だけです" },
] as const;

describe("本文の許可リストの外のキーは 400(全 5 ルート。ほかのルートのキー・どのルートにも無いキー)", () => {
  for (const route of ROUTES) {
    const foreign = [...ALL_KEYS.filter((k) => !(route.allowed as readonly string[]).includes(k)), "zzz"];
    it(`${route.name}: ${foreign.length} 種の外のキーは、単独でも許可キーと並べても 400(裏側に触れない)`, async () => {
      expect(foreign.length).toBeGreaterThan(1); // 前提
      const { deps, token } = await setup();
      for (const key of foreign) {
        const bodies = [{ [key]: "x" }, ...route.allowed.map((a) => ({ [a]: "x", [key]: "x" }))];
        for (const body of bodies) {
          const res = await handle(post(route.path, body, token), env(), {}, deps);
          expect(res.status, JSON.stringify(body)).toBe(400);
          expect(await res.text(), JSON.stringify(body)).toBe(bad(route.message));
        }
      }
    });
  }
});

describe("網羅の保証: handler.ts の `*_KEYS`・呼び出しと、このテストの表が一致する", () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "handler.ts"), "utf-8");

  it("`*_KEYS` 定数の名前と中身", () => {
    const found = new Map<string, string[]>();
    for (const m of source.matchAll(/^const (\w+_KEYS)\b[^=]*= new Set(?:<string>)?\(\[([^\]]*)\]\);$/gm)) {
      found.set(m[1]!, [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
    }
    expect([...found.keys()].sort()).toEqual(ROUTES.map((r) => r.constant).sort());
    for (const r of ROUTES) expect([...(found.get(r.constant) ?? [])].sort(), r.constant).toEqual([...r.allowed].sort());
    expect([...new Set([...found.values()].flat())].sort()).toEqual([...ALL_KEYS].sort());
  });

  it("`Object.keys(record).some((k) => !X.has(k))` の呼び出しは、定数ごとに 1 回ずつ", () => {
    const calls = [...source.matchAll(/Object\.keys\(record\)\.some\(\(k\) => !(\w+)\.has\(k\)\)/g)].map((m) => m[1]!);
    expect(calls.sort()).toEqual(ROUTES.map((r) => r.constant).sort());
  });
});
