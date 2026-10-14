/**
 * クラウド版(Cloudflare D1+R2)への移行ファイルの形式(Issue #215・#167-A)。
 *
 * exe の keiba.db のうち、分析と結果の 8 表だけを、gzip 圧縮の NDJSON 1 ファイルに書き出す。
 * 取り込み(Issue #216。ブラウザ+Worker)はこのファイルを 1 行ずつ読んで D1 / R2 に置く。
 * 取得キャッシュの表は含めない。
 *
 * **このファイルは better-sqlite3 にも `node:` にも依存しない**(ブラウザと Worker で動かすため。
 * `test/ev/native-free-modules.test.ts` が閉包まで機械的に固定している。過去に `node:zlib` の混入で
 * renderer の CI が落ちた)。gzip とファイルの読み書きは、書き出す側の旧 exe の main だけが持っていた(#287 で削除。3c1664e まで)。
 *
 * ## ファイルの構成(1 行 = 1 つの JSON。各行は `\n` で区切る。JSON.stringify は値中の改行を必ずエスケープする)
 * 1. ヘッダ 1 行: `{"type":"header","format":"keiba-cloud-migration","version":1,"exportedAt":…,"appVersion":…}`
 * 2. 分析の行(0 行以上。analysis.id の昇順): 1 分析 = 1 行。`analyses` の行に、その分析の馬(`analysis_horses`)・
 *    買い目(`analysis_bets`)・配分メタ(`analysis_allocation_meta`。無ければ null)を内包する
 * 3. 結果の行(0 行以上。raceId の昇順): 1 レース = 1 行。`race_results`・`race_result_meta`・`race_combo_payouts`・
 *    `race_combo_payout_imports` のどれかに現れる race_id ごとにまとめる
 * 4. フッタ 1 行: 各表の行数と、分析・結果の行数。**フッタが無いファイルは途中で切れている**
 *
 * ## 行の中身
 * 列は DB の値を列名のまま載せる(NULL は null、文字列の JSON 列は文字列のまま。変換で情報を落とさない)。
 * 表ごとの列の集合は {@link MIGRATION_TABLES} が唯一のソースで、**余分な列も不足も拒否する**(exe の表に列が
 * 足されたら、形式の版を上げずに黙って列を落とすのではなく、取り込みで気づけるようにするため)。
 * D1 専用の列(`analyses.detail_key`)は exe の行には無く、取り込み側が埋める。
 *
 * ## 値の検証(Issue #308・#302-B)
 * 列の集合・型・NOT NULL・親子の一致に加えて、**値の形・範囲・1 行あたりの子の行数**を検証し、違反があれば書き込む前にファイル全体を拒否する
 * (ブラウザのアップロード前の検証とサーバの全体検証の両方が、この関数を通る)。規則は {@link COLUMN_RULES} の表が唯一のソース。
 * **最重要の制約は「exe が実際に書き出した正しいファイルを拒否しない」こと**。exe の書き出しは DB の値をそのまま載せるだけで、値は次の経路で作られる
 * (3c1664e で確認): race_id は `parseRaceId`、kaisai_date は `parseKaisaiDate`(または null)、analyzed_at は `toISOString()`、combo_key は
 * `buildComboOddsKey`・`buildOrderedComboOddsKey` の 2 桁連結。そこで次のように分ける。
 *  - 厳格: race_id・kaisai_date・analyzed_at・umaban・bet_type(券種の集合)
 *  - ゆるく: combo_key は「偶数長の数字で各 2 桁が 01〜18」と長さの上限だけ(券種との対応は見ない)、mark は長さだけ(集合は見ない)
 *  - 長さだけ: カテゴリ列(prompt_version・model・route・odds_status ほか。**列挙では見ない**: golden の `odds_status: "ok"` は型 `OddsStatus` の値ではない)
 *  - 見ない: 長文列(raw_response・race_snapshot_json・reason・additional_instruction・各 `*_json`。1 行 8MiB の上限に任せる)
 *
 * **このファイルが import するのは `scraper/ids.ts` と `scraper/combo-odds-key.ts` の 2 本だけで、どちらも import を 1 つも持たない葉**
 * (`cloud/test/client-bundle.test.ts` が固定している)。
 */

import { parseKaisaiDate, parseRaceId } from "../scraper/ids.js";
import { COMBO_ELEMENT_KIND, COMBO_KEY_ORDER, COMBO_SIZE, MAX_WAKUBAN, parseComboOddsKey, type ComboBetType } from "../scraper/combo-odds-key.js";

/** 形式名(ヘッダの `format`)。 */
export const MIGRATION_FORMAT_NAME = "keiba-cloud-migration";
/** 形式の版(ヘッダの `version`)。行の形が変わったら上げる。 */
export const MIGRATION_FORMAT_VERSION = 1;

/** 列の型。SQLite は動的型付けなので、DB に実際に入っている値がこの型でなければ検証で弾く。 */
export type MigrationColumnType = "integer" | "real" | "text";

/** 1 列の定義。 */
export interface MigrationColumnSpec {
  readonly name: string;
  readonly type: MigrationColumnType;
  /** NOT NULL(主キーの列を含む)。true の列に null が入っていれば検証で弾く。 */
  readonly notNull: boolean;
}

