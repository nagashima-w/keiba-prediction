import { describe, expect, it } from "vitest";
import { AnalysisStore } from "../../packages/core/src/ev/analysis-store.js";
import type { AnalysisRecord, RaceComboPayoutsSaveInput, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { extractStartTime } from "../../packages/core/src/ev/lookahead-suspicion.js";
import { computeVerifyReport, computeVerifyReportByPromptVersion, PRODUCTION_VERIFY_CONFIG, type VerifyReport, type VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";
import { buildComboOddsKeyFor, type ComboBetType } from "../../packages/core/src/scraper/combo-odds-key.js";
import { buildVerifySource, VERIFY_READ_SQL, type VerifyReadRows } from "../../cloud/src/verify-read.js";
import { computePromptVersionSummaries } from "../../cloud/src/verify-versions.js";

/**
 * Issue #219: クラウド版の検証の集計(D1 の行 → `buildVerifySource` → core の `computeVerifyReport`)は、同じデータの exe(`AnalysisStore` → `computeVerifyReport`)と
 * **JSON 往復込みで一致する**。クラウド版が API で返すのは JSON なので、比べるのも JSON を通した値。
 *
 * **ここ(ルートの scripts/test/)に置く理由**: exe 側の `AnalysisStore` は better-sqlite3 を使う。cloud の CI は cloud だけを install する(better-sqlite3 が無い)ので、cloud/test からは
 * import できない(#218 と同じ)。cloud の SQL 定数(`VERIFY_READ_SQL`)を、exe と同じスキーマの SQLite にそのまま流して行を取り、D1 の行の代わりにする。
 * D1 の列のうち exe に無いのは `start_time` だけで、これは `ALTER TABLE` で足し、検証の DO の補完と同じ関数(`extractStartTime`)で埋める。
 *
 * 入力は乱数(固定の種)で作った 160 レース前後の分析・結果。**一致の検査が空振りでない**ことを、集計の各カウンタ・券種別の点数が 0 でないことで先に固定する。
 */

// ---------------------------------------------------------------------------
// 決定的な乱数(mulberry32)
// ---------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMBO_TYPES: readonly ComboBetType[] = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];
const COMBO_SIZES: Record<string, number> = { wide: 2, trio: 3, quinella: 2, exacta: 2, trifecta: 3, bracketQuinella: 2 };
const MARKS = ["◎", "〇", "▲", "△", "☆", "注", null, null] as const;
const START_TIMES: readonly (string | null)[] = ["15:45", "20:50", "9:05", null, "午後", "24:00"];

/** 組の馬番(重複なし・昇順にしない。馬単・三連単は順序付き)。 */
function pickUmabans(next: () => number, size: number, headCount: number): number[] {
  const pool = Array.from({ length: headCount }, (_, i) => i + 1);
  const out: number[] = [];
  for (let i = 0; i < size; i += 1) {
    out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]!);
  }
  return out;
}

interface Dataset {
  readonly store: AnalysisStore;
  /** exe の AnalysisStore が持つ SQLite(better-sqlite3)。ルートからは better-sqlite3 を直接 import できないので、`rawDatabase` で借りる。 */
  readonly db: AnalysisStore["rawDatabase"];
}

