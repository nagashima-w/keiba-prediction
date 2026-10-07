/**
 * 設定画面の下書き・検証・表示用データ(Issue #189。純関数)。`view.ts` がこれを VNode にする。
 *
 * **下書きは文字列(数値欄は入力した文字のまま)・真偽は真偽値**で持つ。検証は保存の押下時に1回だけ(`validateDraft`。入力のたびには行わない=`change` で描画しない設計)。
 * 検証の範囲は、サーバが 400 にする**書く側の述語**(`cloud/src/settings.ts` の `CLOUD_SETTINGS_RULES[key].isWritable`)をそのまま使う(範囲の定義は1か所)。
 * 並びとラベルは exe の設定画面(`packages/app/src/renderer/SettingsView.tsx`)に合わせる(ラベルは exe の共有定数を流用)。**補助文は cloud の実際の挙動に合わせて書き直した**:
 *  - 効いている: EV 閾値・資金・1レースの上限・ケリー係数・組合せオッズの取得・各券種を配分に含めるか(発走前の分析が使う。`race-day-core.ts` の `allocationSettings`・`evConfig`)
 *  - 効かない(現在は): 追加指示・クリップ幅(LLM を使う分析〈#179〉で使う。現在は LLM を使わない)/ 発走何分前(定時の自動実行〈#166〉で使う)
 */
import { ALLOCATION_BET_TYPE_LABELS, BET_ALLOCATION_LABELS, CLIP_VARIANT_IDS, INCLUDE_COMBO_ODDS_LABELS } from "../../packages/app/src/shared/settings";
import {
  ADDITIONAL_INSTRUCTION_MAX_LENGTH,
  CLOUD_SETTINGS_KEYS,
  CLOUD_SETTINGS_RULES,
  KELLY_FRACTION_WRITE_MIN,
  PRE_RACE_OFFSET_MAX,
  PRE_RACE_OFFSET_MIN,
  type CloudSettings,
} from "../src/settings";
import type { SettingsSource } from "./api-settings";

export type FieldKey = keyof CloudSettings;
export type DraftValue = string | boolean;
/** 下書き(項目 → 入力した文字、または真偽)。 */
export type SettingsDraft = Readonly<Record<FieldKey, DraftValue>>;
export type FieldErrors = Readonly<Partial<Record<FieldKey, string>>>;
export type FieldKind = "text" | "checkbox" | "select" | "textarea";

/** 画面の項目の並び(exe の設定画面の並び。発走何分前は cloud 専用なので末尾)。 */
export const FIELD_ORDER: readonly FieldKey[] = [
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
];

const BOOLEAN_KEYS: ReadonlySet<FieldKey> = new Set(CLOUD_SETTINGS_KEYS.filter((k) => typeof CLOUD_SETTINGS_RULES[k].fallback === "boolean"));
const KNOWN_KEYS: ReadonlySet<string> = new Set(CLOUD_SETTINGS_KEYS);

/** 設定から下書きを作る(数値は文字列にする)。 */
export function draftFromSettings(settings: CloudSettings): SettingsDraft {
  const draft: Record<string, DraftValue> = {};
  for (const key of CLOUD_SETTINGS_KEYS) {
    const value = settings[key];
    draft[key] = typeof value === "number" ? String(value) : value;
  }
  return draft as SettingsDraft;
}

/** 下書きの1項目を更新した新しい下書きを返す(元は変えない)。真偽の項目は `"true"`・`"false"`。未知の項目は無視する。 */
export function setDraftValue(draft: SettingsDraft, key: FieldKey, value: string): SettingsDraft {
  if (!KNOWN_KEYS.has(key)) return draft;
  return { ...draft, [key]: BOOLEAN_KEYS.has(key) ? value === "true" : value };
}

/** 数値の入力(前後の空白は除く)。数字・小数点・符号・指数だけを受ける(16 進・Infinity・全角・カンマ区切りは不可)。 */
function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || !/^[0-9eE+\-.]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** 1,000,000 のような桁区切り。 */
const withCommas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const ERROR_TEXT: Readonly<Record<FieldKey, (draftValue: DraftValue) => string>> = {
  evThreshold: () => "0より大きい数値を入力してください(半角)。",
  additionalInstruction: (v) => `${withCommas(ADDITIONAL_INSTRUCTION_MAX_LENGTH)}文字以内で入力してください(現在 ${typeof v === "string" ? v.length : 0} 文字)。`,
  clipVariant: () => "選択肢から選んでください。",
  bankroll: () => "0以上100,000,000以下の整数を入力してください(半角。0は未設定を表し、配分提案を出しません)。",
  perRaceCap: () => "0以上10,000,000以下の整数を入力してください(半角。0は未設定を表し、配分提案を出しません)。",
  kellyFraction: () => `${KELLY_FRACTION_WRITE_MIN}以上1以下の数値を入力してください(半角)。`,
  includeComboOdds: () => "チェックの状態が不正です。",
  includeWideInAllocation: () => "チェックの状態が不正です。",
  includeTrioInAllocation: () => "チェックの状態が不正です。",
  includeQuinellaInAllocation: () => "チェックの状態が不正です。",
  includeExactaInAllocation: () => "チェックの状態が不正です。",
  includeTrifectaInAllocation: () => "チェックの状態が不正です。",
  includeBracketQuinellaInAllocation: () => "チェックの状態が不正です。",
  preRaceOffsetMinutes: () => `${PRE_RACE_OFFSET_MIN}以上${PRE_RACE_OFFSET_MAX}以下の整数(分)を入力してください(半角)。`,
};

