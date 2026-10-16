import { describe, expect, it } from "vitest";

import type { AnalysisRecord, RaceData } from "../../src/index.js";
import { COMBO_STATS_SNAPSHOT_KEY } from "../../src/analysis/combo-stats.js";
import { runAnalysis } from "../../src/analysis/analysis-pipeline.js";
import {
  recomputeAllocationFromProbs,
  type RecomputeHorseInput,
} from "../../src/analysis/recompute-allocation.js";
import {
  ALL_BETS_SETTINGS,
  FIXED_NOW,
  KAISAI_DATE,
  RACE_ID,
  scrapeFixtureRace,
  viaJson,
} from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #338(#335-A1): EV・配分の再計算の純関数 `recomputeAllocationFromProbs`。
 * `runAnalysis` の (4)EV・(6)配分を、確率(補正後の3着内率)と新しいオッズだけから決定的に作り直す。
 * 検証の柱は「同じ確率・同じオッズなら、`runAnalysis` が保存した配分と完全に一致する」こと(抽出が無害な証拠。golden とは別の角度)。
 */

interface Baseline {
  readonly race: RaceData;
  readonly record: AnalysisRecord;
  readonly horses: readonly RecomputeHorseInput[];
}

/** 基準(全券種 ON・LLM なしの runAnalysis の1回)は、全テストで共有する(読み取り専用。1回の実行が約 3 秒かかるため、負荷のあるときの既定のタイムアウトを避ける)。 */
let baselineOnce: Promise<Baseline> | undefined;
function baseline(): Promise<Baseline> {
  baselineOnce ??= computeBaseline();
  return baselineOnce;
}

/** 全券種 ON・LLM なしの runAnalysis を1回走らせ、保存レコードと入力(RaceData)を得る。 */
async function computeBaseline(): Promise<Baseline> {
  const race = await scrapeFixtureRace();
  let saved: AnalysisRecord | undefined;
  await runAnalysis(RACE_ID, KAISAI_DATE, {
    scrape: async () => race,
    analyze: null,
    saveAnalysis: (record) => {
      saved = record;
      return 1;
    },
    allocationSettings: ALL_BETS_SETTINGS,
    now: FIXED_NOW,
    llmSkipReason: "テスト: LLM なし",
  });
  const record = saved!;
  const wakubanByUmaban = new Map(race.horses.map((h) => [h.shutuba.umaban, h.shutuba.wakuban]));
  const nameByUmaban = new Map(race.horses.map((h) => [h.shutuba.umaban, h.shutuba.name]));
  const horses = record.horses.map((h) => ({
    umaban: h.umaban,
    wakuban: wakubanByUmaban.get(h.umaban)!,
    horseName: nameByUmaban.get(h.umaban)!,
    prior: h.prior,
    adjustedProb: h.adjustedProb,
  }));
  return { race, record, horses };
}

