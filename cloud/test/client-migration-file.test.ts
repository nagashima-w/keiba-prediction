import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { validateMigrationFile, type ValidateResult } from "../client/migration-file";
import { GOLDEN_TEXT } from "./migration-fixture";

/**
 * Issue #222(#167-B2): ブラウザでの移行ファイルの検証(流し読み)。サーバの `verifyMigrationFile` の「行の分割・parseMigrationLine・MigrationTally・フッタまで」と同じ約束を、
 * `File.stream()`(ここでは同じ形の偽の Blob)に対して行う。守ること:
 *  - 実物のファイル(exe の書き出しと一致を固定している core のフィクスチャ)を通る。壊れ方ごとに、**アップロードさせない理由**(日本語・位置つき)を返す
 *  - 区切りは `\n` だけ(U+2028/2029 を生で含む行を壊さない)。小さなチャンクに割って渡し、マルチバイト文字がチャンクの途中で切れても壊れない
 *  - 全体をメモリに載せない: 1 行ずつ処理し、取り消せば読むのをやめる(ストリームを最後まで引かない)
 */

// Windows のチェックアウトの CRLF は LF にそろえてある(`migration-fixture.ts`)。
const FIXTURE = GOLDEN_TEXT;
const LINES = FIXTURE.replace(/\n$/, "").split("\n");

/** チャンクを引かれた回数を数える、偽の File(Blob 互換の stream と size を持つ)。 */
function fakeFile(bytes: Uint8Array, chunkSize = 64): { file: { size: number; stream(): ReadableStream<Uint8Array> }; pulled: () => number; totalChunks: number } {
  let pulled = 0;
  const totalChunks = Math.ceil(bytes.length / chunkSize);
  return {
    file: {
      size: bytes.length,
      stream: () => {
        let pos = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pos >= bytes.length) {
              controller.close();
              return;
            }
            pulled += 1;
            controller.enqueue(bytes.slice(pos, pos + chunkSize));
            pos += chunkSize;
          },
        });
      },
    },
    pulled: () => pulled,
    totalChunks,
  };
}

const gz = (text: string): Uint8Array => new Uint8Array(gzipSync(Buffer.from(text, "utf-8")));
const run = (bytes: Uint8Array, deps: Parameters<typeof validateMigrationFile>[1] = {}, chunk = 64): Promise<ValidateResult> => validateMigrationFile(fakeFile(bytes, chunk).file, deps);
function invalidMessage(result: ValidateResult): string {
  expect(result.kind).toBe("invalid");
  return result.kind === "invalid" ? result.message : "";
}

describe("validateMigrationFile: 正しいファイル", () => {
  it("前提: フィクスチャは分析 5 行・結果 5 行・U+2028 を生で含む行がある(区切りの検査が空振りでない)", () => {
    expect(LINES.filter((l) => l.startsWith('{"type":"analysis"'))).toHaveLength(5);
    expect(LINES.filter((l) => l.startsWith('{"type":"result"'))).toHaveLength(5);
    expect(FIXTURE).toContain(" ");
  });

  it("実物のフィクスチャを通り、分析の件数・結果のレース数・書き出し日時・アプリの版を返す", async () => {
    const result = await run(gz(FIXTURE));
    expect(result).toEqual({ kind: "ok", summary: { analyses: 5, results: 5, exportedAt: "2026-10-09T00:00:00.000Z", appVersion: "1.27.0", lines: 12, inflatedBytes: Buffer.byteLength(FIXTURE) } });
  });

  it("1 バイトずつのチャンクでも同じ結果(マルチバイト文字・U+2028 がチャンクの途中で切れても壊れない)", async () => {
    const whole = await run(gz(FIXTURE), {}, 4096);
    const tiny = await run(gz(FIXTURE), {}, 1);
    expect(tiny).toEqual(whole);
    expect(tiny.kind).toBe("ok");
  });

  it("最終行が改行で終わっていなくても通る", async () => {
    const result = await run(gz(FIXTURE.replace(/\n$/, "")));
    expect(result.kind).toBe("ok");
  });

  it("分析 0 件・結果 0 件のファイル(ヘッダとフッタだけ)も通る", async () => {
    const footer = LINES[LINES.length - 1]!.replace(/"counts":\{[^}]*\}/, `"counts":{"analyses":0,"analysis_horses":0,"analysis_bets":0,"analysis_allocation_meta":0,"race_results":0,"race_result_meta":0,"race_combo_payouts":0,"race_combo_payout_imports":0}`).replace(/"analysisLines":\d+/, '"analysisLines":0').replace(/"resultLines":\d+/, '"resultLines":0');
    const result = await run(gz(`${LINES[0]}\n${footer}\n`));
    expect(result.kind === "ok" && result.summary.analyses === 0 && result.summary.results === 0).toBe(true);
  });
});

