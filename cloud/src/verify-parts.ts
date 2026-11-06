/**
 * 検証の差分の集計(Issue #628。#616 の段階 3 の前半)の純ロジック。**`cloudflare:workers` を import しない**(Node でテストできる)。
 *
 * ## 役割
 * 開催日ごとに「部分」(全体・版別・締切・内訳。#625)を作って保存し、全部を合わせて確定すると、今の全件読みの集計({@link AssembledReport})と同じ値になる。
 * 段階 3 の前半では、これを今の集計と並べて計算し、{@link compareAssembled} で突き合わせて記録するだけ(画面には出さない)。後半で {@link assembleFromParts} の結果を今の集計の代わりに返す。
 *
 * ## 保存の形(kv。`VerifyCore` が使う)
 * 1 日の部分は、**kv の 1 値を {@link PART_CHUNK_BYTES} 以下**に保つため、レースの項目の並びで区切って複数のキーに分ける(本番の 1 値の上限を確認できないため、上限に依らない形にする)。
 *  - `pd:<日>:m`: メタ({@link DayMeta})。区切りの数・帯の数・版の見出し・発走時刻の欠落。
 *  - `pd:<日>:all:<i>`・`pd:<日>:ver:<i>`・`pd:<日>:close:<i>`・`pd:<日>:bd:<i>`: レースの項目の塊。
 * `<日>` は開催日(YYYYMMDD)。開催日が NULL の分析は {@link NO_DATE_DAY} の 1 日にまとめる。
 * 部分にはラベルや定義(内訳の軸のラベル・頭数帯・印のキー・補正方向の群・`directionEpsilon`・`binCount`・締切の基準と回)が入る。**それらを変えたら {@link PARTS_VERSION} を上げる**
 * (保存済みの部分は古くなる。上げると全部を作り直す)。
 */
import {
  buildVerifyPart,
  finalizeVerifyPart,
  mergeVerifyParts,
  PRODUCTION_VERIFY_CONFIG,
  type PromptVersionPart,
  type VerifyPart,
  type VerifyRacePart,
  type VerifyReport,
  type VerifyVenueFilter,
} from "../../packages/core/src/ev/verify.js";
import { buildVerifySource, countStartTimeGaps, type VerifyReadRows } from "./verify-read";
import { buildPromptVersionSummaryParts, finalizePromptVersionSummaries, mergePromptVersionSummaryParts, type PromptVersionSummary } from "./verify-versions";
import { buildCloseParts, finalizeCloseParts, mergeCloseParts, type CloseComparison, type CloseComparisonPart, type CloseRacePart, type VerifyCloseRows } from "./verify-close";
import { buildVerifyBreakdownParts, finalizeVerifyBreakdowns, mergeBreakdownParts, type BreakdownPart, type BreakdownRacePart, type BreakdownSection } from "./verify-breakdown";
import { buildConditionFactsIndex } from "./verify-race-conditions";

/** 部分の形の版。ラベル・定義・部分の形を変えたら上げる(保存済みの部分を捨てて作り直す)。 */
export const PARTS_VERSION = 1;
/** 開催日が NULL の分析をまとめる日の名前。 */
export const NO_DATE_DAY = "none";
/** kv の 1 値の大きさの目安(バイト)。1 つの項目がこれを超えるときは、その項目だけで 1 つの塊にする。 */
export const PART_CHUNK_BYTES = 100_000;

/** 1 日ぶんの部分。 */
export interface DayParts {
  readonly all: VerifyPart;
  readonly versions: readonly PromptVersionPart[];
  /** 締切の部分。再計算の表を読めなかったときは null。 */
  readonly close: CloseComparisonPart | null;
  readonly breakdown: BreakdownPart;
  readonly startTimeGaps: { readonly lost: number; readonly affecting: number };
}

/** 全部を合わせて確定した、今の集計(`CacheEntry` の一部)と同じ形の値。 */
export interface AssembledReport {
  readonly reports: Readonly<Record<VerifyVenueFilter, VerifyReport>>;
  readonly promptVersions: readonly PromptVersionSummary[];
  readonly closeByVenue: Readonly<Record<VerifyVenueFilter, CloseComparison | null>>;
  readonly breakdownByVenue: Readonly<Record<VerifyVenueFilter, { readonly sections: readonly BreakdownSection[] } | null>>;
  readonly startTimeGaps: { readonly lost: number; readonly affecting: number };
}

const VENUES: readonly VerifyVenueFilter[] = ["all", "central", "nar"];

