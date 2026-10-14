import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_EV_CONFIG } from "../../src/ev/expected-value.js";
import {
  ALLOCATION_BET_TYPE_REQUIRES_ORDER,
  ALLOCATION_BET_TYPE_UMABAN_COUNT,
  allocateGeneralBets,
  allocationBetTypeElementKind,
  allocationBetTypeKeyOrder,
  buildAllocationBetComboKey,
  buildBracketQuinellaCandidates,
  buildComboCandidates,
  buildQuinellaCandidates,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  umabanCountOf,
  type AllocationBetType,
  type AllocationCandidate,
  type GeneralBetAllocationConfig,
  type WinOutcome,
} from "../../src/ev/combo-bet-allocation.js";
import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
  type OrderedOutcome,
  type OrderedPlaceJointModel,
} from "../../src/ev/place-joint-model.js";
import { COMBO_ELEMENT_KIND, COMBO_SIZE, toComboOddsScalarMap } from "../../src/scraper/combo-odds-key.js";
import { expectedBracketQuinellaComboCount } from "../../src/scraper/fetch-combo-odds.js";
import { parseComboOdds } from "../../src/scraper/parse-combo-odds.js";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";

/**
 * 枠連(bracketQuinella)の core(Issue #144・#26-B)。
 *
 * 枠連の買い目は「枠の組」で、`AllocationCandidate.umabans`には**枠番**(1〜8・非減少・同枠可)が入る
 * (オッズ・払戻のキーと一致し、`buildAllocationBetComboKey`がそのまま使える)。的中判定は
 * 1着・2着の**馬番**を枠番に引き直して行うため、馬が`wakuban`を持つ(ビルダーでは必須・
 * `allocateGeneralBets`では任意。枠連候補があるときだけ検査する)。
 *
 * 検証の方針(#128の教訓): モデルの分布を直接足さず、**製品コード(候補ビルダー・
 * `allocateGeneralBets`のisHit)を通して**値を得る。馬番と枠番が一致しない標本(16頭は全枠2頭、
 * 10頭は7番以降が非恒等)を使い、「枠番を馬番として扱う」変異を殺せるようにする。
 */

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** wakuban付きの馬(ビルダーが要求する型)。 */
type WakubanHorse = JointModelHorse & { readonly wakuban: number };

/**
 * 実フィクスチャの出馬表から、馬番・枠番付きの馬を作る。複勝圏内確率は実データが無いため、
 * 「馬番が小さいほど強い」重み1/(i+3)を合計3(topFinishCount)に正規化して合成する
 * (同時分布モデルが縮退しない有限の値であればよい。順序付き分布の値そのものは
 * 製品コードから得るため、この合成値の妥当性は検証対象外)。
 */
function racehorsesFromShutuba(shutubaFile: string): WakubanHorse[] {
  const shutuba = parseShutuba(loadFixture(shutubaFile));
  const sorted = [...shutuba.horses].sort((a, b) => a.umaban - b.umaban);
  const weights = sorted.map((_, i) => 1 / (i + 3));
  const total = weights.reduce((s, w) => s + w, 0);
  return sorted.map((h, i) => ({
    umaban: h.umaban,
    wakuban: h.wakuban,
    placeProb: (3 * weights[i]!) / total,
  }));
}

/** 全ての枠の組(A≤B。1〜8)に同一オッズを割り当てたMap(存在しない同枠キーも含む上位集合)。 */
function allFramePairsOddsMap(odds: number): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (let a = 1; a <= 8; a++) {
    for (let b = a; b <= 8; b++) {
      map.set(`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`, odds);
    }
  }
  return map;
}

/** 馬番の全ペア(a<b)に同一オッズを割り当てたMap(馬連用)。 */
function allUmabanPairsOddsMap(umabans: readonly number[], odds: number): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const a of umabans) {
    for (const b of umabans) {
      if (a < b) {
        map.set(`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`, odds);
      }
    }
  }
  return map;
}

/** 全候補をEVプラスとして拾う設定(ev>0。hitProb=ev/oddsを取り出すため)。 */
const ALL_POSITIVE = { threshold: 0 };

/** 候補のhitProb(=ev/odds)を「枠キー」で引くMapにする。 */
function hitProbByKey(candidates: readonly AllocationCandidate[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of candidates) {
    map.set(c.umabans.join("-"), c.ev / c.odds);
  }
  return map;
}

const realConfig: GeneralBetAllocationConfig = {
  ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  bankroll: 100_000,
  perRaceCap: 100_000,
};

/** 固定の順序付き分布を返すスタブモデル(順序付きoutcomeだけを固定し、期待値を手計算できるようにする)。 */
function stubOrderedModel(outcomes: readonly OrderedOutcome[]): OrderedPlaceJointModel {
  return {
    id: "stub-ordered",
    approximate: false,
    buildDistribution: () => [{ placed: [], probability: 1 }],
    buildOrderedDistribution: () => outcomes,
  };
}

