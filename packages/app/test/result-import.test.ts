import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AnalysisStore,
  parseRaceId,
  parseRaceResult,
  RaceResultNotConfirmedError,
  RaceResultParseError,
  type RaceResult,
} from "@keiba/core";
import {
  importRaceResult,
  summarizeImport,
  toResultEntries,
} from "../src/main/result-import.js";

/** 実フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)),
    "utf-8",
  );
}

/** テスト用のレース結果を最小構成で組み立てる。 */
function buildRaceResult(overrides: Partial<RaceResult> = {}): RaceResult {
  return {
    horses: [
      {
        umaban: 4,
        finishPosition: { kind: "順位", value: 1 },
        horseName: "A",
        wakuban: null,
        passing: [],
        last3f: null,
      },
      {
        umaban: 2,
        finishPosition: { kind: "順位", value: 2 },
        horseName: "B",
        wakuban: null,
        passing: [],
        last3f: null,
      },
      {
        umaban: 9,
        finishPosition: { kind: "順位", value: 3 },
        horseName: "C",
        wakuban: null,
        passing: [],
        last3f: null,
      },
      {
        umaban: 5,
        finishPosition: { kind: "非数値", text: "中止" },
        horseName: "D",
        wakuban: null,
        passing: [],
        last3f: null,
      },
    ],
    placePayouts: [
      { umaban: 4, payout: 210 },
      { umaban: 2, payout: 170 },
      { umaban: 9, payout: 1060 },
    ],
    winPayouts: [{ umaban: 4, payout: 670 }],
    ...overrides,
  };
}

describe("toResultEntries(結果→保存レコード変換)", () => {
  it("着順を数値化し、複勝圏内の馬に確定払戻を対応付けること", () => {
    const entries = toResultEntries(buildRaceResult());
    const byUmaban = new Map(entries.map((e) => [e.umaban, e]));
    expect(byUmaban.get(4)).toEqual({
      umaban: 4,
      finishPosition: 1,
      placePayout: 210,
      winPayout: 670,
      passing: [],
      last3f: null,
    });
    expect(byUmaban.get(9)).toEqual({
      umaban: 9,
      finishPosition: 3,
      placePayout: 1060,
      winPayout: null,
      passing: [],
      last3f: null,
    });
  });

  it("各馬の通過順・上がり3F(タスク#27-A2)をそのまま保存レコードへ詰めること", () => {
    const entries = toResultEntries(
      buildRaceResult({
        horses: [
          {
            umaban: 4,
            finishPosition: { kind: "順位", value: 1 },
            horseName: "A",
            wakuban: 4,
            passing: [2, 2, 4, 2],
            last3f: 37.2,
          },
        ],
      }),
    );
    expect(entries[0]).toEqual({
      umaban: 4,
      finishPosition: 1,
      placePayout: 210,
      winPayout: 670,
      passing: [2, 2, 4, 2],
      last3f: 37.2,
    });
  });

  it("非数値着順(中止など)は finishPosition=null にすること", () => {
    const entries = toResultEntries(buildRaceResult());
    const d = entries.find((e) => e.umaban === 5)!;
    expect(d.finishPosition).toBeNull();
  });

  it("複勝払戻の無い馬は placePayout=null にすること", () => {
    const entries = toResultEntries(buildRaceResult());
    const d = entries.find((e) => e.umaban === 5)!;
    expect(d.placePayout).toBeNull();
  });

  // Issue #100(#23-C): winPayoutもplacePayoutと同じ対応付けロジック(payoutByUmaban)で
  // 詰められることを固定する。
  it("単勝払戻の無い馬は winPayout=null にすること", () => {
    const entries = toResultEntries(buildRaceResult());
    const d = entries.find((e) => e.umaban === 5)!;
    expect(d.winPayout).toBeNull();
  });

  it("単勝払戻のある馬(1着)には確定払戻を対応付けること", () => {
    const entries = toResultEntries(buildRaceResult());
    const a = entries.find((e) => e.umaban === 4)!;
    expect(a.winPayout).toBe(670);
  });

  // AC1(1着同着): winPayouts.length>=2 の実経路(toResultEntries経由)テスト。
  // boss裁定A: winPayouts[0]だけを拾う・単一値で持つ等の実装欠陥はtoResultEntries内にしか
  // 存在しないため、RaceResultEntry[]を手で組み立てるのではなくRaceResultを合成して
  // toResultEntriesに通す(実経路を通す)。
  it("単勝の1着同着(winPayouts.length>=2)でも、対象馬それぞれの払戻額が対応付けられること", () => {
    const entries = toResultEntries(
      buildRaceResult({
        winPayouts: [
          { umaban: 4, payout: 670 },
          { umaban: 2, payout: 340 },
        ],
      }),
    );
    const byUmaban = new Map(entries.map((e) => [e.umaban, e.winPayout]));
    // 両方とも非null、かつ「片方だけ拾う」「同額を複製する」実装を落とせるよう別額で固定する。
    expect(byUmaban.get(4)).toBe(670);
    expect(byUmaban.get(2)).toBe(340);
  });

  it("降着(demoted)でも確定着順(value)を採用すること", () => {
    const entries = toResultEntries(
      buildRaceResult({
        horses: [
          {
            umaban: 1,
            finishPosition: { kind: "順位", value: 5, demoted: true },
            horseName: "X",
            wakuban: null,
            passing: [],
            last3f: null,
          },
        ],
        placePayouts: [],
        winPayouts: [],
      }),
    );
    expect(entries[0]!.finishPosition).toBe(5);
  });
});

