/**
 * allocation-proposal-view — 検証タブ「レース一覧」の各レースに「配分提案(分析時点)」を
 * 表示するための純関数モジュール(Issue #55)。
 *
 * `VerifyView.tsx` には本機能の `route`/`skipReasonCode` 分岐と文言リテラルを一切置かない
 * (boss着手前ゲート・設計制約)。`buildAllocationProposalView` が保存済み配分
 * (`StoredAllocationView`。core `AnalysisStore.getStoredAllocation` の写し)を
 * 表示状態の判別共用体へ変換し、`VerifyView.tsx` は返ってきた配列を `.map` するだけにする。
 *
 * ## 表示範囲(PM決定)
 * 提案した買い目・金額・分析時点のオッズ/EV・見送り理由・実効設定のみ。的中・払戻・回収率は
 * 出さない(#16 / #71 の領分)。配分の再計算はしない(保存済みを読むだけ)。
 *
 * ## 欠損の扱い(boss裁定2026-09-02。一般規則)
 * 欠けているのが「その状態の下位理由・パラメータ」だけなら、状態は保持し、欠けた部分だけを
 * 代替文言で明示する(#31が禁じる「判定済みを未判定に潰す」方向を避ける)。状態そのものが
 * 決められないときだけ `kind:"indeterminate"`(判定不能)へ倒す。判定不能へ倒すのは次の2つのみ:
 * - 未知の `route` 文字列(状態そのものが決まらない)
 * - `route∈{place-only,mixed}` ∧ `skip_reason_code=null` ∧ `bets=[]`
 *   (「配分あり」と「見送り」のどちらとも決められない矛盾)
 *
 * `route="unavailable"` ∧ `unavailable_reason=null`、`skip_reason_code="cap-too-small"` ∧
 * `bet_unit=null` はいずれも「状態(unavailable/skip)」自体は判定済みで下位の理由・パラメータが
 * 欠けているだけなので、判定不能へ倒さず、状態を保持したまま代替文言を出す。
 *
 * ## fallback_reason の分岐(boss指摘。重要)
 * `fallback_reason` は `route==="place-only"` 専用ではない。`route==="unavailable"` でも
 * 非nullになりうる(D-2フォールバックが `buildRaceAllocation` を呼んだ結果、頭数不可で
 * `kind:"unavailable"` になる場合。`shared/mixed-race-allocation.ts` の
 * `AllocationOutcomeCodes` JSDoc参照)。したがって分岐は `route` ではなく
 * `fallbackReason !== null` で行う(`route`で分岐すると `unavailable` 経由のフォールバック
 * 理由が静かに消える)。
 *
 * ## bet_type / comboKey の検査範囲(boss指摘)
 * 未知の `bet_type` 値(place/wide/trio以外)はthrowせず生値をそのまま表示する
 * (`core/ev/verify.ts` の防御的 `continue` と同じ考え方)。**`bet_type` と `comboKey` の
 * 長さの不一致は検査しない**(例: ワイドなのに `comboKey` が6桁)。状態を1つ増やす価値が
 * 無く、`parseComboOddsKey` が復号できなかった場合の生キー表示(下記)で実務上は足りる
 * ため、あえて検査しない判断をした。
 */

import {
  comboSkipReasonText,
  parseComboOddsKey,
  type SkipReasonCode as ComboSkipReasonCode,
} from "@keiba/core/ev/combo-bet-allocation";
import { placeSkipReasonText } from "@keiba/core/ev/bet-allocation";

import type { StoredAllocationBetView, StoredAllocationView } from "../shared/analysis-types.js";
import { BET_ALLOCATION_UNSET_NOTE, formatBetLabel, placeBetUnavailableMessage } from "./bet-allocation-view.js";
import { formatEv, formatOdds } from "./format.js";
import { formatYen } from "./verify-format.js";

/** 見送り理由コード(複勝・組合せで共通の6分類。core `SkipReasonCode` の値をそのまま使う)。 */
const KNOWN_SKIP_REASON_CODES: readonly ComboSkipReasonCode[] = [
  "bankroll-unset",
  "cap-unset",
  "cap-too-small",
  "kelly-zero",
  "no-candidates",
  "no-edge",
];

/** 複勝の対象外理由(既知の3値)。 */
const KNOWN_UNAVAILABLE_REASONS: readonly string[] = ["not-sold", "two-place-only", "unknown"];

