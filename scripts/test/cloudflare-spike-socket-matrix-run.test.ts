import { describe, expect, it } from "vitest";
import type { SocketFetchMeta } from "../cloudflare-spike/http1.js";
import type { NetkeibaProbeRecord } from "../cloudflare-spike/reachability.js";
import { MIN_INTERVAL_MS } from "../cloudflare-spike/request-guard.js";
import {
  buildSocketMatrixPlan,
  SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT,
  REFERENCE_E3_SHUTUBA_BYTES,
} from "../cloudflare-spike/socket-matrix-plan.js";
import {
  classifySubrequestError,
  describeSocketMatrix,
  runSocketMatrix,
  summarizeSocketMatrix,
  type MatrixRecord,
  type MatrixSendOutcome,
  type SocketMatrixDeps,
  type SubrequestProbeResult,
} from "../cloudflare-spike/socket-matrix-run.js";
import type { MatrixStep } from "../cloudflare-spike/socket-matrix-plan.js";

/**
 * #162 段階1(socket-matrix)の進行・集計・読み。時計・送信・DO の呼び出し試験を注入できるので、実ネットワークにも
 * 実時間にも依存せず、順序・本数・間隔・打ち切り・マスク・要約・読みを検証できる。
 */

const MASK = { subdomain: "mysub", workerName: "keiba-cf-spike-77-1" };

function rec(over: Partial<NetkeibaProbeRecord> = {}): NetkeibaProbeRecord {
  return {
    targetId: "central-shutuba",
    url: "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211",
    status: 200,
    bodyLength: 1000,
    charset: "UTF-8",
    parsedKind: "shutuba",
    parsedCount: 16,
    parseError: null,
    replacementChars: 0,
    headers: {},
    bodyHead: null,
    error: null,
    ...over,
  };
}

function meta(over: Partial<SocketFetchMeta> = {}): SocketFetchMeta {
  return {
    status: 200,
    framing: "chunked",
    contentEncoding: null,
    receivedBytes: 1100,
    wireBodyBytes: 1000,
    decodedBytes: 1000,
    bodySha256: "aaaaaaaaaaaaaaaa",
    openedMs: 20,
    firstByteMs: 60,
    totalMs: 100,
    ...over,
  };
}

interface Harness {
  deps: SocketMatrixDeps;
  sent: { id: string; at: number }[];
  sleeps: number[];
  probeCalls: number[];
  clock: { t: number };
}

/** 偽の時計(sleep で進む)・送信(スクリプト)・DO の呼び出し試験を持つ。 */
function harness(script: (step: MatrixStep, index: number) => MatrixSendOutcome | Error, probe?: () => Promise<SubrequestProbeResult>): Harness {
  const clock = { t: 1_000_000 };
  const sent: { id: string; at: number }[] = [];
  const sleeps: number[] = [];
  const probeCalls: number[] = [];
  const deps: SocketMatrixDeps = {
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    send: async (step) => {
      sent.push({ id: step.id, at: clock.t });
      const out = script(step, sent.length - 1);
      if (out instanceof Error) {
        throw out;
      }
      return out;
    },
    subrequestProbe: async (count) => {
      probeCalls.push(count);
      return probe !== undefined ? probe() : okProbe(count);
    },
    mask: MASK,
  };
  return { deps, sent, sleeps, probeCalls, clock };
}

function okProbe(count: number): SubrequestProbeResult {
  return { ran: true, requested: count, attempted: count, succeeded: count, firstFailureAt: null, errorKind: null, error: null, httpStatus: 200 };
}

const ok = (over: Partial<NetkeibaProbeRecord> = {}, m: Partial<SocketFetchMeta> = {}): MatrixSendOutcome => ({
  record: rec(over),
  meta: meta(m),
  instance: { id: "do-instance-1", call: 1 },
});
const blocked = (): MatrixSendOutcome => ({ record: rec({ status: 400, bodyLength: 0, parsedCount: null }), meta: meta({ status: 400, wireBodyBytes: 0, decodedBytes: 0 }), instance: { id: "do-instance-1", call: 1 } });
const networkError = (): MatrixSendOutcome => ({ record: rec({ status: null, bodyLength: null, parsedCount: null, error: "boom" }), meta: null, instance: null });

