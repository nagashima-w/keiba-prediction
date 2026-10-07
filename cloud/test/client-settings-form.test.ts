import { describe, expect, it } from "vitest";
import { CLIP_VARIANTS } from "@keiba/core/analyzer/clip-variants";
import { ALLOCATION_BET_TYPE_LABELS, BET_ALLOCATION_LABELS, CLIP_VARIANT_IDS, INCLUDE_COMBO_ODDS_LABELS } from "../../packages/app/src/shared/settings";
import {
  buildSettingsModel,
  draftFromSettings,
  FIELD_ORDER,
  setDraftValue,
  SOURCE_NOTE_DEFAULT,
  SOURCE_NOTE_INVALID,
  validateDraft,
  type FieldKind,
  type SettingsModelInput,
} from "../client/settings-form";
import { CLOUD_SETTINGS_KEYS, DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";

/**
 * Issue #189(段階2): 設定画面の下書き(文字列)・検証(書く側の述語 `isWritable` を使う)・表示用データ。純関数。
 * 並びは exe の設定画面(`SettingsView.tsx`)に揃える。ラベルは exe の共有定数を流用し、補助文は cloud の実際の挙動に合わせて書き直している。
 */

const FULL: CloudSettings = {
  evThreshold: 1.2,
  additionalInstruction: "人気薄は慎重に",
  clipVariant: "wide15",
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
};

describe("FIELD_ORDER(exe の設定画面の並び。発走何分前は末尾)", () => {
  it("EV閾値 → 組合せオッズ → 各券種(ワイド・馬連・枠連・馬単・三連複・三連単)→ 資金・上限・ケリー → 追加指示 → クリップ幅 → 発走何分前", () => {
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
      "preRaceOffsetMinutes",
    ]);
  });

  it("設定の全 14 項目を、重複なく過不足なく含む(項目を足したらここで落ちる)", () => {
    expect(FIELD_ORDER.length).toBe(14);
    expect(new Set(FIELD_ORDER).size).toBe(14);
    expect([...FIELD_ORDER].sort()).toEqual([...CLOUD_SETTINGS_KEYS].sort());
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
    ["追加指示 2000 文字", "additionalInstruction", "あ".repeat(2000), true],
    ["追加指示 2001 文字", "additionalInstruction", "あ".repeat(2001), false],
    ["追加指示 空", "additionalInstruction", "", true],
  ];
  it.each(CASES)("%s", (_name, key, text, ok) => {
    const result = validateDraft(setDraftValue(draftFromSettings(DEFAULT_CLOUD_SETTINGS), key, text));
    expect(result.ok).toBe(ok);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual([key]); // 他の項目は有効なので、その項目だけが失敗
      expect(result.errors[key]!.length).toBeGreaterThan(5);
    }
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

  it("取得済み: 14 項目を FIELD_ORDER の順に、下書きの値で出す", () => {
    const m = buildSettingsModel(READY_INPUT());
    expect(m.fields.map((f) => f.key)).toEqual([...FIELD_ORDER]);
    const byKey = Object.fromEntries(m.fields.map((f) => [f.key, f]));
    expect(byKey["bankroll"]!.value).toBe("500000");
    expect(byKey["includeComboOdds"]!.value).toBe(true);
    expect(byKey["clipVariant"]!.value).toBe("wide15");
    expect(byKey["additionalInstruction"]!.value).toBe("人気薄は慎重に");
    expect(m.loading).toBe(false);
  });

  it("入力の種類: 真偽は checkbox・追加指示は textarea・クリップ幅は select・数値は text(inputmode で数字のキーボード)", () => {
    const m = buildSettingsModel(READY_INPUT());
    const kinds = Object.fromEntries(m.fields.map((f) => [f.key, f.kind])) as Record<string, FieldKind>;
    for (const key of ["includeComboOdds", "includeWideInAllocation", "includeQuinellaInAllocation", "includeBracketQuinellaInAllocation", "includeExactaInAllocation", "includeTrioInAllocation", "includeTrifectaInAllocation"]) {
      expect(kinds[key], key).toBe("checkbox");
    }
    expect(kinds["additionalInstruction"]).toBe("textarea");
    expect(kinds["clipVariant"]).toBe("select");
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

  it("補助文: 追加指示・クリップ幅は、LLM を使うときに効き、API キーが未登録の間は変更しても結果が変わらないことを書く(キーの有無のどちらでも嘘にならない)。発走何分前は「定時の自動実行を入れるまで効きません」", () => {
    const byKey = Object.fromEntries(buildSettingsModel(READY_INPUT()).fields.map((f) => [f.key, f.help ?? ""]));
    expect(byKey["preRaceOffsetMinutes"]).toContain("定時の自動実行を入れるまで効きません");
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
    expect(saving.fields.length).toBe(14);
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
