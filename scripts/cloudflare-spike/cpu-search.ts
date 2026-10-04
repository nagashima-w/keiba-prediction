/**
 * CPU 時間の上限の探索(Issue #159〈#21-A〉)。
 *
 * Workers では、Spectre 対策のため、実行中に I/O がないと `Date.now()` / `performance.now()` が
 * 進まない(公式 docs「APIs that return timers ... only advance or increment after I/O occurs」)。
 * そのため、コード内の時刻差では CPU 時間を測れない。代わりに「同じ処理を reps 回繰り返すリクエスト」を
 * 順に投げ、CPU 上限超過のエラー(HTTP 503 / エラーコード 1102 等)になる点を、倍々 → 二分探索で探す。
 *
 * 判定の核(応答の分類・探索の進め方)だけを純ロジックとして持つ。実際のリクエストは呼び出し側が
 * `probe` として注入する。
 */

export type CpuProbeKind = "ok" | "cpu-exceeded" | "other-error";

/** `CPU 超過を示す` 応答本文のパターン(Workers の 1102 / Durable Object の CPU 超過など)。 */
const CPU_EXCEEDED_PATTERN =
  /error code:?\s*1102|exceeded (?:its |the )?(?:cpu|resource)|cpu (?:time )?limit/i;

/**
 * 応答(ステータスと本文)を分類する。200 は ok、CPU 超過と読める失敗は cpu-exceeded、
 * それ以外の失敗は other-error。**CPU 超過と読めない失敗を CPU の限界として扱わない**
 * (認証の失敗・経路の誤り・日次の上限などを、限界として記録してしまうのを防ぐ)。
 */
export function classifyCpuProbe(status: number | null, body: string): CpuProbeKind {
  if (status === 200) {
    return "ok";
  }
  if (status !== null && CPU_EXCEEDED_PATTERN.test(body)) {
    return "cpu-exceeded";
  }
  return "other-error";
}

/** parse / score が読むはずの出馬表・出走馬の頭数(同梱のフィクスチャ。中央16頭)。 */
export const EXPECTED_HORSE_COUNT = 16;

/**
 * Worker / DO が返した `check`(処理の健全性を示す数)が妥当かを判定する。
 * parse・score は同梱フィクスチャの頭数(16)、alloc 系は買い目の点数(1以上。-1 は「混在配分にならなかった」
 * =早期 return で空振りしたことを表す)。**空振りした計算を「通過」と記録しない**ための検査で、不正なら
 * 呼び出し側は other-error として扱い、探索を止める(誤った実測結論の防止)。
 */
export function isValidCpuCheck(work: string, check: unknown): boolean {
  if (typeof check !== "number" || !Number.isInteger(check)) {
    return false;
  }
  switch (work) {
    case "parse":
    case "score":
      return check === EXPECTED_HORSE_COUNT;
    case "alloc":
    case "allocFull":
      return check >= 1;
    default:
      return false;
  }
}

export interface ProbeOutcome {
  readonly kind: CpuProbeKind;
  /** この1回のリクエストの所要時間(ドライバ側の壁時計。ミリ秒)。 */
  readonly elapsedMs: number;
  /** 失敗の詳細(診断用)。 */
  readonly detail?: string;
}

export interface SearchOptions {
  /** 探索する反復回数の上限。 */
  readonly maxReps: number;
  /** 各点での試行回数(通る点は全試行を行い、落ちる点は最初の失敗で打ち切る)。 */
  readonly trials: number;
  /** 二分探索を打ち切る相対幅。hi <= lo*(1+tolerance) になれば止まる。既定 0.1。0 なら厳密。 */
  readonly tolerance?: number;
  /** プローブ回数の予算(全点の試行数の合計)。既定は無制限。 */
  readonly maxProbes?: number;
  /**
   * 各プローブの前に呼ばれ、true なら探索を打ち切る(壁時計の上限など、外部の事情による中断)。
   * 打ち切るまでに観測した結果は返す(stopReason = "deadline")。
   */
  readonly shouldStop?: () => boolean;
}

export interface SearchPoint {
  readonly reps: number;
  readonly trialsRun: number;
  readonly ok: number;
  readonly cpuExceeded: number;
  readonly otherError: number;
  /** 全試行が ok(= trialsRun === trials)。 */
  readonly passed: boolean;
  /**
   * 予算切れ・外部からの打ち切りで試行の途中で中断され、**失敗は一度も観測していない**点。
   * 通過とも失敗とも言えないので、探索の下限にも上限にも反映しない(passed は false)。
   */
  readonly interrupted: boolean;
  readonly elapsedMs: readonly number[];
}

export type SearchStopReason = "converged" | "max-reps" | "other-error" | "probe-budget" | "deadline";

