/**
 * mixed-allocation-view — 券種横断(複勝・ワイド・三連複)の馬券配分の合成ロジック
 * (機能D-2c第4段・Issue #28)。
 *
 * 第1〜3段(組合せオッズを renderer まで運ぶ器・候補ビルダー `mixed-candidates.ts`・
 * 取得の有効化)を土台に、実際にユーザーへ提示する配分提案を合成する。**画面
 * (`BatchAnalysisView.tsx`)は本モジュールを呼び出すだけで、`bet-allocation-view.ts`・
 * `mixed-candidates.ts` は一切変更しない**(`formatBetLabel`/`evThresholdFootnote`の文言修正を
 * 除く。D-4対応として第4段前半で既に完了済み)。
 *
 * ## ゲート順序(boss改訂・AC3)
 *
 * 1. `unset`(総資金・1レース上限が未設定) → 既存 `buildRaceAllocation` の結果をそのまま返す
 *    (レース全体の表示ゲート。従来どおり)
 * 2. `yoso`(オッズ未発売) → 同上(発売前は組合せオッズも存在しないため、レース全体のゲートで
 *    正しい。第2段の理由(i)と同じ)
 * 3. **頭数不可はここで判定しない。** `mixed-candidates.ts` は反証C・反証Bにより
 *    `resolvePlaceBetTarget` を「レース全体の表示ゲート」から「複勝候補を載せるか否かの判定」へ
 *    意図的に格下げしている(5〜7頭で複勝が対象外になる理由は複勝の払戻対象着数の問題であり、
 *    ワイド・三連複には当てはまらない)。本モジュールもこれを踏襲し、頭数不可を混在経路全体の
 *    ゲートにしない。頭数不可のまま混在経路に入った場合、複勝が対象外である旨は
 *    `diagnostics.place`(`kind:"unavailable"`)としてそのまま表現され、表示側
 *    (`BatchAnalysisView.tsx`。第4段後半)が既存の `placeBetUnavailableMessage(reason)` を
 *    そのまま使って1行を追加する(新しい文言を作らない)。
 * 4. D-2 フォールバック規則(単一定義の原則。3条件のいずれかで既存 `buildRaceAllocation` の
 *    結果をそのまま返す):
 *    - `includeComboOdds` が OFF
 *    - ワイド・三連複とも配分対象OFF(`includeWideInAllocation`/`includeTrioInAllocation`)
 *    - **ワイド・三連複の候補合計が0件**(boss訂正2: 複勝候補の件数は含めない。複勝が0件でも
 *      組合せ候補が1件以上あれば混在経路に入る)
 * 5. 非該当なら `buildMixedCandidates` + `allocateGeneralBets` で実際に混在配分を計算する
 *    (`kind:"mixed"`)。
 *
 * これにより「複勝のみの挙動」の定義が1箇所(`buildRaceAllocation`)に保たれる(AC2)。
 *
 * ## クラッシュ耐性(AC17)
 *
 * `allocateGeneralBets` は契約違反(候補の構造・数値異常、topFinishCount異常)を
 * throwで止める設計(`combo-bet-allocation.ts:59-66`)。`mixed-candidates.ts` の
 * `buildPlaceCandidates` は `placeOddsMin===null || ev===null` のnullチェックしか行わず、
 * `placeOddsMin<=0`・`ev=NaN`・`umaban`非有限は弾かない(素通りしてAllocationCandidateへ
 * 混入しうる)。呼び出し元(`BatchAnalysisView.tsx`)は render 内 IIFE でこの合成関数を呼ぶが、
 * リポジトリに React error boundary は1つも無い(grep 0件)。したがって本モジュール内で
 * `allocateGeneralBets` の呼び出しを try/catch で保護し、例外を`kind:"invalid"`という
 * 判別可能な状態へ変換する(呼び出し前に`validateCandidates`と同じ数値検証を複製すると
 * 二重定義になり将来ズレるリスクがあるため、`allocateGeneralBets`自身の門番に判定を委ね、
 * 本モジュールは例外の受け皿だけを持つ設計にした)。これにより異常なレース1件だけが
 * `kind:"invalid"`として判別可能になり、他レースの計算・画面全体には波及しない
 * (各レースは独立した関数呼び出しであるため)。
 *
 * ## greedySteps が構成比を左右する事実(AC22・Issue #36)
 *
 * `allocateGeneralBets` の貪欲逐次配分は `config.greedySteps`(既定値は
 * `DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps`。`allocation-primitives.ts`の
 * `DEFAULT_GREEDY_STEPS`)刻みで最適化する。**この刻み幅が券種構成比(複勝/ワイド/三連複への
 * 金額配分の割合)を左右することが実測で確認されている。**
 *
 * **再現可能な計測: `pnpm tsx scripts/bench-mixed-allocation.ts`**(ネットワークに出ない。
 * `docs/investigations/combo-odds-real-fetch/central-on.json` の保存済み実オッズを入力にする)。
 * 数値をこのJSDocへ直接書いていたところ、code-reviewer指摘(2026-08-13)により**再現しない
 * 具体例(「資金500万でも0円」)がそのまま書かれていたことが判明した**(オーケストレーターが
 * 別条件〈α平坦化した合成確率〉での計測を無条件の事実として伝えたことが原因。実データでは
 * 再現しない。この欠陥クラス「検証手段のない数値をコードに書く」の再発防止として、以後は
 * 数値そのものではなくスクリプトを参照する)。
 *
 * 計測条件(中央16頭・実オッズ・`runAnalysis` を `analyze:null` で実行した実prior・λ=0.5)での
 * 実行結果の要旨(2026-08-13時点。スクリプトを実行して自分の手元で確認すること):
 * - 総額はgreedySteps(既定1000/400)でほとんど変わらない
 * - **点数**(betCount)と**券種別の構成比**は大きく変わる(点数は概ね1/3程度に、三連複の
 *   取り分は概ね1/3程度に減る。既定1000に対し400を試した場合)
 * - 具体的な数値・割合はスクリプトの出力(実行環境・実データ更新により変動しうる)を参照し、
 *   この場に固定の数字を書かない
 *
 * 本タスク(第4段)では `greedySteps` の値・アルゴリズムを一切変更しない(値変更・チューニングは
 * Issue #36のスコープ)。本モジュールは常に `DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps`
 * をそのまま使う。
 */

