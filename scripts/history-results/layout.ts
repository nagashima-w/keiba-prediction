/**
 * 出力ディレクトリの配置(取得 fetch と解析 parse で共有する)。Issue #532。
 *
 *   <out>/raw/calendar/YYYY-MM.html.gz        中央のカレンダー
 *   <out>/raw/list/YYYYMMDD.html.gz           中央の開催日の一覧
 *   <out>/raw/result/<race_id>.html.gz        中央の結果
 *   <out>/raw/nar/{calendar,list,result}/…    地方(同じ形。結果は交流重賞〈Jpn〉のみ)
 *   <out>/errors.ndjson                       取れなかったものの記録(再実行でもう一度試す)
 */

import path from "node:path";

/** 中央か地方か。 */
export type Kind = "central" | "nar";

/** 取得の段階。 */
export type Stage = "calendar" | "list" | "result";

/** raw の 1 ファイルのパス。`id` は calendar なら `YYYY-MM`、list なら `YYYYMMDD`、result なら race_id。 */
export function rawFilePath(outDir: string, kind: Kind, stage: Stage, id: string): string {
  const base = kind === "nar" ? path.join(outDir, "raw", "nar") : path.join(outDir, "raw");
  return path.join(base, stage, `${id}.html.gz`);
}

/** 結果の raw を置くディレクトリ。 */
export function rawResultDir(outDir: string, kind: Kind): string {
  return path.dirname(rawFilePath(outDir, kind, "result", "x"));
}

/** 取れなかったものの記録ファイル。 */
export function errorsFilePath(outDir: string): string {
  return path.join(outDir, "errors.ndjson");
}
