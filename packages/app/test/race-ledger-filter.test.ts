import { describe, expect, it } from "vitest";

import type { RaceLedgerView } from "../src/shared/analysis-types.js";
import {
  distinctVenueNames,
  EMPTY_RACE_LEDGER_FILTER,
  filterRaceLedger,
  type RaceLedgerFilter,
} from "../src/renderer/race-ledger-filter.js";

/** テスト用のRaceLedgerViewを最小構成で組み立てる(結果未取込・馬なし)。 */
function view(overrides: Partial<RaceLedgerView> = {}): RaceLedgerView {
  return {
    raceId: "202605020801",
    venueName: "東京",
    raceNumber: 1,
    kaisaiDate: "20260705",
    analysisId: 1,
    analyzedAt: "2026-07-05T10:00:00.000Z",
    promptVersion: "2026-07-14.1",
    hasResult: false,
    hasPayout: false,
    horses: [],
    totalStake: 0,
    totalReturn: 0,
    recoveryRate: null,
    betCount: 0,
    ...overrides,
  };
}

describe("filterRaceLedger(検証画面: レース一覧の絞り込み。表示のみに効く純関数)", () => {
  describe("空条件・基本", () => {
    it("EMPTY_RACE_LEDGER_FILTER(絞り込み条件なし)は全件そのまま返すこと", () => {
      const entries = [
        view({ raceId: "202605020801" }),
        view({ raceId: "202605020802", kaisaiDate: null }),
      ];
      expect(filterRaceLedger(entries, EMPTY_RACE_LEDGER_FILTER)).toEqual(entries);
    });

    it("空配列を渡せば空配列を返すこと", () => {
      expect(filterRaceLedger([], EMPTY_RACE_LEDGER_FILTER)).toEqual([]);
    });

    it("該当なしの場合は空配列を返すこと", () => {
      const entries = [view({ venueName: "東京" })];
      const filter: RaceLedgerFilter = {
        ...EMPTY_RACE_LEDGER_FILTER,
        keyword: "存在しないキーワード",
      };
      expect(filterRaceLedger(entries, filter)).toEqual([]);
    });

    it("入力配列を破壊しないこと(新しい配列を返す)", () => {
      const entries = [view({ raceId: "202605020801" })];
      const result = filterRaceLedger(entries, EMPTY_RACE_LEDGER_FILTER);
      expect(result).not.toBe(entries);
      expect(entries).toHaveLength(1);
    });
  });

  describe("日付・期間(開催日不明=kaisaiDate nullの扱い)", () => {
    const known1 = view({ raceId: "202605020801", kaisaiDate: "20260701" });
    const known2 = view({ raceId: "202605020802", kaisaiDate: "20260710" });
    const known3 = view({ raceId: "202605020803", kaisaiDate: "20260720" });
    const unknown = view({ raceId: "202605020804", kaisaiDate: null });
    const entries = [known1, known2, known3, unknown];

    it("期間未指定(from/toともnull)なら開催日不明を含めて全件通すこと", () => {
      const result = filterRaceLedger(entries, EMPTY_RACE_LEDGER_FILTER);
      expect(result).toEqual(entries);
    });

    it("fromのみ指定: from以降(境界含む)のみ通し、開催日不明は除外すること", () => {
      const filter: RaceLedgerFilter = {
        ...EMPTY_RACE_LEDGER_FILTER,
        dateFrom: "20260710",
      };
      const result = filterRaceLedger(entries, filter);
      expect(result.map((v) => v.raceId)).toEqual(["202605020802", "202605020803"]);
    });

    it("toのみ指定: to以前(境界含む)のみ通し、開催日不明は除外すること", () => {
      const filter: RaceLedgerFilter = {
        ...EMPTY_RACE_LEDGER_FILTER,
        dateTo: "20260710",
      };
      const result = filterRaceLedger(entries, filter);
      expect(result.map((v) => v.raceId)).toEqual(["202605020801", "202605020802"]);
    });

    it("from/to両方指定: 境界値(from当日・to当日)を含み範囲外は除外し、開催日不明も除外すること", () => {
      const filter: RaceLedgerFilter = {
        ...EMPTY_RACE_LEDGER_FILTER,
        dateFrom: "20260701",
        dateTo: "20260710",
      };
      const result = filterRaceLedger(entries, filter);
      expect(result.map((v) => v.raceId)).toEqual(["202605020801", "202605020802"]);
    });

    it("範囲外(from>対象日)は除外すること", () => {
      const filter: RaceLedgerFilter = {
        ...EMPTY_RACE_LEDGER_FILTER,
        dateFrom: "20260702",
        dateTo: "20260709",
      };
      const result = filterRaceLedger(entries, filter);
      expect(result).toEqual([]);
    });
  });

  describe("会場(中央/地方の別)", () => {
    // 中央: 場コード05→東京。地方: 場コード54→高知。
    const central = view({ raceId: "202605020801", venueName: "東京" });
    const nar = view({ raceId: "202654071210", venueName: "高知" });
    const entries = [central, nar];

    it("venueKind=all(既定)は中央・地方とも通すこと", () => {
      expect(filterRaceLedger(entries, EMPTY_RACE_LEDGER_FILTER)).toEqual(entries);
    });

    it("venueKind=centralは中央のみ通すこと", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, venueKind: "central" };
      expect(filterRaceLedger(entries, filter)).toEqual([central]);
    });

    it("venueKind=narは地方のみ通すこと", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, venueKind: "nar" };
      expect(filterRaceLedger(entries, filter)).toEqual([nar]);
    });
  });

  describe("会場(競馬場名。ドロップダウン選択想定の完全一致)", () => {
    const tokyo = view({ raceId: "202605020801", venueName: "東京" });
    const nakayama = view({ raceId: "202606020801", venueName: "中山" });
    const entries = [tokyo, nakayama];

    it("venueName=nullは絞り込みなし(全件通す)こと", () => {
      expect(filterRaceLedger(entries, EMPTY_RACE_LEDGER_FILTER)).toEqual(entries);
    });

    it("venueNameを指定すると完全一致する会場のみ通すこと", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, venueName: "東京" };
      expect(filterRaceLedger(entries, filter)).toEqual([tokyo]);
    });

    it("一致する会場が無ければ空配列を返すこと", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, venueName: "京都" };
      expect(filterRaceLedger(entries, filter)).toEqual([]);
    });
  });

  describe("レースID/会場名のキーワード部分一致", () => {
    const race1 = view({ raceId: "202605020811", venueName: "東京" });
    const race2 = view({ raceId: "202654071210", venueName: "高知" });
    const entries = [race1, race2];

    it("空文字列(既定)は絞り込みなし(全件通す)こと", () => {
      expect(filterRaceLedger(entries, EMPTY_RACE_LEDGER_FILTER)).toEqual(entries);
    });

    it("前後の空白のみのキーワードは絞り込みなし扱いにすること", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, keyword: "   " };
      expect(filterRaceLedger(entries, filter)).toEqual(entries);
    });

    it("raceIdの部分一致で絞り込むこと", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, keyword: "0208" };
      expect(filterRaceLedger(entries, filter)).toEqual([race1]);
    });

    it("会場名の部分一致で絞り込むこと", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, keyword: "高" };
      expect(filterRaceLedger(entries, filter)).toEqual([race2]);
    });

    it("前後の空白をトリムして一致判定すること", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, keyword: "  東京  " };
      expect(filterRaceLedger(entries, filter)).toEqual([race1]);
    });

    it("大文字小文字を無視して一致判定すること", () => {
      const alpha = view({ raceId: "202605020899", venueName: "TOKYO" });
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, keyword: "tokyo" };
      expect(filterRaceLedger([alpha], filter)).toEqual([alpha]);
    });

    it("該当しないキーワードは空配列を返すこと", () => {
      const filter: RaceLedgerFilter = { ...EMPTY_RACE_LEDGER_FILTER, keyword: "存在しない" };
      expect(filterRaceLedger(entries, filter)).toEqual([]);
    });
  });

  describe("複数条件のAND", () => {
    it("日付・会場区分・キーワードをすべて満たすエントリのみ通すこと", () => {
      const target = view({
        raceId: "202605020811",
        venueName: "東京",
        kaisaiDate: "20260705",
      });
      const wrongDate = view({
        raceId: "202605020812",
        venueName: "東京",
        kaisaiDate: "20260601",
      });
      const wrongVenueKind = view({
        raceId: "202654071210",
        venueName: "高知",
        kaisaiDate: "20260705",
      });
      const wrongKeyword = view({
        raceId: "202606020811",
        venueName: "中山",
        kaisaiDate: "20260705",
      });
      const entries = [target, wrongDate, wrongVenueKind, wrongKeyword];
      const filter: RaceLedgerFilter = {
        dateFrom: "20260701",
        dateTo: "20260710",
        venueKind: "central",
        venueName: null,
        keyword: "東京",
      };
      expect(filterRaceLedger(entries, filter)).toEqual([target]);
    });
  });
});

describe("distinctVenueNames(レース一覧に登場する会場名の重複なし一覧)", () => {
  it("重複を除いた会場名を五十音順で返すこと", () => {
    const entries = [
      view({ venueName: "東京" }),
      view({ venueName: "中山" }),
      view({ venueName: "東京" }),
    ];
    expect(distinctVenueNames(entries)).toEqual(["中山", "東京"]);
  });

  it("空配列を渡せば空配列を返すこと", () => {
    expect(distinctVenueNames([])).toEqual([]);
  });
});
