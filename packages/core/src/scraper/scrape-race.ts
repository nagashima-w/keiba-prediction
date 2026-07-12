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
 * - エラー方針: 必須データ(出馬表・オッズ)の失敗は throw。optional データ(調教)の失敗は
 *   結果を null にして警告を積む。戦績は馬単位で握り、1頭の失敗で全体を落とさない。
 * - キャッシュTTL: 確定的なデータ(出馬表・戦績・調教)は長TTL、揮発性の高いオッズは短TTL。
 *   発走直前の再取得は bypassOddsCache でキャッシュを迂回する。
 */

import type { CachedFetchTextOptions } from "./cache.js";
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
}

/** 取得中に発生した非致命的な問題の種別。 */
export type ScrapeWarningKind = "戦績" | "調教";

/** 取得中に発生した非致命的な問題(結果には含めるが失敗はさせない)。 */
export interface ScrapeWarning {
  /** 種別(どのデータで起きたか)。 */
  readonly kind: ScrapeWarningKind;
  /** 人間向けの説明(原因メッセージを含む)。 */
  readonly message: string;
  /** 馬単位の警告(戦績)の場合の対象馬ID。 */
  readonly horseId?: HorseId;
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
   * オッズ取得直後の時刻(ISO8601)。オッズは発走直前まで変動するため、
   * EV計算では「いつのオッズか」を fetchedAt ではなくこの値で判断する。
   */
  readonly oddsFetchedAt: string;
  /** 非致命的な警告の一覧。 */
  readonly warnings: ScrapeWarning[];
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
  const odds = isNar
    ? parseNarOdds(
        await deps.fetcher.fetchText(narOddsPageUrl(raceId), oddsFetchOptions),
      )
    : parseOdds(
        await deps.fetcher.fetchText(oddsApiUrl(raceId), oddsFetchOptions),
      );
  // オッズ取得直後の時刻。着手時刻(fetchedAt)とは別に記録する。
  const oddsFetchedAt = now().toISOString();

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
    meta: { fetchedAt, oddsFetchedAt, warnings },
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