/** 1 表の定義。 */
export interface MigrationTableSpec {
  readonly columns: readonly MigrationColumnSpec[];
  /** エラーメッセージで行を特定するための列(主キー)。 */
  readonly keyColumns: readonly string[];
}

const int = (name: string, notNull = false): MigrationColumnSpec => ({ name, type: "integer", notNull });
const real = (name: string, notNull = false): MigrationColumnSpec => ({ name, type: "real", notNull });
const text = (name: string, notNull = false): MigrationColumnSpec => ({ name, type: "text", notNull });

/**
 * 書き出す 8 表の列定義(列名は DB のまま)。書き出し側の SELECT はこの列を明示して発行する
 * (長い期間の migration を経た実 DB に定義表に無い古い列が残っていても、書き出しは常に形式に合う)。
 * `AnalysisStore` の PRAGMA table_info との一致は `test/ev/cloud-migration-format.test.ts` が固定している。
 */
export const MIGRATION_TABLES = {
  analyses: {
    keyColumns: ["id"],
    columns: [
      int("id", true),
      text("race_id", true),
      text("analyzed_at", true),
      int("ev_estimated"),
      text("prompt_version"),
      text("additional_instruction"),
      text("kaisai_date"),
      text("model"),
      text("raw_response"),
      text("race_snapshot_json"),
      text("history_cutoff_date"),
      int("prompt_lookahead_guarded"),
    ],
  },
  analysis_horses: {
    keyColumns: ["analysis_id", "umaban"],
    columns: [
      int("analysis_id", true),
      int("umaban", true),
      real("prior", true),
      real("adjusted_prob", true),
      real("place_odds_min"),
      real("ev"),
      int("is_positive", true),
      text("contributions_json"),
      text("mark"),
      text("reason"),
      text("highlights_json"),
      text("concerns_json"),
    ],
  },
  analysis_bets: {
    keyColumns: ["analysis_id", "bet_type", "combo_key"],
    columns: [
      int("analysis_id", true),
      text("bet_type", true),
      text("combo_key", true),
      int("stake", true),
      real("odds"),
      real("ev"),
    ],
  },
  analysis_allocation_meta: {
    keyColumns: ["analysis_id"],
    columns: [
      int("analysis_id", true),
      text("route", true),
      text("unavailable_reason"),
      text("fallback_reason"),
      text("skip_reason_code"),
      text("combo_odds_wide"),
      text("combo_odds_trio"),
      real("bankroll", true),
      real("per_race_cap", true),
      real("kelly_fraction", true),
      real("ev_threshold", true),
      int("include_combo_odds", true),
      int("include_wide", true),
      int("include_trio", true),
      int("include_quinella"),
      int("include_exacta"),
      int("include_trifecta"),
      int("include_bracket_quinella"),
      int("bet_unit"),
      int("greedy_steps"),
      int("candidate_cap"),
      text("model_id"),
      int("model_approximate"),
      text("odds_status", true),
    ],
  },
  race_results: {
    keyColumns: ["race_id", "umaban"],
    columns: [
      text("race_id", true),
      int("umaban", true),
      int("finish_position"),
      real("place_payout"),
      real("win_payout"),
      text("passing_json"),
      real("last3f"),
    ],
  },
  race_result_meta: {
    keyColumns: ["race_id"],
    columns: [text("race_id", true), text("course_type")],
  },
  race_combo_payouts: {
    keyColumns: ["race_id", "bet_type", "combo_key"],
    columns: [text("race_id", true), text("bet_type", true), text("combo_key", true), int("payout", true)],
  },
  race_combo_payout_imports: {
    keyColumns: ["race_id", "bet_type"],
    columns: [text("race_id", true), text("bet_type", true)],
  },
} as const satisfies Record<string, MigrationTableSpec>;

/** 書き出す表の名前。 */
export type MigrationTableName = keyof typeof MIGRATION_TABLES;

/** 書き出す表の名前(フッタの counts の並びもこの順)。 */
export const MIGRATION_TABLE_NAMES: readonly MigrationTableName[] = [
  "analyses",
  "analysis_horses",
  "analysis_bets",
  "analysis_allocation_meta",
  "race_results",
  "race_result_meta",
  "race_combo_payouts",
  "race_combo_payout_imports",
];

/** DB の 1 行(列名 → 値)。SQLite の値は文字列・数値・NULL のいずれか。 */
export type MigrationRow = Readonly<Record<string, string | number | null>>;

/** 各表の行数。 */
export type MigrationTableCounts = Readonly<Record<MigrationTableName, number>>;

/** ヘッダ行。 */
export interface MigrationHeaderLine {
  readonly type: "header";
  readonly format: typeof MIGRATION_FORMAT_NAME;
  readonly version: typeof MIGRATION_FORMAT_VERSION;
  /** 書き出し日時(ISO 8601 UTC)。 */
  readonly exportedAt: string;
  /** 書き出したアプリの版。 */
  readonly appVersion: string;
}

