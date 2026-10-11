/**
 * JSON の原子的な書き込み(Issue #159〈#21-A〉)。
 *
 * 結果ファイル(spike-result.json)は、ドライバが測定の節目ごとに書き直し、後片付け(cleanup-run)が
 * 最後に読む。書き込み中にプロセスが切れても読み手が壊れた JSON を掴まないよう、同じディレクトリの
 * 一時ファイルに完全な内容を書いてから rename で差し替える(同一ファイルシステム内の rename は原子的)。
 */

import { renameSync as fsRenameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AtomicWriteDeps {
  /** rename の差し替え口(失敗の再現用)。省略時は fs.renameSync。 */
  readonly renameSync?: (from: string, to: string) => void;
}

export function writeJsonAtomic(filePath: string, data: unknown, deps: AtomicWriteDeps = {}): void {
  const rename = deps.renameSync ?? fsRenameSync;
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  rename(tmpPath, filePath);
}
