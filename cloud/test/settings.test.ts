import { describe, expect, it } from "vitest";
import { BASE_SCORE_WEIGHT_KEYS, BIAS_WEIGHT_KEYS } from "../../packages/app/src/shared/settings";
import { DEFAULT_SCORER_CONFIG } from "../../packages/core/src/scorer/config";
import { DEFAULT_PRE_RACE_OFFSET_MINUTES } from "../src/pre-race-time";
import {
  ADDITIONAL_INSTRUCTION_MAX_LENGTH,
  analysisModelFamily,
  ANALYSIS_MODEL_IDS,
  CLOUD_SETTINGS_KEYS,
  CLOUD_SETTINGS_RULES,
  coerceCloudSettings,
  DEFAULT_CLOUD_SETTINGS,
  loadSettings,
  saveSettings,
  SCORING_WEIGHT_FIELDS,
  SELECT_SETTINGS_SQL,
  UPSERT_SETTINGS_SQL,
  validateCloudSettingsForSave,
  type CloudSettings,
} from "../src/settings";

/**
 * Issue #178(#164-c): クラウド版の設定(D1 の1行)。既定値は exe の現在の既定値(`scripts/test/cloud-settings-defaults.test.ts` が exe の値との一致を固定)。
 * 行が無い・読めない・一部の値が不正なときは、exe の `coerceSettings` と同じく、その項目だけ既定値にする(起動を壊さない)。
 */
describe("既定値", () => {
  it("exe と同じ既定値: スコアリングの重みは core の既定値(Issue #218)、資金・1レース上限は 0(配分提案を出さない opt-in)、ケリー 0.5、組合せオッズの取得は OFF、各券種の配分は ON、EV 閾値 1.0、クリップ幅は default", () => {
    expect(DEFAULT_CLOUD_SETTINGS).toEqual({
      evThreshold: 1.0,
      additionalInstruction: "",
      clipVariant: "default",
      analysisModel: "auto",
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
      preRaceOffsetMinutes: 45,
      // Issue #218: スコアリングの重み13項目の既定値は core の DEFAULT_SCORER_CONFIG(= exe の既定値)。ここは数値を直書きして、実装の取り違えを検出する
      biasWeightTrackCondition: 1,
      biasWeightVenue: 1,
      biasWeightSeason: 1,
      biasWeightFrame: 1,
      biasWeightSummerFatigue: 1,
      biasWeightTransport: 1,
      biasWeightRotation: 1,
      baseScoreWeightRecentForm: 0.2,
      baseScoreWeightLast3f: 0.1,
      baseScoreWeightCourseDistance: 0.15,
      baseScoreWeightJockey: 0.15,
      baseScoreWeightWeightChange: 1,
      baseScoreWeightCourseFrameBias: 1,
    });
  });

  it("Issue #189: 発走何分前の既定(preRaceOffsetMinutes)は 45 で、pre-race-time.ts の定数と同じ値(定義は1か所)", () => {
    expect(DEFAULT_PRE_RACE_OFFSET_MINUTES).toBe(45);
    expect(DEFAULT_CLOUD_SETTINGS.preRaceOffsetMinutes).toBe(DEFAULT_PRE_RACE_OFFSET_MINUTES);
  });
});