/** 分析の行(1 分析 = 1 行)。 */
export interface MigrationAnalysisLine {
  readonly type: "analysis";
  /** analyses の行(exe の分析 id は `analysis.id`。取り込み側の冪等性の鍵)。 */
  readonly analysis: MigrationRow;
  readonly horses: readonly MigrationRow[];
  readonly bets: readonly MigrationRow[];
  /** 配分を記録していない旧分析は null。 */
  readonly allocationMeta: MigrationRow | null;
}

/** 結果の行(1 レース = 1 行)。 */
export interface MigrationResultLine {
  readonly type: "result";
  readonly raceId: string;
  readonly results: readonly MigrationRow[];
  /** race_result_meta の行。面(course_type)を記録していないレースは null。 */
  readonly meta: MigrationRow | null;
  readonly comboPayouts: readonly MigrationRow[];
  readonly comboPayoutImports: readonly MigrationRow[];
}

/** フッタ行。 */
export interface MigrationFooterLine {
  readonly type: "footer";
  /** 各表の行数。 */
  readonly counts: MigrationTableCounts;
  /** 分析の行の数。 */
  readonly analysisLines: number;
  /** 結果の行の数。 */
  readonly resultLines: number;
}

/** 1 行ぶんの内容。 */
export type MigrationLine =
  | MigrationHeaderLine
  | MigrationAnalysisLine
  | MigrationResultLine
  | MigrationFooterLine;

/** 形式違反。メッセージに「どの表・どの id/race_id・どの列か」を含める。 */
export class MigrationFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationFormatError";
  }
}

// ---------------------------------------------------------------------------
// 値の規則(Issue #308・#302-B)
// ---------------------------------------------------------------------------

/** 馬番の上限(1〜18)。`scraper/combo-odds-key.ts` の `MAX_UMABAN` と同じ値(あちらは非 export。ドリフトは `test/ev/cloud-migration-format-values.test.ts` が固定)。 */
export const MIGRATION_MAX_UMABAN = 18;

/** カテゴリ列(版・モデル名・到達状態・理由コード・オッズの状態・面など、短い識別子の列)の長さの上限。実際の値は最長でも 30 文字程度。列挙では見ない。 */
export const MIGRATION_CATEGORY_MAX_LENGTH = 128;

/** 予想印(`analysis_horses.mark`)の長さの上限。実際は 1 文字(◎〇▲△☆注)。集合は見ない(古い行の拒否を避ける)。 */
export const MIGRATION_MARK_MAX_LENGTH = 16;

/** `analyzed_at` の長さの上限。ISO 形式で最長のもの(小数 9 桁・オフセットつき `2026-03-02T01:00:00.123456789+09:00`)は 35 文字。 */
export const MIGRATION_ANALYZED_AT_MAX_LENGTH = 40;

/** 組合せの券種(払戻系の `bet_type` の集合。`COMBO_SIZE` のキーから導く)。 */
export const MIGRATION_COMBO_BET_TYPES: readonly string[] = Object.keys(COMBO_SIZE);

/** 買い目(`analysis_bets.bet_type`)の券種の集合: 複勝・単勝に組合せの券種を足したもの。配分の券種 `AllocationBetType` と一致することを、テストがドリフトとして固定する(あちらは重いモジュールなので import しない)。 */
export const MIGRATION_ANALYSIS_BET_TYPES: readonly string[] = ["place", "win", ...MIGRATION_COMBO_BET_TYPES];

/**
 * `combo_key` の長さの上限: 組合せの最大の要素数(`COMBO_SIZE` の最大。三連複・三連単の 3)× 2 桁。
 * 下限は 2(複勝・単勝の 1 頭)。券種ごとの長さは見ない(ゆるくする)。
 */
export const MIGRATION_COMBO_KEY_MAX_LENGTH: number = Math.max(...Object.values(COMBO_SIZE)) * 2;

/** 二項係数 C(n, k)(整数のまま計算する)。 */
function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/** 順列 P(n, k) = n·(n−1)·…·(n−k+1)。 */
function permute(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result *= n - i;
  }
  return result;
}

/**
 * 組合せの 1 券種について、1 レースに現れうる買い目(払戻)の最大の個数。**定義(`COMBO_SIZE`・`COMBO_KEY_ORDER`・`COMBO_ELEMENT_KIND`)から導く**ので、
 * 券種が増えても(枠単など)上限が正しい行を拒否する事故にならない。
 *  - 馬番の組(順不同): C(18, k)。馬番の並び(順序つき): P(18, k)
 *  - 枠番の組(順不同。同枠あり): C(8 + k − 1, k)。枠番の並び(順序つき・同枠あり): 8^k
 */
function maxCombosOf(betType: ComboBetType): number {
  const size = COMBO_SIZE[betType];
  const ordered = COMBO_KEY_ORDER[betType] === "ordered";
  if (COMBO_ELEMENT_KIND[betType] === "wakuban") {
    return ordered ? MAX_WAKUBAN ** size : choose(MAX_WAKUBAN + size - 1, size);
  }
  return ordered ? permute(MIGRATION_MAX_UMABAN, size) : choose(MIGRATION_MAX_UMABAN, size);
}

