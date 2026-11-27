import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { doStub } from "../src/do-stub";

/**
 * Issue #811: すべての Durable Object は、アジア太平洋(apac)に置く希望(locationHint)を付けて作る。
 * 希望が効くのは新しく作られる DO だけで、保証ではない。stub を作る箇所が 1 つでも直接 get すると希望が落ちるので、静的に固定する。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(CLOUD, "src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const others = files.filter((f) => f !== "do-stub.ts");
const read = (f: string): string => readFileSync(path.join(SRC, f), "utf-8");

/** wrangler.toml の [[durable_objects.bindings]] の name を全部取る。 */
function bindingNames(): string[] {
  const toml = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
  const section = toml.split(/^\[\[durable_objects\.bindings\]\]/m).slice(1);
  return section.map((s) => /^\s*name\s*=\s*"([^"]+)"/m.exec(s)?.[1]).filter((n): n is string => n !== undefined);
}

describe("doStub", () => {
  it("名前から id を作り、locationHint apac を付けて get する", () => {
    const calls: unknown[][] = [];
    const ns = {
      idFromName: (name: string) => ({ id: name }),
      get: (...args: unknown[]) => {
        calls.push(args);
        return { stub: true };
      },
    };
    expect(doStub(ns, "20261128")).toEqual({ stub: true });
    expect(calls).toEqual([[{ id: "20261128" }, { locationHint: "apac" }]]);
  });

  it("第 2 引数を無視する偽の名前空間でも動く", () => {
    const ns = { idFromName: (n: string) => n, get: (id: string) => ({ id }) };
    expect(doStub(ns, "20261129")).toEqual({ id: "20261129" });
  });
});

describe("DO の stub は doStub の外で作らない", () => {
  it("wrangler.toml の binding 名を取れている(空振り防止。RaceDay・NetkeibaGate を含み 10 個以上)", () => {
    const names = bindingNames();
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain("RACE_DAY");
    expect(names).toContain("NETKEIBA_GATE");
    expect(files.length).toBeGreaterThan(50);
  });

  it("binding 名に直接 .get( を呼ぶ箇所が無い(do-stub.ts 以外)", () => {
    const re = new RegExp(`\\b(?:${bindingNames().join("|")})\\s*\\.\\s*get\\s*\\(`);
    expect(others.filter((f) => re.test(read(f)))).toEqual([]);
  });

  it("idFromName・newUniqueId・idFromString・getByName を呼ぶ箇所が無い(do-stub.ts 以外。型の宣言 `idFromName(name: string)` は除く)", () => {
    const re = /\.\s*(?:idFromName|newUniqueId|idFromString|getByName)\s*\(|(?<![\w.])(?:newUniqueId|idFromString|getByName)\s*\(/;
    const offenders = others.filter((f) =>
      read(f)
        .split("\n")
        .some((line) => !/^\s*(\*|\/\/)/.test(line) && re.test(line)),
    );
    expect(offenders).toEqual([]);
  });

  it("doStub を使う箇所がある(空振り防止)", () => {
    expect(others.filter((f) => /\bdoStub\s*\(/.test(read(f))).sort()).toEqual(["handler.ts", "race-archive-fetch-do.ts", "race-day-do.ts", "result-backfill-do.ts", "scheduled.ts"]);
  });

  it("do-stub.ts が locationHint apac を渡している", () => {
    expect(read("do-stub.ts")).toContain("locationHint: DO_LOCATION_HINT");
    expect(read("do-stub.ts")).toContain('DO_LOCATION_HINT = "apac"');
  });
});
