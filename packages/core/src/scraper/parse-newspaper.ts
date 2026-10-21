/**
 * 新聞形式の API(`AplNewsPaper`)の応答から、各馬の前走までの**レースの条件**を読むパーサ(Issue #421 段階 1-b)。
 *
 * 応答は `{status, reason, data}` の JSON で、`data` のキーの 1 つ(`nkrace_newspaper::<race_id>`)の値が base64 + zlib の JSON。
 * 展開すると**馬ごとの配列**で、各馬の `race_result` に全走の行がある(復号は `decode-race-api.ts` を grade-winner と共有)。
 * 行のうち使うのは 3 つ(各値は `[コード, 表示, ""]` の 3 要素で、表示の `[1]` を読む):
 *  - `race_id[0]`: 走ったレースの 12 桁の ID。これが無い要素(`z_blank`・`z_brother`)は走の行ではないので除く。
 *    数字 12 桁でないもの(海外の `2026P0010105` など)も除く(結合の相手の `HorseRaceResult.raceIdRaw` も海外は null)。
 *  - `kigou[1]`: 条件の文言(例 `(国際) 牝(指)`)。空白を除いて持つ。**地方のレースの行は空**(中央を走った地方馬の行には入る)。
 *  - `jyuryo[1]`: 負担重量の種別(ハンデ・別定・馬齢・定量。地方は `見込` も)。語と完全一致しなければ null。
 *
 * 出力は race_id をキーにした素のオブジェクト(IPC/`JSON.stringify` を通っても消えない。`RaceData.jockeyStats` と同じ流儀)。
 * 同じレースは馬が違っても同じ値だった(実フィクスチャでの確認: `fixtures/newspaper_api_202608040711.json`〈中央。走の行に出るレースは 88 件で、うち 2 頭以上の行に出る 13 件〉と
 * `fixtures/newspaper_api_nar_202655090311.json`〈地方。270 件のうち 2 頭以上の行に出る 10 件〉で、race_id ごとの `kigou[1]`・`jyuryo[1]` の組の食い違いは 0)ので、最初に出た行を採る。
 * **食い違いを検査できるのは 2 頭以上の行に出るレースだけ**(上の 13 件・10 件)。確認の手順は、フィクスチャを `decodeRaceApiPayload` で展開し、race_id ごとに組を集めて異なる組が 2 つ以上あるレースを数えること
 * (再現用のスクリプトはコミットしていない)。
 */

import { decodeRaceApiPayload, findEncodedPayload, RaceApiDecodeError } from "./decode-race-api.js";
import { isFilliesOnlyCondition, WEIGHT_TYPES, type WeightType } from "./race-condition.js";

/**
 * 前走の負担重量の種別。出馬表の 4 語({@link WEIGHT_TYPES})に、地方の前走にだけ出る `見込` を足したもの。
 * `WEIGHT_TYPES` 自体は広げない(出馬表のパーサの「異なる種別が 2 種類以上なら付けない」判定を変えないため)。
 */
export const PREV_WEIGHT_TYPES = [...WEIGHT_TYPES, "見込"] as const;

export type PrevWeightType = WeightType | "見込";

/** 前走(1 レース)の条件。 */
export interface PrevRaceCondition {
  /** 負担重量の種別。読めない(空・未知の語)ときは null。 */
  readonly weightType: PrevWeightType | null;
  /** 条件の文言(空白を除く。例 `(国際)牝(指)`)。空(地方のレース)なら null。 */
  readonly condition: string | null;
  /** 牝馬限定か。`condition` が null(判定の材料が無い)なら null。 */
  readonly filliesOnly: boolean | null;
}

/** 新聞形式の API の応答が読めない(status が OK でない・構造が壊れている・復号に失敗)。 */
export class NewspaperParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewspaperParseError";
  }
}

/** `[コード, 表示, ...]` の形の値から、表示(`[1]`)の文字列を取り出す(形が違えば undefined)。 */
function displayOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const shown: unknown = value[1];
  return typeof shown === "string" ? shown : undefined;
}

function raceIdOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const id: unknown = value[0];
  return typeof id === "string" && /^\d{12}$/.test(id) ? id : undefined;
}

function weightTypeOf(shown: string | undefined): PrevWeightType | null {
  const text = shown?.trim();
  return PREV_WEIGHT_TYPES.find((w) => w === text) ?? null;
}

function conditionOf(shown: string | undefined): string | null {
  const compact = shown?.replace(/\s+/g, "") ?? "";
  return compact === "" ? null : compact;
}

/**
 * 新聞形式の API の生の応答をパースして、race_id → 前走の条件の表にする。
 * @throws NewspaperParseError status が OK でない・data が無い・復号できない・展開後が配列でない
 */
export function parseNewspaperResponse(raw: string): Readonly<Record<string, PrevRaceCondition>> {
  let response: { status?: unknown; data?: unknown };
  try {
    response = JSON.parse(raw) as { status?: unknown; data?: unknown };
  } catch (error) {
    throw new NewspaperParseError(`新聞形式APIの応答がJSONとして解析できません: ${String(error)}`);
  }
  if (response.status !== "OK") {
    throw new NewspaperParseError(`新聞形式APIの応答の status が OK ではありません(${JSON.stringify(response.status)?.slice(0, 40)})`);
  }
  if (typeof response.data !== "object" || response.data === null) {
    throw new NewspaperParseError("新聞形式APIの応答にdataがありません(status:OKなのに構造が不正)");
  }
  const found = findEncodedPayload(response.data as Record<string, unknown>);
  if (!found.ok) {
    throw new NewspaperParseError(
      found.reason === "no-key"
        ? "新聞形式APIの応答からデータキー(_last_dtで終わらないキー)を特定できません"
        : "新聞形式APIの応答データがbase64文字列ではありません",
    );
  }
  let decoded: unknown;
  try {
    decoded = decodeRaceApiPayload(found.value);
  } catch (error) {
    if (error instanceof RaceApiDecodeError) {
      throw new NewspaperParseError(
        error.stage === "inflate"
          ? `新聞形式APIの応答の復号(base64/zlib)に失敗しました: ${String(error.cause)}`
          : `新聞形式APIの復号後データのJSON解析に失敗しました: ${String(error.cause)}`,
      );
    }
    throw error;
  }
  if (!Array.isArray(decoded)) {
    throw new NewspaperParseError("新聞形式APIの復号後データが配列ではありません");
  }

  const table: Record<string, PrevRaceCondition> = {};
  for (const horse of decoded as unknown[]) {
    const rows: unknown = (horse as { race_result?: unknown } | null)?.race_result;
    if (!Array.isArray(rows)) {
      continue;
    }
    for (const row of rows as unknown[]) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const r = row as Record<string, unknown>;
      const raceId = raceIdOf(r.race_id);
      if (raceId === undefined || Object.hasOwn(table, raceId)) {
        continue; // 走の行でない・海外など(除く)/ 同じレースは最初の行を採る
      }
      const condition = conditionOf(displayOf(r.kigou));
      table[raceId] = {
        weightType: weightTypeOf(displayOf(r.jyuryo)),
        condition,
        filliesOnly: condition === null ? null : isFilliesOnlyCondition(condition),
      };
    }
  }
  return table;
}