const COMBO_TOTAL = (Object.keys(COMBO_SIZE) as ComboBetType[]).reduce((sum, t) => sum + maxCombosOf(t), 0);

/**
 * 1 行(1 分析・1 レース)に載せられる子の行数の上限。**理論値から導いた値**で、実物の最大(stake>0 だけを載せるので桁違いに小さい)より十分に上、
 * 「数万行」より十分に下。#309 の「1 行の書き込み行数の見積もりの最大 < 日次上限」はこの上限に依存する。
 *  - horses・results: 18。主キー (…, umaban) と umaban ∈ [1, 18] から、重複のない行は 18 を超えない
 *  - bets: 複勝 18 + 単勝 18 + 組合せの全券種の最大の合計(馬連・ワイド C(18,2)=153、三連複 C(18,3)=816、馬単 P(18,2)=306、枠連 C(9,2)=36、三連単 P(18,3)=4896)= 6396
 *  - comboPayouts: 組合せの全券種の最大の合計 = 6360(複勝・単勝を含まない)
 *  - comboPayoutImports: 主キー (race_id, bet_type) と組合せの券種の数 = 6
 * 6396 と 6360 は総当たりの列挙(導出式を使わない)と一致することを `test/ev/cloud-migration-format-values.test.ts` が固定している。
 * 重複を許す「同じ行の繰り返し」も、この件数の上限で止まる(主キーの重複そのものは `cloud/src/migration-convert.ts` の取り込みの変換が検出する)。
 */
export const MIGRATION_MAX_CHILD_ROWS = {
  horses: MIGRATION_MAX_UMABAN,
  results: MIGRATION_MAX_UMABAN,
  bets: 2 * MIGRATION_MAX_UMABAN + COMBO_TOTAL,
  comboPayouts: COMBO_TOTAL,
  comboPayoutImports: MIGRATION_COMBO_BET_TYPES.length,
} as const;

/** 検証のオプション。 */
export interface ValidateMigrationOptions {
  /**
   * `analyzed_at` の上限(エポックからのミリ秒)。これより後の分析日時は拒否する。**サーバ側の検証だけが渡す**(取り込み時刻 + 7 日。`cloud/src/migration-verify.ts`)。
   * core は時計を持たず、時刻は引数で受ける。省略したとき(ブラウザのアップロード前の検証)は、未来の日時を検査しない。
   */
  readonly maxAnalyzedAtMs?: number;
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** エラーメッセージに載せる文字列の最大の長さ(これを超える分は切る。値の全文が応答・保存先〈kv〉に載らないように)。 */
const MESSAGE_CLIP = 40;

function clip(text: string): string {
  return text.length > MESSAGE_CLIP ? `${text.slice(0, MESSAGE_CLIP)}…` : text;
}

/** エラーメッセージに載せる値の表現(Infinity・NaN を区別できるように String 化する)。 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `文字列 ${JSON.stringify(clip(value))}`;
  }
  if (typeof value === "number") {
    return `数値 ${String(value)}`;
  }
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "配列" : typeof value;
}

/** 行を特定する文字列(例: `analysis_horses (analysis_id=12, umaban=3)`)。主キーの値が壊れていてもそのまま見せる。 */
function describeRow(table: MigrationTableName, row: Record<string, unknown>): string {
  const keys = MIGRATION_TABLES[table].keyColumns
    .map((k) => `${k}=${row[k] === undefined ? "(なし)" : clip(String(row[k]))}`)
    .join(", ");
  return `${table} (${keys})`;
}

function columnTypeProblem(spec: MigrationColumnSpec, value: unknown): string | null {
  if (value === null) {
    return spec.notNull ? "null は許されない(NOT NULL)" : null;
  }
  switch (spec.type) {
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? null
        : `整数でなければならない(実際: ${describeValue(value)})`;
    case "real":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `有限の数値でなければならない(実際: ${describeValue(value)})`;
    case "text":
      return typeof value === "string" ? null : `文字列でなければならない(実際: ${describeValue(value)})`;
  }
}

/** 値の規則の文脈。 */
interface RuleContext {
  readonly maxAnalyzedAtMs: number | undefined;
}

/** 列の値の規則。型の検査を通った null でない値を受け取り、違反なら理由を、よければ null を返す。 */
type ColumnRule = (value: string | number, context: RuleContext) => string | null;

const raceIdRule: ColumnRule = (value) => {
  try {
    parseRaceId(String(value));
    return null;
  } catch {
    return `レース ID(12 桁・場コード・月日・レース番号の規則)に合わない(実際: ${describeValue(value)})`;
  }
};

const kaisaiDateRule: ColumnRule = (value) => {
  try {
    parseKaisaiDate(String(value));
    return null;
  } catch {
    return `開催日(YYYYMMDD の実在する日付)に合わない(実際: ${describeValue(value)})`;
  }
};

/** ISO 8601(UTC の `Z` またはオフセットつき)。`Date.parse` は空白区切りをローカル時刻として読み、`02-30` を 3 月 2 日に繰り上げて通すので、先に形を見る。 */
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const analyzedAtRule: ColumnRule = (value, context) => {
  const text = String(value);
  const match = text.length <= MIGRATION_ANALYZED_AT_MAX_LENGTH ? ISO_TIMESTAMP.exec(text) : null;
  const ms = match === null ? Number.NaN : Date.parse(text);
  if (match === null || !Number.isFinite(ms)) {
    return `ISO 8601(タイムゾーンつき。長さ ${MIGRATION_ANALYZED_AT_MAX_LENGTH} 文字以内)の日時でない(実際: ${describeValue(value)})`;
  }
  // 暦として実在するか(日が月の日数を超える値を弾く。年が 0〜99 でも暦年のまま比べるため setUTCFullYear を使う)。
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return `暦に存在しない日付(実際: ${describeValue(value)})`;
  }
  if (context.maxAnalyzedAtMs !== undefined && ms > context.maxAnalyzedAtMs) {
    return `未来の日時(取り込み時刻 + 7 日より後。実際: ${describeValue(value)})`;
  }
  return null;
};

