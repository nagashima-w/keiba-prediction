/**
 * JRA の馬ごとの頁(`accessU.html`)の cname の末尾の 2 桁の計算(Issue #697。根拠は `docs/investigations/past-blinker-695.md` §10)。
 *
 * 2 桁 = (K + Σ 重み_i × 桁_i) mod 256 を、大文字の 16 進 2 桁で書く(i は馬の ID 10 桁の左から)。重みは、フィクスチャのリンク 123 組(1983〜2024 年生まれ)と、
 * 本物の頁で開いた 3 頭(2019106837・2018104667・2020103173)で確かめた(`test/jra-horse-cname.test.ts` が固定)。
 *
 * **重み 0 の桁(2 桁目と 5 桁目)は、手元の組では値が動かない桁**(2 桁目は 0 か 9、5 桁目は 1)。重みが本当に 0 かは確かめられていないので、
 * その桁がほかの値の ID は「計算できない」として null を返す(呼び出し側が飛ばす)。
 */

const K = 177;
/** 馬の ID の左から 10 桁の重み。 */
const WEIGHTS: readonly number[] = [143, 0, 107, 140, 0, 206, 239, 49, 16, 115];

/** 馬の ID(10 桁の数字)から末尾の 2 桁を作る。10 桁の数字でない、または重み 0 の桁が確かめた値以外のときは null。 */
export function horseCnameSuffix(horseId: string): string | null {
  if (!/^[0-9]{10}$/.test(horseId)) return null;
  const d = (i: number): number => Number(horseId[i]);
  if (d(1) !== 0 && d(1) !== 9) return null;
  if (d(4) !== 1) return null;
  let sum = K;
  for (let i = 0; i < 10; i++) sum += WEIGHTS[i]! * d(i);
  return (sum % 256).toString(16).toUpperCase().padStart(2, "0");
}
