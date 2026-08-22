import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/channels.js";

/**
 * better-sqlite3 ネイティブバインディング解決(Issue #60-B)のテスト。
 *
 * 背景: 配布exeで `Error: Could not locate the bindings file` が発生した実機バグへの対応。
 * bindings パッケージのスタックトレース探索は packaged 実行で崩れうるため、packaged 時は
 * app.asar.unpacked 配下の絶対パスを明示的に組み立てて new Database() へ渡す(pipeline-deps.ts の
 * nativeBindingPath)。ここでは (1) パス解決の純粋関数、(2) 実在確認つき解決関数、
 * (3) resourceManager が実際に createPipelineDeps まで nativeBindingPath を届けることを検証する。
 *
 * electron はテスト環境で読み込めないためモックする(既存 ipc.test.ts / ipc-resource-lifecycle.test.ts
 * と同じ流儀)。isPackaged を可変にして両分岐を通す。
 */

// hoisted: electron / pipeline-deps のモックから参照する共有オブジェクト。
const { handleMock, createPipelineDepsMock, ctx } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createPipelineDepsMock: vi.fn(),
  ctx: { userData: "", isPackaged: false },
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0",
    getPath: () => ctx.userData,
    get isPackaged() {
      return ctx.isPackaged;
    },
  },
  ipcMain: { handle: handleMock },
}));

// 実IO(better-sqlite3・HTTP)を避け、資源をフェイクに差し替える。
vi.mock("../src/main/pipeline-deps.js", () => ({
  createPipelineDeps: createPipelineDepsMock,
}));

import {
  resolveNativeBindingPath,
  resolveVerifiedNativeBindingPath,
} from "../src/main/ipc.js";

describe("resolveNativeBindingPath(パス解決、Issue #60-B)", () => {
  it("非packagedならresourcesPathの値に関わらずundefinedを返す(従来どおりbindingsに解決を任せる)", () => {
    expect(
      resolveNativeBindingPath({ isPackaged: false, resourcesPath: "/some/resources" }),
    ).toBeUndefined();
    expect(
      resolveNativeBindingPath({ isPackaged: false, resourcesPath: undefined }),
    ).toBeUndefined();
  });

  it("packagedかつresourcesPath定義済みなら、app.asar.unpacked配下の絶対パスをpath.joinで組み立てて返す", () => {
    const resourcesPath = "/resources";
    const result = resolveNativeBindingPath({ isPackaged: true, resourcesPath });
    expect(result).toBe(
      path.join(
        resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node",
      ),
    );
  });

  it("packagedでもresourcesPathがundefinedなら壊れず(例外を投げず)undefinedを返す(Electron外・テスト環境の防御)", () => {
    expect(() =>
      resolveNativeBindingPath({ isPackaged: true, resourcesPath: undefined }),
    ).not.toThrow();
    expect(
      resolveNativeBindingPath({ isPackaged: true, resourcesPath: undefined }),
    ).toBeUndefined();
  });

  it("resourcesPathがWindows風の区切り(\\)を含む文字列でも、その文字列がそのまま先頭に保たれること(セグメントの非破壊)", () => {
    // 注意(code-reviewer指摘対応): このテストは実装の戻り値を「検証対象と同じ path.join 呼び出し」と
    // 比較する同語反復だったため、実質的に固定できていたのは「resourcesPathの文字列が先頭に保たれる」
    // ことだけだった(このテスト名・アサーションはその実態に合わせて縮小した)。「path.joinで組み立てられる
    // こと(手書き結合の禁止)」自体の固定は、直後の describe「resolveNativeBindingPathの絶対パス組み立てで
    // path.joinが実際に呼ばれていること」のspyテストが担う。
    // また、この環境(Linux)ではPOSIX版path.joinが走るため、実機Windowsのセパレータ処理
    // (`\`区切りでの組み立て)そのものはここでは検証できていない(実行環境依存の既知の限界)。
    const resourcesPath = "C:\\Users\\tester\\AppData\\Local\\Temp\\keiba-ev-tool\\resources";
    const result = resolveNativeBindingPath({ isPackaged: true, resourcesPath });
    expect(result).toBeDefined();
    expect(result!.startsWith(resourcesPath)).toBe(true);
  });
});

describe("resolveNativeBindingPathの絶対パス組み立てでpath.joinが実際に呼ばれていること(code-reviewer指摘対応: 手書き結合の禁止を直接固定)", () => {
  it("path.joinへ期待する引数列で呼ばれ、その戻り値がそのまま関数の戻り値になること(手書き結合〈resourcesPath + \"/\" + ...〉に置き換わっていたら、この呼び出し自体が発生しなくなり赤くなる)", () => {
    const resourcesPath = "C:\\Users\\tester\\AppData\\Local\\Temp\\keiba-ev-tool\\resources";
    const joinSpy = vi.spyOn(path, "join");
    try {
      const result = resolveNativeBindingPath({ isPackaged: true, resourcesPath });

      expect(joinSpy).toHaveBeenCalledWith(
        resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node",
      );
      const lastResult = joinSpy.mock.results[joinSpy.mock.results.length - 1];
      expect(lastResult).toBeDefined();
      expect(result).toBe(lastResult!.value);
    } finally {
      joinSpy.mockRestore();
    }
  });
});

