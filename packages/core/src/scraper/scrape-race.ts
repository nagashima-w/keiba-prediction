/**
 * scraperファサード: 各パーサー(出馬表・戦績・調教・オッズ・レース一覧)と
 * キャッシュ付きフェッチを統合し、1レース分の完全データ(RaceData)を組み立てる。
 *
 * 設計方針:
 * - IO(HTTP・キャッシュ)は `RaceFetcher` として注入する。CachedFetcher がこれを満たすため、
 *   テストではフィクスチャを返すフェイクフェッチャを差し込み、実ネットワークを使わず検証できる。
 * - 馬プロフィール(db.netkeiba.com/horse/{id}/)は取得しない。厩舎所在地は出馬表に含まれ、
 *   全戦績はAjax APIで取れるため、プロフィール取得はリクエスト数を増やすだけで得るものがない
 *   (設計判断: 1レースあたりのGET数を「出馬表1+戦績N+調教1+オッズ1」に抑える)。
 * - エラー方針: 必須データ(出馬表・オッズ)の失敗は throw。optional データ(調教・組合せオッズ)の
 *   失敗は結果を null/未設定にして警告を積む。戦績は馬単位で握り、1頭の失敗で全体を落とさない。
 * - キャッシュTTL: 確定的なデータ(出馬表・戦績・調教)は長TTL、揮発性の高いオッズは短TTL。
 *   発走直前の再取得は bypassOddsCache でキャッシュを迂回する。
 * - 組合せオッズ(ワイド・3連複)は`options.includeComboOdds`によるオプトイン(既定OFF。
 *   機能D-2b-B・Issue #33第4段)。取得は`fetch-combo-odds.ts`(第3段)に委譲し、本ファイルは
 *   「呼ぶかどうか」「警告をいつ出すか」「`OddsSnapshot`/`RaceDataMeta`にどう詰めるか」の
 *   配線のみを担う(取得ロジック自体の再実装はしない)。
 */

import type { CachedFetchTextOptions } from "./cache.js";
import { toComboOddsScalarMap, type ComboBetType } from "./combo-odds-key.js";
import {
  fetchComboOdds,
  type ComboOddsFetchDiagnostics,
  type ComboOddsFetchResult,
  type ComboOddsFetchState,
} from "./fetch-combo-odds.js";
import type { HorseId, KaisaiDate, RaceId } from "./ids.js";
import { venueKindOfRaceId } from "./ids.js";
import { parseHorseResults } from "./parse-horse-results.js";
import { parseNarOdds } from "./parse-nar-odds.js";
import { parseOdds } from "./parse-odds.js";
import { parseOikiri } from "./parse-oikiri.js";
import { parseRaceList } from "./parse-race-list.js";
import { parseShutuba } from "./parse-shutuba.js";
import type {
  HorseRaceResult,
  OddsSnapshot,
  OikiriEntry,
  RaceListEntry,
  ShutubaHorse,
  ShutubaRaceInfo,
} from "./types.js";
import {
  horseResultsApiUrl,
  narOddsPageUrl,
  narRaceListSubUrl,
  oddsApiUrl,
  oikiriUrl,
  raceListSubUrl,
  shutubaUrl,
} from "./urls.js";

/**
 * 出馬表のキャッシュ許容鮮度(ミリ秒)。既定6時間。
 * 出馬表は前日〜当日で騎手変更・回避・馬体重発表などの更新があり得るため、
 * 戦績ほど長くは持たせない(1セッション内の再解析はキャッシュで賄える程度)。
 */
export const DEFAULT_SHUTUBA_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 全戦績のキャッシュ許容鮮度(ミリ秒)。既定24時間。
 * 過去走は確定データで、対象レース当日に馬の履歴が増えることはないため長めに持つ。
 */
export const DEFAULT_RESULTS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 調教(追い切り)のキャッシュ許容鮮度(ミリ秒)。既定6時間。
 * 追い切りは開催直前までに確定し以後変わらないが、出馬表同様に当日更新の可能性を見て6時間とする。
 */
