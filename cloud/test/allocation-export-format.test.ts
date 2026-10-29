import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collectProposedBetEvents, computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyReadRows } from "../src/verify-read";
import {
  ALLOCATION_ALLOCATION_KEYS,
  ALLOCATION_BET_KEYS,
  ALLOCATION_CODES_KEYS,
  ALLOCATION_COMBO_KINDS,
  ALLOCATION_EXPORT_FORMAT,
  ALLOCATION_HORSE_KEYS,
  ALLOCATION_MISSED_KEYS,
  ALLOCATION_RESULT_HORSE_KEYS,
  ALLOCATION_RESULT_KEYS,
  ALLOCATION_ROW_KEYS,
  ALLOCATION_SETTINGS_KEYS,
  allocationExportFilename,
  buildAllocationHead,
  buildAllocationRaceRow,
  encodeAllocationChunk,
  selectAllocationExportAnalyses,
  toAllocationSnapshot,
  type AllocationMetaInput,
  type AllocationRaceRow,
  type BuildAllocationRowInput,
  type ChosenAllocationAnalysis,
} from "../src/allocation-export-format";
import type { CandidateRow } from "../src/prior-export-format";

/**
 * Issue #463: 配分の再計算用の書き出しの形式(純関数)。母集団は検証画面の `computeVerifyReport` と同じ規則であること(表駆動の同値性)、
 * 行の列が許可リストと完全一致すること・自由文や名前が漏れないこと・NULL が NULL のまま出ること・塊の大きさの上界を固定する。
 */

const RACE_A = "202606030811";
const RACE_B = "202606030812";
const RACE_C = "202606030813";

interface Spec {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly promptVersion?: string | null;
  readonly historyCutoffDate?: string | null;
  readonly promptLookaheadGuarded?: 0 | 1 | null;
  readonly startTime?: string | null;
  readonly evEstimated?: 0 | 1;
}

const BEFORE_START = "2026-07-05T00:00:00.000Z"; // JST 09:00。発走 15:45 より前
const AFTER_START = "2026-07-05T08:00:00.000Z"; // JST 17:00。発走 15:45 より後

function candidate(s: Spec): CandidateRow {
  return {
    id: s.id, raceId: s.raceId, analyzedAt: s.analyzedAt, kaisaiDate: "20260705", promptVersion: s.promptVersion === undefined ? "v9" : s.promptVersion,
    detailKey: `analyses/${s.id}.json.gz`, evEstimated: s.evEstimated ?? 0, promptLookaheadGuarded: s.promptLookaheadGuarded === undefined ? null : s.promptLookaheadGuarded,
    historyCutoffDate: s.historyCutoffDate === undefined ? null : s.historyCutoffDate, startTime: s.startTime === undefined ? "15:45" : s.startTime,
  };
}

/** 同じ Spec から検証画面の読み取り口を作る(各分析に買い目を 1 件ずつ付け、採用された分析を `collectProposedBetEvents` の analysisId で見分けられるようにする)。 */
function verifySource(specs: readonly Spec[]): ReturnType<typeof buildVerifySource> {
  const startOf = (s: Spec): string | null => (s.startTime === undefined ? "15:45" : s.startTime);
  const analyses: VerifyAnalysisRow[] = specs.map((s) => ({
    id: s.id, raceId: s.raceId, analyzedAt: s.analyzedAt, evEstimated: s.evEstimated ?? 0, promptVersion: s.promptVersion === undefined ? "v9" : s.promptVersion,
    additionalInstruction: null, kaisaiDate: "20260705", model: null, rawResponse: null,
    raceSnapshotJson: startOf(s) !== null && /^[0-9]/.test(startOf(s)!) ? JSON.stringify({ race: { startTime: startOf(s) } }) : null,
    historyCutoffDate: s.historyCutoffDate === undefined ? null : s.historyCutoffDate,
    promptLookaheadGuarded: s.promptLookaheadGuarded === undefined ? null : s.promptLookaheadGuarded, startTime: startOf(s),
  }));
  const raceIds = [...new Set(specs.map((s) => s.raceId))];
  const rows: VerifyReadRows = {
    analyses,
    horses: [],
    allocationMeta: specs.map((s) => ({ analysisId: s.id, route: "mixed", skipReasonCode: null })),
    bets: specs.map((s) => ({ analysisId: s.id, betType: "place", comboKey: "01", stake: 100 })),
    results: raceIds.map((raceId) => ({ raceId, umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 300 })),
    comboPayouts: [],
    comboImports: [],
  };
  return buildVerifySource(rows);
}

