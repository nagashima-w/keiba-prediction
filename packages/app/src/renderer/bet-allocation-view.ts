/**
 * 馬券配分(機能C-2)の renderer 側表示関数。
 *
 * BatchAnalysisView から利用する。計算本体(`resolvePlaceBetTarget`・`isBetAllocationUnset`・
 * `buildRaceAllocation`・関連の型)は Issue #57 で `shared/race-allocation.ts` へ移設した
 * (挙動不変・移動のみ。renderer・main の両方から呼べるようにするため)。本ファイルには
 * 買い目ラベル・合計行・注記文言など、画面表示のためだけの純関数が残る。
 *
 * reasonコード→文言のマップはこのファイルに1箇所だけ置く(頭数の意味論はcoreが知り得ない
 * 領域のため、skipReason/advisoryのような「core側が文言を持つ」原則の例外として、
 * ここではrendererが文言の定義元になる)。
 */

import type { BetAllocationResult } from "@keiba/core/ev/bet-allocation";

import type { PlaceBetUnavailableReason } from "../shared/race-allocation.js";
import { formatYen } from "./verify-format.js";

/** reasonコード→文言のマップ(1箇所に集約。JSXに文言を直書きしない)。 */
const PLACE_BET_UNAVAILABLE_MESSAGES: Record<PlaceBetUnavailableReason, string> = {
  "two-place-only":
    "複勝が2着までとなり本ツールの3着内率推定と整合しないため配分提案を行いません",
  "not-sold": "複勝が発売されないため対象外です",
  unknown: "出走頭数を判定できないため配分提案を行いません",
};

/** PlaceBetTarget.reason(不可の理由コード)を表示文言にする。 */
export function placeBetUnavailableMessage(reason: PlaceBetUnavailableReason): string {
  return PLACE_BET_UNAVAILABLE_MESSAGES[reason];
}

/**
 * 買い目ラベルの純関数生成(受け入れ条件27)。umabanをJSXへ直接埋め込まず、
 * ラベル文字列をここで一元的に組み立てる。
 *
 * **機能D-2c第4段(Issue #28)でワイド・3連複の組ラベルに対応した(boss指示: 必ずこのファイル側で
 * 拡張し、新ファイルに別実装を複製しないこと)。** 単一馬番(`number`。複勝・従来どおり)と
 * 馬番の組(`readonly number[]`。ワイド・3連複)の両方を受け取れる。
 * - 単一馬番、または要素数1の配列: `"4番"`(従来どおりの表記)
 * - 要素数2の配列(ワイド): `"4-7"`
 * - 要素数3の配列(3連複): `"3-4-7"`
 *
 * 配列の順序はそのまま連結する(本関数では再ソートしない)。`AllocationCandidate.umabans`/
 * `GeneralBetAllocation.umabans`(`combo-bet-allocation.ts`)は「昇順・重複なし」が契約
 * (`validateCandidates`が違反をthrowで弾く)であるため、この関数はその契約に委ねる
 * (構造的自己防御ではなく呼び出し側の契約に委ねる、というAllocationCandidate側の設計と揃える)。
 */
export function formatBetLabel(umaban: number | readonly number[]): string {
  if (typeof umaban === "number") {
    return `${umaban}番`;
  }
  if (umaban.length === 1) {
    return `${umaban[0]}番`;
  }
  return umaban.join("-");
}

/**
 * `formatAllocationSummary`が実際に読む5フィールドだけを取り出した構造的な入力型
 * (機能D-2c第4段・Issue #28)。`BetAllocationResult`(複勝専用)と
 * `GeneralBetAllocationResult`(`combo-bet-allocation.ts`。券種混在)は`diagnostics`の形が
 * 非互換(`placeProbSum`等の有無が異なる)だが、この関数が実際に使うのは総額・ケリー適正額・
 * 1レース上限・上限到達フラグ・解決済み総資金の5つだけなので、それらだけを要求する構造的な
 * 型にして両方の結果型から呼べるようにする(単一定義の原則。合計行の文言を2箇所に複製しない)。
 */
export interface AllocationSummaryInput {
  readonly totalStake: number;
  readonly kellyTargetStake: number;
  readonly effectivePerRaceCap: number;
  readonly capApplied: boolean;
  readonly resolvedBankroll: number;
}

