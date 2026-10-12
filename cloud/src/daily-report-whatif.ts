/**
 * 日報の「もしも」(Issue #272)。印の定型の買い方を毎レース各 100 円で買っていたときの成績と、惜しかったレース。**純関数**: D1・R2・時計・LLM を持たない。
 *
 * ## 判定は既存の `judgeBets` に任せる(判定の流儀を複製しない)
 * 定型を `DayBet`(賭け金 100 円)にして `judgeBets`(`daily-report-bets.ts`)に渡す。結果なし・取込印なし・払戻 0 件・単勝/複勝の払戻なしを「判定不能」にする規則は、実際の買い目と同じものがそのまま働く。
 * 加えて、この機能だけの状態が 1 つある: **対象外**(`inapplicable`)。必要な印が無い(◎〇▲のどれかが付いていない)、または同じ印が複数ある(データの異常)ので、型を組めないレース。
 * 買うはずの券が無いので、判定不能(買うはずだったが結果・払戻が無く成否が分からない)とは別に数え、点数・賭け金・回収率に入れない。
 *
 * ## 型は固定
 * 後知恵にならないよう、型の一覧は {@link MARK_TEMPLATES} で固定し、日によって変えない。id は券種名と同じ。同じ券種の型を足すときは別の id を付ける。
 *
 * ## 既知の限界
 * ◎が取消・除外の馬でも「はずれ」になる(日報の `judgeBets` は `race_results.scratched` を読まない。実際の買い目と同じ扱い)。
 */
import { judgeBets, unorderedComboKey, type DayBet, type RaceResultData } from "./daily-report-bets";

export { templateLabel } from "./whatif-format";

/** 定型 1 点の賭け金(円)。 */
export const TEMPLATE_STAKE = 100;

export interface MarkTemplate {
  readonly id: string;
  readonly betType: string;
  /** 必要な印(馬の並び = キーの元)。 */
  readonly marks: readonly string[];
}

export const MARK_TEMPLATES: readonly MarkTemplate[] = [
  { id: "win", betType: "win", marks: ["◎"] },
  { id: "place", betType: "place", marks: ["◎"] },
  { id: "wide", betType: "wide", marks: ["◎", "〇"] },
  { id: "quinella", betType: "quinella", marks: ["◎", "〇"] },
  { id: "trio", betType: "trio", marks: ["◎", "〇", "▲"] },
];

/** 「惜しかったレース」の対象にする型(組合せ券種)。単勝・複勝は含めない。 */
const NEAR_MISS_IDS: ReadonlySet<string> = new Set(["wide", "quinella", "trio"]);

/** 惜しかったレースを出す最大件数(1 日分)。 */
export const NEAR_MISS_LIMIT = 3;

export type TemplateStatus = "hit" | "miss" | "unjudged" | "inapplicable";

/** 1 レースの 1 型の結果。`payout` は円(賭け金 100 円あたり。的中以外は 0)。`bought` は的中した型と同じ券種・同じ組合せが実際の買い目にあったとき true(それ以外は付けない)。 */
export interface TemplateOutcome {
  readonly id: string;
  readonly status: TemplateStatus;
  readonly payout: number;
  readonly bought?: true;
}

export interface MarkedHorse {
  readonly mark: string;
  readonly umaban: number;
}

/**
 * 1 レースの定型の結果(常に {@link MARK_TEMPLATES} の順で 5 件)。
 * `marks` はそのレースの印と馬番、`actualBets` は実際に配分した買い目(的中した型を「買っていたか」の判定に使う)。
 */
export function evaluateTemplates(marks: readonly MarkedHorse[], actualBets: readonly { readonly betType: string; readonly comboKey: string }[], result: RaceResultData | undefined): TemplateOutcome[] {
  // 印 → 馬番。同じ印が複数ある(または無い)なら null(型を組めない)。
  const umabanOf = (mark: string): number | null => {
    const hits = marks.filter((m) => m.mark === mark);
    return hits.length === 1 ? hits[0]!.umaban : null;
  };
  const planned = MARK_TEMPLATES.map((t) => {
    const umabans = t.marks.map(umabanOf);
    if (umabans.some((u) => u === null)) {
      return { template: t, bet: null };
    }
    const nums = umabans as number[];
    const comboKey = nums.length === 1 ? String(nums[0]).padStart(2, "0") : unorderedComboKey(nums);
    const bet: DayBet = { betType: t.betType, comboKey, stake: TEMPLATE_STAKE, odds: null };
    return { template: t, bet };
  });
  const judged = judgeBets(planned.flatMap((p) => (p.bet === null ? [] : [p.bet])), result);
  let next = 0;
  return planned.map(({ template, bet }): TemplateOutcome => {
    if (bet === null) {
      return { id: template.id, status: "inapplicable", payout: 0 };
    }
    const outcome = judged[next++]!;
    if (outcome.status !== "hit") {
      return { id: template.id, status: outcome.status === "miss" ? "miss" : "unjudged", payout: 0 };
    }
    const bought = actualBets.some((a) => a.betType === bet.betType && a.comboKey === bet.comboKey);
    return { id: template.id, status: "hit", payout: outcome.payout, ...(bought ? { bought: true as const } : {}) };
  });
}