/** 1 日ぶんの行(全件の読みと同じ列・同じ並び)から部分を作る。`close` は再計算の行(読めなければ null)。 */
export function buildDayParts(rows: VerifyReadRows, close: VerifyCloseRows | null): DayParts {
  const source = buildVerifySource(rows);
  const analyses = source.listAnalyses();
  const comboOnIds = new Set(rows.allocationMeta.filter((m) => m.includeComboOdds === 1).map((m) => m.analysisId));
  return {
    all: buildVerifyPart(source, analyses, PRODUCTION_VERIFY_CONFIG),
    versions: buildPromptVersionSummaryParts(source, analyses),
    close: close === null ? null : buildCloseParts(source, close, analyses, comboOnIds),
    breakdown: buildVerifyBreakdownParts(source, rows.bets, analyses, buildConditionFactsIndex(rows.analyses)),
    startTimeGaps: countStartTimeGaps(rows.analyses),
  };
}

const EMPTY_SOURCE_ROWS: VerifyReadRows = { analyses: [], horses: [], allocationMeta: [], bets: [], results: [], comboPayouts: [], comboImports: [] };

/** 全部の日の部分を合わせて確定する。日が 0 でも、全件の読みが 0 件のときと同じ値になる。 */
export function assembleFromParts(days: readonly DayParts[]): AssembledReport {
  const empty = buildDayParts(EMPTY_SOURCE_ROWS, null);
  const all = mergeVerifyParts([empty.all, ...days.map((d) => d.all)]);
  const reports = Object.fromEntries(VENUES.map((v) => [v, finalizeVerifyPart(all, PRODUCTION_VERIFY_CONFIG, v)])) as Record<VerifyVenueFilter, VerifyReport>;
  const promptVersions = finalizePromptVersionSummaries(mergePromptVersionSummaryParts(days.map((d) => d.versions)));
  // 1 日でも再計算の表を読めなかったなら、締切は全区分 null(全件の読みで表が読めないときと同じ)。
  const closeParts = days.map((d) => d.close);
  const closeMerged = closeParts.some((c) => c === null) ? null : mergeCloseParts(closeParts as CloseComparisonPart[]);
  const closeByVenue = Object.fromEntries(VENUES.map((v) => [v, closeMerged === null ? null : finalizeCloseParts(closeMerged, v)])) as Record<VerifyVenueFilter, CloseComparison | null>;
  const bd = finalizeVerifyBreakdowns(mergeBreakdownParts(days.map((d) => d.breakdown)));
  const breakdownByVenue = Object.fromEntries(VENUES.map((v) => [v, bd[v] === null ? null : { sections: bd[v]!.sections }])) as Record<VerifyVenueFilter, { readonly sections: readonly BreakdownSection[] } | null>;
  const startTimeGaps = { lost: days.reduce((n, d) => n + d.startTimeGaps.lost, 0), affecting: days.reduce((n, d) => n + d.startTimeGaps.affecting, 0) };
  return { reports, promptVersions, closeByVenue, breakdownByVenue, startTimeGaps };
}

// ---------------------------------------------------------------------------
// 保存の形(分ける・組み立て直す)
// ---------------------------------------------------------------------------

