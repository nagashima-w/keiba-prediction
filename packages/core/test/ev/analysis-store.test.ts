import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AnalysisStore,
  type AnalysisAllocationMetaRecord,
  type AnalysisRecord,
  type StoredAllocation,
} from "../support/analysis-store.js";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { loadFixture } from "../support/fixtures.js";

/** テスト用の分析レコードを最小構成で組み立てる。 */
function makeRecord(overrides: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    raceId: "202605020811",
    analyzedAt: "2026-07-08T10:00:00.000Z",
    horses: [
      {
        umaban: 1,
        prior: 0.3,
        adjustedProb: 0.3,
        placeOddsMin: 2.5,
        ev: 0.75,
        isPositive: false,
        contributions: [{ biasName: "近走着順", correction: 0.05 }],
        mark: "◎",
      },
      {
        umaban: 2,
        prior: 0.5,
        adjustedProb: 0.5,
        placeOddsMin: 2.2,
        ev: 1.1,
        isPositive: true,
        contributions: [{ biasName: "近走着順", correction: 0.12 }],
        mark: null,
      },
    ],
    ...overrides,
  };
}

describe("AnalysisStore(分析結果のSQLite保存)", () => {
  describe("推定EVフラグ(evEstimated)の保存・復元(Task#25)", () => {
    it("evEstimatedを指定して保存すると、そのまま復元できること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "推定レース", evEstimated: true }));
      const a = store.listAnalyses({ raceId: "推定レース" })[0]!;
      expect(a.evEstimated).toBe(true);
      store.close();
    });

    it("evEstimatedを省略して保存すると false として保存・復元されること(後方互換の既定値)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "確定レース" }));
      const a = store.listAnalyses({ raceId: "確定レース" })[0]!;
      expect(a.evEstimated).toBe(false);
      store.close();
    });
  });

  describe("saveAnalysis / listAnalyses", () => {
    it("保存した分析を馬ごと復元でき、寄与度ログ(JSON)も往復すること", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(makeRecord());
      expect(typeof id).toBe("number");

      const all = store.listAnalyses();
      expect(all).toHaveLength(1);
      const a = all[0]!;
      expect(a.id).toBe(id);
      expect(a.raceId).toBe("202605020811");
      expect(a.analyzedAt).toBe("2026-07-08T10:00:00.000Z");
      expect(a.horses).toHaveLength(2);

      const h2 = a.horses.find((h) => h.umaban === 2)!;
      expect(h2.prior).toBeCloseTo(0.5, 10);
      expect(h2.adjustedProb).toBeCloseTo(0.5, 10);
      expect(h2.placeOddsMin).toBeCloseTo(2.2, 10);
      expect(h2.ev).toBeCloseTo(1.1, 10);
      expect(h2.isPositive).toBe(true);
      // 寄与度ログはJSONとして往復する。
      expect(h2.contributions).toEqual([{ biasName: "近走着順", correction: 0.12 }]);
      // 予想印(Task#23)も往復する。
      expect(h2.mark).toBeNull();
      const h1 = a.horses.find((h) => h.umaban === 1)!;
      expect(h1.mark).toBe("◎");

      store.close();
    });

    it("オッズ欠損馬(placeOddsMin/ev が null)もそのまま保存・復元できること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({
          horses: [
            {
              umaban: 3,
              prior: 0.2,
              adjustedProb: 0.2,
              placeOddsMin: null,
              ev: null,
              isPositive: false,
              contributions: null,
              mark: null,
            },
          ],
        }),
      );
      const h = store.listAnalyses()[0]!.horses[0]!;
      expect(h.placeOddsMin).toBeNull();
      expect(h.ev).toBeNull();
      expect(h.contributions).toBeNull();
      store.close();
    });

    it("同一レースを複数回分析すると別idで両方保存されること", () => {
      const store = new AnalysisStore();
      const id1 = store.saveAnalysis(
        makeRecord({ analyzedAt: "2026-07-08T09:00:00.000Z" }),
      );
      const id2 = store.saveAnalysis(
        makeRecord({ analyzedAt: "2026-07-08T15:30:00.000Z" }),
      );
      expect(id1).not.toBe(id2);
      expect(store.listAnalyses()).toHaveLength(2);
      store.close();
    });

    it("raceId でフィルタできること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "202605020811" }));
      store.saveAnalysis(makeRecord({ raceId: "202605020812" }));
      const filtered = store.listAnalyses({ raceId: "202605020812" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.raceId).toBe("202605020812");
      store.close();
    });
  });

  describe("saveResult / getResult", () => {
    it("実着順を保存・取得でき、非数値着順は null として保持されること", () => {
      const store = new AnalysisStore();
      store.saveResult("202605020811", [
        { umaban: 1, finishPosition: 3 },
        { umaban: 2, finishPosition: 1 },
        { umaban: 3, finishPosition: null }, // 中止・除外など
      ]);
      const results = store.getResult("202605020811")!;
      expect(results).toHaveLength(3);
      const byUmaban = new Map(results.map((r) => [r.umaban, r.finishPosition]));
      expect(byUmaban.get(1)).toBe(3);
      expect(byUmaban.get(2)).toBe(1);
      expect(byUmaban.get(3)).toBeNull();
      store.close();
    });

    it("同一レースの結果を再保存すると上書きされること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 5 }]);
      store.saveResult("R1", [{ umaban: 1, finishPosition: 2 }]);
      const results = store.getResult("R1")!;
      expect(results).toHaveLength(1);
      expect(results[0]!.finishPosition).toBe(2);
      store.close();
    });

    it("結果が無いレースは undefined を返すこと", () => {
      const store = new AnalysisStore();
      expect(store.getResult("未保存")).toBeUndefined();
      store.close();
    });

    it("複勝の確定払戻(placePayout)を保存・取得できること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [
        { umaban: 4, finishPosition: 1, placePayout: 210 },
        { umaban: 2, finishPosition: 2, placePayout: 170 },
        { umaban: 9, finishPosition: 3, placePayout: 1060 },
        { umaban: 5, finishPosition: 4 }, // 複勝圏外は払戻なし
      ]);
      const byUmaban = new Map(
        store.getResult("R1")!.map((r) => [r.umaban, r.placePayout]),
      );
      expect(byUmaban.get(4)).toBe(210);
      expect(byUmaban.get(9)).toBe(1060);
      // placePayout を省略した馬は null。
      expect(byUmaban.get(5)).toBeNull();
      store.close();
    });

    it("placePayout を指定せず保存した既存互換の呼び出しでは placePayout が null になること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      expect(store.getResult("R1")![0]!.placePayout).toBeNull();
      store.close();
    });

    it("払戻なしで取り込んだ後、払戻ありで再取込すると placePayout が更新されること", () => {
      const store = new AnalysisStore();
      // 確定直前: 着順のみ(払戻なし)。
      store.saveResult("R1", [{ umaban: 4, finishPosition: 1 }]);
      expect(store.getResult("R1")![0]!.placePayout).toBeNull();
      // 確定後の再取込: 複勝払戻が付く。
      store.saveResult("R1", [{ umaban: 4, finishPosition: 1, placePayout: 210 }]);
      const updated = store.getResult("R1")!;
      expect(updated).toHaveLength(1);
      expect(updated[0]!.finishPosition).toBe(1);
      expect(updated[0]!.placePayout).toBe(210);
      store.close();
    });

    // Issue #100(#23-C): 単勝の確定払戻(winPayout)。placePayoutと同型の後付け列(win_payout)。
    it("単勝の確定払戻(winPayout)を保存・取得できること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [
        { umaban: 4, finishPosition: 1, winPayout: 670 },
        { umaban: 2, finishPosition: 2 }, // 単勝は1着のみ払戻対象。2着以下は払戻なし。
      ]);
      const byUmaban = new Map(
        store.getResult("R1")!.map((r) => [r.umaban, r.winPayout]),
      );
      expect(byUmaban.get(4)).toBe(670);
      // winPayout を省略した馬(1着以外)は null。
      expect(byUmaban.get(2)).toBeNull();
      store.close();
    });

    it("winPayout を指定せず保存した既存互換の呼び出しでは winPayout が null になること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      expect(store.getResult("R1")![0]!.winPayout).toBeNull();
      store.close();
    });

    it("払戻なしで取り込んだ後、払戻ありで再取込すると winPayout が更新されること", () => {
      const store = new AnalysisStore();
      // 確定直前: 着順のみ(払戻なし)。
      store.saveResult("R1", [{ umaban: 4, finishPosition: 1 }]);
      expect(store.getResult("R1")![0]!.winPayout).toBeNull();
      // 確定後の再取込: 単勝払戻が付く。
      store.saveResult("R1", [{ umaban: 4, finishPosition: 1, winPayout: 670 }]);
      const updated = store.getResult("R1")!;
      expect(updated).toHaveLength(1);
      expect(updated[0]!.finishPosition).toBe(1);
      expect(updated[0]!.winPayout).toBe(670);
      store.close();
    });

    // AC1(1着同着): winPayouts.length>=2 の入力で全件が保存されること。
    // parsePayoutRowは件数を固定していないため実在しうる(合成入力)。
    it("単勝の1着同着(2頭とも払戻あり)で、両馬それぞれの払戻額が保存されること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [
        { umaban: 3, finishPosition: 1, winPayout: 150 },
        { umaban: 7, finishPosition: 1, winPayout: 320 }, // 同着でも金額は馬ごとに異なりうる
      ]);
      const byUmaban = new Map(
        store.getResult("R1")!.map((r) => [r.umaban, r.winPayout]),
      );
      // 両方とも非null、かつ「片方だけ拾う」「同額を複製する」実装を落とせるよう別額で固定する。
      expect(byUmaban.get(3)).toBe(150);
      expect(byUmaban.get(7)).toBe(320);
      store.close();
    });
  });

  describe("プロンプト版番号(promptVersion)の保存・復元(Task#27)", () => {
    it("promptVersionを指定して保存すると、そのまま復元できること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "版指定レース", promptVersion: "2026-07-14.1" }),
      );
      const a = store.listAnalyses({ raceId: "版指定レース" })[0]!;
      expect(a.promptVersion).toBe("2026-07-14.1");
      store.close();
    });

    it("promptVersionを省略して保存するとnull(版不明)として保存・復元されること(後方互換の既定値)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "版不明レース" }));
      const a = store.listAnalyses({ raceId: "版不明レース" })[0]!;
      expect(a.promptVersion).toBeNull();
      store.close();
    });

    it("promptVersionにnullを明示しても版不明として保存・復元されること(LLM未使用時の想定)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "LLM未使用レース", promptVersion: null }),
      );
      const a = store.listAnalyses({ raceId: "LLM未使用レース" })[0]!;
      expect(a.promptVersion).toBeNull();
      store.close();
    });
  });

  describe("追加指示(additionalInstruction)の保存・復元(Task#28 プロンプト改善C)", () => {
    it("additionalInstructionを指定して保存すると、そのまま復元できること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({
          raceId: "追加指示レース",
          additionalInstruction: "人気薄の複勝率は慎重に見積もること",
        }),
      );
      const a = store.listAnalyses({ raceId: "追加指示レース" })[0]!;
      expect(a.additionalInstruction).toBe("人気薄の複勝率は慎重に見積もること");
      store.close();
    });

    it("additionalInstructionを省略して保存するとnullとして保存・復元されること(後方互換の既定値)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "追加指示なしレース" }));
      const a = store.listAnalyses({ raceId: "追加指示なしレース" })[0]!;
      expect(a.additionalInstruction).toBeNull();
      store.close();
    });

    it("additionalInstructionにnullを明示しても null として保存・復元されること(設定が空の想定)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "設定空レース", additionalInstruction: null }),
      );
      const a = store.listAnalyses({ raceId: "設定空レース" })[0]!;
      expect(a.additionalInstruction).toBeNull();
      store.close();
    });
  });

  describe("開催日(kaisaiDate)の保存・復元(Task#34)", () => {
    it("kaisaiDateを指定して保存すると、そのまま復元できること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "開催日指定レース", kaisaiDate: "20260714" }),
      );
      const a = store.listAnalyses({ raceId: "開催日指定レース" })[0]!;
      expect(a.kaisaiDate).toBe("20260714");
      store.close();
    });

    it("kaisaiDateを省略して保存するとnull(日付不明)として保存・復元されること(後方互換の既定値)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "開催日不明レース" }));
      const a = store.listAnalyses({ raceId: "開催日不明レース" })[0]!;
      expect(a.kaisaiDate).toBeNull();
      store.close();
    });

    it("kaisaiDateにnullを明示しても日付不明として保存・復元されること(選択済み開催日が渡らなかった場合の想定)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "近似日付レース", kaisaiDate: null }),
      );
      const a = store.listAnalyses({ raceId: "近似日付レース" })[0]!;
      expect(a.kaisaiDate).toBeNull();
      store.close();
    });
  });

  describe("history_cutoff_date列(戦績の絞り込み基準日の記録。Issue #39)", () => {
    /** 生SQLで history_cutoff_date を読む(StoredAnalysis への読み出しは別の describe〈Issue #152 A〉で検証する)。 */
    function readCutoff(db: InstanceType<typeof Database>, analysisId: number): string | null {
      const row = db
        .prepare(`SELECT history_cutoff_date AS v FROM analyses WHERE id = ?`)
        .get(analysisId) as { v: string | null };
      return row.v;
    }

    it("historyCutoffDate を指定して保存すると、列にその基準日(YYYYMMDD)が書かれること", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(makeRecord({ raceId: "基準日あり", historyCutoffDate: "20260628" }));
      expect(readCutoff(db, id)).toBe("20260628");
      store.close();
    });

    it("historyCutoffDate を省略した保存(=是正前の呼び出し元)は NULL(記録なし)になり、0や空文字にならないこと", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(makeRecord({ raceId: "基準日省略" }));
      expect(readCutoff(db, id)).toBeNull();
      store.close();
    });

    it("historyCutoffDate に null を明示しても NULL として保存されること", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(makeRecord({ raceId: "基準日null", historyCutoffDate: null }));
      expect(readCutoff(db, id)).toBeNull();
      store.close();
    });
  });

  describe("prompt_lookahead_guarded列(LLMプロンプト側の先読みリーク遮断を通った印。Issue #153)", () => {
    /** 生SQLで prompt_lookahead_guarded を読む(StoredAnalysis への読み出しは別の describe〈Issue #152 A〉で検証する)。 */
    function readGuarded(db: InstanceType<typeof Database>, analysisId: number): number | null {
      const row = db
        .prepare(`SELECT prompt_lookahead_guarded AS v FROM analyses WHERE id = ?`)
        .get(analysisId) as { v: number | null };
      return row.v;
    }

    it("promptLookaheadGuarded: true で保存すると、列に 1 が書かれること", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(makeRecord({ raceId: "遮断あり", promptLookaheadGuarded: true }));
      expect(readGuarded(db, id)).toBe(1);
      store.close();
    });

    it("promptLookaheadGuarded を省略した保存(=遮断より前の呼び出し元)は NULL(記録なし)になり、0 にならないこと", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(makeRecord({ raceId: "遮断省略" }));
      expect(readGuarded(db, id)).toBeNull();
      store.close();
    });

    it("promptLookaheadGuarded に null を明示しても NULL として保存されること", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(makeRecord({ raceId: "遮断null", promptLookaheadGuarded: null }));
      expect(readGuarded(db, id)).toBeNull();
      store.close();
    });

    it("promptLookaheadGuarded: false は 0 として保存され、NULL(記録なし)と区別できること", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(makeRecord({ raceId: "遮断false", promptLookaheadGuarded: false }));
      expect(readGuarded(db, id)).toBe(0);
      store.close();
    });

    it("history_cutoff_date と独立に書かれる(一方だけ指定しても、もう一方の列に影響しない)", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const a = store.saveAnalysis(makeRecord({ raceId: "基準日のみ", historyCutoffDate: "20260628" }));
      const b = store.saveAnalysis(makeRecord({ raceId: "遮断のみ", promptLookaheadGuarded: true }));
      const cutoff = (id: number): string | null =>
        (db.prepare(`SELECT history_cutoff_date AS v FROM analyses WHERE id = ?`).get(id) as { v: string | null }).v;
      expect(cutoff(a)).toBe("20260628");
      expect(readGuarded(db, a)).toBeNull();
      expect(cutoff(b)).toBeNull();
      expect(readGuarded(db, b)).toBe(1);
      store.close();
    });
  });

  describe("遮断マーカーの読み出し(historyCutoffDate・promptLookaheadGuarded。Issue #152 A)", () => {
    it("保存した値が listAnalyses で復元される(基準日はそのまま、guarded は 1→true・0→false)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "R-true", historyCutoffDate: "20260628", promptLookaheadGuarded: true }),
      );
      store.saveAnalysis(
        makeRecord({ raceId: "R-false", historyCutoffDate: "20260629", promptLookaheadGuarded: false }),
      );
      const all = store.listAnalyses();
      expect(all).toHaveLength(2);
      expect(all[0]!.historyCutoffDate).toBe("20260628");
      expect(all[0]!.promptLookaheadGuarded).toBe(true);
      expect(all[1]!.historyCutoffDate).toBe("20260629");
      expect(all[1]!.promptLookaheadGuarded).toBe(false);
      store.close();
    });

    it("未指定(NULL)は null のまま復元され、false や空文字に化けない(『記録なし』と『明示的に未遮断』を区別する)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "R-null" }));
      const [a] = store.listAnalyses();
      expect(a!.historyCutoffDate).toBeNull();
      expect(a!.promptLookaheadGuarded).toBeNull();
      store.close();
    });

    it("raceId を指定した listAnalyses(SELECT がもう1本ある経路)でも同じ値が復元される", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "R-A", historyCutoffDate: "20260628", promptLookaheadGuarded: true }),
      );
      store.saveAnalysis(makeRecord({ raceId: "R-B" }));
      const [a] = store.listAnalyses({ raceId: "R-A" });
      expect(a!.historyCutoffDate).toBe("20260628");
      expect(a!.promptLookaheadGuarded).toBe(true);
      const [b] = store.listAnalyses({ raceId: "R-B" });
      expect(b!.historyCutoffDate).toBeNull();
      expect(b!.promptLookaheadGuarded).toBeNull();
      store.close();
    });
  });

  describe("エクスポート用列(model/rawResponse/raceSnapshot/reason)の保存・復元(Issue#10)", () => {
    it("model・rawResponse・raceSnapshot・各馬reasonを指定して保存すると、そのまま復元できること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({
          raceId: "LLM使用レース",
          model: "claude-sonnet-4-6",
          rawResponse: '{"horses":[]}',
          raceSnapshot: { race: { raceName: "テストS" } },
          horses: [
            {
              umaban: 1,
              prior: 0.3,
              adjustedProb: 0.35,
              placeOddsMin: 2.5,
              ev: 0.9,
              isPositive: false,
              contributions: null,
              mark: "◎",
              reason: "調教良化",
            },
            {
              umaban: 2,
              prior: 0.5,
              adjustedProb: 0.5,
              placeOddsMin: 2.2,
              ev: 1.1,
              isPositive: true,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      );
      const a = store.listAnalyses({ raceId: "LLM使用レース" })[0]!;
      expect(a.model).toBe("claude-sonnet-4-6");
      expect(a.rawResponse).toBe('{"horses":[]}');
      expect(a.raceSnapshot).toEqual({ race: { raceName: "テストS" } });
      expect(a.horses.find((h) => h.umaban === 1)!.reason).toBe("調教良化");
      expect(a.horses.find((h) => h.umaban === 2)!.reason).toBeNull();
      store.close();
    });

    it("model・rawResponse・raceSnapshotを省略して保存するとnullとして保存・復元されること(LLMスキップ想定・後方互換の既定値)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "LLMスキップレース" }));
      const a = store.listAnalyses({ raceId: "LLMスキップレース" })[0]!;
      expect(a.model).toBeNull();
      expect(a.rawResponse).toBeNull();
      expect(a.raceSnapshot).toBeNull();
      expect(a.horses.every((h) => h.reason === null)).toBe(true);
      store.close();
    });

    it("model・rawResponseにnullを明示してもLLMスキップ想定としてnullで保存・復元されること(raceSnapshotのみ保存する運用を許容)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({
          raceId: "スナップショットのみレース",
          model: null,
          rawResponse: null,
          raceSnapshot: { race: { raceName: "スナップショットのみ" } },
          horses: [
            {
              umaban: 1,
              prior: 0.3,
              adjustedProb: 0.3,
              placeOddsMin: 2.5,
              ev: 0.9,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      );
      const a = store.listAnalyses({ raceId: "スナップショットのみレース" })[0]!;
      expect(a.model).toBeNull();
      expect(a.rawResponse).toBeNull();
      expect(a.raceSnapshot).toEqual({ race: { raceName: "スナップショットのみ" } });
      store.close();
    });
  });

  describe("強調材料・懸念事項(highlights_json・concerns_json)の保存・復元・後付け列(Issue #197・#196-a)", () => {
    const horse = (umaban: number, extra: Record<string, unknown>) => ({
      umaban,
      prior: 0.3,
      adjustedProb: 0.3,
      placeOddsMin: 2.0,
      ev: 0.6,
      isPositive: false,
      contributions: null,
      mark: null,
      reason: null,
      ...extra,
    });
    const columnNames = (db: InstanceType<typeof Database>): string[] =>
      (db.prepare("PRAGMA table_info(analysis_horses)").all() as { name: string }[]).map((c) => c.name);

    it("新規に作った DB の analysis_horses は highlights_json・concerns_json 列を持つ(CREATE に含まれる)", () => {
      const db = new Database(":memory:");
      new AnalysisStore({ database: db });
      const names = columnNames(db);
      expect(names).toContain("highlights_json");
      expect(names).toContain("concerns_json");
      // 並びは reason の後ろ(D1 の ALTER で足した列の並びと一致させる)。
      expect(names.slice(-3)).toEqual(["reason", "highlights_json", "concerns_json"]);
      db.close();
    });

    it("指定した配列がそのまま往復し、空配列・省略は DB 上 NULL で、読むと [] に戻る", () => {
      const db = new Database(":memory:");
      const store = new AnalysisStore({ database: db });
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "根拠細分化レース",
          horses: [
            horse(1, { highlights: ["追い切り好時計", "内枠有利"], concerns: ["距離延長"] }),
            horse(2, { highlights: [], concerns: [] }),
            horse(3, {}),
          ],
        }),
      );
      const a = store.listAnalyses({ raceId: "根拠細分化レース" })[0]!;
      const byUma = (n: number) => a.horses.find((h) => h.umaban === n)!;
      expect(byUma(1).highlights).toEqual(["追い切り好時計", "内枠有利"]);
      expect(byUma(1).concerns).toEqual(["距離延長"]);
      expect(byUma(2).highlights).toEqual([]);
      expect(byUma(3).concerns).toEqual([]);
      // 保存の形(空は NULL)。
      const raw = db
        .prepare("SELECT umaban, highlights_json, concerns_json FROM analysis_horses WHERE analysis_id = ? ORDER BY umaban")
        .all(id) as { umaban: number; highlights_json: string | null; concerns_json: string | null }[];
      expect(raw).toEqual([
        { umaban: 1, highlights_json: '["追い切り好時計","内枠有利"]', concerns_json: '["距離延長"]' },
        { umaban: 2, highlights_json: null, concerns_json: null },
        { umaban: 3, highlights_json: null, concerns_json: null },
      ]);
      store.close();
    });
  });

  describe("getRaceResultDetail(passing/last3f/course_typeの2テーブルround-trip。タスク#27-A2)", () => {
    it("passing=[]・last3f=null・courseType未指定(面行なし)を保存すると、その通りに復元できること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [
        { umaban: 1, finishPosition: 1, passing: [], last3f: null },
      ]);
      const detail = store.getRaceResultDetail("R1")!;
      expect(detail.courseType).toBeNull();
      const h = detail.horses.find((x) => x.umaban === 1)!;
      expect(h.passing).toEqual([]);
      expect(h.last3f).toBeNull();
      store.close();
    });

    it("passing=[2,3,4,3]・last3f=35.2・courseType='芝'を保存すると、その通りに復元できること", () => {
      const store = new AnalysisStore();
      store.saveResult(
        "R1",
        [{ umaban: 4, finishPosition: 1, passing: [2, 3, 4, 3], last3f: 35.2 }],
        "芝",
      );
      const detail = store.getRaceResultDetail("R1")!;
      expect(detail.courseType).toBe("芝");
      const h = detail.horses.find((x) => x.umaban === 4)!;
      expect(h.passing).toEqual([2, 3, 4, 3]);
      expect(h.last3f).toBe(35.2);
      store.close();
    });

    it.each([["芝"], ["ダ"], ["障"]] as const)(
      "courseType='%s'を保存すると、その値のまま復元できること",
      (courseType) => {
        const store = new AnalysisStore();
        store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], courseType);
        expect(store.getRaceResultDetail("R1")!.courseType).toBe(courseType);
        store.close();
      },
    );

    it("1件も保存されていないレースは undefined を返すこと", () => {
      const store = new AnalysisStore();
      expect(store.getRaceResultDetail("未保存")).toBeUndefined();
      store.close();
    });

    it("finishPositionがnull(中止・除外)の馬でもumaban/finishPosition/passing/last3fが復元できること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [
        { umaban: 5, finishPosition: null, passing: [3], last3f: 36.5 },
      ]);
      const h = store.getRaceResultDetail("R1")!.horses.find((x) => x.umaban === 5)!;
      expect(h.finishPosition).toBeNull();
      expect(h.passing).toEqual([3]);
      expect(h.last3f).toBe(36.5);
      store.close();
    });

    // code-reviewer指摘対応: 保存順(逆順)に依存せず、常に馬番昇順で返す契約を専用テストで固定する。
    it("複数馬を馬番の逆順(9→4→2)で保存しても、馬番昇順(2→4→9)で返ること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [
        { umaban: 9, finishPosition: 3 },
        { umaban: 4, finishPosition: 1 },
        { umaban: 2, finishPosition: 2 },
      ]);
      const detail = store.getRaceResultDetail("R1")!;
      expect(detail.horses.map((h) => h.umaban)).toEqual([2, 4, 9]);
      store.close();
    });
  });

  describe("防御的復元(passing_json破損・course_type未知値。タスク#27-A2)", () => {
    it("passing_jsonがNULLの行は passing=[] として復元されること(旧データ・列追加直後の想定)", () => {
      const store = new AnalysisStore();
      store.rawDatabase
        .prepare(
          `INSERT INTO race_results (race_id, umaban, finish_position, place_payout, passing_json, last3f)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("破損レース", 1, 1, null, null, null);
      const h = store
        .getRaceResultDetail("破損レース")!
        .horses.find((x) => x.umaban === 1)!;
      expect(h.passing).toEqual([]);
      store.close();
    });

    it("passing_jsonが不正なJSON文字列の行は passing=[] として復元されること(throwしない)", () => {
      const store = new AnalysisStore();
      store.rawDatabase
        .prepare(
          `INSERT INTO race_results (race_id, umaban, finish_position, place_payout, passing_json, last3f)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("不正JSONレース", 1, 1, null, "{不正", null);
      const h = store
        .getRaceResultDetail("不正JSONレース")!
        .horses.find((x) => x.umaban === 1)!;
      expect(h.passing).toEqual([]);
      store.close();
    });

    // code-reviewer指摘対応: toStoredPassingが Array.isArray ガードと .every ガードの
    // それぞれを別々に通る境界値(非配列JSON / 配列内に非数値混入)を回帰テストとして固定する。
    // 将来どちらかのガードが弱化・削除されても、この2ケースで検知できるようにする。
    it.each([
      ["非配列JSON(オブジェクト)", '{"a":1}'],
      ["非配列JSON(文字列)", '"2-3-4"'],
      ["配列内に非数値混入", '[1,"a",3]'],
    ])(
      "passing_jsonが%s(%s)の場合は passing=[] として復元されること(throwしない)",
      (_label, rawJson) => {
        const store = new AnalysisStore();
        store.rawDatabase
          .prepare(
            `INSERT INTO race_results (race_id, umaban, finish_position, place_payout, passing_json, last3f)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run("防御的復元境界値レース", 1, 1, null, rawJson, null);
        const h = store
          .getRaceResultDetail("防御的復元境界値レース")!
          .horses.find((x) => x.umaban === 1)!;
        expect(h.passing).toEqual([]);
        store.close();
      },
    );

    it("course_typeが未知の文字列の行は courseType=null として復元されること(throwしない)", () => {
      const store = new AnalysisStore();
      store.rawDatabase
        .prepare(
          `INSERT INTO race_results (race_id, umaban, finish_position) VALUES (?, ?, ?)`,
        )
        .run("未知面レース", 1, 1);
      store.rawDatabase
        .prepare(`INSERT INTO race_result_meta (race_id, course_type) VALUES (?, ?)`)
        .run("未知面レース", "未知値");
      expect(store.getRaceResultDetail("未知面レース")!.courseType).toBeNull();
      store.close();
    });
  });

  describe("非破壊回帰: getResultは従来どおりの出力を維持すること(タスク#27-A2・Issue #100)", () => {
    it("passing/last3f/courseTypeを保存した後もgetResultはumaban/finishPosition/placePayout/winPayoutのみを返すこと", () => {
      const store = new AnalysisStore();
      store.saveResult(
        "R1",
        [
          {
            umaban: 1,
            finishPosition: 1,
            placePayout: 210,
            winPayout: 670,
            passing: [2, 3],
            last3f: 35.0,
          },
        ],
        "芝",
      );
      const results = store.getResult("R1")!;
      expect(results).toEqual([
        { umaban: 1, finishPosition: 1, placePayout: 210, winPayout: 670 },
      ]);
      store.close();
    });
  });

  describe("馬単の払戻(順序付きキー。Issue #106・#24-B AC-B2)", () => {
    it("逆順の2組(1着13・2着8 と 1着8・2着13)が別キー・別値のまま保存・復元されること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        exacta: {
          state: "parsed",
          payouts: [
            { umabans: [13, 8], payout: 8360 },
            { umabans: [8, 13], payout: 11880 },
          ],
        },
      });
      const result = store.getComboPayouts("R1", "exacta");
      expect(result.state).toBe("imported");
      if (result.state !== "imported") throw new Error("unreachable");
      expect(result.payouts).toHaveLength(2);
      const byKey = new Map(result.payouts.map((p) => [p.comboKey, p.payout]));
      expect(byKey.get("1308")).toBe(8360);
      expect(byKey.get("0813")).toBe(11880);
      expect(byKey.get("1308")).not.toBe(byKey.get("0813"));
      store.close();
    });

    it("★変異確認用の前提固定: ワイド・3連複は従来どおり順不同キーで保存されること(回帰)", () => {
      // 馬単対応でワイド・3連複の既存挙動を壊していないことを同時に固定する(退行防止)。
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 120 }] },
        trio: { state: "parsed", payouts: [{ umabans: [1, 2, 5], payout: 240 }] },
      });
      expect(store.getComboPayouts("R1", "wide")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "0102", payout: 120 }],
      });
      expect(store.getComboPayouts("R1", "trio")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "010205", payout: 240 }],
      });
      store.close();
    });
  });

  describe("馬単の確定払戻の取り込み(Issue #121・#24-F2: parseRaceResultからgetComboPayoutsまでの結線)", () => {
    it("実フィクスチャ(fixtures/result_202603020211.html)をparseRaceResult→saveResultで保存し、getComboPayoutsで読み出したキーが正順'1308'のままであること(パーサ・ストアのどちらかで昇順化が混入すると'0813'になり赤くなる)", () => {
      const html = loadFixture("result_202603020211.html");
      const parsed = parseRaceResult(html);
      // 前提固定(空振り防止): パース結果自体が着順どおりの並び([13, 8])であること。
      expect(parsed.exactaPayouts).toEqual({
        state: "parsed",
        payouts: [{ umabans: [13, 8], payout: 8360 }],
      });

      const store = new AnalysisStore();
      store.saveResult("202603020211", [{ umaban: 13, finishPosition: 1 }], parsed.courseType, {
        exacta: parsed.exactaPayouts,
      });

      const result = store.getComboPayouts("202603020211", "exacta");
      expect(result.state).toBe("imported");
      if (result.state !== "imported") throw new Error("unreachable");
      expect(result.payouts).toEqual([{ comboKey: "1308", payout: 8360 }]);
      // ★変異確認用の直接固定: 昇順化されたキー'0813'になっていないこと。
      expect(result.payouts.map((p) => p.comboKey)).not.toContain("0813");
      store.close();
    });
  });

  describe("三連単の確定払戻の取り込み(Issue #131・#25-F: parseRaceResultからgetComboPayoutsまでの結線)", () => {
    it("実フィクスチャ(fixtures/result_202603020211.html)をparseRaceResult→saveResultで保存し、getComboPayoutsで読み出したキーが正順'130805'のままであること(パーサ・ストアのどちらかで昇順化が混入すると'050813'のような別のキーになり赤くなる)", () => {
      const html = loadFixture("result_202603020211.html");
      const parsed = parseRaceResult(html);
      // 前提固定(空振り防止): パース結果自体が着順どおりの並び([13, 8, 5])であること。
      expect(parsed.trifectaPayouts).toEqual({
        state: "parsed",
        payouts: [{ umabans: [13, 8, 5], payout: 52690 }],
      });

      const store = new AnalysisStore();
      store.saveResult("202603020211", [{ umaban: 13, finishPosition: 1 }], parsed.courseType, {
        trifecta: parsed.trifectaPayouts,
      });

      const result = store.getComboPayouts("202603020211", "trifecta");
      expect(result.state).toBe("imported");
      if (result.state !== "imported") throw new Error("unreachable");
      expect(result.payouts).toEqual([{ comboKey: "130805", payout: 52690 }]);
      // ★変異確認用の直接固定: 昇順化されたキー'050813'になっていないこと。
      expect(result.payouts.map((p) => p.comboKey)).not.toContain("050813");
      store.close();
    });
  });

  /**
   * 馬連の払戻(Issue #113・#24-D2)。
   *
   * `RaceComboPayoutsSaveInput`に`quinella?`フィールドを追加する(#106のexactaと同じ形。
   * `combo?.[betType]`が`ComboBetType`の全メンバーを添字に取るため、追加しないと
   * `pnpm typecheck`がTS7053で落ちる。着手前ゲートで発見)。
   *
   * AC-6(★地雷の確認): `COMBO_SIZE`に`quinella`が追加されたことで`COMBO_BET_TYPES`
   * (`Object.keys(COMBO_SIZE)`由来の払戻保存ループ)が馬連も回すようになるが、
   * `comboPayouts`に`quinella`キー自体が無ければDBには一切書かれないことを固定する
   * (このテストは`saveResult`を直接呼び、`quinella`キーを省略した`{wide, trio}`だけを
   * 渡すことでその状況を再現する)。
   *
   * ★`result-import.ts`は引き続き`{wide, trio}`のみを渡す、という記述は本テスト追加時点
   * (#113)では真だったが、**Issue #114・#24-F1で`quinella: result.quinellaPayouts`が
   * 追加され、現在のproductionはこの3つを渡す**(`result-import.test.ts`「組合せ払戻
   * (馬連、Issue #114・#24-F1)の素通し」describe参照)。このテスト自体は
   * `saveResult`の`COMBO_BET_TYPES`ループが`quinella`キー省略時にどう振る舞うかを見る
   * 単体テストであり、production呼び出し形の変化とは独立に成立し続ける。
   */
  describe("馬連の払戻(Issue #113・#24-D2)", () => {
    it("馬連を明示的に渡すと保存・復元できること(型追加が正しく機能することの確認。ワイドと同じ順不同キー)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        quinella: { state: "parsed", payouts: [{ umabans: [8, 13], payout: 4550 }] },
      });
      expect(store.getComboPayouts("R1", "quinella")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "0813", payout: 4550 }],
      });
      store.close();
    });

    it("AC-6: comboPayoutsに{wide, trio}のみを渡し馬連(quinella)キーを省略した場合、馬連はCOMBO_BET_TYPESに含まれてもnot_importedのままであること(馬連の払戻行は書かれない。Issue #114以降のresult-import.tsは実際にはquinellaも渡すが、そのこととは独立に成立する単体テスト)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 120 }] },
        trio: { state: "parsed", payouts: [{ umabans: [1, 2, 5], payout: 240 }] },
      });
      // 前提固定(空振り防止): wide/trioは従来どおり書かれること。
      expect(store.getComboPayouts("R1", "wide").state).toBe("imported");
      expect(store.getComboPayouts("R1", "trio").state).toBe("imported");
      // 本題: quinellaを渡していないので、COMBO_BET_TYPESループが回っても書かれない。
      expect(store.getComboPayouts("R1", "quinella")).toEqual({
        state: "not_imported",
      });
      store.close();
    });
  });

  /**
   * 三連単の払戻(Issue #130・#25-D)。
   *
   * `RaceComboPayoutsSaveInput`に`trifecta?`フィールドを追加する(#106のexacta・#113の
   * quinellaと同じ形。`combo?.[betType]`が`ComboBetType`の全メンバーを添字に取るため、
   * 追加しないと`pnpm typecheck`がTS7053で落ちる。着手前確認で発見)。
   *
   * AC-6相当(★地雷の確認): `COMBO_SIZE`に`trifecta`が追加されたことで`COMBO_BET_TYPES`
   * (`Object.keys(COMBO_SIZE)`由来の払戻保存ループ)が三連単も回すようになるが、
   * `comboPayouts`に`trifecta`キー自体が無ければDBには一切書かれないことを固定する
   * (このテストは`saveResult`を直接呼び、`trifecta`キーを省略した`{wide, trio}`だけを
   * 渡すことでその状況を再現する。払戻の取込配線自体は#131のスコープ)。
   */
  describe("三連単の払戻(Issue #130・#25-D)", () => {
    it("三連単を明示的に渡すと保存・復元できること(型追加が正しく機能することの確認。馬単と同じ順序付きキー)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        trifecta: { state: "parsed", payouts: [{ umabans: [13, 8, 5], payout: 52690 }] },
      });
      expect(store.getComboPayouts("R1", "trifecta")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "130805", payout: 52690 }],
      });
      store.close();
    });

    it("三連単の完全反転(5→8→13)は別キーとして保存されること(着順が意味を持つ券種であることの回帰確認)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        trifecta: { state: "parsed", payouts: [{ umabans: [5, 8, 13], payout: 44270 }] },
      });
      expect(store.getComboPayouts("R1", "trifecta")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "050813", payout: 44270 }],
      });
      store.close();
    });

    it("AC-6相当: comboPayoutsに{wide, trio}のみを渡し三連単(trifecta)キーを省略した場合、三連単はCOMBO_BET_TYPESに含まれてもnot_importedのままであること(三連単の払戻行は書かれない)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 120 }] },
        trio: { state: "parsed", payouts: [{ umabans: [1, 2, 5], payout: 240 }] },
      });
      // 前提固定(空振り防止): wide/trioは従来どおり書かれること。
      expect(store.getComboPayouts("R1", "wide").state).toBe("imported");
      expect(store.getComboPayouts("R1", "trio").state).toBe("imported");
      // 本題: trifectaを渡していないので、COMBO_BET_TYPESループが回っても書かれない。
      expect(store.getComboPayouts("R1", "trifecta")).toEqual({
        state: "not_imported",
      });
      store.close();
    });
  });

  /**
   * 枠連の払戻(Issue #143・#26-D)。
   *
   * `RaceComboPayoutsSaveInput`に`bracketQuinella?`フィールドを追加する(#106・#113・#130と
   * 同じ「型を壊さないための最小追加」。`combo?.[betType]`が`ComboBetType`の全メンバーを
   * 添字に取るため、無いと`pnpm typecheck`がTS7053で落ちる)。払戻の取込の配線
   * (`result-import.ts`が渡すこと・`tr.Wakuren`の解析)はIssue #145・#26-Fで行った
   * (`result-import.test.ts`「組合せ払戻(枠連、Issue #145・#26-F)の取込」参照。
   * このdescribeが固定するのはストア単体の契約であり、その後も有効)。
   *
   * ★地雷の確認: `COMBO_SIZE`に`bracketQuinella`が加わって`COMBO_BET_TYPES`ループが枠連も
   * 回るようになっても、`comboPayouts`に`bracketQuinella`キーが無ければDBには一切書かれない
   * (既存の取込を壊さない)。
   */
  describe("枠連の払戻(Issue #143・#26-D)", () => {
    it("枠連を明示的に渡すと保存・復元できること(順不同の昇順キー。同枠[1,1]は\"0101\")", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        bracketQuinella: {
          state: "parsed",
          payouts: [
            { umabans: [7, 4], payout: 3150 },
            { umabans: [1, 1], payout: 640 },
          ],
        },
      });
      expect(store.getComboPayouts("R1", "bracketQuinella")).toEqual({
        state: "imported",
        payouts: [
          { comboKey: "0101", payout: 640 },
          { comboKey: "0407", payout: 3150 },
        ],
      });
      store.close();
    });

    it("comboPayoutsに{wide, trio}のみを渡し枠連キーを省略した場合、枠連はnot_importedのままであること(枠連の払戻行は書かれず、既存の取込は壊れない)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 120 }] },
        trio: { state: "parsed", payouts: [{ umabans: [1, 2, 5], payout: 240 }] },
      });
      // 前提固定(空振り防止): wide/trioは従来どおり書かれること。
      expect(store.getComboPayouts("R1", "wide").state).toBe("imported");
      expect(store.getComboPayouts("R1", "trio").state).toBe("imported");
      expect(store.getComboPayouts("R1", "bracketQuinella")).toEqual({ state: "not_imported" });
      store.close();
    });
  });

  describe("getComboPayouts(組合せ払戻の読み出し契約。Issue #52 AC9・boss裁定R-4〜R-6)", () => {
    it("一度も取り込んでいないレースは not_imported を返すこと", () => {
      const store = new AnalysisStore();
      expect(store.getComboPayouts("未保存", "wide")).toEqual({
        state: "not_imported",
      });
      store.close();
    });

    it("state:'parsed'かつpayouts:[]で保存すると、imported かつ空配列を返すこと(未発売等・0件でもnot_importedへ退行しない)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [] },
      });
      expect(store.getComboPayouts("R1", "wide")).toEqual({
        state: "imported",
        payouts: [],
      });
      store.close();
    });

    it("1件以上の払戻を保存すると、そのまま復元できること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        trio: {
          state: "parsed",
          payouts: [{ umabans: [1, 2, 5], payout: 240 }],
        },
      });
      expect(store.getComboPayouts("R1", "trio")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "010205", payout: 240 }],
      });
      store.close();
    });

    it("state:'undetermined'を渡して保存しても、DBに一切触れず not_imported のままであること(R-5)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: {
          state: "undetermined",
          reason: {
            kind: "payoutTableAbsent",
            message: "テスト用",
            observedGroupCount: null,
            observedPayoutCount: null,
            rawHtml: null,
          },
        },
      });
      expect(store.getComboPayouts("R1", "wide")).toEqual({
        state: "not_imported",
      });
      store.close();
    });

    it("comboPayouts自体を省略した既存互換の呼び出しでは、DBに一切触れず not_imported のままであること(AC13: 既存呼び出しの非破壊)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      expect(store.getComboPayouts("R1", "wide")).toEqual({
        state: "not_imported",
      });
      expect(store.getComboPayouts("R1", "trio")).toEqual({
        state: "not_imported",
      });
      store.close();
    });

    it("複数組を保存すると combo_key 昇順で決定的に返ること(getResultのORDER BY umabanと同じ流儀)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: {
          state: "parsed",
          payouts: [
            { umabans: [1, 4], payout: 150 },
            { umabans: [1, 2], payout: 100 },
            { umabans: [2, 4], payout: 200 },
          ],
        },
      });
      const result = store.getComboPayouts("R1", "wide");
      expect(result.state).toBe("imported");
      if (result.state === "imported") {
        expect(result.payouts.map((p) => p.comboKey)).toEqual([
          "0102",
          "0104",
          "0204",
        ]);
      }
      store.close();
    });

    it("wideとtrioは互いに独立して保存・読み出しできること(片方だけ保存してももう片方はnot_importedのまま)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 100 }] },
      });
      expect(store.getComboPayouts("R1", "wide")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "0102", payout: 100 }],
      });
      expect(store.getComboPayouts("R1", "trio")).toEqual({
        state: "not_imported",
      });
      store.close();
    });
  });

  describe("saveResultの組合せ払戻: 単一トランザクション・再取込の境界(Issue #52 AC7・AC8・boss裁定R-7〜R-9)", () => {
    it("courseType同様、comboPayouts省略時はrace_combo_payouts/race_combo_payout_importsに一切触れないこと(既存呼び出しの非破壊)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const comboRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_combo_payouts WHERE race_id = ?`)
        .get("R1") as { c: number };
      const markerRow = store.rawDatabase
        .prepare(
          `SELECT COUNT(*) AS c FROM race_combo_payout_imports WHERE race_id = ?`,
        )
        .get("R1") as { c: number };
      expect(comboRow.c).toBe(0);
      expect(markerRow.c).toBe(0);
      store.close();
    });

    it("再取込の境界1: 3組保存済みの状態で2組に減らして再取込すると、古い行が1つも残らないこと(AC8)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: {
          state: "parsed",
          payouts: [
            { umabans: [1, 2], payout: 100 },
            { umabans: [1, 3], payout: 150 },
            { umabans: [2, 3], payout: 200 },
          ],
        },
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: {
          state: "parsed",
          payouts: [{ umabans: [1, 2], payout: 110 }],
        },
      });
      const result = store.getComboPayouts("R1", "wide");
      // 前提: 再取込後の件数をまず無条件に固定する(空振り防止。「1組も残らない」は
      // 「2件消えて1件残る」ことを含意するため、件数そのものを固定する)。
      expect(result.state).toBe("imported");
      if (result.state === "imported") {
        expect(result.payouts).toHaveLength(1);
        expect(result.payouts).toEqual([{ comboKey: "0102", payout: 110 }]);
      }
      store.close();
    });

    it("再取込の境界2: 3組保存済みの状態でstate:'undetermined'で再取込すると、3組がそのまま保持されること(消えない。一過性の構造異常で正しい過去データを破壊しない)", () => {
      const store = new AnalysisStore();
      const threeEntries = [
        { umabans: [1, 2], payout: 100 },
        { umabans: [1, 3], payout: 150 },
        { umabans: [2, 3], payout: 200 },
      ];
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: threeEntries },
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: {
          state: "undetermined",
          reason: {
            kind: "groupCountMismatch",
            message: "テスト用(一過性の構造異常を模す)",
            observedGroupCount: 2,
            observedPayoutCount: 1,
            rawHtml: null,
          },
        },
      });
      const result = store.getComboPayouts("R1", "wide");
      expect(result.state).toBe("imported");
      if (result.state === "imported") {
        expect(result.payouts).toHaveLength(3);
        expect(result.payouts.map((p) => p.comboKey)).toEqual([
          "0102",
          "0103",
          "0203",
        ]);
      }
      store.close();
    });

    it("再取込の境界3: 3組保存済みの状態でstate:'parsed'かつpayouts:[]で再取込すると、0組になりimportedのまま(not_importedへ退行しない)であること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: {
          state: "parsed",
          payouts: [
            { umabans: [1, 2], payout: 100 },
            { umabans: [1, 3], payout: 150 },
            { umabans: [2, 3], payout: 200 },
          ],
        },
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [] },
      });
      const result = store.getComboPayouts("R1", "wide");
      expect(result).toEqual({ state: "imported", payouts: [] });
      store.close();
    });

    it("race_results・race_combo_payoutsを単一トランザクションで書くこと(AC7の直接固定)", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 100 }] },
      });
      const resultRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_results WHERE race_id = ?`)
        .get("R1") as { c: number };
      const comboRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_combo_payouts WHERE race_id = ?`)
        .get("R1") as { c: number };
      const markerRow = store.rawDatabase
        .prepare(
          `SELECT COUNT(*) AS c FROM race_combo_payout_imports WHERE race_id = ? AND bet_type = 'wide'`,
        )
        .get("R1") as { c: number };
      expect(resultRow.c).toBe(1);
      expect(comboRow.c).toBe(1);
      expect(markerRow.c).toBe(1);
      store.close();
    });

    /**
     * 上のテスト(件数1/1/1)は「保存できたこと」の事後条件であり、非トランザクション実装
     * (race_resultsを書いた後にrace_combo_payoutsの書き込みで例外が起きても、race_results側は
     * 巻き戻らない実装)でも同じ値になる。これでは「単一トランザクションで書くこと」自体の
     * 検出力が無い(boss メタレビュー・要修正2)。
     *
     * 検出力のある反例: 正規化後(buildComboOddsKey適用後)で同一になる組を2件渡すと、
     * race_combo_payoutsのPRIMARY KEY(race_id, bet_type, combo_key)違反で例外が飛ぶ
     * (このテスト自体はcode-reviewerの一次レビューR-12プローブがアドホックに確認した現象を
     * 固定化したもの)。単一トランザクションで書かれているなら、この例外でrace_results側も
     * 巻き戻り、getResultはundefinedを返すはずである。もし将来 db.transaction(...) が
     * 素の関数呼び出しに置き換えられる退行が起きた場合、race_resultsの書き込みは既に
     * コミット済みのまま残ってしまい、このアサーションが失敗して検知できる。
     */
    it("正規化後に重複するcombo_key(例: [1,2]と[2,1]はどちらも\"0102\")を渡すとPRIMARY KEY違反で例外を投げ、race_results側も巻き戻ってgetResultがundefinedになること(AC7の原子性を検出力を持たせて直接固定する)", () => {
      const store = new AnalysisStore();
      expect(() =>
        store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
          wide: {
            state: "parsed",
            payouts: [
              { umabans: [1, 2], payout: 100 },
              { umabans: [2, 1], payout: 100 }, // 正規化後は同一キー"0102"
            ],
          },
        }),
      ).toThrow();
      // 単一トランザクションでなければ、race_combo_payouts側の例外前に既にコミット済みの
      // race_results行が残ってしまう。ここが緑のままだと原子性が壊れていても気づけない。
      expect(store.getResult("R1")).toBeUndefined();
      store.close();
    });
  });

  describe("配分提案の永続化(analysis_allocation_meta / analysis_bets、Issue #59)", () => {
    /** テスト用のメタ行(#59スキーマ24列。Issue #118でinclude_quinella・#126でinclude_exacta・#140でinclude_trifecta・#151でinclude_bracket_quinellaを追加し20→21→22→23→24列)を最小上書きで組み立てる。 */
    function makeMeta(
      overrides: Partial<AnalysisAllocationMetaRecord> = {},
    ): AnalysisAllocationMetaRecord {
      return {
        route: "mixed",
        unavailableReason: null,
        fallbackReason: null,
        skipReasonCode: null,
        comboOddsWide: null,
        comboOddsTrio: null,
        bankroll: 100000,
        perRaceCap: 10000,
        kellyFraction: 0.5,
        evThreshold: 1.0,
        includeComboOdds: true,
        includeWide: true,
        includeTrio: true,
        includeQuinella: true,
        includeExacta: true,
        includeTrifecta: true,
        includeBracketQuinella: true,
        betUnit: 100,
        greedySteps: 1000,
        candidateCap: 2000,
        modelId: "conditional-bernoulli",
        modelApproximate: false,
        oddsStatus: "result",
        ...overrides,
      };
    }

    /** analysis_allocation_meta の生行(snake_case)を取得する。 */
    function rawMetaRow(store: AnalysisStore, analysisId: number): unknown {
      return store.rawDatabase
        .prepare(`SELECT * FROM analysis_allocation_meta WHERE analysis_id = ?`)
        .get(analysisId);
    }

    it("AC2: route=unset のメタ行が全24列で固定どおりに保存されること(coreの配分計算に未到達=設定エコー以外は全null。Issue #118でinclude_quinella列を追加し20→21列・Issue #126でinclude_exacta列を追加し21→22列・Issue #140でinclude_trifecta列を追加し22→23列・Issue #151でinclude_bracket_quinella列を追加し23→24列)", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "配分unsetレース",
          allocation: {
            meta: makeMeta({
              route: "unset",
              fallbackReason: null,
              skipReasonCode: null,
              comboOddsWide: null,
              comboOddsTrio: null,
              bankroll: 0,
              perRaceCap: 0,
              includeComboOdds: false,
              // code-reviewer水平展開レビュー(finding1・finding「includeWideのfalse分岐が
              // 一度も踏まれない」の両方に対応): include_wideがこの describe 全体で常にtrue(=1)
              // だと、(a) ev_threshold(1.0→JSでは1)との束縛入れ替えを検出できず、
              // (b) `m.includeWide ? 1 : 0` のfalse分岐を固定できない。この経路でfalseにする。
              includeWide: false,
              includeTrio: true,
              // Issue #118(#24-D3b-3): include_quinellaがこのdescribe全体でtrueのみだと
              // `m.includeQuinella ? 1 : 0`のfalse分岐を固定できない。この経路でfalseにする。
              includeQuinella: false,
              // Issue #126(#24-E3c): include_exactaはこの経路でtrueにする(include_quinellaと
              // 逆の値にすることで、隣接列どうしの入れ替え変異〈include_quinella⇔include_exacta〉を
              // この経路単体でも検出できるようにする)。
              includeExacta: true,
              // Issue #140(#25-E3c): include_trifectaはこの経路でtrueにする。4経路全体での
              // include_quinella列パターン[F,T,T,F]・include_exacta列パターン[T,F,T,F]の
              // いずれとも2箇所以上で異なるパターン[T,T,F,T]にすることで、隣接列どうしの
              // 入れ替え変異〈include_exacta⇔include_trifecta〉をこの経路単体でも検出できる
              // ようにする。
              includeTrifecta: true,
              // Issue #151(#26-E3c): include_bracket_quinella列のパターンは4経路[unset,place-only,
              // unavailable,mixed]=[F,F,T,T]。include_quinella[F,T,T,F]・include_exacta[T,F,T,F]・
              // include_trifecta[T,T,F,T]・include_combo_odds[F,F,F,T]のいずれとも一致しないため、
              // 隣接列との入れ替え・定数化・include_combo_odds(直前の設定エコー)との取り違えを
              // 4経路の合計で検出できる。
              includeBracketQuinella: false,
              betUnit: null,
              greedySteps: null,
              candidateCap: null,
              modelId: null,
              modelApproximate: null,
              oddsStatus: "result",
            }),
            bets: [],
          },
        }),
      );
      expect(rawMetaRow(store, id)).toEqual({
        analysis_id: id,
        route: "unset",
        unavailable_reason: null,
        fallback_reason: null,
        skip_reason_code: null,
        combo_odds_wide: null,
        combo_odds_trio: null,
        bankroll: 0,
        per_race_cap: 0,
        kelly_fraction: 0.5,
        ev_threshold: 1.0,
        include_combo_odds: 0,
        include_wide: 0,
        include_trio: 1,
        include_quinella: 0,
        include_exacta: 1,
        include_trifecta: 1,
        include_bracket_quinella: 0,
        bet_unit: null,
        greedy_steps: null,
        candidate_cap: null,
        model_id: null,
        model_approximate: null,
        odds_status: "result",
      });
      store.close();
    });

    it("AC2: route=place-only(includeComboOdds=false)のメタ行が全24列で固定どおりに保存されること(candidate_capはplace-only経路に存在しないためnull。Issue #118でinclude_quinella列を追加し20→21列・Issue #126でinclude_exacta列を追加し21→22列・Issue #140でinclude_trifecta列を追加し22→23列・Issue #151でinclude_bracket_quinella列を追加し23→24列)", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "配分place-onlyレース",
          allocation: {
            meta: makeMeta({
              route: "place-only",
              unavailableReason: null,
              fallbackReason: "combo-odds-not-requested",
              skipReasonCode: "reference-ev-not-positive",
              comboOddsWide: null,
              comboOddsTrio: null,
              includeComboOdds: false,
              // boss差し戻し(M2): include_wide/include_trioが全フィクスチャでtrue/true同値だと
              // 束縛の入れ替えを検出できない。この経路でtrueとfalseに分ける。
              includeWide: true,
              includeTrio: false,
              // Issue #118(#24-D3b-3): unsetテストでfalseを踏んだので、この経路ではtrueにする
              // (2値以上を観測。「定数直書き」への退行を検出できるようにする)。
              includeQuinella: true,
              // Issue #126(#24-E3c): unsetテストでtrueを踏んだので、この経路ではfalseにする
              // (2値以上の観測に加え、include_quinella=trueと組み合わせることでこの経路単体でも
              // 隣接列の入れ替え変異を検出できるようにする)。
              includeExacta: false,
              // Issue #140(#25-E3c): unsetテストでtrueを踏んだので、この経路でも改めてtrueにする
              // (include_quinella=trueと同値の組み合わせも1経路は作り、「隣接列が常に逆の値」
              // という別の交絡を避ける。パターン設計は上記unsetテストのコメント参照)。
              includeTrifecta: true,
              // Issue #151(#26-E3c): この経路はfalse(パターンは上記unsetテストのコメント参照)。
              includeBracketQuinella: false,
              betUnit: 100,
              greedySteps: 1000,
              candidateCap: null,
              modelId: "conditional-bernoulli",
              // code-reviewer水平展開レビュー(finding2): この describe 全体で
              // modelApproximateがfalse/nullのみだと、`m.modelApproximate === null ? null :
              // m.modelApproximate ? 1 : 0` のtrue→1分岐が一度もDB往復を通らない。この経路でtrueにする。
              modelApproximate: true,
              oddsStatus: "middle",
            }),
            bets: [],
          },
        }),
      );
      expect(rawMetaRow(store, id)).toEqual({
        analysis_id: id,
        route: "place-only",
        unavailable_reason: null,
        fallback_reason: "combo-odds-not-requested",
        skip_reason_code: "reference-ev-not-positive",
        combo_odds_wide: null,
        combo_odds_trio: null,
        bankroll: 100000,
        per_race_cap: 10000,
        kelly_fraction: 0.5,
        ev_threshold: 1.0,
        include_combo_odds: 0,
        include_wide: 1,
        include_trio: 0,
        include_quinella: 1,
        include_exacta: 0,
        include_trifecta: 1,
        include_bracket_quinella: 0,
        bet_unit: 100,
        greedy_steps: 1000,
        candidate_cap: null,
        model_id: "conditional-bernoulli",
        model_approximate: 1,
        odds_status: "middle",
      });
      store.close();
    });

    it("AC2: route=unavailable のメタ行が全24列で固定どおりに保存されること(unavailable_reasonが非nullになる唯一の経路。boss差し戻しM1の再発防止。Issue #118でinclude_quinella列を追加し20→21列・Issue #126でinclude_exacta列を追加し21→22列・Issue #140でinclude_trifecta列を追加し22→23列・Issue #151でinclude_bracket_quinella列を追加し23→24列)", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "配分unavailableレース",
          allocation: {
            meta: makeMeta({
              route: "unavailable",
              unavailableReason: "two-place-only",
              fallbackReason: "combo-odds-not-requested",
              skipReasonCode: null,
              comboOddsWide: null,
              comboOddsTrio: null,
              bankroll: 100000,
              perRaceCap: 10000,
              // coordinator水平展開レビュー(定数置換の穴): kellyFractionが4テストとも0.5だと
              // `m.kellyFraction`を0.5のリテラル直書きに変異させても検出できない
              // (実測: core 2072件が全緑になることを確認済み)。この経路で0.5以外にする。
              kellyFraction: 0.7,
              includeComboOdds: false,
              includeWide: true,
              includeTrio: true,
              // Issue #118(#24-D3b-3): unsetでfalse・place-onlyでtrueを踏んだので、
              // この経路でも改めてtrueにする(この経路自体でも非デフォルトの値を通す)。
              includeQuinella: true,
              // Issue #126(#24-E3c): unsetでtrue・place-onlyでfalseを踏んだので、この経路でも
              // 改めてtrueにする(include_quinellaと同値の組み合わせも1経路は作り、
              // 「隣接列が常に逆の値」という別の交絡〈#59の反省〉を避ける)。
              includeExacta: true,
              // Issue #140(#25-E3c): unset・place-onlyでtrueを踏んだので、この経路ではfalseにする
              // (4経路全体でtrue/falseの両方を踏む。パターン設計は上記unsetテストのコメント参照)。
              includeTrifecta: false,
              // Issue #151(#26-E3c): この経路はtrue(パターンは上記unsetテストのコメント参照)。
              includeBracketQuinella: true,
              // coreの配分計算に未到達(unset/yoso/unavailableと同じ扱い)。
              betUnit: null,
              greedySteps: null,
              candidateCap: null,
              modelId: null,
              modelApproximate: null,
              oddsStatus: "result",
            }),
            bets: [],
          },
        }),
      );
      expect(rawMetaRow(store, id)).toEqual({
        analysis_id: id,
        route: "unavailable",
        unavailable_reason: "two-place-only",
        fallback_reason: "combo-odds-not-requested",
        skip_reason_code: null,
        combo_odds_wide: null,
        combo_odds_trio: null,
        bankroll: 100000,
        per_race_cap: 10000,
        kelly_fraction: 0.7,
        ev_threshold: 1.0,
        include_combo_odds: 0,
        include_wide: 1,
        include_trio: 1,
        include_quinella: 1,
        include_exacta: 1,
        include_trifecta: 0,
        include_bracket_quinella: 1,
        bet_unit: null,
        greedy_steps: null,
        candidate_cap: null,
        model_id: null,
        model_approximate: null,
        odds_status: "result",
      });
      store.close();
    });

    it("AC2: route=mixed のメタ行が全24列で固定どおりに保存されること(candidate_cap・comboOdds診断値とも非null。Issue #118でinclude_quinella列を追加し20→21列・Issue #126でinclude_exacta列を追加し21→22列・Issue #140でinclude_trifecta列を追加し22→23列・Issue #151でinclude_bracket_quinella列を追加し23→24列)", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "配分mixedレース",
          allocation: {
            meta: makeMeta({
              route: "mixed",
              unavailableReason: null,
              fallbackReason: null,
              skipReasonCode: null,
              // boss差し戻し(M3): combo_odds_wide/trioが全フィクスチャで同値だと束縛の入れ替えを
              // 検出できない。この経路でwideとtrioを異ならせる。
              comboOddsWide: "present",
              comboOddsTrio: "empty",
              // coordinator水平展開レビュー(定数置換の穴): evThresholdが4テストとも1.0だと
              // `m.evThreshold`を1.0のリテラル直書きに変異させても検出できない
              // (実測: core 2072件が全緑になることを確認済み)。この経路で1.0以外にする。
              evThreshold: 1.3,
              // Issue #118(#24-D3b-3): unset/false・place-only/true・unavailable/trueと来たので、
              // この経路(mixed)ではfalseに戻す(4テスト全体でtrue/falseの両方を踏む)。
              includeQuinella: false,
              // Issue #126(#24-E3c): unset/true・place-only/false・unavailable/trueと来たので、
              // この経路(mixed)ではfalseにする(4テスト全体でtrue/falseの両方を踏む。
              // includeQuinella=falseと同値にすることで、4経路全体でのincludeQuinella列パターン
              // [F,T,T,F]とincludeExacta列パターン[T,F,T,F]が2箇所〈unset・place-only〉で異なり、
              // 列どうしの丸ごと入れ替え変異を検出できる)。
              includeExacta: false,
              // Issue #140(#25-E3c): unset/true・place-only/true・unavailable/falseと来たので、
              // この経路(mixed)ではtrueにする(makeMetaの既定値どおりだが、4経路全体での
              // include_trifecta列パターン[T,T,F,T]をこの経路でも明示する。このパターンは
              // include_quinella[F,T,T,F]・include_exacta[T,F,T,F]のいずれとも2箇所以上で
              // 異なり、3列間どうしの入れ替え変異〈include_exacta⇔include_trifecta等〉を検出できる)。
              includeTrifecta: true,
              // Issue #151(#26-E3c): この経路はtrue(パターンは上記unsetテストのコメント参照)。
              includeBracketQuinella: true,
            }),
            bets: [],
          },
        }),
      );
      expect(rawMetaRow(store, id)).toEqual({
        analysis_id: id,
        route: "mixed",
        unavailable_reason: null,
        fallback_reason: null,
        skip_reason_code: null,
        combo_odds_wide: "present",
        combo_odds_trio: "empty",
        bankroll: 100000,
        per_race_cap: 10000,
        kelly_fraction: 0.5,
        ev_threshold: 1.3,
        include_combo_odds: 1,
        include_wide: 1,
        include_trio: 1,
        include_quinella: 0,
        include_exacta: 0,
        include_trifecta: 1,
        include_bracket_quinella: 1,
        bet_unit: 100,
        greedy_steps: 1000,
        candidate_cap: 2000,
        model_id: "conditional-bernoulli",
        model_approximate: 0,
        odds_status: "result",
      });
      store.close();
    });

    it("AC3(明細の一部): stake>0の明細行だけが保存され、bet_type・combo_keyがそのまま往復すること(#59決定(b)(c))", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "配分明細レース",
          allocation: {
            meta: makeMeta(),
            bets: [
              { betType: "place", comboKey: "07", stake: 300, odds: 2.5, ev: 1.2 },
              { betType: "wide", comboKey: "0102", stake: 500, odds: 3.1, ev: 1.05 },
              { betType: "trio", comboKey: "010203", stake: 100, odds: 12.4, ev: 1.4 },
            ],
          },
        }),
      );
      const rows = store.rawDatabase
        .prepare(
          `SELECT bet_type, combo_key, stake, odds, ev FROM analysis_bets WHERE analysis_id = ? ORDER BY bet_type`,
        )
        .all(id);
      expect(rows).toEqual([
        { bet_type: "place", combo_key: "07", stake: 300, odds: 2.5, ev: 1.2 },
        { bet_type: "trio", combo_key: "010203", stake: 100, odds: 12.4, ev: 1.4 },
        { bet_type: "wide", combo_key: "0102", stake: 500, odds: 3.1, ev: 1.05 },
      ]);
      store.close();
    });

    it("AC4: allocationを渡さずに保存した分析には、メタ行・明細行のいずれも作られないこと(旧分析=記録なしとの区別)", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(makeRecord({ raceId: "配分未指定レース" }));
      expect(rawMetaRow(store, id)).toBeUndefined();
      const betCount = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM analysis_bets WHERE analysis_id = ?`)
        .get(id) as { c: number };
      expect(betCount.c).toBe(0);
      store.close();
    });

    it("AC5-1(原子性): 明細のPRIMARY KEY違反(同一analysis_id・bet_type・combo_keyが2件)でsaveAnalysisがthrowし、analyses・analysis_horses・メタ・明細のどの行も残らないこと", () => {
      const store = new AnalysisStore();
      expect(() =>
        store.saveAnalysis(
          makeRecord({
            raceId: "原子性違反レース",
            allocation: {
              meta: makeMeta(),
              bets: [
                { betType: "wide", comboKey: "0102", stake: 100, odds: 3.0, ev: 1.1 },
                { betType: "wide", comboKey: "0102", stake: 200, odds: 3.0, ev: 1.1 }, // 同一キー重複
              ],
            },
          }),
        ),
      ).toThrow();
      // 単一トランザクションでなければ、analyses/analysis_horses/メタ行は例外前に
      // 既にコミット済みのまま残ってしまう(race_combo_payoutsの原子性テストと同じ検出力)。
      expect(store.listAnalyses({ raceId: "原子性違反レース" })).toHaveLength(0);
      const counts = store.rawDatabase
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM analyses) AS analyses,
             (SELECT COUNT(*) FROM analysis_horses) AS horses,
             (SELECT COUNT(*) FROM analysis_allocation_meta) AS meta,
             (SELECT COUNT(*) FROM analysis_bets) AS bets`,
        )
        .get() as { analyses: number; horses: number; meta: number; bets: number };
      expect(counts).toEqual({ analyses: 0, horses: 0, meta: 0, bets: 0 });
      store.close();
    });

    describe("getAllocationForVerify(配分提案の読み出し。Issue #71 AC-B1/AC-B2)", () => {
      it("AC-B1: メタ行が無ければundefinedを返すこと(#59より前の旧分析=記録なし)", () => {
        const store = new AnalysisStore();
        const id = store.saveAnalysis(makeRecord({ raceId: "読み出し記録なしレース" }));
        expect(store.getAllocationForVerify(id)).toBeUndefined();
        store.close();
      });

      it("AC-B1: route=unsetのメタ行もroute=\"unset\"としてそのまま読み出せること(配分あり/見送り/未到達の分類自体はverify.ts側の責務であり、ここでは値の往復のみを保証する)", () => {
        const store = new AnalysisStore();
        const id = store.saveAnalysis(
          makeRecord({
            raceId: "読み出しunsetレース",
            allocation: {
              meta: makeMeta({
                route: "unset",
                skipReasonCode: null,
                bankroll: 0,
                perRaceCap: 0,
                betUnit: null,
                greedySteps: null,
                candidateCap: null,
                modelId: null,
                modelApproximate: null,
              }),
              bets: [],
            },
          }),
        );
        expect(store.getAllocationForVerify(id)).toEqual({
          route: "unset",
          skipReasonCode: null,
          bets: [],
        });
        store.close();
      });

      it("AC-B2: 5つの束縛箇所(route/skip_reason_code/bet_type/combo_key/stake)が値としてDB往復すること(明細例はIssue本文どおり)", () => {
        const store = new AnalysisStore();

        // 配分あり相当: 複勝・ワイド・3連複の3明細(Issue本文の明細例をそのまま使う)。
        const allocatedId = store.saveAnalysis(
          makeRecord({
            raceId: "読み出し配分ありレース",
            allocation: {
              meta: makeMeta({ route: "mixed", skipReasonCode: null }),
              bets: [
                { betType: "place", comboKey: "07", stake: 100, odds: 2.5, ev: 1.2 },
                { betType: "wide", comboKey: "0102", stake: 300, odds: 3.1, ev: 1.05 },
                { betType: "trio", comboKey: "010203", stake: 200, odds: 12.4, ev: 1.4 },
              ],
            },
          }),
        );
        // 見送り相当: 複勝のみ1明細、skip_reason_codeが非null。
        const skippedId = store.saveAnalysis(
          makeRecord({
            raceId: "読み出し見送りレース",
            allocation: {
              meta: makeMeta({
                route: "place-only",
                skipReasonCode: "reference-ev-not-positive",
              }),
              bets: [{ betType: "place", comboKey: "09", stake: 400, odds: 2.1, ev: 0.9 }],
            },
          }),
        );
        // 未到達相当(route=unsetは直上のテストで単独固定済みのため、ここではyosoを使い
        // routeが3値目を取ることでA'〈2値以上〉を余裕を持って満たす)。
        const unreachedId = store.saveAnalysis(
          makeRecord({
            raceId: "読み出し未到達レース",
            allocation: {
              meta: makeMeta({
                route: "yoso",
                skipReasonCode: null,
                betUnit: null,
                greedySteps: null,
                candidateCap: null,
                modelId: null,
                modelApproximate: null,
              }),
              bets: [],
            },
          }),
        );

        // 束縛箇所ごとの値の内訳(条件A0・A'):
        // - route: "mixed"/"place-only"/"yoso" の3値
        // - skip_reason_code: null / "reference-ev-not-positive" の2値
        // - bet_type: "place"/"wide"/"trio" の3値(4行中)
        // - combo_key: "07"/"0102"/"010203"/"09" の4値
        // - stake: 100/300/200/400 の4値
        // 条件B: route([mixed,place-only,yoso])とskip_reason_code([null,文字列,null])は
        // 値の型(nullの有無)からして一致し得ず、bet_type/combo_key/stakeもそれぞれ文字列/
        // 文字列/数値で値集合が重ならないため、5箇所いずれも他と値ベクトルが一致しない。
        expect(store.getAllocationForVerify(allocatedId)).toEqual({
          route: "mixed",
          skipReasonCode: null,
          bets: [
            { betType: "place", comboKey: "07", stake: 100 },
            { betType: "trio", comboKey: "010203", stake: 200 },
            { betType: "wide", comboKey: "0102", stake: 300 },
          ],
        });
        expect(store.getAllocationForVerify(skippedId)).toEqual({
          route: "place-only",
          skipReasonCode: "reference-ev-not-positive",
          bets: [{ betType: "place", comboKey: "09", stake: 400 }],
        });
        expect(store.getAllocationForVerify(unreachedId)).toEqual({
          route: "yoso",
          skipReasonCode: null,
          bets: [],
        });
        store.close();
      });
    });

    describe("getStoredAllocation(配分提案の読み出し。Issue #55)", () => {
      /**
       * 読む17列の基準値(boss裁定2026-09-02: combo_odds_wide/combo_odds_trioを除いた13列。
       * Issue #118(#24-D3b-3)でinclude_quinellaを追加し13→14列、Issue #126(#24-E3c)で
       * include_exactaを追加し14→15列、Issue #140(#25-E3c)でinclude_trifectaを追加し
       * 15→16列、Issue #151(#26-E3c)でinclude_bracket_quinellaを追加し16→17列。
       * include_bracket_quinellaはfalseにして、SELECT文で隣接するinclude_trifecta(true)との
       * 入れ替え変異を検出できるようにする)。
       * 全列が互いに異なる値を持つよう選び、束縛箇所の取り違え(条件B)を機械的に検出できるようにする
       * (includeQuinella=true・includeExacta=falseと値を逆にし、includeTrifecta=trueで
       * includeQuinellaと揃えることで、SELECT文で隣接する2組〈include_quinella⇔include_exacta・
       * include_exacta⇔include_trifecta〉双方の入れ替えを検出できるようにする)。
       */
      function baselineMeta(
        overrides: Partial<AnalysisAllocationMetaRecord> = {},
      ): AnalysisAllocationMetaRecord {
        return makeMeta({
          route: "mixed",
          unavailableReason: "not-sold",
          fallbackReason: "no-combo-candidates",
          skipReasonCode: "kelly-zero",
          bankroll: 111111,
          perRaceCap: 22222,
          kellyFraction: 0.33,
          evThreshold: 1.05,
          includeComboOdds: true,
          includeWide: false,
          includeTrio: true,
          includeQuinella: true,
          includeExacta: false,
          includeTrifecta: true,
          includeBracketQuinella: false,
          betUnit: 150,
          oddsStatus: "middle",
          ...overrides,
        });
      }

      const BASELINE_BET: {
        betType: string;
        comboKey: string;
        stake: number;
        odds: number | null;
        ev: number | null;
      } = {
        betType: "place",
        comboKey: "03",
        stake: 500,
        odds: 2.7,
        ev: 1.15,
      };

      it("メタ行が無ければundefinedを返すこと(#59より前の旧分析=記録なし)", () => {
        const store = new AnalysisStore();
        const id = store.saveAnalysis(makeRecord({ raceId: "getStoredAllocation記録なしレース" }));
        expect(store.getStoredAllocation(id)).toBeUndefined();
        store.close();
      });

      it("読む17列 + bets(betType/comboKey/stake/odds/ev)がすべて値として往復し、読まない列を戻り値に含まないこと(Issue #118でinclude_quinellaを追加し13→14列・Issue #126でinclude_exactaを追加し14→15列・Issue #140でinclude_trifectaを追加し15→16列・Issue #151でinclude_bracket_quinellaを追加し16→17列)", () => {
        const store = new AnalysisStore();
        const id = store.saveAnalysis(
          makeRecord({
            raceId: "getStoredAllocation全体像レース",
            allocation: {
              meta: baselineMeta(),
              bets: [
                { betType: "place", comboKey: "07", stake: 100, odds: 2.5, ev: 1.2 },
                { betType: "wide", comboKey: "0102", stake: 300, odds: 3.1, ev: 1.05 },
                { betType: "trio", comboKey: "010203", stake: 200, odds: 12.4, ev: 1.4 },
              ],
            },
          }),
        );
        const result = store.getStoredAllocation(id);
        expect(result).toEqual({
          route: "mixed",
          unavailableReason: "not-sold",
          fallbackReason: "no-combo-candidates",
          skipReasonCode: "kelly-zero",
          bankroll: 111111,
          perRaceCap: 22222,
          kellyFraction: 0.33,
          evThreshold: 1.05,
          includeComboOdds: true,
          includeWide: false,
          includeTrio: true,
          includeQuinella: true,
          includeExacta: false,
          includeTrifecta: true,
          includeBracketQuinella: false,
          betUnit: 150,
          oddsStatus: "middle",
          bets: [
            { betType: "place", comboKey: "07", stake: 100, odds: 2.5, ev: 1.2 },
            { betType: "trio", comboKey: "010203", stake: 200, odds: 12.4, ev: 1.4 },
            { betType: "wide", comboKey: "0102", stake: 300, odds: 3.1, ev: 1.05 },
          ],
        });
        // 読まない6列(combo_odds_wide/combo_odds_trio/greedy_steps/candidate_cap/model_id/
        // model_approximate)に対応するキーが戻り値オブジェクトに一切現れないこと(誰も読まない
        // 列にコストを払わない#71原則の裏返し。余計なフィールドが型を超えて漏れていないか)。
        expect(Object.keys(result!)).not.toContain("comboOddsWide");
        expect(Object.keys(result!)).not.toContain("comboOddsTrio");
        expect(Object.keys(result!)).not.toContain("greedySteps");
        expect(Object.keys(result!)).not.toContain("candidateCap");
        expect(Object.keys(result!)).not.toContain("modelId");
        expect(Object.keys(result!)).not.toContain("modelApproximate");
        store.close();
      });

      /** 1件のメタ列差分テストの仕様: どの列を書き換えるか・書き換え後のDB生値・対応するJSフィールドと期待値。 */
      interface MetaColumnCase {
        readonly label: string;
        readonly metaOverride: Partial<AnalysisAllocationMetaRecord>;
        readonly column: string;
        readonly sentinelDbValue: number | string | null;
        readonly field: keyof StoredAllocation;
        readonly expectedValue: unknown;
      }

      const metaColumnCases: readonly MetaColumnCase[] = [
        {
          label: "route",
          metaOverride: {},
          column: "route",
          sentinelDbValue: "SENTINEL_ROUTE",
          field: "route",
          expectedValue: "SENTINEL_ROUTE",
        },
        {
          label: "unavailable_reason(非null→null)",
          metaOverride: {},
          column: "unavailable_reason",
          sentinelDbValue: null,
          field: "unavailableReason",
          expectedValue: null,
        },
        {
          label: "unavailable_reason(null→非null)",
          metaOverride: { unavailableReason: null },
          column: "unavailable_reason",
          sentinelDbValue: "SENTINEL_UNAVAILABLE_REASON",
          field: "unavailableReason",
          expectedValue: "SENTINEL_UNAVAILABLE_REASON",
        },
        {
          label: "fallback_reason(非null→null)",
          metaOverride: {},
          column: "fallback_reason",
          sentinelDbValue: null,
          field: "fallbackReason",
          expectedValue: null,
        },
        {
          label: "fallback_reason(null→非null)",
          metaOverride: { fallbackReason: null },
          column: "fallback_reason",
          sentinelDbValue: "SENTINEL_FALLBACK_REASON",
          field: "fallbackReason",
          expectedValue: "SENTINEL_FALLBACK_REASON",
        },
        {
          label: "skip_reason_code(非null→null)",
          metaOverride: {},
          column: "skip_reason_code",
          sentinelDbValue: null,
          field: "skipReasonCode",
          expectedValue: null,
        },
        {
          label: "skip_reason_code(null→非null)",
          metaOverride: { skipReasonCode: null },
          column: "skip_reason_code",
          sentinelDbValue: "SENTINEL_SKIP_CODE",
          field: "skipReasonCode",
          expectedValue: "SENTINEL_SKIP_CODE",
        },
        {
          label: "bankroll",
          metaOverride: {},
          column: "bankroll",
          sentinelDbValue: 987654.25,
          field: "bankroll",
          expectedValue: 987654.25,
        },
        {
          label: "per_race_cap",
          metaOverride: {},
          column: "per_race_cap",
          sentinelDbValue: 54321.5,
          field: "perRaceCap",
          expectedValue: 54321.5,
        },
        {
          label: "kelly_fraction",
          metaOverride: {},
          column: "kelly_fraction",
          sentinelDbValue: 0.777,
          field: "kellyFraction",
          expectedValue: 0.777,
        },
        {
          label: "ev_threshold",
          metaOverride: {},
          column: "ev_threshold",
          sentinelDbValue: 2.34,
          field: "evThreshold",
          expectedValue: 2.34,
        },
        {
          label: "include_combo_odds(true→false)",
          metaOverride: { includeComboOdds: true },
          column: "include_combo_odds",
          sentinelDbValue: 0,
          field: "includeComboOdds",
          expectedValue: false,
        },
        {
          label: "include_combo_odds(false→true)",
          metaOverride: { includeComboOdds: false },
          column: "include_combo_odds",
          sentinelDbValue: 1,
          field: "includeComboOdds",
          expectedValue: true,
        },
        {
          label: "include_wide(false→true)",
          metaOverride: { includeWide: false },
          column: "include_wide",
          sentinelDbValue: 1,
          field: "includeWide",
          expectedValue: true,
        },
        {
          label: "include_wide(true→false)",
          metaOverride: { includeWide: true },
          column: "include_wide",
          sentinelDbValue: 0,
          field: "includeWide",
          expectedValue: false,
        },
        {
          label: "include_trio(true→false)",
          metaOverride: { includeTrio: true },
          column: "include_trio",
          sentinelDbValue: 0,
          field: "includeTrio",
          expectedValue: false,
        },
        {
          label: "include_trio(false→true)",
          metaOverride: { includeTrio: false },
          column: "include_trio",
          sentinelDbValue: 1,
          field: "includeTrio",
          expectedValue: true,
        },
        // Issue #118(#24-D3b-3): include_quinella列の追加(13→14列)。他列と異なりNULLを
        // 許容する列のため、真偽の入れ替えに加えて非null⇔nullの往復も観測する(下記2ケース)。
        // 「null→非null」方向は`AnalysisAllocationMetaRecord.includeQuinella`がboolean(非null)
        // 型のため、このテーブル駆動の枠組み(baselineをこの型経由の保存で作る)では作れない
        // (型上NULLを書けない)。その方向は本テーブルの外に単独テストとして置く
        // (「include_quinella(null→非null、#118より前の記録を模す)」describe末尾参照)。
        {
          label: "include_quinella(true→false)",
          metaOverride: { includeQuinella: true },
          column: "include_quinella",
          sentinelDbValue: 0,
          field: "includeQuinella",
          expectedValue: false,
        },
        {
          label: "include_quinella(false→true)",
          metaOverride: { includeQuinella: false },
          column: "include_quinella",
          sentinelDbValue: 1,
          field: "includeQuinella",
          expectedValue: true,
        },
        {
          label: "include_quinella(非null→null)",
          metaOverride: { includeQuinella: true },
          column: "include_quinella",
          sentinelDbValue: null,
          field: "includeQuinella",
          expectedValue: null,
        },
        // Issue #126(#24-E3c): include_exacta列の追加(14→15列)。include_quinellaと同じくNULLを
        // 許容する列のため、真偽の入れ替えに加えて非null⇔nullの往復も観測する(下記2ケース)。
        // 「null→非null」方向は`AnalysisAllocationMetaRecord.includeExacta`がboolean(非null)型の
        // ため、このテーブル駆動の枠組みでは作れない(型上NULLを書けない)。その方向は本テーブルの外に
        // 単独テストとして置く(「include_exacta(null→非null、#126より前の記録を模す)」
        // describe末尾参照)。
        {
          label: "include_exacta(true→false)",
          metaOverride: { includeExacta: true },
          column: "include_exacta",
          sentinelDbValue: 0,
          field: "includeExacta",
          expectedValue: false,
        },
        {
          label: "include_exacta(false→true)",
          metaOverride: { includeExacta: false },
          column: "include_exacta",
          sentinelDbValue: 1,
          field: "includeExacta",
          expectedValue: true,
        },
        {
          label: "include_exacta(非null→null)",
          metaOverride: { includeExacta: true },
          column: "include_exacta",
          sentinelDbValue: null,
          field: "includeExacta",
          expectedValue: null,
        },
        // Issue #140(#25-E3c): include_trifecta列の追加(15→16列)。include_quinella/
        // include_exactaと同じくNULLを許容する列のため、真偽の入れ替えに加えて非null⇔nullの
        // 往復も観測する(下記2ケース)。「null→非null」方向は
        // `AnalysisAllocationMetaRecord.includeTrifecta`がboolean(非null)型のため、この
        // テーブル駆動の枠組みでは作れない(型上NULLを書けない)。その方向は本テーブルの外に
        // 単独テストとして置く(「include_trifecta(null→非null、#140より前の記録を模す)」
        // describe末尾参照)。
        {
          label: "include_trifecta(true→false)",
          metaOverride: { includeTrifecta: true },
          column: "include_trifecta",
          sentinelDbValue: 0,
          field: "includeTrifecta",
          expectedValue: false,
        },
        {
          label: "include_trifecta(false→true)",
          metaOverride: { includeTrifecta: false },
          column: "include_trifecta",
          sentinelDbValue: 1,
          field: "includeTrifecta",
          expectedValue: true,
        },
        {
          label: "include_trifecta(非null→null)",
          metaOverride: { includeTrifecta: true },
          column: "include_trifecta",
          sentinelDbValue: null,
          field: "includeTrifecta",
          expectedValue: null,
        },
        // Issue #151(#26-E3c): include_bracket_quinella列の追加(16→17列)。include_trifectaと同じく
        // NULLを許容する列のため、真偽の入れ替えに加えて非null⇔nullの往復も観測する(下記3ケース)。
        // 「null→非null」方向は`AnalysisAllocationMetaRecord.includeBracketQuinella`がboolean
        // (非null)型のため、このテーブル駆動の枠組みでは作れない(型上NULLを書けない)。その方向は
        // 本テーブルの外に単独テストとして置く(「include_bracket_quinella(null→非null、#151より前の
        // 記録を模す)」参照)。
        {
          label: "include_bracket_quinella(true→false)",
          metaOverride: { includeBracketQuinella: true },
          column: "include_bracket_quinella",
          sentinelDbValue: 0,
          field: "includeBracketQuinella",
          expectedValue: false,
        },
        {
          label: "include_bracket_quinella(false→true)",
          metaOverride: { includeBracketQuinella: false },
          column: "include_bracket_quinella",
          sentinelDbValue: 1,
          field: "includeBracketQuinella",
          expectedValue: true,
        },
        {
          label: "include_bracket_quinella(非null→null)",
          metaOverride: { includeBracketQuinella: true },
          column: "include_bracket_quinella",
          sentinelDbValue: null,
          field: "includeBracketQuinella",
          expectedValue: null,
        },
        {
          label: "bet_unit(非null→null)",
          metaOverride: {},
          column: "bet_unit",
          sentinelDbValue: null,
          field: "betUnit",
          expectedValue: null,
        },
        {
          label: "bet_unit(null→非null)",
          metaOverride: { betUnit: null },
          column: "bet_unit",
          sentinelDbValue: 777,
          field: "betUnit",
          expectedValue: 777,
        },
        {
          label: "odds_status",
          metaOverride: {},
          column: "odds_status",
          sentinelDbValue: "SENTINEL_STATUS",
          field: "oddsStatus",
          expectedValue: "SENTINEL_STATUS",
        },
      ];

      it.each(metaColumnCases)(
        "AC1(メタ列): $label の列だけをUPDATEすると、戻り値のそのフィールドだけが変わり他フィールドは変化しないこと",
        ({ metaOverride, column, sentinelDbValue, field, expectedValue }) => {
          const store = new AnalysisStore();
          const id = store.saveAnalysis(
            makeRecord({
              raceId: `AC1メタ列-${column}`,
              allocation: { meta: baselineMeta(metaOverride), bets: [BASELINE_BET] },
            }),
          );
          const baseline = store.getStoredAllocation(id)!;
          store.rawDatabase
            .prepare(`UPDATE analysis_allocation_meta SET ${column} = ? WHERE analysis_id = ?`)
            .run(sentinelDbValue, id);
          const updated = store.getStoredAllocation(id)!;
          // 前提固定(条件A0): 書き換え後の値が実際に期待どおり変わっていること。
          expect(updated[field]).toEqual(expectedValue);
          // 本題: 対象フィールド以外は基準値から一切変化していないこと。
          expect({ ...updated, [field]: baseline[field] }).toEqual(baseline);
          store.close();
        },
      );

      it("include_quinella(null→非null、Issue #118より前の記録を模す): 列が既にNULLの行をUPDATEすると、includeQuinellaだけがtrue/falseに変わり他フィールドは変化しないこと", () => {
        // metaColumnCasesのコメントの通り、`AnalysisAllocationMetaRecord.includeQuinella`は
        // boolean(非null)型のため、この型経由の保存ではNULLの初期値を作れない。
        // #118より前に保存された記録(列追加前=NULL)を模すため、通常保存の直後に
        // 生SQLでinclude_quinellaだけをNULLへ書き戻す。
        const store = new AnalysisStore();
        const id = store.saveAnalysis(
          makeRecord({
            raceId: "AC1メタ列-include_quinella-null-to-nonnull",
            allocation: { meta: baselineMeta(), bets: [BASELINE_BET] },
          }),
        );
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_quinella = NULL WHERE analysis_id = ?`)
          .run(id);
        const baseline = store.getStoredAllocation(id)!;
        // 前提固定: NULLへの書き戻しが効いていること(includeQuinella=記録なし)。
        expect(baseline.includeQuinella).toBeNull();
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_quinella = ? WHERE analysis_id = ?`)
          .run(1, id);
        const updated = store.getStoredAllocation(id)!;
        // 本題: null→非null(true)に変わり、他フィールドは基準値から一切変化していないこと。
        expect(updated.includeQuinella).toBe(true);
        expect({ ...updated, includeQuinella: baseline.includeQuinella }).toEqual(baseline);
        store.close();
      });

      it("include_exacta(null→非null、Issue #126より前の記録を模す): 列が既にNULLの行をUPDATEすると、includeExactaだけがtrue/falseに変わり他フィールドは変化しないこと", () => {
        // metaColumnCasesのコメントの通り、`AnalysisAllocationMetaRecord.includeExacta`は
        // boolean(非null)型のため、この型経由の保存ではNULLの初期値を作れない。
        // #126より前に保存された記録(列追加前=NULL)を模すため、通常保存の直後に
        // 生SQLでinclude_exactaだけをNULLへ書き戻す。
        const store = new AnalysisStore();
        const id = store.saveAnalysis(
          makeRecord({
            raceId: "AC1メタ列-include_exacta-null-to-nonnull",
            allocation: { meta: baselineMeta(), bets: [BASELINE_BET] },
          }),
        );
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_exacta = NULL WHERE analysis_id = ?`)
          .run(id);
        const baseline = store.getStoredAllocation(id)!;
        // 前提固定: NULLへの書き戻しが効いていること(includeExacta=記録なし)。
        expect(baseline.includeExacta).toBeNull();
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_exacta = ? WHERE analysis_id = ?`)
          .run(1, id);
        const updated = store.getStoredAllocation(id)!;
        // 本題: null→非null(true)に変わり、他フィールドは基準値から一切変化していないこと。
        expect(updated.includeExacta).toBe(true);
        expect({ ...updated, includeExacta: baseline.includeExacta }).toEqual(baseline);
        store.close();
      });

      it("include_trifecta(null→非null、Issue #140より前の記録を模す): 列が既にNULLの行をUPDATEすると、includeTrifectaだけがtrue/falseに変わり他フィールドは変化しないこと", () => {
        // metaColumnCasesのコメントの通り、`AnalysisAllocationMetaRecord.includeTrifecta`は
        // boolean(非null)型のため、この型経由の保存ではNULLの初期値を作れない。
        // #140より前に保存された記録(列追加前=NULL)を模すため、通常保存の直後に
        // 生SQLでinclude_trifectaだけをNULLへ書き戻す。
        const store = new AnalysisStore();
        const id = store.saveAnalysis(
          makeRecord({
            raceId: "AC1メタ列-include_trifecta-null-to-nonnull",
            allocation: { meta: baselineMeta(), bets: [BASELINE_BET] },
          }),
        );
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_trifecta = NULL WHERE analysis_id = ?`)
          .run(id);
        const baseline = store.getStoredAllocation(id)!;
        // 前提固定: NULLへの書き戻しが効いていること(includeTrifecta=記録なし)。
        expect(baseline.includeTrifecta).toBeNull();
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_trifecta = ? WHERE analysis_id = ?`)
          .run(1, id);
        const updated = store.getStoredAllocation(id)!;
        // 本題: null→非null(true)に変わり、他フィールドは基準値から一切変化していないこと。
        expect(updated.includeTrifecta).toBe(true);
        expect({ ...updated, includeTrifecta: baseline.includeTrifecta }).toEqual(baseline);
        store.close();
      });

      it("include_bracket_quinella(null→非null、Issue #151より前の記録を模す): 列が既にNULLの行をUPDATEすると、includeBracketQuinellaだけがtrue/falseに変わり他フィールドは変化しないこと", () => {
        // metaColumnCasesのコメントの通り、`AnalysisAllocationMetaRecord.includeBracketQuinella`は
        // boolean(非null)型のため、この型経由の保存ではNULLの初期値を作れない。
        // #151より前に保存された記録(列追加前=NULL)を模すため、通常保存の直後に
        // 生SQLでinclude_bracket_quinellaだけをNULLへ書き戻す。
        const store = new AnalysisStore();
        const id = store.saveAnalysis(
          makeRecord({
            raceId: "AC1メタ列-include_bracket_quinella-null-to-nonnull",
            allocation: { meta: baselineMeta(), bets: [BASELINE_BET] },
          }),
        );
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_bracket_quinella = NULL WHERE analysis_id = ?`)
          .run(id);
        const baseline = store.getStoredAllocation(id)!;
        // 前提固定: NULLへの書き戻しが効いていること(includeBracketQuinella=記録なし)。
        expect(baseline.includeBracketQuinella).toBeNull();
        store.rawDatabase
          .prepare(`UPDATE analysis_allocation_meta SET include_bracket_quinella = ? WHERE analysis_id = ?`)
          .run(1, id);
        const updated = store.getStoredAllocation(id)!;
        // 本題: null→非null(true)に変わり、他フィールドは基準値から一切変化していないこと。
        expect(updated.includeBracketQuinella).toBe(true);
        expect({ ...updated, includeBracketQuinella: baseline.includeBracketQuinella }).toEqual(baseline);
        store.close();
      });

      /** analysis_bets側(odds/ev)の差分テストの仕様。 */
      interface BetColumnCase {
        readonly label: string;
        readonly betOverride: Partial<typeof BASELINE_BET>;
        readonly column: "odds" | "ev";
        readonly sentinelDbValue: number | null;
        readonly field: "odds" | "ev";
        readonly expectedValue: number | null;
      }

      const betColumnCases: readonly BetColumnCase[] = [
        {
          label: "odds(非null→null)",
          betOverride: {},
          column: "odds",
          sentinelDbValue: null,
          field: "odds",
          expectedValue: null,
        },
        {
          label: "odds(null→非null)",
          betOverride: { odds: null },
          column: "odds",
          sentinelDbValue: 9.99,
          field: "odds",
          expectedValue: 9.99,
        },
        {
          label: "ev(非null→null)",
          betOverride: {},
          column: "ev",
          sentinelDbValue: null,
          field: "ev",
          expectedValue: null,
        },
        {
          label: "ev(null→非null)",
          betOverride: { ev: null },
          column: "ev",
          sentinelDbValue: 3.21,
          field: "ev",
          expectedValue: 3.21,
        },
      ];

      it.each(betColumnCases)(
        "AC1(bets列): $label の列だけをUPDATEすると、戻り値のそのフィールドだけが変わり他フィールドは変化しないこと",
        ({ betOverride, column, sentinelDbValue, field, expectedValue }) => {
          const store = new AnalysisStore();
          const bet = { ...BASELINE_BET, ...betOverride };
          const id = store.saveAnalysis(
            makeRecord({
              raceId: `AC1bet列-${column}-${JSON.stringify(betOverride)}`,
              allocation: { meta: baselineMeta(), bets: [bet] },
            }),
          );
          const baseline = store.getStoredAllocation(id)!;
          store.rawDatabase
            .prepare(
              `UPDATE analysis_bets SET ${column} = ? WHERE analysis_id = ? AND bet_type = ? AND combo_key = ?`,
            )
            .run(sentinelDbValue, id, bet.betType, bet.comboKey);
          const updated = store.getStoredAllocation(id)!;
          // 前提固定(条件A0): 書き換え後の値が実際に期待どおり変わっていること。
          expect(updated.bets[0]![field]).toEqual(expectedValue);
          // 本題: 対象フィールド以外(bets内の他フィールド・メタ16列全部。Issue #118で13→14列、
          // Issue #126で14→15列、Issue #140で15→16列)は基準値から変化しないこと。
          expect({
            ...updated,
            bets: [{ ...updated.bets[0]!, [field]: baseline.bets[0]![field] }],
          }).toEqual(baseline);
          store.close();
        },
      );

      describe("AC2: 読まない6列(combo_odds_wide/combo_odds_trio/greedy_steps/candidate_cap/model_id/model_approximate)に極端な値を入れても戻り値が変わらないこと", () => {
        const unreadColumnCases = [
          { label: "combo_odds_wide", column: "combo_odds_wide", sentinelDbValue: "EXTREME_VALUE" },
          { label: "combo_odds_trio", column: "combo_odds_trio", sentinelDbValue: "EXTREME_VALUE" },
          { label: "greedy_steps", column: "greedy_steps", sentinelDbValue: 999999999 },
          { label: "candidate_cap", column: "candidate_cap", sentinelDbValue: -1 },
          { label: "model_id", column: "model_id", sentinelDbValue: "EXTREME_MODEL_ID" },
          { label: "model_approximate", column: "model_approximate", sentinelDbValue: 1 },
        ] as const;

        it.each(unreadColumnCases)(
          "$label に極端な値を入れても getStoredAllocation の戻り値が完全一致すること",
          ({ column, sentinelDbValue }) => {
            const store = new AnalysisStore();
            const id = store.saveAnalysis(
              makeRecord({
                raceId: `AC2-${column}`,
                allocation: { meta: baselineMeta(), bets: [BASELINE_BET] },
              }),
            );
            const before = store.getStoredAllocation(id);
            store.rawDatabase
              .prepare(`UPDATE analysis_allocation_meta SET ${column} = ? WHERE analysis_id = ?`)
              .run(sentinelDbValue, id);
            const after = store.getStoredAllocation(id);
            expect(after).toEqual(before);
            store.close();
          },
        );
      });
    });
  });
});
