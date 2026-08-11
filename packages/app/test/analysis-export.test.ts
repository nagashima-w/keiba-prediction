/**
 * analysis-export.ts(分析データのエクスポート・第一版)のテスト(GitHub Issue#10)。
 *
 * electron・IOに一切依存しない純関数(buildRaceSnapshot・buildAnalysisExportDocument・
 * serializeAnalysisExportJson・serializeAnalysisExportCsv・pickLatestAnalysis)を検証する。
 * 手本は log-export.test.ts 相当の純関数テスト流儀。
 */

import { describe, expect, it } from "vitest";
import type {
  ComboOddsFetchOutcome,
  RaceData,
  RaceResultDetail,
  RaceResultEntry,
  StoredAnalysis,
} from "@keiba/core";

import {
  buildAnalysisExportDocument,
  buildDefaultAnalysisExportFileName,
  buildRaceSnapshot,
  deriveCsvPathFromJsonPath,
  pickLatestAnalysis,
  serializeAnalysisExportCsv,
  serializeAnalysisExportJson,
  type BuildAnalysisExportInput,
} from "../src/main/analysis-export.js";

/** テスト用の最小 RaceData を組み立てる。 */
function makeRaceData(overrides: Partial<RaceData> = {}): RaceData {
  return {
    raceId: "202605020811" as RaceData["raceId"],
    race: {
      raceName: "テストステークス",
      courseType: "芝",
      distance: 1600,
      startTime: "15:35",
      weather: "晴",
      trackCondition: "良",
      fence: "A",
    },
    horses: [
      {
        shutuba: {
          wakuban: 1,
          umaban: 1,
          name: "アルファ",
          horseId: "2020100001" as never,
          sex: "牡",
          age: 4,
          kinryo: 57,
          jockeyName: "テスト騎手",
          jockeyId: "00001",
          stableLocation: "美浦",
          trainerName: "テスト調教師",
          trainerId: "00002",
          bodyWeight: { weight: 480, diff: 2 },
        },
        results: [],
        oikiri: { umaban: 1, horseId: "2020100001" as never, horseName: "アルファ", critic: "動き良好", rank: "A" },
      },
      {
        shutuba: {
          wakuban: 2,
          umaban: 2,
          name: "ブラボー",
          horseId: "2020100002" as never,
          sex: "牝",
          age: 3,
          kinryo: 54,
          jockeyName: "テスト騎手2",
          jockeyId: null,
          stableLocation: "栗東",
          trainerName: "テスト調教師2",
          trainerId: null,
          bodyWeight: null,
        },
        results: [],
        oikiri: null,
      },
    ],
    odds: {
      officialDatetime: "2026-07-24 09:00:00",
      oddsStatus: "result",
      win: {
        1: { odds: 2.5, ninki: 1 },
        2: { odds: 8.0, ninki: 4 },
      },
      place: {
        1: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 },
        2: { oddsMin: 2.0, oddsMax: 2.5, ninki: 4 },
      },
    },
    meta: {
      fetchedAt: "2026-07-24T09:00:00.000Z",
      oddsFetchedAt: "2026-07-24T09:00:00.000Z",
      warnings: [],
    },
    ...overrides,
  } as RaceData;
}

/**
 * テスト用の最小 ComboOddsFetchOutcome(機能D-2c第3段・Issue #28)を組み立てる。
 * state="available"なら1件取得できた体、それ以外(unavailable/failed)は0件取得の体にする
 * (発売なし/未発売と取得失敗はどちらもwideCombo/trioComboが{}になるが、この`state`だけが
 * 両者を区別する唯一の手段であるため〈shared/analysis-types.tsのJSDoc参照〉)。
 */
function makeComboOddsFetchOutcome(
  state: ComboOddsFetchOutcome["state"],
): ComboOddsFetchOutcome {
  return {
    state,
    diagnostics: {
      betType: "wide",
      requestCount: 1,
      expectedComboCount: 1,
      obtainedComboCount: state === "available" ? 1 : 0,
      missingComboCount: state === "available" ? 0 : 1,
      axisUmabans: [],
      attempts: [],
      numericConflictCount: 0,
      nullWinConflictCount: 0,
      conflictSamples: [],
    },
  };
}

describe("makeComboOddsFetchOutcome(テストヘルパーの自己検証)", () => {
  it("stateをそのまま反映し、available以外はobtainedComboCount=0にすること", () => {
    const available = makeComboOddsFetchOutcome("available");
    expect(available.state).toBe("available");
    expect(available.diagnostics.obtainedComboCount).toBe(1);

    const unavailable = makeComboOddsFetchOutcome("unavailable");
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.diagnostics.obtainedComboCount).toBe(0);

    const failed = makeComboOddsFetchOutcome("failed");
    expect(failed.state).toBe("failed");
    expect(failed.diagnostics.obtainedComboCount).toBe(0);
  });
});