export interface SearchResult {
  readonly points: readonly SearchPoint[];
  /** 全試行が通った最大の reps(1回目から落ちたら null)。 */
  readonly maxPassReps: number | null;
  /** CPU 超過で落ちた最小の reps(上限が見つからなければ null)。 */
  readonly minFailReps: number | null;
  /** maxReps でも全部通った(上限が maxReps 以内には無い)。 */
  readonly reachedMax: boolean;
  readonly stopReason: SearchStopReason;
  /** other-error で止まった(CPU の限界と断定できない)。 */
  readonly inconclusive: boolean;
  readonly totalProbes: number;
}

/**
 * 倍々(1,2,4,…,maxReps)で最初の失敗点を探し、その直前の通過点との間を二分探索する。
 */
export async function searchLimit(
  probe: (reps: number) => Promise<ProbeOutcome>,
  options: SearchOptions,
): Promise<SearchResult> {
  const tolerance = options.tolerance ?? 0.1;
  const maxProbes = options.maxProbes ?? Number.POSITIVE_INFINITY;
  const points: SearchPoint[] = [];
  let totalProbes = 0;
  // evaluate(クロージャ)から書き換えるため、制御フロー解析で null に狭められないよう型を明示する。
  let stopReason = null as SearchStopReason | null;
  let lo: number | null = null; // 全試行が通った最大の reps
  let hi: number | null = null; // CPU 超過で落ちた最小の reps

  /** 1点を評価する。otherError なら stopReason をセットする。予算切れなら null を返す。 */
  const evaluate = async (reps: number): Promise<SearchPoint | null> => {
    let ok = 0;
    let cpuExceeded = 0;
    let otherError = 0;
    const elapsedMs: number[] = [];
    let trialsRun = 0;
    for (let t = 0; t < options.trials; t += 1) {
      if (options.shouldStop?.() === true) {
        stopReason = "deadline";
        break;
      }
      if (totalProbes >= maxProbes) {
        stopReason = "probe-budget";
        break;
      }
      const outcome = await probe(reps);
      totalProbes += 1;
      trialsRun += 1;
      elapsedMs.push(outcome.elapsedMs);
      if (outcome.kind === "ok") {
        ok += 1;
      } else {
        if (outcome.kind === "cpu-exceeded") {
          cpuExceeded += 1;
        } else {
          otherError += 1;
        }
        break; // 最初の失敗で、同じ点の残りの試行を打ち切る
      }
    }
    if (trialsRun === 0) {
      return null;
    }
    const point: SearchPoint = {
      reps,
      trialsRun,
      ok,
      cpuExceeded,
      otherError,
      passed: ok === options.trials,
      interrupted: trialsRun < options.trials && cpuExceeded === 0 && otherError === 0,
      elapsedMs,
    };
    points.push(point);
    if (otherError > 0) {
      stopReason = "other-error";
    }
    return point;
  };

  // 倍々。
  let reps = 1;
  let reachedMax = false;
  for (;;) {
    const point = await evaluate(reps);
    // 中断された点(interrupted)は passed でも cpuExceeded>0 でもないので、下の分岐で lo にも hi にも
    // 反映されずに break する(同じ扱いになるので、ここで個別には見ない)。
    if (point === null || point.otherError > 0) {
      break;
    }
    if (point.passed) {
      lo = reps;
      if (reps >= options.maxReps) {
        reachedMax = true;
        stopReason = "max-reps";
        break;
      }
      reps = Math.min(reps * 2, options.maxReps);
      continue;
    }
    if (point.cpuExceeded > 0) {
      hi = reps;
    }
    break;
  }

  // 二分探索(失敗点が見つかり、他の理由で止まっていないときだけ)。
  if (stopReason === null && hi !== null) {
    const base = lo ?? 0;
    let low = base;
    let high = hi;
    while (high - low > 1 && high > low * (1 + tolerance)) {
      const mid = Math.floor((low + high) / 2);
      const point = await evaluate(mid);
      if (point === null) {
        break;
      }
      // 中断された点(失敗を観測していない)は、下限にも上限にも反映しない。
      if (point.otherError > 0 || point.interrupted) {
        break;
      }
      if (point.passed) {
        low = mid;
      } else {
        high = mid;
      }
      if (stopReason !== null) {
        break;
      }
    }
    lo = low === 0 ? null : low;
    hi = high;
    if (stopReason === null) {
      stopReason = "converged";
    }
  }

  const inconclusive = stopReason === "other-error";
  return {
    points,
    maxPassReps: lo,
    minFailReps: inconclusive ? null : hi,
    reachedMax,
    stopReason: stopReason ?? "converged",
    inconclusive,
    totalProbes,
  };
}
