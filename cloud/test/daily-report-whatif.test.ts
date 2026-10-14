import { describe, expect, it } from "vitest";
import { unorderedComboKey, type RaceResultData } from "../src/daily-report-bets";
import {
  buildWhatIfStats,
  evaluateTemplates,
  MARK_TEMPLATES,
  mergeWhatIfStats,
  NEAR_MISS_LIMIT,
  pickNearMisses,
  TEMPLATE_STAKE,
  templateLabel,
  type TemplateOutcome,
} from "../src/daily-report-whatif";
import { formatTemplateStat, TEMPLATE_LABELS } from "../src/whatif-format";
import { buildComboOddsKey } from "../../packages/core/src/scraper/combo-odds-key.js";

/**
 * Issue #272: 日報の「もしも」(印の定型の買い方)。判定は既存の `judgeBets` に型の買い目を渡すだけで、ここでは
 *  - 型 → 買い目の変換(印が足りなければ対象外、同じ印が複数でも対象外)
 *  - 判定不能(結果・取込印・払戻が無い)と対象外が別の状態であること
 *  - 集計(判定できた点数だけが賭け金・回収率に入る)・合算(片方が null なら null)
 *  - 惜しかったレース(組合せ券種の型が的中したのに、同じ組合せを買っていない)
 * を固定する。
 */

const horses = (rows: ReadonlyArray<[number, number | null, number | null, number | null]>): RaceResultData["horses"] =>
  rows.map(([umaban, finishPosition, winPayout, placePayout]) => ({ umaban, finishPosition, winPayout, placePayout }));

/** ◎1 〇2 ▲3 が 1〜3 着。全券種の取込印あり。 */
const ALL_HIT: RaceResultData = {
  horses: horses([
    [1, 1, 450, 150],
    [2, 2, null, 210],
    [3, 3, null, 320],
    [4, 4, null, null],
  ]),
  combos: {
    wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }, { comboKey: "0103", payout: 1500 }, { comboKey: "0203", payout: 900 }] },
    quinella: { imported: true, payouts: [{ comboKey: "0102", payout: 1200 }] },
    trio: { imported: true, payouts: [{ comboKey: "010203", payout: 5000 }] },
  },
};

/** ◎(1 番)が着外で、払戻の組合せに 1 番を含まない(払戻の表は実際の着順に従う)。 */
const MISS_COMBOS: RaceResultData["combos"] = {
  wide: { imported: true, payouts: [{ comboKey: "0203", payout: 900 }] },
  quinella: { imported: true, payouts: [{ comboKey: "0203", payout: 1100 }] },
  trio: { imported: true, payouts: [{ comboKey: "020304", payout: 4000 }] },
};

const MARKS_123 = [{ mark: "◎", umaban: 1 }, { mark: "〇", umaban: 2 }, { mark: "▲", umaban: 3 }];
const byId = (outcomes: readonly TemplateOutcome[]): Record<string, TemplateOutcome> => Object.fromEntries(outcomes.map((o) => [o.id, o]));

describe("定型の一覧", () => {
  it("5 つで、順序と必要な印が固定(◎単勝・◎複勝・◎-〇ワイド・◎-〇馬連・◎〇▲の3連複)。賭け金は各 100 円", () => {
    expect(MARK_TEMPLATES.map((t) => [t.id, t.betType, t.marks.join("")])).toEqual([
      ["win", "win", "◎"],
      ["place", "place", "◎"],
      ["wide", "wide", "◎〇"],
      ["quinella", "quinella", "◎〇"],
      ["trio", "trio", "◎〇▲"],
    ]);
    expect(TEMPLATE_STAKE).toBe(100);
    expect(MARK_TEMPLATES.map((t) => templateLabel(t.id))).toEqual(["◎単勝", "◎複勝", "◎-〇ワイド", "◎-〇馬連", "◎〇▲の3連複"]);
  });

  it("組合せのキーは core の buildComboOddsKey と同じ(昇順・2 桁ゼロ埋め。順不同)", () => {
    for (const umabans of [[12, 3, 7], [3, 12], [1, 2, 3], [18, 1]]) {
      expect(unorderedComboKey(umabans)).toBe(buildComboOddsKey(umabans));
    }
  });
});