describe("runSocketMatrix: 進行・本数・間隔", () => {
  it("計画の 9 本を、計画の順に1本ずつ送り、送信の間隔は 2 秒以上(合計 9 本)", async () => {
    const h = harness(() => ok());
    const r = await runSocketMatrix(h.deps);
    expect(h.sent.map((s) => s.id)).toEqual(buildSocketMatrixPlan().map((s) => s.id));
    expect(h.sent).toHaveLength(9);
    for (let i = 1; i < h.sent.length; i += 1) {
      expect(h.sent[i]!.at - h.sent[i - 1]!.at).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    }
    // 間隔は、1本目の前には待たない・2本目以降は待つ(守りが実際に効いている)。
    expect(h.sleeps).toHaveLength(8);
    expect(r.netkeibaRequestCount).toBe(9);
    expect(r.plannedCount).toBe(9);
    expect(r.stoppedReason).toBeNull();
    expect(r.skippedStepIds).toEqual([]);
  });

  it("記録には、ステップの ID・方式・役割・対・メタ情報・DO のインスタンスと、最初の送信からの経過 ms が載る", async () => {
    const h = harness(() => ok());
    const r = await runSocketMatrix(h.deps);
    expect(r.records.map((x) => x.stepId)).toEqual(h.sent.map((s) => s.id));
    const s1g = r.records.find((x) => x.stepId === "S1g")!;
    expect(s1g).toMatchObject({ variant: "gzip", role: "compression", pairWith: "S1", instance: { id: "do-instance-1", call: 1 } });
    expect(s1g.meta).toEqual(meta());
    expect(r.records[0]!.sentAtMs).toBe(0);
    expect(r.records[1]!.sentAtMs).toBe(MIN_INTERVAL_MS);
  });

  it("400 が2回連続したら、netkeiba へはそれ以上送らず、残りは送らなかったステップとして記録する", async () => {
    const h = harness((_s, i) => (i < 2 ? blocked() : ok()));
    const r = await runSocketMatrix(h.deps);
    expect(h.sent.map((s) => s.id)).toEqual(["S1", "R1"]);
    expect(r.netkeibaRequestCount).toBe(2);
    expect(r.stoppedReason).toBe("consecutive-blocks");
    expect(r.skippedStepIds).toEqual(["N1", "O1", "T1", "N2", "S1r", "S1g", "T1g"]);
    expect(r.skippedStepIds.length + r.records.length).toBe(9);
  });

  it("2回連続でなければ打ち切らない(400 → 200 → 400 は連続ではない)", async () => {
    const h = harness((_s, i) => (i === 0 || i === 2 ? blocked() : ok()));
    const r = await runSocketMatrix(h.deps);
    expect(r.netkeibaRequestCount).toBe(9);
    expect(r.stoppedReason).toBeNull();
  });

  it("通信エラー(status=null)は拒否に数えず、連続も途切れさせない(400 → エラー → 400 で打ち切る)", async () => {
    const h = harness((_s, i) => (i === 1 ? networkError() : blocked()));
    const r = await runSocketMatrix(h.deps);
    expect(h.sent.map((s) => s.id)).toEqual(["S1", "R1", "N1"]);
    expect(r.stoppedReason).toBe("consecutive-blocks");
  });

  it("403 と 429 も拒否に数える(403 → 429 で打ち切る)", async () => {
    const h = harness((_s, i) => ({ record: rec({ status: i === 0 ? 403 : 429 }), meta: null, instance: null }));
    const r = await runSocketMatrix(h.deps);
    expect(r.netkeibaRequestCount).toBe(2);
    expect(r.stoppedReason).toBe("consecutive-blocks");
  });

  it("送信が例外を投げたら、status=null の記録にして理由を残す(打ち切りの数え方は通信エラーと同じ)", async () => {
    const h = harness((_s, i) => (i === 0 ? new Error("DO が応答しない") : ok()));
    const r = await runSocketMatrix(h.deps);
    expect(r.records[0]).toMatchObject({ stepId: "S1", status: null, meta: null, instance: null });
    expect(r.records[0]!.error).toMatch(/DO が応答しない/);
    expect(r.netkeibaRequestCount).toBe(9);
  });

  it("本数の上限(守りの設定)を超えるときは max-requests で止まる", async () => {
    const h = harness(() => ok());
    const r = await runSocketMatrix(h.deps, { guard: { maxRequests: 3 } });
    expect(r.netkeibaRequestCount).toBe(3);
    expect(r.stoppedReason).toBe("max-requests");
    expect(r.skippedStepIds).toHaveLength(6);
  });

  it("打ち切られても、netkeiba へ出ない DO の呼び出し試験は実行する(60 回を要求)", async () => {
    const h = harness(() => blocked());
    const r = await runSocketMatrix(h.deps);
    expect(h.probeCalls).toEqual([SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT]);
    expect(r.subrequestProbe).toEqual(okProbe(60));
  });

  it("DO の呼び出し試験が例外でも、netkeiba の結果は失わない(ran=false と理由を残す)", async () => {
    const h = harness(() => ok(), async () => {
      throw new Error("probe failed mysub.workers.dev");
    });
    const r = await runSocketMatrix(h.deps);
    expect(r.records).toHaveLength(9);
    expect(r.subrequestProbe).toMatchObject({ ran: false, requested: 60 });
    expect(r.subrequestProbe!.error).toMatch(/probe failed/);
    expect(r.subrequestProbe!.error).not.toContain("mysub");
  });

  it("parseError にも、生の値が残らないようにマスクする", async () => {
    const h = harness(() => ({
      record: rec({ status: 200, parsedCount: null, parseError: "keiba-cf-spike-77-1.mysub.workers.dev から 203.0.113.7 のパースに失敗" }),
      meta: meta(),
      instance: null,
    }));
    const r = await runSocketMatrix(h.deps, { plan: buildSocketMatrixPlan().slice(0, 1) });
    const json = JSON.stringify(r);
    expect(r.records[0]!.parseError).toMatch(/パースに失敗/);
    expect(json).not.toContain("mysub");
    expect(json).not.toContain("203.0.113.7");
    expect(json).not.toContain("keiba-cf-spike-77-1");
  });

  it("DO の呼び出し試験が成功扱いで返した error(HTTP の失敗の本文など)にも、生の値が残らないようにマスクする", async () => {
    const h = harness(() => ok(), async () => ({
      ran: false,
      requested: 60,
      attempted: null,
      succeeded: null,
      firstFailureAt: null,
      errorKind: null,
      error: "HTTP 500: keiba-cf-spike-77-1.mysub.workers.dev 203.0.113.7",
      httpStatus: 500,
    }));
    const r = await runSocketMatrix(h.deps, { plan: buildSocketMatrixPlan().slice(0, 1) });
    const json = JSON.stringify(r.subrequestProbe);
    expect(json).not.toContain("mysub");
    expect(json).not.toContain("203.0.113.7");
    expect(json).not.toContain("keiba-cf-spike-77-1");
    expect(r.subrequestProbe!.error).toMatch(/HTTP 500/);
  });

  it("計画を差し替えられ、onUpdate は記録が増えるたび(と試験の後)に呼ばれる", async () => {
    const updates: number[] = [];
    const plan = buildSocketMatrixPlan().slice(0, 2);
    const h = harness(() => ok());
    await runSocketMatrix(h.deps, { plan, onUpdate: (x) => updates.push(x.records.length) });
    expect(h.sent.map((s) => s.id)).toEqual(["S1", "R1"]);
    expect(updates[0]).toBe(1);
    expect(updates.at(-1)).toBe(2);
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });
});

