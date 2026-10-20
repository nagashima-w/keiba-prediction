/**
 * 日単位の DO(`RaceDayCore`)の、**日報の時刻の下限の段階**(Issue #291・#298。Issue #399〈#390 R-9b〉で `race-day-core.ts` から切り出した)。
 * **純ロジック**: `cloudflare:workers` を import しない。DO の SQLite の `race_day_meta` に持つ値(下限・依頼済み・判定済みの印)の読み書きだけを持ち、
 * 値の形の読み書きと一覧からの発走時刻の取り出しは `report-hold.ts`(純関数)にある。時計・保存先・一覧の取得口・警告の出口は注入({@link ReportHoldStageDeps})。
 * `BabaStage`(`race-day-baba.ts`)・`CloseStage`(`race-day-close-stage.ts`)と同じ形で、`setAlarm`・`rearm` には触れない(アラームの候補を返すだけで、張るのは本体の `rearm`)。
 *
 * ## 本体との境界
 *  - 記録: 本体の発走前の取得ステップ(`runPreRaceFetch`)が、出馬表の取得に成功した後・結果の行を積む前に {@link ReportHoldStage.record} を呼ぶ(1 箇所。gate への取得は、本体の `getRaceList` を注入された取得口が行う)。
 *  - 候補: 本体の `rearm` が {@link ReportHoldStage.pendingAlarmAt}(下限のアラーム)と {@link ReportHoldStage.judgePending}(下限を過ぎて未判定のときの即時の起床)を、アラームの入力に渡す。
 *  - 判定: 日報の依頼(`maybeRequestReport`。静かな日の判定は計画・結果・タスクに触れるので本体に残す)が、{@link ReportHoldStage.markJudged} と {@link ReportHoldStage.isAfterHold} を呼ぶ。
 *
 * 手順の仕様は、各メソッドの JSDoc と `race-day-core.ts` 冒頭の「日報」の項を参照。メソッドの本体は切り出し前から変えていない。
 */
