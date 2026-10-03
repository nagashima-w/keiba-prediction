/**
 * mixed-allocation-settings.test.ts — `AppSettings`(`getSettings`の戻り値)から配分の設定
 * (`MixedAllocationSettings`)を作る純関数の検証(Issue #150・#26-E3b・AC-5(b))。
 *
 * ## 背景
 * `App.tsx`は11項目を手書きで写していたため、`includeBracketQuinellaInAllocation`(や三連単)を
 * `true`固定に書き換える変異が全緑のまま生存していた(レンダリングテスト基盤が無く、`App`は
 * `window.keibaApi`を要するため)。写し方を純関数へ切り出し、全項目をここで固定する。
 *
 * `App.tsx`がこの関数を呼んでいること自体は、1行のソース走査で固定する(下のdescribe)。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mixedAllocationSettingsFromAppSettings } from "../src/renderer/mixed-allocation-settings.js";
import type { MixedAllocationSettings } from "../src/shared/mixed-race-allocation.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(currentDir, "../src/renderer");

/** 全項目が互いに区別できる入力(数値は相異なる、booleanは全てtrue)。 */
function source(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 100001,
    perRaceCap: 20002,
    kellyFraction: 0.3,
    evThreshold: 1.7,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

const BOOLEAN_FIELDS = [
  "includeComboOdds",
  "includeWideInAllocation",
  "includeTrioInAllocation",
  "includeQuinellaInAllocation",
  "includeExactaInAllocation",
  "includeTrifectaInAllocation",
  "includeBracketQuinellaInAllocation",
] as const satisfies readonly (keyof MixedAllocationSettings)[];

const NUMBER_FIELDS = ["bankroll", "perRaceCap", "kellyFraction", "evThreshold"] as const satisfies readonly (keyof MixedAllocationSettings)[];

describe("mixedAllocationSettingsFromAppSettings(AppSettings→MixedAllocationSettings。Issue #150・AC-5(b))", () => {
  it("前提固定(空振り防止): 項目は11個(boolean7+number4)で、テストの列挙と一致すること", () => {
    expect(Object.keys(source())).toHaveLength(11);
    expect([...BOOLEAN_FIELDS, ...NUMBER_FIELDS].sort()).toEqual(Object.keys(source()).sort());
  });

  it("全項目を値どおりに写すこと(すべてtrue/相異なる数値)", () => {
    expect(mixedAllocationSettingsFromAppSettings(source())).toEqual(source());
  });

  it.each(BOOLEAN_FIELDS)(
    "booleanの項目%sだけをfalseにすると、出力もその項目だけがfalseになること(殺す変異: その項目をtrue固定にする/他項目から取る)",
    (field) => {
      const input = source({ [field]: false });
      // 前提固定: 入力ではこの項目だけがfalse。
      expect(BOOLEAN_FIELDS.filter((f) => input[f] === false)).toEqual([field]);
      const out = mixedAllocationSettingsFromAppSettings(input);
      expect(out[field]).toBe(false);
      expect(BOOLEAN_FIELDS.filter((f) => out[f] === false)).toEqual([field]);
    },
  );

  it.each(NUMBER_FIELDS)("数値の項目%sを別の値にすると、出力もその値になること(項目間の取り違えを検知)", (field) => {
    const out = mixedAllocationSettingsFromAppSettings(source({ [field]: 987.5 }));
    expect(out[field]).toBe(987.5);
    for (const other of NUMBER_FIELDS.filter((f) => f !== field)) {
      expect(out[other]).toBe(source()[other]);
    }
  });

  it("AppSettingsが持つ配分と無関係な項目(APIキー・Discord等)は出力に含めないこと(機微値をキャッシュキー・Workerへ渡さない)", () => {
    const withExtra = { ...source(), anthropicApiKey: "sk-ant-secret", discordWebhookUrl: "https://x" };
    const out = mixedAllocationSettingsFromAppSettings(withExtra);
    expect(Object.keys(out).sort()).toEqual(Object.keys(source()).sort());
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});

describe("App.tsxがmixedAllocationSettingsFromAppSettingsを経由して設定を渡すこと(ソース走査。レンダリングテスト基盤が無いため。Issue #150・AC-5(b))", () => {
  it("getSettingsの結果をsetBetAllocationSettings(mixedAllocationSettingsFromAppSettings(s))で渡していること(殺す変異: 手書きの項目列挙に戻して枠連をtrue固定にする)", () => {
    const source = readFileSync(path.join(rendererDir, "App.tsx"), "utf8");
    expect(source).toContain("setBetAllocationSettings(mixedAllocationSettingsFromAppSettings(s))");
    // 前提固定(空振り防止): getSettingsの結果sを使っており、ファイルを正しく読めていること。
    expect(source).toContain(".getSettings()");
  });
});

describe("BatchAnalysisView.tsxがtoMixedAllocationCacheKeyを経由してキャッシュキーを作ること(ソース走査。Issue #150・AC-5(b))", () => {
  it("keyForAllocationが設定の項目を手書きで写さず、return toMixedAllocationCacheKey(raceId, fullResult, props.betAllocationSettings);でそのまま返していること(殺す変異: 項目の手書きに戻して枠連をtrue固定にする)", () => {
    const source = readFileSync(path.join(rendererDir, "BatchAnalysisView.tsx"), "utf8");
    // `return`直後にそのまま返していること(結果を`{ ...key, 項目: true }`のように上書きする変異を許さない)。
    expect(source).toContain("return toMixedAllocationCacheKey(raceId, fullResult, props.betAllocationSettings);");
    // 前提固定(空振り防止): keyForAllocationが実在し、手書きの写しが残っていないこと。
    expect(source).toContain("const keyForAllocation");
    expect(source).not.toMatch(/includeBracketQuinellaInAllocation:\s*s\./);
  });
});
