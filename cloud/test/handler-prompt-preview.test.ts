import { describe, expect, it } from "vitest";
import { buildPromptPreview, resolveClipVariant } from "@keiba/core/analyzer/build-prompt";
import { handle, type Env } from "../src/handler";
import { buildPreviewText } from "../src/prompt-preview";
import { clampAdditionalInstruction } from "../src/settings";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #396: `POST /api/settings/prompt-preview`(設定画面のプロンプトのプレビューを、サーバが組み立てて返す)。
 * 守り(Origin 403 → Content-Type 415 → 413 → 400)の順序は `handler-json-guard.test.ts` が表で固定する。役割(管理者専用)は `handler-roles.test.ts`・`route-policy.test.ts`。
 * ここはルート固有の動作: 入力の検証・応答の形・**もとのクライアント実装(`client/prompt-preview.ts`。#396 で削除)と同じ文面を返すこと**・裏側に触れないこと。
 * 文面の「もとの手順」は、このテストの `expectedText`(切る → 版を解決 → `buildPromptPreview`)に手で書く(サーバの関数を呼んで期待値を作らない)。
 * 送信側の文面との一致は `race-day-llm.test.ts` の e10 が固定する。
 */

const ORIGIN = "https://cloud.invalid";
const PATH = "/api/settings/prompt-preview";

function trackedEnv(): { env: Env; touched: () => string[] } {
  const touched: string[] = [];
  const authKeys = new Set<string | symbol>(["ACCESS_TEAM_NAME", "ACCESS_AUD", "ACCESS_ALLOWED_EMAIL", "ADMIN_USER"]);
  const env = new Proxy({ ...GOOD_ENV } as Record<string | symbol, unknown>, {
    get(target, key) {
      if (!authKeys.has(key)) touched.push(String(key));
      return target[key];
    },
  }) as unknown as Env;
  return { env, touched: () => touched };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  return { deps, token: await signToken(key), viewer: await signToken(key, { email: "friend@example.com" }) };
}

function post(token: string | undefined, body: unknown, over: { origin?: string | null; raw?: string } = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  const origin = over.origin === undefined ? ORIGIN : over.origin;
  if (origin !== null) headers.set("Origin", origin);
  return new Request(`${ORIGIN}${PATH}`, { method: "POST", headers, body: over.raw ?? JSON.stringify(body) });
}

/** もとのクライアント実装(`client/prompt-preview.ts`)の手順を、ここに手で書いたもの。 */
function expectedText(additionalInstruction: string, clipVariant: string): { text: string; clamped: boolean; promptVersion: string } {
  const instruction = clampAdditionalInstruction(additionalInstruction);
  const variant = resolveClipVariant(clipVariant);
  return { text: buildPromptPreview(instruction.text, variant.id), clamped: instruction.clamped, promptVersion: variant.promptVersion };
}

describe("POST /api/settings/prompt-preview: 文面は、もとのクライアント実装と同じ(バイト一致)", () => {
  const cases: { name: string; instruction: string; clipVariant: string; clamped: boolean }[] = [
    { name: "空・default", instruction: "", clipVariant: "default", clamped: false },
    { name: "空白と改行のみ・default", instruction: "   \n  ", clipVariant: "default", clamped: false },
    { name: "短い指示・wide15", instruction: "逃げ馬を重視してください", clipVariant: "wide15", clamped: false },
    { name: "未知の版 ID は default に解決する", instruction: "x", clipVariant: "bogus", clamped: false },
    { name: "ちょうど 2,000 単位は切らない", instruction: "あ".repeat(2000), clipVariant: "default", clamped: false },
    { name: "2,001 単位は 2,000 単位に切る", instruction: "あ".repeat(2001), clipVariant: "wide15", clamped: true },
    { name: "2,100 単位(D1 へ直接入れた長い値)", instruction: "あ".repeat(2100), clipVariant: "default", clamped: true },
    { name: "2,000 単位目がサロゲートペアの途中: ペアごと落とす", instruction: `${"あ".repeat(1999)}😀`, clipVariant: "default", clamped: true },
    { name: "サロゲートペアが 2,000 単位に収まる", instruction: `${"あ".repeat(1998)}😀`, clipVariant: "wide15", clamped: false },
    { name: "JSON のエスケープが要る文字(引用符・バックスラッシュ・改行・タブ)", instruction: "\"引用\" \\ \n\t 終わり", clipVariant: "default", clamped: false },
  ];

  it.each(cases)("$name", async ({ instruction, clipVariant, clamped }) => {
    const { deps, token } = await setup();
    const { env, touched } = trackedEnv();
    const response = await handle(post(token, { additionalInstruction: instruction, clipVariant }), env, {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; text: string; clamped: boolean; promptVersion: string };
    const expected = expectedText(instruction, clipVariant);
    expect(body).toEqual({ ok: true, ...expected });
    expect(body.clamped).toBe(clamped); // 前提: 切り詰めの有無が期待どおり
    expect(body.text).toBe(buildPreviewText({ additionalInstruction: instruction, clipVariant }).text);
    expect(touched(), "env のバインディング(D1・DO・R2)に触れない").toEqual([]);
  });

  it("前提(空振り防止): 版・追加指示・切り詰めで文面が実際に変わる(上の表が同じ文面を返しているだけではない)", async () => {
    const { deps, token } = await setup();
    const textOf = async (additionalInstruction: string, clipVariant: string): Promise<string> =>
      ((await (await handle(post(token, { additionalInstruction, clipVariant }), trackedEnv().env, {}, deps)).json()) as { text: string }).text;
    const base = await textOf("", "default");
    const wide = await textOf("", "wide15");
    const withInstruction = await textOf("追加の指示", "default");
    const cut = await textOf("あ".repeat(2100), "default");
    const uncut = buildPromptPreview("あ".repeat(2100), "default");
    expect(wide).not.toBe(base);
    expect(withInstruction).not.toBe(base);
    expect(base.length).toBeGreaterThan(1000);
    expect(uncut.length - cut.length, "切った分(2,100 − 2,000)だけ短い").toBe(100);
  });
});

describe("POST /api/settings/prompt-preview: 入力の検証(400。入力の値を本文に写さない)", () => {
  const MESSAGE = "本文は additionalInstruction(文字列)と clipVariant(文字列)の 2 項目だけにしてください";
  it.each([
    ["clipVariant が無い", { additionalInstruction: "a" }],
    ["additionalInstruction が無い", { clipVariant: "default" }],
    ["空のオブジェクト", {}],
    ["additionalInstruction が文字列でない", { additionalInstruction: 5, clipVariant: "default" }],
    ["clipVariant が文字列でない", { additionalInstruction: "a", clipVariant: null }],
    ["additionalInstruction が配列", { additionalInstruction: ["a"], clipVariant: "default" }],
    ["余計なキーがある", { additionalInstruction: "a", clipVariant: "default", extra: "秘密の値" }],
    ["キーが 2 つでも名前が違う", { additionalInstruction: "a", clip: "default" }],
  ])("%s は 400(固定の message)。裏側に触れない", async (_name, body) => {
    const { deps, token } = await setup();
    const { env, touched } = trackedEnv();
    const response = await handle(post(token, body), env, {}, deps);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "bad-request", message: MESSAGE } });
    expect(text).not.toContain("秘密の値");
    expect(touched()).toEqual([]);
  });
});