function build(seed: number): Dataset {
  const next = rng(seed);
  const store = new AnalysisStore();
  const db = store.rawDatabase;
  const raceIds: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    raceIds.push(`2026${String(1 + Math.floor(next() * 10)).padStart(2, "0")}03${String(1 + (i % 12)).padStart(2, "0")}${String(1 + Math.floor(i / 12)).padStart(2, "0")}`);
  }
  for (let i = 0; i < 60; i += 1) {
    raceIds.push(`202644${String(7).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}${String(1 + Math.floor(i / 28)).padStart(2, "0")}`);
  }
  const uniqueRaceIds = [...new Set(raceIds)];
  for (const raceId of uniqueRaceIds) {
    const headCount = 6 + Math.floor(next() * 10);
    const isNar = raceId.startsWith("202644");
    // 開催日: 中央は kaisaiDate を持つか null(unknown になりうる)。地方は raceId から決まる。
    const kaisai = isNar ? `2026${raceId.slice(6, 10)}` : "20260705";
    const startTime = START_TIMES[Math.floor(next() * START_TIMES.length)]!;
    const analysisCount = 1 + Math.floor(next() * 3);
    for (let k = 0; k < analysisCount; k += 1) {
      // 分析時刻: 前日・当日の発走前後・翌日にばらす。
      const offsetsHours = [-20, -3, 0.5, 2, 5, 30];
      const day = new Date(Date.UTC(Number(kaisai.slice(0, 4)), Number(kaisai.slice(4, 6)) - 1, Number(kaisai.slice(6, 8)), 3, 0, 0)); // 12:00 JST 相当
      const analyzedAt = new Date(day.getTime() + offsetsHours[Math.floor(next() * offsetsHours.length)]! * 3600_000 + k * 1000).toISOString();
      const llm = next() < 0.7;
      const guarded = next();
      const record: AnalysisRecord = {
        raceId,
        analyzedAt,
        evEstimated: next() < 0.1,
        promptVersion: llm ? (next() < 0.5 ? "v1" : "v2") : null,
        additionalInstruction: next() < 0.2 ? "追加" : null,
        kaisaiDate: isNar && next() < 0.5 ? null : next() < 0.15 ? null : kaisai,
        historyCutoffDate: guarded < 0.5 ? kaisai : null,
        promptLookaheadGuarded: guarded < 0.35 ? true : guarded < 0.5 ? false : null,
        raceSnapshot: { race: { raceName: "テスト", startTime }, horses: [] },
        horses: Array.from({ length: headCount }, (_, h) => {
          const prior = 0.05 + next() * 0.5;
          const adjusted = Math.min(0.95, Math.max(0.01, prior + (next() - 0.5) * 0.1));
          const placeOddsMin = next() < 0.1 ? null : next() < 0.03 ? 0 : 1 + next() * 6;
          return {
            umaban: h + 1,
            prior,
            adjustedProb: adjusted,
            placeOddsMin,
            ev: placeOddsMin === null ? null : adjusted * placeOddsMin,
            isPositive: next() < 0.4,
            contributions: null,
            mark: MARKS[Math.floor(next() * MARKS.length)] ?? null,
          };
        }),
      };
      // 配分提案: なし(記録なし)・未到達・見送り・配分あり。
      const roll = next();
      const allocation =
        roll < 0.15
          ? undefined
          : {
              meta: {
                route: roll < 0.25 ? "unset" : roll < 0.3 ? "yoso" : roll < 0.4 ? "unavailable" : roll < 0.7 ? "place-only" : "mixed",
                unavailableReason: null,
                fallbackReason: null,
                skipReasonCode: roll >= 0.7 && roll < 0.78 ? "no-candidates" : null,
                comboOddsWide: null,
                comboOddsTrio: null,
                bankroll: 10000,
                perRaceCap: 2000,
                kellyFraction: 0.25,
                evThreshold: 1,
                includeComboOdds: false,
                includeWide: false,
                includeTrio: false,
                includeQuinella: false,
                includeExacta: false,
                includeTrifecta: false,
                includeBracketQuinella: false,
                betUnit: 100,
                greedySteps: 1000,
                candidateCap: 2000,
                modelId: null,
                modelApproximate: null,
                oddsStatus: "result",
              },
              bets: makeBets(next, headCount),
            };
      store.saveAnalysis(allocation === undefined ? record : { ...record, allocation });
    }
    // 結果: 約 85% のレースに保存する。
    if (next() < 0.85) {
      const order = pickUmabans(next, headCount, headCount);
      const hasPayout = next() < 0.8;
      const entries: RaceResultEntry[] = order.map((umaban, idx) => ({
        umaban,
        finishPosition: next() < 0.05 ? null : idx + 1,
        placePayout: hasPayout && idx < 3 && next() < 0.95 ? 100 + Math.floor(next() * 400) : null,
        winPayout: hasPayout && idx === 0 ? 150 + Math.floor(next() * 800) : null,
      }));
      store.saveResult(raceId, entries, null, makeComboPayouts(next, headCount));
    }
  }
  // 発走時刻の写し(0009)。検証の DO の補完と同じ手順: 保存済みのスナップショットから extractStartTime → なければ ''。
  db.exec("ALTER TABLE analyses ADD COLUMN start_time TEXT");
  const snapshots = db.prepare("SELECT id, race_snapshot_json AS json FROM analyses").all() as Array<{ id: number; json: string | null }>;
  const setStart = db.prepare("UPDATE analyses SET start_time = ? WHERE id = ?");
  for (const row of snapshots) {
    setStart.run(extractStartTime(row.json === null ? null : JSON.parse(row.json)) ?? "", row.id);
  }
  return { store, db };
}

