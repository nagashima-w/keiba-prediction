import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assembleFile,
  buildRaceRows,
  encodeChunk,
  exportFilename,
  PRIOR_EXPORT_FORMAT,
  PRIOR_ROW_KEYS,
  selectPriorExportAnalyses,
  toContributions,
  type CandidateRow,
  type ChosenAnalysis,
  type PriorDatasetRow,
} from "../src/prior-export-format";

/**
 * Issue #266: 統計モデルの見直し用の書き出しの形式(純関数)。
 * 母集団の選別(遮断済み or 発走前の分析・レースごとに最新1件)・行の整形・NDJSON(gzip の複数メンバー)・ファイル名。
 */

const BEFORE_START = "2026-10-10T00:00:00.000Z"; // JST 09:00。発走(10:05)より前
const AFTER_START = "2026-10-10T03:00:00.000Z"; // JST 12:00。発走(10:05)より後

function cand(id: number, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id,
    raceId: "202606030801",
    analyzedAt: BEFORE_START,
    kaisaiDate: "20261010",
    promptVersion: "v-test",
    detailKey: `analyses/${id}.json.gz`,
    evEstimated: 0,
    promptLookaheadGuarded: null,
    historyCutoffDate: null,
    startTime: "10:05",
    ...over,
  };
}

describe("selectPriorExportAnalyses: 母集団", () => {
  it("遮断済み(history_cutoff_date あり)は、発走の前後・start_time の有無を問わず入り、leak_class は guarded", () => {
    const rows = [
      cand(1, { raceId: "202606030801", historyCutoffDate: "20261009", analyzedAt: AFTER_START }),
      cand(2, { raceId: "202606030802", historyCutoffDate: "20261009", startTime: null }),
    ];
    const { chosen, excluded } = selectPriorExportAnalyses(rows);
    expect(chosen.map((c) => [c.id, c.leakClass])).toEqual([[1, "guarded"], [2, "guarded"]]);
    expect(excluded).toEqual({ suspect: 0, unknown: 0, unchecked: 0, superseded: 0 });
  });

  it("遮断なしは、分析が発走より前なら pre_race で入り、発走より後なら suspect として除外して数える", () => {
    const { chosen, excluded } = selectPriorExportAnalyses([
      cand(1, { raceId: "202606030801", analyzedAt: BEFORE_START }),
      cand(2, { raceId: "202606030802", analyzedAt: AFTER_START }),
    ]);
    expect(chosen.map((c) => [c.id, c.leakClass])).toEqual([[1, "pre_race"]]);
    expect(excluded.suspect).toBe(1);
  });

  it("遮断なしで start_time が NULL(検証の DO の補完待ち)は判定できないので除外して unchecked に数える。遮断済みなら NULL でも入る", () => {
    const { chosen, excluded } = selectPriorExportAnalyses([
      cand(1, { raceId: "202606030801", startTime: null }),
      cand(2, { raceId: "202606030802", startTime: null, historyCutoffDate: "20261009" }),
    ]);
    expect(chosen.map((c) => c.id)).toEqual([2]);
    expect(excluded.unchecked).toBe(1);
  });

  it("発走時刻が無い('' や '?')は開催日の境で判定する: 前日までは入り、当日中は unknown、翌日以降は suspect", () => {
    const { chosen, excluded } = selectPriorExportAnalyses([
      cand(1, { raceId: "202606030801", startTime: "", analyzedAt: "2026-10-09T03:00:00.000Z" }),
      cand(2, { raceId: "202606030802", startTime: "?", analyzedAt: "2026-10-10T03:00:00.000Z" }),
      cand(3, { raceId: "202606030803", startTime: "", analyzedAt: "2026-10-11T03:00:00.000Z" }),
    ]);
    expect(chosen.map((c) => c.id)).toEqual([1]);
    expect(excluded).toMatchObject({ unknown: 1, suspect: 1 });
  });

  it("レースごとに最新の1件(analyzed_at が大きいもの。同時刻は id が大きいもの)だけを選び、旧い分析は superseded に数える", () => {
    const { chosen, excluded } = selectPriorExportAnalyses([
      cand(1, { analyzedAt: "2026-10-09T01:00:00.000Z" }),
      cand(3, { analyzedAt: "2026-10-09T02:00:00.000Z" }),
      cand(2, { analyzedAt: "2026-10-09T02:00:00.000Z" }),
      cand(4, { raceId: "202606030802", analyzedAt: "2026-10-09T01:00:00.000Z" }),
    ]);
    expect(chosen.map((c) => c.id)).toEqual([3, 4]); // 同時刻の 2 と 3 は id の大きい 3
    expect(excluded.superseded).toBe(2);
  });

  it("clean な旧い分析は、発走後(suspect)の新しい分析に最新の座を奪われない(最新選択は適格な候補だけが対象)", () => {
    const { chosen, excluded } = selectPriorExportAnalyses([
      cand(1, { analyzedAt: BEFORE_START }),
      cand(2, { analyzedAt: AFTER_START }),
    ]);
    expect(chosen.map((c) => c.id)).toEqual([1]);
    expect(excluded).toMatchObject({ suspect: 1, superseded: 0 });
  });

  it("結果は レースID の昇順、同じレースの中では 1 件。除外の内訳の和 + 採用 = 候補の総数", () => {
    const candidates = [
      cand(1, { raceId: "202606030803", historyCutoffDate: "20261009" }),
      cand(2, { raceId: "202606030801" }),
      cand(3, { raceId: "202606030801", analyzedAt: "2026-10-09T23:00:00.000Z" }),
      cand(4, { raceId: "202606030802", analyzedAt: AFTER_START }),
      cand(5, { raceId: "202606030804", startTime: null }),
      cand(6, { raceId: "202606030805", startTime: "", analyzedAt: BEFORE_START }),
    ];
    const { chosen, excluded } = selectPriorExportAnalyses(candidates);
    expect(chosen.map((c) => c.raceId)).toEqual(["202606030801", "202606030803"]);
    // 前提(空振りでない): 4 種の除外がそれぞれ 1 件以上ある
    expect(excluded.suspect).toBeGreaterThan(0);
    expect(excluded.unchecked).toBeGreaterThan(0);
    expect(excluded.superseded).toBeGreaterThan(0);
    expect(excluded.unknown).toBeGreaterThan(0);
    const sum = chosen.length + excluded.suspect + excluded.unknown + excluded.unchecked + excluded.superseded;
    expect(sum).toBe(candidates.length);
  });
});

