/**
 * 結果の保存(saveResult)の golden の入力側(Issue #207〈#182-A〉AC-A3)。
 *
 * 目的: クラウド版の `D1ResultStore`(cloud/src/result-repository.ts)が、exe の `AnalysisStore.saveResult` と**同じ入力から同じ4表を作る**ことを固定する。
 * 各シナリオ(入力の `steps`。同じレースへの再保存を含む)を、新しい空の `AnalysisStore` に順に保存し、4表のダンプ(race_results・race_result_meta・
 * race_combo_payouts・race_combo_payout_imports。主キー順)と、`getRaceResultDetail` の復元結果を取る。それが golden JSON(`race-result-contract.json`)で、
 * cloud 側のテストが同じ入力から D1 で同じダンプ・復元結果になることを確かめる。生成手順は `scripts/gen-race-result-contract.ts`
 * (`pnpm tsx scripts/gen-race-result-contract.ts`)。検証は `test/ev/race-result-contract.test.ts`(exe 側)と cloud/test/result-repository.test.ts(D1 側)。
 *
 * 入力はリポジトリ内のフィクスチャ(`fixtures/`)と固定の合成値だけ(実ネットワークには触れない)。入力は JSON を一度往復させてから exe に渡す
 * (cloud 側が JSON から読んだ入力と、完全に同じ値にするため。undefined のキーは消える)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AnalysisStore } from "../../src/ev/analysis-store.js";
import type { RaceComboPayoutsSaveInput, RaceResultDetail, RaceResultEntry } from "../../src/ev/analysis-store-types.js";
import { toResultEntries } from "../../src/ev/result-import.js";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import type { CourseType } from "../../src/scraper/types.js";

/** 1回の saveResult の入力。 */
export interface ContractStep {
  readonly raceId: string;
  readonly entries: RaceResultEntry[];
  /** 省略・null は「面を書かない」。 */
  readonly courseType?: CourseType | null;
  /** 省略は「組合せ払戻に触れない」。 */
  readonly comboPayouts?: RaceComboPayoutsSaveInput;
}

export interface RaceResultsRow {
  readonly race_id: string;
  readonly umaban: number;
  readonly finish_position: number | null;
  readonly place_payout: number | null;
  readonly win_payout: number | null;
  readonly passing_json: string | null;
  readonly last3f: number | null;
}
export interface RaceResultMetaRow {
  readonly race_id: string;
  readonly course_type: string | null;
}
export interface RaceComboPayoutsRow {
  readonly race_id: string;
  readonly bet_type: string;
  readonly combo_key: string;
  readonly payout: number;
}
export interface RaceComboPayoutImportsRow {
  readonly race_id: string;
  readonly bet_type: string;
}

/** 4表のダンプ(主キー順)。 */
export interface ResultTablesDump {
  readonly race_results: RaceResultsRow[];
  readonly race_result_meta: RaceResultMetaRow[];
  readonly race_combo_payouts: RaceComboPayoutsRow[];
  readonly race_combo_payout_imports: RaceComboPayoutImportsRow[];
}

export interface ContractCase {
  readonly name: string;
  /** saveResult を使わず、表へ直接入れる行(防御的復元の検査用。壊れた値を saveResult 経由では作れないため)。 */
  readonly raw?: Pick<ResultTablesDump, "race_results" | "race_result_meta">;
  readonly steps: ContractStep[];
  /** 全 steps(と raw)の後のダンプ。 */
  readonly expected: ResultTablesDump;
  /** 復元を確かめるレースID(存在しないレースを1つ含む)。値は exe の `getRaceResultDetail(id) ?? null`。 */
  readonly expectedDetails: Record<string, RaceResultDetail | null>;
}

export interface RaceResultContract {
  readonly cases: ContractCase[];
}

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf-8");
}

