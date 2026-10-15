/**
 * repairMarks(予想印の補修。Issue #317)のテスト。
 *
 * 目的: LLM が印の規則(◎ちょうど1頭・〇▲は0〜1頭・△は0〜3頭・☆注は0〜1頭・本線は途切れない・未知の印文字なし)に
 * 違反しても、印を全消しせず「外れた部分だけ」直して、必ず規則を満たす印にする。
 *
 * 固定すること:
 *  - 表駆動: 違反の種類ごとの代表入力と、補修後の印・変更の記録(元の印→今の印)
 *  - 性質(固定シードの乱数で多数回): 補修後は必ず規則を満たす / 合法な入力は変えない / 冪等 / 印以外は不変 /
 *    本線の元の格の順序を保つ / 生成器が10種の違反をすべて実際に生んだ(空振りでない)
 */

import { describe, expect, it } from "vitest";
import {
  MARK_VIOLATION_KINDS,
  PREDICTION_MARKS,
  findMarkViolationKinds,
  type ParsedHorseResult,
  type PredictionMark,
} from "../../src/analyzer/parse-response.js";
import { repairMarks, type MarkOrigin } from "../../src/analyzer/repair-marks.js";

/** 補修に関係する項目だけを変える馬を作る(他の項目は固定値)。 */
function horse(umaban: number, adjustedProb: number, mark: PredictionMark | null): ParsedHorseResult {
  return {
    umaban,
    prior: 0.3,
    adjustedProb,
    reason: `根拠${umaban}`,
    highlights: [`強み${umaban}`],
    concerns: [`弱み${umaban}`],
    clipped: umaban % 2 === 0,
    usedPrior: false,
    mark,
  };
}

/** 馬番 → 補修後の印。 */
function marksOf(horses: readonly ParsedHorseResult[]): Record<number, PredictionMark | null> {
  return Object.fromEntries(horses.map((h) => [h.umaban, h.mark]));
}

interface Row {
  readonly name: string;
  /** [馬番, 補正後の3着内率, 元の印]。 */
  readonly input: ReadonlyArray<readonly [number, number, PredictionMark | null]>;
  /** 未知の印文字だった馬番。 */
  readonly unknown?: readonly number[];
  /** 補修後の印(馬番 → 印)。 */
  readonly expected: Record<number, PredictionMark | null>;
  /** 変更の記録(馬番 → [元の印, 今の印])。これ以外の馬は変わらない。 */
  readonly changes: Record<number, readonly [MarkOrigin, PredictionMark | null]>;
}

