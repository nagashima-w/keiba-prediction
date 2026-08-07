import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * @keiba/core の新規サブパスエクスポート `./ev/combo-bet-allocation`(機能D-2c第1段・Issue #28)を
 * renderer(ブラウザ向けesbuildバンドル)から import しても native/node 依存を引き込まないことを
 * 機械的に確認する(CLAUDE.md 鉄則9: 「テスト全緑」だけでは renderer バンドルの破綻を検出できない
 * 過去実績〈node:zlib混入〉への対応)。
 *
 * boss着手前ゲートで依存グラフを実測済み(combo-bet-allocation.tsの依存はcombo-odds-key.ts=import
 * ゼロ・place-joint-model.ts=importゼロ・expected-value.ts/allocation-primitives.ts=type-only)だが、
 * その実測結果を毎回機械的に再確認できるよう回帰テストとして固定する。
 *
 * renderer配下(packages/app/src/renderer/**)は本段のスコープ外のため一切変更していない
 * (合成エントリは test/fixtures/ に置く。bundle.test.ts が main.ts を実際にesbuildで束ねて
 * external維持を確認するのと対になる、renderer側の「native混入なし」確認)。
 */
describe("@keiba/core のサブパス ./ev/combo-bet-allocation(renderer向けバンドル安全性)", () => {
  it("platform:browserでバンドルしても native/node 依存を含まないこと", async () => {
    const entryPath = path.join(
      currentDir,
      "fixtures/combo-bet-allocation-export-entry.ts",
    );

    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
    });

    const output = result.outputFiles.map((f) => f.text).join("\n");
    // native依存(main用bundle.test.tsが external 維持を確認しているのと同じ懸念)が
    // インライン化・requireのいずれの形でも紛れ込んでいないこと。
    expect(output).not.toMatch(/better-sqlite3/);
    expect(output).not.toMatch(/node:/);
    expect(output).not.toMatch(/["']cheerio["']/);
    expect(output).not.toMatch(/["']undici["']/);
    expect(output).not.toMatch(/["']iconv-lite["']/);
    expect(output).not.toMatch(/@anthropic-ai\/sdk/);
    // 空振り防止: 期待した関数が実際にバンドル出力へ現れていること(束ね自体が空振りでない)。
    expect(output).toContain("allocateGeneralBets");
  });
});
