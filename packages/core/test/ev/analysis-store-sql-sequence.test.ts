import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AnalysisStore, type AnalysisRecord } from "../../src/ev/analysis-store.js";

/**
 * Issue #168(#163-a)AC-a7: exe の保存・取得が発行する SQL 文の列を固定する(特性化テスト)。
 *
 * 目的: 型・変換ロジックを別ファイル(analysis-store-codec.ts)へ切り出しても、exe(better-sqlite3)が
 * 「同じ文を、同じ回数、同じ順序、同じ値で」発行することを保証する。**exe の性能を変えない**ことの証拠。
 * たとえば切り出しの結果、(1)文が増える(行ごとの prepare・余分な SELECT)、(2)順序が変わる、
 * (3)値の写し(0/1・NULL・JSON 化)が変わる、のいずれかが起きれば、この列が食い違って落ちる。
 *
 * 期待値は **切り出し前の実装で実測した列**(better-sqlite3 の `verbose` が返す、束縛値を埋め込んだ実行時の SQL。
 * 空白は1つに畳む)。再現手順: `new Database(":memory:", { verbose })` を `AnalysisStore({ database })` に渡し、
 * 下の入力で saveAnalysis・listAnalyses を呼んで `verbose` の引数を集める。切り出し前後で同じ値であること自体が検査の中身で、
 * このテストは切り出し前の実装に対しても全緑だった(Red を持たない特性化テスト)。
 *
 * 数値は REAL として束縛されるため `1.0` と表示される(better-sqlite3 は JS の number を REAL で束縛する)。
 */

const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** verbose を注入した in-memory の DB と、実行された SQL を集める関数。ストア構築(スキーマ作成)の SQL は集めない。 */
function createRecordingStore(): {
  store: AnalysisStore;
  take: () => string[];
  takePrepares: () => string[];
} {
  const log: string[] = [];
  const prepares: string[] = [];
  let recording = false;
  const db = new Database(":memory:", {
    verbose: (sql?: unknown) => {
      if (recording) {
        log.push(normalize(String(sql)));
      }
    },
  });
  // prepare の呼び出し(SQL の文字列)も記録する。verbose は「実行」しか拾わないので、行ごとの prepare し直し
  // (実行列は同じでも、性能が落ちる変更)はこちらで検出する。
  const originalPrepare = db.prepare.bind(db) as (sql: string) => unknown;
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (recording) {
      prepares.push(normalize(sql));
    }
    return originalPrepare(sql);
  };
  const store = new AnalysisStore({ database: db });
  recording = true;
  return {
    store,
    take: () => log.splice(0, log.length),
    takePrepares: () => prepares.splice(0, prepares.length),
  };
}

const FULL_RECORD: AnalysisRecord = {
  raceId: "202603020211",
  analyzedAt: "2026-10-06T09:00:00.000Z",
  horses: [
    {
      umaban: 1,
      prior: 0.1234567890123,
      adjustedProb: 0.2,
      placeOddsMin: 1.5,
      ev: 1.1,
      isPositive: true,
      contributions: { a: 1 },
      mark: "◎",
      reason: "根拠",
    },
    {
      umaban: 2,
      prior: 0.3,
      adjustedProb: 0.3,
      placeOddsMin: null,
      ev: null,
      isPositive: false,
      contributions: null,
      mark: null,
    },
  ],
  raceSnapshot: { x: 1 },
  allocation: {
    meta: {
      route: "mixed",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      bankroll: 10000,
      perRaceCap: 3000,
      kellyFraction: 0.25,
      evThreshold: 1,
      // 7つの真偽値フラグは、FLAG_CODES の番号の bit0(0,1,0,1,0,1,0)。bit1・bit2 は別の2入力で保存する(下の describe)。
      includeComboOdds: false,
      includeWide: true,
      includeTrio: false,
      includeQuinella: true,
      includeExacta: false,
      includeTrifecta: true,
      includeBracketQuinella: false,
      betUnit: 100,
      greedySteps: 5,
      candidateCap: 50,
      modelId: "m",
      modelApproximate: null,
      oddsStatus: "kakutei",
    },
    bets: [
      { betType: "place", comboKey: "01", stake: 300, odds: 1.5, ev: 1.1 },
      { betType: "wide", comboKey: "0102", stake: 100, odds: null, ev: null },
    ],
  },
};

