import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MigrationFormatError } from "../../packages/core/src/ev/cloud-migration-format";
import { MAX_LINE_BYTES, MigrationFileError, readLines, type RawLine } from "../src/migration-reader";
import { verifyMigrationFile } from "../src/migration-verify";
import { GOLDEN_TEXT, gz, streamOf } from "./migration-fixture";

/**
 * Issue #216(#167-B1): 移行ファイル(gzip の NDJSON)の流し読みと、書き込み前の全体の検証。
 * 区切りは `\n`(0x0A)だけ(U+2028・U+2029 は値の中に生で入る)。位置は「展開後のバイトオフセット」で持ち、次の alarm はそこまでを読み飛ばす。
 */

async function collect(it: AsyncIterable<RawLine>): Promise<RawLine[]> {
  const out: RawLine[] = [];
  for await (const l of it) out.push(l);
  return out;
}

const enc = new TextEncoder();

describe("readLines: 行・バイトオフセット", () => {
  const text = "あい\n{\"a\":\"x y z\"}\n🐎\n\nlast";
  const bytes = gz(text);

  it.each([1, 3, 7, 64, 100000])("チャンクの大きさ %d バイトでも同じ行・同じオフセット(マルチバイト文字・行の途中で切れても壊れない)", async (size) => {
    const lines = await collect(readLines(streamOf(bytes, size)));
    expect(lines.map((l) => l.text)).toEqual(["あい", '{"a":"x y z"}', "🐎", "", "last"]);
    // オフセット: start は直前の end。end は改行の次(最終行は改行なしなので本文の終わり)。
    let expectedStart = 0;
    for (const l of lines) {
      expect(l.start).toBe(expectedStart);
      expectedStart = l.end;
    }
    expect(lines[lines.length - 1]!.end).toBe(enc.encode(text).length);
    expect(lines[0]!.end).toBe(enc.encode("あい\n").length);
  });

  it("U+2028・U+2029 は区切りにならない(1 行のまま)", async () => {
    const lines = await collect(readLines(streamOf(gz('{"a":"  "}\n'), 5)));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('{"a":"  "}');
  });

  it("末尾の改行で終わるファイルは、空の最終行を出さない", async () => {
    const lines = await collect(readLines(streamOf(gz("a\nb\n"), 2)));
    expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("startOffset まで読み飛ばし、以降は同じ行・同じオフセット(次の alarm の再開)", async () => {
    const all = await collect(readLines(streamOf(bytes, 5)));
    for (const k of [1, 2, 3, 4]) {
      const resumed = await collect(readLines(streamOf(bytes, 5), all[k]!.start));
      expect(resumed, `k=${k}`).toEqual(all.slice(k));
    }
    // 前提: 再開が空振りでない(読み飛ばした先に行が残っている)
    expect((await collect(readLines(streamOf(bytes, 5), all[2]!.start))).length).toBeGreaterThan(0);
    // ファイルの大きさと同じオフセットなら何も返さない
    expect(await collect(readLines(streamOf(bytes, 5), all[all.length - 1]!.end))).toEqual([]);
  });

  it("途中で切れた gzip は、そこまでの行を返したあと MigrationFileError(gzip)", async () => {
    const full = gz(Array.from({ length: 3000 }, (_, i) => `行${i}-${(i * 2654435761 % 4294967296).toString(36)}`).join("\n"));
    const cut = full.slice(0, Math.floor(full.length / 2));
    const got: string[] = [];
    let error: unknown;
    try {
      for await (const l of readLines(streamOf(cut, 64))) got.push(l.text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationFileError);
    expect((error as MigrationFileError).kind).toBe("gzip");
    expect(got.length).toBeGreaterThan(0); // 前提: 切れる前の行は読めている
  });

  it("gzip でないデータは MigrationFileError(gzip)", async () => {
    await expect(collect(readLines(streamOf(enc.encode("これは gzip ではない"), 8)))).rejects.toMatchObject({ name: "MigrationFileError", kind: "gzip" });
  });

  it("UTF-8 として不正なバイトは MigrationFileError(utf8)", async () => {
    await expect(collect(readLines(streamOf(new Uint8Array(gzipSync(Buffer.from([0x61, 0xff, 0xfe, 0x0a]))), 4)))).rejects.toMatchObject({ kind: "utf8" });
  });

  it("1 行が上限(MAX_LINE_BYTES)を超えたら MigrationFileError(line-too-long)", async () => {
    const big = gz(`${"x".repeat(MAX_LINE_BYTES + 10)}\n`);
    await expect(collect(readLines(streamOf(big, 1 << 20)))).rejects.toMatchObject({ kind: "line-too-long" });
  });

  it("途中でやめても(for await を break)展開は止まり、例外にならない", async () => {
    for await (const l of readLines(streamOf(gz("a\n".repeat(10000)), 64))) {
      expect(l.text).toBe("a");
      break;
    }
  });
});

describe("verifyMigrationFile: 書き込みの前の全体の検証", () => {
  const ok = (text: string = GOLDEN_TEXT, size = 4096): ReadableStream<Uint8Array> => streamOf(gz(text), size);

  it("実物のファイル: 通る。ヘッダ・フッタの件数・行数・展開後の大きさ・結果の行の開始オフセットを返す", async () => {
    const v = await verifyMigrationFile(ok());
    expect(v.header.appVersion).toBe("1.27.0");
    expect(v.footer.analysisLines).toBe(5);
    expect(v.footer.resultLines).toBe(5);
    expect(v.footer.counts.analyses).toBe(5);
    expect(v.lines).toBe(12);
    expect(v.bytes).toBe(new TextEncoder().encode(GOLDEN_TEXT).length);
  });

  it("チャンクの切れ目が違っても結果は同じ", async () => {
    const a = await verifyMigrationFile(ok(GOLDEN_TEXT, 7));
    const b = await verifyMigrationFile(ok(GOLDEN_TEXT, 1 << 20));
    expect(a).toEqual(b);
  });

  const lines = GOLDEN_TEXT.trimEnd().split("\n");
  const footerIdx = lines.length - 1;
  const join = (ls: readonly string[]): string => `${ls.join("\n")}\n`;

  const bad: ReadonlyArray<readonly [string, () => string | ReadableStream<Uint8Array>, RegExp]> = [
    ["フッタが無い(途中で切れた)", () => join(lines.slice(0, footerIdx)), /フッタ/],
    ["フッタの件数が合わない", () => join([...lines.slice(0, footerIdx), lines[footerIdx]!.replace('"analysisLines":5', '"analysisLines":6')]), /フッタ/],
    ["フッタのあとに行がある", () => join([...lines, lines[0]!]), /フッタのあと/],
    ["ヘッダが無い", () => join(lines.slice(1)), /ヘッダ/],
    ["JSON として読めない行", () => join([lines[0]!, "{壊れた", ...lines.slice(1)]), /2 行目.*JSON/],
    ["列が足りない行(形式違反)", () => join([lines[0]!, lines[1]!.replace('"model":', '"modelx":'), ...lines.slice(2)]), /2 行目/],
    ["race_snapshot_json が JSON でない(形式は通るが、取り込みで落ちる)", () => join([lines[0]!, ...lines.slice(1).map((l) => l.replace(/"race_snapshot_json":"\{\\"raceName/, '"race_snapshot_json":"{壊れた\\"raceName'))]), /race_snapshot_json/],
    ["空行が途中にある", () => join([lines[0]!, "", ...lines.slice(1)]), /2 行目/],
    ["gzip が途中で切れている", () => { const full = gz(GOLDEN_TEXT); return streamOf(full.slice(0, full.length - 20), 64); }, /展開|切れ/],
    ["gzip でない", () => streamOf(new TextEncoder().encode("plain text"), 4), /展開|gzip/],
    ["空のファイル", () => "", /ヘッダ|フッタ|空/],
  ];
  it.each(bad)("拒否: %s", async (_name, make, pattern) => {
    const made = make();
    const stream = typeof made === "string" ? streamOf(gz(made), 100) : made;
    const error = await verifyMigrationFile(stream).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationFormatError);
    expect((error as Error).message).toMatch(pattern);
  });

  it("前提(空振り防止): 変異に使った置換は、実物に効いている", () => {
    expect(lines[footerIdx]).toContain('"analysisLines":5');
    expect(lines[1]).toContain('"model":');
    expect(lines.slice(1).some((l) => /"race_snapshot_json":"\{\\"raceName/.test(l))).toBe(true);
  });
});
