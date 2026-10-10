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
 * - キャッシュTTL: 戦績・調教(24時間)とレース一覧(6時間)は長TTL、出馬表は当日の更新(取消・馬体重・
 *   乗り替わり)を拾うため10分(Issue #155)、オッズは60秒。
 *   発走直前の再取得は bypassOddsCache でキャッシュを迂回する。
 * - 組合せオッズ(ワイド・3連複)は`options.includeComboOdds`によるオプトイン(既定OFF。
 *   機能D-2b-B・Issue #33第4段)。取得は`fetch-combo-odds.ts`(第3段)に委譲し、本ファイルは
 *   「呼ぶかどうか」「警告をいつ出すか」「`OddsSnapshot`/`RaceDataMeta`にどう詰めるか」の
 *   配線のみを担う(取得ロジック自体の再実装はしない)。
 */

import type { CachedFetchTextOptions } from "./cached-fetcher.js";
import { toComboOddsScalarMap, type ComboBetType } from "./combo-odds-key.js";
import {
  fetchBracketQuinellaOdds,
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
  ScratchedHorse,
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
 * 出馬表のキャッシュ許容鮮度(ミリ秒)。既定10分(Issue #155)。
 *
 * 出馬表は当日に更新される(取消・除外、馬体重、騎手の乗り替わり、斤量)。取消は #154 で
 * `scrapeRace` が出走馬から除くようにしたが、**キャッシュ上の出馬表が取消の発表前のものだと
 * 印が無く、除けない**。かつては6時間持たせていたため、最長6時間その取りこぼしが続いた。
 * 分析は発走前に利用者が操作するので、古さを10分以内に抑える(オッズの60秒ほど厳しくはしない)。
 *
 * 取り直しのコストは1レースにつき出馬表1リクエスト(最低1.5秒間隔)だけで、戦績・調教・
 * レース一覧のキャッシュには影響しない。一括分析は1レース1回の取得なのでリクエスト数はほぼ
 * 変わらず、増えるのは**同じレースを10分以上あけて再分析したとき**だけ。
 *
 * 鮮度は読み取り側で判定する(`cache.ts`の`maxAgeMs`)ので、既に保存済みの6時間以内の行も、
 * この値を超えていれば次の取得で自然に取り直される(移行処理は不要)。
 */
export const DEFAULT_SHUTUBA_TTL_MS = 10 * 60 * 1000;

/**
 * 全戦績のキャッシュ許容鮮度(ミリ秒)。既定24時間。
 * 過去走は確定データで、対象レース当日に馬の履歴が増えることはないため長めに持つ。
 */
export const DEFAULT_RESULTS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 調教(追い切り)のキャッシュ許容鮮度(ミリ秒)。既定24時間(戦績の`DEFAULT_RESULTS_TTL_MS`と同じ)。
 * 追い切りは開催直前までに確定し、当日の朝に取得できていればその後に更新されることはまずない
 * (ユーザー判断 2026-10-07)ので、戦績と同じ24時間とする。旧版は「当日更新の可能性を見て6時間」
 * だったが、その根拠は成り立たない(クラウド版では、事前分析〈当時の名称は「朝の準備」で午前に実行。Issue #249 で前日の夜に変わった〉で取った調教が、夕方の発走前の
 * 分析で6時間の期限切れになり、無駄に取り直していた)。出馬表の10分(`DEFAULT_SHUTUBA_TTL_MS`)とは独立。
 * 鮮度は読み取り側で判定する(`cache.ts`の`maxAgeMs`)ので、保存済みの行にも移行処理なしで効く。
 * 取り直しが減るだけで、分析の結果は変わらない。
 */
export const DEFAULT_OIKIRI_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * オッズのキャッシュ許容鮮度(ミリ秒)。既定60秒。
 * オッズは発走直前まで刻々と変動するため短い。確実に最新を取りたい場合は bypassOddsCache を使う。
 */
export const DEFAULT_ODDS_TTL_MS = 60 * 1000;

/**
 * レース一覧のキャッシュ許容鮮度(ミリ秒)。既定6時間。
 * 開催日のレース割りは基本的に確定済みなので6時間とする(一覧は馬ごとの情報を持たず、取消の判定には使わない)。
 * 出馬表の10分(`DEFAULT_SHUTUBA_TTL_MS`)とは独立で、変えていない。
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
export type ScrapeWarningKind = "戦績" | "調教" | "組合せオッズ" | "出走取消";

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
 * 組合せオッズ(ワイド・3連複・馬連のいずれか)1件分の取得結果の要約
 * (機能D-2b-B・Issue #33第4段。馬連はIssue #116・#24-D3b-1で追加)。
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

/**
 * 組合せオッズ(ワイド・3連複・馬連・馬単・三連単〈中央のみ〉・枠連)取得結果のペア。
 * `options.includeComboOdds`がtrueのときのみ設定される(馬連はIssue #116・#24-D3b-1、
 * 馬単はIssue #122・#24-E2、三連単はIssue #137・#25-E2、枠連はIssue #148・#26-E2で追加)。
 */
export interface ComboOddsScrapeOutcome {
  readonly wide?: ComboOddsFetchOutcome;
  readonly trio?: ComboOddsFetchOutcome;
  readonly quinella?: ComboOddsFetchOutcome;
  readonly exacta?: ComboOddsFetchOutcome;
  /**
   * 三連単の取得結果(Issue #137・#25-E2)。**地方(NAR)では常に`undefined`**
   * (ユーザー判断2026-09-27により地方は当面取得しないため。`OddsSnapshot.trifectaCombo`の
   * JSDoc参照)。中央では他の4券種と同じく`options.includeComboOdds`がtrueのとき設定される。
   */
  readonly trifecta?: ComboOddsFetchOutcome;
  /**
   * 枠連の取得結果(Issue #148・#26-E2)。三連単と異なり**中央・地方とも**
   * `options.includeComboOdds`がtrueのとき設定される(1レースあたり常に1リクエスト。
   * `OddsSnapshot.bracketQuinellaCombo`のJSDoc参照)。ただし枠連の取得中に想定外の例外が
   * 起きた場合(出馬表の枠番が不正な場合等。`parseShutuba`が枠番を検証するため
   * productionからは到達しない)は、他の券種と同じく警告に落とし、本フィールドは`undefined`になる。
   */
  readonly bracketQuinella?: ComboOddsFetchOutcome;
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
   * 意図的に設けていない(#33のコメント「実装中に確定した判断の記録(クローズ前の申し送り)」
   * に判断理由を記録)。組合せオッズの新鮮さは
   * `meta.comboOdds`(診断値。`requestCount`等)から間接的に読み取ること。
   */
  readonly oddsFetchedAt: string;
  /** 非致命的な警告の一覧。 */
  readonly warnings: ScrapeWarning[];
  /**
   * 組合せオッズ(ワイド・3連複)の取得結果。`options.includeComboOdds`がtrueのときのみ
   * 設定される(既定はundefined。機能D-2b-B・Issue #33第4段)。
   *
   * **進捗表示の要否は判断済み(Issue #15再スコープ・2026-08-20)**: レース内(1レースの
   * 組合せオッズ取得中)の進捗表示は出さない。レース単位(一括分析での複数レース間)の
   * 逐次表示は #49 へ分離した。`onProgress`コールバックは現状持たない。
   */
  readonly comboOdds?: ComboOddsScrapeOutcome;
  /**
   * 出馬表に取消・除外の印が付いていたため、出走馬(`RaceData.horses`)から除いた馬
   * (Issue #154)。**除いた馬がいるときだけ設定される**(いなければキー自体が無い。取消の
   * 無いレースの出力は従来と変わらない)。除くのは出馬表(`horses`)だけで、
   * `odds.win` / `odds.place` の取消馬の欄(オッズ null・人気 9999)はそのまま残る。
   * 同じ内容が `warnings`(kind=出走取消)にも1頭1件で入り、画面の警告欄に出る。
   *
   * 観測は中央 202606040901(発走後の取得)の「取消」のみ。発走前の印・地方の印・
   * 「除外」の文言は未観測で、同じ雛形・同じ印と見込んでいる。
   */
  readonly scratched?: readonly ScratchedHorse[];
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
 * 券種の日本語表示名(警告メッセージ用)。
 *
 * **網羅的なswitchにする理由(Issue #106・#24-B着手前ゲートで発見)**: 従来は
 * `betType === "wide" ? "ワイド" : "3連複"` という2値専用の三項演算子だった。
 * `ComboBetType`に`exacta`(馬単)を追加した際、この三項演算子はコンパイルエラーを
 * 出さずに馬単を誤って「3連複」と表示する状態になっていた(**現在は本ファイルの
 * `fetchComboBetTypeOdds`呼び出しがwide・trio・quinella〈Issue #116・#24-D3b-1〉・
 * exacta〈Issue #122・#24-E2〉・trifecta〈Issue #137・#25-E2。ただし中央のみ〉の
 * 5券種すべてを取得しており、5つともproductionから到達する。枠連〈Issue #148・#26-E2〉は
 * `fetchComboBetTypeOdds`ではなく専用の`fetchBracketQuinellaOutcome`が取得するが、警告文言の
 * 券種名は本関数を共有するため`bracketQuinella`のcaseも到達する**)。`default`のnever
 * 到達チェックにより、次に券種を追加する際〈#26等〉は必ずコンパイルエラーで
 * 気づける形にしておく。
 *
 * **三連単(trifecta)は地方(NAR)では`fetchComboBetTypeOdds`が呼ばれない**
 * (ユーザー判断2026-09-27。`scrapeRace`の`if (!isNar)`ガード参照)ため、このcaseの
 * 地方分岐は依然として到達しないが、中央分岐は#137で到達するようになった。
 */
function comboBetTypeLabel(betType: ComboBetType): string {
  switch (betType) {
    case "wide":
      return "ワイド";
    case "trio":
      return "3連複";
    case "exacta":
      return "馬単";
    case "quinella":
      return "馬連";
    case "trifecta":
      return "三連単";
    case "bracketQuinella":
      return "枠連";
    default: {
      const exhaustiveCheck: never = betType;
      throw new Error(`未知の券種です: ${String(exhaustiveCheck)}`);
    }
  }
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
    // 「全requestCount件が失敗」とは書かない: state==="failed"はobtainedComboCount===0かつ
    // 全試行がunavailableではない、という条件でしかなく、HTTP自体は成功して構造的に正当な
    // 「未発売」文書が返っている試行が大半を占めるケースが普通にある(例: 9軸unavailable+
    // 1軸fetchFailedの混在)。この場合「全requestCount件が失敗」は事実に反する
    // (boss メタレビュー・提案採用)。実際の内訳はbreakdownが正確に示す。
    return `${label}オッズを1件も取得できませんでした(発売なし/未発売〈状態②③〉とは異なる。${structureWarning}内訳: ${breakdown}。requestCount=${requestCount})`;
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
): Promise<ComboOddsBetTypeResult | undefined> {
  return runComboBetTypeFetch(
    betType,
    () => fetchComboOdds(raceId, betType, startingUmabans, fetcher, fetchOptions),
    warnings,
  );
}

/**
 * 枠連の組合せオッズを取得し、`fetchComboBetTypeOdds`と同じ形(Record変換・警告判定・想定外の
 * 例外の警告化)で返す(Issue #148・#26-E2)。
 *
 * `fetchComboBetTypeOdds`(内部で`fetchComboOdds`を呼ぶ)は枠連を渡すとthrowする(#143)ため、
 * 枠連は出走馬番ではなく**出走馬の枠番**を受け取る`fetchBracketQuinellaOdds`へ委譲する専用の
 * 関数にした。後半(警告の要否・メッセージ・Record変換・catch)は`runComboBetTypeFetch`で共有する。
 *
 * `fetchBracketQuinellaOdds`は枠番が1〜8の整数でない馬がいるとHTTP発行前にthrowする(こちら側の
 * バグの検出)が、`parseShutuba`が枠番を1〜8で検証してレース全体を落とすため、production から
 * この throw に到達する経路は無い。それでも、枠連は調教と同じ任意データであり、レース全体を
 * 落とさず枠連だけを諦める契約を型と同じ場所で明示するため、他の券種と同じくcatchして警告に落とす。
 */
async function fetchBracketQuinellaOutcome(
  raceId: RaceId,
  startingWakubans: readonly number[],
  fetcher: RaceFetcher,
  fetchOptions: CachedFetchTextOptions,
  warnings: ScrapeWarning[],
): Promise<ComboOddsBetTypeResult | undefined> {
  return runComboBetTypeFetch(
    "bracketQuinella",
    () => fetchBracketQuinellaOdds(raceId, startingWakubans, fetcher, fetchOptions),
    warnings,
  );
}

/** 組合せオッズ1券種分の取得結果(`OddsSnapshot`用のRecordと、診断値の要約)。 */
interface ComboOddsBetTypeResult {
  readonly record: Record<string, number | null>;
  readonly outcome: ComboOddsFetchOutcome;
}

/**
 * 組合せオッズの取得を実行し、警告判定・`OddsSnapshot`用Recordへの変換・想定外の例外の
 * 警告化まで行う共通本体(`fetchComboBetTypeOdds`・`fetchBracketQuinellaOutcome`が共有する)。
 * `fetch`が想定外にthrowした場合は警告(`kind:"組合せオッズ"`)に落とし`undefined`を返す
 * (当該券種のRecordは未設定のまま)。
 */
async function runComboBetTypeFetch(
  betType: ComboBetType,
  fetch: () => Promise<ComboOddsFetchResult>,
  warnings: ScrapeWarning[],
): Promise<ComboOddsBetTypeResult | undefined> {
  try {
    const result = await fetch();
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
 * 取消・除外の馬を出走馬から除いたことの警告文(画面の警告欄に出る。Issue #154)。
 * 「不明」(未知の文言)は出走しない側に倒したことと、原文を添える。
 */
function scratchWarningMessage(horse: ShutubaHorse): string {
  const label = `${horse.umaban}番 ${horse.name}`;
  if (horse.scratch === "不明") {
    const text = horse.scratchText ?? "";
    return `出走取消: ${label}は出馬表に未知の印(「${text}」)が付いているため、出走しない馬として分析から除きました`;
  }
  return `出走取消: ${label}は出馬表で${horse.scratch}の印が付いているため、分析から除きました`;
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
  const parsedShutuba = parseShutuba(shutubaText);

  // (1b) 取消・除外の馬を出走馬から除く(Issue #154)。出馬表には発走前に取消になった馬が
  // 残ることがある(中央 202606040901 で観測。印は行の `Cancel` クラスと `td.Cancel_Txt`)。
  // **戦績取得より前に**除く理由: 取消は分析日に依らない事実で、ここで除けば、以降の
  // 頭数(prior の中立確率・Σ 目標 min(3,頭数)・複勝の発売条件)・戦績の取得・組合せオッズの
  // 期待組合せ数と地方3連複の軸馬・枠連の枠構成が、すべて実際に走る馬だけから作られる
  // (いずれも下の `shutuba.horses` から導出される)。#39 の戦績の絞り込みを scraper で行わない
  // のは分析日(scraper は知らない)に依存するからで、取消にはその理由が当たらない。
  // 除いた馬は meta.scratched と警告(画面の警告欄)に残す。全馬が取消扱いなら
  // parseShutuba が失敗させるので、ここで horses が空になることはない。
  const scratchedHorses: ScratchedHorse[] = [];
  const runnerHorses: ShutubaHorse[] = [];
  for (const horse of parsedShutuba.horses) {
    if (horse.scratch === undefined) {
      runnerHorses.push(horse);
      continue;
    }
    scratchedHorses.push({
      umaban: horse.umaban,
      wakuban: horse.wakuban,
      name: horse.name,
      horseId: horse.horseId,
      status: horse.scratch,
      text: horse.scratchText ?? "",
    });
    warnings.push({
      kind: "出走取消",
      horseId: horse.horseId,
      message: scratchWarningMessage(horse),
    });
  }
  const shutuba = { ...parsedShutuba, horses: runnerHorses };

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

  // (5) 組合せオッズ(ワイド・3連複・馬連・馬単・三連単〈中央のみ〉・枠連。オプトイン。既定OFF。
  // 機能D-2b-B・Issue #33第4段。馬連はIssue #116・#24-D3b-1、馬単はIssue #122・#24-E2、
  // 三連単はIssue #137・#25-E2、枠連はIssue #148・#26-E2で追加):
  // options.includeComboOddsがtrueの場合のみ実行する。既定呼び出しでは本ステップは一切実行
  // されず、発行URL列・リクエスト数は現行と完全に一致する(AC4)。馬連・馬単・三連単・枠連は
  // ワイド・3連複の**後**に取得する(既存URL列の先頭部分を変えないため。Issue #116 AC-1・
  // Issue #122 AC-1・Issue #137 AC-1・Issue #148 AC-1)。枠連は最後(三連単の後)に取得する。
  //
  // **枠連は中央・地方とも取得し、頭数(8頭以下=発売なし)で省かない(Issue #148)**: 発売の
  // 境界(9頭以上)は各頭数1レースの観測でしかなく、閾値をコードに持たせると観測の外側で静かに
  // 誤る。8頭以下の応答は`fetchBracketQuinellaOdds`が`unavailable`に分類し警告も出さない
  // (追加コストは小頭数レースの1リクエストだけ)。取得には出走馬の**枠番**を渡す
  // (期待組合せ数は枠の構成で決まる。`shutuba.horses[].wakuban`は`parseShutuba`が1〜8で検証済み)。
  //
  // **三連単は中央のみ取得する(ユーザー判断2026-09-27)**: 地方三連単は軸馬別取得
  // (1着固定・頭数分のリクエストが必要。`docs/trifecta-odds-investigation.md` §3.3)だが、
  // 当面実装しない(取得しない)と決めたため、調教(oikiri)と同じ`if (!isNar)`で明示的に
  // ガードする(wide/trio/quinella/exactaのように無条件で`fetchComboBetTypeOdds`を呼び
  // `fetch-combo-odds.ts`の地方三連単throwに委ねる設計は採らない。その方式だと地方の
  // 分析のたびに「想定外の例外」という警告が混入し、意図的な仕様であることと矛盾する。
  // `comboOddsUrlFor`の地方三連単throwは、本ガードにより到達不能のまま残る)。
  //
  // 防御カバレッジ表への追記(AC8。fetch-combo-odds.tsの表に対する追加出口):
  // | 入力 | 経路 | 防御 | 方式 | 理由・テスト所在 |
  // |---|---|---|---|---|
  // | fetchComboOddsの結果(ComboOddsCellのMap) | Object.fromEntries(toComboOddsScalarMap(...)) | あり | 変換(MapをRecordに詰め替え。#32のtoComboOddsScalarMapで下限採用ルールを1箇所に閉じる。ここで規則を再実装しない) | `scrape-race.test.ts`「JSON.stringifyを通しても値が消えないこと」it(Map化していないことのJSON往復回帰テスト) |
  // | narTrioOddsAxisUrlの契約違反throw(AC-6のfail fast経由) | fetchComboBetTypeOddsのcatch | あり | 分類(警告に落とす。他の任意データ〈調教〉と同じ扱い。レース全体は落とさない) | 本ファイル内コメント参照。専用の合成テストは今回未追加(発生させるにはshutuba由来の出走馬番自体が破損している必要があり、既存parse-shutubaの馬番検証〈1〜18範囲・throw〉が既に上流で防いでいるため実質到達不能経路。到達可能にする改変〈shutuba側の検証を弱める等〉があれば別途テストを追加すること) |
  // | fetchBracketQuinellaOddsの契約違反throw(Issue #148。出走馬の枠番が1〜8の整数でない) | fetchBracketQuinellaOutcomeのcatch | あり | 分類(警告に落とし枠連だけ諦める。上と同じ扱い) | 専用の合成テストは未追加(上と同じ理由: `parseShutuba`の枠番検証〈1〜8・throw〉が上流でレース全体を落とすため、fetcherの入力からは発生させられない実質到達不能経路。Issue #148着手前ゲートで合意した【記録】区分) |
  let wideCombo: Record<string, number | null> | undefined;
  let trioCombo: Record<string, number | null> | undefined;
  let quinellaCombo: Record<string, number | null> | undefined;
  let exactaCombo: Record<string, number | null> | undefined;
  let trifectaCombo: Record<string, number | null> | undefined;
  let bracketQuinellaCombo: Record<string, number | null> | undefined;
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
    const quinellaOutcome = await fetchComboBetTypeOdds(
      "quinella",
      raceId,
      startingUmabans,
      deps.fetcher,
      oddsFetchOptions,
      warnings,
    );
    const exactaOutcome = await fetchComboBetTypeOdds(
      "exacta",
      raceId,
      startingUmabans,
      deps.fetcher,
      oddsFetchOptions,
      warnings,
    );
    // 三連単は中央のみ(調教と同じ明示ガード。上記コメント参照)。地方では
    // fetchComboBetTypeOdds自体を呼ばないため、リクエストも警告も発生しない。
    const trifectaOutcome = isNar
      ? undefined
      : await fetchComboBetTypeOdds(
          "trifecta",
          raceId,
          startingUmabans,
          deps.fetcher,
          oddsFetchOptions,
          warnings,
        );
    // 枠連(Issue #148・#26-E2): 中央・地方とも取得する。最後(三連単の後)に発行する。
    const bracketQuinellaOutcome = await fetchBracketQuinellaOutcome(
      raceId,
      shutuba.horses.map((h) => h.wakuban),
      deps.fetcher,
      oddsFetchOptions,
      warnings,
    );
    wideCombo = wideOutcome?.record;
    trioCombo = trioOutcome?.record;
    quinellaCombo = quinellaOutcome?.record;
    exactaCombo = exactaOutcome?.record;
    trifectaCombo = trifectaOutcome?.record;
    bracketQuinellaCombo = bracketQuinellaOutcome?.record;
    comboOdds = {
      wide: wideOutcome?.outcome,
      trio: trioOutcome?.outcome,
      quinella: quinellaOutcome?.outcome,
      exacta: exactaOutcome?.outcome,
      trifecta: trifectaOutcome?.outcome,
      bracketQuinella: bracketQuinellaOutcome?.outcome,
    };
  }

  const odds: OddsSnapshot = {
    ...baseOdds,
    ...(wideCombo !== undefined ? { wideCombo } : {}),
    ...(trioCombo !== undefined ? { trioCombo } : {}),
    ...(quinellaCombo !== undefined ? { quinellaCombo } : {}),
    ...(exactaCombo !== undefined ? { exactaCombo } : {}),
    ...(trifectaCombo !== undefined ? { trifectaCombo } : {}),
    ...(bracketQuinellaCombo !== undefined ? { bracketQuinellaCombo } : {}),
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
    meta: {
      fetchedAt,
      oddsFetchedAt,
      warnings,
      comboOdds,
      ...(scratchedHorses.length > 0 ? { scratched: scratchedHorses } : {}),
    },
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
