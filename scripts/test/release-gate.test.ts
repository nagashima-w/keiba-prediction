/**
 * dev-latest 公開ゲートの機械検査(scripts/release-gate.ts)のテスト(Issue #45)。
 *
 * 判定核(純関数)・実ネットワーク層(fetch のエラー種別分類)・CLI 配線(dispatch の
 * ふるまい)・実プロセス起動(AC8)の4層で検証する。
 *
 * 【boss 追加条件(1)への対応】: resultToExitCode の定義が1箇所であることの静的固定は
 * 補助にすぎない(片方のハンドラが `return 1` をインライン化しても定義自体は1箇所のまま
 * 緑になるため)。主たる担保は「純函数レイヤ末尾: dispatch() のふるまいテスト」で、
 * 要求された5セル(version-bump-check の block/allow/skip、tag-version の
 * block(不一致)/block(不正)/allow)を **実際に返る終了コード整数**で個別に固定する。
 *
 * 【boss 追加条件(2)への対応】: HTTP 404・403/5xx・ネットワーク例外(タイムアウト含む)を
 * 警告文で区別することを固定する。実ネットワーク層(fetchDevLatestAssetNamesReal)は
 * global fetch を stub して検証し、実ネットワークへは一切出ない。
 *
 * 【boss 追加条件(3)への対応】: AC8 の実プロセス起動テストは process.execPath
 * (絶対パスの node)で起動し、PATH 上の pnpm/npx/tsx シムを使わない。
 * skipIf 等の条件付き無効化は付けない。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  AssetFetchError,
  type DispatchOutcome,
  type GateResult,
  type RealDeps,
  dispatch,
  fetchDevLatestAssetNamesReal,
  judgeTagVersion,
  judgeVersionBump,
  resolveSingleExeName,
  resultToExitCode,
} from "../release-gate.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(currentDir, "../..");
const SCRIPT_ABS_PATH = path.join(REPO_ROOT, "scripts/release-gate.ts");
const APP_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "packages/app/package.json");

/** テスト用の RealDeps を組み立てるヘルパ(未指定のフィールドは失敗させて誤用を防ぐ)。 */
function makeDeps(overrides: Partial<RealDeps>): RealDeps {
  return {
    listExeFileNames: () => {
      throw new Error("listExeFileNames は本テストでは未使用のはずです");
    },
    fetchAssetNames: () => {
      throw new Error("fetchAssetNames は本テストでは未使用のはずです");
    },
    readAppVersion: () => {
      throw new Error("readAppVersion は本テストでは未使用のはずです");
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 純関数: resultToExitCode(判定ロジックと独立に、写像だけを固定する)
// ---------------------------------------------------------------------------

describe("純関数: resultToExitCode(終了コードの写像)", () => {
  it("block は 1", () => {
    const result: GateResult = { status: "block", message: "x" };
    expect(resultToExitCode(result)).toBe(1);
  });

  it("allow は 0", () => {
    const result: GateResult = { status: "allow" };
    expect(resultToExitCode(result)).toBe(0);
  });

  it("skip は 0", () => {
    const result: GateResult = { status: "skip", message: "x" };
    expect(resultToExitCode(result)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 純関数: resolveSingleExeName(exe 名の解決)
// ---------------------------------------------------------------------------

describe("純関数: resolveSingleExeName(exe 名の解決)", () => {
  it("0個は skip(警告に0個である旨を含む)", () => {
    const resolution = resolveSingleExeName([]);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("到達しないはず");
    expect(resolution.result.status).toBe("skip");
    expect(resolution.result.message).toContain("0個");
  });

  it("2個以上は skip(警告に個数を含む)", () => {
    const resolution = resolveSingleExeName([
      "keiba-ev-tool-1.2.1-portable.exe",
      "keiba-ev-tool-1.2.1-x64.exe",
    ]);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("到達しないはず");
    expect(resolution.result.status).toBe("skip");
    expect(resolution.result.message).toContain("2個");
  });

  it("1個は basename を返す", () => {
    const resolution = resolveSingleExeName(["keiba-ev-tool-1.2.1-portable.exe"]);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("到達しないはず");
    expect(resolution.name).toBe("keiba-ev-tool-1.2.1-portable.exe");
  });
});

// ---------------------------------------------------------------------------
// 純関数: judgeVersionBump(版数据え置き判定)
// ---------------------------------------------------------------------------

describe("純関数: judgeVersionBump(版数据え置き判定)", () => {
  const CURRENT = "keiba-ev-tool-1.2.1-portable.exe";

  it("完全一致の名前が既存アセットにあれば block", async () => {
    const result = await judgeVersionBump({
      listExeFileNames: () => [CURRENT],
      fetchAssetNames: async () => [CURRENT],
    });
    expect(result.status).toBe("block");
  });

  it("既存アセットが空なら allow", async () => {
    const result = await judgeVersionBump({
      listExeFileNames: () => [CURRENT],
      fetchAssetNames: async () => [],
    });
    expect(result.status).toBe("allow");
  });

  it("旧版名のみなら allow(版数が上がっている正常系)", async () => {
    const result = await judgeVersionBump({
      listExeFileNames: () => [CURRENT],
      fetchAssetNames: async () => ["keiba-ev-tool-1.2.0-portable.exe"],
    });
    expect(result.status).toBe("allow");
  });

  it("大文字小文字違いは block(fail-closed 側に倒す)", async () => {
    const result = await judgeVersionBump({
      listExeFileNames: () => [CURRENT],
      fetchAssetNames: async () => ["KEIBA-EV-TOOL-1.2.1-PORTABLE.EXE"],
    });
    expect(result.status).toBe("block");
  });

  it("部分一致(.exe.bak 等)は allow(素朴な includes 実装を殺す)", async () => {
    const result = await judgeVersionBump({
      listExeFileNames: () => [CURRENT],
      fetchAssetNames: async () => [`${CURRENT}.bak`, `old-${CURRENT}`],
    });
    expect(result.status).toBe("allow");
  });

  it("exe 個数異常(0個)は skip として judgeVersionBump からそのまま伝播する", async () => {
    const result = await judgeVersionBump({
      listExeFileNames: () => [],
      fetchAssetNames: async () => {
        throw new Error("到達しないはず(exe解決の時点でskipするため呼ばれない)");
      },
    });
    expect(result.status).toBe("skip");
  });

  describe("取得失敗の種別ごとの区別(boss 追加条件2)", () => {
    it("404(dev-latest 未作成)は allow + 警告に『存在しません』を含む", async () => {
      const result = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("not_found");
        },
      });
      expect(result.status).toBe("allow");
      expect(result.message).toContain("404");
      expect(result.message).toContain("存在しません");
    });

    it("403(トークン権限退行)は allow + 警告にステータスコード403を含む", async () => {
      const result = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("http_error", { status: 403 });
        },
      });
      expect(result.status).toBe("allow");
      expect(result.message).toContain("403");
    });

    it("500(サーバ障害)は allow + 警告にステータスコード500を含む(404/403とは別文言)", async () => {
      const result = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("http_error", { status: 500 });
        },
      });
      expect(result.status).toBe("allow");
      expect(result.message).toContain("500");
    });

    it("ネットワーク例外(タイムアウト含む)は allow + 警告にネットワークエラーである旨を含む", async () => {
      const result = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("network_error", {
            cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          });
        },
      });
      expect(result.status).toBe("allow");
      expect(result.message).toContain("ネットワークエラー");
      expect(result.message).toContain("TimeoutError");
    });

    it("AssetFetchError 以外の例外(想定外)も allow + warning に落ちる(注入した関数が生 throw するケース)", async () => {
      const result = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new Error("想定外の失敗");
        },
      });
      expect(result.status).toBe("allow");
      expect(result.message).toContain("想定外の失敗");
    });

    it("403 と 404 と 500 のメッセージが互いに異なる(取り違え検出)", async () => {
      const notFound = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("not_found");
        },
      });
      const forbidden = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("http_error", { status: 403 });
        },
      });
      const serverError = await judgeVersionBump({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("http_error", { status: 500 });
        },
      });
      expect(notFound.message).not.toBe(forbidden.message);
      expect(forbidden.message).not.toBe(serverError.message);
      expect(notFound.message).not.toBe(serverError.message);
    });
  });

  it("block メッセージが「版数を上げる」「docs/versioning.md」「workflow_dispatch で再送できる」に触れている", async () => {
    const result = await judgeVersionBump({
      listExeFileNames: () => [CURRENT],
      fetchAssetNames: async () => [CURRENT],
    });
    expect(result.status).toBe("block");
    expect(result.message).toContain("版数を上げる");
    expect(result.message).toContain("docs/versioning.md");
    expect(result.message).toContain("workflow_dispatch で再送できる");
  });
});

