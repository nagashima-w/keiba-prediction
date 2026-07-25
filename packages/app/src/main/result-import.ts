/**
 * レース結果(core parseRaceResult の出力)を AnalysisStore 保存用に変換し、取込フローを組む。
 *
 * 変換ロジック(toResultEntries/summarizeImport)は core の型のみに依存する純関数。
 * 取込フロー(importRaceResult)は実IO(HTTP取得・DB保存・パース)を関数注入で受け、
 * 実ネットワーク・実DBなしで単体テストできる(bypassCache の付与や、パース失敗時に保存しないことを検証)。
 */

import {
  raceResultUrl,
  RaceResultNotConfirmedError,
  type CourseType,
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
 * - 通過順(passing)・上がり3F(last3f、タスク#27-A2)は各馬の値をそのまま詰める
 *   (parseRaceResult が既に非throwフォールバック済みのため、ここでの追加変換は不要)。
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
      passing: h.passing,
      last3f: h.last3f,
    };
  });
}

/**
 * 取込結果の要約(UI通知用)を作る。結果が確定している場合のみ呼ばれる
 * (未確定は importRaceResult 側で RaceResultNotConfirmedError を捕捉して別応答を返す)。
 * @param raceId 取り込んだレースID
 * @param result パース済みのレース結果
 */
export function summarizeImport(
  raceId: string,
  result: RaceResult,
): ImportResultOutcome {
  return {
    status: "imported",
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
  /**
   * 実着順・通過順・上がり3F・複勝払戻を保存する(通常は AnalysisStore.saveResult)。
   * courseType(面、タスク#27-A2)はレース単位の別引数として渡す。パース結果に面が
   * 無い(未解決)場合は undefined を渡し、AnalysisStore 側が race_result_meta へ
   * 書き込まないようにする。
   */
  readonly saveResult: (
    raceId: RaceId,
    entries: readonly RaceResultEntry[],
    courseType?: CourseType | null,
  ) => void;
}

/**
 * レース結果を取り込む(取得→パース→保存→サマリ)。
 *
 * - 常にライブ取得(bypassCache: true)。結果は発走後に確定し以後不変だが、発走前に押した際に
 *   未確定HTMLをキャッシュへ載せて後続を毒化しないよう、キャッシュを迂回して毎回取得する。
 * - パースが RaceResultNotConfirmedError(未確定レース。#All_Result_Table はあるが結果行が
 *   0件)を投げた場合は例外を伝播せず、saveResult も呼ばずに { status: "not_confirmed" } を
 *   正常応答として返す。着順を保存しないため取込済み扱いにはならず、確定後に再取込できる。
 *   IPC越しに例外でなく正常応答で返すのは、一括取込(Task#31)が未確定レースを例外ハンドリング
 *   無しで自動スキップできるようにするため。
 * - それ以外のパース失敗(RaceResultParseError等。結果テーブル欠落=構造異常)は例外をそのまま
 *   伝播し、saveResult を呼ばない(DBを汚さない)。呼び出し側(UI)がエラーを表示する。
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
  let result: RaceResult;
  try {
    result = deps.parse(html);
  } catch (e) {
    if (e instanceof RaceResultNotConfirmedError) {
      // 未確定レース: 保存せず正常応答として返す(取込済み扱いにしない)。
      return { status: "not_confirmed", raceId };
    }
    // 構造異常等はそのまま伝播 → 以降の保存に到達しない。
    throw e;
  }
  deps.saveResult(raceId, toResultEntries(result), result.courseType);
  return summarizeImport(raceId, result);
}
