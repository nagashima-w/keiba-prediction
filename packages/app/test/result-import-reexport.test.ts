import { describe, expect, expectTypeOf, it } from "vitest";
import * as core from "@keiba/core";
import * as appModule from "../src/main/result-import.js";
import type { ImportResultOutcome as SharedImportResultOutcome } from "../src/shared/analysis-types.js";

/**
 * Issue #207(#182-A)AC-A2: 結果の取込フロー(変換・importRaceResult)の実体を core へ移し、app の `result-import.ts` は re-export するだけにした。
 * app の既存テスト(result-import.test.ts ほか)は無改変で通る。ここでは、移設の「つなぎ目」を固定する:
 *  - app が公開する関数は、core の実体と同一(別実装が app に残っていない・取り違えていない)
 *  - core の `ImportResultOutcome` と、IPC・画面が使う `shared/analysis-types.ts` の `ImportResultOutcome` は同じ形(型が食い違えば型検査で落ちる)
 */
describe("app の result-import.ts は core の実体の re-export", () => {
  it("importRaceResult・summarizeImport・toResultEntries が core のものと同一", () => {
    expect(appModule.importRaceResult).toBe(core.importRaceResult);
    expect(appModule.summarizeImport).toBe(core.summarizeImport);
    expect(appModule.toResultEntries).toBe(core.toResultEntries);
    expect(typeof appModule.importRaceResult).toBe("function");
  });

  it("app の公開は上の3関数だけ(実装を app に持ち直していない)", () => {
    expect(Object.keys(appModule).sort()).toEqual(["importRaceResult", "summarizeImport", "toResultEntries"]);
  });

  it("型: core の ImportResultOutcome と shared の ImportResultOutcome は同じ形", () => {
    expectTypeOf<core.ImportResultOutcome>().toEqualTypeOf<SharedImportResultOutcome>();
  });
});
