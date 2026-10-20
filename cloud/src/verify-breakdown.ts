/**
 * 検証画面の「人気帯ごとの期待値と回収率」(Issue #384)と「条件ごとの的中率と回収率」(Issue #385-A)。**`cloudflare:workers` を import しない**(Node でテストできる)。
 *
 * ## 何を測るか
 * 統計モデルの prior は人気順の差が小さい(#258)。そのため人気薄の期待値が過大に見積もられ、買い目に人気薄が多く入っているかもしれない。
 * 配分ベースの買い目(`proposedBet`)を人気帯で分け、帯ごとに次を並べる:
 *  - **提案時の期待値**(賭け金加重 `Σ stake×ev ÷ Σ stake`。1.0 が損益分岐)と**実際の回収率**(確定払戻 ÷ 賭け金)。
 *  - **予想した的中数**(買い目ごとの `ev ÷ odds` = 分析時の的中確率の和)と**実際の的中数**、その比。複勝・ワイドの `odds` は複勝オッズの**下限**で、実払戻が上振れする
 *    (回収率が期待値を上回りやすい)ので、人気とは関係のないこのずれを避けて「確率を過大に見積もったか」を見るための比。
 *
 * ## 人気の定義(ユーザーの決定 2026-10-19。買い目の券種に合わせる)
 *  - **複勝・ワイド**: 分析時の複勝オッズ下限の順位(`analysis_horses.place_odds_min` の小さい順。同点は小さい方の順位を共有)。確定時の複勝オッズは D1 に無い。分析時に知りえた値。
 *    **結果(取消など)を見て順位を変えない**。単勝の人気とは一致しないことがある。
 *  - **単勝・馬連・馬単・3連複・3連単**: 確定時の単勝人気(`race_results.ninki`)。結果を振り返る集計で、購入時には分からない値。
 *  - 組合せは**構成馬のうち最も人気薄の馬**で分ける(1 頭でも人気薄を含むかを見る)。順位・人気が無い馬を含む買い目は「人気不明」。
 *  - 枠連は枠番の組で、馬の人気に直せないので**対象外**(件数と賭け金だけを出す)。
 * 帯は 4 つ: 1〜3 / 4〜6 / 7〜9 / 10 以下。券種のグループごとに表を分ける(複勝 / 単勝 / ワイド / 馬連・馬単・3連複・3連単)。
 *
 * ## 単複の人気のずれ
 * 「単勝は人気薄なのに複勝は売れている馬」を、モデルが当てられているかを見る内訳。買い目を、構成馬ごとの `確定の単勝人気 − 分析時の複勝順位` で分ける
 * (区切りは {@link WIN_PLACE_GAP_MIN}。置き値)。1 頭でも差が区切り以上なら「単勝は人気薄」、区切り以下の負なら「複勝は人気薄」、両方の向きの馬を含めば「両方」。
 *
 * ## 判定は本体と同じ
 * 買い目の的中・外れ・返還・判定不能は、core の `collectProposedBetEvents`(本体の `proposedBet` と同じ判定から出る事象)を使う。ここでは作り直さない。
 * 帯・人気不明・対象外の合計は、本体の券種別の要約と一致する(テストが固定している)。判定不能の買い目はどの行にも入らない。
 *
 * ## 数字の揺れ
 * 区間は**レース単位のクラスタ・ブートストラップ**(パーセンタイル法・95%・1000 回・固定シード)。同じレースの買い目は独立でないので、買い目単位の再標本にしない。
 * クラスタが 1 つ以下の行は区間なし。標本が小さいと区間は実際より狭く出る(目安)。区間は行ごとの 95% で、行が多いと偶然外れる行が出る。
 * 30 レース未満の行には「参考」の印を付ける({@link BREAKDOWN_REFERENCE_MIN_RACES}。検証画面の再計算の比較と同じ置き値で、統計的な閾値ではない)。
 *
 * ## 条件ごとの的中率と回収率(Issue #385-A: 競馬場・頭数帯・開催区分)
 * どの条件で当たりにくいか・回収率が悪いかを見て、見送りの判断の材料にする(後の #386 が同じ集計を使う)。**単位はレース**(見送りがレース単位の判断なので): 配分ベースの買い目のあったレースごとに
 * {賭け金, 払戻, 1 点でも的中したか}(レース台帳 {@link buildRaceLedger})を作り、条件で分ける。的中レース率は Wilson 区間、回収率はレース単位のブートストラップ区間。条件の行には『全体との差』を付ける。
 *  - 競馬場: race_id の場コードから(D1・R2 の追加の読みなし)。コード順(中央 01〜10、地方 30〜)。{@link CONDITION_MERGE_MIN_RACES} レース未満の場は「その他の場」にまとめる(区間を出しても読めないため)。
 *  - 頭数帯(〜8 / 9〜12 / 13〜15 / 16〜): 分析時の出走頭数(`analysis_horses` の行数。すでに読んでいる)。馬の行が無い分析は「頭数不明」。
 *  - 開催区分(中央 / 地方): 全体の区分のタブにだけ出す。
 *  - 距離帯・馬場状態・クラス・芝ダは D1 に無く(R2 のスナップショットにだけある)、別の Issue(migration と補完が要る)。
 *
 * ## 画面への渡し方
 * 節の説明・注記・行の見出し・項目の名前と値は**サーバが文字列に組み立てて渡す**(日本語をクライアントの束に置かない。1 文字 6 バイト。#379 と同じ流儀)。
 */

