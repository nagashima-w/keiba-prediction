/**
 * 検証画面だけが使う表示の部品(Issue #219)。
 *
 * 率・金額・補正幅・各種ラベルの整形は、core の `packages/core/src/view/verify-format.ts` の 1 本にまとめた(Issue #397 R-3)。
 * 以前はここに同名・同出力の関数を複製して一致をテストで固定していたが、複製の理由(旧 exe の renderer が app の閉包から引けなかった)が #287 でなくなった。
 * 使う側は core のファイルを直接 import する。ここに残るのは、クライアントだけが使う券種の並びである。
 */
import type { ProposedBetType } from "./api-verify";

/** 配分ベースの券種の表示順と名前(旧 exe の検証画面の「内訳」の並びに合わせた)。 */
export const PROPOSED_BET_LABELS: ReadonlyArray<{ readonly type: ProposedBetType; readonly label: string }> = [
  { type: "place", label: "複勝" },
  { type: "win", label: "単勝" },
  { type: "wide", label: "ワイド" },
  { type: "quinella", label: "馬連" },
  { type: "bracketQuinella", label: "枠連" },
  { type: "exacta", label: "馬単" },
  { type: "trio", label: "3連複" },
  { type: "trifecta", label: "三連単" },
];
