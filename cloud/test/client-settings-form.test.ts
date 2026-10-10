import { describe, expect, it } from "vitest";
import { CLIP_VARIANTS } from "@keiba/core/analyzer/clip-variants";
import { ALLOCATION_BET_TYPE_LABELS, BASE_SCORE_WEIGHT_LABELS, BET_ALLOCATION_LABELS, BIAS_WEIGHT_LABELS, CLIP_VARIANT_IDS, INCLUDE_COMBO_ODDS_LABELS, isValidWeight } from "../../packages/app/src/shared/settings";
import {
  buildSettingsModel,
  draftFromSettings,
  FIELD_ORDER,
  resetWeightsInDraft,
  setDraftValue,
  SOURCE_NOTE_DEFAULT,
  SOURCE_NOTE_INVALID,
  validateDraft,
  WEIGHT_FIELD_ORDER,
  type FieldKind,
  type SettingsModelInput,
} from "../client/settings-form";
import { buildPreviewText } from "../client/prompt-preview";
import { ANALYSIS_MODEL_IDS, CLOUD_SETTINGS_KEYS, DEFAULT_CLOUD_SETTINGS, SCORING_WEIGHT_FIELDS, type CloudSettings } from "../src/settings";

/**
 * Issue #189(段階2): 設定画面の下書き(文字列)・検証(書く側の述語 `isWritable` を使う)・表示用データ。純関数。
 * 並びは exe の設定画面(`SettingsView.tsx`)に揃える。ラベルは exe の共有定数を流用し、補助文は cloud の実際の挙動に合わせて書き直している。
 */

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
  // Issue #218: 重み13項目は、すべて既定値とは別の値
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

describe("FIELD_ORDER(exe の設定画面の並び。分析モデル・発走何分前は cloud 専用で後ろ)", () => {
  it("EV閾値 → 組合せオッズ → 各券種(ワイド・馬連・枠連・馬単・三連複・三連単)→ 資金・上限・ケリー → 追加指示 → クリップ幅 → 分析モデル → 発走何分前", () => {
    expect(FIELD_ORDER).toEqual([
      "evThreshold",
      "includeComboOdds",
      "includeWideInAllocation",
      "includeQuinellaInAllocation",
      "includeBracketQuinellaInAllocation",
      "includeExactaInAllocation",
      "includeTrioInAllocation",
      "includeTrifectaInAllocation",
      "bankroll",
      "perRaceCap",
      "kellyFraction",
      "additionalInstruction",
      "clipVariant",
      "analysisModel",
      "preRaceOffsetMinutes",
    ]);
  });

  it("設定の全項目 = FIELD_ORDER(15項目)+ WEIGHT_FIELD_ORDER(スコアリングの重み13項目。Issue #218)を、重複なく過不足なく含む(項目を足したらここで落ちる)", () => {
    expect(FIELD_ORDER.length).toBe(15);
    expect(WEIGHT_FIELD_ORDER.length).toBe(13);
    const all = [...FIELD_ORDER, ...WEIGHT_FIELD_ORDER];
    expect(new Set(all).size).toBe(28);
    expect(all.length).toBe(CLOUD_SETTINGS_KEYS.length);
    expect([...all].sort()).toEqual([...CLOUD_SETTINGS_KEYS].sort());
  });

  it("WEIGHT_FIELD_ORDER は対応表(SCORING_WEIGHT_FIELDS)の並び = exe の設定画面の並び(バイアス7 → 基礎6)", () => {
    expect([...WEIGHT_FIELD_ORDER]).toEqual(SCORING_WEIGHT_FIELDS.map((f) => f.field));
  });
});

describe("draftFromSettings / setDraftValue", () => {
  it("数値・文字列・選択は文字列、真偽は真偽値の下書きになる", () => {
    const draft = draftFromSettings(FULL);
    expect(draft.bankroll).toBe("500000");
    expect(draft.kellyFraction).toBe("0.25");
    expect(draft.evThreshold).toBe("1.2");
    expect(draft.preRaceOffsetMinutes).toBe("60");
    expect(draft.additionalInstruction).toBe("人気薄は慎重に");
    expect(draft.clipVariant).toBe("wide15");
    expect(draft.includeComboOdds).toBe(true);
    expect(draft.includeWideInAllocation).toBe(false);
    // Issue #218: 重みも文字列(入力した文字のまま)
    expect(draft.biasWeightTrackCondition).toBe("0.5");
    expect(draft.baseScoreWeightCourseFrameBias).toBe("0.75");
    expect(WEIGHT_FIELD_ORDER.every((k) => typeof draft[k] === "string")).toBe(true);
  });

  it("setDraftValue: 真偽の項目は \"true\"・\"false\" を真偽値に、それ以外は文字列のまま。元の下書きは変えない", () => {
    const draft = draftFromSettings(FULL);
    const next = setDraftValue(setDraftValue(setDraftValue(draft, "includeComboOdds", "false"), "bankroll", "123"), "additionalInstruction", "a\nb");
    expect(next.includeComboOdds).toBe(false);
    expect(next.bankroll).toBe("123");
    expect(next.additionalInstruction).toBe("a\nb");
    expect(draft.includeComboOdds).toBe(true);
    expect(draft.bankroll).toBe("500000");
    expect(setDraftValue(draft, "includeWideInAllocation", "true").includeWideInAllocation).toBe(true);
  });

  it("setDraftValue: 未知の項目は無視する(下書きは変わらない)", () => {
    const draft = draftFromSettings(FULL);
    expect(setDraftValue(draft, "secret" as never, "x")).toEqual(draft);
  });
});

