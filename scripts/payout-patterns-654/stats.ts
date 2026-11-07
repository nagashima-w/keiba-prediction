/**
 * #654: ブートストラップ・候補の選別(計画 §6)・後半の判定(計画 §7)。純粋関数。
 */

import {
  benjaminiHochberg,
  holm,
  roiWithoutTop,
  takeoutOf,
  type ComboBet,
  type PerRace,
} from "./lib.js";

/** 形 1 つの集計(期間ごと)。 */
export interface FormResult {
  id: string;
  /** 帯の族("R"/"Q"/"-")。候補の族(F1 など)とは別。 */
  family: string;
  bet: ComboBet;
  definition: unknown;
  races: number;
  tickets: number;
  returnYen: number;
  roi: number;
  hits: number;
  expectedHits: number;
  expectedHitsDiscounted?: number;
  fairYen: number;
  hitPayouts: number[];
  perRace: PerRace[];
}

/** レースの条件 × 券種の集計(期間ごと)。 */
export interface ConditionResult {
  id: string;
  bet: ComboBet;
  condition: { key: string; value: string };
  races: number;
  /** 全組合せ買いの回収率。 */
  allRoi: number;
  allRoiLo: number;
  allRoiHi: number;
  /** 配当 1 万円以上の的中の本数と Harville の見込み。 */
  bigHits: number;
  bigHitsExpected: number;
  /** 副次の基準(割引つき)での万馬券の見込み(読み方の道具。候補の選別には使わない)。 */
  bigHitsExpectedDiscounted?: number;
  /** 配当 10 万円以上。 */
  hugeHits: number;
  hugeHitsExpected: number;
  /** 的中組合せの配当 ÷ Harville の公平配当。 */
  fairRatio: number;
  perRace?: PerRace[];
  hitPayouts?: number[];
}

export interface BootstrapResult {
  lo: number;
  hi: number;
  mean: number;
  /** 片側 p 値: 再標本の ROI が threshold 以下になった割合(H1: ROI > threshold)。 */
  pAbove1: number;
}

/** 決定的な乱数(mulberry32)。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * レース単位のブートストラップ。レースを復元抽出し、ROI = Σret / Σcost を reps 回計算する。
 * threshold は片側 p 値の基準(既定 1.0。全組合せ買いでは 1−t を使う)。
 */
export function bootstrapRoi(perRace: readonly PerRace[], reps: number, seed: number, threshold = 1): BootstrapResult {
  const n = perRace.length;
  if (n === 0) return { lo: Number.NaN, hi: Number.NaN, mean: Number.NaN, pAbove1: Number.NaN };
  const cost = new Float64Array(n);
  const ret = new Float64Array(n);
  perRace.forEach((r, i) => {
    cost[i] = r.cost;
    ret[i] = r.ret;
  });
  const rng = makeRng(seed);
  const rois = new Float64Array(reps);
  let atOrBelow = 0;
  let sum = 0;
  for (let r = 0; r < reps; r++) {
    let c = 0;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      c += cost[idx]!;
      v += ret[idx]!;
    }
    const roi = v / c;
    rois[r] = roi;
    sum += roi;
    if (roi <= threshold) atOrBelow++;
  }
  const sorted = Array.from(rois).sort((a, b) => a - b);
  const pick = (p: number): number => sorted[Math.min(reps - 1, Math.max(0, Math.floor(p * reps)))]!;
  return { lo: pick(0.025), hi: pick(0.975), mean: sum / reps, pAbove1: atOrBelow / reps };
}

/** ポアソン近似の z = (A−E)/√E。 */
export function zPoisson(actual: number, expected: number): number {
  if (expected <= 0) return 0;
  return (actual - expected) / Math.sqrt(expected);
}

/** 標準正規の上側確率(Abramowitz–Stegun 26.2.17 の近似)。 */
export function normalSf(z: number): number {
  if (z < 0) return 1 - normalSf(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) * poly;
}

export type CandidateFamily = "F1" | "F2" | "F3" | "F4";

export interface Candidate {
  id: string;
  family: CandidateFamily;
  /** 比の族の向き(+1: 実際 > 見込み、−1: 実際 < 見込み)。F3 の万馬券の比は +1。 */
  direction?: 1 | -1;
  /** F3 の種類(全買いの ROI か万馬券の比か)。 */
  f3Kind?: "roi" | "big";
  bet?: ComboBet;
  firstHalf?: Record<string, number>;
}

