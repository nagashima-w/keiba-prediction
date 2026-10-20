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
  PRIOR_ROW_KEYS_V1,
  PRIOR_ROW_KEYS_V2_ADDED,
  PRIOR_ROW_KEYS_V3_ADDED,
  toContributions,
  toSnapshotColumns,
  type ChosenAnalysis,
  type PriorDatasetRow,
} from "../../cloud/src/prior-export-format.js";
import { groupByRace, guardedOnly, loadPriorDataset, parsePriorDataset, summarize, v2ColumnCoverage, v3ColumnCoverage } from "../prior-dataset.js";

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
    ...buildRaceRows(chosen(1, "202606030801"), horses, results, "芝", contributions, null),
    ...buildRaceRows(chosen(2, "202606030802", "pre_race"), horses, results, null, new Map(), null),
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

// ---------------------------------------------------------------------------
// Issue #341(#340-1): 形式 v2(出馬表の列を足した)。ローダは v1・v2 の両方を読む。
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  race: { raceName: "テストS", grade: "G3", distance: 1600, trackCondition: "良", weightType: "馬齢", filliesOnly: true },
  horses: [
    { umaban: 1, wakuban: 1, sex: "牡", age: 3, kinryo: 56, bodyWeight: 480, oikiriRank: "A", oikiriCritic: "動き良化" },
    { umaban: 2, wakuban: 2, sex: "牝", age: 4, kinryo: 54, bodyWeight: null, oikiriRank: null, oikiriCritic: null },
  ],
};

/** v2 の列が入った行(レース 1 はスナップショットあり、レース 2 はなし)。 */
function v2Rows(): PriorDatasetRow[] {
  return [
    ...buildRaceRows(chosen(1, "202606030801"), horses, results, "芝", contributions, toSnapshotColumns(SNAPSHOT)),
    ...buildRaceRows(chosen(2, "202606030802"), horses, results, "芝", new Map(), null),
  ];
}

const gz = (meta: object, rows: readonly object[]): Uint8Array => gzipSync(Buffer.from(`${[{ _meta: meta }, ...rows].map((x) => JSON.stringify(x)).join("\n")}\n`));

/** v2 の行: v1 の 19 列 + v2 の 11 列(v3 の列を持たない)。 */
function toV2(row: PriorDatasetRow): Record<string, unknown> {
  return Object.fromEntries([...PRIOR_ROW_KEYS_V1, ...PRIOR_ROW_KEYS_V2_ADDED].map((k) => [k, (row as unknown as Record<string, unknown>)[k]]));
}

/** v1 の行: v1 の 19 列だけ(v2 の列を持たない)。 */
function toV1(row: PriorDatasetRow): Record<string, unknown> {
  return Object.fromEntries(PRIOR_ROW_KEYS_V1.map((k) => [k, (row as unknown as Record<string, unknown>)[k]]));
}

describe("parsePriorDataset: 形式 v2(v3 の列を持たない 30 列のファイルも読める)", () => {
  it("v2 のファイルを往復で読む。meta.format は 2 のまま。v2 の 11 列が値のまま戻り、スナップショットの無いレースは 11 列とも null。v3 の 2 列は null に補う", () => {
    const rows = v2Rows();
    expect(rows).toHaveLength(4); // 前提: 2 レース × 2 頭
    const loaded = parsePriorDataset(gz({ format: 2, generatedAt: "x", rows: rows.length, races: 2, missingDetail: 0 }, rows.map(toV2)));
    expect(loaded.meta.format).toBe(2);
    expect(loaded.rows).toEqual(JSON.parse(JSON.stringify(rows.map((r) => ({ ...toV2(r), weight_type: null, fillies_only: null })))));
    expect(loaded.rows[0]).toMatchObject({ race_name: "テストS", grade: "G3", distance: 1600, track_condition: "良", wakuban: 1, sex: "牡", age: 3, body_weight: 480, kinryo: 56, oikiri_rank: "A", oikiri_critic: "動き良化" });
    expect(loaded.rows[1]).toMatchObject({ sex: "牝", body_weight: null, oikiri_critic: null });
    for (const r of loaded.rows.slice(2)) expect(PRIOR_ROW_KEYS_V2_ADDED.map((k) => r[k])).toEqual(Array(11).fill(null));
    for (const r of loaded.rows) {
      expect(PRIOR_ROW_KEYS_V3_ADDED.map((k) => r[k])).toEqual([null, null]);
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
    }
  });

  it.each([
    ["列が足りない(v2 の列 sex がない)", (r: Record<string, unknown>) => { delete r["sex"]; }, /列が足りません.*sex/],
    ["race_name が数", (r: Record<string, unknown>) => { r["race_name"] = 3; }, /型が違います.*race_name/],
    ["grade が数", (r: Record<string, unknown>) => { r["grade"] = 3; }, /型が違います.*grade/],
    ["distance が小数", (r: Record<string, unknown>) => { r["distance"] = 1600.5; }, /型が違います.*distance/],
    ["track_condition が数", (r: Record<string, unknown>) => { r["track_condition"] = 1; }, /型が違います.*track_condition/],
    ["wakuban が小数", (r: Record<string, unknown>) => { r["wakuban"] = 1.5; }, /型が違います.*wakuban/],
    ["sex が数", (r: Record<string, unknown>) => { r["sex"] = 1; }, /型が違います.*sex/],
    ["age が文字列", (r: Record<string, unknown>) => { r["age"] = "3"; }, /型が違います.*age/],
    ["body_weight が文字列", (r: Record<string, unknown>) => { r["body_weight"] = "480"; }, /型が違います.*body_weight/],
    ["kinryo が文字列", (r: Record<string, unknown>) => { r["kinryo"] = "56"; }, /型が違います.*kinryo/],
    ["oikiri_rank が数", (r: Record<string, unknown>) => { r["oikiri_rank"] = 1; }, /型が違います.*oikiri_rank/],
    ["oikiri_critic が数", (r: Record<string, unknown>) => { r["oikiri_critic"] = 1; }, /型が違います.*oikiri_critic/],
    ["馬名の列が混ざった(知らない列)", (r: Record<string, unknown>) => { r["horse_name"] = "x"; }, /知らない列.*horse_name/],
  ])("v2 の行が壊れている(%s)と、行番号と列名つきの例外", (_name, mutate, pattern) => {
    const row = JSON.parse(JSON.stringify(toV2(v2Rows()[0]!))) as Record<string, unknown>;
    mutate(row);
    expect(() => parsePriorDataset(gz({ format: 2, rows: 1 }, [row]))).toThrow(pattern);
    expect(() => parsePriorDataset(gz({ format: 2, rows: 1 }, [row]))).toThrow(/2 行目/);
  });
});

