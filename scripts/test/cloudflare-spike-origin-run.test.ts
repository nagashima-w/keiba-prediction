import { describe, expect, it } from "vitest";
import { maskText, type EchoFetchResult } from "../cloudflare-spike/echo.js";
import type { EchoService } from "../cloudflare-spike/echo-targets.js";
import type { HeaderEntry } from "../cloudflare-spike/http1.js";
import { runOrigin, type OriginResult, type OriginRunDeps } from "../cloudflare-spike/origin-run.js";
import { buildOriginPlan, type OriginPlace, type OriginStep } from "../cloudflare-spike/origin-plan.js";
import type { NetkeibaProbeRecord } from "../cloudflare-spike/reachability.js";
import { MAX_NETKEIBA_REQUESTS, MIN_INTERVAL_MS } from "../cloudflare-spike/request-guard.js";

/**
 * #160 E0〜E3 の進行(`runOrigin`)。時計・エコー・送信を注入できるので、実ネットワークにも実時間にも
 * 依存せず、順序・本数・間隔・送信元ごとの打ち切り・マスク・結論を検証できる。
 */

const RAW_IP = "198.51.100.9";
const RAW_SUB = "my-sub";
const RAW_WORKER = "keiba-cf-spike-123456-1";
const RAW_RAY = "abc123def456";
const MASK = { subdomain: RAW_SUB, workerName: RAW_WORKER };

/** tls.peet.ws の応答(HTTP/1.1 形式)を作る。 */
function peet(headers: string[], over: { http?: string; ja4?: string } = {}): string {
  return JSON.stringify({
    ip: `${RAW_IP}:1234`,
    http_version: over.http ?? "HTTP/1.1",
    tls: { ja3_hash: "0".repeat(32), ja4: over.ja4 ?? "t13d_same" },
    http1: { headers },
  });
}

const WORKER_ECHO_HEADERS = [
  "User-Agent: UA",
  "accept-encoding: br, gzip",
  `cf-connecting-ip: ${RAW_IP}`,
  `x-real-ip: ${RAW_IP}`,
  `cf-worker: ${RAW_SUB}.workers.dev`,
  `cf-ray: ${RAW_RAY}-IAD`,
  "cdn-loop: cloudflare",
];
const RUNNER_ECHO_HEADERS = [
  "Host: tls.peet.ws",
  "Connection: keep-alive",
  "User-Agent: UA",
  "accept: */*",
  "accept-language: *",
  "sec-fetch-mode: cors",
  "accept-encoding: gzip, deflate",
];

function ok(text: string): EchoFetchResult {
  return { status: 200, bodyText: text, responseHeaders: { server: "TrackMe.peet.ws" }, error: null };
}
const fail = (status: number | null = 503): EchoFetchResult => ({
  status,
  bodyText: status === null ? null : "err",
  responseHeaders: {},
  error: status === null ? "boom" : null,
});

function record(step: OriginStep, status: number | null, over: Partial<NetkeibaProbeRecord> = {}): NetkeibaProbeRecord {
  return {
    targetId: step.target.id,
    url: step.target.url,
    status,
    bodyLength: status === 200 ? 1000 : status === null ? null : 0,
    charset: null,
    parsedKind: step.target.kind,
    parsedCount: status === 200 ? 5 : null,
    parseError: null,
    replacementChars: status === 200 ? 0 : null,
    headers: {},
    bodyHead: null,
    error: status === null ? "boom" : null,
    ...over,
  };
}

interface Sent {
  step: OriginStep;
  headers: readonly HeaderEntry[];
  at: number;
}
interface Harness {
  deps: OriginRunDeps;
  sent: Sent[];
  echoCalls: { place: OriginPlace; service: EchoService; at: number }[];
  clock: { now: number };
}

interface HarnessOptions {
  echo?: (place: OriginPlace, service: EchoService) => EchoFetchResult | Promise<EchoFetchResult>;
  status?: (step: OriginStep) => number | null;
  throwOn?: (step: OriginStep) => string | null;
}