/** 表示状態の判別値(AC3: 7状態 + 判定不能)。 */
export type AllocationProposalViewKind =
  | "no-record"
  | "unset"
  | "yoso"
  | "unavailable"
  | "invalid"
  | "skip"
  | "allocated"
  | "indeterminate";

/** 買い目1行分の表示値(AC4)。 */
export interface AllocationBetRowView {
  readonly betTypeLabel: string;
  readonly comboLabel: string;
  readonly stake: string;
  readonly odds: string;
  readonly ev: string;
}

/** `buildAllocationProposalView` の戻り値。 */
export interface AllocationProposalView {
  readonly kind: AllocationProposalViewKind;
  /** 状態説明・見送り理由・フォールバック理由等の注記(表示順)。 */
  readonly notices: readonly string[];
  /** 買い目行(配分ありのときのみ非空)。 */
  readonly bets: readonly AllocationBetRowView[];
  /** 実効設定8項目(「ラベル: 値」の文字列配列)。記録が無ければ空配列。 */
  readonly settingsRows: readonly string[];
}

// ============================================================================
// 固定文言
// ============================================================================

/**
 * 記録なし(#59より前の旧分析)の注記。
 * code-reviewer指摘対応(2巡目・水平展開): テストから値として比較できるようexportする。
 */
export const NO_RECORD_NOTE = "この分析には配分提案の記録がありません(Issue #59より前の分析です)。";

/**
 * yoso(分析時点でオッズ未発売)の注記。過去分析の再表示のため過去形・中立表現にする。
 * code-reviewer指摘対応(2巡目・水平展開): テストから値として比較できるようexportする。
 */
export const YOSO_NOTE = "分析時点でオッズが未発売だったため、配分提案を行っていません。";

/**
 * invalid(配分計算が例外で止まった)の注記。
 * code-reviewer指摘対応(2巡目・水平展開): テストから値として比較できるようexportする。
 */
export const INVALID_NOTE = "配分計算中にエラーが発生したため、配分を提案していません。";

/**
 * unavailable_reasonが想定外(null、または未知の値)のときの代替文言(boss裁定A)。
 * 「複勝が配分対象外である」という判定結果自体は保持し、下位理由だけを「記録されていません」と
 * 明示する(判定不能へは倒さない)。
 */
export const UNAVAILABLE_REASON_MISSING_NOTE =
  "出走頭数の条件により複勝の配分対象外です(理由の詳細が記録されていません)";

/**
 * skip_reason_code="cap-too-small" ∧ bet_unit=null(想定外)のときの代替文言(boss指定の
 * 文言をそのまま使う)。「見送りである」「理由が1レース上限不足である」までは判定済みのため
 * 状態(skip)は保持し、数値だけを含めない(捏造しない)。
 */
export const CAP_TOO_SMALL_MISSING_UNIT_NOTE =
  "1レースの上限が最小賭け金単位を下回るため配分できません(単位額が記録されていません)";

/**
 * skipReasonCodeが未知の値(想定外)のときの汎用フォールバック文言。
 * code-reviewer指摘対応: テストから値として比較できるようexportする。
 */
export const SKIP_REASON_UNKNOWN_NOTE = "見送り理由の詳細が記録されていません。";

/**
 * 未知のroute文字列(判定不能)のときの注記。
 * code-reviewer指摘対応: テストから値として比較できるようexportする。
 */
export const INDETERMINATE_UNKNOWN_ROUTE_NOTE =
  "配分提案の状態を判定できません(記録された種別が不明です)。";

/**
 * skipReasonCode=null ∧ bets=[](判定不能)のときの注記。
 * code-reviewer指摘対応: テストから値として比較できるようexportする。
 */
export const INDETERMINATE_ALLOCATED_NO_BETS_NOTE =
  "配分提案の状態を判定できません(見送りでも配分ありでもない記録です)。";

/**
 * 総資金のみ0のときの注記。
 * code-reviewer指摘対応(2巡目・水平展開): テストから値として比較できるようexportする。
 */
export const UNSET_BANKROLL_ONLY_NOTE =
  "総資金が0円のため配分提案を行っていません(1レース上限は設定済みです)。";

/**
 * 1レース上限のみ0のときの注記。
 * code-reviewer指摘対応(2巡目・水平展開): テストから値として比較できるようexportする。
 */
export const UNSET_PER_RACE_CAP_ONLY_NOTE =
  "1レースの上限が0円のため配分提案を行っていません(総資金は設定済みです)。";

