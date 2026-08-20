/**
 * mixed-allocation-view — 券種横断(複勝・ワイド・三連複)の馬券配分の合成ロジック
 * (機能D-2c第4段・Issue #28)。
 *
 * 第1〜3段(組合せオッズを renderer まで運ぶ器・候補ビルダー `mixed-candidates.ts`・
 * 取得の有効化)を土台に、実際にユーザーへ提示する配分提案を合成する。**画面
 * (`BatchAnalysisView.tsx`)は本モジュールを呼び出すだけで、`bet-allocation-view.ts`・
 * `mixed-candidates.ts`の既存の関数・型の**契約(シグネチャ・意味論)**は破壊的に変更しない**
 * (boss メタレビュー差し戻し2026-08-13対応: 「一切変更しない」という記述が実態と食い違って
 * いた。実際には両ファイルとも第4段で追記・拡張されている)。実際の変更点:
 * - `mixed-candidates.ts`: `MixedCandidateBuildOptions.evConfig`(D-4)を新設し、
 *   `buildComboCandidatesForBetType`/`buildComboCandidates`へ引数として追加した(既存の
 *   判定順序・診断値の型は変更していない。第2段で確定した契約の範囲内の**加法的**拡張)
 * - `bet-allocation-view.ts`: `formatBetLabel`のシグネチャを`number`→
 *   `number | readonly number[]`へ拡張(既存呼び出しはそのまま動く)、`formatAllocationSummary`/
 *   `probabilitySumWarning`の引数型をそれぞれ構造的な`AllocationSummaryInput`/
 *   `ProbabilitySumWarningInput`へ広げ(ロジック不変。単一定義の原則で本モジュールから
 *   再利用するため)、`NOT_DIVERSIFIED_NOTE`をexportした。いずれも既存の呼び出し元・
 *   既存テストを壊さない後方互換な拡張であり、**単に「変更していない」わけではない**
 *
 * `BatchAnalysisView.tsx`・`mixed-candidates.ts`の判定順序・診断値の型は第2段で確定済みの
 * 契約として維持する(変更したくなったら着手前に相談、という原則は保持している)。
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
  NOT_DIVERSIFIED_NOTE,
  placeBetUnavailableMessage,
  probabilitySumWarning,
  type BetAllocationSettings,
  type RaceAllocationView,
} from "./bet-allocation-view.js";
import { formatYen } from "./verify-format.js";

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
 * 本関数自体の契約(戻り値が全件であること)は変わらない。画面(`BatchAnalysisView.tsx`)は
 * この結果をそのまま描画するのではなく、`splitAllocationsForDisplay`で上位N件+隠れ分に
 * 分割してから`split.visible`のみを常時表示し、残りは折りたたみに入れる(Issue #15再スコープ。
 * 直下の`splitAllocationsForDisplay`・`MIXED_ALLOCATION_VISIBLE_LIMIT`参照)。
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

/**
 * 混在配分の買い目一覧を画面に常時表示する上限件数(Issue #15再スコープ)。
 *
 * - **N=20はユーザー判断によるUXの目安であり、計測から導いた値ではない**(boss裁定)。
 * - **この上限の適用範囲は混在経路(本モジュール)の買い目一覧のみ。** 複勝専用経路
 *   (`BatchAnalysisView.tsx`の`renderBetAllocationBlock`)は`result.allocations.filter(
 *   stake>0).map(...)`で全件を描画しており、そもそも上限という概念自体を適用していない
 *   (以前のJSDocは「出走頭数18が構造的上限だから複勝専用経路の見た目は変わらない」と
 *   書いていたが、これは誤り。頭数18を強制するコードは存在せず、複勝専用経路の描画は
 *   常に無条件・全件であるため、頭数と無関係に不変。boss指摘2026-08-20により訂正)。
 * - **性能上の意図はない。** 折りたたみ(`<details>`)は隠れた行も含めて React が描画し
 *   DOM に載せる(表示のみを隠す)。目的は可読性(一覧が数百件になりうる)のみであり、
 *   「描画が軽くなる」効果は主張しない。
 */