/**
 * 合計行の文言。capApplied(1レース上限で頭打ちになったか)で表現を切り替える
 * (仕様「UI 表示要件」の2例文に準拠)。
 */
export function formatAllocationSummary(result: AllocationSummaryInput): string {
  const total = formatYen(result.totalStake);
  const kellyTarget = formatYen(Math.round(result.kellyTargetStake));
  const cap = formatYen(result.effectivePerRaceCap);
  if (result.capApplied) {
    return `配分 合計 ${total} — ケリー適正額 ${kellyTarget} を1レース上限 ${cap}で打ち止め`;
  }
  const percent =
    result.resolvedBankroll > 0 ? (result.totalStake / result.resolvedBankroll) * 100 : 0;
  return `配分 合計 ${total}(総資金の${percent.toFixed(1)}%) — ケリー適正額 ${kellyTarget} / 1レース上限 ${cap}(上限に未達)`;
}

/** 確率合計の乖離がこの絶対値を超えたら警告する(名前付き定数)。 */
const PLACE_PROB_SUM_DEVIATION_THRESHOLD = 0.3;

/**
 * `probabilitySumWarning`が実際に読む3フィールドだけを取り出した構造的な入力型
 * (機能D-2c第4段・Issue #28。boss メタレビュー差し戻し2026-08-13対応)。
 * `formatAllocationSummary`/`AllocationSummaryInput`と同じ理由(単一定義の原則)で、
 * `BetAllocationDiagnostics`(複勝専用。`marginalDeviationMax`/`candidateCount`も持つ)から
 * この3つだけを要求する構造的な型に切り出し、`GeneralBetAllocationDiagnostics`
 * (`combo-bet-allocation.ts`。この3フィールドを持たない)からは**呼び出し元
 * 〈`mixed-allocation-view.ts`〉が`race.rows[].adjustedProb`の合計と`topFinishCount`から
 * 同じ形の値を組み立てて渡す**ことで、同じ警告ロジック・同じ閾値・同じ文言を再利用できる
 * ようにする(警告そのものを2箇所に複製しない)。
 */
export interface ProbabilitySumWarningInput {
  readonly placeProbSum: number;
  readonly placeProbSumTarget: number;
  readonly placeProbSumDeviation: number;
}

/**
 * 複勝圏内確率の合計が目標(placeCount)から外れている旨の警告。
 * |placeProbSumDeviation| > 閾値 かつ 有限のときのみ文言を返す。非有限値は画面に出さない
 * (受け入れ条件24)。
 */
export function probabilitySumWarning(diagnostics: ProbabilitySumWarningInput): string | null {
  const { placeProbSum, placeProbSumTarget, placeProbSumDeviation } = diagnostics;
  if (!Number.isFinite(placeProbSumDeviation)) {
    return null;
  }
  if (Math.abs(placeProbSumDeviation) <= PLACE_PROB_SUM_DEVIATION_THRESHOLD) {
    return null;
  }
  return (
    `複勝圏内確率の合計が目標 ${placeProbSumTarget.toFixed(2)} から外れています` +
    `(実測 ${placeProbSum.toFixed(2)})。配分額の信頼性が下がります。`
  );
}

/**
 * notDiversified(1点配分だが分散できる余地があった)の注記文言。
 *
 * 原因を名指ししない中立表現にする(boss実測による指摘・欠陥クラスの5回目の再発防止)。
 * 旧文言は「1レース上限の制約により」と原因を1レース上限に限定していたが、実際には
 * betCount===1になる経路は複数あり(1: 100円単位への丸めで他候補が0円に切り捨てられる
 * 純粋な丸め・2: 最低額ロジックが1頭だけに割り当てる)、1レース上限(capApplied)が
 * 効いていないケース(bankroll総資金1,200〜12,000円という最も一般的な設定帯を含む)の方が
 * 実測では多数派だった。判定していない(あるいは別の)原因を判定結果として報告しては
 * ならない欠陥クラス(C-1で3回・C-2着手前ゲートQ2で1回)の5回目。
 * core側 BetAllocation.tsのJSDocが notDiversified を「1点配分だが分散できる余地があった旨の
 * 注記」と意図的に原因中立で定義している設計に、renderer側の文言も揃える
 * (capApplied/minimumStakeAppliedによる原因分岐は行わない。原因を問わず常に真であることを
 * 優先する)。
 *
 * **機能D-2c第4段(Issue #28)でexportした**: `GeneralBetAllocationResult`(券種混在。
 * `combo-bet-allocation.ts`)も同じ意味の`notDiversified`フィールドを持つため、
 * `mixed-allocation-view.ts`/`BatchAnalysisView.tsx`がこの文言をそのまま再利用できるように
 * する(単一定義の原則。同じ注記文言を2箇所に複製しない)。
 */
