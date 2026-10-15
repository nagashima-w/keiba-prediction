/**
 * 予想印の補修(Issue #317)— LLM の印が規則に違反しても、全消しにせず「外れた部分だけ」直す純関数。
 *
 * 背景: 以前は、聞き直してもなお印が規則に違反した応答は、確率の補正だけ採用して印を全馬 null にしていた(`marksDropped`)。
 * 「全レースに印を付けたい」というユーザー要望により、LLM の印をできるだけ残して規則に合わせる。
 * (Task#22 の「印は LLM 判断が本質のため機械生成の代替はしない」から、確率の補正が有効な応答に限って変更した。
 *  LLM 自体が失敗して確率も prior に戻ったレースには、従来どおり印を付けない。)
 *
 * 規則(`parse-response.ts` の `MARK_COUNT_RANGES`・本線の優先順位): ◎ちょうど1頭 / 〇・▲は0〜1頭 / △は0〜3頭 / ☆・注は0〜1頭 /
 * 本線(◎〇▲△)は上から途切れない / 既知の6種以外の印文字は無い。
 *
 * ## 補修の手順(決定的。乱数・時刻を使わない)
 * 馬の順位 = 補正後の3着内率(`adjustedProb`)の降順、同値は馬番の小さい方が上。
 *  1. 未知の印文字の馬は、印なしにする(元の印は「不明」と記録する)。
 *  2. ☆・注は、それぞれ順位が最上位の1頭だけ残し、余りは印なしにする。
 *  3. 本線は、**元の印の格(◎→〇→▲→△)の高い順、同格は馬の順位順**に並べ、上から枠 `[◎, 〇, ▲, △, △, △]` に1頭ずつ詰める。
 *     枠からはみ出した馬は印なしにする。この1パスで、「頭数の超過を下の印へ繰り下げる」「途切れを上へ詰める」
 *     「◎が無いとき本線の最上位を◎に繰り上げる」が同時に済む(LLM が付けた格の順序は保つ)。
 *  4. 本線が1頭も無いときは、全馬のうち順位が最上位の馬を◎にする(その馬が☆・注を持っていたら外れる。1頭1印)。
 * 馬が0頭なら何もしない。補修後は必ず規則を満たす(性質テストで固定)。
 *
 * 印以外の項目(確率・根拠・強調材料など)は一切変えない。入力は書き換えない。
 */

import type { ParsedHorseResult, PredictionMark } from "./parse-response.js";

/**
 * 補修前の印の表現(固定の語彙)。既知の6種、印なしを表す `"なし"`、未知の印文字だったことを表す `"不明"`。
 * **LLM の生の文字列は入らない**(保存・画面・通知に出してよい値だけ)。
 */
export type MarkOrigin = PredictionMark | "なし" | "不明";

/** 補修で印が変わった馬 1 頭の記録。 */
export interface MarkRepairChange {
  readonly umaban: number;
  /** 補修前の印(未知の印文字は `"不明"`、印なしは `"なし"`)。 */
  readonly from: MarkOrigin;
  /** 補修後の印(印なしは null)。 */
  readonly to: PredictionMark | null;
}

/** {@link repairMarks} の結果。 */
export interface RepairMarksResult {
  /** 補修後の horses(入力と同じ並び。印以外は入力のまま)。 */
  readonly horses: ParsedHorseResult[];
  /** 印が変わった馬(入力の並び)。変わらなければ空。 */
  readonly changes: MarkRepairChange[];
}

/** 本線の印の枠(上から)。◎1・〇1・▲1・△3。 */
const MAIN_SLOTS: readonly PredictionMark[] = ["◎", "〇", "▲", "△", "△", "△"];

/** 本線の格(小さいほど上)。 */
const MAIN_TIER: Readonly<Partial<Record<PredictionMark, number>>> = { "◎": 0, "〇": 1, "▲": 2, "△": 3 };

/** 補修前の印の表現を返す。 */
function originOf(h: ParsedHorseResult, unknown: ReadonlySet<number>): MarkOrigin {
  if (unknown.has(h.umaban)) return "不明";
  return h.mark ?? "なし";
}

/**
 * 予想印を規則に合わせて直す。
 * @param horses 補正済みの全馬(`mark` は LLM の元の印。未知の印文字の馬は null)
 * @param unknownUmabans 未知の印文字だった馬の馬番
 */
export function repairMarks(horses: readonly ParsedHorseResult[], unknownUmabans: readonly number[]): RepairMarksResult {
  if (horses.length === 0) {
    return { horses: [], changes: [] };
  }
  const unknown = new Set(unknownUmabans);

  // 順位: 率の降順 → 馬番の昇順。
  const ranked = [...horses].sort((a, b) => b.adjustedProb - a.adjustedProb || a.umaban - b.umaban);
  const rankOf = new Map(ranked.map((h, i) => [h.umaban, i]));
  const byRank = (a: ParsedHorseResult, b: ParsedHorseResult): number => rankOf.get(a.umaban)! - rankOf.get(b.umaban)!;

  // 補修後の印(馬番 → 印)。まず全馬を印なしにして、残す印だけ入れる。
  const next = new Map<number, PredictionMark | null>(horses.map((h) => [h.umaban, null]));

  // 元の印(未知の印文字の馬は印なし扱い)。
  const original = (h: ParsedHorseResult): PredictionMark | null => (unknown.has(h.umaban) ? null : h.mark);

  // 2. ☆・注: それぞれ順位が最上位の1頭だけ残す。
  for (const side of ["☆", "注"] as const) {
    const holders = horses.filter((h) => original(h) === side).sort(byRank);
    if (holders.length > 0) next.set(holders[0]!.umaban, side);
  }

  // 3. 本線: 元の格 → 順位 の順に並べ、枠に上から詰める。
  const main = horses
    .filter((h) => {
      const m = original(h);
      return m !== null && MAIN_TIER[m] !== undefined;
    })
    .sort((a, b) => MAIN_TIER[original(a)!]! - MAIN_TIER[original(b)!]! || byRank(a, b));
  main.forEach((h, i) => {
    next.set(h.umaban, i < MAIN_SLOTS.length ? MAIN_SLOTS[i]! : null);
  });

  // 4. 本線が1頭も無いとき: 全馬で順位が最上位の馬を◎にする(その馬の☆・注は上書きで外れる)。
  if (main.length === 0) {
    next.set(ranked[0]!.umaban, "◎");
  }

  const repaired = horses.map((h) => ({ ...h, mark: next.get(h.umaban)! }));
  const changes: MarkRepairChange[] = [];
  horses.forEach((h, i) => {
    const from = originOf(h, unknown);
    const to = repaired[i]!.mark;
    // 「なし → 印なし(null)」は変更ではない。「不明 → 印なし」は変更(未知の印文字を落とした)。
    if (from !== (to ?? "なし")) changes.push({ umaban: h.umaban, from, to });
  });
  return { horses: repaired, changes };
}