export type DraftValidation = { readonly ok: true; readonly settings: CloudSettings } | { readonly ok: false; readonly errors: FieldErrors };

/** 下書きを検証する(書く側の述語。保存の押下時に1回)。全項目が有効なら数値に直した設定、そうでなければ項目ごとのエラー。 */
export function validateDraft(draft: SettingsDraft): DraftValidation {
  const settings: Record<string, unknown> = {};
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const key of CLOUD_SETTINGS_KEYS) {
    const raw = draft[key];
    const fallback = CLOUD_SETTINGS_RULES[key].fallback;
    // 数値の項目は文字列を数値に直してから、書く側の述語に通す。それ以外はそのまま。
    const candidate = typeof fallback === "number" ? (typeof raw === "string" ? parseNumberInput(raw) : null) : raw;
    if (candidate !== null && (CLOUD_SETTINGS_RULES[key] as { isWritable(v: unknown): boolean }).isWritable(candidate)) {
      settings[key] = candidate;
    } else {
      errors[key] = ERROR_TEXT[key](raw);
    }
  }
  return Object.keys(errors).length === 0 ? { ok: true, settings: settings as unknown as CloudSettings } : { ok: false, errors };
}

export const SOURCE_NOTE_DEFAULT = "まだ保存されていません(既定値を表示しています)。";
export const SOURCE_NOTE_INVALID = "保存済みの設定が読めないため、既定値を表示しています。保存すると置き換わります。";
export const SAVED_NOTICE = "保存しました。次に実行する発走前の分析から使われます。";

export type SettingsLoadState = { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "ready"; readonly source: SettingsSource };
export type SettingsSaveState = { readonly kind: "idle" } | { readonly kind: "saving" } | { readonly kind: "saved" } | { readonly kind: "error"; readonly message: string };

export interface SettingsModelInput {
  readonly load: SettingsLoadState;
  readonly draft: SettingsDraft | null;
  readonly errors: FieldErrors;
  readonly save: SettingsSaveState;
}