/**
 * route="unset" なのに bankroll・perRaceCap のどちらも0以下ではない(想定外)ときの代替文言
 * (boss差し戻し対応)。旧実装は3分岐目(else相当)に「1レース上限のみ0」の断定文言を
 * 割り当てており、この想定外の入力(どちらも正の値)まで断定して飲み込んでいた
 * (#31/#51/#58/#70と同型の「判定できないものを判定結果として報告する」欠陥)。
 * `route="unset"`という状態自体は判定済みで、欠けているのは「どちらが未設定だったか」という
 * 下位理由だけなので、`unavailable_reason=null`と同じ扱いで状態(kind="unset")は保持し、
 * 数値を捏造せず判定不能である旨だけを明示する。
 */
export const UNSET_INDETERMINATE_NOTE =
  "配分提案を行っていません(総資金・1レース上限のいずれが未設定だったかは記録から判定できません)。";

/**
 * D-2フォールバック理由(3コード)の注記文言。個別に定数化してexportする
 * (code-reviewer指摘対応・2巡目: Record内のリテラルのままだと個別に値として固定しにくいため、
 * 他の注記定数と同じ形〈名前付きexport定数〉に揃えた)。
 */
export const FALLBACK_REASON_COMBO_ODDS_NOT_REQUESTED_NOTE =
  "組合せオッズを取得しない設定のため複勝のみの配分になっています。";
export const FALLBACK_REASON_COMBO_BET_TYPES_OFF_NOTE =
  "ワイド・三連複が配分対象外の設定のため複勝のみの配分になっています。";
export const FALLBACK_REASON_NO_COMBO_CANDIDATES_NOTE =
  "ワイド・三連複にEVプラスの候補が無かったため複勝のみの配分になっています。";

/** D-2フォールバック理由コード→注記文言のマップ(上記3定数から組み立てる。複製しない)。 */
const FALLBACK_REASON_NOTES: Record<string, string> = {
  "combo-odds-not-requested": FALLBACK_REASON_COMBO_ODDS_NOT_REQUESTED_NOTE,
  "combo-bet-types-off": FALLBACK_REASON_COMBO_BET_TYPES_OFF_NOTE,
  "no-combo-candidates": FALLBACK_REASON_NO_COMBO_CANDIDATES_NOTE,
};

/**
 * fallback_reasonが未知の値(想定外)のときの汎用フォールバック文言。
 * code-reviewer指摘対応(2巡目・水平展開): テストから値として比較できるようexportする
 * (このケース自体、1巡目までテストが1件も無かった未検査コードパスだった)。
 */
export const FALLBACK_REASON_UNKNOWN_NOTE =
  "複勝のみの配分になっています(理由の詳細は記録されていません)。";

/** 券種コード(bet_type)→日本語ラベル。未知の値はそのまま返す(throwしない)。 */
function betTypeLabel(betType: string): string {
  switch (betType) {
    case "place":
      return "複勝";
    case "wide":
      return "ワイド";
    case "trio":
      return "三連複";
    default:
      return betType;
  }
}

/** オッズ発売状態(odds_status)→日本語ラベル。
 *
 * 既存の `oddsStatusNote`(format.ts)は流用しない: (i) `"result"`(確定)で `null` を返す設計
 * (実効設定は8項目すべてに値が要るため使えない)、(ii) 文言が実行中のラン向け(「発売後に
 * 再分析推奨」)で過去分析の再表示には不適切、という用途の違いによる(`oddsStatusNote` 自体は
 * 改変しない。`BatchAnalysisView.tsx` が依存しているため)。
 */
function oddsStatusLabelForPastAnalysis(oddsStatus: string): string {
  switch (oddsStatus) {
    case "result":
      return "確定";
    case "middle":
      return "中間(発売中)";
    case "yoso":
      return "発売前";
    default:
      return oddsStatus;
  }
}

/** boolean→ON/OFF表記(既存コードコメントの慣用表現に合わせる)。 */
function onOff(value: boolean): string {
  return value ? "ON" : "OFF";
}

