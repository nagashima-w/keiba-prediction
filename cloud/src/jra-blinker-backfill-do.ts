/**
 * 過去のレースのブリンカー着用の埋め戻しの Durable Object `JraBlinkerBackfillDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #698。親は #695)。
 *
 * ロジックは `JraBlinkerBackfillCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・D1(`D1PastBlinkerStore`)・JRA への取得口(`createJraResultFetcher`)を
 * 配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。他の DO とは別のインスタンス・別のアラームなので、互いに止め合わない(馬ごとの頁の DO〈#697〉とも別)。
 * **netkeiba にも gate にも出ない**(JRA の公式サイトと D1 だけ)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v15)に固定される。
 *
 * 動きを変える設定は Worker の var(どちらも任意): `JRA_BLINKER_BACKFILL_ENABLED`(文字列 `"0"` だけが動きを止める。**wrangler.toml の [vars] で `"0"` にして公開する**。
 * 馬ごとの頁〈#697〉の取得が終わってから `"1"` にする〈ユーザーの決定〉。var が無い構成では動く)・`JRA_BLINKER_BACKFILL_DAILY_ROWS`(1 日の書き込み行数を**下げる**上書き。上げることはできない)。
 * ★止める var を DO の binding の名前(`JRA_BLINKER_BACKFILL`)にしてはならない(同じ名前の var は binding と衝突する)。
 */
import { DurableObject } from "cloudflare:workers";
import { BLINKER_BACKFILL_DAILY_ROWS_MAX, isJraBlinkerBackfillDisabled, JraBlinkerBackfillCore, type JraBlinkerBackfillOptions } from "./jra-blinker-backfill-core";
import { createJraResultFetcher } from "./jra-result-fetch";
import { parseLimitOverride } from "./limit-override";
import { D1PastBlinkerStore, type PastBlinkerDb } from "./past-blinker-repository";

export interface JraBlinkerBackfillEnv {
  DB: PastBlinkerDb;
  /** 任意(var)。**文字列 `"0"` だけ**が動きを止める(アラームを張らず、起きても何もしない)。未設定・それ以外は動く。 */
  JRA_BLINKER_BACKFILL_ENABLED?: string;
  /** 任意(var)。1 日(JST)に 2 つの表へ書く行数を**下げる**上書き(1 以上の整数。上限 14,000 を超える値・不正な値は無視)。 */
  JRA_BLINKER_BACKFILL_DAILY_ROWS?: string;
}

export class JraBlinkerBackfillDO extends DurableObject<JraBlinkerBackfillEnv> {
  private readonly core: JraBlinkerBackfillCore;

  constructor(ctx: DurableObjectState, env: JraBlinkerBackfillEnv) {
    super(ctx, env);
    this.core = new JraBlinkerBackfillCore(
      {
        sql: ctx.storage.sql,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        store: new D1PastBlinkerStore({ db: env.DB }),
        fetchPage: createJraResultFetcher(),
        log: (line, level) => (level === "error" ? console.error(line) : console.log(line)),
      },
      this.options(),
    );
  }

  private options(): JraBlinkerBackfillOptions {
    const dailyRows = parseLimitOverride(this.env.JRA_BLINKER_BACKFILL_DAILY_ROWS, BLINKER_BACKFILL_DAILY_ROWS_MAX);
    return { ...(isJraBlinkerBackfillDisabled(this.env.JRA_BLINKER_BACKFILL_ENABLED) ? { disabled: true } : {}), ...(dailyRows === null ? {} : { dailyRows }) };
  }

  /** アラームが無ければ張る(RPC)。cron の `scheduled` が 21 時と 23 時に呼ぶ。 */
  kick(): Promise<void> {
    return this.core.kick();
  }

  /** アラーム: 次の起床を 1 回実行する(例外は握る: 失敗は 10 分後の再試行になる)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