/** テスト用の最小 StoredAnalysis を組み立てる。 */
function makeStoredAnalysis(overrides: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    id: 42,
    raceId: "202605020811",
    analyzedAt: "2026-07-24T09:05:00.000Z",
    evEstimated: false,
    promptVersion: "v1",
    additionalInstruction: null,
    kaisaiDate: "20260724",
    model: "claude-sonnet-4-6",
    rawResponse: '{"horses":[]}',
    raceSnapshot: buildRaceSnapshot(makeRaceData()),
    horses: [
      {
        umaban: 1,
        prior: 0.4,
        adjustedProb: 0.45,
        placeOddsMin: 1.2,
        ev: 0.9,
        isPositive: false,
        contributions: null,
        mark: "◎",
        reason: "調教良化",
      },
      {
        umaban: 2,
        prior: 0.2,
        adjustedProb: 0.18,
        placeOddsMin: 2.0,
        ev: 1.2,
        isPositive: true,
        contributions: null,
        mark: null,
        reason: null,
      },
    ],
    ...overrides,
  };
}

function makeInput(overrides: Partial<BuildAnalysisExportInput> = {}): BuildAnalysisExportInput {
  return {
    analysis: makeStoredAnalysis(),
    venueName: "東京",
    results: undefined,
    resultDetail: undefined,
    toolName: "競馬期待値分析ツール",
    toolVersion: "1.0.0",
    exportedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildRaceSnapshot(取得したレース情報のスナップショット化)", () => {
  it("レース情報・各馬の出馬表項目・単複オッズ・調教をスナップショット化すること", () => {
    const snapshot = buildRaceSnapshot(makeRaceData());
    expect(snapshot.race).toEqual({
      raceName: "テストステークス",
      courseType: "芝",
      distance: 1600,
      weather: "晴",
      trackCondition: "良",
      startTime: "15:35",
      fence: "A",
      oddsStatus: "result",
      officialDatetime: "2026-07-24 09:00:00",
    });
    const h1 = snapshot.horses.find((h) => h.umaban === 1)!;
    expect(h1).toEqual({
      umaban: 1,
      wakuban: 1,
      name: "アルファ",
      sex: "牡",
      age: 4,
      kinryo: 57,
      jockeyName: "テスト騎手",
      trainerName: "テスト調教師",
      bodyWeight: 480,
      winOdds: 2.5,
      popularity: 1,
      placeOddsMin: 1.2,
      oikiriCritic: "動き良好",
      oikiriRank: "A",
    });
  });

  it("馬体重未発表(null)・調教評価なし(oikiri null)・天候等未取得(undefined)は欠損項目をnullで表すこと", () => {
    const snapshot = buildRaceSnapshot(
      makeRaceData({
        race: {
          raceName: "テスト2",
          courseType: "ダ",
          distance: 1200,
        },
      }),
    );
    expect(snapshot.race.weather).toBeNull();
    expect(snapshot.race.trackCondition).toBeNull();
    expect(snapshot.race.startTime).toBeNull();
    expect(snapshot.race.fence).toBeNull();
    const h2 = snapshot.horses.find((h) => h.umaban === 2)!;
    expect(h2.bodyWeight).toBeNull();
    expect(h2.oikiriCritic).toBeNull();
    expect(h2.oikiriRank).toBeNull();
  });

  it("過去戦績(results)はスナップショットに含めないこと(サイズ大のため対象外)", () => {
    const snapshot = buildRaceSnapshot(makeRaceData());
    for (const h of snapshot.horses) {
      expect((h as unknown as Record<string, unknown>).results).toBeUndefined();
    }
  });

  describe("組合せオッズ(ワイド・三連複。機能D-2c第3段・Issue #28: 一次データを記録のみ残す)", () => {
    /**
     * hasOwnPropertyの簡潔な別名(code-reviewer指摘対応: analysis-pipeline.test.tsの
     * 8状態〈wideCombo有無×trioCombo有無×comboOdds有無〉パターンをこのファイルにも横展開する。
     * 「undefinedという値の代入」と「キー自体が無いこと」はJSON.stringifyでは区別できないため、
     * hasOwnPropertyで直接キーの有無を見る)。
     */
    const hasOwn = (obj: object, key: string): boolean =>
      Object.prototype.hasOwnProperty.call(obj, key);

    /** ワイド・三連複を含むraceDataを組み立てる(odds/metaの3フィールドを個別に上書きできる)。 */
    function makeComboRaceData(overrides: {
      wideCombo?: Record<string, number | null>;
      trioCombo?: Record<string, number | null>;
      comboOdds?: {
        wide?: ReturnType<typeof makeComboOddsFetchOutcome>;
        trio?: ReturnType<typeof makeComboOddsFetchOutcome>;
      };
    }): RaceData {
      return makeRaceData({
        odds: {
          officialDatetime: "2026-07-24 09:00:00",
          oddsStatus: "result",
          win: { 1: { odds: 2.5, ninki: 1 }, 2: { odds: 8.0, ninki: 4 } },
          place: {
            1: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 },
            2: { oddsMin: 2.0, oddsMax: 2.5, ninki: 4 },
          },
          ...(overrides.wideCombo !== undefined ? { wideCombo: overrides.wideCombo } : {}),
          ...(overrides.trioCombo !== undefined ? { trioCombo: overrides.trioCombo } : {}),
        },
        meta: {
          fetchedAt: "2026-07-24T09:00:00.000Z",
          oddsFetchedAt: "2026-07-24T09:00:00.000Z",
          warnings: [],
          ...(overrides.comboOdds !== undefined ? { comboOdds: overrides.comboOdds } : {}),
        },
      });
    }

    it("OFF(includeComboOdds未使用): race.odds.wideCombo/trioCombo・race.meta.comboOddsが" +
      "undefinedのままなら、スナップショットにキー自体が生えないこと(受け入れ条件7)", () => {
      // makeRaceData()の既定odds/metaにはwideCombo/trioCombo/comboOddsを含めていない
      // (scrapeRaceのincludeComboOdds:false相当)。まず前提を無条件expectで固定する。
      const race = makeRaceData();
      expect(race.odds.wideCombo).toBeUndefined();
      expect(race.odds.trioCombo).toBeUndefined();
      expect(race.meta.comboOdds).toBeUndefined();

      const snapshot = buildRaceSnapshot(race);
      expect(hasOwn(snapshot, "wideCombo")).toBe(false);
      expect(hasOwn(snapshot, "trioCombo")).toBe(false);
      expect(hasOwn(snapshot, "comboOdds")).toBe(false);
    });

    it("ON・取得成功: race.odds.wideCombo/trioCombo・race.meta.comboOddsの値が欠落なく写ること(受け入れ条件7・3キーすべて有)", () => {
      const race = makeComboRaceData({
        wideCombo: { "1-2": 3.4 },
        trioCombo: { "1-2-3": 12.5 },
        comboOdds: {
          wide: makeComboOddsFetchOutcome("available"),
          trio: makeComboOddsFetchOutcome("available"),
        },
      });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.wideCombo).toEqual({ "1-2": 3.4 });
      expect(hasOwn(snapshot, "wideCombo")).toBe(true);
      expect(snapshot.trioCombo).toEqual({ "1-2-3": 12.5 });
      expect(hasOwn(snapshot, "trioCombo")).toBe(true);
      expect(snapshot.comboOdds).toEqual({
        wide: makeComboOddsFetchOutcome("available"),
        trio: makeComboOddsFetchOutcome("available"),
      });
      expect(hasOwn(snapshot, "comboOdds")).toBe(true);
    });

    /**
     * 非対称ケース(code-reviewer指摘: 「trioComboの条件式がwideCombo側の条件を見る」変異
     * 〈`...(race.odds.wideCombo !== undefined ? { trioCombo: ... } : {})`〉が、
     * 「両方値あり」「両方未設定」という対称な入力だけでは検知できないことが実際に確認された
     * 〈レビュアーが注入し32件全緑で通過〉。analysis-pipeline.test.tsの8状態パターンを
     * このファイルにも横展開し、片方だけ設定・もう片方は未取得(キー自体無し)を両方向で固定する。
     */
    it("wideComboのみ設定・trioComboは未設定(キー自体無し)のとき、両者が互いに影響し合わず独立して伝播すること(非対称ケース)", () => {
      const race = makeComboRaceData({ wideCombo: { "1-2": 3.4 } });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.wideCombo).toEqual({ "1-2": 3.4 });
      expect(hasOwn(snapshot, "wideCombo")).toBe(true);
      expect(snapshot.trioCombo).toBeUndefined();
      expect(hasOwn(snapshot, "trioCombo")).toBe(false);
      expect(snapshot.comboOdds).toBeUndefined();
      expect(hasOwn(snapshot, "comboOdds")).toBe(false);
    });

    it("trioComboのみ設定・wideComboは未設定(キー自体無し)のとき、両者が互いに影響し合わず独立して伝播すること(非対称ケース・逆方向)", () => {
      const race = makeComboRaceData({ trioCombo: { "1-2-3": 12.5 } });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.trioCombo).toEqual({ "1-2-3": 12.5 });
      expect(hasOwn(snapshot, "trioCombo")).toBe(true);
      expect(snapshot.wideCombo).toBeUndefined();
      expect(hasOwn(snapshot, "wideCombo")).toBe(false);
      expect(snapshot.comboOdds).toBeUndefined();
      expect(hasOwn(snapshot, "comboOdds")).toBe(false);
    });

    it("wideComboとcomboOddsのみ設定・trioComboは未設定(キー自体無し)のとき、3キーとも独立して伝播すること(混在ケース)", () => {
      const comboOdds = { wide: makeComboOddsFetchOutcome("available") };
      const race = makeComboRaceData({ wideCombo: { "1-2": 3.4 }, comboOdds });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.wideCombo).toEqual({ "1-2": 3.4 });
      expect(hasOwn(snapshot, "wideCombo")).toBe(true);
      expect(snapshot.comboOdds).toEqual(comboOdds);
      expect(hasOwn(snapshot, "comboOdds")).toBe(true);
      expect(snapshot.trioCombo).toBeUndefined();
      expect(hasOwn(snapshot, "trioCombo")).toBe(false);
    });

    it("trioComboとcomboOddsのみ設定・wideComboは未設定(キー自体無し)のとき、3キーとも独立して伝播すること(混在ケース・逆方向)", () => {
      const comboOdds = { trio: makeComboOddsFetchOutcome("available") };
      const race = makeComboRaceData({ trioCombo: { "1-2-3": 12.5 }, comboOdds });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.trioCombo).toEqual({ "1-2-3": 12.5 });
      expect(hasOwn(snapshot, "trioCombo")).toBe(true);
      expect(snapshot.comboOdds).toEqual(comboOdds);
      expect(hasOwn(snapshot, "comboOdds")).toBe(true);
      expect(snapshot.wideCombo).toBeUndefined();
      expect(hasOwn(snapshot, "wideCombo")).toBe(false);
    });

    describe("3状態(未取得〈undefined〉/空({})/値あり)の区別、およびcomboOdds.<betType>.stateが唯一の判別子であること(受け入れ条件7)", () => {
      it("wideCombo: {}(発売なし/未発売)と{}(取得失敗)をcomboOdds.wide.stateで区別できること", () => {
        const unavailableSnapshot = buildRaceSnapshot(
          makeComboRaceData({
            wideCombo: {},
            comboOdds: { wide: makeComboOddsFetchOutcome("unavailable") },
          }),
        );
        expect(unavailableSnapshot.wideCombo).toEqual({});
        expect(unavailableSnapshot.comboOdds?.wide?.state).toBe("unavailable");

        const failedSnapshot = buildRaceSnapshot(
          makeComboRaceData({
            wideCombo: {},
            comboOdds: { wide: makeComboOddsFetchOutcome("failed") },
          }),
        );
        expect(failedSnapshot.wideCombo).toEqual({});
        expect(failedSnapshot.comboOdds?.wide?.state).toBe("failed");

        // wideCombo単体(いずれも{})では区別できず、comboOdds.wide.stateが区別する唯一の手段であること。
        expect(unavailableSnapshot.wideCombo).toEqual(failedSnapshot.wideCombo);
        expect(unavailableSnapshot.comboOdds?.wide?.state).not.toBe(
          failedSnapshot.comboOdds?.wide?.state,
        );
      });

      it("trioCombo: {}(発売なし/未発売)と{}(取得失敗)をcomboOdds.trio.stateで区別できること(wide側と同じ観点を三連複にも横展開)", () => {
        const unavailableSnapshot = buildRaceSnapshot(
          makeComboRaceData({
            trioCombo: {},
            comboOdds: { trio: makeComboOddsFetchOutcome("unavailable") },
          }),
        );
        expect(unavailableSnapshot.trioCombo).toEqual({});
        expect(unavailableSnapshot.comboOdds?.trio?.state).toBe("unavailable");

        const failedSnapshot = buildRaceSnapshot(
          makeComboRaceData({
            trioCombo: {},
            comboOdds: { trio: makeComboOddsFetchOutcome("failed") },
          }),
        );
        expect(failedSnapshot.trioCombo).toEqual({});
        expect(failedSnapshot.comboOdds?.trio?.state).toBe("failed");

        expect(unavailableSnapshot.trioCombo).toEqual(failedSnapshot.trioCombo);
        expect(unavailableSnapshot.comboOdds?.trio?.state).not.toBe(
          failedSnapshot.comboOdds?.trio?.state,
        );
      });

      it("未取得(キー自体無し)と空({})は別状態であること(wideCombo/trioComboそれぞれ)", () => {
        const unfetched = buildRaceSnapshot(makeRaceData());
        expect(hasOwn(unfetched, "wideCombo")).toBe(false);
        expect(hasOwn(unfetched, "trioCombo")).toBe(false);

        const empty = buildRaceSnapshot(
          makeComboRaceData({ wideCombo: {}, trioCombo: {} }),
        );
        expect(hasOwn(empty, "wideCombo")).toBe(true);
        expect(empty.wideCombo).toEqual({});
        expect(hasOwn(empty, "trioCombo")).toBe(true);
        expect(empty.trioCombo).toEqual({});
      });
    });

    describe("入力×出力の対応表 + 定数置換(.claude/agents/code-reviewer.mdの新条項)", () => {
      // buildRaceSnapshotはrace.odds/race.metaから「写す」関数であるため、出力を実装内の
      // 何らかの固定値に置き換えても検知できることを、非デフォルト値のフィクスチャで確認する。
      it("wideCombo/trioCombo/comboOddsの値は、実装内に無い非デフォルト値でも欠落なく写ること(定数置換の余地が無いことの確認)", () => {
        const race = makeComboRaceData({
          wideCombo: { "3-4": 99.9 }, // 他のどのテストとも異なる値。
          trioCombo: { "3-4-5": 88.8 },
          comboOdds: {
            wide: makeComboOddsFetchOutcome("failed"),
            trio: makeComboOddsFetchOutcome("unavailable"),
          },
        });
        const snapshot = buildRaceSnapshot(race);
        expect(snapshot.wideCombo).toEqual({ "3-4": 99.9 });
        expect(snapshot.trioCombo).toEqual({ "3-4-5": 88.8 });
        expect(snapshot.comboOdds?.wide?.state).toBe("failed");
        expect(snapshot.comboOdds?.trio?.state).toBe("unavailable");
      });
    });
  });

  describe("horsesブロックの行ごとの写像(受け入れ条件7周辺。第2段boss差し戻し論点の横展開)", () => {
    /**
     * 2頭の値をすべて異ならせたraceDataを組み立てる(第2段「行ごとの写像を、値の種類がある
     * 入力で固定する」の教訓: 全ての行が同じ値だと、行を取り違える変異〈umabanをハードコードする等〉
     * を検知できない)。
     */
    function makeTwoDistinctHorsesRaceData(): RaceData {
      return makeRaceData({
        odds: {
          officialDatetime: "2026-07-24 09:00:00",
          oddsStatus: "result",
          win: { 1: { odds: 2.5, ninki: 1 }, 2: { odds: 8.0, ninki: 4 } },
          place: {
            1: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 },
            2: { oddsMin: 2.0, oddsMax: 2.5, ninki: 4 },
          },
        },
      });
    }

    it("2頭それぞれの出馬表項目・単複オッズ・調教が、umabanに対応する値のまま独立して写ること(行の取り違え検知)", () => {
      const snapshot = buildRaceSnapshot(makeTwoDistinctHorsesRaceData());
      const h1 = snapshot.horses.find((h) => h.umaban === 1)!;
      const h2 = snapshot.horses.find((h) => h.umaban === 2)!;

      // 前提固定: 2頭の値がすべて異なること(空振り防止。同じ値なら取り違えても気付けない)。
      expect(h1).not.toEqual(h2);
      expect(h1.winOdds).not.toBe(h2.winOdds);
      expect(h1.popularity).not.toBe(h2.popularity);
      expect(h1.placeOddsMin).not.toBe(h2.placeOddsMin);
      expect(h1.name).not.toBe(h2.name);
      expect(h1.oikiriCritic).not.toBe(h2.oikiriCritic);

      // h1・h2それぞれの値を個別に固定する(片方だけでは行の取り違えを検知できない)。
      expect(h1).toEqual({
        umaban: 1,
        wakuban: 1,
        name: "アルファ",
        sex: "牡",
        age: 4,
        kinryo: 57,
        jockeyName: "テスト騎手",
        trainerName: "テスト調教師",
        bodyWeight: 480,
        winOdds: 2.5,
        popularity: 1,
        placeOddsMin: 1.2,
        oikiriCritic: "動き良好",
        oikiriRank: "A",
      });
      expect(h2).toEqual({
        umaban: 2,
        wakuban: 2,
        name: "ブラボー",
        sex: "牝",
        age: 3,
        kinryo: 54,
        jockeyName: "テスト騎手2",
        trainerName: "テスト調教師2",
        bodyWeight: null,
        winOdds: 8.0,
        popularity: 4,
        placeOddsMin: 2.0,
        oikiriCritic: null,
        oikiriRank: null,
      });
    });
  });
});

