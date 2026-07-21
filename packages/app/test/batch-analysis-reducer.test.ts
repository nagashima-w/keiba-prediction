/**
 * 一括分析 reducer(純関数)のテスト。
 *
 * 複数選択のトグル/会場一括選択・解除/全解除、一括分析の開始→進捗→完了、中断要求、
 * レース詳細の折りたたみ、実行中の選択変更ガード(in-flight の一括版)を固定する。
 */

import { describe, expect, it } from "vitest";

import {
  batchAnalysisReducer,
  createInitialBatchState,
  createInitialPeriodBatchState,
  periodBatchReducer,
  type BatchAppState,
} from "../src/renderer/batch-analysis-reducer.js";
import type {
  AnalysisResult,
  BatchProgress,
  BatchRaceOutcome,
  PeriodBatchCollectResult,
  RaceListItem,
} from "../src/shared/analysis-types.js";

const race = (raceId: string, raceNumber: number, venue: string): RaceListItem => ({
  raceId,
  name: `${raceNumber}R テスト`,
  courseType: "芝",
  distance: 1600,
  entryCount: 12,
  venue,
  raceNumber,
});

/** 東京3レース・中山2レースの一覧を用意する。 */
const RACES: RaceListItem[] = [
  race("T1", 1, "東京"),
  race("T2", 2, "東京"),
  race("T3", 3, "東京"),
  race("N1", 1, "中山"),
  race("N2", 2, "中山"),
];

const fakeResult = (raceId: string): AnalysisResult => ({
  raceId,
  venueName: "東京",
  raceName: `${raceId}特別`,
  courseType: "芝",
  distance: 1600,
  date: "2026/07/12",
  dateApproximate: false,
  llmUsed: false,
  llmSkippedReason: null,
  fallback: false,
  fallbackReason: null,
  oddsStatus: "result",
  rows: [],
  warnings: [],
  analyzedAt: "2026-07-12T00:00:00.000Z",
});

/** レース一覧を積んだ初期状態を作る。 */
function withRaces(): BatchAppState {
  const s = createInitialBatchState("20260712");
  return batchAnalysisReducer(s, { type: "レース取得成功", races: RACES });
}

describe("createInitialBatchState(初期状態)", () => {
  it("日付を保持し、選択なし・未実行で開始する", () => {
    const s = createInitialBatchState("20260712");
    expect(s.selection.date).toBe("20260712");
    expect(s.selection.selectedRaceIds).toEqual([]);
    expect(s.run.running).toBe(false);
    expect(s.run.outcomes).toEqual([]);
    expect(s.run.expandedRaceIds).toEqual([]);
  });

  it("開催区分(venueKind)は既定で中央(central)になる", () => {
    const s = createInitialBatchState("20260712");
    expect(s.selection.venueKind).toBe("central");
  });

  it("Jpnのみ絞り込み(jpnOnly)は既定でfalseになる(タスクB1)", () => {
    const s = createInitialBatchState("20260712");
    expect(s.selection.jpnOnly).toBe(false);
  });
});

