/**
 * mixed-allocation-view — 券種横断(複勝・ワイド・三連複)の馬券配分の表示データ導出
 * (機能D-2c第4段・Issue #28)。**合成ロジック本体は Issue #57 で `shared/mixed-race-allocation.ts`
 * へ移設した(下記「追記(Issue #57)」参照)。本ファイルの自己識別は移設後の実態に合わせて
 * 書き換えている(code-reviewer指摘: `bet-allocation-view.ts`と同じ基準で自ファイルのタイトルにも
 * 適用する)。
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

import {
  ALLOCATION_BET_TYPE_UMABAN_COUNT,
  type AllocationBetType,
  type GeneralBetAllocation,
  type GeneralBetAllocationResult,
} from "@keiba/core/ev/combo-bet-allocation";

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

/**
 * 券種別の内訳(金額・点数)。**`AllocationBetType`の全券種ぶんのキーを持つ**
 * (Issue #90・#23-B2で4群化。place/win/wide/trio)。`Object.values(breakdown)`で走査した
 * 合計は必ず`totalStake`と一致する(AC10。win行を含むフィクスチャでも成立する。
 * `mixed-allocation-view.test.ts`のAC10 describe参照)。
 *
 * キーを手で列挙せず`Record<AllocationBetType, ...>`にしている理由(D-2・boss裁定):
 * 4フィールド並記(place/win/wide/trio個別プロパティ)にすると、#24で馬連を足すとき
 * 「1箇所だけ足す事故」(`buildMixedAllocationBreakdown`の実装には足したが、この型定義・
 * 合計計算のどちらかに足し忘れる)が再発しうる。`Record`にすることで、券種の一覧は
 * `ALLOCATION_BET_TYPE_UMABAN_COUNT`(core・唯一の正)1箇所に保たれ、本ファイル・
 * `BatchAnalysisView.tsx`の両方がそれを走査するだけで新しい券種に自動追従する。
 */
export type MixedAllocationBreakdown = Record<AllocationBetType, { readonly stake: number; readonly count: number }>;

/**
 * `MixedAllocationBreakdown`(内訳表)の表示順(Issue #90・#23-B2)。**順序自体に契約上の意味は
 * 無い**(表示上の読みやすさのための並びであり、頭数の昇順=`ALLOCATION_BET_TYPE_UMABAN_COUNT`の
 * 挿入順と揃えているだけ)。`BatchAnalysisView.tsx`の内訳表はこの配列を`.map`して
 * `mixedBetTypeLabel`でラベルを引くだけにする(券種を手で行数分書かない)——**つまり
 * この配列に載っている券種は無条件に内訳表の行として描画される**(`stake===0`等の
 * 判定分岐は`BatchAnalysisView.tsx`側に一切無い)。
 *
 * **キーの集合は`ALLOCATION_BET_TYPE_UMABAN_COUNT`のキー集合と常に同一ではない**
 * (Issue #112・code-reviewer【重大】指摘・メタレビュー差し戻し2026-09-24で訂正)。
 * 旧版は「常に同一」として固定していたが、この設計だと`AllocationBetType`に新しい
 * 券種を足すたびに「表示すべきか」を考えずこの配列にも機械的に追随させる圧力を生み、
 * 実際に#112で`quinella`(馬連)を追加してしまった。app はまだ馬連の候補を一切
 * 作らない(#24-D3まで)ため、`buildMixedAllocationBreakdown`の集計は常に
 * `{stake:0,count:0}`になり、内訳表に**常に「馬連 ¥0 0点」の行が出る**という
 * 利用者から見える誤りになっていた(単勝・三連複の¥0は「妙味が無かったという
 * 判定結果」だが、馬連の¥0は「一度も評価していない」ことを判定結果のように
 * 見せてしまう——#31〈判定不能と判定結果を混ぜない〉のUI版)。
 *
 * **Issue #117(#24-D3b-2)で`quinella`の除外を解除した。** `resolveMixedBetTypes`
 * (`shared/mixed-race-allocation.ts`)が`includeQuinellaInAllocation`設定を実際に参照する
 * ようになったことで、馬連はワイド・3連複と同じ「ユーザーが設定でON/OFFできる、ONならば
 * 実際に評価される」券種になった。ワイド・3連複も、ユーザーが個別にOFFにした状態
 * (他方がONで混在経路に入る場合)では同様に「¥0 0点」を注記なしで表示する
 * (`buildMixedAllocationBreakdown`は`ALLOCATION_BET_TYPE_UMABAN_COUNT`の全キーを無条件に
 * 集計するため)。これは#112当時のような「原理的に評価不能」ではなく「ユーザーがOFFに
 * した」という到達可能な理由であり、既存のワイド・3連複と同じ扱いを受け入れる設計とする。
 * したがって馬連もこの配列に含める。
 *
 * **Issue #120(#24-E1)で`AllocationBetType`に`exacta`(馬単)が加わったが、当時appはまだ
 * 馬単の候補を一切作らなかった(オッズ配線は#122・配分接続は#125のスコープ)。**
 * #112当時の馬連と全く同じ理由で、`exacta`は当初この配列に含めていなかった。
 * **Issue #125(#24-E3b)で`resolveMixedBetTypes`が`includeExactaInAllocation`設定を
 * 実際に参照するようになり、#117での馬連と全く同じ理由で馬単の除外も解除した。**
 *
 * **Issue #128(#25-B)で`AllocationBetType`に`trifecta`(三連単)が加わったが、当時appは
 * まだ三連単の候補を一切作らなかった(オッズ配線は#137・配分接続は#139のスコープ)。**
 * #112当時の馬連・#120当時の馬単と全く同じ理由で、`trifecta`は当初この配列に含めていなかった。
 * **Issue #139(#25-E3b)で`resolveMixedBetTypes`が`includeTrifectaInAllocation`設定を
 * 実際に参照するようになり、#125での馬単と全く同じ理由で三連単の除外も解除した。**
 * 表示順は頭数の昇順(複勝→単勝→ワイド→馬連→馬単→3連複→三連単。三連単は3連複と同じ頭数
 * 〈3〉のため3連複の直後に置く)。
 */