import type { SqlLike } from "./sql-like";
import { parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids";
import { jstKaisaiDate } from "./auto-run-plan";
import { holdHeadOf, isHoldSettled, lastStartMsOfHead, parseReportHold, reportHoldAtMs, withHoldFailure } from "./report-hold";
import type { RaceListResult, RaceListVenue } from "./race-day-core";

/** 日報の時刻の下限を求められなかったときの警告(固定の文言。末尾に race_id を添える)。 */
const WARN_REPORT_HOLD = "日報の時刻の下限を求められませんでした";

/** 日報の作成を依頼済みの印(Issue #235。依頼した時刻〈エポックミリ秒〉)を永続化するキー。本体の `maybeRequestReport` が書き、この段階は読む。 */
export const REPORT_REQUESTED_KEY = "report_requested";

/**
 * 日報の時刻の下限(Issue #291)を永続化するキー。値は JSON(形は `report-hold.ts`): 開催(race_id の先頭 10 桁)ごとに、最終レースの発走時刻(epoch ms)か、記録できなかった試行の回数。
 * 下限はその最大。手動で分析したレースの開催の最終レースの発走まで、日報を依頼しない。
 */
export const REPORT_HOLD_KEY = "report_hold";

/**
 * 日報の時刻の下限を過ぎたあとの判定(`RaceDayCore.maybeRequestReport`)を**1回行った**印(Issue #298)を永続化するキー。値は判定したときの下限(`String(下限)`)。
 * 下限が後から伸びれば値が食い違い、新しい下限を過ぎたあとにもう一度判定の機会が来る。判定の結果(静かか・依頼の成否)は問わない。
 */
const REPORT_HOLD_JUDGED_KEY = "report_hold_judged";

export interface ReportHoldStageDeps {
  readonly sql: SqlLike;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`。鍵の形を伏せる包みを通した後のもの)。 */
  readonly onWarn: (message: string) => void;
  /** `race_day_meta` の読み(本体の `metaGet`。呼ぶたびに読む)。 */
  readonly metaGet: (key: string) => string | null;
  /** 結果ストアがあるか(無い構成では結果の仕組み全体が無効で、下限を記録しない)。 */
  readonly hasResultStore: boolean;
  /** 日報の依頼先があるか(無ければ依頼しないので、下限も要らない)。 */
  readonly hasRequestReport: boolean;
  /** その日のレース一覧(本体の `getRaceList`。取得キャッシュにあれば gate に出ない)。 */
  readonly getRaceList: (kaisaiDate: string, venue: RaceListVenue) => Promise<RaceListResult>;
  /** 一覧を引く試行の上限(開催ごと。本体の `MAX_ATTEMPTS`)。 */
  readonly maxAttempts: number;
}

export class ReportHoldStage {
  private readonly sql: SqlLike;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly metaGet: (key: string) => string | null;
  private readonly hasResultStore: boolean;
  private readonly hasRequestReport: boolean;
  private readonly getRaceList: (kaisaiDate: string, venue: RaceListVenue) => Promise<RaceListResult>;
  private readonly maxAttempts: number;

  constructor(deps: ReportHoldStageDeps) {
    this.sql = deps.sql;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.metaGet = deps.metaGet;
    this.hasResultStore = deps.hasResultStore;
    this.hasRequestReport = deps.hasRequestReport;
    this.getRaceList = deps.getRaceList;
    this.maxAttempts = deps.maxAttempts;
  }

  /** 日報の時刻の下限(Issue #291。記録が無ければ null)。meta の値が壊れていても空として扱う。 */
  holdAt(): number | null {
    return reportHoldAtMs(parseReportHold(this.metaGet(REPORT_HOLD_KEY)));
  }

  /** 下限が無い、または過ぎている(`now >= 下限`)。`isDayQuiet` に渡す真偽値(下限ちょうどは過ぎたとみなす)。 */
  isAfterHold(): boolean {
    const hold = this.holdAt();
    return hold === null || this.now() >= hold;
  }

  /** アラームの候補にする下限: 日報の依頼先があり、まだ依頼しておらず、下限が未来のときだけ(それ以外は null)。 */
  pendingAlarmAt(): number | null {
    if (!this.hasRequestReport || this.metaGet(REPORT_REQUESTED_KEY) !== null) {
      return null;
    }
    const hold = this.holdAt();
    return hold !== null && this.now() < hold ? hold : null;
  }

  /**
   * 下限を過ぎていて、その下限での判定(`RaceDayCore.maybeRequestReport`)がまだ行われていない(Issue #298)。日報の依頼先があり、未依頼のときだけ。
   * タスクが無い条件は呼び出し側(`RaceDayCore.rearm`)が付ける(`AlarmInputs.reportJudgePending`)。
   *
   * **冗長な防御が 2 つある**(Issue #300。外しても結果は変わらず、テストでは区別できない。残す理由は、将来の変更で前提が崩れたときの安全側):
   *  - 「依頼済みなら偽」: 依頼より前に印が書かれ(判定は依頼の前に行う)、依頼後は下限が動かない({@link ReportHoldStage.record} も依頼済みなら引かない)ので、外しても全緑。
   *  - 印の値の照合(`!== String(hold)`): 下限が未来へ伸びたときは、未来の下限のアラーム({@link ReportHoldStage.pendingAlarmAt})が起床させて判定するので、照合を `=== null` に変えても全緑。
   *    照合が単独で効くのは「印が過去の下限の値のまま、下限を過ぎている」場合だけで、下限は後退しない(開催ごとに記録できたら再び引かず、下限はその最大なので、新しい開催の分析で伸びるだけ)ので構成上到達しない。
   */
  judgePending(): boolean {
    if (!this.hasRequestReport || this.metaGet(REPORT_REQUESTED_KEY) !== null) {
      return false;
    }
    const hold = this.holdAt();
    return hold !== null && this.now() >= hold && this.metaGet(REPORT_HOLD_JUDGED_KEY) !== String(hold);
  }

  /** 下限を過ぎた判定を行った印を書く(下限がある・過ぎているときだけ。値は下限)。判定の結果は問わない。 */
  markJudged(): void {
    const hold = this.holdAt();
    if (hold === null || this.now() < hold) {
      return;
    }
    this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", REPORT_HOLD_JUDGED_KEY, String(hold));
  }

  /**
   * 発走前の分析(取得ステップ)を行ったレースの**開催の最終レースの発走時刻**を、日報の時刻の下限として記録する(Issue #291)。
   * 手動の分析だけの日は、先に分析したレースの結果がそろっただけで日報が依頼され、あとから分析するレースが抜けていた。下限までは日報を依頼しない(`RaceDayCore.maybeRequestReport`)。
   * 時刻は、その日のレース一覧(`getRaceList`。手動の分析は画面でこの一覧から選ぶので、通常は取得キャッシュに載っていてリクエストは増えない)の、同じ開催(race_id の先頭 10 桁)の行の読める発走時刻の最大。
   * 最大のレース番号の行の時刻が読めないと、下限は本当の最終レースより早まる(部分的な保護)。
   *
   * **一覧の参照は 1 つの開催につき 1 回まで**: 記録できた開催は引かない。記録できなかった試行(一覧が取れない・該当の開催が無い・時刻が読めない・例外)は開催ごとに {@link ReportHoldStageDeps.maxAttempts} 回まで数え、
   * 上限に達したらその日はもう引かない(自動の分析も同じ取得ステップを通るので、一覧が取れない日に毎レース引き続けない)。
   * 引かない条件: 結果ストアか日報の依頼先が無い / 開催日が過去(日報は後日の cron の経路) / 日報を依頼済み(作り直さない)。
   * **失敗しても取得ステップは失敗にしない**(今と同じ動き = 待たない。固定の警告だけを残し、例外の本文・拒否の本文は出さない)。例外は外へ漏らさない。
   */
  async record(raceId: string): Promise<void> {
    try {
      const kaisaiDate = this.metaGet("kaisai_date");
      if (
        !this.hasResultStore ||
        !this.hasRequestReport ||
        kaisaiDate === null ||
        kaisaiDate < jstKaisaiDate(this.now()) ||
        this.metaGet(REPORT_REQUESTED_KEY) !== null
      ) {
        return;
      }
      const head = holdHeadOf(raceId);
      if (isHoldSettled(parseReportHold(this.metaGet(REPORT_HOLD_KEY)), head, this.maxAttempts)) {
        return;
      }
      let startMs: number | null = null;
      try {
        const kind = venueKindOfRaceId(parseRaceId(raceId));
        const list = await this.getRaceList(kaisaiDate, kind === "central" ? "central" : "nar");
        if (list.ok) {
          startMs = lastStartMsOfHead(list.races, head, kaisaiDate);
        }
      } catch {
        startMs = null;
      }
      // 一覧を待つあいだに他の記録が増えうるので、読み直してから書く(await の後〜書き込みは同期)。
      const holds = parseReportHold(this.metaGet(REPORT_HOLD_KEY));
      const next = startMs === null ? withHoldFailure(holds, head) : { ...holds, [head]: startMs };
      this.sql.exec(
        "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        REPORT_HOLD_KEY,
        JSON.stringify(next),
      );
      if (startMs === null) {
        this.onWarn(`${WARN_REPORT_HOLD}(${raceId})。待たずに続けます`);
      }
    } catch {
      this.onWarn(`${WARN_REPORT_HOLD}(${raceId})。待たずに続けます`);
    }
  }
}
