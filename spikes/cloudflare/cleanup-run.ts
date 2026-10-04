/**
 * `wrangler delete` の後の確認と、結果の出力(Issue #159〈#21-A〉)。ワークフローの最後(always)で動く。
 *
 *  1. Worker の一覧を取り、`keiba-cf-spike-` で始まる Worker が残っていないことを検査してログに出す
 *     (preflight で作った最小 Worker も対象)。残っていれば API の DELETE で消しにいくが、
 *     wrangler delete で消えていなかった事実は変わらないので、ジョブは失敗させる。
 *  2. Durable Object の名前空間が Worker と一緒に消えたかを記録する(wrangler delete の直後の状態)。
 *  3. 結果 JSON に後片付けの結果を足し、step summary に Markdown を書き、結果の全文を
 *     `===CF-SPIKE-RESULT-BEGIN===` / `===CF-SPIKE-RESULT-END===` で挟んだ1行でログに出す
 *     (メインが読めるのはジョブログ本文だけのため。ログは末尾から読まれるので、出力の最後に置く)。
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  extractDurableObjectScriptNames,
  extractScriptNames,
  judgeCleanup,
  SPIKE_WORKER_PREFIX,
} from "../../scripts/cloudflare-spike/preflight.js";
import {
  emptyResult,
  formatResultBlock,
  renderMarkdown,
  type SpikeResult,
} from "../../scripts/cloudflare-spike/result.js";
import { cfApi, requireEnv } from "./cf-api.js";

const RESULT_PATH = process.env["RESULT_PATH"] ?? "spike-result.json";

async function listState(token: string, accountId: string) {
  const scripts = await cfApi(token, `/accounts/${accountId}/workers/scripts`);
  const dos = await cfApi(token, `/accounts/${accountId}/workers/durable_objects/namespaces`);
  return {
    scriptNames: scripts.status === 200 ? extractScriptNames(scripts.text) : null,
    doScriptNames: dos.status === 200 ? extractDurableObjectScriptNames(dos.text) : null,
  };
}

async function main(): Promise<void> {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");

  const result: SpikeResult = existsSync(RESULT_PATH)
    ? (JSON.parse(readFileSync(RESULT_PATH, "utf-8")) as SpikeResult)
    : emptyResult(process.env["GITHUB_RUN_ID"] ?? "unknown");
  if (!existsSync(RESULT_PATH)) {
    result.notes.push("測定結果のファイルが無かった(測定の前で失敗した)ため、後片付けの結果だけを出力する");
  }

  // 1. wrangler delete の直後の状態。
  const first = judgeCleanup(await listState(token, accountId));
  console.log(
    `削除の確認: 接頭辞 ${SPIKE_WORKER_PREFIX} の Worker の残り=${first.leftoverWorkers.length}件` +
      `${first.leftoverWorkers.length > 0 ? `(${first.leftoverWorkers.join(", ")})` : ""}` +
      ` / 一覧の取得=${first.listUnavailable ? "失敗" : "成功"} / Durable Object の名前空間=${first.durableObjectNamespaces}`,
  );

  // 残っていれば API で消しにいく(消えていなかった事実は ok=false に残す)。
  const deletedByFallback: string[] = [];
  for (const name of first.leftoverWorkers) {
    const del = await cfApi(token, `/accounts/${accountId}/workers/scripts/${name}?force=true`, { method: "DELETE" });
    console.log(`::warning::wrangler delete で消えていなかった ${name} を API で削除しました(HTTP ${del.status ?? "例外"})`);
    if (del.status === 200) {
      deletedByFallback.push(name);
    }
  }
  const final = first.leftoverWorkers.length > 0 ? judgeCleanup(await listState(token, accountId)) : first;
  if (first.leftoverWorkers.length > 0) {
    console.log(`再確認: 残り=${final.leftoverWorkers.length}件${final.leftoverWorkers.length > 0 ? `(${final.leftoverWorkers.join(", ")})` : ""}`);
  }

  const ok = first.ok && final.ok;
  result.cleanup = {
    leftoverWorkers: first.leftoverWorkers,
    deletedByFallback,
    // 「DO は Worker と一緒に消えるか」への答えは、wrangler delete の直後(フォールバック前)の状態。
    durableObjectNamespaces: first.durableObjectNamespaces,
    ok,
    listUnavailable: first.listUnavailable,
  };
  result.finishedAt = new Date().toISOString();
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));

  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath !== undefined) {
    appendFileSync(summaryPath, renderMarkdown(result) + "\n");
  }

  // 失敗の通知は、結果の全文より前に出す(結果の全文を出力の最後=ログの末尾に置くため)。
  if (!ok) {
    console.log(
      `::error title=後片付けに失敗::${first.listUnavailable ? "Worker の一覧を取得できず、残っていないことを確認できません" : `Worker が残っていました: ${first.leftoverWorkers.join(", ")}`}`,
    );
  }

  // 結果の全文は出力の最後に置く(ログは末尾から取得される)。
  console.log(formatResultBlock(result));

  if (!ok) {
    process.exit(1);
  }
}

await main();
