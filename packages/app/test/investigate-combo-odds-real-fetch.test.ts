/**
 * scripts/investigate-combo-odds-real-fetch.ts の buildRaceRecord(純関数)の回帰テスト
 * (機能D-2c計測スクリプト・code-reviewer指摘修正3)。
 *
 * `buildRaceRecord`は「IO・ネットワークを一切行わない純関数」と明記され、ライブ取得経路
 * (`runLiveFetch`)と再生成経路(`runRegenerateFromSaved`。`--from-saved`)の両方から
 * 呼ばれる設計だが、テストが無く「保存済みJSONから決定論的に再生成できる」という`ba32b43`の
 * 主張がテストで守られていなかった。小さな合成フィクスチャを入力に、最低限
 * numericConflictCount/nullWinConflictCount/conflictSamples(修正2で追加した転記)が
 * 正しく転記されることを固定する。
 *
 * scripts/ は @keiba/app のワークスペースパッケージではないため、パッケージ内の test/ から
 * 相対パスで直接importする(main()はモジュールのエントリポイントガードにより、importだけでは
 * 発火しない。実行時にネットワークへ出ないことは、このテストがオフラインで通ることで裏付ける)。
 */

import { describe, expect, it } from "vitest";
import { parseRaceId, type ComboOddsFetchOutcome, type RaceData } from "@keiba/core";

import { buildRaceRecord } from "../../../scripts/investigate-combo-odds-real-fetch.js";

/** テスト用の最小 RaceData を組み立てる(analysis-export.test.ts の makeRaceData と同型)。 */
function makeRaceData(overrides: Partial<RaceData> = {}): RaceData {
  return {
    raceId: parseRaceId("202603020211"),
    race: {
      raceName: "テストステークス",
      courseType: "芝",
      distance: 1600,
      startTime: "15:35",
      weather: "晴",
      trackCondition: "良",
      fence: "A",
    },
    horses: [],
    odds: {
      officialDatetime: "2026-07-24 09:00:00",
      oddsStatus: "result",
      win: {},
      place: {},
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
 * 地方3連複の軸間衝突(numeric 2件・nullWin 1件)を含む ComboOddsFetchOutcome を組み立てる。
 * `nar-on.json` の実測(いずれも0件)とは異なる値を意図的に使い、「0だから何もしていない」
 * ではなく実際に転記されていることを固定する(0件のフィクスチャだけでは転記漏れがあっても
 * テストが偶然通ってしまう空振りになるため)。
 */
function makeTrioOutcomeWithConflicts(): ComboOddsFetchOutcome {
  return {
    state: "available",
    diagnostics: {
      betType: "trio",
      requestCount: 10,
      expectedComboCount: 220,
      obtainedComboCount: 220,
      missingComboCount: 0,
      axisUmabans: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      attempts: [],
      numericConflictCount: 2,
      nullWinConflictCount: 1,
      conflictSamples: [
        {
          key: "010203",
          kind: "numeric",
          entries: [
            { axis: 1, cell: { oddsMin: 10.5, oddsMax: null, ninki: null } },
            { axis: 2, cell: { oddsMin: 12.1, oddsMax: null, ninki: null } },
          ],
        },
      ],
    },
  };
}

describe("buildRaceRecord(まとめ1レコードの組み立て・純関数の回帰)", () => {
  it("軸間衝突の実測値(numericConflictCount/nullWinConflictCount/conflictSamples)をcomboOdds.trioへ転記すること", () => {
    const offRace = makeRaceData();
    const onRace = makeRaceData({
      meta: {
        fetchedAt: "2026-07-24T09:00:00.000Z",
        oddsFetchedAt: "2026-07-24T09:00:00.000Z",
        warnings: [],
        comboOdds: { trio: makeTrioOutcomeWithConflicts() },
      },
      odds: {
        officialDatetime: "2026-07-24 09:00:00",
        oddsStatus: "result",
        win: {},
        place: {},
        trioCombo: { "010203": 10.5 },
      },
    });

    const record = buildRaceRecord(
      { label: "central", raceId: parseRaceId("202603020211") },
      offRace,
      onRace,
      { offColdMs: 27608, onWarmReuseMs: 3466 },
    );

    const comboOdds = record.comboOdds as {
      trio: {
        numericConflictCount: number;
        nullWinConflictCount: number;
        conflictSamples: unknown[];
      } | null;
    };
    // 前提固定: trio診断値そのものが欠落していないこと(空振り防止)。
    expect(comboOdds.trio).not.toBeNull();
    expect(comboOdds.trio!.numericConflictCount).toBe(2);
    expect(comboOdds.trio!.nullWinConflictCount).toBe(1);
    expect(comboOdds.trio!.conflictSamples).toEqual([
      {
        key: "010203",
        kind: "numeric",
        entries: [
          { axis: 1, cell: { oddsMin: 10.5, oddsMax: null, ninki: null } },
          { axis: 2, cell: { oddsMin: 12.1, oddsMax: null, ninki: null } },
        ],
      },
    ]);
  });

  it("組合せオッズ取得結果が無い(undefined)場合はcomboOdds.wide/trioをnullにすること(既存の写すだけ挙動の維持)", () => {
    const offRace = makeRaceData();
    const onRace = makeRaceData();

    const record = buildRaceRecord(
      { label: "nar", raceId: parseRaceId("202654071210") },
      offRace,
      onRace,
      { offColdMs: 24049, onWarmReuseMs: 15803 },
    );

    const comboOdds = record.comboOdds as { wide: unknown; trio: unknown };
    expect(comboOdds.wide).toBeNull();
    expect(comboOdds.trio).toBeNull();
  });

  it("IO・ネットワークを行わない純関数であること(同一入力を2回渡しても同じ結果になること)", () => {
    const offRace = makeRaceData();
    const onRace = makeRaceData({
      meta: {
        fetchedAt: "2026-07-24T09:00:00.000Z",
        oddsFetchedAt: "2026-07-24T09:00:00.000Z",
        warnings: [],
        comboOdds: { trio: makeTrioOutcomeWithConflicts() },
      },
    });
    const target = { label: "central", raceId: parseRaceId("202603020211") };
    const timing = { offColdMs: 100, onWarmReuseMs: 50 };

    const first = buildRaceRecord(target, offRace, onRace, timing);
    const second = buildRaceRecord(target, offRace, onRace, timing);

    expect(second).toEqual(first);
  });
});