describe("selectAllocationExportAnalyses: 検証画面(computeVerifyReport。PRODUCTION_VERIFY_CONFIG)と同じ母集団", () => {
  // 各ケースは (名前, 分析の列)。発走時刻はすべて入っている(start_time NULL は検証画面側が補完を待つので、別のテストで扱う)。
  const CASES: ReadonlyArray<{ readonly name: string; readonly specs: Spec[] }> = [
    { name: "遮断済み(LLM も遮断)は、分析が発走後でも clean", specs: [{ id: 1, raceId: RACE_A, analyzedAt: AFTER_START, historyCutoffDate: "20260704", promptLookaheadGuarded: 1 }] },
    { name: "LLM 未使用(prompt_version NULL)で history_cutoff あり → clean(発走後でも)", specs: [{ id: 1, raceId: RACE_A, analyzedAt: AFTER_START, historyCutoffDate: "20260704", promptVersion: null }] },
    {
      name: "history_cutoff はあるが LLM のプロンプトは遮断なし(prior-dataset なら無条件で入る行)→ 発走後は suspect で除外",
      specs: [{ id: 1, raceId: RACE_A, analyzedAt: AFTER_START, historyCutoffDate: "20260704", promptLookaheadGuarded: 0 }],
    },
    { name: "遮断なしで発走前 → clean", specs: [{ id: 1, raceId: RACE_A, analyzedAt: BEFORE_START }] },
    { name: "遮断なしで発走後 → suspect", specs: [{ id: 1, raceId: RACE_A, analyzedAt: AFTER_START }] },
    { name: "遮断なし・時刻なし('')で開催日の当日中 → unknown", specs: [{ id: 1, raceId: RACE_A, analyzedAt: "2026-07-05T03:00:00.000Z", startTime: "" }] },
    {
      name: "同じレースの clean が複数 → 最新だけ(古い方は superseded)。analyzed_at が同じなら id が大きい方",
      specs: [
        { id: 1, raceId: RACE_A, analyzedAt: "2026-07-04T00:00:00.000Z" },
        { id: 2, raceId: RACE_A, analyzedAt: BEFORE_START },
        { id: 3, raceId: RACE_A, analyzedAt: BEFORE_START },
      ],
    },
    {
      name: "古い clean と、新しい suspect → suspect は最新の座を奪わず、古い clean が採用される(最新選択の前に分類する)",
      specs: [
        { id: 1, raceId: RACE_A, analyzedAt: BEFORE_START },
        { id: 2, raceId: RACE_A, analyzedAt: AFTER_START },
      ],
    },
    {
      name: "最新の clean が推定 EV → そのレースは丸ごと除外(古い clean に代わらない)",
      specs: [
        { id: 1, raceId: RACE_A, analyzedAt: "2026-07-04T00:00:00.000Z" },
        { id: 2, raceId: RACE_A, analyzedAt: BEFORE_START, evEstimated: 1 },
      ],
    },
    {
      name: "古い clean が推定 EV で、新しい clean が確定 EV → 新しい方を採用(古い推定 EV は superseded)",
      specs: [
        { id: 1, raceId: RACE_A, analyzedAt: "2026-07-04T00:00:00.000Z", evEstimated: 1 },
        { id: 2, raceId: RACE_A, analyzedAt: BEFORE_START },
      ],
    },
    {
      name: "複数のレースの混在(採用・suspect・推定 EV・最新に取って代わられた旧分析が同時にある)",
      specs: [
        { id: 1, raceId: RACE_A, analyzedAt: BEFORE_START },
        { id: 2, raceId: RACE_B, analyzedAt: AFTER_START },
        { id: 3, raceId: RACE_C, analyzedAt: BEFORE_START, evEstimated: 1 },
        { id: 4, raceId: RACE_A, analyzedAt: "2026-07-04T00:00:00.000Z" },
      ],
    },
  ];

  /** 補完が済んだ状態(発走時刻が全分析に入っている)の分析の列を、書き出しの選別と検証画面の集計の両方に通して、同じになることを確かめる。 */
  function expectSameAsVerify(specs: readonly Spec[]): ReturnType<typeof selectAllocationExportAnalyses> {
    const source = verifySource(specs);
    const report = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG);
    const events = collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG);
    const selected = selectAllocationExportAnalyses(specs.map(candidate));
    const { chosen, excluded } = selected;
    // 採用された分析の集合が検証画面と同じ(各分析に買い目が 1 件あるので、採用された分析だけが事象を出す)
    expect(chosen.map((c) => c.id).sort((a, b) => a - b)).toEqual([...new Set(events.map((e) => e.analysisId))].sort((a, b) => a - b));
    // 除外の内訳が検証画面のカウンタと同じ
    expect(chosen.length).toBe(report.includedAnalysisCount);
    expect(excluded.suspect).toBe(report.excludedLookaheadSuspectCount);
    expect(excluded.unknown).toBe(report.excludedLookaheadUnknownCount);
    expect(excluded.superseded).toBe(report.supersededAnalysisCount);
    expect(excluded.estimated).toBe(report.excludedEstimatedCount);
    expect(excluded.unchecked).toBe(0);
    expect(excluded.uncheckedRaces).toBe(0);
    // 内訳の和 + 採用 = 候補の総数
    expect(chosen.length + excluded.suspect + excluded.unknown + excluded.unchecked + excluded.superseded + excluded.estimated).toBe(specs.length);
    return selected;
  }

  for (const { name, specs } of CASES) {
    it(`${name}`, () => {
      expectSameAsVerify(specs);
    });
  }

  it("前提(空振り防止): 上の表は、採用・suspect・unknown・superseded・estimated のすべてが 1 件以上現れるように作ってある", () => {
    const totals = { chosen: 0, suspect: 0, unknown: 0, superseded: 0, estimated: 0 };
    for (const { specs } of CASES) {
      const { chosen, excluded } = selectAllocationExportAnalyses(specs.map(candidate));
      totals.chosen += chosen.length;
      totals.suspect += excluded.suspect;
      totals.unknown += excluded.unknown;
      totals.superseded += excluded.superseded;
      totals.estimated += excluded.estimated;
    }
    for (const [name, n] of Object.entries(totals)) {
      expect(n, name).toBeGreaterThan(0);
    }
  });

  describe("start_time が NULL(発走時刻の補完待ち)の分析: 検証画面は補完が済むまで集計を待つので、補完が済んだあとの結果に合わせる", () => {
    // 同じ分析の列を「補完前(最新だけ start_time が NULL)」と「補完後(start_time が入った)」の2つの状態で並べる。補完前の書き出しは、補完後の検証画面の結果を先取りしない:
    // 最新が unchecked のレースは、古い clean に代えず、レースごと書き出さない。補完後は検証画面と一致する。
    const OLDER_CLEAN: Spec = { id: 1, raceId: RACE_A, analyzedAt: "2026-07-04T00:00:00.000Z" };
    const TABLE: ReadonlyArray<{ readonly name: string; readonly before: Spec[]; readonly afterClean: Spec[]; readonly afterSuspect: Spec[] }> = [
      {
        name: "最新が unchecked・1 つ古いのが clean",
        before: [OLDER_CLEAN, { id: 2, raceId: RACE_A, analyzedAt: BEFORE_START, startTime: null }],
        afterClean: [OLDER_CLEAN, { id: 2, raceId: RACE_A, analyzedAt: BEFORE_START }], // 補完後に clean(発走前)→ 新しい方(2)が採用される
        afterSuspect: [OLDER_CLEAN, { id: 2, raceId: RACE_A, analyzedAt: AFTER_START }], // 補完後に suspect(発走後)→ 古い clean(1)が採用される
      },
    ];

    for (const { name, before, afterClean, afterSuspect } of TABLE) {
      it(`${name}: 補完前はレースごと書き出さない(古い clean に代えない)。除外した分析は unchecked に、レース数は uncheckedRaces に数える`, () => {
        const { chosen, excluded } = selectAllocationExportAnalyses(before.map(candidate));
        expect(chosen).toEqual([]);
        // 古い clean(1)は、より新しい分析(2)があるので superseded に数える。和 + 採用 = 候補の総数
        expect(excluded).toEqual({ suspect: 0, unknown: 0, unchecked: 1, uncheckedRaces: 1, superseded: 1, estimated: 0 });
        expect(chosen.length + excluded.suspect + excluded.unknown + excluded.unchecked + excluded.superseded + excluded.estimated).toBe(before.length);
      });

      it(`${name}: 補完後は検証画面と一致する(clean なら新しい方、suspect なら古い clean)`, () => {
        expect(expectSameAsVerify(afterClean).chosen.map((c) => c.id)).toEqual([2]);
        expect(expectSameAsVerify(afterSuspect).chosen.map((c) => c.id)).toEqual([1]);
      });
    }

    it("最新が clean で、古いのが unchecked なら、最新を採用する(古い unchecked は unchecked に数えるが、レースは落とさない)", () => {
      const { chosen, excluded } = selectAllocationExportAnalyses([
        candidate({ id: 1, raceId: RACE_A, analyzedAt: "2026-07-04T00:00:00.000Z", startTime: null }),
        candidate({ id: 2, raceId: RACE_A, analyzedAt: BEFORE_START }),
      ]);
      expect(chosen.map((c) => c.id)).toEqual([2]);
      expect(excluded).toEqual({ suspect: 0, unknown: 0, unchecked: 1, uncheckedRaces: 0, superseded: 0, estimated: 0 });
    });

    it("analyzed_at が同じなら id の大きい方が最新(unchecked の方が大きければレースごと書き出さない)。ほかのレースには影響しない。遮断済みなら時刻に関係なく採用(unchecked にならない)", () => {
      const { chosen, excluded } = selectAllocationExportAnalyses([
        candidate({ id: 1, raceId: RACE_A, analyzedAt: BEFORE_START }),
        candidate({ id: 2, raceId: RACE_A, analyzedAt: BEFORE_START, startTime: null }),
        candidate({ id: 3, raceId: RACE_B, analyzedAt: AFTER_START, startTime: null, historyCutoffDate: "20260704", promptVersion: null }),
        candidate({ id: 4, raceId: RACE_C, analyzedAt: BEFORE_START }),
      ]);
      expect(chosen.map((c) => [c.id, c.leakClass])).toEqual([[3, "guarded"], [4, "pre_race"]]);
      expect(excluded).toEqual({ suspect: 0, unknown: 0, unchecked: 1, uncheckedRaces: 1, superseded: 1, estimated: 0 });
    });

    it("最新が unchecked のレースの古い分析が推定 EV の clean でも、そのレースは書き出さない(estimated には数えず superseded)", () => {
      const { chosen, excluded } = selectAllocationExportAnalyses([
        candidate({ id: 1, raceId: RACE_A, analyzedAt: "2026-07-04T00:00:00.000Z", evEstimated: 1 }),
        candidate({ id: 2, raceId: RACE_A, analyzedAt: BEFORE_START, startTime: null }),
      ]);
      expect(chosen).toEqual([]);
      expect(excluded).toEqual({ suspect: 0, unknown: 0, unchecked: 1, uncheckedRaces: 1, superseded: 1, estimated: 0 });
    });
  });

  it("結果は レースID の昇順。採用した分析の列を引き継ぐ(promptLookaheadGuarded は boolean | null)", () => {
    const { chosen } = selectAllocationExportAnalyses([
      candidate({ id: 5, raceId: RACE_C, analyzedAt: BEFORE_START, promptLookaheadGuarded: 1 }),
      candidate({ id: 6, raceId: RACE_A, analyzedAt: BEFORE_START }),
    ]);
    expect(chosen.map((c) => c.raceId)).toEqual([RACE_A, RACE_C]);
    expect(chosen[1]).toEqual({
      id: 5, raceId: RACE_C, analyzedAt: BEFORE_START, kaisaiDate: "20260705", promptVersion: "v9", detailKey: "analyses/5.json.gz", promptLookaheadGuarded: true, leakClass: "pre_race",
    });
    expect(chosen[0]!.promptLookaheadGuarded).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/** 18 頭・全 6 券種の組合せオッズ(三連単 4,896 通りを含む)。値は決定的な擬似乱数(同じ値の繰り返しで圧縮が実物より良くならないよう、桁を散らす)。 */
function bigCombos(field: number): Record<string, Record<string, number | null>> {
  let s = 12345;
  const rnd = (): number => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const odds = (lo: number, hi: number): number => Math.round(Math.exp(Math.log(lo) + rnd() * (Math.log(hi) - Math.log(lo))) * 10) / 10;
  const u = Array.from({ length: field }, (_, i) => i + 1);
  const pairs = (ordered: boolean): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const a of u) for (const b of u) if (a !== b && (ordered || a < b)) o[pad(a) + pad(b)] = odds(2, 800);
    return o;
  };
  const triples = (ordered: boolean): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const a of u) for (const b of u) for (const c of u) if (a !== b && b !== c && a !== c && (ordered || (a < b && b < c))) o[pad(a) + pad(b) + pad(c)] = odds(5, 9999);
    return o;
  };
  return { wideCombo: pairs(false), trioCombo: triples(false), quinellaCombo: pairs(false), exactaCombo: pairs(true), trifectaCombo: triples(true), bracketQuinellaCombo: { "0101": 5.5, "0102": null } };
}

