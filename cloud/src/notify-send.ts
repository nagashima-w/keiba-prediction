/**
 * Discord への送信の入口(Issue #205〈#166-D〉G-D2・G-D6)。Worker の secret `DISCORD_WEBHOOK_URL` の検証と、core の `sendDiscordNotification` の呼び出し。
 *
 * **URL の値は、ここで作るクロージャの外に出ない**: `RaceDayCore` が受け取るのは `{ send(payload) }` だけで、URL そのものを持たない。したがって DO の状態・ログ・応答に URL が入る経路が構造的に無い。
 * 失敗は {@link classifyNotifyError} の分類(`http-<status>`・`timeout`・`rate-limited`・`network`・`other`)だけを残し、例外のメッセージ・応答の本文は残さない。
 *
 * 送信の条件(G-D2。アラームの中の1ステップなので、長い待ちは他の仕事を止める):
 *  - タイムアウトは {@link NOTIFY_TIMEOUT_MS}(5 秒)。core の既定(15 秒)より短くする。
 *  - 429 の `Retry-After` は {@link MAX_RATE_LIMIT_WAIT_MS}(5 秒)以内なら待って 1 回だけ再送する(core の仕様)。それを超えるなら待たずに `rate-limited` の失敗にする(再送しない)。
 *  - core の既定の fetch(undici)は Worker では使えない(スタブに差し替えてある)ので、グローバルの `fetch` を必ず注入する。
 */
import { DiscordNotifyError, isDiscordWebhookUrl, sendDiscordNotification, type DiscordFetchLike, type DiscordPayload } from "../../packages/core/src/notify/discord";

/** 1回の送信のタイムアウト(ミリ秒)。 */
export const NOTIFY_TIMEOUT_MS = 5000;
/** 429 の `Retry-After` を待つ上限(ミリ秒)。超えたら待たずに失敗にする。 */
export const MAX_RATE_LIMIT_WAIT_MS = 5000;

/** Webhook URL の状態。`absent` = 未登録・空白だけ / `invalid` = 登録されているが形式が Discord の Webhook ではない / `valid` = 通知に使える。 */
export type WebhookStatus = "absent" | "invalid" | "valid";

/** secret の値(未登録なら undefined)から状態を決める。前後の空白・末尾の改行(貼り付けで付く)は取り除いて判定する。値は返さない。 */
export function webhookStatus(raw: string | undefined): WebhookStatus {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "absent";
  }
  return isDiscordWebhookUrl(raw.trim()) ? "valid" : "invalid";
}

/** `RaceDayCore` に渡す送信の依存。URL を持たない。 */
export interface DiscordNotifier {
  send(payload: DiscordPayload): Promise<void>;
}

/** 429 の待ちが上限を超えるときに投げる(待たずに失敗にする)。メッセージは固定。 */
export class RateLimitedError extends Error {
  constructor() {
    super("Discord のレート制限の待ちが長いため、送信を見送りました");
    this.name = "RateLimitedError";
  }
}

export interface CreateNotifierDeps {
  /** 送信に使う fetch。省略時はグローバルの `fetch`(Worker)。テストで差し替える。 */
  readonly fetch?: DiscordFetchLike;
}

/**
 * secret の値から notifier を作る。**未登録・形式不正なら undefined**(通知の仕組み全体を無効にする。材料も行も積まない)。
 */
export function createDiscordNotifier(raw: string | undefined, deps: CreateNotifierDeps = {}): DiscordNotifier | undefined {
  if (webhookStatus(raw) !== "valid") {
    return undefined;
  }
  const url = (raw as string).trim();
  const fetchFn: DiscordFetchLike = deps.fetch ?? ((target, init) => fetch(target, init) as unknown as ReturnType<DiscordFetchLike>);
  const sleep = async (ms: number): Promise<void> => {
    if (ms > MAX_RATE_LIMIT_WAIT_MS) {
      throw new RateLimitedError();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  };
  return {
    send: (payload) => sendDiscordNotification(url, payload, { fetch: fetchFn, timeoutMs: NOTIFY_TIMEOUT_MS, sleep }),
  };
}

/**
 * 送信の失敗を、保存してよい分類にする。**メッセージ・本文・URL は読んでも保存しない**(種別の判定にだけメッセージを読む)。
 * `http-<status>`(Discord の応答)/ `timeout` / `rate-limited` / `network`(接続・切断)/ `other`。
 */
export function classifyNotifyError(error: unknown): string {
  if (error instanceof RateLimitedError) {
    return "rate-limited";
  }
  if (error instanceof DiscordNotifyError && typeof error.status === "number") {
    return `http-${Math.trunc(error.status)}`;
  }
  const message = error instanceof Error ? error.message : "";
  if (/タイムアウト|time(d)?[ -]?out/i.test(message)) {
    return "timeout";
  }
  if (/connection|network|fetch failed|ECONN/i.test(message)) {
    return "network";
  }
  return "other";
}
