/**
 * 発売前(`status:"middle"`)の仮の値(9,999.9・99,999.9)の組が、配分の候補に入らないこと(Issue #469)。
 *
 * パーサ(`parseComboOdds`)の欠損化は`parse-combo-odds.test.ts`が固定する。本ファイルは**その先**、
 * 取得したオッズを`toComboOddsScalarMap`→各券種の候補ビルダーに渡したときの帰結を固定する:
 * 仮の値の組はMapの値がnullになり、`resolveComboOdds`の`missing`状態(`oddsMissingCount`に数えられ、
 * 候補にならない)に分類される。`unfetched`(キーが無い)にも`malformed`(数値として不正)にもならない。
 *
 * 券種ごとに専用の候補ビルダーがある(ワイド・三連複=`buildComboCandidates`、馬連=`buildQuinellaCandidates`、
 * 馬単=`buildExactaCandidates`、枠連=`buildBracketQuinellaCandidates`)。いずれも
 * `Map<string, number|null>`を受けて`resolveComboOdds`で4状態に分類する同じ形だが、**ビルダー自体が別**
 * なので、券種ごとに1件ずつ確かめる。
 *
 * 出走14頭(東京1R)は、実物のキー数から確かめている: ワイドC(14,2)=91・三連複C(14,3)=364・馬単14×13=182。
 * 枠連は枠3〜8が2頭ずつ・枠1,2が1頭ずつ(同枠の組"0303"〜"0808"の6組がフィクスチャにあることから導く)。
 */
import { describe, expect, it } from "vitest";
import {
  buildAllocationBetComboKey,
  buildBracketQuinellaCandidates,
  buildComboCandidates,
  buildExactaCandidates,
  buildQuinellaCandidates,
  type AllocationBetType,
  type ComboCandidateBuildResult,
} from "../../src/ev/combo-bet-allocation.js";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";
import { toComboOddsScalarMap } from "../../src/scraper/combo-odds-key.js";
import { parseComboOdds, type ComboBetType } from "../../src/scraper/parse-combo-odds.js";
import { loadFixture } from "../support/fixtures.js";

/** 14頭(馬番1〜14)。3着内率は非一様(0.9から0.05ずつ下がる。下限0.25)。 */
const HORSES: JointModelHorse[] = Array.from({ length: 14 }, (_, i) => ({
  umaban: i + 1,
  placeProb: 0.9 - i * 0.05,
}));

/** 枠連用: 馬番1→枠1・馬番2→枠2・馬番3,4→枠3・…・馬番13,14→枠8。 */
const BRACKET_HORSES = HORSES.map((h) => ({
  ...h,
  wakuban: h.umaban <= 2 ? h.umaban : Math.floor((h.umaban - 3) / 2) + 3,
}));

interface Case {
  readonly name: string;
  readonly betType: ComboBetType;
  readonly allocationBetType: AllocationBetType;
  readonly file: string;
  readonly total: number;
  readonly capCount: number;
  readonly capValue: number;
  /** 生JSON上の仮の値の文字列。 */
  readonly capText: string;
  readonly typeKey: string;
  readonly build: (odds: ReadonlyMap<string, number | null>) => ComboCandidateBuildResult;
}

const CASES: readonly Case[] = [
  {
    name: "ワイド",
    betType: "wide",
    allocationBetType: "wide",
    file: "odds_wide_presale_202605040801_20261023.json",
    total: 91,
    capCount: 21,
    capValue: 9999.9,
    capText: "9,999.9",
    typeKey: "5",
    build: (odds) => buildComboCandidates(HORSES, 3, "wide", odds),
  },
  {
    name: "三連複",
    betType: "trio",
    allocationBetType: "trio",
    file: "odds_trio_presale_202605040801_20261023.json",
    total: 364,
    capCount: 165,
    capValue: 99999.9,
    capText: "99,999.9",
    typeKey: "7",
    build: (odds) => buildComboCandidates(HORSES, 3, "trio", odds),
  },
  {
    name: "馬連",
    betType: "quinella",
    allocationBetType: "quinella",
    file: "odds_quinella_presale_202605040801_20261023.json",
    total: 91,
    capCount: 34,
    capValue: 99999.9,
    capText: "99,999.9",
    typeKey: "4",
    build: (odds) => buildQuinellaCandidates(HORSES, 3, odds),
  },
  {
    name: "馬単",
    betType: "exacta",
    allocationBetType: "exacta",
    file: "odds_exacta_presale_202605040801_20261023.json",
    total: 182,
    capCount: 108,
    capValue: 99999.9,
    capText: "99,999.9",
    typeKey: "6",
    build: (odds) => buildExactaCandidates(HORSES, 3, odds),
  },
  {
    name: "枠連",
    betType: "bracketQuinella",
    allocationBetType: "bracketQuinella",
    file: "odds_wakuren_presale_202605040801_20261023.json",
    total: 34,
    capCount: 5,
    capValue: 9999.9,
    capText: "9,999.9",
    typeKey: "3",
    build: (odds) => buildBracketQuinellaCandidates(BRACKET_HORSES, 3, odds),
  },
];

