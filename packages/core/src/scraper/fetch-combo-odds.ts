/**
 * fetch-combo-odds — 組合せオッズ(ワイド・3連複)取得のオーケストレーション層
 * (機能D-2b-B・Issue #33第3段。boss着手前ゲート2026-08-07裁定)。
 *
 * `HttpClient`(構造的に互換な最小フェッチャ)を受け取り、中央/地方 × ワイド/三連複の
 * 4経路を束ねて「成否と診断値」を返す純粋な取得層。**`OddsSnapshot`拡張・`scrapeRace`配線
 * (第4段のスコープ)には一切触れない**。`scraper/`配下の葉モジュール(`scrape-race.ts`)を
 * importすると層依存が逆流するため、フェッチャの型もローカルに独立定義する
 * (`ScrapeWarning`/`ScrapeWarningKind`の生成・拡張も第4段の責務)。
 *
 * ## 4経路
 * - 中央ワイド/3連複: `wideOddsApiUrl`/`trioOddsApiUrl` を1リクエスト → `parseComboOdds`
 * - 地方ワイド: `narWideOddsPageUrl` を1リクエスト → `parseNarComboOdds`
 *   (軸馬別の制限を受けない。`urls.ts`のJSDoc参照)
 * - 地方3連複: `deriveNarTrioAxisUmabans` で軸集合を導出し、各軸に `narTrioOddsAxisUrl` を
 *   1リクエストずつ直列に発行 → `parseNarComboOdds` → `mergeAxisComboOddsMaps` でマージ
 *
 * ## Q3裁定(catchの方針): 本階層は基本的にthrowしない
 *
 * 本関数は最大16回(`MAX_UMABAN`-2)の取得を束ねる関数であり、**部分成功が正常な結果形状**である。
 * どの軸が成功/失敗したかを知っているのは本関数だけで、ここで生例外を投げると第4段の
 * `scrapeRace`はその知識を再構成できない。したがって、HTTP取得失敗・パース例外
 * (`ComboOddsParseError`/`NarComboOddsParseError`)は**すべてcatchして診断値に分類する**
 * (中央・地方ワイドも地方3連複と同じ扱いにするのは、呼び出し側が券種・主催ごとに
 * 2種類のエラープロトコルを使い分けずに済むようにするため)。「必須/任意」の判断
 * (`ScrapeWarning`を実際に上げるかどうか)は第4段の責務。
 *
 * **catchしてはいけないもの(AC-6)**: `narTrioOddsAxisUrl`の契約違反throwと軸馬番の異常。
 * これらは市場データの異常ではなく**こちら側のバグ**(`jiku`は`deriveNarTrioAxisUmabans`が
 * 出走馬番から導出した値であり、外部から来た数値ではない)。ただしループ途中で投げると
 * 成功済みの軸の結果を握りつぶしてしまうため、**軸集合導出の直後・HTTP発行前に全軸馬番を
 * 検証してfail fastする**(`fetchNarTrioComboOdds`参照)。
 *
 * ## Q2裁定(警告規則の第4段への申し送り)
 *
 * 本関数自身は`ScrapeWarning`を生成しない(層依存の都合。上記参照)が、軸ごとの結末
 * (`diagnostics.attempts`)から第4段が以下の規則で警告を判断できるよう、規則そのものを
 * ここに明記して再発明を防ぐ:
 *
 * | 軸の結末 | 意味 | 警告 |
 * |---|---|---|
 * | 全軸 `unavailable` | 首尾一貫 = 状態②発売なし/③未発売。区別しない(#32踏襲) | 出さない |
 * | 一部だけ `available`、残り `unavailable` | 市場は生きているのに一部が空 = 矛盾 | 出す |
 * | 一部だけ HTTP失敗(`fetchFailed`) | 生きた市場の部分被覆 | 出す |
 * | 全軸 `fetchFailed` | 状態④取得失敗。②③と絶対に混同しない | 出す(必須) |
 * | 構造異常(`parseError`) | サイト構造変更の疑い(AC7b「静かな劣化」) | 出す |
 *
 * この規則は発売前レースでは1件も発火しない(全軸`unavailable`で揃うため。`unavailableAxes`
 * 単体の即警告はアラート疲れを招くとして前boss・本bossの双方で却下されている)。
 *
 * ## AC-10: 最小値採用がEVに与える系統誤差(未測定)
 *
 * 地方3連複の軸集合は出走馬番の上位2頭を含まない(`deriveNarTrioAxisUmabans`参照)。
 * このため各トリオが軸走査で「何回観測されるか」(=`mergeAxisComboOddsMaps`が最小値を
 * 取る際の標本数)は組の内容に依存して不均一になる: **上位2頭を含まない組は3回、
 * 片方を含む組は2回、両方を含む組は1回**観測される(最大3標本の最小値)。最小値採用
 * (`mergeAxisComboOddsMaps`のQ1裁定)は保守的(EVを過大評価しない方向)だが、
 * **下押しの大きさは組の重複度(1〜3)に依存して不均一であり、実測されていない**。
 * #28(券種横断予算配分の有効化)で回収率を見る際の既知の系統誤差として申し送る。
 *
 * ## 防御カバレッジ表(AC-8。#14/#32と同じ5列)
 *
 * | 入力 | 経路 | 防御 | 方式 | 理由・テスト所在 |
 * |---|---|---|---|---|
 * | 出走馬番(頭数nの源。`parseShutuba`由来の**外部データ**) | `deriveNarTrioAxisUmabans` → 事前検証ループ | あり | throw(HTTP発行前にfail fast) | 非整数・範囲外が`jiku`に混入するとURLが壊れる。#14`validateCandidates`と同じ扱い。`fetch-combo-odds.test.ts`「軸馬番の契約違反はfail fast」describe |
 * | 軸馬番`jiku`(**こちらが導出した引数**) | `narTrioOddsAxisUrl` | あり(第2段で実装済み) | throw(非有限・小数・0・負値・>18) | 二層原則の門番側。`urls.test.ts` |
 * | リクエスト数(n-2。**導出値**) | 軸ループ | 対象外(構造的に有界) | 上限は`MAX_UMABAN`=18より最大16回。1.5秒間隔から所要は最大約24秒(**導出値**。16頭なら14回≒21秒) | 追加の人為的キャップは置かない。実際の発行回数は`diagnostics.requestCount`に残す |
 * | 軸ごとのHTTP応答(取得失敗) | 軸ループの catch | あり | 分類(`fetchFailed`。throwしない) | 部分成功が正常な結果形状。`fetch-combo-odds.test.ts`「券種の結末3値」describe |
 * | 軸ごとのパース結果(`unavailable`) | 軸ループ | あり | 分類(単体では警告にしない。第4段への申し送り) | 発売前レースで全軸に出るためアラート疲れ(Q2裁定) |
 * | 軸ごとのパース例外(`NarComboOddsParseError`/`ComboOddsParseError`) | 軸ループ・単発リクエストの catch | あり | 分類(`parseError`。`fetchFailed`と別枠) | サイト構造変更の早期警戒(AC7b) |
 * | 軸間の同一キーの値(**衝突**) | `mergeAxisComboOddsMaps`(`combo-odds-key.ts`) | あり | 分類+保守側採用(`null`<小<大。throwしない) | #14の下限採用と同じ保守方針。合成データでテスト(`combo-odds-key.test.ts`) |
 */