/** 実フィクスチャのパース結果から、実際の取込と同じ入力(toResultEntries・面・全券種の払戻)を作る。 */
function stepFromFixture(raceId: string, fixture: string): ContractStep {
  const result = parseRaceResult(loadFixture(fixture));
  return {
    raceId,
    entries: toResultEntries(result),
    courseType: result.courseType ?? null,
    comboPayouts: {
      wide: result.widePayouts,
      trio: result.trioPayouts,
      quinella: result.quinellaPayouts,
      exacta: result.exactaPayouts,
      trifecta: result.trifectaPayouts,
      bracketQuinella: result.bracketQuinellaPayouts,
    } as RaceComboPayoutsSaveInput,
  };
}

const UNDETERMINED = {
  state: "undetermined",
  reason: { kind: "payoutTableAbsent", message: "払戻テーブルがありません", observedGroupCount: null, observedPayoutCount: null, rawHtml: null },
} as const;

/** 18頭立ての合成入力(1着同着・取消〈着順 null〉・0 と小数の混在・省略項目を含む)。 */
function synthetic18Step(): ContractStep {
  // 着順の並び: 7番と11番が1着同着、以下 3→3着、14→4着 …(17着まで)。18番は着順なし(取消・中止)。
  const order = [7, 11, 3, 14, 1, 9, 2, 16, 5, 12, 4, 8, 15, 6, 17, 10, 13];
  const rankOf = new Map<number, number>(order.map((u, i) => [u, i === 0 || i === 1 ? 1 : i + 1]));
  const entries: RaceResultEntry[] = Array.from({ length: 18 }, (_, i) => {
    const umaban = i + 1;
    const rank = rankOf.get(umaban) ?? null;
    const base: RaceResultEntry = { umaban, finishPosition: rank };
    switch (umaban) {
      case 7:
        return { ...base, placePayout: 150, winPayout: 620, passing: [2, 2, 1, 1], last3f: 33.7 };
      case 11:
        return { ...base, placePayout: 210, winPayout: 620, passing: [5, 5, 3, 2], last3f: 33.9 };
      case 3:
        return { ...base, placePayout: 340, winPayout: null, passing: [9, 9, 8, 6], last3f: 0 };
      case 14:
        return { ...base, passing: [], last3f: 34.5 };
      case 18:
        return { ...base, passing: [], last3f: null };
      default:
        // 省略(undefined)の項目: 払戻・通過順・上がり3F を渡さない
        return umaban % 2 === 0 ? base : { ...base, passing: [10, 11], last3f: 35.1 };
    }
  });
  return {
    raceId: "202654071210",
    entries,
    courseType: "ダ",
    comboPayouts: {
      wide: { state: "parsed", payouts: [{ umabans: [7, 11], payout: 450 }, { umabans: [3, 7], payout: 780 }, { umabans: [3, 11], payout: 1230 }] },
      trio: { state: "parsed", payouts: [{ umabans: [3, 7, 11], payout: 25530 }] },
      quinella: { state: "parsed", payouts: [{ umabans: [7, 11], payout: 1320 }] },
      // 1着同着の馬単・三連単は、逆順の2組がどちらも的中(キーが別になる)
      exacta: { state: "parsed", payouts: [{ umabans: [7, 11], payout: 2840 }, { umabans: [11, 7], payout: 2840 }] },
      trifecta: { state: "parsed", payouts: [{ umabans: [7, 11, 3], payout: 39210 }, { umabans: [11, 7, 3], payout: 39210 }] },
      // 枠連は馬番ではなく枠番(同枠 8-8 を含む)
      bracketQuinella: { state: "parsed", payouts: [{ umabans: [4, 6], payout: 910 }, { umabans: [8, 8], payout: 7740 }] },
    },
  };
}