export interface SelectOptions {
  reps: number;
  seed: number;
}

/** 計画 §6 の形の候補(F1: ROI、F2: 的中数の比)。 */
export function selectFormCandidates(results: readonly FormResult[], opt: SelectOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const r of results) {
    if (r.races >= 300 && r.hits >= 30 && r.roi >= 1.05 && roiWithoutTop(r, 3) >= 0.95) {
      const b = bootstrapRoi(r.perRace, opt.reps, opt.seed);
      if (b.lo > 0.9) {
        out.push({
          id: r.id,
          family: "F1",
          bet: r.bet,
          firstHalf: { races: r.races, tickets: r.tickets, hits: r.hits, roi: r.roi, lo: b.lo, hi: b.hi, roiTop3: roiWithoutTop(r, 3) },
        });
      }
    }
    if (r.hits >= 30) {
      const z = zPoisson(r.hits, r.expectedHits);
      if (Math.abs(z) >= 2) {
        out.push({
          id: r.id,
          family: "F2",
          bet: r.bet,
          direction: z > 0 ? 1 : -1,
          firstHalf: { races: r.races, hits: r.hits, expectedHits: r.expectedHits, z, roi: r.roi },
        });
      }
    }
  }
  return out;
}

/** 計画 §6 の条件の候補(F3)。 */
export function selectConditionCandidates(results: readonly ConditionResult[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of results) {
    if (r.races < 200) continue;
    const t = takeoutOf(r.bet);
    if (r.allRoiLo > 1 - t) {
      out.push({
        id: r.id,
        family: "F3",
        f3Kind: "roi",
        bet: r.bet,
        firstHalf: { races: r.races, allRoi: r.allRoi, lo: r.allRoiLo, hi: r.allRoiHi },
      });
    }
    const ratio = r.bigHitsExpected > 0 ? r.bigHits / r.bigHitsExpected : 0;
    if (r.bigHitsExpected >= 10 && ratio >= 1.3 && zPoisson(r.bigHits, r.bigHitsExpected) >= 2) {
      out.push({
        id: r.id,
        family: "F3",
        f3Kind: "big",
        bet: r.bet,
        direction: 1,
        firstHalf: { races: r.races, bigHits: r.bigHits, bigHitsExpected: r.bigHitsExpected, ratio },
      });
    }
  }
  return out;
}

export interface Judgement {
  id: string;
  family: CandidateFamily;
  f3Kind?: "roi" | "big";
  survived: boolean;
  reasons: string[];
  races: number;
  hits: number;
  roi?: number;
  lo?: number;
  hi?: number;
  roiTop1?: number;
  roiTop3?: number;
  roiTop5?: number;
  ticketsPerRace?: number;
  expectedHits?: number;
  z?: number;
  p: number;
  bhQ: number;
  holmP: number;
}

type AnyResult = FormResult | ConditionResult;

function isCondition(r: AnyResult): r is ConditionResult {
  return "allRoi" in r;
}

/**
 * 計画 §7 の後半の判定。候補ごとに同じ指標を出し、族ごとに BH(q < 0.10)と Holm を掛ける。
 * 残る条件: 同じ向き・BH q < 0.10・(ROI の族は)上位 3 件除外 ≥ 0.95・件数(N ≥ 150、的中 ≥ 15)。
 */
