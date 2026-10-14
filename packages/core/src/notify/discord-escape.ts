/**
 * Discord の embed に載せる「外から来た文字列」(LLM の文章・netkeiba の馬名・レース名・会場名)の無害化(Issue #301)。
 *
 * **なぜ必要か**: embed の description・field の値では Discord がマークダウンとマスクドリンク `[文字](URL)` を描画する。
 * 外から来た文字列がそのまま載ると、通知に偽のリンク(表示は無害な文字、リンク先は別)を出させられる。
 *
 * **escape する文字**: `\ * _ ~ | ` > [ ] <` と、行頭の見出し・リスト・番号付きリスト。
 *  - マスクドリンクは `[` `]` を escape すれば成立しない。**丸括弧 `(` `)` は escape しない**: レース名の「(G1)」などに普通に出るため、
 *    タイトルなどでマークダウンとして処理されない場所では `\(` がそのまま見えてしまう(利用者に見える崩れ)。同じ理由で、普通に出うる記号の escape は最小限にしている。
 *  - `<` は `<@id`・`<:emoji:id>`・`<t:…>`・`<https://…>`(自動リンクの囲み)を殺すため。`@` 自体は escape しない(メンションの通知は送信側の `allowed_mentions: { parse: [] }` が止める)。
 *  - 行頭の規則は、見出し(`# `〜`### `)・リスト(`- `)・小さな文字(`-# `)・番号付きリスト(`1. `)。行の途中では書式にならないので、変えない。
 *
 * **平文の URL(`https://…`)は無効化しない**(判断済み): 平文の URL は文字がそのまま見えるので、リンク先は偽装にならない。偽装になるのはマスクドリンクだけで、
 * それは `[` `]` の escape で殺せる。`://` を割る方法は実 Discord でないと効果を確かめられないので採らない。
 *
 * 呼び出し側の規則: **切り詰め(`truncate`)の後に escape する**(見える文字数が escape で減らない)。escape 後の文字列を切るときは {@link dropDanglingBackslash} で
 * escape の対(`\` + 記号)を割らない。冪等ではない(2 回掛けるとバックスラッシュが増える)ので、**1 つの文字列に 1 回だけ**掛ける。
 */

/** 記号の escape の対象(`\` 自身を含む)。丸括弧は含めない。 */
const MARKDOWN_CHARS = /[\\*_~|`>[\]<]/g;

/**
 * 行頭の規則(m フラグ)。先頭の空白は許す。
 *  - `#` が 1〜3 個 + 空白: 最初の `#` を escape
 *  - `-` + 空白または `#`: `-` を escape
 *  - 数字 + `.` + 空白: `.` を escape
 */
const LINE_START = /^([ \t]*)(?:(#{1,3})(?= )|(-)(?=[ #])|(\d+)(\.)(?= ))/gm;

/** 外から来た文字列を、Discord の embed に載せても書式・リンクにならないようにする。 */
export function escapeDiscordMarkdown(text: string): string {
  return text.replace(MARKDOWN_CHARS, "\\$&").replace(LINE_START, (_m, indent: string, heading?: string, dash?: string, digits?: string, dot?: string) => {
    if (heading !== undefined) return `${indent}\\${heading}`;
    if (dash !== undefined) return `${indent}\\${dash}`;
    return `${indent}${digits ?? ""}\\${dot ?? ""}`;
  });
}

/**
 * 切り詰めた文字列の末尾に、escape の前半だけの `\`(奇数個の連続したバックスラッシュ)が残ったら、その 1 個を落とす。
 * escape 後の文字列には、バックスラッシュは `\\`(対)か `\記号`(対)でしか現れない。末尾の連続が奇数個なら、対の前半だけが残っている。
 */
export function dropDanglingBackslash(text: string): string {
  let run = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    run += 1;
  }
  return run % 2 === 1 ? text.slice(0, -1) : text;
}
