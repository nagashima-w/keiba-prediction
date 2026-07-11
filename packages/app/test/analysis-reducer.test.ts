import { describe, expect, it } from "vitest";

import {
  analysisReducer,
  createInitialState,
  type AppState,
} from "../src/renderer/analysis-reducer.js";
import type {
  AnalysisResult,
  RaceListItem,
} from "../src/shared/analysis-types.js";

const fakeRace = (raceId: string, raceNumber: number): RaceListItem => ({
  raceId,
  name: `${raceNumber}R テスト`,
  courseType: "芝",
  distance: 1600,
  entryCount: 12,
  venue: "東京",
  raceNumber,
});

const fakeResult = (raceId: string): AnalysisResult => ({
  raceId,
  venueName: "東京",
  raceName: "テスト特別",
  courseType: "芝",
  distance: 1600,
  date: "2026/07/09",
  dateApproximate: true,
  llmUsed: false,
  llmSkippedReason: "APIキー未設定",
  fallback: false,
  oddsStatus: "result",
  rows: [],
  warnings: [],
  analyzedAt: "2026-07-09T00:00:00.000Z",
});

describe("createInitialState(初期状態)", () => {
  it("与えた日付を保持し、一覧・分析ともに空で開始する", () => {
    const s = createInitialState("20260709");
    expect(s.selection.date).toBe("20260709");
    expect(s.selection.races).toEqual([]);
    expect(s.selection.selectedRaceId).toBeNull();
    expect(s.analysis.result).toBeNull();
    expect(s.analysis.running).toBe(false);
  });
});

describe("analysisReducer(レース選択+分析の状態遷移)", () => {
  const init = (): AppState => createInitialState("20260709");

  it("日付変更: date を更新する", () => {
    const s = analysisReducer(init(), { type: "日付変更", date: "20260710" });
    expect(s.selection.date).toBe("20260710");
  });

  it("レース取得開始→成功: loading を経て一覧を格納する", () => {
    const loading = analysisReducer(init(), { type: "レース取得開始" });
    expect(loading.selection.loadingRaces).toBe(true);
    expect(loading.selection.racesError).toBeNull();

    const races = [fakeRace("202605020811", 11)];
    const done = analysisReducer(loading, { type: "レース取得成功", races });
    expect(done.selection.loadingRaces).toBe(false);
    expect(done.selection.races).toEqual(races);
  });

  it("レース取得失敗: エラーを保持し一覧を空にする", () => {
    const loading = analysisReducer(init(), { type: "レース取得開始" });
    const failed = analysisReducer(loading, {
      type: "レース取得失敗",
      message: "取得できませんでした",
    });
    expect(failed.selection.loadingRaces).toBe(false);
    expect(failed.selection.racesError).toBe("取得できませんでした");
    expect(failed.selection.races).toEqual([]);
  });

  it("レース選択: 選択IDを更新し、前回の分析結果・進捗・エラーをリセットする", () => {
    let s = analysisReducer(init(), { type: "レース選択", raceId: "202605020811" });
    s = analysisReducer(s, {
      type: "分析成功",
      raceId: "202605020811",
      result: fakeResult("202605020811"),
    });
    expect(s.analysis.result).not.toBeNull();

    s = analysisReducer(s, { type: "レース選択", raceId: "202605020812" });
    expect(s.selection.selectedRaceId).toBe("202605020812");
    expect(s.analysis.result).toBeNull();
    expect(s.analysis.progress).toBeNull();
    expect(s.analysis.analysisError).toBeNull();
  });

  it("分析開始→進捗更新→成功: running・progress・result を順に反映する", () => {
    let s = analysisReducer(init(), { type: "レース選択", raceId: "202605020811" });
    s = analysisReducer(s, { type: "分析開始" });
    expect(s.analysis.running).toBe(true);
    expect(s.analysis.result).toBeNull();
    expect(s.analysis.analysisError).toBeNull();

    s = analysisReducer(s, {
      type: "進捗更新",
      progress: { stage: "スコアリング", current: 2, total: 12, message: "中" },
    });
    expect(s.analysis.progress?.stage).toBe("スコアリング");
    expect(s.analysis.running).toBe(true);

    s = analysisReducer(s, {
      type: "分析成功",
      raceId: "202605020811",
      result: fakeResult("202605020811"),
    });
    expect(s.analysis.running).toBe(false);
    expect(s.analysis.result?.raceId).toBe("202605020811");
    expect(s.analysis.progress).toBeNull();
  });

  it("分析失敗: エラーを保持し running を落とす", () => {
    let s = analysisReducer(init(), { type: "レース選択", raceId: "202605020811" });
    s = analysisReducer(s, { type: "分析開始" });
    s = analysisReducer(s, {
      type: "分析失敗",
      raceId: "202605020811",
      message: "分析に失敗しました",
    });
    expect(s.analysis.running).toBe(false);
    expect(s.analysis.analysisError).toBe("分析に失敗しました");
  });

  it("in-flight ガード: 実行中に別レースへ切替後、旧レースの結果は反映されない", () => {
    // レースAを選び分析開始 → 途中でレースBへ切替 → 遅れて届いたAの成功は無視される。
    let s = analysisReducer(init(), { type: "レース選択", raceId: "A" });
    s = analysisReducer(s, { type: "分析開始" });
    s = analysisReducer(s, { type: "レース選択", raceId: "B" });

    s = analysisReducer(s, {
      type: "分析成功",
      raceId: "A",
      result: fakeResult("A"),
    });
    // 現在の選択は B。A の結果は表示されない。
    expect(s.analysis.result).toBeNull();

    // 遅れて届いた A の失敗も無視される。
    s = analysisReducer(s, {
      type: "分析失敗",
      raceId: "A",
      message: "Aの失敗",
    });
    expect(s.analysis.analysisError).toBeNull();
  });

  it("Discord送信: 開始→成功でステータスが sending→success へ遷移する", () => {
    let s = analysisReducer(init(), { type: "レース選択", raceId: "A" });
    s = analysisReducer(s, {
      type: "分析成功",
      raceId: "A",
      result: fakeResult("A"),
    });
    // 分析成功直後は送信していない(idle)。
    expect(s.analysis.discordSend.status).toBe("idle");

    s = analysisReducer(s, { type: "Discord送信開始" });
    expect(s.analysis.discordSend.status).toBe("sending");

    s = analysisReducer(s, { type: "Discord送信成功" });
    expect(s.analysis.discordSend.status).toBe("success");
    expect(s.analysis.discordSend.message).toBeNull();
  });

  it("Discord送信: 失敗でエラーメッセージを保持する", () => {
    let s = analysisReducer(init(), { type: "Discord送信開始" });
    s = analysisReducer(s, {
      type: "Discord送信失敗",
      message: "レート制限により送信できませんでした",
    });
    expect(s.analysis.discordSend.status).toBe("error");
    expect(s.analysis.discordSend.message).toBe(
      "レート制限により送信できませんでした",
    );
  });

  it("分析開始で前回のDiscord送信ステータスはリセットされる", () => {
    let s = analysisReducer(init(), { type: "レース選択", raceId: "A" });
    s = analysisReducer(s, { type: "Discord送信開始" });
    s = analysisReducer(s, { type: "Discord送信成功" });
    expect(s.analysis.discordSend.status).toBe("success");

    s = analysisReducer(s, { type: "分析開始" });
    expect(s.analysis.discordSend.status).toBe("idle");
  });

  it("状態遷移は元の state を破壊的に変更しない(不変性)", () => {
    const before = init();
    const snapshot = JSON.stringify(before);
    analysisReducer(before, { type: "日付変更", date: "20261231" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
