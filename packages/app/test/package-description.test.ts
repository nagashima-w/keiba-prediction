/**
 * packages/app/package.json の description のテスト。
 *
 * この値は electron-builder が Windows exe の FileDescription(ファイルのプロパティに表示される
 * 説明文)として使う(app-builder-lib の winPackager.js: `appInfo.description || appInfo.productName`)。
 * つまり実質的にエンドユーザーの目に触れるため、内部の開発フェーズ表示のような実装都合の情報を
 * 含めるべきではなく、実態と食い違う記述(例: 完了済みのフェーズを指して開発中と読める表記)を
 * 放置してはならない。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

function readDescription(): string {
  const raw = readFileSync(packageJsonPath, "utf-8");
  const parsed = JSON.parse(raw) as { description?: string };
  return parsed.description ?? "";
}

describe("packages/app/package.json の description(exeのFileDescriptionに反映される)", () => {
  it("開発フェーズ番号を含まない(実装済みフェーズを指して開発中と誤読させないため)", () => {
    const description = readDescription();
    // 前提: description が空でないことを先に固定する(空文字だと以降の否定アサーションが自明に成立してしまうため)。
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toMatch(/Phase\s*\d/i);
  });

  it("アプリの説明として実態に即した文言である", () => {
    expect(readDescription()).toBe("競馬期待値分析ツールの Electron デスクトップアプリ");
  });
});
