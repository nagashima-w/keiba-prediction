/**
 * prior の頭数正規化(Issue #258 第1段): 乗算スケール → **ロジットシフト**。
 *
 * 旧: クランプした raw の合計が目標から ±10% を超えたときだけ、全馬に同じ倍率を掛けていた。
 *     「近走着順」の補正が全馬で平均 +0.061 プラスに偏る(素点が中立値 0.33 を平均 0.63 で上回る)ため、
 *     倍率は 1 より小さくなり、レース内の広がり(sd)を中央値で 0.77 倍に縮めていた。
 * 新: 各馬の raw を [minPrior, maxPrior] に収めてから logit に変え、**全馬に共通の c を足して**
 *     Σ clamp(sigmoid(logit_i + c), minPrior, maxPrior) = min(targetPlaceCount, 頭数) になる c を求める。
 *     共通項を足すだけなので、クランプに当たらない馬どうしのロジット差(オッズ比)は保たれる(確率の差は保たれない)。
 *
 * ## 旧テストとの保証の対応(書き換えた箇所)
 * | 旧(乗算)の保証 | 新(ロジットシフト)での扱い |
 * |---|---|
 * | 全馬同一データ → 全馬同一 prior(prior.test.ts) | 無改変で維持。純関数側でも「全馬同一 raw → 全馬 目標/頭数」で固定 |
 * | 全馬が強いとき Σ が 3 付近に戻る(2.7〜3.3。prior.test.ts) | 無改変で維持。純関数側では Σ=目標を 10 桁で固定(許容 ±10% のゲートを撤去したため、常に一致する) |
 * | 飽和した 1 頭が平均馬を巻き添えにしない(prior-calibration.test.ts) | 無改変で維持。純関数側でも「天井に当たった馬は固定され、残りが同じ c で動く」を KKT 条件で固定 |
 * | scale>1 の発動と maxPrior への再クランプ(prior-calibration.test.ts。0.125・0.95 の乗算の数値を固定) | 乗算の数値は無意味になるため、性質(Σ=目標・ロジット差の保存・順序・範囲)に書き換え。天井への飽和は純関数側の別テストで実効化 |
 * | Σ が目標の ±10% 以内なら何もしない(許容。固定値 Σ=3.04。probability-quality-regression.test.ts) | **意図して反転**: 常に Σ=目標。許容の撤去により 3.04 は 3.0 になる(純関数側「許容内でも補正される」) |
 */

import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SCORER_CONFIG, type PriorConfig } from "../../src/scorer/config.js";
import { normalizeFieldPriors } from "../../src/scorer/prior.js";

const CFG: PriorConfig = DEFAULT_SCORER_CONFIG.prior;
const logit = (p: number): number => Math.log(p / (1 - p));
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);

/** i 番目を 0 始まりの等間隔で並べる(決定的な入力の作成用)。 */
function linspace(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

describe("normalizeFieldPriors: Σ が目標(min(3,頭数))に常に一致する", () => {
  const cases: ReadonlyArray<{ name: string; raws: number[]; target: number }> = [
    { name: "18頭・実測に近い分布(平均 0.31 で目標 3 を大きく上回る)", raws: linspace(0.05, 0.7, 18), target: 3 },
    { name: "8頭・全馬低め(Σ が目標を下回り、持ち上げる)", raws: linspace(0.08, 0.2, 8), target: 3 },
    { name: "16頭・全馬高め", raws: linspace(0.3, 0.6, 16), target: 3 },
    { name: "4頭(目標 3。天井 0.95 に当たらない範囲)", raws: [0.5, 0.7, 0.9, 0.94], target: 3 },
    { name: "旧ゲートの許容(±10%)の内側: Σraw=3.04 でも 3.0 に揃う", raws: [0.04, 0.3, 0.5, 0.6, 0.8, 0.8], target: 3 },
  ];
  it.each(cases)("$name", ({ raws, target }) => {
    const out = normalizeFieldPriors(raws, CFG);
    expect(out).toHaveLength(raws.length);
    expect(sum(out)).toBeCloseTo(target, 10);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(CFG.minPrior);
      expect(v).toBeLessThanOrEqual(CFG.maxPrior);
    }
  });

  it("許容内ケースの前提: 入力の Σ は目標 3 の ±10% 以内で、かつ 3 ちょうどではない(旧版ならゲートで素通しだった)", () => {
    const raws = [0.04, 0.3, 0.5, 0.6, 0.8, 0.8];
    const clamped = raws.map((v) => clamp(v, CFG.minPrior, CFG.maxPrior));
    const dev = Math.abs(sum(clamped) - 3) / 3;
    expect(dev).toBeGreaterThan(0.001); // 3 ちょうどではない
    expect(dev).toBeLessThanOrEqual(0.1); // 旧ゲートの内側
  });

  it("Σraw がちょうど目標なら、何も動かさない(c=0)", () => {
    const raws = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.9];
    expect(sum(raws)).toBeCloseTo(3, 12); // 前提を固定
    const out = normalizeFieldPriors(raws, CFG);
    out.forEach((v, i) => expect(v).toBeCloseTo(raws[i]!, 9));
  });
});

