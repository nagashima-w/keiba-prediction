import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../../src/ev/analysis-store.js";
import { generateMigrationLines } from "../../src/ev/cloud-migration-lines.js";
import { createCloudMigrationSource } from "../../src/ev/cloud-migration-reader.js";
import { populateMigrationFixture } from "./cloud-migration-fixture.js";

/**
 * Issue #216(#167-B1): クラウド版(cloud/)の取り込みのテストが読む、**exe の書き出しの実物**(非圧縮の NDJSON)。
 * cloud/ のテストは better-sqlite3 を持たないので、exe 側(ここ)で実際の保存 API → 書き出しの経路から作ったファイルをコミットしておき、
 * cloud 側はそれを読む。書き出しの形(列・並び・値)が変わると、このテストが赤くなる(古いファイルのまま cloud のテストが通り続けない)。
 * 更新: `UPDATE_GOLDEN=1 pnpm --filter @keiba/core exec vitest run test/ev/cloud-migration-golden.test.ts`
 */
const GOLDEN_PATH = fileURLToPath(new URL("../fixtures/cloud-migration-small.ndjson", import.meta.url));

function exportText(): string {
  const store = new AnalysisStore();
  try {
    populateMigrationFixture(store);
    const lines: string[] = [];
    for (const l of generateMigrationLines(createCloudMigrationSource(store.rawDatabase), { exportedAt: "2026-10-09T00:00:00.000Z", appVersion: "1.27.0" })) {
      lines.push(l);
    }
    return `${lines.join("\n")}\n`;
  } finally {
    store.close();
  }
}

describe("cloud-migration-small.ndjson(cloud/ のテストが読む書き出しの実物)", () => {
  it("今の書き出しの経路が作るものと、コミット済みのファイルが一致する", () => {
    const text = exportText();
    if (process.env["UPDATE_GOLDEN"] === "1") {
      writeFileSync(GOLDEN_PATH, text, "utf-8");
    }
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    // Windows のチェックアウトは改行を CRLF にすることがあるので、行末を LF にそろえて比べる(リポジトリ内のファイルを読むテストの流儀。Issue #18)。
    // 値の中の改行・CR は JSON でエスケープされるので、行末の正規化で情報は失われない。
    expect(readFileSync(GOLDEN_PATH, "utf-8").replace(/\r\n/g, "\n")).toBe(text);
  });

  it("前提(空振り防止): 分析5件・結果5レース・NULL の設定列を持つ旧分析・U+2028 を含む値が入っている", () => {
    const text = exportText();
    const lines = text.trimEnd().split("\n");
    expect(lines.filter((l) => l.startsWith('{"type":"analysis"'))).toHaveLength(5);
    expect(lines.filter((l) => l.startsWith('{"type":"result"'))).toHaveLength(5);
    expect(text).toContain('"include_quinella":null');
    expect(text).toContain(" ");
  });
});
