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
import { betHitProb, judgeBets, type BetOutcome, type RaceResultData } from "./daily-report-bets";
import { buildWhatIfStats, evaluateTemplates, mergeWhatIfStats, type TemplateOutcome, type WhatIfStats } from "./daily-report-whatif";

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
  /**
   * 印の定型の買い方の結果(Issue #272。常に 5 型)。**この項目を持つ前に積まれたジョブのダイジェストには無い**(その日の `whatIf` を作らない理由)。
   */
  readonly templates?: readonly TemplateOutcome[];
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

  const bets = judgeBets(view.allocation?.bets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })) ?? [], result);
  // 印の定型(Issue #272)。印は digest の絞り込み後ではなく分析の全馬から取る。
  const templates = evaluateTemplates(
    view.horses.flatMap((h) => (h.mark === null ? [] : [{ mark: h.mark, umaban: h.umaban }])),
    view.allocation?.bets ?? [],
    result,
  );
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
    templates,
  };
}

export interface BetTypeStat {
  readonly betCount: number;
  readonly hitCount: number;
  readonly stake: number;
  readonly payout: number;
  /** 判定できた買い目のうち、分析時点の的中確率(`betHitProb`)を導けたものの点数(Issue #264)。 */
  readonly expectedBetCount: number;
  /** 見込みの的中数: 上の点数それぞれの的中確率の合計(Issue #264)。実際の `hitCount` と並べて「当たる頻度が見込みどおりか」を見る。 */
  readonly expectedHits: number;
  /** 実際の的中数のうち、上の `expectedBetCount` と同じ買い目(確率を導けたもの)だけの数。見込み(`expectedHits`)と比べる実際の数は、分母をそろえるためこちら。 */
  readonly expectedBaseHits: number;
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
  /**
   * 判定できた買い目のうち、分析時点の的中確率を導けたものの点数と、その確率の合計(見込みの的中数。Issue #264)。
   * **判定不能の買い目は入れない**(実際の的中数と分母をそろえる)。導けない買い目〈ev・odds が無い等〉があると `expectedBetCount < judgedBetCount` になる。
   */
  readonly expectedBetCount: number;
  readonly expectedHits: number;
  /** 実際の的中数のうち、確率を導けた買い目(`expectedBetCount` と同じ集合)だけの数。**見込み `expectedHits` と並べる実際の数はこちら**(`hitBetCount` は確率を導けない買い目の的中も含む)。 */
  readonly expectedBaseHits: number;
  /**
   * 的中した買い目のうち払戻が最大の 1 点の払戻と賭け金(円。的中が無ければどちらも 0)。{@link excludingTopRecoveryRate} が「最大の 1 点を除いた回収率」を作る。
   * 払戻が同じなら賭け金の大きい方(足す順に依らず決まる)。
   */
  readonly maxPayout: number;
  readonly maxPayoutStake: number;
  readonly byBetType: Readonly<Record<string, BetTypeStat>>;
  readonly byMark: readonly MarkStat[];
  /**
   * 印の定型の買い方(各 100 円)の型ごとの成績(Issue #272)。**1 レースでも定型の結果を持たない(旧形のダイジェスト)と null**
   * (一部のレースだけの成績を全体の成績として出さない)。足し算(`mergeDayStats`)でも、片方が null なら null。
   */
  readonly whatIf: WhatIfStats | null;
}

/** 統計の集計に要る 1 レース分(ダイジェストからも、D1 の行から作る期間の統計〈`period-stats.ts`〉からも作る。同じ集計の本体を通すための共通の形)。 */
export interface StatsRace {
  readonly hasResult: boolean;
  readonly llmUsed: boolean;
  readonly bets: readonly BetOutcome[];
  /** 印の付いた馬と着順(着順が分からない馬は null)。 */
  readonly marks: readonly { readonly mark: string; readonly finishPosition: number | null }[];
  /** 印の定型の結果(Issue #272)。無いレースがあると `DayStats.whatIf` は null。 */
  readonly templates?: readonly TemplateOutcome[];
}

