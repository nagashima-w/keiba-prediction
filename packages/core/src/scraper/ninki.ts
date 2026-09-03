/**
 * 「人気」文字列の数値化を担う共有ヘルパ(Issue #34)。
 *
 * ## なぜ3パーサで共有するのか
 * 単勝・複勝(`parse-odds.ts`)/ワイド・3連複(`parse-combo-odds.ts`)/地方(`parse-nar-odds.ts`)は
 * いずれも「人気」を表すオッズAPI・HTMLのセルを持ち、従来はそれぞれが同名 `toNinki` を
 * 個別に実装していた。ところが `parse-combo-odds.ts` だけが `"0"` を意図的に `null`
 * (欠損表現)へ丸めており、`parse-odds.ts`/`parse-nar-odds.ts` は `Number("0")` の
 * `0` をそのまま返していた。**同一概念・同名の関数が同一リポジトリ内で異なる契約を
 * 持つ状態**(#32でも問題視された形)であり、値だけ揃えて実装を3本残すと、次の変更で
 * 再び契約がずれる余地を残してしまう。そのため実装を本モジュール1本に統合する。
 *
 * ## 契約
 * - 非文字列(数値・`null`・`undefined`・配列等) → `null`
 * - 前後空白を trim した結果が `/^[0-9]+$/` に一致しない(空文字・非数値・"---.-"等) → `null`
 * - 数値化した結果が `0` → `null`(人気は1始まりの値域であり、`0` は値域外の欠損表現)
 *
 * ## 上限は課さない
 * 馬番(1〜18)とは異なり、人気に上限は設けない。ワイド・3連複の人気は
 * 「その組合せの人気順位」であり、出走頭数から作られる組合せ数まで達しうる
 * (実測: `parse-combo-odds.test.ts` の3連複フィクスチャは `ninki: 103` を期待する)。
 * `MAX_UMABAN`(18)等の馬番の値域に合わせて人気を切ってしまうと、実在する高い組合せ人気
 * (妙味の少ない側ではなく、むしろ人気薄=妙味の候補側)を欠損表現に潰してしまう。
 */

/** 人気文字列を数値化する。非数値・"0"(欠損表現)は null。上限は課さない(モジュールJSDoc参照)。 */
export function toNinki(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  return n === 0 ? null : n;
}
