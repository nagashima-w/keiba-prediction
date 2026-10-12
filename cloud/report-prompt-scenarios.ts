/**
 * 日報のプロンプトの近似確認用シナリオ(Issue #264)。`print-report-prompt.ts --scenario S1..S6` が使う。**偽のデータだけ**(実 API・netkeiba・D1・R2 には触れない)。
 *
 * 目的: 「その日の結果を 4 週と見込みの的中数で比べて書かせる」指示文が、LLM(実 API の代わりにサブエージェント)にどう効くかを、
 * 旧プロンプト(6d345a6。『数十レースの 1 日分では偶然の影響が大きい』)と新プロンプトで比べる。**新旧で「その日」のレースと買い目は同一**(違うのは規則と 4 週のブロックだけ)。
 *
 * その日のレースは、買い目の仕様(券種・賭け金・オッズ・的中確率・的中したか)から**一貫した結果**を作る({@link buildDay}):
 * 的中する買い目の馬を上位に、はずれる買い目の馬を圏外に置く。統計は日報と同じ関数(`buildDayStats`)で計算するので、レースごとの行と統計が食い違わない。
 * 直前 27 日は、日報が D1 から再集計する `PeriodStats` を、数字を明示して作る({@link buildPrior})。
 *
 * | 名前 | その日 | 直前 27 日 | 見たいこと |
 * |---|---|---|---|
 * | S1 | 19 レース・20 点中 1 点的中(払戻 13,320 円・賭け金 2,400 円〈回収率 555%〉)。見込みより少ない | 開催 8 日・回収率 92% | 4 週と比べて書くか。『偶然』を根拠つきで多くとも 1 回にするか(2026-10-10 の実日報の形) |
 * | S2 | 20 点中 3 点的中(回収率 323%)。見込み並み | 回収率 110%(的中 22・見込み 20.1) | その日も 4 週もプラスのとき、定型の『偶然』を繰り返さないか(ユーザーの不満の再現) |
 * | S3 | 20 点中 0 点的中(回収率 0%) | 回収率 110% | 向き(その日が 4 週を下回る)を取り違えないか。見込みとの比較で書くか |
 * | S4 | S1 と同じ | 開催 1 日・12 レース・24 点中 1 点的中 | 4 週の履歴が薄いとき、少なさを述べ、傾向を断定しないか |
 * | S5 | 20 点中 1 点的中。**最大の 1 点を除くと回収率 0%** | 回収率 130%。**最大の 1 点を除くと 75%** | 1 点依存の警告が残っているか(過剰に抑えていないか) |
 * | S6 | 20 点中 5 点的中(回収率 約 160%)。**見込みの 2 倍以上** | 回収率 92%(的中 18・見込み 19.3) | 見込みを上回ったと書くか |
 */
import type { AnalysisView, AnalysisViewHorse } from "./src/analysis-view";
import type { RaceResultData } from "./src/daily-report-bets";
import type { RaceInput } from "./src/daily-report-core";
import type { PeriodStats } from "./src/period-stats";
import { fixturePriorStats } from "./test/daily-report-fixtures";

export const SCENARIO_IDS = ["S1", "S2", "S3", "S4", "S5", "S6"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIO_DATE = "20261010";

/** 買い目の仕様。`p` は分析時点の的中確率(`ev = p × odds` で保存される)。 */
interface BetSpec {
  readonly type: "win" | "place";
  readonly stake: number;
  readonly odds: number;
  readonly p: number;
  readonly hit: boolean;
}

const MARKS = ["◎", "〇", "▲"] as const;
const FILLER_ODDS = [6.5, 9.8, 12, 15, 18, 22, 8.4, 11, 25, 14, 7.2, 16, 19, 10.5, 13, 28, 9, 17.5, 21, 24] as const;

/** はずれの買い目を count 点作る(賭け金は 100 円を基本に、stakeTotal に合わせて端数を 1 点に寄せる)。単勝のオッズは 6.5〜28 倍の穴馬、的中確率は 0.04〜0.17 ほど。 */
function misses(count: number, stakeTotal: number, offset = 0, withPlace = true): BetSpec[] {
  const out: BetSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const isPlace = withPlace && i % 5 === 4; // 5 点に 1 点は複勝(オッズは単勝の 4 分の 1、的中確率は 0.3 前後)
    const odds = isPlace ? Math.max(2, FILLER_ODDS[(i + offset) % FILLER_ODDS.length]! / 4) : FILLER_ODDS[(i + offset) % FILLER_ODDS.length]!;
    const ev = 1.15 + (i % 4) * 0.05;
    out.push({ type: isPlace ? "place" : "win", stake: 100, odds, p: ev / odds, hit: false });
  }
  const base = count * 100;
  if (stakeTotal !== base) {
    out[0] = { ...out[0]!, stake: out[0]!.stake + (stakeTotal - base) };
  }
  return out;
}