export const DEFAULT_OIKIRI_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * オッズのキャッシュ許容鮮度(ミリ秒)。既定60秒。
 * オッズは発走直前まで刻々と変動するため短い。確実に最新を取りたい場合は bypassOddsCache を使う。
 */
export const DEFAULT_ODDS_TTL_MS = 60 * 1000;

/**
 * レース一覧のキャッシュ許容鮮度(ミリ秒)。既定6時間。
 * 開催日のレース割りは基本的に確定済みだが、直前の変更を拾えるよう出馬表と同程度にする。
 */
export const DEFAULT_RACE_LIST_TTL_MS = 6 * 60 * 60 * 1000;

/** カテゴリ別のキャッシュ許容鮮度(ミリ秒)設定。 */
export interface ScrapeTtlConfig {
  /** 出馬表。 */
  readonly shutubaMs: number;
  /** 全戦績。 */
  readonly resultsMs: number;
  /** 調教。 */
  readonly oikiriMs: number;
  /** オッズ。 */
  readonly oddsMs: number;
  /** レース一覧。 */
  readonly raceListMs: number;
}

/** 既定のTTL設定。 */
const DEFAULT_TTL: ScrapeTtlConfig = {
  shutubaMs: DEFAULT_SHUTUBA_TTL_MS,
  resultsMs: DEFAULT_RESULTS_TTL_MS,
  oikiriMs: DEFAULT_OIKIRI_TTL_MS,
  oddsMs: DEFAULT_ODDS_TTL_MS,
  raceListMs: DEFAULT_RACE_LIST_TTL_MS,
};

/**
 * ファサードが必要とするフェッチャ。CachedFetcher が構造的に満たす。
 * bare な HttpClient も渡せるが、その場合 maxAgeMs/bypassCache は無視される(キャッシュされない)。
 */
export interface RaceFetcher {
  fetchText(url: string, options?: CachedFetchTextOptions): Promise<string>;
}

/** scrapeRace / listRaces に注入する依存。 */
export interface ScrapeDeps {
  /** キャッシュ付きフェッチャ(通常は CachedFetcher)。 */
  readonly fetcher: RaceFetcher;
  /** 取得時刻を返す関数(メタ情報用)。テストで固定時刻を注入できる。既定は new Date()。 */
  readonly now?: () => Date;
  /** TTLの上書き(指定したカテゴリのみ差し替え)。 */
  readonly ttl?: Partial<ScrapeTtlConfig>;
}

/** scrapeRace の呼び出しオプション。 */
export interface ScrapeRaceOptions {
  /** true のときオッズをキャッシュを迂回して再取得する(発走直前用)。 */
  readonly bypassOddsCache?: boolean;
  /**
   * true のとき、組合せオッズ(ワイド・3連複)も取得して`OddsSnapshot`(`wideCombo`/
   * `trioCombo`)に載せる。既定は`false`(オプトイン。機能D-2b-B・Issue #33第4段AC4)。
   *
   * **未指定(既定)時は本関数が発行するURL列・リクエスト数を一切変えない**
   * (`scrape-race.test.ts`の既存describeブロックが無改変で全緑であること自体がこの証拠)。
   * true指定時は追加で最大2リクエスト(中央ワイド1件+中央3連複1件、または地方ワイド1件)、
   * 地方3連複はさらに最大16リクエスト(軸走査。`fetch-combo-odds.ts`参照。所要は最大約24秒
   * 〈16軸×1.5秒の**導出値**であり測定値ではない。16頭なら14軸≒21秒だが、それは上限ではなく
   * 一例〉が発行されうる。
   */
  readonly includeComboOdds?: boolean;
}

/** 取得中に発生した非致命的な問題の種別。 */
export type ScrapeWarningKind = "戦績" | "調教" | "組合せオッズ";

/** 取得中に発生した非致命的な問題(結果には含めるが失敗はさせない)。 */
export interface ScrapeWarning {
  /** 種別(どのデータで起きたか)。 */
  readonly kind: ScrapeWarningKind;
  /** 人間向けの説明(原因メッセージを含む)。 */
  readonly message: string;
  /** 馬単位の警告(戦績)の場合の対象馬ID。 */
  readonly horseId?: HorseId;
}