export const MIXED_ALLOCATION_VISIBLE_LIMIT = 20;

/**
 * `splitAllocationsForDisplay`の戻り値。`sortedAllocations`(全件・stake降順)を
 * 上位`MIXED_ALLOCATION_VISIBLE_LIMIT`件(`visible`)と残り(`hidden`)に分割したもの。
 * `visible`と`hidden`を連結すると元の`sorted`と順序・要素ともに完全一致する(AC5)。
 */
export interface MixedAllocationSplit {
  /** 常時表示する上位件数(最大`MIXED_ALLOCATION_VISIBLE_LIMIT`件)。 */
  readonly visible: readonly GeneralBetAllocation[];
  /** 折りたたみに入る残り。 */
  readonly hidden: readonly GeneralBetAllocation[];
  /** `hidden`の件数(0なら折りたたみ自体を出さない。AC1)。 */
  readonly hiddenCount: number;
  /** `hidden`のstake合計(有限なstakeの下で成り立つ。NaN防御は本タスクのスコープ外)。 */
  readonly hiddenStake: number;
}

/**
 * `sortMixedAllocationsForDisplay`の結果(全件・stake降順)を上位N件+隠れ分に分割する。
 *
 * `sorted`は既にソート済みの配列をそのまま受け取り、独立にfilter/sortをやり直さない
 * (AC5「visible++hiddenがsortedAllocationsと完全一致」を偶然ではなく構造で保証するため。
 * boss裁定・条項4)。呼び出し元(`buildMixedAllocationDisplay`)は必ず
 * `sortMixedAllocationsForDisplay`の戻り値をそのまま渡すこと。
 *
 * `limit`は既定`MIXED_ALLOCATION_VISIBLE_LIMIT`(=20)。非有限・0以下を渡すと既定値へ
 * フォールバックする(`resolveCandidateCap`〈`combo-bet-allocation.ts`〉等、本リポジトリの
 * 既存の防御と同じ流儀)。
 *
 * 不変式(有限なstakeの下で成り立つ。`stake`がNaNの場合はこの限りではない。
 * `sortMixedAllocationsForDisplay`・`buildMixedAllocationBreakdown`が既に持つ同一の前提であり、
 * 本関数が新設する穴ではない。NaN防御は本タスクのスコープ外・到達可能性も未調査):
 * 1. `visible`のstake合計 + `hiddenStake` === 元の`GeneralBetAllocationResult.totalStake`
 * 2. `totalStake` === `buildMixedAllocationBreakdown`の`place+wide+trio`のstake合計(既存契約AC10)
 * 3. `visible.length + hiddenCount` === `place+wide+trio`のcount合計
 */
export function splitAllocationsForDisplay(
  sorted: readonly GeneralBetAllocation[],
  limit: number = MIXED_ALLOCATION_VISIBLE_LIMIT,
): MixedAllocationSplit {
  const resolvedLimit = Number.isFinite(limit) && limit > 0 ? limit : MIXED_ALLOCATION_VISIBLE_LIMIT;
  const visible = sorted.slice(0, resolvedLimit);
  const hidden = sorted.slice(resolvedLimit);
  return {
    visible,
    hidden,
    hiddenCount: hidden.length,
    hiddenStake: hidden.reduce((sum, a) => sum + a.stake, 0),
  };
}

/**
 * 折りたたみの見出し文言(AC2強化・boss裁定)。件数だけでなく金額も含めることで、
 * 読者が画面だけで「可視合計+隠れ合計=合計行」(不変式1)を検算できるようにする。
 *
 * **金額が「隠れている買い目の配分額合計」であることが文言だけで一意に読めるよう、
 * 「非表示分の」という限定語を必ず含める**(裸の「(合計◯◯円)」は合計行〈総額〉と
 * 読み違えられるため。boss指摘)。
 */
