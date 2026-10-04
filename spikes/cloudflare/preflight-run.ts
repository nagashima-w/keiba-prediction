/**
 * ワークフローの関門: トークンの有効性と Workers の権限を、実際の API 呼び出しで確かめる
 * (Issue #159〈#21-A〉)。判定は `scripts/cloudflare-spike/preflight.ts` の純関数 `judgePreflight`。
 * 足りないものがあれば、何が足りないかを `::error::` で出して exit 1 で止まる。
 *
 * 権限の自己申告(トークンのポリシーを読む)には別の権限が要るため頼らず、**実際の呼び出しの成否**で
 * 判定する: 一覧の取得(読み取り)・workers.dev のサブドメイン・最小の Worker の作成と削除。
 */

import { appendFileSync } from "node:fs";
import {
  judgePreflight,
  type HttpProbe,
  type PreflightInput,
  type SubdomainProbe,
  type VerifyProbe,
} from "../../scripts/cloudflare-spike/preflight.js";
import { cfApi, head } from "./cf-api.js";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resultField(text: string, field: string): string | null {
  const parsed = parseJson(text) as { result?: Record<string, unknown> | null } | null;
  const value = parsed?.result?.[field];
  return typeof value === "string" ? value : null;
}

async function verify(token: string, path: string): Promise<VerifyProbe> {
  const r = await cfApi(token, path);
  return { status: r.status, tokenStatus: resultField(r.text, "status"), bodyHead: head(r.text) };
}

async function main(): Promise<void> {
  const token = process.env["CLOUDFLARE_API_TOKEN"] ?? "";
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  const runId = process.env["GITHUB_RUN_ID"] ?? "local";

  const base: PreflightInput = {
    tokenPresent: token !== "",
    accountIdPresent: accountId !== "",
    userVerify: null,
    accountVerify: null,
    listScripts: null,
    subdomain: null,
    putProbe: null,
    deleteProbe: null,
  };
  let input = base;

  if (base.tokenPresent && base.accountIdPresent) {
    const userVerify = await verify(token, "/user/tokens/verify");
    const accountVerify = await verify(token, `/accounts/${accountId}/tokens/verify`);
    input = { ...input, userVerify, accountVerify };

    const active = [userVerify, accountVerify].some((v) => v.status === 200 && v.tokenStatus === "active");
    if (active) {
      const list = await cfApi(token, `/accounts/${accountId}/workers/scripts`);
      const sub = await cfApi(token, `/accounts/${accountId}/workers/subdomain`);
      const subdomain: SubdomainProbe = {
        status: sub.status,
        subdomain: resultField(sub.text, "subdomain"),
        bodyHead: head(sub.text),
      };

      // 最小の Worker を作成 → 削除する(作成できて削除できない中途半端な権限も、ここで検出する)。
      const name = `keiba-cf-spike-preflight-${runId}`;
      const form = new FormData();
      form.append(
        "metadata",
        new Blob([JSON.stringify({ main_module: "index.mjs", compatibility_date: "2026-10-01" })], {
          type: "application/json",
        }),
      );
      form.append(
        "index.mjs",
        new Blob(["export default { fetch() { return new Response('preflight'); } };"], {
          type: "application/javascript+module",
        }),
        "index.mjs",
      );
      const put = await cfApi(token, `/accounts/${accountId}/workers/scripts/${name}`, { method: "PUT", body: form });
      const putProbe: HttpProbe = { status: put.status, bodyHead: head(put.text) };
      let deleteProbe: HttpProbe | null = null;
      if (put.status === 200) {
        const del = await cfApi(token, `/accounts/${accountId}/workers/scripts/${name}?force=true`, { method: "DELETE" });
        deleteProbe = { status: del.status, bodyHead: head(del.text) };
      }
      input = {
        ...input,
        listScripts: { status: list.status, bodyHead: head(list.text) },
        subdomain,
        putProbe,
        deleteProbe,
      };
    }
  }

  const judgement = judgePreflight(input);
  if (!judgement.ok) {
    for (const problem of judgement.problems) {
      console.log(`::error title=プリフライト失敗(${problem.code})::${problem.message}`);
    }
    process.exit(1);
  }
  console.log(`プリフライト OK: トークン有効・Worker の作成と削除が可能・workers.dev のサブドメイン=${judgement.subdomain}`);
  const githubEnv = process.env["GITHUB_ENV"];
  if (githubEnv !== undefined && judgement.subdomain !== null) {
    appendFileSync(githubEnv, `CF_SUBDOMAIN=${judgement.subdomain}\n`);
  }
}

await main();
