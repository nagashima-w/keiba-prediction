/**
 * 板の行 → バッジ(一覧とレース画面が共有。Issue #578-3)。`list.ts` と `race.ts` が互いを import していた循環を、
 * 両方が使う部品(バッジと板の行の検索)をここに切り出して無くした。挙動は変えていない。
 */
import type { BoardRow, TaskMode } from "./api";

export interface Badge {
  readonly label: string;
  readonly tone: "none" | "wait" | "ok" | "fail";
}

/** 板の行 → バッジ。行が無ければ「未実行」。 */
export function badgeOf(row: BoardRow | undefined): Badge {
  if (row === undefined) return { label: "未実行", tone: "none" };
  switch (row.status) {
    case "queued":
      return { label: "待ち", tone: "wait" };
    case "fetched":
      return { label: "取得済み", tone: "wait" };
    case "done":
      return { label: "完了", tone: "ok" };
    case "failed":
      return { label: "失敗", tone: "fail" };
  }
}

/** 板から (race_id, mode) の行を探す(race_id だけで引くと、同じレースの 2 つのモードを取り違える)。 */
export function pick(board: readonly BoardRow[], raceId: string, mode: TaskMode): BoardRow | undefined {
  return board.find((r) => r.raceId === raceId && r.mode === mode);
}
