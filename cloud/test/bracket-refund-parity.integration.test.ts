import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { buildDayStats, buildRaceDigest } from "../src/daily-report-digest";
import { D1ReportSource } from "../src/daily-report-repository";
import { D1ResultStore } from "../src/result-repository";
import { buildVerifySource, VERIFY_READ_SQL, type VerifyReadRows } from "../src/verify-read";
import type { AnalysisRecord, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { computeVerifyReport } from "../../packages/core/src/ev/verify";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #269: 枠連の買い目の返還を、検証画面(`verify.ts` の配分ベースの回収率)と日報・月報(`judgeBets`)が**同じ D1 の行から、同じ数**で数えることの固定。
 * 2つの経路は別の実装(別の SQL・別の組み立て)だが、判定は `bracket-quinella-refund.ts` の1つの関数を共有する。ここでは、読み取りの経路(SQL の列・
 * 行の組み立て)まで含めて、返還の点数・賭け金・払戻・点数が食い違わないことを確かめる。
 */

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

const DATE = "20261013";
const raceIdOf = (n: number): string => `2026050308${String(n).padStart(2, "0")}`;

/** 枠連の買い目(comboKey は枠番の組)と賭け金。 */
const BETS: ReadonlyArray<readonly [string, number]> = [
  ["0303", 100], // 枠3は 5・6番。5番だけ取消 → 残り1頭 → ゾロ目のみ返還
  ["0304", 200], // 枠3に6番が残る → 返還なし
  ["0507", 300], // 枠7は 13・14番。2頭とも取消 → 枠7が尽きる → 返還
  ["0707", 400], // 同上。ゾロ目も返還
  ["0102", 500], // 的中(600円 × 5 = 3000円)
  ["0608", 600], // 不的中
];

/** 16頭立て(各枠2頭。枠 = ceil(馬番/2))。5番、13番、14番が取消・除外。枠番を記録するかを選べる。 */
function entries(recordWakuban: boolean): RaceResultEntry[] {
  const scratched = new Set([5, 13, 14]);
  return Array.from({ length: 16 }, (_, i) => {
    const umaban = i + 1;
    return {
      umaban,
      finishPosition: scratched.has(umaban) ? null : umaban,
      placePayout: null,
      winPayout: null,
      ...(scratched.has(umaban) ? { scratched: true } : {}),
      ...(recordWakuban ? { wakuban: Math.ceil(umaban / 2) } : {}),
    };
  });
}

async function saveRace(n: number, recordWakuban: boolean): Promise<{ id: number }> {
  const meta = contractCases[0]!.record.allocation!.meta;
  const record = {
    raceId: raceIdOf(n),
    analyzedAt: `2026-10-13T0${n}:00:00.000Z`,
    kaisaiDate: DATE,
    historyCutoffDate: DATE,
    promptLookaheadGuarded: true,
    promptVersion: "v-test",
    rawResponse: "raw",
    horses: [1, 2, 3].map((umaban) => ({ umaban, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 1.5, ev: 1.1, isPositive: umaban === 1, contributions: { umaban }, mark: umaban === 1 ? "◎" : null, reason: `根拠${umaban}` })),
    allocation: { meta, bets: BETS.map(([comboKey, stake]) => ({ betType: "bracketQuinella", comboKey, stake, odds: 6, ev: 1.1 })) },
  } as AnalysisRecord;
  const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(record);
  await new D1ResultStore({ db: local.db }).saveResult(raceIdOf(n), entries(recordWakuban), "芝", { bracketQuinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 600 }] } });
  return saved;
}

async function readVerifyRows(): Promise<VerifyReadRows> {
  const all = async <T>(sql: string): Promise<T[]> => (await local.db.prepare(sql).all()).results as T[];
  return {
    analyses: await all(VERIFY_READ_SQL.analyses),
    horses: await all(VERIFY_READ_SQL.horses),
    allocationMeta: await all(VERIFY_READ_SQL.allocationMeta),
    bets: await all(VERIFY_READ_SQL.bets),
    results: await all(VERIFY_READ_SQL.results),
    comboPayouts: await all(VERIFY_READ_SQL.comboPayouts),
    comboImports: await all(VERIFY_READ_SQL.comboImports),
  };
}