describe("runSocketMatrix: 公開される結果のマスク", () => {
  it("エラー・本文の先頭・応答ヘッダから、サブドメイン・Worker 名・IP・cf-ray の一意の部分を隠す", async () => {
    const h = harness(() => ({
      record: rec({
        status: 502,
        error: "keiba-cf-spike-77-1.mysub.workers.dev から 203.0.113.7 へ",
        bodyHead: "mysub 203.0.113.7",
        headers: { "cf-ray": "abcdef0123456789-ATL", server: "mysub" },
      }),
      meta: null,
      instance: null,
    }));
    const r = await runSocketMatrix(h.deps, { plan: buildSocketMatrixPlan().slice(0, 1) });
    const json = JSON.stringify(r);
    expect(json).not.toContain("mysub");
    expect(json).not.toContain("keiba-cf-spike-77-1");
    expect(json).not.toContain("203.0.113.7");
    expect(json).not.toContain("abcdef0123456789");
    expect(r.records[0]!.headers["cf-ray"]).toBe("<ray>-ATL");
  });
});

/** 集計の入力にする記録を作る。 */
function mr(stepId: string, over: Partial<MatrixRecord> = {}): MatrixRecord {
  const step = buildSocketMatrixPlan().find((s) => s.id === stepId)!;
  return {
    ...rec({ targetId: step.target.id, url: step.target.url, parsedKind: step.target.kind }),
    stepId,
    variant: step.variant,
    role: step.role,
    pairWith: step.pairWith,
    meta: meta(),
    instance: { id: "do-instance-1", call: 1 },
    sentAtMs: 0,
    ...over,
  };
}

describe("summarizeSocketMatrix: 圧縮の比較(identity と gzip の対)", () => {
  it("対ごとに、線上の本文バイト数・展開後・比率・ms・本文の一致を並べる", () => {
    const records = [
      mr("S1", { meta: meta({ wireBodyBytes: 276708, decodedBytes: 276708, totalMs: 300, firstByteMs: 120, bodySha256: "h1" }) }),
      mr("S1g", { meta: meta({ contentEncoding: "gzip", wireBodyBytes: 55342, decodedBytes: 276708, totalMs: 200, firstByteMs: 100, bodySha256: "h1" }) }),
    ];
    const rows = summarizeSocketMatrix(records).compression;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stepId: "S1g",
      pairWith: "S1",
      identityStatus: 200,
      gzipStatus: 200,
      identityWireBytes: 276708,
      gzipWireBytes: 55342,
      gzipDecodedBytes: 276708,
      wireRatio: 0.2,
      identityTotalMs: 300,
      gzipTotalMs: 200,
      contentEncoding: "gzip",
      bodyHashEqual: true,
    });
    // 比率は gzip の線上のバイト数 / identity の線上のバイト数(1 より小さければ圧縮が効いている)。
    expect(rows[0]!.wireRatio).toBeCloseTo(55342 / 276708, 3);
  });

  it("本文のハッシュが違っても、失敗扱いにせず事実として false を記録する", () => {
    const records = [mr("S1", { meta: meta({ bodySha256: "h1" }) }), mr("S1g", { meta: meta({ contentEncoding: "gzip", wireBodyBytes: 100, bodySha256: "h2" }) })];
    const row = summarizeSocketMatrix(records).compression[0]!;
    expect(row.bodyHashEqual).toBe(false);
    expect(row.gzipStatus).toBe(200);
  });

  it("対の identity が無い(拒否・未実施)ときは、identity 側を null にして、比率・一致も null", () => {
    const records = [mr("S1g", { meta: meta({ contentEncoding: "gzip", wireBodyBytes: 100 }) })];
    const row = summarizeSocketMatrix(records).compression[0]!;
    expect(row).toMatchObject({ identityStatus: null, identityWireBytes: null, wireRatio: null, bodyHashEqual: null });
  });

  it("gzip の取得が拒否(400。メタは本文0バイト)のとき、比率は出さない(本文0バイトの比率を読ませない)", () => {
    const records = [mr("S1"), mr("S1g", { status: 400, bodyLength: 0, parsedCount: null, meta: meta({ status: 400, wireBodyBytes: 0, decodedBytes: 0 }) })];
    const row = summarizeSocketMatrix(records).compression[0]!;
    expect(row.gzipStatus).toBe(400);
    expect(row.wireRatio).toBeNull();
    expect(row.bodyHashEqual).toBeNull();
  });

  it("メタが無い(通信エラー)ときは、バイト・ms を null にする", () => {
    const records = [mr("S1"), mr("S1g", { status: null, meta: null, error: "x" })];
    const row = summarizeSocketMatrix(records).compression[0]!;
    expect(row).toMatchObject({ gzipStatus: null, gzipWireBytes: null, gzipTotalMs: null });
  });
});

