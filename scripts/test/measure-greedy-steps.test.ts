import { describe, expect, it } from "vitest";
import {
  BET_TYPE_COLUMNS,
  allocationsEqual,
  betTypesOfSettings,
  formatShare,
  formatSensitivityTable,
  summarizeAllocations,
  type SensitivityRow,
} from "../measure-greedy-steps.js";

/**
 * Issue #36: greedySteps の感度の測り直し(scripts/measure-greedy-steps.ts)の、純粋な部分の検査。
 * 配分の計算そのもの(allocateGeneralBets)は core 側のテストの責務。ここでは「集計」「表の組み立て」「設定からの券種の並び」だけを固定する。
 */

const alloc = (betType: string, stake: number, umabans: number[] = [1]) => ({ betType, stake, umabans }) as never;

describe("summarizeAllocations(券種別の金額・構成比の集計)", () => {
  const cases: readonly {
    readonly name: string;
    readonly result: { totalStake: number; betCount: number; allocations: readonly unknown[] };
    readonly stake: Record<string, number>;
    readonly share: Record<string, number>;
  }[] = [
    {
      name: "1券種だけ: その券種が100%、ほかは0",
      result: { totalStake: 1000, betCount: 2, allocations: [alloc("wide", 600), alloc("wide", 400, [2])] },
      stake: { wide: 1000 },
      share: { wide: 1 },
    },
    {
      name: "複数の券種: 同じ券種の買い目は合算し、構成比の和は1",
      result: {
        totalStake: 1000,
        betCount: 4,
        allocations: [alloc("win", 100), alloc("trio", 300), alloc("trio", 200, [2]), alloc("trifecta", 400)],
      },
      stake: { win: 100, trio: 500, trifecta: 400 },
      share: { win: 0.1, trio: 0.5, trifecta: 0.4 },
    },
    {
      name: "総額0(見送り): 構成比は全券種0(ゼロ除算しない)",
      result: { totalStake: 0, betCount: 0, allocations: [] },
      stake: {},
      share: {},
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const s = summarizeAllocations(c.result as never);
      // 前提を無条件に固定する: 全8券種のキーが必ずある(取りこぼし・余計な券種が無い)
      expect(Object.keys(s.stakeByType)).toHaveLength(BET_TYPE_COLUMNS.length);
      expect(Object.keys(s.shareByType)).toHaveLength(BET_TYPE_COLUMNS.length);
      expect(s.totalStake).toBe(c.result.totalStake);
      expect(s.betCount).toBe(c.result.betCount);
      for (const { betType } of BET_TYPE_COLUMNS) {
        expect(s.stakeByType[betType], `${betType} の金額`).toBe(c.stake[betType] ?? 0);
        expect(s.shareByType[betType], `${betType} の構成比`).toBeCloseTo(c.share[betType] ?? 0, 12);
      }
      const shareSum = BET_TYPE_COLUMNS.reduce((sum, { betType }) => sum + s.shareByType[betType], 0);
      expect(shareSum).toBeCloseTo(c.result.totalStake > 0 ? 1 : 0, 12);
    });
  }

  it("金額の合計が totalStake と食い違うときは例外(集計の取りこぼしを黙って通さない)", () => {
    expect(() =>
      summarizeAllocations({ totalStake: 1000, betCount: 1, allocations: [alloc("wide", 900)] } as never),
    ).toThrow(/totalStake/);
  });

  it("未知の券種が混ざったら例外(列に出ない金額を黙って落とさない)", () => {
    expect(() =>
      summarizeAllocations({ totalStake: 100, betCount: 1, allocations: [alloc("unknownType", 100)] } as never),
    ).toThrow(/unknownType/);
  });
});

describe("formatShare(構成比の表示)", () => {
  it("小数1桁の百分率。0は 0.0%、1は 100.0%", () => {
    expect(formatShare(0)).toBe("0.0%");
    expect(formatShare(1)).toBe("100.0%");
    expect(formatShare(0.12345)).toBe("12.3%");
    expect(formatShare(0.0005)).toBe("0.1%");
  });
});

