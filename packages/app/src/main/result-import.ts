/**
 * レース結果(core parseRaceResult の出力)を AnalysisStore 保存用に変換し、取込フローを組む。
 *
 * 変換ロジック(toResultEntries/summarizeImport)は core の型のみに依存する純関数。
 * 取込フロー(importRaceResult)は実IO(HTTP取得・DB保存・パース)を関数注入で受け、
 * 実ネットワーク・実DBなしで単体テストできる(bypassCache の付与や、パース失敗時に保存しないことを検証)。
 */

import {
  raceResultUrl,
  type RaceId,
  type RaceResult,
  type RaceResultEntry,
} from "@keiba/core";
import type { ImportResultOutcome } from "../shared/analysis-types.js";

/**
 * レース結果を AnalysisStore.saveResult 用のレコード配列に変換する。
 * - 着順(FinishPosition)は数値順位のみ number にし、非数値(中止など)・null は null にする。
 *   降着(demoted)でも確定着順 value を採用する。
 * - 複勝の確定払戻(placePayout)を馬番で対応付ける。払戻の無い馬は null。
 */
export function toResultEntries(result: RaceResult): RaceResultEntry[] {
  const payoutByUmaban = new Map(
    result.placePayouts.map((p) => [p.umaban, p.payout]),
  );
  return result.horses.map((h) => {
    const finishPosition =
      h.finishPosition !== null && h.finishPosition.kind === "順位"
        ? h.finishPosition.value
        : null;
    return {
      umaban: h.umaban,
      finishPosition,
      placePayout: payoutByUmaban.get(h.umaban) ?? null,
    };
  });
}

/**
 * 取込結果の要約(UI通知用)を作る。
 * @param raceId 取り込んだレースID
 * @param result パース済みのレース結果
 */
export function summarizeImport(
  raceId: string,
  result: RaceResult,
): ImportResultOutcome {
  return {
    raceId,
    horseCount: result.horses.length,
    placePayoutCount: result.placePayouts.length,
    hasPayout: result.placePayouts.length > 0,
  };
}

/** importRaceResult に注入する実IO(すべて関数注入でモック可能)。 */
export interface ImportResultDeps {
  /**
   * result.html を取得する。取込は手動・低頻度で常に確定済み最新が欲しいため、
   * 呼び出し側は必ず bypassCache: true を渡してライブ取得する(発走前HTMLのキャッシュ毒化を避ける)。
   */
  readonly fetchText: (
    url: string,
    options: { readonly bypassCache: true },
  ) => Promise<string>;
  /** 取得HTMLをパースする(通常は core parseRaceResult)。結果テーブル欠落時は例外を投げる。 */
  readonly parse: (html: string) => RaceResult;
  /** 実着順+複勝払戻を保存する(通常は AnalysisStore.saveResult)。 */
  readonly saveResult: (
    raceId: RaceId,
    entries: readonly RaceResultEntry[],
  ) => void;
}

/**
 * レース結果を取り込む(取得→パース→保存→サマリ)。
 *
 * - 常にライブ取得(bypassCache: true)。結果は発走後に確定し以後不変だが、発走前に押した際に
 *   未確定HTMLをキャッシュへ載せて後続を毒化しないよう、キャッシュを迂回して毎回取得する。
 * - パースが失敗(結果テーブル欠落=着順が得られない)した場合は例外をそのまま伝播し、
 *   saveResult を呼ばない(DBを汚さない)。呼び出し側(UI)がエラーを表示する。
 * - 着順は取れるが払戻テーブルが無い場合は保存する(hasPayout=false のまま残り、UIが再取込導線を出す)。
 *
 * @param raceId 取り込むレースID(検証済み)
 * @param deps 実IOの注入
 */
export async function importRaceResult(
  raceId: RaceId,
  deps: ImportResultDeps,
): Promise<ImportResultOutcome> {
  const html = await deps.fetchText(raceResultUrl(raceId), {
    bypassCache: true,
  });
  // パース失敗(結果テーブル欠落)はここで例外送出 → 以降の保存に到達しない。
  const result = deps.parse(html);
  deps.saveResult(raceId, toResultEntries(result));
  return summarizeImport(raceId, result);
}
