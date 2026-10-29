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
    const rows = buildRaceRows(CHOSEN, horses, results, "ダ", contributions, null);
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
    const [row] = buildRaceRows(CHOSEN, horses, results, null, contributions, null);
    expect(Object.keys(row!)).toEqual([...PRIOR_ROW_KEYS]);
    for (const forbidden of ["additional_instruction", "raw_response", "reason", "highlights", "concerns", "mark", "horse_name", "model", "bets"]) {
      expect(PRIOR_ROW_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("地方のレース ID は venue_kind が nar。kaisai_date が NULL なら地方のレース ID から補う", () => {
    const nar: ChosenAnalysis = { ...CHOSEN, raceId: "202544101501", kaisaiDate: null };
    const [row] = buildRaceRows(nar, horses, results, null, contributions, null);
    expect(row!.venue_kind).toBe("nar");
    expect(row!.kaisai_date).toBe("20251015");
  });

  it("中央で kaisai_date が NULL なら null のまま(推測しない)", () => {
    const [row] = buildRaceRows({ ...CHOSEN, kaisaiDate: null }, horses, results, null, contributions, null);
    expect(row!.kaisai_date).toBeNull();
  });
});

describe("NDJSON(gzip の複数メンバー)とファイル名", () => {
  const row = (umaban: number): PriorDatasetRow => buildRaceRows(CHOSEN, [{ umaban, prior: 0.1, adjustedProb: 0.1, placeOddsMin: 1.5 }], [], null, new Map(), null)[0]!;

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
      umaban: 1, wakuban: 1, name: "SECRET-HORSE", sex: "牡", age: 3, kinryo: 56, jockeyName: "騎手ア", jockeyId: "01001", trainerName: "SECRET-TRAINER", bodyWeight: 480,
      winOdds: 99.9, popularity: 13, placeOddsMin: 77.7, placeOddsMax: 88.8, oikiriCritic: "動き良化", oikiriRank: "A",
    },
    {
      umaban: 2, wakuban: 2, name: "SECRET-HORSE-2", sex: "牝", age: 4, kinryo: 54.5, jockeyName: "騎手イ", jockeyId: "01002", trainerName: "SECRET-TRAINER-2", bodyWeight: null,
      winOdds: 5, popularity: 2, placeOddsMin: 1.5, placeOddsMax: 2, oikiriCritic: null, oikiriRank: null,
    },
  ],
};

