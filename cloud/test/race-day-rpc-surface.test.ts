import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #206: Worker が日単位の DO(RaceDay)に対して呼ぶ RPC(`RaceDayStubLike`。handler.ts)の名前が、`race-day-do.ts` の `RaceDay` クラスのメソッドとして実在すること。
 * 型(`RaceDayStubLike`)は Worker 側の宣言にすぎず、DO のクラスに実体が無くても typecheck も Node の単体テストも通る(偽物のスタブで検査するため)。
 * 実際に `getPlanProgress` が `RaceDayCore` にだけあって `RaceDay` に無い欠落が、#206 の着手前調査で見つかった。ここで静的に固定する(本物の DO を通す確認は smoke)。
 * `cloudflare:workers` を持つ race-day-do.ts は import できないので、ソースを読んで比べる。
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (name: string): string => readFileSync(path.join(SRC, name), "utf-8").replace(/\r\n/g, "\n");

/** ブロックコメント・行コメントを除く。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `export interface <name> {` の本体(最初の `\n}` まで)のメンバ名(メソッドの形 `name(`)。 */
function interfaceMethods(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `${name} の宣言`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]!);
}

/** `export class <name> ` の本体のメソッド名(2 スペースのインデントで `name(` または `async name(`)。 */
function classMethods(source: string, name: string): string[] {
  const start = source.indexOf(`export class ${name} `);
  expect(start, `${name} の宣言`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start);
  return [...body.matchAll(/^ {2}(?:async )?(\w+)\(/gm)].map((m) => m[1]!).filter((n) => n !== "constructor");
}

describe("RaceDayStubLike の RPC は RaceDay クラスに実在する", () => {
  const handler = stripComments(read("handler.ts"));
  const doSource = stripComments(read("race-day-do.ts"));
  const rpcNames = interfaceMethods(handler, "RaceDayStubLike");
  const classNames = classMethods(doSource, "RaceDay");

  it("前提: 宣言と実体の両方を読めている(空振りでない)。Issue #206 で足した 4 つ(requestPlan・getPlanProgress・getAutoRunResults・getNotifications)を含む", () => {
    expect(rpcNames.length).toBeGreaterThanOrEqual(8);
    for (const name of ["schedule", "getBoard", "getMorningPrior", "getRaceList", "requestPlan", "getPlanProgress", "getAutoRunResults", "getNotifications"]) {
      expect(rpcNames, `RaceDayStubLike に ${name}`).toContain(name);
    }
    expect(classNames).toContain("alarm");
  });

  it("RaceDayStubLike の各 RPC 名が、RaceDay クラスのメソッドとして実在する", () => {
    const missing = rpcNames.filter((n) => !classNames.includes(n));
    expect(missing).toEqual([]);
  });

  it("検出の確認(空振りでない): クラスに無い名前は拾う", () => {
    const fakeClass = "export class RaceDay extends X {\n  schedule(a) {}\n  async getBoard() {}\n}\n";
    expect(classMethods(fakeClass, "RaceDay")).toEqual(["schedule", "getBoard"]);
    expect(["schedule", "getPlanProgress"].filter((n) => !classMethods(fakeClass, "RaceDay").includes(n))).toEqual(["getPlanProgress"]);
  });
});