describe("validateMigrationFile: 壊れたファイルは理由を返す(アップロードさせない)", () => {
  it("gzip でないファイル(平文)は、展開できない旨", async () => {
    const message = invalidMessage(await run(new TextEncoder().encode(FIXTURE)));
    expect(message).toContain("展開できない");
  });

  it("途中で切れた gzip は、展開できない旨(壊れている、または途中で切れている)", async () => {
    const full = gz(FIXTURE);
    const message = invalidMessage(await run(full.subarray(0, Math.floor(full.length / 2))));
    expect(message).toContain("途中で切れている");
  });

  it("空のファイルは、フッタが無い旨", async () => {
    expect(invalidMessage(await run(new Uint8Array(0)))).toMatch(/展開できない|フッタ/);
    expect(invalidMessage(await run(gz("")))).toContain("フッタ");
  });

  it("フッタの無いファイル(gzip としては正しいが NDJSON が途中で切れている)は、フッタが無い旨", async () => {
    const message = invalidMessage(await run(gz(`${LINES.slice(0, -1).join("\n")}\n`)));
    expect(message).toContain("フッタが無い");
    expect(message).toContain("途中で切れたファイルの可能性"); // MigrationTally の assertComplete の文(読んだ行数つき)。ヘッダ・フッタの null 検査だけでは出ない
    expect(message).toContain("11 行を読んだ");
  });

  it("形式の版が違うファイルは、版が違う旨(1 行目)", async () => {
    const header = LINES[0]!.replace('"version":1', '"version":2');
    expect(header).not.toBe(LINES[0]);
    const message = invalidMessage(await run(gz([header, ...LINES.slice(1)].join("\n"))));
    expect(message).toContain("1 行目");
    expect(message).toContain("未対応の版");
  });

  it("形式名が違うファイル(別の JSON)は、形式名が違う旨", async () => {
    const header = LINES[0]!.replace("keiba-cloud-migration", "other");
    expect(invalidMessage(await run(gz([header, ...LINES.slice(1)].join("\n"))))).toContain("形式名");
  });

  it("JSON として読めない行は、行番号つき", async () => {
    const message = invalidMessage(await run(gz([LINES[0], LINES[1], "{壊れた", ...LINES.slice(2)].join("\n"))));
    expect(message).toContain("3 行目");
    expect(message).toContain("JSON");
  });

  it("未知の列・型の違いは、位置(行番号・表・列)つき", async () => {
    const unknownColumn = LINES[1]!.replace('"race_id":', '"extra":1,"race_id":');
    const m1 = invalidMessage(await run(gz([LINES[0], unknownColumn, ...LINES.slice(2)].join("\n"))));
    expect(m1).toContain("2 行目");
    expect(m1).toContain("未知の列 extra");
    const badType = LINES[1]!.replace('"ev_estimated":0', '"ev_estimated":"x"');
    expect(badType).not.toBe(LINES[1]);
    const m2 = invalidMessage(await run(gz([LINES[0], badType, ...LINES.slice(2)].join("\n"))));
    expect(m2).toContain("ev_estimated");
  });

  it("行の並びの違反(分析の id が昇順でない)は、行番号つき", async () => {
    const message = invalidMessage(await run(gz([LINES[0], LINES[2], LINES[1], ...LINES.slice(3)].join("\n"))));
    expect(message).toContain("3 行目");
    expect(message).toContain("昇順");
  });

  it("フッタの件数が読んだ行数と合わない(行が抜けている)は、件数の不一致", async () => {
    const message = invalidMessage(await run(gz([LINES[0], ...LINES.slice(2)].join("\n"))));
    expect(message).toContain("フッタ");
    expect(message).toMatch(/一致しない/);
  });

  it("フッタのあとに行があれば、その旨", async () => {
    expect(invalidMessage(await run(gz(`${FIXTURE}${LINES[1]}\n`)))).toContain("フッタのあと");
  });

  it("UTF-8 として読めないバイトがあれば、展開できない旨", async () => {
    const bad = Buffer.concat([Buffer.from(`${LINES[0]}\n`), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(LINES.slice(1).join("\n"))]);
    expect(invalidMessage(await run(new Uint8Array(gzipSync(bad))))).toContain("UTF-8");
  });
});