describe("parsePriorDataset: 形式 v1 も読める(v2 の列は null に補う)", () => {
  it("v1 のファイル(19 列だけ)を読み、meta.format は 1 のまま。v1 の列は値が変わらず、v2 の 11 列は null。型は v2 の行", () => {
    const rows = v2Rows();
    const loaded = parsePriorDataset(gz({ format: 1, generatedAt: "x", rows: rows.length, races: 2, missingDetail: 0 }, rows.map(toV1)));
    expect(loaded.meta.format).toBe(1);
    expect(loaded.rows).toHaveLength(4);
    for (const [i, r] of loaded.rows.entries()) {
      expect(PRIOR_ROW_KEYS_V1.map((k) => r[k])).toEqual(PRIOR_ROW_KEYS_V1.map((k) => JSON.parse(JSON.stringify(rows[i]))[k]));
      expect(PRIOR_ROW_KEYS_V2_ADDED.map((k) => r[k])).toEqual(Array(11).fill(null));
      expect(PRIOR_ROW_KEYS_V3_ADDED.map((k) => r[k])).toEqual([null, null]);
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
    }
    expect(loaded.rows[0]!.contributions).not.toBeNull(); // 前提: v1 の列が実際に値を持っている(null 同士の一致ではない)
  });

  it.each([
    ["v2 の列が混ざっている(sex)", (r: Record<string, unknown>) => { r["sex"] = "牡"; }, /知らない列.*sex/],
    ["v1 の列が足りない(ninki)", (r: Record<string, unknown>) => { delete r["ninki"]; }, /列が足りません.*ninki/],
    ["v1 の列の型が違う(prior)", (r: Record<string, unknown>) => { r["prior"] = "0.3"; }, /型が違います.*prior/],
  ])("v1 のファイルの行が壊れている(%s)と、行番号つきの例外", (_name, mutate, pattern) => {
    const row = toV1(v2Rows()[0]!);
    mutate(row);
    expect(() => parsePriorDataset(gz({ format: 1, rows: 1 }, [row]))).toThrow(pattern);
    expect(() => parsePriorDataset(gz({ format: 1, rows: 1 }, [row]))).toThrow(/2 行目/);
  });

  it("v1・v2・v3 以外の版(0・4)は読めない版の例外", () => {
    for (const format of [0, 4]) {
      expect(() => parsePriorDataset(gz({ format, rows: 0 }, []))).toThrow(/版/);
    }
  });

  it("v2 と名乗るファイルに v1 の行(v2 の列がない)が混ざったら、黙って v1 として読まず例外(デプロイ中のジョブの混在)", () => {
    const rows = v2Rows();
    expect(() => parsePriorDataset(gz({ format: 2, rows: 2 }, [toV2(rows[0]!), toV1(rows[1]!)]))).toThrow(/3 行目: 列が足りません/);
  });
});

// ---------------------------------------------------------------------------
// Issue #421(段階 1): 形式 v3(レースの条件の 2 列)。ローダは v1・v2・v3 のすべてを読む。
// ---------------------------------------------------------------------------