export const NOT_DIVERSIFIED_NOTE =
  "妙味のある候補が複数いますが、1点のみの配分になっています(分散されていません)。";

/**
 * レース単位の条件付き注記を、表示順(advisory → 確率合計警告 → notDiversified)で並べる
 * (仕様「注記の表示順」)。該当する注記が無ければ空配列。
 */
export function buildAllocationNotices(result: BetAllocationResult): readonly string[] {
  const notices: string[] = [];
  if (result.advisory !== null) {
    notices.push(result.advisory);
  }
  const warning = probabilitySumWarning(result.diagnostics);
  if (warning !== null) {
    notices.push(warning);
  }
  if (result.notDiversified) {
    notices.push(NOT_DIVERSIFIED_NOTE);
  }
  return notices;
}

/**
 * 固定注記1: ケリー基準の説明(「上限は歯止め・通常は届かない」という誤解を防ぐ)。
 * 数値を含まない完全固定文のため定数として持つ(仕様「UI 表示要件」固定注記1)。
 */
export const KELLY_CAP_EXPLANATION_NOTE =
  "ケリー基準は妙味の大きさに比例した額だけを賭けます。上限は「これ以上は賭けない」という歯止めで、通常は上限に届きません。金額を増やすには総資金またはケリー係数を上げてください(いずれもリスクが増えます)。";

/** 固定注記2: レース横断オーバーベット警告(配分がレース単位で独立計算である旨の注意)。 */
export const CROSS_RACE_OVERBET_NOTE =
  "配分はレースごとに独立して計算しています。各レースの金額は総資金に対する比率で決まるため、複数レースを同時に購入すると合計はケリー最適を超えます。";

/**
 * 固定注記3: EV閾値の脚注(候補選定がisPositive依存であることの説明。数値込みのため関数化)。
 *
 * **機能D-2c第4段(Issue #28・AC9)で「馬」→「買い目」に改訂した。** 券種横断の配分(混在経路)
 * では判定対象が単一馬(複勝)だけでなく組(ワイド・3連複)にも及ぶため、「馬のみ」という表記は
 * 事実と食い違う。「買い目」は`combo-bet-allocation.ts`の既存文言(例:
 * `REASON_NO_CANDIDATES`「EVプラスの買い目がないため見送りです」)と同じ語であり、単一馬・組の
 * どちらも指す中立語として揃える。**文言だけでなく実際の判定基準も揃っていること**(D-4・
 * `mixed-candidates.ts`の`evConfig`)を前提にした改訂であり、`evConfig`を渡し忘れると
 * この文言と実際の判定が再び食い違う(この欠陥クラスの再発防止のため、呼び出し元
 * 〈`mixed-race-allocation.ts` の `buildMixedRaceAllocation`〉が同じ`evThreshold`由来の`evConfig`を渡すこと)。
 */
export function evThresholdFootnote(evThreshold: number): string {
  return `配分の対象はEV閾値(現在 ${evThreshold.toFixed(2)})を上回った買い目のみです。`;
}

/**
 * 総資金・1レース上限が未設定のときの、画面全体で1点だけの注記(仕様「未設定時は…注記は
 * 画面全体で1点だけ」)。レース数に関わらずこの1文だけを表示し、レースごとには繰り返さない。
 */
export const BET_ALLOCATION_UNSET_NOTE =
  "馬券配分の提案には、設定画面で「馬券用の総資金」と「1レースの上限」を入力してください。";
