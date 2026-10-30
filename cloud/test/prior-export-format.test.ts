import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assembleFile,
  buildRaceRows,
  encodeChunk,
  exportFilename,
  PRIOR_EXPORT_FORMAT,
  PRIOR_ROW_KEYS,
  PRIOR_ROW_KEYS_V1,
  PRIOR_ROW_KEYS_V2_ADDED,
  PRIOR_ROW_KEYS_V3_ADDED,
  PRIOR_ROW_KEYS_V4_ADDED,
  PRIOR_ROW_KEYS_V5_ADDED,
  PRIOR_ROW_KEYS_V6_ADDED,
  selectPriorExportAnalyses,
  toContributions,
  toSnapshotColumns,
  type CandidateRow,
  type ChosenAnalysis,
  type PriorDatasetRow,
} from "../src/prior-export-format";

/**
 * Issue #266: 統計モデルの見直し用の書き出しの形式(純関数)。
 * 母集団の選別(遮断済み or 発走前の分析・レースごとに最新1件)・行の整形・NDJSON(gzip の複数メンバー)・ファイル名。
 */

const BEFORE_START = "2026-10-10T00:00:00.000Z"; // JST 09:00。発走(10:05)より前
/** 騎手名 → 騎手 ID の対応が無い(表が空)。v5 の埋め直しをしない呼び出し。 */
const NO_LOOKUP: ReadonlyMap<string, string> = new Map();
/** 調教師名 → 調教師 ID の対応が無い(表が空)。v6 の埋め直しをしない呼び出し。 */
const NO_TRAINER_LOOKUP: ReadonlyMap<string, string> = new Map();
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
    const rows = buildRaceRows(CHOSEN, horses, results, "ダ", contributions, null, NO_LOOKUP, NO_TRAINER_LOOKUP);
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
    const [row] = buildRaceRows(CHOSEN, horses, results, null, contributions, null, NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(Object.keys(row!)).toEqual([...PRIOR_ROW_KEYS]);
    for (const forbidden of ["additional_instruction", "raw_response", "reason", "highlights", "concerns", "mark", "horse_name", "model", "bets"]) {
      expect(PRIOR_ROW_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("地方のレース ID は venue_kind が nar。kaisai_date が NULL なら地方のレース ID から補う", () => {
    const nar: ChosenAnalysis = { ...CHOSEN, raceId: "202544101501", kaisaiDate: null };
    const [row] = buildRaceRows(nar, horses, results, null, contributions, null, NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(row!.venue_kind).toBe("nar");
    expect(row!.kaisai_date).toBe("20251015");
  });

  it("中央で kaisai_date が NULL なら null のまま(推測しない)", () => {
    const [row] = buildRaceRows({ ...CHOSEN, kaisaiDate: null }, horses, results, null, contributions, null, NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(row!.kaisai_date).toBeNull();
  });
});

describe("NDJSON(gzip の複数メンバー)とファイル名", () => {
  const row = (umaban: number): PriorDatasetRow => buildRaceRows(CHOSEN, [{ umaban, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 1.5 }], [], null, new Map(), null, NO_LOOKUP, NO_TRAINER_LOOKUP)[0]!;

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

// ---------------------------------------------------------------------------
// Issue #341(#340-1): 形式 v2。出馬表の列(R2 の詳細の raceSnapshot から。追加の取得なし)を足す。
// ---------------------------------------------------------------------------

/** 分析時点のスナップショット(core の `buildRaceSnapshot` の形)。市場の値・人名・馬名は、書き出さないことを確かめるために目立つ値にしてある。 */
const SNAPSHOT = {
  race: { raceName: "テストステークス", courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", startTime: "10:05", fence: null, oddsStatus: "x", officialDatetime: null, grade: "G3", weightType: "ハンデ", filliesOnly: false },
  horses: [
    {
      umaban: 1, wakuban: 1, name: "SECRET-HORSE", sex: "牡", age: 3, kinryo: 56, jockeyName: "騎手ア", jockeyId: "01001", trainerName: "調教師ア", trainerId: "02001", horseId: "2021100001", bodyWeight: 480,
      winOdds: 99.9, popularity: 13, placeOddsMin: 77.7, placeOddsMax: 88.8, oikiriCritic: "動き良化", oikiriRank: "A",
    },
    {
      umaban: 2, wakuban: 2, name: "SECRET-HORSE-2", sex: "牝", age: 4, kinryo: 54.5, jockeyName: "騎手イ", jockeyId: "01002", trainerName: "調教師イ", trainerId: "02002", horseId: "2021100002", bodyWeight: null,
      winOdds: 5, popularity: 2, placeOddsMin: 1.5, placeOddsMax: 2, oikiriCritic: null, oikiriRank: null,
    },
  ],
};

const HORSE1 = { wakuban: 1, sex: "牡", age: 3, body_weight: 480, kinryo: 56, oikiri_rank: "A", oikiri_critic: "動き良化" };
const NULL_HORSE = { wakuban: null, sex: null, age: null, body_weight: null, kinryo: null, oikiri_rank: null, oikiri_critic: null };
const NULL_RACE = { race_name: null, grade: null, distance: null, track_condition: null };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("v2 の列(許可リスト)", () => {
  it("形式の版は 6(Issue #540)。v1 の 19 列は先頭にそのまま残り、v2 で足した 11 列・v3 で足した 2 列・v4 で足した 2 列・v5 で足した 1 列・v6 で足した 4 列がこの順で続く(順序も固定)", () => {
    expect(PRIOR_EXPORT_FORMAT).toBe(6);
    expect(PRIOR_ROW_KEYS_V1).toHaveLength(19);
    expect([...PRIOR_ROW_KEYS_V1]).toEqual([
      "analysis_id", "race_id", "kaisai_date", "venue_kind", "course_type", "field_size", "umaban", "prior", "adjusted_prob", "place_odds_min", "contributions",
      "finish_position", "win_odds", "ninki", "prompt_version", "analyzed_at", "ev_estimated", "prompt_lookahead_guarded", "leak_class",
    ]);
    expect([...PRIOR_ROW_KEYS_V2_ADDED]).toEqual([
      "race_name", "grade", "distance", "track_condition", "wakuban", "sex", "age", "body_weight", "kinryo", "oikiri_rank", "oikiri_critic",
    ]);
    expect([...PRIOR_ROW_KEYS_V3_ADDED]).toEqual(["weight_type", "fillies_only"]);
    expect([...PRIOR_ROW_KEYS_V4_ADDED]).toEqual(["jockey_name", "jockey_id"]);
    expect([...PRIOR_ROW_KEYS_V5_ADDED]).toEqual(["jockey_id_source"]);
    expect([...PRIOR_ROW_KEYS_V6_ADDED]).toEqual(["trainer_name", "trainer_id", "trainer_id_source", "horse_id"]);
    expect([...PRIOR_ROW_KEYS]).toEqual([...PRIOR_ROW_KEYS_V1, ...PRIOR_ROW_KEYS_V2_ADDED, ...PRIOR_ROW_KEYS_V3_ADDED, ...PRIOR_ROW_KEYS_V4_ADDED, ...PRIOR_ROW_KEYS_V5_ADDED, ...PRIOR_ROW_KEYS_V6_ADDED]);
    expect(PRIOR_ROW_KEYS).toHaveLength(39);
    expect(PRIOR_ROW_KEYS.slice(-7)).toEqual(["jockey_name", "jockey_id", "jockey_id_source", "trainer_name", "trainer_id", "trainer_id_source", "horse_id"]); // 末尾の 7 列が騎手と調教師・馬の ID
  });

  it("format 5 までの 35 列は、名前も順序も変わっていない(v6 の 4 列は末尾に足しただけ。リテラルで固定する。新旧の対応表の左側)", () => {
    expect(PRIOR_ROW_KEYS.slice(0, 35)).toEqual([
      "analysis_id", "race_id", "kaisai_date", "venue_kind", "course_type", "field_size", "umaban", "prior", "adjusted_prob", "place_odds_min", "contributions",
      "finish_position", "win_odds", "ninki", "prompt_version", "analyzed_at", "ev_estimated", "prompt_lookahead_guarded", "leak_class",
      "race_name", "grade", "distance", "track_condition", "wakuban", "sex", "age", "body_weight", "kinryo", "oikiri_rank", "oikiri_critic",
      "weight_type", "fillies_only", "jockey_name", "jockey_id", "jockey_id_source",
    ]);
  });

  it("馬名と、スナップショットの市場の値(単勝オッズ・人気・複勝オッズ)は列にない(騎手名・騎手 ID・ID の出どころは format 4・5、調教師名・調教師 ID・その出どころ・馬の ID は format 6 から入る)。既存の win_odds・ninki(確定値)と place_odds_min だけが市場に近い列", () => {
    for (const forbidden of [
      "name", "horse_name", "jockey", "trainer", "jockey_code", "trainer_code",
      "popularity", "place_odds_max", "snapshot_win_odds", "snapshot_popularity", "snapshot_place_odds_min", "winOdds", "placeOddsMax",
    ]) {
      expect(PRIOR_ROW_KEYS as readonly string[], `${forbidden} は列にない`).not.toContain(forbidden);
    }
    expect(PRIOR_ROW_KEYS.filter((k) => /odds|ninki|popul/.test(k))).toEqual(["place_odds_min", "win_odds", "ninki"]);
    // 調教師名・調教師 ID・馬の ID は format 6 から列にある(ユーザーの決定・2026-10-30)。馬名は引き続き無い。
    for (const shown of ["trainer_name", "trainer_id", "horse_id"]) {
      expect(PRIOR_ROW_KEYS as readonly string[], `${shown} は列にある`).toContain(shown);
    }
  });
});

describe("toSnapshotColumns: スナップショットから v2 の列を取り出す", () => {
  it("レースの列と、馬番ごとの馬の列を返す。馬名・騎手名・調教師名・市場の値は結果に含まれない(キー集合と文字列の両方で固定)", () => {
    const out = toSnapshotColumns(SNAPSHOT);
    expect(out.race).toEqual({ race_name: "テストステークス", grade: "G3", distance: 1600, track_condition: "良" });
    expect([...out.horses.keys()]).toEqual([1, 2]);
    expect(out.horses.get(1)).toEqual(HORSE1);
    expect(out.horses.get(2)).toEqual({ ...NULL_HORSE, wakuban: 2, sex: "牝", age: 4, kinryo: 54.5 });
    for (const h of out.horses.values()) {
      expect(Object.keys(h)).toEqual(["wakuban", "sex", "age", "body_weight", "kinryo", "oikiri_rank", "oikiri_critic"]);
    }
    const text = JSON.stringify({ race: out.race, horses: [...out.horses.values()] });
    for (const secret of ["SECRET", "99.9", "77.7", "88.8", "popularity", "winOdds", "placeOdds"]) {
      expect(text).not.toContain(secret);
    }
  });

  it.each([
    ["null(スナップショットなし)", null],
    ["undefined", undefined],
    ["文字列", "x"],
    ["配列", []],
    ["空のオブジェクト", {}],
    ["race・horses が null", { race: null, horses: null }],
    ["race・horses が配列でない型", { race: "x", horses: {} }],
  ])("%s のときは、レースの列がすべて null で馬は 0 頭(例外を投げない)", (_name, raw) => {
    const out = toSnapshotColumns(raw);
    expect(out.race).toEqual(NULL_RACE);
    expect(out.horses.size).toBe(0);
  });

  it("grade のキーが無い(グレードなし・#250 より前の旧スナップショット)は null。この 2 つは区別できない", () => {
    const withoutGrade = clone(SNAPSHOT);
    delete (withoutGrade.race as { grade?: string }).grade;
    expect(toSnapshotColumns(SNAPSHOT).race.grade).toBe("G3"); // 前提: あるときは取れる
    expect(toSnapshotColumns(withoutGrade).race).toEqual({ race_name: "テストステークス", grade: null, distance: 1600, track_condition: "良" });
  });

  it.each([
    ["race_name が空文字", "raceName", "", "race_name"],
    ["race_name が数", "raceName", 3, "race_name"],
    ["grade が数", "grade", 3, "grade"],
    ["distance が小数", "distance", 1600.5, "distance"],
    ["distance が文字列", "distance", "1600", "distance"],
    ["track_condition が null", "trackCondition", null, "track_condition"],
    ["track_condition が空文字", "trackCondition", "", "track_condition"],
  ])("レースの列の型が違う(%s)と、その列だけ null。ほかの列は残る(推測で直さない)", (_name, field, value, column) => {
    const raw = clone(SNAPSHOT);
    (raw.race as Record<string, unknown>)[field] = value;
    const expected: Record<string, unknown> = { race_name: "テストステークス", grade: "G3", distance: 1600, track_condition: "良" };
    expect(Object.values(expected).every((v) => v !== null)).toBe(true); // 前提: 比べる側は全部入っている
    expected[column] = null;
    expect(toSnapshotColumns(raw).race).toEqual(expected);
  });

  it.each([
    ["wakuban が小数", "wakuban", 1.5, "wakuban"],
    ["wakuban が文字列", "wakuban", "1", "wakuban"],
    ["sex が数", "sex", 1, "sex"],
    ["sex が空文字", "sex", "", "sex"],
    ["age が小数", "age", 3.5, "age"],
    ["age が文字列", "age", "3", "age"],
    ["bodyWeight が文字列", "bodyWeight", "480", "body_weight"],
    ["bodyWeight が null(未発表)", "bodyWeight", null, "body_weight"],
    ["kinryo が文字列", "kinryo", "56", "kinryo"],
    ["oikiriRank が数", "oikiriRank", 3, "oikiri_rank"],
    ["oikiriCritic が数", "oikiriCritic", 3, "oikiri_critic"],
    ["oikiriCritic が空文字", "oikiriCritic", "", "oikiri_critic"],
  ])("馬の列の型が違う(%s)と、その列だけ null。ほかの列は残る", (_name, field, value, column) => {
    const raw = clone(SNAPSHOT);
    (raw.horses[0] as Record<string, unknown>)[field] = value;
    const got = toSnapshotColumns(raw).horses.get(1);
    expect(got).toEqual({ ...HORSE1, [column]: null });
    expect(Object.values(HORSE1).every((v) => v !== null)).toBe(true); // 前提: 元は全部入っている(null との差が出る)
  });

  it.each([
    ["15 文字", "あ".repeat(15), "あ".repeat(15)],
    ["ちょうど 16 文字", "あ".repeat(16), "あ".repeat(16)],
    ["17 文字(自由文の疑い)", "あ".repeat(17), null],
    ["サロゲートペアは 1 文字と数える(16 文字)", "𠮷".repeat(16), "𠮷".repeat(16)],
    ["サロゲートペア 17 文字", "𠮷".repeat(17), null],
  ])("oikiri_critic は 16 文字まで(%s)", (_name, critic, expected) => {
    const raw = clone(SNAPSHOT);
    raw.horses[0]!.oikiriCritic = critic;
    expect(toSnapshotColumns(raw).horses.get(1)!.oikiri_critic).toBe(expected);
  });

  it("馬の並びが壊れている: 配列でない・オブジェクトでない要素・umaban が整数でない要素は飛ばす。馬番が重複したら最初の 1 頭", () => {
    expect(toSnapshotColumns({ race: SNAPSHOT.race, horses: { 1: {} } }).horses.size).toBe(0);
    const raw = {
      race: SNAPSHOT.race,
      horses: [null, "x", 7, { umaban: "3", sex: "牡" }, { umaban: 3.5, sex: "牡" }, { umaban: 4, sex: "牝" }, { umaban: 4, sex: "牡" }],
    };
    const out = toSnapshotColumns(raw);
    expect([...out.horses.keys()]).toEqual([4]);
    expect(out.horses.get(4)).toEqual({ ...NULL_HORSE, sex: "牝" });
  });
});

describe("buildRaceRows: v2 の列", () => {
  const horses = [
    { umaban: 1, prior: 0.4, adjustedProb: 0.35, placeOddsMin: 3.1 },
    { umaban: 2, prior: 0.2, adjustedProb: 0.25, placeOddsMin: null },
    { umaban: 3, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 9 },
  ];
  const results = [{ umaban: 1, finishPosition: 1, winOdds: 2.5, ninki: 1 }];

  it("スナップショットの列を、レースの列は全頭に・馬の列は馬番で結ぶ。スナップショットに無い馬(umaban 3)は馬の列だけ null でレースの列は入る", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, "芝", new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.race_name === "テストステークス" && r.grade === "G3" && r.distance === 1600 && r.track_condition === "良")).toBe(true);
    expect(rows[0]).toMatchObject(HORSE1);
    expect(rows[1]).toMatchObject({ wakuban: 2, sex: "牝", age: 4, body_weight: null, kinryo: 54.5, oikiri_rank: null, oikiri_critic: null });
    expect(rows[2]).toMatchObject(NULL_HORSE);
  });

  it("スナップショットが無い(null)ときは、v2 の 11 列がすべて null。v1 の列は変わらない", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, "芝", new Map(), null, NO_LOOKUP, NO_TRAINER_LOOKUP);
    for (const r of rows) {
      expect(PRIOR_ROW_KEYS_V2_ADDED.map((k) => r[k])).toEqual(Array(11).fill(null));
    }
    expect(rows[0]).toMatchObject({ analysis_id: 7, win_odds: 2.5, ninki: 1, place_odds_min: 3.1, course_type: "芝", field_size: 3 });
  });

  it("キーの順序は PRIOR_ROW_KEYS(v1 の 19 列が先頭)と完全に一致する", () => {
    const [row] = buildRaceRows(CHOSEN, horses, results, null, new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(Object.keys(row!)).toEqual([...PRIOR_ROW_KEYS]);
    expect(Object.keys(row!).slice(0, 19)).toEqual([...PRIOR_ROW_KEYS_V1]);
  });

  it("市場の値は、スナップショットのもの(単勝 99.9・人気 13・複勝 77.7/88.8)ではなく、既存の確定値・分析の値のまま。馬名は行のどこにも出ない", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, null, new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(rows[0]).toMatchObject({ win_odds: 2.5, ninki: 1, place_odds_min: 3.1 });
    const text = JSON.stringify(rows);
    for (const secret of ["SECRET", "99.9", "77.7", "88.8"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("assembleFile のメタ行は format 6 で、列は 39 列。notes に v2 の列の出どころ・null の意味(grade の曖昧さ・地方の調教・critic の未確認)と、v3・v4・v5・v6 の列の意味を書く", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, null, new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP);
    const file = assembleFile({ generatedAt: "2026-10-10T12:00:00.000Z", rows: rows.length, races: 1, missingDetail: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 } }, [encodeChunk(rows)]);
    const lines = new TextDecoder().decode(gunzipSync(file)).split("\n").filter((l) => l !== "");
    const head = JSON.parse(lines[0]!) as { _meta: { format: number; columns: string[]; notes: string[] } };
    expect(head._meta.format).toBe(6);
    expect(head._meta.columns).toHaveLength(39);
    expect(head._meta.columns.slice(-7)).toEqual(["jockey_name", "jockey_id", "jockey_id_source", "trainer_name", "trainer_id", "trainer_id_source", "horse_id"]);
    const notes = head._meta.notes.join("\n");
    for (const phrase of ["v2", "raceSnapshot", "grade", "地方", "oikiri_critic", "16 文字", "確認していない", "馬名と、スナップショットの市場の値", "format 3", "weight_type", "fillies_only", "区別できない", "前走"]) {
      expect(notes, `notes に「${phrase}」`).toContain(phrase);
    }
    // format 4(Issue #526): 方針の変更を書く。「騎手名は含めない」という旧い方針の文は残さない。
    for (const phrase of ["format 4", "jockey_name", "jockey_id", "#526", "2026-10-29", "騎手と馬の相性", "乗り替わり", "実際に乗った騎手とは限らない", "区別できない"]) {
      expect(notes, `notes に「${phrase}」`).toContain(phrase);
    }
    expect(notes).not.toContain("馬名・騎手名・調教師名");
    expect(notes).not.toContain("馬名・調教師名は引き続き含めない"); // format 6 で調教師名を含めるようにしたので、旧い方針の文は残さない
    // format 5(Issue #526 段階 1b): 名前から埋めた ID の意味と、誤りうる条件・表を貯め始めた日・使うかを分析側が選ぶこと。
    for (const phrase of ["format 5", "jockey_id_source", "snapshot", "name", "ちょうど 1 つ", "同じ名前の別人", "引退", "2026-10-29", "絞れる"]) {
      expect(notes, `notes に「${phrase}」`).toContain(phrase);
    }
    // format 6(Issue #540): 方針の変更(調教師名だけ。馬名は含めない)・列の意味・貯め始めた日・誤りうる条件・馬の ID は名前から埋めないこと。
    for (const phrase of ["format 6", "trainer_name", "trainer_id", "trainer_id_source", "horse_id", "#540", "2026-10-30", "騎手と調教師の相性", "馬名は引き続き含めない", "名前から埋めない", "同じ名前の別人", "絞れる"]) {
      expect(notes, `notes に「${phrase}」`).toContain(phrase);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #421(段階 1): 形式 v3。レースの条件(負担重量の種別・牝馬限定)の 2 列。R2 の詳細の raceSnapshot.race から(追加の取得なし)。
// ---------------------------------------------------------------------------

describe("v3 の列: toSnapshotColumns がスナップショットの race から取り出す", () => {
  it("weightType・filliesOnly を weight_type・fillies_only として返す(false は false のまま。null と区別する)", () => {
    expect(toSnapshotColumns(SNAPSHOT).conditions).toEqual({ weight_type: "ハンデ", fillies_only: false });
    const filly = clone(SNAPSHOT);
    (filly.race as Record<string, unknown>)["weightType"] = "馬齢";
    (filly.race as Record<string, unknown>)["filliesOnly"] = true;
    expect(toSnapshotColumns(filly).conditions).toEqual({ weight_type: "馬齢", fillies_only: true });
    // v2 の列は、v3 の列を足しても変わらない。
    expect(toSnapshotColumns(filly).race).toEqual(toSnapshotColumns(SNAPSHOT).race);
  });

  it("キーが無い(地方・読めなかったレース・この項目を保存する前の旧スナップショット)は両列とも null", () => {
    const old = clone(SNAPSHOT);
    delete (old.race as Record<string, unknown>)["weightType"];
    delete (old.race as Record<string, unknown>)["filliesOnly"];
    expect(toSnapshotColumns(SNAPSHOT).conditions.weight_type).toBe("ハンデ"); // 前提: あるときは取れる
    expect(toSnapshotColumns(old).conditions).toEqual({ weight_type: null, fillies_only: null });
    // 種別だけ無い(牝馬限定は確定)の組合せは、牝馬限定の値を残す。
    const noType = clone(SNAPSHOT);
    delete (noType.race as Record<string, unknown>)["weightType"];
    expect(toSnapshotColumns(noType).conditions).toEqual({ weight_type: null, fillies_only: false });
  });

  it.each([
    ["weightType が空文字", "weightType", "", { weight_type: null, fillies_only: false }],
    ["weightType が数", "weightType", 3, { weight_type: null, fillies_only: false }],
    ["filliesOnly が文字列", "filliesOnly", "true", { weight_type: "ハンデ", fillies_only: null }],
    ["filliesOnly が数", "filliesOnly", 1, { weight_type: "ハンデ", fillies_only: null }],
    ["filliesOnly が null", "filliesOnly", null, { weight_type: "ハンデ", fillies_only: null }],
  ])("型が違う(%s)と、その列だけ null(推測で直さない。1 を true にしない)", (_name, field, value, expected) => {
    const raw = clone(SNAPSHOT);
    (raw.race as Record<string, unknown>)[field] = value;
    expect(toSnapshotColumns(raw).conditions).toEqual(expected);
  });

  it.each([
    ["null", null],
    ["文字列", "x"],
    ["race が null", { race: null, horses: [] }],
    ["race が文字列", { race: "x", horses: [] }],
  ])("スナップショットが壊れている(%s)ときは両列とも null(例外を投げない)", (_name, raw) => {
    expect(toSnapshotColumns(raw).conditions).toEqual({ weight_type: null, fillies_only: null });
  });
});

describe("v3 の列: buildRaceRows が全頭に同じ値を載せる", () => {
  const CHOSEN_V3 = CHOSEN;
  const horsesV3 = [
    { umaban: 1, prior: 0.4, adjustedProb: 0.35, placeOddsMin: 3.1 },
    { umaban: 3, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 9 },
  ];

  it("レースの条件は全頭に入る(スナップショットに無い馬にも)。キーの順序は PRIOR_ROW_KEYS で、v3 の 2 列は 31・32 番目(v4 以降の列が後ろに続く)", () => {
    const rows = buildRaceRows(CHOSEN_V3, horsesV3, [], null, new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.weight_type).toBe("ハンデ");
      expect(r.fillies_only).toBe(false);
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
      expect(Object.keys(r).slice(30, 32)).toEqual([...PRIOR_ROW_KEYS_V3_ADDED]); // v4 以降の列が後ろに来たので、v3 の 2 列は 31・32 番目
    }
  });

  it("スナップショットが無い(null)ときは v3 の 2 列も null。ほかの列は変わらない", () => {
    const rows = buildRaceRows(CHOSEN_V3, horsesV3, [], null, new Map(), null, NO_LOOKUP, NO_TRAINER_LOOKUP);
    for (const r of rows) {
      expect(PRIOR_ROW_KEYS_V3_ADDED.map((k) => r[k])).toEqual([null, null]);
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #526(段階 1): 形式 v4。今回の騎手名・騎手 ID の 2 列。R2 の詳細の raceSnapshot.horses[] から(追加の取得なし)。
// ---------------------------------------------------------------------------

describe("v4 の列: toSnapshotColumns がスナップショットの horses[] から取り出す", () => {
  it("jockeyName・jockeyId を馬番ごとに jockey_name・jockey_id として返す。v2 の馬の列(horses)は変わらない", () => {
    const out = toSnapshotColumns(SNAPSHOT);
    expect([...out.jockeys.keys()]).toEqual([1, 2]);
    expect(out.jockeys.get(1)).toEqual({ jockey_name: "騎手ア", jockey_id: "01001" });
    expect(out.jockeys.get(2)).toEqual({ jockey_name: "騎手イ", jockey_id: "01002" });
    expect(out.horses.get(1)).toEqual(HORSE1); // 騎手の列は horses に混ぜない
    expect(Object.keys(out.jockeys.get(1)!)).toEqual([...PRIOR_ROW_KEYS_V4_ADDED]);
  });

  it("jockeyId のキーが無い(2026-10-29 より前の旧スナップショット)は jockey_id だけ null。騎手名は残る", () => {
    const old = clone(SNAPSHOT);
    for (const h of old.horses) delete (h as Record<string, unknown>)["jockeyId"];
    expect(toSnapshotColumns(SNAPSHOT).jockeys.get(1)!.jockey_id).toBe("01001"); // 前提: あるときは取れる
    expect(toSnapshotColumns(old).jockeys.get(1)).toEqual({ jockey_name: "騎手ア", jockey_id: null });
  });

  it.each([
    ["jockeyName が空文字(騎手未定)", "jockeyName", "", { jockey_name: null, jockey_id: "01001" }],
    ["jockeyName が数", "jockeyName", 3, { jockey_name: null, jockey_id: "01001" }],
    ["jockeyName が null", "jockeyName", null, { jockey_name: null, jockey_id: "01001" }],
    ["jockeyId が空文字", "jockeyId", "", { jockey_name: "騎手ア", jockey_id: null }],
    ["jockeyId が数(1001 を \"01001\" に直さない)", "jockeyId", 1001, { jockey_name: "騎手ア", jockey_id: null }],
    ["jockeyId が null(騎手のリンクが無い)", "jockeyId", null, { jockey_name: "騎手ア", jockey_id: null }],
  ])("型が違う・空(%s)と、その列だけ null(推測で直さない)", (_name, field, value, expected) => {
    const raw = clone(SNAPSHOT);
    (raw.horses[0] as Record<string, unknown>)[field] = value;
    expect(toSnapshotColumns(raw).jockeys.get(1)).toEqual(expected);
  });

  it("馬ごとに別の値を取る(取り違えない)。馬番が重複したら、v2 の列と同じく最初の 1 頭の値", () => {
    const raw = {
      race: SNAPSHOT.race,
      horses: [
        { umaban: 4, jockeyName: "最初", jockeyId: "00004" },
        { umaban: 4, jockeyName: "重複", jockeyId: "99999" },
        { umaban: "5", jockeyName: "馬番が文字列", jockeyId: "00005" },
        { umaban: 6, jockeyName: "別の馬", jockeyId: "00006" },
      ],
    };
    const out = toSnapshotColumns(raw);
    expect([...out.jockeys.keys()]).toEqual([4, 6]);
    expect(out.jockeys.get(4)).toEqual({ jockey_name: "最初", jockey_id: "00004" });
    expect(out.jockeys.get(6)).toEqual({ jockey_name: "別の馬", jockey_id: "00006" });
    expect([...out.jockeys.keys()]).toEqual([...out.horses.keys()]); // v2 の馬の列と同じ馬番の集合
  });

  it.each([
    ["null", null],
    ["文字列", "x"],
    ["配列", []],
    ["空のオブジェクト", {}],
    ["horses が null", { race: null, horses: null }],
    ["horses が配列でない型", { race: "x", horses: {} }],
  ])("スナップショットが壊れている(%s)ときは、騎手の列は 0 頭(例外を投げない)", (_name, raw) => {
    expect(toSnapshotColumns(raw).jockeys.size).toBe(0);
  });

  it("調教師名・馬名は、騎手の列(jockeys)に混ざらない", () => {
    const out = toSnapshotColumns(SNAPSHOT);
    const text = JSON.stringify([...out.jockeys.values()]);
    expect(text).toContain("騎手ア"); // 前提: 騎手は出る
    for (const secret of ["SECRET", "trainer"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("v4 の列: buildRaceRows が馬番ごとに載せる", () => {
  const horsesV4 = [
    { umaban: 1, prior: 0.4, adjustedProb: 0.35, placeOddsMin: 3.1 },
    { umaban: 2, prior: 0.2, adjustedProb: 0.25, placeOddsMin: null },
    { umaban: 3, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 9 },
  ];

  it("全頭に載る。スナップショットに無い馬(umaban 3)は両列 null。馬ごとに別の値", () => {
    const rows = buildRaceRows(CHOSEN, horsesV4, [], null, new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.jockey_name, r.jockey_id])).toEqual([
      ["騎手ア", "01001"],
      ["騎手イ", "01002"],
      [null, null],
    ]);
    for (const r of rows) {
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
      expect(Object.keys(r).slice(32, 34)).toEqual([...PRIOR_ROW_KEYS_V4_ADDED]); // v4 の 2 列は 33・34 番目(v5 の 1 列・v6 の 4 列が後ろに続く)
    }
  });

  it("スナップショットが無い(null)ときは両列 null。ほかの列は変わらない", () => {
    const rows = buildRaceRows(CHOSEN, horsesV4, [], null, new Map(), null, NO_LOOKUP, NO_TRAINER_LOOKUP);
    for (const r of rows) {
      expect(PRIOR_ROW_KEYS_V4_ADDED.map((k) => r[k])).toEqual([null, null]);
      expect(r.jockey_id_source).toBeNull();
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
    }
  });

  it("行の JSON に騎手名・騎手 ID は出るが、馬名・スナップショットの市場の値は出ない", () => {
    const text = JSON.stringify(buildRaceRows(CHOSEN, horsesV4, [], null, new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP));
    for (const shown of ["騎手ア", "01001", "騎手イ", "01002"]) {
      expect(text, `行に ${shown} がある`).toContain(shown);
    }
    for (const secret of ["SECRET", "99.9", "77.7", "88.8"]) {
      expect(text, `行に ${secret} が無い`).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #526(段階 1b): 形式 v5。jockey_id_source 1 列。スナップショットに ID が無い行を、騎手名 → 騎手 ID の対応(jockey_names 表で ID がちょうど 1 つの名前)で埋める。
// ---------------------------------------------------------------------------

describe("v5 の列: buildRaceRows が jockey_id を名前から埋め、出どころを jockey_id_source に残す", () => {
  const horsesV5 = [1, 2, 3, 4, 5].map((umaban) => ({ umaban, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 2 }));
  /** 5 頭: 1 = ID あり、2 = ID なし(名前は表にある)、3 = ID なし(名前は表に無い)、4 = 騎手未定(名前なし・ID なし)、5 = スナップショットに載っていない。 */
  const snapshot = (): ReturnType<typeof toSnapshotColumns> =>
    toSnapshotColumns({
      race: { raceName: "x" },
      horses: [
        { umaban: 1, jockeyName: "戸崎圭", jockeyId: "05386" },
        { umaban: 2, jockeyName: "横山武", jockeyId: null },
        { umaban: 3, jockeyName: "表にない騎手", jockeyId: null },
        { umaban: 4, jockeyName: "", jockeyId: null },
      ],
    });
  const lookup = new Map([["横山武", "01170"], ["戸崎圭", "99999"]]); // 戸崎圭 は表の ID がスナップショットと食い違う(スナップショットが優先されることを値で見る)

  const idCols = (rows: readonly PriorDatasetRow[]): unknown[] => rows.map((r) => [r.jockey_name, r.jockey_id, r.jockey_id_source]);

  it("スナップショットに ID があればそれを使い(snapshot)、無くて表に名前があれば表の ID で埋め(name)、どちらでもなければ null。馬ごとに別の結果", () => {
    const rows = buildRaceRows(CHOSEN, horsesV5, [], null, new Map(), snapshot(), lookup, NO_TRAINER_LOOKUP);
    expect(rows).toHaveLength(5);
    expect(idCols(rows)).toEqual([
      ["戸崎圭", "05386", "snapshot"], // 表の 99999 ではなく、スナップショットの ID
      ["横山武", "01170", "name"],
      ["表にない騎手", null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("不変条件: jockey_id が null なのは jockey_id_source が null のときだけ(全行で。出どころが付くのは ID があるときだけ)", () => {
    const rows = buildRaceRows(CHOSEN, horsesV5, [], null, new Map(), snapshot(), lookup, NO_TRAINER_LOOKUP);
    expect(rows.filter((r) => r.jockey_id !== null)).toHaveLength(2); // 前提: ID のある行と無い行の両方がある
    expect(rows.filter((r) => r.jockey_id === null)).toHaveLength(3);
    for (const r of rows) {
      expect(r.jockey_id === null).toBe(r.jockey_id_source === null);
      expect([null, "snapshot", "name"]).toContain(r.jockey_id_source);
    }
  });

  it("対応が空(表が空・読み出し口が無い)なら、スナップショットの ID だけ(snapshot)。埋めない", () => {
    const rows = buildRaceRows(CHOSEN, horsesV5, [], null, new Map(), snapshot(), NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(idCols(rows)).toEqual([
      ["戸崎圭", "05386", "snapshot"],
      ["横山武", null, null],
      ["表にない騎手", null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("スナップショットが無い(null)ときは、名前が無いので表があっても全行 null", () => {
    const rows = buildRaceRows(CHOSEN, horsesV5, [], null, new Map(), null, lookup, NO_TRAINER_LOOKUP);
    expect(rows).toHaveLength(5);
    expect(idCols(rows)).toEqual(Array.from({ length: 5 }, () => [null, null, null]));
  });

  it("突き合わせは厳密な文字列一致: 前後の空白・全角と半角の違いは別の名前(直して合わせない)", () => {
    const snap = toSnapshotColumns({
      race: {},
      horses: [
        { umaban: 1, jockeyName: "横山武 ", jockeyId: null },
        { umaban: 2, jockeyName: "Ｍデムーロ", jockeyId: null },
        { umaban: 3, jockeyName: "Mデムーロ", jockeyId: null },
      ],
    });
    const rows = buildRaceRows(CHOSEN, horsesV5.slice(0, 3), [], null, new Map(), snap, new Map([["横山武", "01170"], ["Mデムーロ", "05212"]]), NO_TRAINER_LOOKUP);
    expect(idCols(rows)).toEqual([
      ["横山武 ", null, null],
      ["Ｍデムーロ", null, null],
      ["Mデムーロ", "05212", "name"],
    ]);
  });

  it("名前が Object のプロパティ名(constructor・__proto__・toString)でも、表に無ければ null(継承されたプロパティを ID と取り違えない)", () => {
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty"];
    const snap = toSnapshotColumns({ race: {}, horses: names.map((jockeyName, i) => ({ umaban: i + 1, jockeyName, jockeyId: null })) });
    const rows = buildRaceRows(CHOSEN, horsesV5.slice(0, 4), [], null, new Map(), snap, new Map([["横山武", "01170"]]), NO_TRAINER_LOOKUP);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect([r.jockey_id, r.jockey_id_source]).toEqual([null, null]);
    }
  });

  it("jockey_id の型が違う(数)スナップショットは、ID なしとして扱い、名前から埋める(型の違う値を ID として採らない)", () => {
    const snap = toSnapshotColumns({ race: {}, horses: [{ umaban: 1, jockeyName: "横山武", jockeyId: 1170 }] });
    expect(snap.jockeys.get(1)!.jockey_id).toBeNull(); // 前提: 数は採られない
    const [row] = buildRaceRows(CHOSEN, horsesV5.slice(0, 1), [], null, new Map(), snap, lookup, NO_TRAINER_LOOKUP);
    expect([row!.jockey_id, row!.jockey_id_source]).toEqual(["01170", "name"]);
  });

  it("行のキーの順は PRIOR_ROW_KEYS のまま(jockey_id_source は 35 番目。v6 の 4 列が後ろに続く)", () => {
    for (const r of buildRaceRows(CHOSEN, horsesV5, [], null, new Map(), snapshot(), lookup, NO_TRAINER_LOOKUP)) {
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
      expect(Object.keys(r).slice(34, 35)).toEqual([...PRIOR_ROW_KEYS_V5_ADDED]); // jockey_id_source は 35 番目(v6 の 4 列が後ろに続く)
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #540: 形式 v6。調教師名・調教師 ID・調教師 ID の出どころ・馬の ID の 4 列。
// 調教師 ID は、スナップショットに無い行を、調教師名 → 調教師 ID の対応(trainer_names 表で ID がちょうど 1 つの名前)で埋める(騎手と同じ規則)。馬の ID は名前から埋めない。
// ---------------------------------------------------------------------------

describe("toSnapshotColumns: v6 の列(調教師名・調教師 ID・馬の ID)", () => {
  it("馬番ごとに、調教師名・調教師 ID と、馬の ID を取り出す。馬ごとに別の値(取り違えの検知)。馬名は結果に含まれない", () => {
    const out = toSnapshotColumns(SNAPSHOT);
    expect([...out.trainers.keys()]).toEqual([1, 2]);
    expect(out.trainers.get(1)).toEqual({ trainer_name: "調教師ア", trainer_id: "02001" });
    expect(out.trainers.get(2)).toEqual({ trainer_name: "調教師イ", trainer_id: "02002" });
    expect([...out.horseIds.entries()]).toEqual([[1, "2021100001"], [2, "2021100002"]]);
    const text = JSON.stringify([...out.trainers.values(), ...out.horseIds.values()]);
    expect(text).toContain("調教師ア"); // 前提: 調教師名は出る
    expect(text).not.toContain("SECRET"); // 馬名は出ない
  });

  it("このキーを保存する前の旧スナップショット(trainerId・horseId のキーが無い)は、調教師名は入り、2 つの ID は null", () => {
    const old = clone(SNAPSHOT);
    for (const h of old.horses as Array<Record<string, unknown>>) {
      delete h["trainerId"];
      delete h["horseId"];
    }
    const out = toSnapshotColumns(old);
    expect(out.trainers.get(1)).toEqual({ trainer_name: "調教師ア", trainer_id: null });
    expect(out.horseIds.get(1)).toBeNull();
    expect(out.horseIds.size).toBe(2); // 馬ごとに null が入っている(馬が消えない)
  });

  it.each([
    ["調教師名が空文字", "trainerName", "", "trainer_name"],
    ["調教師名が数", "trainerName", 7, "trainer_name"],
    ["調教師 ID が数(\"02001\" が 2001 になっていても採らない)", "trainerId", 2001, "trainer_id"],
    ["調教師 ID が空文字", "trainerId", "", "trainer_id"],
  ] as const)("%s のときは、その列だけ null(ほかの列は変わらない)", (_name, key, value, column) => {
    const bad = clone(SNAPSHOT);
    (bad.horses[0] as Record<string, unknown>)[key] = value;
    const got = toSnapshotColumns(bad).trainers.get(1)!;
    expect(got[column]).toBeNull();
    const other = column === "trainer_name" ? "trainer_id" : "trainer_name";
    expect(got[other]).not.toBeNull(); // 前提: もう一方の列は取れている
    expect(toSnapshotColumns(bad).horseIds.get(1)).toBe("2021100001");
  });

  it("馬の ID が数・空文字なら、その馬の horse_id だけ null", () => {
    for (const bad of [2021100001, ""]) {
      const snap = clone(SNAPSHOT);
      (snap.horses[0] as Record<string, unknown>)["horseId"] = bad;
      const out = toSnapshotColumns(snap);
      expect(out.horseIds.get(1)).toBeNull();
      expect(out.horseIds.get(2)).toBe("2021100002"); // 隣の馬は取れる
    }
  });

  it.each([
    ["null", null],
    ["文字列", "x"],
    ["空のオブジェクト", {}],
    ["horses が配列でない型", { race: "x", horses: {} }],
  ])("スナップショットが壊れている(%s)ときは、調教師の列・馬の ID は 0 頭(例外を投げない)", (_name, raw) => {
    const out = toSnapshotColumns(raw);
    expect(out.trainers.size).toBe(0);
    expect(out.horseIds.size).toBe(0);
  });
});

describe("v6 の列: buildRaceRows が調教師 ID を名前から埋め、出どころを trainer_id_source に残す。馬の ID は名前から埋めない", () => {
  const horsesV6 = [1, 2, 3, 4, 5].map((umaban) => ({ umaban, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 2 }));
  /** 5 頭: 1 = ID あり、2 = ID なし(名前は表にある)、3 = ID なし(名前は表に無い)、4 = 調教師名なし・ID なし、5 = スナップショットに載っていない。 */
  const snapshot = (): ReturnType<typeof toSnapshotColumns> =>
    toSnapshotColumns({
      race: { raceName: "x" },
      horses: [
        { umaban: 1, trainerName: "藤野", trainerId: "01200", horseId: "2024104976" },
        { umaban: 2, trainerName: "和田雄", trainerId: null, horseId: "2021105857" },
        { umaban: 3, trainerName: "表にない調教師", trainerId: null },
        { umaban: 4, trainerName: "", trainerId: null },
      ],
    });
  const lookup = new Map([["和田雄", "01143"], ["藤野", "99999"]]); // 藤野 は表の ID がスナップショットと食い違う(スナップショットが優先されることを値で見る)
  const trainerCols = (rows: readonly PriorDatasetRow[]): unknown[] => rows.map((r) => [r.trainer_name, r.trainer_id, r.trainer_id_source]);

  it("スナップショットに ID があればそれを使い(snapshot)、無くて表に名前があれば表の ID で埋め(name)、どちらでもなければ null。馬ごとに別の結果", () => {
    const rows = buildRaceRows(CHOSEN, horsesV6, [], null, new Map(), snapshot(), NO_LOOKUP, lookup);
    expect(rows).toHaveLength(5);
    expect(trainerCols(rows)).toEqual([
      ["藤野", "01200", "snapshot"], // 表の 99999 ではなく、スナップショットの ID
      ["和田雄", "01143", "name"],
      ["表にない調教師", null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("不変条件: trainer_id が null なのは trainer_id_source が null のときだけ(全行で)", () => {
    const rows = buildRaceRows(CHOSEN, horsesV6, [], null, new Map(), snapshot(), NO_LOOKUP, lookup);
    expect(rows.filter((r) => r.trainer_id !== null)).toHaveLength(2); // 前提: ID のある行と無い行の両方がある
    expect(rows.filter((r) => r.trainer_id === null)).toHaveLength(3);
    for (const r of rows) {
      expect(r.trainer_id === null).toBe(r.trainer_id_source === null);
      expect([null, "snapshot", "name"]).toContain(r.trainer_id_source);
    }
  });

  it("対応が空なら、スナップショットの ID だけ(snapshot)。埋めない", () => {
    const rows = buildRaceRows(CHOSEN, horsesV6, [], null, new Map(), snapshot(), NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(trainerCols(rows)).toEqual([
      ["藤野", "01200", "snapshot"],
      ["和田雄", null, null],
      ["表にない調教師", null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("スナップショットが無い(null)ときは、名前が無いので表があっても全行 null(4 列とも)", () => {
    const rows = buildRaceRows(CHOSEN, horsesV6, [], null, new Map(), null, NO_LOOKUP, lookup);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(PRIOR_ROW_KEYS_V6_ADDED.map((k) => r[k])).toEqual([null, null, null, null]);
    }
  });

  it("騎手の対応表と調教師の対応表は混ざらない: 調教師名が騎手の表にあっても埋めない。騎手名が調教師の表にあっても埋めない", () => {
    const snap = toSnapshotColumns({
      race: {},
      horses: [{ umaban: 1, jockeyName: "横山武", jockeyId: null, trainerName: "和田雄", trainerId: null }],
    });
    // 調教師名 和田雄 は騎手の表にだけある。騎手名 横山武 は調教師の表にだけある。
    const [row] = buildRaceRows(CHOSEN, horsesV6.slice(0, 1), [], null, new Map(), snap, new Map([["和田雄", "00001"]]), new Map([["横山武", "00002"]]));
    expect([row!.jockey_id, row!.jockey_id_source, row!.trainer_id, row!.trainer_id_source]).toEqual([null, null, null, null]);
    // 対照: 正しい表なら、両方埋まる(騎手の ID と調教師の ID は別の値)。
    const [ok] = buildRaceRows(CHOSEN, horsesV6.slice(0, 1), [], null, new Map(), snap, new Map([["横山武", "01170"]]), new Map([["和田雄", "01143"]]));
    expect([ok!.jockey_id, ok!.jockey_id_source, ok!.trainer_id, ok!.trainer_id_source]).toEqual(["01170", "name", "01143", "name"]);
  });

  it("突き合わせは厳密な文字列一致: 前後の空白・全角と半角の違いは別の名前(直して合わせない)", () => {
    const snap = toSnapshotColumns({
      race: {},
      horses: [
        { umaban: 1, trainerName: "和田雄 ", trainerId: null },
        { umaban: 2, trainerName: "Ｍ藤野", trainerId: null },
        { umaban: 3, trainerName: "M藤野", trainerId: null },
      ],
    });
    const rows = buildRaceRows(CHOSEN, horsesV6.slice(0, 3), [], null, new Map(), snap, NO_LOOKUP, new Map([["和田雄", "01143"], ["M藤野", "01200"]]));
    expect(trainerCols(rows)).toEqual([
      ["和田雄 ", null, null],
      ["Ｍ藤野", null, null],
      ["M藤野", "01200", "name"],
    ]);
  });

  it("名前が Object のプロパティ名(constructor・__proto__・toString)でも、表に無ければ null(継承されたプロパティを ID と取り違えない)", () => {
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty"];
    const snap = toSnapshotColumns({ race: {}, horses: names.map((trainerName, i) => ({ umaban: i + 1, trainerName, trainerId: null })) });
    const rows = buildRaceRows(CHOSEN, horsesV6.slice(0, 4), [], null, new Map(), snap, NO_LOOKUP, new Map([["和田雄", "01143"]]));
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect([r.trainer_id, r.trainer_id_source]).toEqual([null, null]);
    }
  });

  it("trainer_id の型が違う(数)スナップショットは、ID なしとして扱い、名前から埋める", () => {
    const snap = toSnapshotColumns({ race: {}, horses: [{ umaban: 1, trainerName: "和田雄", trainerId: 1143 }] });
    expect(snap.trainers.get(1)!.trainer_id).toBeNull(); // 前提: 数は採られない
    const [row] = buildRaceRows(CHOSEN, horsesV6.slice(0, 1), [], null, new Map(), snap, NO_LOOKUP, lookup);
    expect([row!.trainer_id, row!.trainer_id_source]).toEqual(["01143", "name"]);
  });

  it("horse_id は、スナップショットにある馬だけ。キーの無い旧スナップショット・載っていない馬・スナップショットなしは null(名前からも表からも埋めない)", () => {
    const rows = buildRaceRows(CHOSEN, horsesV6, [], null, new Map(), snapshot(), NO_LOOKUP, lookup);
    expect(rows.map((r) => r.horse_id)).toEqual(["2024104976", "2021105857", null, null, null]); // 3 頭目はキーなし、4 頭目はキーなし、5 頭目は載っていない
    const none = buildRaceRows(CHOSEN, horsesV6, [], null, new Map(), null, NO_LOOKUP, lookup);
    expect(none.map((r) => r.horse_id)).toEqual([null, null, null, null, null]);
    // 調教師名が表にあり、調教師 ID は名前から埋まるが、馬の ID はスナップショットに無いので null のまま(表の ID を馬の ID に流用しない)。
    const oldSnap = toSnapshotColumns({ race: {}, horses: [{ umaban: 1, trainerName: "和田雄", trainerId: null }] });
    const [filled] = buildRaceRows(CHOSEN, horsesV6.slice(0, 1), [], null, new Map(), oldSnap, NO_LOOKUP, lookup);
    expect([filled!.trainer_id, filled!.trainer_id_source, filled!.horse_id]).toEqual(["01143", "name", null]);
  });

  it("行のキーの順は PRIOR_ROW_KEYS のまま。v6 の 4 列は末尾(trainer_name・trainer_id・trainer_id_source・horse_id)", () => {
    for (const r of buildRaceRows(CHOSEN, horsesV6, [], null, new Map(), snapshot(), NO_LOOKUP, lookup)) {
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
      expect(Object.keys(r).slice(35)).toEqual([...PRIOR_ROW_KEYS_V6_ADDED]);
    }
  });

  it("format 5 までの 35 列の値は、v6 の列を足しても変わらない: 同じ入力で、35 列ぶんは調教師の表・スナップショットの調教師・馬の ID の有無に依らず同じ", () => {
    const withIds = snapshot();
    const withoutIds = toSnapshotColumns({
      race: { raceName: "x" },
      horses: [
        { umaban: 1, trainerName: "", trainerId: null },
        { umaban: 2, trainerName: "", trainerId: null },
      ],
    });
    const a = buildRaceRows(CHOSEN, horsesV6.slice(0, 2), [], "芝", new Map(), withIds, NO_LOOKUP, lookup);
    const b = buildRaceRows(CHOSEN, horsesV6.slice(0, 2), [], "芝", new Map(), withoutIds, NO_LOOKUP, NO_TRAINER_LOOKUP);
    expect(a).toHaveLength(2);
    expect(a.map((r) => PRIOR_ROW_KEYS.slice(0, 35).map((k) => r[k]))).toEqual(b.map((r) => PRIOR_ROW_KEYS.slice(0, 35).map((k) => r[k])));
    expect(a[0]!.trainer_id).not.toBe(b[0]!.trainer_id); // 前提: v6 の列は実際に違う(比較が空振りでない)
  });

  it("行の JSON に調教師名・調教師 ID・馬の ID は出るが、馬名・スナップショットの市場の値は出ない", () => {
    const text = JSON.stringify(buildRaceRows(CHOSEN, horsesV6.slice(0, 2), [], null, new Map(), toSnapshotColumns(SNAPSHOT), NO_LOOKUP, NO_TRAINER_LOOKUP));
    for (const shown of ["調教師ア", "02001", "調教師イ", "02002", "2021100001", "2021100002"]) {
      expect(text, `行に ${shown} がある`).toContain(shown);
    }
    for (const secret of ["SECRET", "99.9", "77.7", "88.8"]) {
      expect(text, `行に ${secret} が無い`).not.toContain(secret);
    }
  });
});
