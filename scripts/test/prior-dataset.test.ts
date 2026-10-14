import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  assembleFile,
  buildRaceRows,
  encodeChunk,
  PRIOR_EXPORT_FORMAT,
  PRIOR_ROW_KEYS,
  toContributions,
  type ChosenAnalysis,
  type PriorDatasetRow,
} from "../../cloud/src/prior-export-format.js";
import { groupByRace, guardedOnly, loadPriorDataset, parsePriorDataset, summarize } from "../prior-dataset.js";

/**
 * Issue #266: 書き出したファイル(NDJSON を gzip。メタ行 + 行)を、開発側で読み込んで型つきの行にするローダ。
 * #258 の第 2 段(重みの当て直し)の入力になる。黙って捨てず、壊れた行・読めない版・件数の食い違い(途中で切れたファイル)は例外にする。
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const chosen = (id: number, raceId: string, leak: ChosenAnalysis["leakClass"] = "guarded"): ChosenAnalysis => ({
  id, raceId, analyzedAt: "2026-10-09T01:00:00.000Z", kaisaiDate: "20261010", promptVersion: "v9", detailKey: `analyses/${id}.json.gz`,
  evEstimated: false, promptLookaheadGuarded: leak === "guarded" ? true : null, leakClass: leak,
});

const contributions = new Map([[1, toContributions([{ biasName: "近走着順", applied: true, weight: 0.2, correction: 0.05, sampleCount: 5, targetRate: 0.6, overallRate: 0.33 }])]]);
const horses = [{ umaban: 1, prior: 0.3, adjustedProb: 0.32, placeOddsMin: 2.1 }, { umaban: 2, prior: 0.2, adjustedProb: 0.19, placeOddsMin: null }];
const results = [{ umaban: 1, finishPosition: 2, winOdds: 4.5, ninki: 2 }, { umaban: 2, finishPosition: null, winOdds: null, ninki: null }];

function sampleRows(): PriorDatasetRow[] {
  return [
    ...buildRaceRows(chosen(1, "202606030801"), horses, results, "芝", contributions),
    ...buildRaceRows(chosen(2, "202606030802", "pre_race"), horses, results, null, new Map()),
  ];
}

const META = { generatedAt: "2026-10-10T12:00:00.000Z", races: 2, missingDetail: 1, excluded: { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 } };

function sampleFile(rows = sampleRows(), meta: { rows?: number } = {}): Uint8Array {
  return assembleFile({ ...META, rows: meta.rows ?? rows.length }, [encodeChunk(rows.slice(0, 3)), encodeChunk(rows.slice(3))]);
}

describe("parsePriorDataset", () => {
  it("書き出しの形式(複数メンバーの gzip)をそのまま読み、メタと型つきの行を返す。書き出した行と往復で一致する", () => {
    const rows = sampleRows();
    expect(rows).toHaveLength(4); // 前提: 2 レース × 2 頭
    const loaded = parsePriorDataset(sampleFile(rows));
    expect(loaded.meta).toMatchObject({ format: PRIOR_EXPORT_FORMAT, rows: 4, races: 2, missingDetail: 1, generatedAt: META.generatedAt });
    expect(loaded.meta.columns).toEqual([...PRIOR_ROW_KEYS]);
    expect(loaded.rows).toEqual(JSON.parse(JSON.stringify(rows)));
    expect(loaded.rows[0]!.contributions).toEqual([{ biasName: "近走着順", applied: true, weight: 0.2, correction: 0.05, sampleCount: 5, targetRate: 0.6, overallRate: 0.33 }]);
    expect(loaded.rows[1]).toMatchObject({ finish_position: null, win_odds: null, ninki: null, place_odds_min: null, contributions: null });
  });

  it("読めない版(format が違う)は例外", () => {
    const text = `${JSON.stringify({ _meta: { format: PRIOR_EXPORT_FORMAT + 1, rows: 0 } })}\n`;
    expect(() => parsePriorDataset(gzipSync(Buffer.from(text)))).toThrow(/版/);
  });

  it("先頭がメタ行でない・空のファイルは例外", () => {
    expect(() => parsePriorDataset(gzipSync(Buffer.from("")))).toThrow(/メタ行/);
    expect(() => parsePriorDataset(gzipSync(Buffer.from(`${JSON.stringify(sampleRows()[0])}\n`)))).toThrow(/メタ行/);
  });

  it("メタ行の rows と実際の行数が食い違う(途中で切れた・混ざった)ファイルは例外", () => {
    const rows = sampleRows();
    expect(() => parsePriorDataset(sampleFile(rows, { rows: rows.length + 1 }))).toThrow(/件数/);
  });

  it("JSON でない行は、行番号つきの例外", () => {
    const text = `${JSON.stringify({ _meta: { format: PRIOR_EXPORT_FORMAT, rows: 1 } })}\n{broken\n`;
    expect(() => parsePriorDataset(gzipSync(Buffer.from(text)))).toThrow(/2 行目/);
  });

  it.each([
    ["列が足りない", (r: Record<string, unknown>) => { delete r["ninki"]; }],
    ["知らない列がある(自由文が混ざった等)", (r: Record<string, unknown>) => { r["reason"] = "x"; }],
    ["prior が数でない", (r: Record<string, unknown>) => { r["prior"] = "0.3"; }],
    ["umaban が整数でない", (r: Record<string, unknown>) => { r["umaban"] = 1.5; }],
    ["venue_kind が未知の値", (r: Record<string, unknown>) => { r["venue_kind"] = "tokyo"; }],
    ["leak_class が未知の値", (r: Record<string, unknown>) => { r["leak_class"] = "other"; }],
    ["contributions の項目の biasName が文字列でない(ほかの属性は正しい)", (r: Record<string, unknown>) => { r["contributions"] = [{ biasName: 3, applied: true, weight: 0.1, correction: 0, sampleCount: null, targetRate: null, overallRate: null }]; }],
    ["contributions の項目の applied が真偽値でない(ほかの属性は正しい)", (r: Record<string, unknown>) => { r["contributions"] = [{ biasName: "a", applied: 1, weight: 0.1, correction: 0, sampleCount: null, targetRate: null, overallRate: null }]; }],
    ["contributions の項目の数値が文字列", (r: Record<string, unknown>) => { r["contributions"] = [{ biasName: "a", applied: true, weight: "0.1", correction: 0, sampleCount: null, targetRate: null, overallRate: null }]; }],
    ["ev_estimated が真偽値でない", (r: Record<string, unknown>) => { r["ev_estimated"] = 0; }],
  ])("行が壊れている(%s)と、行番号つきの例外", (_name, mutate) => {
    const row = JSON.parse(JSON.stringify(sampleRows()[0])) as Record<string, unknown>;
    mutate(row);
    const text = `${JSON.stringify({ _meta: { format: PRIOR_EXPORT_FORMAT, rows: 1 } })}\n${JSON.stringify(row)}\n`;
    expect(() => parsePriorDataset(gzipSync(Buffer.from(text)))).toThrow(/2 行目/);
  });
});

describe("loadPriorDataset(ファイルから)", () => {
  it("ファイルのパスから読む。無いファイルは例外", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prior-dataset-"));
    dirs.push(dir);
    const file = path.join(dir, "prior-dataset.ndjson.gz");
    writeFileSync(file, sampleFile());
    expect(loadPriorDataset(file).rows).toHaveLength(4);
    expect(() => loadPriorDataset(path.join(dir, "none.gz"))).toThrow();
  });
});

describe("guardedOnly・groupByRace・summarize", () => {
  const loaded = parsePriorDataset(sampleFile());

  it("guardedOnly は leak_class が guarded の行だけ(history_cutoff_date ありの母集団)。pre_race は含めない", () => {
    expect(loaded.rows.map((r) => r.leak_class)).toEqual(["guarded", "guarded", "pre_race", "pre_race"]); // 前提: 両方ある
    expect(guardedOnly(loaded.rows).map((r) => r.analysis_id)).toEqual([1, 1]);
  });

  it("groupByRace はレースごと(出現順)に行を束ねる", () => {
    const groups = groupByRace(loaded.rows);
    expect([...groups.keys()]).toEqual(["202606030801", "202606030802"]);
    expect([...groups.values()].map((g) => g.length)).toEqual([2, 2]);
  });

  it("summarize は行数・レース数・区分別・遮断の区分別・寄与度なし・着順なしの件数を返す", () => {
    expect(summarize(loaded.rows)).toEqual({
      rows: 4, races: 2, byVenueKind: { central: 4, nar: 0 }, byLeakClass: { guarded: 2, pre_race: 2 }, withoutContributions: 3, withoutFinish: 2,
    });
  });
});