describe("resolveVerifiedNativeBindingPath(実在検証つき解決、受け入れ条件3)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "keiba-native-binding-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("非packagedならundefinedを返し、存在チェックもしない(resourcesPathにファイルが無くても例外にならない)", () => {
    expect(
      resolveVerifiedNativeBindingPath({ isPackaged: false, resourcesPath: tempDir }),
    ).toBeUndefined();
  });

  it(".nodeが実在すればその絶対パスをそのまま返す", () => {
    const dir = path.join(
      tempDir,
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
    );
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "better_sqlite3.node");
    writeFileSync(file, "");

    const result = resolveVerifiedNativeBindingPath({ isPackaged: true, resourcesPath: tempDir });

    expect(result).toBe(file);
    expect(existsSync(result!)).toBe(true);
  });

  it(".nodeが存在しない場合、期待した絶対パス・fs.existsSyncの結果・process.resourcesPath・app.isPackagedの4要素をすべて含む日本語エラーを投げる(受け入れ条件3)", () => {
    let thrown: unknown;
    try {
      resolveVerifiedNativeBindingPath({ isPackaged: true, resourcesPath: tempDir });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    const expectedPath = path.join(
      tempDir,
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    // 期待した絶対パス
    expect(message).toContain(expectedPath);
    // fs.existsSyncの結果
    expect(message).toContain("fs.existsSync");
    expect(message).toContain("false");
    // process.resourcesPath
    expect(message).toContain(`process.resourcesPath: ${tempDir}`);
    // app.isPackaged
    expect(message).toContain("app.isPackaged: true");
  });
});

describe("resourceManager配線(packaged時にnativeBindingPathがcreatePipelineDepsまで届くこと、受け入れ条件1)", () => {
  let tempDir: string;
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    handleMock.mockReset();
    createPipelineDepsMock.mockReset();
    tempDir = mkdtempSync(path.join(tmpdir(), "keiba-ipc-native-"));
    ctx.userData = tempDir;
    ctx.isPackaged = false;
    originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    createPipelineDepsMock.mockImplementation(() => ({
      listRaces: vi.fn(async () => []),
      listNarRaces: vi.fn(async () => []),
      close: vi.fn(),
      deps: {},
    }));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    (process as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  /** 登録済みハンドラを取得する。 */
  function handlerFor(
    channel: string,
  ): (...args: unknown[]) => unknown {
    const call = handleMock.mock.calls.find((c) => c[0] === channel);
    if (call === undefined) {
      throw new Error(`ハンドラ未登録: ${channel}`);
    }
    return call[1] as (...args: unknown[]) => unknown;
  }

  it("非packagedならnativeBindingPath:undefinedでcreatePipelineDepsが呼ばれる(従来どおり)", async () => {
    ctx.isPackaged = false;
    (process as { resourcesPath?: string }).resourcesPath = "/should-not-be-used";

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.listRaces);
    await handler({ sender: { send: vi.fn() } }, "20260101", "central", false);

    expect(createPipelineDepsMock).toHaveBeenCalledTimes(1);
    expect(createPipelineDepsMock.mock.calls[0]![0]).toMatchObject({
      nativeBindingPath: undefined,
    });
  });

  it("packagedかつ.nodeが実在すれば、その絶対パスがnativeBindingPathとしてcreatePipelineDepsへ渡ること(受け入れ条件1)", async () => {
    const dir = path.join(
      tempDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
    );
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "better_sqlite3.node");
    writeFileSync(file, "");
    ctx.isPackaged = true;
    (process as { resourcesPath?: string }).resourcesPath = path.join(tempDir, "resources");

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.listRaces);
    await handler({ sender: { send: vi.fn() } }, "20260101", "central", false);

    expect(createPipelineDepsMock).toHaveBeenCalledTimes(1);
    expect(createPipelineDepsMock.mock.calls[0]![0]).toMatchObject({
      nativeBindingPath: file,
    });
  });

  it("packagedだが.nodeが存在しないと、リクエスト処理(handleListRaces)が診断メッセージ付きで失敗すること(受け入れ条件3: bindings既定の分かりにくいエラーで落ちる前に検知)", async () => {
    ctx.isPackaged = true;
    (process as { resourcesPath?: string }).resourcesPath = path.join(tempDir, "resources-missing");

    const { registerIpcHandlers } = await import("../src/main/ipc.js");
    registerIpcHandlers();
    const handler = handlerFor(IPC_CHANNELS.listRaces);

    await expect(
      handler({ sender: { send: vi.fn() } }, "20260101", "central", false),
    ).rejects.toThrow(/fs\.existsSync/);
    // Database生成まで到達していない(createPipelineDepsは呼ばれない)ことも確認する。
    expect(createPipelineDepsMock).not.toHaveBeenCalled();
  });
});
