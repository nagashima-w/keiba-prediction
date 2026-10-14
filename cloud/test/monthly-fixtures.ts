/**
 * 月報(Issue #265・#280)のテスト・近似確認(`print-monthly-prompt.ts`)が使う、月の偽データの生成器。**偽のデータだけ**(実 API・netkeiba・D1・R2 には触れない)。
 *
 * 月の D1 の行(`PeriodRows`)を、シード付きの乱数で決定的に作り、本番と同じ `buildMonthStats` に通す。統計は本番と同じ関数で計算するので、行と統計が食い違わない。
 * 1 レースの形: 10 頭立て。印は ◎=1 番・〇=2 番・▲=3 番。買い目は「単勝 100 円(馬は 1〜10 番を巡回)」と「複勝 100 円」の 2 点。
 * 結果は、単勝の買い目の馬が `winHitRate` の確率で 1 着になる(それ以外は乱数)。組合せ券種(ワイド・馬連・3 連複)の払戻は、着順の上位から作る(「もしも」の定型の判定に使う)。
 */
import type { PeriodRows } from "../src/period-stats";
import { buildMonthStats, type MonthStats } from "../src/monthly-stats";

export interface SyntheticMonthSpec {
  /** YYYYMM。 */
  readonly month: string;
  /** 分析のあった開催日(YYYYMMDD)。 */
  readonly days: readonly string[];
  readonly racesPerDay: number;
  readonly seed: number;
  /** 単勝の買い目の馬が 1 着になる確率。 */
  readonly winHitRate: number;
  /** 単勝の買い目のオッズ(倍)。 */
  readonly winOdds: number;
  /** 単勝の買い目の的中確率(分析時点の見込み。`ev = p × odds`)。 */
  readonly winProb: number;
  /** 日ごとの版(`days` と同じ順。省略は全日 `v-fixture`)。 */
  readonly versions?: readonly (string | null)[];
  /** 最終日(`days` の末尾)のレースは、結果を取り込まない(最終日の結果が未取込の月)。 */
  readonly lastDayWithoutResults?: boolean;
}

/** mulberry32(決定的な乱数)。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pairKey = (a: number, b: number): string => (a < b ? `${pad2(a)}${pad2(b)}` : `${pad2(b)}${pad2(a)}`);

export function syntheticMonthRows(spec: SyntheticMonthSpec): PeriodRows {
  const random = rng(spec.seed);
  const races: PeriodRows["races"][number][] = [];
  const bets: PeriodRows["bets"][number][] = [];
  const marks: PeriodRows["marks"][number][] = [];
  const results: PeriodRows["results"][number][] = [];
  const combos: PeriodRows["combos"][number][] = [];
  const imports: PeriodRows["imports"][number][] = [];
  let analysisId = 0;
  spec.days.forEach((date, dayIndex) => {
    const isLastDay = dayIndex === spec.days.length - 1;
    const withResults = !(isLastDay && spec.lastDayWithoutResults === true);
    const promptVersion = spec.versions === undefined ? "v-fixture" : (spec.versions[dayIndex] ?? null);
    for (let r = 1; r <= spec.racesPerDay; r += 1) {
      analysisId += 1;
      const raceId = `2026${pad2(5 + (dayIndex % 3))}${pad2(1 + (dayIndex % 5))}${pad2(dayIndex + 1)}${pad2(r)}`;
      races.push({ analysisId, raceId, kaisaiDate: date, model: "claude-sonnet-5-5", promptVersion });
      const winBetUmaban = 1 + ((analysisId - 1) % 10);
      const placeBetUmaban = 1 + (analysisId % 10);
      bets.push({ analysisId, betType: "win", comboKey: pad2(winBetUmaban), stake: 100, odds: spec.winOdds, ev: spec.winProb * spec.winOdds });
      bets.push({ analysisId, betType: "place", comboKey: pad2(placeBetUmaban), stake: 100, odds: 2.4, ev: 0.31 * 2.4 });
      marks.push({ analysisId, umaban: 1, mark: "◎" }, { analysisId, umaban: 2, mark: "〇" }, { analysisId, umaban: 3, mark: "▲" });
      if (!withResults) {
        continue;
      }
      // 着順: 1〜10 番をシャッフルし、単勝の買い目の馬を winHitRate の確率で 1 着にする。
      const order = Array.from({ length: 10 }, (_, i) => i + 1);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      if (random() < spec.winHitRate) {
        order.splice(order.indexOf(winBetUmaban), 1);
        order.unshift(winBetUmaban);
      }
      order.forEach((umaban, i) => {
        const finishPosition = i + 1;
        results.push({
          raceId,
          umaban,
          finishPosition,
          winPayout: finishPosition === 1 ? (umaban === winBetUmaban ? Math.round(spec.winOdds * 100) : 300 + umaban * 150) : null,
          placePayout: finishPosition <= 3 ? 110 + finishPosition * 40 + umaban * 10 : null,
        });
      });
      const [first, second, third] = order as [number, number, number];
      for (const betType of ["wide", "quinella", "trio"]) {
        imports.push({ raceId, betType });
      }
      combos.push({ raceId, betType: "quinella", comboKey: pairKey(first, second), payout: 800 + first * 150 + second * 60 });
      combos.push({ raceId, betType: "wide", comboKey: pairKey(first, second), payout: 300 + first * 40 });
      combos.push({ raceId, betType: "wide", comboKey: pairKey(first, third), payout: 400 + third * 50 });
      combos.push({ raceId, betType: "wide", comboKey: pairKey(second, third), payout: 500 + second * 30 });
      const trio = [first, second, third].sort((a, b) => a - b);
      combos.push({ raceId, betType: "trio", comboKey: trio.map(pad2).join(""), payout: 2000 + first * 700 + second * 300 + third * 100 });
    }
  });
  return { races, bets, marks, results, combos, imports };
}

export function syntheticMonthStats(spec: SyntheticMonthSpec): MonthStats {
  const first = spec.days[0]!;
  return buildMonthStats(syntheticMonthRows(spec), { fromDate: `${spec.month}01`, toDate: lastDayOf(spec.month, first) });
}

function lastDayOf(month: string, anyDay: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${anyDay.slice(0, 6)}${pad2(last)}`;
}

/** 2026 年 10 月の JRA 開催日(土日)9 日。 */
export const OCT_2026_DAYS: readonly string[] = ["20261003", "20261004", "20261010", "20261011", "20261017", "20261018", "20261024", "20261025", "20261031"];

/** 小さな月(2 開催日・各 6 レース)。単体テストの既定の材料。 */
export const SMALL_MONTH_SPEC: SyntheticMonthSpec = {
  month: "202610",
  days: ["20261024", "20261025"],
  racesPerDay: 6,
  seed: 7,
  winHitRate: 0.3,
  winOdds: 6,
  winProb: 0.2,
  versions: ["v-a", "v-b"],
};
