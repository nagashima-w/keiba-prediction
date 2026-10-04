import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync as realRename, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../../spikes/cloudflare/atomic-write.js";

/**
 * #159 結果ファイル(spike-result.json)の原子的な書き込み。書き込み中に切れても、cleanup-run が読む
 * ファイルが壊れた JSON にならないこと(書きかけの一時ファイルが本体になってはいけない)。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cf-spike-atomic-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("JSON を書き、読み戻すと元のデータに一致する。一時ファイルは残らない", () => {
    const target = path.join(dir, "result.json");
    writeJsonAtomic(target, { a: 1, b: ["日本語"] });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ a: 1, b: ["日本語"] });
    expect(readdirSync(dir)).toEqual(["result.json"]);
  });

  it("既存のファイルを上書きできる", () => {
    const target = path.join(dir, "result.json");
    writeJsonAtomic(target, { v: 1 });
    writeJsonAtomic(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ v: 2 });
    expect(readdirSync(dir)).toEqual(["result.json"]);
  });

  it("本体に書く前に、同じディレクトリの別名の一時ファイルへ書き、rename で差し替える", () => {
    const target = path.join(dir, "result.json");
    const renames: [string, string][] = [];
    writeJsonAtomic(target, { v: 1 }, {
      renameSync: (from, to) => {
        // rename の時点で、一時ファイルには完全な JSON があり、本体はまだ無い
        expect(JSON.parse(readFileSync(from, "utf-8"))).toEqual({ v: 1 });
        expect(existsSync(to)).toBe(false);
        renames.push([from, to]);
        realRename(from, to);
      },
    });
    expect(renames).toHaveLength(1);
    expect(renames[0]![0]).not.toBe(target);
    expect(path.dirname(renames[0]![0])).toBe(dir);
    expect(renames[0]![1]).toBe(target);
  });

  it("rename が失敗しても(書き込みの途中で切れた状態の再現)、既存の本体は壊れず、例外は呼び出し元に伝わる", () => {
    const target = path.join(dir, "result.json");
    writeFileSync(target, JSON.stringify({ old: true }));
    expect(() =>
      writeJsonAtomic(target, { v: "new" }, {
        renameSync: () => {
          throw new Error("disk error");
        },
      }),
    ).toThrow("disk error");
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ old: true });
  });
});