export interface FieldModel {
  readonly key: FieldKey;
  readonly kind: FieldKind;
  readonly label: string;
  readonly help: string | null;
  readonly value: DraftValue;
  readonly error: string | null;
  readonly disabled: boolean;
  /** 数字のキーボード(text の数値欄だけ)。 */
  readonly inputmode: "numeric" | "decimal" | null;
  /** 文字数の上限(textarea だけ)。 */
  readonly maxlength: string | null;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export interface SettingsModel {
  readonly kind: "settings";
  /** 戻り先(トップ=一覧)。 */
  readonly backHref: "#";
  readonly loading: boolean;
  /** 取得の失敗(固定の文言)。 */
  readonly error: string | null;
  readonly sourceNote: string | null;
  readonly saving: boolean;
  readonly saveNotice: { readonly tone: "ok" | "error"; readonly text: string } | null;
  readonly fields: readonly FieldModel[];
}

const COMBO_NAME = "ワイド・馬連・馬単・三連複・三連単・枠連";
const ALLOCATION_HELP = "既定は ON です。上の「オッズも取得する」が OFF の間は効果がありません(取得したオッズが無いため)。";
const LLM_NOT_USED = "LLM を使う分析(#179)で使います。現在は LLM を使わないので、変更しても分析の結果は変わりません。";

/** クリップ幅の選択肢のラベル。幅(%)は core の `CLIP_VARIANTS` の値(`client-settings-form.test.ts` が一致を固定)。 */
const CLIP_LABELS: Readonly<Record<(typeof CLIP_VARIANT_IDS)[number], string>> = {
  default: "対照(±10%、既定)",
  wide15: "新版(±15%)",
};

interface FieldSpec {
  readonly kind: FieldKind;
  readonly label: string;
  readonly help: string | null;
  readonly inputmode?: "numeric" | "decimal";
  readonly maxlength?: string;
}

const SPECS: Readonly<Record<FieldKey, FieldSpec>> = {
  evThreshold: { kind: "text", label: "EV閾値(この値を超える馬券を抽出。既定1.0)", help: "0より大きい数値。EV(的中確率 × オッズ)がこの値を超える馬券を、複勝と組合せの全券種で配分の候補にします。馬ごとの「EVプラス」の判定にも、同じ値を使います。", inputmode: "decimal" },
  includeComboOdds: {
    kind: "checkbox",
    label: INCLUDE_COMBO_ODDS_LABELS.checkbox,
    help: `既定は OFF です。ON にすると、発走前の分析で${COMBO_NAME}のオッズも取得します(取得するぶん分析に時間がかかります)。OFF の間は、組合せの券種は配分に入りません。三連単は中央競馬のみ取得します(地方競馬では取得しません)。`,
  },
  includeWideInAllocation: { kind: "checkbox", label: ALLOCATION_BET_TYPE_LABELS.wide.checkbox, help: ALLOCATION_HELP },
  includeQuinellaInAllocation: { kind: "checkbox", label: ALLOCATION_BET_TYPE_LABELS.quinella.checkbox, help: ALLOCATION_HELP },
  includeBracketQuinellaInAllocation: { kind: "checkbox", label: ALLOCATION_BET_TYPE_LABELS.bracketQuinella.checkbox, help: `${ALLOCATION_HELP}発売されていないレース(頭数が少ない場合など)では対象になりません。` },
  includeExactaInAllocation: { kind: "checkbox", label: ALLOCATION_BET_TYPE_LABELS.exacta.checkbox, help: ALLOCATION_HELP },
  includeTrioInAllocation: { kind: "checkbox", label: ALLOCATION_BET_TYPE_LABELS.trio.checkbox, help: ALLOCATION_HELP },
  includeTrifectaInAllocation: { kind: "checkbox", label: ALLOCATION_BET_TYPE_LABELS.trifecta.checkbox, help: ALLOCATION_HELP },
  bankroll: { kind: "text", label: BET_ALLOCATION_LABELS.bankroll, help: `${BET_ALLOCATION_LABELS.bankrollHelp}。0 以上 100,000,000 以下の整数(円)。0 のままだと配分の提案は出ません。`, inputmode: "numeric" },
  perRaceCap: { kind: "text", label: BET_ALLOCATION_LABELS.perRaceCap, help: "1レースで使う金額の上限(円)。0 以上 10,000,000 以下の整数。0 のままだと配分の提案は出ません。", inputmode: "numeric" },
  kellyFraction: { kind: "text", label: BET_ALLOCATION_LABELS.kellyFraction, help: "0.05〜1(既定 0.5)。小さいほど1回あたりの配分額が控えめになり、資産変動が穏やかになります。", inputmode: "decimal" },
  additionalInstruction: {
    kind: "textarea",
    label: "プロンプト追加指示(任意)",
    help: `${LLM_NOT_USED}${withCommas(ADDITIONAL_INSTRUCTION_MAX_LENGTH)} 文字まで。市場オッズ(人気)に近づける方向の指示は、妙味検出を損なうため避けてください。`,
    maxlength: String(ADDITIONAL_INSTRUCTION_MAX_LENGTH),
  },
  clipVariant: { kind: "select", label: "LLM補正の許容幅(クリップ幅の版。A/B比較用)", help: LLM_NOT_USED },
  preRaceOffsetMinutes: {
    kind: "text",
    label: "発走の何分前に評価するか",
    help: `${PRE_RACE_OFFSET_MIN}〜${PRE_RACE_OFFSET_MAX} 分の整数(既定 45)。定時の自動実行を入れるまで効きません(#166)。`,
    inputmode: "numeric",
  },
};

export function buildSettingsModel(input: SettingsModelInput): SettingsModel {
  const { load, draft, errors, save } = input;
  const ready = load.kind === "ready" && draft !== null;
  const saving = save.kind === "saving";
  const fields: FieldModel[] = ready
    ? FIELD_ORDER.map((key): FieldModel => {
        const spec = SPECS[key];
        return {
          key,
          kind: spec.kind,
          label: spec.label,
          help: spec.help,
          value: draft[key],
          error: errors[key] ?? null,
          disabled: saving,
          inputmode: spec.inputmode ?? null,
          maxlength: spec.maxlength ?? null,
          ...(spec.kind === "select" ? { options: CLIP_VARIANT_IDS.map((id) => ({ value: id, label: CLIP_LABELS[id] })) } : {}),
        };
      })
    : [];
  return {
    kind: "settings",
    backHref: "#",
    loading: load.kind === "loading",
    error: load.kind === "error" ? load.message : null,
    sourceNote: load.kind === "ready" ? (load.source === "default" ? SOURCE_NOTE_DEFAULT : load.source === "invalid" ? SOURCE_NOTE_INVALID : null) : null,
    saving,
    saveNotice: save.kind === "saved" ? { tone: "ok", text: SAVED_NOTICE } : save.kind === "error" ? { tone: "error", text: save.message } : null,
    fields,
  };
}
