import { describe, expect, it } from "vitest";
import type {
  BulkImportRaceOutcome,
  PromptVersionVerifyReportView,
  RaceLedgerView,
  VerifyReportView,
} from "../src/shared/analysis-types.js";
import {
  createInitialVerifyState,
  IMPORT_NOT_CONFIRMED_MESSAGE,
  verifyReducer,
  type VerifyState,
} from "../src/renderer/verify-reducer.js";

const init = (): VerifyState => createInitialVerifyState();

const sampleReport: VerifyReportView = {
  includedAnalysisCount: 1,
  excludedAnalysisCount: 0,
  supersededAnalysisCount: 0,
  excludedEstimatedCount: 0,
  bet: {
    betCount: 2,
    totalStake: 200,
    totalReturn: 300,
    recoveryRate: 1.5,
    actualPayoutCount: 1,
    approximatePayoutCount: 0,
  },
  calibration: [],
  trend: {
    directionGroups: [],
    calibrationBias: [],
    markStats: [],
  },
};

const samplePromptVersionReports: PromptVersionVerifyReportView[] = [
  {
    promptVersion: "2026-07-14.1",
    report: sampleReport,
    additionalInstructions: [null],
  },
  { promptVersion: null, report: sampleReport, additionalInstructions: [null] },
];

const sampleRaceLedger: RaceLedgerView[] = [
  {
    raceId: "202605020811",
    venueName: "東京",
    raceNumber: 11,
    kaisaiDate: "20260708",
    analysisId: 1,
    analyzedAt: "2026-07-08T10:00:00.000Z",
    promptVersion: "2026-07-14.1",
    hasResult: true,
    hasPayout: true,
    horses: [],
    totalStake: 100,
    totalReturn: 300,
    recoveryRate: 3.0,
    betCount: 1,
  },
];

