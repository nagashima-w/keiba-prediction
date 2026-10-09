import { DEFAULT_PRE_RACE_OFFSET_MINUTES } from "./pre-race-time.js";

/**
 * クラウド版の設定(D1 の1行。Issue #178〈#164-c〉。編集の API と画面は Issue #189)。**依存を持たない純モジュール**(exe の既定値との一致を `scripts/test/cloud-settings-defaults.test.ts` が
 * 固定するため、scripts の型検査からも import できる形にしている)。
 *
 * **既定値は exe の現在の既定値**(`packages/app/src/main/settings-store.ts` の `DEFAULT_APP_SETTINGS`。メインの判断 2026-10-06)。cloud は exe の設定ストア
 * (node:fs を使う)を import できないので、値を写して、上のテストで一致を固定する。
 *  - `bankroll`・`perRaceCap` は既定 0(配分提案を出さない opt-in。exe と同じ)。ユーザーが値を決めたら、D1 の行に入れる。
 *  - `includeComboOdds`(組合せオッズの取得)は既定 OFF(オプトイン)。OFF なら、組合せの券種は配分に入らない(exe と同じ)。
 *  - 各券種の `include*InAllocation` は既定 ON。
 *  - `preRaceOffsetMinutes`(発走何分前に評価するか。Issue #189)は **cloud 専用の項目**(exe には無い)。既定 45 分は `pre-race-time.ts` の定数と同じ値(定義は1か所)。
 *    使うのは定時の自動実行(#166)で、それまでは値を保存しても何も起きない。
 *  - `analysisModel`(LLM 分析のモデル。Issue #158)は **cloud 専用の項目**。保存するのは具体的なモデル ID でなく**系統**(`auto`・`sonnet`・`opus`・`haiku`)で、
 *    分析のたびに Models API の一覧からその系統の最新を解決する(新しいモデルが出ても選び直しが要らない)。既定の `auto` は「アプリの推奨に任せる」で、今は最新の Sonnet
 *    (`sonnet` と同じ挙動。#157 の自動選択と同じ)。選んだモデルが使えなければ、動作確認済みの固定モデルに切り替えて続ける(`llm-run.ts`・core の `model-selection.ts`)。
 *    LLM を使うときだけ効く(API キーが未登録の間は効かない)。項目の無い旧い行・不正な値は `auto`(読む側は寛容)。
 * 値は `GET`/`POST /api/settings`(`handler.ts`)と設定画面(`#settings`)で編集する(`cloud_settings` 表。id = 1 の1行だけ)。直接 D1 に入れてもよい。
 *
 * **範囲の述語は項目ごとに1か所**(`CLOUD_SETTINGS_RULES`)。読む側(`coerceCloudSettings`)は `isReadable`、書く側(`validateCloudSettingsForSave`。`POST` が 400 にする基準)は `isWritable` を使う。
 * **書く側は読む側の部分集合**(書ける値は必ず読める): 読む側は手で D1 に入れた行や過去の行を壊さない広さ、書く側は画面から入れる値の狭さ。違うのは次の2項目だけ。
 *  - `kellyFraction`: 読む側 0〜1、書く側 0.05〜1(exe の画面の `isValidKellyFraction` と同じ。0 は配分を出さない見送りになるので、UI からは入れさせない)
 *  - `additionalInstruction`: 読む側は長さの上限なし(D1 に直接入れた長い行を、黙って空に戻さない)、書く側は 2,000 文字(UTF-16 コード単位。HTML の `maxlength` と同じ単位)まで
 *    (#179 で毎回 LLM に送るので上限を付ける。**読む側には上限が無い**ので、#179 のプロンプトの組み立ては、手で入れた長い行に備えて自分でも切り詰めること)
 *
 * 読むときは exe の `coerceSettings` と同じ流儀で、不正な値はその項目だけ既定値に戻す(行が壊れていても分析を止めない)。
 * 行が無い・JSON として読めないときは全項目が既定値。
 */

export type ClipVariantId = "default" | "wide15";

