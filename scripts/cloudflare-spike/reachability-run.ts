/**
 * 到達性の測定の進行(Issue #159 第2ラウンド。Worker とランナーの対照)。
 *
 * 計画(`buildRequestPlan`)を順に送る。**時計と送信を注入できる**ので、実ネットワークにも実時間にも
 * 依存せず、本数・間隔・送信元ごとの打ち切りを単体テストできる(ドライバが実際の fetch を注入する)。
 *  - 本数と間隔は送信元をまたいだ全体で守る(Worker とランナーの合計 10 本以内、2 秒間隔)
 *  - 400/403/429 の2回連続の打ち切りは送信元ごと。止まった送信元の分だけ飛ばし、他方は続ける
 */

import type { NetkeibaProbeRecord, ProbeSource } from "./reachability.js";
import { SourcedRequestGuard, type RequestGuardOptions } from "./request-guard.js";
import type { NetkeibaTarget, PlannedRequest } from "./targets.js";

export interface ReachabilityRunDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 1本を送って記録を返す(例外を投げてもよい。その場合は status=null の記録にする)。 */
  send(source: ProbeSource, target: NetkeibaTarget): Promise<NetkeibaProbeRecord>;
}

export interface ReachabilityRunState {
  readonly records: readonly (NetkeibaProbeRecord & { readonly source: ProbeSource })[];
  readonly requestCount: number;
  /** 全体の打ち切り理由(本数の上限)。なければ null。 */
  readonly stoppedReason: string | null;
  /** 送信元ごとの打ち切り理由(連続拒否)。なければ null。 */
  readonly stoppedBySource: Readonly<Record<ProbeSource, string | null>>;
}

export interface ReachabilityRunOptions {
  readonly guard?: RequestGuardOptions;
  /** 記録が1件増えるたびに呼ばれる(途中経過の保存用)。 */
  readonly onRecord?: (state: ReachabilityRunState) => void;
}

export async function runReachability(
  plan: readonly PlannedRequest[],
  deps: ReachabilityRunDeps,
  options: ReachabilityRunOptions = {},
): Promise<ReachabilityRunState> {
  const guard = new SourcedRequestGuard(options.guard);
  const records: (NetkeibaProbeRecord & { source: ProbeSource })[] = [];
  let stoppedReason: string | null = null;
  const stoppedBySource: Record<ProbeSource, string | null> = { worker: null, runner: null };

  const snapshot = (): ReachabilityRunState => ({
    records: [...records],
    requestCount: guard.sentCount,
    stoppedReason,
    stoppedBySource: { ...stoppedBySource },
  });

  for (const item of plan) {
    const decision = guard.next(item.source, deps.now());
    if (!decision.allow) {
      if (decision.reason === "max-requests") {
        stoppedReason = "max-requests";
        break;
      }
      // この送信元は連続拒否で止める。他方の送信元は続ける。
      stoppedBySource[item.source] = decision.reason;
      continue;
    }
    if (decision.waitMs > 0) {
      await deps.sleep(decision.waitMs);
    }
    guard.markSent(item.source, deps.now());
    let record: NetkeibaProbeRecord;
    try {
      record = await deps.send(item.source, item.target);
    } catch (error) {
      record = {
        targetId: item.target.id,
        url: item.target.url,
        status: null,
        bodyLength: null,
        charset: null,
        parsedKind: item.target.kind,
        parsedCount: null,
        parseError: null,
        replacementChars: null,
        headers: {},
        bodyHead: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    guard.recordStatus(item.source, record.status);
    records.push({ ...record, source: item.source });
    options.onRecord?.(snapshot());
  }

  // 最後の1本で連続拒否になった送信元も記録する。
  for (const source of ["worker", "runner"] as const) {
    if (stoppedBySource[source] === null) {
      const d = guard.next(source, deps.now());
      if (!d.allow && d.reason === "consecutive-blocks") {
        stoppedBySource[source] = d.reason;
      }
    }
  }
  return snapshot();
}
