/**
 * 一括実行(Issue #251。`POST /api/analyses/run/bulk`)の上限。**依存を持たない純モジュール**: Worker の入口(handler.ts)・日単位の DO(race-day-core.ts)・画面(client/)が同じ値を共有する
 * (値を直書きして食い違わせない。handler.ts は race-day-core の値を import しない=型だけを import する慣行なので、定数はここに置く)。
 */

/** 一括で受け付けるレース数の上限。1 つの競馬場は最大 12R なので、その倍の余裕を持たせた値。 */
export const MAX_BULK_RACES = 24;

/** 一括実行の本文の上限(バイト)。`MAX_BULK_RACES` 件の 12 桁のレース ID(1 件 15 バイト前後)と他の 2 項目が十分に収まる大きさ(収まることはテストが固定する)。 */
export const BULK_BODY_MAX_BYTES = 4096;