/** 実効設定8項目(AC5)を「ラベル: 値」の文字列配列にする。 */
function buildSettingsRows(a: StoredAllocationView): readonly string[] {
  return [
    `総資金: ${formatYen(a.bankroll)}`,
    `1レース上限: ${formatYen(a.perRaceCap)}`,
    `ケリー係数: ${a.kellyFraction}`,
    `EV閾値: ${a.evThreshold}`,
    `ワイド: ${onOff(a.includeWide)}`,
    `三連複: ${onOff(a.includeTrio)}`,
    `組合せオッズ取得: ${onOff(a.includeComboOdds)}`,
    `オッズ状態: ${oddsStatusLabelForPastAnalysis(a.oddsStatus)}`,
  ];
}

/** comboKeyを馬番ラベルへデコードする。復号不能(parseComboOddsKeyがnull)なら生キーを返す。 */
function comboLabelOf(comboKey: string): string {
  const umabans = parseComboOddsKey(comboKey);
  if (umabans === null) {
    return comboKey;
  }
  return formatBetLabel(umabans);
}

/** 券種の表示順(複勝→ワイド→3連複)。未知の券種は末尾へ(値99)。 */
const BET_TYPE_ORDER: Record<string, number> = { place: 0, wide: 1, trio: 2 };

function betTypeRank(betType: string): number {
  return BET_TYPE_ORDER[betType] ?? 99;
}

/** 買い目行(AC4)を券種の表示順→comboKey昇順で決定的に並べる(DBのORDER BYに依存しない)。 */
function buildBetRows(bets: readonly StoredAllocationBetView[]): readonly AllocationBetRowView[] {
  return [...bets]
    .sort((a, b) => {
      const rankDiff = betTypeRank(a.betType) - betTypeRank(b.betType);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      if (a.betType !== b.betType) {
        // 券種ランクが同順位(=いずれも未知の券種)の場合のみ、決定的な順序のため文字列比較する。
        return a.betType < b.betType ? -1 : 1;
      }
      return a.comboKey < b.comboKey ? -1 : a.comboKey > b.comboKey ? 1 : 0;
    })
    .map((b) => ({
      betTypeLabel: betTypeLabel(b.betType),
      comboLabel: comboLabelOf(b.comboKey),
      stake: formatYen(b.stake),
      odds: formatOdds(b.odds),
      ev: formatEv(b.ev),
    }));
}

function isKnownSkipReasonCode(code: string): code is ComboSkipReasonCode {
  return (KNOWN_SKIP_REASON_CODES as readonly string[]).includes(code);
}

/**
 * 見送り理由の文言を組み立てる。`route`("place-only"/"mixed")によって文言関数を切り替える
 * (no-candidatesの文言差でrouteの取り違えを検出できる。AC3)。
 *
 * `cap-too-small` ∧ `betUnit===null`(想定外)は状態(skip)を保持したまま、boss指定の代替文言
 * (数値を含まない)を返す。`cap-too-small` 以外のコードは `betUnit` を実際には使わない
 * (`placeSkipReasonText`/`comboSkipReasonText` の実装参照)ため、`betUnit===null` でも
 * 表示に数値が現れない `0` を安全に渡せる。
 *
 * **観測窓は`no-candidates`1つだけ(boss実測・2026-09-03)。** `placeSkipReasonText`と
 * `comboSkipReasonText`は6分類中5分類(`bankroll-unset`/`cap-unset`/`cap-too-small`/
 * `kelly-zero`/`no-edge`)で完全に同一の文言を返し、両者の違いが観測できるのは`no-candidates`
 * (「馬」/「買い目」)だけである。したがって本関数の`route`分岐(`placeSkipReasonText`と
 * `comboSkipReasonText`のどちらを呼ぶか)を守るテストは、実質的に`no-candidates`のケース
 * 一本にしか依存できない。**将来`no-candidates`のテストを整理・削除すると、この`route`分岐は
 * 無防備になる**(他の5分類では place/combo を入れ替えても出力が変わらないため、テストが
 * 検出できない)。`no-candidates`のテストは削除・弱体化しないこと。
 */
function skipNotice(
  route: "place-only" | "mixed",
  skipReasonCode: string,
  betUnit: number | null,
): string {
  if (!isKnownSkipReasonCode(skipReasonCode)) {
    return SKIP_REASON_UNKNOWN_NOTE;
  }
  if (skipReasonCode === "cap-too-small" && betUnit === null) {
    return CAP_TOO_SMALL_MISSING_UNIT_NOTE;
  }
  const effectiveBetUnit = betUnit ?? 0;
  return route === "place-only"
    ? placeSkipReasonText(skipReasonCode, effectiveBetUnit)
    : comboSkipReasonText(skipReasonCode, effectiveBetUnit);
}