describe.each(CASES)("$name: 発売前の仮の値の組が配分の候補に入らないこと(Issue #469)", (c) => {
  const parsed = parseComboOdds(loadFixture(c.file), c.betType);
  // 前提(無条件): 取得できていること。
  expect(parsed.state).toBe("available");
  const oddsMap = parsed.state === "available" ? toComboOddsScalarMap(parsed.odds) : new Map<string, number | null>();
  // 仮の値の組は、パース結果ではなく**生JSON**から数える(パーサの出力を期待値の元にすると自己参照になる)。
  const rawOdds = (JSON.parse(loadFixture(c.file)) as { data: { odds: Record<string, Record<string, string[]>> } }).data
    .odds[c.typeKey]!;
  const capKeys = Object.entries(rawOdds).filter(([, v]) => v[0] === c.capText).map(([k]) => k);

  it("前提: 全組数と、仮の値でnullになった組数が実測と一致すること", () => {
    expect(oddsMap.size).toBe(c.total);
    expect(capKeys.length).toBe(c.capCount);
    expect(capKeys.every((k) => oddsMap.has(k))).toBe(true);
  });

  it("仮の値の組は、Mapにキーが残ったまま値がnullになること(未取得に化けない)", () => {
    for (const key of capKeys) {
      expect(oddsMap.has(key)).toBe(true);
      expect(oddsMap.get(key)).toBeNull();
    }
  });

  it("oddsMissingCountが仮の値の組数に一致し、未取得0・不正0で、全組が分類されること(missing状態になる)", () => {
    const { diagnostics } = c.build(oddsMap);
    expect(diagnostics.enumeratedCount).toBe(c.total);
    expect(diagnostics.unjudged.oddsMissingCount).toBe(c.capCount);
    expect(diagnostics.unjudged.oddsUnfetchedCount).toBe(0);
    expect(diagnostics.unjudged.oddsMalformedCount).toBe(0);
    expect(
      diagnostics.judged.positiveCount + diagnostics.judged.notPositiveCount + c.capCount,
    ).toBe(c.total);
  });

  it("候補のキーに、仮の値の組が1件も含まれないこと(本物の組からは候補が出ていること)", () => {
    const { candidates } = c.build(oddsMap);
    expect(candidates.length).toBeGreaterThan(0);
    const candidateKeys = new Set(candidates.map((cand) => buildAllocationBetComboKey(c.allocationBetType, cand.umabans)));
    expect(candidateKeys.size).toBe(candidates.length);
    for (const key of capKeys) {
      expect(candidateKeys.has(key)).toBe(false);
    }
  });

  it("(検出力の確認)仮の値を本物のオッズとして数値で渡す旧挙動なら、仮の値の組が候補に入ること", () => {
    const legacyMap = new Map<string, number | null>(oddsMap);
    for (const key of capKeys) {
      legacyMap.set(key, c.capValue);
    }
    const { candidates } = c.build(legacyMap);
    const candidateKeys = new Set(candidates.map((cand) => buildAllocationBetComboKey(c.allocationBetType, cand.umabans)));
    const leaked = capKeys.filter((k) => candidateKeys.has(k));
    // 旧挙動では、仮の値の組の少なくとも1件が候補に入る(このテストの本体が空振りでないことの固定)。
    expect(leaked.length).toBeGreaterThan(0);
  });
});