export function formatHiddenAllocationsSummary(split: MixedAllocationSplit): string {
  return `ほかに${split.hiddenCount}件(非表示分の配分額合計${formatYen(split.hiddenStake)})を表示`;
}

/** `buildHiddenAllocationsBlocks`が返す1要素の中身(折りたたみの見出し文言+中の買い目)。 */
export interface HiddenAllocationsBlock {
  /** `<summary>`に表示する文言(`formatHiddenAllocationsSummary`と同一)。 */
  readonly summaryText: string;
  /** `<details>`内の表に描画する買い目(=`split.hidden`)。 */
  readonly rows: readonly GeneralBetAllocation[];
}

/**
 * 折りたたみブロックを**0または1要素の配列**として返す(AC1強化・boss裁定)。
 *
 * `buildMixedAllocationNotices`と同型の設計: `hiddenCount===0`のとき配列長が0であること
 * 自体を値として直接テストできるようにし、呼び出し側(JSX)は`.map`で描画するだけにする。
 * JSXに`hiddenCount > 0 && <details>...`という条件式を書くと、`>`を`>=`に変える変異が
 * 入ってもどのテストも検知できない(`push`1行削除がすり抜けた事故と同じ欠陥クラス。
 * boss指摘2026-08-20)。
 */
export function buildHiddenAllocationsBlocks(
  split: MixedAllocationSplit,
): readonly HiddenAllocationsBlock[] {
  if (split.hiddenCount === 0) {
    return [];
  }
  return [{ summaryText: formatHiddenAllocationsSummary(split), rows: split.hidden }];
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

/**
 * 複勝圏内確率の合計が目標(`topFinishCount`)から外れている旨の警告(boss メタレビュー
 * 差し戻し2026-08-13対応)。
 *
 * **既存の複勝専用経路(`buildRaceAllocation`)は`buildAllocationNotices`経由で
 * `probabilitySumWarning`をnoticesに積んでいたが、混在経路はこの警告を一切出していなかった**
 * (`GeneralBetAllocationDiagnostics`に`placeProbSum`等のフィールドが無いため。boss着手前
 * ゲート裁定Q4で名指しされていた既知の非互換〈D-3への申し送り〉が、実際に本段で対応漏れに
 * なっていた)。この警告は「モデルの複勝圏内確率が壊れている」ことを可視化する**唯一の手段**
 * であり(#35が実測で示した較正ずれの条件そのもの)、組合せ券種はその誤差を増幅するため、
 * 警告が最も必要な経路で警告だけが消えるのは看過できない欠陥だった。
 *
 * `GeneralBetAllocationDiagnostics`にこのフィールドが無くても、元データ
 * (`race.rows[].adjustedProb`の合計)と目標値(`topFinishCount`。混在経路では常に3)は
 * 呼び出し元がすでに持っているため、ここで組み立てて`probabilitySumWarning`
 * (`bet-allocation-view.ts`。`ProbabilitySumWarningInput`に narrow 済み)へ渡す
 * (同じ閾値・同じ文言・同じ非有限時の非表示を再利用し、警告ロジックを複製しない)。
 *
 * `placeProbSum`は**全出走馬**(候補に限らない)のadjustedProb単純合計とする定義
 * (`BetAllocationDiagnostics.placeProbSum`のJSDoc参照)を踏襲する。
 */
export function resolveMixedProbabilitySumWarning(
  race: MixedCandidateBuildInput,
  topFinishCount: number,
): string | null {
  const placeProbSum = race.rows.reduce((sum, r) => sum + r.adjustedProb, 0);
  const placeProbSumTarget = topFinishCount;
  const placeProbSumDeviation = placeProbSum - placeProbSumTarget;
  return probabilitySumWarning({ placeProbSum, placeProbSumTarget, placeProbSumDeviation });
}

/** `kind:"mixed"`のときだけ追加で持つ表示データ(AC10〜AC16の導出結果一式)。 */
export interface MixedAllocationDisplay {
  /** 券種別内訳(AC10・AC13の点数)。 */
  readonly breakdown: MixedAllocationBreakdown;
  /** stake>0の買い目全件(AC13。stake降順・同額は馬番配列の辞書順)。 */
  readonly sortedAllocations: readonly GeneralBetAllocation[];
  /**
   * `sortedAllocations`を上位`MIXED_ALLOCATION_VISIBLE_LIMIT`件+隠れ分に分割したもの
   * (Issue #15再スコープ)。`sortedAllocations`から導出される(`splitAllocationsForDisplay`
   * 参照)。画面はこちらを描画に使い、`sortedAllocations`は`split`の導出元・全件性の契約を
   * 保つために残す。
   */
  readonly split: MixedAllocationSplit;
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
  /**
   * 複勝圏内確率の合計が目標から外れている旨の警告(既存経路と同じ閾値・文言。無ければnull。
   * boss メタレビュー差し戻し2026-08-13対応)。
   */
  readonly probabilitySumWarning: string | null;
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
 * 混在配分の注記(advisory → 確率合計警告 → notDiversified)を表示順で並べる純関数
 * (boss メタレビュー差し戻し2026-08-13対応・再差し戻し対応)。
 *
 * ## 経緯(ソース走査ガードの失敗)
 *
 * 当初、この3種の注記の組み立ては`BatchAnalysisView.tsx`内に直書きし、React描画テスト基盤が
 * 無いことを理由に「`renderMixedAllocationBlock`のソースが3つの識別子を含むこと」を検証する
 * ソース走査テストで代替しようとした。**しかしオーケストレーターが実際に`push`の1行だけを
 * 削除するミューテーションを注入したところ、そのテストは通ってしまった**
 * (`if (display.probabilitySumWarning !== null) {`という行自体は`push`を消しても残るため、
 * `toContain("display.probabilitySumWarning")`という文字列一致では検知できなかった)。
 * 「識別子がソースに書かれていること」と「値が実際に積まれること」は別の主張であり、
 * 前者のテストは後者を保証しない。
 *
 * この教訓を踏まえ、組み立てロジック自体を**値として直接テストできる純関数**として
 * `mixed-allocation-view.ts`側に切り出した(既存の複勝専用経路`buildAllocationNotices`
 * 〈`bet-allocation-view.ts`〉と同じ構造。単一定義の原則の観点でも両経路が揃う)。
 * `BatchAnalysisView.tsx`はこの関数の戻り値をそのまま描画するだけになり、
 * 「pushを1行消したら結果配列の要素数が減る」ことを`mixed-allocation-view.test.ts`が
 * 実データで直接固定できる(ソース走査に依存しない)。
 */
export function buildMixedAllocationNotices(
  result: GeneralBetAllocationResult,
  display: MixedAllocationDisplay,
): readonly string[] {
  const notices: string[] = [];
  if (result.advisory !== null) {
    notices.push(result.advisory);
  }
  if (display.probabilitySumWarning !== null) {
    notices.push(display.probabilitySumWarning);
  }
  if (result.notDiversified) {
    notices.push(NOT_DIVERSIFIED_NOTE);
  }
  return notices;
}

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
  // splitはsortedAllocationsから導出する(独立にfilter/sortし直さない。AC5を構造で保証する)。
  const sortedAllocations = sortMixedAllocationsForDisplay(view.result);
  const display: MixedAllocationDisplay = {
    breakdown: buildMixedAllocationBreakdown(view.result),
    sortedAllocations,
    split: splitAllocationsForDisplay(sortedAllocations),
    unjudged: aggregateUnjudgedCounts(view.diagnostics),
    wideNote: comboBetTypeNote(view.diagnostics.wide),
    trioNote: comboBetTypeNote(view.diagnostics.trio),
    placeUnavailableNote: placeUnavailableNoteForMixed(view.diagnostics.place),
    placeOnlyStake: resolvePlaceOnlyStake(race, settings),
    probabilitySumWarning: resolveMixedProbabilitySumWarning(race, view.topFinishCount),
  };
  return { ...view, display };
}
