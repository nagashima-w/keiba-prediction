/**
 * 削除の後の確認と、結果の出力(Issue #159〈#21-A〉)。ワークフローの最後(always)で動く。
 *
 *  1. Worker の一覧を取り、`keiba-cf-spike-` で始まる Worker が残っていないことを検査してログに出す
 *     (preflight で作った最小 Worker も対象)。削除ステップ(delete-run.ts。API の DELETE)の後に残って
 *     いれば、もう一度 API の DELETE で消しにいき、再度一覧で確認する。**それでも残っていれば
 *     (一覧を取得できない場合も)ジョブを失敗させる。**
 *  2. Durable Object の名前空間が Worker と一緒に消えたかを記録する(削除ステップの直後の状態)。
 *  3. 結果 JSON に後片付けの結果を足し、step summary に Markdown を書き、結果の全文を
 *     `===CF-SPIKE-RESULT-BEGIN===` / `===CF-SPIKE-RESULT-END===` で挟んだ1行でログに出す
 *     (メインが読めるのはジョブログ本文だけのため。ログは末尾から読まれるので、出力の最後に置く)。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  decideCleanup,
  extractDurableObjectScriptNames,
  extractScriptNames,
  judgeCleanup,
  judgeDeleteStatus,
  planCleanupDeletes,
  SPIKE_WORKER_PREFIX,
  type DeleteJudgement,
} from "../../scripts/cloudflare-spike/preflight.js";
import {
  emptyResult,
  formatResultBlock,
  renderMarkdown,
  type SpikeResult,
} from "../../scripts/cloudflare-spike/result.js";
import { writeJsonAtomic } from "./atomic-write.js";
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

  // 結果ファイルが無い・壊れていても、後片付けの確認と診断の出力は止めない。
  let result: SpikeResult;
  let loadNote: string | null = null;
  if (!existsSync(RESULT_PATH)) {
    result = emptyResult(process.env["GITHUB_RUN_ID"] ?? "unknown");
    loadNote = "測定結果のファイルが無かった(測定の前で失敗した)ため、後片付けの結果だけを出力する";
  } else {
    try {
      result = JSON.parse(readFileSync(RESULT_PATH, "utf-8")) as SpikeResult;
    } catch (error) {
      result = emptyResult(process.env["GITHUB_RUN_ID"] ?? "unknown");
      loadNote = `測定結果のファイルを JSON として読めなかった(${error instanceof Error ? error.message : String(error)})ため、後片付けの結果だけを出力する`;
    }
  }
  if (loadNote !== null) {
    result.notes.push(loadNote);
  }

  // 1. 削除ステップの直後の状態。
  const first = judgeCleanup(await listState(token, accountId));
  console.log(
    `削除の確認: 接頭辞 ${SPIKE_WORKER_PREFIX} の Worker の残り=${first.leftoverWorkers.length}件` +
      `${first.leftoverWorkers.length > 0 ? `(${first.leftoverWorkers.join(", ")})` : ""}` +
      ` / 一覧の取得=${first.listUnavailable ? "失敗" : "成功"} / Durable Object の名前空間=${first.durableObjectNamespaces}`,
  );

  // 一覧に残っていた Worker と、この run の Worker(SPIKE_WORKER_NAME)を、API の DELETE で消しにいく。
  // **一覧の成否にかかわらず**、名前が分かっていれば試みる(一覧を取得できなくても、アカウントに Worker を
  // 残さないため。すでに消えていれば 404 で、成功扱い)。接頭辞で始まらない名前は対象にしない。
  const targets = planCleanupDeletes(first.leftoverWorkers, process.env["SPIKE_WORKER_NAME"]);
  const deletes: { name: string; judgement: DeleteJudgement }[] = [];
  for (const name of targets) {
    const del = await cfApi(token, `/accounts/${accountId}/workers/scripts/${name}?force=true`, { method: "DELETE" });
    const judgement = judgeDeleteStatus(del.status);
    deletes.push({ name, judgement });
    if (judgement === "deleted") {
      console.log(`::warning::削除ステップの後も残っていた ${name} を API で削除しました(HTTP ${del.status})`);
    } else if (judgement === "failed") {
      console.log(`::warning::${name} の削除(API の DELETE)に失敗しました(HTTP ${del.status ?? "例外"})`);
    }
  }
  // 削除を試みたら、一覧を取り直す。最終判定はこの再削除のあとの一覧で決める(DELETE の応答では決めない)。
  const final = targets.length > 0 ? judgeCleanup(await listState(token, accountId)) : null;
  if (final !== null) {
    console.log(
      `再確認: 残り=${final.leftoverWorkers.length}件${final.leftoverWorkers.length > 0 ? `(${final.leftoverWorkers.join(", ")})` : ""} / 一覧の取得=${final.listUnavailable ? "失敗" : "成功"}`,
    );
  }
  const outcome = decideCleanup(first, deletes, final);
  const ok = outcome.ok;
  const last = final ?? first;
  result.cleanup = {
    leftoverWorkers: first.leftoverWorkers,
    deletedByFallback: [...outcome.deletedByFallback],
    // 「DO は Worker と一緒に消えるか」への答えは、削除ステップの直後(再削除の前)の状態。
    durableObjectNamespaces: first.durableObjectNamespaces,
    ok,
    listUnavailable: first.listUnavailable,
  };
  result.finishedAt = new Date().toISOString();
  writeJsonAtomic(RESULT_PATH, result);

  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath !== undefined) {
    appendFileSync(summaryPath, renderMarkdown(result) + "\n");
  }

  // 失敗の通知は、結果の全文より前に出す(結果の全文を出力の最後=ログの末尾に置くため)。
  if (!ok) {
    console.log(
      `::error title=後片付けに失敗::${last.listUnavailable ? "Worker の一覧を取得できず、残っていないことを確認できません" : `Worker が残っていました: ${last.leftoverWorkers.join(", ")}`}`,
    );
  }

  // 結果の全文は出力の最後に置く(ログは末尾から取得される)。
  console.log(formatResultBlock(result));

  if (!ok) {
    process.exit(1);
  }
}

await main();