describe("buildAnalysisExportDocument(schemaVersion=1 のエクスポートJSONを組み立てる)", () => {
  it("schemaVersion:1と、meta・race・horses・results・rawLlmResponseを組み立てること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        results: [
          { umaban: 1, finishPosition: 1, placePayout: 120 },
          { umaban: 2, finishPosition: 4, placePayout: null },
        ],
        resultDetail: {
          courseType: "芝",
          horses: [
            { umaban: 1, finishPosition: 1, passing: [2, 1, 1, 1], last3f: 34.5 },
            { umaban: 2, finishPosition: 4, passing: [5, 5, 5, 4], last3f: 35.8 },
          ],
        },
      }),
    );
    expect(doc.schemaVersion).toBe(1);
    expect(doc.meta).toEqual({
      toolName: "競馬期待値分析ツール",
      toolVersion: "1.0.0",
      exportedAt: "2026-07-24T10:00:00.000Z",
      analysisId: 42,
      analyzedAt: "2026-07-24T09:05:00.000Z",
      kaisaiDate: "20260724",
      promptVersion: "v1",
      additionalInstruction: null,
      model: "claude-sonnet-4-6",
      evEstimated: false,
    });
    expect(doc.race).toEqual({
      raceId: "202605020811",
      venueName: "東京",
      raceName: "テストステークス",
      courseType: "芝",
      distance: 1600,
      weather: "晴",
      trackCondition: "良",
      startTime: "15:35",
      fence: "A",
      oddsStatus: "result",
      officialDatetime: "2026-07-24 09:00:00",
    });
    const h1 = doc.horses.find((h) => h.umaban === 1)!;
    expect(h1).toEqual({
      umaban: 1,
      wakuban: 1,
      name: "アルファ",
      sex: "牡",
      age: 4,
      kinryo: 57,
      jockeyName: "テスト騎手",
      trainerName: "テスト調教師",
      bodyWeight: 480,
      winOdds: 2.5,
      popularity: 1,
      placeOddsMin: 1.2,
      oikiriCritic: "動き良好",
      oikiriRank: "A",
      prior: 0.4,
      adjustedProb: 0.45,
      ev: 0.9,
      isPositive: false,
      mark: "◎",
      reason: "調教良化",
    });
    expect(doc.results).toEqual([
      { umaban: 1, finishPosition: 1, placePayout: 120, passing: [2, 1, 1, 1], last3f: 34.5 },
      { umaban: 2, finishPosition: 4, placePayout: null, passing: [5, 5, 5, 4], last3f: 35.8 },
    ]);
    expect(doc.rawLlmResponse).toBe('{"horses":[]}');
  });

  it("欠損はキーを省略せず明示nullで表すこと(placeOddsMin/evなど)", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          horses: [
            {
              umaban: 1,
              prior: 0.3,
              adjustedProb: 0.3,
              placeOddsMin: null,
              ev: null,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    const h1 = doc.horses[0]!;
    expect("placeOddsMin" in h1).toBe(true);
    expect(h1.placeOddsMin).toBeNull();
    expect("ev" in h1).toBe(true);
    expect(h1.ev).toBeNull();
    expect("mark" in h1).toBe(true);
    expect(h1.mark).toBeNull();
    expect("reason" in h1).toBe(true);
    expect(h1.reason).toBeNull();
  });

  it("LLMスキップ時(model/rawResponse/reasonがnull)は偽値を混入させずnullのまま出力すること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          model: null,
          rawResponse: null,
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: 1.2,
              ev: 0.9,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    expect(doc.meta.model).toBeNull();
    expect(doc.rawLlmResponse).toBeNull();
    expect(doc.horses[0]!.reason).toBeNull();
  });

  it("旧レコード(raceSnapshot/model/rawResponseが全てnull)でも例外を投げず出力すること(スナップショット由来項目はnull)", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          model: null,
          rawResponse: null,
          raceSnapshot: null,
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: 1.2,
              ev: 0.9,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    expect(doc.race.raceName).toBeNull();
    expect(doc.race.courseType).toBeNull();
    expect(doc.race.oddsStatus).toBeNull();
    const h1 = doc.horses[0]!;
    expect(h1.name).toBeNull();
    expect(h1.jockeyName).toBeNull();
    expect(h1.oikiriCritic).toBeNull();
    // analysis_horses由来の項目(prior/adjustedProb等)は旧レコードでも保持される。
    expect(h1.prior).toBe(0.4);
    expect(h1.adjustedProb).toBe(0.4);
  });

  it("破損したraceSnapshot(スキーマ不正なJSON由来のunknown値)でも例外を投げずスナップショット由来項目をnullにすること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({ raceSnapshot: { unexpected: "shape" } }),
      }),
    );
    expect(doc.race.raceName).toBeNull();
    expect(doc.horses[0]!.name).toBeNull();
  });

  describe("組合せオッズ(機能D-2c第3段・Issue #28)を持たない旧レコード・持つ新レコードの復元(受け入れ条件8)", () => {
    it("wideCombo/trioCombo/comboOddsキー自体が無い旧形式のraceSnapshotでも例外を投げず、他の項目は復元できること", () => {
      // 機能D-2c第3段より前に保存された典型的なraceSnapshot(新フィールドのキー自体が無い)。
      const legacyRaw = {
        race: { raceName: "旧レコードのレース", courseType: "芝", distance: 1600 },
        horses: [{ umaban: 1, name: "旧レコードの馬" }],
      };
      const doc = buildAnalysisExportDocument(
        makeInput({
          analysis: makeStoredAnalysis({ raceSnapshot: legacyRaw }),
        }),
      );
      expect(doc.race.raceName).toBe("旧レコードのレース");
      expect(doc.horses[0]!.name).toBe("旧レコードの馬");
    });

    it("wideCombo/trioCombo/comboOddsを持つ新形式のraceSnapshotを渡しても例外を投げず、エクスポートJSONへは新フィールドが漏れないこと(G2: 第3段では露出しない)", () => {
      const newFormatRaceSnapshot = buildRaceSnapshot(
        makeRaceData({
          odds: {
            officialDatetime: "2026-07-24 09:00:00",
            oddsStatus: "result",
            win: { 1: { odds: 2.5, ninki: 1 } },
            place: { 1: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 } },
            wideCombo: { "1-2": 3.4 },
          },
          meta: {
            fetchedAt: "2026-07-24T09:00:00.000Z",
            oddsFetchedAt: "2026-07-24T09:00:00.000Z",
            warnings: [],
            comboOdds: { wide: makeComboOddsFetchOutcome("available") },
          },
        }),
      );
      // 前提固定: このraceSnapshotには実際に新フィールドが載っていること。
      expect(newFormatRaceSnapshot.wideCombo).toEqual({ "1-2": 3.4 });

      const doc = buildAnalysisExportDocument(
        makeInput({
          analysis: makeStoredAnalysis({ raceSnapshot: newFormatRaceSnapshot }),
        }),
      );
      expect(doc.race.raceName).toBe("テストステークス");
      expect("wideCombo" in doc.race).toBe(false);
      expect("trioCombo" in doc.race).toBe(false);
      expect("comboOdds" in doc.race).toBe(false);
    });
  });

  it("結果未取込(results/resultDetailともにundefined)ならresultsは空配列になること", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    expect(doc.results).toEqual([]);
  });

  it("非数値着順(finishPosition=null。中止・除外)もそのままnullで出力すること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        results: [{ umaban: 1, finishPosition: null, placePayout: null }],
        resultDetail: {
          courseType: null,
          horses: [{ umaban: 1, finishPosition: null, passing: [], last3f: null }],
        },
      }),
    );
    expect(doc.results).toEqual([
      { umaban: 1, finishPosition: null, placePayout: null, passing: [], last3f: null },
    ]);
  });

  it("yoso(推定EV)はevEstimated:trueかつplaceOddsMinがnullのまま出力すること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          evEstimated: true,
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: null,
              ev: 1.5,
              isPositive: true,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    expect(doc.meta.evEstimated).toBe(true);
    expect(doc.horses[0]!.placeOddsMin).toBeNull();
  });

  it("秘密安全性: 出力ドキュメントに許可されたキー以外(apiKey・webhook・プロンプト本文相当)が混入しないこと", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    expect(Object.keys(doc).sort()).toEqual(
      ["schemaVersion", "meta", "race", "horses", "results", "rawLlmResponse"].sort(),
    );
    expect(Object.keys(doc.meta).sort()).toEqual(
      [
        "toolName",
        "toolVersion",
        "exportedAt",
        "analysisId",
        "analyzedAt",
        "kaisaiDate",
        "promptVersion",
        "additionalInstruction",
        "model",
        "evEstimated",
      ].sort(),
    );
    // rawLlmResponseは「LLMのモデル出力」のみで、プロンプト本文・apiKeyの文字列は
    // buildAnalysisExportDocumentの入力(BuildAnalysisExportInput)自体に存在しないため、
    // 関数のシグネチャ上構造的に混入しえない(このテストは入力に無い秘密が出力にも無いことの確認)。
    const json = serializeAnalysisExportJson(doc);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("webhook");
    expect(json).not.toContain("Webhook");
  });
});

