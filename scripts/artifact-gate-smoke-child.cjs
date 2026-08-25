"use strict";

/**
 * scripts/artifact-gate.ts の "smoke" サブコマンドから、電子ビルド済み exe
 * (packages/app/release/win-unpacked/*.exe)を ELECTRON_RUN_AS_NODE=1 で起動して実行される
 * 子スクリプト(Issue #62)。plain CJS(拡張子 .cjs)にしてある理由: 起動元は win-unpacked に
 * 展開済みの実 exe そのものであり、TSローダー・ESMは前提にできない(素の require のみ動く)。
 *
 * ## やること(scripts/artifact-gate.ts の起動元から3引数を受け取る)
 * argv[2] = nativeBindingPath(better-sqlite3 の .node 絶対パス。scripts/artifact-gate.ts が
 *           packages/app/src/main/native-binding.ts の resolveVerifiedNativeBindingPath を
 *           呼んで得た、本番と同一の値)
 * argv[3] = expectedResourcesPath(この exe の resources ディレクトリの期待値)
 * argv[4] = tmpDbPath(この実行専用の一時 SQLite ファイルパス)
 *
 * 手順: process.resourcesPath の一致確認 →
 *       require.resolve("better-sqlite3", { paths: [<resources>/app.asar/dist/main] }) →
 *       new Database(tmp, { nativeBinding }) → CREATE TABLE/INSERT/SELECT(値一致検証)→
 *       close() → センチネル付きJSONを1行 stdout に出す。
 *
 * どの段階で失敗しても、例外を投げっぱなしにせず必ずセンチネル行(ok:false + reason)を
 * 出してから非0で終了する(judgeSmokeOutcome が「exit 0 だがセンチネル無し」を block にする
 * 設計と対になっており、原因をログに残したうえで確実に block させるため)。
 *
 * ## 射程外(scripts/artifact-gate.ts 冒頭のJSDocと同一内容を必ずここにも書く)
 * 1. 検査対象は win-unpacked であり、portable exe 自身の自己展開(%TEMP%への展開)は通らない
 * 2. ELECTRON_RUN_AS_NODE=1 は Electron の Node 部分だけを起動する。Chromium 初期化・
 *    app.whenReady・BrowserWindow・preload・renderer は動かないため、GUI起動時にしか
 *    出ない破綻は検出しない
 * 3. 本番の呼び出し元(main.cjs の ResourceManager 経由)そのものは実行しない。ただし
 *    #61 以降 nativeBinding を明示指定するため bindings のスタック走査は使われず、.node の
 *    実 require は database.js が絶対パスで行う。呼び出し元の違いは .node のロード可否に影響しない
 * 4. DB操作は CREATE TABLE/INSERT/SELECT のみで、スキーマ移行経路は通らない
 * 5. ビルドマシン上のx64成果物のみ。ユーザー実機の環境差(VC++ランタイム・AVの隔離・
 *    %TEMP%の残骸)は対象外
 * 6. スモークの実 exe 経路は Linux では原理的に実行できない(resolveSingleWinUnpackedExe が
 *    `.exe` を要求するが、Linux 成果物の実行ファイルは `.exe` 拡張子を持たない)。ローカルで
 *    通せるのは fake deps までで、実経路(実 exe を spawn して better-sqlite3 をロードする経路)
 *    の検証は Windows CI が唯一の場所である
 *
 * センチネル出力のプレフィックスは scripts/artifact-gate.ts の SMOKE_SENTINEL_PREFIX と
 * 必ず一致させること(judgeSmokeOutcome が同じ文字列でパースする)。
 */

const path = require("node:path");

const SMOKE_SENTINEL_PREFIX = "KEIBA_ARTIFACT_GATE_SMOKE_RESULT ";

function emit(payload) {
  process.stdout.write(SMOKE_SENTINEL_PREFIX + JSON.stringify(payload) + "\n");
}

function fail(reason) {
  emit({ ok: false, reason: String(reason) });
  process.exitCode = 1;
}

function main() {
  const nativeBindingPath = process.argv[2];
  const expectedResourcesPath = process.argv[3];
  const tmpDbPath = process.argv[4];

  if (!nativeBindingPath || !expectedResourcesPath || !tmpDbPath) {
    fail(
      "必要な引数(nativeBindingPath, expectedResourcesPath, tmpDbPath)が渡されていません: " +
        JSON.stringify(process.argv),
    );
    return;
  }

  if (process.resourcesPath !== expectedResourcesPath) {
    fail(
      `process.resourcesPathが期待値と一致しません(expected=${expectedResourcesPath}, actual=${process.resourcesPath})`,
    );
    return;
  }

  let betterSqlite3EntryPath;
  try {
    betterSqlite3EntryPath = require.resolve("better-sqlite3", {
      paths: [path.join(expectedResourcesPath, "app.asar", "dist", "main")],
    });
  } catch (error) {
    fail(`better-sqlite3の解決(require.resolve)に失敗しました: ${error && error.message}`);
    return;
  }

  let Database;
  try {
    Database = require(betterSqlite3EntryPath);
  } catch (error) {
    fail(`better-sqlite3のrequireに失敗しました: ${error && error.message}`);
    return;
  }

  let db;
  try {
    db = new Database(tmpDbPath, { nativeBinding: nativeBindingPath });
    db.exec("CREATE TABLE smoke_check (id INTEGER PRIMARY KEY, value TEXT)");
    const expectedValue = "keiba-artifact-gate-smoke-" + Date.now() + "-" + process.pid;
    db.prepare("INSERT INTO smoke_check (id, value) VALUES (1, ?)").run(expectedValue);
    const row = db.prepare("SELECT value FROM smoke_check WHERE id = 1").get();
    if (!row || row.value !== expectedValue) {
      fail(
        `INSERT/SELECTの値が一致しません(expected=${expectedValue}, actual=${row && row.value})`,
      );
      return;
    }
    db.close();
  } catch (error) {
    fail(`DB操作(CREATE/INSERT/SELECT)に失敗しました: ${(error && error.stack) || error}`);
    return;
  }

  emit({ ok: true, resourcesPath: process.resourcesPath });
}

main();
