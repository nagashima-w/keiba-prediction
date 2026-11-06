import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #624(#616 の段階 1): 検証が読む表に書き込む SQL を持つファイルを許可リストに固定する。
 * 新しい書き込みの経路が足されたらこのテストが赤になり、「変更の印(verify_race_mark)を付けるか」を決めさせる(付け忘れると、検証の差分の再計算が古い値を返し続ける)。
 *
 * 検出は 2 通り: (1) SQL の文字列に「INSERT/UPDATE/DELETE/REPLACE … 表の名前」がある、(2) core の codec が持つ書き込みの SQL の定数を参照している(codec の文は表の名前を定数で組む)。
 * コメントは除いて見る(コメントに書かれた SQL を数えない)。
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 検証が読む表(cloud/src/verify-read.ts・verify-store.ts・verify-close.ts の SELECT が読むもの)。 */
const VERIFY_TABLES = [
  "analyses",
  "analysis_horses",
  "analysis_allocation_meta",
  "analysis_bets",
  "analysis_close",
  "analysis_close_bets",
  "race_results",
  "race_result_meta",
  "race_combo_payouts",
  "race_combo_payout_imports",
];

/** codec の書き込みの SQL の定数(packages/core/src/ev/analysis-store-codec.ts)。 */
const CODEC_WRITE_CONSTANTS = [
  "INSERT_ANALYSIS_SQL",
  "INSERT_ANALYSIS_HORSE_SQL",
  "INSERT_ALLOCATION_META_SQL",
  "INSERT_ALLOCATION_BET_SQL",
  "UPSERT_RACE_RESULT_SQL",
  "UPSERT_RACE_RESULT_META_SQL",
  "DELETE_COMBO_PAYOUTS_SQL",
  "INSERT_COMBO_PAYOUT_SQL",
  "MARK_COMBO_IMPORTED_SQL",
];

/** 許可リスト: 検証の表に書き込む SQL を持つファイル(これ以外に増えたら赤)。 */
const ALLOWED_WRITERS = ["analysis-close.ts", "analysis-repository.ts", "result-repository.ts", "verify-store.ts"];

/** 印の呼び出し箇所の数(経路の数)。9 経路 = analysis-repository 2(saveAnalysis・saveClose)+ result-repository 6(saveResult・saveWinOdds・saveScratched・saveWinPayout・saveRaceClass・fillNullKaisaiDates〈Issue #630〉)+ verify-store 1(commitStartTimes)。 */
const MARK_CALL_SITES: Readonly<Record<string, number>> = { "analysis-repository.ts": 2, "result-repository.ts": 6, "verify-store.ts": 1 };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

const files = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts") && f !== "client-bundle.generated.ts")
  .map((f) => ({ name: f, code: stripComments(readFileSync(path.join(SRC, f), "utf-8")) }));

const tablePattern = `(?:${VERIFY_TABLES.join("|")})`;
const writeRe = new RegExp(`\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+${tablePattern}\\b`, "i");

function writesVerifyTables(code: string): boolean {
  return writeRe.test(code) || CODEC_WRITE_CONSTANTS.some((c) => new RegExp(`\\b${c}\\b`).test(code));
}

describe("検証が読む表への書き込みの経路(許可リスト)", () => {
  it("前提(空振り防止): 走査したファイルが多数あり、許可リストのファイルは全部存在して、検出がそれらを拾う", () => {
    expect(files.length).toBeGreaterThan(40);
    for (const name of ALLOWED_WRITERS) {
      const f = files.find((x) => x.name === name);
      expect(f, name).toBeDefined();
      expect(writesVerifyTables(f!.code), `${name} は検出されるはず`).toBe(true);
    }
  });

  it("検出の正規表現が、典型的な書き込みを拾い、読み取りとコメントを拾わない", () => {
    expect(writeRe.test("db.prepare('UPDATE analyses SET a = 1')")).toBe(true);
    expect(writeRe.test("INSERT OR IGNORE INTO race_results (a)")).toBe(true);
    expect(writeRe.test("DELETE FROM analysis_close_bets WHERE")).toBe(true);
    expect(writeRe.test("SELECT * FROM analyses WHERE x")).toBe(false);
    expect(writeRe.test("UPDATE race_backfill SET")).toBe(false);
    expect(stripComments("// INSERT INTO analyses\nconst a = 1; /* UPDATE analyses */")).not.toMatch(/INSERT|UPDATE/);
  });

  it("書き込みの SQL を持つファイルは、許可リストのファイルだけ(新しい経路が足されたら赤)", () => {
    const writers = files.filter((f) => writesVerifyTables(f.code)).map((f) => f.name);
    expect(writers).toEqual(ALLOWED_WRITERS);
  });

  it("印を付ける経路の数が固定されている(9 経路。許可リストの書き手が印を呼ばないままにならない)", () => {
    for (const [name, expected] of Object.entries(MARK_CALL_SITES)) {
      const code = files.find((f) => f.name === name)!.code;
      const calls = code.match(/\bverifyRaceMark(?:ByAnalysisIds)?Statement\(/g) ?? [];
      expect(calls.length, name).toBe(expected);
    }
    expect(Object.values(MARK_CALL_SITES).reduce((a, b) => a + b, 0)).toBe(9);
  });
});