function buildDay(races: number, bets: readonly BetSpec[]): RaceInput[] {
  const perRace: BetSpec[][] = Array.from({ length: races }, () => []);
  bets.forEach((b, i) => perRace[i % races]!.push(b));
  return perRace.map((list, r) => {
    const n = r + 1;
    if (list.length > 3) {
      throw new Error("1 レースの買い目は 3 点まで");
    }
    const hitWin = list.findIndex((b) => b.type === "win" && b.hit);
    if (list.filter((b) => b.type === "win" && b.hit).length > 1) {
      throw new Error("1 レースに的中する単勝は 1 点まで");
    }
    // 着順: 1 着 = 的中する単勝の馬(無ければ 8 番)。続く上位 = 的中する複勝の馬、残りは 7・6 番。はずれの買い目の馬は 4 着以下。
    const hitPlace = list.map((b, k) => (b.type === "place" && b.hit ? k + 2 : null)).filter((x): x is number => x !== null);
    const winner = hitWin === -1 ? 8 : hitWin + 2;
    const top = [winner, ...hitPlace.filter((u) => u !== winner)];
    for (const filler of [7, 6]) {
      if (top.length < 3) top.push(filler);
    }
    const rest = [1, 2, 3, 4, 5, 6, 7, 8].filter((u) => !top.includes(u));
    const order = [...top.slice(0, 3), ...rest];
    const horse = (umaban: number, over: Partial<AnalysisViewHorse> = {}): AnalysisViewHorse => ({
      umaban, name: `馬${n}-${umaban}`, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 2, ev: 1.0, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over,
    });
    const horses: AnalysisViewHorse[] = [
      ...list.map((_, k) => horse(k + 2, { mark: MARKS[k]!, adjustedProb: 0.3 - k * 0.05, ev: 1.1 + k * 0.1, isPositive: true, reason: k === 0 ? "近走の内容が安定している" : null })),
      horse(1), horse(5), horse(8),
    ].sort((a, b) => a.umaban - b.umaban);
    const view: AnalysisView = {
      id: 100 + n, raceId: `2026050308${String(n).padStart(2, "0")}`, analyzedAt: "2026-10-10T05:00:00.000Z", kaisaiDate: SCENARIO_DATE, evEstimated: false, model: "claude-sonnet-5-5", promptVersion: "v-scenario", llmNote: null, llmCalls: null,
      race: { venueName: n % 2 === 0 ? "京都" : "東京", raceNumber: ((n - 1) % 12) + 1, raceName: `シナリオ${n}S`, grade: null, startTime: `${10 + Math.floor((n - 1) / 2)}:${n % 2 === 0 ? "30" : "00"}`, courseType: "芝", distance: 1600, weather: "晴", trackCondition: "良", oddsStatus: "result", placeBasis: "top3" },
      horses, detail: "present",
      allocation: {
        route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, betUnit: 100, bankroll: 20000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1,
        includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, oddsStatus: "ok",
        bets: list.map((b, k) => ({ betType: b.type, comboKey: String(k + 2).padStart(2, "0"), stake: b.stake, odds: b.odds, ev: b.p * b.odds })),
      },
    };
    const result: RaceResultData = {
      horses: order.map((umaban, i) => {
        const k = umaban - 2;
        const spec = k >= 0 && k < list.length ? list[k]! : undefined;
        const winPayout = i === 0 ? (spec?.type === "win" && spec.hit ? Math.round(spec.odds * 100) : 350) : null;
        const placePayout = i < 3 ? (spec?.type === "place" && spec.hit ? Math.round(spec.odds * 100) : 140 + i * 10) : null;
        return { umaban, finishPosition: i + 1, winPayout, placePayout };
      }),
      combos: {},
    };
    return { view, result };
  });
}

