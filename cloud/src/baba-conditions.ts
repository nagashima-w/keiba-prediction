/**
 * 馬場の値の型・定数と、取得の失敗の分類(Issue #294〈#293-A〉で作り、Issue #478〈#477-B〉で出どころを外部の API から JRA のページに替えた)。**型と定数だけ**: ネットワーク・D1・DO に触れない。
 * JRA のページの読み取りは `jra-baba-parse.ts`(純関数)、取得の流れは `jra-baba-fetch.ts`。保存の形(`baba_conditions` の列)は #294 のまま変えない。
 *
 * ## 失敗の分類({@link BabaResultClass})
 * 保存してよい固定の語だけ。例外の文面・URL・応答の本文は、保存もログもしない。
 * 外部の API の時代にあった `not-json`・`stale` は、新しい取得では起きない(D1 の既存の行には残りうる。読み出しは文字列のまま扱う)。
 */

/** 取得の結果の分類(`baba_fetches.result`)。固定の語だけ。 */
export type BabaResultClass =
  | "ok"
  | "no-today-venues"
  | "shape-mismatch"
  | "timeout"
  | "network"
  | "too-large"
  | "redirect"
  | "other"
  | "claim-failed"
  | `http-${number}`;

/**
 * 取得の失敗(分類つき)。メッセージは固定の語だけで、元の例外は持たない(`cause` なし)。
 * 取得口は通常は投げない(失敗は結果の分類に落として返す)が、`BabaStage` はどんな例外でも分類だけを読む。
 */
export class BabaFetchError extends Error {
  readonly result: BabaResultClass;

  constructor(result: BabaResultClass) {
    super(`馬場の取得に失敗しました(分類: ${result})`);
    this.name = "BabaFetchError";
    this.result = result;
  }
}

/** 1 面(芝・ダート)の状態と含水率。 */
export interface BabaSurface {
  readonly condition: string | null;
  readonly goalCondition: string | null;
  readonly corner4Condition: string | null;
  readonly goalMoisture: number | null;
  readonly corner4Moisture: number | null;
}

/** 当日の競馬場 1 件ぶんの値(保存する形)。 */
export interface BabaVenueRecord {
  /** JRA の場コード(01〜10。netkeiba のレース ID の場コードと同じ)。 */
  readonly venueCode: string;
  readonly venueName: string;
  /** 計測日時(`YYYY-MM-DDTHH:MM+09:00`)。 */
  readonly measuredAt: string;
  readonly cushion: number | null;
  readonly turf: BabaSurface;
  readonly dirt: BabaSurface;
  readonly rainfallMm: number | null;
  readonly usedCourse: string | null;
  readonly turfLength: string | null;
  /** 芝の状態の文章(良・稍重などの状態ではない)。 */
  readonly turfConditionText: string | null;
  /** JRA から読み取った値の要約の JSON(競馬場 1 件ぶん)。HTML は入れない。読み取りの側は常に入れる(長さは最悪入力でも数百字。上界は `jra-baba-parse.test.ts` が固定する。Issue #490-3 で、旧上限 4096 字の分岐を消した)。型は null を許す。 */
  readonly rawJson: string | null;
}

/**
 * 競馬場を捨てた理由(診断用。Issue #360)。
 *  - `not-today`: 計測日時を読めて、日付が今日でない(JRA のページに当日の値がまだ載っていない・開催していない競馬場の古い値)。
 *  - `unparsed`: 計測日時の文字列を読めない(書式の不一致・実在しない日・時刻の範囲外・曜日の検算の失敗)。書式の変更などの不具合の兆候。
 *  - `invalid`: 場名が JRA の 10 場にない。
 *  - `duplicate`: 場コードの重複(外部の API の時代の記録に残る。JRA のページの読み取りでは起きない)。
 */
export type BabaDropReason = "not-today" | "unparsed" | "invalid" | "duplicate";

/** 捨てた競馬場 1 件の診断(`baba_fetches.dropped_json` の要素)。競馬場の値や本文は含めない。 */
export interface BabaDroppedDetail {
  /** 場コード(制御文字を除いて 4 字まで)。場名から決められなければ null。 */
  readonly venue: string | null;
  readonly reason: BabaDropReason;
  /** ページの計測の時刻の文字列(例: `10月17日（土曜）7時00分`)。制御文字を除いて {@link BABA_MEASURED_TEXT_LIMIT} 字まで。無ければ null。 */
  readonly measured: string | null;
}

/** 捨てた競馬場の詳細を残す件数の上限(件数そのものは `dropped` に残る)。 */
export const BABA_DROPPED_DETAIL_LIMIT = 20;
/** 詳細に残す計測日時の文字列の長さの上限。 */
export const BABA_MEASURED_TEXT_LIMIT = 40;

/** 1 回の取得の結果(取得口が返し、`BabaStage` が D1 に記録する)。 */
export interface BabaFetchOutcome {
  readonly result: BabaResultClass;
  /** 当日の競馬場だけ(`result` が `ok` のときだけ 1 件以上)。 */
  readonly venues: readonly BabaVenueRecord[];
  /** 捨てた競馬場の件数(当日でない・読めない・場名が不明)。 */
  readonly dropped: number;
  /** 捨てた競馬場の理由と計測日時の文字列(場の並び順。{@link BABA_DROPPED_DETAIL_LIMIT} 件まで)。 */
  readonly droppedDetails: readonly BabaDroppedDetail[];
  /** クッション値のページを取得できた時刻(ISO 8601。そのページを取り終えた時刻)。取れていなければ null。`baba_fetch_attempts.api_fetched_at` に入る。 */
  readonly apiFetchedAt: string | null;
  /**
   * クッション値・含水率のページに載っていた場の場コード(載った順、重複なし。JRA の 10 場に当たらない場名は入らない)。当日の値の有無は問わない。
   * 計画から場コードが取れないときだけ、「その日の全部の場」の分母に使う(Issue #480)。ページを読めなければ空。
   */
  readonly listedVenueCodes: readonly string[];
}

/**
 * 場の行が「そろっている」か(Issue #480): クッション値と含水率(芝・ダートのゴール前/4 角のどれか)の**どちらにも**当日の値がある。
 * 片方だけの行は先に保存するが、「そろった」には数えず、後の回で欠けを埋める(`baba-repository.ts` の補完の upsert。SQL の条件は同じ定義)。
 */
export function isVenueComplete(v: Pick<BabaVenueRecord, "cushion" | "turf" | "dirt">): boolean {
  const hasMoisture = [v.turf.goalMoisture, v.turf.corner4Moisture, v.dirt.goalMoisture, v.dirt.corner4Moisture].some((m) => m !== null);
  return v.cushion !== null && hasMoisture;
}

/** `RaceDayCore` に渡す取得口: JRA のページを取って読み、結果を返す。失敗は結果の分類に落とす(投げない)。URL は取得口の中だけにある。 */
export type BabaFetcher = (nowMs: number) => Promise<BabaFetchOutcome>;
