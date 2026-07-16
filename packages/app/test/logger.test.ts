/**
 * main/logger.ts(electron-log への薄い配線層)のテスト。Task#35。
 *
 * 仕様上「electron-log への接続(transport設定)は薄い配線層に分離してテスト対象外にして良い」が、
 * electron・electron-log/main の両方をこのファイル内だけでモックすることで、
 * 「secretsProviderで登録した秘密値が実際にマスクされてelectron-logへ渡ること」
 * 「ロガー自体の失敗でアプリを壊さない(例外を外へ漏らさない)こと」を配線コード込みで確認する。
 * このモックはファイルスコープなので、他のテストファイル(ipc.tsを実体で読み込むもの)には影響しない。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { errorMock, warnMock, infoMock, ctx } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warnMock: vi.fn(),
  infoMock: vi.fn(),
  ctx: { userData: "/tmp/keiba-logger-test" },
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => ctx.userData,
  },
}));

vi.mock("electron-log/main", () => ({
  default: {
    error: errorMock,
    warn: warnMock,
    info: infoMock,
    transports: {
      file: {},
      console: {},
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  errorMock.mockReset();
  warnMock.mockReset();
  infoMock.mockReset();
});

describe("getLogDirectory(ログディレクトリの取得)", () => {
  it("app.getPath('userData') 配下の logs ディレクトリを返す", async () => {
    const { getLogDirectory } = await import("../src/main/logger.js");
    expect(getLogDirectory()).toBe("/tmp/keiba-logger-test/logs");
  });
});

describe("logError(エラーログの記録)", () => {
  it("整形済みの1行JSONをelectron-logのerror()へ渡す", async () => {
    const { logError } = await import("../src/main/logger.js");
    logError("result:import", new Error("取込に失敗しました"), {
      raceId: "202601010101",
    });
    // 内部は非同期(electron-logの遅延importを挟む)ため、マイクロタスクを消化してから検証する。
    await vi.waitFor(() => {
      expect(errorMock).toHaveBeenCalledTimes(1);
    });
    const line = errorMock.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line) as {
      level: string;
      operation: string;
      context: { raceId: string };
      error: { message: string };
    };
    expect(parsed.level).toBe("error");
    expect(parsed.operation).toBe("result:import");
    expect(parsed.context.raceId).toBe("202601010101");
    expect(parsed.error.message).toBe("取込に失敗しました");
  });

  it("setSecretsProviderで登録した秘密値がメッセージ・スタックからマスクされる", async () => {
    const { logError, setSecretsProvider } = await import("../src/main/logger.js");
    setSecretsProvider(() => ["sk-ant-abc123"]);
    const error = new Error("認証エラー: sk-ant-abc123 は無効です");
    logError("settings:save", error);

    await vi.waitFor(() => {
      expect(errorMock).toHaveBeenCalledTimes(1);
    });
    const line = errorMock.mock.calls[0]![0] as string;
    expect(line).not.toContain("sk-ant-abc123");
  });

  it("electron-log側が例外を投げても呼び出し元に例外を伝播させない(ロガー自体の失敗でアプリを壊さない)", async () => {
    errorMock.mockImplementation(() => {
      throw new Error("ディスクフル");
    });
    const { logError } = await import("../src/main/logger.js");
    expect(() => logError("result:import", new Error("失敗"))).not.toThrow();
    // 内部の非同期処理が unhandledRejection を出さずに完了することを待って確認する。
    await vi.waitFor(() => {
      expect(errorMock).toHaveBeenCalledTimes(1);
    });
  });

  it("循環参照を持つcontextを渡しても例外を投げず、electron-logへ到達する(code-reviewer指摘: 要修正1)", async () => {
    const { logError } = await import("../src/main/logger.js");
    const circular: Record<string, unknown> = { raceId: "202601010101" };
    circular.self = circular;
    expect(() =>
      logError("result:import", new Error("失敗"), circular as never),
    ).not.toThrow();
    await vi.waitFor(() => {
      expect(errorMock).toHaveBeenCalledTimes(1);
    });
    // electron-logへ渡った行が有効なJSONであること(formatLogEntry側の再帰マスキングで
    // 循環参照が安全に置き換えられ、write()側のtry/catchが不要になるケースの確認)。
    const line = errorMock.mock.calls[0]![0] as string;
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("formatLogEntry自体が例外を投げても(二重防御をすり抜けた場合)呼び出し元に例外を伝播させず、console.errorへ最低限の情報を出す(code-reviewer指摘: 要修正1)", async () => {
    vi.doMock("../src/shared/log-formatter.js", () => ({
      formatLogEntry: (): string => {
        throw new Error("整形に失敗しました(想定される二重防御漏れのシミュレーション)");
      },
      extractErrorInfo: (error: unknown) => ({
        name: null,
        message: error instanceof Error ? error.message : String(error),
        stack: null,
      }),
    }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { logError } = await import("../src/main/logger.js");
      expect(() => logError("result:import", new Error("失敗"))).not.toThrow();
      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      });
      // formatLogEntry自体が失敗しているため line は組み立てられていないが、
      // 最低限 operation・message を含む文字列がconsole.errorへ渡ること。
      const fallback = String(consoleErrorSpy.mock.calls[0]![0]);
      expect(fallback).toContain("result:import");
      expect(errorMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/shared/log-formatter.js");
    }
  });
});

describe("logWarn / logInfo", () => {
  it("logWarnはelectron-logのwarn()へ整形済みの行を渡す", async () => {
    const { logWarn } = await import("../src/main/logger.js");
    logWarn("scrape:charset-fallback", "サポート外のcharsetを検出しました");
    await vi.waitFor(() => {
      expect(warnMock).toHaveBeenCalledTimes(1);
    });
    const parsed = JSON.parse(warnMock.mock.calls[0]![0] as string) as { level: string };
    expect(parsed.level).toBe("warn");
  });

  it("logInfoはelectron-logのinfo()へ整形済みの行を渡す", async () => {
    const { logInfo } = await import("../src/main/logger.js");
    logInfo("app:start", "起動しました");
    await vi.waitFor(() => {
      expect(infoMock).toHaveBeenCalledTimes(1);
    });
    const parsed = JSON.parse(infoMock.mock.calls[0]![0] as string) as { level: string };
    expect(parsed.level).toBe("info");
  });
});