describe("summarizeSocketMatrix: 再現性・網羅・DO のインスタンス", () => {
  it("再現性: 1本目と2本目のステータス・バイト数・ハッシュ・間隔(ms)・同じ DO インスタンスだったかを並べる", () => {
    const records = [
      mr("S1", { sentAtMs: 2000, instance: { id: "A", call: 1 }, meta: meta({ decodedBytes: 500, bodySha256: "h1", totalMs: 100 }) }),
      mr("S1r", { sentAtMs: 14000, instance: { id: "A", call: 7 }, meta: meta({ decodedBytes: 500, bodySha256: "h1", totalMs: 90 }) }),
    ];
    const rows = summarizeSocketMatrix(records).repeat;
    expect(rows).toEqual([
      {
        stepId: "S1r",
        pairWith: "S1",
        targetId: "central-shutuba",
        firstStatus: 200,
        secondStatus: 200,
        bytesEqual: true,
        hashEqual: true,
        gapMs: 12000,
        sameInstance: true,
        firstTotalMs: 100,
        secondTotalMs: 90,
      },
    ]);
  });

  it("本文のバイト数もハッシュも違えば false(事実として記録する。失敗扱いにしない)。別のインスタンスなら sameInstance=false", () => {
    const records = [
      mr("S1", { sentAtMs: 1000, instance: { id: "A", call: 1 }, meta: meta({ decodedBytes: 500, bodySha256: "h1" }) }),
      mr("S1r", { sentAtMs: 14000, instance: { id: "B", call: 1 }, meta: meta({ decodedBytes: 510, bodySha256: "h2" }) }),
    ];
    const row = summarizeSocketMatrix(records).repeat[0]!;
    expect(row).toMatchObject({ bytesEqual: false, hashEqual: false, sameInstance: false, gapMs: 13000 });
  });

  it("2本目が無い(打ち切り)ときは、再現性の行を作らない", () => {
    expect(summarizeSocketMatrix([mr("S1")]).repeat).toEqual([]);
  });

  it("網羅: identity の取得先ごとに、判定・件数・文字化けを並べる(gzip・repeat は網羅に含めない)", () => {
    const records = [mr("S1"), mr("R1", { status: 400, bodyLength: 0, parsedCount: null }), mr("S1r"), mr("S1g")];
    const rows = summarizeSocketMatrix(records).coverage;
    expect(rows.map((r) => r.stepId)).toEqual(["S1", "R1"]);
    expect(rows[0]).toMatchObject({ targetId: "central-shutuba", host: "race.netkeiba.com", status: 200, verdict: "ok", parsedCount: 16 });
    expect(rows[1]).toMatchObject({ host: "db.netkeiba.com", status: 400, verdict: "blocked" });
  });

  it("DO のインスタンス: 異なる ID の数と、呼び出し通番の最大値", () => {
    const records = [mr("S1", { instance: { id: "A", call: 1 } }), mr("R1", { instance: { id: "A", call: 2 } }), mr("N1", { instance: { id: "B", call: 1 } }), mr("O1", { instance: null })];
    expect(summarizeSocketMatrix(records).instances).toEqual({ distinctIds: 2, maxCall: 2 });
  });
});

describe("classifySubrequestError(DO の呼び出し試験の失敗の種類)", () => {
  it.each([
    ["Error: Too many subrequests by single worker invocation.", "subrequest-limit"],
    ["too many subrequests", "subrequest-limit"],
    ["Too many API requests by single worker invocation.", "subrequest-limit"],
    ["Too many open connections", "other"],
    ["Worker exceeded CPU time limit.", "cpu-limit"],
    ["Exceeded CPU", "cpu-limit"],
    ["something else", "other"],
    ["", "other"],
  ])("%j は %s", (message, kind) => {
    expect(classifySubrequestError(message)).toBe(kind);
  });
});

