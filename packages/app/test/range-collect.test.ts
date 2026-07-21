/**
 * 期間バッチの収集ドライバ(collectRaceIdsOverRange)のテスト(タスクB2a)。
 *
 * UI/IPC・LLM分析(analyzeOne)は一切関与しない「純ロジック層」であることをスタブ注入で検証する。
 * 実ネットワーク・実DBへのアクセスは行わない(すべて依存注入のスタブ)。
 */

import { describe, expect, it, vi } from "vitest";
import type { KaisaiDate, RaceId } from "@keiba/core";
import { parseKaisaiDate } from "@keiba/core";

import {
  collectRaceIdsOverRange,
  type RangeCollectDeps,
} from "../src/main/range-collect.js";
import type { RaceListEntry } from "@keiba/core";

/** テスト用の最小 RaceListEntry を作る。grade を渡すとJpn絞り込みテストに使える。 */
function entry(raceId: string, grade?: string): RaceListEntry {
  return {
    raceId: raceId as RaceId,
    name: `${raceId}のレース`,
    courseType: "ダ",
    distance: 1600,
    entryCount: 12,
    raceNumber: 1,
    ...(grade !== undefined ? { grade } : {}),
  };
}

const CURRENT_VERSION = "2026-07-19.4-clip015";

/** 依存をすべて指定できる最小のデフォルトを組み立てる(個々のテストで上書きする)。 */
function makeDeps(overrides: Partial<RangeCollectDeps> = {}): RangeCollectDeps {
  return {
    listDayRaces: vi.fn(async () => []),
    analyzedPromptVersionsOf: vi.fn(() => []),
    currentPromptVersion: CURRENT_VERSION,
    ...overrides,
  };
}

