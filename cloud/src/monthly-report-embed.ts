/**
 * 月報(Issue #265・#280)の Discord の要約(embed)。**純関数**。全文は web に保存してあり、ここは総括・成績・良かった点/改善点/来月に向けての先頭だけ。
 * 上限(説明 4096・field 1024・合計 6000)は {@link fitEmbed} が最後に保証する。リンク(`url`)は文字数の対象外で、基点があるときだけ付ける。
 * 日報の embed(`daily-report-embed.ts`)の部品(黒字/赤字の語・的中の文・「もしも」の行)をそのまま使う。
 * LLM の文章(総括・良かった点・改善点・来月に向けて)は、日報と同じ理由で `escapeDiscordMarkdown` を掛けて載せる(Issue #301。保存する文章・web には掛けない)。
 */
import { escapeDiscordMarkdown } from "../../packages/core/src/notify/discord-escape";
import { hasWhatIfData, hitText, profitWord, templateShort } from "./daily-report-embed";
import { yen } from "./daily-report-prompt";
import { formatMonthLabel } from "./monthly-month";
import type { MonthlyNarrative } from "./monthly-report-prompt";
import type { MonthStats } from "./monthly-stats";
import { fitEmbed, type CloudEmbed, type EmbedField } from "./notify-embeds";
import { DISCORD_COLORS } from "./palette";
import { formatRecoveryPercent } from "./recovery-format";
import { TEMPLATE_LABELS } from "./whatif-format";

/** 良かった点・改善点・来月に向けてを Discord に出す件数(全文は web)。 */
const SHOWN_ITEMS = 3;

/** 最終日の分が未反映のときの注記(固定文言)。 */
export const MONTHLY_EMBED_LAST_DAY_NOTE = "最終日の結果または日報がそろう前に作ったため、最終日の分は一部が反映されていない場合があります。";

export interface MonthlyEmbedInput {
  /** YYYYMM。 */
  readonly month: string;
  readonly stats: MonthStats;
  /** LLM の文章。使えなかったときは null。 */
  readonly narrative: MonthlyNarrative | null;
  /** 文章が無い理由(固定文言)。 */
  readonly note: string | null;
  /** 月報へのリンク(`<オリジン>/#report=YYYYMM`)。基点が無ければ undefined。 */
  readonly link: string | undefined;
  readonly lastDayPending: boolean;
}

export function buildMonthlyEmbed(input: MonthlyEmbedInput): CloudEmbed {
  const { stats, narrative } = input;
  const roi = stats.recoveryRate === null ? "なし" : `${formatRecoveryPercent(stats.recoveryRate)}${profitWord(stats.recoveryRate)}`;
  const fields: EmbedField[] = [
    { name: "成績", value: `賭け金 ${yen(stats.totalStake)}・払戻 ${yen(stats.totalReturn)}・回収率 ${roi}\n${hitText(stats)}` },
    { name: "レース", value: `${stats.raceCount} 件を分析(開催 ${stats.dayCount} 日・結果あり ${stats.resultRaceCount} 件・結果なし ${stats.noResultRaceCount} 件)` },
  ];
  const whatIf = stats.whatIf;
  if (whatIf !== null && whatIf !== undefined && hasWhatIfData(whatIf)) {
    fields.push({ name: "もしも(印の定型・各100円)", value: TEMPLATE_LABELS.map(([id, label]) => `${label}: ${templateShort(whatIf[id])}`).join("\n") });
  }
  if (narrative !== null) {
    const items: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["良かった点", narrative.good],
      ["改善点", narrative.improve],
      ["来月に向けて", narrative.outlook],
    ];
    for (const [name, list] of items) {
      if (list.length > 0) {
        fields.push({ name, value: list.slice(0, SHOWN_ITEMS).map((s) => `・${escapeDiscordMarkdown(s)}`).join("\n") });
      }
    }
  }
  if (input.lastDayPending) {
    fields.push({ name: "注記", value: MONTHLY_EMBED_LAST_DAY_NOTE });
  }
  const embed: CloudEmbed = {
    title: `月報 ${formatMonthLabel(input.month)}`,
    description: narrative !== null ? escapeDiscordMarkdown(narrative.summary) : (input.note ?? "統計だけの月報です"),
    color: stats.recoveryRate === null ? DISCORD_COLORS.none : stats.recoveryRate >= 1 ? DISCORD_COLORS.ok : DISCORD_COLORS.fail,
    fields,
    ...(input.link === undefined ? {} : { url: input.link }),
  };
  return fitEmbed(embed);
}
