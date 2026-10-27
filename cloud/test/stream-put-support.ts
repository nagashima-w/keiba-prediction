/**
 * 書き出しの `putFileStream`(両方のストア〈`D1PriorExportStore`・`D1AllocationExportStore`〉が共有する流し込み。`export-r2-stream.ts`)のテストの道具。
 * Node のテストには `FixedLengthStream`(workerd の組み込み)が無いので、長さを検査する偽の実装を注入する。
 * 本物の `FixedLengthStream` で R2 に流せることは、スモークテスト(`cloud/smoke.ts`。本物の workerd の DO)が確かめる。
 */

/** FixedLengthStream の代わり: 流れたバイト数が宣言した長さと違えば、読み手(put)が失敗する。 */
export function fixedLength(length: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > length) throw new Error("宣言より多い");
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== length) throw new Error("宣言と違う");
    },
  });
}

/** R2 の put を、流れてきたストリームを読み切って実物のバケットに渡す偽物にする(Node の ReadableStream をローカルの R2 のプロキシに直接渡せないため)。 */
export function streamBucket(real: R2Bucket): { bucket: Pick<R2Bucket, "get" | "put">; bodies: Uint8Array[]; keys: string[] } {
  const bodies: Uint8Array[] = [];
  const keys: string[] = [];
  const bucket = {
    get: (key: string) => real.get(key),
    async put(key: string, value: ReadableStream | Uint8Array, options?: R2PutOptions) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
      keys.push(key);
      bodies.push(bytes);
      return real.put(key, bytes, options);
    },
  } as unknown as Pick<R2Bucket, "get" | "put">;
  return { bucket, bodies, keys };
}
