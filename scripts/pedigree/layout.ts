/**
 * 血統ページの出力ディレクトリの配置(取得 fetch と解析 parse で共有する)。Issue #542 手順 2。
 *
 *   <out>/raw/ped/<馬 ID>.html.gz   血統のページ(db.netkeiba.com/horse/ped/<馬 ID>/。UTF-8 にデコードして gzip)
 *   <out>/errors.ndjson             取れなかったものの記録(再実行でもう一度試す)
 *
 * #532 の結果の出力(`scripts/history-results/layout.ts`)とは別のディレクトリに置く(errors.ndjson を混ぜないため)。
 */

import path from "node:path";

/** raw の 1 ファイルのパス。 */
export function rawPedPath(outDir: string, horseId: string): string {
  return path.join(rawPedDir(outDir), `${horseId}.html.gz`);
}

/** raw を置くディレクトリ。 */
export function rawPedDir(outDir: string): string {
  return path.join(outDir, "raw", "ped");
}

/** 取れなかったものの記録ファイル。 */
export function errorsFilePath(outDir: string): string {
  return path.join(outDir, "errors.ndjson");
}
