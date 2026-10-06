/**
 * NetkeibaGate(Durable Object)の中身(Issue #162 段階2a)。netkeiba への取得を、アカウント全体で1か所に集めて
 * **直列化・間隔制御・サーキットブレーカー**を掛ける。
 *
 * **純ロジック**: `cloudflare:workers` も `cloudflare:sockets` も import しない。ストレージ(`ctx.storage.kv` の同期 API)・時計・
 * 待機・ソケット取得を引数で受けるので、Node の vitest で偽の時計・ストレージ・ソケットを使ってテストできる。
 * DO のラッパ(`netkeiba-gate-do.ts`)は、これらを本物に配線するだけ。
 *
 * ## 守ること
 *  1. **許可する取得先だけ**: https の race / db / nar.netkeiba.com(ポート・ユーザー情報なし)。それ以外は接続せずに拒否する。
 *  2. **直列化(同時に1本)**: プロミスの連鎖で、前の取得が終わるまで次を始めない。取得が最小間隔より長くかかっても重ならない
 *     (開始時刻だけを見る「予約」方式は、前の取得が 2 秒を超えると次と重なるので採らない)。
 *  3. **最小間隔 {@link GATE_MIN_INTERVAL_MS}(開始から開始まで)**: CLAUDE.md の「最低 1.5 秒」を満たす。最後の開始時刻は
 *     **取得の前に永続化**する(DO が作り直されても間隔が守られる)。待ちは最小間隔でクランプする(時計が戻っても長く待たない)。
 *  4. **サーキットブレーカー**: 400/403/429 が {@link GATE_BREAKER_THRESHOLD} 回連続したら {@link GATE_BREAKER_MS} の間、すべての取得を
 *     接続せずに拒否する。状態は永続化する。解除後は1回通し、そこで拒否されたら即座にまた開く(カウントを数え直さない)。
 *     手動のリセットは用意しない(時間経過でのみ戻る。ユーザー判断 2026-10-06)。
 *  5. **待ち行列の上限 {@link GATE_MAX_QUEUE}**: 超えた呼び出しは接続せずに拒否する(呼び出し側が諦めた取得が、2 秒間隔で
 *     溜まり続けるのを防ぐ安全弁)。
 *
 * ## ブレーカーの数え方(spike の RequestGuard と同じ保守側の扱い)
 *  - 400/403/429 は +1。
 *  - ほかの HTTP ステータス(404・5xx・3xx を含む。サーバが普通に応答した)は連続を途切れさせる。
 *  - 通信エラー・タイムアウト・サイズ超過・壊れた応答は、数えず、途切れさせもしない
 *    (拒否→通信エラー→拒否 を「連続していない」と読んで撃ち続けるのを避ける)。
 *  - 圧縮された応答(`unsupported-encoding`)は、受信済みの status で上と同じに数える(圧縮された 403 も拒否として数える)。
 *
 * ## 永続化の限界(受け入れている)
 * 最後の開始時刻・拒否の連続回数・解除時刻は `ctx.storage.kv` の同期 API で書く。**ストレージ書き込みの出力ゲートが、ソケットの送信まで
 * 保護するかは、公式のドキュメントで確認できていない。** 開始時刻を書いてから接続までの間に DO がクラッシュした場合、書き込みが
 * 失われて開始間隔が1回だけ破れうる(ほぼ無視できる確率)。拒否の連続回数も同じ理由で、クラッシュの瞬間の1回分を失いうる。
 *
 * 呼び出し側が諦めても(RPC の呼び出しが取り消されても)、ゲートの中の取得は最後まで走り、状態を更新する
 * (呼び出し側の中止を、ゲート内の状態更新に伝えない)。
 */

import { SocketFetchError, type SocketFetcher } from "./socket-fetch";

/** リクエスト開始の最小間隔(ミリ秒。開始から開始まで)。CLAUDE.md の 1.5 秒以上。段階1の実測も 2 秒間隔。 */
export const GATE_MIN_INTERVAL_MS = 2000;

/** この回数だけ拒否が連続したらブレーカーを開く。 */
export const GATE_BREAKER_THRESHOLD = 2;

/** ブレーカーが開いている時間(ミリ秒)。30 分(ユーザー判断 2026-10-06)。 */
export const GATE_BREAKER_MS = 30 * 60 * 1000;

/** 待ち行列(進行中 + 待ち)の上限。 */
export const GATE_MAX_QUEUE = 8;

/** 「拒否された」とみなす HTTP ステータス。 */
const REFUSAL_STATUSES: readonly number[] = [400, 403, 429];