describe("evaluateTemplates: 型 → 買い目 → 判定", () => {
  it("◎〇▲が 1〜3 着で全券種の払戻がある: 5 型ぜんぶ的中。払戻は 100 円あたりの払戻そのまま", () => {
    const o = evaluateTemplates(MARKS_123, [], ALL_HIT);
    expect(o.map((x) => x.id)).toEqual(["win", "place", "wide", "quinella", "trio"]);
    expect(o.map((x) => [x.status, x.payout])).toEqual([["hit", 450], ["hit", 150], ["hit", 800], ["hit", 1200], ["hit", 5000]]);
  });

  it("印の馬番が昇順でなくても、ワイド・馬連・3 連複のキーは昇順に正規化して引く", () => {
    const result: RaceResultData = {
      horses: horses([[7, 1, 600, 180], [3, 2, null, 150], [12, 3, null, 400]]),
      combos: {
        wide: { imported: true, payouts: [{ comboKey: "0307", payout: 700 }] },
        quinella: { imported: true, payouts: [{ comboKey: "0307", payout: 1000 }] },
        trio: { imported: true, payouts: [{ comboKey: "030712", payout: 8000 }] },
      },
    };
    const o = byId(evaluateTemplates([{ mark: "◎", umaban: 7 }, { mark: "〇", umaban: 3 }, { mark: "▲", umaban: 12 }], [], result));
    expect([o.win!.status, o.place!.status, o.wide!.payout, o.quinella!.payout, o.trio!.payout]).toEqual(["hit", "hit", 700, 1000, 8000]);
  });

  it("◎が 5 着: 単勝・複勝ははずれ(払戻 0)。◎〇のワイド・馬連もはずれ", () => {
    const result: RaceResultData = { horses: horses([[1, 5, null, null], [2, 1, 300, 120], [3, 2, null, 130], [4, 3, null, 140]]), combos: MISS_COMBOS };
    const o = byId(evaluateTemplates(MARKS_123, [], result));
    expect([o.win!.status, o.win!.payout, o.place!.status, o.wide!.status, o.quinella!.status, o.trio!.status]).toEqual(["miss", 0, "miss", "miss", "miss", "miss"]);
  });

  it("◎〇だけ(▲なし): 3 連複は対象外。ほかの 4 型は判定できる", () => {
    const o = byId(evaluateTemplates(MARKS_123.slice(0, 2), [], ALL_HIT));
    expect(o.trio).toMatchObject({ status: "inapplicable", payout: 0 });
    expect([o.win!.status, o.place!.status, o.wide!.status, o.quinella!.status]).toEqual(["hit", "hit", "hit", "hit"]);
  });

  it("◎だけ: ワイド・馬連・3 連複は対象外、単勝・複勝は判定できる", () => {
    const o = byId(evaluateTemplates(MARKS_123.slice(0, 1), [], ALL_HIT));
    expect([o.win!.status, o.place!.status, o.wide!.status, o.quinella!.status, o.trio!.status]).toEqual(["hit", "hit", "inapplicable", "inapplicable", "inapplicable"]);
  });

  it("印が無い(◎が無い)・△☆注しか無い: 5 型ぜんぶ対象外。結果が無くても判定不能ではなく対象外", () => {
    for (const result of [ALL_HIT, undefined]) {
      for (const marks of [[], [{ mark: "△", umaban: 4 }, { mark: "☆", umaban: 5 }]]) {
        const o = evaluateTemplates(marks, [], result);
        expect(o).toHaveLength(5);
        expect(o.every((x) => x.status === "inapplicable" && x.payout === 0)).toBe(true);
      }
    }
  });

  it("同じ印が複数ある(データの異常): その印を要する型は対象外(先頭を黙って採らない)。▲が 2 頭なら 3 連複だけ対象外", () => {
    const twoHonmei = evaluateTemplates([{ mark: "◎", umaban: 1 }, { mark: "◎", umaban: 4 }, { mark: "〇", umaban: 2 }], [], ALL_HIT);
    expect(twoHonmei.every((x) => x.status === "inapplicable")).toBe(true);
    const twoTan = byId(evaluateTemplates([...MARKS_123, { mark: "▲", umaban: 4 }], [], ALL_HIT));
    expect([twoTan.win!.status, twoTan.wide!.status, twoTan.trio!.status]).toEqual(["hit", "hit", "inapplicable"]);
  });

  it("結果が無いレース(undefined): 印が揃った型は判定不能(対象外とは別)", () => {
    const o = evaluateTemplates(MARKS_123, [], undefined);
    expect(o.every((x) => x.status === "unjudged" && x.payout === 0)).toBe(true);
  });

  it("取込印が無い券種・取込済みで払戻が 0 件の券種は判定不能。単勝・複勝の払戻がある限りそちらは判定できる", () => {
    const result: RaceResultData = { ...ALL_HIT, combos: { wide: { imported: false, payouts: [] }, quinella: { imported: true, payouts: [] } } };
    const o = byId(evaluateTemplates(MARKS_123, [], result));
    expect([o.win!.status, o.place!.status, o.wide!.status, o.quinella!.status, o.trio!.status]).toEqual(["hit", "hit", "unjudged", "unjudged", "unjudged"]);
  });

  it("単勝の払戻が 1 頭にも無いレースは単勝だけ判定不能(複勝は判定できる)", () => {
    const result: RaceResultData = { ...ALL_HIT, horses: horses([[1, 1, null, 150], [2, 2, null, 210], [3, 3, null, 320]]) };
    const o = byId(evaluateTemplates(MARKS_123, [], result));
    expect([o.win!.status, o.place!.status]).toEqual(["unjudged", "hit"]);
  });

  it("買っていたか(bought): 的中した型の券種・組合せが実際の買い目にあるときだけ true。別の組合せ・別の券種は買っていないとする", () => {
    const actual = [{ betType: "wide", comboKey: "0102" }, { betType: "trio", comboKey: "010204" }, { betType: "quinella", comboKey: "0103" }];
    const o = byId(evaluateTemplates(MARKS_123, actual, ALL_HIT));
    expect(o.wide!.bought).toBe(true);
    expect(o.trio!.bought).toBeUndefined();
    expect(o.quinella!.bought).toBeUndefined();
    // はずれ・判定不能・対象外には bought を付けない
    const miss = byId(evaluateTemplates(MARKS_123, actual, { horses: horses([[1, 6, null, null], [2, 1, 300, 100]]), combos: MISS_COMBOS }));
    expect(miss.wide!.status).toBe("miss");
    expect(miss.wide!.bought).toBeUndefined();
  });
});