async function dayStatsOf(refs: ReadonlyArray<{ raceId: string; analysisId: number }>) {
  const analyses = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
  const inputs = await new D1ReportSource({ db: local.db, analyses }).readRaces(refs);
  const day = buildDayStats(inputs.map((i) => buildRaceDigest(i!.view, i!.result)));
  const period = await new D1ReportSource({ db: local.db, analyses }).readPeriodStats(DATE, DATE);
  return { day, period };
}

const REFUND_STAKE = 100 + 300 + 400;
const STAKE_PER_RACE = BETS.reduce((n, [, stake]) => n + stake, 0);

describe("枠連の返還: 検証画面と日報・月報が同じ数を数える(Issue #269)", () => {
  it("枠番を記録済みのレース: 返還は 0303・0507・0707 の3点(賭け金 800 円)。的中の払戻は通常どおり。検証・日報(1日)・期間の再集計(月報も同じ)の3つが一致する", async () => {
    const saved = await saveRace(1, true);
    // 前提: D1 に枠番と取消の両方が入っている(空振り防止)
    const col = await local.db.prepare("SELECT COUNT(*) AS n, SUM(scratched) AS s FROM race_results WHERE wakuban IS NOT NULL").first<{ n: number; s: number }>();
    expect(col).toEqual({ n: 16, s: 3 });

    const verify = computeVerifyReport(buildVerifySource(await readVerifyRows())).proposedBet.bracketQuinella;
    expect(verify).toMatchObject({ betCount: 6, totalStake: STAKE_PER_RACE, totalReturn: REFUND_STAKE + 3000, refundedCount: 3, refundedStake: REFUND_STAKE, unjudgedCount: 0 });

    const { day, period } = await dayStatsOf([{ raceId: raceIdOf(1), analysisId: saved.id }]);
    for (const stats of [day, period]) {
      expect(stats.judgedBetCount).toBe(verify.betCount);
      expect(stats.totalStake).toBe(verify.totalStake);
      expect(stats.totalReturn).toBe(verify.totalReturn);
      expect(stats.refundedBetCount).toBe(verify.refundedCount);
      expect(stats.refundedStake).toBe(verify.refundedStake);
    }
    expect(period.byBetType["bracketQuinella"]!.refundCount).toBe(3);
  });

  it("枠番が NULL(旧い行)のレース: どちらも返還にしない(取消を含む枠連は不的中のまま)。やはり2つの経路が一致する", async () => {
    const saved = await saveRace(1, false);
    const col = await local.db.prepare("SELECT COUNT(*) AS n, SUM(scratched) AS s FROM race_results WHERE wakuban IS NULL").first<{ n: number; s: number }>();
    expect(col).toEqual({ n: 16, s: 3 }); // 前提: 取消は記録済みで、枠番だけが NULL

    const verify = computeVerifyReport(buildVerifySource(await readVerifyRows())).proposedBet.bracketQuinella;
    expect(verify).toMatchObject({ betCount: 6, totalStake: STAKE_PER_RACE, totalReturn: 3000, refundedCount: 0, refundedStake: 0 });

    const { day, period } = await dayStatsOf([{ raceId: raceIdOf(1), analysisId: saved.id }]);
    for (const stats of [day, period]) {
      expect(stats.judgedBetCount).toBe(verify.betCount);
      expect(stats.totalStake).toBe(verify.totalStake);
      expect(stats.totalReturn).toBe(verify.totalReturn);
      expect(stats.refundedBetCount).toBe(0);
      expect(stats.refundedStake).toBe(0);
    }
  });

  it("2レース(枠番あり・NULL)を同じ集計に入れても一致する(レース単位で判定する)", async () => {
    const a = await saveRace(1, true);
    const b = await saveRace(2, false);
    const verify = computeVerifyReport(buildVerifySource(await readVerifyRows())).proposedBet.bracketQuinella;
    expect(verify).toMatchObject({ betCount: 12, refundedCount: 3, refundedStake: REFUND_STAKE });
    const { day, period } = await dayStatsOf([
      { raceId: raceIdOf(1), analysisId: a.id },
      { raceId: raceIdOf(2), analysisId: b.id },
    ]);
    for (const stats of [day, period]) {
      expect(stats.judgedBetCount).toBe(verify.betCount);
      expect(stats.totalStake).toBe(verify.totalStake);
      expect(stats.totalReturn).toBe(verify.totalReturn);
      expect(stats.refundedBetCount).toBe(verify.refundedCount);
      expect(stats.refundedStake).toBe(verify.refundedStake);
    }
  });
});