/** fallback_reasonの注記(非nullのときだけ配列に足す)。分岐はrouteではなくfallbackReasonで行う。 */
function fallbackNotices(fallbackReason: string | null): readonly string[] {
  if (fallbackReason === null) {
    return [];
  }
  return [FALLBACK_REASON_NOTES[fallbackReason] ?? FALLBACK_REASON_UNKNOWN_NOTE];
}

/** unset(総資金・1レース上限の未設定)の注記。3パターンを区別する(AC3境界)。 */
function unsetNotices(a: StoredAllocationView): readonly string[] {
  const bankrollUnset = a.bankroll <= 0;
  const perRaceCapUnset = a.perRaceCap <= 0;
  if (bankrollUnset && perRaceCapUnset) {
    return [BET_ALLOCATION_UNSET_NOTE];
  }
  if (bankrollUnset) {
    return [UNSET_BANKROLL_ONLY_NOTE];
  }
  if (perRaceCapUnset) {
    return [UNSET_PER_RACE_CAP_ONLY_NOTE];
  }
  // bossの差し戻し対応: どちらも0以下ではない(想定外。route="unset"の書き込み経路上は
  // 起きないはずだが、末尾のelse相当に断定文言を割り当てない)。
  return [UNSET_INDETERMINATE_NOTE];
}

/** unavailable(複勝が配分対象外)の注記。理由欠損時は状態を保持し代替文言(boss裁定A)。 */
function unavailableNotices(a: StoredAllocationView): readonly string[] {
  const reason = a.unavailableReason;
  const reasonNotice =
    reason !== null && KNOWN_UNAVAILABLE_REASONS.includes(reason)
      ? placeBetUnavailableMessage(reason as "not-sold" | "two-place-only" | "unknown")
      : UNAVAILABLE_REASON_MISSING_NOTE;
  return [reasonNotice, ...fallbackNotices(a.fallbackReason)];
}

/** route∈{place-only,mixed} の分岐(見送り/配分あり/判定不能)。 */
function computedView(
  a: StoredAllocationView,
  route: "place-only" | "mixed",
  settingsRows: readonly string[],
): AllocationProposalView {
  if (a.skipReasonCode !== null) {
    return {
      kind: "skip",
      notices: [skipNotice(route, a.skipReasonCode, a.betUnit), ...fallbackNotices(a.fallbackReason)],
      bets: [],
      settingsRows,
    };
  }
  if (a.bets.length === 0) {
    // #31: 「配分あり」と「見送り」のどちらとも決められない矛盾は判定不能へ倒す。
    return {
      kind: "indeterminate",
      notices: [INDETERMINATE_ALLOCATED_NO_BETS_NOTE],
      bets: [],
      settingsRows,
    };
  }
  return {
    kind: "allocated",
    notices: fallbackNotices(a.fallbackReason),
    bets: buildBetRows(a.bets),
    settingsRows,
  };
}

/**
 * 保存済み配分(`StoredAllocationView`)から表示状態(`AllocationProposalView`)を組み立てる。
 * `allocation===null`(#59より前の旧分析)は `kind:"no-record"`。
 */
export function buildAllocationProposalView(
  allocation: StoredAllocationView | null,
): AllocationProposalView {
  if (allocation === null) {
    return { kind: "no-record", notices: [NO_RECORD_NOTE], bets: [], settingsRows: [] };
  }
  const settingsRows = buildSettingsRows(allocation);
  switch (allocation.route) {
    case "unset":
      return { kind: "unset", notices: unsetNotices(allocation), bets: [], settingsRows };
    case "yoso":
      return { kind: "yoso", notices: [YOSO_NOTE], bets: [], settingsRows };
    case "unavailable":
      return { kind: "unavailable", notices: unavailableNotices(allocation), bets: [], settingsRows };
    case "invalid":
      return { kind: "invalid", notices: [INVALID_NOTE], bets: [], settingsRows };
    case "place-only":
    case "mixed":
      return computedView(allocation, allocation.route, settingsRows);
    default:
      // 未知のroute文字列(状態そのものが決まらない)。#31: 判定不能へ倒す。
      return {
        kind: "indeterminate",
        notices: [INDETERMINATE_UNKNOWN_ROUTE_NOTE],
        bets: [],
        settingsRows,
      };
  }
}