const ROWS: readonly Row[] = [
  {
    name: "合法(◎〇▲△△): 何も変えない",
    input: [[1, 0.5, "◎"], [2, 0.4, "〇"], [3, 0.3, "▲"], [4, 0.2, "△"], [5, 0.1, "△"], [6, 0.05, null]],
    expected: { 1: "◎", 2: "〇", 3: "▲", 4: "△", 5: "△", 6: null },
    changes: {},
  },
  {
    name: "合法(◎のみ + ☆ + 注): 何も変えない",
    input: [[1, 0.5, "◎"], [2, 0.4, "☆"], [3, 0.3, "注"], [4, 0.2, null]],
    expected: { 1: "◎", 2: "☆", 3: "注", 4: null },
    changes: {},
  },
  {
    name: "over-◎: ◎が2頭 → 率の高い方が◎、低い方は〇へ繰り下げ(〇にいた馬はさらに▲へ)",
    input: [[1, 0.5, "◎"], [2, 0.45, "◎"], [3, 0.3, "〇"], [4, 0.2, null]],
    expected: { 1: "◎", 2: "〇", 3: "▲", 4: null },
    changes: { 2: ["◎", "〇"], 3: ["〇", "▲"] },
  },
  {
    name: "over-◎: ◎が2頭で率が逆(馬番の大きい方が高い) → 高い方が◎",
    input: [[1, 0.4, "◎"], [2, 0.5, "◎"]],
    expected: { 1: "〇", 2: "◎" },
    changes: { 1: ["◎", "〇"] },
  },
  {
    name: "over-◎: ◎が2頭で率が同じ → 馬番の小さい方が◎",
    input: [[1, 0.4, "◎"], [2, 0.4, "◎"]],
    expected: { 1: "◎", 2: "〇" },
    changes: { 2: ["◎", "〇"] },
  },
  {
    name: "over-〇: 〇が2頭 → 率の高い方が〇、低い方は▲",
    input: [[1, 0.5, "◎"], [2, 0.3, "〇"], [3, 0.35, "〇"]],
    expected: { 1: "◎", 2: "▲", 3: "〇" },
    changes: { 2: ["〇", "▲"] },
  },
  {
    name: "over-▲: ▲が2頭 → 高い方が▲、低い方は△",
    input: [[1, 0.5, "◎"], [2, 0.4, "〇"], [3, 0.3, "▲"], [4, 0.35, "▲"]],
    expected: { 1: "◎", 2: "〇", 3: "△", 4: "▲" },
    changes: { 3: ["▲", "△"] },
  },
  {
    name: "over-△: △が4頭 → 率の高い3頭が△、最も低い1頭は印なし",
    input: [[1, 0.5, "◎"], [2, 0.4, "〇"], [3, 0.3, "▲"], [4, 0.25, "△"], [5, 0.2, "△"], [6, 0.15, "△"], [7, 0.1, "△"]],
    expected: { 1: "◎", 2: "〇", 3: "▲", 4: "△", 5: "△", 6: "△", 7: null },
    changes: { 7: ["△", null] },
  },
  {
    name: "over-☆: ☆が2頭 → 率の高い方を残し、低い方は印なし",
    input: [[1, 0.5, "◎"], [2, 0.1, "☆"], [3, 0.2, "☆"]],
    expected: { 1: "◎", 2: null, 3: "☆" },
    changes: { 2: ["☆", null] },
  },
  {
    name: "over-注: 注が3頭 → 最も率の高い1頭だけ残す",
    input: [[1, 0.5, "◎"], [2, 0.1, "注"], [3, 0.2, "注"], [4, 0.15, "注"]],
    expected: { 1: "◎", 2: null, 3: "注", 4: null },
    changes: { 2: ["注", null], 4: ["注", null] },
  },
  {
    name: "gap-〇: 〇なしの▲ → 上へ詰めて〇(△もつられて▲)",
    input: [[1, 0.5, "◎"], [2, 0.3, "▲"], [3, 0.2, "△"]],
    expected: { 1: "◎", 2: "〇", 3: "▲" },
    changes: { 2: ["▲", "〇"], 3: ["△", "▲"] },
  },
  {
    name: "gap-▲: ▲なしの△ → 上へ詰めて▲(△が3頭なら、うち1頭が▲に上がり△は2頭に)",
    input: [[1, 0.5, "◎"], [2, 0.4, "〇"], [3, 0.3, "△"], [4, 0.2, "△"], [5, 0.1, "△"]],
    expected: { 1: "◎", 2: "〇", 3: "▲", 4: "△", 5: "△" },
    changes: { 3: ["△", "▲"] },
  },
  {
    name: "gap-〇 + gap-▲ + ◎なし: 本線が△だけ → ◎〇▲と上から詰める",
    input: [[1, 0.5, "△"], [2, 0.4, "△"], [3, 0.3, "△"], [4, 0.2, null]],
    expected: { 1: "◎", 2: "〇", 3: "▲", 4: null },
    changes: { 1: ["△", "◎"], 2: ["△", "〇"], 3: ["△", "▲"] },
  },
  {
    name: "missing-◎: ◎なしで〇▲がある → 本線の最上位(〇)が◎に繰り上がる",
    input: [[1, 0.3, "▲"], [2, 0.5, "〇"], [3, 0.2, null]],
    expected: { 1: "〇", 2: "◎", 3: null },
    changes: { 1: ["▲", "〇"], 2: ["〇", "◎"] },
  },
  {
    name: "missing-◎: 本線が1頭も無く(☆のみ) → 全馬で率最大の馬が◎。その馬の☆は外れる",
    input: [[1, 0.5, "☆"], [2, 0.4, null], [3, 0.3, "注"]],
    expected: { 1: "◎", 2: null, 3: "注" },
    changes: { 1: ["☆", "◎"] },
  },
  {
    name: "missing-◎: 全馬が印なし(mark キー欠落の旧形式を含む) → 率最大の1頭だけ◎",
    input: [[1, 0.2, null], [2, 0.4, null], [3, 0.3, null]],
    expected: { 1: null, 2: "◎", 3: null },
    changes: { 2: ["なし", "◎"] },
  },
  {
    name: "missing-◎: 全馬が印なしで率が全て同じ → 馬番の小さい馬が◎",
    input: [[3, 0.3, null], [1, 0.3, null], [2, 0.3, null]],
    expected: { 1: "◎", 2: null, 3: null },
    changes: { 1: ["なし", "◎"] },
  },
  {
    name: "unknown-char: 未知の印の馬は印なし(他の印はそのまま)",
    input: [[1, 0.5, "◎"], [2, 0.4, null], [3, 0.3, "〇"]],
    unknown: [2],
    expected: { 1: "◎", 2: null, 3: "〇" },
    changes: { 2: ["不明", null] },
  },
  {
    name: "unknown-char: 未知の印だった馬が率最大で、本線が他に無い → ◎に昇格(元は「不明」と記録)",
    input: [[1, 0.5, null], [2, 0.4, null]],
    unknown: [1],
    expected: { 1: "◎", 2: null },
    changes: { 1: ["不明", "◎"] },
  },
  {
    name: "1頭のレース: その馬が◎",
    input: [[7, 0.3, null]],
    expected: { 7: "◎" },
    changes: { 7: ["なし", "◎"] },
  },
  {
    name: "複合: ◎2頭 + 〇なしの▲ + △4頭 + ☆2頭 → すべて同時に直る",
    input: [
      [1, 0.50, "◎"], [2, 0.48, "◎"], [3, 0.40, "▲"],
      [4, 0.30, "△"], [5, 0.28, "△"], [6, 0.26, "△"], [7, 0.24, "△"],
      [8, 0.10, "☆"], [9, 0.12, "☆"], [10, 0.05, null],
    ],
    // 本線の並び(格 → 率): ◎1 ◎2 ▲3 △4 △5 △6 △7 → 枠 ◎〇▲△△△ にそのまま詰める(△7は枠外)。
    expected: { 1: "◎", 2: "〇", 3: "▲", 4: "△", 5: "△", 6: "△", 7: null, 8: null, 9: "☆", 10: null },
    changes: { 2: ["◎", "〇"], 7: ["△", null], 8: ["☆", null] },
  },
];

