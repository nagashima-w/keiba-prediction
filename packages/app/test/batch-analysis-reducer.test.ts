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
  type BatchAppState,
} from "../src/renderer/batch-analysis-reducer.js";
import type {
  AnalysisResult,
  BatchProgress,
  BatchRaceOutcome,
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