describe("parsePriorDataset: 形式 v3", () => {
  it("v3 のファイルを往復で読む。meta.format は 3。weight_type・fillies_only が値のまま戻り(false も false)、スナップショットの無いレースは両列 null", () => {
    const rows = v2Rows();
    const loaded = parsePriorDataset(assembleFile({ ...META, rows: rows.length }, [encodeChunk(rows)]));
    expect(loaded.meta.format).toBe(3);
    expect(loaded.rows).toEqual(JSON.parse(JSON.stringify(rows)));
    for (const r of loaded.rows.slice(0, 2)) expect(r).toMatchObject({ weight_type: "馬齢", fillies_only: true });
    for (const r of loaded.rows.slice(2)) expect(PRIOR_ROW_KEYS_V3_ADDED.map((k) => r[k])).toEqual([null, null]);
    expect(Object.keys(loaded.rows[0]!)).toEqual([...PRIOR_ROW_KEYS]);
  });

  it.each([
    ["列が足りない(weight_type がない)", (r: Record<string, unknown>) => { delete r["weight_type"]; }, /列が足りません.*weight_type/],
    ["weight_type が数", (r: Record<string, unknown>) => { r["weight_type"] = 3; }, /型が違います.*weight_type/],
    ["fillies_only が文字列", (r: Record<string, unknown>) => { r["fillies_only"] = "true"; }, /型が違います.*fillies_only/],
    ["fillies_only が数", (r: Record<string, unknown>) => { r["fillies_only"] = 1; }, /型が違います.*fillies_only/],
    ["知らない列が混ざった", (r: Record<string, unknown>) => { r["prev_weight_type"] = "x"; }, /知らない列.*prev_weight_type/],
  ])("v3 の行が壊れている(%s)と、行番号と列名つきの例外", (_name, mutate, pattern) => {
    const row = JSON.parse(JSON.stringify(v2Rows()[0])) as Record<string, unknown>;
    expect(row["fillies_only"]).toBe(true); // 前提: 壊す前の v3 の行は値を持っている
    mutate(row);
    expect(() => parsePriorDataset(gz({ format: 3, rows: 1 }, [row]))).toThrow(pattern);
    expect(() => parsePriorDataset(gz({ format: 3, rows: 1 }, [row]))).toThrow(/2 行目/);
  });

  it("v3 と名乗るファイルに v2 の行(v3 の列がない)が混ざったら、黙って v2 として読まず例外(デプロイ中のジョブの混在)", () => {
    const rows = v2Rows();
    expect(() => parsePriorDataset(gz({ format: 3, rows: 2 }, [rows[0]!, toV2(rows[1]!)]))).toThrow(/3 行目: 列が足りません.*weight_type/);
  });

  it("v2 と名乗るファイルに v3 の行(v3 の列がある)が混ざったら、知らない列として例外", () => {
    const rows = v2Rows();
    expect(() => parsePriorDataset(gz({ format: 2, rows: 2 }, [toV2(rows[0]!), rows[1]!]))).toThrow(/3 行目: 知らない列.*weight_type/);
  });
});

describe("v3ColumnCoverage: v3 の列の非 null の件数", () => {
  it("v3 のファイルでは、スナップショットありのレース(2 頭)だけが数えられる(fillies_only の false も非 null)", () => {
    const loaded = parsePriorDataset(assembleFile({ ...META, rows: 4 }, [encodeChunk(v2Rows())]));
    expect(v3ColumnCoverage(loaded.rows)).toEqual({ weight_type: 2, fillies_only: 2 });
    const noFilly = v2Rows().map((r, i) => (i === 0 ? { ...r, fillies_only: false } : r));
    expect(v3ColumnCoverage(noFilly).fillies_only).toBe(2);
  });

  it("v1・v2 のファイルを読むと全列 0。キーの順は PRIOR_ROW_KEYS_V3_ADDED", () => {
    const rows = v2Rows();
    const v1 = parsePriorDataset(gz({ format: 1, rows: rows.length }, rows.map(toV1)));
    const v2 = parsePriorDataset(gz({ format: 2, rows: rows.length }, rows.map(toV2)));
    for (const loaded of [v1, v2]) {
      expect(Object.values(v3ColumnCoverage(loaded.rows))).toEqual([0, 0]);
      expect(Object.keys(v3ColumnCoverage(loaded.rows))).toEqual([...PRIOR_ROW_KEYS_V3_ADDED]);
    }
  });
});

describe("v2ColumnCoverage: v2 の列の非 null の件数(v1 を v2 の型で読んだときの全 null を欠損として見分ける)", () => {
  it("列ごとの非 null の行数を返す。スナップショットありのレース(2 頭)だけが数えられる", () => {
    const loaded = parsePriorDataset(assembleFile({ ...META, rows: 4 }, [encodeChunk(v2Rows())]));
    expect(v2ColumnCoverage(loaded.rows)).toEqual({
      race_name: 2, grade: 2, distance: 2, track_condition: 2, wakuban: 2, sex: 2, age: 2, body_weight: 1, kinryo: 2, oikiri_rank: 1, oikiri_critic: 1,
    });
  });

  it("v1 のファイルを読むと、全列が 0", () => {
    const rows = v2Rows();
    const loaded = parsePriorDataset(gz({ format: 1, rows: rows.length }, rows.map(toV1)));
    expect(Object.values(v2ColumnCoverage(loaded.rows))).toEqual(Array(11).fill(0));
    expect(Object.keys(v2ColumnCoverage(loaded.rows))).toEqual([...PRIOR_ROW_KEYS_V2_ADDED]);
  });
});
