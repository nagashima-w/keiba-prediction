import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #586・#587: 手元の開発用の道具(cloud/ 直下。REST で本番の D1・R2 を読む)は、本番の Worker の束に入らない。
 * Worker は `src/` から辿れるものだけをバンドルするので、`src/` のどのファイルもこれらを(型だけの import も含めて)import していないことを固定する。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** import・re-export・動的 import の指定子(型だけのものも含む)。 */
const specifiersOf = (source: string): string[] => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
const TOOLS = ["cf-readonly-client", "pull-race-archive", "build-prior-dataset"];

describe("開発用の道具は Worker の束に入らない", () => {
  it("cloud/src のどのファイルも、道具を import しない(型だけの import も含む)", () => {
    const files = readdirSync(path.join(CLOUD, "src")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(50); // 走査の対象が空でないこと
    const offenders = files.filter((f) => specifiersOf(readFileSync(path.join(CLOUD, "src", f), "utf-8")).some((s) => TOOLS.some((t) => s.includes(t))));
    expect(offenders).toEqual([]);
  });

  it("道具のファイルは実在する(名前を変えて、この検査が空振りしないようにする)", () => {
    const names = readdirSync(CLOUD);
    for (const t of ["cf-readonly-client.ts", "pull-race-archive.ts", "build-prior-dataset.ts"]) expect(names).toContain(t);
  });
});