describe("repairMarks(表駆動)", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const horses = row.input.map(([u, p, m]) => horse(u, p, m));
      const r = repairMarks(horses, row.unknown ?? []);
      expect(marksOf(r.horses)).toEqual(row.expected);
      // 変更の記録は、実際に印が変わった馬だけ(元の印が「不明」の馬は、結果が印なしでも変更)。
      const expectedChanges = Object.entries(row.changes)
        .filter(([, [from, to]]) => from !== (to ?? "なし"))
        .map(([u, [from, to]]) => ({ umaban: Number(u), from, to }))
        .sort((a, b) => a.umaban - b.umaban);
      expect([...r.changes].sort((a, b) => a.umaban - b.umaban)).toEqual(expectedChanges);
      // 補修後は必ず規則を満たす。
      expect(findMarkViolationKinds(r.horses, 0)).toEqual([]);
    });
  }

  it("表の前提: 少なくとも1行は「変更が1件以上」で、合法な行は2行だけ(空振りでない)", () => {
    const changed = ROWS.filter((row) => Object.keys(row.changes).length > 0);
    expect(changed.length).toBe(ROWS.length - 2);
  });
});

describe("repairMarks(印以外は変えない・入力を壊さない)", () => {
  it("確率・根拠・強調材料・懸念事項・clipped・usedPrior・prior は一切変わらない。入力の配列も書き換えない", () => {
    const input = [horse(1, 0.5, "◎"), horse(2, 0.45, "◎"), horse(3, 0.3, "☆"), horse(4, 0.2, "☆")];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = repairMarks(input, []);
    // 前提: 実際に印が変わっている(変わらないなら以下が自明に成立する)。
    expect(r.changes.length).toBeGreaterThanOrEqual(1);
    expect(input).toEqual(snapshot);
    for (const [i, h] of r.horses.entries()) {
      const { mark: _m1, ...before } = input[i]!;
      const { mark: _m2, ...after } = h;
      expect(after).toEqual(before);
    }
    // 順序(入力の並び)も保つ。
    expect(r.horses.map((h) => h.umaban)).toEqual(input.map((h) => h.umaban));
  });

  it("馬が0頭なら何もしない(空配列を返し、変更なし)", () => {
    const r = repairMarks([], []);
    expect(r.horses).toEqual([]);
    expect(r.changes).toEqual([]);
  });
});

