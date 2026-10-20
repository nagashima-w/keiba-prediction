/**
 * 画面のキャッシュ・操作の状態を引く鍵(`app.ts` と、そこから切り出した `bulk-control.ts` などが共有する。Issue #400 R-11)。
 *  - 一覧: (開催日, 区分)。一覧の取得・場ごとの開閉・一括実行の状態の鍵
 *  - レース: (開催日, race_id)。状態・過去の分析・結果の開閉の鍵
 */
import type { Venue } from "./route";

export const listKey = (date: string, venue: Venue): string => `${date}:${venue}`;
export const raceKey = (date: string, raceId: string): string => `${date}:${raceId}`;
