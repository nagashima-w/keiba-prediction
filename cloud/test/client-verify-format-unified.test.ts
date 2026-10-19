import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_DIR } from "../build-client";

/**
 * Issue #397(R-3): 検証画面の整形は、core の `packages/core/src/view/verify-format.ts` の 1 本にまとめた。
 * もとは `cloud/client/verify-format.ts` に同名・同出力の関数が複製されており(exe の renderer が app の閉包から引けなかったため)、
 * `scripts/test/cloud-verify-format.test.ts` が出力の一致を固定していた。#287 で exe がなくなり、複製の理由が消えた。
 * 一致を比べるテストは、実装が 1 つになったので要らない。**代わりに、複製が戻らないこと**をここで固定する。
 */

const CORE_FORMAT_SPEC = "../../packages/core/src/view/verify-format";

/** コメントを除いたソース。 */
function codeOf(file: string): string {
  return readFileSync(path.join(CLIENT_DIR, file), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const clientFiles = readdirSync(CLIENT_DIR).filter((f) => f.endsWith(".ts"));

/** core に 1 本だけある整形の関数(統合前は client にも同名・同出力で複製されていた 14 個。venueLabel は core の venueFilterLabel と同じ出力だった 1 個)。 */
const FORMAT_NAMES = [
  "formatRate",
  "formatYen",
  "formatPayoutBreakdown",
  "formatUnknownBetTypeNotice",
  "directionLabel",
  "formatAdjustment",
  "overconfidenceLabel",
  "markLabel",
  "formatBinRange",
  "calibrationBarWidthPercent",
  "promptVersionLabel",
  "additionalInstructionsSummary",
  "additionalInstructionsFullText",
  "promptVersionCalibrationHeading",
  "venueLabel",
] as const;

describe("検証画面の整形は core の 1 本(Issue #397 R-3)", () => {
  it("前提(空振り防止): 対象の関数は 15 個で、client のソースがあり、検証画面のモデルが整形を使っている", () => {
    expect(FORMAT_NAMES).toHaveLength(15);
    expect(new Set(FORMAT_NAMES).size).toBe(15);
    expect(clientFiles.length).toBeGreaterThan(5);
    expect(codeOf("verify-model.ts")).toContain("formatYen(");
  });

  it("client のどのファイルも、これらの関数を自前で定義しない(function・const・export の別を問わない)", () => {
    for (const file of clientFiles) {
      const code = codeOf(file);
      for (const name of FORMAT_NAMES) {
        expect(code, `${file} が ${name} を定義している`).not.toMatch(new RegExp(`(?:function|const|let|var)\\s+${name}\\b`));
      }
    }
  });

  it("対照: 定義の検出は、関数宣言・const の両方を拾える(上の検査が空振りでない)", () => {
    const detect = (name: string, code: string): boolean => new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(code);
    expect(detect("formatYen", "export function formatYen(a: number) {}")).toBe(true);
    expect(detect("formatYen", "const formatYen = (a: number) => a;")).toBe(true);
    expect(detect("formatYen", "const x = formatYen(1);")).toBe(false);
  });

  it("整形を使う client のファイルは、core の view/verify-format を直接 import している(再エクスポートの層を挟まない)", () => {
    for (const file of ["verify-model.ts", "result.ts", "monthly-model.ts", "report-model.ts"]) {
      expect(codeOf(file), file).toContain(`"${CORE_FORMAT_SPEC}"`);
    }
  });

  it("client/verify-format.ts に残るのは client だけが使う部品(PROPOSED_BET_LABELS)で、core の整形を再エクスポートしない", () => {
    const code = codeOf("verify-format.ts");
    expect(code).toContain("PROPOSED_BET_LABELS");
    expect(code).not.toMatch(/export\s*(?:type\s*)?\{[^}]*\}\s*from/);
    expect(code).not.toMatch(/export\s+\*\s+from/);
  });
});
