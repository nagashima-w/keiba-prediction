/**
 * 馬ごとの頁の埋め戻しの Durable Object `JraHorseBackfillDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #697。親は #695)。
 *
 * ロジックは `JraHorseBackfillCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・D1(`D1JraHorseStore`)・JRA への取得口(`createJraHorseFetcher`)を
 * 配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。他の DO とは別のインスタンス・別のアラームなので、互いに止め合わない。
 * **netkeiba にも gate にも出ない**(JRA の公式サイトと D1 だけ)。1 回の起床で最大 40 頭を取る理由は core の冒頭に書いた(既存の取得の DO の「1 アラーム 1 ステップ」と違う)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v14)に固定される。
 *
 * 動きを変える設定は Worker の var(どちらも任意): `JRA_HORSE_BACKFILL_ENABLED`(文字列 `"0"` だけが動きを止める。既定は動く)・
 * `JRA_HORSE_BACKFILL_DAILY_ROWS`(1 日の書き込み行数を**下げる**上書き。上げることはできない)。
 * ★止める var を DO の binding の名前(`JRA_HORSE_BACKFILL`)にしてはならない(同じ名前の var は binding と衝突する)。
 */
import { DurableObject } from "cloudflare:workers";
import { isJraHorseBackfillDisabled, HORSE_BACKFILL_DAILY_ROWS_MAX, JraHorseBackfillCore, type JraHorseBackfillOptions } from "./jra-horse-backfill-core";
import { createJraHorseFetcher } from "./jra-horse-fetch";
import { D1JraHorseStore, type JraHorseDb } from "./jra-horse-repository";
import { parseLimitOverride } from "./limit-override";

export interface JraHorseBackfillEnv {
  DB: JraHorseDb;
  /** 任意(var)。**文字列 `"0"` だけ**が動きを止める(アラームを張らず、起きても何もしない)。未設定・それ以外は動く。 */
  JRA_HORSE_BACKFILL_ENABLED?: string;
  /** 任意(var)。1 日(JST)に horse_profiles へ書く行数を**下げる**上書き(1 以上の整数。上限 15,000 を超える値・不正な値は無視)。 */
  JRA_HORSE_BACKFILL_DAILY_ROWS?: string;
}

export class JraHorseBackfillDO extends DurableObject<JraHorseBackfillEnv> {
  private readonly core: JraHorseBackfillCore;

  constructor(ctx: DurableObjectState, env: JraHorseBackfillEnv) {
    super(ctx, env);
    this.core = new JraHorseBackfillCore(
      {
        sql: ctx.storage.sql,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        store: new D1JraHorseStore({ db: env.DB }),
        fetchProfile: createJraHorseFetcher(),
        log: (line, level) => (level === "error" ? console.error(line) : console.log(line)),
      },
      this.options(),
    );
  }

  private options(): JraHorseBackfillOptions {
    const dailyRows = parseLimitOverride(this.env.JRA_HORSE_BACKFILL_DAILY_ROWS, HORSE_BACKFILL_DAILY_ROWS_MAX);
    return { ...(isJraHorseBackfillDisabled(this.env.JRA_HORSE_BACKFILL_ENABLED) ? { disabled: true } : {}), ...(dailyRows === null ? {} : { dailyRows }) };
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