import { collectProposedBetEvents, PRODUCTION_VERIFY_CONFIG, type ProposedBetEvent, type VerifyVenueFilter } from "../../packages/core/src/ev/verify.js";
import type { StoredAnalysisHorse, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";
import { wilsonInterval } from "../../packages/core/src/ev/binomial-interval.js";
import { venueNameFromRaceId } from "../../packages/core/src/analysis/venue-codes.js";
import { parseComboOddsKey } from "../../packages/core/src/scraper/combo-odds-key.js";
import { parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import { mulberry32 } from "../../packages/core/src/common/random.js";
import { formatRecoveryPercent } from "./recovery-format";
import type { VerifyBetRow } from "./verify-read";

/** ブートストラップの反復回数(ユーザー指定)。 */
export const BREAKDOWN_BOOTSTRAP_ITERATIONS = 1000;
/** ブートストラップの乱数の種。固定(キャッシュと試験が決定的になる)。 */
const BOOTSTRAP_SEED = 20261019;
/** 「参考」の印を付ける、レース数の境界(未満なら付ける)。**根拠のない置き値**(検証画面の再計算の比較〈`CLOSE_REFERENCE_MIN_COUNT`〉と同じ 30。統計的な閾値ではなく、連動もしない)。 */
export const BREAKDOWN_REFERENCE_MIN_RACES = 30;
/** 単複の人気のずれの区切り(`確定の単勝人気 − 分析時の複勝順位` の絶対値がこれ以上でずれあり)。**根拠のない置き値**(着手前ゲートの案。実データの分布は未確認)。 */
export const WIN_PLACE_GAP_MIN = 4;

// ---------------------------------------------------------------------------
// 人気の順位と帯
// ---------------------------------------------------------------------------

/**
 * 分析時の複勝オッズ下限の順位(馬番 → 順位)。オッズの小さい順に 1 位から、同点は小さい方の順位を共有する(次の順位は飛ぶ)。
 * オッズが無い(null)・0 以下・有限でない馬は順位を持たず、ほかの馬の順位にも数えない。**結果(取消など)は見ない**(分析時に知りえた値だけで決める)。
 */
export function popularityRanks(horses: readonly StoredAnalysisHorse[]): Map<number, number> {
  const usable = horses.filter((h): h is StoredAnalysisHorse & { placeOddsMin: number } => h.placeOddsMin !== null && Number.isFinite(h.placeOddsMin) && h.placeOddsMin > 0);
  const ranks = new Map<number, number>();
  for (const h of usable) {
    ranks.set(h.umaban, 1 + usable.filter((o) => o.placeOddsMin < h.placeOddsMin).length);
  }
  return ranks;
}

/** 人気の帯(4 つ)の添字: 1〜3 → 0、4〜6 → 1、7〜9 → 2、10 以下 → 3。 */
export function popularityBandIndex(rank: number): number {
  return rank <= 3 ? 0 : rank <= 6 ? 1 : rank <= 9 ? 2 : 3;
}

const BAND_LABELS: readonly string[] = ["1〜3番人気", "4〜6番人気", "7〜9番人気", "10番人気以下"];

// ---------------------------------------------------------------------------
// ブートストラップ
// ---------------------------------------------------------------------------

/** 1 レース(クラスタ)ぶんの 2 つの比の分子・分母。1 つ目 = 回収率(払戻 / 賭け金)、2 つ目 = 的中数の比(実際の的中数 / 予想した的中数)。 */
export interface RatioCluster {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}
export interface RatioInterval {
  readonly lower: number;
  readonly upper: number;
}

function percentileInterval(values: Float64Array, count: number): RatioInterval | null {
  if (count === 0) {
    return null;
  }
  const sorted = values.subarray(0, count).sort();
  return { lower: sorted[Math.floor(0.025 * count)]!, upper: sorted[Math.min(count - 1, Math.floor(0.975 * count))]! };
}

/**
 * レース単位のクラスタ・ブートストラップ(パーセンタイル法・95%)で、2 つの比 `Σx1/Σy1` と `Σx2/Σy2` の区間を同じ再標本から求める。
 * クラスタが 1 つ以下なら両方 null(再標本しても同じ値しか出ない)。全体の分母の合計が 0 の側は null。再標本で分母が 0 になった回はその側から外す。
 * 乱数は固定シード(呼び出しごとに初期化するので、行の区間はほかの行の有無に依らない)。
 */
export function bootstrapRatioIntervals(clusters: readonly RatioCluster[]): { readonly first: RatioInterval | null; readonly second: RatioInterval | null } {
  const n = clusters.length;
  if (n < 2) {
    return { first: null, second: null };
  }
  const x1 = Float64Array.from(clusters, (c) => c.x1);
  const y1 = Float64Array.from(clusters, (c) => c.y1);
  const x2 = Float64Array.from(clusters, (c) => c.x2);
  const y2 = Float64Array.from(clusters, (c) => c.y2);
  const wantFirst = y1.reduce((s, v) => s + v, 0) > 0;
  const wantSecond = y2.reduce((s, v) => s + v, 0) > 0;
  const random = mulberry32(BOOTSTRAP_SEED);
  const firsts = new Float64Array(BREAKDOWN_BOOTSTRAP_ITERATIONS);
  const seconds = new Float64Array(BREAKDOWN_BOOTSTRAP_ITERATIONS);
  let firstCount = 0;
  let secondCount = 0;
  for (let b = 0; b < BREAKDOWN_BOOTSTRAP_ITERATIONS; b += 1) {
    let sx1 = 0;
    let sy1 = 0;
    let sx2 = 0;
    let sy2 = 0;
    for (let i = 0; i < n; i += 1) {
      const k = Math.floor(random() * n);
      sx1 += x1[k]!;
      sy1 += y1[k]!;
      sx2 += x2[k]!;
      sy2 += y2[k]!;
    }
    if (wantFirst && sy1 > 0) {
      firsts[firstCount] = sx1 / sy1;
      firstCount += 1;
    }
    if (wantSecond && sy2 > 0) {
      seconds[secondCount] = sx2 / sy2;
      secondCount += 1;
    }
  }
  return { first: wantFirst ? percentileInterval(firsts, firstCount) : null, second: wantSecond ? percentileInterval(seconds, secondCount) : null };
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/** 1 行(帯など)の集計。 */
export interface BandStat {
  /** 判定できた買い目の点数(的中・外れ・返還。判定不能は含まない。本体の `betCount` と同じ数え方)。 */
  readonly bets: number;
  /** 買い目のあったレースの数(クラスタの数)。 */
  readonly races: number;
  readonly stake: number;
  readonly payout: number;
  /** 的中した点数。**予想と比べられる買い目(的中・外れで、ev と odds がある)だけ**を数える(`expectedHits` と同じ集合)。 */
  readonly hits: number;
  /** ev がある買い目の点数(期待値の平均の対象)。 */
  readonly evBets: number;
  /** ev が無い(欠損)買い目の点数 = `bets - evBets`。 */
  readonly evMissing: number;
  /** 提案時の期待値の賭け金加重平均(ev がある買い目だけ)。無ければ null。 */
  readonly meanEv: number | null;
  /** 予想した的中数 = Σ ev ÷ odds(的中・外れで、ev と odds がある買い目)。 */
  readonly expectedHits: number;
  /** 回収率 = 払戻 ÷ 賭け金。賭け金が 0 なら null。 */
  readonly recovery: number | null;
  /** 的中数の比 = hits ÷ expectedHits。予想した的中数が 0 なら null。 */
  readonly hitRatio: number | null;
  readonly recoveryInterval: RatioInterval | null;
  readonly hitRatioInterval: RatioInterval | null;
}

/** 券種のグループ。place = 複勝、win = 単勝、wide = ワイド、combo = 馬連・馬単・3連複・3連単。 */
export type PopularityGroupKey = "place" | "win" | "wide" | "combo";
/** 人気の基準。analysis = 分析時の複勝オッズ下限の順位、final = 確定時の単勝人気。 */
export type PopularityBasis = "analysis" | "final";

export interface GroupStat {
  readonly key: PopularityGroupKey;
  readonly basis: PopularityBasis;
  /** 4 つの帯(1〜3 / 4〜6 / 7〜9 / 10 以下)。 */
  readonly bands: readonly BandStat[];
  /** 人気不明(順位・人気が無い馬を含む買い目)。 */
  readonly unknown: BandStat;
  /** 対象外(枠連)。組合せのグループだけ持つ(他は null)。 */
  readonly excluded: { readonly bets: number; readonly stake: number } | null;
}

export type GapKey = "winLonger" | "placeLonger" | "both" | "small" | "unknown";

export interface PopularityStats {
  readonly groups: readonly GroupStat[];
  /** 単複の人気のずれの行(winLonger → placeLonger → both → small → unknown の順)。 */
  readonly gap: readonly { readonly key: GapKey; readonly stat: BandStat }[];
}

interface Accumulator {
  bets: number;
  stake: number;
  payout: number;
  hits: number;
  evBets: number;
  evStake: number;
  evWeighted: number;
  expectedHits: number;
  clusters: Map<string, { x1: number; y1: number; x2: number; y2: number }>;
}

function emptyAccumulator(): Accumulator {
  return { bets: 0, stake: 0, payout: 0, hits: 0, evBets: 0, evStake: 0, evWeighted: 0, expectedHits: 0, clusters: new Map() };
}

interface BetExtra {
  readonly odds: number | null;
  readonly ev: number | null;
}

/** 買い目の odds・ev を引く索引(キーは `analysisId:betType:comboKey`)。行が odds・ev を持たない(旧いテストの固定データ)ときは null として入れる。 */
export function buildBetExtras(rows: readonly VerifyBetRow[]): Map<string, BetExtra> {
  const map = new Map<string, BetExtra>();
  for (const r of rows) {
    map.set(`${r.analysisId}:${r.betType}:${r.comboKey}`, { odds: r.odds ?? null, ev: r.ev ?? null });
  }
  return map;
}

const isFiniteNumber = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

function addEvent(acc: Accumulator, event: ProposedBetEvent, extra: BetExtra | undefined): void {
  acc.bets += 1;
  acc.stake += event.stake;
  acc.payout += event.payout;
  const cluster = acc.clusters.get(event.raceId) ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
  cluster.x1 += event.payout;
  cluster.y1 += event.stake;
  const ev = extra?.ev ?? null;
  if (isFiniteNumber(ev)) {
    acc.evBets += 1;
    acc.evStake += event.stake;
    acc.evWeighted += event.stake * ev;
    const odds = extra?.odds ?? null;
    if ((event.outcome === "hit" || event.outcome === "miss") && isFiniteNumber(odds) && odds > 0) {
      const p = ev / odds;
      acc.expectedHits += p;
      cluster.y2 += p;
      if (event.outcome === "hit") {
        acc.hits += 1;
        cluster.x2 += 1;
      }
    }
  }
  acc.clusters.set(event.raceId, cluster);
}

function finalize(acc: Accumulator): BandStat {
  const clusters = [...acc.clusters.values()];
  const intervals = clusters.length >= 2 ? bootstrapRatioIntervals(clusters) : { first: null, second: null };
  return {
    bets: acc.bets,
    races: clusters.length,
    stake: acc.stake,
    payout: acc.payout,
    hits: acc.hits,
    evBets: acc.evBets,
    evMissing: acc.bets - acc.evBets,
    meanEv: acc.evStake > 0 ? acc.evWeighted / acc.evStake : null,
    expectedHits: acc.expectedHits,
    recovery: acc.stake > 0 ? acc.payout / acc.stake : null,
    hitRatio: acc.expectedHits > 0 ? acc.hits / acc.expectedHits : null,
    recoveryInterval: intervals.first,
    hitRatioInterval: intervals.second,
  };
}

/** 順位・人気の索引。分析ごとの順位と、レースごとの確定の単勝人気を、使うときに作って覚える。 */
export interface PopularityLookups {
  ranksOf(analysisId: number): ReadonlyMap<number, number>;
  ninkiOf(raceId: string): ReadonlyMap<number, number>;
  /** 分析時の出走頭数(`analysis_horses` の行数。馬の行が無い分析は 0)。 */
  fieldSizeOf(analysisId: number): number;
}

export function createPopularityLookups(source: VerifyDataSource): PopularityLookups {
  const horsesById = new Map(source.listAnalyses().map((a) => [a.id, a.horses] as const));
  const rankCache = new Map<number, ReadonlyMap<number, number>>();
  const ninkiCache = new Map<string, ReadonlyMap<number, number>>();
  return {
    ranksOf(analysisId) {
      let ranks = rankCache.get(analysisId);
      if (ranks === undefined) {
        ranks = popularityRanks(horsesById.get(analysisId) ?? []);
        rankCache.set(analysisId, ranks);
      }
      return ranks;
    },
    fieldSizeOf(analysisId) {
      return horsesById.get(analysisId)?.length ?? 0;
    },
    ninkiOf(raceId) {
      let ninki = ninkiCache.get(raceId);
      if (ninki === undefined) {
        const map = new Map<number, number>();
        for (const r of source.getResult(raceId) ?? []) {
          if (isFiniteNumber(r.ninki) && r.ninki >= 1) {
            map.set(r.umaban, r.ninki);
          }
        }
        ninki = map;
        ninkiCache.set(raceId, ninki);
      }
      return ninki;
    },
  };
}

const GROUP_OF_BET_TYPE: Readonly<Record<string, { readonly key: PopularityGroupKey; readonly basis: PopularityBasis } | undefined>> = {
  place: { key: "place", basis: "analysis" },
  win: { key: "win", basis: "final" },
  wide: { key: "wide", basis: "analysis" },
  quinella: { key: "combo", basis: "final" },
  exacta: { key: "combo", basis: "final" },
  trio: { key: "combo", basis: "final" },
  trifecta: { key: "combo", basis: "final" },
};

const GROUP_ORDER: readonly { readonly key: PopularityGroupKey; readonly basis: PopularityBasis }[] = [
  { key: "place", basis: "analysis" },
  { key: "win", basis: "final" },
  { key: "wide", basis: "analysis" },
  { key: "combo", basis: "final" },
];

const GAP_ORDER: readonly GapKey[] = ["winLonger", "placeLonger", "both", "small", "unknown"];

/** 構成馬の値の最大(1 頭でも値が無ければ null)。 */
function maxOver(legs: readonly number[], values: ReadonlyMap<number, number>): number | null {
  let max = -Infinity;
  for (const umaban of legs) {
    const v = values.get(umaban);
    if (v === undefined) {
      return null;
    }
    max = Math.max(max, v);
  }
  return legs.length === 0 ? null : max;
}

/** 買い目の構成馬ごとの「確定の単勝人気 − 分析時の複勝順位」から、ずれの行を決める。1 頭でも片方が無ければ unknown。 */
function gapKeyOf(legs: readonly number[], ranks: ReadonlyMap<number, number>, ninki: ReadonlyMap<number, number>): GapKey {
  let up = false;
  let down = false;
  for (const umaban of legs) {
    const rank = ranks.get(umaban);
    const win = ninki.get(umaban);
    if (rank === undefined || win === undefined) {
      return "unknown";
    }
    if (win - rank >= WIN_PLACE_GAP_MIN) up = true;
    if (rank - win >= WIN_PLACE_GAP_MIN) down = true;
  }
  return legs.length === 0 ? "unknown" : up && down ? "both" : up ? "winLonger" : down ? "placeLonger" : "small";
}

/**
 * 判定済みの事象(判定不能は除く)を、券種に合わせた人気の帯と、単複の人気のずれの行に分けて集計する。
 * `events` は呼び出し側が区分で絞ったもの。`extras` は買い目の odds・ev(`buildBetExtras`)。
 */
export function buildPopularityStats(
  source: VerifyDataSource,
  events: readonly ProposedBetEvent[],
  extras: ReadonlyMap<string, BetExtra>,
  lookups: PopularityLookups = createPopularityLookups(source),
): PopularityStats {
  const groups = new Map(GROUP_ORDER.map((g) => [g.key, { bands: Array.from({ length: 4 }, emptyAccumulator), unknown: emptyAccumulator() }] as const));
  const gap = new Map(GAP_ORDER.map((k) => [k, emptyAccumulator()] as const));
  let excluded = { bets: 0, stake: 0 };
  for (const event of events) {
    if (event.outcome === "unjudged") {
      continue;
    }
    if (event.betType === "bracketQuinella") {
      excluded = { bets: excluded.bets + 1, stake: excluded.stake + event.stake };
      continue;
    }
    const meta = GROUP_OF_BET_TYPE[event.betType];
    if (meta === undefined) {
      continue;
    }
    const extra = extras.get(`${event.analysisId}:${event.betType}:${event.comboKey}`);
    const legs = parseComboOddsKey(event.comboKey) ?? [];
    const ranks = lookups.ranksOf(event.analysisId);
    const ninki = lookups.ninkiOf(event.raceId);
    const popularity = maxOver(legs, meta.basis === "analysis" ? ranks : ninki);
    const target = groups.get(meta.key)!;
    addEvent(popularity === null ? target.unknown : target.bands[popularityBandIndex(popularity)]!, event, extra);
    addEvent(gap.get(gapKeyOf(legs, ranks, ninki))!, event, extra);
  }
  return {
    groups: GROUP_ORDER.map(({ key, basis }) => {
      const g = groups.get(key)!;
      return { key, basis, bands: g.bands.map(finalize), unknown: finalize(g.unknown), excluded: key === "combo" ? excluded : null };
    }),
    gap: GAP_ORDER.map((key) => ({ key, stat: finalize(gap.get(key)!) })),
  };
}

// ---------------------------------------------------------------------------
// 表示用の節(サーバが文字列に組み立てる)
// ---------------------------------------------------------------------------

export interface BreakdownCell {
  readonly name: string;
  readonly value: string;
}
export interface BreakdownRow {
  readonly label: string;
  readonly cells: readonly BreakdownCell[];
}
export interface BreakdownSection {
  readonly heading: string;
  readonly description: string;
  readonly note: string;
  readonly rows: readonly BreakdownRow[];
}

const percentRange = (r: RatioInterval): string => `${(r.lower * 100).toFixed(1)}〜${(r.upper * 100).toFixed(1)}%`;
const ratioRange = (r: RatioInterval): string => `${r.lower.toFixed(2)}〜${r.upper.toFixed(2)}`;

/** 1 行の項目。買い目が無い行は件数だけ。 */
function statCells(stat: BandStat): BreakdownCell[] {
  if (stat.bets === 0) {
    return [{ name: "件数(レース)", value: "0点(0R)" }];
  }
  const cells: BreakdownCell[] = [
    { name: "件数(レース)", value: `${stat.bets}点(${stat.races}R)` },
    { name: "予想した期待値", value: stat.meanEv === null ? "-" : formatRecoveryPercent(stat.meanEv) },
    {
      name: "実際の回収率",
      value: stat.recovery === null ? "-" : `${formatRecoveryPercent(stat.recovery)}${stat.recoveryInterval === null ? "" : `(${percentRange(stat.recoveryInterval)})`}`,
    },
  ];
  const gapPt = stat.recovery !== null && stat.meanEv !== null ? (stat.recovery - stat.meanEv) * 100 : null;
  cells.push(
    { name: "差(実績−予想)", value: gapPt === null ? "-" : `${gapPt >= 0 ? "+" : ""}${gapPt.toFixed(1)}pt` },
    { name: "的中数(実/予想)", value: stat.expectedHits > 0 ? `${stat.hits}/${stat.expectedHits.toFixed(1)}` : "-" },
    {
      name: "的中数の比",
      value: stat.hitRatio === null ? "-" : `${stat.hitRatio.toFixed(2)}${stat.hitRatioInterval === null ? "" : `(${ratioRange(stat.hitRatioInterval)})`}`,
    },
  );
  if (stat.evMissing > 0) {
    cells.push({ name: "期待値の欠損", value: `${stat.evMissing}点` });
  }
  if (stat.races < BREAKDOWN_REFERENCE_MIN_RACES) {
    cells.push({ name: "注意", value: `参考(${BREAKDOWN_REFERENCE_MIN_RACES}レース未満)` });
  }
  return cells;
}

const COMMON_NOTE = `95%区間は、レース単位の再標本(${BREAKDOWN_BOOTSTRAP_ITERATIONS}回)で求めた目安で、件数が少ないと実際より狭く出ます。区間は行ごとの 95% なので、行が多いと偶然外れる行が出ます。「参考」は ${BREAKDOWN_REFERENCE_MIN_RACES} レース未満の行です。`;
const FINAL_BASIS_WARNING = "結果を振り返る集計で、購入時には分からない値です";

const SECTION_TEXT: Readonly<Record<PopularityGroupKey, { readonly heading: string; readonly description: string; readonly note: string; readonly labelPrefix: string }>> = {
  place: {
    heading: "人気帯ごとの期待値と回収率(複勝)",
    description:
      "買い目の馬を、分析時の複勝オッズ下限の順位(人気)で分けています。分析時に知りえた値ですが、単勝の人気とは一致しないことがあります。" +
      "帯ごとに、提案時の期待値(賭け金加重)と実際の回収率、予想した的中数(買い目ごとの 期待値÷オッズ の和)と実際の的中数を比べます。",
    note: `複勝・ワイドの期待値は複勝オッズの下限で計算しているため、実際の払戻が上振れしやすく、回収率が期待値を上回りやすい傾向があります(人気とは関係のない差)。帯どうしの差と、的中数の比を併せて見てください。${COMMON_NOTE}`,
    labelPrefix: "",
  },
  win: {
    heading: "人気帯ごとの期待値と回収率(単勝)",
    description:
      `買い目の馬を、確定時の単勝人気(結果の人気)で分けています。${FINAL_BASIS_WARNING}。` +
      "帯ごとに、提案時の期待値(賭け金加重)と実際の回収率、予想した的中数(買い目ごとの 期待値÷オッズ の和)と実際の的中数を比べます。",
    note: `確定時の人気は結果の取り込み後に付くため、取消・除外の馬や旧い記録は「人気不明」に入ります。${COMMON_NOTE}`,
    labelPrefix: "",
  },
  wide: {
    heading: "人気帯ごとの期待値と回収率(ワイド)",
    description:
      "買い目を、分析時の複勝オッズ下限の順位で分けています。ワイドは構成馬のうち最も人気薄の馬の順位を使います(人気薄を 1 頭でも含むかを見るため)。" +
      "分析時に知りえた値ですが、単勝の人気とは一致しないことがあります。",
    note: `複勝・ワイドの期待値は複勝オッズの下限で計算しているため、実際の払戻が上振れしやすく、回収率が期待値を上回りやすい傾向があります(人気とは関係のない差)。帯どうしの差と、的中数の比を併せて見てください。${COMMON_NOTE}`,
    labelPrefix: "最低人気 ",
  },
  combo: {
    heading: "人気帯ごとの期待値と回収率(馬連・馬単・3連複・3連単)",
    description:
      `買い目を、確定時の単勝人気(結果の人気)で分けています。構成馬のうち最も人気薄の馬の人気を使います(人気薄を 1 頭でも含むかを見るため)。${FINAL_BASIS_WARNING}。` +
      "枠連は枠番の組で、馬の人気に直せないため対象外です。",
    note: `3頭の券種ほど、最も人気薄の馬の人気が大きくなり、人気の低い帯に寄ります。${COMMON_NOTE}`,
    labelPrefix: "最低人気 ",
  },
};

const GAP_LABELS: Readonly<Record<GapKey, string>> = {
  winLonger: `単勝は人気薄・複勝は売れている(差${WIN_PLACE_GAP_MIN}以上)`,
  placeLonger: `複勝は人気薄・単勝は売れている(差${WIN_PLACE_GAP_MIN}以上)`,
  both: "両方の向きの馬を含む",
  small: `ずれが小さい(差${WIN_PLACE_GAP_MIN - 1}以下)`,
  unknown: "人気不明",
};

const GAP_SECTION = {
  heading: "単勝人気と複勝順位のずれ",
  description:
    `買い目を、構成馬ごとの「確定時の単勝人気 − 分析時の複勝オッズ下限の順位」で分けています。差が ${WIN_PLACE_GAP_MIN} 以上の馬を含む買い目は「単勝は人気薄なのに複勝は売れている」、` +
    `${WIN_PLACE_GAP_MIN} 以下の負の馬を含む買い目は逆向き、両方の向きの馬を含めば「両方」です。モデルが、単複の人気がずれた馬を当てられているかを見ます。${FINAL_BASIS_WARNING}。` +
    "券種は混ぜて集計しています(枠連は除く)。",
  note: `区切りの ${WIN_PLACE_GAP_MIN} は、根拠のない置き値です。券種を混ぜているので、回収率より的中数の比のほうが券種の違いに左右されません。${COMMON_NOTE}`,
};

/** 集計を、画面に渡す節(複勝 → 単勝 → ワイド → 組合せ → 単複のずれ)に組み立てる。ずれの行が無ければその節は出さない。 */
export function renderPopularitySections(stats: PopularityStats): BreakdownSection[] {
  const sections: BreakdownSection[] = stats.groups.map((group) => {
    const text = SECTION_TEXT[group.key];
    const rows: BreakdownRow[] = group.bands.map((band, i) => ({ label: `${text.labelPrefix}${BAND_LABELS[i]!}`, cells: statCells(band) }));
    if (group.unknown.bets > 0) {
      rows.push({ label: "人気不明", cells: statCells(group.unknown) });
    }
    if (group.excluded !== null && group.excluded.bets > 0) {
      rows.push({ label: "枠連(馬の人気に直せないため対象外)", cells: [{ name: "件数(レース)", value: `${group.excluded.bets}点` }] });
    }
    return { heading: text.heading, description: text.description, note: text.note, rows };
  });
  if (stats.gap.length > 0) {
    const rows = stats.gap
      .filter(({ key, stat }) => (key !== "both" && key !== "unknown") || stat.bets > 0)
      .map(({ key, stat }) => ({ label: GAP_LABELS[key], cells: statCells(stat) }));
    sections.push({ ...GAP_SECTION, rows });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// 条件ごとの的中率と回収率(Issue #385-A: 競馬場・頭数帯・開催区分)
// ---------------------------------------------------------------------------

/** 買い目のあった 1 レースの集計(レース台帳の 1 行)。見送りの判断(後の #386)がレース単位なので、集計の単位をレースにする。 */
export interface RaceLedgerRow {
  readonly raceId: string;
  readonly analysisId: number;
  /** 判定できた買い目の点数(的中・外れ・返還。判定不能は含まない)。 */
  readonly bets: number;
  readonly stake: number;
  readonly payout: number;
  /** 1 点でも的中したか(返還は的中でない)。 */
  readonly hit: boolean;
}

/** 判定できた買い目(判定不能を除く全 8 券種。枠連を含む)を、レースごとに束ねる。判定不能の買い目だけのレースは入らない。 */
export function buildRaceLedger(events: readonly ProposedBetEvent[]): RaceLedgerRow[] {
  const rows = new Map<string, { analysisId: number; bets: number; stake: number; payout: number; hit: boolean }>();
  for (const event of events) {
    if (event.outcome === "unjudged") {
      continue;
    }
    const row = rows.get(event.raceId) ?? { analysisId: event.analysisId, bets: 0, stake: 0, payout: 0, hit: false };
    row.bets += 1;
    row.stake += event.stake;
    row.payout += event.payout;
    row.hit = row.hit || event.outcome === "hit";
    rows.set(event.raceId, row);
  }
  return [...rows.entries()].map(([raceId, r]) => ({ raceId, ...r }));
}

/** 場を「その他の場」にまとめる境界(この値未満のレース数の場をまとめる)。置き値。 */
export const CONDITION_MERGE_MIN_RACES = 5;

const FIELD_BAND_LABELS: readonly string[] = ["〜8頭", "9〜12頭", "13〜15頭", "16頭〜"];
const FIELD_UNKNOWN_LABEL = "頭数不明";
const OTHER_VENUES_LABEL = `その他の場(${CONDITION_MERGE_MIN_RACES}レース未満)`;

/** 頭数帯の添字: 8 頭以下 → 0、9〜12 → 1、13〜15 → 2、16 以上 → 3。 */
export function fieldSizeBandIndex(horses: number): number {
  return horses <= 8 ? 0 : horses <= 12 ? 1 : horses <= 15 ? 2 : 3;
}

/** 条件の 1 行。 */
export interface ConditionRow {
  readonly label: string;
  readonly races: number;
  readonly bets: number;
  /** 1 点でも的中したレースの数。 */
  readonly hitRaces: number;
  /** 的中レース率 = hitRaces / races。 */
  readonly hitRate: number | null;
  /** 的中レース率の Wilson 区間(95%)。 */
  readonly hitInterval: RatioInterval | null;
  readonly stake: number;
  readonly payout: number;
  readonly recovery: number | null;
  /** 回収率のレース単位のブートストラップ区間(2 レース以上)。 */
  readonly recoveryInterval: RatioInterval | null;
  /** 回収率 − 全体(区分のタブの合計)の回収率。どちらかが null なら null。 */
  readonly diffFromAll: number | null;
}

export type ConditionKey = "kind" | "venue" | "field";

export interface ConditionStats {
  /** 区分のタブの合計(買い目のあったレース全体)。 */
  readonly overall: { readonly races: number; readonly bets: number; readonly hitRaces: number; readonly stake: number; readonly payout: number; readonly recovery: number | null; readonly hitRate: number | null; readonly hitInterval: RatioInterval | null; readonly recoveryInterval: RatioInterval | null };
  readonly dimensions: readonly { readonly key: ConditionKey; readonly rows: readonly ConditionRow[] }[];
}

interface RaceBucket {
  races: RaceLedgerRow[];
}

function summarizeRaces(label: string, races: readonly RaceLedgerRow[], overallRecovery: number | null): ConditionRow {
  const stake = races.reduce((s, r) => s + r.stake, 0);
  const payout = races.reduce((s, r) => s + r.payout, 0);
  const hitRaces = races.filter((r) => r.hit).length;
  const recovery = stake > 0 ? payout / stake : null;
  const intervals = races.length >= 2 ? bootstrapRatioIntervals(races.map((r) => ({ x1: r.payout, y1: r.stake, x2: 0, y2: 0 }))) : { first: null, second: null };
  return {
    label,
    races: races.length,
    bets: races.reduce((s, r) => s + r.bets, 0),
    hitRaces,
    hitRate: races.length > 0 ? hitRaces / races.length : null,
    hitInterval: races.length > 0 ? wilsonInterval(hitRaces, races.length) : null,
    stake,
    payout,
    recovery,
    recoveryInterval: intervals.first,
    diffFromAll: recovery !== null && overallRecovery !== null ? recovery - overallRecovery : null,
  };
}

function venueLabelOf(raceId: string): string {
  try {
    return venueNameFromRaceId(raceId);
  } catch {
    return "場不明";
  }
}

/**
 * 買い目のあったレースを、開催区分・競馬場・頭数帯の条件で分けて集計する(Issue #385-A)。`events` は呼び出し側が区分で絞ったもの。
 * 競馬場は場コード順(中央 01〜10、地方 30〜)で、{@link CONDITION_MERGE_MIN_RACES} 未満の場は「その他の場」にまとめる。頭数は分析時の出走頭数(馬の行の数)で、分からないレースは「頭数不明」。
 */
export function buildConditionStats(source: VerifyDataSource, events: readonly ProposedBetEvent[], lookups: PopularityLookups = createPopularityLookups(source)): ConditionStats {
  const ledger = buildRaceLedger(events);
  const overall = summarizeRaces("全体", ledger, null);

  const byVenue = new Map<string, RaceLedgerRow[]>();
  const kind: Record<"central" | "nar", RaceLedgerRow[]> = { central: [], nar: [] };
  const field: RaceBucket[] = FIELD_BAND_LABELS.map(() => ({ races: [] }));
  const fieldUnknown: RaceLedgerRow[] = [];
  for (const race of ledger) {
    const code = race.raceId.slice(4, 6);
    byVenue.set(code, [...(byVenue.get(code) ?? []), race]);
    const k = venueKindOf(race.raceId);
    if (k !== null) {
      kind[k].push(race);
    }
    const size = lookups.fieldSizeOf(race.analysisId);
    if (size <= 0) {
      fieldUnknown.push(race);
    } else {
      field[fieldSizeBandIndex(size)]!.races.push(race);
    }
  }

  const row = (label: string, races: readonly RaceLedgerRow[]): ConditionRow => summarizeRaces(label, races, overall.recovery);
  const venueRows: ConditionRow[] = [];
  const merged: RaceLedgerRow[] = [];
  for (const code of [...byVenue.keys()].sort()) {
    const races = byVenue.get(code)!;
    if (races.length < CONDITION_MERGE_MIN_RACES) {
      merged.push(...races);
    } else {
      venueRows.push(row(venueLabelOf(races[0]!.raceId), races));
    }
  }
  if (merged.length > 0) {
    venueRows.push(row(OTHER_VENUES_LABEL, merged));
  }
  const fieldRows = field.flatMap((b, i) => (b.races.length > 0 ? [row(FIELD_BAND_LABELS[i]!, b.races)] : []));
  if (fieldUnknown.length > 0) {
    fieldRows.push(row(FIELD_UNKNOWN_LABEL, fieldUnknown));
  }
  const kindRows = (["central", "nar"] as const).flatMap((k) => (kind[k].length > 0 ? [row(k === "central" ? "中央" : "地方", kind[k])] : []));
  return {
    overall: {
      races: overall.races, bets: overall.bets, hitRaces: overall.hitRaces, stake: overall.stake, payout: overall.payout, recovery: overall.recovery,
      hitRate: overall.hitRate, hitInterval: overall.hitInterval, recoveryInterval: overall.recoveryInterval,
    },
    dimensions: [
      { key: "kind", rows: kindRows },
      { key: "venue", rows: venueRows },
      { key: "field", rows: fieldRows },
    ],
  };
}

/** 条件の行の項目。`withDiff` が偽(全体の行)なら『全体との差』と『注意』は出さない。 */
function conditionCells(r: Pick<ConditionRow, "races" | "bets" | "hitRaces" | "hitRate" | "hitInterval" | "recovery" | "recoveryInterval"> & { readonly diffFromAll?: number | null }, withDiff: boolean): BreakdownCell[] {
  const cells: BreakdownCell[] = [
    { name: "レース数(点)", value: `${r.races}R(${r.bets}点)` },
    { name: "的中レース率", value: r.hitRate === null ? "-" : `${(r.hitRate * 100).toFixed(1)}%${r.hitInterval === null ? "" : `(${percentRange(r.hitInterval)})`}` },
    { name: "回収率", value: r.recovery === null ? "-" : `${formatRecoveryPercent(r.recovery)}${r.recoveryInterval === null ? "" : `(${percentRange(r.recoveryInterval)})`}` },
  ];
  if (withDiff) {
    const diff = r.diffFromAll ?? null;
    cells.push({ name: "全体との差", value: diff === null ? "-" : `${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(1)}pt` });
    if (r.races < BREAKDOWN_REFERENCE_MIN_RACES) {
      cells.push({ name: "注意", value: `参考(${BREAKDOWN_REFERENCE_MIN_RACES}レース未満)` });
    }
  }
  return cells;
}

const CONDITION_DESCRIPTION =
  "配分ベースの買い目のあったレースを、条件ごとに分けて集計します。的中レースは、提案した買い目が 1点でも的中したレースです(返還は的中に数えません)。" +
  "回収率は、そのレースの確定払戻 ÷ 賭け金の合計です。どの条件で当たりにくいか・回収率が悪いかを見て、見送りの判断の材料にします。";
const CONDITION_NOTE =
  `的中レース率の区間は Wilson 区間(95%)で、レースが互いに独立であることを仮定した目安です。回収率の区間は、レース単位の再標本(${BREAKDOWN_BOOTSTRAP_ITERATIONS}回)で求めた目安で、件数が少ないと実際より狭く出ます。` +
  `区間は行ごとの 95% なので、行が多いと偶然外れる行が出ます。「参考」は ${BREAKDOWN_REFERENCE_MIN_RACES} レース未満の行です。` +
  "悪い条件を探して、同じ記録で選ぶと、その条件で見送った効果は実際より良く見えます(選んだ条件は偶然悪かっただけかもしれません)。見送りを試算するときは、条件を選ぶ期間と効果を確かめる期間を分けてください。";

const CONDITION_HEADINGS: Readonly<Record<ConditionKey, string>> = {
  kind: "条件ごとの的中率と回収率(開催区分)",
  venue: "条件ごとの的中率と回収率(競馬場)",
  field: "条件ごとの的中率と回収率(頭数)",
};

/** 条件別の集計を、画面に渡す節に組み立てる。開催区分の節は全体の区分でだけ出す(中央のみ・地方のみでは行が 1 つになる)。条件の行が無い節は出さない。 */
export function renderConditionSections(stats: ConditionStats, venue: VerifyVenueFilter): BreakdownSection[] {
  const overallRow: BreakdownRow = { label: "全体", cells: conditionCells(stats.overall, false) };
  return stats.dimensions
    .filter((d) => d.rows.length > 0 && (d.key !== "kind" || venue === "all"))
    .map((d) => ({
      heading: CONDITION_HEADINGS[d.key],
      description: CONDITION_DESCRIPTION,
      note: CONDITION_NOTE,
      rows: [overallRow, ...d.rows.map((r) => ({ label: r.label, cells: conditionCells(r, true) }))],
    }));
}

// ---------------------------------------------------------------------------
// 区分ごとの集計
// ---------------------------------------------------------------------------

export interface VerifyBreakdownResult {
  readonly stats: PopularityStats;
  readonly conditions: ConditionStats;
  /** 人気帯の 5 つの節に、条件別の節(Issue #385)が続く。 */
  readonly sections: readonly BreakdownSection[];
}

/** race_id から開催区分(判定不能は null。core の区分の絞り込みと同じく、どちらにも含めない)。 */
function venueKindOf(raceId: string): "central" | "nar" | null {
  try {
    return venueKindOfRaceId(parseRaceId(raceId));
  } catch {
    return null;
  }
}

/**
 * 人気帯の内訳を、区分(all・central・nar)ごとに作る。買い目の判定は core の `collectProposedBetEvents`(本体の `proposedBet` と同じ判定)を 1 回だけ回し、
 * 区分は race_id で分ける(最新選択・先読みの除外はレース単位なので、区分で絞った本体の集計と一致する)。判定できた買い目が 1 つも無い区分は null。
 * `betRows` は全件の読みの買い目の行(odds・ev を持つ)。
 */
export function computeVerifyBreakdowns(source: VerifyDataSource, betRows: readonly VerifyBetRow[]): Record<VerifyVenueFilter, VerifyBreakdownResult | null> {
  const events = collectProposedBetEvents(source, PRODUCTION_VERIFY_CONFIG);
  const extras = buildBetExtras(betRows);
  const lookups = createPopularityLookups(source);
  const build = (filter: VerifyVenueFilter): VerifyBreakdownResult | null => {
    const scoped = filter === "all" ? events : events.filter((e) => venueKindOf(e.raceId) === filter);
    if (!scoped.some((e) => e.outcome !== "unjudged")) {
      return null;
    }
    const stats = buildPopularityStats(source, scoped, extras, lookups);
    const conditions = buildConditionStats(source, scoped, lookups);
    return { stats, conditions, sections: [...renderPopularitySections(stats), ...renderConditionSections(conditions, filter)] };
  };
  return { all: build("all"), central: build("central"), nar: build("nar") };
}
