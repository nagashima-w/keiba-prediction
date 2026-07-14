/**
 * レース妙味スコア — 「妙味がありそうなレース」を探すためのレース単位の指標(純関数)。
 *
 * 背景(ユーザー要望):
 *   妙味がある馬を1頭ずつ拾う設計はあるが、大穴ばかり買い続けると回収は安定しない。
 *   そこで「レースとしてどれだけ妙味があるか」をスコア化し、レース横断で買う価値の高い
 *   レースを上位に並べられるようにする。
 *
 * スコアの設計意図(重要):
 *  - 主成分は EVプラス馬それぞれの (EV − 1) × 補正後確率 の最大値。
 *      * (EV − 1) は複勝の期待利益率(元返し=1.0 を基準にした純利益率)。
 *      * 補正後確率は「当たりやすさ」。両者の積を取ることで、確率を主成分に二重計上し、
 *        「EVは高いが当たる確率は極小」の【極端な】大穴の主成分を小さくする。
 *        ただしこれは大穴を一律に不利にする保証ではない。主成分は max raw を取るだけであり、
 *        確率差が中間的なケースでは大穴側の raw が本命側を上回り、大穴が筆頭候補になることもある
 *        (例: 本命 (1.2−1)×0.30=0.060 < 大穴 (1.8−1)×0.08=0.064)。抑制されるのはあくまで
 *        「確率が極端に小さい」大穴であり、「常に本命寄りが勝つ」性質ではない点に注意する。
 *  - 信頼度割引: 出走馬に占める低データ馬(キャリアN走未満)の割合が高いほどスコアを減衰する。
 *      * 新馬・未勝利など戦績が乏しいレースは prior 自体の推定が不確実で、モデル(scorer/LLM)を
 *        過信しやすい。割引を掛けることで、そうしたレースが上位に来にくくする(モデル過信への注意)。
 *      * 減衰式は設計判断: score = 主成分 × clamp(1 − 低データ割合 × 係数, 0, 1)。
 *
 * 見送り記録(レビュー提案・将来検討):
 *  - EVプラス頭数の多さ(レースとしての妙味の「厚み」)をスコアに加点する案は、verify の実データで
 *    回収率との相関を確認してから判断する。現状は主成分(最大 raw)と低データ割引のみで、頭数は
 *    evPlusCount として結果に持たせるだけ(表示・ランキングの参考情報)に留める。
 *
 * 対象外(スコア null + 理由):
 *  - EVプラス0頭: そもそも妙味のある馬がいない。
 *
 * oddsStatus=yoso(複勝未発売)の扱い(Task#25):
 *  当初は「EVが計算できない」ことを理由に yoso を一律スコア対象外にしていたが、Task#25で
 *  単勝オッズから複勝下限を推定してEVを概算できるようになったため、この特別扱いは廃止した。
 *  呼び出し側(analysis-pipeline/batch-summary)が推定EVで horses[].ev を埋めていれば、
 *  yoso のレースも他のレースと全く同じスコア式・除外判定(EVプラス0頭なら null)で扱う。
 *  推定EVである旨(「発売前推定」表記)はこの関数の対象ではなく、呼び出し側がレース単位で
 *  oddsStatus を見て表示する(推定EVは確定EVより誤差が大きいため、UIで明示的に区別する)。
 *  RaceOpportunityMeta.oddsStatus は将来の判定拡張に備えて残すが、現状スコア計算には使わない。
 *
 * ネットワーク・LLM・SQLite には一切依存しない(与えられた数値から決定的に算出するだけ)。
 */

/** オッズの発売状態(core OddsSnapshot.oddsStatus のプレーン写し)。 */
export type RaceOddsStatus = "result" | "middle" | "yoso";

/** 妙味計算に必要な1頭分の情報。 */
export interface RaceOpportunityHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 馬名(筆頭候補の表示に使う)。 */
  readonly horseName: string;
  /** 期待値(補正後確率 × 複勝下限)。オッズ欠損なら null(妙味計算の対象外)。 */
  readonly ev: number | null;
  /** 補正後複勝確率(0〜1)。 */
  readonly adjustedProb: number;
  /** EVが閾値を上回るか(EVプラス馬の判定)。 */
  readonly isPositive: boolean;
  /**
   * キャリア走数(戦績 results.length)。低データ判定に使う。
   * 0 は新馬相当(=判明した低データ)。戦績が取得できなかった(不明な)馬は null とし、
   * 低データ割合の分母・分子いずれからも除外する(取得失敗を新馬と混同しないため)。
   */
  readonly careerRunCount: number | null;
}

/** レース全体のメタ情報。 */
export interface RaceOpportunityMeta {
  /** オッズの発売状態(yoso のとき妙味評価不可)。 */
  readonly oddsStatus: RaceOddsStatus;
}