describe("開催区分変更(中央/地方(全て)/地方(Jpnのみ)の切替。タスクB1でjpnOnlyを追加)", () => {
  /** 選択済みレースがある状態(T1・T2選択済み、central・jpnOnly=false)を作る。 */
  function withSelection(): BatchAppState {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T2" });
    return s;
  }

  it("開催区分を変更すると venueKind が更新され、旧選択・旧バッチ結果がクリアされる", () => {
    const before = withSelection();
    expect(before.selection.selectedRaceIds.length).toBeGreaterThan(0);

    const s = batchAnalysisReducer(before, {
      type: "開催区分変更",
      venueKind: "nar",
      jpnOnly: false,
    });
    expect(s.selection.venueKind).toBe("nar");
    expect(s.selection.jpnOnly).toBe(false);
    expect(s.selection.selectedRaceIds).toEqual([]);
    expect(s.run.outcomes).toEqual([]);
  });

  it("実行中は開催区分変更を無視する(in-flightガード)", () => {
    let s = withSelection();
    s = batchAnalysisReducer(s, { type: "一括分析開始" });
    const before = s;
    s = batchAnalysisReducer(s, {
      type: "開催区分変更",
      venueKind: "nar",
      jpnOnly: false,
    });
    expect(s).toBe(before);
  });

  it("同じ開催区分・同じjpnOnlyを指定した場合はno-op(状態を参照等価のまま返し、選択も維持される)", () => {
    const before = withSelection();
    expect(before.selection.venueKind).toBe("central");
    expect(before.selection.jpnOnly).toBe(false);
    expect(before.selection.selectedRaceIds).toEqual(["T1", "T2"]);

    const s = batchAnalysisReducer(before, {
      type: "開催区分変更",
      venueKind: "central",
      jpnOnly: false,
    });
    // 参照等価(no-op): 同一venueKind・同一jpnOnly指定では新しいオブジェクトを作らない。
    expect(s).toBe(before);
    expect(s.selection.venueKind).toBe("central");
    expect(s.selection.selectedRaceIds).toEqual(["T1", "T2"]);
  });

  it("異なる開催区分を指定した場合は選択・旧バッチ結果がクリアされる(no-opとの対比)", () => {
    const before = withSelection();
    expect(before.selection.selectedRaceIds).toEqual(["T1", "T2"]);

    const s = batchAnalysisReducer(before, {
      type: "開催区分変更",
      venueKind: "nar",
      jpnOnly: false,
    });
    expect(s).not.toBe(before);
    expect(s.selection.venueKind).toBe("nar");
    expect(s.selection.selectedRaceIds).toEqual([]);
  });

  it("同じ開催区分(nar)でもjpnOnlyだけが変わる場合はno-opにならず、選択がクリアされる(地方全て→地方Jpnのみの切替)", () => {
    let before = withRaces();
    before = batchAnalysisReducer(before, {
      type: "開催区分変更",
      venueKind: "nar",
      jpnOnly: false,
    });
    before = batchAnalysisReducer(before, { type: "レース選択トグル", raceId: "T1" });
    expect(before.selection.selectedRaceIds).toEqual(["T1"]);

    const s = batchAnalysisReducer(before, {
      type: "開催区分変更",
      venueKind: "nar",
      jpnOnly: true,
    });
    expect(s).not.toBe(before);
    expect(s.selection.venueKind).toBe("nar");
    expect(s.selection.jpnOnly).toBe(true);
    expect(s.selection.selectedRaceIds).toEqual([]);
  });
});

describe("複数選択(トグル・会場一括・全解除)", () => {
  it("レース選択トグル: 未選択なら追加、選択済みなら解除する", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T2" });
    expect(s.selection.selectedRaceIds).toEqual(["T2"]);
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    expect(s.selection.selectedRaceIds).toEqual(["T2", "T1"]);
    // もう一度押すと解除。
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T2" });
    expect(s.selection.selectedRaceIds).toEqual(["T1"]);
  });

  it("会場全選択: その会場のレースを重複なく追加する", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T2" });
    s = batchAnalysisReducer(s, {
      type: "会場全選択",
      raceIds: ["T1", "T2", "T3"],
    });
    // 既に入っていた T2 は重複させない。
    expect([...s.selection.selectedRaceIds].sort()).toEqual(["T1", "T2", "T3"]);
  });

  it("会場全解除: その会場のレースだけを選択から外す", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, {
      type: "会場全選択",
      raceIds: ["T1", "T2", "T3"],
    });
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "N1" });
    s = batchAnalysisReducer(s, {
      type: "会場全解除",
      raceIds: ["T1", "T2", "T3"],
    });
    expect(s.selection.selectedRaceIds).toEqual(["N1"]);
  });

  it("全解除: すべての選択を外す", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, {
      type: "会場全選択",
      raceIds: ["T1", "T2", "T3"],
    });
    s = batchAnalysisReducer(s, { type: "全解除" });
    expect(s.selection.selectedRaceIds).toEqual([]);
  });
});

