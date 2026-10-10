/**
 * 日報(Issue #235)の 1 レースのダイジェストと、1 日の統計。**純関数**: D1・R2・時計・LLM を持たない。
 *
 * 数字(賭け金・払戻・回収率・的中数・印別の成績)は、LLM に計算させず、ここで決定的に計算する。LLM には「事実」として渡し、
 * 日報にも統計として出す。LLM の仕事は、その事実を読んで良かった点と改善点を文章にすることだけ。
 *
 * 入力は `buildAnalysisView`(`analysis-view.ts`。馬名・レース情報・根拠・強調材料・懸念事項・配分)の結果と、結果(`RaceResultData`)。
 * 結果が無いレース(`undefined`)は、着順なし・買い目は判定不能として載せる(中止・取り込み不能の可能性があるので、日報にも「結果なし」と出す)。
 */
import type { AnalysisView } from "./analysis-view";
import { judgeBets, type BetOutcome, type RaceResultData } from "./daily-report-bets";

/** ダイジェストに載せる馬の最大数(印は最大 6 頭なので、印の付いた馬は必ず収まる)。 */
export const DIGEST_MAX_HORSES = 8;
/** 根拠の最大文字数(UTF-16 の長さ。切ったら末尾を「…」にする)。 */
export const REASON_MAX_CHARS = 90;
/** 強調材料・懸念事項の 1 項目の最大文字数と、馬ごとの最大項目数。 */
export const ITEM_MAX_CHARS = 40;
export const ITEM_MAX_COUNT = 2;
/** 印も EV プラスも無いレースで、代わりに載せる馬の数(補正後の確率の高い順)。 */
const FALLBACK_HORSE_COUNT = 3;

/** 印の並び(exe の凡例と同じ)。ここに無い印は最後。 */
const MARK_ORDER = "◎〇▲△☆注";

export interface DigestHorse {
  readonly umaban: number;
  readonly name: string | null;
  readonly mark: string | null;
  readonly adjustedProb: number;
  readonly ev: number | null;
  readonly isPositive: boolean;
  /** 実着順(結果が無い・着順が空の馬は null)。 */
  readonly finishPosition: number | null;
  readonly reason: string | null;
  readonly highlights: readonly string[];
  readonly concerns: readonly string[];
}

export interface DigestTopHorse {
  readonly umaban: number;
  readonly name: string | null;
  readonly finishPosition: number;
}

export interface RaceDigest {
  readonly raceId: string;
  readonly analysisId: number;
  readonly venueName: string | null;
  readonly raceNumber: number | null;
  readonly raceName: string | null;
  readonly startTime: string | null;
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly trackCondition: string | null;
  /** LLM が効いた分析か(モデルが残っている)。効いていなければ印・根拠は統計のみの分析。 */
  readonly llmUsed: boolean;
  readonly hasResult: boolean;
  readonly horses: readonly DigestHorse[];
  /** 1〜3 着(着順の昇順)。結果が無ければ空。 */
  readonly top3: readonly DigestTopHorse[];
  readonly bets: readonly BetOutcome[];
  /** 買い目が無い理由(配分が見送りだったとき `買い目なし(見送り: <理由コード>)`)。配分の行が無い・買い目があるときは null。 */
  readonly allocationNote: string | null;
  /** 判定できた買い目の賭け金・払戻(円)・点数・的中数。 */
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly judgedBetCount: number;
  readonly hitCount: number;
  /** 判定不能の買い目の賭け金・点数。 */
  readonly unjudgedStake: number;
  readonly unjudgedBetCount: number;
}

