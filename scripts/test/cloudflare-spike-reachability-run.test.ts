import { describe, expect, it } from "vitest";
import { runReachability, type ReachabilityRunDeps } from "../cloudflare-spike/reachability-run.js";
import type { NetkeibaProbeRecord, ProbeSource } from "../cloudflare-spike/reachability.js";
import { buildRequestPlan, type NetkeibaTarget } from "../cloudflare-spike/targets.js";
import { MAX_NETKEIBA_REQUESTS, MIN_INTERVAL_MS } from "../cloudflare-spike/request-guard.js";

/**
 * #159 到達性の測定の進行(Worker とランナーの対照)。時計・送信を注入できるので、実ネットワークにも
 * 実時間にも依存せず、本数・間隔・送信元ごとの打ち切りを検証できる。
 */

function record(target: NetkeibaTarget, status: number | null): NetkeibaProbeRecord {
  return {
    targetId: target.id,
    url: target.url,
    status,
    bodyLength: status === null ? null : 100,
    charset: null,
    parsedKind: target.kind,
    parsedCount: status === 200 ? 5 : null,
    parseError: null,
    replacementChars: status === 200 ? 0 : null,
    headers: {},
    bodyHead: null,
    error: status === null ? "boom" : null,
  };
}

interface Harness {
  deps: ReachabilityRunDeps;
  sent: { source: ProbeSource; targetId: string; at: number }[];
  clock: { now: number };
}

/** statusOf(source, targetId, n) が返すステータスで応答する。時計は sleep の分だけ進む(送信自体は0ms)。 */
function harness(statusOf: (source: ProbeSource, targetId: string) => number | null): Harness {
  const clock = { now: 1_000_000 };
  const sent: Harness["sent"] = [];
  return {
    clock,
    sent,
    deps: {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
      send: async (source, target) => {
        sent.push({ source, targetId: target.id, at: clock.now });
        return record(target, statusOf(source, target.id));
      },
    },
  };
}

