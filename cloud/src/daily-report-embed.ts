/**
 * 日報(Issue #235)の Discord の要約(embed)。**純関数**。全文は web に保存してあり、ここは総括・成績・良かった点/改善点の先頭だけ。
 * 上限(説明 4096・field 1024・合計 6000)は {@link fitEmbed} が最後に保証する。リンク(`url`)は文字数の対象外で、基点があるときだけ付ける。
 *
 * **LLM の文章(総括・良かった点・改善点)と、惜しかったレースのレース名は、外から来た文字列として `escapeDiscordMarkdown` を掛けて載せる**(Issue #301。マスクドリンク・書式が描画されないように)。
 * 掛けるのは**この embed の組み立てだけ**で、保存する文章・web の画面には掛けない(画面にバックスラッシュが見えるため)。固定文(`note` ほか)は対象外。
 */
import { escapeDiscordMarkdown } from "../../packages/core/src/notify/discord-escape";
import { dateLabel, yen, type Narrative } from "./daily-report-prompt";
import { formatExpectedHits } from "./expected-format";
import type { RollingSummary } from "./period-stats";
import { formatRecoveryPercent } from "./recovery-format";
import type { DayStats } from "./daily-report-digest";
import { DISCORD_COLORS } from "./palette";
import { fitEmbed, type CloudEmbed, type EmbedField } from "./notify-embeds";
import type { NearMissSummary, WhatIfStats } from "./daily-report-whatif";
import { templateLabel, TEMPLATE_LABELS } from "./whatif-format";

// 帯の色は palette.ts(Issue #239)。
const COLOR_GREEN = DISCORD_COLORS.ok;
const COLOR_RED = DISCORD_COLORS.fail;
const COLOR_GRAY = DISCORD_COLORS.none;

/** 良かった点・改善点を Discord に出す件数(全文は web)。 */
const SHOWN_ITEMS = 3;

export interface ReportEmbedInput {
  readonly kaisaiDate: string;
  readonly stats: DayStats;
  /** LLM の文章。使えなかったときは null。 */
  readonly narrative: Narrative | null;
  /** 文章が無い理由(固定文言)。 */
  readonly note: string | null;
  /** 日報へのリンク(`<オリジン>/#report=YYYYMMDD`)。基点が無ければ undefined。 */
  readonly link: string | undefined;
  /** 直前 27 日と直近 28 日の累計(Issue #264)。この項目を持つ前の日報には無い(undefined)。 */
  readonly rolling?: RollingSummary | undefined;
  /** 惜しかったレース(Issue #272)。省略・null は未計算(旧形)で、field を出さない。 */
  readonly nearMisses?: NearMissSummary | null | undefined;
  /** 惜しかったレースの名前を引くための、その日のレースの一覧。無ければ raceId を出す。 */
  readonly races?: readonly { readonly raceId: string; readonly title: string }[] | undefined;
}

/** 型 1 つの『的中/点数 回収率』(判定できた点が無ければ回収率は『-』)。 */
export function templateShort(s: WhatIfStats[string] | undefined): string {
  if (s === undefined) return "-";
  return `${s.hitCount}/${s.betCount} ${s.betCount === 0 ? "-" : formatRecoveryPercent(s.payout / s.stake)}`;
}

/** 型の成績が 1 つでも数えられている(レースが 0 件の日は false)。 */
export function hasWhatIfData(w: WhatIfStats): boolean {
  return Object.values(w).some((s) => s.betCount + s.unjudgedCount + s.inapplicableCount > 0);
}

/**
 * 帯の色(緑・赤)だけに頼らないための語(Issue #239)。境界は帯の色の条件(`recoveryRate >= 1` で緑)と同じ: 100% ちょうどは緑で「収支±0」、それ未満は赤で「赤字」、超えれば緑で「黒字」。
 * 丸めた表示が「100.0%」でも、実際の値が 1 未満なら赤字(帯も赤)。
 */
export function profitWord(recoveryRate: number): string {
  if (recoveryRate > 1) return "(黒字)";
  if (recoveryRate === 1) return "(収支±0)";
  return "(赤字)";
}

