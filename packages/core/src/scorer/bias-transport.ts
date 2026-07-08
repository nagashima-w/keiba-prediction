/**
 * 輸送・滞在バイアス。仕様「環境・状態バイアス補正 > 輸送・滞在バイアス」。
 *
 * (1) 輸送負荷の分類: 厩舎所在地(美浦/栗東)× 開催場から 地元圏/短距離輸送/長距離輸送 を
 *     定数テーブルで分類する(概算・チューニング対象)。
 * (2) 長距離輸送実績補正: 今回が長距離輸送なら、過去の長距離輸送を伴った走の複勝率で差分補正。
 *     2走未満は補正なし。補正 = (長距離走の複勝率 − 中央全体の複勝率) × 重み。
 * (3) 滞在競馬(札幌・函館): 今回が札幌・函館なら、過去の札幌・函館走(=滞在開催)の複勝率で
 *     差分補正(2走以上)。さらに「輸送弱」フラグの馬には滞在ボーナス(プラス補正)を加える。
 * (4) 輸送弱フラグ: 輸送を伴う過去走(地元圏以外)で -10kg以上の馬体重減が複数回(2回以上)あればON。
 *
 * 設計判断(仕様の明記事項):
 * - 転厩は追えないため、過去走の厩舎所在地は「今回と同じ」と仮定する(TransportInput.stableLocation を
 *   全過去走の分類に流用する)。これは仕様が許容する近似。
 * - 地方・海外走は輸送分類の対象外(中央10場でない会場は classifyTransportLoad が null を返し、
 *   長距離プール・滞在プール・全体母数・輸送弱カウントのいずれからも除外される)。
 * - 滞在実績の差分補正は minSampleForBias(2走)以上を要求する。仕様文言「実績があれば使用」より
 *   厳しいが、プロジェクト規約「サンプル2走未満は補正なし」との整合を優先した(輸送弱の滞在ボーナスは
 *   この母数要件とは独立に適用する)。
 * - 会場名→中央10場の判定は競馬場適性(bias-venue)と同じ isCentralVenue を再利用する。
 */

import type { DerivedRaceFeature } from "./derive-features.js";
import type { StableLocation } from "../scraper/types.js";
import { aggregatePlaceRate } from "./aggregate.js";
import { DEFAULT_SCORER_CONFIG, type ScorerConfig } from "./config.js";
import { isCentralVenue } from "./course-traits.js";

const BIAS_NAME = "輸送・滞在バイアス";

/** 輸送負荷の3分類。 */
export type TransportLoad = "地元圏" | "短距離輸送" | "長距離輸送";

/**
 * 輸送負荷の分類テーブル(概算・チューニング対象)。
 *
 * 目安(仕様ベース・距離感の逆転を避けるよう調整):
 * - 美浦(茨城): 中山・東京=地元圏、福島・新潟=短距離、
 *   中京・京都・阪神・小倉・札幌・函館=長距離
 * - 栗東(滋賀): 京都・阪神・中京=地元圏、
 *   東京・中山・福島・新潟・小倉・札幌・函館=長距離
 * 北海道(札幌・函館)は両所属とも長距離。
 *
 * 設計判断(レビュー指摘反映): 当初の仕様案は栗東→小倉を短距離としていたが、栗東→小倉(北九州)は
 * 栗東→東京(長距離)より実輸送距離が長く内部矛盾となるため、栗東→小倉は長距離に是正した。
 * その結果、栗東所属には短距離輸送に該当する中央場が存在しない(短距離バケットは空となる)。
 * 他セルも距離感の逆転がないか見直した(美浦→小倉も長距離)。
 * これらの距離感は関東・関西からの実輸送距離の概算であり、verifyの結果を見て調整する。
 */
const TRANSPORT_TABLE: Record<StableLocation, Record<string, TransportLoad>> = {
  美浦: {
    中山: "地元圏",
    東京: "地元圏",
    福島: "短距離輸送",
    新潟: "短距離輸送",
    中京: "長距離輸送",
    京都: "長距離輸送",
    阪神: "長距離輸送",
    小倉: "長距離輸送",
    札幌: "長距離輸送",
    函館: "長距離輸送",
  },
  栗東: {
    京都: "地元圏",
    阪神: "地元圏",
    中京: "地元圏",
    小倉: "長距離輸送",
    東京: "長距離輸送",
    中山: "長距離輸送",
    福島: "長距離輸送",
    新潟: "長距離輸送",
    札幌: "長距離輸送",
    函館: "長距離輸送",
  },
};

/** 滞在開催とみなす会場(洋芝・現地滞在調整が基本の北海道開催)。 */
const STAY_VENUES: readonly string[] = ["札幌", "函館"];

