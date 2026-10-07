/**
 * 板(`GET /api/analyses/status`)の状態(Issue #186。純ロジック。DOM・タイマー・fetch に触れない)。
 *
 * 守ること:
 *  - **古い応答が新しい状態を上書きしない**: 取得を出すたびに通し番号(`nextSeq`)を取り、応答は「自分の番号が、その開催日の適用済みの最大より大きい」ときだけ採用する。
 *    ポーリング・手動の更新・起動・レース画面の状態取得が同時に動くので、応答の到着順は出した順と限らない。
 *  - **オーバーレイ**: 起動の 202(409)の直後、最初のポーリングまでの間、その (race_id, mode) の行を「待ち」などとして重ねる。
 *    外れるのは「**そのオーバーレイを作ったあとに出した取得**の応答」が採用されたときだけ(POST より前に出した取得の古い応答では消えない=古い「完了」に戻らない)。
 *    板(行)がまだ無い開催日には重ねない(行を作ると、他のレースが「未実行」に見える)。
 *  - **完了の検知**: 実行中(queued・fetched。またはオーバーレイ)を見たあとに done になった行を、(開催日, race_id, mode, queued_at)ごとに 1 回だけ返す。
 *    最初から done の行は遷移でない。オーバーレイのある行は、そのオーバーレイより前に出した取得の done(前の実行の完了)を数えない。
 */
import type { BoardRow, TaskMode, TaskStatus } from "./api";

export interface BoardCompletion {
  readonly date: string;
  readonly raceId: string;
  readonly mode: TaskMode;
}

export interface BoardStore {
  /** 取得を出す直前に呼ぶ(通し番号。単調増加)。 */
  nextSeq(): number;
  /** その開催日の行(板)があるか。 */
  has(date: string): boolean;
  /** オーバーレイを重ねた行。板が無ければ null。 */
  effectiveRows(date: string): readonly BoardRow[] | null;
  /** 行を捨てる(手動の取り直しの前)。適用済みの番号は覚えている。 */
  clear(date: string): void;
  apply(date: string, rows: readonly BoardRow[], seq: number): { readonly applied: boolean; readonly completions: readonly BoardCompletion[] };
  /** オーバーレイを重ねる。返す番号は「この番号より大きい番号の取得」だけがオーバーレイを外せる。 */
  setOverlay(date: string, raceId: string, mode: TaskMode, status: "queued" | "fetched", nowMs: number): number;
  /** 実行中(queued・fetched。オーバーレイ込み)の行がある開催日(昇順)。 */
  activeDates(): string[];
}

interface Entry {
  rows: readonly BoardRow[] | null;
  appliedSeq: number;
}

interface Overlay {
  readonly row: BoardRow;
  readonly seq: number;
}

const isActive = (status: TaskStatus): boolean => status === "queued" || status === "fetched";

export function createBoardStore(): BoardStore {
  let counter = 0;
  const entries = new Map<string, Entry>();
  /** 開催日 → ("race_id:mode" → オーバーレイ)。 */
  const overlays = new Map<string, Map<string, Overlay>>();
  /** "開催日:race_id:mode" → 最後に見た status。 */
  const lastSeen = new Map<string, TaskStatus>();
  /** 検知済みの完了("開催日:race_id:mode:queued_at")。 */
  const completed = new Set<string>();

  const taskKey = (raceId: string, mode: TaskMode): string => `${raceId}:${mode}`;
  const fullKey = (date: string, raceId: string, mode: TaskMode): string => `${date}:${raceId}:${mode}`;

  function effectiveRows(date: string): readonly BoardRow[] | null {
    const rows = entries.get(date)?.rows ?? null;
    if (rows === null) return null;
    const overlay = overlays.get(date);
    if (overlay === undefined || overlay.size === 0) return rows;
    return [...rows.filter((r) => !overlay.has(taskKey(r.raceId, r.mode))), ...[...overlay.values()].map((o) => o.row)];
  }

  return {
    nextSeq: () => (counter += 1),
    has: (date) => (entries.get(date)?.rows ?? null) !== null,
    effectiveRows,
    clear(date) {
      const entry = entries.get(date);
      if (entry !== undefined) entry.rows = null;
    },
    apply(date, rows, seq) {
      const entry = entries.get(date) ?? { rows: null, appliedSeq: 0 };
      if (seq <= entry.appliedSeq) {
        return { applied: false, completions: [] };
      }
      const overlay = overlays.get(date);
      const completions: BoardCompletion[] = [];
      for (const row of rows) {
        if (row.status !== "done") continue;
        const own = overlay?.get(taskKey(row.raceId, row.mode));
        if (own !== undefined && seq < own.seq) continue; // 起動より前に出した取得の done(前の実行の完了)
        const before = own !== undefined ? "queued" : lastSeen.get(fullKey(date, row.raceId, row.mode));
        const id = `${fullKey(date, row.raceId, row.mode)}:${row.queuedAt}`;
        if ((before === "queued" || before === "fetched") && !completed.has(id)) {
          completed.add(id);
          completions.push({ date, raceId: row.raceId, mode: row.mode });
        }
      }
      if (overlay !== undefined) {
        for (const [key, own] of [...overlay]) {
          if (seq > own.seq) overlay.delete(key);
        }
      }
      for (const row of rows) {
        lastSeen.set(fullKey(date, row.raceId, row.mode), row.status);
      }
      entry.rows = rows;
      entry.appliedSeq = seq;
      entries.set(date, entry);
      return { applied: true, completions };
    },
    setOverlay(date, raceId, mode, status, nowMs) {
      const seq = (counter += 1);
      const map = overlays.get(date) ?? new Map<string, Overlay>();
      map.set(taskKey(raceId, mode), { row: { raceId, mode, status, attempts: 0, error: null, queuedAt: nowMs, updatedAt: nowMs, prior: false, analysisId: null }, seq });
      overlays.set(date, map);
      return seq;
    },
    activeDates() {
      return [...entries.keys()].filter((date) => (effectiveRows(date) ?? []).some((r) => isActive(r.status))).sort();
    },
  };
}