describe("recomputeAllocationFromProbs(確率を固定してオッズだけ差し替える再計算。Issue #338)", { timeout: 30_000 }, () => {
  it("前提(空振り防止): 基準の配分が多点・複数券種で、組合せオッズ(全6券種)を含む", async () => {
    const { record, race } = await baseline();
    const bets = record.allocation?.bets ?? [];
    expect(bets.length).toBeGreaterThan(5);
    expect(new Set(bets.map((b) => b.betType)).size).toBeGreaterThanOrEqual(3);
    expect(record.horses).toHaveLength(16);
    for (const key of ["wideCombo", "trioCombo", "quinellaCombo", "exactaCombo", "trifectaCombo", "bracketQuinellaCombo"] as const) {
      expect(Object.keys(race.odds[key] ?? {}).length, key).toBeGreaterThan(0);
    }
  });

  it("同じ確率・同じオッズなら、runAnalysis が保存した配分(メタ・買い目)と comboStats に完全に一致する", async () => {
    const { race, record, horses } = await baseline();
    const result = recomputeAllocationFromProbs({
      raceId: RACE_ID,
      horses,
      odds: race.odds,
      comboOdds: race.meta.comboOdds,
      allocationSettings: ALL_BETS_SETTINGS,
    });
    expect(viaJson(result.allocation)).toEqual(viaJson(record.allocation));
    const snapshot = record.raceSnapshot as Record<string, unknown>;
    expect(viaJson(result.comboStats)).toEqual(viaJson(snapshot[COMBO_STATS_SNAPSHOT_KEY] ?? null));
    expect(result.evEstimated).toBe(record.evEstimated);
    expect(result.oddsStatus).toBe(race.odds.oddsStatus);
  });

  it("各馬の EV・複勝下限・単勝オッズ・isPositive が、保存した馬の行と一致する(馬番昇順)", async () => {
    const { race, record, horses } = await baseline();
    const result = recomputeAllocationFromProbs({
      raceId: RACE_ID,
      horses: [...horses].reverse(), // 入力の並びに依らず馬番昇順
      odds: race.odds,
      comboOdds: race.meta.comboOdds,
      allocationSettings: ALL_BETS_SETTINGS,
    });
    expect(result.rows.map((r) => r.umaban)).toEqual(record.horses.map((h) => h.umaban));
    for (const row of result.rows) {
      const saved = record.horses.find((h) => h.umaban === row.umaban)!;
      expect(row.ev).toBe(saved.ev);
      expect(row.placeOddsMin).toBe(saved.placeOddsMin);
      expect(row.isPositive).toBe(saved.isPositive);
      expect(row.adjustedProb).toBe(saved.adjustedProb);
    }
    // 前提: EV が実際に入っている馬がいる(全馬 null の退化入力ではない)
    expect(result.rows.filter((r) => r.ev !== null).length).toBeGreaterThan(8);
  });

  it("確率を固定してオッズだけ差し替えると配分が変わり(差が 0 でない)、同じ入力の2回は同じ結果になる(決定性)", async () => {
    const { race, record, horses } = await baseline();
    // 全馬の単勝・複勝・三連単のオッズを 0.6 倍にする(最後の動きで配当が下がった想定)。
    const scale = (o: Record<string, number | null> | undefined) =>
      o === undefined ? undefined : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? null : Math.max(1.1, Math.round(v * 0.6 * 10) / 10)]));
    const shifted: RaceData["odds"] = {
      ...race.odds,
      win: Object.fromEntries(Object.entries(race.odds.win).map(([k, v]) => [k, { ...v, odds: v.odds === null ? null : Math.max(1.1, Math.round(v.odds * 0.6 * 10) / 10) }])),
      place: Object.fromEntries(Object.entries(race.odds.place).map(([k, v]) => [k, { ...v, oddsMin: v.oddsMin === null ? null : Math.max(1.1, Math.round(v.oddsMin * 0.6 * 10) / 10) }])),
      ...(race.odds.trifectaCombo === undefined ? {} : { trifectaCombo: scale(race.odds.trifectaCombo)! }),
    } as RaceData["odds"];
    const input = { raceId: RACE_ID, horses, comboOdds: race.meta.comboOdds, allocationSettings: ALL_BETS_SETTINGS } as const;
    const a = recomputeAllocationFromProbs({ ...input, odds: shifted });
    const b = recomputeAllocationFromProbs({ ...input, odds: shifted });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const baseBets = record.allocation!.bets;
    const shiftedBets = a.allocation.bets;
    expect(baseBets.length).toBeGreaterThan(0);
    // 前提: 差の指標(合計賭け金の絶対差、または買い目の集合の違い)が 0 でない
    const total = (bets: readonly { stake: number }[]) => bets.reduce((s, x) => s + x.stake, 0);
    const keys = (bets: readonly { betType: string; comboKey: string }[]) => bets.map((x) => `${x.betType}:${x.comboKey}`).sort().join(",");
    expect(Math.abs(total(shiftedBets) - total(baseBets)) > 0 || keys(shiftedBets) !== keys(baseBets)).toBe(true);
  });

  it("発売前(yoso)のオッズでは推定 EV を使い(evEstimated)、複勝の配分は出ない経路になる", async () => {
    const { race, horses } = await baseline();
    const result = recomputeAllocationFromProbs({
      raceId: RACE_ID,
      horses,
      odds: { ...race.odds, oddsStatus: "yoso", place: {} },
      allocationSettings: ALL_BETS_SETTINGS,
    });
    expect(result.evEstimated).toBe(true);
    expect(result.oddsStatus).toBe("yoso");
    expect(result.rows.every((r) => r.evEstimated)).toBe(true);
    expect(result.allocation.bets).toHaveLength(0);
  });

  it("総資金・1レース上限が未設定(0)なら、配分は出ない(メタの route が unset で買い目 0 件)", async () => {
    const { race, horses } = await baseline();
    const result = recomputeAllocationFromProbs({
      raceId: RACE_ID,
      horses,
      odds: race.odds,
      comboOdds: race.meta.comboOdds,
      allocationSettings: { ...ALL_BETS_SETTINGS, bankroll: 0, perRaceCap: 0 },
    });
    expect(result.allocation.meta.route).toBe("unset");
    expect(result.allocation.bets).toHaveLength(0);
    expect(result.allocation.meta.bankroll).toBe(0);
  });
});