/**
 * 組合せオッズ(ワイド or 3連複)1件分の取得結果の要約(機能D-2b-B・Issue #33第4段)。
 *
 * 第3段`ComboOddsFetchResult`の`odds`(`ReadonlyMap<string, ComboOddsCell>`)は含めない。
 * `RaceDataMeta`もIPC/`JSON.stringify`を経由しうる`RaceData`の一部であり、Mapを載せると
 * `OddsSnapshot.wideCombo`/`trioCombo`と同じ「静かに`{}`になる」種を植えてしまうため
 * (`types.ts`の`OddsSnapshot`JSDoc参照)。オッズの値そのものは`OddsSnapshot`側の
 * `wideCombo`/`trioCombo`(`Record`)で保持し、ここには状態と診断値のみを残す。
 */
export interface ComboOddsFetchOutcome {
  /** 券種の最終状態(第3段AC-4の3値)。 */
  readonly state: ComboOddsFetchState;
  /** 第3段の診断値(リクエスト数・期待/実取得組合せ数・軸ごとの結末・衝突件数等)。 */
  readonly diagnostics: ComboOddsFetchDiagnostics;
}

/** 組合せオッズ(ワイド・3連複)取得結果のペア。`options.includeComboOdds`がtrueのときのみ設定される。 */
export interface ComboOddsScrapeOutcome {
  readonly wide?: ComboOddsFetchOutcome;
  readonly trio?: ComboOddsFetchOutcome;
}

/** 1頭分の統合データ(出馬表情報+全戦績+調教評価)。 */
export interface RaceHorseData {
  /** 出馬表情報。 */
  readonly shutuba: ShutubaHorse;
  /** 全戦績。取得・パースに失敗した場合は null(警告に記録される)。 */
  readonly results: HorseRaceResult[] | null;
  /** 調教評価(馬IDで突合)。突合できない・調教取得失敗時は null。 */
  readonly oikiri: OikiriEntry | null;
}

/** 取得メタ情報。 */
export interface RaceDataMeta {
  /**
   * スクレイプ着手時刻(ISO8601)。取得処理を開始した時点の時刻であって、
   * オッズの取得時刻ではない。直列に16頭分の戦績を取得するため、着手からオッズ取得までは
   * 実行環境によっては数十秒ズレる。オッズの鮮度は oddsFetchedAt を参照すること。
   */
  readonly fetchedAt: string;
  /**
   * **単勝・複勝**オッズ取得直後の時刻(ISO8601)。オッズは発走直前まで変動するため、
   * EV計算では「いつのオッズか」を fetchedAt ではなくこの値で判断する。
   *
   * **この値は `odds.wideCombo`/`odds.trioCombo`(組合せオッズ)の鮮度を表さない**
   * (機能D-2b-B・Issue #33第4段。boss メタレビュー指摘)。単勝・複勝は1リクエストで
   * 確定するため単一時刻で鮮度を表せるが、組合せオッズ(特に地方3連複の軸走査)は
   * `oddsFetchedAt` 確定より**後**に複数リクエストへ分散して取得される(地方3連複は
   * 最大16リクエスト・所要は最大約24秒〈16軸×1.5秒の**導出値**〉)。単一の
   * `oddsFetchedAt` では表しきれないため、組合せオッズ専用の取得時刻フィールドは
   * 意図的に設けていない(#33 Issue本文に判断理由を記録)。組合せオッズの新鮮さは
   * `meta.comboOdds`(診断値。`requestCount`等)から間接的に読み取ること。
   */
  readonly oddsFetchedAt: string;
  /** 非致命的な警告の一覧。 */
  readonly warnings: ScrapeWarning[];
  /**
   * 組合せオッズ(ワイド・3連複)の取得結果。`options.includeComboOdds`がtrueのときのみ
   * 設定される(既定はundefined。機能D-2b-B・Issue #33第4段)。#15(UI)が進捗表示の要否を
   * 判断する際、`diagnostics.requestCount`を使う想定(`onProgress`コールバック自体は
   * #15のスコープであり本段では持たない)。
   */
  readonly comboOdds?: ComboOddsScrapeOutcome;
}

