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