describe("verifyReducer(検証タブの状態遷移)", () => {
  it("初期状態は分析タブ・レース一覧空・取込中なし", () => {
    const s = init();
    expect(s.activeTab).toBe("分析");
    expect(s.raceLedger).toEqual([]);
    expect(s.report).toBeNull();
    expect(s.importingRaceIds).toEqual([]);
  });

  it("初期状態の地域フィルタは全体(all)であること(Task#32)", () => {
    const s = init();
    expect(s.venueFilter).toBe("all");
  });

  it("地域フィルタ変更で venueFilter を更新すること(Task#32)", () => {
    const initial = init();
    const s = verifyReducer(initial, {
      type: "地域フィルタ変更",
      venueFilter: "central",
    });
    expect(s.venueFilter).toBe("central");
    // 他の状態フィールド(activeTab等)は元の state 由来のまま(action自体を誤って返していないこと)。
    expect(s.activeTab).toBe(initial.activeTab);
    expect(s.raceLedger).toBe(initial.raceLedger);

    const s2 = verifyReducer(s, {
      type: "地域フィルタ変更",
      venueFilter: "nar",
    });
    expect(s2.venueFilter).toBe("nar");
    expect(s2.activeTab).toBe(initial.activeTab);
  });

  it("地域フィルタ変更は report 等の他フィールドを変えないこと(Task#32)", () => {
    const withReport = verifyReducer(init(), {
      type: "レポート取得成功",
      report: sampleReport,
    });
    const s = verifyReducer(withReport, {
      type: "地域フィルタ変更",
      venueFilter: "central",
    });
    expect(s.report).toEqual(sampleReport);
  });

  it("初期状態は版別レポートも空・未ローディングであること(Task#27)", () => {
    const s = init();
    expect(s.reportsByPromptVersion).toEqual([]);
    expect(s.loadingReportsByPromptVersion).toBe(false);
    expect(s.reportsByPromptVersionError).toBeNull();
  });

  it("版別レポート取得開始→成功で reportsByPromptVersion を格納しローディング解除する(Task#27)", () => {
    const loading = verifyReducer(init(), { type: "版別レポート取得開始" });
    expect(loading.loadingReportsByPromptVersion).toBe(true);
    const done = verifyReducer(loading, {
      type: "版別レポート取得成功",
      reports: samplePromptVersionReports,
    });
    expect(done.loadingReportsByPromptVersion).toBe(false);
    expect(done.reportsByPromptVersion).toEqual(samplePromptVersionReports);
    expect(done.reportsByPromptVersionError).toBeNull();
  });

  it("版別レポート取得失敗でエラーを保持しローディング解除する(Task#27)", () => {
    const s = verifyReducer(
      { ...init(), loadingReportsByPromptVersion: true },
      { type: "版別レポート取得失敗", message: "失敗" },
    );
    expect(s.loadingReportsByPromptVersion).toBe(false);
    expect(s.reportsByPromptVersionError).toBe("失敗");
  });

  it("初期状態はレース一覧も空・未ローディングであること(検証画面UI統合)", () => {
    const s = init();
    expect(s.raceLedger).toEqual([]);
    expect(s.loadingRaceLedger).toBe(false);
    expect(s.raceLedgerError).toBeNull();
  });

  it("レース一覧取得開始→成功で raceLedger を格納しローディング解除する(検証画面UI統合)", () => {
    const loading = verifyReducer(init(), { type: "レース一覧取得開始" });
    expect(loading.loadingRaceLedger).toBe(true);
    const done = verifyReducer(loading, {
      type: "レース一覧取得成功",
      raceLedger: sampleRaceLedger,
    });
    expect(done.loadingRaceLedger).toBe(false);
    expect(done.raceLedger).toEqual(sampleRaceLedger);
    expect(done.raceLedgerError).toBeNull();
  });

  it("レース一覧取得失敗でエラーを保持しローディング解除する(検証画面UI統合)", () => {
    const s = verifyReducer(
      { ...init(), loadingRaceLedger: true },
      { type: "レース一覧取得失敗", message: "失敗" },
    );
    expect(s.loadingRaceLedger).toBe(false);
    expect(s.raceLedgerError).toBe("失敗");
  });

  it("初期状態は版不明削除も未実行・未エラー・未完了であること(Task#33)", () => {
    const s = init();
    expect(s.deletingUnknownPromptVersion).toBe(false);
    expect(s.deleteUnknownPromptVersionError).toBeNull();
    expect(s.deleteUnknownPromptVersionDeletedCount).toBeNull();
  });

  it("版不明削除開始でローディングを立て、直前のエラー・完了件数をクリアすること(Task#33)", () => {
    const withStale = {
      ...init(),
      deleteUnknownPromptVersionError: "前回の失敗",
      deleteUnknownPromptVersionDeletedCount: 5,
    };
    const s = verifyReducer(withStale, { type: "版不明削除開始" });
    expect(s.deletingUnknownPromptVersion).toBe(true);
    expect(s.deleteUnknownPromptVersionError).toBeNull();
    expect(s.deleteUnknownPromptVersionDeletedCount).toBeNull();
  });

  it("版不明削除成功でローディング解除し、削除件数(IPC戻り値そのまま)を格納すること(Task#33)", () => {
    const loading = verifyReducer(init(), { type: "版不明削除開始" });
    const s = verifyReducer(loading, {
      type: "版不明削除成功",
      deletedCount: 3,
    });
    expect(s.deletingUnknownPromptVersion).toBe(false);
    expect(s.deleteUnknownPromptVersionDeletedCount).toBe(3);
    expect(s.deleteUnknownPromptVersionError).toBeNull();
  });

  it("版不明削除成功は削除0件でも区別できるよう0を格納すること(境界値、Task#33)", () => {
    const loading = verifyReducer(init(), { type: "版不明削除開始" });
    const s = verifyReducer(loading, {
      type: "版不明削除成功",
      deletedCount: 0,
    });
    expect(s.deleteUnknownPromptVersionDeletedCount).toBe(0);
  });

  it("版不明削除失敗でローディング解除し、エラーを保持すること(Task#33)", () => {
    const loading = verifyReducer(init(), { type: "版不明削除開始" });
    const s = verifyReducer(loading, {
      type: "版不明削除失敗",
      message: "削除に失敗",
    });
    expect(s.deletingUnknownPromptVersion).toBe(false);
    expect(s.deleteUnknownPromptVersionError).toBe("削除に失敗");
    expect(s.deleteUnknownPromptVersionDeletedCount).toBeNull();
  });

  it("タブ切替: activeTab を更新する", () => {
    const s = verifyReducer(init(), { type: "タブ切替", tab: "検証" });
    expect(s.activeTab).toBe("検証");
  });

  it("レポート取得成功で report を格納する", () => {
    const s = verifyReducer(init(), {
      type: "レポート取得成功",
      report: sampleReport,
    });
    expect(s.report).toEqual(sampleReport);
    expect(s.loadingReport).toBe(false);
  });

  it("取込開始で raceId を importingRaceIds に加える(重複は増やさない)", () => {
    const s1 = verifyReducer(init(), { type: "取込開始", raceId: "R1" });
    expect(s1.importingRaceIds).toEqual(["R1"]);
    const s2 = verifyReducer(s1, { type: "取込開始", raceId: "R1" });
    expect(s2.importingRaceIds).toEqual(["R1"]);
  });

  it("取込成功で raceId を importingRaceIds から取り除く", () => {
    const s1 = verifyReducer(init(), { type: "取込開始", raceId: "R1" });
    const s2 = verifyReducer(s1, { type: "取込成功", raceId: "R1" });
    expect(s2.importingRaceIds).toEqual([]);
    expect(s2.importError).toBeNull();
  });

  it("取込失敗で importingRaceIds から取り除きエラーを保持する", () => {
    const s1 = verifyReducer(init(), { type: "取込開始", raceId: "R1" });
    const s2 = verifyReducer(s1, {
      type: "取込失敗",
      raceId: "R1",
      message: "取得失敗",
    });
    expect(s2.importingRaceIds).toEqual([]);
    expect(s2.importError).toBe("取得失敗");
  });

  it("取込失敗で失敗したレースIDを importErrorRaceId に保持する(Task#36 エラーコピー用)", () => {
    const s1 = verifyReducer(init(), { type: "取込開始", raceId: "R1" });
    const s2 = verifyReducer(s1, {
      type: "取込失敗",
      raceId: "R1",
      message: "取得失敗",
    });
    expect(s2.importErrorRaceId).toBe("R1");
  });

  it("取込開始で前回の importErrorRaceId をクリアすること(再取込時に古い紐付けを残さない)", () => {
    const s1 = verifyReducer(init(), { type: "取込開始", raceId: "R1" });
    const s2 = verifyReducer(s1, {
      type: "取込失敗",
      raceId: "R1",
      message: "取得失敗",
    });
    const s3 = verifyReducer(s2, { type: "取込開始", raceId: "R2" });
    expect(s3.importErrorRaceId).toBeNull();
  });

  it("初期状態は取込案内(importNotice)も無いこと", () => {
    const s = init();
    expect(s.importNotice).toBeNull();
  });

  it("取込未確定で importingRaceIds から取り除き、赤エラーではなく案内メッセージを importNotice に設定すること", () => {
    const s1 = verifyReducer(init(), { type: "取込開始", raceId: "R1" });
    const s2 = verifyReducer(s1, { type: "取込未確定", raceId: "R1" });
    expect(s2.importingRaceIds).toEqual([]);
    expect(s2.importNotice).toBe(IMPORT_NOT_CONFIRMED_MESSAGE);
    // 未確定は失敗ではないので importError は立てない。
    expect(s2.importError).toBeNull();
  });

  it("取込開始で前回の importNotice をクリアすること(再取込時に古い案内を残さない)", () => {
    const s1 = verifyReducer(init(), { type: "取込開始", raceId: "R1" });
    const s2 = verifyReducer(s1, { type: "取込未確定", raceId: "R1" });
    expect(s2.importNotice).not.toBeNull();
    const s3 = verifyReducer(s2, { type: "取込開始", raceId: "R1" });
    expect(s3.importNotice).toBeNull();
  });

  describe("一括取込(bulkImport)の状態遷移(Task#31)", () => {
    const sampleOutcomes: BulkImportRaceOutcome[] = [
      { raceId: "R1", status: "imported", error: null },
      { raceId: "R2", status: "not_confirmed", error: null },
      { raceId: "R3", status: "failure", error: "取得失敗" },
    ];

    it("初期状態は未実行・進捗なし・結果空であること", () => {
      const s = init();
      expect(s.bulkImport.running).toBe(false);
      expect(s.bulkImport.canceling).toBe(false);
      expect(s.bulkImport.progress).toBeNull();
      expect(s.bulkImport.outcomes).toEqual([]);
    });

    it("一括取込開始で running=true・runId が進み、旧結果・進捗がクリアされること", () => {
      const before = init();
      const s = verifyReducer(before, { type: "一括取込開始" });
      expect(s.bulkImport.running).toBe(true);
      expect(s.bulkImport.canceling).toBe(false);
      expect(s.bulkImport.progress).toBeNull();
      expect(s.bulkImport.outcomes).toEqual([]);
      expect(s.bulkImport.runId).toBe(before.bulkImport.runId + 1);
    });

    it("実行中でない状態での一括取込開始でも running=true になり多重起動を妨げないが、" +
      "既に実行中の状態からの再度の開始は現状維持であること(二重実行防止)", () => {
      const started = verifyReducer(init(), { type: "一括取込開始" });
      const again = verifyReducer(started, { type: "一括取込開始" });
      expect(again).toBe(started);
    });

    it("一括取込進捗更新: 現在の実行世代の進捗のみ反映すること(in-flightガード)", () => {
      const started = verifyReducer(init(), { type: "一括取込開始" });
      const progress = { completedRaces: 1, totalRaces: 3, currentRaceId: "R2" };
      const updated = verifyReducer(started, {
        type: "一括取込進捗更新",
        runId: started.bulkImport.runId,
        progress,
      });
      expect(updated.bulkImport.progress).toEqual(progress);

      // 古い世代の進捗は無視される。
      const ignored = verifyReducer(updated, {
        type: "一括取込進捗更新",
        runId: started.bulkImport.runId - 1,
        progress: { completedRaces: 99, totalRaces: 99, currentRaceId: "旧" },
      });
      expect(ignored.bulkImport.progress).toEqual(progress);
    });

    it("一括取込完了: running=false・outcomes を格納し、進捗をクリアすること", () => {
      const started = verifyReducer(init(), { type: "一括取込開始" });
      const done = verifyReducer(started, {
        type: "一括取込完了",
        runId: started.bulkImport.runId,
        outcomes: sampleOutcomes,
      });
      expect(done.bulkImport.running).toBe(false);
      expect(done.bulkImport.canceling).toBe(false);
      expect(done.bulkImport.progress).toBeNull();
      expect(done.bulkImport.outcomes).toEqual(sampleOutcomes);
    });

    it("一括取込完了: 古い実行世代の完了は無視すること(in-flightガード)", () => {
      const started = verifyReducer(init(), { type: "一括取込開始" });
      const ignored = verifyReducer(started, {
        type: "一括取込完了",
        runId: started.bulkImport.runId - 1,
        outcomes: sampleOutcomes,
      });
      expect(ignored).toBe(started);
    });

    it("一括取込中断要求: 実行中のみ canceling=true にすること", () => {
      const started = verifyReducer(init(), { type: "一括取込開始" });
      const canceling = verifyReducer(started, { type: "一括取込中断要求" });
      expect(canceling.bulkImport.canceling).toBe(true);
      expect(canceling.bulkImport.running).toBe(true);
    });

    it("一括取込中断要求: 未実行中は何もしないこと", () => {
      const s = init();
      const result = verifyReducer(s, { type: "一括取込中断要求" });
      expect(result).toBe(s);
    });
  });

  describe("レース一覧の検索/絞り込み(表示専用。#32venueFilterとは別の状態)", () => {
    it("初期状態は絞り込みなし(EMPTY_RACE_LEDGER_FILTER相当)であること", () => {
      const s = init();
      expect(s.raceLedgerFilter).toEqual({
        dateFrom: null,
        dateTo: null,
        venueKind: "all",
        venueName: null,
        keyword: "",
      });
    });

    it("レース一覧フィルタ変更で raceLedgerFilter を丸ごと更新すること", () => {
      const initial = init();
      const s = verifyReducer(initial, {
        type: "レース一覧フィルタ変更",
        filter: {
          dateFrom: "20260701",
          dateTo: "20260710",
          venueKind: "central",
          venueName: "東京",
          keyword: "11R",
        },
      });
      expect(s.raceLedgerFilter).toEqual({
        dateFrom: "20260701",
        dateTo: "20260710",
        venueKind: "central",
        venueName: "東京",
        keyword: "11R",
      });
      // 他の状態フィールド(raceLedger等)は元の state 由来のまま(絞り込みは表示専用で
      // 取得済みの一覧データそのものは変えないこと)。
      expect(s.raceLedger).toBe(initial.raceLedger);
      expect(s.activeTab).toBe(initial.activeTab);
    });

    it("レース一覧フィルタクリアで絞り込み条件を初期状態に戻すこと", () => {
      const filtered = verifyReducer(init(), {
        type: "レース一覧フィルタ変更",
        filter: {
          dateFrom: "20260701",
          dateTo: null,
          venueKind: "nar",
          venueName: "高知",
          keyword: "10R",
        },
      });
      const cleared = verifyReducer(filtered, { type: "レース一覧フィルタクリア" });
      expect(cleared.raceLedgerFilter).toEqual({
        dateFrom: null,
        dateTo: null,
        venueKind: "all",
        venueName: null,
        keyword: "",
      });
    });

    it("レース一覧フィルタ変更・クリアは検証レポート(report)等の他フィールドを変えないこと", () => {
      const withReport = verifyReducer(init(), {
        type: "レポート取得成功",
        report: sampleReport,
      });
      const filtered = verifyReducer(withReport, {
        type: "レース一覧フィルタ変更",
        filter: {
          dateFrom: null,
          dateTo: null,
          venueKind: "all",
          venueName: null,
          keyword: "東京",
        },
      });
      expect(filtered.report).toEqual(sampleReport);
      const cleared = verifyReducer(filtered, { type: "レース一覧フィルタクリア" });
      expect(cleared.report).toEqual(sampleReport);
    });
  });
});