/** 1レース分の完全データ。 */
export interface RaceData {
  /** レースID。 */
  readonly raceId: RaceId;
  /** レース情報(名称・コース・距離など)。 */
  readonly race: ShutubaRaceInfo;
  /** 出走馬(馬番昇順、出馬表のソート順に従う)。 */
  readonly horses: RaceHorseData[];
  /** 単勝・複勝オッズのスナップショット。 */
  readonly odds: OddsSnapshot;
  /** 取得メタ情報。 */
  readonly meta: RaceDataMeta;
}

/** エラーオブジェクトから表示用メッセージを取り出す。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 券種の日本語表示名(警告メッセージ用)。 */
function comboBetTypeLabel(betType: ComboBetType): string {
  return betType === "wide" ? "ワイド" : "3連複";
}

/**
 * 組合せオッズ取得結果が`ScrapeWarning`を要するかを判定する(機能D-2b-B・Issue #33第3段
 * `fetch-combo-odds.ts`のJSDoc「Q2裁定」からの申し送りをそのまま実装する。再発明しない)。
 *
 * | 軸の結末(第3段`diagnostics.attempts`) | 警告 |
 * |---|---|
 * | 全軸`unavailable`(首尾一貫して未発売/発売なし。状態②③。区別しない) | 出さない |
 * | 一部だけ`available`、残りが`unavailable`/HTTP失敗(部分被覆) | 出す |
 * | 全軸HTTP失敗(`state==="failed"`。状態④) | 出す(必須。②③と混同しない) |
 * | 構造異常(`parseError`) | 出す |
 *
 * 上記4行は次の2条件に単純化できる: `state==="failed"`を1行目として無条件に警告対象にし、
 * 残り3行は「`state==="available"`かつ`available`でない試行が1件以上ある」という単一の
 * 条件に統合される(`available`でない試行=`unavailable`/`fetchFailed`/`parseError`のいずれか)。
 * `state==="unavailable"`(全試行が`unavailable`)だけは警告を出さない、という原則がこの
 * 単純化からそのまま導かれる。
 */
function comboOddsNeedsWarning(result: ComboOddsFetchResult): boolean {
  if (result.state === "failed") return true;
  if (result.state === "available") {
    return result.diagnostics.attempts.some((a) => a.state !== "available");
  }
  return false;
}

/**
 * 組合せオッズの警告メッセージを組み立てる(診断値の要約を含める)。
 *
 * **人間が読む唯一のチャネルであることへの対応(boss メタレビュー指摘・要修正3)**:
 * `packages/app/src/main/analysis-pipeline.ts:707` は `race.meta.warnings.map((w) =>
 * w.message)` で `message` 文字列のみを取り出しており、`kind` も `meta.comboOdds` の
 * 診断値(`attempts` の内訳)もユーザーには届かない。診断値では状態④(取得失敗)と
 * 構造異常(`parseError`)を別枠に分類しているが(Q2裁定)、この文言が丸められると
 * 運用者は「取得に失敗しました」しか読めず、netkeibaのHTML/JSON構造が変わった可能性
 * (AC7bの「静かな劣化」)を疑う機会を失う。そのため常に軸/試行の内訳
 * (未発売/発売なし・取得失敗・構造異常の件数)を文言に含め、構造異常が1件でもあれば
 * 明示的に強調する。
 */