// ---------------------------------------------------------------------------
// 純関数: judgeTagVersion(タグとバージョンの一致判定)
// ---------------------------------------------------------------------------

describe("純関数: judgeTagVersion(タグ一致判定)", () => {
  it.each([
    ["v1.2.1", "1.2.1", "allow"],
    ["v1.2.0", "1.2.1", "block"],
    ["v1.2.10", "1.2.1", "block"],
    ["1.2.1", "1.2.1", "block"],
    ["v1.2.1-rc1", "1.2.1", "block"],
  ] as const)("refName=%s, version=%s → %s", (refName, version, expected) => {
    const result = judgeTagVersion({ readAppVersion: () => version }, refName);
    expect(result.status).toBe(expected);
  });

  it("version が X.Y.Z 形式でなければ block(fail-closed)", () => {
    const result = judgeTagVersion({ readAppVersion: () => "1.2" }, "v1.2");
    expect(result.status).toBe("block");
  });

  it("readAppVersion が例外を投げれば block(fail-closed)", () => {
    const result = judgeTagVersion(
      {
        readAppVersion: () => {
          throw new Error("読み取り失敗");
        },
      },
      "v1.2.1",
    );
    expect(result.status).toBe("block");
  });

  it("『不一致』と『読めない/不正』でメッセージ文言を分ける(boss 追加条件4)", () => {
    const mismatch = judgeTagVersion({ readAppVersion: () => "1.2.1" }, "v1.2.0");
    const unreadable = judgeTagVersion(
      {
        readAppVersion: () => {
          throw new Error("ENOENT");
        },
      },
      "v1.2.1",
    );
    const invalidFormat = judgeTagVersion({ readAppVersion: () => "1.2" }, "v1.2");

    // 前提固定: すべて block であること(この後の文言比較が block 同士でないと無意味なため)。
    expect(mismatch.status).toBe("block");
    expect(unreadable.status).toBe("block");
    expect(invalidFormat.status).toBe("block");

    expect(mismatch.message).toContain("一致しません");
    expect(mismatch.message).not.toContain("読み取れない");

    expect(unreadable.message).toContain("読み取れない");
    expect(unreadable.message).not.toContain("一致しません");

    expect(invalidFormat.message).toContain("X.Y.Z 形式ではありません");
    expect(invalidFormat.message).not.toContain("一致しません");
  });
});

