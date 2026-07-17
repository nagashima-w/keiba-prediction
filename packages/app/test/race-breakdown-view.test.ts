import { describe, expect, it } from "vitest";

import type { RaceBreakdown } from "@keiba/core";
import { buildRaceBreakdownView } from "../src/main/race-breakdown-view.js";

/** テスト用のcore RaceBreakdownを最小構成で組み立てる。 */
function breakdown(overrides: Partial<RaceBreakdown> = {}): RaceBreakdown {
  return {
    raceId: "202605020811", // 場コード05 → 東京、末尾2桁11 → 11R。
    analysisId: 1,
    analyzedAt: "2026-07-08T10:00:00.000Z",
    kaisaiDate: "20260708",
    promptVersion: "2026-07-14.1",
    horses: [],
    totalStake: 0,
    totalReturn: 0,
    recoveryRate: null,
    betCount: 0,
    ...overrides,
  };
}

describe("buildRaceBreakdownView(検証画面: レース単位の予実ブレークダウンの表示用組み立て。Task#34)", () => {
  it("raceIdから会場名・レース番号を導出して付与すること(既存の会場名解決ロジックを再利用)", () => {
    const [view] = buildRaceBreakdownView([breakdown({ raceId: "202605020811" })]);
    expect(view!.venueName).toBe("東京");
    expect(view!.raceNumber).toBe(11);
  });

  it("地方(NAR)のレースIDでも会場名を導出すること", () => {
    // 場コード54 → 高知。末尾2桁10 → 10R。
    const [view] = buildRaceBreakdownView([
      breakdown({ raceId: "202654071210" }),
    ]);
    expect(view!.venueName).toBe("高知");
    expect(view!.raceNumber).toBe(10);
  });

  it("core RaceBreakdownの値(kaisaiDate・promptVersion・horses・集計値)をそのまま引き継ぐこと", () => {
    const source = breakdown({
      kaisaiDate: "20260708",
      promptVersion: "2026-07-14.1",
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
    const [view] = buildRaceBreakdownView([source]);
    expect(view!.kaisaiDate).toBe("20260708");
    expect(view!.promptVersion).toBe("2026-07-14.1");
    expect(view!.horses).toEqual(source.horses);
    expect(view!.totalStake).toBe(100);
    expect(view!.totalReturn).toBe(300);
    expect(view!.recoveryRate).toBe(3.0);
    expect(view!.betCount).toBe(1);
    expect(view!.analysisId).toBe(1);
    expect(view!.analyzedAt).toBe("2026-07-08T10:00:00.000Z");
  });

  it("開催日(kaisaiDate)降順に並べ替えること", () => {
    const older = breakdown({ raceId: "202605020801", kaisaiDate: "20260701" });
    const newer = breakdown({ raceId: "202605020802", kaisaiDate: "20260710" });
    const views = buildRaceBreakdownView([older, newer]);
    expect(views.map((v) => v.raceId)).toEqual(["202605020802", "202605020801"]);
  });

  it("開催日不明(kaisaiDate=null)は最後に並べること", () => {
    const unknown = breakdown({ raceId: "202605020801", kaisaiDate: null });
    const known = breakdown({ raceId: "202605020802", kaisaiDate: "20260701" });
    const views = buildRaceBreakdownView([unknown, known]);
    expect(views.map((v) => v.raceId)).toEqual(["202605020802", "202605020801"]);
  });

  it("地方(NAR)レースでkaisaiDateがnullの場合、raceIdから開催日を補完すること(ユーザーフィードバック対応)", () => {
    // 場コード54 → 高知(地方)。7〜10桁目 0712 → 7月12日。
    const [view] = buildRaceBreakdownView([
      breakdown({ raceId: "202654071210", kaisaiDate: null }),
    ]);
    expect(view!.kaisaiDate).toBe("20260712");
  });

  it("中央レースでkaisaiDateがnullの場合は補完せず日付不明(null)のままとすること", () => {
    // 場コード05 → 東京(中央)。7〜10桁目は回次・日次であり日付ではないため復元不可。
    const [view] = buildRaceBreakdownView([
      breakdown({ raceId: "202605020811", kaisaiDate: null }),
    ]);
    expect(view!.kaisaiDate).toBeNull();
  });

  it("kaisaiDateが記録済み(非null)の場合は補完せず記録値を優先すること", () => {
    const [view] = buildRaceBreakdownView([
      breakdown({ raceId: "202654071210", kaisaiDate: "20260701" }),
    ]);
    expect(view!.kaisaiDate).toBe("20260701"); // raceId由来の20260712ではなく記録値
  });

  it("地方レースでもraceIdの月日が暦として不正なら補完せず日付不明にフォールバックすること", () => {
    // 場コード54(地方)だが、7〜10桁目が1332(13月32日)で実在しない。
    // parseRaceIdでは弾かれる値だが、buildRaceBreakdownViewはcore側で検証済みの値を
    // そのまま受け取る前提のため、防御的にフォールバックを確認する。
    const [view] = buildRaceBreakdownView([
      breakdown({ raceId: "202654133201", kaisaiDate: null }),
    ]);
    expect(view!.kaisaiDate).toBeNull();
  });

  it("補完後の開催日がソートに反映されること(地方レースが正しい日付位置に並ぶ)", () => {
    // 場コード54(高知)、raceIdから7/12に補完される地方レース。
    const narUnknown = breakdown({ raceId: "202654071210", kaisaiDate: null });
    // 記録済みkaisaiDateが7/1の中央レース(7/12より古い)。
    const centralKnown = breakdown({
      raceId: "202605020801",
      kaisaiDate: "20260701",
    });
    const views = buildRaceBreakdownView([centralKnown, narUnknown]);
    // 補完された7/12(NAR)が7/1(中央)より新しいので先に並ぶこと。
    expect(views.map((v) => v.raceId)).toEqual([
      "202654071210",
      "202605020801",
    ]);
  });

  it("開催日が同じ(または双方null)場合はレースID昇順で決定的に並べること", () => {
    const a = breakdown({ raceId: "202605020802", kaisaiDate: "20260701" });
    const b = breakdown({ raceId: "202605020801", kaisaiDate: "20260701" });
    const views = buildRaceBreakdownView([a, b]);
    expect(views.map((v) => v.raceId)).toEqual(["202605020801", "202605020802"]);

    const c = breakdown({ raceId: "202605020804", kaisaiDate: null });
    const d = breakdown({ raceId: "202605020803", kaisaiDate: null });
    const viewsNull = buildRaceBreakdownView([c, d]);
    expect(viewsNull.map((v) => v.raceId)).toEqual([
      "202605020803",
      "202605020804",
    ]);
  });

  it("空配列を渡せば空配列を返すこと", () => {
    expect(buildRaceBreakdownView([])).toEqual([]);
  });
});
