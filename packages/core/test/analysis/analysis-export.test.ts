/**
 * analysis-export.ts(レース情報スナップショット)のテスト(GitHub Issue#10・#393)。
 *
 * electron・IOに一切依存しない純関数(buildRaceSnapshot・toSafeRaceSnapshot)を検証する。
 * Issue #393(#390 R-2)で、旧 exe の分析エクスポート(buildAnalysisExportDocument・serializeAnalysisExportJson・
 * serializeAnalysisExportCsv ほか)とそのテストを削除した。そのテストが間接的に固定していた
 * `toSafeRaceSnapshot` の防御的復元(破損・旧形式・新形式)は、末尾の describe で直接固定する。
 */

import { describe, expect, it } from "vitest";
import type { ComboOddsFetchOutcome, RaceData } from "../../src/index.js";
import { buildRaceSnapshot, toSafeRaceSnapshot } from "../../src/analysis/analysis-export.js";

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
 * 両者を区別する唯一の手段であるため〈analysis/analysis-types.tsのJSDoc参照〉)。
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

describe("buildRaceSnapshot(取得したレース情報のスナップショット化)", () => {
  /**
   * code-reviewer指摘への水平展開: raceブロック(RaceSnapshotRace)にも文字列フィールド8個
   * (raceName/courseType/weather/trackCondition/startTime/fence/oddsStatus/officialDatetime。
   * distanceのみnumber|nullで型が異なるため対象外)の同型フィールドが並んでおり、
   * horsesブロックと同じ「隣接ペア取り違え」の穴がありえる。「既定フィクスチャは互いに異なる
   * 値になっている」と報告するだけでなく、new Set([...]).sizeで機械的に固定する
   * (mixed-candidates.test.tsの`row()`自己テスト・horsesブロックの自己テストと同じ形)。
   */
  it("makeRaceData()の既定raceブロックは、文字列フィールド8個が互いに相異なること(取り違え検知の前提の自己検証)", () => {
    const snapshot = buildRaceSnapshot(makeRaceData());
    const r = snapshot.race;
    const strings = [
      r.raceName, r.courseType, r.weather, r.trackCondition,
      r.startTime, r.fence, r.oddsStatus, r.officialDatetime,
    ];
    expect(new Set(strings).size).toBe(8);
  });

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
      jockeyId: "00001", // Issue #526: 出馬表の騎手 ID の写し
      trainerName: "テスト調教師",
      trainerId: "00002", // Issue #540: 出馬表の調教師 ID の写し
      horseId: "2020100001", // Issue #540: 出馬表の馬の ID の写し
      bodyWeight: 480,
      winOdds: 2.5,
      popularity: 1,
      placeOddsMin: 1.2,
      placeOddsMax: 1.4,
      earlyPos: null, // Issue #311: 戦績の通過順位が無いフィクスチャなので null
      latePos: null, // Issue #363: 同上
      legStyle: null, // Issue #314: 同上
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
    expect("jockeyId" in h2).toBe(true); // Issue #526: 騎手 ID が無い(jockeyId=null)馬も、キーは残して null
    expect(h2.jockeyId).toBeNull();
    expect("trainerId" in h2).toBe(true); // Issue #540: 調教師 ID が無い(trainerId=null)馬も、キーは残して null
    expect(h2.trainerId).toBeNull();
    expect(h2.horseId).toBe("2020100002"); // Issue #540: 馬の ID は調教師 ID が無くても入る
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

    /**
     * ワイド・三連複・馬連・馬単・三連単を含むraceDataを組み立てる(odds/metaのフィールドを
     * 個別に上書きできる)。馬連(quinellaCombo)はIssue #116・#24-D3b-1、馬単(exactaCombo)は
     * Issue #122・#24-E2、三連単(trifectaCombo)はIssue #137・#25-E2で追加。
     */
    function makeComboRaceData(overrides: {
      wideCombo?: Record<string, number | null>;
      trioCombo?: Record<string, number | null>;
      quinellaCombo?: Record<string, number | null>;
      exactaCombo?: Record<string, number | null>;
      trifectaCombo?: Record<string, number | null>;
      bracketQuinellaCombo?: Record<string, number | null>;
      comboOdds?: {
        wide?: ReturnType<typeof makeComboOddsFetchOutcome>;
        trio?: ReturnType<typeof makeComboOddsFetchOutcome>;
        quinella?: ReturnType<typeof makeComboOddsFetchOutcome>;
        exacta?: ReturnType<typeof makeComboOddsFetchOutcome>;
        trifecta?: ReturnType<typeof makeComboOddsFetchOutcome>;
        bracketQuinella?: ReturnType<typeof makeComboOddsFetchOutcome>;
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
          ...(overrides.quinellaCombo !== undefined
            ? { quinellaCombo: overrides.quinellaCombo }
            : {}),
          ...(overrides.exactaCombo !== undefined
            ? { exactaCombo: overrides.exactaCombo }
            : {}),
          ...(overrides.trifectaCombo !== undefined
            ? { trifectaCombo: overrides.trifectaCombo }
            : {}),
          ...(overrides.bracketQuinellaCombo !== undefined
            ? { bracketQuinellaCombo: overrides.bracketQuinellaCombo }
            : {}),
        },
        meta: {
          fetchedAt: "2026-07-24T09:00:00.000Z",
          oddsFetchedAt: "2026-07-24T09:00:00.000Z",
          warnings: [],
          ...(overrides.comboOdds !== undefined ? { comboOdds: overrides.comboOdds } : {}),
        },
      });
    }

    it("OFF(includeComboOdds未使用): race.odds.wideCombo/trioCombo/quinellaCombo/exactaCombo/trifectaCombo・" +
      "race.meta.comboOddsがundefinedのままなら、スナップショットにキー自体が生えないこと" +
      "(受け入れ条件7。馬連はIssue #116 AC-4、馬単はIssue #122 AC-4、三連単はIssue #137 AC-2)", () => {
      // makeRaceData()の既定odds/metaにはwideCombo/trioCombo/quinellaCombo/exactaCombo/
      // trifectaCombo/comboOddsを含めていない(scrapeRaceのincludeComboOdds:false相当)。
      // まず前提を無条件expectで固定する。
      const race = makeRaceData();
      expect(race.odds.wideCombo).toBeUndefined();
      expect(race.odds.trioCombo).toBeUndefined();
      expect(race.odds.quinellaCombo).toBeUndefined();
      expect(race.odds.exactaCombo).toBeUndefined();
      expect(race.odds.trifectaCombo).toBeUndefined();
      expect(race.meta.comboOdds).toBeUndefined();

      const snapshot = buildRaceSnapshot(race);
      expect(hasOwn(snapshot, "wideCombo")).toBe(false);
      expect(hasOwn(snapshot, "trioCombo")).toBe(false);
      expect(hasOwn(snapshot, "quinellaCombo")).toBe(false);
      expect(hasOwn(snapshot, "exactaCombo")).toBe(false);
      expect(hasOwn(snapshot, "trifectaCombo")).toBe(false);
      expect(hasOwn(snapshot, "comboOdds")).toBe(false);
    });

    it("ON・取得成功: race.odds.wideCombo/trioCombo/quinellaCombo/exactaCombo/trifectaCombo・race.meta.comboOddsの値が" +
      "欠落なく写ること(受け入れ条件7・6キーすべて有。馬連はIssue #116 AC-4、馬単はIssue #122 AC-4、三連単はIssue #137 AC-2)", () => {
      const race = makeComboRaceData({
        wideCombo: { "1-2": 3.4 },
        trioCombo: { "1-2-3": 12.5 },
        quinellaCombo: { "1-4": 5.6 },
        exactaCombo: { "0102": 7.8, "0201": 9.1 },
        trifectaCombo: { "010203": 15.2, "030201": 88.4 },
        comboOdds: {
          wide: makeComboOddsFetchOutcome("available"),
          trio: makeComboOddsFetchOutcome("available"),
          quinella: makeComboOddsFetchOutcome("available"),
          exacta: makeComboOddsFetchOutcome("available"),
          trifecta: makeComboOddsFetchOutcome("available"),
        },
      });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.wideCombo).toEqual({ "1-2": 3.4 });
      expect(hasOwn(snapshot, "wideCombo")).toBe(true);
      expect(snapshot.trioCombo).toEqual({ "1-2-3": 12.5 });
      expect(hasOwn(snapshot, "trioCombo")).toBe(true);
      expect(snapshot.quinellaCombo).toEqual({ "1-4": 5.6 });
      expect(hasOwn(snapshot, "quinellaCombo")).toBe(true);
      // 順序付きキー("0102"と"0201")が別値のまま伝播すること(馬単固有の回帰観点)。
      expect(snapshot.exactaCombo).toEqual({ "0102": 7.8, "0201": 9.1 });
      expect(hasOwn(snapshot, "exactaCombo")).toBe(true);
      // 三連単も同じく順序付きキー("010203"と"030201")が別値のまま伝播すること。
      expect(snapshot.trifectaCombo).toEqual({ "010203": 15.2, "030201": 88.4 });
      expect(hasOwn(snapshot, "trifectaCombo")).toBe(true);
      expect(snapshot.comboOdds).toEqual({
        wide: makeComboOddsFetchOutcome("available"),
        trio: makeComboOddsFetchOutcome("available"),
        quinella: makeComboOddsFetchOutcome("available"),
        exacta: makeComboOddsFetchOutcome("available"),
        trifecta: makeComboOddsFetchOutcome("available"),
      });
      expect(hasOwn(snapshot, "comboOdds")).toBe(true);
    });

    it("quinellaComboのみ設定・wide/trioComboは未設定(キー自体無し)のとき、互いに影響し合わず独立して伝播すること(非対称ケース。馬連はIssue #116 AC-4)", () => {
      const race = makeComboRaceData({ quinellaCombo: { "1-4": 5.6 } });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.quinellaCombo).toEqual({ "1-4": 5.6 });
      expect(hasOwn(snapshot, "quinellaCombo")).toBe(true);
      expect(snapshot.wideCombo).toBeUndefined();
      expect(hasOwn(snapshot, "wideCombo")).toBe(false);
      expect(snapshot.trioCombo).toBeUndefined();
      expect(hasOwn(snapshot, "trioCombo")).toBe(false);
      expect(snapshot.comboOdds).toBeUndefined();
      expect(hasOwn(snapshot, "comboOdds")).toBe(false);
    });

    it("exactaComboのみ設定・wide/trio/quinellaComboは未設定(キー自体無し)のとき、互いに影響し合わず独立して伝播すること(非対称ケース。馬単はIssue #122 AC-4)", () => {
      const race = makeComboRaceData({ exactaCombo: { "0102": 7.8 } });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.exactaCombo).toEqual({ "0102": 7.8 });
      expect(hasOwn(snapshot, "exactaCombo")).toBe(true);
      expect(snapshot.wideCombo).toBeUndefined();
      expect(hasOwn(snapshot, "wideCombo")).toBe(false);
      expect(snapshot.trioCombo).toBeUndefined();
      expect(hasOwn(snapshot, "trioCombo")).toBe(false);
      expect(snapshot.quinellaCombo).toBeUndefined();
      expect(hasOwn(snapshot, "quinellaCombo")).toBe(false);
      expect(snapshot.comboOdds).toBeUndefined();
      expect(hasOwn(snapshot, "comboOdds")).toBe(false);
    });

    it("trifectaComboのみ設定・wide/trio/quinella/exactaComboは未設定(キー自体無し)のとき、互いに影響し合わず独立して伝播すること(非対称ケース。三連単はIssue #137 AC-2)", () => {
      const race = makeComboRaceData({ trifectaCombo: { "010203": 15.2 } });

      const snapshot = buildRaceSnapshot(race);
      expect(snapshot.trifectaCombo).toEqual({ "010203": 15.2 });
      expect(hasOwn(snapshot, "trifectaCombo")).toBe(true);
      expect(snapshot.wideCombo).toBeUndefined();
      expect(hasOwn(snapshot, "wideCombo")).toBe(false);
      expect(snapshot.trioCombo).toBeUndefined();
      expect(hasOwn(snapshot, "trioCombo")).toBe(false);
      expect(snapshot.quinellaCombo).toBeUndefined();
      expect(hasOwn(snapshot, "quinellaCombo")).toBe(false);
      expect(snapshot.exactaCombo).toBeUndefined();
      expect(hasOwn(snapshot, "exactaCombo")).toBe(false);
      expect(snapshot.comboOdds).toBeUndefined();
      expect(hasOwn(snapshot, "comboOdds")).toBe(false);
    });

    describe("枠連(bracketQuinellaCombo。Issue #148・#26-E2)", () => {
      it("未設定ならスナップショットにキー自体が無いこと({}に化けない)", () => {
        const snapshot = buildRaceSnapshot(makeComboRaceData({ wideCombo: { "0102": 3.4 } }));
        expect(snapshot.wideCombo).toEqual({ "0102": 3.4 }); // 前提固定
        expect(snapshot.bracketQuinellaCombo).toBeUndefined();
        expect(hasOwn(snapshot, "bracketQuinellaCombo")).toBe(false);
      });

      it("設定されていれば枠番4桁キーのままスナップショットに載り、comboOdds.bracketQuinellaも写されること", () => {
        const race = makeComboRaceData({
          bracketQuinellaCombo: { "0407": 31.5, "0101": 63.5 },
          comboOdds: {
            bracketQuinella: makeComboOddsFetchOutcome("available"),
          },
        });

        const snapshot = buildRaceSnapshot(race);
        expect(snapshot.bracketQuinellaCombo).toEqual({ "0407": 31.5, "0101": 63.5 });
        expect(hasOwn(snapshot, "bracketQuinellaCombo")).toBe(true);
        expect(snapshot.comboOdds?.bracketQuinella).toEqual(makeComboOddsFetchOutcome("available"));
        // JSON往復(analyses.race_snapshot_jsonへの保存相当)でも消えない。
        const roundTripped = JSON.parse(JSON.stringify(snapshot)) as {
          bracketQuinellaCombo: Record<string, number | null>;
        };
        expect(roundTripped.bracketQuinellaCombo).toEqual({ "0407": 31.5, "0101": 63.5 });
      });

      it("空オブジェクトなら空のまま載ること(undefinedへ化けない)", () => {
        const snapshot = buildRaceSnapshot(makeComboRaceData({ bracketQuinellaCombo: {} }));
        expect(snapshot.bracketQuinellaCombo).toEqual({});
        expect(hasOwn(snapshot, "bracketQuinellaCombo")).toBe(true);
      });

      it("bracketQuinellaComboのみ設定・他の5券種は未設定のとき、独立して伝播すること(非対称ケース)", () => {
        const snapshot = buildRaceSnapshot(makeComboRaceData({ bracketQuinellaCombo: { "0101": 63.5 } }));
        expect(snapshot.bracketQuinellaCombo).toEqual({ "0101": 63.5 });
        for (const key of [
          "wideCombo",
          "trioCombo",
          "quinellaCombo",
          "exactaCombo",
          "trifectaCombo",
          "comboOdds",
        ]) {
          expect(hasOwn(snapshot, key)).toBe(false);
        }
      });
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
     * 2頭分のRaceHorseDataを明示的に組み立てる(makeRaceData()の既定horsesは使わない)。
     *
     * code-reviewer指摘(2回目): 旧フィクスチャはmakeRaceData()の既定horsesを流用しており、
     * 同一馬内で`umaban`と`wakuban`が同じ値(horse1:1と1/horse2:2と2)のままだった。
     * そのため`wakuban: h.shutuba.umaban`という取り違え変異が検知できず、40件全緑のまま通過した
     * (実際にレビュアーが注入して確認)。
     *
     * 修正: `umaban`自身を含む数値フィールド8個(umaban/wakuban/age/kinryo/bodyWeight/
     * winOdds/popularity/placeOddsMin)・文字列フィールド6個(name/sex/jockeyName/
     * trainerName/oikiriCritic/oikiriRank)を、馬ごとにすべて相異なる値にする
     * (umaban自身も同じSetに含めることで、umaban↔他フィールドの取り違えも検知できるようにする)。
     * 「異なるようにした」という報告だけでは不十分だったため、直後の自己テストで
     * `new Set([...]).size`により実際に相異なることを機械的に固定する
     * (第2段`mixed-candidates.test.ts`の`row()`自己テストと同じ形)。
     */
    function makeTwoDistinctHorsesRaceData(): RaceData {
      return makeRaceData({
        horses: [
          {
            shutuba: {
              wakuban: 4,
              umaban: 1,
              name: "アルファ",
              horseId: "2020100001" as never,
              sex: "牡",
              age: 24,
              kinryo: 57,
              jockeyName: "ジョッキー甲",
              jockeyId: "00001",
              stableLocation: "美浦",
              trainerName: "調教師甲",
              trainerId: "00002",
              bodyWeight: { weight: 480, diff: 2 },
            },
            results: [],
            oikiri: {
              umaban: 1,
              horseId: "2020100001" as never,
              horseName: "アルファ",
              critic: "動き良好",
              rank: "A",
            },
          },
          {
            shutuba: {
              wakuban: 7,
              umaban: 2,
              name: "ブラボー",
              horseId: "2020100002" as never,
              sex: "牝",
              age: 13,
              kinryo: 54,
              jockeyName: "ジョッキー乙",
              jockeyId: "00003",
              stableLocation: "栗東",
              trainerName: "調教師乙",
              trainerId: "00004",
              bodyWeight: { weight: 420, diff: -4 },
            },
            results: [],
            oikiri: {
              umaban: 2,
              horseId: "2020100002" as never,
              horseName: "ブラボー",
              critic: "平凡",
              rank: "B",
            },
          },
        ],
        odds: {
          officialDatetime: "2026-07-24 09:00:00",
          oddsStatus: "result",
          win: { 1: { odds: 2.5, ninki: 9 }, 2: { odds: 8.0, ninki: 6 } },
          place: {
            1: { oddsMin: 1.6, oddsMax: 1.9, ninki: 9 },
            2: { oddsMin: 3.3, oddsMax: 3.9, ninki: 6 },
          },
        },
      });
    }

    describe("makeTwoDistinctHorsesRaceData(テストフィクスチャの自己検証: 「異なるようにした」を機械的に保証する)", () => {
      it("horse1・horse2それぞれで、umabanを含む数値フィールド8個が互いに相異なること(取り違え検知の前提)", () => {
        const snapshot = buildRaceSnapshot(makeTwoDistinctHorsesRaceData());
        const h1 = snapshot.horses.find((h) => h.umaban === 1)!;
        const h2 = snapshot.horses.find((h) => h.umaban === 2)!;

        const h1Numeric = [
          h1.umaban, h1.wakuban, h1.age, h1.kinryo,
          h1.bodyWeight, h1.winOdds, h1.popularity, h1.placeOddsMin,
        ];
        expect(new Set(h1Numeric).size).toBe(8);

        const h2Numeric = [
          h2.umaban, h2.wakuban, h2.age, h2.kinryo,
          h2.bodyWeight, h2.winOdds, h2.popularity, h2.placeOddsMin,
        ];
        expect(new Set(h2Numeric).size).toBe(8);
      });

      it("horse1・horse2それぞれで、文字列フィールド6個が互いに相異なること(取り違え検知の前提)", () => {
        const snapshot = buildRaceSnapshot(makeTwoDistinctHorsesRaceData());
        const h1 = snapshot.horses.find((h) => h.umaban === 1)!;
        const h2 = snapshot.horses.find((h) => h.umaban === 2)!;

        const h1Strings = [h1.name, h1.sex, h1.jockeyName, h1.trainerName, h1.oikiriCritic, h1.oikiriRank];
        expect(new Set(h1Strings).size).toBe(6);

        const h2Strings = [h2.name, h2.sex, h2.jockeyName, h2.trainerName, h2.oikiriCritic, h2.oikiriRank];
        expect(new Set(h2Strings).size).toBe(6);
      });
    });

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
        wakuban: 4,
        name: "アルファ",
        sex: "牡",
        age: 24,
        kinryo: 57,
        jockeyName: "ジョッキー甲",
        jockeyId: "00001", // Issue #526
        trainerName: "調教師甲",
        trainerId: "00002", // Issue #540
        horseId: "2020100001", // Issue #540
        bodyWeight: 480,
        winOdds: 2.5,
        popularity: 9,
        placeOddsMin: 1.6,
        placeOddsMax: 1.9,
        earlyPos: null, // Issue #311: 戦績の通過順位が無いフィクスチャなので null
        latePos: null, // Issue #363: 同上
        legStyle: null, // Issue #314: 同上
        oikiriCritic: "動き良好",
        oikiriRank: "A",
      });
      expect(h2).toEqual({
        umaban: 2,
        wakuban: 7,
        name: "ブラボー",
        sex: "牝",
        age: 13,
        kinryo: 54,
        jockeyName: "ジョッキー乙",
        jockeyId: "00003", // Issue #526: 馬ごとに別の値(取り違えの検知)
        trainerName: "調教師乙",
        trainerId: "00004", // Issue #540: 馬ごとに別の値(取り違えの検知)
        horseId: "2020100002", // Issue #540: 同上
        bodyWeight: 420,
        winOdds: 8.0,
        popularity: 6,
        placeOddsMin: 3.3,
        placeOddsMax: 3.9,
        earlyPos: null, // Issue #311: 戦績の通過順位が無いフィクスチャなので null
        latePos: null, // Issue #363: 同上
        legStyle: null, // Issue #314: 同上
        oikiriCritic: "平凡",
        oikiriRank: "B",
      });
    });
  });
});

