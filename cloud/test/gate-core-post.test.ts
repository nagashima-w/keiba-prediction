import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATE_BREAKER_MS, GATE_MIN_INTERVAL_MS, GateCore, type GatePostRequest, type GateResult, type KvLike } from "../src/gate-core";
import { SocketFetchError, type SocketPostInit, type SocketResponse } from "../src/socket-fetch";

/**
 * Issue #181 段階1: NetkeibaGate の POST(`GateCore.postRaw`。重賞の過去10年傾向の API 用)。
 * 時計・ストレージ・ソケット取得は偽。許可リスト(宛先・本文の形・Referer と Origin の値)、GET と同じ順番待ち(直列化・最小間隔・待ち行列の上限)、
 * POST 専用のブレーカー(1回の拒否で POST だけを 30 分止める。GET の連続回数には数えない)を検証する。実ネットワークには出ない。
 */

const T0 = 1_800_000_000_000;
const RACE_GET = "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211";
const enc = new TextEncoder();

const bodyOf = (raceId: string): string => `input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=${raceId}`;

/** 中央の標準の POST(`fetch-grade-winner.ts` が組み立てるものと同じ形)。 */
function centralPost(raceId = "202603020211"): GatePostRequest {
  return {
    url: "https://race.netkeiba.com/race_api/",
    referer: `https://race.netkeiba.com/race/past10.html?race_id=${raceId}`,
    origin: "https://race.netkeiba.com",
    body: bodyOf(raceId),
  };
}
/** 地方の標準の POST(Referer のページ名が past5.html)。 */
function narPost(raceId = "202644070111"): GatePostRequest {
  return {
    url: "https://nar.netkeiba.com/race_api/",
    referer: `https://nar.netkeiba.com/race/past5.html?race_id=${raceId}`,
    origin: "https://nar.netkeiba.com",
    body: bodyOf(raceId),
  };
}

type Outcome = number | Error;
interface Call {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly init: SocketPostInit | undefined;
  readonly startedAt: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function kvOf(map: Map<string, unknown>): KvLike {
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, value);
    },
  };
}

function harness(options: { maxQueue?: number } = {}) {
  const kv = new Map<string, unknown>();
  const calls: Call[] = [];
  const script: Outcome[] = [];
  const durationMs = { value: 0 };
  let inFlight = 0;
  let maxInFlight = 0;
  const fetcher = async (url: string, init?: SocketPostInit): Promise<SocketResponse> => {
    calls.push({ method: init === undefined ? "GET" : "POST", url, init, startedAt: Date.now() });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (durationMs.value > 0) {
        await sleep(durationMs.value);
      }
      const outcome = script.shift() ?? 200;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return { status: outcome, contentType: "text/html; charset=UTF-8", body: enc.encode("body") };
    } finally {
      inFlight -= 1;
    }
  };
  return {
    kv,
    calls,
    script,
    durationMs,
    maxInFlight: () => maxInFlight,
    make: () => new GateCore({ kv: kvOf(kv), now: () => Date.now(), sleep, fetcher }, options),
  };
}