/** 直接入れる行(防御的復元): 壊れた通過順・未知の面・面だけで結果の無いレース。 */
function defensiveRaw(): NonNullable<ContractCase["raw"]> {
  const row = (race_id: string, umaban: number, finish: number | null, passing: string | null, last3f: number | null): RaceResultsRow => ({
    race_id,
    umaban,
    finish_position: finish,
    place_payout: null,
    win_payout: null,
    passing_json: passing,
    last3f,
  });
  return {
    race_results: [
      row("202603020299", 1, 1, "[1,2]", 35.1),
      row("202603020299", 2, 2, "broken", 34.8),
      row("202603020299", 3, 3, null, null),
      row("202603020299", 4, 4, '["a"]', 0),
      row("202603020299", 5, null, '[1,"2"]', null),
      row("202603020298", 1, 1, "[3,3]", 36.2),
    ],
    race_result_meta: [
      { race_id: "202603020299", course_type: "turf" }, // 未知の文字列 → 面不明(null)
      { race_id: "202603020298", course_type: "ダ" },
      { race_id: "202603020297", course_type: "芝" }, // 面だけで結果の行が無い → 結果なし(null)
    ],
  };
}

const DUMP_SQL = {
  race_results:
    "SELECT race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f FROM race_results ORDER BY race_id, umaban",
  race_result_meta: "SELECT race_id, course_type FROM race_result_meta ORDER BY race_id",
  race_combo_payouts: "SELECT race_id, bet_type, combo_key, payout FROM race_combo_payouts ORDER BY race_id, bet_type, combo_key",
  race_combo_payout_imports: "SELECT race_id, bet_type FROM race_combo_payout_imports ORDER BY race_id, bet_type",
} as const;

/** 各ケースの入力(名前・steps・raw・復元を確かめるレースID)。 */
function scenarioInputs(): Array<{ name: string; raw?: ContractCase["raw"]; steps: ContractStep[]; probeIds: string[] }> {
  const resave: ContractStep[] = [
    {
      raceId: "202603020211",
      entries: [
        { umaban: 1, finishPosition: 2, placePayout: 120, winPayout: null, passing: [1, 1], last3f: 34.0 },
        { umaban: 2, finishPosition: 1, placePayout: 140, winPayout: 410, passing: [2, 2], last3f: 33.8 },
        { umaban: 3, finishPosition: 3, placePayout: 180, passing: [3, 3], last3f: 34.4 },
        { umaban: 4, finishPosition: 4 },
        { umaban: 5, finishPosition: null },
      ],
      courseType: "芝",
      comboPayouts: {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }, { umabans: [1, 3], payout: 500 }, { umabans: [2, 3], payout: 700 }] },
        trio: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 2100 }] },
        quinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 650 }, { umabans: [1, 3], payout: 900 }] },
      },
    },
    {
      raceId: "202603020212",
      entries: [
        { umaban: 1, finishPosition: 1, placePayout: 110, winPayout: 150, passing: [1], last3f: 36.0 },
        { umaban: 2, finishPosition: 2, placePayout: 130 },
      ],
      courseType: "ダ",
      comboPayouts: { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 240 }, { umabans: [2, 3], payout: 410 }] } },
    },
    // 同じレースの再保存: 馬は上書き(2回目に無い馬4・5は据え置き)・面は上書き・wide は払戻0件(行を消してマーカーのみ)・
    // trio は undetermined(据え置き)・quinella は行が減る(2→1。delete-then-insert)・exacta は新規・別レース(…12)は無傷。
    {
      raceId: "202603020211",
      entries: [
        { umaban: 1, finishPosition: 1, placePayout: 125, winPayout: 380, passing: [1, 1, 1], last3f: 34.1 },
        { umaban: 2, finishPosition: 2, placePayout: 145, passing: [2, 3], last3f: 33.9 },
        { umaban: 3, finishPosition: 3 },
      ],
      courseType: "ダ",
      comboPayouts: {
        wide: { state: "parsed", payouts: [] },
        trio: UNDETERMINED,
        quinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 660 }] },
        exacta: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 1300 }] },
      },
    },
  ];
  return [
    { name: "central-fixture-16-heads", steps: [stepFromFixture("202603020211", "result_202603020211.html")], probeIds: ["202603020211", "202603020210"] },
    { name: "nar-fixture", steps: [stepFromFixture("202654071210", "nar_result_202654071210.html")], probeIds: ["202654071210", "202654071209"] },
    { name: "synthetic-18-heads-all-bet-types", steps: [synthetic18Step()], probeIds: ["202654071210", "202654071211"] },
    {
      name: "all-finish-null-no-meta-no-combo",
      // 全頭が中止・除外のレース(行はあるが着順が全て NULL)。面・組合せ払戻は渡さない。
      steps: [{ raceId: "202603020214", entries: [{ umaban: 1, finishPosition: null }, { umaban: 2, finishPosition: null, passing: [], last3f: null }] }],
      probeIds: ["202603020214", "202603020215"],
    },
    { name: "resave-delete-then-insert-undetermined-keeps", steps: resave, probeIds: ["202603020211", "202603020212", "202603020213"] },
    {
      name: "undetermined-only",
      steps: [
        {
          raceId: "202603020213",
          entries: [{ umaban: 1, finishPosition: 1, placePayout: 100, winPayout: 200 }, { umaban: 2, finishPosition: 2 }],
          courseType: "障",
          comboPayouts: { wide: UNDETERMINED, trio: UNDETERMINED, exacta: UNDETERMINED },
        },
      ],
      probeIds: ["202603020213", "202603020216"],
    },
    {
      name: "defensive-restore",
      raw: defensiveRaw(),
      steps: [],
      probeIds: ["202603020299", "202603020298", "202603020297", "202603020296"],
    },
  ];
}