describe("describeSocketMatrix: 事実・推測・限界", () => {
  const allOk = (): MatrixRecord[] =>
    buildSocketMatrixPlan().map((s) =>
      mr(s.id, {
        meta: meta({
          contentEncoding: s.variant === "gzip" ? "gzip" : null,
          wireBodyBytes: s.variant === "gzip" ? 200 : 1000,
          bodySha256: "same",
        }),
      }),
    );
  const read = (records: MatrixRecord[], probe: SubrequestProbeResult | null = okProbe(60), stoppedReason: string | null = null) =>
    describeSocketMatrix(records, summarizeSocketMatrix(records), probe, stoppedReason);

  it("限界は常に併記される: 標本(各セル n=1・1アカウント・1回の実行)・ms のばらつき・ハッシュの不一致の読み・プラン未確認", () => {
    const text = read(allOk()).limitations.join("\n");
    expect(text).toMatch(/n=1/);
    expect(text).toMatch(/1回の実行/);
    expect(text).toMatch(/ms/);
    expect(text).toMatch(/ハッシュ.*(更新|不一致)/);
    expect(text).toMatch(/プラン/);
  });

  it("事実: 取得先ごとのステータスと、出馬表の本文バイト数が #160 E3 と同じか", () => {
    const facts = read(allOk()).facts.join("\n");
    expect(facts).toContain("S1: 200");
    expect(facts).toContain(String(REFERENCE_E3_SHUTUBA_BYTES));
    const same = allOk();
    same[0] = mr("S1", { bodyLength: REFERENCE_E3_SHUTUBA_BYTES });
    expect(read(same).facts.join("\n")).toMatch(/同じ/);
    const differ = allOk();
    differ[0] = mr("S1", { bodyLength: REFERENCE_E3_SHUTUBA_BYTES + 1 });
    expect(read(differ).facts.join("\n")).toMatch(/違う/);
  });

  it("全部通ったとき: 推測は『通った』ことを述べ、推測であって原因の分離ではないことを添える", () => {
    const r = read(allOk());
    expect(r.inferences.join("\n")).toMatch(/DO の中から/);
    expect(r.inferences.join("\n")).toMatch(/通っ/);
    // 事実の欄に、推測の言い回し(疑い・可能性・推測)を混ぜない。
    expect(r.facts.join("\n")).not.toMatch(/疑い|可能性|推測/);
  });

  it("S1 が拒否されたとき: 事実にステータスを載せ、推測は『通った』と言わない", () => {
    const records = [mr("S1", { status: 400, bodyLength: 0, parsedCount: null })];
    const r = read(records, okProbe(60), "consecutive-blocks");
    expect(r.facts.join("\n")).toContain("S1: 400");
    expect(r.inferences.join("\n")).not.toMatch(/通っ/);
    expect(r.facts.join("\n")).toMatch(/打ち切り|consecutive-blocks/);
  });

  it("gzip が拒否され identity が通ったとき: Accept-Encoding の疑いを推測として述べ、2本だけの標本であることを添える", () => {
    const records = allOk().map((x) => (x.variant === "gzip" ? { ...x, status: 400, bodyLength: 0, parsedCount: null, meta: meta({ status: 400, wireBodyBytes: 0, decodedBytes: 0 }) } : x));
    const r = read(records);
    expect(r.inferences.join("\n")).toMatch(/Accept-Encoding/);
    expect(r.inferences.join("\n")).toMatch(/疑い/);
    expect(r.facts.join("\n")).toContain("S1g: 400");
  });

  it("gzip が通ったとき: 圧縮後の線上のバイト数の比を事実として載せる(採用の判断は読みに含めない)", () => {
    const facts = read(allOk()).facts.join("\n");
    expect(facts).toMatch(/gzip/);
    expect(facts).toContain("0.2");
    expect(read(allOk()).inferences.join("\n")).not.toMatch(/採用/);
  });

  it("再現性: 本文のハッシュが一致すれば一致、違えば不一致を事実として載せる(失敗とは書かない)", () => {
    const same = read(allOk()).facts.join("\n");
    expect(same).toMatch(/S1r.*(?<!不)一致/);
    const records = allOk().map((x) => (x.stepId === "S1r" ? { ...x, meta: meta({ bodySha256: "other" }) } : x));
    const differ = read(records).facts.join("\n");
    expect(differ).toMatch(/S1r.*不一致/);
    expect(differ).not.toMatch(/失敗/);
  });

  it("DO の呼び出し試験: 全部成功なら、50 を超えても失敗しなかった事実を載せる", () => {
    const facts = read(allOk(), okProbe(60)).facts.join("\n");
    expect(facts).toMatch(/60 回.*すべて成功|60 回すべて成功/);
  });

  it("DO の呼び出し試験: 51 回目で subrequest の上限が出たら、事実として載せ、推測は『DO の呼び出しも数えられる疑い』", () => {
    const probe: SubrequestProbeResult = { ran: true, requested: 60, attempted: 51, succeeded: 50, firstFailureAt: 51, errorKind: "subrequest-limit", error: "Too many subrequests", httpStatus: 200 };
    const r = read(allOk(), probe);
    expect(r.facts.join("\n")).toMatch(/51 回目/);
    expect(r.inferences.join("\n")).toMatch(/subrequest/);
    expect(r.inferences.join("\n")).toMatch(/疑い/);
  });

  it("DO の呼び出し試験: CPU 上限など別の理由で失敗したら、subrequest の数え方については何も言わない", () => {
    const probe: SubrequestProbeResult = { ran: true, requested: 60, attempted: 30, succeeded: 29, firstFailureAt: 30, errorKind: "cpu-limit", error: "Worker exceeded CPU time limit.", httpStatus: 200 };
    const r = read(allOk(), probe);
    expect(r.facts.join("\n")).toMatch(/30 回目/);
    expect(r.inferences.join("\n")).not.toMatch(/subrequest の上限に数え/);
    expect(r.inferences.join("\n")).toMatch(/決められない|分から/);
  });

  it("DO の呼び出し試験が実行できなかった(ran=false)ときは、その事実だけを載せる", () => {
    const probe: SubrequestProbeResult = { ran: false, requested: 60, attempted: null, succeeded: null, firstFailureAt: null, errorKind: null, error: "HTTP 500", httpStatus: 500 };
    const r = read(allOk(), probe);
    expect(r.facts.join("\n")).toMatch(/実行できなかった/);
  });

  it("DO のインスタンスが全記録で同じなら、その事実を載せる(同じインスタンスでの再取得か)", () => {
    expect(read(allOk()).facts.join("\n")).toMatch(/DO のインスタンス.*1/);
  });
});

