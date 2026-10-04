/**
 * Worker の `POST /echo`・`POST /netkeiba-socket` の処理(Issue #160〈#21-B〉)。共有秘密の検査は前面の
 * `worker.ts` が行うので、ここへ来るのは認可済みのリクエストだけ。それでも入力は検査する
 * (`scripts/cloudflare-spike/worker-input.ts`。固定表以外の宛先・許可ホスト以外・禁止ヘッダ・制御文字は 400)。
 *
 * `cloudflare:sockets` はここでは import しない(`connect` を引数で受ける)。Node の vitest で呼べるようにするため。
 */

import { validateEchoRequest, validateSocketRequest } from "../../../scripts/cloudflare-spike/worker-input.js";
import { fetchEcho } from "./echo-fetch.js";
import { probeNetkeiba, type ProbeFetch } from "./netkeiba-probe.js";
import { json } from "./json.js";
import { createSocketFetch, type ConnectFn } from "./socket-probe.js";

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: (await request.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * `POST /echo`(本文: `{service}`)。固定表の URL へ、netkeiba と同じ経路・同じヘッダで1回だけ取りに行き、
 * 結果を `{ok: true, result}` で返す。エコーが 403 などでも Worker の応答は 200(エコーの結果として運ぶ)。
 */
export async function handleEcho(request: Request, fetchImpl?: ProbeFetch): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) {
    return json({ ok: false, error: "JSON ではありません" }, 400);
  }
  const v = validateEchoRequest(parsed.body);
  if (!v.ok) {
    return json({ ok: false, error: v.error }, 400);
  }
  const result = await fetchEcho(v.value.service, fetchImpl);
  return json({ ok: true, result });
}

/**
 * `POST /netkeiba-socket`(本文: `{targetId, url, kind, encoding, headers}`)。ソケットで1本だけ取得し、
 * 記録を `{ok: true, record}` で返す。**再試行もリダイレクトの追従もしない**(1回の呼び出しで接続は1回)。
 * ソケットを開けない場合も 200 で、記録(status=null と理由)として返す(利用不可の事実を結果に残すため)。
 */
export async function handleNetkeibaSocket(request: Request, connect: ConnectFn): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) {
    return json({ ok: false, error: "JSON ではありません" }, 400);
  }
  const v = validateSocketRequest(parsed.body);
  if (!v.ok) {
    return json({ ok: false, error: v.error }, 400);
  }
  const { targetId, url, kind, encoding, headers } = v.value;
  const record = await probeNetkeiba({ targetId, url, kind, encoding }, createSocketFetch(connect, { headers }));
  return json({ ok: true, record });
}