import {
  allocateGeneralBets,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type EvConfig,
  type GeneralBetAllocation,
  type GeneralBetAllocationConfig,
  type GeneralBetAllocationResult,
  type JointModelHorse,
} from "@keiba/core/ev/combo-bet-allocation";

import {
  buildMixedCandidates,
  type ComboCandidateDiagnosticsView,
  type MixedCandidateBuildInput,
  type MixedCandidateDiagnostics,
  type PlaceCandidateDiagnostics,
} from "./mixed-candidates.js";
import {
  buildRaceAllocation,
  isBetAllocationUnset,
  placeBetUnavailableMessage,
  type BetAllocationSettings,
  type RaceAllocationView,
} from "./bet-allocation-view.js";

/**
 * 混在配分の合成に必要な設定(既存の複勝配分3項目 `BetAllocationSettings` に、
 * EV閾値統一〈D-4〉・券種選択〈D-1〉の4項目を加えた形)。
 */
export interface MixedAllocationSettings extends BetAllocationSettings {
  /** EVプラス判定の閾値(`AppSettings.evThreshold`)。ワイド・三連複にも同じ値を適用する(D-4)。 */
  readonly evThreshold: number;
  /** ワイド・三連複のオッズを取得するか(`AppSettings.includeComboOdds`)。 */
  readonly includeComboOdds: boolean;
  /** ワイドを配分対象に含めるか(`AppSettings.includeWideInAllocation`)。 */
  readonly includeWideInAllocation: boolean;
  /** 三連複を配分対象に含めるか(`AppSettings.includeTrioInAllocation`)。 */
  readonly includeTrioInAllocation: boolean;
}

/**
 * 混在配分が異常な入力により計算不能だったことを表す(AC17)。`message` は開発者向けの
 * 診断情報(`allocateGeneralBets` が投げた例外のメッセージ)であり、ユーザー向け文言の生成は
 * 表示側(`BatchAnalysisView.tsx`)の責務とする(仕様「見送り理由の文言はcoreが持つ」と同じ
 * 「文言は呼び出し側で組み立てる」流儀は本モジュールでは採らない。異常系のため専用の一言注記を
 * 表示側で出す)。
 */
export interface MixedRaceAllocationInvalid {
  readonly kind: "invalid";
  readonly message: string;
}

/**
 * 混在配分(D-2フォールバック非該当・実際に `buildMixedCandidates` + `allocateGeneralBets` を
 * 実行した)結果。
 */