// ---- 集計 ----

export interface TemplateStat {
  /** 判定できた点数(的中 + はずれ)。賭け金 = 点数 × 100 円。 */
  readonly betCount: number;
  readonly hitCount: number;
  readonly stake: number;
  readonly payout: number;
  /** 判定不能(買うはずだったが結果・取込印・払戻が無い)のレース数。成績に入れない。 */
  readonly unjudgedCount: number;
  /** 対象外(必要な印が無い)のレース数。成績に入れない。 */
  readonly inapplicableCount: number;
}

/** 型 id → 成績。5 型ぜんぶが必ず載る。 */
export type WhatIfStats = Readonly<Record<string, TemplateStat>>;

/** 集計に要る 1 レース分。`templates` が無い(旧形のダイジェスト)レースがあると、集計は null になる。 */
export interface TemplateRace {
  readonly templates?: readonly TemplateOutcome[];
}

const ZERO: TemplateStat = { betCount: 0, hitCount: 0, stake: 0, payout: 0, unjudgedCount: 0, inapplicableCount: 0 };

/** 型ごとの成績。1 レースでも `templates` が無ければ null(一部のレースだけの集計を、全体の成績として返さない)。 */
export function buildWhatIfStats(races: readonly TemplateRace[]): WhatIfStats | null {
  const acc = new Map<string, { -readonly [K in keyof TemplateStat]: TemplateStat[K] }>(MARK_TEMPLATES.map((t) => [t.id, { ...ZERO }]));
  for (const race of races) {
    if (race.templates === undefined) {
      return null;
    }
    for (const out of race.templates) {
      const s = acc.get(out.id);
      if (s === undefined) {
        continue;
      }
      if (out.status === "unjudged") {
        s.unjudgedCount += 1;
      } else if (out.status === "inapplicable") {
        s.inapplicableCount += 1;
      } else {
        s.betCount += 1;
        s.stake += TEMPLATE_STAKE;
        s.payout += out.payout;
        s.hitCount += out.status === "hit" ? 1 : 0;
      }
    }
  }
  return Object.fromEntries(acc);
}

/** 2 つの成績を足す。片方が null なら null(欠けた分だけ小さい累計を作らない)。 */
export function mergeWhatIfStats(a: WhatIfStats | null, b: WhatIfStats | null): WhatIfStats | null {
  if (a === null || b === null) {
    return null;
  }
  return Object.fromEntries(
    MARK_TEMPLATES.map((t) => {
      const x = a[t.id] ?? ZERO;
      const y = b[t.id] ?? ZERO;
      return [
        t.id,
        {
          betCount: x.betCount + y.betCount,
          hitCount: x.hitCount + y.hitCount,
          stake: x.stake + y.stake,
          payout: x.payout + y.payout,
          unjudgedCount: x.unjudgedCount + y.unjudgedCount,
          inapplicableCount: x.inapplicableCount + y.inapplicableCount,
        },
      ];
    }),
  );
}

// ---- 惜しかったレース ----

export interface NearMiss {
  readonly raceId: string;
  /** 的中した型(組合せ券種の型)。 */
  readonly templateId: string;
  /** 定型で買っていたときの払戻(円。100 円あたり)。 */
  readonly payout: number;
}

export interface NearMissSummary {
  /** 該当したレースの全件数(上限を超えても数える)。 */
  readonly total: number;
  /** 払戻の多い順に最大 {@link NEAR_MISS_LIMIT} 件(同額はレース ID 昇順)。 */
  readonly shown: readonly NearMiss[];
}

/**
 * 惜しかったレース: 組合せ券種の型(ワイド・馬連・3 連複)が的中したのに、同じ券種・同じ組合せを実際には買っていなかったレース。
 * 1 レースにつき 1 件(該当する型のうち払戻が最大のもの。同額なら先の型)。1 レースでも `templates` が無ければ null。
 */
export function pickNearMisses(races: readonly (TemplateRace & { readonly raceId: string })[], limit: number = NEAR_MISS_LIMIT): NearMissSummary | null {
  const found: NearMiss[] = [];
  for (const race of races) {
    if (race.templates === undefined) {
      return null;
    }
    let best: NearMiss | null = null;
    for (const out of race.templates) {
      if (out.status === "hit" && out.bought !== true && NEAR_MISS_IDS.has(out.id) && (best === null || out.payout > best.payout)) {
        best = { raceId: race.raceId, templateId: out.id, payout: out.payout };
      }
    }
    if (best !== null) {
      found.push(best);
    }
  }
  found.sort((a, b) => b.payout - a.payout || (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0));
  return { total: found.length, shown: found.slice(0, limit) };
}
