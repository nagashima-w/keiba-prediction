/**
 * mixed-race-allocation — 券種横断(複勝・ワイド・三連複)の馬券配分の合成ロジック本体(計算)。
 *
 * Issue #57 で `renderer/mixed-allocation-view.ts` から計算部分(本ファイル)を分離した
 * (挙動不変・移動のみ)。renderer・main の両方から呼べるようにする(#54参照)。
 *
 * 表示データの導出(`MixedAllocationBreakdown`・`sortMixedAllocationsForDisplay`・
 * `splitAllocationsForDisplay`・`MIXED_ALLOCATION_VISIBLE_LIMIT`・`buildMixedAllocationDisplay`等)は
 * `renderer/mixed-allocation-view.ts` に残る(表示/計算の分割線。Issue #57)。
 */

import {
  allocateGeneralBets,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type EvConfig,
  type GeneralBetAllocationConfig,
  type GeneralBetAllocationResult,
  type JointModelHorse,
  type SkipReasonCode,
} from "@keiba/core/ev/combo-bet-allocation";

import {
  buildMixedCandidates,
  type ComboCandidateDiagnosticsView,
  type MixedCandidateBuildInput,
  type MixedCandidateDiagnostics,
} from "./mixed-candidates.js";
import {
  buildRaceAllocation,
  isBetAllocationUnset,
  type BetAllocationSettings,
  type PlaceBetUnavailableReason,
  type RaceAllocationView,
} from "./race-allocation.js";

/**
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
 * - **総額への影響は条件によって幅がある**(小さい場合〈概ね1%未満〉と1割を超える場合の
 *   両方が実測で出た。「ほとんど変わらない」と断定した旧版の記述は誤りだった。boss指摘
 *   2026-08-13: 3シナリオ中1つで+13.7%〈84,800円→96,400円〉となり、単純な断定では
 *   なかったことが判明した)。ただし**点数・券種別の構成比の変化に比べれば総額側の変化は
 *   小さい**
 * - **点数**(betCount)と**券種別の構成比**は大きく変わる(点数は概ね1/3程度に、三連複の
 *   取り分は概ね1/3程度に減る。既定1000に対し400を試した場合)
 * - 具体的な数値・割合はスクリプトの出力(実行環境・実データ更新により変動しうる)を参照し、
 *   この場に固定の数字を書かない
 *
 * 本タスク(第4段)では `greedySteps` の値・アルゴリズムを一切変更しない(値変更・チューニングは
 * Issue #36のスコープ)。本モジュールは常に `DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps`
 * をそのまま使う。
 */

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
 * D-2フォールバック規則の条件①(候補構築より前に判定できる)。
 * `includeComboOdds` がOFF(ワイド・3連複のオッズ自体を取得していない)。
 */
function isComboOddsNotRequested(settings: MixedAllocationSettings): boolean {
  return !settings.includeComboOdds;
}

/**
 * D-2フォールバック規則の条件②(候補構築より前に判定できる)。
 * ワイド・3連複とも配分対象からOFF(オッズは取得していても配分には使わない設定)。
 */
function isComboBetTypesOff(settings: MixedAllocationSettings): boolean {
  return !settings.includeWideInAllocation && !settings.includeTrioInAllocation;
}

/**
 * Issue #58(#56-2)。見送り理由を「日本語文言」ではなく「文言を持たないコード」の
 * タプルとして復元するための型群。#31(判定不能と判定結果を混ぜない)の踏襲——
 * 各フィールドの `null` は「判定不能」ではなく「その層の判定に到達していない」ことを表す。
 * 到達したか否かは `route` から一意に決まる(下記JSDoc参照)。
 */

/**
 * 到達状態(層1)。`MixedRaceAllocationView` の判別子とは別に持つ理由は、
 * `"place-only"` が既存の判別共用体には存在しない状態(D-2フォールバックにより
 * `RaceAllocationView` の `kind:"computed"` へ潰れる)であるため。既存の
 * `MixedRaceAllocationView` は一切変更しない(判断2)。
 */
export type AllocationRouteCode =
  | "unset"
  | "yoso"
  | "unavailable"
  | "place-only"
  | "mixed"
  | "invalid";

/** D-2フォールバックの分岐理由(どの条件で複勝のみに落ちたか)。 */
export type PlaceOnlyFallbackReason =
  | "combo-odds-not-requested" // ① includeComboOdds=false
  | "combo-bet-types-off" // ② ワイド・3連複とも配分対象OFF
  | "no-combo-candidates"; // ③ ワイド・3連複の候補合計が0件

/**
 * 券種ごとの組合せオッズ可用性。`ComboCandidateDiagnosticsView`(診断値)からの純写像で、
 * 新しい判定を足さない(`comboOddsAvailabilityFromDiagnostics`参照)。
 *
 * 注意: `empty`(空オブジェクト)の原因(市場側の発売なし/取得失敗)は`comboOddsState`
 * でしか判別できないと`mixed-candidates.ts`のJSDocが明記している。本Issue #58では
 * 保存対象に含めない(`empty`は「空だった」という事実だけを表し、原因は判定しない。
 * #31準拠——原因不明を原因ラベルにしない)。#59で必要になれば別途追加する。
 */