const o = (id: string, status: TemplateOutcome["status"], payout = 0, bought = false): TemplateOutcome => ({ id, status, payout, ...(bought ? { bought: true as const } : {}) });
const FIVE = (over: Record<string, TemplateOutcome>): TemplateOutcome[] =>
  MARK_TEMPLATES.map((t) => over[t.id] ?? o(t.id, "inapplicable"));

describe("buildWhatIfStats: 集計", () => {
  it("判定できた点数だけが賭け金(100 円/点)・払戻・回収率の元になる。判定不能と対象外は別に数える", () => {
    const stats = buildWhatIfStats([
      { templates: FIVE({ win: o("win", "hit", 450), place: o("place", "miss"), wide: o("wide", "unjudged") }) },
      { templates: FIVE({ win: o("win", "miss"), place: o("place", "hit", 150), wide: o("wide", "hit", 800) }) },
      { templates: FIVE({}) },
    ])!;
    expect(stats.win).toEqual({ betCount: 2, hitCount: 1, stake: 200, payout: 450, refundCount: 0, unjudgedCount: 0, inapplicableCount: 1 });
    expect(stats.place).toEqual({ betCount: 2, hitCount: 1, stake: 200, payout: 150, refundCount: 0, unjudgedCount: 0, inapplicableCount: 1 });
    expect(stats.wide).toEqual({ betCount: 1, hitCount: 1, stake: 100, payout: 800, refundCount: 0, unjudgedCount: 1, inapplicableCount: 1 });
    expect(stats.trio).toEqual({ betCount: 0, hitCount: 0, stake: 0, payout: 0, refundCount: 0, unjudgedCount: 0, inapplicableCount: 3 });
    // 5 型ぜんぶ必ず載る(形が固定)
    expect(Object.keys(stats)).toEqual(["win", "place", "wide", "quinella", "trio"]);
  });

  it("レースが 0 件でも 5 型ぜんぶ 0 で載る(null ではない)", () => {
    const stats = buildWhatIfStats([])!;
    expect(Object.keys(stats)).toHaveLength(5);
    expect(Object.values(stats).every((s) => s.betCount === 0 && s.inapplicableCount === 0)).toBe(true);
  });

  it("1 レースでも templates が無い(旧形のダイジェスト)なら null。一部だけの集計を返さない", () => {
    expect(buildWhatIfStats([{ templates: FIVE({}) }, {}])).toBeNull();
  });
});

describe("mergeWhatIfStats: 合算", () => {
  const a = buildWhatIfStats([{ templates: FIVE({ win: o("win", "hit", 450) }) }])!;
  const b = buildWhatIfStats([{ templates: FIVE({ win: o("win", "miss"), trio: o("trio", "unjudged") }) }])!;

  it("全項目を足す(率ではなく件数・金額を足す)", () => {
    const m = mergeWhatIfStats(a, b)!;
    expect(m.win).toEqual({ betCount: 2, hitCount: 1, stake: 200, payout: 450, refundCount: 0, unjudgedCount: 0, inapplicableCount: 0 });
    expect(m.trio).toEqual({ betCount: 0, hitCount: 0, stake: 0, payout: 0, refundCount: 0, unjudgedCount: 1, inapplicableCount: 1 });
  });

  it("片方が null なら null(欠けた分だけ小さい累計を作らない)", () => {
    expect(mergeWhatIfStats(a, null)).toBeNull();
    expect(mergeWhatIfStats(null, b)).toBeNull();
    expect(mergeWhatIfStats(null, null)).toBeNull();
  });
});

