/**
 * クラウド移行ファイルの書き込み(main。Issue #215・#167-A AC3)。
 * gzip とファイル書き込みは main だけが持つ。一時ファイルに書いて成功したら rename し、失敗したら
 * 一時ファイルを消して、選んだパスに途中のファイルを残さない。実ファイルシステム(テンポラリ)で検証する。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MigrationFooterLine } from "@keiba/core";

import {
  buildDefaultCloudMigrationFileName,
  writeCloudMigrationFile,
} from "../src/main/cloud-migration-export.js";

const FOOTER: MigrationFooterLine = {
  type: "footer",
  counts: {
    analyses: 0, analysis_horses: 0, analysis_bets: 0, analysis_allocation_meta: 0,
    race_results: 0, race_result_meta: 0, race_combo_payouts: 0, race_combo_payout_imports: 0,
  },
  analysisLines: 7,
  resultLines: 3,
};

function* linesThen(lines: string[], end: "footer" | Error): Generator<string, MigrationFooterLine> {
  for (const l of lines) yield l;
  if (end instanceof Error) throw end;
  return FOOTER;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keiba-cloud-migration-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("既定のファイル名", () => {
  it.each([
    ["2026-10-09", new Date(2026, 9, 9, 12, 0, 0), "keiba-cloud-migration-20261009.ndjson.gz"],
    ["2026-01-05(月日をゼロ埋め)", new Date(2026, 0, 5, 0, 0, 0), "keiba-cloud-migration-20260105.ndjson.gz"],
    ["2027-12-31 23:59:59(ローカル日付)", new Date(2027, 11, 31, 23, 59, 59), "keiba-cloud-migration-20271231.ndjson.gz"],
  ])("%s → 既定名が YYYYMMDD 付きになる", (_label, date, expected) => {
    expect(buildDefaultCloudMigrationFileName(date)).toBe(expected);
  });
});

describe("成功", () => {
  it("行を改行で区切って gzip で書き、フッタとファイルの大きさを返す", async () => {
    const target = path.join(dir, "out.ndjson.gz");
    const result = await writeCloudMigrationFile(target, linesThen(['{"a":"日本語"}', '{"b":2}'], "footer"));
    expect(result.footer).toEqual(FOOTER);
    expect(statSync(target).size).toBe(result.fileBytes);
    expect(result.fileBytes).toBeGreaterThan(0);
    const raw = readFileSync(target);
    expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]); // 実際に gzip になっている
    expect(gunzipSync(raw).toString("utf-8")).toBe('{"a":"日本語"}\n{"b":2}\n');
  });

  it("成功後に一時ファイルが残らない(ディレクトリには出力だけ)", async () => {
    const target = path.join(dir, "out.ndjson.gz");
    await writeCloudMigrationFile(target, linesThen(["x"], "footer"));
    expect(readdirSync(dir)).toEqual(["out.ndjson.gz"]);
  });

  it("既存のファイルがあれば置き換える", async () => {
    const target = path.join(dir, "out.ndjson.gz");
    writeFileSync(target, "古い内容");
    await writeCloudMigrationFile(target, linesThen(["new"], "footer"));
    expect(gunzipSync(readFileSync(target)).toString("utf-8")).toBe("new\n");
  });

  it("大量の行(約 6 万行・十数 MB)も流して書ける", async () => {
    const target = path.join(dir, "big.ndjson.gz");
    const line = JSON.stringify({ x: "あ".repeat(200) });
    function* many(): Generator<string, MigrationFooterLine> {
      for (let i = 0; i < 60_000; i++) yield line;
      return FOOTER;
    }
    const result = await writeCloudMigrationFile(target, many());
    const text = gunzipSync(readFileSync(target)).toString("utf-8");
    expect(text.length).toBe(60_000 * (line.length + 1));
    expect(result.fileBytes).toBe(statSync(target).size);
  }, 60_000);
});

describe("失敗(選んだパスに途中のファイルを残さない)", () => {
  it("行の生成が途中で throw したら、同じエラーで reject し、出力も一時ファイルも残らない", async () => {
    const target = path.join(dir, "out.ndjson.gz");
    await expect(
      writeCloudMigrationFile(target, linesThen(["a", "b"], new Error("検証に失敗しました"))),
    ).rejects.toThrow("検証に失敗しました");
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("既存のファイルがあるパスでも、失敗したら既存の内容がそのまま残る", async () => {
    const target = path.join(dir, "out.ndjson.gz");
    writeFileSync(target, "前回の書き出し");
    await expect(writeCloudMigrationFile(target, linesThen(["a"], new Error("boom")))).rejects.toThrow("boom");
    expect(readFileSync(target, "utf-8")).toBe("前回の書き出し");
    expect(readdirSync(dir)).toEqual(["out.ndjson.gz"]);
  });

  it("最後の rename が失敗したら(保存先がディレクトリ)、reject し、一時ファイルを消す", async () => {
    const target = path.join(dir, "taken");
    mkdirSync(target);
    await expect(writeCloudMigrationFile(target, linesThen(["a"], "footer"))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("保存先のディレクトリが無ければ reject する(途中のファイルは作られない)", async () => {
    const target = path.join(dir, "no-such-dir", "out.ndjson.gz");
    await expect(writeCloudMigrationFile(target, linesThen(["a"], "footer"))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
