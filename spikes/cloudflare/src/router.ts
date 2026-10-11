/**
 * Worker と Durable Object で共有するリクエストの処理(Issue #159〈#21-A〉)。
 * 認可(共有秘密)は前面の Worker だけが行い、DO は Worker のバインディング経由でしか呼ばれない。
 */

import { isAllowedUrl, TARGET_KINDS, type TargetKind } from "../../../scripts/cloudflare-spike/targets.js";
import type { CpuRuntime } from "../../../scripts/cloudflare-spike/result.js";
import { isCpuWork, MAX_REPS, runCpu } from "./handlers.js";
import { json } from "./json.js";
import { probeNetkeiba } from "./netkeiba-probe.js";

export { json };

/** `/cpu/<work>?reps=N` を処理する(runtime ごとの I/O を注入)。 */
export async function handleCpu(
  runtime: CpuRuntime,
  workName: string,
  url: URL,
  io: () => Promise<unknown>,
): Promise<Response> {
  if (!isCpuWork(workName)) {
    return json({ ok: false, error: `未知の処理: ${workName}` }, 404);
  }
  const reps = Number(url.searchParams.get("reps") ?? "1");
  if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) {
    return json({ ok: false, error: `reps は 1〜${MAX_REPS} の整数` }, 400);
  }
  return json(await runCpu(runtime, workName, reps, io));
}

/**
 * `POST /netkeiba`(本文: {targetId, url, kind, encoding})。1回の呼び出しで netkeiba へ出す
 * リクエストはちょうど1本。許可ホスト(race / db / nar の netkeiba.com)以外の URL は、共有秘密を
 * 持っていても取得しない。
 */
export async function handleNetkeiba(request: Request): Promise<Response> {
  let body: { targetId?: unknown; url?: unknown; kind?: unknown; encoding?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "JSON ではありません" }, 400);
  }
  const { targetId, url, kind, encoding } = body;
  if (
    typeof targetId !== "string" ||
    typeof url !== "string" ||
    !isAllowedUrl(url) ||
    typeof kind !== "string" ||
    !(TARGET_KINDS as readonly string[]).includes(kind) ||
    (encoding !== "utf-8" && encoding !== "euc-jp")
  ) {
    return json({ ok: false, error: "リクエストが不正、または許可されていない URL です" }, 400);
  }
  const record = await probeNetkeiba({ targetId, url, kind: kind as TargetKind, encoding });
  return json({ ok: true, record });
}