const umabanRule: ColumnRule = (value) =>
  typeof value === "number" && value >= 1 && value <= MIGRATION_MAX_UMABAN ? null : `馬番は 1〜${MIGRATION_MAX_UMABAN} でなければならない(実際: ${describeValue(value)})`;

function oneOfRule(allowed: readonly string[], label: string): ColumnRule {
  return (value) => (typeof value === "string" && allowed.includes(value) ? null : `${label}(${allowed.join("・")})のいずれかでなければならない(実際: ${describeValue(value)})`);
}

/** 偶数長の数字で各 2 桁が 01〜18(`parseComboOddsKey`)、長さ 2〜{@link MIGRATION_COMBO_KEY_MAX_LENGTH}。券種との対応は見ない。 */
const comboKeyRule: ColumnRule = (value) => {
  const key = String(value);
  if (key.length <= MIGRATION_COMBO_KEY_MAX_LENGTH && parseComboOddsKey(key) !== null) {
    return null;
  }
  return `買い目のキー(各 2 桁が 01〜${MIGRATION_MAX_UMABAN} の偶数長の数字。長さ 2〜${MIGRATION_COMBO_KEY_MAX_LENGTH})に合わない(実際: ${describeValue(value)})`;
};

function maxLengthRule(max: number): ColumnRule {
  return (value) => (String(value).length <= max ? null : `長さが上限 ${max} 文字を超えている(実際: ${String(value).length} 文字)`);
}

const categoryRule = maxLengthRule(MIGRATION_CATEGORY_MAX_LENGTH);

/**
 * 列ごとの値の規則(表 → 列 → 規則)。型・NOT NULL の検査を通った、null でない値にだけ適用する。表に無い列は規則なし(長文列は意図して置かない)。
 * 子の表の `race_id` に規則を置かないのは、親(分析の行の `race_id`・結果の行の `raceId`)との一致を先に検査しており、一致すれば親の規則に適うため。
 */
const COLUMN_RULES: { readonly [T in MigrationTableName]?: Readonly<Record<string, ColumnRule>> } = {
  analyses: {
    race_id: raceIdRule,
    analyzed_at: analyzedAtRule,
    kaisai_date: kaisaiDateRule,
    prompt_version: categoryRule,
    model: categoryRule,
    history_cutoff_date: categoryRule,
  },
  analysis_horses: { umaban: umabanRule, mark: maxLengthRule(MIGRATION_MARK_MAX_LENGTH) },
  analysis_bets: { bet_type: oneOfRule(MIGRATION_ANALYSIS_BET_TYPES, "買い目の券種"), combo_key: comboKeyRule },
  analysis_allocation_meta: {
    route: categoryRule,
    unavailable_reason: categoryRule,
    fallback_reason: categoryRule,
    skip_reason_code: categoryRule,
    combo_odds_wide: categoryRule,
    combo_odds_trio: categoryRule,
    model_id: categoryRule,
    odds_status: categoryRule,
  },
  race_results: { umaban: umabanRule },
  race_result_meta: { course_type: categoryRule },
  race_combo_payouts: { bet_type: oneOfRule(MIGRATION_COMBO_BET_TYPES, "組合せの券種"), combo_key: comboKeyRule },
  race_combo_payout_imports: { bet_type: oneOfRule(MIGRATION_COMBO_BET_TYPES, "組合せの券種") },
};

/** 1 行(1 表の 1 行)を検証する。列の集合は完全一致・型・NOT NULL・値の規則({@link COLUMN_RULES})。 */
function validateRow(table: MigrationTableName, value: unknown, where: string, context: RuleContext): MigrationRow {
  if (!isPlainObject(value)) {
    throw new MigrationFormatError(`${where}: ${table} の行がオブジェクトでない(実際: ${describeValue(value)})`);
  }
  const spec = MIGRATION_TABLES[table];
  const rules = COLUMN_RULES[table];
  const label = describeRow(table, value);
  const known = new Set<string>(spec.columns.map((c) => c.name));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new MigrationFormatError(`${where}: ${label} に未知の列 ${key} がある`);
    }
  }
  for (const column of spec.columns) {
    if (!(column.name in value)) {
      throw new MigrationFormatError(`${where}: ${label} に列 ${column.name} がない`);
    }
    const cell = value[column.name];
    const problem = columnTypeProblem(column, cell) ?? (cell === null ? null : (rules?.[column.name]?.(cell as string | number, context) ?? null));
    if (problem !== null) {
      throw new MigrationFormatError(`${where}: ${label} の列 ${column.name}: ${problem}`);
    }
  }
  return value as MigrationRow;
}

