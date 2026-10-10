/**
 * 日報(Issue #235)の Discord の要約(embed)。**純関数**。全文は web に保存してあり、ここは総括・成績・良かった点/改善点の先頭だけ。
 * 上限(説明 4096・field 1024・合計 6000)は {@link fitEmbed} が最後に保証する。リンク(`url`)は文字数の対象外で、基点があるときだけ付ける。
 */
import { dateLabel, percent, yen, type Narrative } from "./daily-report-prompt";
import type { DayStats } from "./daily-report-digest";
import { DISCORD_COLORS } from "./palette";
import { fitEmbed, type CloudEmbed, type EmbedField } from "./notify-embeds";

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
}

/**
 * 帯の色(緑・赤)だけに頼らないための語(Issue #239)。境界は帯の色の条件(`recoveryRate >= 1` で緑)と同じ: 100% ちょうどは緑で「収支±0」、それ未満は赤で「赤字」、超えれば緑で「黒字」。
 * 丸めた表示が「100.0%」でも、実際の値が 1 未満なら赤字(帯も赤)。
 */
function profitWord(recoveryRate: number): string {
  if (recoveryRate > 1) return "(黒字)";
  if (recoveryRate === 1) return "(収支±0)";
  return "(赤字)";
}

export function buildReportEmbed(input: ReportEmbedInput): CloudEmbed {
  const { stats, narrative } = input;
  const roi = stats.recoveryRate === null ? "なし" : `${percent(stats.recoveryRate)}${profitWord(stats.recoveryRate)}`;
  const fields: EmbedField[] = [
    { name: "成績", value: `賭け金 ${yen(stats.totalStake)}・払戻 ${yen(stats.totalReturn)}・回収率 ${roi}\n${stats.judgedBetCount} 点中 ${stats.hitBetCount} 点的中` },
    { name: "レース", value: `${stats.raceCount} 件を分析(結果あり ${stats.resultRaceCount} 件・結果なし ${stats.noResultRaceCount} 件)` },
  ];
  if (narrative !== null) {
    if (narrative.good.length > 0) {
      fields.push({ name: "良かった点", value: narrative.good.slice(0, SHOWN_ITEMS).map((s) => `・${s}`).join("\n") });
    }
    if (narrative.improve.length > 0) {
      fields.push({ name: "改善点", value: narrative.improve.slice(0, SHOWN_ITEMS).map((s) => `・${s}`).join("\n") });
    }
  }
  const embed: CloudEmbed = {
    title: `日報 ${dateLabel(input.kaisaiDate)}`,
    description: narrative !== null ? narrative.summary : (input.note ?? "統計だけの日報です"),
    color: stats.recoveryRate === null ? COLOR_GRAY : stats.recoveryRate >= 1 ? COLOR_GREEN : COLOR_RED,
    fields,
    ...(input.link === undefined ? {} : { url: input.link }),
  };
  return fitEmbed(embed);
}