/**
 * 手計算用の4頭立て。枠は [1,1,2,2](馬番1・2が枠1、馬番3・4が枠2)。
 * 順序付きoutcome(1着,2着,3着)と確率:
 *   [1,2,3]=0.4 → 枠(1,1)   [2,1,4]=0.1 → 枠(1,1)
 *   [3,1,2]=0.2 → 枠(2,1)   [4,3,1]=0.3 → 枠(2,2)
 * よって枠の組の的中確率は {1,1}=0.5、{1,2}=0.2、{2,2}=0.3(和=1)。
 * 馬連は {1,2}=0.4+0.1=0.5(馬番1・2)、{1,3}=0.2、{3,4}=0.3。
 */
const STUB_HORSES: readonly WakubanHorse[] = [
  { umaban: 1, wakuban: 1, placeProb: 0.75 },
  { umaban: 2, wakuban: 1, placeProb: 0.75 },
  { umaban: 3, wakuban: 2, placeProb: 0.75 },
  { umaban: 4, wakuban: 2, placeProb: 0.75 },
];
const STUB_OUTCOMES: readonly OrderedOutcome[] = [
  { order: [1, 2, 3], probability: 0.4 },
  { order: [2, 1, 4], probability: 0.1 },
  { order: [3, 1, 2], probability: 0.2 },
  { order: [4, 3, 1], probability: 0.3 },
];
const STUB_MODEL = stubOrderedModel(STUB_OUTCOMES);

function bracket(umabans: number[], odds = 10, ev = 5): AllocationCandidate {
  return { betType: "bracketQuinella", umabans, odds, ev, isPositive: true };
}

describe("AC-1: 型・写像への追加(Issue #144・#26-B)", () => {
  it("ALLOCATION_BET_TYPE_UMABAN_COUNT.bracketQuinellaが2で、COMBO_SIZE.bracketQuinellaと一致すること", () => {
    expect(ALLOCATION_BET_TYPE_UMABAN_COUNT.bracketQuinella).toBe(2);
    expect(umabanCountOf("bracketQuinella")).toBe(2);
    expect(ALLOCATION_BET_TYPE_UMABAN_COUNT.bracketQuinella).toBe(COMBO_SIZE.bracketQuinella);
  });

  it("ALLOCATION_BET_TYPE_REQUIRES_ORDER.bracketQuinellaがtrueであること(1着・2着の馬番から枠を引くため順序付きoutcome空間が要る)", () => {
    expect(ALLOCATION_BET_TYPE_REQUIRES_ORDER.bracketQuinella).toBe(true);
  });

  it("allocationBetTypeKeyOrder('bracketQuinella')が'unordered'であること(キーは昇順の枠の組)", () => {
    expect(allocationBetTypeKeyOrder("bracketQuinella")).toBe("unordered");
  });

  it("buildAllocationBetComboKeyがオッズ・払戻と同じ4桁キーを返すこと(4-7→'0407'、逆順も同じ、同枠1-1→'0101'・8-8→'0808')", () => {
    expect(buildAllocationBetComboKey("bracketQuinella", [4, 7])).toBe("0407");
    expect(buildAllocationBetComboKey("bracketQuinella", [7, 4])).toBe("0407");
    expect(buildAllocationBetComboKey("bracketQuinella", [1, 1])).toBe("0101");
    expect(buildAllocationBetComboKey("bracketQuinella", [8, 8])).toBe("0808");
  });

  it("allocationBetTypeElementKind: bracketQuinellaだけが'wakuban'で、他の券種はすべて'umaban'であること(ハードコードしたリテラル)", () => {
    const expected: Record<AllocationBetType, "umaban" | "wakuban"> = {
      place: "umaban",
      win: "umaban",
      wide: "umaban",
      quinella: "umaban",
      exacta: "umaban",
      bracketQuinella: "wakuban",
      trio: "umaban",
      trifecta: "umaban",
    };
    for (const betType of Object.keys(expected) as AllocationBetType[]) {
      expect(allocationBetTypeElementKind(betType)).toBe(expected[betType]);
    }
    // 網羅の確認: ALLOCATION_BET_TYPE_UMABAN_COUNTの全キーを上の表が覆っていること。
    expect(new Set(Object.keys(expected))).toEqual(new Set(Object.keys(ALLOCATION_BET_TYPE_UMABAN_COUNT)));
  });

  it("allocationBetTypeElementKindがCOMBO_ELEMENT_KINDと一致すること(ComboBetTypeに属する券種。写像の二重定義の乖離を検出)", () => {
    for (const betType of Object.keys(COMBO_ELEMENT_KIND) as (keyof typeof COMBO_ELEMENT_KIND)[]) {
      expect(allocationBetTypeElementKind(betType)).toBe(COMBO_ELEMENT_KIND[betType]);
    }
  });
});