describe("toContributions: R2 の寄与度を、自由文(reason)を除いた数値の形にする", () => {
  it("配列の各項目から biasName・applied・weight・correction・sampleCount・targetRate・overallRate だけを取り、reason は落とす", () => {
    const out = toContributions([
      { biasName: "近走着順", applied: true, reason: "直近6走の重み付き着順", weight: 0.2, correction: 0.134, sampleCount: 6, targetRate: 1, overallRate: 0.33 },
      { biasName: "斤量", applied: false, reason: "x", weight: 0.1, correction: 0 },
    ]);
    expect(out).toEqual([
      { biasName: "近走着順", applied: true, weight: 0.2, correction: 0.134, sampleCount: 6, targetRate: 1, overallRate: 0.33 },
      { biasName: "斤量", applied: false, weight: 0.1, correction: 0, sampleCount: null, targetRate: null, overallRate: null },
    ]);
    expect(JSON.stringify(out)).not.toContain("reason");
  });

  it("配列でない・項目が壊れている(biasName が文字列でない)ときは null(想定外の形を推測で直さない)", () => {
    expect(toContributions(null)).toBeNull();
    expect(toContributions(undefined)).toBeNull();
    expect(toContributions({ umaban: 1, contributions: [] })).toBeNull();
    expect(toContributions([{ biasName: 3 }])).toBeNull();
    expect(toContributions(["x"])).toBeNull();
  });

  it("非有限の数・文字列の数は null にする(JSON に NaN を出さない)", () => {
    const out = toContributions([{ biasName: "a", applied: true, weight: Number.NaN, correction: "0.1", sampleCount: Infinity, targetRate: null }]);
    expect(out).toEqual([{ biasName: "a", applied: true, weight: null, correction: null, sampleCount: null, targetRate: null, overallRate: null }]);
  });
});

const CHOSEN: ChosenAnalysis = {
  id: 7,
  raceId: "202606030801",
  analyzedAt: BEFORE_START,
  kaisaiDate: "20261010",
  promptVersion: "v9",
  detailKey: "analyses/7.json.gz",
  evEstimated: false,
  promptLookaheadGuarded: true,
  leakClass: "guarded",
};