/** 分析モデルの選択肢(画面の並び)。`auto` は既定(アプリの推奨に任せる。今は最新の Sonnet)。 */
export const ANALYSIS_MODEL_IDS = ["auto", "sonnet", "opus", "haiku"] as const;
export type AnalysisModelId = (typeof ANALYSIS_MODEL_IDS)[number];
/** モデル一覧から最新を選ぶ系統(core の `ModelFamily` と同じ3つ。この純モジュールは core に依存しないので、同じ値を持つ。型の一致は `llm-run.ts` が確かめる)。 */
export type AnalysisModelFamily = "sonnet" | "opus" | "haiku";

/** 分析モデルの選択を、最新を選ぶ系統に直す(`auto` = 最新の Sonnet)。 */
export function analysisModelFamily(id: AnalysisModelId): AnalysisModelFamily {
  return id === "auto" ? "sonnet" : id;
}

export interface CloudSettings {
  /** EV の閾値(0 より大きい)。 */
  readonly evThreshold: number;
  /** プロンプト追加指示(#179 の LLM で使う)。 */
  readonly additionalInstruction: string;
  /** クリップ幅の版(#179 の LLM で使う)。 */
  readonly clipVariant: ClipVariantId;
  /** LLM 分析のモデル(系統。Issue #158。cloud 専用)。 */
  readonly analysisModel: AnalysisModelId;
  /** 馬券用の総資金(円。整数 0〜1億)。0 は配分提案を出さない。 */
  readonly bankroll: number;
  /** 1レースの上限(円。整数 0〜1000万)。 */
  readonly perRaceCap: number;
  /** ケリー係数(0〜1)。 */
  readonly kellyFraction: number;
  /** ワイド・3連複・馬連・馬単・三連単〈中央〉・枠連のオッズを取得するか。 */
  readonly includeComboOdds: boolean;
  readonly includeWideInAllocation: boolean;
  readonly includeTrioInAllocation: boolean;
  readonly includeQuinellaInAllocation: boolean;
  readonly includeExactaInAllocation: boolean;
  readonly includeTrifectaInAllocation: boolean;
  readonly includeBracketQuinellaInAllocation: boolean;
  /** 発走の何分前に評価するか(整数 10〜180。cloud 専用。定時の自動実行〈#166〉で使う。それまでは効かない)。 */
  readonly preRaceOffsetMinutes: number;
}

export const DEFAULT_CLOUD_SETTINGS: CloudSettings = {
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
  preRaceOffsetMinutes: DEFAULT_PRE_RACE_OFFSET_MINUTES,
};

const BANKROLL_MAX = 100_000_000;
const PER_RACE_CAP_MAX = 10_000_000;
/** 追加指示の上限(書く側のみ。UTF-16 コード単位 = `String#length`。HTML の `maxlength` と同じ)。 */
export const ADDITIONAL_INSTRUCTION_MAX_LENGTH = 2000;
export const PRE_RACE_OFFSET_MIN = 10;
export const PRE_RACE_OFFSET_MAX = 180;
/** ケリー係数の書く側の下限(exe の `isValidKellyFraction` と同じ。読む側の下限は 0)。 */
export const KELLY_FRACTION_WRITE_MIN = 0.05;

/**
 * 追加指示を `max` UTF-16 コード単位(既定 2,000。`String#length` と同じ単位)までに切る。上位サロゲートで終わってしまうとき(ペアの途中)は、そのペアごと落とす。
 * 先頭から切るだけで、途中は書き換えない。`clamped` は、実際に切ったか。
 * 読む側(`coerceCloudSettings`)には上限が無いので、LLM へ送る側(`race-day-core.ts`)が使う。**設定画面のプレビュー(Issue #201)も同じ関数で切る**(送信と同じ文面にするため。
 * 定義がこのファイルにあるのは、クライアントのバンドルに入れられる依存なしの純モジュールだから。`llm-run.ts` から再 export している)。
 */
export function clampAdditionalInstruction(text: string, max: number = ADDITIONAL_INSTRUCTION_MAX_LENGTH): { readonly text: string; readonly clamped: boolean } {
  if (text.length <= max) {
    return { text, clamped: false };
  }
  let end = max;
  const last = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1; // 上位サロゲートだけが残る(対の下位サロゲートを切った)ので、ペアごと落とす
  }
  return { text: text.slice(0, end), clamped: true };
}