export const MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER: readonly AllocationBetType[] = [
  "place",
  "win",
  "wide",
  "quinella",
  "exacta",
  "trio",
  "trifecta",
];

/**
 * `result.allocations` を `betType`(Issue #76: `umabans.length`からの逆算をやめ、候補自身が
 * 運ぶ値で群分けする)で券種ごとに分け、金額合計・点数(`stake>0`の件数)を求める
 * (AC10・AC13の点数)。**券種の列挙は`ALLOCATION_BET_TYPE_UMABAN_COUNT`のキーを走査する**
 * (D-2・boss裁定。券種の列挙をこのファイルで新たに増やさない)。
 */
export function buildMixedAllocationBreakdown(
  result: GeneralBetAllocationResult,
): MixedAllocationBreakdown {
  const groupOf = (betType: AllocationBetType): { stake: number; count: number } => {
    const inGroup = result.allocations.filter((a) => a.betType === betType);
    return {
      stake: inGroup.reduce((sum, a) => sum + a.stake, 0),
      count: inGroup.filter((a) => a.stake > 0).length,
    };
  };
  const betTypes = Object.keys(ALLOCATION_BET_TYPE_UMABAN_COUNT) as AllocationBetType[];
  return Object.fromEntries(betTypes.map((betType) => [betType, groupOf(betType)])) as MixedAllocationBreakdown;
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
 * 2. `totalStake` === `buildMixedAllocationBreakdown`の全券種(`Object.values(breakdown)`)の
 *    stake合計(既存契約AC10。Issue #90で4群化〈place/win/wide/trio〉した後も、
 *    `Record`全体を走査する限り成立する)
 * 3. `visible.length + hiddenCount` === 全券種のcount合計(同上の理由による)
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

/**
 * `betType`から券種の日本語ラベルを返す(表示用。Issue #76: `umabans.length`からの逆算をやめた)。
 * `betType`は閉じたユニオン(`AllocationBetType`)のため`switch`は網羅的であり、TSが
 * ケース漏れをコンパイルエラーで検出する。是正前は`if 1 / if 2 / elseすべて三連複`という
 * 構造で、想定外の頭数(例: 4)を渡すと黙って「三連複」を返していた(`code-reviewer.md`
 * 「多分岐の最後の else が残った1つを断定」の実例)。この副産物は`betType`引数化で
 * 構造的に消える(未知の`betType`はそもそも上流〈`validateCandidates`/`umabanCountOf`〉が
 * throwするため、ここに到達しない)。
 *
 * `allocation-proposal-view.ts`の`betTypeLabel`(DB由来の開いた文字列を扱う、統合しない
 * 別実装)とplace/win/wide/quinella/exacta/trio/trifectaの7つの日本語ラベルが同一であることは
 * `allocation-proposal-view.test.ts`「betTypeLabelとmixedBetTypeLabel…」でリテラル固定する。
 *
 * **かつては`"win"`・`"quinella"`・`"exacta"`・`"trifecta"`が例外だった(#91・#23-B1a、
 * #112・#24-D1、#120・#24-E1、#128・#25-B)。** 当時`betTypeLabel`はこれらのcaseを持たず
 * (`default`分岐でDB由来の生文字列をそのまま返す)、本関数との戻り値が一致しない非対称が
 * あった。`"win"`は#90(#23-B2)、`"quinella"`はIssue #117(#24-D3b-2)、`"exacta"`はIssue #125
 * (#24-E3b)、`"trifecta"`はIssue #139(#25-E3b)でそれぞれ`betTypeLabel`側にもcaseを追加し、
 * この非対称は解消済み(現在は7値すべてで両関数の戻り値が一致する)。
 *
 * **`"trifecta"`(三連単)はIssue #128(#25-B)で`AllocationBetType`に加わり、当初は本caseの
 * 追加をコンパイルを通すための最小限にとどめ、`betTypeLabel`側へのcase追加・
 * `MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`への追加は行わなかった**(app はまだ三連単の
 * 候補を一切作らなかったため。`win`/`quinella`/`exacta`が最初にそうだったのと同じ経緯)。
 * **Issue #139(#25-E3b)で配分接続が完了したため、`betTypeLabel`側のcase追加・
 * `MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`への追加のどちらも完了した。**
 *
 * **`"bracketQuinella"`(枠連)はIssue #144(#26-B)で`AllocationBetType`に加わり、本caseの
 * 追加はコンパイルを通すための最小限である**(`betTypeLabel`側へのcase追加・
 * `MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`・`ALL_MIXED_CANDIDATE_BET_TYPES`への追加は行わない。
 * 既定の配分ではappはまだ枠連の候補を作らない。オッズ取得・候補ビルダーはIssue #148〈#26-E2〉で
 * 完了し、設定の配管も#149で完了したが、配分接続・表示は#150のスコープ)。したがって
 * 上記「7値すべてで両関数の戻り値が一致する」は枠連を除く7値の話であり、枠連は
 * `betTypeLabel`側にまだcaseが無い(`quinella`等が最初にそうだったのと同じ経緯の非対称)。
 */
export function mixedBetTypeLabel(
  betType: AllocationBetType,
): "複勝" | "単勝" | "ワイド" | "馬連" | "三連複" | "馬単" | "三連単" | "枠連" {
  switch (betType) {
    case "place":
      return "複勝";
    case "win":
      return "単勝";
    case "wide":
      return "ワイド";
    case "quinella":
      return "馬連";
    case "trio":
      return "三連複";
    case "exacta":
      return "馬単";
    case "trifecta":
      return "三連単";
    case "bracketQuinella":
      return "枠連";
  }
}

/** 券種横断で判定不能(unjudged)だった件数(AC15)。 */
export interface MixedUnjudgedCounts {
  readonly oddsMissingCount: number;
  readonly oddsUnfetchedCount: number;
  readonly oddsMalformedCount: number;
}

/** `aggregateUnjudgedCounts`が1券種ぶんの判定不能件数を表すのに使う共通の形(0埋め済み)。 */
interface UnjudgedFields {
  readonly oddsMissingCount: number;
  readonly oddsUnfetchedCount: number;
  readonly oddsMalformedCount: number;
}

/** 判定不能0件(対象外〈not-requested`/`unavailable`〉、またはそもそも判定不能を持たない区分の既定値)。 */
const ZERO_UNJUDGED: UnjudgedFields = { oddsMissingCount: 0, oddsUnfetchedCount: 0, oddsMalformedCount: 0 };

/**
 * 1券種(`betType`)ぶんの判定不能件数を、その券種が実際に持つ診断値の形(複勝・単勝・
 * 組合せ券種でそれぞれ異なる)から取り出す(`aggregateUnjudgedCounts`の内部ヘルパー)。
 *
 * `betType`は`AllocationBetType`(coreの唯一の定義)を引数に取る**網羅的switch**にしてある
 * ため、`AllocationBetType`に新しい券種が増えると本関数がコンパイルエラーになり、
 * 「合算対象に加えるかどうか」の判断を人間に強制する(Issue #139の着手前確認で発覚した
 * 欠陥——`AllocationBetType`にtrifectaが加わった後も本関数〈旧実装〉がtrifectaを一切
 * 参照しなかったため、三連単のoddsMissingCount/oddsUnfetchedCount/oddsMalformedCountが
 * 常に合算から漏れていた——の再発防止)。
 */
function unjudgedOf(betType: AllocationBetType, diagnostics: MixedCandidateDiagnostics): UnjudgedFields {
  switch (betType) {
    case "place": {
      // 複勝は`unjudged.oddsMissingCount`のみ持つ(oddsUnfetchedCount/oddsMalformedCountは無い)。
      const d = diagnostics.place;
      return d.kind === "judged" ? { ...ZERO_UNJUDGED, oddsMissingCount: d.unjudged.oddsMissingCount } : ZERO_UNJUDGED;
    }
    case "win": {
      // 単勝はoddsMissingCount/oddsMalformedCountを持つが、oddsUnfetchedCountは持たない
      // (`winOdds`はAnalysisRowのフィールドであり「キーが無い」未取得状態が構造的に存在しないため。
      // `WinCandidateDiagnosticsView`のJSDoc参照)。
      const d = diagnostics.win;
      return d.kind === "judged"
        ? { ...ZERO_UNJUDGED, oddsMissingCount: d.unjudged.oddsMissingCount, oddsMalformedCount: d.unjudged.oddsMalformedCount }
        : ZERO_UNJUDGED;
    }
    case "wide":
    case "trio":
    case "quinella":
    case "exacta":
    case "trifecta": {
      // ワイド・3連複・馬連・馬単・三連単は同型の`ComboCandidateDiagnosticsView`を共有し、
      // `kind:"built"`のとき3区分すべてを持つ。
      const d = diagnostics[betType];
      return d.kind === "built" ? d.build.unjudged : ZERO_UNJUDGED;
    }
    case "bracketQuinella":
      // 枠連(Issue #144・#26-B)。診断値(`MixedCandidateDiagnostics.bracketQuinella`)は
      // Issue #148(#26-E2)で追加されたが、設定の配管は#149で完了したが、配分への接続は#150のスコープで、判定不能の合算
      // (`MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`を回す)にはまだ枠連が含まれない。
      // このためこの分岐に実行時に到達する経路は無い(網羅的switchのコンパイルを通すための最小限。
      // 表示順へ加えるとき〈#150〉に、ここを他のコンボ券種と同じ`diagnostics[betType]`経由に
      // 置き換える)。
      return ZERO_UNJUDGED;
  }
}

/**
 * 券種横断(複勝・単勝・ワイド・馬連・馬単・3連複・三連単)で判定不能だった件数を合算する
 * (AC15・Issue #90でwinを追加・Issue #117で馬連〈quinella〉を追加・Issue #125で馬単
 * 〈exacta〉を追加・Issue #139で三連単〈trifecta〉を追加)。`kind!=="built"/"judged"`
 * (`not-requested`・`unavailable`。ユーザーが対象外にした券種、またはwinのyosoガード)は
 * 判定不能ではなく「対象外」なので0として扱う(判定不能〈unjudged〉と対象外
 * 〈not-requested`/`unavailable`〉を混同しない)。
 *
 * **Issue #139(#25-E3b)で券種を1つずつ手で足す実装から、`MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`
 * (全7券種を持つ唯一の定義)を`.reduce`する実装へ変更した。** 旧実装は券種ごとに変数束縛
 * (`wideUnjudged`等)を手書きし、3つの合計式それぞれに手で足し込む形だったため、三連単
 * (`AllocationBetType`に既に存在した)を`AllocationBetType`に加えた後もこの関数への追加を
 * 忘れる欠陥が実際に発生した(#139着手前確認で発覚。三連単のunjudgedが常に0扱いになり、
 * 三連単しか判定不能が無いレースでは注記自体が出ない利用者から見える欠陥だった)。本実装は
 * `MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`を回して`unjudgedOf`(`AllocationBetType`の
 * 網羅的switch)で1券種ずつ取り出すため、次に券種が増えたときは
 * (a) `MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`への追加、(b) `unjudgedOf`のswitchケース追加
 * (追加しないとコンパイルエラー)の2点さえ行えば、本関数自体への追加作業は不要になる。
 */
export function aggregateUnjudgedCounts(diagnostics: MixedCandidateDiagnostics): MixedUnjudgedCounts {
  const perType = MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER.map((betType) => unjudgedOf(betType, diagnostics));
  return {
    oddsMissingCount: perType.reduce((sum, u) => sum + u.oddsMissingCount, 0),
    oddsUnfetchedCount: perType.reduce((sum, u) => sum + u.oddsUnfetchedCount, 0),
    oddsMalformedCount: perType.reduce((sum, u) => sum + u.oddsMalformedCount, 0),
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
 * レースIDの場コード(5〜6桁目)から中央/地方を判定する(Issue #139・#25-E3b・AC4)。
 *
 * 中央/地方の判定ロジック自体は core `venueKindOfRaceId`(scraper/ids.ts)と同じ場コード範囲
 * (中央01〜10)によるが、renderer層は core のバレル(`@keiba/core`)をそのまま import すると
 * native依存(better-sqlite3等。core/package.json の exports コメント参照)をバンドルに巻き込んで
 * しまい、この判定だけの狭いsubpathも無いため、この一行の閾値判定のみをここに複製する
 * (`renderer/race-ledger-filter.ts`の`venueKindOfRaceLedgerRaceId`と同じ前例・同じ理由。
 * `pnpm --filter @keiba/app build`が検出する`node:zlib`混入と同種の事故を避けるため)。
 *
 * `raceId`が無い(旧データ・raceIdを持たない最小テスト入力)場合は`false`(中央として扱う)を
 * 返す。production では`AnalysisResult.raceId`が常に存在するため、raceId欠落は「未知」を
 * 意味するだけであり、判定不能を「地方」と断定してはならない(#31の原則)。
 *
 * `mixed-allocation-view.test.ts`が本関数の判定と core `venueKindOfRaceId` の判定を
 * 中央・地方それぞれ1件で直接比較して固定する(複製が本家からずれる事故を防ぐ)。
 */
export function isNarRaceId(raceId: string | undefined): boolean {
  if (raceId === undefined || raceId.length < 6) {
    return false;
  }
  return Number(raceId.slice(4, 6)) > 10;
}

/**
 * 地方競馬では三連単を取得していない旨の注記(Issue #139・#25-E3b・AC4)。
 * `trifectaBetTypeNote`が地方レースの"unknown"状態に対して返す固定文言。
 */
export const NAR_TRIFECTA_NOTE = "地方競馬では三連単を取得していません。";

/**
 * 三連単の状態注記(Issue #139・#25-E3b・AC4)。wide/trio/quinella/exactaの`comboBetTypeNote`と
 * 基本は同じだが、地方(NAR)は三連単を当面取得しない(ユーザー判断2026-09-27。
 * `scrapeRace`が調教と同じ`if (!isNar)`ガードで取得自体を試みない)という三連単固有の事情が
 * あるため、`comboOddsState==="unknown"`のときだけ地方/中央で文言を分ける。
 *
 * 中央の"unknown"(未取得。設定変更後に再分析すると反映される)は`comboBetTypeNote`の
 * 既存文言をそのまま使う(再分析〈`includeComboOdds`をONにする〉すれば実際に取得されるため、
 * 文言は事実と一致する)。地方の場合は、再分析しても三連単は取得されない
 * (`docs/trifecta-odds-investigation.md`。地方は当面非対応)ため、その既存文言をそのまま
 * 出すと「設定変更後に再分析すると反映されます」という誤った案内になる。代わりに
 * `NAR_TRIFECTA_NOTE`(「地方競馬では三連単を取得していません」)を返す。
 *
 * `unavailable`/`failed`/`available`(EVプラス0件)は中央・地方を問わず同じ意味を持つため
 * (発売なし・取得失敗・EVプラスなしはいずれも「取得は試みた結果」であり、地方特例の対象では
 * ない)、`comboBetTypeNote`にそのまま委譲する。
 */
export function trifectaBetTypeNote(
  diag: ComboCandidateDiagnosticsView,
  raceId: string | undefined,
): string | null {
  if (diag.kind === "built" && diag.comboOddsState === "unknown" && isNarRaceId(raceId)) {
    return NAR_TRIFECTA_NOTE;
  }
  return comboBetTypeNote(diag);
}

/**
 * `buildComboBetTypeNotices`が返す1件(表示するラベルと注記文言)。
 */
export interface ComboBetTypeNoticeItem {
  readonly label: string;
  readonly note: string;
}

/**
 * 組合せ券種(ワイド・馬連・馬単・3連複・三連単)の状態注記を、表示順
 * (ワイド→馬連→馬単→3連複→三連単。`MIXED_ALLOCATION_BREAKDOWN_DISPLAY_ORDER`と同じ並び)に
 * 並べ、`null`(注記なし)の券種を省いた配列にする純関数(Issue #139・#25-E3b・Q1)。
 *
 * ## 経緯(#125のexactaNote欠落の再発防止)
 * Issue #125(#24-E3b)で`display.exactaNote`を新設したが、`BatchAnalysisView.tsx`側に
 * 対応する`<p>`を追加し忘れる欠落(利用者から見える欠落)が本Issue(#139)着手前確認で
 * 発覚した。原因は「券種を増やすたびにJSXへ`<p>`を1行手で足す」構造そのものにあったため、
 * 本関数を新設し、`BatchAnalysisView.tsx`はこの配列を`.map`で描画するだけにする
 * (`buildMixedAllocationNotices`〈advisory等を並べる既存の純関数〉と同じ考え方)。
 * これにより、次に券種を足すときの描画漏れは「表示順の全券種が含まれること」を固定する
 * テストで検出できる。
 *
 * ラベルは`mixedBetTypeLabel`をそのまま使う(`BatchAnalysisView.tsx`が従来
 * 「ワイド:」「馬連:」「3連複:」と直書きしていたラベルと同じ日本語であることを、
 * ラベル文言の複製を作らずに保証する)。
 */
export function buildComboBetTypeNotices(
  display: Pick<MixedAllocationDisplay, "wideNote" | "quinellaNote" | "exactaNote" | "trioNote" | "trifectaNote">,
): readonly ComboBetTypeNoticeItem[] {
  const entries: ReadonlyArray<{ readonly betType: AllocationBetType; readonly note: string | null }> = [
    { betType: "wide", note: display.wideNote },
    { betType: "quinella", note: display.quinellaNote },
    { betType: "exacta", note: display.exactaNote },
    { betType: "trio", note: display.trioNote },
    { betType: "trifecta", note: display.trifectaNote },
  ];
  return entries
    .filter((e): e is { betType: AllocationBetType; note: string } => e.note !== null)
    .map((e) => ({ label: mixedBetTypeLabel(e.betType), note: e.note }));
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
 *
 * ## Issue #80(#78-A): try/catchによる例外の吸収
 * `buildRaceAllocation`は内部で`allocateBets`(同時分布モデルを呼ぶ)を呼ぶが、本関数は
 * render内IIFE(`BatchAnalysisView.tsx`)から直接呼ばれ、リポジトリにReact error boundaryは
 * 1つも無い(`mixed-race-allocation.ts`冒頭JSDoc参照)。`PLACKETT_LUCE_MODEL`を含む任意の
 * モデルが`buildDistribution`でthrowしても画面全体を巻き添えにしないよう、本関数内で
 * try/catchし、throw時は`null`を返す。
 *
 * この catch は**防御的な二重化**である。**現行の production 経路では単独で発火しない**:
 * 本関数が使う入力(全出走馬の`adjustedProb`・`placeCount=3`)は、混在経路
 * (`COMBO_TOP_FINISH_COUNT=3`)と頭数・確率・k のすべてが同一であり、モデルが失敗するなら
 * 先に混在経路が失敗して`kind:"invalid"`を返すため、`kind:"mixed"`の分岐にある本関数へは
 * 到達しない。**到達不能であることを証明したわけではない**(将来どちらかの入力の作り方が
 * 変われば破れる)。`null`は既存の「複勝のみなら提案不能」と同じ意味で返す。
 */
export function resolvePlaceOnlyStake(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
): number | null {
  try {
    const view = buildRaceAllocation(race, settings);
    return view.kind === "computed" ? view.result.totalStake : null;
  } catch {
    return null;
  }
}

/**
 * #35の較正注記(AC14)。組合せ券種のEVが過大評価であること・較正未実施であることを明記する。
 * Issue #117: 例示にワイド・3連複に加えて馬連も含めた(馬連も同じ「複数頭の組み合わせによる
 * 確率誤差の増幅」を受ける組合せ券種であり、ワイド・3連複だけを挙げる旧文言はこれを言い落として
 * いた)。Issue #125: 同じ理由で馬単も例示に加えた。Issue #139: 同じ理由で三連単も例示に加えた。
 */
export const COMBO_EV_CALIBRATION_NOTE =
  "ワイド・馬連・馬単・三連複・三連単など組合せ券種のEVは、推定確率の誤差が組み合わせ人数ぶん増幅されるため過大評価になりやすいことが実測でわかっています(較正は未実施・Issue #35)。表示額を鵜呑みにせず、資金管理は慎重に行ってください。";

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
  /** 馬連の状態注記(Issue #117・AC-5。wide/trioと同じcomboBetTypeNoteを使う。無ければnull)。 */
  readonly quinellaNote: string | null;
  /** 馬単の状態注記(Issue #125・AC-4。wide/trio/quinellaと同じcomboBetTypeNoteを使う。無ければnull)。 */
  readonly exactaNote: string | null;
  /**
   * 三連単の状態注記(Issue #139・AC4。`trifectaBetTypeNote`を使う。無ければnull)。
   * 地方(NAR)では`comboOddsState==='unknown'`のとき`comboBetTypeNote`の中央向け文言
   * (「設定変更後に再分析すると反映されます」)ではなく`NAR_TRIFECTA_NOTE`になる点が
   * wide/trio/quinella/exactaと異なる(`trifectaBetTypeNote`のJSDoc参照)。
   */
  readonly trifectaNote: string | null;
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
// ============================================================================
// Issue #110(#24-C2): 配分計算をレース単位に分けて進める際の表示文言
// (AC-1: 待ちの明示・全体進捗。AC-7': 失敗レースの一言)。計算の進め方自体は
// `mixed-allocation-queue.ts`が担い、本節はそれが返す状態をどう文言にするかだけを持つ。
// ============================================================================

/**
 * 配分計算の全体進捗の文言(AC-1)。`done`=既に結果が出たレース数、`total`=対象レース数
 * (`betAllocationUnset`のときは対象自体が0)。表示するかどうか(`done===total`になったら
 * 消す等)は呼び出し側(`BatchAnalysisView.tsx`)の責務とする(`formatUnjudgedNote`が
 * 0件時の非表示判定を呼び出し側に委ねているのと同じ役割分担)。
 */
export function allocationProgressText(done: number, total: number): string {
  return `配分を計算中… ${done} / ${total} レース`;
}

/**
 * 1レースの配分計算(`buildMixedAllocationDisplay`)が例外を投げて失敗したときの一言(AC-7')。
 * 「計算中」のまま表示し続けると利用者に事実と異なることを言い続けることになるため、
 * 失敗が確定した(`AllocationOutcome.status==="error"`)レースにはこの注記を出す。
 * `MIXED_ALLOCATION_INVALID_MESSAGE`(kind:"invalid"用の文言)とは別の状況
 * (`buildMixedRaceAllocation`自体は例外を投げない設計〈AC17〉であり、これは
 * `mixed-allocation-queue.ts`が防御的に用意するtry/catchが実際に捕まえた場合の文言)。
 */
export const ALLOCATION_COMPUTE_ERROR_NOTE =
  "このレースの配分計算でエラーが発生しました。設定を変更するか、再分析すると再計算されます。";

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
    quinellaNote: comboBetTypeNote(view.diagnostics.quinella),
    exactaNote: comboBetTypeNote(view.diagnostics.exacta),
    trifectaNote: trifectaBetTypeNote(view.diagnostics.trifecta, race.raceId),
    placeUnavailableNote: placeUnavailableNoteForMixed(view.diagnostics.place),
    placeOnlyStake: resolvePlaceOnlyStake(race, settings),
    probabilitySumWarning: resolveMixedProbabilitySumWarning(race, view.topFinishCount),
  };
  return { ...view, display };
}