export interface MixedRaceAllocationComputed {
  readonly kind: "mixed";
  /** `allocateGeneralBets` の結果(券種混在の配分)。 */
  readonly result: GeneralBetAllocationResult;
  /** 上位何着まで的中判定に使ったか(常に3。`buildMixedCandidates`のJSDoc参照)。 */
  readonly topFinishCount: number;
  /** 候補ビルドの診断値(券種ごと)。表示側が券種別内訳・判定不能件数・頭数不可注記に使う。 */
  readonly diagnostics: MixedCandidateDiagnostics;
}

/**
 * 混在配分ビューの判別共用体。
 * - `RaceAllocationView` の4種(`unset`/`yoso`/`unavailable`/`computed`)は、
 *   D-2フォールバック規則(またはunset/yosoのレース全体ゲート)に該当したときの状態で、
 *   既存 `buildRaceAllocation` の戻り値を**そのまま**返す(AC2: 非破壊性を機械的に保証)。
 * - `mixed`: 実際に券種横断で最適化した結果。
 * - `invalid`: `allocateGeneralBets` が契約違反を検知しthrowした(AC17)。
 */
export type MixedRaceAllocationView =
  | RaceAllocationView
  | MixedRaceAllocationComputed
  | MixedRaceAllocationInvalid;

/** D-1: 設定(2つのboolean)から `MixedCandidateBuildOptions.betTypes` を組み立てる。複勝は常に含める。 */
function resolveMixedBetTypes(settings: MixedAllocationSettings): ("place" | "wide" | "trio")[] {
  const betTypes: ("place" | "wide" | "trio")[] = ["place"];
  if (settings.includeWideInAllocation) {
    betTypes.push("wide");
  }
  if (settings.includeTrioInAllocation) {
    betTypes.push("trio");
  }
  return betTypes;
}

/**
 * D-2フォールバック規則の条件①②(候補構築より前に判定できる、設定だけで決まる条件)。
 * 条件③(ワイド・三連複の候補合計0件)は候補構築後でないと判定できないため別途行う。
 */
function shouldFallbackBeforeBuildingCandidates(settings: MixedAllocationSettings): boolean {
  if (!settings.includeComboOdds) {
    return true;
  }
  if (!settings.includeWideInAllocation && !settings.includeTrioInAllocation) {
    return true;
  }
  return false;
}

/**
 * 券種横断(複勝・ワイド・3連複)の馬券配分ビューを合成する。
 *
 * @param race レース情報(`AnalysisResult` をそのまま渡せる。`MixedCandidateBuildInput` と
 *   同じ構造的最小型)
 * @param settings 配分設定(複勝3項目 + EV閾値 + 券種取得/選択の4項目)
 */
