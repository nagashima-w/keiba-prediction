/**
 * 400 の原因の切り分け(Issue #160〈#21-B〉)の進行。E1(エコー)→ E0 → E3 → E2 の順に進める。
 *
 * **時計・エコー・送信を注入できる**ので、実ネットワークにも実時間にも依存せず、順序・本数・間隔・
 * 送信元ごとの打ち切り・マスク・結論を単体テストできる(ドライバが実際の fetch / Worker 呼び出しを注入する)。
 *  - netkeiba への本数と間隔は、送信元・手段をまたいだ全体で守る(合計 10 本以内・2 秒間隔。計画は 6 本)
 *  - 400/403/429 の2回連続の打ち切りは、「場所:手段」ごと(`OriginSourceKey`)
 *  - エコーは netkeiba の本数に含めない(最大4回: peet を両側 → だめなら httpbin を両側)
 *
 * **公開される結果にはマスク済みの値だけを載せる**(IP・workers.dev のサブドメイン・Worker 名・cf-ray の一意の部分)。
 * E2・E3 の送信に使う生の値は、この関数の中のメモリ上でだけ扱い、結果にもログにも出さない。
 *
 * **何がどこへ送られるか**(第三者と netkeiba に出るもの。詳細は `echo.ts`):
 *  - E1(エコー): Worker の subrequest には Cloudflare が `CF-Worker`(workers.dev のサブドメインを含みうる)などを付け、
 *    それが第三者のエコー(tls.peet.ws・httpbin.org)に届く。ランナー側も、ランナーの IP がエコーに届く。
 *  - **エコー宛てで観測したものを、netkeiba 宛ての代理として使う**(Worker が netkeiba へ実際に送るヘッダは観測できない。
 *    エコーに届いたものと同じと仮定している)。
 *  - E2: その仮定のもとで、Worker にだけ現れたヘッダ(エコーで観測した生の値)を、ランナーから netkeiba へ送る。
 *  - E3: ランナーの観測から導出したヘッダを、Worker のソケットから netkeiba へ送る。
 */

import {
  computeHeaderDiff,
  deriveSocketHeaders,
  maskHeaderValue,
  maskText,
  parseEchoObservation,
  selectE2Headers,
  type EchoFetchResult,
  type EchoObservation,
  type MaskContext,
  type SkippedHeader,
} from "./echo.js";
import { ECHO_SERVICES, type EchoService } from "./echo-targets.js";
import type { HeaderEntry } from "./http1.js";
import {
  baselineReproduced,
  buildOriginPlan,
  concludeOrigin,
  describeConclusion,
  ORIGIN_SOURCE_KEYS,
  outcomeOf,
  PLANNED_COUNT,
  type ConclusionReading,
  type E1Comparison,
  type Outcome,
  type OriginConclusion,
  type OriginPlace,
  type OriginRecord,
  type OriginSourceKey,
  type OriginStep,
} from "./origin-plan.js";
import type { NetkeibaProbeRecord } from "./reachability.js";
import { SourcedRequestGuard, type RequestGuardOptions } from "./request-guard.js";

export interface OriginRunDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** エコーへ1回取得する(例外を投げてもよい。その場合は失敗として記録する)。 */
  echo(place: OriginPlace, service: EchoService): Promise<EchoFetchResult>;
  /**
   * netkeiba へ1本送って記録を返す(例外を投げてもよい。その場合は status=null の記録にする)。
   * headers は、E2 では Worker にだけ現れた生のヘッダ、E3 ではソケットで送るヘッダ、E0 では空。
   */
  send(step: OriginStep, headers: readonly HeaderEntry[]): Promise<NetkeibaProbeRecord>;
  /** マスクに使う、この実行に固有の識別子。 */
  readonly mask: MaskContext;
}

export interface OriginRunOptions {
  readonly guard?: RequestGuardOptions;
  /** 送信の計画(テスト用の差し込み口。省略時は `buildOriginPlan()`)。 */
  readonly plan?: readonly OriginStep[];
  /** 状態が変わるたびに呼ばれる(途中経過の保存用)。 */
  readonly onUpdate?: (result: OriginResult) => void;
}

export interface MaskedHeader {
  readonly name: string;
  readonly value: string;
}

export interface MaskedEchoObservation {
  readonly service: EchoService;
  readonly httpVersion: string | null;
  readonly tlsJa3Hash: string | null;
  readonly tlsJa4: string | null;
  readonly h2Fingerprint: string | null;
  readonly headers: readonly MaskedHeader[];
}

export interface EchoAttempt {
  readonly place: OriginPlace;
  readonly service: EchoService;
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
  readonly cloudflareHosted: boolean;
}