async function settle<T>(...promises: Promise<T>[]): Promise<T[]> {
  const all = Promise.all(promises);
  await vi.runAllTimersAsync();
  return all;
}
const get = async (core: GateCore): Promise<GateResult> => (await settle(core.fetchRaw(RACE_GET)))[0]!;
const post = async (core: GateCore, request: GatePostRequest = centralPost()): Promise<GateResult> => (await settle(core.postRaw(request)))[0]!;
const reasonOf = (r: GateResult): string | null => (r.kind === "refused" ? r.reason : null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST の許可リスト", () => {
  it("中央の標準の POST を通し、ソケット取得に宛先・本文・Referer・Origin をそのまま渡す。応答はステータスと本文を返す", async () => {
    const h = harness();
    const result = await post(h.make());
    expect(result.kind).toBe("response");
    expect(result.kind === "response" && result.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.method).toBe("POST");
    expect(h.calls[0]!.url).toBe("https://race.netkeiba.com/race_api/");
    expect(h.calls[0]!.init).toEqual({
      method: "POST",
      body: bodyOf("202603020211"),
      referer: "https://race.netkeiba.com/race/past10.html?race_id=202603020211",
      origin: "https://race.netkeiba.com",
    });
  });

  it("地方(nar.netkeiba.com。Referer は past5.html)の標準の POST も通す", async () => {
    const h = harness();
    const result = await post(h.make(), narPost());
    expect(result.kind).toBe("response");
    expect(h.calls.map((c) => c.url)).toEqual(["https://nar.netkeiba.com/race_api/"]);
  });

  it("race_id の違うレースでも、形が同じなら通す(許可リストは race_id の値を固定しない)", async () => {
    const h = harness();
    expect((await post(h.make(), centralPost("202606010101"))).kind).toBe("response");
  });

  const central = centralPost();
  it.each<[string, GatePostRequest]>([
    ["db.netkeiba.com(GET では許すが POST は race / nar だけ)", { ...central, url: "https://db.netkeiba.com/race_api/", origin: "https://db.netkeiba.com", referer: "https://db.netkeiba.com/race/past10.html?race_id=202603020211" }],
    ["別ホスト", { ...central, url: "https://example.com/race_api/", origin: "https://example.com", referer: "https://example.com/race/past10.html?race_id=202603020211" }],
    ["http(暗号化なし)", { ...central, url: "http://race.netkeiba.com/race_api/" }],
    ["ポート指定あり", { ...central, url: "https://race.netkeiba.com:8443/race_api/" }],
    ["パスの末尾のスラッシュなし", { ...central, url: "https://race.netkeiba.com/race_api" }],
    ["パスが /race_api/ の下", { ...central, url: "https://race.netkeiba.com/race_api/x" }],
    ["別のパス", { ...central, url: "https://race.netkeiba.com/race/shutuba.html" }],
    ["クエリつき", { ...central, url: "https://race.netkeiba.com/race_api/?a=1" }],
    ["URL として読めない", { ...central, url: "not a url" }],
    ["URL に空白", { ...central, url: "https://race.netkeiba.com/race_api/ x" }],
    ["Referer のホストが送り先と違う", { ...central, referer: "https://nar.netkeiba.com/race/past10.html?race_id=202603020211" }],
    ["Referer が外部ホスト", { ...central, referer: "https://example.com/race/past10.html?race_id=202603020211" }],
    ["Referer が http", { ...central, referer: "http://race.netkeiba.com/race/past10.html?race_id=202603020211" }],
    ["Referer のパスが past10 / past5 でない", { ...central, referer: "https://race.netkeiba.com/race/result.html?race_id=202603020211" }],
    ["Referer のクエリが race_id だけでない", { ...central, referer: "https://race.netkeiba.com/race/past10.html?race_id=202603020211&x=1" }],
    ["Referer の race_id が 12 桁でない", { ...central, referer: "https://race.netkeiba.com/race/past10.html?race_id=2026030202" }],
    ["Referer の race_id が本文と違う", { ...central, referer: "https://race.netkeiba.com/race/past10.html?race_id=202606010101" }],
    ["Referer にフラグメント", { ...central, referer: "https://race.netkeiba.com/race/past10.html?race_id=202603020211#x" }],
    ["Origin が送り先と違うホスト", { ...central, origin: "https://nar.netkeiba.com" }],
    ["Origin の末尾にスラッシュ", { ...central, origin: "https://race.netkeiba.com/" }],
    ["Origin が http", { ...central, origin: "http://race.netkeiba.com" }],
    ["本文の class が違う", { ...central, body: central.body.replace("AplGradeWinner", "AplOther") }],
    ["本文に余計なパラメータ", { ...central, body: `${central.body}&x=1` }],
    ["本文の race_id が 11 桁", { ...central, body: bodyOf("20260302021"), referer: "https://race.netkeiba.com/race/past10.html?race_id=20260302021" }],
    ["本文の race_id が 13 桁", { ...central, body: bodyOf("2026030202111"), referer: "https://race.netkeiba.com/race/past10.html?race_id=2026030202111" }],
    ["本文が空", { ...central, body: "" }],
    ["本文に改行", { ...central, body: `${central.body}\r\nX: y` }],
    ["本文が長い(1万文字)", { ...central, body: `${central.body}${"a".repeat(10_000)}` }],
  ])("拒否して、接続も状態の書き込みもしない: %s", async (_label, request) => {
    const h = harness();
    const result = await post(h.make(), request);
    expect(reasonOf(result)).toBe("disallowed-url");
    expect(h.calls).toHaveLength(0);
    expect(h.kv.size).toBe(0);
  });

  it("前提: 上の拒否の例の元になった標準の POST は通る(拒否の理由が標準の形そのものにない)", async () => {
    const h = harness();
    expect((await post(h.make(), central)).kind).toBe("response");
  });
});