describe("normalizeFieldPriors: 広がりを保つ(クランプに当たらない馬どうしのロジット差が保存される)", () => {
  // 実測に近い分布: 平均 0.31 で、Σ が目標を大きく上回る → 共通項 c は大きく負。
  const raws = linspace(0.08, 0.55, 18);
  let out: number[] = [];
  beforeAll(() => {
    out = normalizeFieldPriors(raws, CFG);
  });

  it("前提: 全馬がクランプの内側に収まっている(床・天井に当たっていない)", () => {
    for (const v of out) {
      expect(v).toBeGreaterThan(CFG.minPrior);
      expect(v).toBeLessThan(CFG.maxPrior);
    }
  });

  it("前提: 共通項 c は 0 から十分に離れている(差の保存が自明にならない)", () => {
    const c = logit(out[0]!) - logit(raws[0]!);
    expect(Math.abs(c)).toBeGreaterThan(0.2);
  });

  it("前提: 馬どうしのロジット差は 0 から十分に離れている(差が全て 0 ではない)", () => {
    const gap = logit(raws[17]!) - logit(raws[0]!);
    expect(gap).toBeGreaterThan(2);
  });

  it("全ての馬の対で logit(出力) の差 = logit(raw) の差になる", () => {
    for (let i = 0; i < raws.length; i++) {
      for (let j = i + 1; j < raws.length; j++) {
        const before = logit(raws[j]!) - logit(raws[i]!);
        const after = logit(out[j]!) - logit(out[i]!);
        expect(after).toBeCloseTo(before, 9);
      }
    }
  });

  it("旧(乗算)が縮めていた確率差の比を再現しない: 最大と最小の比が raw の logit 差から決まる", () => {
    // 確率の差ではなくオッズ比が保存される(乗算は p の比を保つが、広がりを縮めた)。
    const oddsRatioBefore = Math.exp(logit(raws[17]!) - logit(raws[0]!));
    const oddsRatioAfter = Math.exp(logit(out[17]!) - logit(out[0]!));
    expect(oddsRatioAfter / oddsRatioBefore).toBeCloseTo(1, 9);
  });
});

describe("normalizeFieldPriors: 順序の保存", () => {
  it("クランプに当たらない範囲では厳密に増加する(同値を新たに作らない)", () => {
    const raws = linspace(0.1, 0.65, 16);
    const out = normalizeFieldPriors(raws, CFG);
    // 前提(無条件): 全馬が範囲の内側 → クランプによる同値は生まれえない。
    for (const v of out) {
      expect(v).toBeGreaterThan(CFG.minPrior);
      expect(v).toBeLessThan(CFG.maxPrior);
    }
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    }
  });

  it("入力の並び順(馬の順序)を保つ: 入力の i 番目の結果が i 番目に返る", () => {
    const raws = [0.5, 0.1, 0.4, 0.2, 0.6, 0.3, 0.05, 0.7];
    const out = normalizeFieldPriors(raws, CFG);
    // 前提: 入力が昇順でも降順でもない並び。
    expect(raws[0]! > raws[1]!).toBe(true);
    expect(raws[1]! < raws[2]!).toBe(true);
    for (let i = 0; i < raws.length; i++) {
      for (let j = 0; j < raws.length; j++) {
        if (raws[i]! < raws[j]!) {
          expect(out[i]!).toBeLessThanOrEqual(out[j]!);
        }
      }
    }
    // 最大の raw が最大の出力、最小の raw が最小の出力。
    expect(out.indexOf(Math.max(...out))).toBe(raws.indexOf(Math.max(...raws)));
    expect(out.indexOf(Math.min(...out))).toBe(raws.indexOf(Math.min(...raws)));
  });
});

