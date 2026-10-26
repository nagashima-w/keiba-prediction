import { describe, expect, it } from "vitest";
import {
  buildAllocationRaceRow,
  toAllocationSnapshot,
  type AllocationMetaInput,
  type AllocationRaceRow,
  type ChosenAllocationAnalysis,
} from "../../cloud/src/allocation-export-format.js";
import { buildComboOddsKeyFor } from "../../packages/core/src/scraper/combo-odds-key.js";
import { compareReplay, replayRace, type ReplayOutcome } from "../allocation-dataset.js";
import { COMBO_KINDS, snapshotOf, syntheticRace, wakubanOf, type SyntheticRace } from "../measure-allocation-export.js";
import { seededRandom } from "../synthetic-random.js";

/** Issue #494: 書き出しの実測スクリプト(scripts/measure-allocation-export.ts)の合成データの作り方の検査。測定そのもの(wrangler dev・/proc)は機械に依存するため固定しない。 */

const flag = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);
const choose = (n: number, k: number): number => (k === 0 ? 1 : (choose(n - 1, k - 1) * n) / k);

/** 合成のレースを、D1 に入れて書き出したときと同じ行(`buildAllocationRaceRow`)にする。 */
function rowOf(race: SyntheticRace, id: number): AllocationRaceRow {
  const m = race.allocation.meta;
  const analysis: ChosenAllocationAnalysis = {
    id, raceId: race.raceId, analyzedAt: "2026-10-03T03:00:00.000Z", kaisaiDate: "20251005", promptVersion: "v8", detailKey: `analyses/${id}.json.gz`, promptLookaheadGuarded: true, leakClass: "guarded",
  };
  const meta: AllocationMetaInput = {
    route: m.route, unavailableReason: m.unavailableReason, fallbackReason: m.fallbackReason, skipReasonCode: m.skipReasonCode, comboOddsWide: m.comboOddsWide, comboOddsTrio: m.comboOddsTrio,
    bankroll: m.bankroll, perRaceCap: m.perRaceCap, kellyFraction: m.kellyFraction, evThreshold: m.evThreshold, includeComboOdds: flag(m.includeComboOdds), includeWide: flag(m.includeWide),
    includeTrio: flag(m.includeTrio), includeQuinella: flag(m.includeQuinella), includeExacta: flag(m.includeExacta), includeTrifecta: flag(m.includeTrifecta),
    includeBracketQuinella: flag(m.includeBracketQuinella), betUnit: m.betUnit, greedySteps: m.greedySteps, candidateCap: m.candidateCap, modelId: m.modelId, modelApproximate: flag(m.modelApproximate),
    oddsStatus: m.oddsStatus, minHitProb: m.minHitProb ?? null, belowFloorCount: m.belowFloorCount ?? null,
    missedJson: m.missed === undefined || m.missed === null ? null : JSON.stringify(m.missed.map((x) => ({ bet_type: x.betType, combo_key: x.comboKey, hit_prob: x.hitProb, odds: x.odds, ev: x.ev, would_stake: x.wouldStake }))),
  };
  return buildAllocationRaceRow({
    analysis,
    horses: race.horseRecords.map((h) => ({ umaban: h.umaban, prior: h.prior, adjustedProb: h.adjustedProb, placeOddsMin: h.placeOddsMin, ev: h.ev })),
    snapshot: toAllocationSnapshot(snapshotOf({ race: {}, horses: [{ name: "x" }] }, race)),
    meta,
    bets: race.allocation.bets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })),
    results: race.entries.map((e) => ({
      umaban: e.umaban, finishPosition: e.finishPosition, placePayout: e.placePayout ?? null, winPayout: e.winPayout ?? null, scratched: 0, wakuban: race.horses[e.umaban - 1]!.wakuban,
      winOdds: race.horses[e.umaban - 1]!.winOdds, ninki: race.horses[e.umaban - 1]!.ninki,
    })),
    payouts: COMBO_KINDS.flatMap((kind) => {
      const result = race.combo[kind];
      return result?.state === "parsed" ? result.payouts.map((p) => ({ betType: kind, comboKey: buildComboOddsKeyFor(kind, p.umabans), payout: p.payout })) : [];
    }),
    imports: COMBO_KINDS.filter((k) => race.combo[k]?.state === "parsed"),
  });
}

describe("wakubanOf(枠番の割り当て)", () => {
  it("8 頭以下は馬番と同じ。9 頭以上は、後ろの枠から順に 1 頭ずつ多い(10 頭・14 頭・18 頭を手で確かめる)", () => {
    expect(wakubanOf(8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(wakubanOf(5)).toEqual([1, 2, 3, 4, 5]);
    expect(wakubanOf(10)).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 8, 8]);
    const count = (n: number): number[] => {
      const w = wakubanOf(n);
      return Array.from({ length: 8 }, (_, f) => w.filter((x) => x === f + 1).length);
    };
    expect(count(14)).toEqual([1, 1, 2, 2, 2, 2, 2, 2]);
    expect(count(18)).toEqual([2, 2, 2, 2, 2, 2, 3, 3]);
    expect(wakubanOf(14)).toHaveLength(14);
  });
});