/** 最大払戻の 1 点の比較: 払戻が大きい方、同じなら賭け金が大きい方。 */
function topBetOf(a: { payout: number; stake: number }, b: { payout: number; stake: number }): { payout: number; stake: number } {
  return b.payout > a.payout || (b.payout === a.payout && b.stake > a.stake) ? b : a;
}

export function buildStatsFromRaces(races: readonly StatsRace[]): DayStats {
  const byBetType = new Map<string, { betCount: number; hitCount: number; stake: number; payout: number; expectedBetCount: number; expectedHits: number; expectedBaseHits: number }>();
  const byMark = new Map<string, { count: number; win: number; top3: number }>();
  let totalStake = 0;
  let totalReturn = 0;
  let judgedBetCount = 0;
  let hitBetCount = 0;
  let unjudgedBetCount = 0;
  let unjudgedStake = 0;
  let expectedBetCount = 0;
  let expectedHits = 0;
  let expectedBaseHits = 0;
  let top = { payout: 0, stake: 0 };
  for (const r of races) {
    for (const b of r.bets) {
      if (b.status === "unjudged") {
        unjudgedBetCount += 1;
        unjudgedStake += b.stake;
        continue;
      }
      judgedBetCount += 1;
      totalStake += b.stake;
      totalReturn += b.payout;
      const hit = b.status === "hit";
      hitBetCount += hit ? 1 : 0;
      if (hit) {
        top = topBetOf(top, { payout: b.payout, stake: b.stake });
      }
      const stat = byBetType.get(b.betType) ?? { betCount: 0, hitCount: 0, stake: 0, payout: 0, expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0 };
      stat.betCount += 1;
      stat.hitCount += hit ? 1 : 0;
      stat.stake += b.stake;
      stat.payout += b.payout;
      const prob = betHitProb(b.odds, b.ev);
      if (prob !== null) {
        stat.expectedBetCount += 1;
        stat.expectedHits += prob;
        stat.expectedBaseHits += hit ? 1 : 0;
        expectedBetCount += 1;
        expectedHits += prob;
        expectedBaseHits += hit ? 1 : 0;
      }
      byBetType.set(b.betType, stat);
    }
    if (r.hasResult) {
      for (const h of r.marks) {
        if (h.finishPosition === null) {
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
  const resultRaceCount = races.filter((r) => r.hasResult).length;
  return {
    raceCount: races.length,
    resultRaceCount,
    noResultRaceCount: races.length - resultRaceCount,
    betRaceCount: races.filter((r) => r.bets.length > 0).length,
    llmUsedRaceCount: races.filter((r) => r.llmUsed).length,
    totalStake,
    totalReturn,
    recoveryRate: totalStake === 0 ? null : totalReturn / totalStake,
    judgedBetCount,
    hitBetCount,
    unjudgedBetCount,
    unjudgedStake,
    expectedBetCount,
    expectedHits,
    expectedBaseHits,
    maxPayout: top.payout,
    maxPayoutStake: top.stake,
    byBetType: Object.fromEntries(byBetType),
    byMark: [...byMark.entries()].map(([mark, s]) => ({ mark, ...s })).sort((a, b) => markRank(a.mark) - markRank(b.mark)),
    whatIf: buildWhatIfStats(races),
  };
}

export function buildDayStats(digests: readonly RaceDigest[]): DayStats {
  return buildStatsFromRaces(
    digests.map((d) => ({
      hasResult: d.hasResult,
      llmUsed: d.llmUsed,
      bets: d.bets,
      ...(d.templates === undefined ? {} : { templates: d.templates }),
      marks: d.horses.flatMap((h) => (h.mark === null ? [] : [{ mark: h.mark, finishPosition: h.finishPosition }])),
    })),
  );
}

/**
 * 2 つの統計を足す(Issue #264。直前 27 日 + その日 = 28 日累計。月報〈#265〉の期間の合算にも使う)。
 * 件数・賭け金・払戻・見込みは足し、回収率は足した賭け金・払戻から作り直す(率の平均ではない)。最大払戻は大きい方。券種別・印別は和集合(印は印の順)。
 */
export function mergeDayStats(a: DayStats, b: DayStats): DayStats {
  const byBetType: Record<string, BetTypeStat> = {};
  for (const type of new Set([...Object.keys(a.byBetType), ...Object.keys(b.byBetType)])) {
    const x = a.byBetType[type];
    const y = b.byBetType[type];
    byBetType[type] = {
      betCount: (x?.betCount ?? 0) + (y?.betCount ?? 0),
      hitCount: (x?.hitCount ?? 0) + (y?.hitCount ?? 0),
      stake: (x?.stake ?? 0) + (y?.stake ?? 0),
      payout: (x?.payout ?? 0) + (y?.payout ?? 0),
      expectedBetCount: (x?.expectedBetCount ?? 0) + (y?.expectedBetCount ?? 0),
      expectedHits: (x?.expectedHits ?? 0) + (y?.expectedHits ?? 0),
      expectedBaseHits: (x?.expectedBaseHits ?? 0) + (y?.expectedBaseHits ?? 0),
    };
  }
  const marks = new Map<string, MarkStat>();
  for (const m of [...a.byMark, ...b.byMark]) {
    const cur = marks.get(m.mark);
    marks.set(m.mark, cur === undefined ? m : { mark: m.mark, count: cur.count + m.count, win: cur.win + m.win, top3: cur.top3 + m.top3 });
  }
  const totalStake = a.totalStake + b.totalStake;
  const totalReturn = a.totalReturn + b.totalReturn;
  const top = topBetOf({ payout: a.maxPayout, stake: a.maxPayoutStake }, { payout: b.maxPayout, stake: b.maxPayoutStake });
  return {
    raceCount: a.raceCount + b.raceCount,
    resultRaceCount: a.resultRaceCount + b.resultRaceCount,
    noResultRaceCount: a.noResultRaceCount + b.noResultRaceCount,
    betRaceCount: a.betRaceCount + b.betRaceCount,
    llmUsedRaceCount: a.llmUsedRaceCount + b.llmUsedRaceCount,
    totalStake,
    totalReturn,
    recoveryRate: totalStake === 0 ? null : totalReturn / totalStake,
    judgedBetCount: a.judgedBetCount + b.judgedBetCount,
    hitBetCount: a.hitBetCount + b.hitBetCount,
    unjudgedBetCount: a.unjudgedBetCount + b.unjudgedBetCount,
    unjudgedStake: a.unjudgedStake + b.unjudgedStake,
    expectedBetCount: a.expectedBetCount + b.expectedBetCount,
    expectedHits: a.expectedHits + b.expectedHits,
    expectedBaseHits: a.expectedBaseHits + b.expectedBaseHits,
    maxPayout: top.payout,
    maxPayoutStake: top.stake,
    byBetType,
    byMark: [...marks.values()].sort((x, y) => markRank(x.mark) - markRank(y.mark)),
    whatIf: mergeWhatIfStats(a.whatIf, b.whatIf),
  };
}

/**
 * 払戻が最大の 1 点を除いた回収率(Issue #264)。`(払戻 − 最大払戻) ÷ (賭け金 − その買い目の賭け金)`。
 * 的中が無い(除く 1 点が無い)・除いた残りの賭け金が 0 のときは null。回収率が 1 点の的中に支えられているかを、確定値で示す。
 */
export function excludingTopRecoveryRate(stats: Pick<DayStats, "totalStake" | "totalReturn" | "maxPayout" | "maxPayoutStake">): number | null {
  if (stats.maxPayout <= 0) {
    return null;
  }
  const stake = stats.totalStake - stats.maxPayoutStake;
  return stake <= 0 ? null : (stats.totalReturn - stats.maxPayout) / stake;
}
