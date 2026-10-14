/**
 * 移行ファイル(gzip の NDJSON。Issue #215)の流し読み(Issue #216・#167-B1)。**全体をメモリに載せない**: 展開した本文を 1 行ずつ取り出して渡すだけで、
 * 保持するのは「いま組み立て中の 1 行」(実物で約 130KB。上限 {@link MAX_LINE_BYTES})だけ。
 *
 * - **区切りは 0x0A(`\n`)だけ**。U+2028・U+2029 は値の中に生で入る(JSON.stringify はエスケープしない)ので、Unicode の行区切りで分けてはならない。
 *   バイト列の 0x0A で分け、行ごとに UTF-8 としてデコードするので、マルチバイト文字がチャンクの途中で切れても壊れない。
 * - **位置は展開後のバイトオフセット**。`start` はその行の先頭、`end` は次の行の先頭(改行の次。最終行が改行で終わらなければ本文の終わり)。
 *   次の alarm は `startOffset` に前回の `end` を渡し、そこまでを**解釈せずに捨てる**(gzip は途中から読めないので展開はするが、行の切り出し・デコード・JSON.parse はしない)。
 * - 展開は `DecompressionStream`(workerd・Node 18+ にある)。壊れた・途中で切れた gzip は {@link MigrationFileError}(`kind: "gzip"`)。
 */

/** 1 行の上限(バイト)。実物の最大は約 130KB。区切りの無い巨大なデータでメモリを使い切らないための歯止め。 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** 流し読みの失敗(ファイルの壊れ)。`kind` で原因を区別する。 */
export class MigrationFileError extends Error {
  readonly kind: "gzip" | "utf8" | "line-too-long";
  constructor(kind: MigrationFileError["kind"], message: string) {
    super(message);
    this.name = "MigrationFileError";
    this.kind = kind;
  }
}

/** 取り出した 1 行。 */
export interface RawLine {
  readonly text: string;
  /** この行の先頭の、展開後のバイトオフセット。 */
  readonly start: number;
  /** 次の行の先頭のオフセット(改行の次)。 */
  readonly end: number;
}

const NEWLINE = 0x0a;

function concat(pieces: readonly Uint8Array[], total: number): Uint8Array {
  if (pieces.length === 1) {
    return pieces[0]!;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of pieces) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * gzip の本文を 1 行ずつ取り出す。`startOffset` までの展開後のバイトは捨てる(その位置は前回の {@link RawLine.end} で、行の境界でなければならない)。
 * 途中でやめても(`for await` の `break`)、展開を止める。
 */
export async function* readLines(gz: ReadableStream<Uint8Array>, startOffset = 0): AsyncGenerator<RawLine> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const decode = (bytes: Uint8Array): string => {
    try {
      return decoder.decode(bytes);
    } catch {
      throw new MigrationFileError("utf8", "UTF-8 として読めないバイトがある");
    }
  };
  const reader = gz.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  let consumed = 0; // これまでに読んだ展開後のバイト数
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let lineStart = startOffset;
  try {
    for (;;) {
      let chunk: Uint8Array;
      try {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunk = value;
      } catch {
        throw new MigrationFileError("gzip", "gzip として展開できない(壊れている、または途中で切れている)");
      }
      const chunkStart = consumed;
      consumed += chunk.length;
      if (consumed <= startOffset) {
        continue; // まるごと捨てる
      }
      if (chunkStart < startOffset) {
        chunk = chunk.subarray(startOffset - chunkStart);
      }
      let from = 0;
      for (;;) {
        const idx = chunk.indexOf(NEWLINE, from);
        if (idx < 0) {
          const rest = chunk.subarray(from);
          if (rest.length > 0) {
            pending.push(rest);
            pendingBytes += rest.length;
            if (pendingBytes > MAX_LINE_BYTES) {
              throw new MigrationFileError("line-too-long", `1 行が上限(${MAX_LINE_BYTES} バイト)を超えている`);
            }
          }
          break;
        }
        const piece = chunk.subarray(from, idx);
        const total = pendingBytes + piece.length;
        if (total > MAX_LINE_BYTES) {
          throw new MigrationFileError("line-too-long", `1 行が上限(${MAX_LINE_BYTES} バイト)を超えている`);
        }
        pending.push(piece);
        const text = decode(pending.length === 1 ? pending[0]! : concat(pending, total));
        pending = [];
        pendingBytes = 0;
        const end = lineStart + total + 1;
        yield { text, start: lineStart, end };
        lineStart = end;
        from = idx + 1;
      }
    }
    // 改行で終わらない最終行。
    if (pendingBytes > 0) {
      const text = decode(concat(pending, pendingBytes));
      yield { text, start: lineStart, end: lineStart + pendingBytes };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