describe("syntheticRace(合成した 1 レース)", () => {
  it("同じ種・同じ引数なら同じレース、種が違えば違うレース(決定的)", () => {
    const a = syntheticRace(3, 10, seededRandom(1));
    expect(JSON.stringify(syntheticRace(3, 10, seededRandom(1)))).toBe(JSON.stringify(a));
    expect(JSON.stringify(syntheticRace(3, 10, seededRandom(2)))).not.toBe(JSON.stringify(a));
  });

  it("全 6 券種の全組合せのオッズを持つ(14 頭・18 頭の組合せ数を、数式で数えた値と比べる)。枠連は同じ枠の組を、2 頭以上いる枠だけに作る", () => {
    for (const [n, bracket] of [[14, 28 + 6], [18, 28 + 8], [8, 28]] as const) {
      const race = syntheticRace(1, n, seededRandom(7));
      const sizes = Object.fromEntries(COMBO_KINDS.map((k) => [k, Object.keys(race.combos[k]).length]));
      expect(sizes, `${n} 頭`).toEqual({ wide: choose(n, 2), trio: choose(n, 3), quinella: choose(n, 2), exacta: n * (n - 1), trifecta: n * (n - 1) * (n - 2), bracketQuinella: bracket });
      expect(Object.values(race.combos).every((m) => Object.values(m).every((o) => Number.isFinite(o) && o >= 1.1 && o <= 9999.9))).toBe(true);
    }
    expect(Object.keys(syntheticRace(1, 18, seededRandom(7)).combos.trifecta).length).toBe(4896);
  });

  it("結果: 着順は馬番の並べ替えで、払戻の組はすべて合成のオッズのキーにある(取込印つきの払戻が判定できる)", () => {
    const race = syntheticRace(2, 14, seededRandom(3));
    expect([...race.finishOrder].sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(race.entries.filter((e) => e.placePayout !== null)).toHaveLength(3);
    expect(race.entries.filter((e) => e.winPayout !== null)).toHaveLength(1);
    for (const kind of COMBO_KINDS) {
      const result = race.combo[kind]!;
      expect(result.state).toBe("parsed");
      expect(result.state === "parsed" && result.payouts.length).toBeGreaterThan(0);
      if (result.state === "parsed") {
        for (const p of result.payouts) expect(Object.keys(race.combos[kind]), kind).toContain(buildComboOddsKeyFor(kind, p.umabans));
      }
    }
  });

  it("書き出される列(R2 の raceSnapshot → toAllocationSnapshot)に、馬のオッズ・枠番・6 券種の組合せが落ちずに入る", () => {
    const race = syntheticRace(4, 12, seededRandom(5));
    const snap = toAllocationSnapshot(snapshotOf({ race: {}, horses: [{ name: "x", jockeyName: "y" }] }, race));
    expect(snap.present).toBe(true);
    expect(snap.horses.size).toBe(12);
    for (const h of race.horses) {
      expect(snap.horses.get(h.umaban)).toEqual({ wakuban: h.wakuban, win_odds: h.winOdds, ninki: h.ninki, place_min: h.placeMin, place_max: h.placeMax });
    }
    for (const kind of COMBO_KINDS) {
      expect(snap.combos[kind], kind).toEqual(race.combos[kind]);
      expect(snap.comboStates[kind], kind).toBe("available");
    }
  });
});

describe("合成データは、分析時の提案を計算し直しと同じ関数で作っている(往復で完全に一致する)", () => {
  it("14 頭の複数のレースと 18 頭の最悪の構成で、書き出した行から計算し直すと提案が完全に一致する。前提: 買い目が空でなく、券種が 2 種類以上", () => {
    const rand = seededRandom(494);
    const races = [...Array.from({ length: 5 }, (_, i) => syntheticRace(i, 14, rand)), syntheticRace(9, 18, rand)];
    for (const [i, race] of races.entries()) {
      const row = rowOf(race, i + 1);
      const bets = row.allocation!.bets;
      expect(bets.length, `レース ${i}: 前提(買い目がある)`).toBeGreaterThan(0);
      expect(row.has_odds).toBe(true);
      const outcome = replayRace(row) as Extract<ReplayOutcome, { kind: "replayed" }>;
      expect(outcome.kind).toBe("replayed");
      expect(outcome.result.allocation.bets.length, `レース ${i}: 計算し直しも空でない`).toBe(bets.length);
      expect(compareReplay(row, outcome).differences, `レース ${i}`).toEqual([]);
      expect(row.allocation!.missed?.length ?? 0, `レース ${i}: 下限で外した買い目の記録が行に写る`).toBe(race.allocation.meta.missed?.length ?? 0);
    }
    expect(new Set(races.flatMap((r) => r.allocation.bets.map((b) => b.betType))).size, "前提: 券種が 2 種類以上").toBeGreaterThanOrEqual(2);
  }, 120_000);
});
