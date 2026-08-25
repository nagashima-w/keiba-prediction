/**
 * 配布 exe の「動くこと」を CI で検査するゲート(scripts/artifact-gate.ts)のテスト(Issue #62)。
 *
 * 背景: #60(better-sqlite3がpackaged実行でロードできなかった実機事故)を踏まえ、#61で
 * ネイティブバインディングのパスを明示指定した。しかし CI は配置検査(asarの構造)だけでは
 * ABI不一致(NODE_MODULE_VERSION不一致等)を1件も検出できないことが boss の実測
 * (壊れていたv1.3.1のasarで配置検査4項目すべてPASSしたのにヘッドレススモークだけがFAIL)で
 * 確定している。そのため本テストは
 *   (1) asar配置検査(縮小版・A1/A2)の判定核
 *   (2) asarヘッダのバイト列パーサ(実フォーマットで動くこと)
 *   (3) ヘッドレススモークの判定核(センチネル出力の解釈)
 *   (4) スモークの実装が本番と同一の resolveVerifiedNativeBindingPath を再利用していること
 *      (パス規則を再実装していないこと。#61で同語反復テストの差し戻しが2度あったため、
 *      ここは「検証対象と同じ関数で答え合わせをする」形を避け、参照同一性 + 実際に呼ばれた
 *      ときの本物のエラー文言で確認する)
 * を検証する。
 *
 * 【禁止事項の遵守】「nativeBindingにapp.asar/側のパスを渡すと失敗するはず」というテストは
 * 書かない(asar shimの透過リダイレクトにより実際には成功する。boss実測済み)。
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// spawnSyncだけをspy可能なvi.fn()へ差し替える(node:child_processのESM名前空間は
// Object.definePropertyの都合でvi.spyOnによる再定義を受け付けないため、vi.mock+
// importOriginalで部分モック化する。既定はactual実装への素通しなので、他のテストが
// 実際のサブプロセス起動を必要とする箇所(実プロセス起動テスト・M3の子プロセス直接起動)は
// 挙動が変わらない。M5対応のテストでだけ一時的にmockReturnValueOnceで差し替える)。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

import { resolveVerifiedNativeBindingPath } from "../../packages/app/src/main/native-binding.js";
import {
  SMOKE_SENTINEL_PREFIX,
  SMOKE_TIMEOUT_MS,
  dispatch,
  judgeAsarLayout,
  judgeAsarLayoutCommand,
  judgeAsarLayoutFromBytes,
  judgeSmokeOutcome,
  makeSmokeRealDeps,
  parseAsarHeader,
  resolveSingleWinUnpackedExe,
  resultToExitCode,
  runMain,
  runSmokeCheck,
  type AsarNode,
  type DispatchDeps,
  type GateResult,
  type SmokeProcessOutcome,
  type SmokeRealDeps,
} from "../artifact-gate.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(currentDir, "../..");
const SCRIPT_ABS_PATH = path.join(REPO_ROOT, "scripts/artifact-gate.ts");

// ---------------------------------------------------------------------------
// テスト用ヘルパ: 最小asarバッファの手組み立て(実フォーマット準拠)
// ---------------------------------------------------------------------------

/**
 * 実際の @electron/asar (3.4.1、node_modules 内に electron-builder 経由で存在) が生成した
 * asar ファイルをバイト単位で解析し、下記の構造を実測で確定した(/tmp での実験、Bashツール):
 *
 *   bytes[0,4)   = 4 (固定。外側 size-pickle の payload_size フィールド。中身が uint32 1個のため常に4)
 *   bytes[4,8)   = innerHeaderPickle の長さ N
 *   bytes[8, 8+N) が innerHeaderPickle:
 *     bytes[8,12)  = 文字列pickleのpayload_size(= 4 + jsonバイト長 + パディング)
 *     bytes[12,16) = ヘッダJSONのバイト長(ブリーフの「readUInt32LE(12)」はこれ)
 *     bytes[16, 16+len) = ヘッダJSON本体(UTF-8、パディングなし)
 *     bytes[16+len, 8+N) = 4バイト境界への0パディング
 *   bytes[8+N, ...] = 実ファイルのペイロード(パースには無関係)
 *
 * parseAsarHeader はこの実フォーマットに従って書く(推測ではなく実測に基づく)。
 */
function buildMinimalAsarBuffer(headerJson: unknown, payload = Buffer.alloc(0)): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(headerJson), "utf8");
  const stringPayloadLen = 4 + jsonBuf.length; // 長さフィールド4バイト + JSON本体
  const paddedStringPayloadLen = Math.ceil(stringPayloadLen / 4) * 4;
  const padding = Buffer.alloc(paddedStringPayloadLen - stringPayloadLen);

  const innerHeaderPickle = Buffer.concat([
    uint32LE(paddedStringPayloadLen), // bytes[8,12) 相当(文字列pickleのpayload_size)
    uint32LE(jsonBuf.length), // bytes[12,16) 相当(JSONバイト長)
    jsonBuf,
    padding,
  ]);

  const sizePickle = Buffer.concat([
    uint32LE(4), // bytes[0,4): 外側size-pickleのpayload_size(常に4)
    uint32LE(innerHeaderPickle.length), // bytes[4,8): innerHeaderPickleの長さ
  ]);

  return Buffer.concat([sizePickle, innerHeaderPickle, payload]);
}

function uint32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// 正常系ヘッダの雛形(judgeAsarLayoutのテーブル駆動テストで使い回す)
// ---------------------------------------------------------------------------

