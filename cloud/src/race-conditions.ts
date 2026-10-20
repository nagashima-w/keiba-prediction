/**
 * レースの条件(負担重量の種別・牝馬限定)の記録の窓口(Issue #421 段階 1。migration 0022 の表 `race_conditions`)。型だけの純モジュール。
 * 保存先の実装は `race-conditions-repository.ts`(D1)。RaceDay の取得ステップ(朝・発走前)が、出馬表を読んだ直後に呼ぶ。
 */

import type { WeightType } from "../../packages/core/src/scraper/race-condition";

/** 1 レースぶんの記録。 */
export interface RaceConditionRecord {
  readonly raceId: string;
  /** 負担重量の種別。出馬表から決まらなかったときは null。 */
  readonly weightType: WeightType | null;
  readonly filliesOnly: boolean;
  /** 書く時刻(エポックミリ秒)。 */
  readonly savedAt: number;
}

/** 保存の窓口(RaceDay が使う)。失敗は投げる(呼び出し側が握って警告にする)。 */
export interface RaceConditionsStore {
  save(record: RaceConditionRecord): Promise<void>;
}

/**
 * 取得した出馬表の `race`(`RaceData.race`)から、書く記録を作る。条件の欄を読めなかった(`filliesOnly` がキー無し。地方・`RaceData02` 無し)ときは null
 * (行を作らない)。純関数。
 */
export function toRaceConditionRecord(
  raceId: string,
  race: { readonly weightType?: WeightType; readonly filliesOnly?: boolean },
  savedAt: number,
): RaceConditionRecord | null {
  if (race.filliesOnly === undefined) {
    return null;
  }
  return { raceId, weightType: race.weightType ?? null, filliesOnly: race.filliesOnly, savedAt };
}
