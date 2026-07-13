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

  describe("予想印(mark)列の後方互換マイグレーション(Task#23)", () => {
    it("mark列が無い旧スキーマのDBを開いても、既存馬行はmark=nullで読め、新規保存は印付きで保存できること", () => {
      const db = new Database(":memory:");
      // Task#23より前のバージョン相当のスキーマ(analysis_horsesにmark列が無い)を直接作る。
      db.exec(`
        CREATE TABLE analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          race_id TEXT NOT NULL,
          analyzed_at TEXT NOT NULL
        );
        CREATE TABLE analysis_horses (
          analysis_id INTEGER NOT NULL,
          umaban INTEGER NOT NULL,
          prior REAL NOT NULL,
          adjusted_prob REAL NOT NULL,
          place_odds_min REAL,
          ev REAL,
          is_positive INTEGER NOT NULL,
          contributions_json TEXT,
          PRIMARY KEY (analysis_id, umaban),
          FOREIGN KEY (analysis_id) REFERENCES analyses (id)
        );
      `);
      // 旧バージョンで保存済みの既存データ(mark列自体が存在しない状態での保存を模す)。
      const info = db
        .prepare(`INSERT INTO analyses (race_id, analyzed_at) VALUES (?, ?)`)
        .run("旧レース", "2026-01-01T00:00:00.000Z");
      const oldAnalysisId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO analysis_horses
           (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(oldAnalysisId, 1, 0.4, 0.4, 2.0, 0.8, 0, null);

      // 新バージョンの AnalysisStore で開く(mark列が無ければ ALTER TABLE で追加されるはず)。
      const store = new AnalysisStore({ database: db });

      // 旧レースの馬行はmark列を後付けしても既存行はmark=nullとして読める。
      const old = store.listAnalyses({ raceId: "旧レース" })[0]!;
      expect(old.horses[0]!.mark).toBeNull();

      // 新規保存(印あり)も問題なく動作する(後方互換を確認)。
      const newId = store.saveAnalysis(makeRecord({ raceId: "新レース" }));
      const saved = store.listAnalyses({ raceId: "新レース" })[0]!;
      expect(saved.id).toBe(newId);
      expect(saved.horses.find((h) => h.umaban === 1)!.mark).toBe("◎");
      expect(saved.horses.find((h) => h.umaban === 2)!.mark).toBeNull();

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