describe("分析モデル(analysisModel。Issue #158)", () => {
  it("既定は auto(自動 = 最新の Sonnet。今までと同じ挙動)。選べる値は auto・sonnet・opus・haiku の4つ", () => {
    expect(DEFAULT_CLOUD_SETTINGS.analysisModel).toBe("auto");
    expect([...ANALYSIS_MODEL_IDS]).toEqual(["auto", "sonnet", "opus", "haiku"]);
  });

  it("後方互換: 項目が無い旧い行(#158 より前に保存した設定・計画のスナップショット)は auto で読め、他の項目は壊れない", () => {
    const old = coerceCloudSettings({ bankroll: 1_000_000, clipVariant: "wide15" });
    expect(old.analysisModel).toBe("auto");
    expect(old.bankroll).toBe(1_000_000);
    expect(old.clipVariant).toBe("wide15");
  });

  it.each([["不正な文字列", "gpt"], ["具体的なモデル ID", "claude-opus-5-5"], ["大文字", "Opus"], ["数値", 1], ["null", null]])("読む側: %s は、その項目だけ auto に戻す(行が壊れていても分析を止めない)", (_n, raw) => {
    const s = coerceCloudSettings({ analysisModel: raw, bankroll: 123 });
    expect(s.analysisModel).toBe("auto");
    expect(s.bankroll).toBe(123);
  });

  it.each(["sonnet", "opus", "haiku"] as const)("読む側: %s はそのまま採用する(前提: 既定の auto とは別の値)", (id) => {
    expect(id).not.toBe(DEFAULT_CLOUD_SETTINGS.analysisModel);
    expect(coerceCloudSettings({ analysisModel: id }).analysisModel).toBe(id);
  });

  it("書く側: 項目が欠けた保存は 400 相当(ok: false で fields に analysisModel)。範囲外も同じ。黙って auto に戻さない", () => {
    const { analysisModel: _omit, ...withoutModel } = FULL;
    expect(validateCloudSettingsForSave(withoutModel)).toEqual({ ok: false, fields: ["analysisModel"] });
    expect(validateCloudSettingsForSave({ ...FULL, analysisModel: "gpt" })).toEqual({ ok: false, fields: ["analysisModel"] });
    expect(validateCloudSettingsForSave({ ...FULL, analysisModel: "haiku" })).toMatchObject({ ok: true });
  });

  it("系統への対応: auto は sonnet(自動 = 最新の Sonnet)、sonnet・opus・haiku はそのまま", () => {
    expect(ANALYSIS_MODEL_IDS.map((id) => [id, analysisModelFamily(id)])).toEqual([["auto", "sonnet"], ["sonnet", "sonnet"], ["opus", "opus"], ["haiku", "haiku"]]);
  });
});

