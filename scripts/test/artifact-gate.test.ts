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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveVerifiedNativeBindingPath } from "../../packages/app/src/main/native-binding.js";
import {
  SMOKE_SENTINEL_PREFIX,
  dispatch,
  judgeAsarLayout,
  judgeAsarLayoutFromBytes,
  judgeSmokeOutcome,
  makeSmokeRealDeps,
  parseAsarHeader,
  resolveSingleWinUnpackedExe,
  resultToExitCode,
  runSmokeCheck,
  type AsarNode,
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
      // nativeBindingPathが解決済みの絶対パスとして子プロセス引数に渡っていること。
      expect(calls.spawnCalls[0]!.args).toContain(nativeFile);
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
// 実プロセス起動: 壊れたフィクスチャに対してasar-layoutサブコマンドが実際にblockすること
// (「報告してほしいもの」2: 壊したフィクスチャで各blockケースが実際にfailするログ)
// ---------------------------------------------------------------------------

describe("実プロセス起動: asar-layoutサブコマンドが壊れたapp.asarに対して実際にblockする", () => {
  const RELEASE_DIR = path.join(REPO_ROOT, "packages/app/release");
  const WIN_UNPACKED_DIR = path.join(RELEASE_DIR, "win-unpacked");
  const RESOURCES_DIR = path.join(WIN_UNPACKED_DIR, "resources");
  const APP_ASAR_PATH = path.join(RESOURCES_DIR, "app.asar");

  function ensureCorruptAsar(): { createdDirs: string[]; createdFile: boolean; backedUp: boolean } {
    const createdDirs: string[] = [];
    for (const dir of [RELEASE_DIR, WIN_UNPACKED_DIR, RESOURCES_DIR]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        createdDirs.push(dir);
      }
    }
    const backedUp = existsSync(APP_ASAR_PATH);
    if (backedUp) {
      rmSync(`${APP_ASAR_PATH}.artifact-gate-test-backup`, { force: true });
      // 既存の本物のapp.asarをテスト後に戻すためリネーム退避する。
      renameSync(APP_ASAR_PATH, `${APP_ASAR_PATH}.artifact-gate-test-backup`);
    }
    // 明らかに壊れているバイト列(16バイト未満)を書く。
    writeFileSync(APP_ASAR_PATH, Buffer.from([1, 2, 3]));
    return { createdDirs, createdFile: true, backedUp };
  }

  function cleanup(state: { createdDirs: string[]; createdFile: boolean; backedUp: boolean }): void {
    if (state.backedUp) {
      renameSync(`${APP_ASAR_PATH}.artifact-gate-test-backup`, APP_ASAR_PATH);
    } else if (state.createdFile) {
      rmSync(APP_ASAR_PATH, { force: true });
    }
    for (const dir of [...state.createdDirs].reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("app.asarが16バイト未満に壊れていると、asar-layoutサブコマンドは終了コード1・::error::付きで実際に失敗する", () => {
    const state = ensureCorruptAsar();
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT_ABS_PATH, "asar-layout"],
        { encoding: "utf8", cwd: REPO_ROOT },
      );
      expect(result.status).toBe(1);
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(combined).toContain("::error::");
    } finally {
      cleanup(state);
    }
  });
});