/**
 * 厩舎所在地 × 開催場を輸送負荷に分類する。
 * 中央10場でない会場(地方・海外)は分類対象外として null を返す。
 */
export function classifyTransportLoad(
  stable: StableLocation,
  venueName: string,
): TransportLoad | null {
  if (!isCentralVenue(venueName)) {
    return null;
  }
  return TRANSPORT_TABLE[stable][venueName] ?? null;
}

/** 今回レースの輸送条件。 */
export interface TransportInput {
  /**
   * 厩舎所在地(美浦/栗東)。転厩は追えないため、過去走もこの所在地とみなして分類する
   * (設計判断・上記コメント参照)。
   */
  readonly stableLocation: StableLocation;
  /** 今回の中央競馬場名(新潟・函館など)。 */
  readonly venueName: string;
}

/** 輸送・滞在バイアスの評価種別。 */
export type TransportKind = "長距離輸送" | "滞在" | "近距離" | "不明";

/**
 * 輸送・滞在バイアスの寄与度(ログ用内訳付き)。
 *
 * 滞在時は「差分補正(滞在走の複勝率差)」に加えて「滞在ボーナス(輸送弱の馬への加点)」が
 * 乗るため、共通の BiasContribution 不変条件(correction === (target−overall)×weight)は
 * 崩れる。そのため独自形状とし、correction = differenceCorrection + stayBonus を保持する。
 */
export interface TransportBiasContribution {
  /** バイアス名(ログ識別用)。 */
  readonly biasName: string;
  /** どの経路で評価したか(長距離輸送/滞在/近距離/不明)。 */
  readonly kind: TransportKind;
  /** 今回の輸送負荷分類(中央10場でなければ null)。 */
  readonly todayLoad: TransportLoad | null;
  /** 補正を適用したか(近距離・不明・実績不足かつ輸送弱でないなら false)。 */
  readonly applied: boolean;
  /** 適用/非適用の理由。 */
  readonly reason: string;
  /** 対象プール(長距離走 or 滞在走)のサンプル数。 */
  readonly sampleCount: number;
  /** 対象プールの複勝率。集計できない場合は null。 */
  readonly targetRate: number | null;
  /** 比較基準となる中央全体の複勝率。集計できない場合は null。 */
  readonly overallRate: number | null;
  /** 適用した重み係数。 */
  readonly weight: number;
  /** 「輸送弱」フラグ。 */
  readonly transportWeakFlag: boolean;
  /** 輸送弱判定に使った大幅減の該当回数。 */
  readonly weakDropCount: number;
  /** 差分ベースの補正((対象複勝率 − 全体複勝率) × 重み)。実績不足なら0。 */
  readonly differenceCorrection: number;
  /** 滞在 × 輸送弱のプラス補正(それ以外は0)。 */
  readonly stayBonus: number;
  /** 最終的な補正値(= differenceCorrection + stayBonus)。 */
  readonly correction: number;
}

/** 中央かつ会場名が中央10場として既知の走だけを取り出す。 */
function centralKnownRuns(
  features: readonly DerivedRaceFeature[],
): DerivedRaceFeature[] {
  return features.filter((f) => {
    const name = f.result.venue?.name;
    return (
      f.result.venueKind === "中央" &&
      name !== null &&
      name !== undefined &&
      isCentralVenue(name)
    );
  });
}

/**
 * 「輸送弱」フラグを判定する。
 * 輸送を伴う過去走(地元圏以外 = 短距離輸送 or 長距離輸送)で、馬体重減が閾値以下(既定 -10kg 以下)の
 * 走を数え、その回数が既定回数(2回)以上ならフラグON。地元圏走・地方海外走・馬体重欠損走は数えない。
 */
function countWeakTransportDrops(
  central: readonly DerivedRaceFeature[],
  stable: StableLocation,
  config: ScorerConfig,
): number {
  const { weakWeightDropThreshold } = config.transport;
  let count = 0;
  for (const f of central) {
    const name = f.result.venue!.name!;
    const load = classifyTransportLoad(stable, name);
    if (load === null || load === "地元圏") {
      continue; // 地元圏(および分類外)は輸送を伴わないので対象外。
    }
    const bw = f.result.bodyWeight;
    if (bw === null) {
      continue; // 馬体重欠損は判定できない。
    }
    if (bw.diff <= weakWeightDropThreshold) {
      count += 1;
    }
  }
  return count;
}

/**
 * 輸送・滞在バイアスの補正を計算する。
 * @param features 過去走の派生特徴量。
 * @param today 今回の輸送条件(厩舎所在地・会場)。
 * @param config scorer 設定。省略時は既定値。
 */
