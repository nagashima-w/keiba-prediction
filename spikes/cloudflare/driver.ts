/**
 * 実測のドライバ(Issue #159〈#21-A〉)。GitHub Actions 上で、デプロイ済みの Worker を呼んで測り、
 * 結果 JSON を書き出す。判定の核は `scripts/cloudflare-spike/` の純ロジック(単体テスト済み)。
 *
 * 環境変数: SPIKE_EXPERIMENTS(選ぶ実験。必須。origin / reachability / socket-matrix / cpu のカンマ区切り)/
 * SPIKE_URL(Worker のベース URL)/ SPIKE_SECRET(共有秘密)/ RUN_ID / RESULT_PATH。
 * 未設定・空・未知のトークンはエラー(誤って全実験を走らせない)。netkeiba へ出る実験(reachability・origin・
 * socket-matrix)は、どの2つも同時に選べない(netkeiba への合計 10 本以内の守り)。
 *
 * 測るもの(Issue #160 で、実験を選べるようにした):
 *  0. origin(#160): Workers からだけ HTTP 400 になる原因の切り分け。E0 基準の再確認 / E1 ヘッダの観測(エコー。
 *     netkeiba へは出ない)/ E2 ランナー + Workers 風のヘッダ / E3 Worker の TCP ソケット。netkeiba へ 6 本。
 *     判定の核は `scripts/cloudflare-spike/origin-*.ts`(単体テスト済み)。
 *  0'. socket-matrix(#162 段階1): DO の中のソケットでの取得。取得先の網羅・`Accept-Encoding: gzip`・再現性を、netkeiba へ 9 本
 *     (2 秒間隔・2 回連続の 400/403/429 で全体を打ち切り)。送るヘッダは #160 E3 と同じ集合(`STATIC_SOCKET_HEADERS`)で、
 *     gzip は計画の最後の2本にだけ付ける。このほかに netkeiba へ出ない、Worker から DO を繰り返し呼ぶ試験
 *     (subrequest の数え方)を行う。判定・進行の核は `scripts/cloudflare-spike/socket-matrix-*.ts`(単体テスト済み)。
 *  以下の 1〜3 のうち、1 は reachability、3 は cpu を選んだときだけ行う(2 は常に行う):
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
import { STATIC_SOCKET_HEADERS, type EchoFetchResult } from "../../scripts/cloudflare-spike/echo.js";
import type { EchoService } from "../../scripts/cloudflare-spike/echo-targets.js";
import { parseExperiments } from "../../scripts/cloudflare-spike/experiments.js";
import type { HeaderEntry } from "../../scripts/cloudflare-spike/http1.js";
import type { OriginPlace, OriginStep } from "../../scripts/cloudflare-spike/origin-plan.js";
import { runOrigin } from "../../scripts/cloudflare-spike/origin-run.js";
import { runReachability } from "../../scripts/cloudflare-spike/reachability-run.js";
import { runSocketMatrix, type MatrixSendOutcome, type SubrequestProbeResult } from "../../scripts/cloudflare-spike/socket-matrix-run.js";
import { buildMatrixSocketBody, type MatrixStep } from "../../scripts/cloudflare-spike/socket-matrix-plan.js";
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
import { fetchEcho } from "./src/echo-fetch.js";
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

/**
 * Worker に1本を取得させ、記録を受け取る。Worker の応答が想定外なら、status=null の記録にして理由を残す。
 * path は `/netkeiba`(Worker の fetch)か `/netkeiba-socket`(Worker の TCP ソケット。extra に headers を渡す)。
 */