describe("validateDraft(書く側の範囲。保存の押下時に1回)", () => {
  it("全項目が有効なら、数値に直した設定を返す(下書きの往復で元に戻る)", () => {
    expect(validateDraft(draftFromSettings(FULL))).toEqual({ ok: true, settings: FULL });
    expect(validateDraft(draftFromSettings(DEFAULT_CLOUD_SETTINGS))).toEqual({ ok: true, settings: DEFAULT_CLOUD_SETTINGS });
  });

  const CASES: ReadonlyArray<readonly [string, keyof CloudSettings, string, boolean]> = [
    ["bankroll 0", "bankroll", "0", true],
    ["bankroll 1億", "bankroll", "100000000", true],
    ["bankroll 1億+1", "bankroll", "100000001", false],
    ["bankroll 負", "bankroll", "-1", false],
    ["bankroll 小数", "bankroll", "1000.5", false],
    ["bankroll 空", "bankroll", "", false],
    ["bankroll 空白だけ", "bankroll", "   ", false],
    ["bankroll 文字", "bankroll", "abc", false],
    ["bankroll 前後の空白は除く", "bankroll", " 100 ", true],
    ["bankroll 指数表記(1e3 = 1000)", "bankroll", "1e3", true],
    ["bankroll 16進", "bankroll", "0x10", false],
    ["bankroll Infinity", "bankroll", "Infinity", false],
    ["bankroll 全角数字", "bankroll", "１００", false],
    ["bankroll カンマ区切り", "bankroll", "1,000", false],
    ["perRaceCap 1000万", "perRaceCap", "10000000", true],
    ["perRaceCap 1000万+1", "perRaceCap", "10000001", false],
    ["perRaceCap 小数", "perRaceCap", "0.5", false],
    ["evThreshold 0", "evThreshold", "0", false],
    ["evThreshold 0.01", "evThreshold", "0.01", true],
    ["evThreshold 負", "evThreshold", "-1", false],
    ["kelly 0.05", "kellyFraction", "0.05", true],
    ["kelly 1", "kellyFraction", "1", true],
    ["kelly 0.04999(読む側では有効だが書く側は不可)", "kellyFraction", "0.04999", false],
    ["kelly 0", "kellyFraction", "0", false],
    ["kelly 1.01", "kellyFraction", "1.01", false],
    ["発走何分前 10", "preRaceOffsetMinutes", "10", true],
    ["発走何分前 180", "preRaceOffsetMinutes", "180", true],
    ["発走何分前 9", "preRaceOffsetMinutes", "9", false],
    ["発走何分前 181", "preRaceOffsetMinutes", "181", false],
    ["発走何分前 小数", "preRaceOffsetMinutes", "30.5", false],
    ["clipVariant 未知", "clipVariant", "wide99", false],
    ["clipVariant 空", "clipVariant", "", false],
    ["clipVariant default", "clipVariant", "default", true],
    ["analysisModel 未知", "analysisModel", "gpt", false],
    ["analysisModel 空", "analysisModel", "", false],
    ["analysisModel 大文字", "analysisModel", "Opus", false],
    ...(["auto", "sonnet", "opus", "haiku"] as const).map((id) => [`analysisModel ${id}`, "analysisModel", id, true] as const),
    ["追加指示 2000 文字", "additionalInstruction", "あ".repeat(2000), true],
    ["追加指示 2001 文字", "additionalInstruction", "あ".repeat(2001), false],
    ["追加指示 空", "additionalInstruction", "", true],
    // Issue #218: スコアリングの重み(有限な数で 0 以上。上限なし)。13項目すべてで同じ境界を、下の it.each が回す
    ["重み 0", "biasWeightVenue", "0", true],
    ["重み 小数", "baseScoreWeightRecentForm", "0.05", true],
    ["重み 大きい値(上限なし)", "biasWeightSeason", "1000000", true],
    ["重み 負", "biasWeightFrame", "-0.01", false],
    ["重み 空", "biasWeightRotation", "", false],
    ["重み 文字", "baseScoreWeightJockey", "abc", false],
    ["重み Infinity", "baseScoreWeightLast3f", "Infinity", false],
    ["重み 全角数字", "baseScoreWeightCourseDistance", "１", false],
    ["重み カンマ区切り", "biasWeightTransport", "1,5", false],
  ];
  it.each(CASES)("%s", (_name, key, text, ok) => {
    const result = validateDraft(setDraftValue(draftFromSettings(DEFAULT_CLOUD_SETTINGS), key, text));
    expect(result.ok).toBe(ok);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual([key]); // 他の項目は有効なので、その項目だけが失敗
      expect(result.errors[key]!.length).toBeGreaterThan(5);
    }
  });

  it.each(WEIGHT_FIELD_ORDER.flatMap((key) => [[key, "0", true], [key, "0.5", true], [key, "12", true], [key, "-0.5", false], [key, "", false], [key, "x", false]] as const))("Issue #218: 重み %s = %j は ok=%s(13項目すべて同じ境界。不正なら、その項目だけがエラー)", (key, text, ok) => {
    const result = validateDraft(setDraftValue(draftFromSettings(DEFAULT_CLOUD_SETTINGS), key, text));
    expect(result.ok).toBe(ok);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual([key]);
      expect(result.errors[key]).toContain("0以上の数値");
    }
  });

  it("Issue #218: 重みの入力の検証は exe の isValidWeight と一致する(同じ文字列で同じ判定)。違うのは、cloud が 16 進(0x10)・カンマなどを数値として受けない点だけ(既存の数値欄と同じ流儀)", () => {
    const inputs = ["0", "0.0", "0.05", "1", "3", "10", "1e3", " 2 ", "-0.1", "-1", "", "   ", "abc", "Infinity", "-Infinity", "NaN", "1,5", "１", "1.2.3", "0x10"];
    const differences: string[] = [];
    for (const text of inputs) {
      const cloud = validateDraft(setDraftValue(draftFromSettings(DEFAULT_CLOUD_SETTINGS), "biasWeightVenue", text)).ok;
      if (cloud !== isValidWeight(text)) differences.push(text);
    }
    expect(inputs.filter((t) => isValidWeight(t)).length).toBeGreaterThan(5); // 前提: 有効な入力が十分ある(空振りでない)
    expect(inputs.filter((t) => !isValidWeight(t)).length).toBeGreaterThan(5);
    expect(differences).toEqual(["0x10"]);
  });

  it("複数の項目が不正なら、項目ごとにエラー。有効な項目にはエラーを付けない", () => {
    let draft = draftFromSettings(DEFAULT_CLOUD_SETTINGS);
    draft = setDraftValue(setDraftValue(draft, "bankroll", "x"), "preRaceOffsetMinutes", "5");
    const result = validateDraft(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["bankroll", "preRaceOffsetMinutes"]);
  });

  it("エラーの文言(項目ごとの固定の文言。範囲を示す)。追加指示は文字数つき", () => {
    const run = (key: keyof CloudSettings, text: string) => {
      const r = validateDraft(setDraftValue(draftFromSettings(DEFAULT_CLOUD_SETTINGS), key, text));
      if (r.ok) throw new Error("失敗するはず");
      return r.errors[key]!;
    };
    expect(run("bankroll", "-1")).toContain("100,000,000");
    expect(run("perRaceCap", "-1")).toContain("10,000,000");
    expect(run("evThreshold", "0")).toContain("0より大きい");
    expect(run("kellyFraction", "0")).toContain("0.05");
    expect(run("preRaceOffsetMinutes", "5")).toContain("10");
    expect(run("preRaceOffsetMinutes", "5")).toContain("180");
    expect(run("additionalInstruction", "あ".repeat(2003))).toContain("2,000");
    expect(run("additionalInstruction", "あ".repeat(2003))).toContain("2003");
  });

  it("追加指示の文字数は UTF-16 コード単位(`.length`)。サロゲートペア(𠮷)は 2 と数える(サーバ・maxlength と同じ単位)", () => {
    const edge = "a".repeat(1999) + "𠮷";
    expect(edge.length).toBe(2001);
    expect(validateDraft(setDraftValue(draftFromSettings(DEFAULT_CLOUD_SETTINGS), "additionalInstruction", edge)).ok).toBe(false);
  });
});