describe("validateMigrationFile: 流し読み・進捗・取り消し", () => {
  it("進捗は、読んだ(圧縮の)バイト数が単調に増え、最後は全体と一致する。行数も増える", async () => {
    const bytes = gz(FIXTURE);
    const seen: { readBytes: number; totalBytes: number; lines: number }[] = [];
    const result = await run(bytes, { onProgress: (p) => seen.push({ ...p }) }, 16);
    expect(result.kind).toBe("ok");
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.readBytes).toBeGreaterThanOrEqual(seen[i - 1]!.readBytes);
      expect(seen[i]!.lines).toBeGreaterThanOrEqual(seen[i - 1]!.lines);
    }
    expect(seen.every((p) => p.totalBytes === bytes.length)).toBe(true);
    expect(seen[seen.length - 1]!.readBytes).toBe(bytes.length);
    expect(seen[seen.length - 1]!.lines).toBe(12);
  });

  it("取り消すと cancelled を返し、3 行目以降を処理しない(解釈も進捗の通知もしない)", async () => {
    // (Node の DecompressionStream は入力を先読みして引き切るので、「引いたチャンク数」は検査しない。ブラウザでのメモリは Playwright の実測で確かめる。)
    // 圧縮が効きにくい(行ごとに違う乱数の文字列を持つ)入力にして、圧縮後のチャンク数を多くする。3 行目に入る前に取り消す。
    let seed = 12345;
    const rand = (): string => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed.toString(36);
    };
    const noise = (): string => Array.from({ length: 400 }, rand).join("");
    const big = `${LINES[0]}\n${Array.from({ length: 600 }, (_, i) => LINES[1]!.replace('"id":1,', `"id":${i + 1},`).replace('"additional_instruction":null', `"additional_instruction":"${noise()}"`)).join("\n")}\n`;
    const bytes = gz(big);
    const f = fakeFile(bytes, 256);
    expect(f.totalChunks).toBeGreaterThan(1000);
    let calls = 0;
    let lastLines = 0;
    const result = await validateMigrationFile(f.file, { isCancelled: () => (calls += 1) > 2, onProgress: (p) => (lastLines = p.lines) });
    expect(result.kind).toBe("cancelled");
    expect(calls).toBe(3);
    expect(lastLines).toBe(2);
  });

  it("時間が一定以上たったら yieldToUi を呼ぶ(画面に制御を返す)。たたなければ呼ばない", async () => {
    let t = 0;
    let yields = 0;
    const slow = await run(gz(FIXTURE), { now: () => (t += 100), yieldToUi: async () => { yields += 1; } });
    expect(slow.kind).toBe("ok");
    expect(yields).toBeGreaterThan(3);
    let t2 = 0;
    let yields2 = 0;
    const fast = await run(gz(FIXTURE), { now: () => t2, yieldToUi: async () => { yields2 += 1; } });
    expect(fast.kind).toBe("ok");
    expect(yields2).toBe(0);
  });

  it("ファイルの読み込み自体が失敗したら(stream が投げる)、読めなかった旨", async () => {
    const result = await validateMigrationFile({ size: 10, stream: () => { throw new Error("NotReadableError SECRET"); } }, {});
    const message = invalidMessage(result);
    expect(message).toContain("読み込めません");
    expect(message).not.toContain("SECRET");
  });
});