function makeBets(next: () => number, headCount: number): NonNullable<AnalysisRecord["allocation"]>["bets"] {
  const bets: Array<{ betType: string; comboKey: string; stake: number; odds: number | null; ev: number | null }> = [];
  const count = Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) {
    const r = next();
    if (r < 0.2) {
      bets.push({ betType: "place", comboKey: String(1 + Math.floor(next() * headCount)).padStart(2, "0"), stake: 100 * (1 + Math.floor(next() * 5)), odds: 2, ev: 1.1 });
    } else if (r < 0.35) {
      bets.push({ betType: "win", comboKey: String(1 + Math.floor(next() * headCount)).padStart(2, "0"), stake: 100, odds: 5, ev: 1.2 });
    } else if (r < 0.97) {
      const type = COMBO_TYPES[Math.floor(next() * COMBO_TYPES.length)]!;
      const size = COMBO_SIZES[type]!;
      const umabans = type === "bracketQuinella" ? [1 + Math.floor(next() * 8), 1 + Math.floor(next() * 8)] : pickUmabans(next, size, headCount);
      bets.push({ betType: type, comboKey: buildComboOddsKeyFor(type, umabans), stake: 100 * (1 + Math.floor(next() * 3)), odds: 10, ev: 1.3 });
    } else {
      bets.push({ betType: "mystery", comboKey: "0102", stake: 100, odds: null, ev: null });
    }
  }
  // 主キー (analysis_id, bet_type, combo_key) の重複を除く。
  const seen = new Set<string>();
  return bets.filter((b) => {
    const key = `${b.betType}:${b.comboKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeComboPayouts(next: () => number, headCount: number): RaceComboPayoutsSaveInput {
  const input: Record<string, { state: "parsed"; payouts: Array<{ umabans: number[]; payout: number }> }> = {};
  for (const type of COMBO_TYPES) {
    const r = next();
    if (r < 0.3) continue; // 未取込(not_imported)
    const payouts: Array<{ umabans: number[]; payout: number }> = [];
    if (r >= 0.4) {
      const n = 1 + Math.floor(next() * 3);
      const seen = new Set<string>();
      for (let i = 0; i < n; i += 1) {
        const umabans = type === "bracketQuinella" ? [1 + Math.floor(next() * 8), 1 + Math.floor(next() * 8)] : pickUmabans(next, COMBO_SIZES[type]!, headCount);
        const key = buildComboOddsKeyFor(type, umabans);
        if (seen.has(key)) continue;
        seen.add(key);
        payouts.push({ umabans, payout: 200 + Math.floor(next() * 5000) });
      }
    }
    input[type] = { state: "parsed", payouts };
  }
  return input as RaceComboPayoutsSaveInput;
}

/** cloud の SQL 定数を、exe と同じスキーマの SQLite に流して行を取る(D1 から読む行の代わり)。 */
function readRows(db: Dataset["db"]): VerifyReadRows {
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  return {
    analyses: all(VERIFY_READ_SQL.analyses),
    horses: all(VERIFY_READ_SQL.horses),
    allocationMeta: all(VERIFY_READ_SQL.allocationMeta),
    bets: all(VERIFY_READ_SQL.bets),
    results: all(VERIFY_READ_SQL.results),
    comboPayouts: all(VERIFY_READ_SQL.comboPayouts),
    comboImports: all(VERIFY_READ_SQL.comboImports),
  };
}

const json = (report: VerifyReport): unknown => JSON.parse(JSON.stringify(report));

const dataset = build(20261009);
const rows = readRows(dataset.db);
const source = buildVerifySource(rows);
const VENUES: readonly VerifyVenueFilter[] = ["all", "central", "nar"];

describe("前提: 入力が一致の検査を空振りさせない(各カウンタ・券種別の点数が 0 でない)", () => {
  const report = computeVerifyReport(dataset.store, PRODUCTION_VERIFY_CONFIG, "all");

  it("除外の各理由・集計・旧分析のカウンタがすべて 1 以上", () => {
    expect(report.includedAnalysisCount).toBeGreaterThan(0);
    expect(report.excludedAnalysisCount).toBeGreaterThan(0);
    expect(report.supersededAnalysisCount).toBeGreaterThan(0);
    expect(report.excludedEstimatedCount).toBeGreaterThan(0);
    expect(report.excludedLookaheadSuspectCount).toBeGreaterThan(0);
    expect(report.excludedLookaheadUnknownCount).toBeGreaterThan(0);
  });

  it("累積回収率に賭け・的中(実配当)・近似があり、配分の母集団の4分類がすべて 1 以上", () => {
    expect(report.bet.betCount).toBeGreaterThan(0);
    expect(report.bet.totalReturn).toBeGreaterThan(0);
    expect(report.bet.actualPayoutCount).toBeGreaterThan(0);
    const p = report.proposedBet.population;
    expect(p.allocated).toBeGreaterThan(0);
    expect(p.skipped).toBeGreaterThan(0);
    expect(p.unreached).toBeGreaterThan(0);
    expect(p.noRecord).toBeGreaterThan(0);
  });

  it("配分ベースの8券種すべてに判定できた点数・払戻があり、判定不能と未知の券種もある", () => {
    const pb = report.proposedBet;
    for (const type of ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const) {
      expect(pb[type].betCount, `${type} の点数`).toBeGreaterThan(0);
    }
    expect(pb.overall.totalReturn).toBeGreaterThan(0);
    expect(pb.overall.unjudgedCount).toBeGreaterThan(0);
    expect(pb.unknownBetType.count).toBeGreaterThan(0);
  });

  it("区分で結果が変わる(中央のみ・地方のみ・全体が互いに異なる)", () => {
    const [all, central, nar] = VENUES.map((v) => computeVerifyReport(dataset.store, PRODUCTION_VERIFY_CONFIG, v));
    expect(central!.includedAnalysisCount).toBeGreaterThan(0);
    expect(nar!.includedAnalysisCount).toBeGreaterThan(0);
    expect(central!.includedAnalysisCount + nar!.includedAnalysisCount).toBe(all!.includedAnalysisCount);
  });

  it("start_time の写しに、値・''(時刻なし)の両方がある(NULL=未確認は残っていない)", () => {
    const values = rows.analyses.map((r) => r.raceSnapshotJson === null);
    expect(values.some((v) => v)).toBe(true);
    expect(values.some((v) => !v)).toBe(true);
    const nullCount = (dataset.db.prepare("SELECT count(*) AS n FROM analyses WHERE start_time IS NULL").get() as { n: number }).n;
    expect(nullCount).toBe(0);
  });
});

describe("クラウド版の集計は exe の集計と JSON 往復込みで一致する", () => {
  it.each(VENUES)("区分 %s: PRODUCTION_VERIFY_CONFIG(先読み疑いの除外あり)で全項目が一致", (venue) => {
    const exe = computeVerifyReport(dataset.store, PRODUCTION_VERIFY_CONFIG, venue);
    const cloud = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, venue);
    expect(json(cloud)).toEqual(json(exe));
  });

  it.each(VENUES)("区分 %s: 先読みの除外なしの既定設定でも一致(除外の有無で入力の読み方が変わらない)", (venue) => {
    const exe = computeVerifyReport(dataset.store, { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }, venue);
    const cloud = computeVerifyReport(source, { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }, venue);
    expect(json(cloud)).toEqual(json(exe));
  });

  it("先読みの除外の有無でレポートが実際に変わる(除外の検査が空振りでない)", () => {
    const on = json(computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "all"));
    const off = json(computeVerifyReport(source, { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }, "all"));
    expect(on).not.toEqual(off);
  });

  it("全件モード(includeAllAnalyses)でも一致", () => {
    const config = { ...PRODUCTION_VERIFY_CONFIG, includeAllAnalyses: true };
    expect(json(computeVerifyReport(source, config, "all"))).toEqual(json(computeVerifyReport(dataset.store, config, "all")));
  });
});

describe("発走時刻の写し(start_time)が先読み判定を変える(補完の欠落が exe と違う結果にする場合の検出)", () => {
  it("start_time を '' に潰すと除外の件数が exe と食い違う(= 写しが判定に効いている。欠落('')が判定を変えうることの実証)", () => {
    const withTimes = (dataset.db.prepare("SELECT count(*) AS n FROM analyses WHERE start_time <> ''").get() as { n: number }).n;
    expect(withTimes).toBeGreaterThan(0);
    const cleared = readRows(dataset.db);
    // 時刻の写しだけを失った行(SQL が組み立てるスナップショットが無い状態)にする。
    const clearedSource = buildVerifySource({ ...cleared, analyses: cleared.analyses.map((a) => ({ ...a, raceSnapshotJson: null })) });
    const exe = computeVerifyReport(dataset.store, PRODUCTION_VERIFY_CONFIG, "all");
    const broken = computeVerifyReport(clearedSource, PRODUCTION_VERIFY_CONFIG, "all");
    expect(json(broken)).not.toEqual(json(exe));
  });
});

/**
 * Issue #220: プロンプト版別の比較も exe と一致する。クラウド版が保存・配信するのは `computePromptVersionSummaries`(画面が使う項目だけの射影)なので、
 * **同じ射影を exe の結果にも適用して**、JSON 往復込みで比べる。射影の前の完全な版別レポート(core の `computeVerifyReportByPromptVersion`)も比べる(射影が差を隠していないことの確認)。
 *
 * **このテストが保証する範囲(Issue #255)**: 射影の**前**(完全な版別レポート)が exe と cloud で一致すること、そして、同じ関数 `computePromptVersionSummaries` を両側に適用した結果が
 * 一致すること(= 入力が同じなら出力も同じ、という決定性)。**射影が何を残し、どの値を取り出すか**(項目の取捨選択・添字の取り違え)は、同じ射影を両側に通すので、ここでは検出できない
 * (過信バイアスの添字を +1 する変異で、このファイルのテストが全緑だった〈Issue #237 の記録〉)。それは `cloud/test/verify-versions.test.ts` が固定する。
 */
describe("プロンプト版別の比較は exe の結果と JSON 往復込みで一致する", () => {
  const exeFull = computeVerifyReportByPromptVersion(dataset.store, PRODUCTION_VERIFY_CONFIG);
  const cloudFull = computeVerifyReportByPromptVersion(source, PRODUCTION_VERIFY_CONFIG);
  const exeSummaries = computePromptVersionSummaries(dataset.store);
  const cloudSummaries = computePromptVersionSummaries(source);

  it("前提(空振り防止): 版が 3 つ以上(v1・v2・版不明)で、どの版にも集計対象・賭け・帯の件数があり、追加指示が複数の版がある", () => {
    expect(exeSummaries.map((s) => s.promptVersion)).toEqual(["v1", "v2", null]);
    for (const s of exeSummaries) {
      expect(s.includedAnalysisCount, `${s.promptVersion} の集計件数`).toBeGreaterThan(0);
      expect(s.bet.betCount, `${s.promptVersion} の賭け数`).toBeGreaterThan(0);
      expect(s.calibration.some((b) => b.predictedCount > 0), `${s.promptVersion} の帯`).toBe(true);
      expect(s.overconfidenceGaps.some((g) => g !== null), `${s.promptVersion} の過信バイアス`).toBe(true);
    }
    expect(exeSummaries.some((s) => s.additionalInstructions.length >= 2)).toBe(true);
    // 版ごとに回収率・集計件数が違う(版を取り違えても一致してしまう入力ではない)
    expect(new Set(exeSummaries.map((s) => s.bet.recoveryRate)).size).toBeGreaterThan(1);
    expect(new Set(exeSummaries.map((s) => s.includedAnalysisCount)).size).toBeGreaterThan(1);
  });

  it("前提(空振り防止): 最新の選択は版の中で行われる(版ごとの集計件数の合計が、全体の集計件数より多い)", () => {
    const all = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "all");
    const sum = exeSummaries.reduce((n, s) => n + s.includedAnalysisCount, 0);
    expect(sum).toBeGreaterThan(all.includedAnalysisCount);
  });

  it("完全な版別レポート(射影の前)が一致する", () => {
    expect(JSON.parse(JSON.stringify(cloudFull))).toEqual(JSON.parse(JSON.stringify(exeFull)));
  });

  it("同じ射影を両側に適用した結果が一致する(決定性。射影が何を残すかは verify-versions.test.ts の仕事)", () => {
    expect(JSON.parse(JSON.stringify(cloudSummaries))).toEqual(JSON.parse(JSON.stringify(exeSummaries)));
  });
});