/**
 * レビュー指摘の修正(#162 段階1)。実測の結果を誤読させる記録・文面を出さない:
 *  1. 本文の比較(バイト数・ハッシュ・「サーバ側の更新」の推測)は、両方が 2xx のときだけ行う。
 *  2. gzip 拒否の推測(Accept-Encoding の引き金)は、直前の identity の取得が拒否されていないときだけ出す。
 *  3. gzip で返ったか(content-encoding)を事実・表に出す。圧縮されなかったら「gzip の線上の本文」とは書かない。
 */
const blockedMeta = (over: Partial<SocketFetchMeta> = {}): SocketFetchMeta =>
  meta({ status: 403, wireBodyBytes: 150, decodedBytes: 150, bodySha256: "ffffffffffffffff", ...over });
const refused = (stepId: string, status = 403, over: Partial<MatrixRecord> = {}): MatrixRecord =>
  mr(stepId, { status, bodyLength: 150, parsedCount: null, meta: blockedMeta({ status }), ...over });
const readAll = (records: MatrixRecord[], probe: SubrequestProbeResult | null = okProbe(60)) =>
  describeSocketMatrix(records, summarizeSocketMatrix(records), probe, null);

describe("指摘1: 本文の比較は、両方が 2xx のときだけ行う", () => {
  it("再現性: 2本目(S1r)が 403(本文あり・ハッシュが違う)でも、本文の比較は null で、『本文が違った』の推測を出さない", () => {
    const records = [mr("S1", { meta: meta({ bodySha256: "aaaaaaaaaaaaaaaa", decodedBytes: 500 }) }), refused("S1r", 403)];
    const row = summarizeSocketMatrix(records).repeat[0]!;
    expect(row).toMatchObject({ firstStatus: 200, secondStatus: 403, bytesEqual: null, hashEqual: null });
    const r = readAll(records);
    expect(r.inferences.join("\n")).not.toMatch(/本文が違った|サーバ側の更新|拒否や不具合とは読まない/);
    expect(r.facts.join("\n")).toMatch(/S1r.*比較しない.*2xx/);
    // 比較しなくても、ステータスの事実は載せる。
    expect(r.facts.join("\n")).toMatch(/S1r.*200 → 403/);
  });

  it("再現性: 1本目が 403 でも、2本目が 200 でも、比較しない(片方でも非 2xx なら null)", () => {
    const records = [refused("S1", 403), mr("S1r", { meta: meta({ bodySha256: "aaaaaaaaaaaaaaaa" }) })];
    expect(summarizeSocketMatrix(records).repeat[0]).toMatchObject({ bytesEqual: null, hashEqual: null });
  });

  it("再現性: 両方が 2xx なら、従来どおり比較する(ハッシュが違えば false と、正当な更新の推測)", () => {
    const records = [mr("S1", { meta: meta({ bodySha256: "aaaaaaaaaaaaaaaa", decodedBytes: 500 }) }), mr("S1r", { meta: meta({ bodySha256: "bbbbbbbbbbbbbbbb", decodedBytes: 510 }) })];
    expect(summarizeSocketMatrix(records).repeat[0]).toMatchObject({ bytesEqual: false, hashEqual: false });
    expect(readAll(records).inferences.join("\n")).toMatch(/正当な違いの可能性/);
  });

  it("圧縮: gzip が 403(本文 150 バイトのエラー応答)でも、比率・本文のハッシュは出さない(null)。ステータスは載る", () => {
    const records = [mr("S1", { meta: meta({ wireBodyBytes: 1000 }) }), refused("S1g", 403, { variant: "gzip" })];
    const row = summarizeSocketMatrix(records).compression[0]!;
    expect(row).toMatchObject({ identityStatus: 200, gzipStatus: 403, wireRatio: null, bodyHashEqual: null });
    expect(row.gzipWireBytes).toBe(150);
  });

  it("圧縮: identity が 403 でも、gzip が 200 でも、比率・ハッシュは null(片方でも非 2xx なら比較しない)", () => {
    const records = [refused("S1", 403), mr("S1g", { meta: meta({ contentEncoding: "gzip", wireBodyBytes: 200 }) })];
    expect(summarizeSocketMatrix(records).compression[0]).toMatchObject({ identityStatus: 403, gzipStatus: 200, wireRatio: null, bodyHashEqual: null });
  });

  it("圧縮: gzip が 403 のとき、事実の欄に『倍』の比率や『ハッシュ不一致』を載せない(比較しないと書く)", () => {
    const records = [mr("S1", { meta: meta({ wireBodyBytes: 1000 }) }), refused("S1g", 403, { variant: "gzip" })];
    const facts = readAll(records).facts.join("\n");
    expect(facts).not.toMatch(/S1g: gzip の線上/);
    expect(facts).not.toMatch(/不一致/);
    expect(facts).toMatch(/S1g.*比較しない/);
  });
});

