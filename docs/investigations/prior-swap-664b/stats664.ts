/**
 * #664 段階 1b の判定の部分(Issue #664)。純粋な関数だけ。
 * 規則(試算の前に固定): lr664_50・lr664_100 のうち、中央の全券種合計で (1) 回収率が cur 以上(点推定)、(2) |見込み/実−1| が cur より小さい(実的中 0 は不可)、
 * を両方満たすものがあれば「段階 2 に進む」。#662 の規則と同じ形。
 */
export interface RaceCell { readonly stake: number; readonly ret: number; readonly exp: number; readonly act: number }

function total(rs: readonly RaceCell[]): RaceCell {
  return rs.reduce((a, r) => ({ stake: a.stake + r.stake, ret: a.ret + r.ret, exp: a.exp + r.exp, act: a.act + r.act }), { stake: 0, ret: 0, exp: 0, act: 0 });
}
export const rateOf = (c: RaceCell): number | null => (c.stake === 0 ? null : c.ret / c.stake);
export const ratioOf = (c: RaceCell): number | null => (c.act === 0 ? null : c.exp / c.act);

export interface RuleResult { readonly rate: number | null; readonly ratio: number | null; readonly ok1: boolean; readonly ok2: boolean; readonly qualified: boolean }
export function ruleCheck(cur: readonly RaceCell[], cand: readonly RaceCell[]): RuleResult {
  const bc = total(cur), cc = total(cand);
  const rb = rateOf(bc), rc = rateOf(cc), qb = ratioOf(bc), qc = ratioOf(cc);
  const ok1 = rc !== null && rb !== null && rc >= rb;
  const ok2 = qc !== null && qb !== null && Math.abs(qc - 1) < Math.abs(qb - 1);
  return { rate: rc, ratio: qc, ok1, ok2, qualified: ok1 && ok2 };
}

export function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface PairedDiff { readonly point: number; readonly lo: number; readonly hi: number; readonly positiveFrac: number }
/** 回収率の差(b − a)の、レース単位の対ブートストラップ(同じレースの組を引く)。95% 区間は 2.5%〜97.5% 点。 */
export function pairedRateDiff(a: readonly RaceCell[], b: readonly RaceCell[], seed: number, B: number): PairedDiff {
  if (a.length !== b.length) throw new Error("レース数が違う");
  const pa = total(a), pb = total(b);
  const point = pb.ret / pb.stake - pa.ret / pa.stake;
  const rnd = mulberry32(seed);
  const ds: number[] = [];
  for (let k = 0; k < B; k++) {
    let sa = 0, ga = 0, sb = 0, gb = 0;
    for (let i = 0; i < a.length; i++) { const j = Math.floor(rnd() * a.length); sa += a[j]!.stake; ga += a[j]!.ret; sb += b[j]!.stake; gb += b[j]!.ret; }
    if (sa > 0 && sb > 0) ds.push(gb / sb - ga / sa);
  }
  ds.sort((x, y) => x - y);
  return { point, lo: ds[Math.floor(ds.length * 0.025)]!, hi: ds[Math.floor(ds.length * 0.975)]!, positiveFrac: ds.filter((d) => d > 0).length / ds.length };
}
