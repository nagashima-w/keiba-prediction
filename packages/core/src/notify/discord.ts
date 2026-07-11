/**
 * Discord Webhook 通知クライアント。
 *
 * 仕様「技術スタック(通知: Discord Webhook)」および「5. ui(Discordに送信/自動送信)」に対応する。
 *
 * 設計方針:
 *  - 純ロジック(URL検証・Retry-After解釈・切り詰め・embed整形)を副作用から切り離し、単体テストで固定する。
 *  - 実送信は注入可能な fetch(DiscordFetchLike)経由にし、テストでは実Discordへ送らない。
 *  - 本番の既定 fetch は undici + EnvHttpProxyAgent。http-client.ts の「dispatcher をプロセス内で
 *    1つ生成して使い回す」流儀を踏襲する(プロキシ必須環境でも通す)。
 *  - 送信失敗(非2xx)は理由を保持した DiscordNotifyError にする。呼び出し側(main)がユーザー向け
 *    メッセージ化して表示する。レート制限(429)は Retry-After を尊重して1回だけ待機リトライする。
 */

import { DEFAULT_USER_AGENT } from "../scraper/http-client.js";

/** Discord embed(送信ペイロードの1要素)。 */
export interface DiscordEmbed {
  /** タイトル(最大256字)。 */
  readonly title?: string;
  /** 説明本文(最大4096字)。 */
  readonly description?: string;
  /** 左側の縦帯の色(10進RGB)。 */
  readonly color?: number;
}

/** Discord Webhook へ送る JSON ペイロード。 */
export interface DiscordPayload {
  /** テキスト本文(省略可)。 */
  readonly content?: string;
  /** embed 群(本ツールは1件のみ送る想定)。 */
  readonly embeds: readonly DiscordEmbed[];
}

/**
 * fetch(undici互換)のうち POST 送信に必要な最小インターフェース。
 * これに絞ることで、テストでは実ネットワークを使わず疑似レスポンスを注入できる。
 */
export interface DiscordFetchResponse {
  /** HTTPステータスコード。 */
  readonly status: number;
  /** 2xx系かどうか。 */
  readonly ok: boolean;
  /** ヘッダ参照(存在しなければ null)。 */
  readonly headers: { get(name: string): string | null };
  /** レスポンスボディを文字列で取得する(エラー診断用)。 */
  text(): Promise<string>;
}

/** 注入可能な fetch 関数(POST)。undici の fetch 相当を最小限に抽象化したもの。 */
export type DiscordFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<DiscordFetchResponse>;

/** sendDiscordNotification の依存(注入)。 */
export interface SendDiscordDeps {
  /** 送信に使う fetch。省略時は undici + EnvHttpProxyAgent を使う。 */
  readonly fetch?: DiscordFetchLike;
  /** 待機関数(429リトライ用)。省略時は setTimeout ベース。テストで差し替え可能。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * リクエスト単位のタイムアウト(ミリ秒)。省略時は DEFAULT_DISCORD_TIMEOUT_MS。
   * この時間内に応答が完了しなければ打ち切り、DiscordNotifyError を投げる。
   */
  readonly timeoutMs?: number;
}

/** Discord embed の説明本文の文字数上限。 */
export const DISCORD_EMBED_DESCRIPTION_MAX = 4096;
/** Discord embed のタイトルの文字数上限。 */
export const DISCORD_EMBED_TITLE_MAX = 256;

/**
 * リクエスト単位のタイムアウトのデフォルト(ミリ秒)。
 * undiciのfetchはボディ受信ハングに全体タイムアウトを持たないため、本クライアント側で打ち切る
 * (http-client.ts と同方針。UI の送信状態が "sending" のまま復帰不能になるのを防ぐ)。
 */
export const DEFAULT_DISCORD_TIMEOUT_MS = 15000;

