/**
 * #657-0 オッズの動きの試算の純粋な部分(馬ごとの比・買い目ごとの記録)。計画は plan.md。
 * 本番のコードは変えない。判定は書き出しの道具(judgeRaceBets。検証画面と同じ判定)を使う。
 */
import { judgeRaceBets, type AllocationRaceRow } from "../../../scripts/allocation-dataset.js";

/** 券種ごとの馬番の個数。枠連は枠番なので馬番を持たない。 */
const SIZE: Record<string, number> = { win: 1, place: 1, wide: 2, quinella: 2, exacta: 2, trio: 3, trifecta: 3 };

/** 買い目のキー(2 桁ずつの馬番)から馬番の列を取る。枠連・知らない券種・桁数が合わないキーは null。 */
export function keyHorses(betType: string, key: string): number[] | null {
  const n = SIZE[betType];
  if (n === undefined || key.length !== n * 2 || !/^\d+$/.test(key)) return null;
  return Array.from({ length: n }, (_, i) => Number(key.slice(i * 2, i * 2 + 2)));
}

export function ninkiBand(ninki: number): "1-3" | "4-6" | "7-" {
  return ninki <= 3 ? "1-3" : ninki <= 6 ? "4-6" : "7-";
}

/** 昇順でなくてよい。線形補間の分位点。 */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export interface HorseRatio {
  readonly umaban: number;
  /** 確定の単勝 ÷ 分析時点の単勝。 */
  readonly ratio: number;
  /** 分析時点の単勝人気。 */
  readonly ninki: number;
  /** この馬が入った買い目の券種(重複なし。順序は買い目の順)。空なら買い目に入っていない。 */
  readonly types: string[];
}

const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** 馬ごとの比。分析時点と確定のどちらかの単勝が無い馬・取消の馬は外す。 */
export function horseRatios(row: AllocationRaceRow): HorseRatio[] {
  const bought = new Map<number, string[]>();
  for (const b of row.allocation?.bets ?? []) {
    for (const u of keyHorses(b.bet_type, b.combo_key) ?? []) {
      const ts = bought.get(u) ?? [];
      if (!ts.includes(b.bet_type)) ts.push(b.bet_type);
      bought.set(u, ts);
    }
  }
  const fin = new Map(row.result.horses.map((h) => [h.umaban, h] as const));
  const out: HorseRatio[] = [];
  for (const h of row.horses) {
    const f = fin.get(h.umaban);
    if (f === undefined || f.scratched === 1 || !pos(h.win_odds) || !pos(f.win_odds) || h.ninki === null) continue;
    out.push({ umaban: h.umaban, ratio: f.win_odds / h.win_odds, ninki: h.ninki, types: bought.get(h.umaban) ?? [] });
  }
  return out;
}

export interface BetRecord {
  readonly betType: string;
  readonly stake: number;
  /** 分析時の確率 = ev ÷ odds。 */
  readonly p: number;
  readonly oddsAnalysis: number;
  readonly hit: boolean;
  /** 確定オッズ。単勝は全買い目で既知、複勝・組合せは的中した買い目の払戻 ÷ 100 だけ。それ以外は null。 */
  readonly oddsFinal: number | null;
  /** 分析時点のオッズでの見込みの払戻(円)= stake·p·odds。 */
  readonly e0: number;
  /** 確定オッズでの見込みの払戻(円)の実測。確定オッズが既知の買い目だけ、それ以外は null。 */
  readonly e1Measured: number | null;
  /** 買い目の馬の単勝の比の積(感度試算の代理)。作れなければ null。 */
  readonly proxyRatio: number | null;
  /** e0 × proxyRatio(感度試算。実測ではない)。 */
  readonly e1Proxy: number | null;
  /** 実際の払戻(円。賭け金を含む)。 */
  readonly actual: number;
}

/** 買い目ごとの記録。返還・判定不能・知らない券種・オッズや ev が不正な買い目は除く(期待にも実際にも入れない)。 */
export function betRecords(row: AllocationRaceRow): BetRecord[] {
  const bets = row.allocation?.bets ?? [];
  const ratios = new Map(horseRatios(row).map((h) => [h.umaban, h.ratio] as const));
  const fin = new Map(row.result.horses.map((h) => [h.umaban, h] as const));
  const out: BetRecord[] = [];
  for (const j of judgeRaceBets(row, bets)) {
    const o = j.judgment.outcome;
    const b = j.bet;
    if (o !== "hit" && o !== "miss") continue;
    if (!pos(b.odds) || !Number.isFinite(b.ev)) continue;
    const p = b.ev / b.odds;
    const hit = o === "hit";
    const horses = keyHorses(b.bet_type, b.combo_key);
    let oddsFinal: number | null = null;
    if (b.bet_type === "win") {
      const f = horses === null ? undefined : fin.get(horses[0]!)?.win_odds;
      oddsFinal = pos(f) ? f : null;
    } else if (hit) {
      oddsFinal = j.payout / b.stake; // 100 円あたりの払戻 ÷ 100 = 倍率
    }
    let proxyRatio: number | null = null;
    if (horses !== null) {
      const rs = horses.map((u) => ratios.get(u));
      if (rs.every((r): r is number => r !== undefined)) proxyRatio = rs.reduce((a, r) => a * r, 1);
    }
    const e0 = b.stake * b.ev;
    out.push({
      betType: b.bet_type,
      stake: b.stake,
      p,
      oddsAnalysis: b.odds,
      hit,
      oddsFinal,
      e0,
      e1Measured: oddsFinal === null ? null : b.stake * p * oddsFinal,
      proxyRatio,
      e1Proxy: proxyRatio === null ? null : e0 * proxyRatio,
      actual: j.payout,
    });
  }
  return out;
}
