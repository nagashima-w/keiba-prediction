import { fixtureForUrl, loadFixture } from "./pipeline-fixtures";

/**
 * Issue #680: 中央 16 頭の 202603020211 の出馬表から、馬番 15・16 の行を取り除いた 14 頭の派生(テストの中だけ。フィクスチャのファイルは足さない)。
 * JRA のオッズの見本(東京 8R・`jra_odds_*_202605050208.html`)は 14 頭なので、DO の出馬表を 14 頭にそろえると、
 * 組合せの頁が出走馬と食い違わず、JRA から採用される経路を DO の単位で通せる。取り除くのは行(`<tr class="HorseList" …>` から最初の `</tr>` まで)だけで、
 * 後ろの編集用モーダルの `<div>` は残す(件数を数える他の部分には影響しない)。
 */
export function shutuba14Html(): string {
  let html = loadFixture("shutuba_202603020211.html");
  for (const umaban of [15, 16]) {
    const cell = `<td class="Umaban8 Txt_C">${umaban}</td>`;
    const at = html.indexOf(cell);
    if (at < 0) throw new Error(`馬番 ${umaban} の行が見つからない`);
    const start = html.lastIndexOf('<tr class="HorseList"', at);
    const end = html.indexOf("</tr>", at) + "</tr>".length;
    html = html.slice(0, start) + html.slice(end);
  }
  // 枠も 14 頭の割り当てに直す(JRA の規則: 1・2 枠が 1 頭ずつ、3〜8 枠が 2 頭ずつ。枠連の頁の枠の構成と合わせる)。
  const wakuOf = (umaban: number): number => (umaban <= 2 ? umaban : Math.ceil((umaban - 2) / 2) + 2);
  let rewritten = 0;
  html = html.replace(/<td class="Waku\d Txt_C"><span>\d<\/span><\/td>(\s*)<td class="Umaban\d Txt_C">(\d+)<\/td>/g, (_all, gap: string, umaban: string) => {
    rewritten += 1;
    const waku = wakuOf(Number(umaban));
    return `<td class="Waku${waku} Txt_C"><span>${waku}</span></td>${gap}<td class="Umaban${waku} Txt_C">${umaban}</td>`;
  });
  if (rewritten !== 14) throw new Error(`枠を直した行が 14 ではない: ${rewritten}`);
  return html;
}

/** `fixtureForUrl` の出馬表だけ 14 頭にしたもの。 */
export function fixtureForUrl14(url: string): string {
  return url.includes("shutuba.html") ? shutuba14Html() : fixtureForUrl(url);
}