describe("normalizeFieldPriors: 床・天井に当たった馬は固定され、残りが同じ c で動く(水詰め)", () => {
  it("床: Σ が目標を上回り c が大きく負 → 低い馬は minPrior に固定、他の馬は共通の c", () => {
    const raws = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.03, 0.03, 0.03, 0.03];
    const out = normalizeFieldPriors(raws, CFG);
    // 前提(無条件): 低い 4 頭が床に固定されている。
    const atFloor = out.filter((v) => v === CFG.minPrior);
    expect(atFloor).toHaveLength(4);
    expect(out.slice(6)).toEqual([CFG.minPrior, CFG.minPrior, CFG.minPrior, CFG.minPrior]);
    // 残り 6 頭は床にも天井にもいない。
    for (const v of out.slice(0, 6)) {
      expect(v).toBeGreaterThan(CFG.minPrior);
      expect(v).toBeLessThan(CFG.maxPrior);
    }
    expect(sum(out)).toBeCloseTo(3, 10);
    // KKT: 固定されていない馬は同じ c を共有する。
    const cs = out.slice(0, 6).map((v, i) => logit(v) - logit(raws[i]!));
    for (const c of cs) {
      expect(c).toBeCloseTo(cs[0]!, 9);
    }
    // 前提: c は床に押し込む十分な大きさの負(自明でない)。
    expect(cs[0]!).toBeLessThan(-0.4);
  });

  it("天井: Σ が目標を下回り c が正 → 突出馬は maxPrior に固定、他の馬は共通の c", () => {
    const raws = [0.94, ...new Array(7).fill(0.15)];
    const out = normalizeFieldPriors(raws, CFG);
    // 前提(無条件): 突出馬が天井に固定されている。
    expect(out[0]).toBe(CFG.maxPrior);
    for (const v of out.slice(1)) {
      expect(v).toBeGreaterThan(CFG.minPrior);
      expect(v).toBeLessThan(CFG.maxPrior);
    }
    expect(sum(out)).toBeCloseTo(3, 10);
    // 残り 7 頭は raw が同じなので出力も同じで、(3−0.95)/7 になる。
    for (const v of out.slice(1)) {
      expect(v).toBeCloseTo((3 - CFG.maxPrior) / 7, 10);
    }
    // c は正(持ち上げ)で、突出馬は c を足すと天井を超える(固定が実効している)。
    const c = logit(out[1]!) - logit(0.15);
    expect(c).toBeGreaterThan(0.2);
    expect(logit(0.94) + c).toBeGreaterThan(logit(CFG.maxPrior));
  });

  it("raw が天井を大きく超える馬 1 頭が、平均馬を巻き添えにしない(旧「巻き添え防止」と同じ性質)", () => {
    const raws = [3.0, ...new Array(15).fill(0.1875)];
    const out = normalizeFieldPriors(raws, CFG);
    // 突出馬は天井近くのまま(raw は maxPrior に収めてから logit にするため、c が負でも 0.9 を割らない)。
    expect(out[0]).toBeGreaterThan(0.9);
    expect(out[0]).toBeLessThanOrEqual(CFG.maxPrior);
    // 平均馬は中立 0.1875 から大きくは下がらない。
    for (const v of out.slice(1)) {
      expect(v).toBeGreaterThan(0.13);
      expect(v).toBeLessThanOrEqual(0.1875);
    }
    expect(sum(out)).toBeCloseTo(3, 10);
  });
});

