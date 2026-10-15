import { describe, expect, it } from "vitest";
import { frameAt, LAT_STEP_RATIO, MOVE_START, PLAN_STEPS, planRace, type PlanGeometry, type PlanInput, type RacePlan } from "../client/replay-plan";
import type { LegStyle, PaceEstimate } from "../client/api-analysis";
import { rankingAt, REPLAY_SPREAD } from "../client/replay-model";

/**
 * Issue #314(レース再生の見た目の改善): 展開の前計算 `planRace`・コマの補間 `frameAt`。
 * 隊列の塊・動き出しの時機は**脚質と想定ペースで決まり、乱数に依らない**(乱数は横位置の目標だけ)。
 * 着順(`drawFinishOrder` の抽選)は変えず、ゴールの通過順 = 抽選した着順。
 * 受け入れ条件: AC1=通過順 / AC2=単調・ゴール通過 / AC3=横位置の連続 / AC4=抜く側が固定されない / AC5=隊列(脚質・ペース) / AC7=決定性。
 */

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

/** 丸 1 個分の大きさ(1600m・コース幅 0.238 のとき。`overlapGeometry(1600)` と同じ桁)。 */
const GEO: PlanGeometry = { along: 0.0235, across: 0.0483 / 0.19 };
const PACES: readonly PaceEstimate[] = ["ハイ", "平均", "スロー", "不明"];
const STYLES: readonly LegStyle[] = ["逃げ", "先行", "差し", "追込"];

function shuffled(n: number, rng: () => number): number[] {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 乱数で作る入力。脚質は開始順で 逃げ(1〜2 頭)→先行→差し→追込 の 3 分割(実際の分類に近い)。着順は無作為。 */
function randomInput(n: number, rng: () => number, pace: PaceEstimate): PlanInput {
  const early = Array.from({ length: n }, () => rng());
  const startRanks = early.map((v, i) => early.filter((w, j) => w < v || (w === v && j < i)).length);
  const runners = 1 + (rng() < 0.4 ? 1 : 0);
  const styles = startRanks.map((r): LegStyle => (r < runners ? "逃げ" : r / n <= 1 / 3 ? "先行" : r / n <= 2 / 3 ? "差し" : "追込"));
  const order = shuffled(n, rng);
  const finalRanks: number[] = Array(n).fill(0);
  order.forEach((h, r) => (finalRanks[h] = r));
  return { styles, startRanks, finalRanks, gates: [...Array(n).keys()], pace };
}

/** 脚質を開始順と独立に無作為に割り付けた入力(本番に近い。開始順が前なのに追込、など)。 */
function independentStyleInput(n: number, rng: () => number, pace: PaceEstimate): PlanInput {
  const base = randomInput(n, rng, pace);
  return { ...base, styles: base.styles.map(() => STYLES[Math.floor(rng() * 4)]!) };
}

/** 各脚質がそろう固定の入力(逃げ 2・先行 4・差し 5・追込 3 = 14 頭)。開始順は脚質の順、着順は引数。 */
function groupedInput(pace: PaceEstimate, order?: readonly number[]): PlanInput {
  const styles: LegStyle[] = [...Array(2).fill("逃げ"), ...Array(4).fill("先行"), ...Array(5).fill("差し"), ...Array(3).fill("追込")];
  const n = styles.length;
  const ord = order ?? [...Array(n).keys()];
  const finalRanks: number[] = Array(n).fill(0);
  ord.forEach((h, r) => (finalRanks[h] = r));
  return { styles, startRanks: [...Array(n).keys()], finalRanks, gates: [...Array(n).keys()], pace };
}

/** 馬 i が x=1 に届く進み具合(コマ内は線形補間)。届かなければ Infinity。 */
function crossTime(plan: RacePlan, i: number): number {
  const xs = plan.x[i]!;
  for (let s = 0; s < plan.steps; s++) {
    if (xs[s + 1]! >= 1) return (s + (1 - xs[s]!) / (xs[s + 1]! - xs[s]!)) / plan.steps;
  }
  return Number.POSITIVE_INFINITY;
}

/** 追い越しの事象(コマ s で i が j を前に出た)。 */
function passes(plan: RacePlan): { i: number; j: number; s: number }[] {
  const out: { i: number; j: number; s: number }[] = [];
  const n = plan.x.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      for (let s = 1; s <= plan.steps; s++) {
        if (plan.x[i]![s - 1]! <= plan.x[j]![s - 1]! && plan.x[i]![s]! > plan.x[j]![s]!) out.push({ i, j, s });
      }
    }
  }
  return out;
}

