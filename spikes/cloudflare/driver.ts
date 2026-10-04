/**
 * 実測のドライバ(Issue #159〈#21-A〉)。GitHub Actions 上で、デプロイ済みの Worker を呼んで測り、
 * 結果 JSON を書き出す。判定の核は `scripts/cloudflare-spike/` の純ロジック(単体テスト済み)。
 *
 * 環境変数: SPIKE_URL(Worker のベース URL)/ SPIKE_SECRET(共有秘密)/ RUN_ID / RESULT_PATH。
 *
 * 測るもの:
 *  1. 到達性: netkeiba へ、Worker とランナー(この Node。対照実験)から同じ5対象を1本ずつ。合計10本以内・
 *     2秒間隔(送信元をまたいで直列)。400/403/429 の2回連続の打ち切りは送信元ごと(Worker が止まっても
 *     ランナーの対照は続ける)。ランナーは Worker と同じ `probeNetkeiba`(同じ URL・同じヘッダ・同じ記録の形)で
 *     送るので、変わるのは送信元だけ
 *  2. EUC-JP のデコード(Worker 内の往復。ネットワーク不使用)
 *  3. CPU: 普通の Worker と Durable Object で、parse / score / alloc / allocFull を、反復回数を倍々 →
 *     二分探索で増やして、上限超過で落ちる点を探す(Workers では実行中に I/O が無いと時計が進まないため、
 *     コード内の時刻差では測れない)。各リクエストの時刻差(insideMs / afterIoMs)も補助として記録する。
 */

import { existsSync, readFileSync } from "node:fs";
import {
  classifyCpuProbe,
  isValidCpuCheck,
  searchLimit,
  type ProbeOutcome,
} from "../../scripts/cloudflare-spike/cpu-search.js";
import { runReachability } from "../../scripts/cloudflare-spike/reachability-run.js";
import type { NetkeibaProbeRecord, ProbeSource } from "../../scripts/cloudflare-spike/reachability.js";
import {
  CPU_WORKS,
  emptyResult,
  type CpuRuntime,
  type CpuWork,
  type LocalCalibrationEntry,
  type SpikeResult,
} from "../../scripts/cloudflare-spike/result.js";
import { buildRequestPlan, type NetkeibaTarget } from "../../scripts/cloudflare-spike/targets.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { requireEnv } from "./cf-api.js";
import { probeNetkeiba } from "./src/netkeiba-probe.js";

/**
 * Worker のベース URL。ワークフローでは SPIKE_WORKER_NAME と CF_SUBDOMAIN(GITHUB_ENV。マスク済み)から組み立てる
 * (ステップの env に URL を展開すると、public なジョブログに workers.dev のサブドメインが出るため)。
 * SPIKE_URL は、ローカルの `wrangler dev` に向ける配線確認用の上書き。URL はログに出さない。
 */
const BASE_URL = (
  process.env["SPIKE_URL"] ??
  `https://${requireEnv("SPIKE_WORKER_NAME")}.${requireEnv("CF_SUBDOMAIN")}.workers.dev`
).replace(/\/$/, "");
const SECRET = requireEnv("SPIKE_SECRET");
const RESULT_PATH = process.env["RESULT_PATH"] ?? "spike-result.json";
const LOCAL_CALIBRATION_PATH = process.env["LOCAL_CALIBRATION_PATH"] ?? "local-calibration.json";

/**
 * ドライバ全体の壁時計の上限(分)。ワークフローの「測定を実行」ステップの timeout(45 分)より短くし、
 * 超えたら探索を打ち切って、それまでの結果を書き出す(ステップの時間切れで結果が残らないのを防ぐ)。
 */
const DRIVER_WALL_MS = 40 * 60_000;
const DEADLINE = Date.now() + DRIVER_WALL_MS;
const shouldStop = (): boolean => Date.now() > DEADLINE;

/** 1リクエストのタイムアウト(Durable Object の 30 秒を超える余裕を持たせる)。 */
const REQUEST_TIMEOUT_MS = 150_000;

/**
 * ローカルでの配線確認用(SPIKE_LOCAL_DRYRUN=1): netkeiba へは出ず、反復回数の上限も小さくする。
 * ローカルの workerd には CPU 上限が無く、本番と同じ上限まで探索すると時間がかかりすぎるため。
 */
const LOCAL_DRYRUN = process.env["SPIKE_LOCAL_DRYRUN"] === "1";

/**
 * 処理ごとの反復回数の上限。Durable Object の 30 秒を覆うように置く
 * (ローカルの 1 reps あたり ms は smoke.ts が測る。parse≈20〜30ms、alloc≈115ms、allocFull≈540ms 程度)。
 */
