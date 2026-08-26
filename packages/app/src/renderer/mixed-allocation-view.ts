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
 * **追記(Issue #57)**: 計算本体(`buildMixedRaceAllocation`・`MixedAllocationSettings`・
 * `MixedRaceAllocationComputed`/`MixedRaceAllocationInvalid`/`MixedRaceAllocationView`と、
 * ゲート順序(AC3)・クラッシュ耐性(AC17)・greedySteps が構成比を左右する事実(AC22・Issue #36)
 * の3節)は `shared/mixed-race-allocation.ts` へ移設した(挙動不変・移動のみ。renderer・main の
 * 両方から呼べるようにするため)。本ファイルには表示データの導出
 * (`buildMixedAllocationDisplay`・内訳・並べ替え・折りたたみ分割・注記等)が残る。
 */

import type { GeneralBetAllocation, GeneralBetAllocationResult } from "@keiba/core/ev/combo-bet-allocation";

import type {
  ComboCandidateDiagnosticsView,
  MixedCandidateBuildInput,
  MixedCandidateDiagnostics,
  PlaceCandidateDiagnostics,
} from "../shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  type MixedAllocationSettings,
  type MixedRaceAllocationComputed,
  type MixedRaceAllocationInvalid,
} from "../shared/mixed-race-allocation.js";
import { buildRaceAllocation, type RaceAllocationView } from "../shared/race-allocation.js";
import {
  NOT_DIVERSIFIED_NOTE,
  placeBetUnavailableMessage,
  probabilitySumWarning,
} from "./bet-allocation-view.js";
import { formatYen } from "./verify-format.js";


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
