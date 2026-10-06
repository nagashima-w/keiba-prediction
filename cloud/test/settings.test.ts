import { describe, expect, it } from "vitest";
import { coerceCloudSettings, DEFAULT_CLOUD_SETTINGS, loadSettings, SELECT_SETTINGS_SQL } from "../src/settings";

/**
 * Issue #178(#164-c): クラウド版の設定(D1 の1行)。既定値は exe の現在の既定値(`scripts/test/cloud-settings-defaults.test.ts` が exe の値との一致を固定)。
 * 行が無い・読めない・一部の値が不正なときは、exe の `coerceSettings` と同じく、その項目だけ既定値にする(起動を壊さない)。
 */
describe("既定値", () => {
  it("exe と同じ既定値: 資金・1レース上限は 0(配分提案を出さない opt-in)、ケリー 0.5、組合せオッズの取得は OFF、各券種の配分は ON、EV 閾値 1.0、クリップ幅は default", () => {
    expect(DEFAULT_CLOUD_SETTINGS).toEqual({
      evThreshold: 1.0,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 0,
      perRaceCap: 0,
      kellyFraction: 0.5,
      includeComboOdds: false,
      includeWideInAllocation: true,
      includeTrioInAllocation: true,
      includeQuinellaInAllocation: true,
      includeExactaInAllocation: true,
      includeTrifectaInAllocation: true,
      includeBracketQuinellaInAllocation: true,
    });
  });
});

describe("coerceCloudSettings", () => {
  it("正しい値はそのまま採用し、無い項目は既定値", () => {
    const s = coerceCloudSettings({ bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.25, includeComboOdds: true, includeTrifectaInAllocation: false });
    expect(s.bankroll).toBe(1_000_000);
    expect(s.perRaceCap).toBe(100_000);
    expect(s.kellyFraction).toBe(0.25);
    expect(s.includeComboOdds).toBe(true);
    expect(s.includeTrifectaInAllocation).toBe(false);
    expect(s.includeWideInAllocation).toBe(true); // 既定
    expect(s.evThreshold).toBe(1.0);
  });

  it.each([
    ["bankroll が負", { bankroll: -1 }, "bankroll", 0],
    ["bankroll が小数", { bankroll: 1000.5 }, "bankroll", 0],
    ["bankroll が上限(1億)超え", { bankroll: 100_000_001 }, "bankroll", 0],
    ["bankroll が文字列", { bankroll: "1000" }, "bankroll", 0],
    ["bankroll が NaN", { bankroll: Number.NaN }, "bankroll", 0],
    ["perRaceCap が上限(1000万)超え", { perRaceCap: 10_000_001 }, "perRaceCap", 0],
    ["kellyFraction が 1 超え", { kellyFraction: 1.5 }, "kellyFraction", 0.5],
    ["kellyFraction が負", { kellyFraction: -0.1 }, "kellyFraction", 0.5],
    ["evThreshold が 0", { evThreshold: 0 }, "evThreshold", 1.0],
    ["clipVariant が未知", { clipVariant: "wide99" }, "clipVariant", "default"],
    ["include が真偽値でない", { includeComboOdds: "true" }, "includeComboOdds", false],
    ["include が真偽値でない(ワイド)", { includeWideInAllocation: 1 }, "includeWideInAllocation", true],
  ])("%s は、その項目だけ既定値に戻す", (_name, raw, key, expected) => {
    expect((coerceCloudSettings(raw) as unknown as Record<string, unknown>)[key]).toBe(expected);
  });

  it("境界: bankroll 1億ちょうど・perRaceCap 1000万ちょうど・kellyFraction 0 と 1 は採用する", () => {
    expect(coerceCloudSettings({ bankroll: 100_000_000 }).bankroll).toBe(100_000_000);
    expect(coerceCloudSettings({ perRaceCap: 10_000_000 }).perRaceCap).toBe(10_000_000);
    expect(coerceCloudSettings({ kellyFraction: 0 }).kellyFraction).toBe(0);
    expect(coerceCloudSettings({ kellyFraction: 1 }).kellyFraction).toBe(1);
  });

  it("オブジェクトでない入力(null・配列・文字列)は全部既定値。未知のキーは捨てる", () => {
    for (const raw of [null, undefined, [], "x", 5]) {
      expect(coerceCloudSettings(raw)).toEqual(DEFAULT_CLOUD_SETTINGS);
    }
    expect("secretKey" in coerceCloudSettings({ secretKey: "x" })).toBe(false);
  });
});

describe("loadSettings(D1 の1行)", () => {
  function db(row: unknown, record: string[] = []): Parameters<typeof loadSettings>[0] {
    return {
      prepare: (sql: string) => {
        record.push(sql);
        return { first: async () => row } as never;
      },
    } as never;
  }

  it("行が無ければ既定値(source: default)。読むのは1文だけ", async () => {
    const sqls: string[] = [];
    const loaded = await loadSettings(db(null, sqls));
    expect(loaded).toEqual({ settings: DEFAULT_CLOUD_SETTINGS, source: "default" });
    expect(sqls).toEqual([SELECT_SETTINGS_SQL]);
  });

  it("行があれば JSON を読んで採用する(source: d1)。一部の値が不正でも、その項目だけ既定値", async () => {
    const loaded = await loadSettings(db({ settings_json: JSON.stringify({ bankroll: 500_000, perRaceCap: -5, includeComboOdds: true }) }));
    expect(loaded.source).toBe("d1");
    expect(loaded.settings.bankroll).toBe(500_000);
    expect(loaded.settings.perRaceCap).toBe(0);
    expect(loaded.settings.includeComboOdds).toBe(true);
  });

  it("JSON として読めない行は、既定値で続ける(source: invalid)。投げない", async () => {
    const loaded = await loadSettings(db({ settings_json: "{not json" }));
    expect(loaded).toEqual({ settings: DEFAULT_CLOUD_SETTINGS, source: "invalid" });
  });

  it("D1 の読み出しが失敗したら投げる(設定が読めないまま、既定値で配分を作らない)", async () => {
    const failing = {
      prepare: () => ({
        first: async () => {
          throw new Error("D1 失敗");
        },
      }),
    } as never;
    await expect(loadSettings(failing)).rejects.toThrow("D1 失敗");
  });
});