describe("summarizeImport(取込サマリ)", () => {
  it("頭数・複勝払戻点数・払戻有無を集計し、status='imported' で返すこと", () => {
    const outcome = summarizeImport("202602010607", buildRaceResult());
    expect(outcome).toEqual({
      status: "imported",
      raceId: "202602010607",
      horseCount: 4,
      placePayoutCount: 3,
      hasPayout: true,
    });
  });

  it("払戻テーブルが無い(着順のみ確定)場合は hasPayout=false になること", () => {
    const outcome = summarizeImport(
      "202602010607",
      buildRaceResult({ placePayouts: [], winPayouts: [] }),
    );
    expect(outcome.status).toBe("imported");
    if (outcome.status !== "imported") {
      throw new Error("unreachable");
    }
    expect(outcome.hasPayout).toBe(false);
    expect(outcome.placePayoutCount).toBe(0);
  });
});

describe("importRaceResult(取込フロー: 取得→パース→保存)", () => {
  const raceId = parseRaceId("202602010607");

  it("常にライブ取得する(bypassCache: true でフェッチする)", async () => {
    const fetchText = vi.fn().mockResolvedValue("<html>ok</html>");
    const saveResult = vi.fn();
    await importRaceResult(raceId, {
      fetchText,
      parse: () => buildRaceResult(),
      saveResult,
    });
    expect(fetchText).toHaveBeenCalledTimes(1);
    const [url, options] = fetchText.mock.calls[0]!;
    expect(url).toBe(
      "https://race.netkeiba.com/race/result.html?race_id=202602010607",
    );
    expect(options).toMatchObject({ bypassCache: true });
  });

  it("パース成功時は結果を保存し取込サマリを返す", async () => {
    const saveResult = vi.fn();
    const outcome = await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
      parse: () => buildRaceResult(),
      saveResult,
    });
    expect(saveResult).toHaveBeenCalledTimes(1);
    const [savedRaceId, entries] = saveResult.mock.calls[0]!;
    expect(savedRaceId).toBe(raceId);
    expect(entries).toEqual(toResultEntries(buildRaceResult()));
    expect(outcome).toEqual({
      status: "imported",
      raceId: "202602010607",
      horseCount: 4,
      placePayoutCount: 3,
      hasPayout: true,
    });
  });

  it("パース結果の面(courseType、タスク#27-A2)を saveResult の第3引数へそのまま渡すこと", async () => {
    const saveResult = vi.fn();
    await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
      parse: () => buildRaceResult({ courseType: "ダ" }),
      saveResult,
    });
    expect(saveResult).toHaveBeenCalledTimes(1);
    const [, , courseType] = saveResult.mock.calls[0]!;
    expect(courseType).toBe("ダ");
  });

  it("パース結果に面(courseType)が無い(未解決)場合は saveResult の第3引数に undefined を渡すこと", async () => {
    const saveResult = vi.fn();
    await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
      parse: () => buildRaceResult(),
      saveResult,
    });
    const [, , courseType] = saveResult.mock.calls[0]!;
    expect(courseType).toBeUndefined();
  });

  describe("組合せ払戻(ワイド・3連複、Issue #52)の素通し(boss裁定R-7・R-10)", () => {
    it("パース結果のwidePayouts/trioPayoutsを、saveResultの第4引数へそのまま(判断を挟まず)渡すこと", async () => {
      const saveResult = vi.fn();
      const wide: RaceResult["widePayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [2, 4], payout: 190 }],
      };
      const trio: RaceResult["trioPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [1, 2, 4], payout: 2210 }],
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult({ widePayouts: wide, trioPayouts: trio }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({ wide, trio });
    });

    it("ワイドが state:'undetermined'(構造異常)のときも、判断を挟まずそのままsaveResultの第4引数へ渡り、着順・複勝は通常どおり保存されること", async () => {
      const saveResult = vi.fn();
      const undeterminedWide: RaceResult["widePayouts"] = {
        state: "undetermined",
        reason: {
          kind: "groupCountMismatch",
          message: "テスト用",
          observedGroupCount: 2,
          observedPayoutCount: 1,
          rawHtml: null,
        },
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult({ widePayouts: undeterminedWide }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [savedRaceId, entries, , comboPayouts] = saveResult.mock.calls[0]!;
      // 巻き添え無し: 着順(→entries)は通常どおり保存される。
      expect(savedRaceId).toBe(raceId);
      expect(entries).toEqual(toResultEntries(buildRaceResult()));
      // ワイドの undetermined がそのまま渡っている(呼び出し側〈result-import.ts〉が
      // これを空配列に変換したり握りつぶしたりしていないこと)。
      expect(comboPayouts).toEqual({
        wide: undeterminedWide,
        trio: undefined,
      });
    });

    it("パース結果にwidePayouts/trioPayoutsが無い(未設定)場合は、saveResultの第4引数もundefinedのままになること", async () => {
      const saveResult = vi.fn();
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult(), // widePayouts/trioPayouts省略
        saveResult,
      });
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({ wide: undefined, trio: undefined });
    });
  });

  describe("組合せ払戻(馬連、Issue #114・#24-F1)の素通し(#52のR-7・R-10をquinellaにも適用)", () => {
    it("パース結果のquinellaPayoutsを、wide/trioと同時にsaveResultの第4引数へそのまま(判断を挟まず)渡すこと(AC-2)", async () => {
      const saveResult = vi.fn();
      const wide: RaceResult["widePayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [2, 4], payout: 190 }],
      };
      const trio: RaceResult["trioPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [1, 2, 4], payout: 2210 }],
      };
      const quinella: RaceResult["quinellaPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [8, 13], payout: 4550 }],
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () =>
          buildRaceResult({ widePayouts: wide, trioPayouts: trio, quinellaPayouts: quinella }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({ wide, trio, quinella });
    });

    it("馬連がstate:'undetermined'(構造異常)のときも、判断を挟まずそのままsaveResultの第4引数へ渡り、着順・複勝は通常どおり保存されること", async () => {
      const saveResult = vi.fn();
      const undeterminedQuinella: RaceResult["quinellaPayouts"] = {
        state: "undetermined",
        reason: {
          kind: "payoutTableAbsent",
          message: "テスト用",
          observedGroupCount: null,
          observedPayoutCount: null,
          rawHtml: null,
        },
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult({ quinellaPayouts: undeterminedQuinella }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [savedRaceId, entries, , comboPayouts] = saveResult.mock.calls[0]!;
      // 巻き添え無し: 着順(→entries)は通常どおり保存される。
      expect(savedRaceId).toBe(raceId);
      expect(entries).toEqual(toResultEntries(buildRaceResult()));
      expect(comboPayouts).toEqual({
        wide: undefined,
        trio: undefined,
        quinella: undeterminedQuinella,
      });
    });

    it("パース結果にquinellaPayoutsが無い(未設定)場合は、saveResultの第4引数もundefinedのままになること", async () => {
      const saveResult = vi.fn();
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult(), // quinellaPayouts省略
        saveResult,
      });
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({ wide: undefined, trio: undefined, quinella: undefined });
    });
  });

  describe("組合せ払戻(馬単、Issue #121・#24-F2)の素通し(#52のR-7・R-10をexactaにも適用)", () => {
    it("パース結果のexactaPayoutsを、wide/trio/quinellaと同時にsaveResultの第4引数へそのまま(判断を挟まず)渡すこと(AC-3)", async () => {
      const saveResult = vi.fn();
      const wide: RaceResult["widePayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [2, 4], payout: 190 }],
      };
      const trio: RaceResult["trioPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [1, 2, 4], payout: 2210 }],
      };
      const quinella: RaceResult["quinellaPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [8, 13], payout: 4550 }],
      };
      // 馬単は着順どおりの並び([13, 8])のまま渡ってくる(ソートしない。AC-3の要)。
      const exacta: RaceResult["exactaPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [13, 8], payout: 8360 }],
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () =>
          buildRaceResult({
            widePayouts: wide,
            trioPayouts: trio,
            quinellaPayouts: quinella,
            exactaPayouts: exacta,
          }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({ wide, trio, quinella, exacta });
      // ★空振り防止: 並びが昇順化されていないこと(渡された[13, 8]のまま)を直接固定する。
      expect(comboPayouts.exacta.payouts[0].umabans).toEqual([13, 8]);
      expect(comboPayouts.exacta.payouts[0].umabans).not.toEqual([8, 13]);
    });

    it("馬単がstate:'undetermined'(構造異常)のときも、判断を挟まずそのままsaveResultの第4引数へ渡り、着順・複勝は通常どおり保存されること", async () => {
      const saveResult = vi.fn();
      const undeterminedExacta: RaceResult["exactaPayouts"] = {
        state: "undetermined",
        reason: {
          kind: "payoutTableAbsent",
          message: "テスト用",
          observedGroupCount: null,
          observedPayoutCount: null,
          rawHtml: null,
        },
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult({ exactaPayouts: undeterminedExacta }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [savedRaceId, entries, , comboPayouts] = saveResult.mock.calls[0]!;
      // 巻き添え無し: 着順(→entries)は通常どおり保存される。
      expect(savedRaceId).toBe(raceId);
      expect(entries).toEqual(toResultEntries(buildRaceResult()));
      expect(comboPayouts).toEqual({
        wide: undefined,
        trio: undefined,
        quinella: undefined,
        exacta: undeterminedExacta,
      });
    });

    it("パース結果にexactaPayoutsが無い(未設定)場合は、saveResultの第4引数もundefinedのままになること", async () => {
      const saveResult = vi.fn();
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult(), // exactaPayouts省略
        saveResult,
      });
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({
        wide: undefined,
        trio: undefined,
        quinella: undefined,
        exacta: undefined,
      });
    });
  });

  describe("組合せ払戻(三連単、Issue #131・#25-F)の素通し(#52のR-7・R-10をtrifectaにも適用)", () => {
    it("パース結果のtrifectaPayoutsを、wide/trio/quinella/exactaと同時にsaveResultの第4引数へそのまま(判断を挟まず)渡すこと(AC-3)", async () => {
      const saveResult = vi.fn();
      const wide: RaceResult["widePayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [2, 4], payout: 190 }],
      };
      const trio: RaceResult["trioPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [1, 2, 4], payout: 2210 }],
      };
      const quinella: RaceResult["quinellaPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [8, 13], payout: 4550 }],
      };
      const exacta: RaceResult["exactaPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [13, 8], payout: 8360 }],
      };
      // 三連単は着順どおりの並び([13, 8, 5])のまま渡ってくる(ソートしない。AC-3の要)。
      const trifecta: RaceResult["trifectaPayouts"] = {
        state: "parsed",
        payouts: [{ umabans: [13, 8, 5], payout: 52690 }],
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () =>
          buildRaceResult({
            widePayouts: wide,
            trioPayouts: trio,
            quinellaPayouts: quinella,
            exactaPayouts: exacta,
            trifectaPayouts: trifecta,
          }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({ wide, trio, quinella, exacta, trifecta });
      // ★空振り防止: 並びが昇順化されていないこと(渡された[13, 8, 5]のまま)を直接固定する。
      expect(comboPayouts.trifecta.payouts[0].umabans).toEqual([13, 8, 5]);
      expect(comboPayouts.trifecta.payouts[0].umabans).not.toEqual([5, 8, 13]);
    });

    it("三連単がstate:'undetermined'(構造異常)のときも、判断を挟まずそのままsaveResultの第4引数へ渡り、着順・複勝は通常どおり保存されること", async () => {
      const saveResult = vi.fn();
      const undeterminedTrifecta: RaceResult["trifectaPayouts"] = {
        state: "undetermined",
        reason: {
          kind: "payoutTableAbsent",
          message: "テスト用",
          observedGroupCount: null,
          observedPayoutCount: null,
          rawHtml: null,
        },
      };
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult({ trifectaPayouts: undeterminedTrifecta }),
        saveResult,
      });
      expect(saveResult).toHaveBeenCalledTimes(1);
      const [savedRaceId, entries, , comboPayouts] = saveResult.mock.calls[0]!;
      // 巻き添え無し: 着順(→entries)は通常どおり保存される。
      expect(savedRaceId).toBe(raceId);
      expect(entries).toEqual(toResultEntries(buildRaceResult()));
      expect(comboPayouts).toEqual({
        wide: undefined,
        trio: undefined,
        quinella: undefined,
        exacta: undefined,
        trifecta: undeterminedTrifecta,
      });
    });

    it("パース結果にtrifectaPayoutsが無い(未設定)場合は、saveResultの第4引数もundefinedのままになること", async () => {
      const saveResult = vi.fn();
      await importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
        parse: () => buildRaceResult(), // trifectaPayouts省略
        saveResult,
      });
      const [, , , comboPayouts] = saveResult.mock.calls[0]!;
      expect(comboPayouts).toEqual({
        wide: undefined,
        trio: undefined,
        quinella: undefined,
        exacta: undefined,
        trifecta: undefined,
      });
    });
  });

  it("結果テーブル欠落(構造異常のパース失敗)時は保存せずエラーを伝播する(DBを汚さない)", async () => {
    const saveResult = vi.fn();
    await expect(
      importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>構造異常</html>"),
        parse: () => {
          throw new RaceResultParseError("結果テーブルが見つかりませんでした");
        },
        saveResult,
      }),
    ).rejects.toBeInstanceOf(RaceResultParseError);
    expect(saveResult).not.toHaveBeenCalled();
  });

  it("未確定レース(RaceResultNotConfirmedError)は例外を伝播せず保存もせず status='not_confirmed' を返すこと", async () => {
    const saveResult = vi.fn();
    const outcome = await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>未確定</html>"),
      parse: () => {
        throw new RaceResultNotConfirmedError(
          "結果テーブルはありますが結果行がありません",
        );
      },
      saveResult,
    });
    expect(saveResult).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "not_confirmed",
      raceId: "202602010607",
    });
  });

  it("地方(NAR)のレースIDでも取得URLが nar.netkeiba.com に切り替わり、保存まで動作すること(race_id形式非依存の確認)", async () => {
    const narRaceId = parseRaceId("202654071210"); // 場コード54 → 高知(docs/nar-scraping-plan.mdの実例)。
    const fetchText = vi.fn().mockResolvedValue("<html>ok</html>");
    const saveResult = vi.fn();
    const outcome = await importRaceResult(narRaceId, {
      fetchText,
      parse: () => buildRaceResult(),
      saveResult,
    });
    const [url] = fetchText.mock.calls[0]!;
    expect(url).toBe(
      "https://nar.netkeiba.com/race/result.html?race_id=202654071210",
    );
    expect(saveResult).toHaveBeenCalledTimes(1);
    expect(outcome.raceId).toBe("202654071210");
  });
});

