import { describe, expect, it } from "vitest";

import type { RaceLedgerEntry } from "@keiba/core";
import { buildRaceLedgerView } from "../src/main/race-ledger-view.js";

/** テスト用のcore RaceLedgerEntryを最小構成で組み立てる。 */
function entry(overrides: Partial<RaceLedgerEntry> = {}): RaceLedgerEntry {
  return {
    raceId: "202605020811", // 場コード05 → 東京、末尾2桁11 → 11R。
    analysisId: 1,
    analyzedAt: "2026-07-08T10:00:00.000Z",
    kaisaiDate: "20260708",
    promptVersion: "2026-07-14.1",
    hasResult: false,
    hasPayout: false,
    horses: [],
    totalStake: 0,
    totalReturn: 0,
    recoveryRate: null,
    betCount: 0,
    ...overrides,
  };
}

describe("buildRaceLedgerView(検証画面: レース単位の統合リストの表示用組み立て。検証画面UI統合)", () => {
  it("raceIdから会場名・レース番号を導出して付与すること(既存の会場名解決ロジックを再利用)", () => {
    const [view] = buildRaceLedgerView([entry({ raceId: "202605020811" })]);
    expect(view!.venueName).toBe("東京");
    expect(view!.raceNumber).toBe(11);
  });

  it("地方(NAR)のレースIDでも会場名を導出すること", () => {
    // 場コード54 → 高知。末尾2桁10 → 10R。
    const [view] = buildRaceLedgerView([entry({ raceId: "202654071210" })]);
    expect(view!.venueName).toBe("高知");
    expect(view!.raceNumber).toBe(10);
  });

  it("core RaceLedgerEntryの値(kaisaiDate・promptVersion・hasResult・hasPayout・horses・集計値)をそのまま引き継ぐこと", () => {
    const source = entry({
      kaisaiDate: "20260708",
      promptVersion: "2026-07-14.1",
      hasResult: true,
      hasPayout: true,
      horses: [
        {
          umaban: 1,
          mark: "◎",
          adjustedProb: 0.5,
          placeOddsMin: 2.0,
          ev: 1.0,
          isPositive: true,
          finishPosition: 1,
          isPlaced: true,
          stake: 100,
          payout: 300,
          payoutSource: "actual",
        },
      ],
      totalStake: 100,
      totalReturn: 300,
      recoveryRate: 3.0,
      betCount: 1,
    });
    const [view] = buildRaceLedgerView([source]);
    expect(view!.kaisaiDate).toBe("20260708");
    expect(view!.promptVersion).toBe("2026-07-14.1");
    expect(view!.hasResult).toBe(true);
    expect(view!.hasPayout).toBe(true);
    expect(view!.horses).toEqual(source.horses);
    expect(view!.totalStake).toBe(100);
    expect(view!.totalReturn).toBe(300);
    expect(view!.recoveryRate).toBe(3.0);
    expect(view!.betCount).toBe(1);
    expect(view!.analysisId).toBe(1);
    expect(view!.analyzedAt).toBe("2026-07-08T10:00:00.000Z");
  });

  it("結果未取込(hasResult=false)の値もそのまま引き継ぐこと", () => {
    const [view] = buildRaceLedgerView([
      entry({ hasResult: false, hasPayout: false }),
    ]);
    expect(view!.hasResult).toBe(false);
    expect(view!.hasPayout).toBe(false);
  });

  it("開催日(kaisaiDate)降順に並べ替えること", () => {
    const older = entry({ raceId: "202605020801", kaisaiDate: "20260701" });
    const newer = entry({ raceId: "202605020802", kaisaiDate: "20260710" });
    const views = buildRaceLedgerView([older, newer]);
    expect(views.map((v) => v.raceId)).toEqual(["202605020802", "202605020801"]);
  });

  it("開催日不明(kaisaiDate=null)は最後に並べること", () => {
    const unknown = entry({ raceId: "202605020801", kaisaiDate: null });
    const known = entry({ raceId: "202605020802", kaisaiDate: "20260701" });
    const views = buildRaceLedgerView([unknown, known]);
    expect(views.map((v) => v.raceId)).toEqual(["202605020802", "202605020801"]);
  });

  it("地方(NAR)レースでkaisaiDateがnullの場合、raceIdから開催日を補完すること", () => {
    // 場コード54 → 高知(地方)。7〜10桁目 0712 → 7月12日。
    const [view] = buildRaceLedgerView([
      entry({ raceId: "202654071210", kaisaiDate: null }),
    ]);
    expect(view!.kaisaiDate).toBe("20260712");
  });

  it("中央レースでkaisaiDateがnullの場合は補完せず日付不明(null)のままとすること", () => {
    const [view] = buildRaceLedgerView([
      entry({ raceId: "202605020811", kaisaiDate: null }),
    ]);
    expect(view!.kaisaiDate).toBeNull();
  });

  it("開催日が同じ(または双方null)場合はレースID昇順で決定的に並べること", () => {
    const a = entry({ raceId: "202605020802", kaisaiDate: "20260701" });
    const b = entry({ raceId: "202605020801", kaisaiDate: "20260701" });
    const views = buildRaceLedgerView([a, b]);
    expect(views.map((v) => v.raceId)).toEqual(["202605020801", "202605020802"]);
  });

  it("空配列を渡せば空配列を返すこと", () => {
    expect(buildRaceLedgerView([])).toEqual([]);
  });
});