// ---------------------------------------------------------------------------
// 実ネットワーク層: fetchDevLatestAssetNamesReal(global fetch を stub。実通信なし)
// ---------------------------------------------------------------------------

describe("実装: fetchDevLatestAssetNamesReal(fetch のエラー種別分類とタイムアウト配線)", () => {
  it("200 なら assets[].name の配列を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ assets: [{ name: "a.exe" }, { name: "b.exe" }] }),
      })),
    );
    try {
      const names = await fetchDevLatestAssetNamesReal({
        owner: "o",
        repo: "r",
        token: "t",
      });
      expect(names).toEqual(["a.exe", "b.exe"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("呼び出しに AbortSignal.timeout 由来の signal が渡っている(タイムアウト配線の固定)", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return { ok: true, status: 200, json: async () => ({ assets: [] }) };
      }),
    );
    try {
      await fetchDevLatestAssetNamesReal({ owner: "o", repo: "r", token: "t" });
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("404 は AssetFetchError(kind=not_found)を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    try {
      await expect(
        fetchDevLatestAssetNamesReal({ owner: "o", repo: "r", token: "t" }),
      ).rejects.toMatchObject({ kind: "not_found" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("403 は AssetFetchError(kind=http_error, status=403)を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );
    try {
      await expect(
        fetchDevLatestAssetNamesReal({ owner: "o", repo: "r", token: "t" }),
      ).rejects.toMatchObject({ kind: "http_error", status: 403 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("500 は AssetFetchError(kind=http_error, status=500)を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    try {
      await expect(
        fetchDevLatestAssetNamesReal({ owner: "o", repo: "r", token: "t" }),
      ).rejects.toMatchObject({ kind: "http_error", status: 500 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetch() 自体が reject する(タイムアウト等)場合は AssetFetchError(kind=network_error)を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    try {
      await expect(
        fetchDevLatestAssetNamesReal({ owner: "o", repo: "r", token: "t" }),
      ).rejects.toMatchObject({ kind: "network_error" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI 配線: dispatch(boss 追加条件1の主担保。5セル全てをふるまいで固定する)
// ---------------------------------------------------------------------------

describe("配線: dispatch(終了コードをふるまいで固定する。5セル全て)", () => {
  const CURRENT = "keiba-ev-tool-1.2.1-portable.exe";

  it("[表1] version-bump-check: 同名アセットあり → exit 1", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["version-bump-check"],
      makeDeps({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => [CURRENT],
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.logs.join("\n")).toContain("::error::");
  });

  it("[表2] version-bump-check: 競合なし → exit 0", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["version-bump-check"],
      makeDeps({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => [],
      }),
    );
    expect(outcome.exitCode).toBe(0);
  });

  it("[表3] version-bump-check: 取得失敗(skip+warning)→ exit 0", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["version-bump-check"],
      makeDeps({
        listExeFileNames: () => [],
        fetchAssetNames: async () => {
          throw new Error("到達しないはず");
        },
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.logs.join("\n")).toContain("::warning::");
  });

  it("[表3の別ケース] version-bump-check: exe 個数異常(2個)→ exit 0(skip+warning)", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["version-bump-check"],
      makeDeps({
        listExeFileNames: () => [CURRENT, "other.exe"],
        fetchAssetNames: async () => {
          throw new Error("到達しないはず");
        },
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.logs.join("\n")).toContain("::warning::");
  });

  it("[表3の別ケース] version-bump-check: アセット取得が例外 → exit 0(allow+warning)", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["version-bump-check"],
      makeDeps({
        listExeFileNames: () => [CURRENT],
        fetchAssetNames: async () => {
          throw new AssetFetchError("http_error", { status: 500 });
        },
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.logs.join("\n")).toContain("::warning::");
  });

  it("[表4] tag-version: 不一致 → exit 1", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["tag-version", "v1.2.0"],
      makeDeps({ readAppVersion: () => "1.2.1" }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.logs.join("\n")).toContain("::error::");
  });

  it("[表4の別ケース] tag-version: package.json 読み取り失敗 → exit 1", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["tag-version", "v1.2.1"],
      makeDeps({
        readAppVersion: () => {
          throw new Error("読み取り失敗");
        },
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.logs.join("\n")).toContain("::error::");
  });

  it("[表5] tag-version: 一致 → exit 0", async () => {
    const outcome: DispatchOutcome = await dispatch(
      ["tag-version", "v1.2.1"],
      makeDeps({ readAppVersion: () => "1.2.1" }),
    );
    expect(outcome.exitCode).toBe(0);
  });

  it("未知のサブコマンドは block(exit 1)", async () => {
    const outcome: DispatchOutcome = await dispatch(["nonsense"], makeDeps({}));
    expect(outcome.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 実プロセス起動(AC8)。boss 追加条件3: process.execPath で起動し、skipIf を付けない。
// ---------------------------------------------------------------------------

describe("実プロセス起動(AC8): tag-version をネットワーク不要で実行する", () => {
  // 本テストは実リポジトリの packages/app/package.json の version に依存する。
  // 本タスクで 1.2.1 に上げること自体が前提のため、先に前提を無条件 expect で固定する
  // (据え置きのまま実行され「たまたま一致」で緑になる空振りを避ける)。
  const appPkg = JSON.parse(readFileSync(APP_PACKAGE_JSON_PATH, "utf8")) as {
    version: string;
  };

  it("前提: packages/app/package.json の version が 1.2.1 である", () => {
    expect(appPkg.version).toBe("1.2.1");
  });

  it("バージョン不一致(v1.2.0)で終了コード1、出力に ::error:: を含む", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT_ABS_PATH, "tag-version", "v1.2.0"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(combined).toContain("::error::");
  });

  it("バージョン一致(v1.2.1)で終了コード0", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT_ABS_PATH, "tag-version", "v1.2.1"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });
});
