/**
 * 配布 exe が「動くこと」を CI で検査するゲート(Issue #62)。
 *
 * ## 背景
 * #60(better-sqlite3 が packaged 実行でロードできなかった実機事故)を #61 で是正したが、
 * このリポジトリの検証は「exe が更新されたこと」しか見ておらず「exe が動くこと」を一度も
 * 確認していなかった。vitest は Node 環境で走るため、Electron ランタイム・asar・
 * ネイティブモジュールの破綻を原理的に検出できない。
 *
 * ## 設計の核心(boss の着手前ゲートで実測により確定。推測で変えないこと)
 *
 * 【実測の訂正(#62 メタレビュー2巡目で発覚)】当初は「壊れていた v1.3.1 の実物 exe を検査すると
 * 配置検査4項目(当初案)は PASS したが、ヘッドレススモークは
 * `NODE_MODULE_VERSION 127 ... requires 132` で実際に FAIL した」と記述していたが、これは誤り
 * だった。v1.3.1 実物の `.node` をバイナリレベルで実測すると `nm_version=132`
 * (Electron 34 向けに正しくビルド済み)であり、**配置検査・スモークとも実際には allow を返す**
 * (`.node` は 1,918,976 バイトで実在・asar ヘッダ上 `unpacked: true`・`dist` 3点も実在。
 * 読み取り方法は下記参照)。127→132 のエラーは、Node 向け(NODE_MODULE_VERSION=127)の `.node`
 * を Electron 向け配置へ注入した対照実験で再現したものであり、v1.3.1 の実物から出たものでは
 * なかった。
 *
 * 【この対照実験で確認できたこと(2段構成の根拠。ここは変わらない)】配置検査は asar のヘッダ
 * (ファイルの存在・展開状態)しか見ず `.node` の中身(ABI)を一切読まないため、原理的に ABI
 * 不一致を検出できない。実際、Node 向け `.node` を注入すると配置検査4項目(当初案)はすべて
 * PASS したが、ヘッドレススモークは `NODE_MODULE_VERSION 127 ... requires 132` で実際に FAIL
 * した(.node は存在しサイズもあるのに Electron からロードできない状態)。**ABI 不一致は配置検査
 * では1件も検出できない。** そのため本モジュールは
 *   (1) asar 配置検査(縮小版・A1/A2。スモークが subsume しない部分だけを残す)
 *   (2) ヘッドレススモーク(本命)
 * の2段構成にする。
 *
 * 【nm_version の実測方法(次に読む人が同じ調査を繰り返さないための記録)】ネイティブアドオンは
 * `node_module` 構造体を静的データとして埋め込む(レイアウト: `nm_version` int(+0)・
 * `nm_flags` unsigned(+4)・`nm_dso_handle` void*(+8)・`nm_filename` char*(+16)・
 * `nm_register_func`(+24)・`nm_context_register_func`(+32)・`nm_modname` char*(+40))。
 * バイナリ中で `nm_modname`("better_sqlite3" 文字列)を指す絶対アドレスの QWORD を探し、
 * そこから40バイト遡った位置の int32 が `nm_version`(`nm_flags==0` であることも整合性チェックに
 * 使える)。この方法を、正解が既知の2検体(現行 Node 向け `.node` → 127。
 * `process.versions.modules` と一致/ electron-rebuild 済み `.node` → 132。Electron 34 と一致)
 * で裏取りしたうえで v1.3.1 実物 exe の `.node`(PE32+)に適用し、`nm_version=132`
 * (`nm_flags=0`)を確認した。
 *
 * スモークは「本番と同じ呼び出し経路(スタック起点)」ではなく「本番と同じメカニズム」を追う。
 * better-sqlite3/lib/database.js は nativeBinding を文字列で渡された瞬間 bindings を一切
 * 呼ばず、.node の require を自身が絶対パスで行うため、呼び出し元のスタックは影響しない。
 * したがって `packages/app/src/main/native-binding.ts` の `resolveVerifiedNativeBindingPath`
 * を**そのまま呼ぶ**(検査スクリプトがパス規則を再実装すると、本番の規則が変わったときに
 * 検査だけ通り続けてしまうため)。
 *
 * ## 射程外(#60型の症状を検出できない、とは書かない。#61以降それは事実として誤り)
 *
 * 【この検査が実際に何を検出できるのか(boss 再メタレビュー 提案3対応)】
 * 本検査は v1.3.1 の実物 exe(`.node` が 1,918,976 バイトで実在・asar ヘッダ上 `unpacked: true`・
 * `dist` 3点も実在)に対し A1/A2・スモークとも実際に allow を返す(実測確認済み。#60当時の
 * 壊れ方はこの検査には映らない)。#60 の真因は `bindings` パッケージの呼び出し元スタック走査
 * であり、そのメカニズムは #61 で除去済みのため、本検査は成果物を*現行(#61後)のメカニズムで*
 * 叩くだけで、v1.3.1 当時の壊れ方(呼び出し元スタックに依存した解決失敗)そのものは原理的に
 * 再現しない。本検査が守るのは、#61 が新たに単一障害点にした「ハードコードされた絶対パスが
 * 実物の配置と一致すること」と、ABI・asar・配置の破綻という(#60より)より広いクラスである。
 *
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
 * 7. 本番コードが実際に nativeBinding を渡し続けることは本検査の対象外である(検査は成果物を
 *    正しいメカニズムで叩けることを見るだけで、本番コードがそのメカニズムを使っているかは
 *    見ない)。この配線は packages/app/test/ipc-native-binding.test.ts が守っており、
 *    役割分担として正しい
 *
 * ## 終了コードの写像
 * `GateResult`/`resultToExitCode` は `scripts/release-gate.ts`(Issue #45)の型・規約に倣う。
 * ただし import はしない(自己完結にする。release-gate.ts は版数据え置き検査、本ファイルは
 * exe の可動性検査で目的が異なる独立したゲートであり、将来どちらかの型が変わっても互いに
 * 影響しないようにするため。「倣う」は模倣であって共有ではない、という判断)。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveVerifiedNativeBindingPath } from "../packages/app/src/main/native-binding.js";

// ---------------------------------------------------------------------------
// 共通の判定結果型(scripts/release-gate.ts の GateResult/resultToExitCode に倣う)
// ---------------------------------------------------------------------------

export type GateResult =
  | { status: "block"; message: string }
  | { status: "allow"; message?: string }
  | { status: "skip"; message: string };

export function resultToExitCode(result: GateResult): number {
  return result.status === "block" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// S1: asar ヘッダのバイト列パーサ(副作用ゼロの純関数)
// ---------------------------------------------------------------------------

/**
 * asar ヘッダ木のノード(電子/asar のヘッダJSON構造)。
 * ディレクトリ相当のノードは `files` を持ち、ファイル相当のノードは持たない。
 * `unpacked: true` は asarUnpack で展開されたファイル(実体が asar 外にある)を示す。
 */
