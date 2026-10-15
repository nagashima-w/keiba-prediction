import { describe, expect, it } from "vitest";
import type { AnalysisDetail, AnalysisHorse } from "../client/api-analysis";
import { PREDICTION_MARKS } from "../../packages/core/src/analyzer/parse-response";
import { buildReplayInit, drawFinishOrder, finalRanksOf, rankingAt, REPLAY_SPREAD, startRanksOf } from "../client/replay-model";

/**
 * Issue #311(レース再生): 純関数 — 着順の抽選(AC2)・再生の材料(`buildReplayInit`)。
 * (位置の計算は Issue #314 で `replay-plan.ts` の `planRace`/`frameAt` に置き換わった。テストは `client-replay-plan.test.ts`。)
 * 演出であって、確率・配分・保存される値は変えない(読むだけ)。
 */

/** 固定の種の乱数(mulberry32)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 値を順に返す乱数(使い切ったら投げる=想定より多く引いたことを検出する)。 */
function seq(values: readonly number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i];
    if (v === undefined) throw new Error("乱数を引きすぎ");
    i += 1;
    return v;
  };
}

const item = (strength: number, fallback = 0.1) => ({ strength, fallback });

describe("drawFinishOrder(Plackett-Luce の逐次抽選。AC2)", () => {
  it("固定の乱数に対する結果: 強さ [0.5, 0.3, 0.2]・乱数 [0.0, 0.7, 0.0] → 0 番目が1着、残り(重み 0.3・0.2、合計 0.5)で 0.7×0.5=0.35 > 0.3 なので 2 番目が2着、最後に 1 番目", () => {
    expect(drawFinishOrder([item(0.5), item(0.3), item(0.2)], seq([0.0, 0.7, 0.0]))).toEqual([0, 2, 1]);
  });

  it("乱数が大きいほど後ろの馬が選ばれる(0.999 は最後の馬が1着)。最後の1頭の選択では乱数を引かない(頭数 − 1 回だけ引く)", () => {
    const draws: number[] = [];
    const rng = () => {
      draws.push(0.999);
      return 0.999;
    };
    expect(drawFinishOrder([item(0.5), item(0.3), item(0.2)], rng)).toEqual([2, 1, 0]);
    expect(draws.length).toBe(2);
  });

  it("着順は 0〜n−1 の並べ替え(重複・欠落なし)。多数回の抽選でも常に", () => {
    const rng = mulberry32(1);
    const items = [item(0.4), item(0.25), item(0.15), item(0.1), item(0.07), item(0.03)];
    for (let k = 0; k < 500; k++) {
      const order = drawFinishOrder(items, rng);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    }
  });

  it("頻度: 1着の頻度が強さ(勝率)に一致する(N=20000・種固定。許容は二項の標準偏差の 5 倍)", () => {
    const strengths = [0.5, 0.3, 0.15, 0.05];
    const items = strengths.map((s) => item(s));
    const N = 20000;
    const rng = mulberry32(42);
    const first = [0, 0, 0, 0];
    for (let k = 0; k < N; k++) first[drawFinishOrder(items, rng)[0]!]! += 1;
    strengths.forEach((p, i) => {
      const sd = Math.sqrt((p * (1 - p)) / N);
      expect(Math.abs(first[i]! / N - p), `馬${i}の1着頻度 ${first[i]! / N} と勝率 ${p}`).toBeLessThan(5 * sd);
    });
    // 前提: 許容幅が頻度の差より十分小さい(5σ が最小の勝率 0.05 の 1/3 未満)=空振りしない
    expect(5 * Math.sqrt((0.05 * 0.95) / N)).toBeLessThan(0.05 / 3);
  });

  it("頻度: 2着の頻度が Σ_j p_j·p_i/(1−p_j)(Plackett-Luce)に一致する。強さを無視した一様な抽選では一致しない", () => {
    const strengths = [0.5, 0.3, 0.15, 0.05];
    const items = strengths.map((s) => item(s));
    const N = 20000;
    const rng = mulberry32(7);
    const second = [0, 0, 0, 0];
    for (let k = 0; k < N; k++) second[drawFinishOrder(items, rng)[1]!]! += 1;
    const expected = strengths.map((pi, i) => strengths.reduce((acc, pj, j) => (j === i ? acc : acc + (pj * pi) / (1 - pj)), 0));
    expect(expected.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10); // 前提: 確率の和は 1
    strengths.forEach((_, i) => {
      const p = expected[i]!;
      const sd = Math.sqrt((p * (1 - p)) / N);
      expect(Math.abs(second[i]! / N - p), `馬${i}の2着頻度 ${second[i]! / N} と期待 ${p}`).toBeLessThan(5 * sd);
    });
    // 前提: 一様(0.25)との差が許容幅より十分大きい(最も強い馬で 0.25 との差が 5σ を超える)
    expect(Math.abs(expected[0]! - 0.25)).toBeGreaterThan(5 * Math.sqrt((expected[0]! * (1 - expected[0]!)) / N));
  });

  it("合計が 1 でない強さでも比で抽選する(全部 2 倍にしても同じ結果)", () => {
    const a = drawFinishOrder([item(0.5), item(0.3), item(0.2)], mulberry32(3));
    const b = drawFinishOrder([item(5), item(3), item(2)], mulberry32(3));
    expect(a).toEqual(b);
  });

  it("強さ 0 の馬は、強さのある馬がいる間は選ばれない(末尾に回る)", () => {
    const rng = mulberry32(5);
    for (let k = 0; k < 200; k++) {
      const order = drawFinishOrder([item(0), item(0.6), item(0), item(0.4)], rng);
      expect(new Set(order.slice(0, 2))).toEqual(new Set([1, 3]));
      expect(new Set(order.slice(2))).toEqual(new Set([0, 2]));
    }
  });

  it("強さが残りすべて 0 になったら、fallback(adjustedProb)を重みにする。fallback の大きい馬が先に来やすい", () => {
    // 1 頭だけ強さ 1(固定馬)。残りは強さ 0 で、fallback = [0.9, 0.05, 0.05]。
    const items = [item(1, 0.3), item(0, 0.9), item(0, 0.05), item(0, 0.05)];
    const rng = mulberry32(11);
    let secondIsOne = 0;
    const N = 4000;
    for (let k = 0; k < N; k++) {
      const order = drawFinishOrder(items, rng);
      expect(order[0]).toBe(0);
      if (order[1] === 1) secondIsOne += 1;
    }
    // 期待 0.9/(0.9+0.05+0.05) = 0.9。一様なら 1/3。
    const sd = Math.sqrt((0.9 * 0.1) / N);
    expect(Math.abs(secondIsOne / N - 0.9)).toBeLessThan(5 * sd);
  });

  it("強さも fallback も全部 0・NaN・負なら一様に抽選する(投げない。並べ替えにはなる)", () => {
    const rng = mulberry32(9);
    const counts = [0, 0, 0];
    for (let k = 0; k < 3000; k++) {
      const order = drawFinishOrder([{ strength: 0, fallback: 0 }, { strength: Number.NaN, fallback: -1 }, { strength: -2, fallback: Number.NaN }], rng);
      expect([...order].sort()).toEqual([0, 1, 2]);
      counts[order[0]!]! += 1;
    }
    for (const c of counts) expect(Math.abs(c / 3000 - 1 / 3)).toBeLessThan(5 * Math.sqrt(((1 / 3) * (2 / 3)) / 3000));
    expect(Math.min(...counts), "前提: どの馬も1着になる(定数化の変異を検出できる)").toBeGreaterThan(0);
  });

  it("退化: 0 頭は []・1 頭は [0](乱数を引かない)", () => {
    expect(drawFinishOrder([], seq([]))).toEqual([]);
    expect(drawFinishOrder([item(1)], seq([]))).toEqual([0]);
  });
});

