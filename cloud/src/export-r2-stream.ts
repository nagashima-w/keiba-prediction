/**
 * 書き出しのファイルを、塊を 1 つずつ流して R2 に put する(Issue #495。統計モデル用〈`prior-export-store.ts`〉と配分用〈`allocation-export-store.ts`〉のストアが共有する)。
 * **R2 の `put` を呼ぶのはこの 1 箇所だけ**(固定キーを原子的に上書きする)。Class A の計数は、呼び出し側のストアが put の前に済ませる。
 *
 * 塊は `FixedLengthStream` に 1 つずつ書いて R2 の `put` に渡す。全体を 1 つのバッファに連結しない。
 * 流している途中の例外・宣言した総バイト数との食い違いは put の失敗になり、固定キーの古いファイルは変わらない。
 */

/** 定長のストリーム(workerd の組み込み `FixedLengthStream` と同じ形。R2 の put にストリームを渡すには長さが要る)。 */
export type FixedLengthStreamFactory = (length: number) => { readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array> };

/** R2 のうち使う部分: 詳細の読み出し(get)と、完成したファイルの書き込み(put)だけ。 */
export type ExportBucket = Pick<R2Bucket, "get" | "put">;

export interface ExportFileInfoForPut {
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
}

/** 既定の定長ストリーム(workerd の `FixedLengthStream`)。Node のテストは、長さを検査する偽物を注入する。 */
export const defaultFixedLengthStream: FixedLengthStreamFactory = (length) => new FixedLengthStream(length);

export async function putStreamToR2(
  bucket: ExportBucket,
  fixedLengthStream: FixedLengthStreamFactory,
  key: string,
  parts: () => Iterable<Uint8Array>,
  totalBytes: number,
  info: ExportFileInfoForPut,
): Promise<void> {
  const { readable, writable } = fixedLengthStream(totalBytes);
  // put の結果。この Promise 自身は reject しない(失敗は putError に記録する)ので、流し込みの途中で put が先に失敗しても未処理の reject にならない。
  let putFailed = false;
  let putError: unknown;
  const putCall = bucket.put(key, readable, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { generatedAt: info.generatedAt, rows: String(info.rows), races: String(info.races) },
  });
  const putDone = putCall.then(
    () => undefined,
    (error: unknown) => {
      putFailed = true;
      putError = error;
    },
  );
  // put が先に失敗したら、読み手のいないストリームへの書き込みで待ち続けないよう、書き込みの待ちを打ち切る。
  const putAborted = putDone.then(() => (putFailed ? Promise.reject(putError) : new Promise<never>(() => undefined)));
  putAborted.catch(() => undefined);
  const writer = writable.getWriter();
  try {
    for (const part of parts()) {
      await Promise.race([writer.write(part), putAborted]);
    }
    await Promise.race([writer.close(), putAborted]);
  } catch (error) {
    // abort の完了は待たない(読み手のいないストリームでは、進行中の書き込みが詰まったまま abort が終わらないことがある)。abort は読み手に伝わり、put は失敗で終わる。
    void writer.abort(error).catch(() => undefined);
    await putDone;
    throw error;
  }
  await putDone;
  if (putFailed) {
    throw putError;
  }
}
