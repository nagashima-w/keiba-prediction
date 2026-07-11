/**
 * 単勝・複勝オッズ(api_get_jra_odds)のパーサー。
 *
 * レスポンスは `{status, data:{official_datetime, odds:{"1":単勝, "2":複勝}}}`。
 * 単勝は `{馬番(2桁): [オッズ, "0.0", 人気]}`、複勝は `{馬番: [下限, 上限, 人気]}`。
 * 馬番キー("01"形式)は数値化し、1〜18の範囲外は構造異常として失敗させる。
 * EV計算では複勝下限(oddsMin)を用いる。
 *
 * status は3種を受理する(発走前分析が主用途のため確定前も通す):
 * - "result" 確定・"middle" 発売中: 単勝・複勝ともに通常パース。
 * - "yoso" 予想オッズ: 複勝(odds[2])が存在しないため、複勝なしを許容し place は空にする。
 * それ以外(NG等)は従来通り OddsParseError で失敗させる。
 *
 * 発売前・オッズ未確定("---.-"等の非数値)は null で表現する。
 * 単勝セル第2要素は状態により "0.0"/"0"/""(空文字)と揺れるが、単勝では未使用のため影響しない。
 */

import type {
  OddsSnapshot,
  OddsStatus,
  PlaceOdds,
  WinOdds,
} from "./types.js";

/** 馬番の上限(1〜18)。 */
const MAX_UMABAN = 18;

/** 受理する発売状態(確定・発売中・予想)。 */
const KNOWN_STATUSES: readonly OddsStatus[] = ["result", "middle", "yoso"];

/** オッズのパース失敗(構造不一致・範囲外馬番等)を表す例外。 */
export class OddsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OddsParseError";
  }
}

/** オッズAPIのJSON構造(必要部分のみ)。 */
interface OddsResponse {
  status?: unknown;
  data?: {
    official_datetime?: unknown;
    odds?: {
      "1"?: Record<string, unknown>;
      "2"?: Record<string, unknown>;
    };
  };
}

/** オッズ文字列を数値化する。非数値・未確定("---.-"等)は null。 */
function toOddsNumber(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

/** 人気文字列を数値化する。非数値・"0"欠損表現は null。 */
function toNinki(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

/** 馬番キー("01"等)を検証して数値化する。範囲外は例外。 */
function toUmaban(key: string): number {
  if (!/^[0-9]+$/.test(key)) {
    throw new OddsParseError(`馬番キーが数字ではありません(キー: "${key}")`);
  }
  const umaban = Number(key);
  if (!Number.isInteger(umaban) || umaban < 1 || umaban > MAX_UMABAN) {
    throw new OddsParseError(
      `馬番は1〜${MAX_UMABAN}の範囲である必要があります(キー: "${key}")`,
    );
  }
  return umaban;
}

/** 配列セル([...])から指定インデックスの要素を安全に取り出す。 */
function cellAt(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

/**
 * オッズAPIのJSON文字列をパースする。
 *
 * @param json api_get_jra_odds のJSON文字列
 * @returns 単勝・複勝オッズのスナップショット
 */
export function parseOdds(json: string): OddsSnapshot {
  let parsed: OddsResponse;
  try {
    parsed = JSON.parse(json) as OddsResponse;
  } catch {
    throw new OddsParseError("JSONとして解釈できませんでした");
  }

  const status = parsed.status;
  if (
    typeof status !== "string" ||
    !(KNOWN_STATUSES as readonly string[]).includes(status)
  ) {
    throw new OddsParseError(
      `status が result/middle/yoso のいずれでもありません(status: ${JSON.stringify(status)})`,
    );
  }
  const oddsStatus = status as OddsStatus;

  const oddsData = parsed.data?.odds;
  const winRaw = oddsData?.["1"];
  const placeRaw = oddsData?.["2"];
  // 単勝は全状態で必須。複勝は予想(yoso)では未発売のため欠落を許容する。
  if (winRaw === undefined) {
    throw new OddsParseError("単勝(odds[1])が欠落しています");
  }
  if (placeRaw === undefined && oddsStatus !== "yoso") {
    throw new OddsParseError("複勝(odds[2])が欠落しています");
  }

  const officialDatetime =
    typeof parsed.data?.official_datetime === "string"
      ? parsed.data.official_datetime
      : null;

  const win: Record<number, WinOdds> = {};
  for (const [key, value] of Object.entries(winRaw)) {
    const umaban = toUmaban(key);
    win[umaban] = {
      odds: toOddsNumber(cellAt(value, 0)),
      ninki: toNinki(cellAt(value, 2)),
    };
  }

  // 複勝は予想(yoso)では未発売のため空のまま返す。
  const place: Record<number, PlaceOdds> = {};
  if (placeRaw !== undefined) {
    for (const [key, value] of Object.entries(placeRaw)) {
      const umaban = toUmaban(key);
      place[umaban] = {
        oddsMin: toOddsNumber(cellAt(value, 0)),
        oddsMax: toOddsNumber(cellAt(value, 1)),
        ninki: toNinki(cellAt(value, 2)),
      };
    }
  }

  return { officialDatetime, oddsStatus, win, place };
}