describe("一括分析の開始→進捗→完了", () => {
  it("一括分析開始: 選択をレース一覧順にスナップショットし、全レースをpendingで開始する", () => {
    let s = withRaces();
    // わざと一覧と逆順で選ぶ。
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T3" });
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "一括分析開始" });

    expect(s.run.running).toBe(true);
    expect(s.run.canceling).toBe(false);
    // 実行対象は一覧順(T1→T3)に並ぶ。
    expect(s.run.outcomes.map((o) => o.raceId)).toEqual(["T1", "T3"]);
    expect(s.run.outcomes.every((o) => o.status === "pending")).toBe(true);
  });

  it("一括進捗更新: 進捗を反映する(runId不一致は無視)", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "一括分析開始" });
    const runId = s.run.runId;

    const progress: BatchProgress = {
      completedRaces: 0,
      totalRaces: 1,
      currentRaceId: "T1",
      currentRaceName: "1R テスト",
      stage: { stage: "スクレイピング", current: null, total: null, message: "取得中" },
    };
    s = batchAnalysisReducer(s, { type: "一括進捗更新", runId, progress });
    expect(s.run.progress).toEqual(progress);

    // 古い runId の進捗は無視される。
    const before = s;
    s = batchAnalysisReducer(s, {
      type: "一括進捗更新",
      runId: runId - 1,
      progress: { ...progress, completedRaces: 99 },
    });
    expect(s).toBe(before);
  });

  it("一括分析完了: アウトカムを反映し running を落とす(runId不一致は無視)", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T2" });
    s = batchAnalysisReducer(s, { type: "一括分析開始" });
    const runId = s.run.runId;

    const outcomes: BatchRaceOutcome[] = [
      {
        raceId: "T1",
        raceName: "T1特別",
        status: "success",
        result: fakeResult("T1"),
        error: null,
      },
      {
        raceId: "T2",
        raceName: null,
        status: "failure",
        result: null,
        error: "取得失敗",
      },
    ];

    // 古い runId の完了は無視される。
    const beforeComplete = s;
    s = batchAnalysisReducer(s, {
      type: "一括分析完了",
      runId: runId - 1,
      outcomes,
    });
    expect(s).toBe(beforeComplete);

    s = batchAnalysisReducer(s, { type: "一括分析完了", runId, outcomes });
    expect(s.run.running).toBe(false);
    expect(s.run.progress).toBeNull();
    expect(s.run.outcomes[0]!.status).toBe("success");
    expect(s.run.outcomes[0]!.result?.raceId).toBe("T1");
    expect(s.run.outcomes[1]!.status).toBe("failure");
    expect(s.run.outcomes[1]!.error).toBe("取得失敗");
  });
});

describe("中断・折りたたみ・送信", () => {
  it("中断要求: 実行中は canceling を立てる(running は境界まで維持)", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "一括分析開始" });
    s = batchAnalysisReducer(s, { type: "中断要求" });
    expect(s.run.canceling).toBe(true);
    expect(s.run.running).toBe(true);
  });

  it("中断要求: 実行していないときは何もしない", () => {
    const s = withRaces();
    const after = batchAnalysisReducer(s, { type: "中断要求" });
    expect(after).toBe(s);
  });

  it("詳細開閉トグル: 既定は閉。押すと開き、もう一度押すと閉じる", () => {
    let s = withRaces();
    expect(s.run.expandedRaceIds).toEqual([]);
    s = batchAnalysisReducer(s, { type: "詳細開閉トグル", raceId: "T1" });
    expect(s.run.expandedRaceIds).toEqual(["T1"]);
    s = batchAnalysisReducer(s, { type: "詳細開閉トグル", raceId: "T1" });
    expect(s.run.expandedRaceIds).toEqual([]);
  });

  it("Discord送信: 開始→成功→失敗のステータス遷移", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "Discord送信開始" });
    expect(s.run.discordSend.status).toBe("sending");
    s = batchAnalysisReducer(s, { type: "Discord送信成功" });
    expect(s.run.discordSend.status).toBe("success");
    s = batchAnalysisReducer(s, { type: "Discord送信失敗", message: "失敗" });
    expect(s.run.discordSend.status).toBe("error");
    expect(s.run.discordSend.message).toBe("失敗");
  });
});