export type ComboOddsAvailabilityCode = "not-requested" | "yoso" | "unfetched" | "empty" | "present";

/**
 * 見送り理由(判定不能ではなく判定結果)をコードのタプルとして復元するための型。
 * 日本語文言(`skipReason`等)を経由せず、この4フィールドだけから状態を機械的に
 * 区別できることをテストで固定する(`allocation-outcome-codes.test.ts`のAC1)。
 *
 * 各フィールドの`null`の意味(「未到達」であって「不明」ではない):
 * - `unavailableReason`: `route==="unavailable"` のときのみ非null。
 * - `fallbackReason`: D-2フォールバック分岐(①②③のいずれか)を通ったときのみ非null
 *   (`route`が`"unavailable"`でも非nullになりうる。D-2フォールバックが
 *   `buildRaceAllocation`を呼んだ結果、頭数不可で`kind:"unavailable"`になる場合)。
 * - `skipReasonCode`: 層2。coreに到達し(`route`が`"place-only"`または`"mixed"`)、
 *   かつ`isSkip`のときのみ非null。
 * - `comboOdds`: `buildMixedCandidates`を実行したときのみ非null(実行していない=
 *   判定不能ではなく、まだその判定に到達していないことをnullで表す)。
 *   **`route==="invalid"`でも非nullになりうる**: `buildMixedCandidates`は
 *   `allocateGeneralBets`の呼び出し(throwしうる)より前に実行済みであり、
 *   「オッズが取得できていたか」という事実は`allocateGeneralBets`の成否と独立に
 *   既に判定済みだから(裁定2026年。#31が禁じる「判定済みを未判定に潰す」方向を避ける)。
 *
 * `(route, skipReasonCode)`だけで「配分あり」と「core未到達」が区別できる
 * (`allocation-outcome-codes.test.ts`の不変条件テストで固定):
 * - `route`が`"unset"`/`"yoso"`/`"unavailable"`/`"invalid"`のいずれかならcore未到達。
 * - `route`が`"place-only"`/`"mixed"`で`skipReasonCode===null`なら配分あり。
 */
export interface AllocationOutcomeCodes {
  readonly route: AllocationRouteCode;
  readonly unavailableReason: PlaceBetUnavailableReason | null;
  readonly fallbackReason: PlaceOnlyFallbackReason | null;
  readonly skipReasonCode: SkipReasonCode | null;
  readonly comboOdds: { readonly wide: ComboOddsAvailabilityCode; readonly trio: ComboOddsAvailabilityCode } | null;
}

/**
 * `ComboCandidateDiagnosticsView`(mixed-candidates.tsの診断値)から
 * `ComboOddsAvailabilityCode`への純写像。新しい判定を発明しない
 * (判別子と`fieldPresence`をそのまま読み替えるだけ)。
 */
export function comboOddsAvailabilityFromDiagnostics(
  diagnostics: ComboCandidateDiagnosticsView,
): ComboOddsAvailabilityCode {
  switch (diagnostics.kind) {
    case "not-requested":
      return "not-requested";
    case "yoso":
      return "yoso";
    case "built":
      switch (diagnostics.fieldPresence) {
        case "absent":
          return "unfetched";
        case "empty":
          return "empty";
        case "present":
          return "present";
      }
  }
}

/** `MixedRaceAllocationView`とコード付き到達状態(`AllocationOutcomeCodes`)の組。 */
export interface MixedRaceAllocationOutcome {
  readonly view: MixedRaceAllocationView;
  readonly outcome: AllocationOutcomeCodes;
}

/** 判定に到達していない(null)ことを表す共通の空`AllocationOutcomeCodes`片。 */
function unreachedOutcome(route: AllocationRouteCode): AllocationOutcomeCodes {
  return { route, unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOdds: null };
}

/**
 * D-2フォールバック(①②③のいずれか)に該当したときの view・outcome を組み立てる。
 * `buildRaceAllocation`をそのまま呼び、その戻り値(`kind`)から`route`
 * (`"unavailable"`または`"place-only"`)を判定する。
 *
 * unset/yoso(`kind`が`"unset"`/`"yoso"`)がここで返ることは無い: 呼び出し元
 * (`buildMixedRaceAllocationWithOutcome`)が本関数を呼ぶ前に同一条件
 * (`isBetAllocationUnset`・`oddsStatus==="yoso"`)を既にfalseと確認済みであり、
 * `buildRaceAllocation`は同じ条件を先頭で再評価するだけなので結果は変わらない。
 */