describe("pickNearMisses: 惜しかったレース", () => {
  const race = (raceId: string, over: Record<string, TemplateOutcome>) => ({ raceId, templates: FIVE(over) });

  it("組合せ券種の型(ワイド・馬連・3 連複)が的中し、買っていないレースだけ。単勝・複勝の的中や、買っていた的中は入れない", () => {
    const s = pickNearMisses([
      race("R1", { win: o("win", "hit", 450), place: o("place", "hit", 150) }),
      race("R2", { wide: o("wide", "hit", 800, true) }),
      race("R3", { wide: o("wide", "hit", 700) }),
      race("R4", { trio: o("trio", "miss") }),
    ])!;
    expect(s.total).toBe(1);
    expect(s.shown).toEqual([{ raceId: "R3", templateId: "wide", payout: 700 }]);
  });

  it("1 レースにつき 1 件(組合せ型のうち払戻が最大のもの)。同額なら先の型", () => {
    const s = pickNearMisses([race("R1", { wide: o("wide", "hit", 800), quinella: o("quinella", "hit", 1200), trio: o("trio", "hit", 5000) })])!;
    expect(s.shown).toEqual([{ raceId: "R1", templateId: "trio", payout: 5000 }]);
    const tie = pickNearMisses([race("R1", { wide: o("wide", "hit", 900), quinella: o("quinella", "hit", 900) })])!;
    expect(tie.shown[0]!.templateId).toBe("wide");
  });

  it(`払戻の多い順に最大 ${NEAR_MISS_LIMIT} 件。全件数(total)は上限を超えても数える。同額はレース ID 昇順`, () => {
    const races = [100, 900, 500, 900, 300].map((p, i) => race(`R${i + 1}`, { wide: o("wide", "hit", p) }));
    const s = pickNearMisses(races)!;
    expect(NEAR_MISS_LIMIT).toBe(3);
    expect(s.total).toBe(5);
    expect(s.shown.map((x) => [x.raceId, x.payout])).toEqual([["R2", 900], ["R4", 900], ["R3", 500]]);
  });

  it("該当が無ければ total 0・shown 空(null ではない)。templates が無いレースが 1 つでもあれば null", () => {
    expect(pickNearMisses([race("R1", {})])).toEqual({ total: 0, shown: [] });
    expect(pickNearMisses([race("R1", {}), { raceId: "R2" }])).toBeNull();
  });
});

describe("whatif-format: 型の名前と成績の文(サーバとクライアントで共有)", () => {
  const yen = (n: number): string => `${n.toLocaleString("en-US")}円`;

  it("表示名の一覧は型の定義と同じ id・同じ順序", () => {
    expect(TEMPLATE_LABELS.map(([id]) => id)).toEqual(MARK_TEMPLATES.map((t) => t.id));
    expect(templateLabel("zzz")).toBe("zzz"); // 未知の id は id のまま
  });

  it.each([
    ["判定できた型: 点数・的中・賭け金・払戻・回収率", { betCount: 38, hitCount: 7, stake: 3800, payout: 3150, unjudgedCount: 0, inapplicableCount: 0 }, "判定できた 38 レース中 7 的中・賭け金 3,800円・払戻 3,150円・回収率 82.9%"],
    ["判定不能と対象外は、あるときだけ添える", { betCount: 38, hitCount: 7, stake: 3800, payout: 3150, unjudgedCount: 2, inapplicableCount: 5 }, "判定できた 38 レース中 7 的中・賭け金 3,800円・払戻 3,150円・回収率 82.9%(判定不能 2 レース・対象外 5 レース)"],
    ["対象外だけ", { betCount: 1, hitCount: 0, stake: 100, payout: 0, unjudgedCount: 0, inapplicableCount: 3 }, "判定できた 1 レース中 0 的中・賭け金 100円・払戻 0円・回収率 0.0%(対象外 3 レース)"],
    ["判定できたレースが無いときは回収率を出さない(賭け金 0 で割らない)", { betCount: 0, hitCount: 0, stake: 0, payout: 0, unjudgedCount: 1, inapplicableCount: 0 }, "判定できたレースなし(判定不能 1 レース)"],
  ])("%s", (_name, stat, expected) => {
    expect(formatTemplateStat(stat, yen)).toBe(expected);
  });
});
