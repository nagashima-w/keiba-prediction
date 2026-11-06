/**
 * 検証の集計の試験用に、乱数で分析・結果・配分の入力を作る(Issue #625)。固定シードなので再現できる。
 * 複数のレース・複数のプロンプトの版・取消や返還・中央と地方・組合せの払戻と未知券種を含む。
 */
import type { RaceComboPayoutsReadResult, RaceResultEntry, StoredAllocationSummary, StoredAnalysis, VerifyDataSource } from "../../src/ev/analysis-store-types.js";
import type { ComboBetType } from "../../src/scraper/combo-odds-key.js";
import { buildComboOddsKeyFor } from "../../src/scraper/combo-odds-key.js";
import { mulberry32 } from "../../src/common/random.js";

export interface RandomVerifyData {
  readonly analyses: StoredAnalysis[];
  readonly source: VerifyDataSource;
  readonly raceIds: string[];
}

const MARKS = ["◎", "〇", "▲", "△", "☆", "注", null] as const;
const VERSIONS = [null, "v1", "v2", "v10"] as const;
const INSTRUCTIONS = [null, "指示A", "指示B"] as const;
const COMBO_TYPES: readonly ComboBetType[] = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];

export function randomVerifyData(seed: number, raceCount: number, options: { dirtyProbability?: boolean } = {}): RandomVerifyData {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const venues = ["05", "06", "08", "30", "42", "44"]; // 中央 3、地方 3
  const raceIds: string[] = [];
  const used = new Set<string>();
  while (raceIds.length < raceCount) {
    const id = `2025${pick(venues)}0${int(1, 3)}${String(int(1, 6)).padStart(2, "0")}${String(int(1, 12)).padStart(2, "0")}`;
    if (!used.has(id)) {
      used.add(id);
      raceIds.push(id);
    }
  }
  // 分析 ID は全レースにまたがって交互に採番する(race_id の順と ID の順が一致しないようにする)。
  const slots: string[] = [];
  const counts = new Map(raceIds.map((r) => [r, int(1, 3)] as const));
  for (const r of raceIds) {
    for (let i = 0; i < counts.get(r)!; i += 1) slots.push(r);
  }
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  const fieldSizes = new Map(raceIds.map((r) => [r, int(5, 16)] as const));
  const analyses: StoredAnalysis[] = slots.map((raceId, index) => {
    const size = fieldSizes.get(raceId)!;
    const guarded = rnd() < 0.85;
    return {
      id: index + 1,
      raceId,
      analyzedAt: `2025-06-0${int(1, 3)}T0${int(0, 9)}:00:00Z`,
      horses: Array.from({ length: size }, (_, k) => {
        const prior = rnd() * 0.6;
        const adjustedProb = options.dirtyProbability === true && rnd() < 0.02 ? 1.3 : Math.min(1, Math.max(0, prior + (rnd() - 0.5) * 0.1));
        const placeOddsMin = rnd() < 0.9 ? 1 + rnd() * 20 : null;
        return {
          umaban: k + 1,
          prior,
          adjustedProb,
          placeOddsMin,
          ev: rnd() < 0.9 ? 0.6 + rnd() : null,
          isPositive: rnd() < 0.4,
          contributions: null,
          mark: pick(MARKS),
          reason: null,
          highlights: [],
          concerns: [],
        };
      }),
      evEstimated: rnd() < 0.1,
      promptVersion: pick(VERSIONS),
      additionalInstruction: pick(INSTRUCTIONS),
      kaisaiDate: "20250601",
      model: null,
      rawResponse: null,
      raceSnapshot: null,
      historyCutoffDate: guarded ? "20250530" : null,
      promptLookaheadGuarded: guarded ? true : rnd() < 0.5 ? false : null,
    };
  });

  const results = new Map<string, RaceResultEntry[]>();
  const combos = new Map<string, RaceComboPayoutsReadResult>();
  for (const raceId of raceIds) {
    if (rnd() < 0.12) continue; // 結果未保存
    const size = fieldSizes.get(raceId)!;
    const order = Array.from({ length: size }, (_, k) => k + 1).sort(() => rnd() - 0.5);
    const hasPlacePayout = rnd() < 0.9;
    results.set(
      raceId,
      order.map((umaban, i) => {
        const scratched = rnd() < 0.05;
        const finish = scratched || rnd() < 0.03 ? null : i + 1;
        return {
          umaban,
          finishPosition: finish,
          placePayout: hasPlacePayout && finish !== null && finish <= 3 ? int(11, 60) * 10 : null,
          winPayout: finish === 1 ? int(12, 300) * 10 : null,
          ninki: finish === null ? null : i + 1,
          scratched,
          wakuban: Math.min(8, Math.ceil(umaban / 2)),
        };
      }),
    );
    for (const t of COMBO_TYPES) {
      const r = rnd();
      const payouts = Array.from({ length: int(0, 3) }, () => {
        const a = int(1, size);
        const b = int(1, size);
        return { comboKey: buildComboOddsKeyFor(t, a === b ? [a, (a % size) + 1] : [a, b]), payout: int(10, 900) * 10 };
      });
      combos.set(`${raceId}:${t}`, r < 0.2 ? { state: "not_imported" } : { state: "imported", payouts: r < 0.3 ? [] : payouts });
    }
  }

  const allocations = new Map<number, StoredAllocationSummary>();
  const betTypes = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella", "mystery"];
  for (const a of analyses) {
    const r = rnd();
    if (r < 0.1) continue;
    if (r < 0.2) {
      allocations.set(a.id, { route: "unset", skipReasonCode: null, bets: [] });
      continue;
    }
    if (r < 0.3) {
      allocations.set(a.id, { route: "mixed", skipReasonCode: "ev-below", bets: [] });
      continue;
    }
    const size = fieldSizes.get(a.raceId)!;
    allocations.set(a.id, {
      route: rnd() < 0.5 ? "mixed" : "place-only",
      skipReasonCode: null,
      bets: Array.from({ length: int(1, 6) }, () => {
        const betType = pick(betTypes);
        const u1 = int(1, size);
        const u2 = (u1 % size) + 1;
        const u3 = (u2 % size) + 1;
        const comboKey =
          betType === "place" || betType === "win" ? String(u1).padStart(2, "0") : buildComboOddsKeyFor((COMBO_TYPES.includes(betType as ComboBetType) ? betType : "wide") as ComboBetType, betType === "trio" || betType === "trifecta" ? [u1, u2, u3] : [u1, u2]);
        return { betType, comboKey, stake: int(1, 20) * 100 };
      }).filter((b, i, all) => all.findIndex((o) => o.betType === b.betType && o.comboKey === b.comboKey) === i),
    });
  }

  const source: VerifyDataSource = {
    listAnalyses: (filter) => (filter?.raceId === undefined ? analyses : analyses.filter((a) => a.raceId === filter.raceId)),
    getResult: (raceId) => results.get(raceId),
    getComboPayouts: (raceId, betType) => combos.get(`${raceId}:${betType}`) ?? { state: "not_imported" },
    getAllocationForVerify: (id) => allocations.get(id),
  };
  return { analyses, source, raceIds };
}

/** 配列を乱数で並べ替えた写しを返す。 */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 分析を、レースごと(`byRace`)・開催日ごとに分けるための分割(同じレースは同じ塊に入る)。 */
export function splitByRace(analyses: readonly StoredAnalysis[], chunkOfRace: (raceId: string, index: number) => number): StoredAnalysis[][] {
  const raceOrder = [...new Set(analyses.map((a) => a.raceId))];
  const chunks = new Map<number, StoredAnalysis[]>();
  raceOrder.forEach((raceId, index) => {
    const key = chunkOfRace(raceId, index);
    const chunk = chunks.get(key) ?? [];
    chunk.push(...analyses.filter((a) => a.raceId === raceId));
    chunks.set(key, chunk);
  });
  return [...chunks.values()];
}
