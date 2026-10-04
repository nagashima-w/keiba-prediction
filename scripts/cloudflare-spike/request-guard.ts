/**
 * netkeiba へ出すリクエストの守り(Issue #159〈#21-A〉)。
 *
 * スパイクの Worker は「netkeiba へリクエストを出す公開 URL」になる。第三者に叩かれたり、拒否され
 * ているのに撃ち続けたりしてユーザーのアカウントから netkeiba に負荷をかけないよう、ドライバ側で
 * 次の3つを守る(判定は時刻とステータスだけを入力にする純ロジックで、実ネットワークには出ない)。
 *  1. 1回の実行の合計は {@link MAX_NETKEIBA_REQUESTS} 本以内
 *  2. 送信の間隔は {@link MIN_INTERVAL_MS} ms 以上(リポジトリ既定の 1.5 秒より厳しい 2 秒)
 *  3. 400/403/429 が2回連続したら打ち切る
 */

/** 1回の実行で netkeiba に出してよい本数の上限。 */
export const MAX_NETKEIBA_REQUESTS = 10;

/** リクエスト送信の最小間隔(ミリ秒)。 */
export const MIN_INTERVAL_MS = 2000;

/** 「拒否された」とみなす HTTP ステータス。 */
export const BLOCK_STATUSES: readonly number[] = [400, 403, 429];

/** この回数だけ拒否が連続したら打ち切る。 */
export const MAX_CONSECUTIVE_BLOCKS = 2;

export interface RequestGuardOptions {
  readonly maxRequests?: number;
  readonly minIntervalMs?: number;
  readonly maxConsecutiveBlocks?: number;
}

export type GuardDecision =
  | { readonly allow: true; readonly waitMs: number }
  | { readonly allow: false; readonly reason: "max-requests" | "consecutive-blocks" };

export class RequestGuard {
  private readonly maxRequests: number;
  private readonly minIntervalMs: number;
  private readonly maxConsecutiveBlocks: number;
  private sent = 0;
  private lastSentMs: number | null = null;
  private consecutiveBlocks = 0;

  constructor(options: RequestGuardOptions = {}) {
    this.maxRequests = options.maxRequests ?? MAX_NETKEIBA_REQUESTS;
    this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
    this.maxConsecutiveBlocks = options.maxConsecutiveBlocks ?? MAX_CONSECUTIVE_BLOCKS;
  }

  /** これまでに送った本数(失敗したものも数える)。 */
  get sentCount(): number {
    return this.sent;
  }

  /**
   * 次を送ってよいかを返す(状態は変えない)。許可なら、間隔を満たすまでに待つ ms を添える。
   * 打ち切り条件が2つ同時に成立したら、情報量の多い consecutive-blocks を返す。
   */
  next(nowMs: number): GuardDecision {
    if (this.consecutiveBlocks >= this.maxConsecutiveBlocks) {
      return { allow: false, reason: "consecutive-blocks" };
    }
    if (this.sent >= this.maxRequests) {
      return { allow: false, reason: "max-requests" };
    }
    if (this.lastSentMs === null) {
      return { allow: true, waitMs: 0 };
    }
    return { allow: true, waitMs: Math.max(0, this.lastSentMs + this.minIntervalMs - nowMs) };
  }

  /** 1本送ったことを記録する(応答を待つ前に呼ぶ)。 */
  markSent(nowMs: number): void {
    this.sent += 1;
    this.lastSentMs = nowMs;
  }

  /**
   * 応答のステータスを記録する。null はネットワークエラー: 拒否には数えず、連続も途切れさせない
   * (拒否→通信エラー→拒否 を「連続していない」と読んで撃ち続けるのを避ける保守側の扱い)。
   */
  recordStatus(status: number | null): void {
    if (status === null) {
      return;
    }
    if (BLOCK_STATUSES.includes(status)) {
      this.consecutiveBlocks += 1;
    } else {
      this.consecutiveBlocks = 0;
    }
  }
}