describe("スコアリングの重み13項目(Issue #218。exe のバイアス7・基礎6。キーは平坦な接頭辞つき)", () => {
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

  it("対応表は13行: exe のキー(BIAS_WEIGHT_KEYS 7 → BASE_SCORE_WEIGHT_KEYS 6)と同じ順・同じ集合で、cloud のキー名 = 接頭辞(biasWeight / baseScoreWeight)+ exe のキー(先頭大文字)。cloud のキーは重複しない", () => {
    expect(SCORING_WEIGHT_FIELDS.length).toBe(13);
    expect(BIAS_WEIGHT_KEYS.length + BASE_SCORE_WEIGHT_KEYS.length).toBe(13);
    expect(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "bias").map((f) => f.exeKey)).toEqual([...BIAS_WEIGHT_KEYS]);
    expect(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "base").map((f) => f.exeKey)).toEqual([...BASE_SCORE_WEIGHT_KEYS]);
    for (const f of SCORING_WEIGHT_FIELDS) {
      expect(f.field, f.exeKey).toBe(`${f.group === "bias" ? "biasWeight" : "baseScoreWeight"}${cap(f.exeKey)}`);
    }
    expect(new Set(SCORING_WEIGHT_FIELDS.map((f) => f.field)).size).toBe(13);
    // 表の並びは、CloudSettings の項目(CLOUD_SETTINGS_KEYS)にそのまま含まれる
    for (const f of SCORING_WEIGHT_FIELDS) {
      expect(CLOUD_SETTINGS_KEYS.includes(f.field), f.field).toBe(true);
    }
  });

  it("既定値は core の DEFAULT_SCORER_CONFIG(= exe の既定値)と、13項目すべて同じ。既定値は1種類ではない(0.2 などを含む=取り違えを検出できる)", () => {
    for (const f of SCORING_WEIGHT_FIELDS) {
      const expected = f.group === "bias" ? (DEFAULT_SCORER_CONFIG.weights as unknown as Record<string, number>)[f.exeKey] : (DEFAULT_SCORER_CONFIG.baseScore.weights as unknown as Record<string, number>)[f.exeKey];
      expect(typeof expected, f.exeKey).toBe("number");
      expect(DEFAULT_CLOUD_SETTINGS[f.field], f.field).toBe(expected);
    }
    expect(new Set(SCORING_WEIGHT_FIELDS.map((f) => DEFAULT_CLOUD_SETTINGS[f.field])).size).toBeGreaterThan(3);
  });

  it("後方互換: 重みの項目が無い旧い行(今の本番)は、13項目すべて既定値で読め、他の項目は壊れない", () => {
    const old = coerceCloudSettings({ bankroll: 1_000_000, evThreshold: 1.5 });
    for (const f of SCORING_WEIGHT_FIELDS) expect(old[f.field], f.field).toBe(DEFAULT_CLOUD_SETTINGS[f.field]);
    expect(old.bankroll).toBe(1_000_000);
    expect(old.evThreshold).toBe(1.5);
  });

  it("読む側: 1項目が不正でも、その項目だけ既定値に戻り、他の12項目の保存値は残る(exe の coerceBiasWeights と同じ粒度)", () => {
    for (const target of SCORING_WEIGHT_FIELDS) {
      const raw: Record<string, unknown> = { ...FULL, [target.field]: -1 };
      const read = coerceCloudSettings(raw);
      expect(read[target.field], target.field).toBe(DEFAULT_CLOUD_SETTINGS[target.field]);
      for (const other of SCORING_WEIGHT_FIELDS.filter((f) => f.field !== target.field)) {
        expect(FULL[other.field], `前提: ${other.field} は既定値と別の値`).not.toBe(DEFAULT_CLOUD_SETTINGS[other.field]);
        expect(read[other.field], `${target.field} が不正でも ${other.field} は残る`).toBe(FULL[other.field]);
      }
    }
  });

  it("書く側: 重みが欠けた保存は不可(fields にその項目名だけ)。負の値も不可。0 は可(exe と同じ >= 0)", () => {
    for (const f of SCORING_WEIGHT_FIELDS) {
      const body: Record<string, unknown> = { ...FULL };
      delete body[f.field];
      expect(validateCloudSettingsForSave(body), `欠け ${f.field}`).toEqual({ ok: false, fields: [f.field] });
      expect(validateCloudSettingsForSave({ ...FULL, [f.field]: -0.01 }), `負 ${f.field}`).toEqual({ ok: false, fields: [f.field] });
      expect(validateCloudSettingsForSave({ ...FULL, [f.field]: 0 }), `0 ${f.field}`).toMatchObject({ ok: true });
    }
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
    ["preRaceOffsetMinutes が 10 未満", { preRaceOffsetMinutes: 9 }, "preRaceOffsetMinutes", 45],
    ["preRaceOffsetMinutes が 180 超え", { preRaceOffsetMinutes: 181 }, "preRaceOffsetMinutes", 45],
    ["preRaceOffsetMinutes が小数", { preRaceOffsetMinutes: 30.5 }, "preRaceOffsetMinutes", 45],
    ["preRaceOffsetMinutes が文字列", { preRaceOffsetMinutes: "30" }, "preRaceOffsetMinutes", 45],
  ])("%s は、その項目だけ既定値に戻す", (_name, raw, key, expected) => {
    expect((coerceCloudSettings(raw) as unknown as Record<string, unknown>)[key]).toBe(expected);
  });

  it("境界: bankroll 1億ちょうど・perRaceCap 1000万ちょうど・kellyFraction 0 と 1 は採用する", () => {
    expect(coerceCloudSettings({ bankroll: 100_000_000 }).bankroll).toBe(100_000_000);
    expect(coerceCloudSettings({ perRaceCap: 10_000_000 }).perRaceCap).toBe(10_000_000);
    expect(coerceCloudSettings({ kellyFraction: 0 }).kellyFraction).toBe(0);
    expect(coerceCloudSettings({ kellyFraction: 1 }).kellyFraction).toBe(1);
    expect(coerceCloudSettings({ preRaceOffsetMinutes: 10 }).preRaceOffsetMinutes).toBe(10);
    expect(coerceCloudSettings({ preRaceOffsetMinutes: 180 }).preRaceOffsetMinutes).toBe(180);
  });

  it("Issue #189: 追加指示は、読む側では長さの上限を持たない(D1 に直接入れた長い行を、黙って空に戻さない)", () => {
    const long = "あ".repeat(ADDITIONAL_INSTRUCTION_MAX_LENGTH + 500);
    expect(coerceCloudSettings({ additionalInstruction: long }).additionalInstruction).toBe(long);
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

  it.each([["null"], ["[]"], ["123"], ['"文字列"'], ["true"]])("Issue #189: JSON としては有効でも、オブジェクトでない行(%s)は、既定値で続ける(source: invalid)。画面に「読めた」と出して全項目が既定値、という食い違いを作らない", async (json) => {
    const loaded = await loadSettings(db({ settings_json: json }));
    expect(loaded).toEqual({ settings: DEFAULT_CLOUD_SETTINGS, source: "invalid" });
  });

  it("Issue #189: 空のオブジェクト({})は、オブジェクトなので source: d1(全項目が既定値になるが、行は読めている)", async () => {
    const loaded = await loadSettings(db({ settings_json: "{}" }));
    expect(loaded).toEqual({ settings: DEFAULT_CLOUD_SETTINGS, source: "d1" });
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

/** 全項目が有効な設定(既定値とは別の値。書き込みの検証が全項目を通ることの確認に使う)。 */
const FULL: CloudSettings = {
  evThreshold: 1.2,
  additionalInstruction: "人気薄は慎重に",
  clipVariant: "wide15",
  analysisModel: "opus",
  bankroll: 500_000,
  perRaceCap: 50_000,
  kellyFraction: 0.25,
  includeComboOdds: true,
  includeWideInAllocation: false,
  includeTrioInAllocation: false,
  includeQuinellaInAllocation: true,
  includeExactaInAllocation: false,
  includeTrifectaInAllocation: true,
  includeBracketQuinellaInAllocation: false,
  preRaceOffsetMinutes: 60,
  // Issue #218: 重み13項目は、すべて既定値とは別の値(保存・読み戻しで取り違えないことの確認に使う)
  biasWeightTrackCondition: 0.5,
  biasWeightVenue: 0.6,
  biasWeightSeason: 0.7,
  biasWeightFrame: 0.8,
  biasWeightSummerFatigue: 0.9,
  biasWeightTransport: 1.1,
  biasWeightRotation: 1.2,
  baseScoreWeightRecentForm: 0.25,
  baseScoreWeightLast3f: 0.35,
  baseScoreWeightCourseDistance: 0.45,
  baseScoreWeightJockey: 0.55,
  baseScoreWeightWeightChange: 0.65,
  baseScoreWeightCourseFrameBias: 0.75,
};

/** スコアリングの重みの境界値(Issue #218。exe の `isValidWeight` と同じ: 有限な数で 0 以上。上限は無い)。読む側も書く側も同じ。 */
const WEIGHT_OK: readonly unknown[] = [0, 0.05, 0.15, 1, 100, 1e300, Number.MAX_VALUE];
const WEIGHT_NG: readonly unknown[] = [-0.0001, -1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NaN, "1", "", null, true, [1], {}];

/**
 * 項目ごとの境界値の表(Issue #189)。`read`・`write` は、その値を読む側・書く側が受け入れるか。
 * 書く側は読む側の部分集合(write なら必ず read)。読めるが書けない値(kelly の 0〜0.05 未満)だけが、部分集合が真の部分集合である箇所。
 */
const BOUNDARIES: ReadonlyArray<{ key: keyof CloudSettings; raw: unknown; read: boolean; write: boolean }> = [
  ...[0, 1, 50_000, 100_000_000].map((raw) => ({ key: "bankroll" as const, raw, read: true, write: true })),
  ...[-1, 100_000_001, 1000.5, "1000", null, Number.NaN].map((raw) => ({ key: "bankroll" as const, raw, read: false, write: false })),
  ...[0, 1, 10_000_000].map((raw) => ({ key: "perRaceCap" as const, raw, read: true, write: true })),
  ...[-1, 10_000_001, 0.5, "1"].map((raw) => ({ key: "perRaceCap" as const, raw, read: false, write: false })),
  ...[Number.MIN_VALUE, 0.01, 1, 1.5, 100].map((raw) => ({ key: "evThreshold" as const, raw, read: true, write: true })),
  ...[0, -0.1, "1", Number.NaN].map((raw) => ({ key: "evThreshold" as const, raw, read: false, write: false })),
  ...[0.05, 0.5, 1].map((raw) => ({ key: "kellyFraction" as const, raw, read: true, write: true })),
  ...[0, 0.01, 0.04999].map((raw) => ({ key: "kellyFraction" as const, raw, read: true, write: false })),
  ...[-0.01, 1.0001, "0.5", Number.NaN].map((raw) => ({ key: "kellyFraction" as const, raw, read: false, write: false })),
  ...[10, 11, 45, 179, 180].map((raw) => ({ key: "preRaceOffsetMinutes" as const, raw, read: true, write: true })),
  ...[0, 9, 181, 10.5, "45", Number.NaN].map((raw) => ({ key: "preRaceOffsetMinutes" as const, raw, read: false, write: false })),
  ...["default", "wide15"].map((raw) => ({ key: "clipVariant" as const, raw, read: true, write: true })),
  ...["wide99", "", 1, null].map((raw) => ({ key: "clipVariant" as const, raw, read: false, write: false })),
  // Issue #158: 分析モデルは4値の列挙。読む側も書く側も同じ(部分集合が真部分集合でない)
  ...["auto", "sonnet", "opus", "haiku"].map((raw) => ({ key: "analysisModel" as const, raw, read: true, write: true })),
  ...["", "Opus", "OPUS", "gpt", "claude-opus-5-5", "fable", 1, null, true].map((raw) => ({ key: "analysisModel" as const, raw, read: false, write: false })),
  ...["", "x", "あ".repeat(ADDITIONAL_INSTRUCTION_MAX_LENGTH)].map((raw) => ({ key: "additionalInstruction" as const, raw, read: true, write: true })),
  ...["あ".repeat(ADDITIONAL_INSTRUCTION_MAX_LENGTH + 1)].map((raw) => ({ key: "additionalInstruction" as const, raw, read: true, write: false })),
  ...[1, null].map((raw) => ({ key: "additionalInstruction" as const, raw, read: false, write: false })),
  ...SCORING_WEIGHT_FIELDS.flatMap(({ field }) => [
    ...WEIGHT_OK.map((raw) => ({ key: field, raw, read: true, write: true })),
    ...WEIGHT_NG.map((raw) => ({ key: field, raw, read: false, write: false })),
  ]),
  ...(
    [
      "includeComboOdds",
      "includeWideInAllocation",
      "includeTrioInAllocation",
      "includeQuinellaInAllocation",
      "includeExactaInAllocation",
      "includeTrifectaInAllocation",
      "includeBracketQuinellaInAllocation",
    ] as const
  ).flatMap((key) => [
    { key, raw: true, read: true, write: true },
    { key, raw: false, read: true, write: true },
    { key, raw: "true", read: false, write: false },
    { key, raw: 1, read: false, write: false },
    { key, raw: null, read: false, write: false },
  ]),
];

describe("範囲の述語(項目ごとに1か所。読む側 coerce と書く側 validate が同じ表を使う。Issue #189)", () => {
  it("表のキー集合は、既定値のキー集合(= CloudSettings の全項目)と一致する。境界値の表も全項目を覆う", () => {
    expect([...CLOUD_SETTINGS_KEYS].sort()).toEqual(Object.keys(DEFAULT_CLOUD_SETTINGS).sort());
    expect(Object.keys(CLOUD_SETTINGS_RULES).sort()).toEqual(Object.keys(DEFAULT_CLOUD_SETTINGS).sort());
    expect([...new Set(BOUNDARIES.map((b) => b.key))].sort()).toEqual(Object.keys(DEFAULT_CLOUD_SETTINGS).sort());
  });

  it("各項目の fallback は、その項目の既定値と同じ(読む側の既定値の戻し先が1か所)", () => {
    for (const key of CLOUD_SETTINGS_KEYS) {
      expect(CLOUD_SETTINGS_RULES[key].fallback, key).toEqual(DEFAULT_CLOUD_SETTINGS[key]);
    }
  });

  it.each(BOUNDARIES.map((b) => [`${b.key} = ${typeof b.raw === "string" && b.raw.length > 20 ? `(${b.raw.length}文字)` : JSON.stringify(b.raw)}`, b] as const))("%s", (_name, b) => {
    const rule = CLOUD_SETTINGS_RULES[b.key] as { isReadable(raw: unknown): boolean; isWritable(raw: unknown): boolean };
    expect(rule.isReadable(b.raw)).toBe(b.read);
    expect(rule.isWritable(b.raw)).toBe(b.write);
    // 読む側(coerce)は isReadable に従う: 読めるなら採用、読めないなら既定値
    const coerced = coerceCloudSettings({ [b.key]: b.raw })[b.key];
    if (b.read) expect(coerced).toBe(b.raw);
    else expect(coerced).toBe(DEFAULT_CLOUD_SETTINGS[b.key]);
  });

  it("部分集合: 書く側が受け入れる値は、必ず読む側も受け入れる。かつ、読めるが書けない値が実際にある(部分集合が真の部分集合になっている箇所を固定: kelly の 0〜0.05 未満と、2,001 文字の追加指示だけ)", () => {
    const writable = BOUNDARIES.filter((b) => b.write);
    expect(writable.length).toBeGreaterThan(0);
    expect(writable.every((b) => b.read)).toBe(true);
    const readOnly = BOUNDARIES.filter((b) => b.read && !b.write);
    expect(readOnly.length).toBe(4);
    expect([...new Set(readOnly.map((b) => b.key))].sort()).toEqual(["additionalInstruction", "kellyFraction"]);
  });

  it("全境界値で「保存 → 読み戻し」が一致する: 書ける値を JSON にして validate → JSON.stringify → JSON.parse → coerce しても、値が変わらない", () => {
    const writable = BOUNDARIES.filter((b) => b.write);
    for (const b of writable) {
      const body = JSON.parse(JSON.stringify({ ...FULL, [b.key]: b.raw })) as unknown;
      const checked = validateCloudSettingsForSave(body);
      expect(checked.ok, `${b.key}=${JSON.stringify(b.raw)?.slice(0, 30)}`).toBe(true);
      if (!checked.ok) continue;
      const roundTripped = coerceCloudSettings(JSON.parse(JSON.stringify(checked.settings)));
      expect(roundTripped).toEqual(checked.settings);
      expect(roundTripped[b.key]).toBe(b.raw);
    }
  });
});

describe("validateCloudSettingsForSave(全項目の置き換え。キーの欠け・未知のキー・範囲外は不可)", () => {
  it("全項目が有効なら ok で、同じ内容の設定を返す(余計なキーを足さない)", () => {
    const checked = validateCloudSettingsForSave({ ...FULL });
    expect(checked).toEqual({ ok: true, settings: FULL });
  });

  it("既定値そのもの(全項目)も通る", () => {
    expect(validateCloudSettingsForSave({ ...DEFAULT_CLOUD_SETTINGS })).toEqual({ ok: true, settings: DEFAULT_CLOUD_SETTINGS });
  });

  it.each(CLOUD_SETTINGS_KEYS.map((key) => [key] as const))("キー %s が欠けていたら不可(fields にその項目名だけ)", (key) => {
    const body: Record<string, unknown> = { ...FULL };
    delete body[key];
    expect(validateCloudSettingsForSave(body)).toEqual({ ok: false, fields: [key] });
  });

  it("範囲外の項目は fields に出る(複数あれば全部。順序は CloudSettings の項目順)", () => {
    const checked = validateCloudSettingsForSave({ ...FULL, bankroll: -1, kellyFraction: 0.01, preRaceOffsetMinutes: 5 });
    expect(checked).toEqual({ ok: false, fields: ["bankroll", "kellyFraction", "preRaceOffsetMinutes"] });
  });

  it("未知のキーは不可。未知のキー名は結果に写さない(fields は既知の項目名だけ)", () => {
    const checked = validateCloudSettingsForSave({ ...FULL, secretKey: "x" });
    expect(checked.ok).toBe(false);
    expect(JSON.stringify(checked)).not.toContain("secretKey");
    expect(checked).toEqual({ ok: false, fields: [] });
  });

  it("__proto__ という名前の own キー(JSON.parse が作る)も未知のキーとして不可", () => {
    const body = JSON.parse(`{"__proto__":{"bankroll":1},${JSON.stringify(FULL).slice(1)}`) as unknown;
    expect(Object.keys(body as object)).toContain("__proto__");
    expect(validateCloudSettingsForSave(body).ok).toBe(false);
  });

  it("オブジェクトでない入力(null・配列・文字列・数値)は不可", () => {
    for (const raw of [null, undefined, [], "x", 5]) {
      expect(validateCloudSettingsForSave(raw).ok, String(raw)).toBe(false);
    }
  });

  it("追加指示は 2,000 文字(UTF-16 コード単位。`.length`)まで: 2,000 は可、2,001 は不可", () => {
    expect(ADDITIONAL_INSTRUCTION_MAX_LENGTH).toBe(2000);
    expect(validateCloudSettingsForSave({ ...FULL, additionalInstruction: "a".repeat(2000) }).ok).toBe(true);
    expect(validateCloudSettingsForSave({ ...FULL, additionalInstruction: "a".repeat(2001) })).toEqual({ ok: false, fields: ["additionalInstruction"] });
  });
});

describe("saveSettings(D1 の1行に UPSERT)", () => {
  function writeDb(record: Array<{ sql: string; args: unknown[] }>, fail = false): Parameters<typeof saveSettings>[0] {
    return {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            record.push({ sql, args });
            if (fail) throw new Error("D1 失敗");
            return {};
          },
        }),
      }),
    } as never;
  }

  it("UPSERT の1文を、(設定の JSON, 更新時刻)で1回だけ実行する。JSON は全項目で、読み戻すと同じ", async () => {
    const record: Array<{ sql: string; args: unknown[] }> = [];
    await saveSettings(writeDb(record), FULL, "2026-10-07T01:02:03.000Z");
    expect(record.length).toBe(1);
    expect(record[0]!.sql).toBe(UPSERT_SETTINGS_SQL);
    expect(record[0]!.args.length).toBe(2);
    expect(record[0]!.args[1]).toBe("2026-10-07T01:02:03.000Z");
    expect(JSON.parse(record[0]!.args[0] as string)).toEqual(FULL);
    expect(Object.keys(JSON.parse(record[0]!.args[0] as string) as object).length).toBe(28); // 既存の15項目 + 重み13項目
    expect(Object.keys(JSON.parse(record[0]!.args[0] as string) as object).length).toBe(Object.keys(DEFAULT_CLOUD_SETTINGS).length);
  });

  it("UPSERT の文は id = 1 の1行だけを対象にする(CHECK 制約と同じ。id を引数にしない)", () => {
    expect(UPSERT_SETTINGS_SQL).toContain("cloud_settings");
    expect(UPSERT_SETTINGS_SQL).toContain("VALUES (1, ?, ?)");
    expect(UPSERT_SETTINGS_SQL).toContain("ON CONFLICT(id) DO UPDATE");
  });

  it("D1 の書き込みが失敗したら投げる", async () => {
    await expect(saveSettings(writeDb([], true), FULL, "2026-10-07T00:00:00.000Z")).rejects.toThrow("D1 失敗");
  });
});
