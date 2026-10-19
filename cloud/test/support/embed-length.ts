import type { CloudEmbed } from "../../src/notify-embeds";

/**
 * テスト用: embed の長さ(Discord が全体の上限に数える部分: title・description・field の name と value)。
 *
 * Issue #393 で、`src/notify-embeds.ts` の `embedLength`(production からは未使用で、テストだけが使っていた)をここへ移した。
 */
export function embedLength(embed: CloudEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}
