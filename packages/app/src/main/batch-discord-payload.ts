/**
 * 一括分析の横断サマリを Discord Webhook ペイロード(embed 1件)へ変換する純関数。
 *
 * 個別レースごとの送信は行わず、全レース横断のEVプラス馬一覧を1通にまとめる。
 * 整形規則は core の1レース用 embed(buildAnalysisEmbed)に合わせつつ、レース名を各行に添える。
 * Discord の説明文上限(DISCORD_EMBED_DESCRIPTION_MAX)を超えないよう truncate で切り詰める。
 */

import {
  DISCORD_EMBED_DESCRIPTION_MAX,
  DISCORD_EMBED_TITLE_MAX,
  truncate,
  type DiscordPayload,
} from "@keiba/core";

import type { BatchRaceOutcome } from "../shared/analysis-types.js";
import {
  collectEvPlusSummary,
  rankRaceOpportunities,
  summarizeBatch,
} from "../renderer/batch-summary.js";

/** Discordサマリに載せる妙味レースランキングの最大件数(上位数件で十分)。 */
const RANKING_TOP_N = 3;

/** EVプラスがあるときの帯色(緑)。 */
const COLOR_POSITIVE = 0x2ecc71;
/** EVプラスが無いときの帯色(グレー)。 */
const COLOR_NONE = 0x95a5a6;
/** 馬名は行が長くなりすぎないよう個別に切り詰める。 */
const HORSE_NAME_MAX = 32;

/** 0〜1の確率を小数第1位までのパーセント文字列にする。 */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** 複勝オッズ下限を小数第1位まで表示する。欠損は "-"。 */
function formatOdds(oddsMin: number | null): string {
  return oddsMin === null ? "-" : oddsMin.toFixed(1);
}

/** 期待値を小数第2位まで表示する。 */
function formatEv(ev: number): string {
  return ev.toFixed(2);
}

/** コードポイント数(絵文字・サロゲート対応)。 */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * ヘッダ行 + 馬行群を上限文字数に収める。全行が収まらない場合は、無言で途中切りせず、
 * 収まる範囲の上位行だけを残して末尾に「…他N頭省略」を付す(省略数を明示する)。
 * @param header 先頭に必ず残す行(件数注記)
 * @param horseLines EV降順の馬行(上位ほど残す価値が高い)
 * @param max 説明文の上限コードポイント数
 */
function fitWithOmissionNote(
  header: string,
  horseLines: readonly string[],
  max: number,
): string {
  const full = [header, "", ...horseLines].join("\n");
  if (codePointLength(full) <= max) {
    return full;
  }
  // 省略が必要。掲載行数 k を減らしながら、注記込みで収まる最大の k を探す。
  for (let k = horseLines.length - 1; k >= 1; k -= 1) {
    const omitted = horseLines.length - k;
    const candidate = [
      header,
      "",
      ...horseLines.slice(0, k),
      `…他${omitted}頭省略`,
    ].join("\n");
    if (codePointLength(candidate) <= max) {
      return candidate;
    }
  }
  // 1行すら収まらない極端なケースは、注記のみ(それでも溢れるなら truncate で安全側)。
  return truncate(
    [header, "", `…他${horseLines.length}頭省略`].join("\n"),
    max,
  );
}

/**
 * 一括分析のアウトカム配列から Discord 送信ペイロード(embed 1件)を組み立てる。
 * @param outcomes レースごとの成功/失敗/スキップのアウトカム
 */
export function buildBatchDiscordPayload(
  outcomes: readonly BatchRaceOutcome[],
): DiscordPayload {
  const evPlus = collectEvPlusSummary(outcomes);
  const counts = summarizeBatch(outcomes);

  const countLine = `対象${counts.total}レース(成功${counts.success} / 失敗${counts.failure} / スキップ${counts.skipped})`;

  // 妙味レースランキング(上位数件)。スコアが算出できたレースだけを対象にする。
  const ranked = rankRaceOpportunities(outcomes).filter(
    (r) => r.opportunity.score !== null,
  );
  const rankingLines: string[] = [];
  if (ranked.length > 0) {
    rankingLines.push("【妙味レースランキング】");
    ranked.slice(0, RANKING_TOP_N).forEach((r, i) => {
      const op = r.opportunity;
      const pick =
        op.bestPick !== null
          ? `筆頭${truncate(op.bestPick.horseName, HORSE_NAME_MAX)}(${op.bestPick.umaban}番)`
          : "筆頭なし";
      // 低データが多いレースは注記する(モデル過信への注意喚起)。
      const lowNote = op.lowDataRatio >= 0.5 ? " ※低データ多" : "";
      rankingLines.push(
        `${i + 1}. ${r.raceName} スコア${op.score!.toFixed(2)}(EVプラス${op.evPlusCount}頭)${pick}${lowNote}`,
      );
    });
  }

  const horseLines =
    evPlus.length > 0
      ? evPlus.map((r) => {
          const name = truncate(r.horseName, HORSE_NAME_MAX);
          // 予想印(Task#23): 印が付いた馬は行頭に「◎ 」のように添える。印なし馬は従来どおり。
          const markPrefix = r.mark !== null ? `${r.mark} ` : "";
          return `${markPrefix}${r.raceName} ${r.umaban}番 ${name} AI補正後${formatPercent(r.adjustedProb)} 複勝下限${formatOdds(r.placeOddsMin)} EV${formatEv(r.ev)}`;
        })
      : ["EVプラスの馬はありません(該当なし)"];

  // 件数行とランキング(固定して残す部分)を1つのヘッダにまとめ、EVプラス馬行だけを省略対象にする。
  const header =
    rankingLines.length > 0
      ? [countLine, "", ...rankingLines, "", "【EVプラス馬(横断・EV降順)】"].join(
          "\n",
        )
      : countLine;

  const description = fitWithOmissionNote(
    header,
    horseLines,
    DISCORD_EMBED_DESCRIPTION_MAX,
  );

  return {
    embeds: [
      {
        title: truncate("一括分析: EVプラス馬サマリ", DISCORD_EMBED_TITLE_MAX),
        description,
        color: evPlus.length > 0 ? COLOR_POSITIVE : COLOR_NONE,
      },
    ],
  };
}
