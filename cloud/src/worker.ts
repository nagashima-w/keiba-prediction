/**
 * クラウド版の Worker のエントリ(Issue #161〈#21-C〉)。認証・ルーティングは handler.ts に任せる薄い層。
 */
import { handle, type Env } from "./handler";

export { NetkeibaGate } from "./netkeiba-gate-do";
export { RaceDay } from "./race-day-do";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
