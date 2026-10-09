import { describe, expect, it } from "vitest";
import type { ApiFailure, FetchLike } from "../client/api";
import { fetchSettings, postSettings, settingsFailureMessage } from "../client/api-settings";
import { CLOUD_SETTINGS_KEYS, DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";

/**
 * Issue #189(段階2): 設定の取得 `GET /api/settings` と保存 `POST /api/settings` の呼び出しと応答の分類。純関数・偽の fetch。
 * **応答を信用しない**(型違い・欠損・余計なキーは「想定外」。一部の項目だけ採用しない)。サーバの文面は画面に出さず、固定の文言にする。
 * Origin の扱い(`referrerPolicy`・`mode` を指定しない)は `api-run.ts` と同じ(client-api-run.test.ts の説明を参照)。
 */

type Resp = { status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });
const SAVED: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 500_000, perRaceCap: 50_000, kellyFraction: 0.25, includeComboOdds: true, additionalInstruction: "慎重に", clipVariant: "wide15", analysisModel: "opus", preRaceOffsetMinutes: 60 };

function fake(respond: () => Promise<Resp>): { fetch: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

describe("fetchSettings(GET /api/settings)", () => {
  it("リクエスト: GET /api/settings(同じオリジンの資格情報。本文なし)", async () => {
    const f = fake(async () => resp(200, { ok: true, settings: SAVED, source: "d1" }));
    await fetchSettings(f.fetch);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/settings");
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(f.calls[0]!.init.credentials).toBe("same-origin");
    expect(f.calls[0]!.init.body).toBeUndefined();
  });

  it("成功: 全 15 項目と source を、そのまま返す", async () => {
    for (const source of ["default", "d1", "invalid"] as const) {
      const f = fake(async () => resp(200, { ok: true, settings: SAVED, source }));
      expect(await fetchSettings(f.fetch)).toEqual({ ok: true, settings: SAVED, source });
    }
    expect(CLOUD_SETTINGS_KEYS.length).toBe(15);
  });

  it.each([
    ["本文が JSON でない", async () => ({ status: 200, json: async () => Promise.reject(new Error("x")) })],
    ["ok が true でない", async () => resp(200, { ok: false, settings: SAVED, source: "d1" })],
    ["settings が無い", async () => resp(200, { ok: true, source: "d1" })],
    ["source が未知", async () => resp(200, { ok: true, settings: SAVED, source: "cache" })],
    ["source が無い", async () => resp(200, { ok: true, settings: SAVED })],
    ["項目が欠けている", async () => resp(200, { ok: true, settings: { ...SAVED, bankroll: undefined }, source: "d1" })],
    ["項目の型が違う(bankroll が文字列)", async () => resp(200, { ok: true, settings: { ...SAVED, bankroll: "1" }, source: "d1" })],
    ["項目が範囲外(発走何分前が 5)", async () => resp(200, { ok: true, settings: { ...SAVED, preRaceOffsetMinutes: 5 }, source: "d1" })],
    ["余計なキーがある", async () => resp(200, { ok: true, settings: { ...SAVED, extra: 1 }, source: "d1" })],
    ["settings が配列", async () => resp(200, { ok: true, settings: [], source: "d1" })],
  ])("%s は想定外の応答(unexpected。HTTP 200)", async (_name, respond) => {
    expect(await fetchSettings(fake(respond).fetch)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("読む側の範囲は受け入れる: kelly が 0・追加指示が 2,000 文字超でも、サーバが返したものとして採用する(書く側より広い)", async () => {
    const wide = { ...SAVED, kellyFraction: 0, additionalInstruction: "あ".repeat(2500) };
    const f = fake(async () => resp(200, { ok: true, settings: wide, source: "d1" }));
    expect(await fetchSettings(f.fetch)).toEqual({ ok: true, settings: wide, source: "d1" });
  });

  it.each([
    [403, { ok: false, error: { type: "origin-mismatch" } }, { kind: "origin-mismatch" }],
    [403, "forbidden", { kind: "forbidden" }],
    [503, { ok: false, error: { type: "d1-error" } }, { kind: "server-error" }],
    [500, undefined, { kind: "unexpected", httpStatus: 500 }],
  ])("HTTP %i は失敗に分類する", async (status, body, expected) => {
    expect(await fetchSettings(fake(async () => resp(status, body)).fetch)).toEqual({ ok: false, error: expected });
  });

  it("fetch が投げたら(同期でも非同期でも) network。例外の文面を持ち込まない", async () => {
    const asyncFail = await fetchSettings(() => Promise.reject(new Error("秘密のホスト名")));
    expect(asyncFail).toEqual({ ok: false, error: { kind: "network" } });
    const syncFail = await fetchSettings(() => {
      throw new Error("秘密のホスト名");
    });
    expect(syncFail).toEqual({ ok: false, error: { kind: "network" } });
    expect(JSON.stringify(asyncFail)).not.toContain("秘密");
  });
});

describe("postSettings(POST /api/settings)", () => {
  it("リクエスト: POST /api/settings に、15 項目すべての JSON を送る(content-type: application/json・同じオリジンの資格情報・referrerPolicy: same-origin。mode は指定しない)", async () => {
    const f = fake(async () => resp(200, { ok: true, settings: SAVED }));
    await postSettings(f.fetch, SAVED);
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("POST");
    expect(init.headers?.["content-type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
    expect(init.referrerPolicy).toBe("same-origin");
    expect(Object.keys(init as object)).not.toContain("mode");
    const body = JSON.parse(init.body!) as Record<string, unknown>;
    expect(body).toEqual(SAVED);
    expect([...Object.keys(body)].sort()).toEqual([...CLOUD_SETTINGS_KEYS].sort());
  });

  it("成功(200): サーバが返した設定を採用する(送った値と違っても、サーバの値が真実)", async () => {
    const echoed = { ...SAVED, bankroll: 1 };
    const f = fake(async () => resp(200, { ok: true, settings: echoed }));
    expect(await postSettings(f.fetch, SAVED)).toEqual({ ok: true, settings: echoed });
  });

  it.each([
    ["ok が true でない", async () => resp(200, { ok: false })],
    ["settings が無い", async () => resp(200, { ok: true })],
    ["項目が欠けている", async () => resp(200, { ok: true, settings: { ...SAVED, clipVariant: undefined } })],
    ["余計なキーがある", async () => resp(200, { ok: true, settings: { ...SAVED, extra: 1 } })],
    ["本文が JSON でない", async () => ({ status: 200, json: async () => Promise.reject(new Error("x")) })],
  ])("%s は想定外の応答(unexpected。HTTP 200)", async (_name, respond) => {
    expect(await postSettings(fake(respond).fetch, SAVED)).toEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it.each([
    [400, { ok: false, error: { type: "bad-request", message: "秘密の文面", fields: ["bankroll"] } }, { kind: "bad-request" }],
    [413, { ok: false, error: { type: "payload-too-large" } }, { kind: "bad-request" }],
    [415, { ok: false, error: { type: "unsupported-media-type" } }, { kind: "bad-request" }],
    [403, { ok: false, error: { type: "origin-mismatch" } }, { kind: "origin-mismatch" }],
    [403, "forbidden", { kind: "forbidden" }],
    [503, { ok: false, error: { type: "d1-error" } }, { kind: "server-error" }],
    [502, undefined, { kind: "unexpected", httpStatus: 502 }],
  ])("HTTP %i は失敗に分類する(サーバの文面は読まない)", async (status, body, expected) => {
    const result = await postSettings(fake(async () => resp(status, body)).fetch, SAVED);
    expect(result).toEqual({ ok: false, error: expected });
    expect(JSON.stringify(result)).not.toContain("秘密");
  });

  it("fetch が投げたら network", async () => {
    expect(await postSettings(() => Promise.reject(new Error("x")), SAVED)).toEqual({ ok: false, error: { kind: "network" } });
    expect(
      await postSettings(() => {
        throw new Error("x");
      }, SAVED),
    ).toEqual({ ok: false, error: { kind: "network" } });
  });
});

describe("settingsFailureMessage(固定の文言。サーバの文面・HTTP の本文を含まない)", () => {
  const FAILURES: readonly ApiFailure[] = [
    { kind: "forbidden" },
    { kind: "origin-mismatch" },
    { kind: "bad-request" },
    { kind: "netkeiba-unavailable", reason: "busy" },
    { kind: "server-error" },
    { kind: "not-found" },
    { kind: "unexpected", httpStatus: 418 },
    { kind: "network" },
  ];

  it("取得・保存の別に、すべての失敗に文言がある(空でない)。取得と保存で文言が違う(保存は「保存できませんでした」・取得は「取得できませんでした」)", () => {
    for (const failure of FAILURES) {
      const load = settingsFailureMessage(failure, "load");
      const save = settingsFailureMessage(failure, "save");
      expect(load.length, failure.kind).toBeGreaterThan(10);
      expect(save.length, failure.kind).toBeGreaterThan(10);
      expect(load, failure.kind).not.toBe(save);
      expect(load, failure.kind).toContain("取得");
      expect(save, failure.kind).toContain("保存");
    }
  });

  it("一時的な失敗(network・server-error・unexpected)は、やり直せることを示す。保存の失敗は入力が残っていることを示す", () => {
    expect(settingsFailureMessage({ kind: "network" }, "load")).toContain("再読込");
    expect(settingsFailureMessage({ kind: "server-error" }, "load")).toContain("再読込");
    for (const failure of [{ kind: "network" }, { kind: "server-error" }, { kind: "unexpected", httpStatus: 500 }, { kind: "bad-request" }] as const) {
      expect(settingsFailureMessage(failure, "save"), failure.kind).toContain("入力した内容は残っています");
    }
  });

  it("origin-mismatch は Origin の不一致であること・ページの再読み込みを案内する。unexpected は HTTP の状態を示す", () => {
    expect(settingsFailureMessage({ kind: "origin-mismatch" }, "save")).toContain("Origin");
    expect(settingsFailureMessage({ kind: "forbidden" }, "load")).toContain("ログインの期限切れ");
    expect(settingsFailureMessage({ kind: "unexpected", httpStatus: 418 }, "load")).toContain("HTTP 418");
  });
});