// ---- 性質テスト(固定シードの乱数) ----

/** 再現できる乱数(mulberry32)。 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  readonly horses: ParsedHorseResult[];
  readonly unknown: number[];
}

/** 印の割り当てが荒い(違反しやすい)入力を作る。率は 4 値だけにして、同値(タイブレーク)を頻発させる。 */
function generate(rand: () => number): Generated {
  const n = 1 + Math.floor(rand() * 18);
  const probs = [0.1, 0.2, 0.3, 0.4];
  const marksPool: ReadonlyArray<PredictionMark | null | "unknown"> = [...PREDICTION_MARKS, null, null, "unknown"];
  const horses: ParsedHorseResult[] = [];
  const unknown: number[] = [];
  for (let u = 1; u <= n; u++) {
    const pick = marksPool[Math.floor(rand() * marksPool.length)]!;
    // 印を付ける確率を下げる(全馬に印が付くと、◎過多ばかりになる)。
    const kept = rand() < 0.45 ? pick : null;
    if (kept === "unknown") {
      unknown.push(u);
      horses.push(horse(u, probs[Math.floor(rand() * probs.length)]!, null));
    } else {
      horses.push(horse(u, probs[Math.floor(rand() * probs.length)]!, kept));
    }
  }
  return { horses, unknown };
}

/** 規則を満たす入力を作る(◎1頭 + 〇▲0〜1 + △0〜3 + ☆注0〜1。馬の割り当てはランダム)。 */
function generateLegal(rand: () => number): Generated {
  const n = 1 + Math.floor(rand() * 18);
  const order = Array.from({ length: n }, (_, i) => i + 1).sort(() => rand() - 0.5);
  const slots: Array<PredictionMark> = ["◎"];
  if (rand() < 0.7) slots.push("〇");
  if (slots.length === 2 && rand() < 0.7) slots.push("▲");
  if (slots.length === 3) for (let i = Math.floor(rand() * 4); i > 0; i--) slots.push("△");
  if (rand() < 0.4) slots.push("☆");
  if (rand() < 0.4) slots.push("注");
  const marks = new Map<number, PredictionMark>();
  slots.slice(0, n).forEach((m, i) => marks.set(order[i]!, m));
  const probs = [0.1, 0.2, 0.3, 0.4];
  return {
    horses: Array.from({ length: n }, (_, i) => horse(i + 1, probs[Math.floor(rand() * probs.length)]!, marks.get(i + 1) ?? null)),
    unknown: [],
  };
}

const TRIALS = 3000;