describe("validateCandidates: 枠連の並び・範囲検証(要素は枠番。同枠を許し、既存券種の検証は変えない)", () => {
  it("同枠 [1,1]・[2,2] を拒否せず受理すること(厳密昇順の検査に落とさない)", () => {
    const result = allocateGeneralBets(STUB_HORSES, 3, [bracket([1, 1]), bracket([2, 2])], realConfig, STUB_MODEL);
    expect(result.allocations.map((a) => a.umabans)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("非減少 [1,2] を受理し、降順 [2,1] は拒否すること(同枠は許すが逆順は許さない)", () => {
    expect(() => allocateGeneralBets(STUB_HORSES, 3, [bracket([1, 2])], realConfig, STUB_MODEL)).not.toThrow();
    expect(() => allocateGeneralBets(STUB_HORSES, 3, [bracket([2, 1])], realConfig, STUB_MODEL)).toThrow(
      /昇順/,
    );
  });

  it.each([
    ["9(上限8超)", [1, 9]],
    ["0(1未満)", [0, 1]],
    ["小数", [1.5, 2]],
  ])("枠番が範囲外・非整数(%s)の候補は拒否すること", (_label, umabans) => {
    expect(() => allocateGeneralBets(STUB_HORSES, 3, [bracket(umabans)], realConfig, STUB_MODEL)).toThrow(/枠番/);
  });

  it("頭数不一致(3要素)は既存どおり拒否すること", () => {
    expect(() => allocateGeneralBets(STUB_HORSES, 3, [bracket([1, 2, 2])], realConfig, STUB_MODEL)).toThrow(
      /2頭の組/,
    );
  });

  it("同じ枠の組を2回渡すと重複として拒否すること", () => {
    expect(() =>
      allocateGeneralBets(STUB_HORSES, 3, [bracket([1, 2]), bracket([1, 2])], realConfig, STUB_MODEL),
    ).toThrow(/重複/);
  });

  it("枠連 [1,2] と馬連 [1,2](別券種・同じ数値の組)は重複扱いにならず、独立に受理されること", () => {
    const candidates: AllocationCandidate[] = [
      bracket([1, 2]),
      { betType: "quinella", umabans: [1, 2], odds: 10, ev: 5, isPositive: true },
    ];
    expect(() => allocateGeneralBets(STUB_HORSES, 3, candidates, realConfig, STUB_MODEL)).not.toThrow();
  });

  it("既存券種の検証を変えていないこと: 馬連の同値 [1,1] は引き続き拒否される(枠番の緩和が馬番券種に漏れない)", () => {
    const candidates: AllocationCandidate[] = [
      { betType: "quinella", umabans: [1, 1], odds: 10, ev: 5, isPositive: true },
    ];
    expect(() => allocateGeneralBets(STUB_HORSES, 3, candidates, realConfig, STUB_MODEL)).toThrow(/昇順/);
  });

  it("既存券種の検証を変えていないこと: 馬連の馬番 9・18 は枠番の上限8に縛られず受理される", () => {
    const horses: JointModelHorse[] = Array.from({ length: 18 }, (_, i) => ({ umaban: i + 1, placeProb: 3 / 18 }));
    const candidates: AllocationCandidate[] = [
      { betType: "quinella", umabans: [9, 18], odds: 10, ev: 5, isPositive: true },
    ];
    expect(() => allocateGeneralBets(horses, 3, candidates, realConfig)).not.toThrow();
  });
});

describe("馬番→枠番の対応(wakuban)の検査: 枠連候補があるときだけ、全馬について fail fast", () => {
  const withWakuban = (umaban: number, wakuban: number | undefined): JointModelHorse & { wakuban?: number } =>
    wakuban === undefined
      ? { umaban, placeProb: 0.75 }
      : { umaban, wakuban, placeProb: 0.75 };

  it("★前提: 全馬が有効な枠番を持つと、枠連候補ありでもthrowしないこと", () => {
    expect(() => allocateGeneralBets(STUB_HORSES, 3, [bracket([1, 2])], realConfig, STUB_MODEL)).not.toThrow();
  });

  it("1頭でもwakubanが欠けていると、枠連候補ありのときthrowすること(その馬が1着・2着に来るoutcomeの枠が決まらず静かにfalseになるため)", () => {
    const horses = [withWakuban(1, 1), withWakuban(2, 1), withWakuban(3, 2), withWakuban(4, undefined)];
    expect(() => allocateGeneralBets(horses, 3, [bracket([1, 2])], realConfig, STUB_MODEL)).toThrow(
      /枠番.*umaban=4|umaban=4.*枠番/,
    );
  });

  it.each([
    ["0", 0],
    ["9", 9],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("wakubanが範囲外・非整数(%s)の馬がいると、枠連候補ありのときthrowすること", (_label, bad) => {
    const horses = [withWakuban(1, 1), withWakuban(2, 1), withWakuban(3, 2), withWakuban(4, bad)];
    expect(() => allocateGeneralBets(horses, 3, [bracket([1, 2])], realConfig, STUB_MODEL)).toThrow(/枠番/);
  });

  it("順序付き分布が判定不能(indeterminate)になる呼び出しでも、wakubanの欠落は契約違反としてthrowすること", () => {
    // 3頭・topFinishCount=3は「上位k枠が全頭を覆う」縮退(PLACKETT_LUCE_MODELでnullになる)。
    const horses = [withWakuban(1, 1), withWakuban(2, 2), withWakuban(3, undefined)];
    expect(() => allocateGeneralBets(horses, 3, [bracket([1, 2])], realConfig)).toThrow(/枠番/);
  });

  it("枠連候補が無い呼び出しは、wakubanが欠けていても不正でも一切見ない(非破壊性)", () => {
    const horses = [withWakuban(1, undefined), withWakuban(2, 99), withWakuban(3, Number.NaN), withWakuban(4, 1.5)];
    const candidates: AllocationCandidate[] = [
      { betType: "quinella", umabans: [1, 2], odds: 10, ev: 5, isPositive: true },
      { betType: "win", umabans: [3], odds: 10, ev: 5, isPositive: true },
    ];
    expect(() => allocateGeneralBets(horses, 3, candidates, realConfig, STUB_MODEL)).not.toThrow();
  });

  it("isPositive=falseの枠連候補だけでも(最適化対象外でも)検査は行うこと(候補の有無で契約が変わらない)", () => {
    const horses = [withWakuban(1, 1), withWakuban(2, 1), withWakuban(3, 2), withWakuban(4, undefined)];
    const c: AllocationCandidate = { ...bracket([1, 2]), isPositive: false };
    expect(() => allocateGeneralBets(horses, 3, [c], realConfig, STUB_MODEL)).toThrow(/枠番/);
  });
});

describe("★手計算で固定する枠連の的中確率(スタブ分布。製品のisHit・ビルダーを通す)", () => {
  it("allocateGeneralBets: {1,1}=0.5・{1,2}=0.2・{2,2}=0.3(同枠は1着・2着がともにその枠、順不同)で、和が1であること", () => {
    const candidates = [bracket([1, 1]), bracket([1, 2]), bracket([2, 2])];
    const result = allocateGeneralBets(STUB_HORSES, 3, candidates, realConfig, STUB_MODEL);
    expect(result.winOutcome).toEqual<WinOutcome>({ kind: "determined" });
    const hp = (u: number[]) => result.allocations.find((a) => a.umabans.join("-") === u.join("-"))!.hitProb;
    expect(result.allocations.length).toBe(3);
    expect(hp([1, 1])).toBeCloseTo(0.5, 12);
    expect(hp([1, 2])).toBeCloseTo(0.2, 12);
    expect(hp([2, 2])).toBeCloseTo(0.3, 12);
    expect(hp([1, 1]) + hp([1, 2]) + hp([2, 2])).toBeCloseTo(1, 12);
  });

  it("★{1,2}は「1着が枠2・2着が枠1」(outcome [3,1,2])の逆順でも的中すること(逆順項を落とす変異を殺す)", () => {
    // 逆順の寄与は0.2のみ。順方向(1着枠1・2着枠2)のoutcomeはスタブに存在しない。
    const result = allocateGeneralBets(STUB_HORSES, 3, [bracket([1, 2])], realConfig, STUB_MODEL);
    expect(result.allocations[0]!.hitProb).toBeCloseTo(0.2, 12);
  });

  it("buildBracketQuinellaCandidates: 同じ分布から同じ値(ev/odds)を返すこと(ビルダーと配分器の独立2実装の一致)", () => {
    const build = buildBracketQuinellaCandidates(STUB_HORSES, 3, allFramePairsOddsMap(10), ALL_POSITIVE, STUB_MODEL);
    const hp = hitProbByKey(build.candidates);
    expect(build.candidates.length).toBe(3);
    expect(hp.get("1-1")).toBeCloseTo(0.5, 12);
    expect(hp.get("1-2")).toBeCloseTo(0.2, 12);
    expect(hp.get("2-2")).toBeCloseTo(0.3, 12);
  });

  it("同じ数値の組でも枠連と馬連は別の的中確率で判定されること(枠[1,2]=0.2・馬番[1,2]=0.5。混在しても互いに汚染しない)", () => {
    const candidates: AllocationCandidate[] = [
      bracket([1, 2]),
      { betType: "quinella", umabans: [1, 2], odds: 10, ev: 5, isPositive: true },
    ];
    const result = allocateGeneralBets(STUB_HORSES, 3, candidates, realConfig, STUB_MODEL);
    const b = result.allocations.find((a) => a.betType === "bracketQuinella")!;
    const q = result.allocations.find((a) => a.betType === "quinella")!;
    expect(b.hitProb).toBeCloseTo(0.2, 12);
    expect(q.hitProb).toBeCloseTo(0.5, 12);
  });

  it("馬番と枠番の対応が恒等でない並び(馬番1・4が枠2、馬番2・3が枠1)でも、その対応どおりに判定すること", () => {
    // [1,2,3]=0.4→枠(2,1) [2,1,4]=0.1→枠(1,2) [3,1,2]=0.2→枠(1,2) [4,3,1]=0.3→枠(2,1)
    // → {1,2}=1.0(同枠の的中は無い)。同じ分布・元の対応(枠[1,1,2,2])なら {1,2}=0.2 なので、
    // 対応表が実際に参照されていることの直接証拠になる。
    const horses: WakubanHorse[] = [
      { umaban: 1, wakuban: 2, placeProb: 0.75 },
      { umaban: 2, wakuban: 1, placeProb: 0.75 },
      { umaban: 3, wakuban: 1, placeProb: 0.75 },
      { umaban: 4, wakuban: 2, placeProb: 0.75 },
    ];
    const result = allocateGeneralBets(horses, 3, [bracket([1, 2]), bracket([1, 1]), bracket([2, 2])], realConfig, STUB_MODEL);
    const hp = (u: number[]) => result.allocations.find((a) => a.umabans.join("-") === u.join("-"))!.hitProb;
    expect(hp([1, 2])).toBeCloseTo(1.0, 12);
    expect(hp([1, 1])).toBeCloseTo(0, 12);
    expect(hp([2, 2])).toBeCloseTo(0, 12);
  });
});

describe("候補側の不可能な組(馬のいない枠・1頭枠の同枠)は throw せず、hitProb=0・賭け金なしになる【記録】", () => {
  // 枠1は馬番1の1頭のみ、枠2は馬番2・3の2頭。
  const horses: WakubanHorse[] = [
    { umaban: 1, wakuban: 1, placeProb: 0.9 },
    { umaban: 2, wakuban: 2, placeProb: 0.9 },
    { umaban: 3, wakuban: 2, placeProb: 0.9 },
    { umaban: 4, wakuban: 3, placeProb: 0.9 },
  ];
  const outcomes: OrderedOutcome[] = [
    { order: [1, 2, 3], probability: 0.5 },
    { order: [2, 3, 1], probability: 0.3 },
    { order: [4, 1, 2], probability: 0.2 },
  ];

  it("1頭枠の同枠 [1,1] と、馬のいない枠 [5,6] は hitProb が厳密に0で、continuousFraction・stake も0であること(実在する [2,2]・[1,2] は正)", () => {
    const candidates = [bracket([1, 1]), bracket([5, 6]), bracket([2, 2]), bracket([1, 2])];
    const result = allocateGeneralBets(horses, 3, candidates, realConfig, stubOrderedModel(outcomes));
    const find = (u: number[]) => result.allocations.find((a) => a.umabans.join("-") === u.join("-"))!;
    // 前提の固定(無条件): 4件すべてが最適化に載っていること。
    expect(result.allocations.length).toBe(4);
    expect(find([2, 2]).hitProb).toBeCloseTo(0.3, 12);
    expect(find([1, 2]).hitProb).toBeCloseTo(0.5, 12);
    for (const u of [[1, 1], [5, 6]]) {
      const a = find(u);
      expect(a.hitProb).toBe(0);
      expect(a.continuousFraction).toBe(0);
      expect(a.stake).toBe(0);
    }
  });

  it("ビルダーはそもそも1頭枠の同枠・馬のいない枠を列挙しないこと(production から到達不能)", () => {
    const build = buildBracketQuinellaCandidates(horses, 3, allFramePairsOddsMap(10), ALL_POSITIVE, stubOrderedModel(outcomes));
    const keys = build.candidates.map((c) => c.umabans.join("-"));
    expect(keys).not.toContain("1-1");
    expect(keys).not.toContain("3-3");
    expect(keys.some((k) => k.includes("5") || k.includes("6") || k.includes("7") || k.includes("8"))).toBe(false);
    // 列挙: 相異なる枠3つ→C(3,2)=3、2頭以上いる枠は枠2のみ→同枠1、計4。
    expect(build.diagnostics.enumeratedCount).toBe(4);
  });
});

describe("buildBracketQuinellaCandidates: 実フィクスチャ(16頭・10頭)と合成9頭", () => {
  const races = [
    { label: "中央16頭(全8枠が2頭。odds_wakuren_202603020211)", shutuba: "shutuba_202603020211.html", odds: "odds_wakuren_202603020211.json", enumerated: 36, n: 16 },
    { label: "中央10頭(7・8枠のみ2頭。odds_wakuren_202602010607)", shutuba: "shutuba_202602010607.html", odds: "odds_wakuren_202602010607.json", enumerated: 30, n: 10 },
  ] as const;

  for (const race of races) {
    describe(race.label, () => {
      const horses = racehorsesFromShutuba(race.shutuba);
      const parsed = parseComboOdds(loadFixture(race.odds), "bracketQuinella");
      // 前提(無条件): 取得できたオッズが空でないこと。
      expect(parsed.state).toBe("available");
      const realOdds = parsed.state === "available" ? toComboOddsScalarMap(parsed.odds) : new Map();

      it(`前提: ${race.n}頭で、枠番付きの馬が作れ、馬番と枠番が一致しない馬がいること(枠番を馬番として扱う変異を検出できる標本)`, () => {
        expect(horses.length).toBe(race.n);
        expect(horses.filter((h) => h.wakuban !== h.umaban).length).toBeGreaterThan(0);
      });

      it(`enumeratedCountが枠構成から導いた期待値(${race.enumerated})に一致し、expectedBracketQuinellaComboCountとも一致すること`, () => {
        const build = buildBracketQuinellaCandidates(horses, 3, realOdds, ALL_POSITIVE);
        expect(race.enumerated).toBe(expectedBracketQuinellaComboCount(horses.map((h) => h.wakuban)));
        expect(build.diagnostics.enumeratedCount).toBe(race.enumerated);
      });

      it("実オッズのキー集合と列挙した枠の組が過不足なく一致すること(未取得0・欠損0・不正0で、全件が判定されたこと)", () => {
        const build = buildBracketQuinellaCandidates(horses, 3, realOdds, ALL_POSITIVE);
        expect(realOdds.size).toBe(race.enumerated);
        const d = build.diagnostics;
        expect(d.unjudged).toEqual({ oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 });
        expect(d.judged.positiveCount + d.judged.notPositiveCount).toBe(race.enumerated);
        expect(d.judged.positiveCount).toBe(build.candidates.length);
      });

      it("候補のオッズが、そのキー('0407'等)で引いた実オッズと一致すること(同枠キーも含む)", () => {
        const build = buildBracketQuinellaCandidates(horses, 3, realOdds, ALL_POSITIVE);
        expect(build.candidates.length).toBeGreaterThan(0);
        for (const c of build.candidates) {
          expect(c.betType).toBe("bracketQuinella");
          expect(c.umabans[0]!).toBeLessThanOrEqual(c.umabans[1]!);
          expect(c.odds).toBe(realOdds.get(buildAllocationBetComboKey("bracketQuinella", c.umabans)));
        }
      });

      describe("★的中確率の恒等式(すべて製品のビルダー・allocateGeneralBets経由)", () => {
        const oddsMap = allFramePairsOddsMap(1000);
        const build = buildBracketQuinellaCandidates(horses, 3, oddsMap, ALL_POSITIVE);
        const bracketHp = hitProbByKey(build.candidates);

        it("前提: すべての枠の組が候補になり(hitProb>0)、列挙数と一致すること", () => {
          expect(build.candidates.length).toBe(race.enumerated);
          for (const p of bracketHp.values()) {
            expect(p).toBeGreaterThan(0);
          }
        });

        it("(1) 全枠組の的中確率の和が1であること(全頭がいずれかの枠に属する)", () => {
          let sum = 0;
          for (const p of bracketHp.values()) sum += p;
          expect(sum).toBeCloseTo(1, 10);
        });

        it("(2) 各枠組の的中確率が、その枠に属する馬どうしの馬連的中確率の和に一致すること(同枠は枠内の相異なる2頭の和)", () => {
          const quinella = buildQuinellaCandidates(
            horses,
            3,
            allUmabanPairsOddsMap(horses.map((h) => h.umaban), 1000),
            ALL_POSITIVE,
          );
          const q = new Map<string, number>();
          for (const c of quinella.candidates) q.set(c.umabans.join("-"), c.ev / c.odds);
          // 前提(無条件): 馬連の全ペアが得られていること。
          expect(quinella.candidates.length).toBe((race.n * (race.n - 1)) / 2);

          const horsesOf = (w: number) => horses.filter((h) => h.wakuban === w).map((h) => h.umaban);
          for (const c of build.candidates) {
            const [a, b] = c.umabans as [number, number];
            let expected = 0;
            if (a === b) {
              const hs = horsesOf(a);
              for (let i = 0; i < hs.length; i++) {
                for (let j = i + 1; j < hs.length; j++) {
                  expected += q.get(`${Math.min(hs[i]!, hs[j]!)}-${Math.max(hs[i]!, hs[j]!)}`)!;
                }
              }
            } else {
              for (const ha of horsesOf(a)) {
                for (const hb of horsesOf(b)) {
                  expected += q.get(`${Math.min(ha, hb)}-${Math.max(ha, hb)}`)!;
                }
              }
            }
            expect(c.ev / c.odds).toBeCloseTo(expected, 10);
          }
        });

        it("(3) allocateGeneralBetsのisHitが導く的中確率が、ビルダーの値と全候補で一致し、和が1であること", () => {
          const result = allocateGeneralBets(horses, 3, build.candidates, realConfig);
          expect(result.winOutcome).toEqual<WinOutcome>({ kind: "determined" });
          expect(result.allocations.length).toBe(race.enumerated);
          let sum = 0;
          for (const a of result.allocations) {
            expect(a.hitProb).toBeCloseTo(bracketHp.get(a.umabans.join("-"))!, 10);
            sum += a.hitProb;
          }
          expect(sum).toBeCloseTo(1, 10);
        });

        it("(3b) 他券種(単勝・複勝・馬連)と混在しても、枠連のhitProbは枠連単独のときと一致すること", () => {
          const others: AllocationCandidate[] = [
            { betType: "win", umabans: [1], odds: 5, ev: 2, isPositive: true },
            { betType: "place", umabans: [2], odds: 5, ev: 2, isPositive: true },
            { betType: "quinella", umabans: [1, 2], odds: 5, ev: 2, isPositive: true },
            { betType: "wide", umabans: [1, 3], odds: 5, ev: 2, isPositive: true },
          ];
          const result = allocateGeneralBets(horses, 3, [...others, ...build.candidates], realConfig);
          const bracketAllocs = result.allocations.filter((a) => a.betType === "bracketQuinella");
          expect(bracketAllocs.length).toBe(race.enumerated);
          for (const a of bracketAllocs) {
            expect(a.hitProb).toBeCloseTo(bracketHp.get(a.umabans.join("-"))!, 10);
          }
        });
      });
    });
  }

  it("10頭: 1頭だけの枠1に同枠 '0101' は存在せず、ビルダーは(オッズMapに0101があっても)[1,1]を候補にしないこと。枠7・8の同枠は候補になる", () => {
    const horses = racehorsesFromShutuba("shutuba_202602010607.html");
    // 前提(無条件): 枠1は1頭のみ、枠7・8は2頭。
    expect(horses.filter((h) => h.wakuban === 1).length).toBe(1);
    expect(horses.filter((h) => h.wakuban === 7).length).toBe(2);
    expect(horses.filter((h) => h.wakuban === 8).length).toBe(2);
    const oddsMap = allFramePairsOddsMap(1000);
    expect(oddsMap.has("0101")).toBe(true);
    const build = buildBracketQuinellaCandidates(horses, 3, oddsMap, ALL_POSITIVE);
    const keys = new Set(build.candidates.map((c) => c.umabans.join("-")));
    expect(keys.has("1-1")).toBe(false);
    expect(keys.has("7-7")).toBe(true);
    expect(keys.has("8-8")).toBe(true);
  });

  it("合成9頭(馬番8・9が枠8): enumeratedCount=29(=C(8,2)+同枠1)で、expectedBracketQuinellaComboCountと一致すること", () => {
    const horses: WakubanHorse[] = Array.from({ length: 9 }, (_, i) => ({
      umaban: i + 1,
      wakuban: Math.min(i + 1, 8),
      placeProb: 3 / 9,
    }));
    const build = buildBracketQuinellaCandidates(horses, 3, allFramePairsOddsMap(1000), ALL_POSITIVE);
    expect(expectedBracketQuinellaComboCount(horses.map((h) => h.wakuban))).toBe(29);
    expect(build.diagnostics.enumeratedCount).toBe(29);
    const sum = build.candidates.reduce((s, c) => s + c.ev / c.odds, 0);
    expect(build.candidates.length).toBe(29);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("8頭以下(各馬が別の枠。枠連の発売なし): オッズMapが空なら全組が未取得になり候補0件。coreに頭数の閾値を持たない", () => {
    const horses: WakubanHorse[] = Array.from({ length: 8 }, (_, i) => ({
      umaban: i + 1,
      wakuban: i + 1,
      placeProb: 3 / 8,
    }));
    const build = buildBracketQuinellaCandidates(horses, 3, new Map());
    expect(build.candidates).toEqual([]);
    expect(build.diagnostics.enumeratedCount).toBe(28);
    expect(build.diagnostics.unjudged.oddsUnfetchedCount).toBe(28);
    expect(build.diagnostics.judged).toEqual({ positiveCount: 0, notPositiveCount: 0 });
  });
});

describe("buildBracketQuinellaCandidates: オッズ4状態・EV閾値・退化入力・契約違反", () => {
  it("欠損(null)・未取得(キー無し)・不正(1.0未満)を別々に数え、候補にしないこと", () => {
    const odds = new Map<string, number | null>([
      ["0101", null], // 欠損
      // "0102" は未取得(キー無し)
      ["0202", 0.5], // 不正
    ]);
    const build = buildBracketQuinellaCandidates(STUB_HORSES, 3, odds, ALL_POSITIVE, STUB_MODEL);
    expect(build.candidates).toEqual([]);
    expect(build.diagnostics.enumeratedCount).toBe(3);
    expect(build.diagnostics.unjudged).toEqual({ oddsMissingCount: 1, oddsUnfetchedCount: 1, oddsMalformedCount: 1 });
    expect(build.diagnostics.judged).toEqual({ positiveCount: 0, notPositiveCount: 0 });
  });

  it("EV閾値の境界: ev=hitProb×odds が閾値ちょうどなら候補外(厳密不等号)、わずかに超えれば候補になること", () => {
    // {1,1}の的中確率は0.5。odds=2.0→ev=1.0(既定閾値1.0ちょうど)。
    const atThreshold = buildBracketQuinellaCandidates(STUB_HORSES, 3, new Map([["0101", 2.0]]), DEFAULT_EV_CONFIG, STUB_MODEL);
    expect(atThreshold.candidates).toEqual([]);
    expect(atThreshold.diagnostics.judged).toEqual({ positiveCount: 0, notPositiveCount: 1 });
    const above = buildBracketQuinellaCandidates(STUB_HORSES, 3, new Map([["0101", 2.2]]), DEFAULT_EV_CONFIG, STUB_MODEL);
    expect(above.candidates.length).toBe(1);
    expect(above.candidates[0]!.umabans).toEqual([1, 1]);
    expect(above.candidates[0]!.ev).toBeCloseTo(1.1, 12);
  });

  it("順序付き分布が判定不能(3頭・topFinishCount=3)のとき、throwせず候補0件で返すこと", () => {
    const horses: WakubanHorse[] = [
      { umaban: 1, wakuban: 1, placeProb: 0.9 },
      { umaban: 2, wakuban: 2, placeProb: 0.9 },
      { umaban: 3, wakuban: 3, placeProb: 0.9 },
    ];
    const build = buildBracketQuinellaCandidates(horses, 3, allFramePairsOddsMap(1000));
    expect(build.candidates).toEqual([]);
    expect(build.diagnostics.enumeratedCount).toBe(3);
    expect(build.diagnostics.judged).toEqual({ positiveCount: 0, notPositiveCount: 0 });
  });

  it("退化入力(0頭・1頭)でthrowせず候補0件になること(1頭は1枠1頭で同枠が無いため列挙0)", () => {
    expect(buildBracketQuinellaCandidates([], 3, allFramePairsOddsMap(1000)).diagnostics.enumeratedCount).toBe(0);
    const one = buildBracketQuinellaCandidates([{ umaban: 1, wakuban: 1, placeProb: 1 }], 3, allFramePairsOddsMap(1000));
    expect(one.candidates).toEqual([]);
    expect(one.diagnostics.enumeratedCount).toBe(0);
  });

  it("順序付き分布を作れないモデル(CONDITIONAL_BERNOULLI_MODEL)を渡すとthrowすること", () => {
    expect(() =>
      buildBracketQuinellaCandidates(STUB_HORSES, 3, allFramePairsOddsMap(1000), DEFAULT_EV_CONFIG, CONDITIONAL_BERNOULLI_MODEL),
    ).toThrow(/順序付きoutcome空間/);
  });

  it("topFinishCountが負・非有限ならthrowすること", () => {
    expect(() => buildBracketQuinellaCandidates(STUB_HORSES, -1, allFramePairsOddsMap(1000))).toThrow(/topFinishCount/);
    expect(() => buildBracketQuinellaCandidates(STUB_HORSES, Number.POSITIVE_INFINITY, allFramePairsOddsMap(1000))).toThrow(
      /topFinishCount/,
    );
  });

  it.each([
    ["欠落", undefined],
    ["0", 0],
    ["9", 9],
    ["小数", 1.5],
    ["NaN", Number.NaN],
  ])("wakubanが不正な馬(%s)がいるとthrowすること(呼び出し側が構築する引数の契約違反)", (_label, bad) => {
    const horses = [
      { umaban: 1, wakuban: 1, placeProb: 0.75 },
      { umaban: 2, wakuban: 1, placeProb: 0.75 },
      { umaban: 3, wakuban: 2, placeProb: 0.75 },
      { umaban: 4, wakuban: bad as unknown as number, placeProb: 0.75 },
    ];
    expect(() => buildBracketQuinellaCandidates(horses, 3, allFramePairsOddsMap(1000), ALL_POSITIVE, STUB_MODEL)).toThrow(
      /枠番/,
    );
  });
});

describe("allocateGeneralBets: 枠連の順序付き空間の前提(#112裁定2の踏襲)", () => {
  it("topFinishCount=1は、枠連の構成頭数(2)未満なのでthrowすること(2着が存在せずhitProbが黙って0になるのを防ぐ)", () => {
    expect(() => allocateGeneralBets(STUB_HORSES, 1, [bracket([1, 2])], realConfig, STUB_MODEL)).toThrow(
      /topFinishCountは2以上/,
    );
  });

  it("順序付きoutcome空間を作れないモデルではthrowすること(枠連単独でも順序展開を要する)", () => {
    expect(() =>
      allocateGeneralBets(STUB_HORSES, 3, [bracket([1, 2])], realConfig, CONDITIONAL_BERNOULLI_MODEL),
    ).toThrow(/順序付きoutcome空間/);
  });

  it("順序付き分布が判定不能(3頭・topFinishCount=3)のとき、枠連候補は最適化から除外され、winOutcomeがindeterminateになること", () => {
    const horses: WakubanHorse[] = [
      { umaban: 1, wakuban: 1, placeProb: 0.9 },
      { umaban: 2, wakuban: 2, placeProb: 0.9 },
      { umaban: 3, wakuban: 3, placeProb: 0.9 },
    ];
    const result = allocateGeneralBets(horses, 3, [bracket([1, 2])], realConfig);
    expect(result.winOutcome).toEqual<WinOutcome>({ kind: "indeterminate", reason: "top-k-covers-all-runners" });
    expect(result.allocations).toEqual([]);
  });
});

describe("buildComboCandidates: 枠連の専用門番(構成頭数2が wide と同じため、門番が無いと集合分布のワイドの的中確率・枠番を馬番と誤解した値で値付けされる)", () => {
  it("betType='bracketQuinella' を渡すとthrowし、メッセージに券種が入ること", () => {
    const horses: JointModelHorse[] = Array.from({ length: 6 }, (_, i) => ({ umaban: i + 1, placeProb: 0.5 }));
    expect(() => buildComboCandidates(horses, 3, "bracketQuinella", new Map())).toThrow(
      /buildComboCandidatesは組合せ\(ワイド・三連複\)専用の候補ビルダーです。.*枠連\(bracketQuinella\).*betType=bracketQuinella/,
    );
  });
});