/** 429 の Retry-After が欠損・不正なときの既定待機(ミリ秒)。 */
const DEFAULT_RETRY_AFTER_MS = 1000;
/** 待機のクランプ上限(ミリ秒)。過大な Retry-After で長時間ブロックしないため。 */
const MAX_RETRY_AFTER_MS = 60000;

/** EVプラス色(緑)。 */
const COLOR_POSITIVE = 0x2ecc71;
/** 該当なし色(グレー)。 */
const COLOR_NONE = 0x95a5a6;

/** 有効な Discord Webhook URL のプレフィックス(https のみ許容)。 */
const WEBHOOK_URL_PREFIXES = [
  "https://discord.com/api/webhooks/",
  "https://discordapp.com/api/webhooks/",
] as const;

/**
 * Discord 通知の失敗を表す例外。理由(ステータス・応答本文)を保持する。
 * 呼び出し側がユーザー向けメッセージ化して表示する。
 */
export class DiscordNotifyError extends Error {
  /** HTTPステータス(URL検証失敗など送信前エラーでは undefined)。 */
  readonly status?: number;
  /** 応答本文(取得できた範囲。診断用)。 */
  readonly responseBody?: string;

  constructor(
    message: string,
    options: { status?: number; responseBody?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DiscordNotifyError";
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

/**
 * 送信前のURL検証。Discord Webhook の正規プレフィックスで始まる https URL のみ許容する。
 * (設定画面レビューの申し送り事項: 実送信の直前でホスト・パスを固定的に検証する。)
 */
export function isDiscordWebhookUrl(url: string): boolean {
  return WEBHOOK_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * 429 応答の Retry-After ヘッダ(秒)をミリ秒へ変換する。
 * 欠損・非数値・負値は既定1000ms、過大値は上限60000msにクランプする。
 */
export function parseRetryAfterMs(header: string | null): number {
  if (header === null) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
}

/**
 * 文字列を最大長 maxLen(コードポイント単位)以内に収める。
 * 超過時は末尾を省略記号「…」に置き換え、結果長を maxLen コードポイントちょうどにする。
 * サロゲートペア(絵文字等)を割らないよう、コードユニットではなくコードポイントで数える。
 * @param maxLen 1以上を想定。
 */
export function truncate(text: string, maxLen: number): string {
  const codePoints = [...text];
  if (codePoints.length <= maxLen) {
    return text;
  }
  return `${codePoints.slice(0, maxLen - 1).join("")}…`;
}

/** embed 整形に用いるレース情報(app の AnalysisResult と構造互換)。 */
export interface EmbedRaceInfo {
  /** レース名。 */
  readonly raceName: string;
  /** 開催日(表示用文字列)。 */
  readonly date: string;
  /** 会場名。 */
  readonly venueName: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: string;
  /** 距離(m)。 */
  readonly distance: number;
  /** LLM補正を実行したか。 */
  readonly llmUsed: boolean;
  /**
   * オッズの発売状態(確定/発売中/予想)。
   * middle/yoso は確定オッズではない旨を embed 説明文に注記する(確定 result は注記しない)。
   */
  readonly oddsStatus: "result" | "middle" | "yoso";
}

/**
 * オッズ発売状態の embed 用注記(確定 result は注記なしで null)。
 * UI 表示(app 側 oddsStatusNote)より短い文言で、embed 説明文の1行として使う。
 */
function embedOddsStatusNote(
  status: EmbedRaceInfo["oddsStatus"],
): string | null {
  switch (status) {
    case "middle":
      return "※オッズは発売中(暫定)";
    case "yoso":
      return "※複勝未発売のためEV計算不可";
    default:
      return null;
  }
}

/** embed 整形に用いる1頭分の情報(app の AnalysisRow と構造互換の部分集合)。 */
export interface EmbedHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 馬名。 */
  readonly horseName: string;
  /** 補正後複勝確率(0〜1)。 */
  readonly adjustedProb: number;
  /** 複勝オッズ下限。欠損なら null。 */
  readonly placeOddsMin: number | null;
  /** 期待値。欠損なら null。 */
  readonly ev: number | null;
  /** EVが閾値を上回るか。 */
  readonly isPositive: boolean;
}

/** 0〜1の確率を小数第1位までのパーセント文字列にする。 */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** 複勝オッズ下限を小数第1位まで表示する。欠損は "-"。 */
function formatOdds(oddsMin: number | null): string {
  return oddsMin === null ? "-" : oddsMin.toFixed(1);
}

/** 期待値を小数第2位まで表示する。欠損は "-"。 */
function formatEv(ev: number | null): string {
  return ev === null ? "-" : ev.toFixed(2);
}

/** 馬名は行が長くなりすぎないよう個別に切り詰める。 */
const HORSE_NAME_MAX = 32;

/**
 * 分析結果を Discord embed へ整形する(純関数)。
 *
 * - タイトル: 「会場名 レース名」(256字以内)
 * - 説明: 日付・会場・コース距離のメタ行、EVプラス馬の一覧(馬番・馬名・補正後確率・複勝下限・EV)、
 *   EVプラスが無ければ「該当なし」、末尾に LLM使用有無。全体を4096字以内に切り詰める。
 * - 色: EVプラスがあれば緑、無ければグレー。
 */
export function buildAnalysisEmbed(
  raceInfo: EmbedRaceInfo,
  horses: readonly EmbedHorse[],
): DiscordEmbed {
  const positives = horses.filter((h) => h.isPositive);

  const metaLine = `${raceInfo.date} / ${raceInfo.venueName} / ${raceInfo.courseType}${raceInfo.distance}m`;

  const horseLines =
    positives.length > 0
      ? positives.map((h) => {
          const name = truncate(h.horseName, HORSE_NAME_MAX);
          return `${h.umaban}番 ${name} 補正後${formatPercent(h.adjustedProb)} 複勝下限${formatOdds(h.placeOddsMin)} EV${formatEv(h.ev)}`;
        })
      : ["EVプラスの馬はありません(該当なし)"];

  const llmLine = `LLM補正: ${raceInfo.llmUsed ? "実行" : "スキップ"}`;

  // 確定前(middle/yoso)はオッズ状態の注記をメタ行の直後に差し込む(result は注記なし)。
  const statusNote = embedOddsStatusNote(raceInfo.oddsStatus);
  const metaLines = statusNote === null ? [metaLine] : [metaLine, statusNote];

  const description = truncate(
    [...metaLines, "", ...horseLines, "", llmLine].join("\n"),
    DISCORD_EMBED_DESCRIPTION_MAX,
  );

  return {
    title: truncate(
      `${raceInfo.venueName} ${raceInfo.raceName}`,
      DISCORD_EMBED_TITLE_MAX,
    ),
    description,
    color: positives.length > 0 ? COLOR_POSITIVE : COLOR_NONE,
  };
}

/**
 * ステータスコードからユーザー向けの失敗理由(日本語)を組み立てる。
 */
function reasonForStatus(status: number): string {
  if (status === 400) {
    return "送信内容が不正です(Discordに拒否されました)";
  }
  if (status === 401 || status === 403) {
    return "Webhook URL が無効か、権限がありません";
  }
  if (status === 404) {
    return "Webhook が見つかりません(削除された可能性があります)";
  }
  if (status === 429) {
    return "レート制限により送信できませんでした(しばらく待って再試行してください)";
  }
  if (status >= 500 && status <= 599) {
    return "Discord サーバでエラーが発生しました(時間をおいて再試行してください)";
  }
  return `Discord への送信に失敗しました(HTTP ${status})`;
}

/** undici本体を遅延ロードする(初回のみ実import、以降はキャッシュ)。 */
let undiciModulePromise: Promise<typeof import("undici")> | undefined;
/** プロキシ対応 dispatcher をプロセス内で1つだけ生成して使い回す。 */
let sharedDispatcher: import("undici").Dispatcher | undefined;

function loadUndici(): Promise<typeof import("undici")> {
  if (undiciModulePromise === undefined) {
    undiciModulePromise = import("undici");
  }
  return undiciModulePromise;
}

/**
 * 既定の fetch 実装。undici の fetch に EnvHttpProxyAgent を dispatcher として渡し、
 * HTTPS_PROXY / NO_PROXY 環境変数に従わせる(http-client.ts と同方針)。
 */
async function defaultDiscordFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
): Promise<DiscordFetchResponse> {
  const { fetch, EnvHttpProxyAgent } = await loadUndici();
  if (sharedDispatcher === undefined) {
    sharedDispatcher = new EnvHttpProxyAgent();
  }
  return fetch(url, {
    ...init,
    dispatcher: sharedDispatcher,
  }) as unknown as Promise<DiscordFetchResponse>;
}

/** setTimeout ベースの待機(vitestのフェイクタイマーで制御可能)。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch を timeoutMs で打ち切れるようにラップする(http-client.ts と同方式)。
 * setTimeout + AbortController ベースにすることで vitest のフェイクタイマーでも制御できる。
 * タイムアウト時は AbortController を abort して実リクエストの解放を促しつつ、DiscordNotifyError を投げる。
 */
async function fetchWithTimeout(
  fetchFn: DiscordFetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs: number,
): Promise<DiscordFetchResponse> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        new DiscordNotifyError(
          `Discord への送信がタイムアウトしました(${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);
  });

  const fetchPromise = fetchFn(url, { ...init, signal: controller.signal });
  // タイムアウトが先に解決した場合でも fetch 側の reject を握りつぶし、未処理拒否を防ぐ。
  fetchPromise.catch(() => {});

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Discord Webhook へペイロードを POST する。
 *
 * - 送信前に URL を検証し、正規の Webhook URL でなければ送信せず DiscordNotifyError を投げる。
 * - 2xx なら解決。非2xx は理由付きの DiscordNotifyError を投げる。
 * - 429(レート制限)は Retry-After を尊重して1回だけ待機リトライする。
 * - タイムアウトは429リトライとは独立。応答が返らない場合は timeoutMs で打ち切って即 DiscordNotifyError を
 *   投げ、リトライはしない(ハングはサーバ側の一時的過負荷とは限らず、盲目的な再送で状況を悪化させ得るため。
 *   利用者が明示的に再送ボタンを押せる UI 前提でこの設計とする)。
 */
export async function sendDiscordNotification(
  webhookUrl: string,
  payload: DiscordPayload,
  deps: SendDiscordDeps = {},
): Promise<void> {
  if (!isDiscordWebhookUrl(webhookUrl)) {
    throw new DiscordNotifyError(
      "Discord Webhook URL が不正です(https://discord.com/api/webhooks/ で始まる必要があります)",
    );
  }

  const fetchFn = deps.fetch ?? defaultDiscordFetch;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DISCORD_TIMEOUT_MS;
  const body = JSON.stringify(payload);

  // 初回 + 429 のとき1回だけリトライ(合計最大2回試行)。
  // タイムアウト時は fetchWithTimeout が DiscordNotifyError を throw し、ループを抜けて即失敗する(リトライしない)。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchWithTimeout(
      fetchFn,
      webhookUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": DEFAULT_USER_AGENT,
        },
        body,
      },
      timeoutMs,
    );

    if (response.ok) {
      return;
    }

    // 429 かつ初回のみ、Retry-After 分だけ待って1回リトライする。
    if (response.status === 429 && attempt === 0) {
      const waitMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await sleep(waitMs);
      continue;
    }

    const responseBody = await response.text().catch(() => "");
    throw new DiscordNotifyError(reasonForStatus(response.status), {
      status: response.status,
      responseBody: truncate(responseBody, 500),
    });
  }
}