export function computeTransportBias(
  features: readonly DerivedRaceFeature[],
  today: TransportInput,
  config: ScorerConfig = DEFAULT_SCORER_CONFIG,
): TransportBiasContribution {
  const weight = config.weights.transport;
  const todayLoad = classifyTransportLoad(today.stableLocation, today.venueName);

  const central = centralKnownRuns(features);
  const weakDropCount = countWeakTransportDrops(
    central,
    today.stableLocation,
    config,
  );
  const transportWeakFlag = weakDropCount >= config.transport.weakDropMinCount;

  const base = {
    biasName: BIAS_NAME,
    todayLoad,
    weight,
    transportWeakFlag,
    weakDropCount,
  } as const;

  // 今回の会場が中央10場でなければ評価不能。
  if (todayLoad === null) {
    return {
      ...base,
      kind: "不明",
      applied: false,
      reason: "今回の会場が中央10場でないため補正なし",
      sampleCount: 0,
      targetRate: null,
      overallRate: null,
      differenceCorrection: 0,
      stayBonus: 0,
      correction: 0,
    };
  }

  const overall = aggregatePlaceRate(central.map((f) => f.placed));
  const isStay = STAY_VENUES.includes(today.venueName);

  // (3) 滞在競馬(札幌・函館)。滞在走の複勝率差 + 輸送弱ボーナス。
  if (isStay) {
    const stayRuns = central.filter((f) =>
      STAY_VENUES.includes(f.result.venue!.name!),
    );
    const stayAgg = aggregatePlaceRate(stayRuns.map((f) => f.placed));
    const stayBonus = transportWeakFlag ? config.transport.stayBonus * weight : 0;

    const hasStayHistory = stayAgg.sampleCount >= config.minSampleForBias;
    const differenceCorrection = hasStayHistory
      ? (stayAgg.rate - overall.rate) * weight
      : 0;
    const correction = differenceCorrection + stayBonus;

    const reason = hasStayHistory
      ? transportWeakFlag
        ? "滞在(札幌・函館)実績の複勝率で補正 + 輸送弱の滞在ボーナス"
        : "滞在(札幌・函館)実績の複勝率で補正"
      : transportWeakFlag
        ? "滞在実績2走未満だが輸送弱のため滞在ボーナスのみ適用"
        : "滞在実績2走未満のため補正なし";

    return {
      ...base,
      kind: "滞在",
      // applied は他バイアスと統一し「差分補正のサンプルが十分か(滞在実績2走以上)」を表す。
      // 輸送弱の滞在ボーナスは applied とは独立に stayBonus / correction フィールドで表現する。
      applied: hasStayHistory,
      reason,
      sampleCount: stayAgg.sampleCount,
      targetRate: stayAgg.sampleCount === 0 ? null : stayAgg.rate,
      overallRate: overall.rate,
      differenceCorrection,
      stayBonus,
      correction,
    };
  }

  // (2) 長距離輸送(滞在以外)。長距離走の複勝率差で補正。
  if (todayLoad === "長距離輸送") {
    const longRuns = central.filter(
      (f) =>
        classifyTransportLoad(today.stableLocation, f.result.venue!.name!) ===
        "長距離輸送",
    );
    const longAgg = aggregatePlaceRate(longRuns.map((f) => f.placed));

    if (longAgg.sampleCount < config.minSampleForBias) {
      return {
        ...base,
        kind: "長距離輸送",
        applied: false,
        reason: "長距離輸送の実績が2走未満のため補正なし",
        sampleCount: longAgg.sampleCount,
        targetRate: longAgg.sampleCount === 0 ? null : longAgg.rate,
        overallRate: overall.rate,
        differenceCorrection: 0,
        stayBonus: 0,
        correction: 0,
      };
    }

    const differenceCorrection = (longAgg.rate - overall.rate) * weight;
    return {
      ...base,
      kind: "長距離輸送",
      applied: true,
      reason: "長距離輸送の複勝率で補正",
      sampleCount: longAgg.sampleCount,
      targetRate: longAgg.rate,
      overallRate: overall.rate,
      differenceCorrection,
      stayBonus: 0,
      correction: differenceCorrection,
    };
  }

  // (1) 地元圏・短距離輸送: 補正しない(仕様は長距離・滞在のみを補正対象とする)。
  return {
    ...base,
    kind: "近距離",
    applied: false,
    reason: `${todayLoad}のため補正なし`,
    sampleCount: 0,
    targetRate: null,
    overallRate: overall.rate,
    differenceCorrection: 0,
    stayBonus: 0,
    correction: 0,
  };
}