function comboOddsWarningMessage(betType: ComboBetType, result: ComboOddsFetchResult): string {
  const label = comboBetTypeLabel(betType);
  const { requestCount, expectedComboCount, obtainedComboCount, missingComboCount, attempts } =
    result.diagnostics;
  const unavailableCount = attempts.filter((a) => a.state === "unavailable").length;
  const fetchFailedCount = attempts.filter((a) => a.state === "fetchFailed").length;
  const parseErrorCount = attempts.filter((a) => a.state === "parseError").length;
  const breakdown = `未発売/発売なし=${unavailableCount} / 取得失敗=${fetchFailedCount} / 構造異常=${parseErrorCount}`;
  const structureWarning =
    parseErrorCount > 0
      ? `構造異常${parseErrorCount}件(netkeibaのHTML/JSON構造が変わった可能性)。`
      : "";
  if (result.state === "failed") {
    // 状態④(取得失敗)であることを明記し、②③(発売なし/未発売)との混同を防ぐ(AC7bの趣旨)。
    return `${label}オッズの取得に失敗しました(全${requestCount}リクエストが失敗。発売なし/未発売〈状態②③〉とは異なる。${structureWarning}内訳: ${breakdown})`;
  }
  return `${label}オッズが部分的にしか取得できませんでした(期待${expectedComboCount}件中${obtainedComboCount}件取得、${missingComboCount}件欠落。${structureWarning}内訳: ${breakdown}。requestCount=${requestCount})`;
}

/**
 * 組合せオッズ1券種分を取得し、`OddsSnapshot`用のRecordへの変換・警告判定まで行う。
 *
 * `fetchComboOdds`(第3段)は基本的にthrowしない設計(Q3裁定)だが、`narTrioOddsAxisUrl`の
 * 契約違反(AC-6のfail fast。出走馬番の異常に由来する、こちら側のバグ)は例外的にthrowしうる。
 * 組合せオッズは調教と同じ任意データ(オプトイン)であり、この例外でレース全体を落とすのは
 * 過剰なため、他の任意データ(調教)と同じくcatchして警告に落とす
 * (`odds.wideCombo`/`trioCombo`は当該券種について未設定のままになる)。
 */