const MAX_REPS: Record<CpuWork, number> = LOCAL_DRYRUN
  ? { parse: 3, score: 3, alloc: 2, allocFull: 2 }
  : { parse: 4096, score: 4096, alloc: 512, allocFull: 128 };

/** 試行回数(Worker は安いので 3 回、DO は 1 回が最大 30 秒かかるので 2 回)。 */
const TRIALS: Record<CpuRuntime, number> = { worker: 3, durableObject: 2 };

/** 1つの探索で投げるリクエスト数の予算。 */
const MAX_PROBES_PER_SEARCH = 60;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface HttpOutcome {
  readonly status: number | null;
  readonly text: string;
  readonly wallMs: number;
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpOutcome> {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "x-spike-secret": SECRET,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text(), wallMs: Date.now() - started };
  } catch (error) {
    return {
      status: null,
      text: error instanceof Error ? error.message : String(error),
      wallMs: Date.now() - started,
    };
  }
}

/** 結果ファイルは原子的に書く(書き込み中に切れても、後片付けが壊れた JSON を読まないように)。 */
function save(result: SpikeResult): void {
  writeJsonAtomic(RESULT_PATH, result);
}

/** デプロイ直後は workers.dev への反映に時間がかかることがあるので、/ping が通るまで待つ(netkeiba へは出ない)。 */
async function waitUntilReady(result: SpikeResult): Promise<boolean> {
  for (let i = 0; i < 45; i += 1) {
    const r = await call("GET", "/ping");
    if (r.status === 200) {
      result.notes.push(`Worker が応答するまで ${i + 1} 回の /ping を要した`);
      return true;
    }
    await sleep(2000);
  }
  result.notes.push("Worker が 90 秒以内に応答しなかった(測定を中止)");
  return false;
}