describe("POST /api/settings/prompt-preview: 役割・メソッド・守り", () => {
  it("閲覧者・認証なしは 403(閲覧者は admin-only の固定の本文)。本文を読まず、裏側に触れない", async () => {
    const { deps, viewer } = await setup();
    const { env, touched } = trackedEnv();
    const req = post(viewer, { additionalInstruction: "", clipVariant: "default" });
    const response = await handle(req, env, {}, deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { type: "admin-only" } });
    expect(req.bodyUsed).toBe(false);
    expect(touched()).toEqual([]);
    const anon = await handle(post(undefined, { additionalInstruction: "", clipVariant: "default" }), trackedEnv().env, {}, deps);
    expect(anon.status).toBe(403);
    expect(await anon.text()).toBe("forbidden");
  });

  it("Origin が無い・別のオリジンは 403(origin-mismatch)。管理者でも(CSRF)", async () => {
    const { deps, token } = await setup();
    for (const origin of [null, "https://evil.example"]) {
      const response = await handle(post(token, { additionalInstruction: "", clipVariant: "default" }, { origin }), trackedEnv().env, {}, deps);
      expect(response.status, String(origin)).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    }
  });

  it("POST 以外のメソッドは、管理者でも文面を返さない(GET・PUT・DELETE は 405 か 404 系。200 にならない)", async () => {
    const { deps, token } = await setup();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const headers = new Headers({ "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN });
      const response = await handle(new Request(`${ORIGIN}${PATH}`, { method, headers }), trackedEnv().env, {}, deps);
      expect(response.status, method).not.toBe(200);
      expect(await response.text(), method).not.toContain("【予想印】");
    }
  });

  it("本文の上限は 16 KiB: 追加指示 2,001 単位(最悪の JSON エスケープで約 12 KB)は通り、17 KiB は 413", async () => {
    const { deps, token } = await setup();
    // 制御文字 \u0001 は JSON で 6 バイト。2,001 単位でも 16 KiB に収まる最悪の入力
    const worst = JSON.stringify({ additionalInstruction: "\u0001".repeat(2001), clipVariant: "default" });
    expect(Buffer.byteLength(worst), "前提: 最悪の入力でも上限に収まる").toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(worst), "前提: 6 バイト × 2,001 を超える").toBeGreaterThan(12_000);
    const ok = await handle(post(token, undefined, { raw: worst }), trackedEnv().env, {}, deps);
    expect(ok.status).toBe(200);
    const big = JSON.stringify({ additionalInstruction: "a".repeat(17 * 1024), clipVariant: "default" });
    const tooBig = await handle(post(token, undefined, { raw: big }), trackedEnv().env, {}, deps);
    expect(tooBig.status).toBe(413);
  });
});