const READY_INPUT = (over: Partial<SettingsModelInput> = {}): SettingsModelInput => ({
  load: { kind: "ready", source: "d1" },
  draft: draftFromSettings(FULL),
  errors: {},
  save: { kind: "idle" },
  ...over,
});

describe("buildSettingsModel", () => {
  it("読み込み中: 項目なし・loading", () => {
    const m = buildSettingsModel({ load: { kind: "loading" }, draft: null, errors: {}, save: { kind: "idle" } });
    expect(m.kind).toBe("settings");
    expect(m.loading).toBe(true);
    expect(m.fields).toEqual([]);
    expect(m.error).toBeNull();
    expect(m.backHref).toBe("#");
  });

  it("取得の失敗: 固定の文言・項目なし・再読込できる(loading でない)", () => {
    const m = buildSettingsModel({ load: { kind: "error", message: "取得できませんでした" }, draft: null, errors: {}, save: { kind: "idle" } });
    expect(m.error).toBe("取得できませんでした");
    expect(m.loading).toBe(false);
    expect(m.fields).toEqual([]);
    expect(m.sourceNote).toBeNull();
  });

  it("取得済み: 15 項目を FIELD_ORDER の順に、下書きの値で出す", () => {
    const m = buildSettingsModel(READY_INPUT());
    expect(m.fields.map((f) => f.key)).toEqual([...FIELD_ORDER]);
    const byKey = Object.fromEntries(m.fields.map((f) => [f.key, f]));
    expect(byKey["bankroll"]!.value).toBe("500000");
    expect(byKey["includeComboOdds"]!.value).toBe(true);
    expect(byKey["clipVariant"]!.value).toBe("wide15");
    expect(byKey["analysisModel"]!.value).toBe("opus");
    expect(byKey["additionalInstruction"]!.value).toBe("人気薄は慎重に");
    expect(m.loading).toBe(false);
  });

  it("入力の種類: 真偽は checkbox・追加指示は textarea・クリップ幅・分析モデルは select・数値は text(inputmode で数字のキーボード)", () => {
    const m = buildSettingsModel(READY_INPUT());
    const kinds = Object.fromEntries(m.fields.map((f) => [f.key, f.kind])) as Record<string, FieldKind>;
    for (const key of ["includeComboOdds", "includeWideInAllocation", "includeQuinellaInAllocation", "includeBracketQuinellaInAllocation", "includeExactaInAllocation", "includeTrioInAllocation", "includeTrifectaInAllocation"]) {
      expect(kinds[key], key).toBe("checkbox");
    }
    expect(kinds["additionalInstruction"]).toBe("textarea");
    expect(kinds["clipVariant"]).toBe("select");
    expect(kinds["analysisModel"]).toBe("select");
    for (const key of ["evThreshold", "bankroll", "perRaceCap", "kellyFraction", "preRaceOffsetMinutes"]) {
      expect(kinds[key], key).toBe("text");
    }
    const byKey = Object.fromEntries(m.fields.map((f) => [f.key, f]));
    expect(byKey["bankroll"]!.inputmode).toBe("numeric");
    expect(byKey["perRaceCap"]!.inputmode).toBe("numeric");
    expect(byKey["preRaceOffsetMinutes"]!.inputmode).toBe("numeric");
    expect(byKey["evThreshold"]!.inputmode).toBe("decimal");
    expect(byKey["kellyFraction"]!.inputmode).toBe("decimal");
    expect(byKey["additionalInstruction"]!.maxlength).toBe("2000");
    expect(byKey["bankroll"]!.maxlength).toBeNull();
  });

  it("ラベル: exe の共有定数を流用する(資金・1レースの上限・ケリー係数・組合せオッズ・6 券種)", () => {
    const byKey = Object.fromEntries(buildSettingsModel(READY_INPUT()).fields.map((f) => [f.key, f.label]));
    expect(byKey["bankroll"]).toBe(BET_ALLOCATION_LABELS.bankroll);
    expect(byKey["perRaceCap"]).toBe(BET_ALLOCATION_LABELS.perRaceCap);
    expect(byKey["kellyFraction"]).toBe(BET_ALLOCATION_LABELS.kellyFraction);
    expect(byKey["includeComboOdds"]).toBe(INCLUDE_COMBO_ODDS_LABELS.checkbox);
    expect(byKey["includeWideInAllocation"]).toBe(ALLOCATION_BET_TYPE_LABELS.wide.checkbox);
    expect(byKey["includeQuinellaInAllocation"]).toBe(ALLOCATION_BET_TYPE_LABELS.quinella.checkbox);
    expect(byKey["includeBracketQuinellaInAllocation"]).toBe(ALLOCATION_BET_TYPE_LABELS.bracketQuinella.checkbox);
    expect(byKey["includeExactaInAllocation"]).toBe(ALLOCATION_BET_TYPE_LABELS.exacta.checkbox);
    expect(byKey["includeTrioInAllocation"]).toBe(ALLOCATION_BET_TYPE_LABELS.trio.checkbox);
    expect(byKey["includeTrifectaInAllocation"]).toBe(ALLOCATION_BET_TYPE_LABELS.trifecta.checkbox);
  });

  it("クリップ幅の選択肢: exe と同じ版 ID の順。ラベルの幅(±10%・±15%)は core の CLIP_VARIANTS から導いた値と一致する", () => {
    const select = buildSettingsModel(READY_INPUT()).fields.find((f) => f.key === "clipVariant")!;
    expect(select.options!.map((o) => o.value)).toEqual([...CLIP_VARIANT_IDS]);
    for (const option of select.options!) {
      const percent = Math.round(CLIP_VARIANTS[option.value as keyof typeof CLIP_VARIANTS].maxAdjust * 100);
      expect(option.label, option.value).toContain(`±${percent}%`);
    }
    expect(select.options!.find((o) => o.value === "default")!.label).toContain("既定");
  });

  it("分析モデルの選択肢(Issue #158): 自動(最新の Sonnet)・Sonnet・Opus・Haiku の4つがこの順。日付付きスナップショット等の個別の ID は並べない。ラベルに系統名が入る", () => {
    const select = buildSettingsModel(READY_INPUT()).fields.find((f) => f.key === "analysisModel")!;
    expect(select.options!.map((o) => o.value)).toEqual(["auto", "sonnet", "opus", "haiku"]);
    expect([...ANALYSIS_MODEL_IDS]).toEqual(["auto", "sonnet", "opus", "haiku"]);
    const label = Object.fromEntries(select.options!.map((o) => [o.value, o.label]));
    expect(label["auto"]).toContain("自動");
    expect(label["auto"]).toContain("最新の Sonnet");
    expect(label["sonnet"]).toContain("Sonnet");
    expect(label["opus"]).toContain("Opus");
    expect(label["haiku"]).toContain("Haiku");
    for (const option of select.options!) {
      expect(option.label, option.value).not.toMatch(/\d{8}|claude-/); // 日付付きの ID・具体的な ID を並べない
    }
  });

  it("分析モデルの補助文(Issue #158): 「自動」はアプリの推奨に任せる(今は最新の Sonnet)・費用は相対表現(金額・倍率を書かない)・使えないときは固定モデルで続ける・API キー未登録の間は効かない・次に始まる発走前の分析から", () => {
    const help = buildSettingsModel(READY_INPUT()).fields.find((f) => f.key === "analysisModel")!.help ?? "";
    expect(help).toContain("アプリの推奨に任せ");
    expect(help).toContain("今は最新の Sonnet");
    expect(help).toContain("Opus は Sonnet より費用が高く");
    expect(help).toContain("Haiku は安く");
    expect(help).not.toMatch(/[0-9]+\s*(円|ドル|倍)|\$|¥/); // 価格改定で嘘にならないよう、金額・倍率を書かない
    expect(help).toContain("固定モデル");
    expect(help).toContain("API キーが未登録の間は LLM を使わない");
    expect(help).toContain("次に始まる発走前の分析から");
  });

  it("補助文: 追加指示・クリップ幅は、LLM を使うときに効き、API キーが未登録の間は変更しても結果が変わらないことを書く(キーの有無のどちらでも嘘にならない)。発走何分前は「次の朝 9:00(日本時間)の計画から反映される。すでに計画した日の分は変わらない」(Issue #206。旧: 定時の自動実行を入れるまで効きません)", () => {
    const byKey = Object.fromEntries(buildSettingsModel(READY_INPUT()).fields.map((f) => [f.key, f.help ?? ""]));
    expect(byKey["preRaceOffsetMinutes"]).toContain("変更は、毎晩 21:00(日本時間)に行う翌日分の事前分析の計画から反映されます。その時刻より前に保存した変更は、翌日の分から効きます。すでに計画した日の分は変わりません。");
    for (const key of ["additionalInstruction", "clipVariant"]) {
      expect(byKey[key], key).toContain("LLM を使うときに効きます");
      expect(byKey[key], key).toContain("API キーが未登録の間は LLM を使わない");
      expect(byKey[key], key).toContain("変更しても分析の結果は変わりません");
      expect(byKey[key], key).not.toContain("現在は LLM を使わない"); // キーを登録すれば LLM を使うので、「現在は」と言い切らない
    }
    expect(byKey["additionalInstruction"]).toContain("2,000 文字");
    // 効いている項目には「効きません」を書かない(事実と食い違う注記を付けない)
    for (const key of ["evThreshold", "bankroll", "perRaceCap", "kellyFraction", "includeComboOdds", "includeWideInAllocation"]) {
      expect(byKey[key], key).not.toContain("効きません");
      expect(byKey[key], key).not.toContain("LLM を使わない");
    }
    // Issue #206(AC-E3): 定時の自動実行が始まったので、**どの項目の補助文にも**「効きません」が残っていない(発走何分前を含む全項目)
    expect(Object.keys(byKey).length).toBeGreaterThanOrEqual(15); // 前提: 全項目を走査している(空振りでない)
    expect(Object.keys(byKey)).toContain("preRaceOffsetMinutes");
    for (const [key, help] of Object.entries(byKey)) {
      expect(help, key).not.toContain("効きません");
      expect(help, key).not.toContain("定時の自動実行を入れるまで");
    }
  });

  it("画面に出る文(ラベル・補助文)に、Issue 番号(#数字)を書かない", () => {
    const fields = buildSettingsModel(READY_INPUT()).fields;
    expect(fields.length, "前提: 項目が出ている(0 だと検査が空振り)").toBeGreaterThan(10);
    for (const f of fields) {
      expect(f.label, `${f.key} のラベル`).not.toMatch(/#\d/);
      expect(f.help ?? "", `${f.key} の補助文`).not.toMatch(/#\d/);
    }
  });

  it("補助文(EV閾値): 複勝だけでなく組合せを含む全券種の配分の候補に効くことが分かる(閾値は複勝の EV の定義だけに読めない書き方にしない)。馬ごとの「EVプラス」と同じ値であることも書く", () => {
    const help = buildSettingsModel(READY_INPUT()).fields.find((f) => f.key === "evThreshold")!.help ?? "";
    expect(help).toContain("複勝と組合せの全券種");
    expect(help).toContain("EVプラス");
    expect(help).not.toContain("複勝オッズの下限"); // 複勝の EV の定義(3着内率 × 複勝オッズの下限)だけに効くと読める書き方
  });

  it("補助文: 各券種の配分は、組合せオッズの取得が OFF の間は効果がない旨と、既定が ON である旨。組合せの取得は、OFF の間は組合せの券種が配分に入らない旨と、三連単は中央のみ", () => {
    const byKey = Object.fromEntries(buildSettingsModel(READY_INPUT()).fields.map((f) => [f.key, f.help ?? ""]));
    for (const key of ["includeWideInAllocation", "includeQuinellaInAllocation", "includeBracketQuinellaInAllocation", "includeExactaInAllocation", "includeTrioInAllocation", "includeTrifectaInAllocation"]) {
      expect(byKey[key], key).toContain("既定は ON");
      expect(byKey[key], key).toContain("OFF の間は効果がありません");
    }
    expect(byKey["includeComboOdds"]).toContain("OFF の間は、組合せの券種は配分に入りません");
    expect(byKey["includeComboOdds"]).toContain("三連単は中央競馬のみ");
    expect(byKey["bankroll"]).toContain("0 のままだと配分の提案は出ません");
    expect(byKey["perRaceCap"]).toContain("0 のままだと配分の提案は出ません");
  });

  it("source の注記: default は「まだ保存されていません(既定値を表示)」・invalid は「保存済みの設定が読めないため、既定値を表示しています」・d1 は注記なし", () => {
    expect(buildSettingsModel(READY_INPUT({ load: { kind: "ready", source: "default" } })).sourceNote).toBe(SOURCE_NOTE_DEFAULT);
    expect(buildSettingsModel(READY_INPUT({ load: { kind: "ready", source: "invalid" } })).sourceNote).toBe(SOURCE_NOTE_INVALID);
    expect(buildSettingsModel(READY_INPUT({ load: { kind: "ready", source: "d1" } })).sourceNote).toBeNull();
    expect(SOURCE_NOTE_DEFAULT).toContain("まだ保存されていません");
    expect(SOURCE_NOTE_DEFAULT).toContain("既定値を表示");
    expect(SOURCE_NOTE_INVALID).toContain("保存済みの設定が読めない");
  });

  it("項目ごとのエラー: 渡した項目だけに error が付く", () => {
    const m = buildSettingsModel(READY_INPUT({ errors: { bankroll: "エラーA", clipVariant: "エラーB" } }));
    expect(Object.fromEntries(m.fields.filter((f) => f.error !== null).map((f) => [f.key, f.error]))).toEqual({ bankroll: "エラーA", clipVariant: "エラーB" });
  });

  it("保存の状態: idle は通知なし・保存中は saving かつ全項目 disabled・成功は ok の通知・失敗は error の通知(固定の文言)", () => {
    const idle = buildSettingsModel(READY_INPUT());
    expect(idle.saving).toBe(false);
    expect(idle.saveNotice).toBeNull();
    expect(idle.fields.every((f) => !f.disabled)).toBe(true);
    const saving = buildSettingsModel(READY_INPUT({ save: { kind: "saving" } }));
    expect(saving.saving).toBe(true);
    expect(saving.fields.length).toBe(15);
    expect(saving.fields.every((f) => f.disabled)).toBe(true);
    const saved = buildSettingsModel(READY_INPUT({ save: { kind: "saved" } }));
    expect(saved.saveNotice).toEqual({ tone: "ok", text: "保存しました。次に実行する発走前の分析から使われます。" });
    const failed = buildSettingsModel(READY_INPUT({ save: { kind: "error", message: "保存できませんでした" } }));
    expect(failed.saveNotice).toEqual({ tone: "error", text: "保存できませんでした" });
  });

  it("検証エラーがあるとき、保存の通知は出さない(項目ごとのエラーだけ)。保存済みの通知と検証エラーが同時に出ない", () => {
    const m = buildSettingsModel(READY_INPUT({ errors: { bankroll: "エラー" }, save: { kind: "idle" } }));
    expect(m.saveNotice).toBeNull();
  });
});

describe("Issue #201: プロンプトのプレビューの表示用データ(buildSettingsModel の preview)", () => {
  const open = (over: Partial<SettingsModelInput> = {}) => buildSettingsModel(READY_INPUT({ previewOpen: true, ...over })).preview!;
  const notesOf = (p: { notes: readonly string[] }): string => p.notes.join("\n");

  it("下書きを取得できていないとき(読み込み中・取得の失敗)は、プレビューの項目自体を出さない(previewOpen が true でも)", () => {
    for (const load of [{ kind: "loading" }, { kind: "error", message: "失敗" }] as const) {
      const m = buildSettingsModel({ load, draft: null, errors: {}, save: { kind: "idle" }, previewOpen: true });
      expect(m.preview, load.kind).toBeNull();
    }
    expect(buildSettingsModel(READY_INPUT()).preview, "前提: 取得済みなら出る").not.toBeNull();
  });

  it("閉じているとき: 開くボタンの文言だけ。注記・文面は無い(文面は開いたときだけ組み立てる)。previewOpen を渡さなければ閉じている", () => {
    for (const m of [buildSettingsModel(READY_INPUT()), buildSettingsModel(READY_INPUT({ previewOpen: false }))]) {
      expect(m.preview).toEqual({ open: false, toggleLabel: "LLMへ送るプロンプトのプレビューを開く", refreshLabel: null, notes: [], text: null });
    }
  });

  it("開いているとき: 閉じるボタンの文言・反映ボタンの文言・注記・文面が出る", () => {
    const p = open();
    expect(p.open).toBe(true);
    expect(p.toggleLabel).toBe("LLMへ送るプロンプトのプレビューを閉じる");
    expect(p.refreshLabel).toBe("入力中の内容を反映");
    expect(p.notes.length).toBeGreaterThan(0);
    expect(p.text).not.toBeNull();
  });

  it("文面は下書きの追加指示とクリップ幅から作る(FULL: 追加指示「人気薄は慎重に」・wide15)。送信と同じ手順の buildPreviewText と一致する", () => {
    const p = open();
    expect(p.text).toBe(buildPreviewText({ additionalInstruction: "人気薄は慎重に", clipVariant: "wide15" }).text);
    expect(p.text).toContain("人気薄は慎重に");
    expect(p.text).toContain("±15%(絶対値0.15)");
    // 下書きを変えると文面が変わる(前提: 変わらないなら、上は下書きを使った証明にならない)
    const draft = setDraftValue(setDraftValue(draftFromSettings(FULL), "additionalInstruction", "別の指示"), "clipVariant", "default");
    const changed = open({ draft });
    expect(changed.text).not.toBe(p.text);
    expect(changed.text).toContain("別の指示");
    expect(changed.text).toContain("±10%(絶対値0.10)");
  });

  it("注記: サンプルで作った例・実分析で置き換わるセクション・保存後の次回から反映・「入力中の内容を反映」で更新・同日の傾向は前のレースが2つ以上あるときだけ(実質、中央)・重賞の傾向は重賞で取得できて条件に合う過去回が3回以上あるときだけ送る・プロンプト版", () => {
    const p = open();
    const notes = notesOf(p);
    expect(notes).toContain("サンプルレース");
    expect(notes).toContain("【レース情報】【展開想定】【出走馬】");
    expect(notes).toContain("【予想印】【出力スキーマ】");
    expect(notes).toContain("馬場悪化シナリオ");
    expect(notes).toContain("入力中の内容を反映");
    expect(notes).toContain("保存後");
    expect(notes).toContain("同日の傾向は、取り込み済みの前のレースが同じ場・同じ面で2つ以上あるときだけ、実際の分析でも送ります");
    expect(notes).toContain("地方は結果ページに通過順が無いため、ほとんど効きません");
    expect(notes).toContain("発走の何分前に評価するか");
    expect(notes).toContain("重賞のレースでは、同じレースの過去10年の傾向も、取得できて条件に合う過去回が3回以上あるときだけ、実際の分析でも送ります");
    expect(notes).toContain("このサンプルには、どちらも含まれません");
    expect(notes).not.toContain("重賞の傾向は送りません"); // 旧: 重賞の傾向は送らないとする文
    expect(notes).not.toContain("同日の傾向・重賞の傾向"); // 旧: 同日の傾向も送らないとする文
    expect(notes).not.toContain("今後追加予定");
    expect(notes).not.toContain("#"); // 画面の文に Issue 番号を書かない
    expect(notes).toContain(`プロンプト版: ${CLIP_VARIANTS.wide15.promptVersion}`);
    const d = open({ draft: setDraftValue(draftFromSettings(FULL), "clipVariant", "default") });
    expect(notesOf(d)).toContain(`プロンプト版: ${CLIP_VARIANTS.default.promptVersion}`);
    expect(notesOf(d)).not.toContain(CLIP_VARIANTS.wide15.promptVersion);
  });

  it("追加指示が 2,000 単位を超えるとき(D1 へ直接入れた長い値)だけ、切って送られる旨の注記を出す", () => {
    const long = open({ draft: setDraftValue(draftFromSettings(FULL), "additionalInstruction", "あ".repeat(2500)) });
    expect(notesOf(long)).toContain("2,000 文字");
    expect(notesOf(long)).toContain("切った");
    const exact = open({ draft: setDraftValue(draftFromSettings(FULL), "additionalInstruction", "あ".repeat(2000)) });
    expect(notesOf(exact)).not.toContain("切った");
    expect(notesOf(open())).not.toContain("切った");
  });

  it("画面に出る文(ボタンの文言・注記)に、Issue 番号(#数字)を書かない", () => {
    const p = open({ draft: setDraftValue(draftFromSettings(FULL), "additionalInstruction", "あ".repeat(2500)) });
    expect(p.notes.length, "前提: 注記が出ている(0 だと検査が空振り)").toBeGreaterThan(3);
    for (const s of [p.toggleLabel, p.refreshLabel ?? "", ...p.notes]) {
      expect(s).not.toMatch(/#\d/);
    }
  });
});

describe("Issue #218: スコアリングの重みの節(buildSettingsModel の weights)", () => {
  const weights = (over: Partial<SettingsModelInput> = {}) => buildSettingsModel(READY_INPUT(over)).weights!;
  const allFields = (w: NonNullable<ReturnType<typeof buildSettingsModel>["weights"]>) => w.groups.flatMap((g) => g.fields);

  it("下書きを取得できていないとき(読み込み中・取得の失敗)は節自体を出さない。取得済みなら出る(前提)", () => {
    for (const load of [{ kind: "loading" }, { kind: "error", message: "失敗" }] as const) {
      expect(buildSettingsModel({ load, draft: null, errors: {}, save: { kind: "idle" } }).weights, load.kind).toBeNull();
    }
    expect(buildSettingsModel(READY_INPUT()).weights).not.toBeNull();
  });

  it("重みの13項目は fields(既存の15項目)に混ざらず、節の groups にだけある: 見出しは exe と同じ「環境・状態バイアス補正」(7)→「基礎スコア」(6)", () => {
    const m = buildSettingsModel(READY_INPUT());
    expect(m.fields.map((f) => f.key)).toEqual([...FIELD_ORDER]);
    const w = m.weights!;
    expect(w.groups.map((g) => [g.heading, g.fields.length])).toEqual([["環境・状態バイアス補正", 7], ["基礎スコア", 6]]);
    expect(allFields(w).map((f) => f.key)).toEqual([...WEIGHT_FIELD_ORDER]);
  });

  it("ラベルは exe と同じ日本語(BIAS_WEIGHT_LABELS・BASE_SCORE_WEIGHT_LABELS)。13項目すべて、対応表の exe のキーのラベル", () => {
    const byKey = Object.fromEntries(allFields(weights()).map((f) => [f.key, f.label]));
    expect(Object.keys(byKey).length).toBe(13);
    for (const f of SCORING_WEIGHT_FIELDS) {
      const expected = f.group === "bias" ? BIAS_WEIGHT_LABELS[f.exeKey] : BASE_SCORE_WEIGHT_LABELS[f.exeKey];
      expect(expected.length, f.field).toBeGreaterThan(1); // 前提: exe 側にラベルがある
      expect(byKey[f.field], f.field).toBe(expected);
    }
    expect(byKey["biasWeightTrackCondition"]).toBe("馬場状態適性(道悪)");
    expect(byKey["baseScoreWeightWeightChange"]).toBe("斤量");
  });

  it("入力の種類: 13項目とも text で、小数のキーボード(decimal)。値は下書きの文字のまま。maxlength なし", () => {
    const fields = allFields(weights());
    expect(fields.length).toBe(13);
    for (const f of fields) {
      expect(f.kind, f.key).toBe("text");
      expect(f.inputmode, f.key).toBe("decimal");
      expect(f.maxlength, f.key).toBeNull();
    }
    expect(Object.fromEntries(fields.map((f) => [f.key, f.value]))).toEqual({
      biasWeightTrackCondition: "0.5",
      biasWeightVenue: "0.6",
      biasWeightSeason: "0.7",
      biasWeightFrame: "0.8",
      biasWeightSummerFatigue: "0.9",
      biasWeightTransport: "1.1",
      biasWeightRotation: "1.2",
      baseScoreWeightRecentForm: "0.25",
      baseScoreWeightLast3f: "0.35",
      baseScoreWeightCourseDistance: "0.45",
      baseScoreWeightJockey: "0.55",
      baseScoreWeightWeightChange: "0.65",
      baseScoreWeightCourseFrameBias: "0.75",
    });
  });

  it("エラーは渡した項目だけに付く。保存中は13項目とも disabled(通常は disabled でない)", () => {
    const w = weights({ errors: { biasWeightVenue: "エラーA", baseScoreWeightJockey: "エラーB", bankroll: "別の項目" } });
    expect(Object.fromEntries(allFields(w).filter((f) => f.error !== null).map((f) => [f.key, f.error]))).toEqual({ biasWeightVenue: "エラーA", baseScoreWeightJockey: "エラーB" });
    expect(allFields(weights()).every((f) => !f.disabled)).toBe(true);
    const saving = weights({ save: { kind: "saving" } });
    expect(allFields(saving).length).toBe(13);
    expect(allFields(saving).every((f) => f.disabled)).toBe(true);
  });

  it("節の見出しと説明: 事前分析と発走前の分析の両方で使われること・すでに始まったタスクは始めたときの設定のままであること・過剰補正に注意・「既定値に戻す」ボタン(保存中は無効)", () => {
    const w = weights();
    expect(w.heading).toBe("スコアリングの重み");
    const text = w.help.join("\n");
    expect(text).toContain("事前分析と発走前の分析の両方で使われ");
    expect(text).toContain("すでに始まったタスクは始めたときの設定のまま");
    expect(text).toContain("過剰");
    expect(text).toContain("0 以上");
    expect(w.resetLabel).toBe("重みを既定値に戻す");
    expect(w.resetDisabled).toBe(false);
    expect(weights({ save: { kind: "saving" } }).resetDisabled).toBe(true);
  });

  it("補助文: 騎手成績の重みは「現在の分析では効かない」旨を書く(分析が騎手の当該コース成績を渡さないため。exe も同じ)。ほかの12項目には書かない。画面に出る文に Issue 番号を書かない", () => {
    const w = weights();
    const byKey = Object.fromEntries(allFields(w).map((f) => [f.key, f.help ?? ""]));
    expect(byKey["baseScoreWeightJockey"]).toContain("変えても結果は変わりません");
    for (const f of SCORING_WEIGHT_FIELDS.filter((x) => x.field !== "baseScoreWeightJockey")) {
      expect(byKey[f.field], f.field).not.toContain("変わりません");
    }
    for (const [key, help] of Object.entries(byKey)) expect(help, key).not.toMatch(/#\d/);
    expect(w.heading).not.toMatch(/#\d/);
    expect(w.help.join("\n")).not.toMatch(/#\d/);
    for (const g of w.groups) expect(g.heading).not.toMatch(/#\d/);
  });
});

describe("Issue #218: resetWeightsInDraft(「重みを既定値に戻す」。下書きだけを戻す)", () => {
  it("13項目の下書きを既定値(文字列)に戻し、重み以外の15項目は変えない。元の下書きは変えない", () => {
    const draft = draftFromSettings(FULL);
    for (const k of WEIGHT_FIELD_ORDER) expect(draft[k], `前提: ${k} は既定値と別の値`).not.toBe(String(DEFAULT_CLOUD_SETTINGS[k]));
    const reset = resetWeightsInDraft(draft);
    for (const k of WEIGHT_FIELD_ORDER) expect(reset[k], k).toBe(String(DEFAULT_CLOUD_SETTINGS[k]));
    for (const k of FIELD_ORDER) expect(reset[k], k).toBe(draft[k]);
    expect(draft.biasWeightVenue).toBe("0.6");
  });

  it("不正な入力(文字・空・負)も既定値に戻る。戻した下書きは検証を通る(その他が有効なら)", () => {
    let draft = draftFromSettings(DEFAULT_CLOUD_SETTINGS);
    draft = setDraftValue(setDraftValue(setDraftValue(draft, "biasWeightVenue", "abc"), "baseScoreWeightJockey", ""), "biasWeightSeason", "-3");
    expect(validateDraft(draft).ok).toBe(false);
    const result = validateDraft(resetWeightsInDraft(draft));
    expect(result).toEqual({ ok: true, settings: DEFAULT_CLOUD_SETTINGS });
  });
});