function rawSnapshot(field: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    race: { raceName: "SECRET-RACENAME", courseType: "芝", distance: 1600, grade: "G3", oddsStatus: "result" },
    horses: Array.from({ length: field }, (_, k) => ({
      umaban: k + 1, wakuban: Math.min(8, Math.floor(k / 2) + 1), name: "SECRET-NAME", jockeyName: "SECRET-JOCKEY", trainerName: "SECRET-TRAINER",
      winOdds: 3.5 + k, popularity: k + 1, placeOddsMin: 1.5 + k / 10, placeOddsMax: 2.5 + k / 10, oikiriCritic: "SECRET-CRITIC",
    })),
    ...bigCombos(field),
    comboOdds: {
      wide: { state: "available", diagnostics: { conflictSamples: ["SECRET-DIAG"] } }, trio: { state: "unavailable" }, quinella: { state: "failed" },
      exacta: { state: "weird" }, trifecta: { state: "available" }, bracketQuinella: { state: "available" },
    },
    ...extra,
  };
}

describe("toAllocationSnapshot(R2 の詳細の raceSnapshot から、配分の再計算に要る分を取り出す)", () => {
  it("馬ごとのオッズ・枠番、レースの列、6 券種の組合せオッズ(キーの順序つき)、取得の状態を取り出す。診断の本体・名前は読まない", () => {
    const snap = toAllocationSnapshot(rawSnapshot(4));
    expect(snap.present).toBe(true);
    expect(snap.race).toEqual({ course_type: "芝", distance: 1600, grade: "G3" });
    expect([...snap.horses.keys()]).toEqual([1, 2, 3, 4]);
    expect(snap.horses.get(2)).toEqual({ wakuban: 1, win_odds: 4.5, ninki: 2, place_min: 1.6, place_max: 2.6 });
    expect(Object.keys(snap.combos).sort()).toEqual([...ALLOCATION_COMBO_KINDS].sort());
    // 馬単・三連単のキーは順序つき(逆順が別のキーとして残る)
    expect(Object.keys(snap.combos.exacta!)).toContain("0201");
    expect(Object.keys(snap.combos.exacta!)).toContain("0102");
    expect(Object.keys(snap.combos.trifecta!)).toContain("040302");
    // 取得の状態は 3 つの語だけ(それ以外の語・診断の本体は載せない)
    expect(snap.comboStates).toEqual({ wide: "available", trio: "unavailable", quinella: "failed", trifecta: "available", bracketQuinella: "available" });
    expect(JSON.stringify(snap.comboStates)).not.toMatch(/SECRET/);
  });

  it("組合せオッズの値の null は残す(未確定のセル)。値が数でも null でもない券種は、取得していない扱い(キー無し)。{} は取得したが空として残す", () => {
    const snap = toAllocationSnapshot(rawSnapshot(3, { wideCombo: { "0102": null, "0103": 4.4 }, trioCombo: { "010203": "x" }, quinellaCombo: {}, exactaCombo: [1, 2], trifectaCombo: undefined }));
    expect(snap.combos.wide).toEqual({ "0102": null, "0103": 4.4 });
    expect("trio" in snap.combos).toBe(false);
    expect(snap.combos.quinella).toEqual({});
    expect("exacta" in snap.combos).toBe(false);
    expect("trifecta" in snap.combos).toBe(false);
  });

  it("スナップショットが無い・壊れている・馬が読めない → present が false(全列 null・馬 0 頭・組合せ無し)。馬の型が違う列はその列だけ null", () => {
    for (const raw of [null, undefined, "x", 3, [], { race: {} }, { horses: [] }, { horses: [{ umaban: "1" }] }]) {
      const snap = toAllocationSnapshot(raw);
      expect(snap.present).toBe(false);
      expect(snap.horses.size).toBe(0);
      expect(snap.combos).toEqual({});
    }
    const snap = toAllocationSnapshot({ horses: [{ umaban: 1, wakuban: "3", winOdds: "9", popularity: 1.5, placeOddsMin: Number.NaN, placeOddsMax: 4 }, { umaban: 1, winOdds: 99 }] });
    expect(snap.present).toBe(true);
    expect(snap.horses.get(1)).toEqual({ wakuban: null, win_odds: null, ninki: null, place_min: null, place_max: 4 }); // 馬番が重複したら最初の 1 頭
  });
});