describe("in-flight ガード(実行中の選択変更を無視する)", () => {
  it("実行中はトグル・全選択・全解除・全解除が選択に反映されない", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "一括分析開始" });
    const selectedBefore = s.selection.selectedRaceIds;

    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T2" });
    expect(s.selection.selectedRaceIds).toBe(selectedBefore);
    s = batchAnalysisReducer(s, {
      type: "会場全選択",
      raceIds: ["T1", "T2", "T3"],
    });
    expect(s.selection.selectedRaceIds).toBe(selectedBefore);
    s = batchAnalysisReducer(s, { type: "全解除" });
    expect(s.selection.selectedRaceIds).toBe(selectedBefore);
  });

  it("実行中は日付変更・レース取得も無視する", () => {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "一括分析開始" });
    const before = s;
    s = batchAnalysisReducer(s, { type: "日付変更", date: "20260101" });
    expect(s).toBe(before);
    s = batchAnalysisReducer(s, { type: "レース取得開始" });
    expect(s).toBe(before);
  });
});

describe("日付変更・再取得で選択と旧結果をクリアする", () => {
  /** 選択して一括分析を完了させ、旧結果(run.outcomes)を持った状態を作る。 */
  function withCompletedRun(): BatchAppState {
    let s = withRaces();
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T1" });
    s = batchAnalysisReducer(s, { type: "レース選択トグル", raceId: "T2" });
    s = batchAnalysisReducer(s, { type: "一括分析開始" });
    const runId = s.run.runId;
    const outcomes: BatchRaceOutcome[] = [
      { raceId: "T1", raceName: "T1特別", status: "success", result: fakeResult("T1"), error: null },
      { raceId: "T2", raceName: "T2特別", status: "success", result: fakeResult("T2"), error: null },
    ];
    return batchAnalysisReducer(s, { type: "一括分析完了", runId, outcomes });
  }

  it("日付変更: 旧選択と旧バッチ結果(横断サマリ)がクリアされる", () => {
    const before = withCompletedRun();
    expect(before.selection.selectedRaceIds.length).toBeGreaterThan(0);
    expect(before.run.outcomes.length).toBeGreaterThan(0);

    const s = batchAnalysisReducer(before, {
      type: "日付変更",
      date: "20260101",
    });
    expect(s.selection.date).toBe("20260101");
    expect(s.selection.selectedRaceIds).toEqual([]);
    expect(s.run.outcomes).toEqual([]);
    expect(s.run.progress).toBeNull();
  });

  it("レース取得成功: 旧選択と旧バッチ結果がクリアされ、新しい一覧に差し替わる", () => {
    const before = withCompletedRun();
    const newRaces: RaceListItem[] = [race("X1", 1, "阪神")];
    const s = batchAnalysisReducer(before, {
      type: "レース取得成功",
      races: newRaces,
    });
    expect(s.selection.races).toEqual(newRaces);
    expect(s.selection.selectedRaceIds).toEqual([]);
    expect(s.run.outcomes).toEqual([]);
  });

  it("日付変更でも実行世代IDは巻き戻さない(遅延イベントの取り違え防止)", () => {
    const before = withCompletedRun();
    const runIdBefore = before.run.runId;
    const s = batchAnalysisReducer(before, {
      type: "日付変更",
      date: "20260101",
    });
    expect(s.run.runId).toBe(runIdBefore);
  });
});

