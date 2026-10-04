/**
 * 使い捨て Worker の削除(Issue #159〈#21-A〉)。ワークフローの always() で動く。
 *
 * **API の DELETE を主にする**(第1ラウンドで、`wrangler delete` は Worker を消した後に KV 名前空間の確認
 * (/accounts/.../storage/kv/namespaces)で認証エラー(code 10000)になって exit 1 となり、手順が赤くなった。
 * このトークンは KV の権限を持たない最小権限のため)。`force=true` は、依存する他の Worker があっても消す指定。
 *
 * 消えたかどうかの最終判定は、この後の cleanup-run.ts が Worker の一覧で行う(残っていればジョブを失敗させる)。
 */

import { judgeDeleteStatus } from "../../scripts/cloudflare-spike/preflight.js";
import { cfApi, head, requireEnv } from "./cf-api.js";

async function main(): Promise<void> {
  const name = process.env["SPIKE_WORKER_NAME"] ?? "";
  if (name === "") {
    console.log("デプロイの前に失敗したため、この run の削除対象はありません");
    return;
  }
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const r = await cfApi(token, `/accounts/${accountId}/workers/scripts/${name}?force=true`, { method: "DELETE" });
  const judgement = judgeDeleteStatus(r.status);
  console.log(`Worker ${name} の削除(API の DELETE): ${judgement}(HTTP ${r.status ?? "例外"})`);
  if (judgement === "failed") {
    console.log(`::warning::Worker の削除に失敗しました(HTTP ${r.status ?? "例外"}): ${head(r.text)}`);
    process.exit(1);
  }
}

await main();