describe("repairMarks(性質テスト。固定シード・多数回)", () => {
  const rand = prng(317);
  const cases: Generated[] = Array.from({ length: TRIALS }, () => generate(rand));

  it("生成器の前提: 10種の違反がすべて、実際に1回以上生まれている(空振りでない)", () => {
    const seen = new Set<string>();
    let violating = 0;
    for (const c of cases) {
      const kinds = findMarkViolationKinds(c.horses, c.unknown.length);
      if (kinds.length > 0) violating++;
      for (const k of kinds) seen.add(k);
    }
    expect([...seen].sort()).toEqual([...MARK_VIOLATION_KINDS].sort());
    expect(MARK_VIOLATION_KINDS).toHaveLength(10);
    // 違反しない入力も含まれている(両方が混ざった母集団)。
    expect(violating).toBeGreaterThan(TRIALS * 0.5);
    expect(violating).toBeLessThan(TRIALS);
  });

  it("補修後は必ず規則を満たす(◎ちょうど1・〇▲0〜1・△0〜3・☆注0〜1・本線は途切れない)", () => {
    for (const c of cases) {
      const r = repairMarks(c.horses, c.unknown);
      expect(findMarkViolationKinds(r.horses, 0), JSON.stringify(c)).toEqual([]);
      expect(r.horses.filter((h) => h.mark === "◎")).toHaveLength(1);
    }
  });

  it("冪等: 補修した結果をもう一度補修しても、何も変わらない", () => {
    for (const c of cases) {
      const once = repairMarks(c.horses, c.unknown);
      const twice = repairMarks(once.horses, []);
      expect(twice.changes).toEqual([]);
      expect(marksOf(twice.horses)).toEqual(marksOf(once.horses));
    }
  });

  it("印以外の項目は、すべての入力で変わらない", () => {
    for (const c of cases) {
      const r = repairMarks(c.horses, c.unknown);
      expect(r.horses.map(({ mark: _m, ...rest }) => rest)).toEqual(c.horses.map(({ mark: _m, ...rest }) => rest));
    }
  });

  it("変更の記録は、実際に印が変わった馬と過不足なく一致する(元の印が「不明」の馬は必ず変更として載る)", () => {
    for (const c of cases) {
      const r = repairMarks(c.horses, c.unknown);
      const originOf = (h: ParsedHorseResult): MarkOrigin => (c.unknown.includes(h.umaban) ? "不明" : h.mark ?? "なし");
      const expected = c.horses
        .map((h, i) => ({ umaban: h.umaban, from: originOf(h), to: r.horses[i]!.mark }))
        .filter((x) => x.from !== (x.to ?? "なし"));
      expect(r.changes).toEqual(expected);
    }
  });

  it("本線の順序を保つ: 補修後に印の格が違う2頭は、元の印の格の高低が逆転しない(元が本線の馬どうしで比べる)", () => {
    const tier: Record<string, number> = { "◎": 0, "〇": 1, "▲": 2, "△": 3 };
    let compared = 0;
    for (const c of cases) {
      const r = repairMarks(c.horses, c.unknown);
      const origMark = new Map(c.horses.map((h) => [h.umaban, c.unknown.includes(h.umaban) ? null : h.mark]));
      const after = r.horses.filter((h) => h.mark !== null && h.mark in tier);
      for (const a of after) {
        for (const b of after) {
          const oa = origMark.get(a.umaban);
          const ob = origMark.get(b.umaban);
          if (oa === null || oa === undefined || ob === null || ob === undefined || !(oa in tier) || !(ob in tier)) continue;
          if (tier[a.mark!]! < tier[b.mark!]!) {
            expect(tier[oa]!).toBeLessThanOrEqual(tier[ob]!);
            compared++;
          }
        }
      }
    }
    // 前提: 比較が実際に行われた(空振りでない)。
    expect(compared).toBeGreaterThan(1000);
  });

  it("合法な入力は一切変えない(変更0件・印が同一)", () => {
    const r2 = prng(318);
    const legal = Array.from({ length: TRIALS }, () => generateLegal(r2));
    for (const c of legal) {
      expect(findMarkViolationKinds(c.horses, 0)).toEqual([]); // 前提: 生成器が本当に合法な入力を作っている。
      const r = repairMarks(c.horses, []);
      expect(r.changes).toEqual([]);
      expect(marksOf(r.horses)).toEqual(marksOf(c.horses));
    }
  });
});