/** 1項目の範囲の述語(Issue #189)。`isWritable` ⊂ `isReadable`(テストが境界値の表で固定する)。 */
export interface FieldRule<T> {
  /** 読む側が不正な値を戻す先(= その項目の既定値)。 */
  readonly fallback: T;
  readonly isReadable: (raw: unknown) => raw is T;
  readonly isWritable: (raw: unknown) => raw is T;
}

function rule<T>(fallback: T, isReadable: (raw: unknown) => raw is T, isWritable: (raw: unknown) => raw is T = isReadable): FieldRule<T> {
  return { fallback, isReadable, isWritable };
}

const numberWhere =
  (predicate: (n: number) => boolean) =>
  (raw: unknown): raw is number =>
    typeof raw === "number" && Number.isFinite(raw) && predicate(raw);
const isBoolean = (raw: unknown): raw is boolean => typeof raw === "boolean";
const isString = (raw: unknown): raw is string => typeof raw === "string";
const isClipVariant = (raw: unknown): raw is ClipVariantId => raw === "default" || raw === "wide15";
const isAnalysisModel = (raw: unknown): raw is AnalysisModelId => typeof raw === "string" && (ANALYSIS_MODEL_IDS as readonly string[]).includes(raw);

const D = DEFAULT_CLOUD_SETTINGS;

/**
 * 全項目の範囲の述語(項目の定義順。`CloudSettings` のキーを網羅する型なので、項目を足して述語を書き忘れると型エラー)。
 * 読む側(`coerceCloudSettings`)と書く側(`validateCloudSettingsForSave`)の両方がこの表を使う。
 */
export const CLOUD_SETTINGS_RULES: { readonly [K in keyof CloudSettings]: FieldRule<CloudSettings[K]> } = {
  evThreshold: rule(D.evThreshold, numberWhere((n) => n > 0)),
  additionalInstruction: rule(D.additionalInstruction, isString, (raw): raw is string => isString(raw) && raw.length <= ADDITIONAL_INSTRUCTION_MAX_LENGTH),
  clipVariant: rule(D.clipVariant, isClipVariant),
  analysisModel: rule(D.analysisModel, isAnalysisModel),
  bankroll: rule(D.bankroll, numberWhere((n) => Number.isInteger(n) && n >= 0 && n <= BANKROLL_MAX)),
  perRaceCap: rule(D.perRaceCap, numberWhere((n) => Number.isInteger(n) && n >= 0 && n <= PER_RACE_CAP_MAX)),
  kellyFraction: rule(D.kellyFraction, numberWhere((n) => n >= 0 && n <= 1), numberWhere((n) => n >= KELLY_FRACTION_WRITE_MIN && n <= 1)),
  includeComboOdds: rule(D.includeComboOdds, isBoolean),
  includeWideInAllocation: rule(D.includeWideInAllocation, isBoolean),
  includeTrioInAllocation: rule(D.includeTrioInAllocation, isBoolean),
  includeQuinellaInAllocation: rule(D.includeQuinellaInAllocation, isBoolean),
  includeExactaInAllocation: rule(D.includeExactaInAllocation, isBoolean),
  includeTrifectaInAllocation: rule(D.includeTrifectaInAllocation, isBoolean),
  includeBracketQuinellaInAllocation: rule(D.includeBracketQuinellaInAllocation, isBoolean),
  preRaceOffsetMinutes: rule(D.preRaceOffsetMinutes, numberWhere((n) => Number.isInteger(n) && n >= PRE_RACE_OFFSET_MIN && n <= PRE_RACE_OFFSET_MAX)),
};

/** 設定の項目名(`CLOUD_SETTINGS_RULES` の定義順)。 */
export const CLOUD_SETTINGS_KEYS = Object.keys(CLOUD_SETTINGS_RULES) as readonly (keyof CloudSettings)[];

const KNOWN_KEYS: ReadonlySet<string> = new Set(CLOUD_SETTINGS_KEYS);

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** 任意の値から設定を作る(不正な項目だけ既定値。未知のキーは捨てる)。読む側の述語(`isReadable`)を使う。 */
export function coerceCloudSettings(raw: unknown): CloudSettings {
  const rec = asRecord(raw) ?? {};
  const out: Record<string, unknown> = {};
  for (const key of CLOUD_SETTINGS_KEYS) {
    const fieldRule = CLOUD_SETTINGS_RULES[key] as FieldRule<unknown>;
    out[key] = fieldRule.isReadable(rec[key]) ? rec[key] : fieldRule.fallback;
  }
  return out as unknown as CloudSettings;
}

