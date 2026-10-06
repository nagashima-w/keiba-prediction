/**
 * クラウド版の設定(D1 の1行。Issue #178〈#164-c〉)。**依存を持たない純モジュール**(exe の既定値との一致を `scripts/test/cloud-settings-defaults.test.ts` が
 * 固定するため、scripts の型検査からも import できる形にしている)。
 *
 * **既定値は exe の現在の既定値**(`packages/app/src/main/settings-store.ts` の `DEFAULT_APP_SETTINGS`。メインの判断 2026-10-06)。cloud は exe の設定ストア
 * (node:fs を使う)を import できないので、値を写して、上のテストで一致を固定する。
 *  - `bankroll`・`perRaceCap` は既定 0(配分提案を出さない opt-in。exe と同じ)。ユーザーが値を決めたら、D1 の行に入れる。
 *  - `includeComboOdds`(組合せオッズの取得)は既定 OFF(オプトイン)。OFF なら、組合せの券種は配分に入らない(exe と同じ)。
 *  - 各券種の `include*InAllocation` は既定 ON。
 * **設定を編集する API は無い**(#165 で作る)。値は migration か D1 への直接の UPDATE で入れる(`cloud_settings` 表。id = 1 の1行だけ)。
 *
 * 読むときは exe の `coerceSettings` と同じ流儀で、不正な値はその項目だけ既定値に戻す(行が壊れていても分析を止めない)。
 * 行が無い・JSON として読めないときは全項目が既定値。
 */

export type ClipVariantId = "default" | "wide15";

export interface CloudSettings {
  /** EV の閾値(0 より大きい)。 */
  readonly evThreshold: number;
  /** プロンプト追加指示(#179 の LLM で使う)。 */
  readonly additionalInstruction: string;
  /** クリップ幅の版(#179 の LLM で使う)。 */
  readonly clipVariant: ClipVariantId;
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
}

export const DEFAULT_CLOUD_SETTINGS: CloudSettings = {
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
};

const BANKROLL_MAX = 100_000_000;
const PER_RACE_CAP_MAX = 10_000_000;

function coerceNumber(raw: unknown, fallback: number, predicate: (n: number) => boolean): number {
  return typeof raw === "number" && Number.isFinite(raw) && predicate(raw) ? raw : fallback;
}

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** 任意の値から設定を作る(不正な項目だけ既定値。未知のキーは捨てる)。 */
export function coerceCloudSettings(raw: unknown): CloudSettings {
  const rec: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_CLOUD_SETTINGS;
  return {
    evThreshold: coerceNumber(rec["evThreshold"], d.evThreshold, (n) => n > 0),
    additionalInstruction: typeof rec["additionalInstruction"] === "string" ? rec["additionalInstruction"] : d.additionalInstruction,
    clipVariant: rec["clipVariant"] === "default" || rec["clipVariant"] === "wide15" ? rec["clipVariant"] : d.clipVariant,
    bankroll: coerceNumber(rec["bankroll"], d.bankroll, (n) => Number.isInteger(n) && n >= 0 && n <= BANKROLL_MAX),
    perRaceCap: coerceNumber(rec["perRaceCap"], d.perRaceCap, (n) => Number.isInteger(n) && n >= 0 && n <= PER_RACE_CAP_MAX),
    kellyFraction: coerceNumber(rec["kellyFraction"], d.kellyFraction, (n) => n >= 0 && n <= 1),
    includeComboOdds: coerceBoolean(rec["includeComboOdds"], d.includeComboOdds),
    includeWideInAllocation: coerceBoolean(rec["includeWideInAllocation"], d.includeWideInAllocation),
    includeTrioInAllocation: coerceBoolean(rec["includeTrioInAllocation"], d.includeTrioInAllocation),
    includeQuinellaInAllocation: coerceBoolean(rec["includeQuinellaInAllocation"], d.includeQuinellaInAllocation),
    includeExactaInAllocation: coerceBoolean(rec["includeExactaInAllocation"], d.includeExactaInAllocation),
    includeTrifectaInAllocation: coerceBoolean(rec["includeTrifectaInAllocation"], d.includeTrifectaInAllocation),
    includeBracketQuinellaInAllocation: coerceBoolean(rec["includeBracketQuinellaInAllocation"], d.includeBracketQuinellaInAllocation),
  };
}

/** 設定の行を読む SQL(id = 1 の1行だけ)。 */
export const SELECT_SETTINGS_SQL = "SELECT settings_json FROM cloud_settings WHERE id = 1";

export interface LoadedSettings {
  readonly settings: CloudSettings;
  /** `default`: 行が無い / `d1`: 行を読んだ / `invalid`: 行はあるが JSON として読めない(既定値で続ける)。 */
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
    return { settings: coerceCloudSettings(JSON.parse(row.settings_json)), source: "d1" };
  } catch {
    return { settings: DEFAULT_CLOUD_SETTINGS, source: "invalid" };
  }
}