describe("GET と同じ順番待ち", () => {
  it("GET の直後の POST は、開始から開始まで最小間隔(2 秒)を空ける。逆順(POST → GET)も同じ", async () => {
    const h = harness();
    const core = h.make();
    await get(core);
    await post(core);
    await get(core);
    expect(h.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(h.calls.map((c) => c.startedAt)).toEqual([T0, T0 + GATE_MIN_INTERVAL_MS, T0 + 2 * GATE_MIN_INTERVAL_MS]);
  });

  it("GET と POST を同時に呼んでも、呼んだ順に1本ずつ実行する(重ならない。POST だけが先に行かない)。取得が 2 秒より長くても重ならない", async () => {
    const h = harness();
    h.durationMs.value = 3000;
    const core = h.make();
    await settle(core.fetchRaw(RACE_GET), core.postRaw(centralPost()), core.fetchRaw(RACE_GET), core.postRaw(narPost()));
    expect(h.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(h.maxInFlight()).toBe(1);
    for (let i = 1; i < h.calls.length; i += 1) {
      expect(h.calls[i]!.startedAt - h.calls[i - 1]!.startedAt).toBeGreaterThanOrEqual(3000);
    }
  });

  it("POST の開始時刻も、GET と同じく取得の前に永続化する(失敗した POST も間隔に数える)", async () => {
    const h = harness();
    h.script.push(new SocketFetchError("network", "切断"));
    const core = h.make();
    const result = await post(core);
    expect(reasonOf(result)).toBe("network-error");
    expect(core.status().lastStartAt).toBe(T0);
    const next = await get(core);
    expect(next.kind).toBe("response");
    expect(h.calls[1]!.startedAt).toBe(T0 + GATE_MIN_INTERVAL_MS);
  });

  it("待ち行列の上限は GET と共有する(上限に達していれば POST も接続せずに拒否する)", async () => {
    const h = harness({ maxQueue: 2 });
    h.durationMs.value = 1000;
    const core = h.make();
    const results = await settle(core.fetchRaw(RACE_GET), core.fetchRaw(RACE_GET), core.postRaw(centralPost()));
    expect(results.map(reasonOf)).toEqual([null, null, "queue-full"]);
    expect(h.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
});

describe("GET のブレーカーが開いている間", () => {
  it("POST も接続せずに拒否する(reason は blocked。解除時刻を添える)", async () => {
    const h = harness();
    h.script.push(403, 403);
    const core = h.make();
    await get(core);
    await get(core);
    expect(core.status().blockedUntil).not.toBeNull();
    const result = await post(core);
    expect(reasonOf(result)).toBe("blocked");
    expect(result.kind === "refused" && typeof result.blockedUntil).toBe("number");
    expect(h.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("POST が順番を待っている間に GET のブレーカーが開いたら、順番が来ても接続しない", async () => {
    const h = harness();
    h.script.push(403, 403);
    const core = h.make();
    await get(core); // 1 回目の拒否
    const results = await settle(core.fetchRaw(RACE_GET), core.postRaw(centralPost()));
    expect(results[0]!.kind).toBe("response"); // 2 回目の拒否は応答として返る
    expect(reasonOf(results[1]!)).toBe("blocked");
    expect(h.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
});

describe("POST のブレーカー(1 回の拒否で POST だけを 30 分止める)", () => {
  it.each([400, 403, 429])("POST が %i で拒否されたら、すぐ POST の解除時刻が入り(30 分後)、次の POST は接続せずに post-blocked", async (status) => {
    const h = harness();
    h.script.push(status);
    const core = h.make();
    const first = await post(core);
    expect(first.kind).toBe("response"); // 拒否の応答そのものは呼び出し側へ返る
    expect(core.status().postBlockedUntil).toBe(T0 + GATE_BREAKER_MS);
    const second = await post(core);
    expect(reasonOf(second)).toBe("post-blocked");
    expect(second.kind === "refused" && second.blockedUntil).toBe(T0 + GATE_BREAKER_MS);
    expect(second.kind === "refused" && typeof second.retryAfterMs).toBe("number");
    expect(h.calls).toHaveLength(1);
  });

  it("POST の拒否で GET は止まらない: GET は接続され、GET のブレーカーの連続回数は 0 のまま・解除時刻も入らない", async () => {
    const h = harness();
    h.script.push(403, 200);
    const core = h.make();
    await post(core);
    expect(core.status().consecutiveRefusals).toBe(0);
    expect(core.status().blockedUntil).toBeNull();
    const next = await get(core);
    expect(next.kind).toBe("response");
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("POST の拒否は GET の連続回数に数えない: GET 拒否 1 回 → POST 拒否 → GET 拒否 1 回、で GET の連続は 2(開く)であって、POST で先に開かない", async () => {
    const h = harness();
    h.script.push(403, 403, 403);
    const core = h.make();
    await get(core); // GET の連続 = 1
    await post(core); // POST の拒否(GET の連続は 1 のまま)
    expect(core.status().consecutiveRefusals).toBe(1);
    expect(core.status().blockedUntil).toBeNull(); // POST が数えられていれば、ここで 2 になって開いている
    const third = await get(core); // GET の連続 = 2 → ここで初めて開く
    expect(third.kind).toBe("response");
    expect(core.status().consecutiveRefusals).toBe(2);
    expect(core.status().blockedUntil).not.toBeNull();
  });

  it("POST の成功は GET の連続回数をリセットしない(GET 拒否 → POST 200 → GET 拒否 で、GET のブレーカーが開く)", async () => {
    const h = harness();
    h.script.push(403, 200, 403);
    const core = h.make();
    await get(core);
    await post(core);
    expect(core.status().consecutiveRefusals).toBe(1);
    await get(core);
    expect(core.status().blockedUntil).not.toBeNull();
  });

  it("POST の拒否以外の応答(404・500)・通信エラー・タイムアウトでは POST のブレーカーは開かない", async () => {
    const h = harness();
    h.script.push(404, 500, new SocketFetchError("network", "切断"), new SocketFetchError("timeout", "遅い"), new SocketFetchError("malformed", "壊れ"), 200);
    const core = h.make();
    for (let i = 0; i < 6; i += 1) {
      const r = await post(core);
      expect(reasonOf(r), `${i + 1} 本目`).not.toBe("post-blocked");
    }
    expect(h.calls).toHaveLength(6);
    expect(core.status().postBlockedUntil).toBeNull();
  });

  it.each([
    ["圧縮された 403(unsupported-encoding + status)", new SocketFetchError("unsupported-encoding", "圧縮", 403)],
    ["本文の途中で切れた 429(malformed + status)", new SocketFetchError("malformed", "途中切れ", 429)],
    ["本文の途中でタイムアウトした 400(timeout + status)", new SocketFetchError("timeout", "遅い", 400)],
  ])("受信済みのステータスを持つ失敗は、拒否として数える: %s", async (_label, error) => {
    const h = harness();
    h.script.push(error);
    const core = h.make();
    await post(core);
    expect(core.status().postBlockedUntil).toBe(T0 + GATE_BREAKER_MS);
    expect(reasonOf(await post(core))).toBe("post-blocked");
  });

  it("受信済みのステータスが 200 の失敗(本文の途中で切れた等)は、拒否として数えない", async () => {
    const h = harness();
    h.script.push(new SocketFetchError("malformed", "途中切れ", 200));
    const core = h.make();
    await post(core);
    expect(core.status().postBlockedUntil).toBeNull();
  });

  it("30 分たったら解除され、POST が 1 本通る。そこでまた拒否されたら、すぐまた 30 分止まる", async () => {
    const h = harness();
    h.script.push(403, 403, 200);
    const core = h.make();
    await post(core);
    vi.setSystemTime(T0 + GATE_BREAKER_MS - 1);
    expect(reasonOf(await post(core))).toBe("post-blocked"); // あと 1 ms
    expect(h.calls).toHaveLength(1);
    vi.setSystemTime(T0 + GATE_BREAKER_MS);
    expect(core.status().postBlockedUntil).toBeNull();
    const reopened = await post(core);
    expect(reopened.kind).toBe("response");
    expect(h.calls).toHaveLength(2);
    expect(core.status().postBlockedUntil).toBe(T0 + 2 * GATE_BREAKER_MS);
    expect(reasonOf(await post(core))).toBe("post-blocked");
    vi.setSystemTime(T0 + 2 * GATE_BREAKER_MS);
    expect((await post(core)).kind).toBe("response"); // 解除後に成功すれば通常に戻る
    expect(reasonOf(await post(core))).not.toBe("post-blocked");
  });

  it("POST が順番を待っている間に、前の POST の拒否でブレーカーが開いたら、順番が来ても接続しない", async () => {
    const h = harness();
    h.script.push(403);
    const core = h.make();
    const results = await settle(core.postRaw(centralPost()), core.postRaw(narPost()));
    expect(results[0]!.kind).toBe("response");
    expect(reasonOf(results[1]!)).toBe("post-blocked");
    expect(h.calls).toHaveLength(1);
  });

  it("POST が順番を待っている間に開いた POST のブレーカーは、後ろの GET を止めない", async () => {
    const h = harness();
    h.script.push(403);
    const core = h.make();
    const results = await settle(core.postRaw(centralPost()), core.fetchRaw(RACE_GET));
    expect(results[1]!.kind).toBe("response");
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("POST のブレーカーの状態は永続化される(同じストレージで作り直したゲートでも、止まったまま)", async () => {
    const h = harness();
    h.script.push(403);
    await post(h.make());
    const rebuilt = h.make();
    expect(rebuilt.status().postBlockedUntil).toBe(T0 + GATE_BREAKER_MS);
    expect(reasonOf(await post(rebuilt))).toBe("post-blocked");
  });
});

describe("status() の postBlockedUntil", () => {
  it("初期状態は null。解除時刻が過去でも null", () => {
    const h = harness();
    expect(h.make().status().postBlockedUntil).toBeNull();
    h.kv.set("postBlockedUntil", T0 - 1);
    expect(h.make().status().postBlockedUntil).toBeNull();
  });
});