describe("collectRaceIdsOverRange(期間バッチの純ロジック収集ドライバ)", () => {
  it("空日(entries=[])は empty として記録し failure にしないこと", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260711");
    const deps = makeDeps({
      listDayRaces: vi.fn(async () => []),
    });

    const result = await collectRaceIdsOverRange(from, to, "central", deps);

    expect(result.perDayOutcome).toEqual([
      { date: "20260710", status: "empty" },
      { date: "20260711", status: "empty" },
    ]);
    expect(result.failureDays).toEqual([]);
    expect(result.totalRaces).toBe(0);
  });

  it("lister が throw した日は failure として記録し、後続日の処理を継続すること", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260712");
    const listDayRaces = vi.fn(async (date: KaisaiDate) => {
      if (date === "20260711") {
        throw new Error("ネットワークエラー");
      }
      return [entry(`race-${date}`)];
    });
    const deps = makeDeps({ listDayRaces });

    const result = await collectRaceIdsOverRange(from, to, "central", deps);

    expect(result.perDayOutcome[1]).toEqual({
      date: "20260711",
      status: "failure",
      error: "ネットワークエラー",
    });
    expect(result.failureDays).toEqual(["20260711"]);
    // 失敗日以外(710・712)は継続して処理されていること。
    expect(result.perDayOutcome[0]?.status).toBe("hasRaces");
    expect(result.perDayOutcome[2]?.status).toBe("hasRaces");
  });

  it("空日とエラー日をアウトカム型で区別できること", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260711");
    const listDayRaces = vi.fn(async (date: KaisaiDate) => {
      if (date === "20260710") {
        return [];
      }
      throw new Error("boom");
    });
    const deps = makeDeps({ listDayRaces });

    const result = await collectRaceIdsOverRange(from, to, "central", deps);

    expect(result.perDayOutcome[0]).toEqual({
      date: "20260710",
      status: "empty",
    });
    expect(result.perDayOutcome[1]).toEqual({
      date: "20260711",
      status: "failure",
      error: "boom",
    });
  });

  it("target=nar-jpn の時のみ filterJpnOnlyEntries を適用すること(central/nar-allでは非適用)", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260710");
    const listDayRaces = vi.fn(async () => [
      entry("202642071001", "Jpn1"),
      entry("202642071002"), // gradeなし(通常戦)
    ]);

    const jpnResult = await collectRaceIdsOverRange(
      from,
      to,
      "nar-jpn",
      makeDeps({ listDayRaces }),
    );
    expect(jpnResult.targetRaces.map((t) => t.raceId)).toEqual(["202642071001"]);
    expect(jpnResult.totalRaces).toBe(1);

    const allResult = await collectRaceIdsOverRange(
      from,
      to,
      "nar-all",
      makeDeps({ listDayRaces }),
    );
    expect([...allResult.targetRaces.map((t) => t.raceId)].sort()).toEqual(
      ["202642071001", "202642071002"].sort(),
    );

    const centralResult = await collectRaceIdsOverRange(
      from,
      to,
      "central",
      makeDeps({ listDayRaces }),
    );
    expect([...centralResult.targetRaces.map((t) => t.raceId)].sort()).toEqual(
      ["202642071001", "202642071002"].sort(),
    );
  });

  describe("dedup(既分析との突合)の3ケース", () => {
    it("現行版promptVersionと一致する既分析があるraceIdは除外し、skippedにカウントすること", async () => {
      const from = parseKaisaiDate("20260710");
      const to = parseKaisaiDate("20260710");
      const listDayRaces = vi.fn(async () => [entry("202642071001")]);
      const analyzedPromptVersionsOf = vi.fn((raceId: RaceId) =>
        raceId === "202642071001" ? [CURRENT_VERSION] : [],
      );

      const result = await collectRaceIdsOverRange(
        from,
        to,
        "central",
        makeDeps({ listDayRaces, analyzedPromptVersionsOf }),
      );

      expect(result.targetRaces.map((t) => t.raceId)).toEqual([]);
      expect(result.skippedAlreadyAnalyzed).toBe(1);
      expect(result.totalRaces).toBe(1);
    });

    it("別版promptVersionで分析済みのraceIdは実行対象に含めること", async () => {
      const from = parseKaisaiDate("20260710");
      const to = parseKaisaiDate("20260710");
      const listDayRaces = vi.fn(async () => [entry("202642071001")]);
      const analyzedPromptVersionsOf = vi.fn(() => ["2026-07-19.3"]);

      const result = await collectRaceIdsOverRange(
        from,
        to,
        "central",
        makeDeps({ listDayRaces, analyzedPromptVersionsOf }),
      );

      expect(result.targetRaces.map((t) => t.raceId)).toEqual(["202642071001"]);
      expect(result.skippedAlreadyAnalyzed).toBe(0);
    });

    it("promptVersion=null(LLM完全スキップ・旧データ)のraceIdは実行対象に含めること", async () => {
      const from = parseKaisaiDate("20260710");
      const to = parseKaisaiDate("20260710");
      const listDayRaces = vi.fn(async () => [entry("202642071001")]);
      const analyzedPromptVersionsOf = vi.fn(() => [null]);

      const result = await collectRaceIdsOverRange(
        from,
        to,
        "central",
        makeDeps({ listDayRaces, analyzedPromptVersionsOf }),
      );

      expect(result.targetRaces.map((t) => t.raceId)).toEqual(["202642071001"]);
      expect(result.skippedAlreadyAnalyzed).toBe(0);
    });

    it("同一raceIdに複数分析があり1件でも現行版一致なら除外すること", async () => {
      const from = parseKaisaiDate("20260710");
      const to = parseKaisaiDate("20260710");
      const listDayRaces = vi.fn(async () => [entry("202642071001")]);
      const analyzedPromptVersionsOf = vi.fn(() => [
        null,
        "2026-07-19.3",
        CURRENT_VERSION,
      ]);

      const result = await collectRaceIdsOverRange(
        from,
        to,
        "central",
        makeDeps({ listDayRaces, analyzedPromptVersionsOf }),
      );

      expect(result.targetRaces.map((t) => t.raceId)).toEqual([]);
      expect(result.skippedAlreadyAnalyzed).toBe(1);
    });
  });

  it("3値整合: total = skipped + 実行対象数であり、failureDaysのレースはtotalに含まれないこと", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260712");
    const listDayRaces = vi.fn(async (date: KaisaiDate) => {
      if (date === "20260711") {
        throw new Error("boom");
      }
      if (date === "20260710") {
        return [entry("202642071001"), entry("202642071002")];
      }
      return [entry("202642071201")];
    });
    const analyzedPromptVersionsOf = vi.fn((raceId: RaceId) =>
      raceId === "202642071001" ? [CURRENT_VERSION] : [],
    );

    const result = await collectRaceIdsOverRange(
      from,
      to,
      "central",
      makeDeps({ listDayRaces, analyzedPromptVersionsOf }),
    );

    // 収集できたのは 710の2件 + 712の1件 = 3件(711はfailureで収集できていない)。
    expect(result.totalRaces).toBe(3);
    expect(result.skippedAlreadyAnalyzed).toBe(1);
    expect(result.targetRaces).toHaveLength(2);
    expect(result.totalRaces).toBe(
      result.skippedAlreadyAnalyzed + result.targetRaces.length,
    );
    expect(result.failureDays).toEqual(["20260711"]);
  });

  it("渡された現行版promptVersionを全dedup判定で一貫使用すること(版スナップショット)", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260711");
    const listDayRaces = vi.fn(async (date: KaisaiDate) => [
      entry(date === "20260710" ? "202642071001" : "202642071101"),
    ]);
    const analyzedPromptVersionsOf = vi.fn((raceId: RaceId) =>
      raceId === "202642071001" || raceId === "202642071101"
        ? [CURRENT_VERSION]
        : [],
    );

    const result = await collectRaceIdsOverRange(
      from,
      to,
      "central",
      makeDeps({ listDayRaces, analyzedPromptVersionsOf }),
    );

    // 2日分とも同じ現行版と突合され、両方とも除外されること。
    expect(result.skippedAlreadyAnalyzed).toBe(2);
    expect(result.targetRaces.map((t) => t.raceId)).toEqual([]);
  });

  it("確定前LLM呼出ゼロ: ドライバの依存型に analyzeOne 相当のフィールドが無いこと(構造的担保)", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260710");
    // analyzeOne を装った余剰プロパティを deps に混入させても、ドライバが型上それを
    // 呼び出す手段(deps.analyzeOne という参照)を持たないことを確認する。
    const analyzeOneSpy = vi.fn();
    const deps = {
      ...makeDeps({ listDayRaces: vi.fn(async () => [entry("202642071001")]) }),
      analyzeOne: analyzeOneSpy,
    };

    await collectRaceIdsOverRange(from, to, "central", deps);

    expect(analyzeOneSpy).not.toHaveBeenCalled();
  });

  it("onProgress: 日ごとに件数・順序どおり通知されること", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260712");
    const onProgress = vi.fn();
    const deps = makeDeps({
      listDayRaces: vi.fn(async () => []),
      onProgress,
    });

    await collectRaceIdsOverRange(from, to, "central", deps);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      completedDays: 1,
      totalDays: 3,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      completedDays: 2,
      totalDays: 3,
    });
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      completedDays: 3,
      totalDays: 3,
    });
  });

  it("shouldCancel: 日境界で打ち切り、収集済みまでで確定し中断フラグを立てること", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260713");
    let callCount = 0;
    const listDayRaces = vi.fn(async () => {
      callCount += 1;
      return [entry(`20260${710 + callCount - 1}01`)];
    });
    // 2日目の処理後にキャンセル要求が立つ想定(境界確認は次の日の着手前)。
    const shouldCancel = vi.fn(() => callCount >= 2);
    const deps = makeDeps({ listDayRaces, shouldCancel });

    const result = await collectRaceIdsOverRange(from, to, "central", deps);

    expect(result.cancelled).toBe(true);
    // 710・711の2日だけ処理され、712・713は打ち切られて未処理であること。
    expect(result.perDayOutcome).toHaveLength(2);
    expect(listDayRaces).toHaveBeenCalledTimes(2);
  });

  it("shouldCancel が一度も true を返さなければ cancelled は false のままであること", async () => {
    const from = parseKaisaiDate("20260710");
    const to = parseKaisaiDate("20260711");
    const deps = makeDeps({
      listDayRaces: vi.fn(async () => []),
      shouldCancel: vi.fn(() => false),
    });

    const result = await collectRaceIdsOverRange(from, to, "central", deps);

    expect(result.cancelled).toBe(false);
    expect(result.perDayOutcome).toHaveLength(2);
  });

  describe("targetRacesの日跨ぎ整合性(タスクC1: 中央のraceIdは暦日を持たないため、収集時の列挙日をレース単位で運ぶ)", () => {
    it("複数日を跨ぐ収集で、各レースのkaisaiDateがそのレースが見つかった列挙日と一致すること(単一共有日にならないこと)", async () => {
      const from = parseKaisaiDate("20260710");
      const to = parseKaisaiDate("20260712");
      const listDayRaces = vi.fn(async (date: KaisaiDate) => {
        if (date === "20260711") {
          return []; // 空日を挟んでも日付対応がずれないことも確認する。
        }
        return [entry(`race-${date}`)];
      });
      const deps = makeDeps({ listDayRaces });

      const result = await collectRaceIdsOverRange(from, to, "central", deps);

      expect(result.targetRaces).toEqual([
        { raceId: "race-20260710", kaisaiDate: "20260710" },
        { raceId: "race-20260712", kaisaiDate: "20260712" },
      ]);
    });

    it("同一日に複数レースがあっても、全レースにその日のkaisaiDateが付与されること", async () => {
      const from = parseKaisaiDate("20260710");
      const to = parseKaisaiDate("20260710");
      const listDayRaces = vi.fn(async () => [
        entry("202605020811"),
        entry("202605020812"),
      ]);
      const deps = makeDeps({ listDayRaces });

      const result = await collectRaceIdsOverRange(from, to, "central", deps);

      expect(result.targetRaces).toEqual([
        { raceId: "202605020811", kaisaiDate: "20260710" },
        { raceId: "202605020812", kaisaiDate: "20260710" },
      ]);
    });
  });
});