import type { CachedFetchTextOptions } from "./cache.js";
import {
  COMBO_SIZE,
  mergeAxisComboOddsMaps,
  type AxisComboOddsMap,
  type ComboBetType,
  type ComboOddsCell,
  type ComboOddsCellConflict,
} from "./combo-odds-key.js";
import type { RaceId } from "./ids.js";
import { venueKindOfRaceId } from "./ids.js";
import { deriveNarTrioAxisUmabans } from "./nar-trio-axis.js";
import {
  parseComboOdds,
  type ComboOddsUnavailableReason,
} from "./parse-combo-odds.js";
import {
  parseNarComboOdds,
  type NarComboOddsUnavailableReason,
} from "./parse-nar-combo-odds.js";
import {
  narTrioOddsAxisUrl,
  narWideOddsPageUrl,
  trioOddsApiUrl,
  wideOddsApiUrl,
} from "./urls.js";

/**
 * `fetchComboOdds` が要求する最小限のフェッチャ。`RaceFetcher`(`scrape-race.ts`)と
 * 構造的に同じ形だが、層依存の逆流を避けるため独立定義する(モジュール冒頭JSDoc参照)。
 * `HttpClient`・`CachedFetcher`のいずれも構造的に満たす。
 */
export interface ComboOddsFetcher {
  fetchText(url: string, options?: CachedFetchTextOptions): Promise<string>;
}