// ---------------------------------------------------------------------------

const CHOSEN: ChosenAllocationAnalysis = {
  id: 7, raceId: RACE_A, analyzedAt: BEFORE_START, kaisaiDate: "20260705", promptVersion: "v9", detailKey: "analyses/7.json.gz", promptLookaheadGuarded: true, leakClass: "guarded",
};

const META: AllocationMetaInput = {
  route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: "present", comboOddsTrio: "present",
  bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1.05, includeComboOdds: 1, includeWide: 1, includeTrio: 0,
  includeQuinella: null, includeExacta: 0, includeTrifecta: 1, includeBracketQuinella: null, betUnit: 100, greedySteps: 1000, candidateCap: 2000,
  modelId: "plackett-luce", modelApproximate: 0, oddsStatus: "result", minHitProb: null, belowFloorCount: 3, maxWinBets: 2, maxPlaceBets: null,
  missedJson: JSON.stringify([{ bet_type: "trifecta", combo_key: "010203", hit_prob: 0.001, odds: 900, ev: 1.2, would_stake: 100, reason: "SECRET-MISSED", extra: { a: 1 } }, "x", { bet_type: { a: 1 } }]),
};

function rowInput(over: Partial<BuildAllocationRowInput> = {}): BuildAllocationRowInput {
  return {
    analysis: CHOSEN,
    horses: [
      { umaban: 2, prior: 0.3, adjustedProb: 0.31, placeOddsMin: null, ev: null },
      { umaban: 1, prior: 0.4, adjustedProb: 0.41, placeOddsMin: 1.6, ev: 1.1 },
    ],
    snapshot: toAllocationSnapshot(rawSnapshot(2)),
    meta: META,
    bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 1.6, ev: 1.1 }, { betType: "trifecta", comboKey: "020103", stake: 100, odds: 55.5, ev: 1.2 }],
    results: [
      { umaban: 2, finishPosition: null, placePayout: null, winPayout: null, scratched: 1, wakuban: 1, winOdds: null, ninki: null },
      { umaban: 1, finishPosition: 1, placePayout: 130, winPayout: 250, scratched: 0, wakuban: 1, winOdds: 2.5, ninki: 1 },
    ],
    payouts: [{ betType: "exacta", comboKey: "0102", payout: 1200 }, { betType: "exacta", comboKey: "0201", payout: 3400 }, { betType: "wide", comboKey: "0102", payout: 180 }],
    imports: ["exacta", "trifecta", "wide"],
    ...over,
  };
}

