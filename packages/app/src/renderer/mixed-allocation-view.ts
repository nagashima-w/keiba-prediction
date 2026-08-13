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
 * 金額配分の割合)を左右することが実測で確認されている**(例: `greedySteps=400`では三連複が
 * 資金500万でも0円、既定1000なら資金100万で三連複に入る)。本タスク(第4段)では
 * `greedySteps`の値・アルゴリズムを一切変更しない(値変更・チューニングはIssue #36のスコープ)。
 * 本モジュールは常に`DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps`をそのまま使う。
 */

import {
  allocateGeneralBets,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type EvConfig,
  type GeneralBetAllocationConfig,
  type GeneralBetAllocationResult,
  type JointModelHorse,
} from "@keiba/core/ev/combo-bet-allocation";

import {
  buildMixedCandidates,
  type MixedCandidateBuildInput,
  type MixedCandidateDiagnostics,
} from "./mixed-candidates.js";
import {
  buildRaceAllocation,
  isBetAllocationUnset,
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