describe("normalizeFieldPriors: 範囲外・退化した入力", () => {
  it("raw ≤ 0 や ≥ 1 は logit の前に [minPrior, maxPrior] に収める(同じ値に収まった馬は同じ出力)", () => {
    const raws = [-0.2, 0, 0.015, 0.3, 0.4, 0.5, 0.95, 1.0, 1.3, 0.2];
    const out = normalizeFieldPriors(raws, CFG);
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(CFG.minPrior);
      expect(v).toBeLessThanOrEqual(CFG.maxPrior);
    }
    expect(sum(out)).toBeCloseTo(3, 10);
    // 前提: 下側 3 頭(−0.2・0・0.015)は全て minPrior 以下で、上側 3 頭(0.95・1.0・1.3)は maxPrior 以上。
    expect(raws.slice(0, 3).every((v) => v <= CFG.minPrior)).toBe(true);
    expect(raws.slice(6, 9).every((v) => v >= CFG.maxPrior)).toBe(true);
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
    expect(out[6]).toBe(out[7]);
    expect(out[7]).toBe(out[8]);
    // それでも下側より上側のほうが大きい(順序は壊れない)。
    expect(out[6]!).toBeGreaterThan(out[0]!);
  });

  it("全馬同一の raw → 全馬 目標/頭数(同一入力は同一出力)", () => {
    const out = normalizeFieldPriors(new Array(16).fill(0.3), CFG);
    for (const v of out) {
      expect(v).toBeCloseTo(3 / 16, 10);
    }
  });

  it("実現不能: 頭数 3 以下では Σ=目標に届かず、全頭 maxPrior に飽和する(throw しない)", () => {
    expect(normalizeFieldPriors([0.5, 0.3, 0.2], CFG)).toEqual([0.95, 0.95, 0.95]);
    expect(normalizeFieldPriors([0.4], CFG)).toEqual([0.95]);
    expect(normalizeFieldPriors([0.4, 0.1], CFG)).toEqual([0.95, 0.95]);
    // 前提: 目標は頭数に等しく、天井では届かない(実現不能が実効している)。
    expect(3 * CFG.maxPrior).toBeLessThan(3);
  });

  it("実現不能: 目標が床の合計以下なら全頭 minPrior に飽和する(throw しない)", () => {
    const cfg: PriorConfig = { ...CFG, targetPlaceCount: 0.1 };
    const out = normalizeFieldPriors(new Array(10).fill(0.3), cfg);
    // 前提: 10 頭 × 0.02 = 0.2 > 目標 0.1(実現不能)。
    expect(10 * cfg.minPrior).toBeGreaterThan(cfg.targetPlaceCount);
    expect(out).toEqual(new Array(10).fill(cfg.minPrior));
  });

  it("頭数 0 は空配列", () => {
    expect(normalizeFieldPriors([], CFG)).toEqual([]);
  });

  it("targetPlaceCount を目標に使う(2 → Σ=2)", () => {
    const cfg: PriorConfig = { ...CFG, targetPlaceCount: 2 };
    const out = normalizeFieldPriors(linspace(0.1, 0.5, 10), cfg);
    expect(sum(out)).toBeCloseTo(2, 10);
  });
});

