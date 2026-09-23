/**
 * 馬連・馬単オッズ実測調査(Issue #103・#24-A)用の汎用単発取得スクリプト。
 *
 * `scripts/fetch-nar-trio-axis-fixture.ts`(#33)と同じ流儀:
 * - 単発の調査・検証専用であり、CI からは呼ばない(`pnpm test` / `pnpm -r test` の対象外)
 * - `pnpm --filter` 等のビルド・テストパイプラインに組み込まれていない
 * - 必ず `HttpClient`(UA明示 `DEFAULT_USER_AGENT`)経由で取得する。
 *   生の `fetch` / `curl` は使わない(production と同じレート制限・UA明示コードを強制するのが
 *   このスクリプトの価値の中心)
 * - `fetchText` の戻り値を得た直後に `writeFileSync` で保存する(解析より先に保存する。
 *   #13 §11・#33・および本タスクの2026-09-23実測で計4回繰り返された
 *   「取得したが保存しなかった」失敗の再発防止)
 *
 * #33の版(`fetch-nar-trio-axis-fixture.ts`)は対象URL・保存先を1件だけハードコードしていたが、
 * 本タスク(#103)は取得対象が複数(中央/地方 × 馬連/馬単 × 複数レース × presale探索)かつ
 * 探索の分岐で対象が変わるため、URL・保存先ファイル名をCLI引数で受け取る汎用版にした
 * (boss裁定Q6「AC-A7を満たすには必須」への対応。個別URLごとの再現コマンドは
 * `docs/umaren-umatan-odds-investigation.md` の実リクエスト一覧表に記録する)。
 *
 * ## 400のリトライ規律(2026-09-23、オーケストレーターの変数切り分けを反映)
 *
 * 当初は「400を1回受けたら即中断」だったが、オーケストレーターが同一URL・同一type値に対し
 * 間隔だけを変えて再試行し、**数十秒後に同じURLが200で返る**ことを実測した(400はtype値にも
 * エンドポイントにも依存しない、netkeiba側の一過性スロットリング)。この実測を受け、
 * 400のみ下記のバックオフで自動再試行する(403/429は性質が異なる可能性があるため再試行せず
 * 即座にステータスを報告して終了する。呼び出し側が「2回連続なら中断」を判断する)。
 *
 * - 400を受けたら 8秒 → 15秒 → 30秒 の順に間隔を空けて同一URLを最大3回再試行する
 * - 4回目(初回+3回の再試行)もなお400なら、そのURLは取得断念として記録し非ゼロ終了する
 * - 試行ごとに時刻・ステータスを標準エラー出力に記録する(手動再実行より記録が正確になる)
 *
 * ## リクエスト間隔
 *
 * production の既定(`DEFAULT_MIN_INTERVAL_MS`=1500ms)は変更しない。本スクリプトは
 * `HttpClient` 構築時に `minIntervalMs` オプションで独自の既定値(8000ms。
 * オーケストレーター指示「間隔は8秒以上を既定にする」)を明示的に渡すことで対応する
 * (`--min-interval-ms` で上書き可能)。
 *
 * ## 実行方法
 *
 *   pnpm tsx scripts/fetch-quinella-exacta-raw.ts <URL> <保存先ファイル名(fixtures/配下)> [--min-interval-ms N]
 *
 * 例:
 *   pnpm tsx scripts/fetch-quinella-exacta-raw.ts \
 *     "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=4&action=init" \
 *     odds_quinella_202603020211.json
 *
 * 取得日時・HTTPステータス・保存先・バイト数を標準エラー出力に記録する
 * (実行者はこの出力を `docs/umaren-umatan-odds-investigation.md` の実リクエスト一覧表へ転記する)。
 * 403/429応答時は `HttpClient` が即座に `HttpError` を投げるため、その旨とステータスを出力して
 * 非ゼロ終了する(保存は行わない。ボディが無いため。再試行はしない)。
 *
 * 既存ファイルがあれば上書きする(取得日時を再確認したい場合の再実行を妨げないため)。
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient, HttpError } from "../packages/core/src/index.js";

/** フィクスチャ保存先ディレクトリ(リポジトリルート直下の fixtures/)。 */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

/** スクリプト独自のリクエスト間隔既定値(ms)。オーケストレーター指示により8秒以上。 */
const DEFAULT_SCRIPT_MIN_INTERVAL_MS = 8000;

/** 400のバックオフ間隔(ms)。初回失敗後にこの順で待ってから再試行する。 */
const RETRY_DELAYS_MS = [8000, 15000, 30000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** process.argv から `--min-interval-ms N` を取り出す(無指定ならデフォルト)。 */
function parseMinIntervalMs(args: readonly string[]): number {
  const idx = args.indexOf("--min-interval-ms");
  if (idx === -1) return DEFAULT_SCRIPT_MIN_INTERVAL_MS;
  const raw = args[idx + 1];
  const value = raw ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--min-interval-ms の値が不正です: "${raw}"`);
  }
  return value;
}

/** 1回のGET試行。成否と本文(成功時のみ)・ステータス(失敗時のみ)を返す。 */
async function attemptFetch(
  client: HttpClient,
  url: string,
): Promise<{ ok: true; body: string } | { ok: false; status: number | undefined }> {
  try {
    const body = await client.fetchText(url);
    return { ok: true, body };
  } catch (error) {
    if (error instanceof HttpError) {
      return { ok: false, status: error.status };
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [url, outName] = args;
  if (!url || !outName) {
    console.error(
      "使い方: pnpm tsx scripts/fetch-quinella-exacta-raw.ts <URL> <保存先ファイル名(fixtures/配下)> [--min-interval-ms N]",
    );
    process.exitCode = 1;
    return;
  }
  const minIntervalMs = parseMinIntervalMs(args);

  const outPath = path.join(FIXTURES_DIR, outName);
  const client = new HttpClient({ minIntervalMs });
  console.error(`GET ${url} (minIntervalMs=${minIntervalMs})`);

  let attemptNo = 1;
  for (;;) {
    const result = await attemptFetch(client, url);
    const now = new Date().toISOString();
    if (result.ok) {
      // 解析より先に保存する(AC10・#13/#33・本タスク2026-09-23の教訓)。
      writeFileSync(outPath, result.body, "utf-8");
      console.error(`試行${attemptNo}: status 200 (${now})`);
      console.error(`保存: ${outPath} (${result.body.length}文字)`);
      return;
    }

    console.error(`試行${attemptNo}: status ${result.status ?? "(不明)"} (${now})`);

    const isRetryableStatus = result.status === 400;
    const retryIndex = attemptNo - 1; // 1回目の失敗が RETRY_DELAYS_MS[0] に対応
    if (isRetryableStatus && retryIndex < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[retryIndex]!;
      console.error(`400のため${delay / 1000}秒待って再試行します(${attemptNo + 1}回目)`);
      await sleep(delay);
      attemptNo += 1;
      continue;
    }

    console.error(
      isRetryableStatus
        ? `400が${attemptNo}回連続。取得断念(保存せず終了)`
        : `status ${result.status ?? "(不明)"} は再試行対象外。ただちに終了(保存せず)`,
    );
    process.exitCode = 1;
    return;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