/** 直前 27 日の統計を、数字を明示して作る(日報が D1 から再集計する `PeriodStats` と同じ形。券種別は単勝 4 割・複勝 6 割で配る)。 */
function buildPrior(s: { dayCount: number; races: number; judged: number; hits: number; expectedHits: number; stake: number; ret: number; maxPayout: number; maxPayoutStake: number }): PeriodStats {
  const winN = Math.round(s.judged * 0.4);
  const placeN = s.judged - winN;
  const winHits = Math.round(s.hits * 0.3);
  const winStake = Math.round((s.stake * 0.45) / 100) * 100;
  const winPay = Math.round(s.ret * 0.6);
  const winExp = s.expectedHits * (winN / s.judged);
  const results = s.races - 2;
  return fixturePriorStats({
    dayCount: s.dayCount, raceCount: s.races, resultRaceCount: results, noResultRaceCount: 2, betRaceCount: Math.round(s.races * 0.9), llmUsedRaceCount: s.races - 10,
    totalStake: s.stake, totalReturn: s.ret, recoveryRate: s.ret / s.stake, judgedBetCount: s.judged, hitBetCount: s.hits, unjudgedBetCount: 2, unjudgedStake: 600,
    expectedBetCount: s.judged, expectedHits: s.expectedHits, expectedBaseHits: s.hits, maxPayout: s.maxPayout, maxPayoutStake: s.maxPayoutStake,
    byBetType: {
      win: { betCount: winN, hitCount: winHits, stake: winStake, payout: winPay, expectedBetCount: winN, expectedHits: winExp, expectedBaseHits: winHits },
      place: { betCount: placeN, hitCount: s.hits - winHits, stake: s.stake - winStake, payout: s.ret - winPay, expectedBetCount: placeN, expectedHits: s.expectedHits - winExp, expectedBaseHits: s.hits - winHits },
    },
    byMark: [
      { mark: "◎", count: results, win: Math.round(results * 0.27), top3: Math.round(results * 0.6) },
      { mark: "〇", count: results, win: Math.round(results * 0.16), top3: Math.round(results * 0.55) },
    ],
  });
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly description: string;
  readonly inputs: RaceInput[];
  readonly prior: PeriodStats;
}

const hit = (type: "win" | "place", stake: number, odds: number, p: number): BetSpec => ({ type, stake, odds, p, hit: true });

export function buildScenario(id: ScenarioId): Scenario {
  const PRIOR_92 = { dayCount: 8, races: 150, judged: 300, hits: 18, expectedHits: 19.3, stake: 36000, ret: 33100, maxPayout: 8200, maxPayoutStake: 200 };
  const PRIOR_110 = { dayCount: 8, races: 150, judged: 300, hits: 22, expectedHits: 20.1, stake: 36000, ret: 39600, maxPayout: 7000, maxPayoutStake: 200 };
  switch (id) {
    case "S1":
      return { id, description: "2026-10-10 の実日報の形: 19 レース・20 点中 1 点的中(払戻 13,320 円・賭け金 2,400 円)。見込みより少ない。直前 27 日は回収率 92%", inputs: buildDay(19, [hit("win", 400, 33.3, 0.05), ...misses(19, 2000)]), prior: buildPrior(PRIOR_92) };
    case "S2":
      return {
        id, description: "その日も 4 週もプラス: 20 点中 3 点的中(回収率 323%・見込み並み)。直前 27 日は回収率 110%",
        inputs: buildDay(19, [hit("win", 300, 18.5, 0.06), hit("win", 200, 9.2, 0.11), hit("place", 300, 3.4, 0.35), ...misses(17, 1800, 3)]), prior: buildPrior(PRIOR_110),
      };
    case "S3":
      return { id, description: "その日は 0 点的中(回収率 0%)、4 週はプラス(回収率 110%)", inputs: buildDay(19, misses(20, 2400, 5)), prior: buildPrior(PRIOR_110) };
    case "S4":
      return {
        id, description: "S1 と同じ日。直前 27 日は履歴が薄い(開催 1 日・12 レース・24 点中 1 点的中)",
        inputs: buildDay(19, [hit("win", 400, 33.3, 0.05), ...misses(19, 2000)]),
        prior: buildPrior({ dayCount: 1, races: 12, judged: 24, hits: 1, expectedHits: 1.9, stake: 2800, ret: 1900, maxPayout: 1900, maxPayoutStake: 200 }),
      };
    case "S5":
      return {
        id, description: "1 点依存: その日は 20 点中 1 点的中(払戻 3,000 円・賭け金 2,400 円)で、最大の 1 点を除くと回収率 0%。直前 27 日も回収率 130%だが最大の 1 点を除くと 75%",
        inputs: buildDay(19, [hit("win", 300, 10, 0.1), ...misses(19, 2100, 2)]),
        prior: buildPrior({ dayCount: 8, races: 150, judged: 300, hits: 17, expectedHits: 19, stake: 36000, ret: 46800, maxPayout: 20000, maxPayoutStake: 200 }),
      };
    case "S6":
      return {
        id, description: "見込みより多く当たった日: 20 点中 5 点的中(見込みの 2 倍以上)。直前 27 日は回収率 92%",
        inputs: buildDay(19, [hit("win", 200, 14.5, 0.07), hit("win", 200, 8.8, 0.11), hit("place", 300, 3.8, 0.28), hit("place", 200, 4.4, 0.23), hit("win", 100, 21, 0.05), ...misses(15, 1500, 7, false)]),
        prior: buildPrior(PRIOR_92),
      };
  }
}
