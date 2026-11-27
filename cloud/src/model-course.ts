/**
 * 別の Worker が返すコースの参考情報(Issue #802)の検査。応答の `course` と、各馬の `course_fit`。
 *
 *  - 欄ごとに独立に検査し、崩れていればその欄だけ null にする(確率の表示・既存の検査には影響させない)。
 *  - 表示名は key から本番の側で組む(`{場名} {芝|ダ}{距離}`)。相手の `name` は、組んだ名前そのもの、または組んだ名前に key の周りに対応する語を足したものと
 *    完全に一致するときだけ使い、それ以外は組んだ名前を使う。外から来た任意の文字列は画面に出さない。
 *  - 配列は、要素が 1 つでも崩れていれば全体を落とす(一部だけ出さない)。上位 5 件まで。
 * 純ロジック。
 */

/** 場コード → 場名(中央の 10 場)。 */
export const COURSE_VENUE_NAMES: Readonly<Record<string, string>> = {
  "01": "札幌",
  "02": "函館",
  "03": "福島",
  "04": "新潟",
  "05": "東京",
  "06": "中山",
  "07": "中京",
  "08": "京都",
  "09": "阪神",
  "10": "小倉",
};

/** key の周り → 組んだ名前に足してよい語(先頭の空白を含む)。相手の `name` がこの語を持つときだけ採用する。 */
export const COURSE_RING_SUFFIX = { in: " 内回り", out: " 外回り", outin: " 外内回り", straight: " 直線" } as const;
export type CourseRing = keyof typeof COURSE_RING_SUFFIX;

const KEY_PATTERN = /^(0[1-9]|10)-(T|D)-(\d{3,4})-(in|out|outin|straight)$/;
const DISTANCE_MIN = 1000;
const DISTANCE_MAX = 4000;
/** 配列の最大の件数(超えた分は捨てる)。 */
export const COURSE_LIST_MAX = 5;

export interface CourseKeyParts {
  readonly venue: string;
  readonly surface: "芝" | "ダ";
  readonly distance: number;
  readonly ring: CourseRing;
}

/** key の形の検査。形が崩れている・距離が 1000〜4000 の外なら null。 */
export function parseCourseKey(key: unknown): CourseKeyParts | null {
  if (typeof key !== "string") return null;
  const m = KEY_PATTERN.exec(key);
  if (m === null) return null;
  const distance = Number(m[3]);
  if (distance < DISTANCE_MIN || distance > DISTANCE_MAX) return null;
  return { venue: COURSE_VENUE_NAMES[m[1]!]!, surface: m[2] === "T" ? "芝" : "ダ", distance, ring: m[4] as CourseRing };
}

/** 表示名。key が崩れていれば null。`name` は、組んだ名前(+ 周りに対応する語)と完全一致のときだけ使う。 */
export function courseDisplayName(key: unknown, name: unknown): string | null {
  const parts = parseCourseKey(key);
  if (parts === null) return null;
  const built = `${parts.venue} ${parts.surface}${parts.distance}`;
  return name === built || name === `${built}${COURSE_RING_SUFFIX[parts.ring]}` ? (name as string) : built;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export interface CourseNear {
  readonly name: string;
  readonly s: number;
}
export interface CourseNearResults extends CourseNear {
  readonly n: number;
}

/** 画面に送る今日のコース。配列が崩れていれば null(空配列は崩れではない)。 */
export interface CourseView {
  readonly name: string;
  readonly similarShape: readonly CourseNear[] | null;
  readonly similarResults: readonly CourseNearResults[] | null;
}

function readList<T extends CourseNear>(raw: unknown, withN: boolean): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const e of raw) {
    if (!isRecord(e)) return null;
    const name = courseDisplayName(e["key"], e["name"]);
    const s = e["s"];
    if (name === null || typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 1) return null;
    if (withN) {
      const n = e["n"];
      if (!isCount(n)) return null;
      out.push({ name, s, n } as unknown as T);
    } else {
      out.push({ name, s } as T);
    }
  }
  return out.slice(0, COURSE_LIST_MAX);
}

/** `course` の検査。無い・形が崩れていれば null(course 全体を落とす)。 */
export function readCourse(raw: unknown): CourseView | null {
  if (!isRecord(raw)) return null;
  const name = courseDisplayName(raw["key"], raw["name"]);
  if (name === null) return null;
  return { name, similarShape: readList<CourseNear>(raw["similar_shape"], false), similarResults: readList<CourseNearResults>(raw["similar_results"], true) };
}

export interface CourseRecord {
  readonly runs: number;
  readonly wins: number;
  readonly top3: number;
  readonly best: number | null;
}
export interface CourseFit {
  readonly same: CourseRecord;
  readonly similar: CourseRecord;
  readonly unknownRing: number;
}

function readRecord(raw: unknown): CourseRecord | null {
  if (!isRecord(raw)) return null;
  const { runs, wins, top3, best } = raw;
  if (!isCount(runs) || !isCount(wins) || !isCount(top3) || wins > top3 || top3 > runs) return null;
  if (best === null) return { runs, wins, top3, best: null };
  if (runs === 0 || typeof best !== "number" || !Number.isInteger(best) || best < 1) return null;
  return { runs, wins, top3, best };
}

/** 馬の `course_fit` の検査。崩れていれば null(その馬の欄だけ落とす)。`similar.courses` は読まない。 */
export function readCourseFit(raw: unknown): CourseFit | null {
  if (!isRecord(raw)) return null;
  const same = readRecord(raw["same"]);
  const similar = readRecord(raw["similar"]);
  const ring = raw["unknown_ring"];
  if (same === null || similar === null || !isCount(ring)) return null;
  return { same, similar, unknownRing: ring };
}