export interface OriginResult {
  readonly echo: {
    /** エコーへ出した回数(netkeiba の本数には含めない)。 */
    readonly requestCount: number;
    readonly attempts: readonly EchoAttempt[];
    /** Worker とランナーの両方で取れたサービス。取れなければ null。 */
    readonly serviceUsed: EchoService | null;
    readonly worker: MaskedEchoObservation | null;
    readonly runner: MaskedEchoObservation | null;
    readonly diff: {
      readonly workerOnly: readonly MaskedHeader[];
      readonly runnerOnly: readonly string[];
      readonly valueDiffers: readonly { readonly name: string; readonly workerValue: string; readonly runnerValue: string }[];
    } | null;
    readonly warnings: readonly string[];
  };
  readonly e2: {
    readonly ran: boolean;
    /** 付けたヘッダ(名前とマスク済みの値)。 */
    readonly sent: readonly MaskedHeader[];
    readonly skipped: readonly SkippedHeader[];
    readonly note: string | null;
  };
  readonly e3: {
    /** ソケットで送るヘッダを、ランナーの観測から導出したか、静的フォールバックを使ったか。 */
    readonly headerSource: "runner-echo" | "static-fallback";
    readonly headers: readonly MaskedHeader[];
  };
  readonly records: readonly OriginRecord[];
  readonly netkeibaRequestCount: number;
  /** 全体の打ち切り理由(本数の上限)。 */
  readonly stoppedReason: string | null;
  /** 送信元(場所:手段)ごとの打ち切り理由(連続拒否)。 */
  readonly stoppedBySource: Readonly<Record<OriginSourceKey, string | null>>;
  readonly baselineReproduced: boolean;
  readonly outcomes: { readonly e2: Outcome; readonly e3: Outcome };
  readonly conclusion: OriginConclusion;
  readonly reading: ConclusionReading;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runOrigin(deps: OriginRunDeps, options: OriginRunOptions = {}): Promise<OriginResult> {
  const mask = deps.mask;
  const maskHeaders = (headers: readonly HeaderEntry[]): MaskedHeader[] =>
    headers.map((h) => ({ name: h.name, value: maskHeaderValue(h.name, h.value, mask) }));
  const maskObservation = (o: EchoObservation): MaskedEchoObservation => ({
    service: o.service,
    httpVersion: o.httpVersion,
    tlsJa3Hash: o.tlsJa3Hash,
    tlsJa4: o.tlsJa4,
    h2Fingerprint: o.h2Fingerprint,
    headers: maskHeaders(o.headers),
  });

  // ---- 状態 ----
  const attempts: EchoAttempt[] = [];
  let serviceUsed: EchoService | null = null;
  let workerObs: EchoObservation | null = null;
  let runnerObs: EchoObservation | null = null;
  const warnings: string[] = [];
  let diff: ReturnType<typeof computeHeaderDiff> | null = null;
  let e2Send: readonly HeaderEntry[] = [];
  let e2Skipped: readonly SkippedHeader[] = [];
  let e2Note: string | null = null;
  let socketHeaders: ReturnType<typeof deriveSocketHeaders> = deriveSocketHeaders(null);
  const records: OriginRecord[] = [];
  let stoppedReason: string | null = null;
  const stoppedBySource = Object.fromEntries(ORIGIN_SOURCE_KEYS.map((k) => [k, null])) as Record<OriginSourceKey, string | null>;
  const guard = new SourcedRequestGuard(options.guard);

  const assemble = (): OriginResult => {
    const e2Ran = e2Send.length > 0;
    const baseline = baselineReproduced(records);
    const e2: Outcome = e2Ran ? outcomeOf(records, "E2", PLANNED_COUNT.E2) : "unknown";
    const e3: Outcome = outcomeOf(records, "E3", PLANNED_COUNT.E3);
    const conclusion = concludeOrigin({ baseline, e2, e3 });
    const e1: E1Comparison = {
      observed: workerObs !== null && runnerObs !== null,
      service: serviceUsed,
      workerHttpVersion: workerObs?.httpVersion ?? null,
      runnerHttpVersion: runnerObs?.httpVersion ?? null,
      workerJa4: workerObs?.tlsJa4 ?? null,
      runnerJa4: runnerObs?.tlsJa4 ?? null,
    };
    return {
      echo: {
        requestCount: attempts.length,
        attempts: [...attempts],
        serviceUsed,
        worker: workerObs === null ? null : maskObservation(workerObs),
        runner: runnerObs === null ? null : maskObservation(runnerObs),
        diff:
          diff === null
            ? null
            : {
                workerOnly: maskHeaders(diff.workerOnly),
                runnerOnly: [...diff.runnerOnly],
                valueDiffers: diff.valueDiffers.map((d) => ({
                  name: d.name,
                  workerValue: maskHeaderValue(d.name, d.workerValue, mask),
                  runnerValue: maskHeaderValue(d.name, d.runnerValue, mask),
                })),
              },
        warnings: [...warnings],
      },
      e2: { ran: e2Ran, sent: maskHeaders(e2Send), skipped: [...e2Skipped], note: e2Note },
      e3: { headerSource: socketHeaders.source, headers: maskHeaders(socketHeaders.headers) },
      records: [...records],
      netkeibaRequestCount: guard.sentCount,
      stoppedReason,
      stoppedBySource: { ...stoppedBySource },
      baselineReproduced: baseline,
      outcomes: { e2, e3 },
      conclusion,
      reading: describeConclusion(conclusion, e1),
    };
  };
  const notify = (): void => options.onUpdate?.(assemble());

  // ---- E1: エコー(netkeiba へは出ない) ----
  const observe = async (place: OriginPlace, service: EchoService): Promise<EchoObservation> => {
    let fetched: EchoFetchResult;
    try {
      fetched = await deps.echo(place, service);
    } catch (error) {
      fetched = { status: null, bodyText: null, responseHeaders: {}, error: messageOf(error) };
    }
    const observation = parseEchoObservation(service, fetched);
    attempts.push({
      place,
      service,
      ok: observation.ok,
      status: observation.status,
      error: observation.error === null ? null : maskText(observation.error, mask),
      cloudflareHosted: observation.cloudflareHosted,
    });
    if (observation.cloudflareHosted) {
      const w = `エコー(${service})の応答に Cloudflare 上にある疑い(cf-ray または server: cloudflare)があった(${place} 側)。Workers の振る舞いが CloudFront 宛てと変わりうる`;
      if (!warnings.includes(w)) {
        warnings.push(w);
      }
    }
    return observation;
  };

  let firstOkRunner: EchoObservation | null = null;
  for (const service of ECHO_SERVICES) {
    // どちらか一方でも失敗したら、次のサービスで両側をやり直す(同じサービスで比べる)。
    const w = await observe("worker", service);
    const r = await observe("runner", service);
    if (r.ok && firstOkRunner === null) {
      firstOkRunner = r;
    }
    if (w.ok && r.ok) {
      serviceUsed = service;
      workerObs = w;
      runnerObs = r;
      break;
    }
  }
  // 比較できなくても、ランナー側の観測が取れていれば、E3 のヘッダの導出には使う。
  runnerObs ??= firstOkRunner;
  socketHeaders = deriveSocketHeaders(runnerObs);

  if (workerObs !== null && runnerObs !== null && serviceUsed !== null) {
    diff = computeHeaderDiff(workerObs.headers, runnerObs.headers);
    const selection = selectE2Headers(diff.workerOnly);
    e2Send = selection.send;
    e2Skipped = selection.skipped;
    if (e2Send.length === 0) {
      e2Note =
        selection.skipped.length > 0
          ? "Worker にだけ現れるヘッダはあったが、付けられるものが無かった(転送されない種類、または不正な値)ため、E2 は実施していない"
          : "Worker にだけ現れるヘッダが無かったため、E2 は実施していない";
    }
  } else {
    e2Note = "E1 の観測が Worker とランナーの両側で揃わなかったため、E2 は実施していない";
  }
  notify();

  // ---- E0 / E3 / E2: netkeiba へ(送信元・手段をまたいで直列) ----
  const plan = (options.plan ?? buildOriginPlan()).filter((step) => step.experiment !== "E2" || e2Send.length > 0);
  const headersFor = (step: OriginStep): readonly HeaderEntry[] =>
    step.experiment === "E2" ? e2Send : step.experiment === "E3" ? socketHeaders.headers : [];

  for (const step of plan) {
    const decision = guard.next(step.sourceKey, deps.now());
    if (!decision.allow) {
      if (decision.reason === "max-requests") {
        stoppedReason = "max-requests";
        break;
      }
      // この送信元(場所:手段)は連続拒否で止める。他の送信元は続ける。
      stoppedBySource[step.sourceKey] = decision.reason;
      continue;
    }
    if (decision.waitMs > 0) {
      await deps.sleep(decision.waitMs);
    }
    guard.markSent(step.sourceKey, deps.now());
    let record: NetkeibaProbeRecord;
    try {
      record = await deps.send(step, headersFor(step));
    } catch (error) {
      record = {
        targetId: step.target.id,
        url: step.target.url,
        status: null,
        bodyLength: null,
        charset: null,
        parsedKind: step.target.kind,
        parsedCount: null,
        parseError: null,
        replacementChars: null,
        headers: {},
        bodyHead: null,
        error: messageOf(error),
      };
    }
    guard.recordStatus(step.sourceKey, record.status);
    records.push({
      ...record,
      headers: Object.fromEntries(Object.entries(record.headers).map(([k, v]) => [k, maskHeaderValue(k, v, mask)])),
      bodyHead: record.bodyHead === null ? null : maskText(record.bodyHead, mask),
      error: record.error === null ? null : maskText(record.error, mask),
      experiment: step.experiment,
      place: step.place,
      via: step.via,
      sourceKey: step.sourceKey,
    });
    notify();
  }

  // 最後の1本で連続拒否になった送信元も記録する。
  for (const key of ORIGIN_SOURCE_KEYS) {
    if (stoppedBySource[key] === null) {
      const d = guard.next(key, deps.now());
      if (!d.allow && d.reason === "consecutive-blocks") {
        stoppedBySource[key] = d.reason;
      }
    }
  }
  notify();
  return assemble();
}
