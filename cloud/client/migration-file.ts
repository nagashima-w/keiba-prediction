/**
 * ブラウザでの移行ファイルの検証(Issue #222〈#167-B2〉)。選んだ gzip の NDJSON(exe の「クラウド移行用に書き出す」。#215)を、**アップロードする前に**、
 * 全行を流し読みして検証する。壊れている・途中で切れている・形式の版が違うファイルは、理由を返してアップロードさせない。
 *
 * サーバの検証(`src/migration-verify.ts`)と同じ約束の、このうち「行の分割・`parseMigrationLine`・`MigrationTally`・フッタまで」を行う:
 *  - 行の分割は**サーバと同じ `readLines`**(`src/migration-reader.ts`。区切りは 0x0A だけ。U+2028・U+2029 を生で含む値を壊さない。チャンクの途中で切れたマルチバイトも壊さない)
 *  - **全体をメモリに載せない**: `File.stream()` を `DecompressionStream` に流し、保持するのは組み立て中の 1 行だけ(実物で約 130KB。展開後は百数十 MB)
 *  - 行ごとに取り消し(`isCancelled`)を確かめ、取り消されたら読むのをやめる(`readLines` の finally が展開を止める)
 *  - 展開と JSON.parse は主スレッドで行うので、**一定時間(既定 50ms)ごとに `yieldToUi` で画面に制御を返す**(進捗の表示・タップが固まらない)
 *
 * **サーバの検証との差**: サーバはさらに「取り込みの変換」(`toAnalysisImport`・`toResultImport`)を通す。ここでは通さない(クライアントのバンドルに取り込みの変換と codec を入れないため)。
 * 形式は通るが変換で落ちる内容(JSON の列が壊れている・馬番や買い目のキーの重複)は、アップロード後にサーバが検証で `failed` にし、画面の進捗に理由が出る(何も書かれない)。
 */
import { MigrationFormatError, MigrationTally, parseMigrationLine, type MigrationFooterLine, type MigrationHeaderLine } from "@keiba/core/ev/cloud-migration-format";
import { MigrationFileError, readLines } from "../src/migration-reader";

/** 検証に必要な File の部分(`File`・`Blob` が満たす。テストでは偽物を渡せる)。 */
export interface ValidatableFile {
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

/** 進捗: 読んだ(圧縮の)バイト数・ファイル全体(圧縮)のバイト数・読んだ行数。 */
export interface ValidateProgress {
  readonly readBytes: number;
  readonly totalBytes: number;
  readonly lines: number;
}

export interface ValidateDeps {
  /** 行ごとに呼ぶ(呼び出し側が間引く)。 */
  readonly onProgress?: (progress: ValidateProgress) => void;
  /** true を返したら読むのをやめて `cancelled`。行ごとに呼ぶ。 */
  readonly isCancelled?: () => boolean;
  /** 現在時刻(ミリ秒)。`yieldToUi` の間隔の判定に使う。 */
  readonly now?: () => number;
  /** 画面に制御を返す(本番は `setTimeout(0)` の Promise)。省略は返さない。 */
  readonly yieldToUi?: () => Promise<void>;
  /** `yieldToUi` を呼ぶ間隔(ミリ秒)。既定 50。 */
  readonly yieldEveryMs?: number;
}

/** 検証に通ったファイルの要約。 */
export interface ValidatedSummary {
  /** 分析の件数(分析の行の数)。 */
  readonly analyses: number;
  /** 結果のレース数(結果の行の数)。 */
  readonly results: number;
  readonly exportedAt: string;
  readonly appVersion: string;
  /** 行数(ヘッダ・フッタを含む)。 */
  readonly lines: number;
  /** 展開後のバイト数。 */
  readonly inflatedBytes: number;
}

export type ValidateResult =
  | { readonly kind: "ok"; readonly summary: ValidatedSummary }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "cancelled" };

/** `file.stream()` を、読んだバイト数を数えながら通す(圧縮のバイト数。進捗の割合に使う)。 */
function counting(source: ReadableStream<Uint8Array>, onBytes: (total: number) => void): ReadableStream<Uint8Array> {
  let total = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.length;
        onBytes(total);
        controller.enqueue(chunk);
      },
    }),
  );
}

export async function validateMigrationFile(file: ValidatableFile, deps: ValidateDeps = {}): Promise<ValidateResult> {
  const now = deps.now ?? (() => 0);
  const yieldEvery = deps.yieldEveryMs ?? 50;
  const tally = new MigrationTally();
  let header: MigrationHeaderLine | null = null;
  let footer: MigrationFooterLine | null = null;
  let readBytes = 0;
  let count = 0;
  let inflated = 0;
  let lastYield = now();
  try {
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = counting(file.stream(), (n) => {
        readBytes = n;
      });
    } catch {
      return { kind: "invalid", message: "ファイルを読み込めません(ファイルが移動・削除された、または読み取りの権限がない可能性があります)" };
    }
    for await (const raw of readLines(stream)) {
      if (deps.isCancelled?.() === true) {
        return { kind: "cancelled" };
      }
      count += 1;
      inflated = raw.end;
      let line;
      try {
        line = parseMigrationLine(raw.text);
      } catch (e) {
        throw new MigrationFormatError(`${count} 行目: ${e instanceof Error ? e.message : String(e)}`);
      }
      tally.accept(line);
      if (line.type === "header") header = line;
      else if (line.type === "footer") footer = line;
      deps.onProgress?.({ readBytes, totalBytes: file.size, lines: count });
      if (deps.yieldToUi !== undefined) {
        const t = now();
        if (t - lastYield >= yieldEvery) {
          lastYield = t;
          await deps.yieldToUi();
          if (deps.isCancelled?.() === true) {
            return { kind: "cancelled" };
          }
        }
      }
    }
    tally.assertComplete();
    if (header === null || footer === null) {
      throw new MigrationFormatError("ヘッダまたはフッタが無い");
    }
    deps.onProgress?.({ readBytes, totalBytes: file.size, lines: count });
    return { kind: "ok", summary: { analyses: footer.analysisLines, results: footer.resultLines, exportedAt: header.exportedAt, appVersion: header.appVersion, lines: count, inflatedBytes: inflated } };
  } catch (e) {
    if (e instanceof MigrationFormatError) {
      return { kind: "invalid", message: e.message };
    }
    if (e instanceof MigrationFileError) {
      const where = e.kind === "gzip" ? "ファイルを展開できない" : e.kind === "utf8" ? "ファイルを展開できない(UTF-8)" : "ファイルを展開できない(1 行が長すぎる)";
      return { kind: "invalid", message: `${count + 1} 行目付近: ${where}(${e.message})` };
    }
    return { kind: "invalid", message: "ファイルを読み込めません(読み取り中にエラーが起きました)" };
  }
}