async function sendViaWorker(
  target: NetkeibaTarget,
  path = "/netkeiba",
  extra: Record<string, unknown> = {},
): Promise<NetkeibaProbeRecord> {
  const r = await call("POST", path, {
    targetId: target.id,
    url: target.url,
    kind: target.kind,
    encoding: target.encoding,
    ...extra,
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

/** E1: Worker の `/echo` にエコーを取りに行かせる(ランナー側は `fetchEcho` を直接使う。同じ関数)。 */
async function echoViaWorker(service: EchoService): Promise<EchoFetchResult> {
  const r = await call("POST", "/echo", { service });
  try {
    const parsed = JSON.parse(r.text) as { ok?: boolean; result?: EchoFetchResult };
    if (r.status === 200 && parsed.ok === true && parsed.result !== undefined) {
      return parsed.result;
    }
    throw new Error(`Worker の /echo の応答が想定外です(HTTP ${r.status}): ${r.text.slice(0, 200)}`);
  } catch (error) {
    return { status: null, bodyText: null, responseHeaders: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Issue #160: Workers からだけ HTTP 400 になる原因の切り分け(E0〜E3)。進行・守り・マスク・結論は
 * `runOrigin`(単体テスト済みの純ロジック)が担い、ここは実際の送信(Worker の呼び出し・ランナーの fetch)を注入する。
 * **ここからログに出すのは結論の名前だけ**(エコーで観測した IP・サブドメイン等の生の値は、結果にもログにも出さない)。
 */
async function measureOrigin(result: SpikeResult): Promise<void> {
  const send = async (step: OriginStep, headers: readonly HeaderEntry[]): Promise<NetkeibaProbeRecord> => {
    const request = { targetId: step.target.id, url: step.target.url, kind: step.target.kind, encoding: step.target.encoding };
    switch (step.via) {
      case "fetch":
        // E0: 追加のヘッダなし。Worker の fetch か、ランナーのグローバル fetch(どちらも `probeNetkeiba`)。
        return step.place === "worker" ? sendViaWorker(step.target) : probeNetkeiba(request);
      case "socket":
        // E3: Worker の TCP ソケット。ヘッダはドライバが渡す(ランナーの観測から導出した集合)。
        return sendViaWorker(step.target, "/netkeiba-socket", {
          headers: headers.map((h) => ({ name: h.name, value: h.value })),
        });
      case "fetch+worker-headers": {
        // E2: ランナーの fetch に、Worker にだけ現れたヘッダ(生の値。メモリ上のみ)を足す。送信元はランナーのまま。
        const extra = Object.fromEntries(headers.map((h) => [h.name, h.value]));
        return probeNetkeiba(request, (url, init) => fetch(url, { ...init, headers: { ...init.headers, ...extra } }));
      }
    }
  };
  const origin = await runOrigin(
    {
      now: () => Date.now(),
      sleep,
      echo: (place: OriginPlace, service: EchoService) => (place === "worker" ? echoViaWorker(service) : fetchEcho(service)),
      send,
      mask: {
        ...(process.env["CF_SUBDOMAIN"] !== undefined ? { subdomain: process.env["CF_SUBDOMAIN"] } : {}),
        ...(process.env["SPIKE_WORKER_NAME"] !== undefined ? { workerName: process.env["SPIKE_WORKER_NAME"] } : {}),
      },
    },
    {
      onUpdate: (o) => {
        result.origin = o;
        save(result);
      },
    },
  );
  result.origin = origin;
  save(result);
  console.log(
    `切り分け(origin): 結論=${origin.conclusion} 基準の再現=${origin.baselineReproduced} E2=${origin.outcomes.e2} E3=${origin.outcomes.e3} ` +
      `netkeiba=${origin.netkeibaRequestCount}本 エコー=${origin.echo.requestCount}回`,
  );
}

/** Worker の `/do/netkeiba-socket`(DO の中のソケット)に、計画の1本を取得させる。想定外の応答は例外にする(runner が記録にする)。 */
async function sendViaDoSocket(step: MatrixStep): Promise<MatrixSendOutcome> {
  // E3 と同じヘッダ集合。gzip の opt-in は、計画のステップの方式から buildMatrixSocketBody が決める(ここでは付け足さない)。
  const r = await call("POST", "/do/netkeiba-socket", buildMatrixSocketBody(step, STATIC_SOCKET_HEADERS));
  const parsed = ((): Partial<MatrixSendOutcome> & { ok?: boolean } => {
    try {
      return JSON.parse(r.text) as Partial<MatrixSendOutcome> & { ok?: boolean };
    } catch {
      return {};
    }
  })();
  if (r.status === 200 && parsed.ok === true && parsed.record !== undefined) {
    return { record: parsed.record, meta: parsed.meta ?? null, instance: parsed.instance ?? null };
  }
  throw new Error(`Worker の /do/netkeiba-socket の応答が想定外です(HTTP ${r.status}): ${r.text.slice(0, 200)}`);
}

/** Worker に、DO を繰り返し呼ぶ試験(netkeiba へは出ない)をさせる。 */
async function subrequestProbeViaWorker(count: number): Promise<SubrequestProbeResult> {
  const r = await call("POST", `/subrequest-probe?n=${count}`);
  try {
    const parsed = JSON.parse(r.text) as { ok?: boolean; result?: SubrequestProbeResult };
    if (r.status === 200 && parsed.ok === true && parsed.result !== undefined) {
      return parsed.result;
    }
  } catch {
    // 下で、想定外の応答として扱う。
  }
  // Worker 自体が失敗した(CPU 超過など)。本文の先頭を理由に残す(マスクは runSocketMatrix が行う)。
  return { ran: false, requested: count, attempted: null, succeeded: null, firstFailureAt: null, errorKind: null, error: `HTTP ${r.status}: ${r.text.slice(0, 200)}`, httpStatus: r.status };
}

/**
 * Issue #162 段階1: DO の中のソケットでの取得(socket-matrix)。進行・守り・マスク・要約・読みは `runSocketMatrix`
 * (単体テスト済みの純ロジック)が担い、ここは実際の送信(Worker の呼び出し)を注入する。
 * **ここからログに出すのは件数だけ**(IP・サブドメインなどの生の値は、結果にもログにも出さない)。
 */
async function measureSocketMatrix(result: SpikeResult): Promise<void> {
  const matrix = await runSocketMatrix(
    {
      now: () => Date.now(),
      sleep,
      send: sendViaDoSocket,
      subrequestProbe: subrequestProbeViaWorker,
      mask: {
        ...(process.env["CF_SUBDOMAIN"] !== undefined ? { subdomain: process.env["CF_SUBDOMAIN"] } : {}),
        ...(process.env["SPIKE_WORKER_NAME"] !== undefined ? { workerName: process.env["SPIKE_WORKER_NAME"] } : {}),
      },
    },
    {
      onUpdate: (m) => {
        result.socketMatrix = m;
        save(result);
      },
    },
  );
  result.socketMatrix = matrix;
  save(result);
  console.log(
    `socket-matrix: netkeiba=${matrix.netkeibaRequestCount}本/${matrix.plannedCount}本 打ち切り=${matrix.stoppedReason ?? "なし"} ` +
      `ok=${matrix.summary.coverage.filter((c) => c.verdict === "ok").length}/${matrix.summary.coverage.length} ` +
      `DO呼び出し試験=${matrix.subrequestProbe === null ? "なし" : matrix.subrequestProbe.ran ? `失敗${matrix.subrequestProbe.firstFailureAt ?? "なし"}` : "実行できず"}`,
  );
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
    // 実験の選択(フェイルクローズ)。解釈できなければ何も測らずに、理由を残して失敗にする。
    const selection = parseExperiments(process.env["SPIKE_EXPERIMENTS"]);
    if (!selection.ok) {
      result.notes.push(selection.error);
      console.log(`::error title=実験の選択が不正::${selection.error}`);
      process.exitCode = 1;
      return;
    }
    const experiments = selection.experiments;
    result.experiments = [...experiments];
    save(result);

    if (existsSync(LOCAL_CALIBRATION_PATH)) {
      result.local = { entries: JSON.parse(readFileSync(LOCAL_CALIBRATION_PATH, "utf-8")).entries as LocalCalibrationEntry[] };
    }
    if (!(await waitUntilReady(result))) {
      return;
    }
    await measureSelftest(result);
    if (experiments.includes("reachability")) {
      if (LOCAL_DRYRUN) {
        result.notes.push("SPIKE_LOCAL_DRYRUN=1: netkeiba への到達性の測定を行っていない(ローカルの配線確認)");
      } else {
        await measureReachability(result);
      }
    }
    if (experiments.includes("origin")) {
      if (LOCAL_DRYRUN) {
        result.notes.push("SPIKE_LOCAL_DRYRUN=1: 400 の原因の切り分け(origin)を行っていない(netkeiba・エコーへは出ない。ローカルの配線確認)");
      } else {
        await measureOrigin(result);
      }
    }
    if (experiments.includes("socket-matrix")) {
      if (LOCAL_DRYRUN) {
        result.notes.push("SPIKE_LOCAL_DRYRUN=1: DO の中のソケットでの取得(socket-matrix)を行っていない(netkeiba へは出ない。ローカルの配線確認)");
      } else {
        await measureSocketMatrix(result);
      }
    }
    if (experiments.includes("cpu")) {
      await measureCpu(result, "worker");
      await measureCpu(result, "durableObject");
    }
  } catch (error) {
    result.notes.push(`ドライバが例外で中断: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    result.finishedAt = new Date().toISOString();
    save(result);
  }
}

await main();
