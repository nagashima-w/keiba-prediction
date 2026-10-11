/**
 * Issue #216(#167-B1)のテスト用: exe の書き出しの実物(packages/core/test/fixtures/cloud-migration-small.ndjson。
 * core の cloud-migration-golden.test.ts が、今の書き出しの経路との一致を固定している)を読む。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseMigrationLine, type MigrationAnalysisLine, type MigrationLine, type MigrationResultLine } from "../../packages/core/src/ev/cloud-migration-format";

const GOLDEN_PATH = fileURLToPath(new URL("../../packages/core/test/fixtures/cloud-migration-small.ndjson", import.meta.url));

/** 実物の NDJSON(非圧縮。末尾に改行)。 */
// Windows のチェックアウトは改行を CRLF にすることがあるので、行末を LF にそろえる(値の中の改行・CR は JSON でエスケープされるので、情報は失われない)。
export const GOLDEN_TEXT: string = readFileSync(GOLDEN_PATH, "utf-8").replace(/\r\n/g, "\n");
export const GOLDEN_LINES: readonly MigrationLine[] = GOLDEN_TEXT.trimEnd().split("\n").map((l) => parseMigrationLine(l));
export const GOLDEN_ANALYSES = GOLDEN_LINES.filter((l): l is MigrationAnalysisLine => l.type === "analysis");
export const GOLDEN_RESULTS = GOLDEN_LINES.filter((l): l is MigrationResultLine => l.type === "result");

export function gz(text: string): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(text, "utf-8")));
}

/** 文字列の並びを、一定の大きさで切った ReadableStream(チャンク境界が行・マルチバイト文字の途中に来る場合を作る)。 */
export function streamOf(bytes: Uint8Array, chunkSize = 64): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + chunkSize));
      pos += chunkSize;
    },
  });
}