function validateRows(
  table: MigrationTableName,
  value: unknown,
  where: string,
  expectedOwner: { readonly column: string; readonly value: string | number },
  context: RuleContext,
  maxRows: number,
): readonly MigrationRow[] {
  if (!Array.isArray(value)) {
    throw new MigrationFormatError(`${where}: ${table} の行の並びが配列でない(実際: ${describeValue(value)})`);
  }
  // 件数は、個々の行を検証する前に見る(巨大な配列の行を 1 つずつ検証するコストを払わずに拒否する)。
  if (value.length > maxRows) {
    throw new MigrationFormatError(`${where}: ${table} の行数が 1 行あたりの上限 ${maxRows} を超えている(実際: ${value.length})`);
  }
  return value.map((v) => {
    const row = validateRow(table, v, where, context);
    if (row[expectedOwner.column] !== expectedOwner.value) {
      throw new MigrationFormatError(
        `${where}: ${describeRow(table, row)} の ${expectedOwner.column} が親(${expectedOwner.value})と一致しない`,
      );
    }
    return row;
  });
}

function validateNullableRow(
  table: MigrationTableName,
  value: unknown,
  where: string,
  expectedOwner: { readonly column: string; readonly value: string | number },
  context: RuleContext,
): MigrationRow | null {
  if (value === null) {
    return null;
  }
  const row = validateRow(table, value, where, context);
  if (row[expectedOwner.column] !== expectedOwner.value) {
    throw new MigrationFormatError(
      `${where}: ${describeRow(table, row)} の ${expectedOwner.column} が親(${expectedOwner.value})と一致しない`,
    );
  }
  return row;
}

function requireKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new MigrationFormatError(`${where}: 未知の項目 ${key} がある`);
    }
  }
  for (const key of allowed) {
    if (!(key in obj)) {
      throw new MigrationFormatError(`${where}: 項目 ${key} がない`);
    }
  }
}

function validateHeader(obj: Record<string, unknown>): MigrationHeaderLine {
  const where = "ヘッダ";
  requireKeys(obj, ["type", "format", "version", "exportedAt", "appVersion"], where);
  if (obj["format"] !== MIGRATION_FORMAT_NAME) {
    throw new MigrationFormatError(
      `${where}: 形式名が ${MIGRATION_FORMAT_NAME} でない(実際: ${describeValue(obj["format"])})`,
    );
  }
  if (obj["version"] !== MIGRATION_FORMAT_VERSION) {
    throw new MigrationFormatError(
      `${where}: 未対応の版(対応: ${MIGRATION_FORMAT_VERSION}、実際: ${describeValue(obj["version"])})`,
    );
  }
  for (const key of ["exportedAt", "appVersion"] as const) {
    if (typeof obj[key] !== "string" || obj[key] === "") {
      throw new MigrationFormatError(`${where}: ${key} が空でない文字列でない(実際: ${describeValue(obj[key])})`);
    }
  }
  return obj as unknown as MigrationHeaderLine;
}

function validateAnalysisLine(obj: Record<string, unknown>, context: RuleContext): MigrationAnalysisLine {
  requireKeys(obj, ["type", "analysis", "horses", "bets", "allocationMeta"], "分析の行");
  const analysis = validateRow("analyses", obj["analysis"], "分析の行", context);
  const id = analysis["id"] as number;
  const where = `分析の行(analysis.id=${id})`;
  const owner = { column: "analysis_id", value: id } as const;
  return {
    type: "analysis",
    analysis,
    horses: validateRows("analysis_horses", obj["horses"], where, owner, context, MIGRATION_MAX_CHILD_ROWS.horses),
    bets: validateRows("analysis_bets", obj["bets"], where, owner, context, MIGRATION_MAX_CHILD_ROWS.bets),
    allocationMeta: validateNullableRow("analysis_allocation_meta", obj["allocationMeta"], where, owner, context),
  };
}