describe("指摘2: gzip 拒否の推測は、直前の identity が拒否されていないときだけ", () => {
  it("S1=200・S1r=403・S1g=403 では、Accept-Encoding の引き金とは言わず、時間経過による拒否と区別できないと書く", () => {
    const records = [mr("S1"), refused("S1r", 403), refused("S1g", 403, { variant: "gzip" })];
    const inf = readAll(records).inferences.join("\n");
    expect(inf).not.toMatch(/引き金/);
    expect(inf).toMatch(/区別できない/);
    expect(inf).toMatch(/S1g/);
  });

  it("S1=200・S1r=200・S1g=403 では、(従来どおり)引き金の疑いを推測として出す", () => {
    const records = [mr("S1"), mr("S1r"), refused("S1g", 403, { variant: "gzip" })];
    const inf = readAll(records).inferences.join("\n");
    expect(inf).toMatch(/S1g.*引き金/);
    expect(inf).not.toMatch(/区別できない/);
  });

  it("『直前』は、そのステップより前で最後の identity の記録(T1g の直前の identity は S1r。間に gzip の S1g があっても)", () => {
    // S1r=403 の後に S1g(gzip)=403、T1g(gzip)=403。T1 は 200。T1g の直前の identity は S1r で拒否されている。
    const records = [mr("S1"), mr("T1"), refused("S1r", 403), refused("S1g", 403, { variant: "gzip" }), refused("T1g", 403, { variant: "gzip" })];
    const inf = readAll(records).inferences.join("\n");
    expect(inf).not.toMatch(/T1g.*引き金/);
    expect(inf).toMatch(/T1g.*区別できない/);
  });

  it("T1g の直前の identity(S1r)が通っていれば、S1g が拒否されていても T1g には引き金の疑いを出す", () => {
    const records = [mr("S1"), mr("T1"), mr("S1r"), refused("S1g", 403, { variant: "gzip" }), refused("T1g", 403, { variant: "gzip" })];
    const inf = readAll(records).inferences.join("\n");
    expect(inf).toMatch(/T1g.*引き金/);
  });

  it.each([[400], [403], [429]])("gzip が %i で拒否されたときも、引き金の疑いを推測として出す(400・403・429 はいずれも拒否)", (status) => {
    const records = [mr("S1"), mr("S1r"), refused("S1g", status, { variant: "gzip" })];
    expect(readAll(records).inferences.join("\n")).toMatch(/S1g.*引き金/);
  });

  it("直前の identity が通信エラー(status=null)のときも、引き金とは言わない(通ったとは言えない)", () => {
    const records = [mr("S1"), mr("S1r", { status: null, meta: null, error: "x" }), refused("S1g", 403, { variant: "gzip" })];
    const inf = readAll(records).inferences.join("\n");
    expect(inf).not.toMatch(/引き金/);
    expect(inf).toMatch(/区別できない/);
  });

  it("対の identity(S1)自体が拒否されているときも、引き金とは言わない", () => {
    const records = [refused("S1", 403), mr("S1r"), refused("S1g", 403, { variant: "gzip" })];
    expect(readAll(records).inferences.join("\n")).not.toMatch(/引き金/);
  });
});

describe("指摘3: gzip で返ったか(content-encoding)を事実・表に出す", () => {
  it("gzip で返った: 事実に content-encoding: gzip を載せ、行の compressed は true", () => {
    const records = [mr("S1", { meta: meta({ wireBodyBytes: 1000 }) }), mr("S1g", { meta: meta({ contentEncoding: "gzip", wireBodyBytes: 200 }) })];
    expect(summarizeSocketMatrix(records).compression[0]).toMatchObject({ contentEncoding: "gzip", compressed: true });
    expect(readAll(records).facts.join("\n")).toMatch(/S1g.*content-encoding: gzip/);
  });

  it("gzip を要求したのに圧縮されずに返った(content-encoding なし): 『圧縮されなかった』と書き、『gzip の線上の本文』とは書かない。compressed は false", () => {
    const records = [mr("S1", { meta: meta({ wireBodyBytes: 1000 }) }), mr("S1g", { meta: meta({ contentEncoding: null, wireBodyBytes: 1000 }) })];
    const row = summarizeSocketMatrix(records).compression[0]!;
    expect(row).toMatchObject({ contentEncoding: null, compressed: false });
    const facts = readAll(records).facts.join("\n");
    expect(facts).toMatch(/S1g.*圧縮されなかった/);
    expect(facts).not.toMatch(/S1g: gzip の線上の本文/);
    // 推測は『gzip を足しても拒否されなかった』と、圧縮されなかった事実を、混同しない。
    const inf = readAll(records).inferences.join("\n");
    expect(inf).toMatch(/S1g.*圧縮(され|で返さ)なかった/);
  });

  it("identity で返った(content-encoding: identity)ときも、圧縮されなかったとして扱う", () => {
    const records = [mr("S1"), mr("S1g", { meta: meta({ contentEncoding: "identity" }) })];
    expect(summarizeSocketMatrix(records).compression[0]).toMatchObject({ compressed: false });
  });

  it("gzip の取得が拒否されたとき(メタに content-encoding なし)、compressed は null(圧縮の有無を判断しない)", () => {
    const records = [mr("S1"), refused("S1g", 403, { variant: "gzip" })];
    expect(summarizeSocketMatrix(records).compression[0]).toMatchObject({ compressed: null });
  });

  it("メタが無い(通信エラー)とき、compressed は null", () => {
    const records = [mr("S1"), mr("S1g", { status: null, meta: null, error: "x" })];
    expect(summarizeSocketMatrix(records).compression[0]).toMatchObject({ compressed: null });
  });
});

