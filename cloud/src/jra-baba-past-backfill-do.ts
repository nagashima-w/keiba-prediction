/**
 * 過去の馬場の公表値(JRA の過去の含水率・クッション値の PDF)の埋め戻しの Durable Object `JraBabaPastBackfillDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #769)。
 *
 * ロジックは `JraBabaPastBackfillCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・D1・R2(`D1BabaPastStore`)・JRA への取得口
 * (`createJraBabaPastFetcher`)を配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。他の DO とは別のインスタンス・別のアラームなので、互いに止め合わない。
 * **netkeiba にも gate にも出ない**(JRA の公式サイトと D1・R2 だけ)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v18)に固定される。
 *
 * 動きを変える設定は Worker の var(どちらも任意): `JRA_BABA_PAST_BACKFILL_ENABLED`(**文字列 `"1"` だけが動かす**。未設定・`"0"`・それ以外は止まっている。**wrangler.toml の [vars] で `"0"` にして公開し、確かめてから `"1"` にする**)・
 * `JRA_BABA_PAST_BACKFILL_DAILY_ROWS`(1 日の書き込み行数を**下げる**上書き)。
 * ★止める var を DO の binding の名前(`JRA_BABA_PAST_BACKFILL`)にしてはならない(同じ名前の var は binding と衝突する)。
 */
import { DurableObject } from "cloudflare:workers";
import { D1BabaPastStore, type BabaPastBucket, type BabaPastDb } from "./baba-past-repository";
import {
  BABA_PAST_DAILY_ROWS_MAX,
  isJraBabaPastBackfillEnabled,
  JraBabaPastBackfillCore,
  type BabaPastBackfillStatus,
  type JraBabaPastBackfillOptions,
} from "./jra-baba-past-backfill-core";
import { createJraBabaPastFetcher } from "./jra-baba-past-fetch";
import { parseLimitOverride } from "./limit-override";

export interface JraBabaPastBackfillEnv {
  DB: BabaPastDb;
  /** 過去の馬場の PDF の控えを置く R2(get と put だけ使う)。 */
  ANALYSIS_DETAIL: BabaPastBucket;
  /** 任意(var)。**文字列 `"1"` だけ**が動かす。未設定・それ以外は止まっている(アラームを張らず、起きても何もしない)。 */
  JRA_BABA_PAST_BACKFILL_ENABLED?: string;
  /** 任意(var)。1 日(JST)に書く行数を**下げる**上書き(1 以上の整数。上限 500 を超える値・不正な値は無視)。 */
  JRA_BABA_PAST_BACKFILL_DAILY_ROWS?: string;
}

export class JraBabaPastBackfillDO extends DurableObject<JraBabaPastBackfillEnv> {
  private readonly core: JraBabaPastBackfillCore;

  constructor(ctx: DurableObjectState, env: JraBabaPastBackfillEnv) {
    super(ctx, env);
    const fetcher = createJraBabaPastFetcher();
    this.core = new JraBabaPastBackfillCore(
      {
        sql: ctx.storage.sql,
        now: () => Date.now(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        store: new D1BabaPastStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL }),
        fetchYear: (year) => fetcher.fetchYear(year),
        fetchPdf: (path) => fetcher.fetchPdf(path),
        log: (line) => console.log(line),
      },
      this.options(),
    );
  }

  private options(): JraBabaPastBackfillOptions {
    const dailyRows = parseLimitOverride(this.env.JRA_BABA_PAST_BACKFILL_DAILY_ROWS, BABA_PAST_DAILY_ROWS_MAX);
    return { ...(isJraBabaPastBackfillEnabled(this.env.JRA_BABA_PAST_BACKFILL_ENABLED) ? { enabled: true } : {}), ...(dailyRows === null ? {} : { dailyRows }) };
  }

  /** アラームが無ければ張る(RPC)。cron の `scheduled` が 21 時と 23 時に呼ぶ。 */
  kick(): Promise<void> {
    return this.core.kick();
  }

  /** 進み具合(RPC。管理者の読み取り口 `GET /api/baba-past` が呼ぶ。状態を変えない)。 */
  status(): Promise<BabaPastBackfillStatus> {
    return this.core.status();
  }

  /** アラーム: 次の起床を 1 回実行する(例外は握る: 失敗は 10 分後の再試行になる)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