const MINIMAL_RECORD: AnalysisRecord = {
  raceId: "202654071210",
  analyzedAt: "2026-10-06T10:00:00.000Z",
  horses: [
    {
      umaban: 3,
      prior: 0.5,
      adjustedProb: 0.5,
      placeOddsMin: null,
      ev: null,
      isPositive: false,
      contributions: undefined,
      mark: null,
    },
  ],
};

const INSERT_ANALYSES =
  "INSERT INTO analyses (race_id, analyzed_at, ev_estimated, prompt_version, additional_instruction, kaisai_date, model, raw_response, race_snapshot_json, history_cutoff_date, prompt_lookahead_guarded) VALUES";
const INSERT_HORSE =
  "INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark, reason) VALUES";
const INSERT_META =
  "INSERT INTO analysis_allocation_meta (analysis_id, route, unavailable_reason, fallback_reason, skip_reason_code, combo_odds_wide, combo_odds_trio, bankroll, per_race_cap, kelly_fraction, ev_threshold, include_combo_odds, include_wide, include_trio, include_quinella, include_exacta, include_trifecta, include_bracket_quinella, bet_unit, greedy_steps, candidate_cap, model_id, model_approximate, odds_status) VALUES";
const INSERT_BET =
  "INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake, odds, ev) VALUES";
const SELECT_ANALYSES_HEAD =
  "SELECT id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated, prompt_version AS promptVersion, additional_instruction AS additionalInstruction, kaisai_date AS kaisaiDate, model, raw_response AS rawResponse, race_snapshot_json AS raceSnapshotJson, history_cutoff_date AS historyCutoffDate, prompt_lookahead_guarded AS promptLookaheadGuarded FROM analyses";
const SELECT_ALLOCATION_META_HEAD =
  "SELECT route, unavailable_reason AS unavailableReason, fallback_reason AS fallbackReason, skip_reason_code AS skipReasonCode, bankroll, per_race_cap AS perRaceCap, kelly_fraction AS kellyFraction, ev_threshold AS evThreshold, include_combo_odds AS includeComboOdds, include_wide AS includeWide, include_trio AS includeTrio, include_quinella AS includeQuinella, include_exacta AS includeExacta, include_trifecta AS includeTrifecta, include_bracket_quinella AS includeBracketQuinella, bet_unit AS betUnit, odds_status AS oddsStatus FROM analysis_allocation_meta";
const SELECT_ALLOCATION_BETS_HEAD =
  "SELECT bet_type AS betType, combo_key AS comboKey, stake, odds, ev FROM analysis_bets";
const SELECT_HORSES_HEAD =
  "SELECT umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark, reason FROM analysis_horses";