/** 1回の取得試行(中央・地方ワイドは1件のみ。地方3連複は軸ごとに1件)の結末。 */
export type ComboOddsFetchAttempt =
  | { readonly axis: number | null; readonly state: "available"; readonly comboCount: number }
  | {
      readonly axis: number | null;
      readonly state: "unavailable";
      readonly reason: ComboOddsUnavailableReason | NarComboOddsUnavailableReason;
    }
  | { readonly axis: number | null; readonly state: "fetchFailed"; readonly message: string }
  | { readonly axis: number | null; readonly state: "parseError"; readonly message: string };

/**
 * 券種の最終状態(AC-4。3値)。
 * - "available": 少なくとも1件の組合せオッズが得られた(部分被覆を含む)
 * - "unavailable": 市場が首尾一貫して未発売/発売なし(状態②③。区別しない)
 * - "failed": 取得できず、②③と断定できない(状態④。取消馬による欠落と混同しないための区別)
 */
export type ComboOddsFetchState = "available" | "unavailable" | "failed";

/** `fetchComboOdds` の診断値(AC-5)。 */
export interface ComboOddsFetchDiagnostics {
  readonly betType: ComboBetType;
  /** 発行したHTTPリクエスト数。 */
  readonly requestCount: number;
  /** 出走馬番から導出した期待組合せ数(ワイド: C(n,2)、3連複: C(n,3))。 */
  readonly expectedComboCount: number;
  /** マージ後に実際に得られた組合せ数。 */
  readonly obtainedComboCount: number;
  /** expectedComboCount - obtainedComboCount(0未満にはならない)。#13未検証の取消馬による欠落の可視化。 */
  readonly missingComboCount: number;
  /** 地方3連複の軸馬番配列(昇順)。中央・地方ワイドは空配列。 */
  readonly axisUmabans: readonly number[];
  /** 取得試行ごとの結末(中央・地方ワイドは1件、地方3連複は軸数件)。 */
  readonly attempts: readonly ComboOddsFetchAttempt[];
  /** 軸間の数値衝突件数(oddsMinが数値同士で食い違った件数)。 */
  readonly numericConflictCount: number;
  /** 軸間のnull採用衝突件数(片方がnullだった件数)。 */
  readonly nullWinConflictCount: number;
  /** 衝突サンプル(上限{@link MAX_CONFLICT_SAMPLES}件で打ち切り。正確な件数は上記2フィールド)。 */
  readonly conflictSamples: readonly ComboOddsCellConflict[];
}

/** `fetchComboOdds` の戻り値。 */
export interface ComboOddsFetchResult {
  readonly state: ComboOddsFetchState;
  /** マージ後のオッズセルMap(失敗した試行にしか属さない組はキーごと不在。AC-5b)。 */
  readonly odds: ReadonlyMap<string, ComboOddsCell>;
  readonly diagnostics: ComboOddsFetchDiagnostics;
}

/** 診断値に残す衝突サンプルの上限件数(表示用のキャップ。正確な件数は numericConflictCount/nullWinConflictCount に別途保持する)。 */
const MAX_CONFLICT_SAMPLES = 10;