export function judgeCandidates(
  candidates: readonly Candidate[],
  results: Readonly<Record<string, AnyResult>>,
  opt: SelectOptions,
): Judgement[] {
  const rows: { c: Candidate; j: Omit<Judgement, "bhQ" | "holmP" | "survived">; direction: boolean; sens: boolean; counts: boolean; key: string }[] = [];
  for (const c of candidates) {
    const r = results[c.id];
    const reasons: string[] = [];
    if (!r) {
      rows.push({ c, j: { id: c.id, family: c.family, reasons: ["後半に結果なし"], races: 0, hits: 0, p: 1 }, direction: false, sens: false, counts: false, key: `${c.family}` });
      continue;
    }
    if (isCondition(r)) {
      const t = takeoutOf(r.bet);
      if (c.f3Kind === "big") {
        const z = zPoisson(r.bigHits, r.bigHitsExpected);
        const p = normalSf(z);
        const direction = r.bigHits > r.bigHitsExpected;
        const counts = r.races >= 150 && r.bigHits >= 15;
        if (!direction) reasons.push("向き");
        if (!counts) reasons.push("件数");
        rows.push({
          c,
          j: { id: c.id, family: c.family, f3Kind: "big", reasons, races: r.races, hits: r.bigHits, expectedHits: r.bigHitsExpected, z, p },
          direction,
          sens: true,
          counts,
          key: "F3:big",
        });
      } else {
        const b = r.perRace ? bootstrapRoi(r.perRace, opt.reps, opt.seed, 1 - t) : { lo: r.allRoiLo, hi: r.allRoiHi, mean: r.allRoi, pAbove1: Number.NaN };
        const direction = r.allRoi > 1 - t;
        const counts = r.races >= 150;
        if (!direction) reasons.push("向き");
        if (!counts) reasons.push("件数");
        const sensBase = r.hitPayouts && r.perRace ? { tickets: r.perRace.reduce((a, x) => a + x.cost, 0) / 100, returnYen: r.perRace.reduce((a, x) => a + x.ret, 0), hitPayouts: r.hitPayouts } : undefined;
        rows.push({
          c,
          j: {
            id: c.id,
            family: c.family,
            f3Kind: "roi",
            reasons,
            races: r.races,
            hits: r.races,
            roi: r.allRoi,
            lo: b.lo,
            hi: b.hi,
            roiTop1: sensBase ? roiWithoutTop(sensBase, 1) : undefined,
            roiTop3: sensBase ? roiWithoutTop(sensBase, 3) : undefined,
            roiTop5: sensBase ? roiWithoutTop(sensBase, 5) : undefined,
            p: b.pAbove1,
          },
          direction,
          sens: true,
          counts,
          key: "F3:roi",
        });
      }
      continue;
    }
    if (c.family === "F2") {
      const z = zPoisson(r.hits, r.expectedHits);
      const dir = c.direction ?? 1;
      const p = normalSf(dir * z);
      const direction = Math.sign(z) === dir;
      const counts = r.races >= 150 && r.hits >= 15;
      if (!direction) reasons.push("向き");
      if (!counts) reasons.push("件数");
      rows.push({
        c,
        j: { id: c.id, family: c.family, reasons, races: r.races, hits: r.hits, roi: r.roi, expectedHits: r.expectedHits, z, p, ticketsPerRace: r.races ? r.tickets / r.races : undefined },
        direction,
        sens: true,
        counts,
        key: "F2",
      });
      continue;
    }
    // F1・F4(ROI の族)
    const b = bootstrapRoi(r.perRace, opt.reps, opt.seed);
    const direction = r.roi >= 1;
    const top3 = roiWithoutTop(r, 3);
    const sens = top3 >= 0.95;
    const counts = r.races >= 150 && r.hits >= 15;
    if (!direction) reasons.push("向き");
    if (!sens) reasons.push("感度");
    if (!counts) reasons.push("件数");
    rows.push({
      c,
      j: {
        id: c.id,
        family: c.family,
        reasons,
        races: r.races,
        hits: r.hits,
        roi: r.roi,
        lo: b.lo,
        hi: b.hi,
        roiTop1: roiWithoutTop(r, 1),
        roiTop3: top3,
        roiTop5: roiWithoutTop(r, 5),
        ticketsPerRace: r.races ? r.tickets / r.races : undefined,
        expectedHits: r.expectedHits,
        z: zPoisson(r.hits, r.expectedHits),
        p: b.pAbove1,
      },
      direction,
      sens,
      counts,
      key: c.family,
    });
  }
  // 族ごとに BH・Holm
  const out: Judgement[] = rows.map((row) => ({ ...row.j, bhQ: 1, holmP: 1, survived: false }));
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const g = groups.get(row.key) ?? [];
    g.push(i);
    groups.set(row.key, g);
  });
  for (const idxs of groups.values()) {
    const ps = idxs.map((i) => (Number.isFinite(rows[i]!.j.p) ? rows[i]!.j.p : 1));
    const q = benjaminiHochberg(ps);
    const h = holm(ps);
    idxs.forEach((i, k) => {
      out[i]!.bhQ = q[k]!;
      out[i]!.holmP = h[k]!;
    });
  }
  rows.forEach((row, i) => {
    const o = out[i]!;
    const bh = o.bhQ < 0.1;
    if (!bh) o.reasons.push("BH");
    o.survived = row.direction && row.sens && row.counts && bh;
  });
  return out;
}