/** 既定: Worker は拒否(400)、ランナーと、ソケット・Workers 風ヘッダは 200。echo は peet で両側 ok。 */
function harness(o: HarnessOptions = {}): Harness {
  const clock = { now: 5_000_000 };
  const sent: Sent[] = [];
  const echoCalls: Harness["echoCalls"] = [];
  const defaultEcho = (place: OriginPlace): EchoFetchResult =>
    ok(peet(place === "worker" ? WORKER_ECHO_HEADERS : RUNNER_ECHO_HEADERS));
  const defaultStatus = (step: OriginStep): number => (step.sourceKey === "worker:fetch" ? 400 : 200);
  return {
    clock,
    sent,
    echoCalls,
    deps: {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
      echo: async (place, service) => {
        echoCalls.push({ place, service, at: clock.now });
        return (o.echo ?? defaultEcho)(place, service);
      },
      send: async (step, headers) => {
        sent.push({ step, headers, at: clock.now });
        const thrown = o.throwOn?.(step) ?? null;
        if (thrown !== null) {
          throw new Error(thrown);
        }
        return record(step, (o.status ?? defaultStatus)(step));
      },
      mask: MASK,
    },
  };
}

describe("runOrigin: 正常系(E0 が再現し、E3 が通り、E2 も通る)", () => {
  it("netkeiba へ6本を、E0(Worker → ランナー)→ E3(race → db)→ E2(race → db)の順で送る", async () => {
    const h = harness();
    const r = await runOrigin(h.deps);
    expect(h.sent.map((s) => `${s.step.experiment}:${s.step.sourceKey}:${s.step.target.id}`)).toEqual([
      "E0:worker:fetch:central-shutuba",
      "E0:runner:fetch:central-shutuba",
      "E3:worker:socket:central-shutuba",
      "E3:worker:socket:db-horse-page",
      "E2:runner:fetch+worker-headers:central-shutuba",
      "E2:runner:fetch+worker-headers:db-horse-page",
    ]);
    expect(r.netkeibaRequestCount).toBe(6);
    expect(r.records).toHaveLength(6);
    expect(r.stoppedReason).toBeNull();
  });

  it("送信は全体で2秒以上の間隔を空ける(送信元・手段をまたいで直列)", async () => {
    const h = harness();
    await runOrigin(h.deps);
    expect(h.sent).toHaveLength(6);
    for (let i = 1; i < h.sent.length; i += 1) {
      expect(h.sent[i]!.at - h.sent[i - 1]!.at).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    }
  });

  it("エコーは netkeiba の間隔・本数に影響しない(E1 は netkeiba へ出る前に終わる)", async () => {
    const h = harness();
    await runOrigin(h.deps);
    const firstSend = h.sent[0]!.at;
    expect(h.echoCalls.every((c) => c.at <= firstSend)).toBe(true);
    expect(h.sent.length).toBeLessThanOrEqual(MAX_NETKEIBA_REQUESTS);
  });

  it("結論は fetch-specific(E0 が再現し、E3 が good)。実験ごとの集約を結果に持つ", async () => {
    const r = await runOrigin(harness().deps);
    expect(r.baselineReproduced).toBe(true);
    expect(r.outcomes).toEqual({ e2: "good", e3: "good" });
    expect(r.conclusion).toBe("fetch-specific");
    expect(r.reading.summary).toMatch(/ソケット/);
    expect(r.reading.limitations.join("\n")).toMatch(/分離できない/);
  });

  it("E0 の記録は Worker とランナーで同じ対象(race)で、実験・場所・手段が付く", async () => {
    const r = await runOrigin(harness().deps);
    const e0 = r.records.filter((x) => x.experiment === "E0");
    expect(e0.map((x) => [x.place, x.via, x.sourceKey, x.targetId, x.status])).toEqual([
      ["worker", "fetch", "worker:fetch", "central-shutuba", 400],
      ["runner", "fetch", "runner:fetch", "central-shutuba", 200],
    ]);
  });
});