/** エラーオブジェクトから表示用メッセージを取り出す(`scrape-race.ts`と同じパターン)。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 組合せ数 C(n, r) を計算する(n<r または r<0 は0件)。 */
function combinationCount(n: number, r: number): number {
  if (r < 0 || n < r) return 0;
  let result = 1;
  for (let i = 0; i < r; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * 試行結果の一覧から券種の最終状態(AC-4)を決定する。
 * - 1件でも`available`があれば"available"(部分被覆を含む。診断値で被覆度が読み取れる)
 * - 試行が0件(軸0件)なら"unavailable"(#33本文の境界: n<3 → 0リクエスト・unavailable)
 * - 全試行が`unavailable`(市場が首尾一貫して未発売/発売なし)なら"unavailable"
 * - それ以外(1件でも`fetchFailed`/`parseError`を含み、かつ`available`が0件)は"failed"
 *   (②③〈市場が無い〉と④〈取得できず分からない〉を混同しない。AC7bの趣旨)
 */
function determineState(
  obtainedComboCount: number,
  attempts: readonly ComboOddsFetchAttempt[],
): ComboOddsFetchState {
  if (obtainedComboCount > 0) return "available";
  if (attempts.length === 0) return "unavailable";
  if (attempts.every((a) => a.state === "unavailable")) return "unavailable";
  return "failed";
}

/** 診断値を組み立てる(中央・地方ワイド〈単発〉・地方3連複〈軸走査〉で共有)。 */
function buildResult(
  betType: ComboBetType,
  startingUmabans: readonly number[],
  requestCount: number,
  axisUmabans: readonly number[],
  attempts: readonly ComboOddsFetchAttempt[],
  odds: ReadonlyMap<string, ComboOddsCell>,
  conflicts: readonly ComboOddsCellConflict[],
): ComboOddsFetchResult {
  const n = new Set(startingUmabans).size;
  const expectedComboCount = combinationCount(n, COMBO_SIZE[betType]);
  const obtainedComboCount = odds.size;
  const missingComboCount = Math.max(0, expectedComboCount - obtainedComboCount);
  const numericConflictCount = conflicts.filter((c) => c.kind === "numeric").length;
  const nullWinConflictCount = conflicts.filter((c) => c.kind === "nullWin").length;
  const conflictSamples = conflicts.slice(0, MAX_CONFLICT_SAMPLES);
  const state = determineState(obtainedComboCount, attempts);

  return {
    state,
    odds,
    diagnostics: {
      betType,
      requestCount,
      expectedComboCount,
      obtainedComboCount,
      missingComboCount,
      axisUmabans,
      attempts,
      numericConflictCount,
      nullWinConflictCount,
      conflictSamples,
    },
  };
}

/** 中央ワイド/3連複・地方ワイド(いずれも1リクエストで完結)を取得する。 */
async function fetchSingleRequestComboOdds(
  raceId: RaceId,
  betType: ComboBetType,
  isNar: boolean,
  startingUmabans: readonly number[],
  fetcher: ComboOddsFetcher,
  options: CachedFetchTextOptions,
): Promise<ComboOddsFetchResult> {
  const url = isNar
    ? narWideOddsPageUrl(raceId)
    : betType === "wide"
      ? wideOddsApiUrl(raceId)
      : trioOddsApiUrl(raceId);

  let attempt: ComboOddsFetchAttempt;
  let odds: ReadonlyMap<string, ComboOddsCell> = new Map();

  try {
    const text = await fetcher.fetchText(url, options);
    try {
      const parsed = isNar ? parseNarComboOdds(text, betType) : parseComboOdds(text, betType);
      if (parsed.state === "available") {
        odds = parsed.odds;
        attempt = { axis: null, state: "available", comboCount: parsed.odds.size };
      } else {
        attempt = { axis: null, state: "unavailable", reason: parsed.reason };
      }
    } catch (error) {
      attempt = { axis: null, state: "parseError", message: errorMessage(error) };
    }
  } catch (error) {
    attempt = { axis: null, state: "fetchFailed", message: errorMessage(error) };
  }

  return buildResult(betType, startingUmabans, 1, [], [attempt], odds, []);
}

/**
 * 地方3連複を軸馬別に取得する(AC-2〜AC-9)。
 *
 * 全軸のエントリを連結して`buildComboOddsCellMap`に渡す実装は禁止(AC-2)。軸ごとに
 * `parseNarComboOdds`を呼び(文書内自己整合のthrowは#32のまま生かす)、得られたMap同士を
 * `mergeAxisComboOddsMaps`でマージする。
 */
async function fetchNarTrioComboOdds(
  raceId: RaceId,
  startingUmabans: readonly number[],
  fetcher: ComboOddsFetcher,
  options: CachedFetchTextOptions,
): Promise<ComboOddsFetchResult> {
  // AC-7: 軸は deriveNarTrioAxisUmabans から取る(1..n-2 をリテラルに作らない)。
  const axisUmabans = deriveNarTrioAxisUmabans(startingUmabans);

  // AC-6: HTTP発行前に全軸馬番を検証してfail fastする(narTrioOddsAxisUrl自身の契約チェックを
  // 再利用する。戻り値は使わず検証だけが目的)。ループの中で検証すると、途中まで成功した軸の
  // 結果を握りつぶして例外にしてしまう(成功済みの部分結果を失う)ため、必ずループの外側・
  // HTTP発行より前に済ませる。ここで投げるのは市場データの異常ではなく、jiku(こちらが
  // deriveNarTrioAxisUmabansで導出した値)の契約違反=こちら側のバグである。
  for (const axis of axisUmabans) {
    narTrioOddsAxisUrl(raceId, axis);
  }

  const axisMaps: AxisComboOddsMap[] = [];
  const attempts: ComboOddsFetchAttempt[] = [];

  // AC-8: 軸は直列にawaitする。自前のsleepは持たない(レート制限はHttpClient.minIntervalMsの
  // 直列スロットの責務)。maxAgeMs/bypassCacheは全軸に一様に伝播する(optionsをそのまま渡す)。
  for (const axis of axisUmabans) {
    const url = narTrioOddsAxisUrl(raceId, axis);
    try {
      const text = await fetcher.fetchText(url, options);
      try {
        const parsed = parseNarComboOdds(text, "trio");
        if (parsed.state === "available") {
          axisMaps.push({ axis, odds: parsed.odds });
          attempts.push({ axis, state: "available", comboCount: parsed.odds.size });
        } else {
          attempts.push({ axis, state: "unavailable", reason: parsed.reason });
        }
      } catch (error) {
        attempts.push({ axis, state: "parseError", message: errorMessage(error) });
      }
    } catch (error) {
      attempts.push({ axis, state: "fetchFailed", message: errorMessage(error) });
    }
  }

  // AC-5b: axisMapsには成功した軸のみが含まれるため、失敗軸にしか属さない組は
  // マージ結果のキーとして最初から現れない(値nullで存在するのではなく不在になる)。
  const { odds, conflicts } = mergeAxisComboOddsMaps(axisMaps);

  return buildResult(
    "trio",
    startingUmabans,
    axisUmabans.length,
    axisUmabans,
    attempts,
    odds,
    conflicts,
  );
}

/**
 * 組合せオッズ(ワイド・3連複)を取得する(中央/地方 × ワイド/3連複の4経路を自動選択)。
 *
 * @param raceId 対象レースID(検証済み。中央/地方は`venueKindOfRaceId`で自動判定)
 * @param betType "wide"(ワイド)または"trio"(3連複)
 * @param startingUmabans 出走馬番の集合(順不同・重複ありうる。期待組合せ数の算出・
 *   地方3連複の軸導出に使う。`parseShutuba`の結果由来)
 * @param fetcher HTTP取得を担うフェッチャ(`HttpClient`/`CachedFetcher`のいずれも可)
 * @param options `maxAgeMs`/`bypassCache`等(全リクエストに一様に伝播する。AC-8)
 */
export async function fetchComboOdds(
  raceId: RaceId,
  betType: ComboBetType,
  startingUmabans: readonly number[],
  fetcher: ComboOddsFetcher,
  options: CachedFetchTextOptions = {},
): Promise<ComboOddsFetchResult> {
  const isNar = venueKindOfRaceId(raceId) === "nar";
  if (isNar && betType === "trio") {
    return fetchNarTrioComboOdds(raceId, startingUmabans, fetcher, options);
  }
  return fetchSingleRequestComboOdds(raceId, betType, isNar, startingUmabans, fetcher, options);
}
