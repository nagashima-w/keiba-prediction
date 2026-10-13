import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * quinella-allocation-setting-ui-wiring.test.ts — Issue #286(#285 の段階A)。
 * `packages/core/test/analysis/quinella-allocation-setting-wiring.test.ts` を core へ移すとき、**exe の画面のソース**(`SettingsView.tsx`・`VerifyView.tsx`。packages/app/src/renderer)を走査する describe を、
 * exe 専用のテストとしてここへ分離した。core のテストから exe のソースを読まないため。**テストの本体・assert は元のまま(弱めていない)**。
 * 振る舞いの検査(混在配分の計算・配線)は、元のファイルが core 側に残っている。packages/app を削除する段階B(Issue #287)で、このファイルも削除する。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(currentDir, "../src/renderer");

describe("SettingsView.tsxがincludeQuinellaInAllocationを参照すること(Issue #117。#115時点は未参照だったが#117でチェックボックスを追加した)", () => {
  it("SettingsView.tsxのソースにincludeQuinellaInAllocationという識別子が出現すること(JSX直書きでレンダリングテスト基盤が無いためソース走査で確認する。combo-odds-scope-guard.test.tsと同じ流儀)", () => {
    const source = readFileSync(path.join(rendererDir, "SettingsView.tsx"), "utf8");
    // 前提固定: 既存2券種のチェックボックスは実在すること(空振り防止。ファイルを正しく読めていることの確認)。
    expect(source).toContain("includeWideInAllocation");
    expect(source).toContain("includeTrioInAllocation");
    expect(source).toContain("includeQuinellaInAllocation");
  });
});
