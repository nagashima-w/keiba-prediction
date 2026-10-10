/**
 * クラウド版の Worker のエントリ(Issue #161〈#21-C〉)。認証・ルーティングは handler.ts に任せる薄い層。
 * cron(`wrangler.toml` の `[triggers]`。Issue #206)は `scheduled` の 1 経路で、scheduled.ts に委譲する(認証は不要。cron は Cloudflare が起動する)。
 */
import { handle, type Env } from "./handler";
import { runScheduled } from "./scheduled";

export { NetkeibaGate } from "./netkeiba-gate-do";
export { RaceDay } from "./race-day-do";
export { CloudMigration } from "./migration-do";
export { ResultBackfill } from "./result-backfill-do";
export { VerifyReportDO } from "./verify-do";
export { DailyReportDO } from "./daily-report-do";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
