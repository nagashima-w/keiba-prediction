/**
 * レース結果の取込(変換・取込フロー)。**実体は core(`@keiba/core` の `ev/result-import.ts`)に移した**(Issue #207〈#182-A〉。#168 と同じ型)。
 *
 * クラウド版(cloud/)が、app の import(core のバレル経由で better-sqlite3 を巻き込む)を経由せずに同じ取込フローを使うため。
 * このファイルは re-export するだけ(app の呼び出し元・テストの import 先は変えない)。exe の挙動は変わらない。
 * 移設で変わったのは、`ImportResultDeps.saveResult` の戻り値が `void | Promise<void>`(await される)になったことだけ。
 */
export {
  importRaceResult,
  summarizeImport,
  toResultEntries,
  type ImportResultDeps,
} from "@keiba/core";
