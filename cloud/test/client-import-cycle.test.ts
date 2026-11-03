import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #578-3: `cloud/client` の `list.ts` と `race.ts` が互いを import する循環を無くした(両方が使う部品は `badge.ts`)。
 * 循環が戻らないことの静的ガード。`import type` も含める(型だけでも依存の向きは同じ)。
 */
const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "client");

function specifiersOf(file: string): string[] {
  const source = readFileSync(path.join(CLIENT, file), "utf8");
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

describe("client の import の向き: list ↔ race の循環を作らない", () => {
  it("前提: list.ts は race を、race.ts は badge を import している(検査が空振りしていない)", () => {
    expect(specifiersOf("list.ts")).toContain("./race");
    expect(specifiersOf("race.ts")).toContain("./badge");
  });

  it("race.ts と badge.ts は ./list を import しない", () => {
    expect(specifiersOf("race.ts")).not.toContain("./list");
    expect(specifiersOf("badge.ts")).not.toContain("./list");
    expect(specifiersOf("badge.ts")).not.toContain("./race");
  });
});
