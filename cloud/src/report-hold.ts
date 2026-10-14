/**
 * 日報の時刻の下限(Issue #291)の、meta に持つ値の読み書きと、一覧からの発走時刻の取り出し。**純関数**: DO・SQL・時計を持たない。
 *
 * 手動で分析したレースの開催(競馬場・日)の最終レースの発走時刻までは、日報を依頼しない(先に分析したレースの結果がそろっただけで日報が作られ、あとから分析したレースが抜けるのを防ぐ)。
 * 開催は race_id の先頭 10 桁で決まる(中央: 年 + 場コード + 回次 + 日次、地方: 年 + 場コード + 月日。どちらも「場 × 日」で一意)。
 * meta の 1 キーに、開催ごとの記録を JSON で持つ: `{ "<先頭 10 桁>": 発走の epoch ms }`(記録できた開催)か `{ "<先頭 10 桁>": { "failures": n } }`(記録できなかった試行の回数)。
 * 下限は、記録できた開催の epoch ms の最大。
 */
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { startTimeEpochMs } from "./pre-race-time";

/** 開催ごとの記録。数値は記録できた最終レースの発走時刻(epoch ms)、`failures` は記録できなかった試行の回数。 */
export type ReportHoldEntry = number | { readonly failures: number };
export type ReportHoldMap = Readonly<Record<string, ReportHoldEntry>>;

/** race_id から開催のキー(先頭 10 桁)を取る。 */
export function holdHeadOf(raceId: string): string {
  return raceId.slice(0, 10);
}

/**
 * meta の値を読む。**壊れた JSON・想定外の形は空として扱い、例外を投げない。** 個々の値が想定外(有限でない数・負や小数の回数)の開催は、その開催だけ無かったことにする。
 */
export function parseReportHold(raw: string | null): ReportHoldMap {
  if (raw === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, ReportHoldEntry> = {};
  for (const [head, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[head] = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const failures = (value as { failures?: unknown }).failures;
      if (typeof failures === "number" && Number.isInteger(failures) && failures >= 0) {
        out[head] = { failures };
      }
    }
  }
  return out;
}

/** 日報の時刻の下限(記録できた開催の発走時刻の最大)。1 件も無ければ null。 */
export function reportHoldAtMs(holds: ReportHoldMap): number | null {
  let max: number | null = null;
  for (const value of Object.values(holds)) {
    if (typeof value === "number" && (max === null || value > max)) {
      max = value;
    }
  }
  return max;
}

/** 開催の記録を、これ以上しない(記録できた、または失敗が `maxFailures` 回に達した)か。 */
export function isHoldSettled(holds: ReportHoldMap, head: string, maxFailures: number): boolean {
  const entry = holds[head];
  if (entry === undefined) {
    return false;
  }
  return typeof entry === "number" || entry.failures >= maxFailures;
}

/** 失敗の回数を 1 つ増やした記録を返す(元は変えない)。 */
export function withHoldFailure(holds: ReportHoldMap, head: string): ReportHoldMap {
  const entry = holds[head];
  const failures = entry === undefined || typeof entry === "number" ? 0 : entry.failures;
  return { ...holds, [head]: { failures: failures + 1 } };
}

/**
 * 一覧から、開催(先頭 10 桁)の最終レースの発走時刻(epoch ms)を取り出す。**同じ開催の行のうち、読める発走時刻の最大**。
 * 読める行が無ければ null。
 * 最大のレース番号の行の時刻が読めないとき(発走後に取得した中央の一覧は、時刻が空の行を持つ)は、読める行の最大になるので、下限は本当の最終レースより早まる(部分的な保護)。
 * 地方には 12R まで無い開催(9R まで等)があるので、レース番号ではなく時刻の最大を取る。
 */
export function lastStartMsOfHead(races: readonly RaceListEntry[], head: string, kaisaiDate: string): number | null {
  let max: number | null = null;
  for (const race of races) {
    if (holdHeadOf(race.raceId) !== head || race.startTime === undefined) {
      continue;
    }
    let ms: number;
    try {
      ms = startTimeEpochMs(kaisaiDate, race.startTime);
    } catch {
      continue; // 読めない時刻の行は無かったことにする
    }
    if (max === null || ms > max) {
      max = ms;
    }
  }
  return max;
}