/**
 * 『N 点中 M 点的中』に、返還があるときは『うち返還 K 点』(Issue #278。項目が無い旧形・0 点なら添えない)、見込みを導けるときは『見込み X.XX 点・実際 Y 点』を、1 つの括弧に添える。
 * 返還は N には含まれ、M には含まれない。
 */
export function hitText(s: DayStats): string {
  const expected = formatExpectedHits(s);
  const parts = [(s.refundedBetCount ?? 0) > 0 ? `うち返還 ${s.refundedBetCount} 点` : null, expected].filter((t): t is string => t !== null);
  return `${s.judgedBetCount} 点中 ${s.hitBetCount} 点的中${parts.length === 0 ? "" : `(${parts.join("・")})`}`;
}

export function buildReportEmbed(input: ReportEmbedInput): CloudEmbed {
  const { stats, narrative } = input;
  const roi = stats.recoveryRate === null ? "なし" : `${formatRecoveryPercent(stats.recoveryRate)}${profitWord(stats.recoveryRate)}`;
  const fields: EmbedField[] = [
    { name: "成績", value: `賭け金 ${yen(stats.totalStake)}・払戻 ${yen(stats.totalReturn)}・回収率 ${roi}\n${hitText(stats)}` },
    { name: "レース", value: `${stats.raceCount} 件を分析(結果あり ${stats.resultRaceCount} 件・結果なし ${stats.noResultRaceCount} 件)` },
  ];
  if (input.rolling !== undefined) {
    const t = input.rolling.total;
    fields.push({
      name: "直近 28 日の累計(その日を含む)",
      value: `賭け金 ${yen(t.totalStake)}・払戻 ${yen(t.totalReturn)}・回収率 ${t.recoveryRate === null ? "なし" : formatRecoveryPercent(t.recoveryRate)}\n${hitText(t)}\n開催 ${t.dayCount} 日・${t.raceCount} レース`,
    });
  }
  // 型の上では必須でも、デプロイをまたいだジョブの record は旧コードが積んだもの(この項目が無い)ことがある。落とさず、field を出さない。
  const whatIf: WhatIfStats | null | undefined = stats.whatIf;
  if (whatIf !== null && whatIf !== undefined && hasWhatIfData(whatIf)) {
    const total = input.rolling?.total.whatIf ?? null;
    fields.push({
      name: "もしも(印の定型・各100円)",
      value: TEMPLATE_LABELS.map(([id, label]) => `${label}: その日 ${templateShort(whatIf[id])}${total === null ? "" : `・28日 ${templateShort(total[id])}`}`).join("\n"),
    });
  }
  const near = input.nearMisses;
  if (near !== undefined && near !== null && near.total > 0) {
    const titleOf = (raceId: string): string => escapeDiscordMarkdown(input.races?.find((r) => r.raceId === raceId)?.title ?? raceId);
    fields.push({ name: `惜しかったレース(全 ${near.total} 件)`, value: near.shown.map((n) => `${titleOf(n.raceId)}: ${templateLabel(n.templateId)} ${yen(n.payout)}`).join("\n") });
  }
  if (narrative !== null) {
    if (narrative.good.length > 0) {
      fields.push({ name: "良かった点", value: narrative.good.slice(0, SHOWN_ITEMS).map((s) => `・${escapeDiscordMarkdown(s)}`).join("\n") });
    }
    if (narrative.improve.length > 0) {
      fields.push({ name: "改善点", value: narrative.improve.slice(0, SHOWN_ITEMS).map((s) => `・${escapeDiscordMarkdown(s)}`).join("\n") });
    }
  }
  const embed: CloudEmbed = {
    title: `日報 ${dateLabel(input.kaisaiDate)}`,
    description: narrative !== null ? escapeDiscordMarkdown(narrative.summary) : (input.note ?? "統計だけの日報です"),
    color: stats.recoveryRate === null ? COLOR_GRAY : stats.recoveryRate >= 1 ? COLOR_GREEN : COLOR_RED,
    fields,
    ...(input.link === undefined ? {} : { url: input.link }),
  };
  return fitEmbed(embed);
}
