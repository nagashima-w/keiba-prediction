/**
 * 実測のドライバ(Issue #159〈#21-A〉)。GitHub Actions 上で、デプロイ済みの Worker を呼んで測り、
 * 結果 JSON を書き出す。判定の核は `scripts/cloudflare-spike/` の純ロジック(単体テスト済み)。
 *
 * 環境変数: SPIKE_URL(Worker のベース URL)/ SPIKE_SECRET(共有秘密)/ RUN_ID / RESULT_PATH。
 *
 * 測るもの:
 *  1. 到達性: netkeiba へ Worker から5本(2秒間隔、合計10本以内、400/403/429 が2回連続で打ち切り)
 *  2. EUC-JP のデコード(Worker 内の往復。ネットワーク不使用)
 *  3. CPU: 普通の Worker と Durable Object で、parse / score / alloc / allocFull を、反復回数を倍々 →
 *     二分探索で増やして、上限超過で落ちる点を探す(Workers では実行中に I/O が無いと時計が進まないため、
 *     コード内の時刻差では測れない)。各リクエストの時刻差(insideMs / afterIoMs)も補助として記録する。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  classifyCpuProbe,
  searchLimit,
  type ProbeOutcome,
} from "../../scripts/cloudflare-spike/cpu-search.js";
import { RequestGuard } from "../../scripts/cloudflare-spike/request-guard.js";
import type { NetkeibaProbeRecord } from "../../scripts/cloudflare-spike/reachability.js";
import {
  CPU_WORKS,
  emptyResult,
  type CpuRuntime,
  type CpuWork,
  type LocalCalibrationEntry,
  type SpikeResult,
} from "../../scripts/cloudflare-spike/result.js";
import { buildTargets } from "../../scripts/cloudflare-spike/targets.js";
import { requireEnv } from "./cf-api.js";

const BASE_URL = requireEnv("SPIKE_URL").replace(/\/$/, "");
const SECRET = requireEnv("SPIKE_SECRET");
const RESULT_PATH = process.env["RESULT_PATH"] ?? "spike-result.json";
const LOCAL_CALIBRATION_PATH = process.env["LOCAL_CALIBRATION_PATH"] ?? "local-calibration.json";

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

function save(result: SpikeResult): void {
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
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

async function measureReachability(result: SpikeResult): Promise<void> {
  const guard = new RequestGuard();
  for (const target of buildTargets()) {
    const decision = guard.next(Date.now());
    if (!decision.allow) {
      result.netkeiba.stoppedReason = decision.reason;
      break;
    }
    if (decision.waitMs > 0) {
      await sleep(decision.waitMs);
    }
    guard.markSent(Date.now());
    const r = await call("POST", "/netkeiba", {
      targetId: target.id,
      url: target.url,
      kind: target.kind,
      encoding: target.encoding,
    });
    let record: NetkeibaProbeRecord;
    try {
      const parsed = JSON.parse(r.text) as { ok?: boolean; record?: NetkeibaProbeRecord };
      if (r.status === 200 && parsed.ok === true && parsed.record !== undefined) {
        record = parsed.record;
      } else {
        throw new Error(`Worker の応答が想定外です(HTTP ${r.status}): ${r.text.slice(0, 200)}`);
      }
    } catch (error) {
      record = {
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
    guard.recordStatus(record.status);
    result.netkeiba.records.push(record);
    result.netkeiba.requestCount = guard.sentCount;
    save(result);
  }
  const after = guard.next(Date.now());
  if (!after.allow && result.netkeiba.stoppedReason === null) {
    result.netkeiba.stoppedReason = after.reason;
  }
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
  for (const work of CPU_WORKS) {
    // コールドスタート(初回のモジュール評価)の影響を探索に混ぜないよう、1回捨てる。
    await call("POST", `${prefix}/cpu/${work}?reps=1`);

    const probe = async (reps: number): Promise<ProbeOutcome> => {
      const r = await call("POST", `${prefix}/cpu/${work}?reps=${reps}`);
      const kind = classifyCpuProbe(r.status, r.text);
      let insideMs: number | null = null;
      let afterIoMs: number | null = null;
      if (kind === "ok") {
        try {
          const parsed = JSON.parse(r.text) as { insideMs?: number; afterIoMs?: number };
          insideMs = parsed.insideMs ?? null;
          afterIoMs = parsed.afterIoMs ?? null;
        } catch {
          // 補助の値なので、読めなくても探索は続ける。
        }
      }
      result.cpu.samples.push({
        runtime,
        work,
        reps,
        status: r.status,
        kind,
        wallMs: r.wallMs,
        insideMs,
        afterIoMs,
        bodyHead: kind === "ok" ? null : r.text.slice(0, 300),
      });
      return { kind, elapsedMs: r.wallMs, ...(kind === "ok" ? {} : { detail: `HTTP ${r.status}: ${r.text.slice(0, 120)}` }) };
    };

    const search = await searchLimit(probe, {
      maxReps: MAX_REPS[work],
      trials: TRIALS[runtime],
      maxProbes: MAX_PROBES_PER_SEARCH,
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