/** 取得を許す https のホスト(完全一致)。 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["race.netkeiba.com", "db.netkeiba.com", "nar.netkeiba.com"]);

/** `ctx.storage.kv`(同期 API)のうち、ここで使う部分。 */
export interface KvLike {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

export interface GateDeps {
  readonly kv: KvLike;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetcher: SocketFetcher;
}

export interface GateOptions {
  readonly minIntervalMs?: number;
  readonly breakerThreshold?: number;
  readonly breakerMs?: number;
  readonly maxQueue?: number;
}

export type GateRefusalReason =
  /** 取得先が許可リストに無い。 */
  | "disallowed-url"
  /** ブレーカーが開いている。 */
  | "blocked"
  /** 待ち行列が上限を超えている。 */
  | "queue-full"
  /** 接続・送信・受信の失敗。 */
  | "network-error"
  /** 全体のタイムアウト。 */
  | "timeout"
  /** 応答が使えない(サイズ超過・壊れた応答・圧縮された応答)。 */
  | "bad-response";

/**
 * `fetchRaw` の戻り値(RPC で運べる値だけ。例外ではなく値で返す。RPC 越しの例外は型・プロパティが落ちるため)。
 * `response` は「HTTP の応答を受け取った」ことを表し、ステータスは 4xx・5xx でもそのまま入る。
 */
export type GateResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly contentType: string | null;
      /** 本文(バイトのまま。文字コードのデコードは呼び出し側)。 */
      readonly body: ArrayBuffer;
      /** 呼び出しから取得の開始まで(待ち行列と間隔の待ち)。 */
      readonly queuedMs: number;
      /** 取得の開始から終了まで。 */
      readonly elapsedMs: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: GateRefusalReason;
      readonly message: string;
      /** 受信済みのステータス(圧縮された応答のときだけ)。 */
      readonly status?: number;
      /** `blocked` のときだけ: ブレーカーの解除時刻(epoch ミリ秒)。 */
      readonly blockedUntil?: number;
      /** `blocked` のときだけ: 解除までの残り(ミリ秒)。 */
      readonly retryAfterMs?: number;
    };

export interface GateStatus {
  /** 拒否(400/403/429)の連続回数。 */
  readonly consecutiveRefusals: number;
  /** ブレーカーの解除時刻(開いていなければ null)。 */
  readonly blockedUntil: number | null;
  /** 最後に取得を開始した時刻(無ければ null)。 */
  readonly lastStartAt: number | null;
  /** 進行中 + 待ちの数。 */
  readonly pending: number;
}

const KEY_LAST_START = "lastStartAt";
const KEY_REFUSALS = "refusals";
const KEY_BLOCKED_UNTIL = "blockedUntil";

type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string };

/**
 * 取得先が許可されているかを検査し、接続先に渡す正規化した URL(フラグメントなし)を返す。
 * 許可: https・ポート指定なし・ユーザー情報なし・ホストが {@link ALLOWED_HOSTS} に完全一致(大文字小文字は正規化される)。
 * 空白・制御文字・バックスラッシュを含む文字列は、解釈が割れうるので拒否する。
 */