const keysOf = (o: object): string[] => Object.keys(o);

describe("buildAllocationRaceRow(1 行 1 レース。列は許可リストと完全一致)", () => {
  const row = buildAllocationRaceRow(rowInput());

  it("すべての階層の列が許可リストと完全一致し、順序も同じ(余計な列・足りない列が無い)", () => {
    expect(keysOf(row)).toEqual([...ALLOCATION_ROW_KEYS]);
    expect(keysOf(row.horses[0]!)).toEqual([...ALLOCATION_HORSE_KEYS]);
    expect(keysOf(row.allocation!)).toEqual([...ALLOCATION_ALLOCATION_KEYS]);
    expect(keysOf(row.allocation!.settings)).toEqual([...ALLOCATION_SETTINGS_KEYS]);
    expect(keysOf(row.allocation!.codes)).toEqual([...ALLOCATION_CODES_KEYS]);
    expect(keysOf(row.allocation!.bets[0]!)).toEqual([...ALLOCATION_BET_KEYS]);
    expect(keysOf(row.allocation!.missed![0]!)).toEqual([...ALLOCATION_MISSED_KEYS]);
    expect(keysOf(row.result)).toEqual([...ALLOCATION_RESULT_KEYS]);
    expect(keysOf(row.result.horses[0]!)).toEqual([...ALLOCATION_RESULT_HORSE_KEYS]);
  });

  it("馬は馬番の昇順。分析時点のオッズと枠番はスナップショットから、保存済みの複勝下限・EV は D1 から(取り違えない)", () => {
    expect(row.horses.map((h) => h.umaban)).toEqual([1, 2]);
    expect(row.horses[0]).toEqual({ umaban: 1, wakuban: 1, prior: 0.4, adjusted_prob: 0.41, win_odds: 3.5, ninki: 1, place_min: 1.5, place_max: 2.5, place_odds_min: 1.6, ev: 1.1 });
    expect(row.horses[1]).toEqual({ umaban: 2, wakuban: 1, prior: 0.3, adjusted_prob: 0.31, win_odds: 4.5, ninki: 2, place_min: 1.6, place_max: 2.6, place_odds_min: null, ev: null });
    expect(row.field_size).toBe(2);
    expect(row.has_odds).toBe(true);
  });

  it("識別・レースの列。開催日が NULL の地方は race_id から補う", () => {
    expect(row).toMatchObject({
      analysis_id: 7, race_id: RACE_A, kaisai_date: "20260705", venue_kind: "central", analyzed_at: BEFORE_START, prompt_version: "v9",
      prompt_lookahead_guarded: true, leak_class: "guarded", course_type: "芝", distance: 1600, grade: "G3",
    });
    const nar = buildAllocationRaceRow(rowInput({ analysis: { ...CHOSEN, raceId: "202644101501", kaisaiDate: null } }));
    expect(nar.venue_kind).toBe("nar");
    expect(nar.kaisai_date).toBe("20261015");
  });

  it("設定と配分のコードは meta の値のまま。D1 の NULL は NULL のまま(0/1 は boolean)で、旧い行の列を OFF や 0 に補わない", () => {
    expect(row.allocation!.settings).toEqual({
      bankroll: 10000, per_race_cap: 3000, kelly_fraction: 0.25, ev_threshold: 1.05, include_combo_odds: true, include_wide: true, include_trio: false,
      include_quinella: null, include_exacta: false, include_trifecta: true, include_bracket_quinella: null, min_hit_prob: null, max_win_bets: 2, max_place_bets: null,
    });
    expect(row.allocation!.codes).toEqual({
      route: "mixed", unavailable_reason: null, fallback_reason: null, skip_reason_code: null, combo_odds_wide: "present", combo_odds_trio: "present",
      bet_unit: 100, greedy_steps: 1000, candidate_cap: 2000, model_id: "plackett-luce", model_approximate: false, below_floor_count: 3,
    });
    expect(row.allocation!.odds_status).toBe("result");
  });

  it("提案した買い目は D1 の並びのまま。馬単・三連単のキーは順序つきのまま(1 桁目が 1 着)", () => {
    expect(row.allocation!.bets).toEqual([
      { bet_type: "place", combo_key: "01", stake: 300, odds: 1.6, ev: 1.1 },
      { bet_type: "trifecta", combo_key: "020103", stake: 100, odds: 55.5, ev: 1.2 },
    ]);
  });

  it("外した買い目(missed_json)は許可リストの 6 キーだけを写す(余計なキー・自由文は落とす)。壊れた JSON・配列でない JSON・NULL は null、'[]' は空配列", () => {
    expect(row.allocation!.missed).toEqual([
      { bet_type: "trifecta", combo_key: "010203", hit_prob: 0.001, odds: 900, ev: 1.2, would_stake: 100 },
      { bet_type: null, combo_key: null, hit_prob: null, odds: null, ev: null, would_stake: null }, // 値の型が違う要素は全列 null(文字列の要素は読み飛ばす)
    ]);
    const missedOf = (missedJson: string | null) => buildAllocationRaceRow(rowInput({ meta: { ...META, missedJson } })).allocation!.missed;
    expect(missedOf(null)).toBeNull();
    expect(missedOf("{broken")).toBeNull();
    expect(missedOf('{"a":1}')).toBeNull();
    expect(missedOf("[]")).toEqual([]);
  });

  it("組合せオッズは券種ごとにスナップショットのまま(キーが無い券種は載せない)。取得の状態も載る", () => {
    expect(Object.keys(row.combos).sort()).toEqual([...ALLOCATION_COMBO_KINDS].sort());
    expect(row.combos["bracketQuinella"]).toEqual({ "0101": 5.5, "0102": null });
    expect(row.combo_states).toEqual({ wide: "available", trio: "unavailable", quinella: "failed", trifecta: "available", bracketQuinella: "available" });
    const partial = buildAllocationRaceRow(rowInput({ snapshot: toAllocationSnapshot(rawSnapshot(2, { trioCombo: undefined, comboOdds: undefined })) }));
    expect("trio" in partial.combos).toBe(false);
    expect(partial.combo_states).toEqual({});
  });

  it("結果: 馬ごとの着順・取消(1 → true、0 → false、NULL → null)・払戻と、券種ごとの確定払戻(D1 の並び)・取込印", () => {
    expect(row.result.horses).toEqual([
      { umaban: 1, finish_position: 1, scratched: false, wakuban: 1, place_payout: 130, win_payout: 250, win_odds: 2.5, ninki: 1 },
      { umaban: 2, finish_position: null, scratched: true, wakuban: 1, place_payout: null, win_payout: null, win_odds: null, ninki: null },
    ]);
    expect(row.result.combo_payouts).toEqual({ exacta: [["0102", 1200], ["0201", 3400]], wide: [["0102", 180]] });
    expect(row.result.payout_imports).toEqual(["exacta", "trifecta", "wide"]); // trifecta は取込済みで 0 件(combo_payouts にキーが無い)
    const unknown = buildAllocationRaceRow(rowInput({ results: [{ umaban: 1, finishPosition: 3, placePayout: null, winPayout: null, scratched: null, wakuban: null, winOdds: null, ninki: null }] }));
    expect(unknown.result.horses[0]!.scratched).toBeNull();
  });

  it("詳細が無い(snapshot が null)・読めない(present が false) → has_odds が false で、馬のオッズ・組合せ・レースの列は空。配分の記録・結果は残る", () => {
    for (const snapshot of [null, toAllocationSnapshot(null)]) {
      const r = buildAllocationRaceRow(rowInput({ snapshot }));
      expect(r.has_odds).toBe(false);
      expect(r.horses.every((h) => h.win_odds === null && h.wakuban === null && h.place_min === null)).toBe(true);
      expect(r.combos).toEqual({});
      expect(r.combo_states).toEqual({});
      expect([r.course_type, r.distance, r.grade]).toEqual([null, null, null]);
      expect(r.allocation).not.toBeNull();
      expect(r.horses[0]!.adjusted_prob).toBe(0.41);
    }
  });

  it("配分のメタ行が無い分析は allocation が null(買い目も載せない)", () => {
    const r = buildAllocationRaceRow(rowInput({ meta: null, bets: [] }));
    expect(r.allocation).toBeNull();
  });

  it("秘匿: スナップショットの馬名・騎手名・調教師名・調教の短評・レース名・診断、missed の自由文は、行の JSON のどこにも現れない", () => {
    const text = JSON.stringify(row);
    expect(text).not.toMatch(/SECRET/);
    const noOdds = JSON.stringify(buildAllocationRaceRow(rowInput({ snapshot: null })));
    expect(noOdds).not.toMatch(/SECRET/);
  });

  it("JSON を経由しても同じ(NaN・Infinity・undefined が混ざらない)", () => {
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });
});