describe("startRanksOf(スタート直後の順位。0 が先頭)", () => {
  it("earlyPos の小さい順(前の馬ほど先頭)。同値は並び順の若い方が前", () => {
    expect(startRanksOf([0.5, 0.1, 0.9, 0.1])).toEqual([2, 0, 3, 1]);
  });

  it("null は、値のある馬の中央値で補う(中団に置く)。偶数頭の中央値は中央 2 つの平均", () => {
    // 既知 [0.2, 0.4, 0.6, 0.8] の中央値 0.5。null(添字 4)は 0.4 と 0.6 の間。
    expect(startRanksOf([0.2, 0.4, 0.6, 0.8, null])).toEqual([0, 1, 3, 4, 2]);
  });

  it("null の補完は『値のある馬の中央値』であって 0.5 固定ではない(中央値が 0.5 以外の入力)", () => {
    // 既知 [0.1, 0.2, 0.3] の中央値 0.2。null(添字 3)は 0.2 と同値になり、同値は添字の若い方が前なので、添字 1 の次・添字 2 の前に入る。
    // 0.5 固定なら null は最後尾(0.3 より後)になる。
    expect(startRanksOf([0.1, 0.2, 0.3, null])).toEqual([0, 1, 3, 2]);
    // 既知が大きい側に寄る入力: 中央値 0.8(0.5 固定なら null は先頭になる)
    expect(startRanksOf([0.7, 0.8, 0.9, null])).toEqual([0, 1, 3, 2]);
  });

  it("全馬 null は全員同値で、並び順どおり(馬番順)", () => {
    expect(startRanksOf([null, null, null])).toEqual([0, 1, 2]);
  });

  it("頭数 0・1", () => {
    expect(startRanksOf([])).toEqual([]);
    expect(startRanksOf([null])).toEqual([0]);
  });

  it("結果は 0〜n−1 の並べ替え", () => {
    const ranks = startRanksOf([0.3, null, 0.3, 0.05, null, 0.99]);
    expect([...ranks].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("finalRanksOf(着順 → 馬ごとの最終順位)", () => {
  it("着順(馬の添字を1着から並べたもの)の逆写像", () => {
    expect(finalRanksOf([2, 0, 3, 1])).toEqual([1, 3, 0, 2]);
  });
});

describe("rankingAt(位置の降順の馬の添字。同位置は添字の若い順)", () => {
  it("降順に並べる", () => {
    expect(rankingAt([0.2, 0.9, 0.5])).toEqual([1, 2, 0]);
    expect(rankingAt([0.5, 0.5])).toEqual([0, 1]);
    expect(rankingAt([])).toEqual([]);
  });
});

function horse(umaban: number, over: Partial<AnalysisHorse> = {}): AnalysisHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.3, adjustedProb: 0.25, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: 0.1, fairWinOdds: 8, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, earlyPos: null, ...over };
}

function analysis(horses: AnalysisHorse[], race: Partial<AnalysisDetail["race"]> = {}): AnalysisDetail {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テスト", grade: null, oddsStatus: "result", placeBasis: "top3", distance: 1800, ...race } as AnalysisDetail["race"],
    horses,
    allocation: null,
    detail: "present",
  } as AnalysisDetail;
}

describe("buildReplayInit(再生の材料)", () => {
  const four = (): AnalysisHorse[] => [horse(1, { winProb: 0.4, adjustedProb: 0.6, earlyPos: 0.1 }), horse(2, { winProb: 0.3, adjustedProb: 0.5, earlyPos: 0.5 }), horse(3, { winProb: 0.2, adjustedProb: 0.4 }), horse(4, { winProb: 0.1, adjustedProb: 0.2, earlyPos: 0.9 })];

  it("馬ごとに、強さ(winProb)・fallback(adjustedProb)・開始位置(earlyPos)・馬番・馬名を写す。分析 id・距離・回りも", () => {
    const init = buildReplayInit(analysis(four(), { turn: "left" }));
    expect(init).toEqual({
      analysisId: 7,
      distance: 1800,
      turn: "left",
      focus: 0,
      horses: [
        { umaban: 1, name: "馬1", strength: 0.4, fallback: 0.6, early: 0.1, style: "先行" },
        { umaban: 2, name: "馬2", strength: 0.3, fallback: 0.5, early: 0.5, style: "差し" },
        { umaban: 3, name: "馬3", strength: 0.2, fallback: 0.4, early: null, style: "差し" },
        { umaban: 4, name: "馬4", strength: 0.1, fallback: 0.2, early: 0.9, style: "追込" },
      ],
      pace: "不明",
    });
  });

  it("脚質(Issue #314): legStyle があればそれを使う(earlyPos と食い違っても legStyle が優先)。想定ペース(race.pace)も写す", () => {
    const horses = [horse(1, { legStyle: "逃げ", earlyPos: 0.9 }), horse(2, { legStyle: "追込", earlyPos: 0.1 }), horse(3, { legStyle: "先行" }), horse(4, { legStyle: "差し" })];
    const init = buildReplayInit(analysis(horses, { pace: "ハイ" }));
    expect(init?.horses.map((h) => h.style)).toEqual(["逃げ", "追込", "先行", "差し"]);
    expect(init?.pace).toBe("ハイ");
    for (const pace of ["スロー", "平均", "不明"] as const) {
      expect(buildReplayInit(analysis(horses, { pace }))?.pace).toBe(pace);
    }
  });

  it("脚質が無い馬(デプロイ前の分析・判定不能)は earlyPos から粗く決める(≤1/3 先行・≤2/3 差し・それ以外 追込。逃げは決めない)。境界を含む", () => {
    const table: ReadonlyArray<readonly [number | null, string]> = [
      [0, "先行"],
      [0.05, "先行"],
      [1 / 3, "先行"],
      [0.334, "差し"],
      [2 / 3, "差し"],
      [0.667, "追込"],
      [1, "追込"],
    ];
    for (const [early, expected] of table) {
      const init = buildReplayInit(analysis([horse(1, { earlyPos: early, legStyle: null }), horse(2), horse(3)]));
      expect(init?.horses[0]!.style, `earlyPos=${early}`).toBe(expected);
    }
  });

  it("脚質も earlyPos も無い馬は「差し」(中団)。legStyle のキー自体が無い(古い固定データ)場合も", () => {
    const horses = [horse(1, { earlyPos: null }), horse(2, { earlyPos: null }), horse(3, { earlyPos: null })];
    delete (horses[1] as { legStyle?: unknown }).legStyle;
    const init = buildReplayInit(analysis(horses));
    expect(init?.horses.map((h) => h.style)).toEqual(["差し", "差し", "差し"]);
    expect(init?.horses.every((h) => h.style !== "逃げ")).toBe(true);
  });

  it("race.pace が無い(古い固定データ)は「不明」", () => {
    const a = analysis(four());
    delete (a.race as { pace?: unknown }).pace;
    expect(buildReplayInit(a)?.pace).toBe("不明");
  });

  it("turn が無ければ right。距離が無ければ null", () => {
    const init = buildReplayInit(analysis(four(), { distance: null }));
    expect(init?.turn).toBe("right");
    expect(init?.distance).toBeNull();
  });

  it("勝率が判定不能(全馬 winProb が null)なら null(ボタンを出さない)", () => {
    expect(buildReplayInit(analysis(four().map((h) => horse(h.umaban, { winProb: null }))))).toBeNull();
  });

  it("1頭でも winProb が null なら null(一部だけで抽選しない)", () => {
    const horses = four();
    horses[2] = horse(3, { winProb: null });
    expect(buildReplayInit(analysis(horses))).toBeNull();
  });

  it("winProb の合計が 0 以下・非有限・負が混じるなら null", () => {
    expect(buildReplayInit(analysis(four().map((h) => horse(h.umaban, { winProb: 0 }))))).toBeNull();
    expect(buildReplayInit(analysis([horse(1, { winProb: -0.1 }), horse(2, { winProb: 0.5 }), horse(3, { winProb: 0.3 }), horse(4, { winProb: 0.3 })]))).toBeNull();
    expect(buildReplayInit(analysis([horse(1, { winProb: Number.NaN }), horse(2), horse(3), horse(4)]))).toBeNull();
  });

  it("2頭未満(0頭・1頭)は null", () => {
    expect(buildReplayInit(analysis([]))).toBeNull();
    expect(buildReplayInit(analysis([horse(1, { winProb: 1 })]))).toBeNull();
  });

  it("winProb が 0 の馬は残す(固定馬 1 頭のレース。強さ 0 の馬も走る)。earlyPos が undefined(古い固定データ)は null", () => {
    const horses = [horse(1, { winProb: 1 }), horse(2, { winProb: 0 }), horse(3, { winProb: 0 })];
    delete (horses[0] as { earlyPos?: unknown }).earlyPos;
    const init = buildReplayInit(analysis(horses));
    expect(init?.horses.map((h) => [h.umaban, h.strength, h.early])).toEqual([[1, 1, null], [2, 0, null], [3, 0, null]]);
  });

  it("詳細なし(馬名が null)でも作れる", () => {
    const init = buildReplayInit(analysis(four().map((h) => horse(h.umaban, { name: null }))));
    expect(init?.horses.every((h) => h.name === null)).toBe(true);
  });
});

describe("buildReplayInit の強調する馬(Issue #316。先頭の判定で色を切り替えず、始めから終わりまで同じ馬を塗る)", () => {
  const MAIN = PREDICTION_MARKS[0];
  /** 馬番 1〜n、勝率と印を指定して作る(winProb の合計は 0 より大きい)。 */
  const field = (rows: readonly (readonly [number, number, string | null])[]): AnalysisHorse[] => rows.map(([umaban, winProb, mark]) => horse(umaban, { winProb, mark }));
  const focusUmaban = (horses: AnalysisHorse[]): number => {
    const init = buildReplayInit(analysis(horses));
    expect(init, "前提: 再生できる分析").not.toBeNull();
    return init!.horses[init!.focus]!.umaban;
  };

  it("前提: 本命の印は core の PREDICTION_MARKS の先頭(◎)", () => {
    expect(MAIN).toBe("◎");
  });

  const TABLE: readonly { name: string; horses: AnalysisHorse[]; expected: number }[] = [
    { name: "◎が 1 頭: 勝率が最大でなくても◎の馬", horses: field([[1, 0.4, null], [2, 0.3, MAIN], [3, 0.2, "〇"], [4, 0.1, null]]), expected: 2 },
    { name: "◎が最低勝率の馬でも◎の馬", horses: field([[1, 0.4, "〇"], [2, 0.3, null], [3, 0.2, null], [4, 0.1, MAIN]]), expected: 4 },
    { name: "◎なし(印はあるが◎以外): 勝率が最も高い馬", horses: field([[1, 0.2, "〇"], [2, 0.4, "▲"], [3, 0.3, "△"], [4, 0.1, "☆"]]), expected: 2 },
    { name: "印なし(全員 null・LLM 無効の分析): 勝率が最も高い馬", horses: field([[1, 0.2, null], [2, 0.1, null], [3, 0.5, null], [4, 0.2, null]]), expected: 3 },
    { name: "◎が複数: ◎の中で勝率が高い方(◎でない最高勝率の馬は選ばない)", horses: field([[1, 0.5, null], [2, 0.1, MAIN], [3, 0.3, MAIN], [4, 0.1, null]]), expected: 3 },
    { name: "◎が複数で勝率も同値: 馬番の小さい方", horses: field([[1, 0.3, null], [2, 0.2, MAIN], [3, 0.2, MAIN], [4, 0.3, null]]), expected: 2 },
    { name: "◎なしで最高勝率が同値: 馬番の小さい方(並び順ではなく馬番)", horses: field([[3, 0.4, null], [1, 0.1, null], [2, 0.4, null], [4, 0.1, null]]), expected: 2 },
    { name: "印が空白だけ・未知の文字列は◎として扱わない", horses: field([[1, 0.1, " "], [2, 0.5, "?"], [3, 0.2, ""], [4, 0.2, null]]), expected: 2 },
  ];
  for (const c of TABLE) {
    it(c.name, () => {
      expect(focusUmaban(c.horses)).toBe(c.expected);
    });
  }

  it("同じ分析からは何度作っても同じ馬(「もう一度再生」「別の展開で再生」でも変わらない。抽選に依らない)", () => {
    const a = analysis(field([[1, 0.4, null], [2, 0.3, MAIN], [3, 0.2, null], [4, 0.1, null]]));
    const picks = [0, 1, 2, 3, 4].map(() => buildReplayInit(a)!.focus);
    expect(picks).toEqual([1, 1, 1, 1, 1]);
  });
});
