import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AnalysisStore,
  type AnalysisRecord,
} from "../../src/ev/analysis-store.js";
import { ScrapeCache } from "../../src/scraper/cache.js";

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
      },
      {
        umaban: 2,
        prior: 0.5,
        adjustedProb: 0.5,
        placeOddsMin: 2.2,
        ev: 1.1,
        isPositive: true,
        contributions: [{ biasName: "近走着順", correction: 0.12 }],
      },
    ],
    ...overrides,
  };
}

describe("AnalysisStore(分析結果のSQLite保存)", () => {
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
  });

  describe("外部キー制約の実効化", () => {
    it("foreign_keys が有効化されていること", () => {
      const store = new AnalysisStore();
      const value = store.rawDatabase.pragma("foreign_keys", { simple: true });
      expect(value).toBe(1);
      store.close();
    });

    it("存在しない分析IDへ馬行を挿入すると外部キー違反で失敗すること", () => {
      const store = new AnalysisStore();
      expect(() => {
        store.rawDatabase
          .prepare(
            `INSERT INTO analysis_horses
               (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(9999, 1, 0.3, 0.3, null, null, 0, null);
      }).toThrow();
      store.close();
    });
  });

  describe("ScrapeCache とのDB共有(テーブル独立)", () => {
    it("同一のbetter-sqlite3 DBを共有しても互いのテーブルを壊さないこと", () => {
      const db = new Database(":memory:");
      const cache = new ScrapeCache({ database: db });
      const store = new AnalysisStore({ database: db });

      cache.set("https://example.test/race", "<html>ok</html>");
      store.saveAnalysis(makeRecord());
      store.saveResult("202605020811", [{ umaban: 1, finishPosition: 1 }]);

      expect(cache.get("https://example.test/race")!.value).toBe("<html>ok</html>");
      expect(store.listAnalyses()).toHaveLength(1);
      expect(store.getResult("202605020811")).toHaveLength(1);

      db.close();
    });

    it("外部キー有効化はDB共有中の ScrapeCache 操作に影響しないこと", () => {
      const db = new Database(":memory:");
      // AnalysisStore が foreign_keys=ON にした後も ScrapeCache は正常動作する。
      const store = new AnalysisStore({ database: db });
      const cache = new ScrapeCache({ database: db });
      cache.set("k", "v");
      cache.set("k", "v2"); // 上書き(FK制約とは無関係)
      expect(cache.get("k")!.value).toBe("v2");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      db.close();
    });
  });
});