/**
 * 再レビュー指摘(#162 段階1): 「2xx だが本文を扱えなかった」(status=200・error あり・meta=null。未対応の content-encoding・
 * gzip の展開失敗)と「片方が 2xx でない」は、比較できない理由が別。事実文は、実際の理由を書く(前者を『2xx ではない』と書かない)。
 */
const handled = (stepId: string, error: string, over: Partial<MatrixRecord> = {}): MatrixRecord =>
  mr(stepId, { status: 200, bodyLength: null, parsedCount: null, meta: null, error, ...over });
const BR = "未対応の content-encoding: br(gzip と identity だけ対応している)";

describe("再レビュー指摘: 2xx だが本文を扱えなかったときの事実・推測", () => {
  it("compression: gzip が 200・meta なし・error あり(identity は正常)。事実は『本文を扱えなかった』と error を載せ、『2xx ではない』とは書かない", () => {
    const records = [mr("S1"), handled("S1g", BR, { variant: "gzip" })];
    const facts = readAll(records).facts.join("\n");
    expect(facts).toMatch(/S1g.*比較しない/);
    expect(facts).toMatch(/S1g.*2xx だが本文を扱えなかった.*未対応の content-encoding: br/);
    expect(facts).not.toMatch(/2xx ではない/);
    // 比率・ハッシュは出さない(比較できていない)。
    const row = summarizeSocketMatrix(records).compression[0]!;
    expect(row).toMatchObject({ gzipStatus: 200, wireRatio: null, bodyHashEqual: null, compressed: null });
  });

  it("compression の推測: gzip が 200・meta なしのとき、『拒否はされなかったが、本文を扱えなかった』と error を書き、『拒否されなかった』だけで終えない", () => {
    const records = [mr("S1"), handled("S1g", BR, { variant: "gzip" })];
    const inf = readAll(records).inferences.join("\n");
    expect(inf).toMatch(/S1g.*拒否はされなかったが、本文を扱えなかった.*未対応の content-encoding: br/);
    expect(inf).not.toMatch(/S1g: Accept-Encoding: gzip を足しても拒否されなかった(?!が)/);
  });

  it("compression: identity(S1)が 200・meta なし・error ありで、gzip は正常。事実は S1 が本文を扱えなかったと書き、『2xx ではない』とは書かない", () => {
    const records = [handled("S1", "gzip として展開できません: x"), mr("S1g", { meta: meta({ contentEncoding: "gzip", wireBodyBytes: 200 }) })];
    const facts = readAll(records).facts.join("\n");
    expect(facts).toMatch(/S1g.*比較しない/);
    expect(facts).toMatch(/S1\(error: gzip として展開できません/);
    expect(facts).not.toMatch(/2xx ではない/);
  });

  it("compression: 片方が 403 でもう片方が 200・meta なしのとき、両方の理由(2xx ではない・本文を扱えなかった)を書く", () => {
    const records = [handled("S1", "壊れた応答"), refused("S1g", 403, { variant: "gzip" })];
    const facts = readAll(records).facts.join("\n");
    expect(facts).toMatch(/2xx ではない/);
    expect(facts).toMatch(/2xx だが本文を扱えなかった.*壊れた応答/);
  });

  it("repeat: 200 → 200 で2本目が meta なし。事実は『両方 2xx だが本文を扱えなかった』理由を書き、『両方が 2xx のときだけ比較する』の理由づけにしない", () => {
    const records = [mr("S1"), handled("S1r", "gzip として展開できません: y")];
    const facts = readAll(records).facts.join("\n");
    expect(facts).toMatch(/S1r.*200 → 200/);
    expect(facts).toMatch(/S1r.*比較しない.*2xx だが本文を扱えなかった.*S1r\(error: gzip として展開できません: y/);
    expect(facts).not.toMatch(/2xx ではない/);
    expect(summarizeSocketMatrix(records).repeat[0]).toMatchObject({ bytesEqual: null, hashEqual: null });
  });

  it("repeat: 1本目(S1)が meta なしでも、同じ(S1 の error を書く)", () => {
    const records = [handled("S1", "未対応"), mr("S1r")];
    expect(readAll(records).facts.join("\n")).toMatch(/S1r.*比較しない.*S1\(error: 未対応/);
  });

  it("repeat: 2本目が 403 のときは、従来どおり『どちらかが 2xx ではない』と書く(理由の言い分けで退行しない)", () => {
    const records = [mr("S1"), refused("S1r", 403)];
    expect(readAll(records).facts.join("\n")).toMatch(/S1r.*比較しない.*両方が 2xx のときだけ.*2xx ではない/);
  });

  it("error が長くても、事実の文では切り詰める(結果を肥大化させない)", () => {
    const records = [mr("S1"), handled("S1g", "x".repeat(1000), { variant: "gzip" })];
    const facts = readAll(records).facts.join("\n");
    expect(facts).toContain("x".repeat(50));
    expect(facts).not.toContain("x".repeat(400));
  });
});
