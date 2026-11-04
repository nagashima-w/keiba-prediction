/**
 * 過去の結果を horse_runs に入れる毎晩の変換の Durable Object `RaceArchiveRunsDO`(SQLite バックエンド。単一インスタンス〈`idFromName("main")`〉。Issue #590〈#549-B3-2〉)。
 *
 * ロジックは `RaceArchiveRunsCore`(純ロジック。Node でテストできる)にあり、ここは本物の `ctx.storage.sql`・時計・`setAlarm`・目録と R2 の読み出し(`D1RaceArchiveStore`)・
 * 変換の書き込み(`convertRaceArchives`)・Discord を配線するだけの薄いラッパ(`cloudflare:workers` を持つため、テストでは import できない)。
 * 取得の DO(`RaceArchiveFetchDO`)とは別のインスタンス・別のアラームなので、互いに止め合わない。**netkeiba にも gate にも出ない**(`fetch` も socket も持たない)。
 *
 * クラス名は migration(wrangler.toml の `new_sqlite_classes`。タグ v12)に固定される。
 *
 * 動きを変える設定は Worker の var・secret の 1 つだけ(任意): `RACE_ARCHIVE_RUNS_NIGHTLY_LIMIT`(1 晩の書き込み行数を**下げる**上書き。未設定は既定の 30,000 行。文字列 `"0"` だけは変換を止める)。
 * **smoke 専用の `options()` の差し替え**(時間帯を外す)は `smoke-worker.ts` のサブクラスだけが行う。本番のエントリ(`worker.ts`)はそのサブクラスを import しない。
 */
import { DurableObject } from "cloudflare:workers";
import { parseLimitOverride } from "./limit-override";
import { buildArchiveRunsNoticeEmbed } from "./notify-embeds";
import { createDiscordNotifier } from "./notify-send";
import { D1RaceArchiveStore, type RaceArchiveBucket } from "./race-archive-repository";
import { convertRaceArchives, type RaceArchiveRunsDb } from "./race-archive-runs";
import { ARCHIVE_RUNS_NIGHTLY_ROWS_MAX, isArchiveRunsDisabled, RaceArchiveRunsCore, type ArchiveRunsOptions, type RaceArchiveRunsStatus } from "./race-archive-runs-core";

export interface RaceArchiveRunsEnv {
  DB: RaceArchiveRunsDb;
  /** R2(`readRaceArchives` が get だけを使う。Class B の計数と柵は D1 の `r2_ops`)。 */
  ANALYSIS_DETAIL: RaceArchiveBucket;
  /** Discord の Webhook URL(Worker の secret)。未登録・形式不正なら通知しない(状態は変わる)。 */
  DISCORD_WEBHOOK_URL?: string;
  /**
   * 任意(var・secret)。1 晩の書き込み行数を**下げる**上書き(1 以上の整数。それ以外・上限超えは無視して既定の 30,000)。**文字列 `"0"` だけは変換を止める**(アラームを張らず、起きても何もしない。state は `disabled`)。
   * ★止める var を `RACE_ARCHIVE_RUNS` にしてはならない: それは DO の binding の名前で、同じ名前の var は binding と衝突する。
   */
  RACE_ARCHIVE_RUNS_NIGHTLY_LIMIT?: string;
}

export class RaceArchiveRunsDO extends DurableObject<RaceArchiveRunsEnv> {
  private readonly core: RaceArchiveRunsCore;

  constructor(ctx: DurableObjectState, env: RaceArchiveRunsEnv) {
    super(ctx, env);
    const store = new D1RaceArchiveStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL });
    const notifier = createDiscordNotifier(env.DISCORD_WEBHOOK_URL);
    this.core = new RaceArchiveRunsCore(
      {
        sql: ctx.storage.sql,
        now: () => Date.now(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        getAlarm: () => ctx.storage.getAlarm(),
        archive: {
          listCatalogPage: (after, limit) => store.listCatalogPage(after, limit),
          readRaceArchives: (ids) => store.readRaceArchives(ids),
        },
        convert: (targets, now) => convertRaceArchives(env.DB, targets, now),
        dbSize: async () => {
          const result = await env.DB.prepare("SELECT 1").run();
          const size = (result.meta as { size_after?: unknown }).size_after;
          return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
        },
        catalogCounts: async () => {
          // 目録の全件走査(約 1.7 万行)。管理者の状態の読み取りのときだけ。
          const { results } = await env.DB.prepare("SELECT runs_version AS v, COUNT(*) AS n FROM race_archive GROUP BY runs_version").all<{ v: number | null; n: number }>();
          const byVersion: Record<string, number> = {};
          let total = 0;
          for (const r of results) {
            byVersion[r.v === null ? "null" : String(r.v)] = r.n;
            total += r.n;
          }
          return { total, byVersion };
        },
        notify: async (notice) => {
          if (notifier === undefined) {
            console.log("race-archive-runs: notice skipped reason=webhook-unavailable");
            return;
          }
          await notifier.send({ embeds: [buildArchiveRunsNoticeEmbed(notice)] });
        },
        log: (line, level) => (level === "error" ? console.error(line) : console.log(line)),
      },
      this.options(),
    );
  }

  /**
   * コアの設定。本番は var・secret から決める(変換を止める `"0"`・書き込み行数を下げる上書き)。
   * **ローカルの smoke(`smoke-worker.ts`)だけが、サブクラスでこれを差し替える**(時間帯を外す)。
   */
  protected options(): ArchiveRunsOptions {
    const nightlyRows = parseLimitOverride(this.env.RACE_ARCHIVE_RUNS_NIGHTLY_LIMIT, ARCHIVE_RUNS_NIGHTLY_ROWS_MAX);
    return { ...(isArchiveRunsDisabled(this.env.RACE_ARCHIVE_RUNS_NIGHTLY_LIMIT) ? { disabled: true } : {}), ...(nightlyRows === null ? {} : { nightlyRows }) };
  }

  /** アラームが無ければ張る(RPC)。cron の `scheduled` が 21 時と 23 時に呼ぶ。 */
  kick(): Promise<void> {
    return this.core.kick();
  }

  /** 進捗の読み取り(RPC)。状態は変えないが、アラームが無ければ張り直す(自己回復)。 */
  async getStatus(): Promise<RaceArchiveRunsStatus> {
    await this.core.kick();
    return this.core.getStatus();
  }

  /** アラーム: 次のステップを 1 つ実行する(例外は握る: 失敗は 10 分後の再試行になる)。 */
  async alarm(): Promise<void> {
    await this.core.runNextStep();
  }
}