function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let head = text.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}…`;
}

function markRank(mark: string | null): number {
  if (mark === null) {
    return MARK_ORDER.length + 1;
  }
  const i = MARK_ORDER.indexOf(mark);
  return i === -1 ? MARK_ORDER.length : i;
}

export function buildRaceDigest(view: AnalysisView, result: RaceResultData | undefined): RaceDigest {
  const finishByUmaban = new Map<number, number>();
  for (const h of result?.horses ?? []) {
    if (h.finishPosition !== null) {
      finishByUmaban.set(h.umaban, h.finishPosition);
    }
  }
  const nameByUmaban = new Map(view.horses.map((h) => [h.umaban, h.name] as const));

  let picked = view.horses.filter((h) => h.mark !== null || h.isPositive);
  if (picked.length === 0) {
    picked = [...view.horses].sort((a, b) => b.adjustedProb - a.adjustedProb || a.umaban - b.umaban).slice(0, FALLBACK_HORSE_COUNT);
  }
  const horses: DigestHorse[] = [...picked]
    .sort((a, b) => markRank(a.mark) - markRank(b.mark) || a.umaban - b.umaban)
    .slice(0, DIGEST_MAX_HORSES)
    .map((h) => ({
      umaban: h.umaban,
      name: h.name,
      mark: h.mark,
      adjustedProb: h.adjustedProb,
      ev: h.ev,
      isPositive: h.isPositive,
      finishPosition: finishByUmaban.get(h.umaban) ?? null,
      reason: h.reason === null || h.reason === "" ? null : cut(h.reason, REASON_MAX_CHARS),
      highlights: h.highlights.slice(0, ITEM_MAX_COUNT).map((s) => cut(s, ITEM_MAX_CHARS)),
      concerns: h.concerns.slice(0, ITEM_MAX_COUNT).map((s) => cut(s, ITEM_MAX_CHARS)),
    }));

  const top3: DigestTopHorse[] = [...finishByUmaban.entries()]
    .filter(([, pos]) => pos >= 1 && pos <= 3)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([umaban, finishPosition]) => ({ umaban, name: nameByUmaban.get(umaban) ?? null, finishPosition }));

  const bets = judgeBets(view.allocation?.bets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds })) ?? [], result);
  const judged = bets.filter((b) => b.status !== "unjudged");
  const unjudged = bets.filter((b) => b.status === "unjudged");
  const allocation = view.allocation;
  return {
    raceId: view.raceId,
    analysisId: view.id,
    venueName: view.race.venueName,
    raceNumber: view.race.raceNumber,
    raceName: view.race.raceName,
    startTime: view.race.startTime,
    courseType: view.race.courseType,
    distance: view.race.distance,
    trackCondition: view.race.trackCondition,
    llmUsed: view.model !== null,
    hasResult: result !== undefined,
    horses,
    top3,
    bets,
    allocationNote: allocation !== null && allocation.bets.length === 0 && allocation.skipReasonCode !== null ? `買い目なし(見送り: ${allocation.skipReasonCode})` : null,
    totalStake: judged.reduce((s, b) => s + b.stake, 0),
    totalReturn: judged.reduce((s, b) => s + b.payout, 0),
    judgedBetCount: judged.length,
    hitCount: judged.filter((b) => b.status === "hit").length,
    unjudgedStake: unjudged.reduce((s, b) => s + b.stake, 0),
    unjudgedBetCount: unjudged.length,
  };
}

export interface BetTypeStat {
  readonly betCount: number;
  readonly hitCount: number;
  readonly stake: number;
  readonly payout: number;
}

export interface MarkStat {
  readonly mark: string;
  /** 結果のあるレースで、その印が付いた馬の数(着順が分かる馬だけ)。 */
  readonly count: number;
  readonly win: number;
  readonly top3: number;
}

export interface DayStats {
  readonly raceCount: number;
  readonly resultRaceCount: number;
  readonly noResultRaceCount: number;
  readonly betRaceCount: number;
  readonly llmUsedRaceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  /** 回収率(払戻/賭け金)。賭け金が 0 なら null。 */
  readonly recoveryRate: number | null;
  readonly judgedBetCount: number;
  readonly hitBetCount: number;
  readonly unjudgedBetCount: number;
  readonly unjudgedStake: number;
  readonly byBetType: Readonly<Record<string, BetTypeStat>>;
  readonly byMark: readonly MarkStat[];
}

export function buildDayStats(digests: readonly RaceDigest[]): DayStats {
  const byBetType = new Map<string, { betCount: number; hitCount: number; stake: number; payout: number }>();
  const byMark = new Map<string, { count: number; win: number; top3: number }>();
  let totalStake = 0;
  let totalReturn = 0;
  let judgedBetCount = 0;
  let hitBetCount = 0;
  let unjudgedBetCount = 0;
  let unjudgedStake = 0;
  for (const d of digests) {
    totalStake += d.totalStake;
    totalReturn += d.totalReturn;
    judgedBetCount += d.judgedBetCount;
    hitBetCount += d.hitCount;
    unjudgedBetCount += d.unjudgedBetCount;
    unjudgedStake += d.unjudgedStake;
    for (const b of d.bets) {
      if (b.status === "unjudged") {
        continue;
      }
      const stat = byBetType.get(b.betType) ?? { betCount: 0, hitCount: 0, stake: 0, payout: 0 };
      stat.betCount += 1;
      stat.hitCount += b.status === "hit" ? 1 : 0;
      stat.stake += b.stake;
      stat.payout += b.payout;
      byBetType.set(b.betType, stat);
    }
    if (d.hasResult) {
      for (const h of d.horses) {
        if (h.mark === null || h.finishPosition === null) {
          continue;
        }
        const stat = byMark.get(h.mark) ?? { count: 0, win: 0, top3: 0 };
        stat.count += 1;
        stat.win += h.finishPosition === 1 ? 1 : 0;
        stat.top3 += h.finishPosition <= 3 ? 1 : 0;
        byMark.set(h.mark, stat);
      }
    }
  }
  const resultRaceCount = digests.filter((d) => d.hasResult).length;
  return {
    raceCount: digests.length,
    resultRaceCount,
    noResultRaceCount: digests.length - resultRaceCount,
    betRaceCount: digests.filter((d) => d.bets.length > 0).length,
    llmUsedRaceCount: digests.filter((d) => d.llmUsed).length,
    totalStake,
    totalReturn,
    recoveryRate: totalStake === 0 ? null : totalReturn / totalStake,
    judgedBetCount,
    hitBetCount,
    unjudgedBetCount,
    unjudgedStake,
    byBetType: Object.fromEntries(byBetType),
    byMark: [...byMark.entries()].map(([mark, s]) => ({ mark, ...s })).sort((a, b) => markRank(a.mark) - markRank(b.mark)),
  };
}