function validateResultLine(obj: Record<string, unknown>, context: RuleContext): MigrationResultLine {
  requireKeys(
    obj,
    ["type", "raceId", "results", "meta", "comboPayouts", "comboPayoutImports"],
    "結果の行",
  );
  const raceId = obj["raceId"];
  if (typeof raceId !== "string" || raceId === "") {
    throw new MigrationFormatError(`結果の行: raceId が空でない文字列でない(実際: ${describeValue(raceId)})`);
  }
  // raceId の形は、子の行を調べる前に見る(以降の `where` に入る raceId は、必ず 12 桁の正しい ID になる)。
  const raceIdProblem = raceIdRule(raceId, context);
  if (raceIdProblem !== null) {
    throw new MigrationFormatError(`結果の行: raceId が${raceIdProblem}`);
  }
  const where = `結果の行(raceId=${raceId})`;
  const owner = { column: "race_id", value: raceId } as const;
  return {
    type: "result",
    raceId,
    results: validateRows("race_results", obj["results"], where, owner, context, MIGRATION_MAX_CHILD_ROWS.results),
    meta: validateNullableRow("race_result_meta", obj["meta"], where, owner, context),
    comboPayouts: validateRows("race_combo_payouts", obj["comboPayouts"], where, owner, context, MIGRATION_MAX_CHILD_ROWS.comboPayouts),
    comboPayoutImports: validateRows("race_combo_payout_imports", obj["comboPayoutImports"], where, owner, context, MIGRATION_MAX_CHILD_ROWS.comboPayoutImports),
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateFooter(obj: Record<string, unknown>): MigrationFooterLine {
  const where = "フッタ";
  requireKeys(obj, ["type", "counts", "analysisLines", "resultLines"], where);
  const counts = obj["counts"];
  if (!isPlainObject(counts)) {
    throw new MigrationFormatError(`${where}: counts がオブジェクトでない(実際: ${describeValue(counts)})`);
  }
  requireKeys(counts, MIGRATION_TABLE_NAMES, `${where}の counts`);
  for (const name of MIGRATION_TABLE_NAMES) {
    if (!isCount(counts[name])) {
      throw new MigrationFormatError(
        `${where}: counts.${name} が 0 以上の整数でない(実際: ${describeValue(counts[name])})`,
      );
    }
  }
  for (const key of ["analysisLines", "resultLines"] as const) {
    if (!isCount(obj[key])) {
      throw new MigrationFormatError(`${where}: ${key} が 0 以上の整数でない(実際: ${describeValue(obj[key])})`);
    }
  }
  return obj as unknown as MigrationFooterLine;
}

/**
 * 1 行ぶんの値(JSON.parse 済み)を検証して返す。違反は {@link MigrationFormatError}
 * (メッセージに「どの表・どの id/race_id・どの列か」を含む)。
 * 書き出し側も、各行を書く前にこの関数を通す(取り込みの段になって初めて気づくより、書き出しの時点で分かる方がよい)。
 * 値の形・範囲・件数の規則は {@link COLUMN_RULES}・{@link MIGRATION_MAX_CHILD_ROWS}(Issue #308)。サーバだけが {@link ValidateMigrationOptions.maxAnalyzedAtMs} を渡す。
 */
export function validateMigrationLine(value: unknown, options: ValidateMigrationOptions = {}): MigrationLine {
  const context: RuleContext = { maxAnalyzedAtMs: options.maxAnalyzedAtMs };
  if (!isPlainObject(value)) {
    throw new MigrationFormatError(`行がオブジェクトでない(実際: ${describeValue(value)})`);
  }
  switch (value["type"]) {
    case "header":
      return validateHeader(value);
    case "analysis":
      return validateAnalysisLine(value, context);
    case "result":
      return validateResultLine(value, context);
    case "footer":
      return validateFooter(value);
    default:
      throw new MigrationFormatError(`未知の行の種類 type=${describeValue(value["type"])}`);
  }
}

/** NDJSON の 1 行(文字列)を読んで検証する。JSON として壊れていれば {@link MigrationFormatError}。 */
export function parseMigrationLine(text: string, options: ValidateMigrationOptions = {}): MigrationLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new MigrationFormatError(`JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateMigrationLine(value, options);
}

/** 1 行を検証してから NDJSON の 1 行(末尾の改行なし)にする。Infinity・NaN など形式に合わない値はここで throw する。 */
export function serializeMigrationLine(line: MigrationLine): string {
  // 検証は「JSON にしたあとに読み直した値」ではなく、書こうとしている値そのものに対して行う
  // (JSON.stringify は Infinity を黙って null にするため、先に検証しないと情報が落ちる)。
  validateMigrationLine(line);
  return JSON.stringify(line);
}

// ---------------------------------------------------------------------------
// 行の組み立て
// ---------------------------------------------------------------------------

/** ヘッダ行を組み立てる。 */
export function buildHeaderLine(input: { readonly exportedAt: string; readonly appVersion: string }): MigrationHeaderLine {
  return {
    type: "header",
    format: MIGRATION_FORMAT_NAME,
    version: MIGRATION_FORMAT_VERSION,
    exportedAt: input.exportedAt,
    appVersion: input.appVersion,
  };
}

/** 分析の行を組み立てる。 */
export function buildAnalysisLine(parts: {
  readonly analysis: MigrationRow;
  readonly horses: readonly MigrationRow[];
  readonly bets: readonly MigrationRow[];
  readonly allocationMeta: MigrationRow | null;
}): MigrationAnalysisLine {
  return { type: "analysis", ...parts };
}

/** 結果の行を組み立てる。 */
export function buildResultLine(parts: {
  readonly raceId: string;
  readonly results: readonly MigrationRow[];
  readonly meta: MigrationRow | null;
  readonly comboPayouts: readonly MigrationRow[];
  readonly comboPayoutImports: readonly MigrationRow[];
}): MigrationResultLine {
  return { type: "result", ...parts };
}

// ---------------------------------------------------------------------------
// 件数の集計と順序の検査(書き出し側と取り込み側で共有する)
// ---------------------------------------------------------------------------

function emptyCounts(): Record<MigrationTableName, number> {
  return {
    analyses: 0,
    analysis_horses: 0,
    analysis_bets: 0,
    analysis_allocation_meta: 0,
    race_results: 0,
    race_result_meta: 0,
    race_combo_payouts: 0,
    race_combo_payout_imports: 0,
  };
}

/**
 * 行を順に受け取り、(1) 行の並びの約束(ヘッダ → 分析 → 結果 → フッタ。分析は id の昇順・結果は raceId の昇順で重複なし)、
 * (2) 各表の行数、(3) フッタの件数との一致、を検査する。
 *
 * 書き出し側はフッタを組み立てるのに使い({@link MigrationTally.buildFooter})、取り込み側は
 * **フッタが来ないまま終わった(=途中で切れた)ファイルを検出する**のに使う({@link MigrationTally.assertComplete})。
 * 行の中身そのものの検証は {@link validateMigrationLine} / {@link parseMigrationLine} が担う。
 */
export class MigrationTally {
  private phase: "start" | "analysis" | "result" | "done" = "start";
  private readonly counts = emptyCounts();
  private analysisLines = 0;
  private resultLines = 0;
  private lines = 0;
  private lastAnalysisId: number | null = null;
  private lastRaceId: string | null = null;

  /** 次の行を受け取る。約束に反すれば {@link MigrationFormatError}(行番号つき)。 */
  accept(line: MigrationLine): void {
    this.lines += 1;
    const where = `${this.lines} 行目`;
    const fail = (message: string): never => {
      throw new MigrationFormatError(`${where}: ${message}`);
    };
    if (this.phase === "done") {
      fail("フッタのあとに行がある");
    }
    if (this.phase === "start") {
      if (line.type !== "header") {
        fail(`最初の行がヘッダでない(type=${line.type})`);
      }
      this.phase = "analysis";
      return;
    }
    switch (line.type) {
      case "header":
        return fail("ヘッダが 2 回ある");
      case "analysis": {
        if (this.phase === "result") {
          fail("結果の行のあとに分析の行がある");
        }
        const id = line.analysis["id"] as number;
        if (this.lastAnalysisId !== null && id <= this.lastAnalysisId) {
          fail(`分析の行が id の昇順(重複なし)でない(analysis.id=${id}、直前は ${this.lastAnalysisId})`);
        }
        this.lastAnalysisId = id;
        this.analysisLines += 1;
        this.counts.analyses += 1;
        this.counts.analysis_horses += line.horses.length;
        this.counts.analysis_bets += line.bets.length;
        this.counts.analysis_allocation_meta += line.allocationMeta === null ? 0 : 1;
        return;
      }
      case "result": {
        this.phase = "result";
        if (this.lastRaceId !== null && line.raceId <= this.lastRaceId) {
          fail(`結果の行が raceId の昇順(重複なし)でない(raceId=${line.raceId}、直前は ${this.lastRaceId})`);
        }
        this.lastRaceId = line.raceId;
        this.resultLines += 1;
        this.counts.race_results += line.results.length;
        this.counts.race_result_meta += line.meta === null ? 0 : 1;
        this.counts.race_combo_payouts += line.comboPayouts.length;
        this.counts.race_combo_payout_imports += line.comboPayoutImports.length;
        return;
      }
      case "footer": {
        const expected = this.buildFooter();
        for (const name of MIGRATION_TABLE_NAMES) {
          if (line.counts[name] !== expected.counts[name]) {
            fail(`フッタの件数が読んだ行数と一致しない(${name}: フッタ ${line.counts[name]}、実際 ${expected.counts[name]})`);
          }
        }
        if (line.analysisLines !== expected.analysisLines) {
          fail(`フッタの分析の行数が一致しない(フッタ ${line.analysisLines}、実際 ${expected.analysisLines})`);
        }
        if (line.resultLines !== expected.resultLines) {
          fail(`フッタの結果の行数が一致しない(フッタ ${line.resultLines}、実際 ${expected.resultLines})`);
        }
        this.phase = "done";
        return;
      }
    }
  }

  /** ここまでに受け取った行から、フッタ行を組み立てる(書き出し側が使う)。 */
  buildFooter(): MigrationFooterLine {
    return {
      type: "footer",
      counts: { ...this.counts },
      analysisLines: this.analysisLines,
      resultLines: this.resultLines,
    };
  }

  /** フッタまで読み終えたか。 */
  get complete(): boolean {
    return this.phase === "done";
  }

  /** 読み終えたあとに呼ぶ。フッタが来ていなければ、途中で切れたファイルとして {@link MigrationFormatError}。 */
  assertComplete(): void {
    if (this.phase !== "done") {
      throw new MigrationFormatError(
        `フッタが無いまま終わっている(途中で切れたファイルの可能性。${this.lines} 行を読んだ)`,
      );
    }
  }
}