describe("AnalysisStore が発行する SQL 文の列(#168 AC-a7。切り出し前後で不変)", () => {
  it("saveAnalysis(配分あり): BEGIN → analyses → 馬×2 → allocation_meta → 買い目×2 → COMMIT の8文で、値の写しも固定", () => {
    const { store, take } = createRecordingStore();
    store.saveAnalysis(FULL_RECORD);
    const sequence = take();
    expect(sequence).toEqual([
      "BEGIN",
      `${INSERT_ANALYSES} ('202603020211', '2026-10-06T09:00:00.000Z', 0.0, NULL, NULL, NULL, NULL, NULL, '{"x":1}', NULL, NULL)`,
      `${INSERT_HORSE} (1.0, 1.0, 0.1234567890123, 0.2, 1.5, 1.1, 1.0, '{"a":1}', '◎', '根拠')`,
      `${INSERT_HORSE} (1.0, 2.0, 0.3, 0.3, NULL, NULL, 0.0, NULL, NULL, NULL)`,
      `${INSERT_META} (1.0, 'mixed', NULL, NULL, NULL, NULL, NULL, 10000.0, 3000.0, 0.25, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 100.0, 5.0, 50.0, 'm', NULL, 'kakutei')`,
      `${INSERT_BET} (1.0, 'place', '01', 300.0, 1.5, 1.1)`,
      `${INSERT_BET} (1.0, 'wide', '0102', 100.0, NULL, NULL)`,
      "COMMIT",
    ]);
  });

  it("saveAnalysis(配分なし): allocation_meta も買い目も発行しない(BEGIN → analyses → 馬 → COMMIT の4文)", () => {
    const { store, take } = createRecordingStore();
    store.saveAnalysis(MINIMAL_RECORD);
    expect(take()).toEqual([
      "BEGIN",
      `${INSERT_ANALYSES} ('202654071210', '2026-10-06T10:00:00.000Z', 0.0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      `${INSERT_HORSE} (1.0, 3.0, 0.5, 0.5, NULL, NULL, 0.0, NULL, NULL, NULL)`,
      "COMMIT",
    ]);
  });

  it("listAnalyses(raceId 指定): analyses の SELECT 1文 + 馬の SELECT を分析の件数ぶん(N+1。切り出しで増減しない)", () => {
    const { store, take } = createRecordingStore();
    store.saveAnalysis(FULL_RECORD);
    store.saveAnalysis(MINIMAL_RECORD);
    take();
    const analyses = store.listAnalyses({ raceId: "202603020211" });
    // 前提: 1件だけ返っている(退化していない)。
    expect(analyses).toHaveLength(1);
    expect(take()).toEqual([
      `${SELECT_ANALYSES_HEAD} WHERE race_id = '202603020211' ORDER BY id`,
      `${SELECT_HORSES_HEAD} WHERE analysis_id = 1.0 ORDER BY umaban`,
    ]);
  });

  it("listAnalyses(全件): analyses の SELECT 1文 + 馬の SELECT を2件ぶん", () => {
    const { store, take } = createRecordingStore();
    store.saveAnalysis(FULL_RECORD);
    store.saveAnalysis(MINIMAL_RECORD);
    take();
    const analyses = store.listAnalyses();
    expect(analyses).toHaveLength(2);
    expect(take()).toEqual([
      `${SELECT_ANALYSES_HEAD} ORDER BY id`,
      `${SELECT_HORSES_HEAD} WHERE analysis_id = 1.0 ORDER BY umaban`,
      `${SELECT_HORSES_HEAD} WHERE analysis_id = 2.0 ORDER BY umaban`,
    ]);
  });

  it("saveAnalysis の prepare は4回(analyses・馬・配分メタ・買い目)で、馬・買い目の行数に依らない(行ごとに prepare し直さない)", () => {
    // 馬2頭・買い目2件の入力と、馬1頭・配分なしの入力で、prepare の列が同じであること(件数に比例しない)。
    const full = createRecordingStore();
    full.store.saveAnalysis(FULL_RECORD);
    const fullPrepares = full.takePrepares();

    const minimal = createRecordingStore();
    minimal.store.saveAnalysis(MINIMAL_RECORD);
    const minimalPrepares = minimal.takePrepares();

    expect(fullPrepares).toEqual([
      expect.stringContaining(INSERT_ANALYSES),
      expect.stringContaining(INSERT_HORSE),
      expect.stringContaining(INSERT_META),
      expect.stringContaining(INSERT_BET),
    ]);
    // 配分なしでも、従来どおり4文とも prepare する(使わない文を prepare する挙動も含めて不変)。
    expect(minimalPrepares).toEqual(fullPrepares);
  });

  it("listAnalyses の prepare は、analyses の SELECT 1回 + 馬の SELECT 1回(分析の件数に依らない)", () => {
    const { store, takePrepares } = createRecordingStore();
    store.saveAnalysis(FULL_RECORD);
    store.saveAnalysis(MINIMAL_RECORD);
    takePrepares();

    expect(store.listAnalyses()).toHaveLength(2);
    expect(takePrepares()).toEqual([
      expect.stringContaining(SELECT_ANALYSES_HEAD),
      expect.stringContaining(SELECT_HORSES_HEAD),
    ]);
  });

  it("getStoredAllocation(配分あり): メタの SELECT → 買い目の SELECT の2文で、prepare も2回(余分な文・順序の入れ替えが無い)", () => {
    const { store, take, takePrepares } = createRecordingStore();
    const id = store.saveAnalysis(FULL_RECORD);
    take();
    takePrepares();

    const allocation = store.getStoredAllocation(id);

    // 前提: 配分が返っており、買い目が2件ある(退化していない)。
    expect(allocation).toBeDefined();
    expect(allocation!.bets).toHaveLength(2);
    expect(take()).toEqual([
      `${SELECT_ALLOCATION_META_HEAD} WHERE analysis_id = 1.0`,
      `${SELECT_ALLOCATION_BETS_HEAD} WHERE analysis_id = 1.0 ORDER BY bet_type, combo_key`,
    ]);
    expect(takePrepares()).toEqual([
      expect.stringContaining(SELECT_ALLOCATION_META_HEAD),
      expect.stringContaining(SELECT_ALLOCATION_BETS_HEAD),
    ]);
  });

  it("getStoredAllocation(配分なし): メタの SELECT 1文だけ(存在確認より先に買い目を引かない)で、prepare も1回", () => {
    const { store, take, takePrepares } = createRecordingStore();
    const id = store.saveAnalysis(MINIMAL_RECORD);
    take();
    takePrepares();

    expect(store.getStoredAllocation(id)).toBeUndefined();

    expect(take()).toEqual([`${SELECT_ALLOCATION_META_HEAD} WHERE analysis_id = 1.0`]);
    expect(takePrepares()).toEqual([expect.stringContaining(SELECT_ALLOCATION_META_HEAD)]);
  });
});

/**
 * 配分メタの真偽値フラグ7つ(INSERT の列順)。番号 0〜6 を2進数で表した3ビットを、3つの入力(bit0・bit1・bit2)に
 * 1ビットずつ割り当てる。**7つの番号がすべて異なる**ので、どの2つのフラグも少なくとも1つの入力で値が違い、
 * 「フラグの束縛位置の入れ替え」のどれもが、この表だけで(別のテストに頼らず)実行 SQL の違いとして現れる
 * (真偽値は2値なので、1つの入力だけでは7つを互いに区別できない)。
 */
const FLAG_FIELDS = [
  "includeComboOdds",
  "includeWide",
  "includeTrio",
  "includeQuinella",
  "includeExacta",
  "includeTrifecta",
  "includeBracketQuinella",
] as const;

function recordWithFlagBit(bit: 0 | 1 | 2): AnalysisRecord {
  const flags = Object.fromEntries(
    FLAG_FIELDS.map((field, code) => [field, ((code >> bit) & 1) === 1]),
  ) as Record<(typeof FLAG_FIELDS)[number], boolean>;
  return {
    ...FULL_RECORD,
    allocation: { ...FULL_RECORD.allocation!, meta: { ...FULL_RECORD.allocation!.meta, ...flags } },
  };
}

describe("配分メタの真偽値フラグ7つの束縛位置(#168 AC-a7。切り出し前後で不変)", () => {
  it("前提: 3つの入力で、7つのフラグの(bit0, bit1, bit2)の組が互いにすべて異なる", () => {
    const codes = FLAG_FIELDS.map((field) =>
      [0, 1, 2].map((bit) => (recordWithFlagBit(bit as 0 | 1 | 2).allocation!.meta[field] ? "1" : "0")).join(""),
    );
    expect(new Set(codes).size).toBe(FLAG_FIELDS.length);
  });

  it.each([
    [0, "0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0"],
    [1, "0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0"],
    [2, "0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0"],
  ] as const)("bit%i の入力: include_* 7列(combo_odds, wide, trio, quinella, exacta, trifecta, bracket_quinella)の値が `%s`", (bit, flags) => {
    const { store, take } = createRecordingStore();
    store.saveAnalysis(recordWithFlagBit(bit));
    const metaInsert = take().filter((sql) => sql.startsWith(INSERT_META));
    expect(metaInsert).toEqual([
      `${INSERT_META} (1.0, 'mixed', NULL, NULL, NULL, NULL, NULL, 10000.0, 3000.0, 0.25, 1.0, ${flags}, 100.0, 5.0, 50.0, 'm', NULL, 'kakutei')`,
    ]);
  });
});
