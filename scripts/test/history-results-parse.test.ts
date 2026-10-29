import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parseParseArgs, runParse } from "../history-results/parse-lib.js";
import { rawFilePath } from "../history-results/layout.js";

/**
 * Issue #532 段階 1: 解析(parse)のテスト。raw/result を読んで NDJSON の gzip を書く。ネットワークには出ない。
 * 手元のフィクスチャを raw の形に置いて通す(中央 2021・2026、地方 Jpn1 2021)。
 */

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "history-parse-"));
  dirs.push(d);
  return d;
};

function put(dir: string, kind: "central" | "nar", id: string, content: string | Buffer, gz = true): void {
  const p = rawFilePath(dir, kind, "result", id);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, gz ? gzipSync(content) : content);
}

const readOut = (file: string): Record<string, any>[] =>
  gunzipSync(readFileSync(file))
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, any>);

describe("parse: raw/result → NDJSON(gzip)", () => {
  it("1 行 1 レース・中央と地方を kind で区別・日付順に並べる", () => {
    const dir = tmp();
    put(dir, "central", "202105040811", fx("history_central_result_202105040811.html"));
    put(dir, "nar", "202146110310", fx("history_nar_result_202146110310.html"));
    put(dir, "central", "202605040807", fx("result_202605040807.html"));
    const out = path.join(dir, "out.ndjson.gz");
    const summary = runParse({ dir, outFile: out, log: () => {} });
    const rows = readOut(out);
    expect(rows.map((r) => [r.kind, r.raceId, r.date])).toEqual([
      ["central", "202105040811", "2021-10-31"],
      ["nar", "202146110310", "2021-11-03"],
      ["central", "202605040807", "2026-10-24"],
    ]);
    expect(rows[0]!.horses).toHaveLength(16);
    expect(rows[1]!.horses).toHaveLength(12);
    expect(rows[0]!.horses[0]).toMatchObject({ umaban: 5, jockeyId: "01170", burden: 56, passing: [6, 6, 6] });
    expect(rows[2]!.horses[1]).toMatchObject({ jockeyMark: "◇", burden: 52 });
    expect(summary).toMatchObject({ total: 3, ok: 3, rejected: 0 });
    expect(summary.rejectedByCategory).toEqual({});
    // 手元の 3 レースでは注意の件数はすべて 0(地方だけ通過順の列が無い)
    expect(summary.notes).toEqual({
      fieldSizeMismatch: 0,
      narNotJpn: 0,
      missingColumnRaces: 1,
      misalignedRaces: 0,
      bodyWeightDiffNonNumeric: 0,
      timeNonNumeric: 0,
      horseIdMissing: 0,
      jockeyIdMissing: 0,
      trainerIdMissing: 0,
    });
  });

  it("読めなかったページは出力に入れず、理由つきで数え、rejects ファイルに残す", () => {
    const dir = tmp();
    put(dir, "central", "202105040811", fx("history_central_result_202105040811.html"));
    // 年が違う race_id で置かれたページ
    put(dir, "central", "202205040811", fx("history_central_result_202105040811.html"));
    // gzip として壊れているファイル
    put(dir, "central", "202105040801", Buffer.from("これはgzipではない"), false);
    // 表の無いページ
    put(dir, "nar", "202146110312", "<html><title>x</title></html>");
    // 種別の置き場違い(地方のページを中央の置き場に)
    put(dir, "central", "202146110310", fx("history_nar_result_202146110310.html"));
    const out = path.join(dir, "out.ndjson.gz");
    const lines: string[] = [];
    const summary = runParse({ dir, outFile: out, log: (m) => lines.push(m) });
    expect(readOut(out).map((r) => r.raceId)).toEqual(["202105040811"]);
    expect(summary.total).toBe(5);
    expect(summary.ok).toBe(1);
    expect(summary.rejected).toBe(4);
    expect(summary.rejectedByCategory).toEqual({ 年不一致: 1, gzip失敗: 1, 構造異常: 1, 種別不一致: 1 });
    const rejects = readFileSync(`${out}.rejects.ndjson`, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(rejects).toHaveLength(4);
    expect(rejects.map((r) => r.raceId).sort()).toEqual(["202105040801", "202146110310", "202146110312", "202205040811"]);
    expect(rejects.every((r) => typeof r.category === "string" && typeof r.detail === "string")).toBe(true);
    // 最後に件数を出す
    const joined = lines.join("\n");
    expect(joined).toMatch(/読めた 1/);
    expect(joined).toMatch(/読めない 4/);
    expect(joined).toContain("年不一致");
  });

  it("raw が 1 件も無いディレクトリは、0 件として終える(例外にしない)が、出力は空のファイル", () => {
    const dir = tmp();
    const out = path.join(dir, "out.ndjson.gz");
    const summary = runParse({ dir, outFile: out, log: () => {} });
    expect(summary).toMatchObject({ total: 0, ok: 0, rejected: 0 });
    expect(readOut(out)).toEqual([]);
  });

  it("頭数の食い違い・地方で Jpn でない格・欠けた列などの注意を件数で報告する", () => {
    const dir = tmp();
    put(dir, "nar", "202146110310", fx("history_nar_result_202146110310.html"));
    // 地方の Jpn1 のページから、title と h1 の格を外して「Jpn でない」ページにする
    const noGrade = fx("history_nar_result_202146110310.html").replaceAll("Jpn1", "").replaceAll("金沢10R", "金沢9R").replaceAll("202146110310", "202146110309");
    expect(noGrade).not.toContain("Jpn");
    put(dir, "nar", "202146110309", noGrade);
    const out = path.join(dir, "out.ndjson.gz");
    const summary = runParse({ dir, outFile: out, log: () => {} });
    expect(summary.ok).toBe(2);
    expect(summary.notes.narNotJpn).toBe(1);
    expect(summary.notes.missingColumnRaces).toBe(2); // 地方は通過順の列が無い
    expect(summary.notes.fieldSizeMismatch).toBe(0);
  });

  it("宣言された頭数と結果の行数が違うレースは、出力には入れて、件数だけ報告する", () => {
    const dir = tmp();
    const html = fx("history_central_result_202105040811.html");
    expect(html).toContain("<span>16頭</span>");
    put(dir, "central", "202105040811", html.replace("<span>16頭</span>", "<span>17頭</span>"));
    const out = path.join(dir, "out.ndjson.gz");
    const summary = runParse({ dir, outFile: out, log: () => {} });
    expect(summary.ok).toBe(1);
    expect(summary.notes.fieldSizeMismatch).toBe(1);
    expect(readOut(out)[0]).toMatchObject({ fieldSizeDeclared: 17 });
    expect(readOut(out)[0]!.horses).toHaveLength(16);
  });
});

describe("parseParseArgs", () => {
  it("ディレクトリと --out が必須", () => {
    expect(parseParseArgs(["/d", "--out", "/o.ndjson.gz"])).toEqual({ ok: true, value: { dir: "/d", outFile: "/o.ndjson.gz" } });
    expect(parseParseArgs(["/d"]).ok).toBe(false);
    expect(parseParseArgs(["--out", "/o"]).ok).toBe(false);
    expect(parseParseArgs(["/d", "/e", "--out", "/o"]).ok).toBe(false);
  });
});
