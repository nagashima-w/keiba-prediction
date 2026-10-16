/**
 * import.meta.url からの相対パスを、ファイルシステムのパス(文字列)に解決する(Issue #332)。
 *
 * `fileURLToPath(new URL(rel, import.meta.url))` と書くと、cloud の tsconfig(types: workers-types と node)では型が衝突する:
 * グローバルの `URL` は workers-types のもの、`node:url` の `fileURLToPath` が要求するのは Node の `URL` で、
 * @types/node 24 以上では `URLSearchParamsIterator` の `[Symbol.dispose]` の有無で代入できない(TS2345)。
 * `.href`(文字列)で渡せば衝突しない。解決されるパスは変わらない(fileURLToPath は文字列を内部で URL にして扱う。末尾の `/` も保たれる)。
 */
import { fileURLToPath } from "node:url";

export function pathFromMeta(relative: string, metaUrl: string): string {
  return fileURLToPath(new URL(relative, metaUrl).href);
}