export type SaveValidation =
  | { readonly ok: true; readonly settings: CloudSettings }
  /** `fields`: 欠けている・範囲外の項目名(**既知の項目名だけ**。未知のキー名は入力の値なので写さない)。未知のキーだけが原因のときは空。 */
  | { readonly ok: false; readonly fields: readonly (keyof CloudSettings)[] };

/**
 * 保存する設定の検証(`POST /api/settings`)。**全項目の置き換え**: 全項目が揃い、未知のキーが無く、各値が書く側の述語(`isWritable`)を満たすときだけ ok。
 * 黙って既定値に戻さない(読む側の `coerceCloudSettings` との違い)。
 */
export function validateCloudSettingsForSave(raw: unknown): SaveValidation {
  const rec = asRecord(raw);
  if (rec === null) {
    return { ok: false, fields: [] };
  }
  const invalid = CLOUD_SETTINGS_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(rec, key) || !(CLOUD_SETTINGS_RULES[key] as FieldRule<unknown>).isWritable(rec[key]));
  const hasUnknown = Object.keys(rec).some((key) => !KNOWN_KEYS.has(key));
  if (invalid.length > 0 || hasUnknown) {
    return { ok: false, fields: invalid };
  }
  const settings: Record<string, unknown> = {};
  for (const key of CLOUD_SETTINGS_KEYS) {
    settings[key] = rec[key];
  }
  return { ok: true, settings: settings as unknown as CloudSettings };
}

/** 設定の行を読む SQL(id = 1 の1行だけ)。 */
export const SELECT_SETTINGS_SQL = "SELECT settings_json FROM cloud_settings WHERE id = 1";

export interface LoadedSettings {
  readonly settings: CloudSettings;
  /** `default`: 行が無い / `d1`: 行を読んだ / `invalid`: 行はあるが JSON として読めない、またはオブジェクトでない(既定値で続ける)。 */
  readonly source: "default" | "d1" | "invalid";
}

/** D1 のうち、設定の読み出しが使う部分(`D1Database` の構造的な部分集合。この純モジュールは workers の型に依存しない)。 */
export interface SettingsDb {
  prepare(sql: string): { first<T = unknown>(): Promise<T | null> };
}

/** D1 から設定を読む(1クエリ)。D1 の読み出しが失敗したら投げる(設定が読めないまま既定値で配分を作らない)。 */
export async function loadSettings(db: SettingsDb): Promise<LoadedSettings> {
  const row = await db.prepare(SELECT_SETTINGS_SQL).first<{ settings_json: string }>();
  if (row === null || row === undefined) {
    return { settings: DEFAULT_CLOUD_SETTINGS, source: "default" };
  }
  try {
    const parsed: unknown = JSON.parse(row.settings_json);
    // JSON として有効でも、オブジェクトでない行(`null`・`[]`・`123` など)は「読めた」とは言えない(全項目が既定値になるので `invalid`。Issue #189)。
    if (asRecord(parsed) === null) {
      return { settings: DEFAULT_CLOUD_SETTINGS, source: "invalid" };
    }
    return { settings: coerceCloudSettings(parsed), source: "d1" };
  } catch {
    return { settings: DEFAULT_CLOUD_SETTINGS, source: "invalid" };
  }
}

/** 設定の行を書く SQL(id = 1 の1行だけ。無ければ作り、あれば置き換える。1文)。 */
export const UPSERT_SETTINGS_SQL =
  "INSERT INTO cloud_settings (id, settings_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at";

/** D1 のうち、設定の書き込みが使う部分(`D1Database` の構造的な部分集合)。 */
export interface SettingsWriteDb {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

/** 設定を D1 に保存する(1文。全項目の置き換え)。`updatedAt` は呼び出し側が渡す(ISO 8601)。D1 の書き込みが失敗したら投げる。 */
export async function saveSettings(db: SettingsWriteDb, settings: CloudSettings, updatedAt: string): Promise<void> {
  await db.prepare(UPSERT_SETTINGS_SQL).bind(JSON.stringify(settings), updatedAt).run();
}
