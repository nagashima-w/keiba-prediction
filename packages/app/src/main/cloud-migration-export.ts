/**
 * クラウド移行ファイルの書き込み(main プロセス。Issue #215・#167-A)。
 *
 * 形式・各行の組み立て・検証は core(`@keiba/core` の cloud-migration-*。ブラウザでも動く)が持つ。
 * ここは **gzip とファイル書き込みだけ**を担う(`node:zlib` / `node:fs` は main だけ。renderer に混入させない)。
 *
 * - 行は同期のジェネレータから**1 行ずつ**引く(全件を一度にメモリに載せない)。Readable.from → gzip → ファイルの
 *   pipeline がバックプレッシャを掛けるので、ファイルが詰まれば次のページの読み出しも止まる。
 * - 一時ファイル(保存先と同じディレクトリ。rename を同じボリュームで行うため)に書き、成功したら保存先へ rename する。
 *   失敗したら一時ファイルを消す。**保存先に途中のファイルを残さない**(既存のファイルがあれば、失敗時もそのまま残る)。
 */

import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { MigrationFooterLine } from "@keiba/core";

/** 書き出しの既定ファイル名(ローカル日付。例: keiba-cloud-migration-20261009.ndjson.gz)。log-export と同じ流儀。 */
export function buildDefaultCloudMigrationFileName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `keiba-cloud-migration-${y}${m}${d}.ndjson.gz`;
}

/** 書き込みの結果。 */
export interface CloudMigrationWriteResult {
  /** 行の生成器が最後に返したフッタ(実際に書いた件数)。 */
  readonly footer: MigrationFooterLine;
  /** 保存先のファイルの大きさ(バイト)。 */
  readonly fileBytes: number;
}

/**
 * 行の生成器を最後まで流して gzip の NDJSON として `filePath` に書く。
 * 生成器が throw したら(形式違反など)同じエラーで reject する。
 */
export async function writeCloudMigrationFile(
  filePath: string,
  lines: Generator<string, MigrationFooterLine>,
): Promise<CloudMigrationWriteResult> {
  const tempPath = `${filePath}.tmp`;
  let footer: MigrationFooterLine | undefined;
  function* withNewlines(): Generator<string> {
    for (;;) {
      const next = lines.next();
      if (next.done === true) {
        footer = next.value;
        return;
      }
      yield `${next.value}\n`;
    }
  }

  const out = createWriteStream(tempPath);
  try {
    await pipeline(Readable.from(withNewlines()), createGzip(), out);
    const { size } = await stat(tempPath);
    await rename(tempPath, filePath);
    if (footer === undefined) {
      throw new Error("行の生成器がフッタを返さずに終わりました"); // 到達しない(生成器は必ずフッタを返す)
    }
    return { footer, fileBytes: size };
  } catch (error) {
    // Windows ではファイルを開いたまま消せないので、書き込みストリームが閉じてから一時ファイルを消す。
    if (!out.closed) {
      out.destroy();
      await new Promise<void>((resolve) => out.once("close", () => resolve()));
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