describe("normalizeFieldPriors: 非有限(NaN)の raw が混ざっても、影響はその馬だけに留まる", () => {
  // 旧実装は NaN の馬だけが NaN になり、他の馬は(正規化されないまま)有限の値を返した。
  // 新実装で二分法が NaN で壊れ、他の全頭が maxPrior に張り付く退行を防ぐ(メタレビュー)。
  const finiteRaws = [0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.45, 0.5, 0.28, 0.33];
  const withNaN = [Number.NaN, ...finiteRaws];

  it("前提: 有限の 11 頭だけを渡した場合の Σ は目標 3 になり、全頭が天井に張り付かない", () => {
    const base = normalizeFieldPriors(finiteRaws, CFG);
    expect(sum(base)).toBeCloseTo(3, 10);
    expect(Math.max(...base)).toBeLessThan(CFG.maxPrior);
    // 空振り防止: 入力の Σ は目標と大きく異なる(正規化が実際に働く)。
    expect(Math.abs(sum(finiteRaws) - 3)).toBeGreaterThan(0.1);
  });

  it("12 頭中 1 頭が NaN: その馬は NaN のまま、残りの 11 頭は有限で、maxPrior に張り付かない", () => {
    const out = normalizeFieldPriors(withNaN, CFG);
    expect(out).toHaveLength(12);
    expect(Number.isNaN(out[0]!)).toBe(true);
    const rest = out.slice(1);
    for (const v of rest) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeLessThan(CFG.maxPrior);
      expect(v).toBeGreaterThanOrEqual(CFG.minPrior);
    }
    // 前提(無条件): 残りは互いに異なる値(全頭が同値に潰れていない)。
    expect(new Set(rest.map((v) => v.toFixed(9))).size).toBeGreaterThan(5);
  });

  it("有限の馬は、NaN の馬が無かった場合と同じ値になる(有限の馬だけで Σ を目標に合わせる)", () => {
    const out = normalizeFieldPriors(withNaN, CFG);
    const base = normalizeFieldPriors(finiteRaws, CFG);
    out.slice(1).forEach((v, i) => expect(v).toBeCloseTo(base[i]!, 12));
    expect(sum(out.slice(1))).toBeCloseTo(3, 10);
  });

  it("NaN が複数・末尾・途中にあっても、その馬だけが NaN", () => {
    const raws = [0.4, Number.NaN, 0.35, 0.3, Number.NaN, 0.25, 0.2, 0.15, 0.1, 0.45];
    const out = normalizeFieldPriors(raws, CFG);
    raws.forEach((r, i) => {
      expect(Number.isNaN(out[i]!)).toBe(Number.isNaN(r));
    });
    const finite = out.filter((v) => !Number.isNaN(v));
    expect(finite).toHaveLength(8);
    expect(sum(finite)).toBeCloseTo(3, 10);
    for (const v of finite) expect(v).toBeLessThan(CFG.maxPrior);
  });

  it("全頭 NaN: throw せず、全頭 NaN を返す", () => {
    const out = normalizeFieldPriors(new Array(8).fill(Number.NaN), CFG);
    expect(out).toHaveLength(8);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("有限の馬が目標より少ない(2 頭だけ有限): 実現不能として天井に飽和し、NaN の馬は NaN のまま", () => {
    const raws = [Number.NaN, 0.5, Number.NaN, 0.3, Number.NaN, Number.NaN];
    const out = normalizeFieldPriors(raws, CFG);
    expect(out[1]).toBe(CFG.maxPrior);
    expect(out[3]).toBe(CFG.maxPrior);
    expect([0, 2, 4, 5].every((i) => Number.isNaN(out[i]!))).toBe(true);
  });

  it("±Infinity は NaN ではなく、片側にクランプされる(従来どおり)", () => {
    const out = normalizeFieldPriors([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.4, 0.3, 0.2, 0.25, 0.35, 0.15], CFG);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(sum(out)).toBeCloseTo(3, 10);
    expect(out[0]!).toBeGreaterThan(out[1]!);
  });
});

describe("normalizeFieldPriors: 決定性と副作用", () => {
  it("同じ入力 → ビット一致の出力。入力配列は変更しない", () => {
    const raws = Object.freeze(linspace(0.05, 0.7, 18));
    const a = normalizeFieldPriors(raws, CFG);
    const b = normalizeFieldPriors(raws, CFG);
    expect(a).toEqual(b);
    expect(raws).toEqual(linspace(0.05, 0.7, 18));
  });
});

describe("PriorConfig: 旧ゲート(normalizeTolerance)は撤去された", () => {
  it("既定設定に normalizeTolerance が無い", () => {
    expect(Object.keys(DEFAULT_SCORER_CONFIG.prior)).not.toContain("normalizeTolerance");
    expect(Object.keys(DEFAULT_SCORER_CONFIG.prior).sort()).toEqual(
      ["biasCorrectionScale", "maxPrior", "minPrior", "targetPlaceCount"].sort(),
    );
  });
});