describe("betTypesOfSettings(設定 → 券種の並び。mixed-race-allocation の resolveMixedBetTypes と同じ順)", () => {
  const all = {
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
  };

  it("全部ON: 8券種が place, win, wide, trio, quinella, exacta, trifecta, bracketQuinella の順", () => {
    expect(betTypesOfSettings(all)).toEqual(["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"]);
  });

  it("馬連・馬単・三連単・枠連をOFF: 単勝・複勝・ワイド・三連複の4券種(8/13と同じ券種)", () => {
    expect(
      betTypesOfSettings({
        ...all,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: false,
        includeTrifectaInAllocation: false,
        includeBracketQuinellaInAllocation: false,
      }),
    ).toEqual(["place", "win", "wide", "trio"]);
  });

  it("組合せ券種を全部OFF: 複勝と単勝だけ(常に含める)", () => {
    expect(
      betTypesOfSettings({
        includeWideInAllocation: false,
        includeTrioInAllocation: false,
        includeQuinellaInAllocation: false,
        includeExactaInAllocation: false,
        includeTrifectaInAllocation: false,
        includeBracketQuinellaInAllocation: false,
      }),
    ).toEqual(["place", "win"]);
  });
});

describe("allocationsEqual(本番の経路との一致の検査)", () => {
  const a = [
    { betType: "wide", umabans: [1, 2], stake: 500 },
    { betType: "win", umabans: [3], stake: 300 },
  ] as never;

  it("同じ列なら true", () => {
    expect(allocationsEqual(a, [...(a as unknown as unknown[])] as never)).toBe(true);
  });

  it("金額が1円違えば false", () => {
    const b = [
      { betType: "wide", umabans: [1, 2], stake: 500 },
      { betType: "win", umabans: [3], stake: 301 },
    ] as never;
    expect(allocationsEqual(a, b)).toBe(false);
  });

  it("馬番の組が違えば false", () => {
    const b = [
      { betType: "wide", umabans: [1, 3], stake: 500 },
      { betType: "win", umabans: [3], stake: 300 },
    ] as never;
    expect(allocationsEqual(a, b)).toBe(false);
  });

  it("件数が違えば false(片方が空でも)", () => {
    expect(allocationsEqual(a, [] as never)).toBe(false);
  });

  it("並びが違うだけなら true(券種+馬番の組をキーに比べる)", () => {
    const reversed = [...(a as unknown as unknown[])].reverse() as never;
    expect(allocationsEqual(a, reversed)).toBe(true);
  });
});

describe("formatSensitivityTable(感度表の組み立て)", () => {
  const rowOf = (greedySteps: number, stakeByType: Partial<Record<string, number>>, betCount: number, belowFloorCount: number): SensitivityRow => {
    const summary = summarizeAllocations({
      totalStake: Object.values(stakeByType).reduce<number>((s, v) => s + (v ?? 0), 0),
      betCount,
      allocations: Object.entries(stakeByType).map(([t, s]) => alloc(t, s ?? 0)),
    } as never);
    return { greedySteps, summary, belowFloorCount };
  };

  const table = formatSensitivityTable("100万/10万", [
    rowOf(400, { wide: 750, trio: 250 }, 3, 7),
    rowOf(1000, { wide: 500, trio: 500 }, 5, 7),
  ]);

  it("見出し行 + 区切り + データ行(行数だけ)で、タイトルが先頭にある", () => {
    expect(table).toHaveLength(2 + 1 + 2); // タイトル・見出し・データ2行 に加えて区切り1行
    expect(table[0]).toContain("100万/10万");
  });

  it("見出しに、greedySteps・総額・点数・外れ(下限)と全8券種の列名がある", () => {
    const header = table[1]!;
    for (const word of ["greedySteps", "総額", "点数", "下限で外れ"]) expect(header).toContain(word);
    for (const { label } of BET_TYPE_COLUMNS) expect(header).toContain(label);
  });

  it("データ行に、greedySteps・総額(桁区切り)・点数・外れ件数・券種別の構成比が、列の順に出る", () => {
    const cells = (line: string): string[] => line.split("|").slice(1, -1).map((c) => c.trim());
    const c400 = cells(table[3]!);
    // 列: greedySteps | 総額 | 点数 | 下限で外れ | 券種8列
    expect(c400.slice(0, 4)).toEqual(["400", "1,000", "3", "7"]);
    const share400 = Object.fromEntries(BET_TYPE_COLUMNS.map((col, i) => [col.betType, c400[4 + i]]));
    expect(share400).toEqual({
      win: "0.0%",
      place: "0.0%",
      wide: "75.0%",
      quinella: "0.0%",
      exacta: "0.0%",
      trio: "25.0%",
      trifecta: "0.0%",
      bracketQuinella: "0.0%",
    });
    const c1000 = cells(table[4]!);
    expect(c1000.slice(0, 4)).toEqual(["1000", "1,000", "5", "7"]);
  });

  it("列の数は全行で同じ(区切りの数が揃う)", () => {
    const counts = table.slice(1).filter((l) => l.includes("|")).map((l) => l.split("|").length);
    expect(counts.length).toBeGreaterThan(2);
    expect(new Set(counts).size).toBe(1);
  });
});