export function buildMixedRaceAllocation(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
): MixedRaceAllocationView {
  // 1. unset(レース全体のゲート。既存どおり)。
  if (isBetAllocationUnset(settings)) {
    return buildRaceAllocation(race, settings);
  }
  // 2. yoso(レース全体のゲート。既存どおり)。
  if (race.oddsStatus === "yoso") {
    return buildRaceAllocation(race, settings);
  }
  // 3. 頭数不可はここで判定しない(buildMixedCandidatesに委ねる。反証B/反証C)。

  // 4. D-2条件①②(候補構築前に判定できる部分)。
  if (shouldFallbackBeforeBuildingCandidates(settings)) {
    return buildRaceAllocation(race, settings);
  }

  const betTypes = resolveMixedBetTypes(settings);
  const evConfig: EvConfig = { threshold: settings.evThreshold };
  const mixed = buildMixedCandidates(race, { betTypes, evConfig });

  // 4. D-2条件③(訂正2: ワイド・三連複の候補合計のみを見る。複勝候補の件数は含めない)。
  const comboCandidateCount = mixed.candidates.filter((c) => c.umabans.length >= 2).length;
  if (comboCandidateCount === 0) {
    return buildRaceAllocation(race, settings);
  }

  // 5. 混在配分を実際に計算する。
  const horses: JointModelHorse[] = race.rows.map((r) => ({
    umaban: r.umaban,
    placeProb: r.adjustedProb,
  }));
  const config: GeneralBetAllocationConfig = {
    bankroll: settings.bankroll,
    perRaceCap: settings.perRaceCap,
    kellyFraction: settings.kellyFraction,
    betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
    // greedySteps・candidateCapは本タスクのスコープ外(AC22・Issue #36)。既定値をそのまま使う。
    greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
    candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
  };

  try {
    const result = allocateGeneralBets(horses, mixed.topFinishCount, mixed.candidates, config);
    return {
      kind: "mixed",
      result,
      topFinishCount: mixed.topFinishCount,
      diagnostics: mixed.diagnostics,
    };
  } catch (e) {
    // AC17: allocateGeneralBetsのthrow(契約違反。異常な数値を含む候補等)を捕捉し、
    // このレースだけを判別可能な状態にする(画面全体・他レースには波及させない)。
    return { kind: "invalid", message: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================
// 表示データの導出(機能D-2c第4段後半・AC10〜AC16)
//
// buildMixedRaceAllocation(合成ロジック本体)は変更せず、kind="mixed"のときだけ
// 追加の表示データ(display)を持たせる薄いラッパー(buildMixedAllocationDisplay)を
// 別関数として用意する。unset/yoso/unavailable/computed/invalidの5状態は
// buildMixedRaceAllocationの結果をそのまま通す(表示ロジックの追加が合成ロジックの
// 非破壊性〈AC2〉に影響しないようにする)。
// ============================================================================

/** 券種別の内訳(金額・点数)。AC10: 3つの合計は必ずtotalStakeと一致する(同じ配列から集計するため)。 */
export interface MixedAllocationBreakdown {
  readonly place: { readonly stake: number; readonly count: number };
  readonly wide: { readonly stake: number; readonly count: number };
  readonly trio: { readonly stake: number; readonly count: number };
}

/**
 * `result.allocations` を `umabans.length`(1=複勝/2=ワイド/3=三連複)で3群に分け、
 * 金額合計・点数(`stake>0`の件数)を求める(AC10・AC13の点数)。
 */
export function buildMixedAllocationBreakdown(
  result: GeneralBetAllocationResult,
): MixedAllocationBreakdown {
  const groupOf = (n: number): { stake: number; count: number } => {
    const inGroup = result.allocations.filter((a) => a.umabans.length === n);
    return {
      stake: inGroup.reduce((sum, a) => sum + a.stake, 0),
      count: inGroup.filter((a) => a.stake > 0).length,
    };
  };
  return { place: groupOf(1), wide: groupOf(2), trio: groupOf(3) };
}

/**
 * 馬番配列を辞書順(要素ごとの昇順、長さが異なれば短い方を先)で比較する
 * (`combo-bet-allocation.ts`の`compareUmabansLex`と同じロジックだが、exportされていない
 * private関数のため、券種非依存モジュール間の依存を増やさない目的で独立して持つ
 * 〈`mixed-candidates.ts`の`kCombinationsOfUmabans`と同じ前例〉)。
 */
function compareUmabansLex(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

/**
 * `stake>0`の買い目を**全件**、`stake`降順(同額は馬番配列の辞書順)で並べる(AC13)。
 * 表示件数の打ち切り(top-N・折りたたみ)は行わない(#15のスコープ。boss指示)。
 */
export function sortMixedAllocationsForDisplay(
  result: GeneralBetAllocationResult,
): readonly GeneralBetAllocation[] {
  return result.allocations
    .filter((a) => a.stake > 0)
    .slice()
    .sort((a, b) => {
      if (a.stake !== b.stake) {
        return b.stake - a.stake;
      }
      return compareUmabansLex(a.umabans, b.umabans);
    });
}

/** `umabans.length`から券種の日本語ラベルを返す(表示用。1=複勝/2=ワイド/3=三連複)。 */
export function mixedBetTypeLabel(umabansLength: number): "複勝" | "ワイド" | "三連複" {
  if (umabansLength === 1) {
    return "複勝";
  }
  if (umabansLength === 2) {
    return "ワイド";
  }
  return "三連複";
}

/** 券種横断で判定不能(unjudged)だった件数(AC15)。 */
export interface MixedUnjudgedCounts {
  readonly oddsMissingCount: number;
  readonly oddsUnfetchedCount: number;
  readonly oddsMalformedCount: number;
}

/**
 * 券種横断(複勝・ワイド・3連複)で判定不能だった件数を合算する(AC15)。
 * `kind!=="built"`(`not-requested`。ユーザーが対象外にした券種)は判定不能ではなく
 * 「対象外」なので0として扱う(判定不能〈unjudged〉と対象外〈not-requested〉を混同しない)。
 * 複勝は`unjudged.oddsMissingCount`のみ持つ(`oddsUnfetchedCount`/`oddsMalformedCount`は
 * ワイド・3連複固有の概念のため複勝には存在しない)。
 */
export function aggregateUnjudgedCounts(diagnostics: MixedCandidateDiagnostics): MixedUnjudgedCounts {
  const placeMissing =
    diagnostics.place.kind === "judged" ? diagnostics.place.unjudged.oddsMissingCount : 0;
  const wideUnjudged = diagnostics.wide.kind === "built" ? diagnostics.wide.build.unjudged : null;
  const trioUnjudged = diagnostics.trio.kind === "built" ? diagnostics.trio.build.unjudged : null;
  return {
    oddsMissingCount:
      placeMissing + (wideUnjudged?.oddsMissingCount ?? 0) + (trioUnjudged?.oddsMissingCount ?? 0),
    oddsUnfetchedCount: (wideUnjudged?.oddsUnfetchedCount ?? 0) + (trioUnjudged?.oddsUnfetchedCount ?? 0),
    oddsMalformedCount: (wideUnjudged?.oddsMalformedCount ?? 0) + (trioUnjudged?.oddsMalformedCount ?? 0),
  };
}

/** `MixedUnjudgedCounts`の合計件数(0なら表示側は注記を出さない。AC15)。 */
export function totalUnjudgedCount(counts: MixedUnjudgedCounts): number {
  return counts.oddsMissingCount + counts.oddsUnfetchedCount + counts.oddsMalformedCount;
}

/**
 * 判定不能件数の注記文言(AC15)。0件の区分は文言から省く(「オッズ欠損0件」のような
 * ノイズを出さない)。呼び出し側は`totalUnjudgedCount(counts) > 0`のときだけこの文言を表示する
 * (0件なら注記自体を出さない、というAC15の要件は表示側〈本関数の外〉の責務とする)。
 */
export function formatUnjudgedNote(counts: MixedUnjudgedCounts): string {
  const parts: string[] = [];
  if (counts.oddsMissingCount > 0) {
    parts.push(`オッズ欠損${counts.oddsMissingCount}件`);
  }
  if (counts.oddsUnfetchedCount > 0) {
    parts.push(`未取得${counts.oddsUnfetchedCount}件`);
  }
  if (counts.oddsMalformedCount > 0) {
    parts.push(`不正値${counts.oddsMalformedCount}件`);
  }
  return `判定できなかった買い目があります(${parts.join("・")})。`;
}

/**
 * ワイド・3連複それぞれの状態を、断定を避けつつ正確に説明する一言注記(AC16)。
 * `{}`(`fieldPresence:"empty"`)を単独で「発売なし」と断定せず、`comboOddsState`
 * (取得結果の最終状態)で原因を判別する(`mixed-candidates.ts`のJSDoc「原因を正しく判別する
 * 唯一の手段は`comboOddsState`」を踏襲する)。
 */
export function comboBetTypeNote(diag: ComboCandidateDiagnosticsView): string | null {
  if (diag.kind !== "built") {
    // "not-requested"(ユーザーが対象外にした)・"yoso"(このkindがmixed表示に現れることは
    // ゲート順序上ない。念のため)はいずれも注記不要。
    return null;
  }
  switch (diag.comboOddsState) {
    case "available":
      return diag.build.judged.positiveCount > 0
        ? null
        : "オッズは取得できましたが、EVプラスの買い目がありませんでした。";
    case "unavailable":
      return "このレースでは発売されていません(取得結果より判定)。";
    case "failed":
      return "オッズの取得に失敗しました(発売されていないとは限りません)。";
    case "unknown":
      return "オッズを取得していません(設定変更後に再分析すると反映されます)。";
  }
}

/**
 * 頭数不可(4以下・5〜7)で複勝が対象外のときの一言注記(AC3改訂)。既存の
 * `placeBetUnavailableMessage`をそのまま使い、新しい文言を作らない。
 * `reason:"yoso"`はゲート順序上、混在経路(`kind:"mixed"`)には到達しない値だが、型上は
 * `PlaceCandidateUnavailableReason`に含まれるため、安全のため明示的にnullへ倒す。
 */
export function placeUnavailableNoteForMixed(place: PlaceCandidateDiagnostics): string | null {
  if (place.kind !== "unavailable") {
    return null;
  }
  if (place.reason === "yoso") {
    return null;
  }
  return placeBetUnavailableMessage(place.reason);
}

/**
 * D-2と同じ`buildRaceAllocation`を使い、「複勝のみで計算した場合の提案額」を求める(AC11)。
 * 混在時の複勝配分額(`breakdown.place.stake`)とは**別々の値**であり、比較対象がずれないよう
 * 同じ`race`/`settings`(の`BetAllocationSettings`部分)を渡す(D-2の単一定義の原則と同じ)。
 * `kind:"computed"`以外(このレースが既にunset/yoso/headcount不可を通過済みのため理論上
 * `unavailable`のみ発生しうる。5〜7頭・4頭以下で複勝自体が対象外の場合)は`null`
 * (「複勝のみなら提案不能」を意味する。0円〈見送り〉とは異なる状態として区別する)。
 */
export function resolvePlaceOnlyStake(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
): number | null {
  const view = buildRaceAllocation(race, settings);
  return view.kind === "computed" ? view.result.totalStake : null;
}

/** #35の較正注記(AC14)。組合せ券種のEVが過大評価であること・較正未実施であることを明記する。 */
export const COMBO_EV_CALIBRATION_NOTE =
  "ワイド・三連複など組合せ券種のEVは、推定確率の誤差が組み合わせ人数ぶん増幅されるため過大評価になりやすいことが実測でわかっています(較正は未実施・Issue #35)。表示額を鵜呑みにせず、資金管理は慎重に行ってください。";

/**
 * `kind:"invalid"`のユーザー向け表示文言(AC17)。`MixedRaceAllocationInvalid.message`は
 * core由来の生の例外メッセージ(開発者向け)であり、そのまま画面に出さない。
 */
export const MIXED_ALLOCATION_INVALID_MESSAGE =
  "このレースのデータに数値の異常(オッズや馬番の不正な値)が含まれているため、券種横断の配分を計算できませんでした。";

/** `kind:"mixed"`のときだけ追加で持つ表示データ(AC10〜AC16の導出結果一式)。 */
export interface MixedAllocationDisplay {
  /** 券種別内訳(AC10・AC13の点数)。 */
  readonly breakdown: MixedAllocationBreakdown;
  /** stake>0の買い目全件(AC13。stake降順・同額は馬番配列の辞書順)。 */
  readonly sortedAllocations: readonly GeneralBetAllocation[];
  /** 券種横断の判定不能件数(AC15)。 */
  readonly unjudged: MixedUnjudgedCounts;
  /** ワイドの状態注記(AC16。無ければnull)。 */
  readonly wideNote: string | null;
  /** 3連複の状態注記(AC16。無ければnull)。 */
  readonly trioNote: string | null;
  /** 頭数不可で複勝が対象外のときの注記(AC3改訂。無ければnull)。 */
  readonly placeUnavailableNote: string | null;
  /** 複勝のみで計算した場合の提案額(AC11。算出不能ならnull)。 */
  readonly placeOnlyStake: number | null;
}

/** `kind:"mixed"`のとき`display`フィールドを追加で持つビュー。 */
export type MixedRaceAllocationComputedWithDisplay = MixedRaceAllocationComputed & {
  readonly display: MixedAllocationDisplay;
};

/**
 * 表示データまで導出したビューの判別共用体。`kind:"mixed"`のときだけ`display`
 * フィールドが追加される。それ以外の4状態(`unset`/`yoso`/`unavailable`/`computed`)と
 * `invalid`は`buildMixedRaceAllocation`の結果をそのまま通す。
 */
export type MixedRaceAllocationDisplayView =
  | RaceAllocationView
  | MixedRaceAllocationInvalid
  | MixedRaceAllocationComputedWithDisplay;

/**
 * 券種横断の馬券配分ビューを、表示に必要な追加データ(AC10〜AC16)まで含めて合成する。
 * `buildMixedRaceAllocation`(合成ロジック本体)自体は変更せず、`kind:"mixed"`のときだけ
 * 追加計算(内訳・並べ替え・判定不能集計・状態注記・複勝のみ比較額)を行う薄いラッパー。
 */
export function buildMixedAllocationDisplay(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
): MixedRaceAllocationDisplayView {
  const view = buildMixedRaceAllocation(race, settings);
  if (view.kind !== "mixed") {
    return view;
  }
  const display: MixedAllocationDisplay = {
    breakdown: buildMixedAllocationBreakdown(view.result),
    sortedAllocations: sortMixedAllocationsForDisplay(view.result),
    unjudged: aggregateUnjudgedCounts(view.diagnostics),
    wideNote: comboBetTypeNote(view.diagnostics.wide),
    trioNote: comboBetTypeNote(view.diagnostics.trio),
    placeUnavailableNote: placeUnavailableNoteForMixed(view.diagnostics.place),
    placeOnlyStake: resolvePlaceOnlyStake(race, settings),
  };
  return { ...view, display };
}