describe("runReachability: 正常系", () => {
  it("計画どおり10本を、Worker → ランナーの順で送り、各記録に送信元を付ける", async () => {
    const h = harness(() => 200);
    const r = await runReachability(buildRequestPlan(), h.deps);
    expect(h.sent).toHaveLength(10);
    expect(r.requestCount).toBe(10);
    expect(r.records.map((x) => x.source)).toEqual(["worker", "runner", "worker", "runner", "worker", "runner", "worker", "runner", "worker", "runner"]);
    expect(r.records.map((x) => x.targetId)).toEqual(h.sent.map((x) => x.targetId));
    expect(r.stoppedReason).toBeNull();
    expect(r.stoppedBySource).toEqual({ worker: null, runner: null });
  });

  it("送信の間隔は、送信元をまたいで2秒以上(隣り合う送信の時刻差の最小値が2000ms)", async () => {
    const h = harness(() => 200);
    await runReachability(buildRequestPlan(), h.deps);
    const gaps = h.sent.slice(1).map((s, i) => s.at - h.sent[i]!.at);
    expect(gaps).toHaveLength(9);
    expect(Math.min(...gaps)).toBe(MIN_INTERVAL_MS);
    expect(gaps.every((g) => g >= MIN_INTERVAL_MS)).toBe(true);
  });

  it("送信が例外を投げても、status=null の記録にして続行する(throw で全体を落とさない)", async () => {
    const h = harness(() => 200);
    let n = 0;
    const deps: ReachabilityRunDeps = {
      ...h.deps,
      send: async (source, target) => {
        n += 1;
        if (n === 1) {
          throw new Error("worker unreachable");
        }
        return h.deps.send(source, target);
      },
    };
    const r = await runReachability(buildRequestPlan(), deps);
    expect(r.records).toHaveLength(10);
    expect(r.records[0]).toMatchObject({ source: "worker", status: null });
    expect(r.records[0]!.error).toContain("worker unreachable");
  });

  it("記録ごとに onRecord が呼ばれる(途中経過の保存用)", async () => {
    const h = harness(() => 200);
    const counts: number[] = [];
    await runReachability(buildRequestPlan(), h.deps, { onRecord: (s) => counts.push(s.records.length) });
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("runReachability: 送信元ごとの打ち切り", () => {
  it("Worker だけが拒否され続けても、2回連続で Worker は止まるが、ランナーの対照は5本とも実施する", async () => {
    const h = harness((source) => (source === "worker" ? 400 : 200));
    const r = await runReachability(buildRequestPlan(), h.deps);
    const worker = r.records.filter((x) => x.source === "worker");
    const runner = r.records.filter((x) => x.source === "runner");
    expect(worker).toHaveLength(2); // 400 が2回連続 → 3本目以降は送らない
    expect(runner).toHaveLength(5); // ランナーは全対象を測る
    expect(r.stoppedBySource).toEqual({ worker: "consecutive-blocks", runner: null });
    expect(r.requestCount).toBe(7);
    // Worker が止まった後もランナーが送られている(順序を保ったまま、止まった送信元の分だけ飛ばす)
    expect(h.sent.map((x) => `${x.source}:${x.targetId}`).slice(-3).every((x) => x.startsWith("runner:"))).toBe(true);
  });

  it("2回連続の拒否で止まっても、別のホストの結果が少なくとも1本は残る(ホストが交互の順序)", async () => {
    const h = harness((source) => (source === "worker" ? 403 : 200));
    const r = await runReachability(buildRequestPlan(), h.deps);
    const workerHosts = new Set(r.records.filter((x) => x.source === "worker").map((x) => new URL(x.url).hostname));
    expect(r.records.filter((x) => x.source === "worker")).toHaveLength(2);
    expect(workerHosts.size).toBe(2); // 同じホストの2本ではなく、別ホスト2本で打ち切り
  });

  it("両方の送信元が拒否され続ければ、それぞれ2本で止まる(合計4本)", async () => {
    const h = harness(() => 429);
    const r = await runReachability(buildRequestPlan(), h.deps);
    expect(r.requestCount).toBe(4);
    expect(r.records.filter((x) => x.source === "worker")).toHaveLength(2);
    expect(r.records.filter((x) => x.source === "runner")).toHaveLength(2);
    expect(r.stoppedBySource).toEqual({ worker: "consecutive-blocks", runner: "consecutive-blocks" });
  });

  it("拒否の間に成功が挟まれば連続は途切れる(Worker: 400, 200, 400, 200, 400 は止まらず5本とも送る)", async () => {
    const seq = [400, 200, 400, 200, 400];
    let i = 0;
    const h = harness((source) => (source === "worker" ? seq[i++]! : 200));
    const r = await runReachability(buildRequestPlan(), h.deps);
    expect(r.records.filter((x) => x.source === "worker")).toHaveLength(5);
    expect(r.stoppedBySource.worker).toBeNull();
  });

  it("最後の1本で2回連続の拒否になった送信元も、stoppedBySource に記録する", async () => {
    const seq = [200, 200, 200, 400, 400];
    let i = 0;
    const h = harness((source) => (source === "worker" ? seq[i++]! : 200));
    const r = await runReachability(buildRequestPlan(), h.deps);
    expect(r.records.filter((x) => x.source === "worker")).toHaveLength(5);
    expect(r.stoppedBySource.worker).toBe("consecutive-blocks");
  });
});

describe("runReachability: 本数の上限", () => {
  it("計画が上限を超えていても、合計は上限(10本)を超えて送らない。stoppedReason は max-requests", async () => {
    const h = harness(() => 200);
    const longPlan = [...buildRequestPlan(), ...buildRequestPlan()];
    expect(longPlan.length).toBeGreaterThan(MAX_NETKEIBA_REQUESTS);
    const r = await runReachability(longPlan, h.deps);
    expect(h.sent).toHaveLength(MAX_NETKEIBA_REQUESTS);
    expect(r.requestCount).toBe(MAX_NETKEIBA_REQUESTS);
    expect(r.stoppedReason).toBe("max-requests");
  });
});
