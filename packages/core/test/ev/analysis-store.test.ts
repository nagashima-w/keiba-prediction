import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AnalysisStore,
  type AnalysisAllocationMetaRecord,
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

  describe("推定EVフラグ(ev_estimated)列の後方互換マイグレーション(Task#25)", () => {
    it("ev_estimated列が無い旧スキーマのDBを開いても、既存分析はevEstimated=falseで読め、新規保存は推定フラグ付きで保存できること", () => {
      const db = new Database(":memory:");
      // Task#25より前のバージョン相当のスキーマ(analysesにev_estimated列が無い)を直接作る。
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
          mark TEXT,
          PRIMARY KEY (analysis_id, umaban),
          FOREIGN KEY (analysis_id) REFERENCES analyses (id)
        );
      `);
      // 旧バージョンで保存済みの既存データ(ev_estimated列自体が存在しない状態での保存を模す)。
      const info = db
        .prepare(`INSERT INTO analyses (race_id, analyzed_at) VALUES (?, ?)`)
        .run("旧レース", "2026-01-01T00:00:00.000Z");
      const oldAnalysisId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO analysis_horses
           (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(oldAnalysisId, 1, 0.4, 0.4, 2.0, 0.8, 0, null, null);

      // 新バージョンの AnalysisStore で開く(ev_estimated列が無ければ ALTER TABLE で追加されるはず)。
      const store = new AnalysisStore({ database: db });

      // 旧分析はev_estimated列を後付けしても既存行はfalse(未推定=確定EV扱い)として読める。
      const old = store.listAnalyses({ raceId: "旧レース" })[0]!;
      expect(old.evEstimated).toBe(false);

      // 新規保存(推定EVあり)も問題なく動作する(後方互換を確認)。
      const newId = store.saveAnalysis(
        makeRecord({ raceId: "新レース", evEstimated: true }),
      );
      const saved = store.listAnalyses({ raceId: "新レース" })[0]!;
      expect(saved.id).toBe(newId);
      expect(saved.evEstimated).toBe(true);

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

  describe("prompt_version列の後方互換マイグレーション(Task#27)", () => {
    it("prompt_version列が無い旧スキーマのDBを開いても、既存分析はpromptVersion=nullで読め、新規保存は版番号付きで保存できること", () => {
      const db = new Database(":memory:");
      // Task#27より前のバージョン相当のスキーマ(analysesにprompt_version列が無い)を直接作る。
      db.exec(`
        CREATE TABLE analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          race_id TEXT NOT NULL,
          analyzed_at TEXT NOT NULL,
          ev_estimated INTEGER
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
          mark TEXT,
          PRIMARY KEY (analysis_id, umaban),
          FOREIGN KEY (analysis_id) REFERENCES analyses (id)
        );
      `);
      // 旧バージョンで保存済みの既存データ(prompt_version列自体が存在しない状態での保存を模す)。
      const info = db
        .prepare(
          `INSERT INTO analyses (race_id, analyzed_at, ev_estimated) VALUES (?, ?, ?)`,
        )
        .run("旧レース", "2026-01-01T00:00:00.000Z", 0);
      const oldAnalysisId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO analysis_horses
           (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(oldAnalysisId, 1, 0.4, 0.4, 2.0, 0.8, 0, null, null);

      // 新バージョンの AnalysisStore で開く(prompt_version列が無ければ ALTER TABLE で追加されるはず)。
      const store = new AnalysisStore({ database: db });

      // 旧分析はprompt_version列を後付けしても既存行はnull(版不明)として読める。
      const old = store.listAnalyses({ raceId: "旧レース" })[0]!;
      expect(old.promptVersion).toBeNull();

      // 新規保存(版番号あり)も問題なく動作する(後方互換を確認)。
      const newId = store.saveAnalysis(
        makeRecord({ raceId: "新レース", promptVersion: "2026-07-14.1" }),
      );
      const saved = store.listAnalyses({ raceId: "新レース" })[0]!;
      expect(saved.id).toBe(newId);
      expect(saved.promptVersion).toBe("2026-07-14.1");

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

  describe("additional_instruction列の後方互換マイグレーション(Task#28)", () => {
    it("additional_instruction列が無い旧スキーマのDBを開いても、既存分析はadditionalInstruction=nullで読め、新規保存は追加指示付きで保存できること", () => {
      const db = new Database(":memory:");
      // Task#28より前のバージョン相当のスキーマ(analysesにadditional_instruction列が無い)を直接作る。
      db.exec(`
        CREATE TABLE analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          race_id TEXT NOT NULL,
          analyzed_at TEXT NOT NULL,
          ev_estimated INTEGER,
          prompt_version TEXT
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
          mark TEXT,
          PRIMARY KEY (analysis_id, umaban),
          FOREIGN KEY (analysis_id) REFERENCES analyses (id)
        );
      `);
      // 旧バージョンで保存済みの既存データ(additional_instruction列自体が存在しない状態での保存を模す)。
      const info = db
        .prepare(
          `INSERT INTO analyses (race_id, analyzed_at, ev_estimated, prompt_version) VALUES (?, ?, ?, ?)`,
        )
        .run("旧レース", "2026-01-01T00:00:00.000Z", 0, null);
      const oldAnalysisId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO analysis_horses
           (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(oldAnalysisId, 1, 0.4, 0.4, 2.0, 0.8, 0, null, null);

      // 新バージョンの AnalysisStore で開く(additional_instruction列が無ければ ALTER TABLE で追加されるはず)。
      const store = new AnalysisStore({ database: db });

      // 旧分析はadditional_instruction列を後付けしても既存行はnullとして読める。
      const old = store.listAnalyses({ raceId: "旧レース" })[0]!;
      expect(old.additionalInstruction).toBeNull();

      // 新規保存(追加指示あり)も問題なく動作する(後方互換を確認)。
      const newId = store.saveAnalysis(
        makeRecord({
          raceId: "新レース",
          additionalInstruction: "テスト用の追加指示",
        }),
      );
      const saved = store.listAnalyses({ raceId: "新レース" })[0]!;
      expect(saved.id).toBe(newId);
      expect(saved.additionalInstruction).toBe("テスト用の追加指示");

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

  describe("kaisai_date列の後方互換マイグレーション(Task#34)", () => {
    it("kaisai_date列が無い旧スキーマのDBを開いても、既存分析はkaisaiDate=nullで読め、新規保存は開催日付きで保存できること", () => {
      const db = new Database(":memory:");
      // Task#34より前のバージョン相当のスキーマ(analysesにkaisai_date列が無い)を直接作る。
      db.exec(`
        CREATE TABLE analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          race_id TEXT NOT NULL,
          analyzed_at TEXT NOT NULL,
          ev_estimated INTEGER,
          prompt_version TEXT,
          additional_instruction TEXT
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
          mark TEXT,
          PRIMARY KEY (analysis_id, umaban),
          FOREIGN KEY (analysis_id) REFERENCES analyses (id)
        );
      `);
      // 旧バージョンで保存済みの既存データ(kaisai_date列自体が存在しない状態での保存を模す)。
      const info = db
        .prepare(
          `INSERT INTO analyses (race_id, analyzed_at, ev_estimated, prompt_version, additional_instruction)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("旧レース", "2026-01-01T00:00:00.000Z", 0, null, null);
      const oldAnalysisId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO analysis_horses
           (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(oldAnalysisId, 1, 0.4, 0.4, 2.0, 0.8, 0, null, null);

      // 新バージョンの AnalysisStore で開く(kaisai_date列が無ければ ALTER TABLE で追加されるはず)。
      const store = new AnalysisStore({ database: db });

      // 旧分析はkaisai_date列を後付けしても既存行はnull(日付不明)として読める。
      const old = store.listAnalyses({ raceId: "旧レース" })[0]!;
      expect(old.kaisaiDate).toBeNull();

      // 新規保存(開催日あり)も問題なく動作する(後方互換を確認)。
      const newId = store.saveAnalysis(
        makeRecord({ raceId: "新レース", kaisaiDate: "20260714" }),
      );
      const saved = store.listAnalyses({ raceId: "新レース" })[0]!;
      expect(saved.id).toBe(newId);
      expect(saved.kaisaiDate).toBe("20260714");

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

  describe("model/raw_response/race_snapshot_json・reason列の後方互換マイグレーション(Issue#10)", () => {
    it("これらの列が無い旧スキーマのDBを開いても、既存分析はmodel/rawResponse/raceSnapshot=null・reason=nullで読め、新規保存は新列付きで保存できること", () => {
      const db = new Database(":memory:");
      // Issue#10より前のバージョン相当のスキーマ(analysesにmodel/raw_response/race_snapshot_json列、
      // analysis_horsesにreason列が無い)を直接作る。
      db.exec(`
        CREATE TABLE analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          race_id TEXT NOT NULL,
          analyzed_at TEXT NOT NULL,
          ev_estimated INTEGER,
          prompt_version TEXT,
          additional_instruction TEXT,
          kaisai_date TEXT
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
          mark TEXT,
          PRIMARY KEY (analysis_id, umaban),
          FOREIGN KEY (analysis_id) REFERENCES analyses (id)
        );
      `);
      // 旧バージョンで保存済みの既存データ(新列自体が存在しない状態での保存を模す)。
      const info = db
        .prepare(
          `INSERT INTO analyses (race_id, analyzed_at, ev_estimated, prompt_version, additional_instruction, kaisai_date)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("旧レース2", "2026-01-01T00:00:00.000Z", 0, null, null, null);
      const oldAnalysisId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO analysis_horses
           (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(oldAnalysisId, 1, 0.4, 0.4, 2.0, 0.8, 0, null, null);

      // 新バージョンの AnalysisStore で開く(新列が無ければ ALTER TABLE で追加されるはず)。
      const store = new AnalysisStore({ database: db });

      // 旧分析は新列を後付けしても既存行はmodel/rawResponse/raceSnapshot=null・reason=nullとして読める。
      const old = store.listAnalyses({ raceId: "旧レース2" })[0]!;
      expect(old.model).toBeNull();
      expect(old.rawResponse).toBeNull();
      expect(old.raceSnapshot).toBeNull();
      expect(old.horses[0]!.reason).toBeNull();

      // 新規保存(新列付き)も問題なく動作する(後方互換を確認)。
      const newId = store.saveAnalysis(
        makeRecord({
          raceId: "新レース2",
          model: "claude-sonnet-4-6",
          rawResponse: "raw",
          raceSnapshot: { race: { raceName: "新レース" } },
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: 2.0,
              ev: 0.8,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: "理由",
            },
          ],
        }),
      );
      const saved = store.listAnalyses({ raceId: "新レース2" })[0]!;
      expect(saved.id).toBe(newId);
      expect(saved.model).toBe("claude-sonnet-4-6");
      expect(saved.rawResponse).toBe("raw");
      expect(saved.raceSnapshot).toEqual({ race: { raceName: "新レース" } });
      expect(saved.horses[0]!.reason).toBe("理由");

      store.close();
    });

    it("同一DBで2回目のAnalysisStore構築(再オープン相当)でもALTER TABLEが再実行されず、既存データを保持すること(冪等性)", () => {
      const db = new Database(":memory:");
      const store1 = new AnalysisStore({ database: db });
      store1.saveAnalysis(
        makeRecord({
          raceId: "冪等性レース2",
          model: "claude-sonnet-4-6",
          rawResponse: "raw",
          raceSnapshot: { race: { raceName: "冪等性" } },
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: 2.0,
              ev: 0.8,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: "理由",
            },
          ],
        }),
      );
      expect(() => new AnalysisStore({ database: db })).not.toThrow();
      const store2 = new AnalysisStore({ database: db });
      const a = store2.listAnalyses({ raceId: "冪等性レース2" })[0]!;
      expect(a.model).toBe("claude-sonnet-4-6");
      expect(a.rawResponse).toBe("raw");
      expect(a.raceSnapshot).toEqual({ race: { raceName: "冪等性" } });
      expect(a.horses[0]!.reason).toBe("理由");
      db.close();
    });
  });

  describe("listUnimportedRaceIds(分析済みで結果未取込のレース列挙。Task#31)", () => {
    it("分析済みだが race_results に行が1件も無いレースを列挙すること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "未取込レース" }));
      const ids = store.listUnimportedRaceIds();
      expect(ids).toEqual(["未取込レース"]);
      store.close();
    });

    it("race_results に行があるレースは列挙されないこと(着順が数値の通常ケース)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "取込済みレース" }));
      store.saveResult("取込済みレース", [
        { umaban: 1, finishPosition: 1 },
        { umaban: 2, finishPosition: 2 },
      ]);
      expect(store.listUnimportedRaceIds()).toEqual([]);
      store.close();
    });

    it("境界値: 全馬 finish_position=NULL(中止・除外のみ)のレースは行が存在するため取込済み扱いになること" +
      "(COUNT(finish_position)によるNULL数え落としのバグを再発させないための回帰テスト)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "全馬中止レース" }));
      store.saveResult("全馬中止レース", [
        { umaban: 1, finishPosition: null },
        { umaban: 2, finishPosition: null },
      ]);
      // race_results に行(値はNULLでも)が存在するので「行の有無」判定では取込済み扱い。
      expect(store.listUnimportedRaceIds()).toEqual([]);
      store.close();
    });

    it("同一レースを複数回分析していても重複せず1回だけ列挙すること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({ raceId: "複数回分析レース", analyzedAt: "2026-07-08T09:00:00.000Z" }),
      );
      store.saveAnalysis(
        makeRecord({ raceId: "複数回分析レース", analyzedAt: "2026-07-08T15:00:00.000Z" }),
      );
      expect(store.listUnimportedRaceIds()).toEqual(["複数回分析レース"]);
      store.close();
    });

    it("分析が1件も無ければ空配列を返すこと", () => {
      const store = new AnalysisStore();
      expect(store.listUnimportedRaceIds()).toEqual([]);
      store.close();
    });

    it("分析の無いレースにだけ結果があっても列挙対象にならないこと(analyses起点で列挙するため)", () => {
      const store = new AnalysisStore();
      store.saveResult("分析なしレース", [{ umaban: 1, finishPosition: 1 }]);
      expect(store.listUnimportedRaceIds()).toEqual([]);
      store.close();
    });

    it("未取込・取込済みが混在する場合、未取込のレースだけをレースID昇順で列挙すること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "B未取込" }));
      store.saveAnalysis(makeRecord({ raceId: "A未取込" }));
      store.saveAnalysis(makeRecord({ raceId: "C取込済み" }));
      store.saveResult("C取込済み", [{ umaban: 1, finishPosition: 1 }]);
      expect(store.listUnimportedRaceIds()).toEqual(["A未取込", "B未取込"]);
      store.close();
    });
  });

  describe("listAnalyzedRaceIdsByPromptVersion(指定版で分析済みのレース列挙。タスクB2b-1)", () => {
    it("指定した版と一致する分析があるレースIDをDISTINCTで列挙すること(同一レースの複数分析でも1件)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({
          raceId: "複数回分析レース",
          promptVersion: "v1",
          analyzedAt: "2026-07-08T09:00:00.000Z",
        }),
      );
      store.saveAnalysis(
        makeRecord({
          raceId: "複数回分析レース",
          promptVersion: "v1",
          analyzedAt: "2026-07-08T15:00:00.000Z",
        }),
      );
      expect(store.listAnalyzedRaceIdsByPromptVersion("v1")).toEqual([
        "複数回分析レース",
      ]);
      store.close();
    });

    it("別版のみで分析済みのレースは列挙されないこと", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "別版レース", promptVersion: "v2" }));
      expect(store.listAnalyzedRaceIdsByPromptVersion("v1")).toEqual([]);
      store.close();
    });

    it("prompt_versionがnull(LLM未使用・旧データ)の分析は列挙されないこと", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "版不明レース", promptVersion: null }));
      expect(store.listAnalyzedRaceIdsByPromptVersion("v1")).toEqual([]);
      store.close();
    });

    it("該当する分析が1件も無ければ空配列を返すこと", () => {
      const store = new AnalysisStore();
      expect(store.listAnalyzedRaceIdsByPromptVersion("v1")).toEqual([]);
      store.close();
    });

    it("指定版のレースIDのみをレースID昇順で列挙すること(別版・null混在)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "B対象", promptVersion: "v1" }));
      store.saveAnalysis(makeRecord({ raceId: "A対象", promptVersion: "v1" }));
      store.saveAnalysis(makeRecord({ raceId: "C別版", promptVersion: "v2" }));
      store.saveAnalysis(makeRecord({ raceId: "D版不明", promptVersion: null }));
      expect(store.listAnalyzedRaceIdsByPromptVersion("v1")).toEqual([
        "A対象",
        "B対象",
      ]);
      store.close();
    });
  });

  describe("deleteAnalysesWithUnknownPromptVersion(版不明分析の削除。Task#33)", () => {
    it("版不明が0件のとき、削除0件を返しエラーにならないこと", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "版ありレース", promptVersion: "2026-07-14.1" }));
      const deletedCount = store.deleteAnalysesWithUnknownPromptVersion();
      expect(deletedCount).toBe(0);
      expect(store.listAnalyses()).toHaveLength(1);
      store.close();
    });

    it("分析が1件も無くても削除0件を返しエラーにならないこと", () => {
      const store = new AnalysisStore();
      const deletedCount = store.deleteAnalysesWithUnknownPromptVersion();
      expect(deletedCount).toBe(0);
      store.close();
    });

    it("版不明と版ありが混在する場合、版不明の分析だけを削除し版ありは残ること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "版不明レース1" }));
      store.saveAnalysis(makeRecord({ raceId: "版不明レース2", promptVersion: null }));
      const keptId = store.saveAnalysis(
        makeRecord({ raceId: "版ありレース", promptVersion: "2026-07-14.1" }),
      );

      const deletedCount = store.deleteAnalysesWithUnknownPromptVersion();

      expect(deletedCount).toBe(2);
      const remaining = store.listAnalyses();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(keptId);
      expect(remaining[0]!.raceId).toBe("版ありレース");
      store.close();
    });

    it("削除した分析に紐づく analysis_horses(子行)も確実に消えること", () => {
      const store = new AnalysisStore();
      const deletedId = store.saveAnalysis(makeRecord({ raceId: "版不明レース" }));

      store.deleteAnalysesWithUnknownPromptVersion();

      const horseRows = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS count FROM analysis_horses WHERE analysis_id = ?`)
        .get(deletedId) as { count: number };
      expect(horseRows.count).toBe(0);
      store.close();
    });

    it("版ありの analysis_horses(子行)は削除されず残ること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "版不明レース" }));
      const keptId = store.saveAnalysis(
        makeRecord({ raceId: "版ありレース", promptVersion: "2026-07-14.1" }),
      );

      store.deleteAnalysesWithUnknownPromptVersion();

      const horseRows = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS count FROM analysis_horses WHERE analysis_id = ?`)
        .get(keptId) as { count: number };
      expect(horseRows.count).toBe(2);
      store.close();
    });

    it("race_results は版不明分析の削除後も消えずに残ること(結果データは版と無関係に再利用できるため)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "版不明レース" }));
      store.saveResult("版不明レース", [
        { umaban: 1, finishPosition: 1, placePayout: 210 },
        { umaban: 2, finishPosition: 2 },
      ]);

      store.deleteAnalysesWithUnknownPromptVersion();

      const results = store.getResult("版不明レース");
      expect(results).toHaveLength(2);
      store.close();
    });

    it("外部キー制約が有効(foreign_keys=ON)でも、子行を先に消すため制約違反にならないこと", () => {
      // initSchemaで foreign_keys=ON にしているため、子行(analysis_horses)を残したまま
      // 親行(analyses)だけを消そうとすると FOREIGN KEY constraint failed で例外になる
      // (analysis_horsesのFK宣言にON DELETE句が無くSQLite既定のNO ACTIONになるため)。
      // この回帰を検知するため、削除操作自体が例外を投げないことを確認する。
      const store = new AnalysisStore();
      store.saveAnalysis(makeRecord({ raceId: "版不明レース" }));
      expect(() => store.deleteAnalysesWithUnknownPromptVersion()).not.toThrow();
      store.close();
    });
  });

  describe("結果詳細列(passing_json/last3f)の後方互換マイグレーション(タスク#27-A2)", () => {
    it("passing_json/last3f列が無い旧スキーマのDBを開いても、既存結果行はpassing=[]・last3f=nullで読め、新規保存は詳細付きで保存できること", () => {
      const db = new Database(":memory:");
      // タスク#27-A2より前のバージョン相当のスキーマ(race_resultsにpassing_json/last3f列が無い)を直接作る。
      db.exec(`
        CREATE TABLE race_results (
          race_id TEXT NOT NULL,
          umaban INTEGER NOT NULL,
          finish_position INTEGER,
          place_payout REAL,
          PRIMARY KEY (race_id, umaban)
        );
      `);
      // 旧バージョンで保存済みの既存データ(passing_json/last3f列自体が存在しない状態での保存を模す)。
      db.prepare(
        `INSERT INTO race_results (race_id, umaban, finish_position, place_payout) VALUES (?, ?, ?, ?)`,
      ).run("旧結果レース", 1, 1, 210);

      // 新バージョンの AnalysisStore で開く(passing_json/last3f列が無ければ ALTER TABLE で追加されるはず)。
      const store = new AnalysisStore({ database: db });

      // 旧結果行はpassing_json/last3f列を後付けしても既存行はpassing=[]・last3f=nullとして読める。
      const oldDetail = store.getRaceResultDetail("旧結果レース")!;
      const oldHorse = oldDetail.horses.find((h) => h.umaban === 1)!;
      expect(oldHorse.passing).toEqual([]);
      expect(oldHorse.last3f).toBeNull();

      // 新規保存(通過順・後3F付き)も問題なく動作する(後方互換を確認)。
      store.saveResult("新結果レース", [
        { umaban: 1, finishPosition: 1, passing: [2, 3, 4, 3], last3f: 35.2 },
      ]);
      const newDetail = store.getRaceResultDetail("新結果レース")!;
      const newHorse = newDetail.horses.find((h) => h.umaban === 1)!;
      expect(newHorse.passing).toEqual([2, 3, 4, 3]);
      expect(newHorse.last3f).toBe(35.2);

      store.close();
    });

    it("同一DBで2回目のAnalysisStore構築(再オープン相当)でもALTER TABLEが再実行されず、既存データを保持すること(冪等性)", () => {
      const db = new Database(":memory:");
      const store1 = new AnalysisStore({ database: db });
      store1.saveResult("R1", [
        { umaban: 1, finishPosition: 1, passing: [1, 1], last3f: 34.0 },
      ]);
      // 同じDBで再度AnalysisStoreを構築(再オープン相当)してもエラーにならない。
      expect(() => new AnalysisStore({ database: db })).not.toThrow();
      const store2 = new AnalysisStore({ database: db });
      const detail = store2.getRaceResultDetail("R1")!;
      expect(detail.horses[0]!.passing).toEqual([1, 1]);
      expect(detail.horses[0]!.last3f).toBe(34.0);
      db.close();
    });
  });

  describe("race_result_metaテーブルの新設(タスク#27-A2)", () => {
    it("race_result_metaテーブルが存在しない旧DBでAnalysisStoreを開くとテーブルが作成され、面付き保存ができること", () => {
      const db = new Database(":memory:");
      // 旧バージョン相当: race_result_meta自体が無い(race_resultsのみの最小スキーマ)。
      db.exec(`
        CREATE TABLE race_results (
          race_id TEXT NOT NULL,
          umaban INTEGER NOT NULL,
          finish_position INTEGER,
          PRIMARY KEY (race_id, umaban)
        );
      `);
      const store = new AnalysisStore({ database: db });
      // 面付きで保存でき、race_result_metaへ書き込めること(テーブルが無ければエラーになるはず)。
      expect(() =>
        store.saveResult("面テストレース", [{ umaban: 1, finishPosition: 1 }], "芝"),
      ).not.toThrow();
      expect(store.getRaceResultDetail("面テストレース")!.courseType).toBe("芝");
      store.close();
    });

    it("同一DBで2回目のAnalysisStore構築(再オープン相当)でもCREATE TABLE IF NOT EXISTSがno-opで既存courseTypeを保持すること", () => {
      const db = new Database(":memory:");
      const store1 = new AnalysisStore({ database: db });
      store1.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], "ダ");
      const store2 = new AnalysisStore({ database: db });
      expect(store2.getRaceResultDetail("R1")!.courseType).toBe("ダ");
      db.close();
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

  describe("saveResultの原子性(race_results/race_result_metaを単一トランザクションで書くこと。タスク#27-A2)", () => {
    it("courseType指定時、race_resultsとrace_result_metaの両方が書かれること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], "芝");
      const resultRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_results WHERE race_id = ?`)
        .get("R1") as { c: number };
      const metaRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_result_meta WHERE race_id = ?`)
        .get("R1") as { c: number };
      expect(resultRow.c).toBe(1);
      expect(metaRow.c).toBe(1);
      store.close();
    });

    it("courseType未指定(省略)でも、race_results側は必ず書かれ、race_result_metaには行を作らないこと", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const resultRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_results WHERE race_id = ?`)
        .get("R1") as { c: number };
      const metaRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_result_meta WHERE race_id = ?`)
        .get("R1") as { c: number };
      expect(resultRow.c).toBe(1);
      expect(metaRow.c).toBe(0);
      store.close();
    });

    it("courseTypeにnullを明示しても、race_result_metaへ行を作らずcourseType=nullとして復元されること", () => {
      const store = new AnalysisStore();
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null);
      const metaRow = store.rawDatabase
        .prepare(`SELECT COUNT(*) AS c FROM race_result_meta WHERE race_id = ?`)
        .get("R1") as { c: number };
      expect(metaRow.c).toBe(0);
      expect(store.getRaceResultDetail("R1")!.courseType).toBeNull();
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

  describe("非破壊回帰: getResultは従来どおりの出力を維持すること(タスク#27-A2)", () => {
    it("passing/last3f/courseTypeを保存した後もgetResultはumaban/finishPosition/placePayoutのみを返すこと", () => {
      const store = new AnalysisStore();
      store.saveResult(
        "R1",
        [
          {
            umaban: 1,
            finishPosition: 1,
            placePayout: 210,
            passing: [2, 3],
            last3f: 35.0,
          },
        ],
        "芝",
      );
      const results = store.getResult("R1")!;
      expect(results).toEqual([
        { umaban: 1, finishPosition: 1, placePayout: 210 },
      ]);
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

  describe("placeOddsMinの非有限値がDB往復でどうなるか(Issue #50・回帰テスト)", () => {
    // 【このテストの目的(4点)】
    // boss メタレビュー(要修正2)を契機に、オーケストレーターの判断で本テストを追加した
    // (テスト追加そのものはboss指示ではない。boss が求めたのは要修正2の走査結果の記録まで)。
    // 目的は次の4点。
    //
    // 1. 「DBを通るから非有限値は消える」という一般化は誤りであることの固定。
    //    本テスト作成の経緯: Issue #31(#50)の調査中、実装担当者が本番の AnalysisStore
    //    (better-sqlite3、in-memory)へ NaN/+Infinity/-Infinity を実際に保存・復元する
    //    プローブを1回限りのスクリプトで実行し、「NaNだけがnullへ自己修復され、Infinityは
    //    そのまま生き残る」ことを実測した。この結果を code-reviewer が本番の AnalysisStore を
    //    使って再現しようとした際に一度は逆の結論(Infinityもnullになる)を得て差し戻しに
    //    至ったが、オーケストレーターが3度目の実測(in-memory・ファイルベース両方、
    //    生SQLのtypeof併用)を行い、当初の実測が正しいことを確定させた。
    //    **「非有限値はNaN・Infinityをまとめて1つの性質として扱ってよい」
    //    という直感は、少なくとも better-sqlite3 経由のREAL列では成立しない。**
    //
    // 2. これは better-sqlite3 の挙動への依存であり、バージョン更新で変わりうる。
    //    本テストはその依存を明示的に固定する回帰テストであり、将来 better-sqlite3(または
    //    SQLiteそのもの)のバージョンが上がって挙動が変わったら、このテストが落ちて気づける
    //    ようにすることが目的(「気づけない」状態を作らないための固定)。
    //
    // 3. Issue #50 のリスク評価はこの事実に依存している: 将来 placeOddsMin に Infinity を
    //    書き込む経路が生まれた場合、**DBは防波堤にならない**(NaNは自己修復されて無害化するが、
    //    Infinityは往復してそのまま残り、verify.ts:640/669等の同型サイトに到達しうる)。
    //
    // 4. この挙動を「望ましい」と承認しているわけではない。これは better-sqlite3 の現状の
    //    実装の記録であって、仕様としての追認ではない(本番コードは本タスクで一切変更していない)。
    //
    // 【確認手順の注意(code-reviewer自身が特定した誤りの根本原因)】
    // この挙動を確認するとき `JSON.stringify` で表示してはならない。`JSON.stringify` は
    // 仕様上 NaN・Infinity・-Infinity をすべて null に変換して出力する(JSONに非有限数の
    // 表現が無いため)。このため「DBが3つとも null に自己修復した」ように見えてしまう
    // (実際に本タスクのレビューで一度この誤認が起きた: code-reviewerが
    // `console.log(JSON.stringify(loaded?.horses, null, 2))` で結果を表示したところ、
    // SQLite側で本当にnullになるNaNと、実際にはInfinityのまま生きているが表示上nullに
    // 潰されていた+Infinity/-Infinityの区別がつかなくなり、「Infinityもnullになる」という
    // 誤った結論に至った)。確認するときは値そのものを typeof・Number.isFinite と
    // あわせて直接出力すること(本テスト本体のアサーションも、当然ながら JSON.stringify を
    // 経由せず toBe(Number.POSITIVE_INFINITY) 等で値を直接比較している)。
    //
    // 対照として通常値(3.5)が素通しされることも併記し、「異常値だけが変な挙動をする」ことを
    // 明確にする(通常値まで巻き添えで壊れているわけではないことの確認)。
    const table: Array<{ name: string; value: number; expected: number | null }> = [
      { name: "NaN → null(自己修復される)", value: Number.NaN, expected: null },
      {
        name: "+Infinity → +Infinityのまま(自己修復されない)",
        value: Number.POSITIVE_INFINITY,
        expected: Number.POSITIVE_INFINITY,
      },
      {
        name: "-Infinity → -Infinityのまま(自己修復されない)",
        value: Number.NEGATIVE_INFINITY,
        expected: Number.NEGATIVE_INFINITY,
      },
      { name: "通常値(3.5・対照)はそのまま素通しされる", value: 3.5, expected: 3.5 },
    ];
    it.each(table)("$name", ({ value, expected }) => {
      // :memory: で十分(オーケストレーターがファイルベースでも同結果であることを実測済み)。テストは一時ファイルを残さない。
      const store = new AnalysisStore();
      store.saveAnalysis(
        makeRecord({
          raceId: "非有限値往復テスト",
          horses: [
            {
              umaban: 1,
              prior: 0.5,
              adjustedProb: 0.5,
              placeOddsMin: value,
              ev: 1.0,
              isPositive: true,
              contributions: null,
              mark: null,
            },
          ],
        }),
      );
      const restored = store.listAnalyses({ raceId: "非有限値往復テスト" })[0]!;
      const restoredOdds = restored.horses[0]!.placeOddsMin;
      if (expected === null) {
        expect(restoredOdds).toBeNull();
      } else {
        // Object.is基準(toBe)で比較する。+Infinity/-Infinityの符号違いを
        // 取り違えないようにするため(NaN行は上のnull分岐で扱う)。
        expect(restoredOdds).toBe(expected);
      }
      store.close();
    });
  });

  describe("組合せ払戻テーブルの新設(race_combo_payouts / race_combo_payout_imports、Issue #52)", () => {
    it("旧DB(combo系テーブルが存在しない)でAnalysisStoreを開くとテーブルが作成され、組合せ払戻付きで保存できること", () => {
      const db = new Database(":memory:");
      // 旧バージョン相当: race_results のみの最小スキーマ(combo系テーブル自体が無い)。
      db.exec(`
        CREATE TABLE race_results (
          race_id TEXT NOT NULL,
          umaban INTEGER NOT NULL,
          finish_position INTEGER,
          PRIMARY KEY (race_id, umaban)
        );
      `);
      const store = new AnalysisStore({ database: db });
      expect(() =>
        store.saveResult(
          "組合せ払戻テストレース",
          [{ umaban: 1, finishPosition: 1 }],
          null,
          {
            wide: {
              state: "parsed",
              payouts: [{ umabans: [1, 2], payout: 120 }],
            },
          },
        ),
      ).not.toThrow();
      expect(store.getComboPayouts("組合せ払戻テストレース", "wide")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "0102", payout: 120 }],
      });
      store.close();
    });

    it("同一DBで2回目のAnalysisStore構築(再オープン相当)でもCREATE TABLE IF NOT EXISTSがno-opで既存データを保持すること", () => {
      const db = new Database(":memory:");
      const store1 = new AnalysisStore({ database: db });
      store1.saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 120 }] },
      });
      const store2 = new AnalysisStore({ database: db });
      expect(store2.getComboPayouts("R1", "wide")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "0102", payout: 120 }],
      });
      db.close();
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

    it("旧DB(race_results に行があるがcombo系マーカーが無い)を開いた直後は not_imported を返すこと(R-4がAC9・AC12を同時に満たすことの直接証明)", () => {
      const db = new Database(":memory:");
      // 旧バージョン相当: race_results には既にこのレースの行がある(#52より前に取り込んだ想定)。
      db.exec(`
        CREATE TABLE race_results (
          race_id TEXT NOT NULL,
          umaban INTEGER NOT NULL,
          finish_position INTEGER,
          PRIMARY KEY (race_id, umaban)
        );
        INSERT INTO race_results (race_id, umaban, finish_position)
        VALUES ('旧DBレース', 1, 1);
      `);
      const store = new AnalysisStore({ database: db });
      // race_results には行があるが、combo系テーブルにはこのレースの行が無い。
      // 「race_resultsの行の有無」を根拠に判定すると誤って imported/[] を返してしまう
      // (=過去の全レースがワイド・3連複払戻0円という偽の確定値になる)ため、
      // race_combo_payout_imports のマーカー行の有無で判定しなければならない。
      expect(store.getComboPayouts("旧DBレース", "wide")).toEqual({
        state: "not_imported",
      });
      expect(store.getComboPayouts("旧DBレース", "trio")).toEqual({
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
    /** テスト用のメタ行(#59スキーマ20列)を最小上書きで組み立てる。 */
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

    it("AC2: route=unset のメタ行が全20列で固定どおりに保存されること(coreの配分計算に未到達=設定エコー以外は全null)", () => {
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
        bet_unit: null,
        greedy_steps: null,
        candidate_cap: null,
        model_id: null,
        model_approximate: null,
        odds_status: "result",
      });
      store.close();
    });

    it("AC2: route=place-only(includeComboOdds=false)のメタ行が全20列で固定どおりに保存されること(candidate_capはplace-only経路に存在しないためnull)", () => {
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
        bet_unit: 100,
        greedy_steps: 1000,
        candidate_cap: null,
        model_id: "conditional-bernoulli",
        model_approximate: 1,
        odds_status: "middle",
      });
      store.close();
    });

    it("AC2: route=unavailable のメタ行が全20列で固定どおりに保存されること(unavailable_reasonが非nullになる唯一の経路。boss差し戻しM1の再発防止)", () => {
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
        bet_unit: null,
        greedy_steps: null,
        candidate_cap: null,
        model_id: null,
        model_approximate: null,
        odds_status: "result",
      });
      store.close();
    });

    it("AC2: route=mixed のメタ行が全20列で固定どおりに保存されること(candidate_cap・comboOdds診断値とも非null)", () => {
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

    it("AC4: 新テーブルが存在しない旧DBを開いても既存データが読め、テーブルが作成され、配分付きで保存できること", () => {
      const db = new Database(":memory:");
      // 旧バージョン相当: analyses/analysis_horses のみの最小スキーマ(配分系テーブル自体が無い)。
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
          PRIMARY KEY (analysis_id, umaban)
        );
        INSERT INTO analyses (id, race_id, analyzed_at) VALUES (1, '旧分析レース', '2026-01-01T00:00:00.000Z');
      `);
      const store = new AnalysisStore({ database: db });
      // 既存データ(旧分析)が読めること。
      expect(store.listAnalyses({ raceId: "旧分析レース" })).toHaveLength(1);
      // 新規保存(配分付き)ができること = 新テーブルが作成されていること。
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "旧DB配分レース",
          allocation: { meta: makeMeta(), bets: [{ betType: "place", comboKey: "01", stake: 100, odds: 2.0, ev: 1.1 }] },
        }),
      );
      expect(rawMetaRow(store, id)).toMatchObject({ route: "mixed" });
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

    it("AC5-2: 配分行を持つ「版不明」分析をdeleteAnalysesWithUnknownPromptVersionで削除でき、FK制約違反にならず、配分の親子行も残らないこと", () => {
      const store = new AnalysisStore();
      const id = store.saveAnalysis(
        makeRecord({
          raceId: "版不明配分レース",
          promptVersion: null,
          allocation: {
            meta: makeMeta(),
            bets: [{ betType: "place", comboKey: "01", stake: 100, odds: 2.0, ev: 1.1 }],
          },
        }),
      );
      expect(() => store.deleteAnalysesWithUnknownPromptVersion()).not.toThrow();
      expect(store.listAnalyses({ raceId: "版不明配分レース" })).toHaveLength(0);
      const counts = store.rawDatabase
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM analysis_allocation_meta WHERE analysis_id = ?) AS meta,
             (SELECT COUNT(*) FROM analysis_bets WHERE analysis_id = ?) AS bets`,
        )
        .get(id, id) as { meta: number; bets: number };
      expect(counts).toEqual({ meta: 0, bets: 0 });
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
  });
});