const HORSE1 = { wakuban: 1, sex: "牡", age: 3, body_weight: 480, kinryo: 56, oikiri_rank: "A", oikiri_critic: "動き良化" };
const NULL_HORSE = { wakuban: null, sex: null, age: null, body_weight: null, kinryo: null, oikiri_rank: null, oikiri_critic: null };
const NULL_RACE = { race_name: null, grade: null, distance: null, track_condition: null };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("v2 の列(許可リスト)", () => {
  it("形式の版は 4(Issue #526)。v1 の 19 列は先頭にそのまま残り、v2 で足した 11 列・v3 で足した 2 列・v4 で足した 2 列がこの順で続く(順序も固定)", () => {
    expect(PRIOR_EXPORT_FORMAT).toBe(4);
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
    expect([...PRIOR_ROW_KEYS]).toEqual([...PRIOR_ROW_KEYS_V1, ...PRIOR_ROW_KEYS_V2_ADDED, ...PRIOR_ROW_KEYS_V3_ADDED, ...PRIOR_ROW_KEYS_V4_ADDED]);
    expect(PRIOR_ROW_KEYS).toHaveLength(34);
    expect(PRIOR_ROW_KEYS.slice(-2)).toEqual(["jockey_name", "jockey_id"]); // 末尾の 2 列が騎手
  });

  it("馬名・調教師名と、スナップショットの市場の値(単勝オッズ・人気・複勝オッズ)は列にない(騎手名・騎手 ID は format 4 から入る)。既存の win_odds・ninki(確定値)と place_odds_min だけが市場に近い列", () => {
    for (const forbidden of [
      "name", "horse_name", "trainer_name", "jockey", "trainer", "horse_id", "trainer_id", "jockey_code", "trainer_code",
      "popularity", "place_odds_max", "snapshot_win_odds", "snapshot_popularity", "snapshot_place_odds_min", "winOdds", "placeOddsMax",
    ]) {
      expect(PRIOR_ROW_KEYS as readonly string[], `${forbidden} は列にない`).not.toContain(forbidden);
    }
    expect(PRIOR_ROW_KEYS.filter((k) => /odds|ninki|popul/.test(k))).toEqual(["place_odds_min", "win_odds", "ninki"]);
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
    const rows = buildRaceRows(CHOSEN, horses, results, "芝", new Map(), toSnapshotColumns(SNAPSHOT));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.race_name === "テストステークス" && r.grade === "G3" && r.distance === 1600 && r.track_condition === "良")).toBe(true);
    expect(rows[0]).toMatchObject(HORSE1);
    expect(rows[1]).toMatchObject({ wakuban: 2, sex: "牝", age: 4, body_weight: null, kinryo: 54.5, oikiri_rank: null, oikiri_critic: null });
    expect(rows[2]).toMatchObject(NULL_HORSE);
  });

  it("スナップショットが無い(null)ときは、v2 の 11 列がすべて null。v1 の列は変わらない", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, "芝", new Map(), null);
    for (const r of rows) {
      expect(PRIOR_ROW_KEYS_V2_ADDED.map((k) => r[k])).toEqual(Array(11).fill(null));
    }
    expect(rows[0]).toMatchObject({ analysis_id: 7, win_odds: 2.5, ninki: 1, place_odds_min: 3.1, course_type: "芝", field_size: 3 });
  });

  it("キーの順序は PRIOR_ROW_KEYS(v1 の 19 列が先頭)と完全に一致する", () => {
    const [row] = buildRaceRows(CHOSEN, horses, results, null, new Map(), toSnapshotColumns(SNAPSHOT));
    expect(Object.keys(row!)).toEqual([...PRIOR_ROW_KEYS]);
    expect(Object.keys(row!).slice(0, 19)).toEqual([...PRIOR_ROW_KEYS_V1]);
  });

  it("市場の値は、スナップショットのもの(単勝 99.9・人気 13・複勝 77.7/88.8)ではなく、既存の確定値・分析の値のまま。人名・馬名は行のどこにも出ない", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, null, new Map(), toSnapshotColumns(SNAPSHOT));
    expect(rows[0]).toMatchObject({ win_odds: 2.5, ninki: 1, place_odds_min: 3.1 });
    const text = JSON.stringify(rows);
    for (const secret of ["SECRET", "99.9", "77.7", "88.8"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("assembleFile のメタ行は format 4 で、列は 34 列。notes に v2 の列の出どころ・null の意味(grade の曖昧さ・地方の調教・critic の未確認)と、v3・v4 の列の意味を書く", () => {
    const rows = buildRaceRows(CHOSEN, horses, results, null, new Map(), toSnapshotColumns(SNAPSHOT));
    const file = assembleFile({ generatedAt: "2026-10-10T12:00:00.000Z", rows: rows.length, races: 1, missingDetail: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 } }, [encodeChunk(rows)]);
    const lines = new TextDecoder().decode(gunzipSync(file)).split("\n").filter((l) => l !== "");
    const head = JSON.parse(lines[0]!) as { _meta: { format: number; columns: string[]; notes: string[] } };
    expect(head._meta.format).toBe(4);
    expect(head._meta.columns).toHaveLength(34);
    expect(head._meta.columns.slice(-2)).toEqual(["jockey_name", "jockey_id"]);
    const notes = head._meta.notes.join("\n");
    for (const phrase of ["v2", "raceSnapshot", "grade", "地方", "oikiri_critic", "16 文字", "確認していない", "馬名・調教師名", "format 3", "weight_type", "fillies_only", "区別できない", "前走"]) {
      expect(notes, `notes に「${phrase}」`).toContain(phrase);
    }
    // format 4(Issue #526): 方針の変更を書く。「騎手名は含めない」という旧い方針の文は残さない。
    for (const phrase of ["format 4", "jockey_name", "jockey_id", "#526", "2026-10-29", "騎手と馬の相性", "乗り替わり", "実際に乗った騎手とは限らない", "区別できない"]) {
      expect(notes, `notes に「${phrase}」`).toContain(phrase);
    }
    expect(notes).not.toContain("馬名・騎手名・調教師名");
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

  it("レースの条件は全頭に入る(スナップショットに無い馬にも)。キーの順序は PRIOR_ROW_KEYS で、v3 の 2 列は 31・32 番目(v4 の 2 列が末尾)", () => {
    const rows = buildRaceRows(CHOSEN_V3, horsesV3, [], null, new Map(), toSnapshotColumns(SNAPSHOT));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.weight_type).toBe("ハンデ");
      expect(r.fillies_only).toBe(false);
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
      expect(Object.keys(r).slice(30, 32)).toEqual([...PRIOR_ROW_KEYS_V3_ADDED]); // v4 で足した 2 列が末尾に来たので、v3 の 2 列は 31・32 番目
    }
  });

  it("スナップショットが無い(null)ときは v3 の 2 列も null。ほかの列は変わらない", () => {
    const rows = buildRaceRows(CHOSEN_V3, horsesV3, [], null, new Map(), null);
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

  it("調教師名・馬名は、騎手の列にも、結果のどこにも出ない", () => {
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
    const rows = buildRaceRows(CHOSEN, horsesV4, [], null, new Map(), toSnapshotColumns(SNAPSHOT));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.jockey_name, r.jockey_id])).toEqual([
      ["騎手ア", "01001"],
      ["騎手イ", "01002"],
      [null, null],
    ]);
    for (const r of rows) {
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
      expect(Object.keys(r).slice(-2)).toEqual([...PRIOR_ROW_KEYS_V4_ADDED]);
    }
  });

  it("スナップショットが無い(null)ときは両列 null。ほかの列は変わらない", () => {
    const rows = buildRaceRows(CHOSEN, horsesV4, [], null, new Map(), null);
    for (const r of rows) {
      expect(PRIOR_ROW_KEYS_V4_ADDED.map((k) => r[k])).toEqual([null, null]);
      expect(Object.keys(r)).toEqual([...PRIOR_ROW_KEYS]);
    }
  });

  it("行の JSON に騎手名・騎手 ID は出るが、調教師名・馬名・スナップショットの市場の値は出ない", () => {
    const text = JSON.stringify(buildRaceRows(CHOSEN, horsesV4, [], null, new Map(), toSnapshotColumns(SNAPSHOT)));
    for (const shown of ["騎手ア", "01001", "騎手イ", "01002"]) {
      expect(text, `行に ${shown} がある`).toContain(shown);
    }
    for (const secret of ["SECRET", "99.9", "77.7", "88.8"]) {
      expect(text, `行に ${secret} が無い`).not.toContain(secret);
    }
  });
});
