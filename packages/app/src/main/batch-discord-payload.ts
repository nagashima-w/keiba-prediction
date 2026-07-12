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
import { collectEvPlusSummary, summarizeBatch } from "../renderer/batch-summary.js";

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

  const horseLines =
    evPlus.length > 0
      ? evPlus.map((r) => {
          const name = truncate(r.horseName, HORSE_NAME_MAX);
          return `${r.raceName} ${r.umaban}番 ${name} 補正後${formatPercent(r.adjustedProb)} 複勝下限${formatOdds(r.placeOddsMin)} EV${formatEv(r.ev)}`;
        })
      : ["EVプラスの馬はありません(該当なし)"];

  const description = fitWithOmissionNote(
    countLine,
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
