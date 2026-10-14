/**
 * クラウド版(Cloudflare D1+R2)への移行ファイルの形式(Issue #215・#167-A)。
 *
 * exe の keiba.db のうち、分析と結果の 8 表だけを、gzip 圧縮の NDJSON 1 ファイルに書き出す。
 * 取り込み(Issue #216。ブラウザ+Worker)はこのファイルを 1 行ずつ読んで D1 / R2 に置く。
 * 取得キャッシュの表は含めない。
 *
 * **このファイルは better-sqlite3 にも `node:` にも依存しない**(ブラウザと Worker で動かすため。
 * `test/ev/native-free-modules.test.ts` が閉包まで機械的に固定している。過去に `node:zlib` の混入で
 * renderer の CI が落ちた)。gzip とファイルの読み書きは app の main だけが持つ。
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
 */

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
// 検証
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** エラーメッセージに載せる値の表現(Infinity・NaN を区別できるように String 化する)。 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `文字列 ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
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
    .map((k) => `${k}=${row[k] === undefined ? "(なし)" : String(row[k])}`)
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

/** 1 行(1 表の 1 行)を検証する。列の集合は完全一致・型・NOT NULL。 */
function validateRow(table: MigrationTableName, value: unknown, where: string): MigrationRow {
  if (!isPlainObject(value)) {
    throw new MigrationFormatError(`${where}: ${table} の行がオブジェクトでない(実際: ${describeValue(value)})`);
  }
  const spec = MIGRATION_TABLES[table];
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
    const problem = columnTypeProblem(column, value[column.name]);
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
): readonly MigrationRow[] {
  if (!Array.isArray(value)) {
    throw new MigrationFormatError(`${where}: ${table} の行の並びが配列でない(実際: ${describeValue(value)})`);
  }
  return value.map((v) => {
    const row = validateRow(table, v, where);
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
): MigrationRow | null {
  if (value === null) {
    return null;
  }
  const row = validateRow(table, value, where);
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

function validateAnalysisLine(obj: Record<string, unknown>): MigrationAnalysisLine {
  requireKeys(obj, ["type", "analysis", "horses", "bets", "allocationMeta"], "分析の行");
  const analysis = validateRow("analyses", obj["analysis"], "分析の行");
  const id = analysis["id"] as number;
  const where = `分析の行(analysis.id=${id})`;
  const owner = { column: "analysis_id", value: id } as const;
  return {
    type: "analysis",
    analysis,
    horses: validateRows("analysis_horses", obj["horses"], where, owner),
    bets: validateRows("analysis_bets", obj["bets"], where, owner),
    allocationMeta: validateNullableRow("analysis_allocation_meta", obj["allocationMeta"], where, owner),
  };
}

function validateResultLine(obj: Record<string, unknown>): MigrationResultLine {
  requireKeys(
    obj,
    ["type", "raceId", "results", "meta", "comboPayouts", "comboPayoutImports"],
    "結果の行",
  );
  const raceId = obj["raceId"];
  if (typeof raceId !== "string" || raceId === "") {
    throw new MigrationFormatError(`結果の行: raceId が空でない文字列でない(実際: ${describeValue(raceId)})`);
  }
  const where = `結果の行(raceId=${raceId})`;
  const owner = { column: "race_id", value: raceId } as const;
  return {
    type: "result",
    raceId,
    results: validateRows("race_results", obj["results"], where, owner),
    meta: validateNullableRow("race_result_meta", obj["meta"], where, owner),
    comboPayouts: validateRows("race_combo_payouts", obj["comboPayouts"], where, owner),
    comboPayoutImports: validateRows("race_combo_payout_imports", obj["comboPayoutImports"], where, owner),
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
 */
export function validateMigrationLine(value: unknown): MigrationLine {
  if (!isPlainObject(value)) {
    throw new MigrationFormatError(`行がオブジェクトでない(実際: ${describeValue(value)})`);
  }
  switch (value["type"]) {
    case "header":
      return validateHeader(value);
    case "analysis":
      return validateAnalysisLine(value);
    case "result":
      return validateResultLine(value);
    case "footer":
      return validateFooter(value);
    default:
      throw new MigrationFormatError(`未知の行の種類 type=${describeValue(value["type"])}`);
  }
}

/** NDJSON の 1 行(文字列)を読んで検証する。JSON として壊れていれば {@link MigrationFormatError}。 */
export function parseMigrationLine(text: string): MigrationLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new MigrationFormatError(`JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateMigrationLine(value);
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
