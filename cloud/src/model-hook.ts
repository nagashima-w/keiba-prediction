/**
 * 別の Worker(service binding `MODEL`)への「計算を頼む口」(Issue #796)。
 *
 *  - `card`: 分析を R2・D1 に保存したあと。`POST /hook/card`、本文 `{"race_id"}`。
 *  - `odds`: 発走の 5 分前・10 分前のオッズの記録を D1 に入れたあと。`POST /hook/odds`、本文 `{"race_id","minutes_before"}`。
 *
 * 応答の中身は見ない。失敗・例外・時間切れ・非 2xx は警告 1 行にして握る(**投げない**。本番の処理の成否・再試行に影響させない)。
 * 警告にはレース ID と状態コードだけを出す(本文・例外の文面は出さない)。時間切れは {@link MODEL_HOOK_TIMEOUT_MS}。
 * 純ロジック(`cloudflare:workers` を import しない)。`Fetcher` と警告の出口は注入する。
 */

/** 呼ぶ側の時間切れ(ミリ秒)。 */
export const MODEL_HOOK_TIMEOUT_MS = 3000;

/** 呼び出しの宛先の基点(service binding の fetch はホスト名を見ない。形だけの URL)。 */
export const MODEL_BASE_URL = "https://model";

export type ModelHookMinutes = 5 | 10;

export interface ModelHook {
  /** 分析の保存後の依頼。投げない。 */
  card(raceId: string): Promise<void>;
  /** オッズの記録の保存後の依頼。投げない。 */
  odds(raceId: string, minutesBefore: ModelHookMinutes): Promise<void>;
}

/** バインディングが無い(undefined)ときは undefined(何もしない)。 */
export function createModelHook(fetcher: Fetcher | undefined, warn: (message: string) => void, timeoutMs: number = MODEL_HOOK_TIMEOUT_MS): ModelHook | undefined {
  if (fetcher === undefined) {
    return undefined;
  }
  const safeWarn = (message: string): void => {
    try {
      warn(message);
    } catch {
      // 警告の出口の失敗は握る(フックは投げない)。
    }
  };
  const post = async (path: string, raceId: string, body: Record<string, unknown>): Promise<void> => {
    if (!/^\d{12}$/.test(raceId)) {
      safeWarn(`別の Worker への依頼を送りませんでした(race_id の形が不正。${path})`);
      return;
    }
    // 中央(JRA)のレースだけ(競馬場コードが 10 以下。`venueKindOfRaceId` と同じ判定。地方は送らない)。
    if (Number(raceId.slice(4, 6)) > 10) {
      return;
    }
    try {
      const res = await fetcher.fetch(`${MODEL_BASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 応答の中身は見ない(接続を閉じるために捨てる)。
      try {
        await res.body?.cancel();
      } catch {
        // 握る。
      }
      if (res.status < 200 || res.status >= 300) {
        safeWarn(`別の Worker への依頼が成功しませんでした(${path} ${raceId}。HTTP ${res.status})`);
      }
    } catch {
      // 例外の文面は出さない(時間切れ・接続の失敗を区別しない)。
      safeWarn(`別の Worker への依頼に失敗しました(${path} ${raceId}。例外または時間切れ)`);
    }
  };
  return {
    card: (raceId) => post("/hook/card", raceId, { race_id: raceId }),
    odds: (raceId, minutesBefore) => post("/hook/odds", raceId, { race_id: raceId, minutes_before: minutesBefore }),
  };
}