describe("runOrigin: E1(エコー)", () => {
  it("第一候補(peet)が両側で取れれば、エコーは2回(Worker → ランナー)だけ", async () => {
    const h = harness();
    const r = await runOrigin(h.deps);
    expect(h.echoCalls.map((c) => `${c.place}:${c.service}`)).toEqual(["worker:peet", "runner:peet"]);
    expect(r.echo.requestCount).toBe(2);
    expect(r.echo.serviceUsed).toBe("peet");
  });

  it("Worker にだけ現れたヘッダ名・ランナーにだけ現れたヘッダ名・値だけ違うヘッダを、差分として結果に持つ", async () => {
    const r = await runOrigin(harness().deps);
    expect(r.echo.diff).not.toBeNull();
    expect(r.echo.diff!.workerOnly.map((x) => x.name)).toEqual(["cf-connecting-ip", "x-real-ip", "cf-worker", "cf-ray", "cdn-loop"]);
    expect(r.echo.diff!.runnerOnly).toEqual(["connection", "accept", "accept-language", "sec-fetch-mode"]);
    expect(r.echo.diff!.valueDiffers.map((x) => x.name)).toEqual(["accept-encoding"]);
  });

  it("どちらか一方でも peet が失敗したら、両側とも httpbin でやり直す(同じサービスで比べる)。エコーは最大4回", async () => {
    const h = harness({
      echo: (place, service) => {
        if (service === "peet") {
          return place === "runner" ? fail(503) : ok(peet(WORKER_ECHO_HEADERS));
        }
        return ok(JSON.stringify({ headers: Object.fromEntries((place === "worker" ? WORKER_ECHO_HEADERS : RUNNER_ECHO_HEADERS).map((l) => l.split(": ") as [string, string])) }));
      },
    });
    const r = await runOrigin(h.deps);
    expect(h.echoCalls.map((c) => `${c.place}:${c.service}`)).toEqual(["worker:peet", "runner:peet", "worker:httpbin", "runner:httpbin"]);
    expect(r.echo.requestCount).toBe(4);
    expect(r.echo.serviceUsed).toBe("httpbin");
    expect(r.echo.attempts).toHaveLength(4);
    expect(r.echo.attempts.map((a) => a.ok)).toEqual([true, false, true, true]);
    expect(r.echo.diff).not.toBeNull();
  });

  it("エコーが例外を投げても止まらず、失敗として記録する(通信エラー)", async () => {
    const h = harness({
      echo: () => {
        throw new Error(`connect failed ${RAW_IP}`);
      },
    });
    const r = await runOrigin(h.deps);
    expect(h.echoCalls).toHaveLength(4);
    expect(r.echo.attempts.every((a) => !a.ok)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(RAW_IP);
  });

  it("エコーが Cloudflare 上にある疑い(cf-ray)があれば、警告を結果に残す", async () => {
    const h = harness({
      echo: (place) => ({ ...ok(peet(place === "worker" ? WORKER_ECHO_HEADERS : RUNNER_ECHO_HEADERS)), responseHeaders: { "cf-ray": "x-IAD" } }),
    });
    const r = await runOrigin(h.deps);
    expect(r.echo.warnings.join("\n")).toMatch(/Cloudflare/);
    expect(r.echo.attempts.every((a) => a.cloudflareHosted)).toBe(true);
  });

  it("エコーがすべて失敗(E1 が取れない): E2 は実施せず理由を残し、E3 は静的フォールバックのヘッダで続ける", async () => {
    const h = harness({ echo: () => fail(503) });
    const r = await runOrigin(h.deps);
    expect(r.echo.serviceUsed).toBeNull();
    expect(r.echo.diff).toBeNull();
    expect(r.e2.ran).toBe(false);
    expect(r.e2.note).toMatch(/E1/);
    expect(h.sent.filter((s) => s.step.experiment === "E2")).toHaveLength(0);
    expect(r.netkeibaRequestCount).toBe(4);
    expect(r.e3.headerSource).toBe("static-fallback");
    const e3 = h.sent.filter((s) => s.step.experiment === "E3");
    expect(e3).toHaveLength(2);
    expect(e3[0]!.headers.map((x) => x.name)).toEqual(["User-Agent", "accept", "accept-language", "sec-fetch-mode"]);
    expect(r.outcomes.e2).toBe("unknown");
  });

  it("Worker 側の観測だけ失敗しランナー側は取れた場合: 比較はできない(E2 なし)が、E3 のヘッダはランナーの観測から導出する", async () => {
    const h = harness({
      echo: (place) => (place === "worker" ? fail(503) : ok(peet(RUNNER_ECHO_HEADERS))),
    });
    const r = await runOrigin(h.deps);
    expect(r.echo.serviceUsed).toBeNull();
    expect(r.e2.ran).toBe(false);
    expect(r.e3.headerSource).toBe("runner-echo");
  });
});

describe("runOrigin: E2(ランナー + Workers 風のヘッダ)", () => {
  it("Worker にだけ現れたヘッダを、Worker が実際に付けた生の値のまま(IP を値に持つものも)送る", async () => {
    const h = harness();
    await runOrigin(h.deps);
    const e2 = h.sent.filter((s) => s.step.experiment === "E2");
    expect(e2).toHaveLength(2);
    for (const s of e2) {
      expect(s.headers).toEqual([
        { name: "cf-connecting-ip", value: RAW_IP },
        { name: "x-real-ip", value: RAW_IP },
        { name: "cf-worker", value: `${RAW_SUB}.workers.dev` },
        { name: "cf-ray", value: `${RAW_RAY}-IAD` },
        { name: "cdn-loop", value: "cloudflare" },
      ]);
    }
  });

  it("値が違うだけのヘッダ(accept-encoding)は付けない。送ったものは名前とマスク済みの値で結果に残る", async () => {
    const r = await runOrigin(harness().deps);
    expect(r.e2.ran).toBe(true);
    expect(r.e2.sent.map((x) => x.name)).not.toContain("accept-encoding");
    expect(r.e2.sent).toContainEqual({ name: "cf-connecting-ip", value: "<ip>" });
    expect(r.e2.sent).toContainEqual({ name: "cf-worker", value: "<subdomain>.workers.dev" });
    expect(r.e2.sent).toContainEqual({ name: "cf-ray", value: "<ray>-IAD" });
    expect(r.e2.sent).toContainEqual({ name: "cdn-loop", value: "cloudflare" });
  });

  it("転送されない種類のヘッダが Worker 側にだけ現れたら、付けずに理由つきで結果に残す", async () => {
    const h = harness({
      echo: (place) => ok(peet(place === "worker" ? [...WORKER_ECHO_HEADERS, "te: trailers", "transfer-encoding: chunked"] : RUNNER_ECHO_HEADERS)),
    });
    const r = await runOrigin(h.deps);
    expect(r.e2.skipped.map((x) => x.name).sort()).toEqual(["te", "transfer-encoding"]);
    expect(h.sent.filter((s) => s.step.experiment === "E2")[0]!.headers.map((x) => x.name)).not.toContain("te");
  });

  it("Worker にだけ現れるヘッダが無ければ、E2 は実施しない(netkeiba へ出さず、理由を残す)", async () => {
    const h = harness({ echo: (place) => ok(peet(place === "worker" ? ["User-Agent: UA"] : RUNNER_ECHO_HEADERS)) });
    const r = await runOrigin(h.deps);
    expect(r.e2.ran).toBe(false);
    expect(r.e2.note).toMatch(/Worker にだけ現れる/);
    expect(h.sent.filter((s) => s.step.experiment === "E2")).toHaveLength(0);
    expect(r.netkeibaRequestCount).toBe(4);
  });
});

describe("runOrigin: E3(ソケット)に渡すヘッダ", () => {
  it("ランナーの観測から導出した集合(Host・Connection・Accept-Encoding を除く)を渡し、導出元を記録する", async () => {
    const h = harness();
    const r = await runOrigin(h.deps);
    const e3 = h.sent.filter((s) => s.step.experiment === "E3");
    for (const s of e3) {
      expect(s.headers).toEqual([
        { name: "User-Agent", value: "UA" },
        { name: "accept", value: "*/*" },
        { name: "accept-language", value: "*" },
        { name: "sec-fetch-mode", value: "cors" },
      ]);
    }
    expect(r.e3.headerSource).toBe("runner-echo");
  });

  it("E0 には追加のヘッダを渡さない(基準は fetch の既定のまま)", async () => {
    const h = harness();
    await runOrigin(h.deps);
    for (const s of h.sent.filter((x) => x.step.experiment === "E0")) {
      expect(s.headers).toEqual([]);
    }
  });
});

describe("runOrigin: 結論(E0〜E3 の結果の組合せ)", () => {
  const statusFor = (map: Record<string, number | null>) => (step: OriginStep): number | null =>
    step.sourceKey in map ? (map[step.sourceKey] as number | null) : 200;

  it("E2 が 400 で E3 が 200 → header-suspected", async () => {
    const r = await runOrigin(harness({ status: statusFor({ "worker:fetch": 400, "runner:fetch+worker-headers": 400 }) }).deps);
    expect(r.conclusion).toBe("header-suspected");
  });

  it("E3 が 400 で E2 が 200 → ip-suspected", async () => {
    const r = await runOrigin(harness({ status: statusFor({ "worker:fetch": 400, "worker:socket": 400 }) }).deps);
    expect(r.conclusion).toBe("ip-suspected");
  });

  it("E2 も E3 も 400 → both-suspected(判定不能)", async () => {
    const r = await runOrigin(
      harness({ status: statusFor({ "worker:fetch": 400, "worker:socket": 400, "runner:fetch+worker-headers": 400 }) }).deps,
    );
    expect(r.conclusion).toBe("both-suspected");
  });

  it("E0 で Worker も 200(基準が再現しない)なら、E3 が 200 でも baseline-not-reproduced", async () => {
    const r = await runOrigin(harness({ status: () => 200 }).deps);
    expect(r.baselineReproduced).toBe(false);
    expect(r.conclusion).toBe("baseline-not-reproduced");
  });

  it("基準が再現しなくても、E2・E3 は測る(本数は6本のまま。データは残す)", async () => {
    const h = harness({ status: () => 200 });
    const r = await runOrigin(h.deps);
    expect(r.netkeibaRequestCount).toBe(6);
  });

  it("ソケットが開けず通信エラー(status=null)なら、E3 は判定不能(unknown)で、IP の原因とは読まない", async () => {
    const r = await runOrigin(harness({ status: statusFor({ "worker:fetch": 400, "worker:socket": null }) }).deps);
    expect(r.outcomes.e3).toBe("unknown");
    expect(r.conclusion).toBe("inconclusive");
  });
});

describe("runOrigin: 守り(本数・連続拒否)", () => {
  it("送信元ごと(場所:手段)に連続拒否を数える: E3 が 400 を2回続けて受けても、E2 は続ける", async () => {
    const h = harness({ status: (s) => (s.sourceKey === "runner:fetch" ? 200 : 400) });
    const r = await runOrigin(h.deps);
    expect(r.netkeibaRequestCount).toBe(6);
    expect(r.stoppedBySource["worker:socket"]).toBe("consecutive-blocks");
    expect(r.stoppedBySource["runner:fetch+worker-headers"]).toBe("consecutive-blocks");
    expect(r.stoppedBySource["runner:fetch"]).toBeNull();
    expect(r.stoppedBySource["worker:fetch"]).toBeNull();
  });

  it("連続拒否の数え方は『場所:手段』ごとで、別の手段の成功・拒否は自分の連続に影響しない", async () => {
    // worker:fetch(E0)の400と、worker:socket(E3)の400は、別の送信元なので合算して「2連続」にならない。
    const h = harness({
      status: (s) => (s.sourceKey === "worker:fetch" || (s.sourceKey === "worker:socket" && s.target.id === "central-shutuba") ? 400 : 200),
    });
    const r = await runOrigin(h.deps);
    expect(h.sent.filter((s) => s.step.experiment === "E3")).toHaveLength(2);
    expect(r.stoppedBySource["worker:fetch"]).toBeNull();
    expect(r.stoppedBySource["worker:socket"]).toBeNull();
  });

  it("同じ送信元(場所:手段)が400を2回続けたら、3本目以降は送らずに止める。別の送信元は続ける", async () => {
    // 実際の計画は各送信元 2 本以内で、打ち切りが効く場面が無い。効くことを、同じ送信元を4本並べた計画で固定する。
    const base = buildOriginPlan();
    const socket = base.find((s) => s.sourceKey === "worker:socket")!;
    const runnerStep = base.find((s) => s.sourceKey === "runner:fetch")!;
    const plan = [socket, socket, socket, runnerStep, socket];
    const h = harness({ status: (s) => (s.sourceKey === "worker:socket" ? 400 : 200) });
    const r = await runOrigin(h.deps, { plan });
    expect(h.sent.map((s) => s.step.sourceKey)).toEqual(["worker:socket", "worker:socket", "runner:fetch"]);
    expect(r.stoppedBySource["worker:socket"]).toBe("consecutive-blocks");
    expect(r.stoppedBySource["runner:fetch"]).toBeNull();
    expect(r.stoppedReason).toBeNull();
  });

  it("拒否の連続は、間に成功(200)が挟まれば途切れる", async () => {
    const base = buildOriginPlan();
    const socket = base.find((s) => s.sourceKey === "worker:socket")!;
    let n = 0;
    const h = harness({ status: () => (n++ % 2 === 0 ? 400 : 200) });
    const r = await runOrigin(h.deps, { plan: [socket, socket, socket, socket] });
    expect(h.sent).toHaveLength(4);
    expect(r.stoppedBySource["worker:socket"]).toBeNull();
  });

  it("上限(本数)に達したら、それ以上送らず max-requests を記録する", async () => {
    const h = harness();
    const r = await runOrigin(h.deps, { guard: { maxRequests: 3 } });
    expect(h.sent).toHaveLength(3);
    expect(r.netkeibaRequestCount).toBe(3);
    expect(r.stoppedReason).toBe("max-requests");
    expect(r.outcomes.e3).toBe("unknown");
  });

  it("ソケットを開けずに例外になった試行も、1本として数える(保守側)", async () => {
    const h = harness({ throwOn: (s) => (s.sourceKey === "worker:socket" ? `connect ECONNREFUSED ${RAW_IP}:443` : null) });
    const r = await runOrigin(h.deps);
    expect(r.netkeibaRequestCount).toBe(6);
    const e3 = r.records.filter((x) => x.experiment === "E3");
    expect(e3).toHaveLength(2);
    expect(e3.every((x) => x.status === null)).toBe(true);
    expect(e3[0]!.error).toBe("connect ECONNREFUSED <ip>:443");
  });
});

describe("runOrigin: 公開される結果に生の値を載せない(マスク)", () => {
  async function leakFree(over: HarnessOptions = {}): Promise<{ r: OriginResult; json: string }> {
    const h = harness({
      throwOn: (s) => (s.sourceKey === "worker:socket" && s.target.id === "db-horse-page" ? `failed via ${RAW_WORKER}.${RAW_SUB}.workers.dev from ${RAW_IP}` : null),
      ...over,
    });
    const r = await runOrigin(h.deps);
    return { r, json: JSON.stringify(r) };
  }

  it.each([
    ["IPv4", RAW_IP],
    ["workers.dev のサブドメイン", RAW_SUB],
    ["Worker 名", RAW_WORKER],
    ["cf-ray の一意の部分", RAW_RAY],
  ])("結果の JSON のどこにも、%s の生の値が出ない", async (_name, raw) => {
    const { json } = await leakFree();
    expect(json).not.toContain(raw);
  });

  it("マスクの置換後の値は出ている(何も出力されずに『漏れていない』となる空振りを防ぐ)", async () => {
    const { json } = await leakFree();
    expect(json).toContain("<ip>");
    expect(json).toContain("<subdomain>");
    expect(json).toContain("<worker>");
    expect(json).toContain("<ray>-IAD");
  });

  it("IPv6 の送信元も隠れる", async () => {
    const v6 = "2001:db8::abcd";
    const h = harness({
      echo: (place) => ok(peet(place === "worker" ? [...WORKER_ECHO_HEADERS, `x-forwarded-for: ${v6}`] : RUNNER_ECHO_HEADERS)),
    });
    const r = await runOrigin(h.deps);
    expect(JSON.stringify(r)).not.toContain(v6);
    expect(JSON.stringify(r)).toContain("x-forwarded-for");
  });

  it("記録の本文の先頭・応答ヘッダの値に IP や識別子が入っていても隠れる", async () => {
    const h = harness({});
    const base = h.deps.send;
    h.deps.send = async (step, headers) => ({
      ...(await base(step, headers)),
      bodyHead: `denied ${RAW_IP}`,
      headers: { via: `1.1 ${RAW_SUB}.workers.dev` },
    });
    const r = await runOrigin(h.deps);
    expect(JSON.stringify(r)).not.toContain(RAW_IP);
    expect(JSON.stringify(r)).not.toContain(RAW_SUB);
  });

  it("E2 の送信には、生の値がそのまま渡る(マスクは記録だけ。送信の値は変わらない)", async () => {
    const h = harness();
    await runOrigin(h.deps);
    const e2 = h.sent.find((s) => s.step.experiment === "E2")!;
    expect(e2.headers.find((x) => x.name === "cf-connecting-ip")!.value).toBe(RAW_IP);
  });
});

describe("runOrigin: 送信は生の値、記録はマスク済みの値(マスク対象を含む値で固定する)", () => {
  // 既定の UA("UA")にはマスク対象が無く、マスクの有無で値が変わらないため、送信値とマスク済みの値の取り違えを
  // 検出できない。E3 のヘッダ(ランナーの観測から導出)・値だけ違うヘッダ・E2 のヘッダのすべてに、マスク対象を入れる。
  const OTHER_IP = "203.0.113.7";
  const SENSITIVE_UA = `ua/${RAW_IP}-${RAW_SUB}`;
  const sensitiveEcho = (place: OriginPlace): EchoFetchResult =>
    ok(
      peet(
        place === "worker"
          ? [
              `User-Agent: ${SENSITIVE_UA}`,
              `x-client: worker ${RAW_IP}`,
              `cf-connecting-ip: ${RAW_IP}`,
              `cf-worker: ${RAW_SUB}.workers.dev`,
              `cf-ray: ${RAW_RAY}-IAD`,
            ]
          : [
              "Host: tls.peet.ws",
              "Connection: keep-alive",
              `User-Agent: ${SENSITIVE_UA}`,
              `x-runner-tag: ${RAW_WORKER}`,
              "accept: */*",
              `x-client: runner ${OTHER_IP}`,
              "accept-encoding: gzip, deflate",
            ],
      ),
    );

  it("前提: マスクすると値が変わる(マスクの有無で結果が分かれる入力になっている)", () => {
    expect(maskText(SENSITIVE_UA, MASK)).not.toBe(SENSITIVE_UA);
    expect(maskText(SENSITIVE_UA, MASK)).toBe("ua/<ip>-<subdomain>");
  });

  it("E3 に渡すヘッダは、ランナーが観測した生の値のまま(マスクした値を送らない)", async () => {
    const h = harness({ echo: sensitiveEcho });
    await runOrigin(h.deps);
    const e3 = h.sent.filter((s) => s.step.experiment === "E3");
    expect(e3).toHaveLength(2);
    for (const s of e3) {
      expect(s.headers).toEqual([
        { name: "User-Agent", value: SENSITIVE_UA },
        { name: "x-runner-tag", value: RAW_WORKER },
        { name: "accept", value: "*/*" },
        { name: "x-client", value: `runner ${OTHER_IP}` },
      ]);
    }
  });

  it("E2 に渡すヘッダは、Worker が実際に付けた生の値のまま(マスクした値を送らない)", async () => {
    const h = harness({ echo: sensitiveEcho });
    await runOrigin(h.deps);
    const e2 = h.sent.filter((s) => s.step.experiment === "E2");
    expect(e2).toHaveLength(2);
    for (const s of e2) {
      expect(s.headers).toEqual([
        { name: "cf-connecting-ip", value: RAW_IP },
        { name: "cf-worker", value: `${RAW_SUB}.workers.dev` },
        { name: "cf-ray", value: `${RAW_RAY}-IAD` },
      ]);
    }
  });

  it("結果の e3.headers は、マスク済みの値だけ(名前は送ったもの、値は置換後)", async () => {
    const r = await runOrigin(harness({ echo: sensitiveEcho }).deps);
    expect(r.e3.headers).toEqual([
      { name: "User-Agent", value: "ua/<ip>-<subdomain>" },
      { name: "x-runner-tag", value: "<worker>" },
      { name: "accept", value: "*/*" },
      { name: "x-client", value: "runner <ip>" },
    ]);
  });

  it("結果の e2.sent は、マスク済みの値だけ", async () => {
    const r = await runOrigin(harness({ echo: sensitiveEcho }).deps);
    expect(r.e2.sent).toEqual([
      { name: "cf-connecting-ip", value: "<ip>" },
      { name: "cf-worker", value: "<subdomain>.workers.dev" },
      { name: "cf-ray", value: "<ray>-IAD" },
    ]);
  });

  it("名前は同じで値が違うヘッダ(valueDiffers)は、Worker 側・ランナー側の両方がマスク済み", async () => {
    const r = await runOrigin(harness({ echo: sensitiveEcho }).deps);
    expect(r.echo.diff!.valueDiffers).toEqual([{ name: "x-client", workerValue: "worker <ip>", runnerValue: "runner <ip>" }]);
  });

  it("両側の観測ヘッダ(echo.worker / echo.runner)と、差分の workerOnly もマスク済み", async () => {
    const r = await runOrigin(harness({ echo: sensitiveEcho }).deps);
    expect(r.echo.worker!.headers).toContainEqual({ name: "User-Agent", value: "ua/<ip>-<subdomain>" });
    expect(r.echo.worker!.headers).toContainEqual({ name: "cf-connecting-ip", value: "<ip>" });
    expect(r.echo.runner!.headers).toContainEqual({ name: "x-runner-tag", value: "<worker>" });
    expect(r.echo.diff!.workerOnly).toContainEqual({ name: "cf-connecting-ip", value: "<ip>" });
  });

  it("結果の JSON のどこにも、生の値(IP 2 種・サブドメイン・Worker 名・cf-ray の一意の部分)が出ない", async () => {
    const r = await runOrigin(harness({ echo: sensitiveEcho }).deps);
    const json = JSON.stringify(r);
    for (const raw of [RAW_IP, OTHER_IP, RAW_SUB, RAW_WORKER, RAW_RAY]) {
      expect(json).not.toContain(raw);
    }
  });

  it("httpbin にフォールバックした場合も、E3 に X-Amzn-Trace-Id を渡さない(エコー側の中継が足したヘッダ)", async () => {
    const asMap = (lines: string[]): Record<string, string> => Object.fromEntries(lines.map((l) => l.split(": ") as [string, string]));
    const h = harness({
      echo: (place, service) => {
        if (service === "peet") {
          return fail(503);
        }
        const lines =
          place === "worker"
            ? ["User-Agent: UA", `cf-connecting-ip: ${RAW_IP}`, "X-Amzn-Trace-Id: Root=1-w"]
            : ["User-Agent: UA", "Accept: */*", "X-Amzn-Trace-Id: Root=1-r"];
        return { status: 200, bodyText: JSON.stringify({ headers: asMap(lines) }), responseHeaders: {}, error: null };
      },
    });
    const r = await runOrigin(h.deps);
    expect(r.echo.serviceUsed).toBe("httpbin");
    for (const s of h.sent.filter((x) => x.step.experiment === "E3")) {
      expect(s.headers).toEqual([
        { name: "User-Agent", value: "UA" },
        { name: "Accept", value: "*/*" },
      ]);
    }
    expect(r.e3.headers.map((x) => x.name)).not.toContain("X-Amzn-Trace-Id");
    // E2 側(差分の経由)にも入らない(従来どおり)
    expect(h.sent.find((x) => x.step.experiment === "E2")!.headers.map((x) => x.name)).toEqual(["cf-connecting-ip"]);
  });
});

describe("runOrigin: 途中経過の通知", () => {
  it("記録が増えるたびに onUpdate が呼ばれ、最後の通知は戻り値と同じ(途中で切れても結果が残る)", async () => {
    const updates: OriginResult[] = [];
    const h = harness();
    const r = await runOrigin(h.deps, { onUpdate: (u) => updates.push(u) });
    const counts = updates.map((u) => u.records.length);
    expect(Math.max(...counts)).toBe(6);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(updates[updates.length - 1]).toEqual(r);
    expect(new Set(counts).size).toBeGreaterThanOrEqual(6);
  });
});