describe("不変性", () => {
  it("状態遷移は元の state を破壊しない", () => {
    const before = withRaces();
    const snapshot = JSON.stringify(before);
    batchAnalysisReducer(before, { type: "レース選択トグル", raceId: "T1" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

/** テスト用のphase1収集結果を組み立てる(targetRaceIds件数だけ指定できる)。 */
function fakeCollectResult(
  targetRaceIdCount: number,
  overrides: Partial<PeriodBatchCollectResult> = {},
): PeriodBatchCollectResult {
  return {
    totalRaces: targetRaceIdCount,
    skippedAlreadyAnalyzed: 0,
    targetRaceIds: Array.from({ length: targetRaceIdCount }, (_, i) => `R${i}`),
    failureDays: [],
    perDayOutcome: [],
    cancelled: false,
    ...overrides,
  };
}

describe("periodBatchReducer(期間バッチの状態遷移。タスクB2b-1)", () => {
  describe("createInitialPeriodBatchState(初期状態)", () => {
    it("phaseはidle・収集結果は無し・実行状態は空であること", () => {
      const s = createInitialPeriodBatchState();
      expect(s.phase).toBe("idle");
      expect(s.collectResult).toBeNull();
      expect(s.collectError).toBeNull();
      expect(s.needsReconfirmation).toBe(false);
      expect(s.run.running).toBe(false);
      expect(s.run.outcomes).toEqual([]);
    });
  });

  describe("収集(phase1)の開始→成功/失敗", () => {
    it("収集開始でphaseがcollectingになり、旧結果・旧エラーがクリアされること", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, {
        type: "期間バッチ収集失敗",
        message: "旧エラー",
      });
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      expect(s.phase).toBe("collecting");
      expect(s.collectResult).toBeNull();
      expect(s.collectError).toBeNull();
    });

    it("収集成功でphaseがcollectedになり、収集結果(3値+failureDays+cancelled+targetRaceIds)を保持すること", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      const result = fakeCollectResult(3, {
        totalRaces: 5,
        skippedAlreadyAnalyzed: 2,
        failureDays: ["20260711"],
        cancelled: true,
      });
      s = periodBatchReducer(s, { type: "期間バッチ収集成功", result });

      expect(s.phase).toBe("collected");
      expect(s.collectResult).toEqual(result);
      expect(s.collectResult?.totalRaces).toBe(5);
      expect(s.collectResult?.skippedAlreadyAnalyzed).toBe(2);
      expect(s.collectResult?.targetRaceIds).toHaveLength(3);
      expect(s.collectResult?.failureDays).toEqual(["20260711"]);
      expect(s.collectResult?.cancelled).toBe(true);
    });

    it("収集中でない状態(idle)での収集成功/失敗は無視されること(遅延イベントガード)", () => {
      const s = createInitialPeriodBatchState();
      const afterSuccess = periodBatchReducer(s, {
        type: "期間バッチ収集成功",
        result: fakeCollectResult(1),
      });
      expect(afterSuccess).toBe(s);

      const afterFailure = periodBatchReducer(s, {
        type: "期間バッチ収集失敗",
        message: "エラー",
      });
      expect(afterFailure).toBe(s);
    });

    it("収集失敗でphaseがidleへ戻り、エラーメッセージを保持すること", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      s = periodBatchReducer(s, {
        type: "期間バッチ収集失敗",
        message: "取得に失敗しました",
      });
      expect(s.phase).toBe("idle");
      expect(s.collectError).toBe("取得に失敗しました");
      expect(s.collectResult).toBeNull();
    });
  });

  describe("実行対象数>100で「要再確認」フラグが立つこと(境界値)", () => {
    it("実行対象数=100はneedsReconfirmation=falseであること", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      s = periodBatchReducer(s, {
        type: "期間バッチ収集成功",
        result: fakeCollectResult(100),
      });
      expect(s.needsReconfirmation).toBe(false);
    });

    it("実行対象数=101はneedsReconfirmation=trueであること", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      s = periodBatchReducer(s, {
        type: "期間バッチ収集成功",
        result: fakeCollectResult(101),
      });
      expect(s.needsReconfirmation).toBe(true);
    });
  });

  describe("実行確定ゲート(確定アクションを経るまでphase2〈進捗・完了〉を発火させない)", () => {
    it("収集前(idle)に実行確定を投げても running へ遷移しないこと", () => {
      const s = createInitialPeriodBatchState();
      const after = periodBatchReducer(s, { type: "期間バッチ実行確定" });
      expect(after).toBe(s);
      expect(after.phase).not.toBe("running");
    });

    it("収集中(collecting)に実行確定を投げても running へ遷移しないこと", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      const after = periodBatchReducer(s, { type: "期間バッチ実行確定" });
      expect(after).toBe(s);
      expect(after.phase).toBe("collecting");
    });

    it("収集成功(collected)後に実行確定を投げるとrunningへ遷移すること", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      s = periodBatchReducer(s, {
        type: "期間バッチ収集成功",
        result: fakeCollectResult(3),
      });
      s = periodBatchReducer(s, { type: "期間バッチ実行確定" });
      expect(s.phase).toBe("running");
      expect(s.run.running).toBe(true);
    });

    it("確定前(collected前)に進捗更新・完了を投げても無視されること(phase2が発火しないことの直接確認)", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      s = periodBatchReducer(s, {
        type: "期間バッチ収集成功",
        result: fakeCollectResult(3),
      });
      // まだ「実行確定」を投げていない(collected止まり)。
      const beforeConfirm = s;

      const progress: BatchProgress = {
        completedRaces: 0,
        totalRaces: 3,
        currentRaceId: "R0",
        currentRaceName: null,
        stage: { stage: "スクレイピング", current: null, total: null, message: "取得中" },
      };
      const afterProgress = periodBatchReducer(s, {
        type: "期間バッチ実行進捗更新",
        progress,
      });
      expect(afterProgress).toBe(beforeConfirm);

      const afterComplete = periodBatchReducer(s, {
        type: "期間バッチ実行完了",
        outcomes: [],
      });
      expect(afterComplete).toBe(beforeConfirm);
      expect(afterComplete.phase).toBe("collected");
    });

    it("確定後(running)は進捗更新・完了が反映されること", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      s = periodBatchReducer(s, {
        type: "期間バッチ収集成功",
        result: fakeCollectResult(2),
      });
      s = periodBatchReducer(s, { type: "期間バッチ実行確定" });

      const progress: BatchProgress = {
        completedRaces: 1,
        totalRaces: 2,
        currentRaceId: "R1",
        currentRaceName: null,
        stage: { stage: "LLM分析", current: null, total: null, message: "分析中" },
      };
      s = periodBatchReducer(s, { type: "期間バッチ実行進捗更新", progress });
      expect(s.run.progress).toEqual(progress);

      const outcomes: BatchRaceOutcome[] = [
        { raceId: "R0", raceName: null, status: "success", result: fakeResult("R0"), error: null },
        { raceId: "R1", raceName: null, status: "failure", result: null, error: "失敗" },
      ];
      s = periodBatchReducer(s, { type: "期間バッチ実行完了", outcomes });
      expect(s.phase).toBe("done");
      expect(s.run.running).toBe(false);
      expect(s.run.progress).toBeNull();
      expect(s.run.outcomes).toEqual(outcomes);
    });

    it("running中に再度実行確定を投げても二重発火しないこと(no-op)", () => {
      let s = createInitialPeriodBatchState();
      s = periodBatchReducer(s, { type: "期間バッチ収集開始" });
      s = periodBatchReducer(s, {
        type: "期間バッチ収集成功",
        result: fakeCollectResult(1),
      });
      s = periodBatchReducer(s, { type: "期間バッチ実行確定" });
      const runningState = s;
      s = periodBatchReducer(s, { type: "期間バッチ実行確定" });
      expect(s).toBe(runningState);
    });
  });

  describe("単日一括分析の状態遷移への回帰影響が無いこと", () => {
    it("periodBatchReducerはBatchAppState(単日)を一切変更しない(別スライス)", () => {
      const batchState = withRaces();
      const before = JSON.stringify(batchState);
      const periodState = createInitialPeriodBatchState();
      periodBatchReducer(periodState, { type: "期間バッチ収集開始" });
      expect(JSON.stringify(batchState)).toBe(before);
    });
  });
});