/** 全シナリオを exe の `AnalysisStore` で実行し、golden を作る(決定的。時刻・乱数なし)。 */
export function computeRaceResultContract(): RaceResultContract {
  const cases: ContractCase[] = scenarioInputs().map((input) => {
    // JSON を往復させた入力を exe に渡す(cloud 側が golden から読む入力と同じ値にする)。
    const steps = JSON.parse(JSON.stringify(input.steps)) as ContractStep[];
    const raw = input.raw === undefined ? undefined : (JSON.parse(JSON.stringify(input.raw)) as NonNullable<ContractCase["raw"]>);
    const store = new AnalysisStore();
    try {
      const db = store.rawDatabase;
      if (raw !== undefined) {
        const insertResult = db.prepare(
          "INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        for (const r of raw.race_results) {
          insertResult.run(r.race_id, r.umaban, r.finish_position, r.place_payout, r.win_payout, r.passing_json, r.last3f);
        }
        const insertMeta = db.prepare("INSERT INTO race_result_meta (race_id, course_type) VALUES (?, ?)");
        for (const m of raw.race_result_meta) {
          insertMeta.run(m.race_id, m.course_type);
        }
      }
      for (const s of steps) {
        store.saveResult(s.raceId, s.entries, s.courseType, s.comboPayouts);
      }
      const expected: ResultTablesDump = {
        race_results: db.prepare(DUMP_SQL.race_results).all() as RaceResultsRow[],
        race_result_meta: db.prepare(DUMP_SQL.race_result_meta).all() as RaceResultMetaRow[],
        race_combo_payouts: db.prepare(DUMP_SQL.race_combo_payouts).all() as RaceComboPayoutsRow[],
        race_combo_payout_imports: db.prepare(DUMP_SQL.race_combo_payout_imports).all() as RaceComboPayoutImportsRow[],
      };
      const expectedDetails: Record<string, RaceResultDetail | null> = {};
      for (const id of input.probeIds) {
        expectedDetails[id] = store.getRaceResultDetail(id) ?? null;
      }
      return { name: input.name, ...(raw === undefined ? {} : { raw }), steps, expected, expectedDetails };
    } finally {
      store.close();
    }
  });
  // 書き出す JSON と同じ値(undefined のキーを持たない)にそろえて返す。
  return JSON.parse(JSON.stringify({ cases })) as RaceResultContract;
}