describe("2,001 単位に縮めた追加指示は、元の長文と同じ位置で切れ、同じ clamped を返す(クライアントは 2,001 単位だけを送る。Issue #396)", () => {
  const LIMIT = 2000;
  const cases: { name: string; text: string }[] = [
    { name: "BMP だけの長文", text: "あ".repeat(5000) },
    { name: "2,000 単位目がサロゲートペアの前半(ペアをまたいで切れるのでペアごと落とす)", text: `${"あ".repeat(1999)}😀${"い".repeat(500)}` },
    { name: "ペアが 1,999〜2,000 単位目にちょうど収まり、次のペアの前半が 2,001 単位目(縮めた入力の末尾に孤立した前半が残る)", text: `${"あ".repeat(1998)}😀😀${"い".repeat(500)}` },
    { name: "ちょうど 2,001 単位", text: "あ".repeat(2001) },
    { name: "2,000 単位以下", text: "あ".repeat(1500) },
    { name: "ちょうど 2,000 単位", text: "あ".repeat(2000) },
  ];
  it.each(cases)("$name", async ({ text }) => {
    const { deps, token } = await setup();
    const response = await handle(post(token, { additionalInstruction: text.slice(0, LIMIT + 1), clipVariant: "default" }), trackedEnv().env, {}, deps);
    const body = (await response.json()) as { text: string; clamped: boolean };
    const original = expectedText(text, "default"); // 元の長文を送ったとき(もとのクライアント実装)の結果
    expect(body.text).toBe(original.text);
    expect(body.clamped).toBe(original.clamped);
  });

  it("前提(空振り防止): 上の表に、切る場合(clamped)・切らない場合の両方があり、サロゲートの境界のケースで切り位置が 2,000 でなく 1,999 になる", () => {
    const flags = cases.map((c) => clampAdditionalInstruction(c.text).clamped);
    expect(flags).toEqual([true, true, true, true, false, false]);
    expect(clampAdditionalInstruction(cases[1]!.text).text.length, "ペアごと落とすので 1,999").toBe(1999);
    expect(clampAdditionalInstruction(cases[2]!.text).text.length, "ペアが 2,000 単位にちょうど収まるときは落とさない").toBe(2000);
    expect(cases[2]!.text.slice(0, LIMIT + 1).charCodeAt(LIMIT), "縮めた入力の末尾(2,001 単位目)は孤立した上位サロゲート").toBeGreaterThanOrEqual(0xd800);
  });
});