export function checkAllowedUrl(raw: string): UrlCheck {
  if (typeof raw !== "string" || /[\\\s\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, message: "URL に空白・制御文字・バックスラッシュを含めることはできません" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: "URL として読めません" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: "取得できるのは https の URL だけです" };
  }
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
    return { ok: false, message: "ポート指定・ユーザー情報のある URL は取得できません" };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return { ok: false, message: "取得を許可していないホストです(race / db / nar.netkeiba.com だけ)" };
  }
  return { ok: true, url: `${parsed.origin}${parsed.pathname}${parsed.search}` };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // 受信バッファ全体の一部を指す view かもしれないので、長さだけの新しい ArrayBuffer にコピーする。
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GateCore {
  private readonly kv: KvLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetcher: SocketFetcher;
  private readonly minIntervalMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerMs: number;
  private readonly maxQueue: number;

  /** 直列化のための連鎖の末尾。解決するだけで拒否はしない(前の取得の成否に関わらず次が進む)。 */
  private tail: Promise<void> = Promise.resolve();
  /** 進行中 + 待ちの数。 */
  private pending = 0;

  constructor(deps: GateDeps, options: GateOptions = {}) {
    this.kv = deps.kv;
    this.now = deps.now;
    this.sleep = deps.sleep;
    this.fetcher = deps.fetcher;
    this.minIntervalMs = options.minIntervalMs ?? GATE_MIN_INTERVAL_MS;
    this.breakerThreshold = options.breakerThreshold ?? GATE_BREAKER_THRESHOLD;
    this.breakerMs = options.breakerMs ?? GATE_BREAKER_MS;
    this.maxQueue = options.maxQueue ?? GATE_MAX_QUEUE;
  }

  status(): GateStatus {
    const now = this.now();
    const blockedUntil = this.kv.get<number>(KEY_BLOCKED_UNTIL) ?? 0;
    return {
      consecutiveRefusals: this.kv.get<number>(KEY_REFUSALS) ?? 0,
      blockedUntil: blockedUntil > now ? blockedUntil : null,
      lastStartAt: this.kv.get<number>(KEY_LAST_START) ?? null,
      pending: this.pending,
    };
  }

  /** ブレーカーが開いていれば、拒否の結果を返す(開いていなければ null)。 */
  private blockedResult(): GateResult | null {
    const now = this.now();
    const blockedUntil = this.kv.get<number>(KEY_BLOCKED_UNTIL) ?? 0;
    if (blockedUntil <= now) {
      return null;
    }
    return {
      kind: "refused",
      reason: "blocked",
      message: `netkeiba に連続して拒否されたため、取得を止めています(あと ${Math.ceil((blockedUntil - now) / 1000)} 秒)`,
      blockedUntil,
      retryAfterMs: blockedUntil - now,
    };
  }

  /** 応答のステータスで、拒否の連続回数とブレーカーを更新する。 */
  private recordStatus(status: number): void {
    if (!REFUSAL_STATUSES.includes(status)) {
      this.kv.put(KEY_REFUSALS, 0);
      this.kv.put(KEY_BLOCKED_UNTIL, 0);
      return;
    }
    const refusals = (this.kv.get<number>(KEY_REFUSALS) ?? 0) + 1;
    this.kv.put(KEY_REFUSALS, refusals);
    if (refusals >= this.breakerThreshold) {
      this.kv.put(KEY_BLOCKED_UNTIL, this.now() + this.breakerMs);
    }
  }

  /**
   * URL を1本取得する。許可リスト → ブレーカー → 待ち行列の上限の順に確かめ、通ったものだけを連鎖に入れる
   * (**これらの確認と待ち行列への登録の間に await を挟まない**。挟むと、同時に来た呼び出しが上限を超えて通る)。
   */
  async fetchRaw(rawUrl: string): Promise<GateResult> {
    const calledAt = this.now();

    const checked = checkAllowedUrl(rawUrl);
    if (!checked.ok) {
      return { kind: "refused", reason: "disallowed-url", message: checked.message };
    }
    const blockedNow = this.blockedResult();
    if (blockedNow !== null) {
      return blockedNow;
    }
    if (this.pending >= this.maxQueue) {
      return { kind: "refused", reason: "queue-full", message: `待ち行列が上限(${this.maxQueue})を超えています` };
    }

    this.pending += 1;
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;

      // 待っている間に、前の取得でブレーカーが開いたかもしれない。
      const blockedAfterWait = this.blockedResult();
      if (blockedAfterWait !== null) {
        return blockedAfterWait;
      }

      // 最小間隔(開始から開始まで)。時計が戻って最後の開始が未来になっていても、待ちは最小間隔でクランプする。
      const lastStartAt = this.kv.get<number>(KEY_LAST_START);
      if (lastStartAt !== undefined) {
        const waitMs = Math.min(this.minIntervalMs, lastStartAt + this.minIntervalMs - this.now());
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }
      }

      // 開始時刻を、接続の前に永続化する(失敗した取得も間隔に数える)。
      const startedAt = this.now();
      this.kv.put(KEY_LAST_START, startedAt);
      const queuedMs = startedAt - calledAt;

      try {
        const response = await this.fetcher(checked.url);
        this.recordStatus(response.status);
        return {
          kind: "response",
          status: response.status,
          contentType: response.contentType,
          body: toArrayBuffer(response.body),
          queuedMs,
          elapsedMs: this.now() - startedAt,
        };
      } catch (error) {
        if (error instanceof SocketFetchError) {
          if (error.status !== undefined) {
            this.recordStatus(error.status);
          }
          return {
            kind: "refused",
            reason: error.kind === "timeout" ? "timeout" : error.kind === "network" ? "network-error" : "bad-response",
            message: error.message,
            ...(error.status !== undefined ? { status: error.status } : {}),
          };
        }
        return { kind: "refused", reason: "network-error", message: messageOf(error) };
      }
    } finally {
      this.pending -= 1;
      release();
    }
  }
}
