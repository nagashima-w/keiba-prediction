import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchMigration, migrationFetchFailureMessage, parseMigrationStatus, postMigrationUpload, uploadFailureMessage, type UploadFailure } from "../client/api-migration";

/**
 * Issue #222(#167-B2): 移行の進捗 `GET /api/migration` と、アップロード `POST /api/migration/upload` のクライアント側の呼び出しと応答の分類。
 * 守ること:
 *  - 進捗の応答は信用しない: 型違い・欠損・未知の state は「想定外」で、一部だけを採用しない(余計なキーは許す=サーバが項目を足しても画面は壊れない)
 *  - アップロードは、サーバが要求する形(POST・`Content-Type: application/gzip`・本文は File そのもの・credentials/referrerPolicy)で送る。Content-Length はブラウザが Blob 本文から付ける
 *  - アップロードの失敗は、**ステータスと `error.type`(サーバが決めた固定の識別子)だけ**で分類する。サーバの `message`・例外の文面は読まない・出さない
 */

const IDLE_BODY = {
  ok: true,
  state: "idle",
  upload: null,
  analyses: { total: null, processed: 0, imported: 0, alreadyImported: 0, conflicts: 0 },
  results: { total: null, processed: 0 },
  resumeAt: null,
  failure: null,
  conflictSamples: [],
  attempts: 0,
  budget: { day: "20261009", usedRows: 0, limitRows: 60000 },
  verified: null,
  lastTick: null,
  updatedAt: null,
};
const IMPORTING_BODY = {
  ...IDLE_BODY,
  state: "importing",
  upload: { size: 15_000_000, uploadedAt: "2026-10-09T01:02:03.000Z", exportedAt: "2026-10-08T00:00:00.000Z", appVersion: "1.27.0" },
  analyses: { total: 2225, processed: 100, imported: 90, alreadyImported: 8, conflicts: 2 },
  results: { total: 1301, processed: 0 },
  conflictSamples: ["analysis.id=7: race_id が違う"],
  budget: { day: "20261009", usedRows: 1234, limitRows: 60000 },
};

