/**
 * 過去の結果の毎晩の取得の Durable Object `RaceArchiveFetchDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #554〈#549-A3〉)。
 *
 * ロジックは `RaceArchiveFetchCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・gate(`NetkeibaGate`。`status()` と `fetchRaw()`)・
 * 日単位の DO(`RaceDay`。**`getPlanProgress` の読み取りだけ**)・保存(`D1RaceArchiveStore`。R2 → D1 の目録)・Discord を配線するだけの薄いラッパ
 * (`cloudflare:workers` を持つため、テストでは import できない)。他の DO とは別のインスタンス・別のアラームなので、定時の自動実行や結果の補完とは干渉しない。
 * netkeiba への取得は、gate の `fetchRaw` だけを通る(この DO は socket も `fetch` も持たない)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v11)に固定される。
 *
 * 動きを変える設定は Worker の var・secret の 1 つだけ(任意): `RACE_ARCHIVE_NIGHTLY_LIMIT`(1 晩のリクエスト数を**下げる**上書き。未設定は上限なし。文字列 `"0"` だけは取得を止める〈結果の補完の `RESULT_BACKFILL_NIGHTLY_LIMIT` と同じ流儀〉)。
 * **smoke 専用の `options()` の差し替え**(開始時刻・時間帯・間隔を外す)は `smoke-worker.ts` のサブクラスだけが行う。本番のエントリ(`worker.ts`)はそのサブクラスを import しない
 * (`test/bundle-guard.test.ts` が、本番のバンドルに入らないことを固定している)。
 */
import { DurableObject } from "cloudflare:workers";
import type { GateStatus } from "./gate-core";
import { parseLimitOverride } from "./limit-override";
import { buildArchiveNoticeEmbed } from "./notify-embeds";
import { createDiscordNotifier } from "./notify-send";
import {
  ARCHIVE_NIGHTLY_LIMIT_MAX,
  isArchiveFetchDisabled,
  RaceArchiveFetchCore,
  type ArchiveFetchOptions,
  type PlanProgressLike,
} from "./race-archive-fetch-core";
import type { RaceArchiveFetchStatus } from "./race-archive-fetch-types";
import { D1RaceArchiveStore, type RaceArchiveBucket, type RaceArchiveDb } from "./race-archive-repository";
import type { GateResult } from "./gate-core";

/** netkeiba への取得の出口(NetkeibaGate)の固定名。handler.ts・race-day-do.ts の GATE_NAME と同じ。 */
const GATE_NAME = "gate";

export interface RaceArchiveFetchEnv {
  DB: RaceArchiveDb;
  /** R2(`saveRaceArchive` が get と put だけを使う。Class A・B の計数と柵は D1 の `r2_ops`)。 */
  ANALYSIS_DETAIL: RaceArchiveBucket;
  /** gate。`status()` と `fetchRaw()` だけを呼ぶ。 */
  NETKEIBA_GATE: { idFromName(name: string): any; get(id: any): { status(): Promise<GateStatus>; fetchRaw(url: string): Promise<GateResult> } };
  /** 日単位の DO。**`getPlanProgress` だけ**を呼ぶ(その日が中央の開催日かの判定。netkeiba には出ない)。 */
  RACE_DAY: { idFromName(name: string): any; get(id: any): { getPlanProgress(): Promise<PlanProgressLike> } };
  /** Discord の Webhook URL(Worker の secret)。未登録・形式不正なら通知しない(状態は変わる)。 */
  DISCORD_WEBHOOK_URL?: string;
  /**
   * 任意(var・secret)。1 晩のリクエスト数を**下げる**上書き(1 以上の整数。それ以外は無視して上限なし)。**文字列 `"0"` だけは取得を止める**(アラームを張らず、起きても何もしない。state は `disabled`)。
   * ★止める var を `RACE_ARCHIVE_FETCH` にしてはならない: それは DO の binding の名前で、同じ名前の var は binding と衝突する(env.RACE_ARCHIVE_FETCH が文字列になり、DO を引けなくなる)。
   */
  RACE_ARCHIVE_NIGHTLY_LIMIT?: string;
}