/** 妙味スコアの調整可能な設定。 */
export interface RaceOpportunityConfig {
  /**
   * 低データ(キャリア不足)とみなすキャリア走数の閾値。この走数「未満」(< threshold)を低データとする。
   * 仕様(ユーザー要望)の既定は5走。新馬(0走)〜数戦の馬を低データ扱いにする。
   */
  readonly lowDataThreshold: number;
  /**
   * 低データ割合に掛ける減衰係数(0〜1)。減衰係数 = clamp(1 − 低データ割合 × この値, 0, 1)。
   * 既定0.5: 全馬が低データ(割合1.0)のレースでもスコアを半分に留める(ゼロにはしない)控えめな割引。
   * チューニング対象。
   */
  readonly lowDataPenaltyCoef: number;
}

/** 既定の妙味スコア設定。 */
export const DEFAULT_RACE_OPPORTUNITY_CONFIG: RaceOpportunityConfig = {
  lowDataThreshold: 5,
  lowDataPenaltyCoef: 0.5,
};

/** 妙味レースの筆頭候補(主成分を最大化した1頭)。 */
export interface RaceOpportunityBestPick {
  /** 馬番。 */
  readonly umaban: number;
  /** 馬名。 */
  readonly horseName: string;
  /** 期待値。 */
  readonly ev: number;
  /** 補正後複勝確率。 */
  readonly adjustedProb: number;
}

/** レース妙味スコアの計算結果。 */
export interface RaceOpportunity {
  /** 妙味スコア(高いほど買う価値がある)。対象外レースは null。 */
  readonly score: number | null;
  /** 筆頭候補(主成分を最大化した馬)。EVプラス0頭・対象外なら null。 */
  readonly bestPick: RaceOpportunityBestPick | null;
  /** EVプラス馬の頭数(EV=null は含めない)。 */
  readonly evPlusCount: number;
  /**
   * キャリアが判明した馬に占める低データ馬の割合(0〜1)。
   * 戦績取得失敗(careerRunCount=null)の馬は分母・分子とも除外する。判明馬0頭なら0。
   */
  readonly lowDataRatio: number;
  /** スコアを算出しなかった理由(算出したなら null)。 */
  readonly excludedReason: string | null;
}

/** EVプラス0頭の除外理由。 */
const REASON_NO_EV_PLUS = "EVプラスの馬がいないため妙味なし";

/**
 * レース単位の妙味スコアを計算する。
 * @param horses 出走馬(EV・補正後確率・キャリア走数を含む)
 * @param meta レースメタ(オッズ発売状態)
 * @param config 妙味スコアの設定
 */
export function computeRaceOpportunity(
  horses: readonly RaceOpportunityHorse[],
  meta: RaceOpportunityMeta,
  config: RaceOpportunityConfig = DEFAULT_RACE_OPPORTUNITY_CONFIG,
): RaceOpportunity {
  // 低データ割合は除外レースでも表示注記に使うため常に算出する。
  // 戦績取得失敗(careerRunCount=null)の馬は「不明」として分母・分子から除外し、取得失敗を
  // 新馬(0走)と混同しない。キャリアが判明した馬のうち閾値未満の割合を低データ割合とする。
  const knownHorses = horses.filter(
    (h): h is RaceOpportunityHorse & { careerRunCount: number } =>
      h.careerRunCount !== null,
  );
  const lowDataRatio =
    knownHorses.length === 0
      ? 0
      : knownHorses.filter((h) => h.careerRunCount < config.lowDataThreshold)
          .length / knownHorses.length;

  // EVプラス馬(EV=null のオッズ欠損馬は金額評価できないため除外)。
  const evPlus = horses.filter(
    (h): h is RaceOpportunityHorse & { ev: number } =>
      h.isPositive && h.ev !== null,
  );
  const evPlusCount = evPlus.length;

  // 対象外の判定。yoso(複勝未発売)であっても horses[].ev に推定EVが入っていれば通常どおり
  // 算出する(Task#25。特別扱いは廃止、evPlusCount=0 の通常ルートに一本化)。
  if (evPlusCount === 0) {
    return {
      score: null,
      bestPick: null,
      evPlusCount,
      lowDataRatio,
      excludedReason: REASON_NO_EV_PLUS,
    };
  }

  // 主成分: (EV − 1) × 補正後確率 の最大値。同値は馬番昇順で決定的に選ぶ。
  let best = evPlus[0]!;
  let bestRaw = rawScore(best);
  for (const h of evPlus.slice(1)) {
    const raw = rawScore(h);
    if (raw > bestRaw || (raw === bestRaw && h.umaban < best.umaban)) {
      best = h;
      bestRaw = raw;
    }
  }

  // 信頼度割引: 低データ割合に応じてスコアを減衰する(係数は [0,1] にクランプ)。
  const decay = clamp01(1 - lowDataRatio * config.lowDataPenaltyCoef);
  const score = bestRaw * decay;

  return {
    score,
    bestPick: {
      umaban: best.umaban,
      horseName: best.horseName,
      ev: best.ev,
      adjustedProb: best.adjustedProb,
    },
    evPlusCount,
    lowDataRatio,
    excludedReason: null,
  };
}

/** 1頭の主成分値 (EV − 1) × 補正後確率。 */
function rawScore(h: RaceOpportunityHorse & { ev: number }): number {
  return (h.ev - 1) * h.adjustedProb;
}

/** 値を [0,1] に丸める。 */
function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