describe("buildRaceRows: 1 行 1 頭", () => {
  const horses = [
    { umaban: 2, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 3.1 },
    { umaban: 1, prior: 0.4, adjustedProb: 0.35, placeOddsMin: null },
    { umaban: 3, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 9 },
  ];
  const results = [
    { umaban: 1, finishPosition: 1, winOdds: 2.5, ninki: 1 },
    { umaban: 2, finishPosition: null, winOdds: null, ninki: null },
  ];
  const contributions = new Map([[1, toContributions([{ biasName: "a", applied: true, weight: 0.1, correction: 0.01 }])]]);

  it("馬番の昇順で、分析の馬ごとに 1 行。頭数・面・結果・寄与度を結ぶ。結果の無い馬(umaban 3)は着順・オッズ・人気が null", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, "ダ", contributions);
    expect(rows.map((r) => r.umaban)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.field_size === 3)).toBe(true);
    expect(rows[0]).toMatchObject({
      analysis_id: 7, race_id: "202606030801", kaisai_date: "20261010", venue_kind: "central", course_type: "ダ",
      prior: 0.4, adjusted_prob: 0.35, place_odds_min: null, finish_position: 1, win_odds: 2.5, ninki: 1,
      prompt_version: "v9", analyzed_at: BEFORE_START, ev_estimated: false, prompt_lookahead_guarded: true, leak_class: "guarded",
    });
    expect(rows[0]!.contributions).toHaveLength(1);
    expect(rows[1]).toMatchObject({ finish_position: null, win_odds: null, ninki: null, contributions: null });
    expect(rows[2]).toMatchObject({ finish_position: null, win_odds: null, ninki: null, contributions: null });
  });

  it("キーは許可リスト(PRIOR_ROW_KEYS)と完全に一致する。追加指示・生応答・自由文・馬名などの秘密や個人的な内容は列にない", () => {
    const [row] = buildRaceRows(CHOSEN, horses, results, null, contributions);
    expect(Object.keys(row!)).toEqual([...PRIOR_ROW_KEYS]);
    for (const forbidden of ["additional_instruction", "raw_response", "reason", "highlights", "concerns", "mark", "horse_name", "model", "bets"]) {
      expect(PRIOR_ROW_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("地方のレース ID は venue_kind が nar。kaisai_date が NULL なら地方のレース ID から補う", () => {
    const nar: ChosenAnalysis = { ...CHOSEN, raceId: "202544101501", kaisaiDate: null };
    const [row] = buildRaceRows(nar, horses, results, null, contributions);
    expect(row!.venue_kind).toBe("nar");
    expect(row!.kaisai_date).toBe("20251015");
  });

  it("中央で kaisai_date が NULL なら null のまま(推測しない)", () => {
    const [row] = buildRaceRows({ ...CHOSEN, kaisaiDate: null }, horses, results, null, contributions);
    expect(row!.kaisai_date).toBeNull();
  });
});

describe("NDJSON(gzip の複数メンバー)とファイル名", () => {
  const row = (umaban: number): PriorDatasetRow => buildRaceRows(CHOSEN, [{ umaban, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 1.5 }], [], null, new Map())[0]!;

  it("encodeChunk は行ごとに 1 行の JSON(末尾改行つき)を gzip の 1 メンバーにし、メンバーの連結は 1 回の gunzip で全部読める", () => {
    const a = encodeChunk([row(1), row(2)]);
    const b = encodeChunk([row(3)]);
    const text = new TextDecoder().decode(gunzipSync(Buffer.concat([a, b])));
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).map((l) => (JSON.parse(l) as PriorDatasetRow).umaban)).toEqual([1, 2, 3]);
  });

  it("assembleFile は先頭にメタ行(format・生成時刻・件数・除外の内訳・列・注記)を置き、その後ろにチャンクを連結する", () => {
    const meta = {
      generatedAt: "2026-10-10T12:00:00.000Z", rows: 3, races: 2, missingDetail: 1,
      excluded: { suspect: 4, unknown: 3, unchecked: 2, superseded: 1 },
    };
    const file = assembleFile(meta, [encodeChunk([row(1), row(2)]), encodeChunk([row(3)])]);
    const lines = new TextDecoder().decode(gunzipSync(file)).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(4);
    const head = JSON.parse(lines[0]!) as { _meta: Record<string, unknown> };
    expect(head._meta).toMatchObject({ format: PRIOR_EXPORT_FORMAT, ...meta, columns: [...PRIOR_ROW_KEYS] });
    expect(head._meta["notes"]).toBeInstanceOf(Array);
    expect(JSON.stringify(head._meta["notes"])).toContain("scorer");
    expect(JSON.parse(lines[3]!)).toMatchObject({ umaban: 3 });
  });

  it("exportFilename は JST の日時(UTC+9)", () => {
    expect(exportFilename("2026-10-10T12:34:56.000Z")).toBe("prior-dataset-20261010-2134.ndjson.gz");
    expect(exportFilename("2026-10-10T16:00:00.000Z")).toBe("prior-dataset-20261011-0100.ndjson.gz");
  });
});
