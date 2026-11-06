import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #639: JRA の出馬表の取得は**保存するだけ**で、発走前の分析・プロンプト・画面は、その結果を読まない。
 * 読む経路を足すなら(#542・#636 で効くと分かってから)、このテストの許可リストを意図して直す。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

const rel = (f: string): string => path.relative(ROOT, f).split(path.sep).join("/");
const SRC = [...sources(path.join(ROOT, "cloud", "src")), ...sources(path.join(ROOT, "cloud", "client")), ...sources(path.join(ROOT, "packages", "core", "src"))];
/** コメントを除いたコード(コメントでの言及は読む経路ではない)。 */
const read = (f: string): string => readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("保存するだけ(読む側に足さない)", () => {
  it("前提: ソースを実際に走査できている(空振りでない)", () => {
    expect(SRC.length).toBeGreaterThan(100);
    expect(SRC.map(rel)).toContain("cloud/src/jra-entries-repository.ts");
    expect(SRC.map(rel)).toContain("cloud/src/race-day-core.ts");
  });

  it("馬・馬主・出走時の情報の表を名指しするのは、保存先(jra-entries-repository.ts)だけ。分析・プロンプト・画面・検証のどこも読まない", () => {
    const tables = /\b(horse_profiles|horse_owner_history|race_horse_entries)\b/;
    const hits = SRC.filter((f) => tables.test(read(f))).map(rel);
    expect(hits).toEqual(["cloud/src/jra-entries-repository.ts"]);
  });

  it("取得の段・取得口・保存先を import するのは、日単位の DO の core と DO のラッパだけ(分析の経路は import しない)", () => {
    const importer = /from\s+"[^"]*\/(race-day-jra-entries|jra-entries-fetch|jra-entries-repository|jra-entries-parse)"/;
    const hits = SRC.filter((f) => importer.test(read(f))).map(rel).sort();
    expect(hits).toEqual(
      [
        "cloud/src/jra-entries-fetch.ts", // → jra-entries-parse
        "cloud/src/jra-entries-repository.ts", // → jra-entries-parse(型)
        "cloud/src/race-day-core.ts",
        "cloud/src/race-day-do.ts",
        "cloud/src/race-day-jra-entries.ts", // → jra-entries-fetch・jra-entries-repository(型)
      ].sort(),
    );
  });

  it("発走前の分析(runCloudAnalysis・analysis の経路)に JRA の出馬表の語が出ない", () => {
    const analysisPath = SRC.filter((f) => /\/(analysis|run-analysis|cloud-analysis|prompt)[^/]*\.ts$/.test(rel(f)) || rel(f).startsWith("packages/core/src/analyzer/"));
    expect(analysisPath.length).toBeGreaterThan(5); // 空振りでない
    for (const f of analysisPath) {
      expect(read(f), rel(f)).not.toMatch(/jra-entries|JraEntries|race_horse_entries|horse_profiles|horse_owner_history/);
    }
  });
});