export class RaceArchiveFetchDO extends DurableObject<RaceArchiveFetchEnv> {
  private readonly core: RaceArchiveFetchCore;

  constructor(ctx: DurableObjectState, env: RaceArchiveFetchEnv) {
    super(ctx, env);
    const store = new D1RaceArchiveStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL });
    const notifier = createDiscordNotifier(env.DISCORD_WEBHOOK_URL);
    const gate = (): ReturnType<RaceArchiveFetchEnv["NETKEIBA_GATE"]["get"]> => env.NETKEIBA_GATE.get(env.NETKEIBA_GATE.idFromName(GATE_NAME));
    this.core = new RaceArchiveFetchCore(
      {
        sql: ctx.storage.sql,
        now: () => Date.now(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        gate: {
          status: async () => {
            const s = await gate().status();
            return { blockedUntil: s.blockedUntil, consecutiveRefusals: s.consecutiveRefusals, lastStartAt: s.lastStartAt, pending: s.pending };
          },
          fetchRaw: (url) => gate().fetchRaw(url),
        },
        planProgress: (kaisaiDate) => this.planProgress(kaisaiDate),
        archive: {
          saveRaceArchive: (input) => store.saveRaceArchive(input),
          getCatalogEntry: (raceId) => store.getCatalogEntry(raceId),
        },
        notify: async (notice) => {
          if (notifier === undefined) {
            console.log("race-archive: notice skipped reason=webhook-unavailable");
            return;
          }
          await notifier.send({ embeds: [buildArchiveNoticeEmbed(notice)] });
        },
        log: (line, level) => (level === "error" ? console.error(line) : console.log(line)),
      },
      this.options(),
    );
  }

  /**
   * その日の計画(中央の行で開催日かを決める材料)。本番は日単位の DO の読み取り専用の RPC。
   * **smoke 専用のサブクラスだけが差し替える**(smoke の日は計画が無く、判定不能で休んでしまうため。`options()` と同じ理由)。
   */
  protected planProgress(kaisaiDate: string): Promise<PlanProgressLike> {
    return this.env.RACE_DAY.get(this.env.RACE_DAY.idFromName(kaisaiDate)).getPlanProgress();
  }

  /**
   * コアの設定。本番は var・secret から決める(取得を止める `"0"`・件数を下げる上書き)。
   * **ローカルの smoke(`smoke-worker.ts`。netkeiba へ出さない)だけが、サブクラスでこれを差し替える**(開始時刻・時間帯・間隔を外して、偽の gate の fixture を流す)。
   */
  protected options(): ArchiveFetchOptions {
    const nightlyLimit = parseLimitOverride(this.env.RACE_ARCHIVE_NIGHTLY_LIMIT, ARCHIVE_NIGHTLY_LIMIT_MAX);
    return { ...(isArchiveFetchDisabled(this.env.RACE_ARCHIVE_NIGHTLY_LIMIT) ? { disabled: true } : {}), ...(nightlyLimit === null ? {} : { nightlyLimit }) };
  }

  /** アラームが無ければ張る(RPC)。cron の `scheduled` が 21 時と 23 時に呼ぶ。 */
  kick(): Promise<void> {
    return this.core.kick();
  }

  /** 進捗の読み取り(RPC)。状態は変えないが、アラームが無ければ張り直す(自己回復。画面の更新で動き出す)。 */
  async getStatus(): Promise<RaceArchiveFetchStatus> {
    await this.core.kick();
    return this.core.getStatus();
  }

  /** 手で再開する(RPC)。止まっていなければ何もしない。 */
  resume(): Promise<{ readonly resumed: boolean; readonly previous: string }> {
    return this.core.resume();
  }

  /** アラーム: 次のステップを 1 つ実行する(例外は握る: 失敗は 10 分後の再試行になる)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