/**
 * toSafeRaceSnapshot(防御的復元)。Issue #393 で、旧 `buildAnalysisExportDocument` 経由の間接テスト
 * (破損・旧レコード・組合せオッズの新旧形式・枠連)を、この関数の直接テストへ移した。
 * 旧テストが固定していた点(例外を投げない・欠損はnull・新フィールドをraceへ漏らさない・枠連の有無で復元結果が変わらない)は、
 * 出力 `{ race, horsesByUmaban }` に対して同じ強さで固定する。
 */
describe("toSafeRaceSnapshot(防御的復元。旧レコード・破損データ・新形式)", () => {
  const ALL_NULL_RACE = {
    raceName: null,
    courseType: null,
    distance: null,
    weather: null,
    trackCondition: null,
    startTime: null,
    fence: null,
    oddsStatus: null,
    officialDatetime: null,
  };

  it.each([
    ["null(列追加前の旧レコード)", null],
    ["undefined", undefined],
    ["文字列(オブジェクトでない)", "x"],
    ["数値(オブジェクトでない)", 42],
    ["スキーマ不正なオブジェクト(破損JSON由来)", { unexpected: "shape" }],
  ] as const)("%s は例外を投げず、レース情報は全項目null・馬は0頭になること", (_name, raw) => {
    const safe = toSafeRaceSnapshot(raw);
    expect(safe.race).toEqual(ALL_NULL_RACE);
    expect(Object.keys(safe.race)).toHaveLength(9); // 前提: 全項目を比べている(空のオブジェクトで自明に一致していない)
    expect(safe.horsesByUmaban.size).toBe(0);
    expect(safe.horsesByUmaban.get(1)).toBeUndefined();
  });

  it("組合せオッズのキー自体が無い旧形式でも、あるだけの項目は復元し、無い項目はnullになること", () => {
    // 機能D-2c第3段より前に保存された典型的なraceSnapshot(新フィールドのキー自体が無い)。
    const legacyRaw = {
      race: { raceName: "旧レコードのレース", courseType: "芝", distance: 1600 },
      horses: [{ umaban: 1, name: "旧レコードの馬" }],
    };
    const safe = toSafeRaceSnapshot(legacyRaw);
    expect(safe.race.raceName).toBe("旧レコードのレース");
    expect(safe.race.courseType).toBe("芝");
    expect(safe.race.distance).toBe(1600);
    expect(safe.race.weather).toBeNull(); // 無い項目はnull
    const horse = safe.horsesByUmaban.get(1)!;
    expect(horse.name).toBe("旧レコードの馬");
    expect(horse.jockeyName).toBeNull(); // 無い項目はnull
    expect(horse.oikiriCritic).toBeNull();
  });

  it("wideCombo/comboOddsを持つ新形式のスナップショットでも例外を投げず、馬・レースを復元し、race に新フィールドが漏れないこと", () => {
    const stored = buildRaceSnapshot(
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
    // 前提固定: このスナップショットには実際に新フィールドが載っていること。
    expect(stored.wideCombo).toEqual({ "1-2": 3.4 });
    expect(stored.comboOdds).toBeDefined();

    // 保存時と同じく JSON を経由して復元する。
    const safe = toSafeRaceSnapshot(JSON.parse(JSON.stringify(stored)) as unknown);
    expect(safe.race.raceName).toBe("テストステークス");
    expect(safe.horsesByUmaban.get(1)!.name).toBe("アルファ");
    expect("wideCombo" in safe.race).toBe(false);
    expect("trioCombo" in safe.race).toBe(false);
    expect("comboOdds" in safe.race).toBe(false);
  });

  it("枠連(bracketQuinellaCombo。Issue #148)の有無で、復元されるレース・馬の内容が変わらず、race へ漏れないこと(旧形式=枠連キー無しでも同じ)", () => {
    const baseOdds = {
      officialDatetime: "2026-07-24 09:00:00",
      oddsStatus: "result" as const,
      win: { 1: { odds: 2.5, ninki: 1 } },
      place: { 1: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 } },
    };
    const withBracket = buildRaceSnapshot(
      makeRaceData({ odds: { ...baseOdds, bracketQuinellaCombo: { "0407": 31.5 } } }),
    );
    // 前提固定: このスナップショットには実際に枠連が載っていること。
    expect(withBracket.bracketQuinellaCombo).toEqual({ "0407": 31.5 });
    // 枠連以外は同一のオッズで、枠連キーだけ無い旧形式相当(キー無し)。
    const withoutBracket = buildRaceSnapshot(makeRaceData({ odds: baseOdds }));
    expect(withoutBracket.bracketQuinellaCombo).toBeUndefined();

    const safeWith = toSafeRaceSnapshot(JSON.parse(JSON.stringify(withBracket)) as unknown);
    const safeWithout = toSafeRaceSnapshot(JSON.parse(JSON.stringify(withoutBracket)) as unknown);
    expect(safeWith.race.raceName).toBe("テストステークス");
    expect("bracketQuinellaCombo" in safeWith.race).toBe(false);
    expect(safeWith.race).toEqual(safeWithout.race);
    expect(safeWith.horsesByUmaban.get(1)).toEqual(safeWithout.horsesByUmaban.get(1));
    expect(safeWith.horsesByUmaban.size).toBe(2); // 前提: 馬を比べている(空のMapで自明に一致していない)
  });

  it("馬ごとの素通しの 9 項目(sex・age・kinryo・jockeyName・trainerName・bodyWeight・popularity・oikiriCritic・oikiriRank)は、値が入った入力をそのまま復元し、馬ごとに取り違えない(Issue #433〈#393 のレビューの記録〉)", () => {
    // 項目ごと・馬ごとに値が異なる入力(取り違え・定数を返す実装を殺すため)。保存時と同じく JSON を経由する。
    const stored = {
      race: {},
      horses: [
        { umaban: 1, sex: "牡", age: 4, kinryo: 57, jockeyName: "騎手ア", trainerName: "調教師ア", bodyWeight: 480, popularity: 3, oikiriCritic: "動き良好", oikiriRank: "A" },
        { umaban: 2, sex: "牝", age: 3, kinryo: 54.5, jockeyName: "騎手イ", trainerName: "調教師イ", bodyWeight: 452, popularity: 11, oikiriCritic: "平凡", oikiriRank: "C" },
      ],
    };
    const safe = toSafeRaceSnapshot(JSON.parse(JSON.stringify(stored)) as unknown);
    expect(safe.horsesByUmaban.size).toBe(2); // 前提: 2 頭を復元している
    const pick = (umaban: number) => {
      const h = safe.horsesByUmaban.get(umaban)!;
      return { sex: h.sex, age: h.age, kinryo: h.kinryo, jockeyName: h.jockeyName, trainerName: h.trainerName, bodyWeight: h.bodyWeight, popularity: h.popularity, oikiriCritic: h.oikiriCritic, oikiriRank: h.oikiriRank };
    };
    expect(Object.keys(pick(1))).toHaveLength(9); // 前提: 9 項目を全て比べている
    expect(pick(1)).toEqual({ sex: "牡", age: 4, kinryo: 57, jockeyName: "騎手ア", trainerName: "調教師ア", bodyWeight: 480, popularity: 3, oikiriCritic: "動き良好", oikiriRank: "A" });
    expect(pick(2)).toEqual({ sex: "牝", age: 3, kinryo: 54.5, jockeyName: "騎手イ", trainerName: "調教師イ", bodyWeight: 452, popularity: 11, oikiriCritic: "平凡", oikiriRank: "C" });
  });

  it("buildRaceSnapshot が書いた値は、toSafeRaceSnapshot で往復して同じ 9 項目になる(書く側と読む側のキー名が揃っている)", () => {
    const safe = toSafeRaceSnapshot(JSON.parse(JSON.stringify(buildRaceSnapshot(makeRaceData()))) as unknown);
    const h1 = safe.horsesByUmaban.get(1)!;
    expect({ sex: h1.sex, age: h1.age, kinryo: h1.kinryo, jockeyName: h1.jockeyName, trainerName: h1.trainerName, bodyWeight: h1.bodyWeight, popularity: h1.popularity, oikiriCritic: h1.oikiriCritic, oikiriRank: h1.oikiriRank }).toEqual({
      sex: "牡", age: 4, kinryo: 57, jockeyName: "テスト騎手", trainerName: "テスト調教師", bodyWeight: 480, popularity: 1, oikiriCritic: "動き良好", oikiriRank: "A",
    });
    const h2 = safe.horsesByUmaban.get(2)!;
    expect({ sex: h2.sex, age: h2.age, kinryo: h2.kinryo, jockeyName: h2.jockeyName, trainerName: h2.trainerName, bodyWeight: h2.bodyWeight, popularity: h2.popularity, oikiriCritic: h2.oikiriCritic, oikiriRank: h2.oikiriRank }).toEqual({
      sex: "牝", age: 3, kinryo: 54, jockeyName: "テスト騎手2", trainerName: "テスト調教師2", bodyWeight: null, popularity: 4, oikiriCritic: null, oikiriRank: null,
    });
  });

  it("馬の配列に、オブジェクトでない要素・umabanが数値でない要素が混ざっていても、それらを飛ばして残りを復元すること", () => {
    const safe = toSafeRaceSnapshot({
      race: {},
      horses: [null, "x", { umaban: "3", name: "文字列の馬番" }, { name: "馬番なし" }, { umaban: 5, name: "有効な馬" }],
    });
    expect([...safe.horsesByUmaban.keys()]).toEqual([5]);
    expect(safe.horsesByUmaban.get(5)!.name).toBe("有効な馬");
  });
});
