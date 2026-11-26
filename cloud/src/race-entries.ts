/**
 * 出馬表の D1 への保存の窓口(Issue #799。migration 0050 の表 `race_entry_races`・`race_entry_horses`)。型と純関数だけの純モジュール。
 * 保存先の実装は `race-entries-repository.ts`(D1)。RaceDay の事前分析(morning)の計算ステップが、前日に読んだ出馬表を渡す。
 * **保存するだけ**: 分析・画面・LLM には使わない。別の Worker が D1 を読んで出馬表を得るための置き場である。
 */

import type { RaceData } from "../../packages/core/src/scraper/scrape-race";
import type { ScratchStatus } from "../../packages/core/src/scraper/types";

/** 1 レースぶんの行(`race_entry_races`)。 */
export interface RaceEntryRaceRecord {
  readonly raceId: string;
  /** 開催日(YYYYMMDD。analyses.kaisai_date と同じ形)。 */
  readonly kaisaiDate: string;
  /** 競馬場コード(race_id の 5〜6 桁目。中央 01〜10・地方はそれ以外)。 */
  readonly venueCode: string;
  /** 芝・ダ・障。 */
  readonly courseType: string;
  /** 距離(m)。 */
  readonly distance: number;
  /** クラス。中央は正準ラベル、地方は生のトークン。読めなければ null。 */
  readonly raceClass: string | null;
  /** グレード(G1 など)。無ければ null。 */
  readonly grade: string | null;
  /** 発走時刻(JST の HH:MM。ゼロ詰め)。読めなければ null。 */
  readonly startTime: string | null;
  /** 書く時刻(エポックミリ秒)。 */
  readonly savedAt: number;
}

/** 1 頭ぶんの行(`race_entry_horses`)。取消・除外の馬は騎手・調教師・斤量・性齢が null。 */
export interface RaceEntryHorseRecord {
  readonly umaban: number;
  readonly waku: number;
  readonly horseId: string;
  readonly jockeyId: string | null;
  readonly trainerId: string | null;
  readonly kinryo: number | null;
  readonly sex: string | null;
  readonly age: number | null;
  /** 取消・除外・不明。出走する馬は null。 */
  readonly scratch: ScratchStatus | null;
}

/** 1 レースの保存の単位。 */
export interface RaceEntriesRecord {
  readonly race: RaceEntryRaceRecord;
  /** 馬番の昇順。 */
  readonly horses: readonly RaceEntryHorseRecord[];
}

/** 保存の窓口(RaceDay が使う)。失敗は投げる(呼び出し側が握って警告にする)。 */
export interface RaceEntriesStore {
  save(record: RaceEntriesRecord): Promise<void>;
}

/** {@link toRaceEntriesRecord} が読む `RaceData` の部分。 */
export type RaceEntriesSource = Pick<RaceData, "race"> & { readonly horses: readonly Pick<RaceData["horses"][number], "shutuba">[] } & { readonly meta: { readonly scratched?: RaceData["meta"]["scratched"] } };

/**
 * 取得した出馬表から、書く記録を作る。取消・除外の馬(`meta.scratched`)も scratch つきの行にして残す。
 * 馬が 1 頭も無い(出走馬も取消馬も無い)ときは null(書かない。書くと、そのレースの既存の行を全部消す文になる)。純関数。
 */
export function toRaceEntriesRecord(raceId: string, kaisaiDate: string, data: RaceEntriesSource, savedAt: number): RaceEntriesRecord | null {
  const running: RaceEntryHorseRecord[] = data.horses.map(({ shutuba: s }) => ({
    umaban: s.umaban,
    waku: s.wakuban,
    horseId: s.horseId,
    jockeyId: s.jockeyId,
    trainerId: s.trainerId,
    kinryo: s.kinryo,
    sex: s.sex,
    age: s.age,
    scratch: null,
  }));
  const scratched: RaceEntryHorseRecord[] = (data.meta.scratched ?? []).map((s) => ({
    umaban: s.umaban,
    waku: s.wakuban,
    horseId: s.horseId,
    jockeyId: null,
    trainerId: null,
    kinryo: null,
    sex: null,
    age: null,
    scratch: s.status,
  }));
  const horses = [...running, ...scratched].sort((a, b) => a.umaban - b.umaban);
  if (horses.length === 0) {
    return null;
  }
  const info = data.race;
  return {
    race: {
      raceId,
      kaisaiDate,
      venueCode: raceId.slice(4, 6),
      courseType: info.courseType,
      distance: info.distance,
      raceClass: info.raceClass ?? null,
      grade: info.grade ?? null,
      // 出馬表の時刻は 1 桁の時間(`9:50`)を取りうる。`HH:MM` に揃える。
      startTime: info.startTime === undefined ? null : info.startTime.padStart(5, "0"),
      savedAt,
    },
    horses,
  };
}