export interface AsarNode {
  files?: Record<string, AsarNode>;
  unpacked?: boolean;
  size?: number;
  offset?: string;
}

export type AsarHeaderParseResult =
  | { ok: true; header: AsarNode }
  | { ok: false; reason: string };

/**
 * asar ヘッダのバイト列パーサ。@electron/asar の実出力を実測して確定したフォーマットに従う
 * (テスト冒頭コメント参照。推測ではなく実測に基づく)。
 *
 * - bytes[0,12) は外側/内側 pickle の制御フィールド(本パーサは読まない。offset 12 だけ見る)
 * - bytes[12,16) = ヘッダJSONのバイト長(readUInt32LE(12))
 * - bytes[16, 16+len) = ヘッダJSON本体(UTF-8)
 *
 * 例外は投げない(fail-closed): ファイルが小さすぎる・サイズフィールドがファイル長と
 * 整合しない・JSONとしてパースできない・`files` を持たない、のいずれも `{ ok: false }` を返す。
 * 呼び出し側(judgeAsarLayoutFromBytes)がこれを block に変換する。
 */
export function parseAsarHeader(buffer: Buffer): AsarHeaderParseResult {
  const MIN_PREFIX_BYTES = 16;
  if (buffer.length < MIN_PREFIX_BYTES) {
    return {
      ok: false,
      reason: `ファイルが小さすぎます(${buffer.length}バイト、最低${MIN_PREFIX_BYTES}バイト必要)`,
    };
  }
  const headerJsonSize = buffer.readUInt32LE(12);
  const headerJsonEnd = MIN_PREFIX_BYTES + headerJsonSize;
  if (headerJsonSize <= 0 || headerJsonEnd > buffer.length) {
    return {
      ok: false,
      reason: `ヘッダJSONのサイズ(${headerJsonSize}バイト)がファイル長(${buffer.length}バイト)と整合しません`,
    };
  }
  const headerJsonBytes = buffer.subarray(MIN_PREFIX_BYTES, headerJsonEnd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerJsonBytes.toString("utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `ヘッダJSONのパースに失敗しました(${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as AsarNode).files !== "object" ||
    (parsed as AsarNode).files === null
  ) {
    return { ok: false, reason: "ヘッダJSONの構造が不正です(files が見つかりません)" };
  }
  return { ok: true, header: parsed as AsarNode };
}

// ---------------------------------------------------------------------------
// S1: judgeAsarLayout(縮小版・A1/A2。副作用ゼロの純関数)
// ---------------------------------------------------------------------------

interface FlatAsarFile {
  readonly path: string;
  readonly unpacked: boolean;
}

/** asar ヘッダ木を "dist/main/main.cjs" 形式のフラットなファイル一覧へ展開する。 */
function flattenAsarFiles(node: AsarNode, prefix: string): FlatAsarFile[] {
  const filesField = node.files;
  if (filesField === undefined) {
    return [];
  }
  const results: FlatAsarFile[] = [];
  for (const [name, child] of Object.entries(filesField)) {
    const childPath = prefix === "" ? name : `${prefix}/${name}`;
    if (child.files !== undefined) {
      results.push(...flattenAsarFiles(child, childPath));
    } else {
      results.push({ path: childPath, unpacked: child.unpacked === true });
    }
  }
  return results;
}

/** A2 で存在確認する必須ファイル(electron-builder.yml の files: dist/**\/* が前提)。 */
const REQUIRED_ASAR_FILES = [
  "dist/main/main.cjs",
  "dist/preload/preload.cjs",
  "dist/renderer/index.html",
] as const;

/**
 * asar 配置検査(縮小版)。ブリーフで合意された2項目だけを見る:
 * - A1: `unpacked !== true` な `.node` エントリが0件であること
 *   (`.node` エントリ自体が1件も無い場合も block とする。推奨どおり fail-closed に倒す。
 *   ビルド構成が変わってネイティブモジュールが同梱されなくなった、という重大な変化を
 *   「何もチェック対象が無いので allow」にしてしまうと、この検査自体が無意味になるため)
 * - A2: `dist/main/main.cjs` / `dist/preload/preload.cjs` / `dist/renderer/index.html` が
 *   asar 内に存在すること
 *
 * 当初案にあった他3項目は削除済み(ブリーフ参照: (a) スモークが subsume する
 * (b) build-electron.mjs と bundle.test.ts で既に3重 (c) unpacked:true のため
 * 「ヘッダに存在」が「中身が asar にある」を意味しない)。
 */
export function judgeAsarLayout(header: AsarNode): GateResult {
  const files = flattenAsarFiles(header, "");
  // boss メタレビュー 提案M1(判断記録): toLowerCase() を外す変異はテストを1件も検出できなかった
  // (electron-builder が生成する asar 内のファイル名は npm パッケージ由来で常に小文字
  // `.node` のため、大文字化ケースの実害は事実上無い)。対応は見送る。ただし
  // fail-closed(大文字小文字を問わず.nodeを1件でも多く拾う側)の安全側であるため toLowerCase()
  // 自体は維持する(実害が薄い変異への専用テスト追加を見送っただけで、既存の安全側の実装は
  // 崩さない、という判断)。
  const nodeEntries = files.filter((f) => f.path.toLowerCase().endsWith(".node"));

  if (nodeEntries.length === 0) {
    return {
      status: "block",
      message:
        "app.asar のヘッダに .node エントリが1件もありません(A1)。ビルド構成が変わり、ネイティブモジュールが同梱されていない可能性があります",
    };
  }

  const packedNodeEntries = nodeEntries.filter((f) => !f.unpacked);
  if (packedNodeEntries.length > 0) {
    return {
      status: "block",
      message: `以下の .node エントリが asarUnpack で展開されていません(A1、unpacked!==true): ${packedNodeEntries
        .map((f) => f.path)
        .join(", ")}`,
    };
  }

  const missing = REQUIRED_ASAR_FILES.filter(
    (required) => !files.some((f) => f.path === required),
  );
  if (missing.length > 0) {
    return {
      status: "block",
      message: `app.asar に必須ファイルがありません(A2): ${missing.join(", ")}`,
    };
  }

  return { status: "allow" };
}

/**
 * parseAsarHeader の失敗を block に変換する合成関数(fail-closed)。
 * parseAsarHeader / judgeAsarLayout のどちらも例外を投げないため、この関数自体も
 * 副作用ゼロの純関数のまま例外を投げない。
 */
export function judgeAsarLayoutFromBytes(buffer: Buffer): GateResult {
  const parsed = parseAsarHeader(buffer);
  if (!parsed.ok) {
    return {
      status: "block",
      message: `app.asar のヘッダを解析できません(${parsed.reason})。ビルド成果物が壊れている可能性があります`,
    };
  }
  return judgeAsarLayout(parsed.header);
}

// ---------------------------------------------------------------------------
// S3: win-unpacked の exe を一意に解決する(0個/複数個は block。release-gate.ts の
// resolveSingleExeName に「倣う」が、あちらは skip でこちらは block にする意図的な非対称)
// ---------------------------------------------------------------------------

export type WinUnpackedExeResolution =
  | { ok: true; exePath: string }
  | { ok: false; result: GateResult };

/**
 * release-gate.ts の resolveSingleExeName は「exe 生成前後の両方で呼ばれうる」検査
 * (バージョン据え置き検査は日常的な dev-latest 公開のたびに走る)のため 0個/複数個を
 * skip(「判定できないだけで公開は止めない」)にしている。
 * 一方こちらは electron-builder による exe 生成の直後にしか呼ばれない専用の検査であり、
 * 0個/複数個は「ビルドが期待通りに終わっていない」ことそのものを意味するため block にする
 * (ブリーフで明示的に指定された非対称)。
 */
export function resolveSingleWinUnpackedExe(
  fileNames: string[],
  winUnpackedDir: string,
): WinUnpackedExeResolution {
  const exeNames = fileNames.filter((name) => name.toLowerCase().endsWith(".exe"));
  if (exeNames.length === 0) {
    return {
      ok: false,
      result: {
        status: "block",
        message: `${winUnpackedDir} に .exe が見つかりません(0個)。win-unpacked の生成に失敗している可能性があります`,
      },
    };
  }
  if (exeNames.length > 1) {
    return {
      ok: false,
      result: {
        status: "block",
        message: `${winUnpackedDir} の .exe が1個ではありません(${exeNames.length}個: ${exeNames.join(", ")})。想定外の構成のためスモークを中止します`,
      },
    };
  }
  const [name] = exeNames;
  if (name === undefined) {
    throw new Error("到達しないはずの分岐です(exeNames.length===1のはずが要素を取得できません)");
  }
  return { ok: true, exePath: path.join(winUnpackedDir, name) };
}

// ---------------------------------------------------------------------------
// S3: judgeSmokeOutcome(終了コード + センチネル出力の解釈。副作用ゼロの純関数)
// ---------------------------------------------------------------------------

/**
 * スモーク子プロセス(scripts/artifact-gate-smoke-child.cjs)の stdout に載せる
 * センチネル行のプレフィックス。子スクリプト側と必ず一致させる。
 */
export const SMOKE_SENTINEL_PREFIX = "KEIBA_ARTIFACT_GATE_SMOKE_RESULT ";

export interface SmokeSentinelPayload {
  readonly ok: boolean;
  readonly resourcesPath?: string;
  readonly reason?: string;
}

/** spawnSync の生の戻り値を、judgeSmokeOutcome が必要とする最小形へ整えたもの。 */
export interface SmokeProcessOutcome {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

/**
 * outcome.stdout からセンチネル行を探して JSON パースする(見つかったかどうか・パース結果を
 * 区別して返す。副作用ゼロ)。
 *
 * boss メタレビュー 要修正1 への対応: 当初、この抽出処理は「exit 0」の分岐でしか行っていなかった。
 * しかし子スクリプト(artifact-gate-smoke-child.cjs)は失敗時に必ずセンチネル(ok:false + reason)を
 * stdout に書いてから exitCode=1 を立てる契約のため、**実子プロセスからの失敗は常に exit≠0 経路
 * にしか入らない**。exit≠0 の分岐がセンチネルを見ずに stderr(常に空。子は stderr へは書かない)
 * だけを載せていたため、実際に起きた失敗理由(例: ABI不一致の NODE_MODULE_VERSION 文言)が
 * CI ログから完全に失われていた。この抽出関数を exit 0/≠0 の両方から共有することで、
 * 「原因をログに残したうえで確実に block させる」という子スクリプトの契約を実際に満たす。
 */
function extractSentinelPayload(stdout: string): {
  readonly found: boolean;
  readonly payload?: SmokeSentinelPayload;
  readonly parseErrorMessage?: string;
} {
  const sentinelLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith(SMOKE_SENTINEL_PREFIX));
  if (sentinelLine === undefined) {
    return { found: false };
  }
  try {
    const payload = JSON.parse(
      sentinelLine.slice(SMOKE_SENTINEL_PREFIX.length),
    ) as SmokeSentinelPayload;
    return { found: true, payload };
  } catch (error) {
    return {
      found: true,
      parseErrorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * ヘッドレススモークの終了コード・センチネル出力を判定する。
 * - 子プロセスの起動自体が失敗(spawnのerror) → block
 * - シグナルで終了(タイムアウトの典型) → block
 * - exit code が 0 以外 → block(**stdout のセンチネルを解析し、取れた reason を message に
 *   含める。取れなければ stdout 末尾を載せる**。boss メタレビュー 要修正1: exit≠0 は何が
 *   あっても block のまま=fail-closed は弱めない。理由の可視化だけを追加する)
 * - exit 0 だがセンチネル行が見つからない → block(「静かに何もせず0で返る」を通さない)
 * - exit 0 でセンチネルはあるがJSONとしてパースできない → block
 * - exit 0 でセンチネルの ok が true でない(false または欠落) → block
 * - exit 0 でセンチネルが ok:true → allow
 */
export function judgeSmokeOutcome(outcome: SmokeProcessOutcome): GateResult {
  if (outcome.error !== undefined) {
    return {
      status: "block",
      message: `子プロセスの起動に失敗しました(${outcome.error.message})`,
    };
  }
  if (outcome.signal !== null) {
    return {
      status: "block",
      message: `子プロセスがシグナル(${outcome.signal})で終了しました(タイムアウトの可能性があります)`,
    };
  }

  const sentinel = extractSentinelPayload(outcome.stdout);

  if (outcome.status !== 0) {
    // fail-closed は絶対に弱めない: このブロックは常に status:"block" を返す。
    // 以下はメッセージへ理由を載せるための分岐であり、判定結果そのものには関与しない。
    let reasonPart: string;
    if (sentinel.payload?.reason !== undefined) {
      reasonPart = `reason: ${sentinel.payload.reason}`;
    } else if (sentinel.parseErrorMessage !== undefined) {
      reasonPart = `センチネルのJSON解析にも失敗しました(${sentinel.parseErrorMessage})`;
    } else if (sentinel.found) {
      reasonPart = "センチネルにreasonがありません";
    } else {
      reasonPart = `stdout末尾: ${outcome.stdout.slice(-2000)}`;
    }
    return {
      status: "block",
      message: `子プロセスが異常終了しました(exit code: ${outcome.status})。${reasonPart}。stderr: ${outcome.stderr.slice(0, 2000)}`,
    };
  }

  if (!sentinel.found) {
    return {
      status: "block",
      message:
        "子プロセスは正常終了(exit 0)しましたが、センチネル出力が見つかりません(スモークが実際に実行された保証がありません)",
    };
  }

  if (sentinel.parseErrorMessage !== undefined) {
    return {
      status: "block",
      message: `センチネル出力のJSON解析に失敗しました(${sentinel.parseErrorMessage})`,
    };
  }

  if (sentinel.payload?.ok !== true) {
    return {
      status: "block",
      message: `子プロセスがスモーク失敗を報告しました(${sentinel.payload?.reason ?? "詳細不明"})`,
    };
  }

  return { status: "allow" };
}

// ---------------------------------------------------------------------------
// S3: runSmokeCheck(実I/Oを注入可能にした駆動本体)
// ---------------------------------------------------------------------------

export interface SmokeRealDeps {
  readonly winUnpackedDir: string;
  readonly listWinUnpackedFileNames: () => string[];
  /**
   * 本番の resolveVerifiedNativeBindingPath(packages/app/src/main/native-binding.ts)を
   * そのまま渡す(既定は makeSmokeRealDeps が配線する)。検査スクリプトがパス規則を
   * 再実装しないことが本タスクの核心のため、ここを別実装で差し替えるのはテスト用途のみに限る。
   */
  readonly resolveNativeBinding: (input: {
    readonly isPackaged: boolean;
    readonly resourcesPath: string | undefined;
  }) => string | undefined;
  readonly mkdtemp: () => string;
  readonly rm: (dir: string) => void;
  readonly spawnChild: (exePath: string, args: string[]) => SmokeProcessOutcome;
}

/**
 * ヘッドレススモークの駆動本体。
 * 1. win-unpacked の exe をちょうど1個解決する(0個/複数個はblock)
 * 2. 本番と同一の resolveVerifiedNativeBindingPath を呼ぶ(packaged:true, resourcesPath指定)
 *    → .node が無ければここで例外を投げるので、その診断メッセージをそのままblockへ転記する
 *    (mkdtemp はまだ呼ばない。無駄な一時ディレクトリを作らないため)
 * 3. mkdtemp で一時ディレクトリを用意し、子プロセスを ELECTRON_RUN_AS_NODE=1 で起動する
 * 4. finally で必ず rm する(子が異常終了しても一時ディレクトリを残さない)
 * 5. 終了コード・センチネル出力を judgeSmokeOutcome で判定する
 */
export function runSmokeCheck(deps: SmokeRealDeps): GateResult {
  const exeResolution = resolveSingleWinUnpackedExe(
    deps.listWinUnpackedFileNames(),
    deps.winUnpackedDir,
  );
  if (!exeResolution.ok) {
    return exeResolution.result;
  }

  const resourcesPath = path.join(deps.winUnpackedDir, "resources");

  let nativeBindingPath: string | undefined;
  try {
    nativeBindingPath = deps.resolveNativeBinding({ isPackaged: true, resourcesPath });
  } catch (error) {
    return {
      status: "block",
      message: `ネイティブバインディングの解決に失敗しました(${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (nativeBindingPath === undefined) {
    // isPackaged:true かつ resourcesPath 定義済みで呼んでいるため、native-binding.ts の
    // 解決規則上ここは到達しないはず(到達したら native-binding.ts 側の規則が変わったことを疑う)。
    return {
      status: "block",
      message:
        "ネイティブバインディングのパスを解決できませんでした(isPackaged:true指定にもかかわらずundefinedが返りました。native-binding.tsの解決規則が変わった可能性があります)",
    };
  }

  const tmpDir = deps.mkdtemp();
  try {
    const tmpDbPath = path.join(tmpDir, "smoke.db");
    const outcome = deps.spawnChild(exeResolution.exePath, [
      nativeBindingPath,
      resourcesPath,
      tmpDbPath,
    ]);
    return judgeSmokeOutcome(outcome);
  } finally {
    deps.rm(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// 実I/O実装(CLI起動時の既定値)
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, "..");
/**
 * release ディレクトリの実パス。既定は CI 本番と同じ `packages/app/release`。
 *
 * `ARTIFACT_GATE_RELEASE_DIR_OVERRIDE` が設定されていればそちらを使う(boss メタレビュー
 * 【提案】: `実プロセス起動` テストが作業ツリーの実 `release/win-unpacked/resources/app.asar` を
 * rename退避→書き換え→復元していたため、プロセスが強制終了されると壊れたファイルと
 * `.artifact-gate-test-backup` が残置されるリスクがあった。この環境変数により、テストは
 * 一時ディレクトリを指すよう CLI 実プロセスへ注入でき、実リポジトリのファイルには一切触れずに
 * 済む。CI では未設定のため既定の実パスのまま動作は変わらない。
 */
const RELEASE_DIR =
  process.env.ARTIFACT_GATE_RELEASE_DIR_OVERRIDE !== undefined
    ? path.resolve(process.env.ARTIFACT_GATE_RELEASE_DIR_OVERRIDE)
    : path.join(REPO_ROOT, "packages/app/release");
const WIN_UNPACKED_DIR = path.join(RELEASE_DIR, "win-unpacked");
const APP_ASAR_PATH = path.join(WIN_UNPACKED_DIR, "resources", "app.asar");
const SMOKE_CHILD_SCRIPT_PATH = path.join(SCRIPT_DIR, "artifact-gate-smoke-child.cjs");
/**
 * スモーク子プロセスのタイムアウト。CREATE/INSERT/SELECT程度なので60秒あれば十分。
 * export するのは、テスト(M5対応)が「spawnSync へこの値が実際に渡っていること」を
 * 検証するときに、テスト側で別途同じ数値をハードコードして二重管理にしないため。
 */
export const SMOKE_TIMEOUT_MS = 60_000;

export function readAsarFileReal(): Buffer {
  return readFileSync(APP_ASAR_PATH);
}

export function judgeAsarLayoutCommand(deps: { readAsarFile: () => Buffer }): GateResult {
  let buffer: Buffer;
  try {
    buffer = deps.readAsarFile();
  } catch (error) {
    return {
      status: "block",
      message: `app.asar を読み込めません(${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return judgeAsarLayoutFromBytes(buffer);
}

function listWinUnpackedFileNamesReal(winUnpackedDir: string): string[] {
  try {
    return readdirSync(winUnpackedDir);
  } catch {
    // ディレクトリが無い場合も「0個」として扱う(resolveSingleWinUnpackedExe が block を返す)。
    return [];
  }
}

function mkdtempReal(): string {
  return mkdtempSync(path.join(tmpdir(), "keiba-artifact-gate-smoke-"));
}

function rmReal(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function spawnChildReal(exePath: string, args: string[]): SmokeProcessOutcome {
  const result: SpawnSyncReturns<string> = spawnSync(exePath, [SMOKE_CHILD_SCRIPT_PATH, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: SMOKE_TIMEOUT_MS,
    encoding: "utf8",
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * SmokeRealDeps を組み立てる。既定(引数省略時)は CI 本番と同じ
 * `packages/app/release/win-unpacked` を見る。winUnpackedDir を明示的に渡せるようにしているのは
 * (1) テストで実DepsのresolveNativeBindingが本物であることを、任意の一時ディレクトリ相手に
 * 検証するため (2) 手元での `--linux dir` 成果物に対する動作確認(本タスクの検証要件)を、
 * 本番CLIの配線を書き換えずに行うため。
 */
export function makeSmokeRealDeps(winUnpackedDir: string = WIN_UNPACKED_DIR): SmokeRealDeps {
  return {
    winUnpackedDir,
    listWinUnpackedFileNames: () => listWinUnpackedFileNamesReal(winUnpackedDir),
    // 本番と同一の関数をそのまま渡す(検査スクリプト側でパス規則を再実装しないことが核心)。
    resolveNativeBinding: resolveVerifiedNativeBindingPath,
    mkdtemp: mkdtempReal,
    rm: rmReal,
    spawnChild: spawnChildReal,
  };
}

export const SMOKE_REAL_DEPS: SmokeRealDeps = makeSmokeRealDeps();

// ---------------------------------------------------------------------------
// CLI ディスパッチ(薄い配線。判定核は上記の純関数が担う。release-gate.ts と同じ考え方)
// ---------------------------------------------------------------------------

export interface DispatchOutcome {
  exitCode: number;
  logs: string[];
}

function formatLogLine(result: GateResult, okLabel: string): string {
  if (result.status === "block") {
    return `::error::${result.message}`;
  }
  if (result.status === "skip") {
    return `::warning::${result.message}`;
  }
  return result.message !== undefined ? `::warning::${result.message}` : okLabel;
}

/**
 * dispatch() が判定核を呼ぶための依存(code-reviewer 再々レビュー指摘対応)。
 *
 * 背景: dispatch() は元々 judgeAsarLayoutCommand/runSmokeCheck を実I/O(readAsarFileReal/
 * SMOKE_REAL_DEPS)へ直接ハードワイヤしており、依存注入の余地が無かった。そのため
 * 「dispatch内部から想定外の例外が投げられてもrunMainがfail-closedで受け止める」ことを、
 * release-gate.test.tsのrunMainテスト(deps注入で意図的にthrowさせる)と同じ手法で
 * 検証できなかった。dispatch()/runMain() のJSDocは「release-gate.tsのrunMainと同じ考え方」と
 * 明記しているため、テスト容易性の面でも同じ考え方に揃える。
 *
 * boss 再メタレビュー【提案1】対応: 当初 dispatch() 自身にも既定値
 * (`deps: DispatchDeps = REAL_DISPATCH_DEPS`)を持たせていたが、本番経路は常に
 * `main() → runMain(argv)`(ここでのみ既定値 REAL_DISPATCH_DEPS が使われる)→
 * `dispatch(argv, deps)`(runMain から常に deps が明示的に渡される)であり、dispatch 側の
 * 既定値は本番経路から一度も評価されない dead default だった(boss実測: dispatch側の既定値を
 * allowスタブへ差し替える変異〈Mu6〉が49件全緑で無検出)。dispatch を deps 必須にすることで、
 * 既定値の所在を runMain 1箇所に集約し、この無検出の枝を消す。
 */
export interface DispatchDeps {
  readonly runAsarLayoutCheck: () => GateResult;
  readonly runSmoke: () => GateResult;
}

const REAL_DISPATCH_DEPS: DispatchDeps = {
  runAsarLayoutCheck: () => judgeAsarLayoutCommand({ readAsarFile: readAsarFileReal }),
  runSmoke: () => runSmokeCheck(SMOKE_REAL_DEPS),
};

export async function dispatch(argv: string[], deps: DispatchDeps): Promise<DispatchOutcome> {
  const [subcommand] = argv;

  if (subcommand === "asar-layout") {
    const result = deps.runAsarLayoutCheck();
    return {
      exitCode: resultToExitCode(result),
      // code-reviewer再レビュー【提案・対応任意】への対応: ARTIFACT_GATE_RELEASE_DIR_OVERRIDE は
      // CI では未設定を前提にしており(yml で設定していない)、誤設定・混入があっても
      // 存在しないディレクトリを指すだけなら fail-closed で実害は無い。ただし「検査が実際に
      // どのディレクトリを見たか」をCIログに残しておけば、意図しない設定漏れ・混入に
      // 気づきやすくなる(#45の据え置き検査が「実際に比較したこと」をログ行で示しているのと
      // 同じ発想)。判定結果とは無関係に常に出す。
      logs: [
        `release ディレクトリの解決先: ${RELEASE_DIR}`,
        formatLogLine(result, "asar 配置検査: 問題ありません(A1/A2 を満たしています)"),
      ],
    };
  }

  if (subcommand === "smoke") {
    const result = deps.runSmoke();
    return {
      exitCode: resultToExitCode(result),
      logs: [
        `release ディレクトリの解決先: ${RELEASE_DIR}`,
        formatLogLine(result, "ヘッドレススモーク: 問題ありません(DB作成・読み書きに成功しました)"),
      ],
    };
  }

  const result: GateResult = {
    status: "block",
    message: `未知のサブコマンドです: ${subcommand ?? "(未指定)"}(asar-layout | smoke のいずれかを指定してください)`,
  };
  return { exitCode: resultToExitCode(result), logs: [formatLogLine(result, "")] };
}

/**
 * dispatch() を try/catch で包み、想定外の例外を fail-closed(exit 1 + ::error::)で受け止める
 * (release-gate.ts の runMain と同じ考え方)。
 */
export async function runMain(
  argv: string[],
  deps: DispatchDeps = REAL_DISPATCH_DEPS,
): Promise<DispatchOutcome> {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    return {
      exitCode: 1,
      logs: [
        `::error::予期しない例外が発生しました(${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        })。fail-closed としてジョブを失敗させます`,
      ],
    };
  }
}

async function main(): Promise<void> {
  const outcome = await runMain(process.argv.slice(2));
  for (const line of outcome.logs) {
    console.log(line);
  }
  process.exitCode = outcome.exitCode;
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  void main();
}