/** 項目の並びを、JSON の大きさが `maxBytes` 以下の塊に区切る(順は保つ)。1 つで超える項目は、その 1 つだけの塊にする。空なら塊は 0 個。 */
export function chunkBySize<T>(items: readonly T[], maxBytes: number = PART_CHUNK_BYTES): T[][] {
  const encoder = new TextEncoder();
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 2;
  for (const item of items) {
    const bytes = encoder.encode(JSON.stringify(item)).length + 1;
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 日のメタ。 */
export interface DayMeta {
  readonly v: number;
  /** 種類ごとの塊の数。 */
  readonly chunks: { readonly all: number; readonly ver: number; readonly close: number; readonly bd: number };
  readonly binCount: number;
  readonly closeNull: boolean;
  /** この日の部分に入っているレース(「レース → 日」の索引のキーを消すために持つ。1 日ぶんなので小さい)。 */
  readonly raceIds: readonly string[];
  readonly versionHeads: readonly { readonly promptVersion: string | null; readonly additionalInstructions: readonly (string | null)[] }[];
  readonly startTimeGaps: { readonly lost: number; readonly affecting: number };
}

export const dayMetaKey = (day: string): string => `pd:${day}:m`;
export const dayChunkKey = (day: string, kind: keyof DayMeta["chunks"], i: number): string => `pd:${day}:${kind}:${i}`;

/** メタが指す、塊のキーの全部(消すときに使う)。 */
export function dayChunkKeys(day: string, meta: DayMeta): string[] {
  const keys: string[] = [];
  for (const kind of ["all", "ver", "close", "bd"] as const) {
    for (let i = 0; i < meta.chunks[kind]; i++) keys.push(dayChunkKey(day, kind, i));
  }
  return keys;
}

interface VersionRaceItem {
  readonly head: number;
  readonly race: VerifyRacePart;
}

/** 1 日の部分を、kv に書くキーと値に分ける(メタを含む)。どの値も、1 項目だけで超えない限り {@link PART_CHUNK_BYTES} 以下。 */
export function encodeDay(day: string, parts: DayParts, maxBytes: number = PART_CHUNK_BYTES): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const versionItems: VersionRaceItem[] = parts.versions.flatMap((v, head) => v.part.races.map((race) => ({ head, race })));
  const sets = {
    all: chunkBySize(parts.all.races, maxBytes),
    ver: chunkBySize(versionItems, maxBytes),
    close: chunkBySize(parts.close?.races ?? [], maxBytes),
    bd: chunkBySize(parts.breakdown.races, maxBytes),
  };
  for (const kind of ["all", "ver", "close", "bd"] as const) {
    sets[kind].forEach((chunk, i) => out.set(dayChunkKey(day, kind, i), chunk));
  }
  const meta: DayMeta = {
    v: PARTS_VERSION,
    chunks: { all: sets.all.length, ver: sets.ver.length, close: sets.close.length, bd: sets.bd.length },
    binCount: parts.all.binCount,
    closeNull: parts.close === null,
    raceIds: parts.all.races.map((r) => r.raceId),
    versionHeads: parts.versions.map((v) => ({ promptVersion: v.promptVersion, additionalInstructions: v.additionalInstructions })),
    startTimeGaps: parts.startTimeGaps,
  };
  out.set(dayMetaKey(day), meta);
  return out;
}

/** {@link encodeDay} の逆。メタ・塊のどれかが無い・版が違うときは null(作り直しの対象)。 */
export function decodeDay(day: string, read: (key: string) => unknown): DayParts | null {
  const meta = read(dayMetaKey(day)) as DayMeta | undefined;
  if (meta === undefined || meta.v !== PARTS_VERSION) return null;
  const gather = <T>(kind: keyof DayMeta["chunks"]): T[] | null => {
    const items: T[] = [];
    for (let i = 0; i < meta.chunks[kind]; i++) {
      const chunk = read(dayChunkKey(day, kind, i)) as T[] | undefined;
      if (chunk === undefined) return null;
      items.push(...chunk);
    }
    return items;
  };
  const all = gather<VerifyRacePart>("all");
  const ver = gather<VersionRaceItem>("ver");
  const close = gather<CloseRacePart>("close");
  const bd = gather<BreakdownRacePart>("bd");
  if (all === null || ver === null || close === null || bd === null) return null;
  return {
    all: { binCount: meta.binCount, races: all },
    versions: meta.versionHeads.map((h, head) => ({
      promptVersion: h.promptVersion,
      additionalInstructions: h.additionalInstructions,
      part: { binCount: meta.binCount, races: ver.filter((i) => i.head === head).map((i) => i.race) },
    })),
    close: meta.closeNull ? null : { races: close },
    breakdown: { races: bd },
    startTimeGaps: meta.startTimeGaps,
  };
}

// ---------------------------------------------------------------------------
// 突き合わせ
// ---------------------------------------------------------------------------

/** 小数の許容(相対)。ユーザーの決定(2026-11-06): 件数・金額・集合・区間の端は完全一致、小数は相対 1e-12 まで。 */
export const COMPARE_REL_TOLERANCE = 1e-12;
/** 区間の端(完全一致を求める)のキー名。 */
const EXACT_KEY = /bound|lower|upper|interval/i;

/**
 * 突き合わせの前の正規化(JSON を通す)。DO の kv(structured clone)から読んだ値は `undefined`・`NaN` を保ちうるが、保存の形(JSON)では消える/null になる。
 * **両側に同じ正規化をかけて**、本番でだけ偽のずれが出ないようにする。
 */
export function normalizeForCompare<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 2 つの値の違う場所(path)を返す。同じなら空。path は `reports.all.x[3]` の形(値は含めない)。`limit` 件で打ち切る。 */
export function compareAssembled(a: unknown, b: unknown, limit = 20): string[] {
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, path: string, exact: boolean): void => {
    if (diffs.length >= limit) return;
    if (typeof x === "number" && typeof y === "number") {
      if (Object.is(x, y) || x === y) return;
      const bothInt = Number.isInteger(x) && Number.isInteger(y);
      if (exact || bothInt || !Number.isFinite(x) || !Number.isFinite(y)) {
        diffs.push(path);
      } else if (Math.abs(x - y) > COMPARE_REL_TOLERANCE * Math.max(Math.abs(x), Math.abs(y))) {
        diffs.push(path);
      }
      return;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
        diffs.push(path);
        return;
      }
      x.forEach((item, i) => walk(item, y[i], `${path}[${i}]`, exact));
      return;
    }
    if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
      const kx = Object.keys(x).sort();
      const ky = Object.keys(y).sort();
      if (kx.length !== ky.length || kx.some((k, i) => k !== ky[i])) {
        diffs.push(path);
        return;
      }
      for (const k of kx) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path === "" ? k : `${path}.${k}`, exact || EXACT_KEY.test(k));
      return;
    }
    if (x !== y) diffs.push(path);
  };
  walk(a, b, "", false);
  return diffs;
}