/** A1/A2 双方を満たす正常な asar ヘッダ木を組み立てる。 */
function baseHeader(): AsarNode {
  return {
    files: {
      dist: {
        files: {
          main: { files: { "main.cjs": { size: 10, offset: "0" } } },
          preload: { files: { "preload.cjs": { size: 10, offset: "10" } } },
          renderer: { files: { "index.html": { size: 10, offset: "20" } } },
        },
      },
      node_modules: {
        files: {
          "better-sqlite3": {
            files: {
              build: {
                files: {
                  Release: {
                    files: {
                      // unpacked:true の場合、実測(前述コメント参照)では offset を持たない。
                      "better_sqlite3.node": { size: 100, unpacked: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "package.json": { size: 5, offset: "999" },
    },
  };
}

// ---------------------------------------------------------------------------
// (1) parseAsarHeader: バイト列パーサ(実フォーマット・境界値)
// ---------------------------------------------------------------------------

describe("parseAsarHeader(asarヘッダのバイト列パーサ)", () => {
  it("実フォーマットに従って組み立てた最小asarバッファからヘッダJSONを正しく取り出す", () => {
    const header = baseHeader();
    const buffer = buildMinimalAsarBuffer(header);

    const result = parseAsarHeader(buffer);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("到達しないはず");
    }
    expect(result.header).toEqual(header);
  });

  it("空ファイル(0バイト)は例外を投げずにok:falseを返す(fail-closed)", () => {
    expect(() => parseAsarHeader(Buffer.alloc(0))).not.toThrow();
    const result = parseAsarHeader(Buffer.alloc(0));
    expect(result.ok).toBe(false);
  });

  it("16バイト未満(ヘッダに満たない)は例外を投げずにok:falseを返す(fail-closed)", () => {
    const result = parseAsarHeader(Buffer.alloc(10));
    expect(result.ok).toBe(false);
  });

  it("ヘッダJSONのサイズがファイル長を超えている(サイズ不足)場合、例外を投げずにok:falseを返す(fail-closed)", () => {
    const buffer = buildMinimalAsarBuffer(baseHeader());
    // ヘッダJSON長を実際より過大な値に破壊する(offset 12, uint32LE)。
    const corrupted = Buffer.from(buffer);
    corrupted.writeUInt32LE(0xffffff, 12);
    const result = parseAsarHeader(corrupted);
    expect(result.ok).toBe(false);
  });

  it("ヘッダJSON本体が壊れている(パース不能なJSON)場合、例外を投げずにok:falseを返す(fail-closed)", () => {
    const buffer = buildMinimalAsarBuffer(baseHeader());
    const corrupted = Buffer.from(buffer);
    // JSON本体の先頭バイトを破壊する(構文として不正になる)。
    corrupted[16] = 0x00;
    corrupted[17] = 0x00;
    const result = parseAsarHeader(corrupted);
    expect(result.ok).toBe(false);
  });

  it("ヘッダJSONにfilesが無い場合、例外を投げずにok:falseを返す(fail-closed)", () => {
    const buffer = buildMinimalAsarBuffer({ notFiles: {} });
    const result = parseAsarHeader(buffer);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) judgeAsarLayout: テーブル駆動(A1/A2)
// ---------------------------------------------------------------------------

describe("judgeAsarLayout(asar配置検査の判定核・A1/A2)", () => {
  it("正常系(全.node展開済み・dist必須3ファイルあり)はallow", () => {
    const result = judgeAsarLayout(baseHeader());
    expect(result.status).toBe("allow");
  });

  it("A1: .nodeエントリがasar内に packed(unpacked!==true) で残っているとblock", () => {
    const header = baseHeader();
    // unpacked を外す(packedのまま残っている状態を再現)。
    (
      header.files!.node_modules!.files!["better-sqlite3"]!.files!.build!.files!.Release!.files![
        "better_sqlite3.node"
      ] as { unpacked?: boolean }
    ).unpacked = undefined;

    const result = judgeAsarLayout(header);

    expect(result.status).toBe("block");
  });

  it("A1: .nodeが複数あり、片方がpackedならblock(もう片方がunpackedでも)", () => {
    const header = baseHeader();
    header.files!.node_modules!.files!["other-native-pkg"] = {
      files: {
        "other.node": { size: 50, offset: "500" }, // unpacked指定なし=packed
      },
    };

    const result = judgeAsarLayout(header);

    expect(result.status).toBe("block");
  });

  it("A2: dist/main/main.cjsが欠落しているとblock", () => {
    const header = baseHeader();
    delete header.files!.dist!.files!.main;

    const result = judgeAsarLayout(header);

    expect(result.status).toBe("block");
  });

  it("A2: dist/preload/preload.cjsが欠落しているとblock", () => {
    const header = baseHeader();
    delete header.files!.dist!.files!.preload;

    const result = judgeAsarLayout(header);

    expect(result.status).toBe("block");
  });

  it("A2: dist/renderer/index.htmlが欠落しているとblock", () => {
    const header = baseHeader();
    delete header.files!.dist!.files!.renderer;

    const result = judgeAsarLayout(header);

    expect(result.status).toBe("block");
  });

  it("A1: .nodeエントリが0件(ビルド構成変化でネイティブモジュール自体が消えた)場合はblock(扱いを明示的に固定する)", () => {
    const header = baseHeader();
    delete header.files!.node_modules;

    // 前提: 0件になっていることを無条件expectで先に固定する(空振り防止)。
    const flatNodeCount = JSON.stringify(header).match(/\.node/g);
    expect(flatNodeCount).toBeNull();

    const result = judgeAsarLayout(header);

    expect(result.status).toBe("block");
  });
});

describe("judgeAsarLayoutFromBytes(parseAsarHeader失敗をfail-closedでblockに変換する合成関数)", () => {
  it("正常なバッファではjudgeAsarLayoutと同じ判定になる(allow)", () => {
    const buffer = buildMinimalAsarBuffer(baseHeader());
    const result = judgeAsarLayoutFromBytes(buffer);
    expect(result.status).toBe("allow");
  });

  it("壊れたバッファ(ヘッダ解析不能)は例外を投げずにblockになる", () => {
    expect(() => judgeAsarLayoutFromBytes(Buffer.alloc(0))).not.toThrow();
    const result = judgeAsarLayoutFromBytes(Buffer.alloc(0));
    expect(result.status).toBe("block");
  });
});

describe("judgeAsarLayoutCommand(app.asar読み込み自体の失敗をfail-closedでblockに変換する。boss メタレビュー 要修正2)", () => {
  // 要修正2: このファイルに judgeAsarLayoutCommand の呼び出しが1件も無く、「app.asar を
  // 読み込めません」分岐(= app.asar が存在しない場合)が一度も実行されていなかった
  // (boss の fail-open 変異注入で36件全緑のまま素通りしたことで実証された)。
  // 既存の「実プロセス起動」テストは壊れたファイルを置くため読み込みは成功し、この分岐を
  // 通らない。ここでは deps.readAsarFile を直接注入する純粋な単体テストとして、この分岐を
  // 確実に固定する(副作用なし。実ファイルには一切触れない)。

  it("readAsarFileが例外を投げる(app.asarが存在しない等)場合、例外を投げずにblockを返す(fail-closed)", () => {
    const call = () =>
      judgeAsarLayoutCommand({
        readAsarFile: () => {
          throw new Error("ENOENT: no such file or directory, open 'app.asar'");
        },
      });

    expect(call).not.toThrow();
    const result = call();
    expect(result.status).toBe("block");
    if (result.status !== "block") throw new Error("到達しないはず");
    expect(result.message).toContain("app.asar を読み込めません");
    expect(result.message).toContain("ENOENT");
  });

  it("readAsarFileが成功すればjudgeAsarLayoutFromBytesへ委譲される(正常系。allowになること)", () => {
    const buffer = buildMinimalAsarBuffer(baseHeader());
    const result = judgeAsarLayoutCommand({ readAsarFile: () => buffer });
    expect(result.status).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// (3) resolveSingleWinUnpackedExe: win-unpacked の exe を一意に解決(0個/複数個はblock)
// ---------------------------------------------------------------------------

describe("resolveSingleWinUnpackedExe(win-unpackedのexe解決・0個/複数個はblock)", () => {
  const dir = "C:\\dummy\\win-unpacked";

  it("ちょうど1個ならokでそのパスを返す", () => {
    const result = resolveSingleWinUnpackedExe(["app.exe"], dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("到達しないはず");
    expect(result.exePath).toBe(path.join(dir, "app.exe"));
  });

  it("0個はblock(release-gate.tsのresolveSingleExeNameとは異なりskipではない)", () => {
    const result = resolveSingleWinUnpackedExe([], dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("到達しないはず");
    expect(result.result.status).toBe("block");
  });

  it("複数個はblock", () => {
    const result = resolveSingleWinUnpackedExe(["a.exe", "b.exe"], dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("到達しないはず");
    expect(result.result.status).toBe("block");
  });

  it(".exe以外は無視して数える(大文字小文字を区別しない)", () => {
    const result = resolveSingleWinUnpackedExe(["readme.txt", "App.EXE"], dir);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (4) judgeSmokeOutcome: 終了コード+センチネル出力の解釈
// ---------------------------------------------------------------------------

function outcome(overrides: Partial<SmokeProcessOutcome>): SmokeProcessOutcome {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    error: undefined,
    ...overrides,
  };
}

describe("judgeSmokeOutcome(終了コード+センチネル出力の判定)", () => {
  it("exit 0 + 正しいセンチネル(ok:true)はallow", () => {
    const result = judgeSmokeOutcome(
      outcome({
        status: 0,
        stdout: `何か別のログ行\n${SMOKE_SENTINEL_PREFIX}${JSON.stringify({ ok: true })}\n`,
      }),
    );
    expect(result.status).toBe("allow");
  });

  it("exit 0 だがセンチネル出力が無いとblock(静かに何もせず0で返るのを通さない)", () => {
    const result = judgeSmokeOutcome(outcome({ status: 0, stdout: "何も出力していない\n" }));
    expect(result.status).toBe("block");
  });

  it("exit 0 だがセンチネルがok:falseを報告している場合もblock", () => {
    const result = judgeSmokeOutcome(
      outcome({
        status: 0,
        stdout: `${SMOKE_SENTINEL_PREFIX}${JSON.stringify({ ok: false, reason: "DB検証失敗" })}\n`,
      }),
    );
    expect(result.status).toBe("block");
    if (result.status !== "block") throw new Error("到達しないはず");
    expect(result.message).toContain("DB検証失敗");
  });

  it("exit 0 だがセンチネルにokキー自体が無い場合もblock(欠落。fail-openな`=== false`判定への弱化を検出する正の対照)", () => {
    // code-reviewer一次レビュー指摘対応: judgeSmokeOutcomeのJSDocは
    // 「okがtrueでない(falseまたは欠落)→block」と明記しているが、既存テストは
    // {ok:true}と{ok:false}の2値しか送っておらず、`payload.ok !== true`を
    // `payload.ok === false`へ弱める変異(欠落・非booleanを通してしまう)を検出できていなかった
    // (レビュアーがsedで実注入し34件全緑のままであることを実証済み)。
    const result = judgeSmokeOutcome(
      outcome({
        status: 0,
        stdout: `${SMOKE_SENTINEL_PREFIX}${JSON.stringify({ resourcesPath: "x" })}\n`,
      }),
    );
    expect(result.status).toBe("block");
  });

  it("exit 0 だがセンチネルのokが非boolean(文字列\"true\"等)のtruthy値の場合もblock(`=== false`判定への弱化を検出する正の対照)", () => {
    const result = judgeSmokeOutcome(
      outcome({
        status: 0,
        stdout: `${SMOKE_SENTINEL_PREFIX}${JSON.stringify({ ok: "true" })}\n`,
      }),
    );
    expect(result.status).toBe("block");
  });

  it("exit 0 だがセンチネル行のJSONが壊れている場合もblock(パース例外を投げない)", () => {
    const call = () =>
      judgeSmokeOutcome(outcome({ status: 0, stdout: `${SMOKE_SENTINEL_PREFIX}{不正json\n` }));
    expect(call).not.toThrow();
    expect(call().status).toBe("block");
  });

  it("exit≠0はblock", () => {
    const result = judgeSmokeOutcome(
      outcome({ status: 1, stdout: "", stderr: "何らかのエラー" }),
    );
    expect(result.status).toBe("block");
  });

  it("exit≠0でもstdoutのセンチネルからreasonを取り出してmessageに含める(boss メタレビュー 要修正1: ABI不一致等の診断がCIログから消えていた問題への対応)。fail-closed(block)は絶対に弱めない", () => {
    // boss が実際に再現したABI不一致の実文言そのものを使い、この文言がmessageに載ることを固定する。
    // 子スクリプトは失敗時に必ずexitCode=1を立てるため、実子プロセスからの失敗は常にこの分岐
    // (status!==0)にしか入らない。この分岐がreasonを見ずにstderr(常に空)だけを載せていたのが
    // 要修正1の実体だった。
    const abiMismatchReason =
      "DB操作(CREATE/INSERT/SELECT)に失敗しました: Error: .../better_sqlite3.node was compiled " +
      "against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js " +
      "requires NODE_MODULE_VERSION 132.";
    const result = judgeSmokeOutcome(
      outcome({
        status: 1,
        stdout: `${SMOKE_SENTINEL_PREFIX}${JSON.stringify({ ok: false, reason: abiMismatchReason })}\n`,
        stderr: "",
      }),
    );

    // fail-closedを弱めていないことを先に固定する(このテストが「原因が見えるようになった」こと
    // だけを見て、うっかりallowへ倒れる変異を見逃さないため)。
    expect(result.status).toBe("block");
    if (result.status !== "block") throw new Error("到達しないはず");
    expect(result.message).toContain("NODE_MODULE_VERSION 127");
    expect(result.message).toContain("NODE_MODULE_VERSION 132");
  });

  it("exit≠0でセンチネル自体が見つからない場合は、stdout末尾をmessageに含める(reasonが取れないときのフォールバック)", () => {
    const result = judgeSmokeOutcome(
      outcome({ status: 1, stdout: "センチネルより前に何か出力\n", stderr: "" }),
    );
    expect(result.status).toBe("block");
    if (result.status !== "block") throw new Error("到達しないはず");
    expect(result.message).toContain("センチネルより前に何か出力");
  });

  it("シグナルで終了(タイムアウトの典型)した場合はblock", () => {
    const result = judgeSmokeOutcome(outcome({ status: null, signal: "SIGTERM" }));
    expect(result.status).toBe("block");
  });

  it("子プロセスの起動自体が失敗した場合(spawnのerror)はblock", () => {
    const result = judgeSmokeOutcome(
      outcome({ status: null, error: new Error("spawn ENOENT") }),
    );
    expect(result.status).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// (5) runSmokeCheck: 実際の配線(resolveVerifiedNativeBindingPathの再利用の実効性)
// ---------------------------------------------------------------------------

describe("runSmokeCheck(スモーク駆動の配線・resolveVerifiedNativeBindingPathの再利用)", () => {
  let tmpBase: string;

  function fakeDeps(overrides: Partial<SmokeRealDeps>): SmokeRealDeps {
    const winUnpackedDir = path.join(tmpBase, "win-unpacked");
    return {
      winUnpackedDir,
      listWinUnpackedFileNames: () => {
        throw new Error("このテストでは未使用のはず");
      },
      resolveNativeBinding: () => {
        throw new Error("このテストでは未使用のはず");
      },
      mkdtemp: () => {
        throw new Error("このテストでは未使用のはず");
      },
      rm: () => {
        throw new Error("このテストでは未使用のはず");
      },
      spawnChild: () => {
        throw new Error("このテストでは未使用のはず");
      },
      ...overrides,
    };
  }

  function makeCalls() {
    return {
      mkdtempCalls: [] as string[],
      rmCalls: [] as string[],
      spawnCalls: [] as Array<{ exePath: string; args: string[] }>,
    };
  }

  function setUp(): void {
    tmpBase = mkdtempSync(path.join(tmpdir(), "keiba-artifact-gate-runsmoke-"));
  }
  function tearDown(): void {
    rmSync(tmpBase, { recursive: true, force: true });
  }

  it("実DepsのresolveNativeBindingは本番のresolveVerifiedNativeBindingPathと参照同一(パス規則の再実装ではないことの固定)", () => {
    setUp();
    try {
      const deps = makeSmokeRealDeps(path.join(tmpBase, "win-unpacked"));
      expect(deps.resolveNativeBinding).toBe(resolveVerifiedNativeBindingPath);
    } finally {
      tearDown();
    }
  });

  it("exeが0個ならblockで、resolveNativeBinding/mkdtemp/spawnChildは一切呼ばれない", () => {
    setUp();
    try {
      const winUnpackedDir = path.join(tmpBase, "win-unpacked");
      mkdirSync(winUnpackedDir, { recursive: true });
      const deps = fakeDeps({
        listWinUnpackedFileNames: () => [],
      });

      const result = runSmokeCheck(deps);

      expect(result.status).toBe("block");
    } finally {
      tearDown();
    }
  });

  it("exeが1個で.nodeが実在しない場合、本物のresolveVerifiedNativeBindingPathが実際に呼ばれ、その固有のエラー文言(fs.existsSync)がGateResultのmessageに現れる。mkdtemp/spawnChildは呼ばれない(nativeBinding解決失敗で一時ディレクトリを作らない)", () => {
    setUp();
    try {
      const winUnpackedDir = path.join(tmpBase, "win-unpacked");
      mkdirSync(winUnpackedDir, { recursive: true });
      writeFileSync(path.join(winUnpackedDir, "app.exe"), "dummy");
      // resources配下に.nodeを一切置かない(resolveVerifiedNativeBindingPathが例外を投げる状況)。

      const calls = makeCalls();
      const deps: SmokeRealDeps = {
        winUnpackedDir,
        listWinUnpackedFileNames: () => readdirSync(winUnpackedDir),
        resolveNativeBinding: resolveVerifiedNativeBindingPath, // 本物をそのまま使う
        mkdtemp: () => {
          calls.mkdtempCalls.push("called");
          throw new Error("呼ばれないはず");
        },
        rm: (dir) => {
          calls.rmCalls.push(dir);
        },
        spawnChild: (exePath, args) => {
          calls.spawnCalls.push({ exePath, args });
          throw new Error("呼ばれないはず");
        },
      };

      const result = runSmokeCheck(deps);

      expect(result.status).toBe("block");
      if (result.status !== "block") throw new Error("到達しないはず");
      // native-binding.ts 固有の文言(検証対象と同じ関数で答え合わせをしていないことの証拠:
      // このテストはpath規則を再計算せず、本物の関数が投げた実際のメッセージ片を見るだけ)。
      expect(result.message).toContain("fs.existsSync");
      expect(calls.mkdtempCalls.length).toBe(0);
      expect(calls.spawnCalls.length).toBe(0);
    } finally {
      tearDown();
    }
  });

  it("exeが1個で.nodeが実在する場合、本物のresolveVerifiedNativeBindingPathが解決した絶対パスがspawnChildへ渡り、mkdtemp→spawnChild→rm(finally)の順で呼ばれる", () => {
    setUp();
    try {
      const winUnpackedDir = path.join(tmpBase, "win-unpacked");
      const nativeDir = path.join(
        winUnpackedDir,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
      );
      mkdirSync(nativeDir, { recursive: true });
      const nativeFile = path.join(nativeDir, "better_sqlite3.node");
      writeFileSync(nativeFile, "dummy");
      mkdirSync(winUnpackedDir, { recursive: true });
      writeFileSync(path.join(winUnpackedDir, "app.exe"), "dummy");

      const fakeTmpDir = path.join(tmpBase, "fake-tmp");
      const calls = makeCalls();
      const deps: SmokeRealDeps = {
        winUnpackedDir,
        listWinUnpackedFileNames: () => readdirSync(winUnpackedDir),
        resolveNativeBinding: resolveVerifiedNativeBindingPath,
        mkdtemp: () => {
          calls.mkdtempCalls.push(fakeTmpDir);
          return fakeTmpDir;
        },
        rm: (dir) => {
          calls.rmCalls.push(dir);
        },
        spawnChild: (exePath, args) => {
          calls.spawnCalls.push({ exePath, args });
          return outcome({
            status: 0,
            stdout: `${SMOKE_SENTINEL_PREFIX}${JSON.stringify({ ok: true })}\n`,
          });
        },
      };

      const result = runSmokeCheck(deps);

      expect(result.status).toBe("allow");
      expect(calls.mkdtempCalls.length).toBe(1);
      expect(calls.spawnCalls.length).toBe(1);
      expect(calls.spawnCalls[0]!.exePath).toBe(path.join(winUnpackedDir, "app.exe"));
      // boss メタレビュー M3対応: nativeBindingPathが解決済みの絶対パスとして子プロセス引数に
      // 渡っていることを、単なる包含(toContain)ではなく**完全一致・順序込み**で固定する
      // (旧toContainでは引数順序を入れ替える変異〈nativeBindingPath/resourcesPath/tmpDbPathの
      // 並びを崩す〉を検出できず、boss実測で36件全緑のまま素通りした)。
      // 子スクリプト(artifact-gate-smoke-child.cjs)は argv[2]=nativeBindingPath,
      // argv[3]=expectedResourcesPath, argv[4]=tmpDbPath の順で読む契約のため、
      // このファイル側もその順序どおりに渡していることを直接固定する。
      const resourcesPath = path.join(winUnpackedDir, "resources");
      expect(calls.spawnCalls[0]!.args).toEqual([
        nativeFile,
        resourcesPath,
        path.join(fakeTmpDir, "smoke.db"),
      ]);
      expect(calls.rmCalls).toEqual([fakeTmpDir]);
    } finally {
      tearDown();
    }
  });

  it("spawnChildが異常終了(exit≠0)の結果を返しても、finallyでrmが必ず呼ばれる(一時ディレクトリを残さない)", () => {
    setUp();
    try {
      const winUnpackedDir = path.join(tmpBase, "win-unpacked");
      const nativeDir = path.join(
        winUnpackedDir,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
      );
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(path.join(nativeDir, "better_sqlite3.node"), "dummy");
      writeFileSync(path.join(winUnpackedDir, "app.exe"), "dummy");

      const fakeTmpDir = path.join(tmpBase, "fake-tmp-2");
      const calls = makeCalls();
      const deps: SmokeRealDeps = {
        winUnpackedDir,
        listWinUnpackedFileNames: () => readdirSync(winUnpackedDir),
        resolveNativeBinding: resolveVerifiedNativeBindingPath,
        mkdtemp: () => fakeTmpDir,
        rm: (dir) => calls.rmCalls.push(dir),
        spawnChild: () => outcome({ status: 1, stderr: "クラッシュ" }),
      };

      const result = runSmokeCheck(deps);

      expect(result.status).toBe("block");
      expect(calls.rmCalls).toEqual([fakeTmpDir]);
    } finally {
      tearDown();
    }
  });
});

// ---------------------------------------------------------------------------
// M3対応: 子プロセス(artifact-gate-smoke-child.cjs)のargv位置契約を、子スクリプト単独を
// plain node で直接起動して固定する(runSmokeCheckの内部配線だけでなく、2ファイル間の
// 実際の引数受け渡し契約そのものを検証する。boss実測: 引数順序を入れ替える変異が36件全緑で
// 素通りしていた)。
// ---------------------------------------------------------------------------

describe("子プロセス(artifact-gate-smoke-child.cjs)のargv位置契約(M3対応)", () => {
  const SMOKE_CHILD_SCRIPT_ABS_PATH = path.join(
    REPO_ROOT,
    "scripts/artifact-gate-smoke-child.cjs",
  );

  function runChild(args: [string, string, string]): { ok: boolean; reason?: string } {
    // plain node(Electronではない)で直接起動する。process.resourcesPathは常にundefinedのため、
    // argv[3](expectedResourcesPath)との不一致で必ずfail()し、その理由文にargv[3]の値が
    // そのまま載る。これを使ってargv[3]の位置を直接特定する。
    const result = spawnSync(process.execPath, [SMOKE_CHILD_SCRIPT_ABS_PATH, ...args], {
      encoding: "utf8",
    });
    const sentinelLine = (result.stdout ?? "")
      .split("\n")
      .find((line) => line.startsWith(SMOKE_SENTINEL_PREFIX));
    if (sentinelLine === undefined) {
      throw new Error(`センチネル出力が無い: stdout=${result.stdout} stderr=${result.stderr}`);
    }
    return JSON.parse(sentinelLine.slice(SMOKE_SENTINEL_PREFIX.length)) as {
      ok: boolean;
      reason?: string;
    };
  }

  it("argv[2]=nativeBindingPath, argv[3]=expectedResourcesPath, argv[4]=tmpDbPathの順で解釈する(1組目)", () => {
    const sentinel = runChild(["NATIVE_BINDING_A", "RESOURCES_PATH_A", "TMP_DB_A"]);
    expect(sentinel.ok).toBe(false);
    if (sentinel.ok) throw new Error("到達しないはず");
    // 前提固定: fail()の理由がprocess.resourcesPath不一致であること自体をまず無条件で固定する。
    expect(sentinel.reason).toContain("process.resourcesPathが期待値と一致しません");
    // argv[3]の値(RESOURCES_PATH_A)だけがexpected=として現れ、他の2値は現れないこと。
    expect(sentinel.reason).toContain("RESOURCES_PATH_A");
    expect(sentinel.reason).not.toContain("NATIVE_BINDING_A");
    expect(sentinel.reason).not.toContain("TMP_DB_A");
  });

  it("argv[2]とargv[3]の値を入れ替えると、fail理由のexpected=も追随して入れ替わる(位置依存であることの直接固定。2組目)", () => {
    // 1組目とは逆に、1番目の位置にRESOURCES_PATH寄りの値、2番目の位置にNATIVE_BINDING寄りの
    // 値を置く。もしargv[2]を読んでいる(位置がずれている)変異が入っていれば、この期待は
    // 1組目と矛盾する形で崩れる。
    const sentinel = runChild(["RESOURCES_PATH_B", "NATIVE_BINDING_B", "TMP_DB_B"]);
    expect(sentinel.ok).toBe(false);
    if (sentinel.ok) throw new Error("到達しないはず");
    expect(sentinel.reason).toContain("NATIVE_BINDING_B");
    expect(sentinel.reason).not.toContain("RESOURCES_PATH_B");
    expect(sentinel.reason).not.toContain("TMP_DB_B");
  });
});

// ---------------------------------------------------------------------------
// M5対応: spawnSync に timeout: SMOKE_TIMEOUT_MS が実際に渡っていることを固定する
// (boss実測: timeoutオプションを削除する変異が36件全緑で素通りしていた。JSDocが
// タイムアウトの目的〈ハングしたらジョブ上限まで回るのを防ぐ〉を明記しているのに未固定だった)。
// ---------------------------------------------------------------------------

describe("makeSmokeRealDeps().spawnChildがspawnSyncへtimeoutを実際に渡す(M5対応)", () => {
  it("spawnSyncの第3引数(オプション)にtimeout: SMOKE_TIMEOUT_MSが含まれる", () => {
    // node:child_process.spawnSync を(ファイル冒頭のvi.mockにより)vi.fn()化したものへ
    // 一度だけ差し替え、実際のプロセスは起動しない(spawnChildRealのロジックだけを検証する)。
    const mockedSpawnSync = vi.mocked(spawnSync);
    const callsBefore = mockedSpawnSync.mock.calls.length;
    mockedSpawnSync.mockReturnValueOnce({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    const deps = makeSmokeRealDeps("/dummy/win-unpacked");
    deps.spawnChild("/dummy/win-unpacked/app.exe", ["a", "b", "c"]);

    expect(mockedSpawnSync.mock.calls.length).toBe(callsBefore + 1);
    const callArgs = mockedSpawnSync.mock.calls[callsBefore]!;
    const options = callArgs[2] as { timeout?: number };
    expect(options.timeout).toBe(SMOKE_TIMEOUT_MS);
    // SMOKE_TIMEOUT_MS自体が0や未定義的な値に弱化されていないことも併せて固定する。
    expect(SMOKE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CLI配線: dispatch()のふるまい(release-gate.tsと同じ考え方。実際に返る終了コードで固定)
// ---------------------------------------------------------------------------

describe("dispatch(CLI配線のふるまい)", () => {
  it("未知のサブコマンドはblock相当(終了コード1)", async () => {
    const outcome2 = await dispatch(["unknown-subcommand"]);
    expect(outcome2.exitCode).toBe(1);
  });

  it("resultToExitCodeの写像はrelease-gate.tsと同じ規約(block=1, allow/skip=0)", () => {
    const block: GateResult = { status: "block", message: "x" };
    const allow: GateResult = { status: "allow" };
    expect(resultToExitCode(block)).toBe(1);
    expect(resultToExitCode(allow)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 配線: runMain(main() の fail-closed ラッパ。code-reviewer 再々レビュー指摘対応)
//
// scripts/release-gate.ts の runMain には同種のテストが3件既にあり(過去に code-reviewer が
// 同じ観点で指摘して追加されたもの)、artifact-gate.ts の runMain の JSDoc は「release-gate.ts の
// runMain と同じ考え方」と明記している。にもかかわらずテストは移植されておらず、
// dispatch()の"smoke"分岐をfail-openへ弱める変異が45件全緑のまま素通りしていた
// (SMOKE_REAL_DEPSをgrepすると0件、というのが発見の端緒)。
// release-gate.test.ts の describe("配線: runMain(...)") と同等の粒度(素通り確認・
// Errorオブジェクトのthrow・非Errorオブジェクトのthrow)で固定する。
// ---------------------------------------------------------------------------

describe("配線: runMain(想定外の例外を fail-closed で受け止める。code-reviewer 再々レビュー指摘対応)", () => {
  it("dispatch が正常に完了する場合は dispatch と同じ結果を返す(素通りの確認)", async () => {
    const deps: DispatchDeps = {
      runAsarLayoutCheck: () => ({ status: "allow" }),
      runSmoke: () => ({ status: "block", message: "スモーク失敗(テスト用)" }),
    };

    const dispatchOutcome = await dispatch(["asar-layout"], deps);
    const runMainOutcome = await runMain(["asar-layout"], deps);

    expect(runMainOutcome).toEqual(dispatchOutcome);
    expect(runMainOutcome.exitCode).toBe(0);
  });

  it("runAsarLayoutCheck が想定外の例外(Errorオブジェクト)を投げても exit 1 になり ::error:: と「予期しない例外」を含む(dispatch()のasar-layout分岐から想定外にthrowするケース)", async () => {
    const deps: DispatchDeps = {
      runAsarLayoutCheck: () => {
        throw new Error("想定外の実I/O例外(権限エラー等を模擬)");
      },
      runSmoke: () => {
        throw new Error("このテストでは未使用のはず");
      },
    };

    const outcome = await runMain(["asar-layout"], deps);

    expect(outcome.exitCode).toBe(1);
    const logText = outcome.logs.join("\n");
    expect(logText).toContain("::error::");
    expect(logText).toContain("予期しない例外");
    expect(logText).toContain("想定外の実I/O例外");
  });

  it("runSmoke が想定外の例外(Errorオブジェクト)を投げても exit 1 になり ::error:: と「予期しない例外」を含む(dispatch()のsmoke分岐から想定外にthrowするケース。本件レビューの発端そのもの)", async () => {
    const deps: DispatchDeps = {
      runAsarLayoutCheck: () => {
        throw new Error("このテストでは未使用のはず");
      },
      runSmoke: () => {
        throw new Error("想定外の実I/O例外(mkdtemp失敗等を模擬)");
      },
    };

    const outcome = await runMain(["smoke"], deps);

    expect(outcome.exitCode).toBe(1);
    const logText = outcome.logs.join("\n");
    expect(logText).toContain("::error::");
    expect(logText).toContain("予期しない例外");
    expect(logText).toContain("想定外の実I/O例外");
  });

  it("非Errorオブジェクトのthrow(文字列throw)でも exit 1 になる(release-gate.test.ts の runMain テストと同等の粒度)", async () => {
    const deps: DispatchDeps = {
      runAsarLayoutCheck: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "文字列 throw(非 Error オブジェクト)";
      },
      runSmoke: () => {
        throw new Error("このテストでは未使用のはず");
      },
    };

    const outcome = await runMain(["asar-layout"], deps);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.logs.join("\n")).toContain("::error::");
  });
});

// ---------------------------------------------------------------------------
// 実プロセス起動: 壊れたフィクスチャに対してasar-layoutサブコマンドが実際にblockすること
// (「報告してほしいもの」2: 壊したフィクスチャで各blockケースが実際にfailするログ)
// ---------------------------------------------------------------------------

describe("実プロセス起動: asar-layoutサブコマンドが実際にblockする(一時ディレクトリに隔離。実リポジトリのファイルには一切触れない)", () => {
  // boss メタレビュー【提案】対応: 旧版は作業ツリーの実
  // packages/app/release/win-unpacked/resources/app.asar を rename退避→書き換え→復元していた。
  // finallyで復元する設計だったが、プロセスが強制終了されると壊れたapp.asarと
  // .artifact-gate-test-backup が残置されるリスクがあった。
  // scripts/artifact-gate.ts の ARTIFACT_GATE_RELEASE_DIR_OVERRIDE 環境変数で、実プロセスの
  // release ディレクトリ解決先を完全に隔離された一時ディレクトリへリダイレクトすることで、
  // 実リポジトリのファイルに一切触れずに実プロセス経路(tsx起動→CLI→judgeAsarLayoutCommand→
  // 実ファイル読み込み)を検証できるようにした。副作用ゼロなので finally での復元も不要になる
  // (rmSyncで一時ディレクトリごと消すだけでよい)。

  function runAsarLayoutSubcommand(releaseDir: string): { status: number | null; combined: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT_ABS_PATH, "asar-layout"],
      {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: { ...process.env, ARTIFACT_GATE_RELEASE_DIR_OVERRIDE: releaseDir },
      },
    );
    return {
      status: result.status,
      combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }

  it("app.asarが16バイト未満に壊れていると、asar-layoutサブコマンドは終了コード1・::error::付きで実際に失敗する", () => {
    const releaseDir = mkdtempSync(path.join(tmpdir(), "keiba-artifact-gate-e2e-corrupt-"));
    try {
      const resourcesDir = path.join(releaseDir, "win-unpacked", "resources");
      mkdirSync(resourcesDir, { recursive: true });
      // 明らかに壊れているバイト列(16バイト未満)を書く。
      writeFileSync(path.join(resourcesDir, "app.asar"), Buffer.from([1, 2, 3]));

      const { status, combined } = runAsarLayoutSubcommand(releaseDir);

      expect(status).toBe(1);
      expect(combined).toContain("::error::");
      // 【提案・対応任意】ARTIFACT_GATE_RELEASE_DIR_OVERRIDEの解決結果がログに残ること
      // (誤設定・混入への気づきやすさのため)。ログ行の正確な形式を固定する(単なる
      // releaseDir文字列の包含だと、この後の分岐のエラーメッセージ自体がたまたま
      // パスを含む場合に空振りする恐れがあるため、ログ行のプレフィックスごと固定する)。
      expect(combined).toContain(`release ディレクトリの解決先: ${releaseDir}`);
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it("app.asar自体が存在しない場合も、asar-layoutサブコマンドは終了コード1・::error::付きで実際に失敗する(boss メタレビュー 要修正2: judgeAsarLayoutCommandのfail-closed分岐〈app.asarを読み込めません〉が実プロセス経路でも通ることの固定。壊れたファイルを置く旧テストは読み込み自体は成功するため、この分岐を一度も通していなかった)", () => {
    const releaseDir = mkdtempSync(path.join(tmpdir(), "keiba-artifact-gate-e2e-missing-"));
    try {
      // win-unpacked/resources ディレクトリすら作らない(app.asarが存在しない状態そのもの)。
      const { status, combined } = runAsarLayoutSubcommand(releaseDir);

      expect(status).toBe(1);
      expect(combined).toContain("::error::");
      expect(combined).toContain("app.asar を読み込めません");
      // 注意: readFileSyncのENOENTメッセージ自体にAPP_ASAR_PATH(releaseDir配下)が含まれるため、
      // 単なるtoContain(releaseDir)は専用ログ行が無くても偶然成立してしまう(実際に確認済み:
      // ログ行を削除する回帰実験でこのit()だけ緑のまま素通りした)。ログ行の正確な形式
      // (プレフィックス込み)で固定し直す。
      expect(combined).toContain(`release ディレクトリの解決先: ${releaseDir}`);
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 実プロセス起動: smokeサブコマンド(CIが実際に呼ぶ本命の検査)がdispatch経路そのもので
// 実際にblockすること(code-reviewer再レビュー指摘対応)
// ---------------------------------------------------------------------------

describe('実プロセス起動: smokeサブコマンドが実際にblockする(dispatch(["smoke"]) → runSmokeCheck(SMOKE_REAL_DEPS)という、CIが実際に呼び出す配線そのものを固定する)', () => {
  // code-reviewer再レビュー指摘対応: SMOKE_REAL_DEPSをテストファイルでgrepすると0件で、
  // dispatch()の"smoke"分岐を丸ごと{status:"allow"}に固定する変異が
  // pnpm test(core 2047 / app 1333 / scripts 108)全緑のまま素通りした。
  // 一方dispatch()の"asar-layout"分岐を同じ手法で固定すると、上の「実プロセス起動」describeが
  // 正しく2件検出した(対照実験で確認済み)。つまりasar-layoutは保護されていてsmokeだけが
  // 無防備という非対称があった。runSmokeCheckやjudgeSmokeOutcomeの単体テストがどれだけ手厚くても、
  // それらをCIが実際に呼び出す配線(dispatch(["smoke"]) → SMOKE_REAL_DEPS → resultToExitCode →
  // formatLogLine)自体が無固定では、この1行が壊れてもCI上「ヘッドレススモークテスト」ステップは
  // 常に成功したままになり、#60が再発する経路をそのまま見逃す。
  //
  // SMOKE_REAL_DEPSは本番実I/O(makeSmokeRealDeps() = 既定でCIと同じ実resolveVerifiedNativeBindingPath
  // 等)に固定されているため差し替えできない。asar-layout側と同じくARTIFACT_GATE_RELEASE_DIR_OVERRIDEで
  // release ディレクトリの解決先だけを隔離された一時ディレクトリへリダイレクトし、
  // win-unpackedが存在しない(.exeが0個の)状態を作ることで、実プロセス経由でblockを固定する
  // (実リポジトリのファイルには一切触れない。asar-layout側と同じ設計)。

  function runSmokeSubcommand(releaseDir: string): { status: number | null; combined: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT_ABS_PATH, "smoke"],
      {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: { ...process.env, ARTIFACT_GATE_RELEASE_DIR_OVERRIDE: releaseDir },
      },
    );
    return {
      status: result.status,
      combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }

  it("win-unpackedディレクトリが存在しない(.exeが0個の)状態では、smokeサブコマンドは終了コード1・::error::付きで実際に失敗し、asar-layoutとは異なるメッセージ(.exe が見つかりません)を返す", () => {
    const releaseDir = mkdtempSync(path.join(tmpdir(), "keiba-artifact-gate-e2e-smoke-missing-"));
    try {
      // win-unpackedディレクトリすら作らない(.exeが0個の状態そのもの)。

      const { status, combined } = runSmokeSubcommand(releaseDir);

      expect(status).toBe(1);
      expect(combined).toContain("::error::");
      expect(combined).toContain(".exe が見つかりません");
      // 【提案・対応任意】ARTIFACT_GATE_RELEASE_DIR_OVERRIDEの解決結果がログに残ること。
      // 注意: 「.exe が見つかりません」メッセージ自体がwinUnpackedDir(releaseDir配下)を
      // 含むため、単なるtoContain(releaseDir)は専用ログ行が無くても偶然成立してしまう
      // (実際に確認済み)。ログ行の正確な形式で固定し直す。
      expect(combined).toContain(`release ディレクトリの解決先: ${releaseDir}`);
      // dispatch()のsubcommand分岐が実際に機能していること(smoke分岐がasar-layoutの処理へ
      // 誤って合流していないこと)を、asar-layout側の固有メッセージが現れないことで固定する。
      expect(combined).not.toContain("app.asar を読み込めません");
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });
});