type Resp = { status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Resp => ({ status, json: async () => body });

describe("parseMigrationStatus(進捗の応答の検査)", () => {
  it("idle の応答を読める(件数の total は null)", () => {
    const p = parseMigrationStatus(IDLE_BODY);
    expect(p).not.toBeNull();
    expect(p!.state).toBe("idle");
    expect(p!.analyses.total).toBeNull();
    expect(p!.upload).toBeNull();
    expect(p!.budget).toEqual({ day: "20261009", usedRows: 0, limitRows: 60000 });
  });

  it("取り込み中の応答の全項目を取り出す", () => {
    expect(parseMigrationStatus(IMPORTING_BODY)).toEqual({
      state: "importing",
      upload: { size: 15_000_000, uploadedAt: "2026-10-09T01:02:03.000Z", exportedAt: "2026-10-08T00:00:00.000Z", appVersion: "1.27.0" },
      analyses: { total: 2225, processed: 100, imported: 90, alreadyImported: 8, conflicts: 2 },
      results: { total: 1301, processed: 0 },
      resumeAt: null,
      failure: null,
      conflictSamples: ["analysis.id=7: race_id が違う"],
      attempts: 0,
      budget: { day: "20261009", usedRows: 1234, limitRows: 60000 },
    });
  });

  it("失敗(failure の phase と message)・予算待ち(resumeAt)を読める", () => {
    const failed = parseMigrationStatus({ ...IMPORTING_BODY, state: "failed", failure: { phase: "verify", message: "3 行目: 未知の列 x がある" } });
    expect(failed!.failure).toEqual({ phase: "verify", message: "3 行目: 未知の列 x がある" });
    const waiting = parseMigrationStatus({ ...IMPORTING_BODY, state: "waiting-budget", resumeAt: "2026-10-10T00:05:00.000Z" });
    expect(waiting!.resumeAt).toBe("2026-10-10T00:05:00.000Z");
  });

  it("余計なキー(verified・lastTick・updatedAt・将来の項目)は無視する(読む項目がそろっていれば成功)", () => {
    expect(parseMigrationStatus({ ...IMPORTING_BODY, future: 1 })).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["配列", []],
    ["ok が true でない", { ...IDLE_BODY, ok: false }],
    ["未知の state", { ...IDLE_BODY, state: "paused" }],
    ["state が無い", { ...IDLE_BODY, state: undefined }],
    ["analyses.processed が文字列", { ...IDLE_BODY, analyses: { ...IDLE_BODY.analyses, processed: "0" } }],
    ["analyses.total が負", { ...IDLE_BODY, analyses: { ...IDLE_BODY.analyses, total: -1 } }],
    ["analyses.total が小数", { ...IDLE_BODY, analyses: { ...IDLE_BODY.analyses, total: 1.5 } }],
    ["results が無い", { ...IDLE_BODY, results: undefined }],
    ["failure の phase が未知", { ...IDLE_BODY, failure: { phase: "x", message: "m" } }],
    ["failure の message が数値", { ...IDLE_BODY, failure: { phase: "verify", message: 1 } }],
    ["conflictSamples に文字列でないもの", { ...IDLE_BODY, conflictSamples: ["a", 1] }],
    ["conflictSamples が配列でない", { ...IDLE_BODY, conflictSamples: "a" }],
    ["resumeAt が数値", { ...IDLE_BODY, resumeAt: 1 }],
    ["upload の size が文字列", { ...IDLE_BODY, upload: { size: "1", uploadedAt: "x", exportedAt: null, appVersion: null } }],
    ["budget が無い", { ...IDLE_BODY, budget: undefined }],
    ["attempts が無い", { ...IDLE_BODY, attempts: undefined }],
  ])("想定外は null(一部だけを採用しない): %s", (_name, body) => {
    expect(parseMigrationStatus(body)).toBeNull();
  });
});

describe("fetchMigration(GET /api/migration)", () => {
  it("GET・same-origin で、パスは /api/migration だけ", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return reply(200, IDLE_BODY);
    };
    const result = await fetchMigration(fetchLike);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/migration");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.progress.state).toBe("idle");
  });

  it.each<[string, Resp | "throw", string]>([
    ["403 は forbidden", reply(403, "forbidden"), "forbidden"],
    ["503 は server-error", reply(503, { ok: false, error: { type: "migration-error" } }), "server-error"],
    ["200 でも形が違えば unexpected", reply(200, { ok: true, state: "paused" }), "unexpected"],
    ["200 で本文が JSON でなければ unexpected", { status: 200, json: async () => { throw new SyntaxError("x"); } }, "unexpected"],
    ["404 は unexpected", reply(404, {}), "unexpected"],
    ["例外は network", "throw", "network"],
  ])("失敗の分類: %s", async (_name, response, kind) => {
    const fetchLike: FetchLike = async () => {
      if (response === "throw") throw new TypeError("Failed to fetch SECRET");
      return response;
    };
    const result = await fetchMigration(fetchLike);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
  });

  it("失敗の文言は固定で、サーバの文面・例外の文面を含まない", async () => {
    const result = await fetchMigration(async () => reply(503, { ok: false, error: { type: "migration-error", message: "SECRET-MESSAGE" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = migrationFetchFailureMessage(result.error);
      expect(text).not.toContain("SECRET");
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

describe("postMigrationUpload(POST /api/migration/upload)", () => {
  const FILE = new Blob([new Uint8Array([1, 2, 3])]);

  it("サーバが要求する形で送る: POST・Content-Type application/gzip・本文は Blob そのもの(文字列化・全読みをしない)・same-origin", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return reply(202, IMPORTING_BODY);
    };
    const result = await postMigrationUpload(fetchLike, FILE);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("/api/migration/upload");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/gzip" });
    expect(init.body).toBe(FILE);
    expect(init.credentials).toBe("same-origin");
    expect(init.referrerPolicy).toBe("same-origin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.progress!.state).toBe("importing");
  });

  it("202 でも本文が想定外なら、受け付けは成功(progress は null。画面は取り直す)", async () => {
    const result = await postMigrationUpload(async () => reply(202, { ok: true }), FILE);
    expect(result).toEqual({ ok: true, progress: null });
  });

  it.each<[string, Resp, UploadFailure]>([
    ["409 は busy", reply(409, { ok: false, error: { type: "migration-busy", message: "m" } }), { kind: "busy" }],
    ["413 は too-large", reply(413, { ok: false, error: { type: "payload-too-large" } }), { kind: "too-large" }],
    ["503 で r2-fence は r2-fence", reply(503, { ok: false, error: { type: "r2-fence", message: "m" } }), { kind: "r2-fence" }],
    ["503 でそれ以外は server-error", reply(503, { ok: false, error: { type: "migration-error" } }), { kind: "server-error" }],
    ["503 で本文が無くても server-error", { status: 503, json: async () => { throw new SyntaxError("x"); } }, { kind: "server-error" }],
    ["411 は bad-request", reply(411, { ok: false, error: { type: "length-required" } }), { kind: "bad-request" }],
    ["415 は bad-request", reply(415, { ok: false, error: { type: "unsupported-media-type" } }), { kind: "bad-request" }],
    ["400 は bad-request", reply(400, { ok: false }), { kind: "bad-request" }],
    ["403 で origin-mismatch は origin-mismatch", reply(403, { ok: false, error: { type: "origin-mismatch" } }), { kind: "origin-mismatch" }],
    ["403 でそれ以外(Access の拒否は平文)は forbidden", reply(403, "forbidden"), { kind: "forbidden" }],
    ["500 は unexpected", reply(500, {}), { kind: "unexpected", httpStatus: 500 }],
  ])("失敗の分類: %s", async (_name, response, expected) => {
    const result = await postMigrationUpload(async () => response, FILE);
    expect(result).toEqual({ ok: false, error: expected });
  });

  it("例外(通信の失敗・ログイン切れで HTML に飛ばされた等)は network", async () => {
    const result = await postMigrationUpload(async () => { throw new TypeError("Failed to fetch"); }, FILE);
    expect(result).toEqual({ ok: false, error: { kind: "network" } });
  });

  it("失敗の文言(日本語の固定文)に、サーバの文面・例外の文面は入らず、種類ごとに内容が違う", async () => {
    const kinds: UploadFailure[] = [{ kind: "busy" }, { kind: "too-large" }, { kind: "r2-fence" }, { kind: "server-error" }, { kind: "bad-request" }, { kind: "forbidden" }, { kind: "origin-mismatch" }, { kind: "network" }, { kind: "unexpected", httpStatus: 500 }];
    const texts = kinds.map((k) => uploadFailureMessage(k));
    expect(new Set(texts).size).toBe(kinds.length);
    expect(texts[0]).toContain("取り込み中");
    expect(texts[1]).toContain("50MB");
    expect(texts[2]).toContain("R2");
    expect(texts[8]).toContain("500");
  });
});