describe("serializeAnalysisExportJson(JSON文字列化)", () => {
  it("schemaVersion=1を含むJSON文字列を返し、パースするとドキュメントと一致すること", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    const json = serializeAnalysisExportJson(doc);
    expect(JSON.parse(json)).toEqual(doc);
    expect(json).toContain('"schemaVersion": 1');
  });
});

describe("serializeAnalysisExportCsv(馬別CSV文字列化・RFC4180準拠)", () => {
  it("ヘッダ行付き・1行1頭で出力し、結果があればfinishPosition/placePayout/last3f/passing列を結合すること(code-reviewer提案対応: passing/last3f追加)", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        results: [{ umaban: 1, finishPosition: 1, placePayout: 120 }],
        resultDetail: {
          courseType: "芝",
          horses: [{ umaban: 1, finishPosition: 1, passing: [2, 3, 4, 3], last3f: 34.5 }],
        },
      }),
    );
    const csv = serializeAnalysisExportCsv(doc);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ行 + 2頭分。
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("umaban");
    expect(lines[0]).toContain("finishPosition");
    expect(lines[0]).toContain("placePayout");
    expect(lines[0]).toContain("last3f");
    expect(lines[0]).toContain("passing");
    const header = lines[0]!.split(",");
    const row1 = parseCsvLine(lines[1]!);
    expect(row1[0]).toBe("1"); // umaban
    expect(lines[1]).toContain("120"); // placePayout
    expect(row1[header.indexOf("last3f")]).toBe("34.5");
    // passingは配列を "2-3-4-3" のようにハイフン連結した文字列にすること。
    expect(row1[header.indexOf("passing")]).toBe("2-3-4-3");
  });

  it("欠損値は空セルとして出力すること(last3f/passingを含む)", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    const csv = serializeAnalysisExportCsv(doc);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // 2頭目(reason=null・placeOddsMin=2.0はあるがfinishPositionは結果未取込でnull)。
    const header = lines[0]!.split(",");
    const finishPositionIdx = header.indexOf("finishPosition");
    const row2 = parseCsvLine(lines[2]!);
    expect(row2[finishPositionIdx]).toBe("");
    expect(row2[header.indexOf("last3f")]).toBe("");
    // passingが空配列(結果未取込)のときも空セルにすること(要素0件のハイフン連結="" の意味を明示)。
    expect(row2[header.indexOf("passing")]).toBe("");
  });

  it("RFC4180エスケープ: 馬名にカンマ・ダブルクオート・改行を含む場合は正しくクオートされること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          raceSnapshot: buildRaceSnapshot(
            makeRaceData({
              horses: [
                {
                  shutuba: {
                    wakuban: 1,
                    umaban: 1,
                    name: '馬名,"引用",改行\n入り',
                    horseId: "2020100001" as never,
                    sex: "牡",
                    age: 4,
                    kinryo: 57,
                    jockeyName: "騎手",
                    jockeyId: "1",
                    stableLocation: "美浦",
                    trainerName: "調教師",
                    trainerId: "1",
                    bodyWeight: null,
                  },
                  results: [],
                  oikiri: null,
                },
              ],
            }),
          ),
          horses: [
            {
              umaban: 1,
              prior: 0.3,
              adjustedProb: 0.3,
              placeOddsMin: null,
              ev: null,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: 'reasonにも,"引用"を含む',
            },
          ],
        }),
      }),
    );
    const csv = serializeAnalysisExportCsv(doc);
    const header = csv.split("\r\n")[0]!.split(",");
    const nameIdx = header.indexOf("name");
    const reasonIdx = header.indexOf("reason");
    const rows = parseCsvRecords(csv);
    const dataRow = rows[1]!;
    expect(dataRow[nameIdx]).toBe('馬名,"引用",改行\n入り');
    expect(dataRow[reasonIdx]).toBe('reasonにも,"引用"を含む');
  });
});