describe("定数の前提", () => {
  it("刻みは 360。脚質の動き出しの時刻はハイ < 平均 < スロー(前の脚質は後退の開始、後方の脚質は進出の開始。脚質ごとに)", () => {
    expect(PLAN_STEPS).toBe(360);
    for (const style of STYLES) {
      expect(MOVE_START["ハイ"][style], style).toBeLessThan(MOVE_START["平均"][style]);
      expect(MOVE_START["平均"][style], style).toBeLessThan(MOVE_START["スロー"][style]);
    }
    for (const style of STYLES) {
      expect(MOVE_START["不明"][style], "不明は平均と同じ").toBe(MOVE_START["平均"][style]);
    }
  });
});

describe("AC1(ブロッキング): ゴールの通過順 = 抽選した着順", () => {
  it("n=2〜18・多数のシード・全ペースで、通過時刻が着順どおりに厳密に並ぶ", () => {
    let checked = 0;
    for (let n = 2; n <= 18; n++) {
      for (let seed = 1; seed <= 12; seed++) {
        const rng = mulberry32(seed * 1009 + n);
        const pace = PACES[(seed + n) % PACES.length]!;
        const input = randomInput(n, rng, pace);
        const plan = planRace(input, rng, GEO);
        const times = [...Array(n).keys()].map((i) => crossTime(plan, i));
        expect(times.every((t) => Number.isFinite(t) && t < 1), `n=${n} seed=${seed}: 全馬がゴールを通過する`).toBe(true);
        const byTime = [...Array(n).keys()].sort((a, b) => times[a]! - times[b]!);
        const byDraw = [...Array(n).keys()].sort((a, b) => input.finalRanks[a]! - input.finalRanks[b]!);
        expect(byTime, `n=${n} seed=${seed} pace=${pace}`).toEqual(byDraw);
        for (let r = 1; r < n; r++) {
          expect(times[byDraw[r]!]!, `n=${n} seed=${seed}: 同時に通過しない(厳密)`).toBeGreaterThan(times[byDraw[r - 1]!]!);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(17 * 12); // 前提: 空振りしていない
  });

  it("脚質を開始順と独立に割り付けた入力(後退の防御が効く入力)でも、通過順 = 着順。n=2〜18・全ペース", () => {
    let checked = 0;
    for (let n = 2; n <= 18; n++) {
      for (let seed = 1; seed <= 40; seed++) {
        const rng = mulberry32(seed * 7919 + n * 104729);
        const input = independentStyleInput(n, rng, PACES[seed % PACES.length]!);
        const plan = planRace(input, rng, GEO);
        const byTime = [...Array(n).keys()].sort((a, b) => crossTime(plan, a) - crossTime(plan, b));
        const byDraw = [...Array(n).keys()].sort((a, b) => input.finalRanks[a]! - input.finalRanks[b]!);
        expect(byTime, `n=${n} seed=${seed}`).toEqual(byDraw);
        checked += 1;
      }
    }
    expect(checked).toBe(17 * 40);
  });

  it("全馬が同じ脚質(集団が 1 つ)・全員逃げ・追込が 1 着でも、通過順 = 着順", () => {
    for (const style of STYLES) {
      for (const pace of PACES) {
        const n = 12;
        const rng = mulberry32(77);
        const input = { ...randomInput(n, rng, pace), styles: Array<LegStyle>(n).fill(style) };
        const plan = planRace(input, rng, GEO);
        const byTime = [...Array(n).keys()].sort((a, b) => crossTime(plan, a) - crossTime(plan, b));
        const byDraw = [...Array(n).keys()].sort((a, b) => input.finalRanks[a]! - input.finalRanks[b]!);
        expect(byTime, `${style} ${pace}`).toEqual(byDraw);
      }
    }
    // 最後尾の追込が 1 着(最も遠い所から全馬を抜く)
    const input = groupedInput("ハイ", [13, ...[...Array(13).keys()]]);
    const plan = planRace(input, mulberry32(5), GEO);
    expect(crossTime(plan, 13), "追込の最後尾が最初に通過する").toBeLessThan(Math.min(...[...Array(13).keys()].map((i) => crossTime(plan, i))));
  });
});

describe("AC2: 前方位置は後ろへ戻らない・最終で全馬がゴールを越える", () => {
  it("全馬・全コマで単調非減少(後退なし)。n=2〜18・全ペース", () => {
    let minStep = Number.POSITIVE_INFINITY;
    for (let n = 2; n <= 18; n++) {
      for (let seed = 1; seed <= 8; seed++) {
        const rng = mulberry32(seed * 31 + n);
        const plan = planRace(randomInput(n, rng, PACES[seed % PACES.length]!), rng, GEO);
        for (const xs of plan.x) {
          for (let s = 1; s <= plan.steps; s++) {
            const d = xs[s]! - xs[s - 1]!;
            minStep = Math.min(minStep, d);
            expect(d, `n=${n} seed=${seed} s=${s}`).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
    expect(Number.isFinite(minStep)).toBe(true); // 前提: 空振りしていない
  });

  it("脚質を開始順と独立に割り付けた入力でも、全馬・全コマで単調非減少(後退なし)。n=2〜18・全ペース・多数のシード(差し・ハイの後退と揺らぎの重なりで、ごく小さな逆行が出うる入力)", () => {
    let plans = 0;
    let worst = 0;
    for (let n = 2; n <= 18; n++) {
      for (let seed = 1; seed <= 100; seed++) {
        const rng = mulberry32(seed * 7919 + n * 104729);
        const plan = planRace(independentStyleInput(n, rng, PACES[seed % PACES.length]!), rng, GEO);
        plans += 1;
        for (let i = 0; i < n; i++) {
          const xs = plan.x[i]!;
          for (let s = 1; s <= plan.steps; s++) {
            worst = Math.min(worst, xs[s]! - xs[s - 1]!);
          }
        }
      }
    }
    expect(plans, "前提: 空振りしていない").toBe(17 * 100);
    expect(worst, "最大の逆行(0 以上 = 後退なし)").toBeGreaterThanOrEqual(0);
  });

  it("progress=1 で全馬が x ≥ 1(ゴールを越えている)。progress=0 は先頭の馬がライン上(x=0)で他は後ろ", () => {
    for (const pace of PACES) {
      const n = 14;
      const plan = planRace(groupedInput(pace, shuffled(n, mulberry32(3))), mulberry32(4), GEO);
      const last = frameAt(plan, 1);
      expect(Math.min(...last.x)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...last.x) - Math.min(...last.x), "最終の隊列に幅がある").toBeGreaterThan(0.05);
      const first = frameAt(plan, 0);
      expect(Math.max(...first.x)).toBeCloseTo(0, 12);
      expect(first.x.filter((x) => x < -1e-9).length, "先頭以外は後ろ").toBe(n - 1);
    }
  });
});

describe("ゴール(progress=1)の並び(旧 positionsAt のテストが保証していたことの引き継ぎ)", () => {
  it("前方位置の降順 = 抽選した着順(1 着が最も前)。順位どうしの間隔は 0 でない。先頭と最後尾の差は REPLAY_SPREAD の 0.95 倍(最終の隊列の幅)。全ペース", () => {
    for (const pace of PACES) {
      const n = 14;
      const order = shuffled(n, mulberry32(17));
      const input = groupedInput(pace, order);
      const x = frameAt(planRace(input, mulberry32(3), GEO), 1).x;
      expect(rankingAt(x), pace).toEqual(order);
      const sorted = [...x].sort((a, b) => b - a);
      for (let k = 1; k < n; k++) expect(sorted[k - 1]! - sorted[k]!, `${pace}: 順位 ${k} の間隔`).toBeGreaterThan(1e-6);
      expect(sorted[0]! - sorted[n - 1]!).toBeCloseTo(0.95 * REPLAY_SPREAD, 10);
    }
  });
});

describe("AC3: 横位置は連続で、コースの幅の範囲内", () => {
  it("隣り合う刻みの変化は 1 刻みあたりの上限以下。常に [0, 1] の中", () => {
    let moved = 0;
    for (const n of [2, 5, 12, 18]) {
      for (let seed = 1; seed <= 10; seed++) {
        const rng = mulberry32(seed * 7 + n);
        const plan = planRace(randomInput(n, rng, "平均"), rng, GEO);
        const cap = GEO.across * LAT_STEP_RATIO;
        for (const ls of plan.lat) {
          expect(ls.length).toBe(plan.steps + 1);
          for (let s = 0; s <= plan.steps; s++) {
            expect(ls[s]!).toBeGreaterThanOrEqual(0);
            expect(ls[s]!).toBeLessThanOrEqual(1);
            if (s > 0) {
              expect(Math.abs(ls[s]! - ls[s - 1]!)).toBeLessThanOrEqual(cap + 1e-12);
            }
          }
          moved += Math.abs(ls[plan.steps]! - ls[0]!) > 0.05 ? 1 : 0;
        }
      }
    }
    expect(moved, "前提: 横に動く馬が実際にいる(定数の横位置では自明に通る)").toBeGreaterThan(20);
    expect(LAT_STEP_RATIO, "前提: 上限は丸の直径より小さい").toBeLessThan(1);
  });
});

describe("横位置の押し離し(近い 2 頭は、その時点の横の相対位置の向きに離れる)", () => {
  it("スタート直後に重なる 6 頭(枠順は馬の添字と逆)は、横の並びを保ったまま離れる。添字や外・内の固定の向きでは押さない", () => {
    const n = 6;
    const input: PlanInput = { styles: Array<LegStyle>(n).fill("差し"), startRanks: [...Array(n).keys()], finalRanks: [...Array(n).keys()], gates: [5, 4, 3, 2, 1, 0], pace: "平均" };
    const plan = planRace(input, mulberry32(1), GEO);
    const s = 24; // 目標への追従が始まる前(進み具合 0.12 未満)。動くのは押し離しだけ
    expect(s / PLAN_STEPS).toBeLessThan(0.12);
    const gap0 = Math.min(...[1, 2, 3, 4, 5].map((k) => Math.abs(plan.lat[k]![0]! - plan.lat[k - 1]![0]!)));
    expect(gap0, "前提: 初期の間隔は丸の横の直径より狭い(重なっている)").toBeLessThan(GEO.across);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (input.gates[a]! > input.gates[b]!) {
          expect(plan.lat[a]![s]!, `枠 ${input.gates[a]} は枠 ${input.gates[b]} より外のまま`).toBeGreaterThan(plan.lat[b]![s]!);
        }
      }
    }
    const sorted = plan.lat.map((l) => l[s]!).sort((p, q) => p - q);
    const moved = plan.lat.map((l) => Math.abs(l[s]! - l[0]!));
    expect(Math.max(...moved), "前提: 押し離しで実際に動いている").toBeGreaterThan(0.01);
    expect(sorted[sorted.length - 1]! - sorted[0]!, "全体の幅が広がる(離れる)").toBeGreaterThan(plan.lat[0]![0]! - plan.lat[5]![0]!);
  });
});

describe("AC4: 抜く側が固定されない(内からも外からも抜く)", () => {
  it("追い越しの時点の横の相対位置で、内から・外からの両方が 30% 以上", () => {
    let inner = 0;
    let outer = 0;
    let tie = 0;
    for (const n of [8, 12, 16, 18]) {
      for (let seed = 1; seed <= 25; seed++) {
        const rng = mulberry32(seed * 131 + n);
        const plan = planRace(randomInput(n, rng, PACES[seed % PACES.length]!), rng, GEO);
        for (const { i, j, s } of passes(plan)) {
          const a = plan.lat[i]![s]!;
          const b = plan.lat[j]![s]!;
          if (a < b) inner += 1;
          else if (a > b) outer += 1;
          else tie += 1;
        }
      }
    }
    const total = inner + outer + tie;
    expect(total, "前提: 追い越しが十分ある").toBeGreaterThan(500);
    expect(inner / total, `内から ${inner}/${total}`).toBeGreaterThanOrEqual(0.3);
    expect(outer / total, `外から ${outer}/${total}`).toBeGreaterThanOrEqual(0.3);
  });
});

describe("AC5: 隊列は脚質で決まる(乱数に依らない)", () => {
  const T = 0.4; // 道中。どのペースでも、動き出しの前(MOVE_START の最小は 0.4 より後)
  const at = (plan: RacePlan, p: number): number[] => frameAt(plan, p).x;

  it("前提: 動き出しはどのペース・脚質でも progress 0.4 より後", () => {
    for (const pace of PACES) for (const style of STYLES) expect(MOVE_START[pace][style]).toBeGreaterThan(T);
  });

  it("(a) 道中(0.4)の並び: 脚質の集団が前から 逃げ→先行→差し→追込 の順(前の集団の最後尾が、次の集団の先頭より前)。全ペース", () => {
    for (const pace of PACES) {
      const input = groupedInput(pace);
      const x = at(planRace(input, mulberry32(11), GEO), T);
      for (let c = 0; c < 3; c++) {
        const front = Math.min(...x.filter((_, i) => input.styles[i] === STYLES[c]));
        const back = Math.max(...x.filter((_, i) => input.styles[i] === STYLES[c + 1]));
        expect(front, `${pace}: ${STYLES[c]} の最後尾 > ${STYLES[c + 1]} の先頭`).toBeGreaterThan(back);
      }
    }
  });

  it("(b) 集団の間の間隔が、集団の中の間隔より広い(最小の集団間 > 最大の集団内)。全ペース。無作為な入力でも", () => {
    const check = (input: PlanInput, plan: RacePlan, label: string): void => {
      const x = at(plan, T);
      const idx = x.map((_, i) => i).sort((a, b) => x[b]! - x[a]!);
      let maxIn = 0;
      let minBetween = Number.POSITIVE_INFINITY;
      for (let k = 1; k < idx.length; k++) {
        const gap = x[idx[k - 1]!]! - x[idx[k]!]!;
        if (input.styles[idx[k - 1]!] === input.styles[idx[k]!]) maxIn = Math.max(maxIn, gap);
        else minBetween = Math.min(minBetween, gap);
      }
      expect(Number.isFinite(minBetween), `${label}: 前提: 集団が 2 つ以上`).toBe(true);
      expect(maxIn, `${label}: 前提: 集団内に間隔がある`).toBeGreaterThan(0);
      expect(minBetween, label).toBeGreaterThan(maxIn);
    };
    for (const pace of PACES) {
      const input = groupedInput(pace);
      check(input, planRace(input, mulberry32(2), GEO), `固定 ${pace}`);
    }
    for (let seed = 1; seed <= 20; seed++) {
      const rng = mulberry32(seed * 977);
      const n = 10 + (seed % 9);
      const input = randomInput(n, rng, PACES[seed % PACES.length]!);
      if (new Set(input.styles).size < 2) continue;
      check(input, planRace(input, rng, GEO), `無作為 seed=${seed}`);
    }
  });

  it("集団の中の並びは開始順(earlyPos の順)", () => {
    const input = groupedInput("平均");
    const x = at(planRace(input, mulberry32(1), GEO), 0.3);
    // 開始順 = 添字順。各集団の中で、添字が小さいほど前(ゆらぎは集団の間隔より小さい。同集団内では入れ替わりうるので、集団の先頭と最後尾の馬で見る)
    for (const style of STYLES) {
      const members = input.styles.map((s, i) => (s === style ? i : -1)).filter((i) => i >= 0);
      const first = members[0]!;
      const last = members[members.length - 1]!;
      expect(x[first]!, style).toBeGreaterThan(x[last]!);
    }
  });

  it("(i) 道中の隊列の全長: ハイ > 平均 > スロー。不明は平均と同じ", () => {
    const length = (pace: PaceEstimate): number => {
      const x = at(planRace(groupedInput(pace), mulberry32(9), GEO), T);
      return Math.max(...x) - Math.min(...x);
    };
    const [hi, mid, slow, unknown] = [length("ハイ"), length("平均"), length("スロー"), length("不明")];
    expect(hi).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(slow);
    expect(slow, "前提: 全長が正").toBeGreaterThan(0);
    expect(unknown).toBe(mid);
  });

  it("隊列の形(前方位置)は乱数に依らない(乱数は横位置の目標だけ)。乱数を変えても x は同じで、lat は変わる", () => {
    const input = groupedInput("ハイ", shuffled(14, mulberry32(8)));
    const a = planRace(input, mulberry32(1), GEO);
    const b = planRace(input, mulberry32(2), GEO);
    expect(b.x).toEqual(a.x);
    expect(b.moveStart).toEqual(a.moveStart);
    expect(b.lat).not.toEqual(a.lat);
  });

  it("(ii) 動き出しの時機がペースで変わる: 実効の動き出し(moveStart)は、同じ馬でハイ < 平均 < スロー(全脚質の馬で)", () => {
    const order = shuffled(14, mulberry32(21));
    const plans = Object.fromEntries(PACES.map((p) => [p, planRace(groupedInput(p, order), mulberry32(1), GEO)])) as Record<PaceEstimate, RacePlan>;
    const input = groupedInput("平均", order);
    for (let i = 0; i < 14; i++) {
      const [hi, mid, slow] = [plans["ハイ"].moveStart[i]!, plans["平均"].moveStart[i]!, plans["スロー"].moveStart[i]!];
      expect(hi, `馬${i}(${input.styles[i]})`).toBeLessThan(mid);
      expect(mid, `馬${i}(${input.styles[i]})`).toBeLessThan(slow);
      expect(plans["不明"].moveStart[i]).toBe(mid);
    }
  });

  it("(ii) 実際の動き: 追込が 1 着のとき先頭に立つ時刻はハイ < 平均 < スロー。逃げが最下位のとき最初に抜かれる時刻もハイ < 平均 < スロー", () => {
    const leaderFrom = (pace: PaceEstimate): number => {
      const input = groupedInput(pace, [13, ...[...Array(13).keys()]]); // 最後尾の追込(馬13)が 1 着
      const plan = planRace(input, mulberry32(1), GEO);
      for (let s = 0; s <= plan.steps; s++) {
        const lead = plan.x.reduce((best, xs, i) => (xs[s]! > plan.x[best]![s]! ? i : best), 0);
        if (lead === 13) return s / plan.steps;
      }
      return Number.POSITIVE_INFINITY;
    };
    const [hi, mid, slow] = [leaderFrom("ハイ"), leaderFrom("平均"), leaderFrom("スロー")];
    expect(Number.isFinite(slow), "前提: スローでも先頭に立つ").toBe(true);
    expect(hi).toBeLessThan(mid);
    expect(mid).toBeLessThan(slow);

    const firstPassedAt = (pace: PaceEstimate): number => {
      const input = groupedInput(pace, [...[...Array(13).keys()].slice(1), 13, 0]); // 先頭の逃げ(馬0)が最下位
      const plan = planRace(input, mulberry32(1), GEO);
      const p = passes(plan).filter((e) => e.j === 0 && input.styles[e.i] !== "逃げ");
      return Math.min(...p.map((e) => e.s)) / plan.steps;
    };
    const [fh, fm, fs] = [firstPassedAt("ハイ"), firstPassedAt("平均"), firstPassedAt("スロー")];
    expect(Number.isFinite(fs), "前提: 抜かれる").toBe(true);
    expect(fh).toBeLessThan(fm);
    expect(fm).toBeLessThan(fs);
  });

  it("(c) 脚質をまたぐ追い越し(後方の脚質が前の脚質を抜く)は、2 頭の動き出しのうち早い方より後にしか起きない。1 件以上ある", () => {
    let cross = 0;
    for (const pace of PACES) {
      for (let seed = 1; seed <= 12; seed++) {
        const rng = mulberry32(seed * 53);
        const input = randomInput(16, rng, pace);
        const plan = planRace(input, rng, GEO);
        for (const { i, j, s } of passes(plan)) {
          const si = STYLES.indexOf(input.styles[i]!);
          const sj = STYLES.indexOf(input.styles[j]!);
          if (si <= sj) continue; // 同じ脚質・前の脚質が後ろを抜く(下がる側の馬)は対象外
          cross += 1;
          const earliest = Math.min(plan.moveStart[i]!, plan.moveStart[j]!);
          expect(s / plan.steps, `${pace} seed=${seed}: ${input.styles[i]}が${input.styles[j]}を抜く`).toBeGreaterThanOrEqual(earliest - 1e-9);
        }
      }
    }
    expect(cross, "前提: 脚質をまたぐ追い越しがある").toBeGreaterThan(100);
  });

  it("隊列が時間で変わる: 道中、同じ集団の中で入れ替わりがある(揺らぎ。乱数なし)。ただし脚質をまたぐ入れ替わりは動き出しの前には無い", () => {
    const input = groupedInput("平均");
    const plan = planRace(input, mulberry32(1), GEO);
    const early = passes(plan).filter((e) => e.s / plan.steps < 0.4);
    const within = early.filter((e) => input.styles[e.i] === input.styles[e.j]);
    expect(within.length, "同じ集団の中の入れ替わり").toBeGreaterThan(2);
    expect(early.length - within.length, "動き出し前に脚質をまたぐ入れ替わりは無い").toBe(0);
    // 同じ間隔のまま固定ではない: 0.1 と 0.3 で隊列の全長が違う(広がっていく)
    const len = (p: number): number => Math.max(...frameAt(plan, p).x) - Math.min(...frameAt(plan, p).x);
    expect(len(0.3)).toBeGreaterThan(len(0.05) * 1.5);
  });
});

describe("AC7: 決定的", () => {
  it("同じ入力・同じ乱数列なら同じ展開。違う乱数列なら横位置が変わる", () => {
    const input = randomInput(16, mulberry32(1), "ハイ");
    const a = planRace(input, mulberry32(42), GEO);
    const b = planRace(input, mulberry32(42), GEO);
    expect(b).toEqual(a);
    const c = planRace(input, mulberry32(43), GEO);
    expect(c.lat).not.toEqual(a.lat);
  });

  it("乱数の引く回数は頭数に比例(2 × 頭数)で、引きすぎない", () => {
    let calls = 0;
    const rng = (): number => {
      calls += 1;
      return 0.5;
    };
    planRace(randomInput(12, mulberry32(1), "平均"), rng, GEO);
    expect(calls).toBe(24);
  });
});

describe("frameAt(コマの補間)", () => {
  const plan = planRace(groupedInput("平均", shuffled(14, mulberry32(3))), mulberry32(4), GEO);

  it("刻みの境目は plan の値そのもの。刻みの中間は線形補間", () => {
    const f = frameAt(plan, 100 / PLAN_STEPS);
    for (let i = 0; i < 14; i++) {
      expect(f.x[i]).toBeCloseTo(plan.x[i]![100]!, 12);
      expect(f.lat[i]).toBeCloseTo(plan.lat[i]![100]!, 12);
    }
    const g = frameAt(plan, 100.5 / PLAN_STEPS);
    for (let i = 0; i < 14; i++) {
      expect(g.x[i]).toBeCloseTo((plan.x[i]![100]! + plan.x[i]![101]!) / 2, 12);
      expect(g.lat[i]).toBeCloseTo((plan.lat[i]![100]! + plan.lat[i]![101]!) / 2, 12);
    }
    expect(f.x.some((v, i) => v !== g.x[i]), "前提: 中間の値は端と違う").toBe(true);
  });

  it("progress は 0〜1 に丸める(範囲外でも投げず、端と同じ)", () => {
    expect(frameAt(plan, -1)).toEqual(frameAt(plan, 0));
    expect(frameAt(plan, 2)).toEqual(frameAt(plan, 1));
    expect(frameAt(plan, Number.NaN)).toEqual(frameAt(plan, 0));
  });
});

describe("退化", () => {
  it("0 頭・1 頭でも投げない。1 頭は最終でゴールを越える", () => {
    const empty = planRace({ styles: [], startRanks: [], finalRanks: [], gates: [], pace: "平均" }, mulberry32(1), GEO);
    expect(frameAt(empty, 0.5)).toEqual({ x: [], lat: [] });
    const one = planRace({ styles: ["差し"], startRanks: [0], finalRanks: [0], gates: [0], pace: "ハイ" }, mulberry32(1), GEO);
    expect(frameAt(one, 1).x[0]).toBeGreaterThanOrEqual(1);
    expect(frameAt(one, 0.5).lat[0]).toBeGreaterThanOrEqual(0);
  });
});

describe("横位置: 逃げ・先行は内寄り、差し・追込は広め(道中)", () => {
  it("道中(進み具合 0.6)の横位置の平均は、差し・追込の方が逃げ・先行より外側(平均の差が 0.08 以上)", () => {
    // 目標の車線は `(逃げ・先行 0.7 / 差し・追込 0.9) × 乱数`。理論上の差は期待値で 0.1(乱数の期待値 0.5)で、押し離しの分だけ個々の展開は揺れる(1 展開では逆転もある)。
    // そこで固定のシード 40 個 × 4 ペース = 160 展開の平均の差を見る。実測は 0.128。全脚質を同じ係数(0.8)にすると 0.031 になる(160 展開の平均なので、0.08 の閾値で区別できる)。
    const diffs: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      for (const pace of PACES) {
        const plan = planRace(groupedInput(pace), mulberry32(seed * 7919), GEO);
        const at = Math.round(plan.steps * 0.6);
        const mean = (idx: readonly number[]): number => idx.reduce((sum, i) => sum + plan.lat[i]![at]!, 0) / idx.length;
        diffs.push(mean([6, 7, 8, 9, 10, 11, 12, 13]) - mean([0, 1, 2, 3, 4, 5])); // groupedInput: 0〜5 が逃げ・先行、6〜13 が差し・追込
      }
    }
    expect(diffs).toHaveLength(160); // 前提: 空振りしない
    const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    expect(meanDiff).toBeGreaterThanOrEqual(0.08);
  });
});
