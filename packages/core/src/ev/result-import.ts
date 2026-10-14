/**
 * レース結果(parseRaceResult の出力)を AnalysisStore 保存用に変換し、取込フローを組む。
 *
 * 変換ロジック(toResultEntries/summarizeImport)は core の型のみに依存する純関数。
 * 取込フロー(importRaceResult)は実IO(HTTP取得・DB保存・パース)を関数注入で受け、
 * 実ネットワーク・実DBなしで単体テストできる(bypassCache の付与や、パース失敗時に保存しないことを検証)。
 *
 * Issue #207(#182-A)で `packages/app/src/main/result-import.ts` から core へ移した(#168 と同じ型)。クラウド版(cloud/)が、app の import
 * (core のバレル経由で better-sqlite3 を巻き込む)を経由せずに使うため。app は `result-import.ts` から re-export していた(app の呼び出し元・テストは無改変。app は #287 で削除。3c1664e まで)。
 * 移設で変わったのは、`saveResult` の依存が**同期でも非同期でもよい**(戻り値を await する)ことだけ。D1(非同期)の保存を差し込める。
 * **このファイルは better-sqlite3 に依存しない**(`test/ev/native-free-modules.test.ts` が閉包を固定している)。
 */

import { RaceResultNotConfirmedError } from "../scraper/parse-race-result.js";
import { isNonStartResult } from "../scraper/parse-horse-results.js";
import type { CourseType, RaceResult } from "../scraper/types.js";
import type { RaceId } from "../scraper/ids.js";
import { raceResultUrl } from "../scraper/urls.js";
import type { RaceComboPayoutsSaveInput, RaceResultEntry } from "./analysis-store-types.js";

/**
 * 結果取込の結果(UI通知用。判別共用体)。`analysis/analysis-types.ts` の `ImportResultOutcome`(exe の `shared/analysis-types.ts` から #286 で移した)と**同じ形**
 * (同一性は `packages/core/test/ev/result-import-flow.test.ts` の末尾の型テストが固定する。app は Issue #287 で削除した)。
 * - "imported": 結果が確定していて着順を保存した(複勝払戻は無いこともある。hasPayout で判別)。
 * - "not_confirmed": まだ発走前・結果確定前で着順を取得できなかった(何も保存していない)。
 *   例外ではなく正常応答として返すことで、一括取込側が自動スキップしやすくする(Task#31)。
 */
export type ImportResultOutcome =
  | {
      readonly status: "imported";
      readonly raceId: string;
      /** 取り込んだ着順の頭数。 */
      readonly horseCount: number;
      /** 取り込んだ複勝払戻の点数。 */
      readonly placePayoutCount: number;
      /** 複勝の払戻テーブルが取得できたか(着順は取れたが払戻未確定なら false)。 */
      readonly hasPayout: boolean;
    }
  | {
      readonly status: "not_confirmed";
      readonly raceId: string;
    };

/**
 * レース結果を AnalysisStore.saveResult 用のレコード配列に変換する。
 * - 着順(FinishPosition)は数値順位のみ number にし、非数値(中止など)・null は null にする。
 *   降着(demoted)でも確定着順 value を採用する。
 * - 複勝の確定払戻(placePayout)を馬番で対応付ける。払戻の無い馬は null。
 * - 単勝の確定払戻(winPayout、Issue #100・#23-C)を馬番で対応付ける。placePayoutと同じ
 *   対応付けロジック(payoutByUmaban)。1着以外の馬は null。1着同着の場合は該当する
 *   複数馬がそれぞれ自分の払戻額を持つ(winPayoutsの件数はparsePayoutRowが固定しないため)。
 * - 通過順(passing)・上がり3F(last3f、タスク#27-A2)は各馬の値をそのまま詰める
 *   (parseRaceResult が既に非throwフォールバック済みのため、ここでの追加変換は不要)。
 * - 確定の人気(ninki)・単勝オッズ(winOdds、Issue #259)も各馬の値をそのまま詰める。クラウド版の D1 だけが保存する
 *   (exe の `AnalysisStore.saveResult` は読まない。契約は `RaceResultEntry` の JSDoc)。
 * - 取消・除外(Issue #72): 着順欄が「取消」「除外」(先頭が 取・除)の馬には `scratched: true` を付ける。
 *   馬券は返還される。`finishPosition` は従来どおり null(中止・失格と同じ)なので、区別はこの印だけが担う。
 *   判定は戦績側の `isNonStartResult`(Issue #261)と同じ関数で、語彙の定義を2箇所に持たない。
 *   取消・除外でない馬には**キー自体を付けない**(false を書くと、既存の golden・保存レコードのすべてに
 *   新しいキーが現れる。D1 側が「印のない行は 0」と読むので情報は落ちない)。
 *   観測は中央の「取消」(202606040901)と「除外」(202605040205)。地方の取消・除外の文言は未観測。
 * - 枠番(Issue #269): 各馬の `wakuban` をそのまま詰める(枠連の買い目の返還の判定に使う。契約は `RaceResultEntry.wakuban` の JSDoc)。
 */