/**
 * 枠連の確定払戻の取込(Issue #145・#26-F)。#52のR-7(判断を挟まず素通し)・R-10を
 * `bracketQuinella`にも適用する。**枠連の`umabans`は馬番ではなく枠番**。
 */
describe("組合せ払戻(枠連、Issue #145・#26-F)の取込", () => {
  const raceId = parseRaceId("202602010607");

  it("パース結果のbracketQuinellaPayoutsを、他の5券種と同時にsaveResultの第4引数へそのまま(判断を挟まず)渡すこと(AC-3)", async () => {
    const saveResult = vi.fn();
    const bracketQuinella: RaceResult["bracketQuinellaPayouts"] = {
      state: "parsed",
      payouts: [{ umabans: [4, 7], payout: 3150 }],
    };
    const trifecta: RaceResult["trifectaPayouts"] = {
      state: "parsed",
      payouts: [{ umabans: [13, 8, 5], payout: 52690 }],
    };
    await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
      parse: () => buildRaceResult({ bracketQuinellaPayouts: bracketQuinella, trifectaPayouts: trifecta }),
      saveResult,
    });
    expect(saveResult).toHaveBeenCalledTimes(1);
    const [, , , comboPayouts] = saveResult.mock.calls[0]!;
    // ★枠連が渡っていること(渡し忘れの変異はここで赤くなる)。toEqualはundefined値を無視するため、
    // フィールド単位でも直接固定する。
    expect(comboPayouts.bracketQuinella).toBe(bracketQuinella);
    expect(comboPayouts.bracketQuinella).not.toBeUndefined();
    // 他券種は従来どおり(三連単は素通しのまま。枠連の追加で置き換わっていない)。
    expect(comboPayouts.trifecta).toBe(trifecta);
    expect(Object.keys(comboPayouts).sort()).toEqual(
      ["bracketQuinella", "exacta", "quinella", "trifecta", "trio", "wide"],
    );
  });

  it("枠連がstate:'undetermined'(構造異常)のときも、判断を挟まずそのままsaveResultの第4引数へ渡り、着順は通常どおり保存されること", async () => {
    const saveResult = vi.fn();
    const undetermined: RaceResult["bracketQuinellaPayouts"] = {
      state: "undetermined",
      reason: {
        kind: "comboSizeMismatch",
        message: "テスト用",
        observedGroupCount: 1,
        observedPayoutCount: 1,
        rawHtml: null,
      },
    };
    await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
      parse: () => buildRaceResult({ bracketQuinellaPayouts: undetermined }),
      saveResult,
    });
    const [savedRaceId, entries, , comboPayouts] = saveResult.mock.calls[0]!;
    expect(savedRaceId).toBe(raceId);
    expect(entries).toEqual(toResultEntries(buildRaceResult()));
    expect(comboPayouts.bracketQuinella).toBe(undetermined);
  });

  it("パース結果にbracketQuinellaPayoutsが無い(未設定)場合は、saveResultの第4引数のbracketQuinellaもundefinedのままになること", async () => {
    const saveResult = vi.fn();
    await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
      parse: () => buildRaceResult(),
      saveResult,
    });
    const [, , , comboPayouts] = saveResult.mock.calls[0]!;
    expect(comboPayouts.bracketQuinella).toBeUndefined();
  });

  describe("実フィクスチャ → importRaceResult → AnalysisStore.saveResult → getComboPayouts の結線(製品コード経由)", () => {
    /** 実フィクスチャを本物のパーサと本物のストアに通して取り込む。 */
    async function importFixture(fixture: string, id: string): Promise<AnalysisStore> {
      const store = new AnalysisStore();
      await importRaceResult(parseRaceId(id), {
        fetchText: vi.fn().mockResolvedValue(loadFixture(fixture)),
        parse: parseRaceResult,
        saveResult: (rid, entries, courseType, comboPayouts) =>
          store.saveResult(rid, entries, courseType, comboPayouts),
      });
      return store;
    }

    it("中央16頭(4-7=3,150円)は bet_type='bracketQuinella'・キー'0407'で保存され、他券種(馬連・三連単)の取込は不変であること(AC-3)", async () => {
      const store = await importFixture("result_202603020211.html", "202603020211");
      expect(store.getComboPayouts("202603020211", "bracketQuinella")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "0407", payout: 3150 }],
      });
      // 既存券種は不変(枠連の追加で他の券種の行が消えたり混ざったりしていない)。
      expect(store.getComboPayouts("202603020211", "trifecta")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "130805", payout: 52690 }],
      });
      const quinella = store.getComboPayouts("202603020211", "quinella");
      expect(quinella.state).toBe("imported");
      if (quinella.state === "imported") {
        expect(quinella.payouts).toHaveLength(1);
        // 馬連は馬番のキー(13-8)であり、枠連のキー'0407'とは別。
        expect(quinella.payouts[0]!.comboKey).toBe("0813");
        expect(quinella.payouts[0]!.comboKey).not.toBe("0407");
      }
      store.close();
    });

    it("同枠の実物(2-2=18,390円)は キー'0202' で保存されること(同枠が落ちたり別の組に化けたりしない)", async () => {
      const store = await importFixture("result_202606040810.html", "202606040810");
      expect(store.getComboPayouts("202606040810", "bracketQuinella")).toEqual({
        state: "imported",
        payouts: [{ comboKey: "0202", payout: 18390 }],
      });
      store.close();
    });

    it("8頭以下(tr.Wakuren無し)は『取込済み・0件』(imported・payouts:[])として保存され、not_importedにはならないこと", async () => {
      const store = await importFixture("result_202607020505.html", "202607020505");
      expect(store.getComboPayouts("202607020505", "bracketQuinella")).toEqual({
        state: "imported",
        payouts: [],
      });
      store.close();
    });
  });
});