describe("pickLatestAnalysis(同一レースの複数分析から最新〈id最大〉を決定的に選ぶ)", () => {
  it("id最大の分析を返すこと(保存順に関わらない)", () => {
    const a1 = makeStoredAnalysis({ id: 5 });
    const a2 = makeStoredAnalysis({ id: 12 });
    const a3 = makeStoredAnalysis({ id: 7 });
    expect(pickLatestAnalysis([a1, a2, a3])).toBe(a2);
  });

  it("1件のみなら、その1件を返すこと", () => {
    const a1 = makeStoredAnalysis({ id: 1 });
    expect(pickLatestAnalysis([a1])).toBe(a1);
  });

  it("空配列ならnullを返すこと", () => {
    expect(pickLatestAnalysis([])).toBeNull();
  });
});

describe("buildDefaultAnalysisExportFileName(既定ファイル名。log-export.tsのbuildDefaultLogExportFileNameと同流儀)", () => {
  it("レースIDと当日日付(YYYYMMDD)を含むJSON既定ファイル名を返すこと", () => {
    const name = buildDefaultAnalysisExportFileName(
      "202605020811",
      new Date(2026, 6, 16),
    );
    expect(name).toBe("keiba-ev-tool-analysis-202605020811-20260716.json");
  });
});

describe("deriveCsvPathFromJsonPath(JSON保存先パスからCSVパスを導出。code-reviewer指摘対応: csvPathがjsonPathと衝突しないことを保証する)", () => {
  it("拡張子.json(小文字)は.csvへ置き換えること", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis.json")).toBe(
      "/tmp/out/analysis.csv",
    );
  });

  it("拡張子.JSON(大文字)も.csvへ置き換えること(大文字小文字を区別しない)", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis.JSON")).toBe(
      "/tmp/out/analysis.csv",
    );
  });

  it("ユーザーが保存先に.csv拡張子を指定した場合は置き換えず末尾に.csvを付加すること(元のjsonPathと衝突させない。JSON消失防止)", () => {
    const result = deriveCsvPathFromJsonPath("/tmp/out/analysis.csv");
    expect(result).toBe("/tmp/out/analysis.csv.csv");
    expect(result).not.toBe("/tmp/out/analysis.csv");
  });

  it("拡張子が無いファイル名は末尾に.csvを付与すること", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis")).toBe(
      "/tmp/out/analysis.csv",
    );
  });

  it(".json以外の拡張子(.txt等)は置き換えず末尾に.csvを付加すること(置き換えると衝突を生みうるため常に付加のみ)", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis.txt")).toBe(
      "/tmp/out/analysis.txt.csv",
    );
  });

  it("境界プロパティ: どの入力でも戻り値が入力jsonPathと一致しないこと(衝突不可能性の保証)", () => {
    for (const p of [
      "/a/b.json",
      "/a/b.JSON",
      "/a/b.csv",
      "/a/b.CSV",
      "/a/b",
      "/a/b.txt",
    ]) {
      expect(deriveCsvPathFromJsonPath(p)).not.toBe(p);
    }
  });
});

/** 簡易CSV1行パーサ(RFC4180の最小サブセット。テスト専用)。 */
function parseCsvLine(line: string): string[] {
  return parseCsvRecords(line)[0]!;
}

/** 簡易CSV全体パーサ(RFC4180の最小サブセット。テスト専用。crlf区切り・""エスケープ対応)。 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      i += 2;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ""));
}