export function toResultEntries(result: RaceResult): RaceResultEntry[] {
  const placePayoutByUmaban = new Map(
    result.placePayouts.map((p) => [p.umaban, p.payout]),
  );
  const winPayoutByUmaban = new Map(
    result.winPayouts.map((p) => [p.umaban, p.payout]),
  );
  return result.horses.map((h) => {
    const finishPosition =
      h.finishPosition !== null && h.finishPosition.kind === "順位"
        ? h.finishPosition.value
        : null;
    return {
      umaban: h.umaban,
      finishPosition,
      placePayout: placePayoutByUmaban.get(h.umaban) ?? null,
      winPayout: winPayoutByUmaban.get(h.umaban) ?? null,
      passing: h.passing,
      last3f: h.last3f,
      // 確定の人気・単勝オッズ(Issue #259)。そのまま渡す(null は null、未設定は未設定)。D1 だけが保存する(exe の codec は読まない)。
      ninki: h.ninki,
      winOdds: h.winOdds,
      // 枠番(Issue #269)。枠連の返還の判定が読む。取消・除外の馬の行にもある。取れなかった行は null のまま(頭数から導かない)。D1 だけが保存する。
      wakuban: h.wakuban,
      ...(isNonStartResult(h) ? { scratched: true } : {}),
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
   * 実着順・通過順・上がり3F・複勝払戻・組合せ払戻(ワイド・3連複、Issue #52)を保存する
   * (通常は AnalysisStore.saveResult)。courseType(面、タスク#27-A2)はレース単位の
   * 別引数として渡す。パース結果に面が無い(未解決)場合は undefined を渡し、
   * AnalysisStore 側が race_result_meta へ書き込まないようにする。
   * comboPayouts(第4引数)は parseRaceResult が返す判別共用体(RaceComboPayoutResult)を
   * そのまま渡す(boss裁定R-7: 呼び出し側〈importRaceResult〉に「undeterminedを空配列に
   * 変換する」等の判断を持たせない。素通しのみ)。
   *
   * 戻り値は同期(旧 exe の AnalysisStore。better-sqlite3。現在は core のテスト用 `test/support/analysis-store.ts`)でも Promise(クラウド版の D1)でもよい(Issue #207。`importRaceResult` が await する)。
   * reject・throw は伝播する(保存に失敗したのに imported を返さない)。
   */
  readonly saveResult: (
    raceId: RaceId,
    entries: readonly RaceResultEntry[],
    courseType?: CourseType | null,
    comboPayouts?: RaceComboPayoutsSaveInput,
  ) => void | Promise<void>;
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
  // boss裁定R-7: result.widePayouts/result.trioPayouts/result.quinellaPayouts/
  // result.exactaPayouts/result.trifectaPayouts/result.bracketQuinellaPayouts(いずれも
  // parseRaceResultが返す判別共用体)をそのまま第4引数へ渡すだけで、ここでは一切の判断
  // (undeterminedを[]に変換する・握りつぶす等)をしない。判断の余地を無くすことがR-7の要点
  // (馬連はIssue #114・#24-F1、馬単はIssue #121・#24-F2、三連単はIssue #131・#25-F、
  // 枠連はIssue #145・#26-Fでwide/trioと同型のまま追加。枠連の`umabans`は馬番ではなく枠番)。
  await deps.saveResult(raceId, toResultEntries(result), result.courseType, {
    wide: result.widePayouts,
    trio: result.trioPayouts,
    quinella: result.quinellaPayouts,
    exacta: result.exactaPayouts,
    trifecta: result.trifectaPayouts,
    bracketQuinella: result.bracketQuinellaPayouts,
  });
  return summarizeImport(raceId, result);
}