// ---------------------------------------------------------------------------

describe("塊とメタ行(gzip のメンバーの連結)", () => {
  it("塊の大きさの上界: 18 頭・全 6 券種(三連単 4,896 通り)のレース 10 件(1 tick ぶん)を gzip した塊が 1 MiB 未満(DO の SQLite の 1 行の上限は約 2MB。余裕を半分以上残す)", () => {
    const rows: AllocationRaceRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      const horses = Array.from({ length: 18 }, (_, k) => ({ umaban: k + 1, prior: 0.2 + k / 1000, adjustedProb: 0.21 + k / 1000, placeOddsMin: 1.5 + k / 10, ev: 1 + k / 100 }));
      rows.push(buildAllocationRaceRow(rowInput({ analysis: { ...CHOSEN, id: i + 1 }, horses, snapshot: toAllocationSnapshot(rawSnapshot(18)) })));
    }
    // 前提: 本当に最悪の構成になっている(三連単が 18P3 = 4,896 キー)
    expect(Object.keys(rows[0]!.combos["trifecta"]!)).toHaveLength(4896);
    expect(rows.every((r) => r.horses.length === 18)).toBe(true);
    const chunk = encodeAllocationChunk(rows);
    expect(chunk.length).toBeLessThan(1024 * 1024);
    // 読み戻せる(1 行 1 レース。末尾改行)
    const lines = new TextDecoder().decode(gunzipSync(chunk)).split("\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(10);
    expect(JSON.parse(lines[3]!)).toEqual(JSON.parse(JSON.stringify(rows[3])));
  });

  it("メタ行: 形式・件数・除外の内訳・列・注記。行の列は ALLOCATION_ROW_KEYS", () => {
    const excluded = { suspect: 1, unknown: 2, unchecked: 3, uncheckedRaces: 6, superseded: 4, estimated: 5 };
    const head = JSON.parse(new TextDecoder().decode(gunzipSync(buildAllocationHead({ generatedAt: "2026-10-26T03:00:00.000Z", rows: 9, races: 9, missingOdds: 2, noAllocation: 1, excluded })))) as {
      _meta: Record<string, unknown>;
    };
    expect(head._meta["format"]).toBe(ALLOCATION_EXPORT_FORMAT);
    expect(head._meta).toMatchObject({ generatedAt: "2026-10-26T03:00:00.000Z", rows: 9, races: 9, missingOdds: 2, noAllocation: 1, excluded, columns: [...ALLOCATION_ROW_KEYS] });
    expect((head._meta["notes"] as string[]).length).toBeGreaterThan(0);
  });

  it("メタ行の注記は、has_odds が false になる 4 つの原因を書いている。4 つの原因のどれでも has_odds が false になる(注記と挙動が食い違わない)", () => {
    const head = JSON.parse(new TextDecoder().decode(gunzipSync(buildAllocationHead({ generatedAt: "2026-10-26T03:00:00.000Z", rows: 0, races: 0, missingOdds: 0, noAllocation: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, uncheckedRaces: 0, superseded: 0, estimated: 0 } })))) as {
      _meta: { notes: string[] };
    };
    const notes = head._meta.notes.filter((n) => n.startsWith("has_odds が false"));
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    // 原因: (1) detail_key が NULL (2) R2 に詳細が無い・壊れている (3) 詳細の race_id が別のレース (4) スナップショットが無い・壊れている・馬を 1 頭も読めない
    for (const phrase of ["detail_key", "R2 に詳細が無い", "別のレース", "raceSnapshot", "1 頭も"]) {
      expect(note, phrase).toContain(phrase);
    }
    // 取得そのものの失敗は has_odds が false にならず、作成を再試行する(store の failed → core の recordFailure)
    expect(note).toContain("再試行");
    // 挙動: (1)〜(3) は store が none を返し、行の入力では snapshot が null。(4) は present が false
    const noHorses = toAllocationSnapshot({ race: { courseType: "芝" }, horses: [], wideCombo: { "0102": 8 } });
    const noRecord = toAllocationSnapshot("壊れた値");
    for (const [name, snapshot] of [["詳細なし(1〜3)", null], ["馬が 1 頭も読めない", noHorses], ["スナップショットが壊れている", noRecord]] as const) {
      expect(buildAllocationRaceRow(rowInput({ snapshot })).has_odds, name).toBe(false);
    }
    expect(noHorses.present).toBe(false); // 前提: 組合せのオッズが読めても、馬が無ければ present は false
    expect(Object.keys(noHorses.combos)).toEqual(["wide"]);
    expect(buildAllocationRaceRow(rowInput({ snapshot: toAllocationSnapshot({ race: {}, horses: [{ umaban: 1, winOdds: 3 }] }) })).has_odds).toBe(true); // 対照: 馬が 1 頭読めれば true
  });

  it("連結した gzip は 1 回の gunzip で全体を読める(メタ行 → 塊)", () => {
    const head = buildAllocationHead({ generatedAt: "2026-10-26T03:00:00.000Z", rows: 1, races: 1, missingOdds: 0, noAllocation: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, uncheckedRaces: 0, superseded: 0, estimated: 0 } });
    const chunk = encodeAllocationChunk([buildAllocationRaceRow(rowInput())]);
    const all = Buffer.concat([head, chunk]);
    const lines = gunzipSync(all).toString("utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(Object.keys(JSON.parse(lines[0]!))).toEqual(["_meta"]);
    expect(Object.keys(JSON.parse(lines[1]!))).toEqual([...ALLOCATION_ROW_KEYS]);
  });

  it("ファイル名は JST の日時", () => {
    expect(allocationExportFilename("2026-10-26T03:05:00.000Z")).toBe("allocation-dataset-20261026-1205.ndjson.gz");
  });
});
