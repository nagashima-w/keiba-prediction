import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";

import {
  JRA_ACCESS_BODY,
  JRA_ACCESS_URL,
  JRA_CHECK_GAP_MS,
  JRA_CHECK_MAX_BODY_BYTES,
  JRA_CHECK_TIMEOUT_MS,
  JRA_CUSHION_URL,
  runJraCheck,
  type JraFetchLike,
} from "../src/jra-check";

import { installFetchTrap } from "./fetch-trap";
import { pathFromMeta } from "./meta-path";

/**
 * Issue #488(#477-A1): Worker のグローバルの fetch で JRA のページに届くかを確かめる確認口の部品(runJraCheck)。
 * **実サイトには一切出ない**: すべて注入した偽の fetch と偽の待ちで確かめる(グローバルの `fetch` は呼ばれたら落ちるスタブ。待ちも実時間を使わない)。
 * フィクスチャは調査(#477)で実際に取った応答の生のバイト(Shift_JIS)。
 */

installFetchTrap();

const FIXTURES = pathFromMeta("../../fixtures/", import.meta.url);
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURES}${name}`));
const CUSHION = fixtureBytes("jra_baba_cushion_20261025.html");
const ACCESS = fixtureBytes("jra_access_j_20261025.json");

/** 実サイトと同じ Shift_JIS のバイト列にする。 */
const encoder = { encode: (text: string): Uint8Array => new Uint8Array(iconv.encode(text, "shift_jis")) };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

interface Harness {
  readonly fetch: JraFetchLike;
  readonly wait: (ms: number) => Promise<void>;
  /** 呼び出しの順序(`fetch GET <url>`・`fetch POST <url>`・`wait <ms>`)。 */
  readonly events: string[];
  readonly calls: Call[];
}

function harness(respond: (call: Call, index: number) => Promise<Response> | Response): Harness {
  const events: string[] = [];
  const calls: Call[] = [];
  return {
    events,
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      events.push(`fetch ${init.method ?? "GET"} ${url}`);
      calls.push(call);
      return respond(call, calls.length - 1);
    },
    wait: async (ms) => {
      events.push(`wait ${ms}`);
    },
  };
}

const okResponses = (call: Call): Response =>
  call.url === JRA_CUSHION_URL
    ? new Response(CUSHION, { status: 200, headers: { "content-type": "text/html" } })
    : new Response(ACCESS, { status: 200, headers: { "content-type": "text/html" } });

describe("取得の順序と形(実サイトの代わりに偽の fetch)", () => {
  it("1 本目は クッション値のページの GET、1.5 秒以上の待ち、2 本目は 開催情報の POST の順で、各 1 回だけ。再試行しない", async () => {
    const h = harness(okResponses);
    await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(JRA_CHECK_GAP_MS).toBeGreaterThanOrEqual(1500);
    expect(h.events).toEqual([`fetch GET ${JRA_CUSHION_URL}`, `wait ${JRA_CHECK_GAP_MS}`, `fetch POST ${JRA_ACCESS_URL}`]);
    expect(JRA_CUSHION_URL).toBe("https://www.jra.go.jp/keiba/baba/_data_cushion.html");
    expect(JRA_ACCESS_URL).toBe("https://www.jra.go.jp/JRADB/accessJ.html");
    expect(JRA_ACCESS_BODY).toBe("CNAME=pw01iwtS3/CD");
  });

  it("リダイレクトを追わない(redirect: manual)。タイムアウトの signal を付ける。UA などのヘッダは足さない(POST の Content-Type と本文だけ)", async () => {
    const h = harness(okResponses);
    await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) {
      expect(call.init.redirect).toBe("manual");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    const [get, post] = h.calls;
    expect(get!.init.method).toBe("GET");
    expect(get!.init.headers).toBeUndefined();
    expect(get!.init.body).toBeUndefined();
    expect(post!.init.method).toBe("POST");
    expect(post!.init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(post!.init.body).toBe("CNAME=pw01iwtS3/CD");
  });

  it("1 本目が失敗(ネットワーク)でも、待ちを入れて 2 本目を取る(2 本は独立した計測)", async () => {
    const h = harness((call) => {
      if (call.url === JRA_CUSHION_URL) throw new TypeError("fetch failed");
      return okResponses(call);
    });
    const result = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(h.events).toEqual([`fetch GET ${JRA_CUSHION_URL}`, `wait ${JRA_CHECK_GAP_MS}`, `fetch POST ${JRA_ACCESS_URL}`]);
    expect(result.cushion.status).toBe("network");
    expect(result.cushion.ok).toBe(false);
    expect(result.access.status).toBe(200);
    expect(result.access.ok).toBe(true);
  });
});

describe("実フィクスチャ(Shift_JIS の生のバイト)で期待した形が見える", () => {
  it("クッション値のページ: 200・場名の一覧(文字化けなし)・最初の場の先頭の time の文字列・大きさ・Content-Type・ok", async () => {
    const h = harness(okResponses);
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(CUSHION.byteLength).toBeGreaterThan(3000); // 前提: フィクスチャを読めている
    expect(cushion).toEqual({
      status: 200,
      httpStatus: 200,
      bytes: CUSHION.byteLength,
      contentType: "text/html",
      ok: true,
      venues: expect.any(Array),
      firstTime: "10月25日（日曜）7時00分",
    });
    expect(cushion.venues.slice(0, 3)).toEqual(["東京", "京都", "新潟"]);
    expect(cushion.venues.length).toBeGreaterThanOrEqual(3);
  });

  it("開催情報の POST: 200・JSON として解釈できた・kaisai_info の件数と各要素の jyoname・kaisai_ymd・ok", async () => {
    const h = harness(okResponses);
    const { access } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    const expected = (JSON.parse(new TextDecoder("utf-8").decode(ACCESS.map((b) => (b < 0x80 ? b : 0x3f)))) as { kaisai_info: unknown[] }).kaisai_info.length;
    expect(expected).toBeGreaterThanOrEqual(3); // 前提: フィクスチャの件数(ASCII 以外を ? に置換して構造だけ読む)
    expect(access.status).toBe(200);
    expect(access.bytes).toBe(ACCESS.byteLength);
    expect(access.contentType).toBe("text/html");
    expect(access.ok).toBe(true);
    expect(access.parsedJson).toBe(true);
    expect(access.kaisaiInfoCount).toBe(expected);
    expect(access.kaisaiInfo).toHaveLength(expected);
    expect(access.kaisaiInfo.slice(0, 3)).toEqual([
      { jyoname: "東京", kaisai_ymd: "20261025" },
      { jyoname: "京都", kaisai_ymd: "20261025" },
      { jyoname: "新潟", kaisai_ymd: "20261025" },
    ]);
  });

  it("応答に本文もヘッダ全体も出ない(許可リストの形)。本文の特徴的な断片・Set-Cookie の値を含まない", async () => {
    const h = harness((call) => {
      const res = okResponses(call);
      res.headers.set("set-cookie", "SECRETCOOKIE=abc");
      res.headers.set("x-secret-header", "SECRETHEADER");
      return res;
    });
    const result = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    const text = JSON.stringify(result);
    for (const leaked of ["cushion_data_list", "class=\"unit\"", "decided_link_para", "SECRETCOOKIE", "SECRETHEADER", "稍重"]) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(Object.keys(result.cushion).sort()).toEqual(["bytes", "contentType", "firstTime", "httpStatus", "ok", "status", "venues"]);
    expect(Object.keys(result.access).sort()).toEqual(["bytes", "contentType", "httpStatus", "kaisaiInfo", "kaisaiInfoCount", "ok", "parsedJson", "status"]);
  });
});

describe("期待した形でないとき ok は false(状態が 200 でも)", () => {
  const html = (text: string, status = 200): Response => new Response(encoder.encode(text), { status, headers: { "content-type": "text/html" } });

  it("200 でも 場名が無い(ブロックのページ等)なら クッション値は ok: false。venues は空・firstTime は null", async () => {
    const h = harness((call) => (call.url === JRA_CUSHION_URL ? html("<html>Access Denied</html>") : okResponses(call)));
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.status).toBe(200);
    expect(cushion.ok).toBe(false);
    expect(cushion.venues).toEqual([]);
    expect(cushion.firstTime).toBeNull();
    expect(cushion.bytes).toBe(encoder.encode("<html>Access Denied</html>").byteLength);
  });

  it("場名はあるが 最初の場に time が無いなら ok: false", async () => {
    const h = harness((call) => (call.url === JRA_CUSHION_URL ? html('<div id="rcA" title="東京"></div>') : okResponses(call)));
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.venues).toEqual(["東京"]);
    expect(cushion.firstTime).toBeNull();
    expect(cushion.ok).toBe(false);
  });

  it("最初の場の time は、2 番目の場の time を取り違えない(最初の場に無ければ null)", async () => {
    const page = '<div id="rcA" title="東京"></div><div id="rcB" title="京都"><div class="time">10月25日（日曜）6時00分</div></div>';
    const h = harness((call) => (call.url === JRA_CUSHION_URL ? html(page) : okResponses(call)));
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.venues).toEqual(["東京", "京都"]);
    expect(cushion.firstTime).toBeNull();
    expect(cushion.ok).toBe(false);
  });

  it("403 は status 403・ok: false。本文の大きさは読んだ数、形は見えない", async () => {
    const h = harness(() => html("blocked", 403));
    const { cushion, access } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    for (const r of [cushion, access]) {
      expect(r.status).toBe(403);
      expect(r.httpStatus).toBe(403);
      expect(r.bytes).toBe(7);
      expect(r.ok).toBe(false);
    }
    expect(access.parsedJson).toBe(false);
    expect(access.kaisaiInfoCount).toBeNull();
  });

  it("POST の本文が JSON でない(200)なら parsedJson: false・ok: false", async () => {
    const h = harness((call) => (call.url === JRA_ACCESS_URL ? html("<html>not json</html>") : okResponses(call)));
    const { access } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(access.status).toBe(200);
    expect(access.parsedJson).toBe(false);
    expect(access.kaisaiInfoCount).toBeNull();
    expect(access.kaisaiInfo).toEqual([]);
    expect(access.ok).toBe(false);
  });

  it("JSON だが kaisai_info が配列でないなら ok: false(parsedJson は true)", async () => {
    const h = harness((call) => (call.url === JRA_ACCESS_URL ? html('{"kaisai_info": "x"}') : okResponses(call)));
    const { access } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(access.parsedJson).toBe(true);
    expect(access.kaisaiInfoCount).toBeNull();
    expect(access.ok).toBe(false);
  });

  it("開催のない日(kaisai_info が 0 件の配列)は ok: true・件数 0(「届いたが開催日でない」を「弾かれた」と区別する)", async () => {
    const h = harness((call) => (call.url === JRA_ACCESS_URL ? html('{"kaisai_info": []}') : okResponses(call)));
    const { access } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(access.parsedJson).toBe(true);
    expect(access.kaisaiInfoCount).toBe(0);
    expect(access.kaisaiInfo).toEqual([]);
    expect(access.ok).toBe(true);
  });

  it("要約は長さを抑える: 長い場名・jyoname・time は切り、要素の数にも上限がある。文字列でない値は null", async () => {
    const long = "あ".repeat(500);
    const page = `<div id="rcA" title="${long}"><div class="time">${long}</div></div>`;
    const many = Array.from({ length: 50 }, () => ({ jyoname: long, kaisai_ymd: 20261025 }));
    const h = harness((call) => (call.url === JRA_CUSHION_URL ? html(page) : html(JSON.stringify({ kaisai_info: many }))));
    const { cushion, access } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.venues[0]!.length).toBeLessThanOrEqual(20);
    expect(cushion.firstTime!.length).toBeLessThanOrEqual(60);
    expect(access.kaisaiInfoCount).toBe(50); // 件数は実際の数
    expect(access.kaisaiInfo.length).toBeLessThanOrEqual(20);
    expect(access.kaisaiInfo[0]!.jyoname!.length).toBeLessThanOrEqual(20);
    expect(access.kaisaiInfo[0]!.kaisai_ymd).toBeNull();
  });
});

describe("失敗の分類(timeout・network・redirect・too-large)", () => {
  it("3xx は redirect(追わない)。HTTP の状態は httpStatus に、bytes は null。Location は返さない", async () => {
    const h = harness(() => new Response(null, { status: 302, headers: { location: "https://secret.invalid/next" } }));
    const result = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    for (const r of [result.cushion, result.access]) {
      expect(r.status).toBe("redirect");
      expect(r.httpStatus).toBe(302);
      expect(r.bytes).toBeNull();
      expect(r.ok).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
    expect(h.calls).toHaveLength(2); // 追わない
  });

  it("fetch が投げた例外は network(メッセージは返さない)。TimeoutError・AbortError は timeout", async () => {
    const names: [string, string][] = [
      ["network", "TypeError"],
      ["timeout", "TimeoutError"],
      ["timeout", "AbortError"],
    ];
    for (const [expected, name] of names) {
      const h = harness(() => {
        const error = new Error("詳細 SECRET-DETAIL");
        error.name = name;
        throw error;
      });
      const result = await runJraCheck({ fetch: h.fetch, wait: h.wait });
      expect(result.cushion.status, name).toBe(expected);
      expect(result.cushion.httpStatus).toBeNull();
      expect(result.cushion.bytes).toBeNull();
      expect(result.cushion.contentType).toBeNull();
      expect(result.cushion.ok).toBe(false);
      expect(JSON.stringify(result), name).not.toContain("SECRET-DETAIL");
    }
  });

  it("実際にタイムアウトする(応答が来ない)と timeout。signal で打ち切る", async () => {
    expect(JRA_CHECK_TIMEOUT_MS).toBe(10_000);
    const h = harness(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal!.addEventListener("abort", () => reject(call.init.signal!.reason));
        }),
    );
    const result = await runJraCheck({ fetch: h.fetch, wait: h.wait, timeoutMs: 20 });
    expect(result.cushion.status).toBe("timeout");
    expect(result.access.status).toBe("timeout");
  });

  it("本文の読み出し中のタイムアウトも timeout(状態は分かっているので httpStatus は残る)", async () => {
    const h = harness((call) => {
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise((_resolve, reject) => {
            call.init.signal!.addEventListener("abort", () => reject(call.init.signal!.reason));
          });
        },
      });
      return new Response(stream, { status: 200 });
    });
    const result = await runJraCheck({ fetch: h.fetch, wait: h.wait, timeoutMs: 20 });
    expect(result.cushion.status).toBe("timeout");
    expect(result.cushion.httpStatus).toBe(200);
    expect(result.cushion.bytes).toBeNull();
    expect(result.cushion.ok).toBe(false);
  });

  it("Content-Length が上限を超える宣言なら too-large(本文を読まない)。bytes は null", async () => {
    expect(JRA_CHECK_MAX_BODY_BYTES).toBe(256 * 1024);
    let cancelled = false;
    const h = harness(() => {
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-length": String(JRA_CHECK_MAX_BODY_BYTES + 1), "content-type": "text/html" } });
    });
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.status).toBe("too-large");
    expect(cushion.httpStatus).toBe(200);
    expect(cushion.bytes).toBeNull();
    expect(cushion.contentType).toBe("text/html");
    expect(cushion.ok).toBe(false);
    expect(cancelled).toBe(true); // 本文は読まずに捨てる
  });

  it("Content-Length が無くても、読んだ累計が上限を超えたら打ち切って too-large", async () => {
    const chunk = new Uint8Array(JRA_CHECK_MAX_BODY_BYTES / 2 + 1);
    let cancelled = false;
    let sent = 0;
    const h = harness(() => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200 });
    });
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.status).toBe("too-large");
    expect(cushion.bytes).toBeNull();
    expect(sent).toBeGreaterThanOrEqual(2); // 前提: 2 個目のチャンクで超えた
    expect(cancelled).toBe(true);
  });

  it("上限を 1 バイトだけ超える本文(Content-Length が無い)は too-large(境界)", async () => {
    const h = harness(() => new Response(new Uint8Array(JRA_CHECK_MAX_BODY_BYTES + 1), { status: 200 }));
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.status).toBe("too-large");
    expect(cushion.bytes).toBeNull();
  });

  it("上限ちょうどの本文は読める(too-large にならない)", async () => {
    const h = harness(() => new Response(new Uint8Array(JRA_CHECK_MAX_BODY_BYTES), { status: 200 }));
    const { cushion } = await runJraCheck({ fetch: h.fetch, wait: h.wait });
    expect(cushion.status).toBe(200);
    expect(cushion.bytes).toBe(JRA_CHECK_MAX_BODY_BYTES);
  });
});