async function fetchComboBetTypeOdds(
  betType: ComboBetType,
  raceId: RaceId,
  startingUmabans: readonly number[],
  fetcher: RaceFetcher,
  fetchOptions: CachedFetchTextOptions,
  warnings: ScrapeWarning[],
): Promise<{ readonly record: Record<string, number | null>; readonly outcome: ComboOddsFetchOutcome } | undefined> {
  try {
    const result = await fetchComboOdds(raceId, betType, startingUmabans, fetcher, fetchOptions);
    if (comboOddsNeedsWarning(result)) {
      warnings.push({ kind: "組合せオッズ", message: comboOddsWarningMessage(betType, result) });
    }
    return {
      record: Object.fromEntries(toComboOddsScalarMap(result.odds)),
      outcome: { state: result.state, diagnostics: result.diagnostics },
    };
  } catch (error) {
    warnings.push({
      kind: "組合せオッズ",
      message: `${comboBetTypeLabel(betType)}オッズの取得中に想定外の例外が発生しました: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

/**
 * 1レースの完全データを取得する。
 *
 * 取得順序は spec に従い 出馬表 → 各馬戦績 → 調教 → オッズ。
 * 出馬表・オッズの失敗は throw、調教の失敗は警告+null、戦績は馬単位で警告+null とする。
 *
 * @param raceId 対象レースID(検証済み)
 * @param deps フェッチャ・now・TTLの注入
 * @param options bypassOddsCache 等の呼び出しオプション
 */
export async function scrapeRace(
  raceId: RaceId,
  deps: ScrapeDeps,
  options: ScrapeRaceOptions = {},
): Promise<RaceData> {
  const ttl: ScrapeTtlConfig = { ...DEFAULT_TTL, ...deps.ttl };
  const now = deps.now ?? (() => new Date());
  const fetchedAt = now().toISOString();
  const warnings: ScrapeWarning[] = [];
  const isNar = venueKindOfRaceId(raceId) === "nar";

  // (1) 出馬表(必須): 失敗は throw。
  // shutubaUrl は race_id の場コードに応じて race.netkeiba.com / nar.netkeiba.com を
  // 自動選択するため、中央・地方でこのステップの呼び出し自体は変わらない。
  const shutubaText = await deps.fetcher.fetchText(shutubaUrl(raceId), {
    maxAgeMs: ttl.shutubaMs,
  });
  const shutuba = parseShutuba(shutubaText);

  // (2) 各馬の全戦績: 馬単位で握る(1頭の失敗で全体を落とさない)。
  // horseResultsApiUrl は db.netkeiba.com 共通で中央・地方の区別が無い(常に同じ呼び出し)。
  const results = new Map<string, HorseRaceResult[]>();
  for (const horse of shutuba.horses) {
    try {
      const text = await deps.fetcher.fetchText(
        horseResultsApiUrl(horse.horseId),
        { maxAgeMs: ttl.resultsMs },
      );
      results.set(horse.horseId, parseHorseResults(text));
    } catch (error) {
      warnings.push({
        kind: "戦績",
        horseId: horse.horseId,
        message: `馬ID ${horse.horseId} の戦績取得に失敗しました: ${errorMessage(error)}`,
      });
    }
  }

  // (3) 調教(optional・中央のみ): 地方(NAR)にはページ自体が存在しないため、
  // 取得を試みず・警告も出さず「対象外」として空(全馬null)のまま扱う。
  // 中央では従来通り、失敗しても null+警告でレースは継続する。
  const oikiriByHorse = new Map<string, OikiriEntry>();
  if (!isNar) {
    try {
      const oikiriText = await deps.fetcher.fetchText(oikiriUrl(raceId), {
        maxAgeMs: ttl.oikiriMs,
      });
      for (const entry of parseOikiri(oikiriText).entries) {
        oikiriByHorse.set(entry.horseId, entry);
      }
    } catch (error) {
      warnings.push({
        kind: "調教",
        message: `調教(追い切り)の取得に失敗しました: ${errorMessage(error)}`,
      });
    }
  }

  // (4) オッズ(必須): 失敗は throw。bypassOddsCache 指定時はキャッシュを迂回。
  // 地方(NAR)はJSON APIが存在しないため、静的HTML(narOddsPageUrl)をparseNarOddsで解釈する。
  const oddsFetchOptions: CachedFetchTextOptions = {
    maxAgeMs: ttl.oddsMs,
    bypassCache: options.bypassOddsCache ?? false,
  };
  const baseOdds = isNar
    ? parseNarOdds(
        await deps.fetcher.fetchText(narOddsPageUrl(raceId), oddsFetchOptions),
      )
    : parseOdds(
        await deps.fetcher.fetchText(oddsApiUrl(raceId), oddsFetchOptions),
      );
  // オッズ取得直後の時刻。着手時刻(fetchedAt)とは別に記録する。
  // 組合せオッズ(下記(5))はこの後に取得するが、既存の意味(「単勝・複勝オッズ取得直後」)を
  // 変えないため、(5)より前のこの位置で確定させる(オプトインしない既定呼び出しでは
  // (5)自体が実行されないため、この行の位置に関わらず既存の挙動と完全に一致する)。
  const oddsFetchedAt = now().toISOString();

  // (5) 組合せオッズ(ワイド・3連複。オプトイン。既定OFF。機能D-2b-B・Issue #33第4段):
  // options.includeComboOddsがtrueの場合のみ実行する。既定呼び出しでは本ステップは
  // 一切実行されず、発行URL列・リクエスト数は現行と完全に一致する(AC4)。
  //
  // 防御カバレッジ表への追記(AC8。fetch-combo-odds.tsの表に対する追加出口):
  // | 入力 | 経路 | 防御 | 方式 | 理由・テスト所在 |
  // |---|---|---|---|---|
  // | fetchComboOddsの結果(ComboOddsCellのMap) | Object.fromEntries(toComboOddsScalarMap(...)) | あり | 変換(MapをRecordに詰め替え。#32のtoComboOddsScalarMapで下限採用ルールを1箇所に閉じる。ここで規則を再実装しない) | `scrape-race.test.ts`「JSON.stringifyを通しても値が消えないこと」it(Map化していないことのJSON往復回帰テスト) |
  // | narTrioOddsAxisUrlの契約違反throw(AC-6のfail fast経由) | fetchComboBetTypeOddsのcatch | あり | 分類(警告に落とす。他の任意データ〈調教〉と同じ扱い。レース全体は落とさない) | 本ファイル内コメント参照。専用の合成テストは今回未追加(発生させるにはshutuba由来の出走馬番自体が破損している必要があり、既存parse-shutubaの馬番検証〈1〜18範囲・throw〉が既に上流で防いでいるため実質到達不能経路。到達可能にする改変〈shutuba側の検証を弱める等〉があれば別途テストを追加すること) |
  let wideCombo: Record<string, number | null> | undefined;
  let trioCombo: Record<string, number | null> | undefined;
  let comboOdds: ComboOddsScrapeOutcome | undefined;
  if (options.includeComboOdds) {
    const startingUmabans = shutuba.horses.map((h) => h.umaban);
    // TTL/bypassCacheは単勝・複勝オッズと同じ揮発性のデータとして扱い、専用のカテゴリは
    // 設けない(oddsFetchOptionsをそのまま流用する。デザイン判断)。
    const wideOutcome = await fetchComboBetTypeOdds(
      "wide",
      raceId,
      startingUmabans,
      deps.fetcher,
      oddsFetchOptions,
      warnings,
    );
    const trioOutcome = await fetchComboBetTypeOdds(
      "trio",
      raceId,
      startingUmabans,
      deps.fetcher,
      oddsFetchOptions,
      warnings,
    );
    wideCombo = wideOutcome?.record;
    trioCombo = trioOutcome?.record;
    comboOdds = { wide: wideOutcome?.outcome, trio: trioOutcome?.outcome };
  }

  const odds: OddsSnapshot = {
    ...baseOdds,
    ...(wideCombo !== undefined ? { wideCombo } : {}),
    ...(trioCombo !== undefined ? { trioCombo } : {}),
  };

  const horses: RaceHorseData[] = shutuba.horses.map((shutubaHorse) => ({
    shutuba: shutubaHorse,
    results: results.get(shutubaHorse.horseId) ?? null,
    oikiri: oikiriByHorse.get(shutubaHorse.horseId) ?? null,
  }));

  return {
    raceId,
    race: shutuba.race,
    horses,
    odds,
    meta: { fetchedAt, oddsFetchedAt, warnings, comboOdds },
  };
}

/**
 * 開催日のレース一覧を取得する。
 *
 * @param kaisaiDate 開催日(検証済み)
 * @param deps フェッチャ・TTLの注入
 */
export async function listRaces(
  kaisaiDate: KaisaiDate,
  deps: ScrapeDeps,
): Promise<RaceListEntry[]> {
  const ttl: ScrapeTtlConfig = { ...DEFAULT_TTL, ...deps.ttl };
  const text = await deps.fetcher.fetchText(raceListSubUrl(kaisaiDate), {
    maxAgeMs: ttl.raceListMs,
  });
  return parseRaceList(text);
}

/**
 * 開催日の地方(NAR)レース一覧を取得する。
 *
 * kaisaiDate自体は中央・地方の区別を持たないため(YYYYMMDDのみ)、URL選択は
 * listRaces と別関数に分ける。パース(parseRaceList)は中央と共通で、
 * 帯広(ばんえい・場コード65)は parseRaceId が拒否するため一覧から自動的に除外される。
 *
 * @param kaisaiDate 開催日(検証済み)
 * @param deps フェッチャ・TTLの注入
 */
export async function listNarRaces(
  kaisaiDate: KaisaiDate,
  deps: ScrapeDeps,
): Promise<RaceListEntry[]> {
  const ttl: ScrapeTtlConfig = { ...DEFAULT_TTL, ...deps.ttl };
  const text = await deps.fetcher.fetchText(narRaceListSubUrl(kaisaiDate), {
    maxAgeMs: ttl.raceListMs,
  });
  return parseRaceList(text);
}
