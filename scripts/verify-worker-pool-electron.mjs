/**
 * verify-worker-pool-electron — Issue #119(#24-C3)のAC-7(実機起動確認)・AC-8(実測)を
 * 実際のElectron(packages/app/node_modules/electron相当・v34)上で確かめるスクリプト。
 *
 * 本番コードには確認用フックを一切入れず(2026-09-25ゴーサインの方針)、代わりにこの
 * スクリプト自身が本番の設定(sandbox: true・contextIsolation: true・preload・file://・
 * CSP)のまま`packages/app/dist/renderer/index.html`を`loadFile`し、`executeJavaScript`で
 * **ビルド成果物のWorkerチャンクをそのまま`new Worker(url, {type:"module"})`で起動**して
 * 検証する(コミットする本番コードと確かめたコードが同じであることが条件、という指示に対応)。
 *
 * 前提: 事前に以下を実行しておくこと(このスクリプト自体はビルドしない)。
 *   pnpm --filter @keiba/app build
 *   pnpm tsx scripts/verify-worker-pool-prepare.ts <fixture.json>
 *
 * 使い方(xvfb-run経由。/usr/bin/xvfb-runがある環境向け):
 *   xvfb-run -a node_modules/.bin/electron scripts/verify-worker-pool-electron.mjs \
 *     <fixture.json> <dist/renderer のディレクトリ> <preload.cjsのパス> [poolCap] [taskCount]
 *
 * 標準出力にJSON1行でレポートを出し、正常終了は成功、異常終了(exit 1)は失敗を意味する。
 */

import { app, BrowserWindow } from "electron";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

async function main() {
  const [, , fixturePathArg, rendererDirArg, preloadPathArg, poolCapArg, taskCountArg] = process.argv;
  const fixturePath = fixturePathArg ?? "/tmp/keiba-worker-pool-verify.json";
  const rendererDir = path.resolve(
    rendererDirArg ?? path.join(process.cwd(), "packages/app/dist/renderer"),
  );
  const preloadPath = path.resolve(
    preloadPathArg ?? path.join(process.cwd(), "packages/app/dist/preload/preload.cjs"),
  );
  const poolCap = poolCapArg !== undefined ? Number(poolCapArg) : 4;
  const taskCount = taskCountArg !== undefined ? Number(taskCountArg) : 12;

  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

  const assetsDir = path.join(rendererDir, "assets");
  const workerFile = readdirSync(assetsDir).find((f) => /^mixed-allocation\.worker-.*\.js$/.test(f));
  if (workerFile === undefined) {
    console.error(`Workerチャンクが見つかりません(${assetsDir})。pnpm --filter @keiba/app build を先に実行してください。`);
    app.exit(1);
    return;
  }
  const workerRelativeUrl = `assets/${workerFile}`;

  await app.whenReady();

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      // packages/app/src/main/main.tsのcreateMainWindowと同じ本番設定。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath,
    },
  });

  await window.loadFile(path.join(rendererDir, "index.html"));

  // ---- (a) 正誤確認: 実際に作られたWorkerチャンクを1つ起動し、フィクスチャの「正解」と一致するか ----
  const correctnessResult = await window.webContents.executeJavaScript(
    `
    (function () {
      return new Promise((resolve, reject) => {
        try {
          const worker = new Worker(${JSON.stringify(workerRelativeUrl)}, { type: "module" });
          const timeout = setTimeout(() => {
            worker.terminate();
            reject(new Error("Workerからの応答がタイムアウトしました"));
          }, 15000);
          worker.onmessage = (event) => {
            clearTimeout(timeout);
            worker.terminate();
            resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timeout);
            worker.terminate();
            reject(new Error("Worker onerror: " + (event && event.message)));
          };
          worker.onmessageerror = (event) => {
            clearTimeout(timeout);
            worker.terminate();
            reject(new Error("Worker onmessageerror"));
          };
          worker.postMessage(${JSON.stringify({
            raceId: fixture.race.raceId,
            race: fixture.race,
            settings: fixture.settings,
          })});
        } catch (e) {
          reject(e);
        }
      });
    })()
    `,
    true, // userGesture(Worker生成自体に必須ではないが、ページ側APIの制約を避けるため付与)
  );

  const correctnessOk =
    correctnessResult.raceId === fixture.race.raceId &&
    deepEqual(correctnessResult.outcome, { status: "ok", value: fixture.expected });

  // ---- (b) AC-8実測: 1 Worker(直列)とpoolCap個のWorker(並列)で、taskCount件の所要時間を比較 ----
  const timingResult = await window.webContents.executeJavaScript(
    `
    (async function () {
      const workerUrl = ${JSON.stringify(workerRelativeUrl)};
      const race = ${JSON.stringify(fixture.race)};
      const settings = ${JSON.stringify(fixture.settings)};
      const taskCount = ${JSON.stringify(taskCount)};
      const poolCap = ${JSON.stringify(poolCap)};

      function runOneWorker(worker, raceId) {
        return new Promise((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => reject(new Error("Worker onerror: " + (event && event.message)));
          worker.postMessage({ raceId, race, settings });
        });
      }

      // workerCount個のWorkerで、taskCount件を空いたWorkerへ都度割り当てて全件終わるまでの
      // 所要時間を測る(mixed-allocation-worker-pool.tsのpump()と同じ「空いたら次を詰める」
      // 方式を、この確認スクリプト自身の中でも素朴に再現する。プールのオーケストレーション
      // ロジック自体の正しさはNode側のvitest〈mixed-allocation-worker-pool.test.ts〉で
      // フェイクWorkerを使って別途検証済みであり、ここでは実Worker・実Electron環境での
      // 実測時間だけを見る)。
      async function measure(workerCount) {
        const workers = Array.from({ length: workerCount }, () => new Worker(workerUrl, { type: "module" }));
        const t0 = performance.now();
        let nextTask = 0;
        async function runWorkerLoop(worker) {
          while (nextTask < taskCount) {
            const raceId = "task-" + nextTask;
            nextTask += 1;
            await runOneWorker(worker, raceId);
          }
        }
        await Promise.all(workers.map((w) => runWorkerLoop(w)));
        const elapsedMs = performance.now() - t0;
        for (const w of workers) w.terminate();
        return elapsedMs;
      }

      const singleWorkerMs = await measure(1);
      const poolMs = await measure(poolCap);
      return { singleWorkerMs, poolMs, poolCap, taskCount };
    })()
    `,
    true,
  );

  console.log(
    JSON.stringify(
      {
        workerFile,
        correctnessOk,
        correctnessRaceId: correctnessResult.raceId,
        ...timingResult,
      },
      null,
      2,
    ),
  );

  app.exit(correctnessOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
