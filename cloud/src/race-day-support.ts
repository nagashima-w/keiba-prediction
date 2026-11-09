/**
 * 日単位の DO(`RaceDayCore`)と、そこから切り出した段階(`race-day-close-stage.ts` ほか)が**共有する小物**(Issue #399〈#390 R-9a〉)。**葉のモジュール**: `race-day-core.ts` を import しない
 * (段階が本体から import すると実行時に循環するため、共有するものはここに置く)。
 * 中身は `race-day-core.ts` にあったものをそのまま移した(オッズの URL の分類・キャッシュだけを読む取得の失敗・その失敗の見分け・エラー文面・計算ステップの TTL・配分に使う設定の取り出し)。
 * 挙動は変えていない。`ODDS_URL_PATTERN` は `race-day-core.ts` が再 export する(従来の import 先を保つ)。
 */
import { HttpError } from "../../packages/core/src/scraper/http-client";
import type { ScrapeTtlConfig } from "../../packages/core/src/scraper/scrape-race";
import type { AnalysisAllocationSettings } from "../../packages/core/src/analysis/allocation-record";
import { GateRefusedError } from "./gate-fetch";
import type { CloudSettings } from "./settings";

/** オッズ・組合せオッズの取得先(中央の `api_get_jra_odds`・地方の `nar.netkeiba.com/odds/` 配下: `index.html`〈単勝複勝・馬連・ワイドほか〉と `odds_get_form.html`〈3連複・3連単の軸馬別〉)。発走前の計算ステップは、これらだけ、取得ステップの開始以降のキャッシュに限る。 */
export const ODDS_URL_PATTERN = /api_get_jra_odds|\/odds\//;

/** {@link CacheMissError} の文面の頭(警告の書き換え {@link describeScrapeWarning} が、この語で計算ステップのキャッシュ無しを見分ける)。 */
export const CACHE_MISS_HEAD = "キャッシュに無い取得先です(計算ステップは netkeiba には出ません)";

/** 計算ステップで、キャッシュに無いものをネットワークに取りに行かないための取得器(呼ばれたら投げる)。 */
export class CacheMissError extends Error {
  constructor(url: string) {
    super(`${CACHE_MISS_HEAD}: ${url}`);
    this.name = "CacheMissError";
  }
}

/** 計算ステップが、取得済みのキャッシュを鮮度に関係なく読むための TTL(実質無期限)。 */
const FOREVER_MS = Number.MAX_SAFE_INTEGER;
export const CACHE_ONLY_TTL: ScrapeTtlConfig = {
  shutubaMs: FOREVER_MS,
  resultsMs: FOREVER_MS,
  oikiriMs: FOREVER_MS,
  oddsMs: FOREVER_MS,
  raceListMs: FOREVER_MS,
  jockeyMs: FOREVER_MS,
  trainerMs: FOREVER_MS,
  newspaperMs: FOREVER_MS,
};

/**
 * 設定のスナップショットのうち、配分に使う 14 項目(Issue #533 で単勝・複勝の点数の上限を足して 11 → 13、Issue #656 で市場に寄せる割合 `marketShrinkWeight` を足して 14)(`runAnalysis` の `allocationSettings`)。発走前の計算ステップ(分析)と、締切の直前の再計算(Issue #338)が**同じ関数**で作る
 * (食い違うと、再計算の配分が分析時の配分と、設定の差で食い違う)。
 */
export function allocationSettingsOf(settings: CloudSettings): AnalysisAllocationSettings {
  return {
    bankroll: settings.bankroll,
    perRaceCap: settings.perRaceCap,
    kellyFraction: settings.kellyFraction,
    minHitProb: settings.minHitProb,
    maxWinBets: settings.maxWinBetsPerRace,
    maxPlaceBets: settings.maxPlaceBetsPerRace,
    marketShrinkWeight: settings.marketShrinkWeight,
    includeComboOdds: settings.includeComboOdds,
    includeWideInAllocation: settings.includeWideInAllocation,
    includeTrioInAllocation: settings.includeTrioInAllocation,
    includeQuinellaInAllocation: settings.includeQuinellaInAllocation,
    includeExactaInAllocation: settings.includeExactaInAllocation,
    includeTrifectaInAllocation: settings.includeTrifectaInAllocation,
    includeBracketQuinellaInAllocation: settings.includeBracketQuinellaInAllocation,
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpError && error.cause instanceof GateRefusedError) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 再試行しても直らない失敗(ブレーカーが開いている・許可リスト外)。 */
export function isFatalFetchError(error: unknown): boolean {
  if (error instanceof HttpError && error.cause instanceof GateRefusedError) {
    return error.cause.reason === "blocked" || error.cause.reason === "disallowed-url";
  }
  return false;
}

/** 差し込みの例外をログに残すときの 1 行の長さの上限(Issue #680)。 */
export const OVERRIDE_ERROR_LOG_MAX_CHARS = 300;

/**
 * `scrapeRace` の `onOverrideError`(JRA のオッズの差し込みが例外を投げた)に渡す関数を作る(Issue #680)。
 * 例外の名前と文面を **`onWarn`(DO のログ)にだけ**出す。利用者の画面(`result.warnings`)にも D1(`odds_sources_json`)にも入れない
 * (理由はそちらでは固定の語 `override-error` のまま。内部の語を画面に出さない #677 の方針)。1 行は {@link OVERRIDE_ERROR_LOG_MAX_CHARS} 字に切り詰める。
 * 鍵の形の伏せ字は、渡された `onWarn`(本体の包み)が行う。ログの出力の失敗で取得を落とさない(`scrapeRace` 側でも握る)。
 */
export function overrideErrorLogger(
  onWarn: (message: string) => void,
  label: string,
): (info: { readonly kind: string; readonly error: unknown }) => void {
  return ({ kind, error }) => {
    const name = error instanceof Error ? error.name : typeof error;
    const line = `JRA のオッズを使えませんでした(${label}・${kind}): ${name}: ${errorMessage(error)}`;
    onWarn(line.length > OVERRIDE_ERROR_LOG_MAX_CHARS ? `${line.slice(0, OVERRIDE_ERROR_LOG_MAX_CHARS)}…` : line);
  };
}