/** Worker に1本を取得させ、記録を受け取る。Worker の応答が想定外なら、status=null の記録にして理由を残す。 */
async function sendViaWorker(target: NetkeibaTarget): Promise<NetkeibaProbeRecord> {
  const r = await call("POST", "/netkeiba", {
    targetId: target.id,
    url: target.url,
    kind: target.kind,
    encoding: target.encoding,
  });
  try {
    const parsed = JSON.parse(r.text) as { ok?: boolean; record?: NetkeibaProbeRecord };
    if (r.status === 200 && parsed.ok === true && parsed.record !== undefined) {
      return parsed.record;
    }
    throw new Error(`Worker の応答が想定外です(HTTP ${r.status}): ${r.text.slice(0, 200)}`);
  } catch (error) {
    return {
      targetId: target.id,
      url: target.url,
      status: null,
      bodyLength: null,
      charset: null,
      parsedKind: target.kind,
      parsedCount: null,
      parseError: null,
      replacementChars: null,
      headers: {},
      bodyHead: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function measureReachability(result: SpikeResult): Promise<void> {
  const state = await runReachability(
    buildRequestPlan(),
    {
      now: () => Date.now(),
      sleep,
      send: (source: ProbeSource, target: NetkeibaTarget) =>
        source === "worker"
          ? sendViaWorker(target)
          : // ランナー(この Node。グローバル fetch)から、Worker と同じ処理で取得する(対照)。
            probeNetkeiba({ targetId: target.id, url: target.url, kind: target.kind, encoding: target.encoding }),
    },
    {
      onRecord: (s) => {
        result.netkeiba.records = [...s.records];
        result.netkeiba.requestCount = s.requestCount;
        save(result);
      },
    },
  );
  result.netkeiba.records = [...state.records];
  result.netkeiba.requestCount = state.requestCount;
  result.netkeiba.stoppedReason = state.stoppedReason;
  result.netkeiba.stoppedBySource = { ...state.stoppedBySource };
  save(result);
}

async function measureSelftest(result: SpikeResult): Promise<void> {
  const r = await call("GET", "/selftest/euc-jp");
  try {
    const parsed = JSON.parse(r.text) as { ok?: boolean; roundTrip?: boolean; decoded?: string };
    result.selftest = {
      eucJpRoundTrip: r.status === 200 ? parsed.roundTrip === true : null,
      detail: r.status === 200 ? (parsed.roundTrip === true ? "往復一致" : `不一致: ${parsed.decoded ?? ""}`) : `HTTP ${r.status}: ${r.text.slice(0, 200)}`,
    };
  } catch {
    result.selftest = { eucJpRoundTrip: null, detail: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
  }
  const doPing = await call("GET", "/do/ping");
  result.notes.push(`Durable Object の /do/ping: HTTP ${doPing.status ?? "例外"} ${doPing.text.slice(0, 200)}`);
}

async function measureCpu(result: SpikeResult, runtime: CpuRuntime): Promise<void> {
  const prefix = runtime === "worker" ? "" : "/do";
  // Durable Object は、実運用と同じ負荷(allocFull)を最優先で測る(壁時計の上限で後ろが切れても、最重要の問いに答えが出る)。
  const order = runtime === "durableObject" ? [...CPU_WORKS].reverse() : CPU_WORKS;
  for (const work of order) {
    if (shouldStop()) {
      result.notes.push(`壁時計の上限(${DRIVER_WALL_MS / 60_000} 分)に達したため ${runtime}/${work} 以降の探索を行っていない`);
      break;
    }
    // コールドスタート(初回のモジュール評価)の影響を探索に混ぜないよう、1回捨てる。
    await call("POST", `${prefix}/cpu/${work}?reps=1`);

    const probe = async (reps: number): Promise<ProbeOutcome> => {
      const r = await call("POST", `${prefix}/cpu/${work}?reps=${reps}`);
      const kind = classifyCpuProbe(r.status, r.text);
      let insideMs: number | null = null;
      let afterIoMs: number | null = null;
      let finalKind: typeof kind = kind;
      let invalidCheck: string | null = null;
      if (kind === "ok") {
        try {
          const parsed = JSON.parse(r.text) as { insideMs?: number; afterIoMs?: number; check?: unknown };
          insideMs = parsed.insideMs ?? null;
          afterIoMs = parsed.afterIoMs ?? null;
          // 空振りした計算(早期 return で何も計算していない等)を「通過」と記録しない。
          if (!isValidCpuCheck(work, parsed.check)) {
            finalKind = "other-error";
            invalidCheck = `check=${String(parsed.check)} は ${work} の妥当な値ではない(空振りの疑い)`;
          }
        } catch {
          finalKind = "other-error";
          invalidCheck = "200 だが応答が JSON として読めない";
        }
      }
      // Worker で CPU 超過になった直後に、処理を伴わない /ping を投げて記録する。超過の後は軽い処理さえ
      // 失敗する疑いがあり(第1ラウンドで観測)、その場合、超過の後の測定は独立していないため。
      let pingAfter: number | null | undefined;
      if (runtime === "worker" && finalKind === "cpu-exceeded") {
        pingAfter = (await call("GET", "/ping")).status;
      }
      result.cpu.samples.push({
        runtime,
        work,
        reps,
        status: r.status,
        kind: finalKind,
        wallMs: r.wallMs,
        insideMs,
        afterIoMs,
        bodyHead: finalKind === "ok" ? null : (invalidCheck ?? r.text.slice(0, 300)),
        ...(pingAfter !== undefined ? { pingAfter } : {}),
      });
      return {
        kind: finalKind,
        elapsedMs: r.wallMs,
        ...(finalKind === "ok" ? {} : { detail: invalidCheck ?? `HTTP ${r.status}: ${r.text.slice(0, 120)}` }),
      };
    };

    const search = await searchLimit(probe, {
      maxReps: MAX_REPS[work],
      trials: TRIALS[runtime],
      maxProbes: MAX_PROBES_PER_SEARCH,
      shouldStop,
    });
    result.cpu[runtime][work] = search;
    save(result);
    console.log(
      `CPU 探索 ${runtime}/${work}: maxPassReps=${search.maxPassReps} minFailReps=${search.minFailReps} stop=${search.stopReason} probes=${search.totalProbes}`,
    );
  }
}

async function main(): Promise<void> {
  const result = emptyResult(process.env["RUN_ID"] ?? process.env["GITHUB_RUN_ID"] ?? "local");
  result.startedAt = new Date().toISOString();
  try {
    if (existsSync(LOCAL_CALIBRATION_PATH)) {
      result.local = { entries: JSON.parse(readFileSync(LOCAL_CALIBRATION_PATH, "utf-8")).entries as LocalCalibrationEntry[] };
    }
    if (!(await waitUntilReady(result))) {
      return;
    }
    await measureSelftest(result);
    if (LOCAL_DRYRUN) {
      result.notes.push("SPIKE_LOCAL_DRYRUN=1: netkeiba への到達性の測定を行っていない(ローカルの配線確認)");
    } else {
      await measureReachability(result);
    }
    await measureCpu(result, "worker");
    await measureCpu(result, "durableObject");
  } catch (error) {
    result.notes.push(`ドライバが例外で中断: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    result.finishedAt = new Date().toISOString();
    save(result);
  }
}

await main();