function buildPlaceOnlyFallbackOutcome(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
  fallbackReason: PlaceOnlyFallbackReason,
  comboOdds: AllocationOutcomeCodes["comboOdds"],
): MixedRaceAllocationOutcome {
  const view = buildRaceAllocation(race, settings);
  if (view.kind === "unavailable") {
    return {
      view,
      outcome: { route: "unavailable", unavailableReason: view.reason, fallbackReason, skipReasonCode: null, comboOdds },
    };
  }
  if (view.kind === "computed") {
    return {
      view,
      outcome: {
        route: "place-only",
        unavailableReason: null,
        fallbackReason,
        skipReasonCode: view.result.isSkip ? view.result.skipReasonCode : null,
        comboOdds,
      },
    };
  }
  // 契約違反(呼び出し元の前提が崩れている場合の防御)。上記JSDoc参照。
  throw new Error(
    `buildPlaceOnlyFallbackOutcome: 呼び出し元が事前にunset/yosoを排除したはずなのに` +
      `buildRaceAllocationがkind="${view.kind}"を返した(前提が崩れている)`,
  );
}

/**
 * 券種横断(複勝・ワイド・3連複)の馬券配分ビューを、コード付き到達状態
 * (`AllocationOutcomeCodes`)とともに合成する(Issue #58)。
 *
 * `view`の判定ロジック(ゲート順序)は`buildMixedRaceAllocation`(旧実装)と完全に同一。
 * 本関数はその判定と同時に、通過した経路をコードとして記録する(二重定義を避けるため、
 * 判定ロジックはこの関数1箇所だけに存在し、`buildMixedRaceAllocation`は本関数を呼んで
 * `.view`だけを返す薄いラッパーになる)。
 *
 * @param race レース情報(`AnalysisResult` をそのまま渡せる。`MixedCandidateBuildInput` と
 *   同じ構造的最小型)
 * @param settings 配分設定(複勝3項目 + EV閾値 + 券種取得/選択の4項目)
 */
export function buildMixedRaceAllocationWithOutcome(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
): MixedRaceAllocationOutcome {
  // 1. unset(レース全体のゲート。既存どおり)。
  if (isBetAllocationUnset(settings)) {
    return { view: buildRaceAllocation(race, settings), outcome: unreachedOutcome("unset") };
  }
  // 2. yoso(レース全体のゲート。既存どおり)。
  if (race.oddsStatus === "yoso") {
    return { view: buildRaceAllocation(race, settings), outcome: unreachedOutcome("yoso") };
  }
  // 3. 頭数不可はここで判定しない(buildMixedCandidatesに委ねる。反証B/反証C)。

  // 4. D-2条件①②(候補構築前に判定できる部分。既存の短絡順序=①→②を保つ)。
  if (isComboOddsNotRequested(settings)) {
    return buildPlaceOnlyFallbackOutcome(race, settings, "combo-odds-not-requested", null);
  }
  if (isComboBetTypesOff(settings)) {
    return buildPlaceOnlyFallbackOutcome(race, settings, "combo-bet-types-off", null);
  }

  const betTypes = resolveMixedBetTypes(settings);
  const evConfig: EvConfig = { threshold: settings.evThreshold };
  const mixed = buildMixedCandidates(race, { betTypes, evConfig });
  const comboOdds = {
    wide: comboOddsAvailabilityFromDiagnostics(mixed.diagnostics.wide),
    trio: comboOddsAvailabilityFromDiagnostics(mixed.diagnostics.trio),
  };

  // 4. D-2条件③(訂正2: ワイド・三連複の候補合計のみを見る。複勝候補の件数は含めない)。
  const comboCandidateCount = mixed.candidates.filter((c) => c.umabans.length >= 2).length;
  if (comboCandidateCount === 0) {
    return buildPlaceOnlyFallbackOutcome(race, settings, "no-combo-candidates", comboOdds);
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
      view: { kind: "mixed", result, topFinishCount: mixed.topFinishCount, diagnostics: mixed.diagnostics },
      outcome: {
        route: "mixed",
        unavailableReason: null,
        fallbackReason: null,
        skipReasonCode: result.isSkip ? result.skipReasonCode : null,
        comboOdds,
      },
    };
  } catch (e) {
    // AC17: allocateGeneralBetsのthrow(契約違反。異常な数値を含む候補等)を捕捉し、
    // このレースだけを判別可能な状態にする(画面全体・他レースには波及させない)。
    // comboOddsは非null(このtryブロックへ到達した時点でmixed.diagnosticsは算出済み。
    // AllocationOutcomeCodesのJSDoc参照)。
    return {
      view: { kind: "invalid", message: e instanceof Error ? e.message : String(e) },
      outcome: { route: "invalid", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOdds },
    };
  }
}

/**
 * 券種横断(複勝・ワイド・3連複)の馬券配分ビューを合成する。
 *
 * Issue #58で実装本体を`buildMixedRaceAllocationWithOutcome`へ移し、本関数はその`.view`だけを
 * 返す薄いラッパーになった(シグネチャ・戻り型は不変。呼び出し元の`renderer/mixed-allocation-view.ts`
 * 等に一切変更を要求しない)。
 *
 * @param race レース情報(`AnalysisResult` をそのまま渡せる。`MixedCandidateBuildInput` と
 *   同じ構造的最小型)
 * @param settings 配分設定(複勝3項目 + EV閾値 + 券種取得/選択の4項目)
 */
export function buildMixedRaceAllocation(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
): MixedRaceAllocationView {
  return buildMixedRaceAllocationWithOutcome(race, settings).view;
}
