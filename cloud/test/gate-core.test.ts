import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATE_BREAKER_MS,
  GATE_BREAKER_THRESHOLD,
  GATE_MAX_QUEUE,
  GATE_MIN_INTERVAL_MS,
  GateCore,
  type GateResult,
  type KvLike,
} from "../src/gate-core";
import { SocketFetchError, type SocketResponse } from "../src/socket-fetch";

// ユーザー情報つき URL(user:pw と @ の組)をテスト用に組み立てる。リテラルで書くとメールアドレスの形になり、公開リポジトリへの混入検査が反応するため。
const AT = "@";

/**
 * Issue #162 段階2a: NetkeibaGate の中身(`GateCore`。純ロジック)。時計・ストレージ・ソケット取得を偽にして、
 * 直列化・最小間隔・間隔の永続化・サーキットブレーカー・取得先の許可リスト・待ち行列の上限を検証する。実ネットワークには出ない。
 * 時計は vitest の偽タイマー(Date.now と setTimeout を同じ仮想時計で動かす)。
 */

const T0 = 1_800_000_000_000;
const RACE = "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211";
const enc = new TextEncoder();

type Outcome = number | Error;

interface Harness {
  kv: Map<string, unknown>;
  starts: number[];
  urls: string[];
  maxInFlight: () => number;
  inFlightNow: () => number;
  script: Outcome[];
  durationMs: { value: number };
  make: () => GateCore;
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

function harness(): Harness {
  const kv = new Map<string, unknown>();
  const starts: number[] = [];
  const urls: string[] = [];
  const script: Outcome[] = [];
  const durationMs = { value: 0 };
  let inFlight = 0;
  let maxInFlight = 0;
  const fetcher = async (url: string): Promise<SocketResponse> => {
    starts.push(Date.now());
    urls.push(url);
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
    starts,
    urls,
    script,
    durationMs,
    maxInFlight: () => maxInFlight,
    inFlightNow: () => inFlight,
    make: () => new GateCore({ kv: kvOf(kv), now: () => Date.now(), sleep, fetcher }),
  };
}

/** 仮想時計を進めながら、複数の呼び出しの完了を待つ。 */
async function settle<T>(...promises: Promise<T>[]): Promise<T[]> {
  const all = Promise.all(promises);
  await vi.runAllTimersAsync();
  return all;
}
async function one(core: GateCore, url = RACE): Promise<GateResult> {
  return (await settle(core.fetchRaw(url)))[0]!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("定数", () => {
  it("最小間隔 2 秒(CLAUDE.md の 1.5 秒以上)・閾値 2 回・ブレーカー 30 分・待ち行列 8", () => {
    expect(GATE_MIN_INTERVAL_MS).toBe(2000);
    expect(GATE_BREAKER_THRESHOLD).toBe(2);
    expect(GATE_BREAKER_MS).toBe(30 * 60 * 1000);
    expect(GATE_MAX_QUEUE).toBe(8);
  });
});

describe("取得先の許可リスト(AC-6)", () => {
  it.each([
    ["race.netkeiba.com", "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211"],
    ["db.netkeiba.com", "https://db.netkeiba.com/horse/2021105857/"],
    ["nar.netkeiba.com", "https://nar.netkeiba.com/race/shutuba.html?race_id=202654071210"],
    ["大文字のホスト(正規化される)", "https://RACE.NETKEIBA.COM/x"],
  ])("許可する: %s", async (_label, url) => {
    const h = harness();
    const result = await one(h.make(), url);
    expect(result.kind).toBe("response");
    expect(h.urls).toHaveLength(1);
  });

  it.each([
    ["http(暗号化なし)", "http://race.netkeiba.com/x"],
    ["ポート指定あり", "https://race.netkeiba.com:8443/x"],
    ["ユーザー情報あり", `https://user:pw${AT}race.netkeiba.com/x`],
    ["パスワードだけ", `https://:pw${AT}race.netkeiba.com/x`],
    ["サブドメインの後ろに別ドメイン", "https://race.netkeiba.com.evil.example/x"],
    ["前に文字を足したホスト", "https://evilrace.netkeiba.com/x"],
    ["www.netkeiba.com(許可リスト外のホスト)", "https://www.netkeiba.com/x"],
    ["netkeiba.com 本体", "https://netkeiba.com/x"],
    ["別ホスト", "https://example.com/x"],
    ["ホスト名の末尾のドット", "https://race.netkeiba.com./x"],
    ["URL として読めない", "not a url"],
    ["空文字列", ""],
    ["バックスラッシュ入り", `https://race.netkeiba.com\\${AT}evil.example/x`],
    ["空白入り", "https://race.netkeiba.com/x y"],
    ["改行入り", "https://race.netkeiba.com/x\r\nHost: evil.example"],
    ["ftp", "ftp://race.netkeiba.com/x"],
    ["javascript:", "javascript:alert(1)"],
  ])("拒否して、接続を 1 回もしない: %s", async (_label, url) => {
    const h = harness();
    const result = await one(h.make(), url);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toBe("disallowed-url");
    expect(h.urls).toHaveLength(0);
  });

  it("取得先の拒否は、間隔にもブレーカーにも影響しない(次の本物の取得は待たずに始まる)", async () => {
    const h = harness();
    const core = h.make();
    await one(core, "https://example.com/x");
    await one(core, "https://example.com/y");
    expect(h.kv.size).toBe(0); // 拒否では何も書かれない
    await one(core);
    expect(h.starts).toEqual([T0]);
    expect(core.status().consecutiveRefusals).toBe(0);
  });

  it("接続先に渡す URL は正規化したもの(フラグメントは捨てる)", async () => {
    const h = harness();
    await one(h.make(), "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211#frag");
    expect(h.urls).toEqual(["https://race.netkeiba.com/race/shutuba.html?race_id=202603020211"]);
  });
});

describe("直列化(AC-7)", () => {
  it("同時に 3 本呼んでも、実行は重ならない(進行中は最大 1)。取得が 2 秒より長くても、次は前の終了後に始まる", async () => {
    const h = harness();
    h.durationMs.value = 3000;
    const core = h.make();
    const results = await settle(core.fetchRaw(RACE), core.fetchRaw(RACE), core.fetchRaw(RACE));
    expect(results.map((r) => r.kind)).toEqual(["response", "response", "response"]);
    expect(h.maxInFlight()).toBe(1);
    // 前の取得は 3000ms かかる。次の開始は前の「終了」以降(前の開始 + 3000)。
    expect(h.starts).toEqual([T0, T0 + 3000, T0 + 6000]);
  });

  it("呼んだ順に実行される", async () => {
    const h = harness();
    const core = h.make();
    await settle(
      core.fetchRaw("https://race.netkeiba.com/a"),
      core.fetchRaw("https://db.netkeiba.com/b"),
      core.fetchRaw("https://nar.netkeiba.com/c"),
    );
    expect(h.urls).toEqual(["https://race.netkeiba.com/a", "https://db.netkeiba.com/b", "https://nar.netkeiba.com/c"]);
  });

  it("途中の取得が失敗しても、後続は止まらず実行される(連鎖が詰まらない)", async () => {
    const h = harness();
    h.script.push(new SocketFetchError("network", "切断"), 200);
    const core = h.make();
    const results = await settle(core.fetchRaw(RACE), core.fetchRaw(RACE));
    expect(results.map((r) => (r.kind === "refused" ? r.reason : r.status))).toEqual(["network-error", 200]);
    expect(h.maxInFlight()).toBe(1);
  });

  it("取得の中身が想定外の例外を投げても、後続は止まらない", async () => {
    const h = harness();
    h.script.push(new TypeError("想定外"), 200);
    const core = h.make();
    const results = await settle(core.fetchRaw(RACE), core.fetchRaw(RACE));
    expect(results.map((r) => (r.kind === "refused" ? r.reason : r.status))).toEqual(["network-error", 200]);
  });
});

describe("最小間隔 2 秒(AC-8)", () => {
  it("開始間隔は常に 2000ms 以上。最初の取得は待たず、短い取得(0ms)でも 2 秒空く", async () => {
    const h = harness();
    const core = h.make();
    const results = await settle(core.fetchRaw(RACE), core.fetchRaw(RACE), core.fetchRaw(RACE));
    expect(h.starts).toEqual([T0, T0 + 2000, T0 + 4000]);
    expect(results.map((r) => (r.kind === "response" ? r.queuedMs : -1))).toEqual([0, 2000, 4000]);
  });

  it("境界: 前の開始から 1999ms 後の呼び出しは 1ms 待って 2000 で始まり、ちょうど 2000ms 後の呼び出しは待たない", async () => {
    const h = harness();
    const core = h.make();
    await one(core);
    vi.setSystemTime(T0 + 1999);
    const second = (await one(core)) as Extract<GateResult, { kind: "response" }>;
    expect(h.starts[1]).toBe(T0 + 2000);
    expect(second.queuedMs).toBe(1);
    vi.setSystemTime(T0 + 2000 + 2000);
    const third = (await one(core)) as Extract<GateResult, { kind: "response" }>;
    expect(h.starts[2]).toBe(T0 + 4000);
    expect(third.queuedMs).toBe(0);
  });

  it.each([
    ["通信エラー", new SocketFetchError("network", "切断")],
    ["タイムアウト", new SocketFetchError("timeout", "遅い")],
    ["圧縮された応答", new SocketFetchError("unsupported-encoding", "圧縮", 200)],
    ["想定外の例外", new Error("???")],
  ])("失敗した取得(%s)も間隔に数える(次は 2 秒空ける)", async (_label, error) => {
    const h = harness();
    h.script.push(error);
    const core = h.make();
    await one(core);
    await one(core);
    expect(h.starts).toEqual([T0, T0 + 2000]);
  });

  it("所要時間(elapsedMs)は取得の開始から終了まで", async () => {
    const h = harness();
    h.durationMs.value = 250;
    const r = (await one(h.make())) as Extract<GateResult, { kind: "response" }>;
    expect(r.elapsedMs).toBe(250);
    expect(r.queuedMs).toBe(0);
  });
});

describe("間隔の永続化(AC-9・AC-9b)", () => {
  it("DO が作り直された(同じストレージで GateCore を作り直した)後も、最後の開始から 2 秒以内なら待つ", async () => {
    const h = harness();
    await one(h.make());
    vi.setSystemTime(T0 + 500);
    await one(h.make()); // 別のインスタンス(メモリの状態は引き継がない)
    expect(h.starts).toEqual([T0, T0 + 2000]);
  });

  it("対照: ストレージが空なら待たない(上の待ちが永続化によるものだという前提)", async () => {
    const h = harness();
    await one(h.make());
    h.kv.clear();
    vi.setSystemTime(T0 + 500);
    await one(h.make());
    expect(h.starts).toEqual([T0, T0 + 500]);
  });

  it("開始時刻は取得の前に永続化される(取得が終わらないうちに作り直されても間隔が守られる)", async () => {
    const h = harness();
    h.durationMs.value = 5000;
    const core = h.make();
    const pending = core.fetchRaw(RACE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.kv.get("lastStartAt")).toBe(T0);
    await vi.runAllTimersAsync();
    await pending;
  });

  it("時計が戻って最後の開始が未来になっていても、待ちは最小間隔(2 秒)を超えない", async () => {
    const h = harness();
    h.kv.set("lastStartAt", T0 + 3_600_000);
    await one(h.make());
    expect(h.starts).toEqual([T0 + 2000]);
  });
});

describe("サーキットブレーカー(AC-10)", () => {
  const R = (statuses: Outcome[]): Outcome[] => statuses;

  it.each([
    ["400 が 2 連続", R([400, 400]), true],
    ["403 が 2 連続", R([403, 403]), true],
    ["429 が 2 連続", R([429, 429]), true],
    ["400 と 403 の連続(種類は問わない)", R([400, 403]), true],
    ["429 の後に 400", R([429, 400]), true],
    ["拒否が 1 回だけ", R([403]), false],
    ["拒否・成功・拒否(成功で途切れる)", R([403, 200, 403]), false],
    ["拒否・404・拒否(404 は途切れさせる)", R([429, 404, 429]), false],
    ["拒否・500・拒否(5xx は途切れさせる)", R([400, 503, 400]), false],
    ["拒否・拒否の前に成功", R([200, 403, 403]), true],
    ["拒否・通信エラー・拒否(通信エラーは数えず、途切れさせない)", R([403, new SocketFetchError("network", "切断"), 403]), true],
    ["拒否・タイムアウト・拒否", R([403, new SocketFetchError("timeout", "遅い"), 403]), true],
    ["拒否・想定外の例外・拒否(SocketFetchError 以外の例外も、数えず途切れさせない)", R([403, new Error("???"), 403]), true],
    ["拒否・サイズ超過・拒否", R([403, new SocketFetchError("too-large", "大きい"), 403]), true],
    ["拒否・応答が壊れている・拒否", R([403, new SocketFetchError("malformed", "壊れ"), 403]), true],
    ["圧縮された 403 が 2 連続(status を持つ例外)", R([new SocketFetchError("unsupported-encoding", "圧縮", 403), new SocketFetchError("unsupported-encoding", "圧縮", 403)]), true],
    ["圧縮された 403 と通常の 429", R([new SocketFetchError("unsupported-encoding", "圧縮", 403), 429]), true],
    ["本文の途中で切れた 403(malformed + status)が 2 連続", R([new SocketFetchError("malformed", "途中切れ", 403), new SocketFetchError("malformed", "途中切れ", 403)]), true],
    ["サイズ超過の 429(too-large + status)が 2 連続", R([new SocketFetchError("too-large", "大きい", 429), new SocketFetchError("too-large", "大きい", 429)]), true],
    ["本文の途中でタイムアウトした 400(timeout + status)が 2 連続", R([new SocketFetchError("timeout", "遅い", 400), new SocketFetchError("timeout", "遅い", 400)]), true],
    ["拒否・本文の途中で切れた 200(status あり)・拒否(サーバは普通に応答した)", R([403, new SocketFetchError("malformed", "途中切れ", 200), 403]), false],
    ["拒否・圧縮された 200(サーバは普通に応答した)・拒否", R([403, new SocketFetchError("unsupported-encoding", "圧縮", 200), 403]), false],
    ["3xx は数えない", R([302, 302, 302]), false],
  ])("%s", async (_label, sequence, shouldBlock) => {
    const h = harness();
    h.script.push(...sequence);
    const core = h.make();
    for (let i = 0; i < sequence.length; i += 1) {
      const r = await one(core);
      expect(r.kind === "refused" && r.reason === "blocked", `${i + 1} 本目は接続される(まだ開いていない)`).toBe(false);
    }
    expect(h.urls).toHaveLength(sequence.length);
    expect(core.status().blockedUntil !== null).toBe(shouldBlock);
    const next = await one(core);
    if (shouldBlock) {
      expect(next.kind === "refused" && next.reason).toBe("blocked");
      expect(h.urls).toHaveLength(sequence.length); // 接続しない
    } else {
      expect(next.kind).toBe("response");
      expect(h.urls).toHaveLength(sequence.length + 1);
    }
  });

  it("開いている間は接続 0 回で blocked を返し、解除時刻と残り時間を添える。間隔の待ちも発生しない", async () => {
    const h = harness();
    h.script.push(403, 403);
    const core = h.make();
    await one(core);
    await one(core);
    const openedAt = Date.now();
    const blocked = await one(core);
    expect(Date.now()).toBe(openedAt); // 待っていない
    expect(blocked.kind).toBe("refused");
    if (blocked.kind === "refused") {
      expect(blocked.reason).toBe("blocked");
      expect(blocked.blockedUntil).toBe(openedAt + GATE_BREAKER_MS);
      expect(blocked.retryAfterMs).toBe(GATE_BREAKER_MS);
    }
    expect(h.urls).toHaveLength(2);
  });

  it("解除の境界: 解除時刻の 1ms 前は blocked、ちょうど解除時刻から通る", async () => {
    const h = harness();
    h.script.push(403, 403);
    const core = h.make();
    await one(core);
    await one(core);
    const until = core.status().blockedUntil!;
    vi.setSystemTime(until - 1);
    expect((await one(core)).kind).toBe("refused");
    expect(h.urls).toHaveLength(2);
    vi.setSystemTime(until);
    expect((await one(core)).kind).toBe("response");
    expect(h.urls).toHaveLength(3);
  });

  it("解除後に 1 回通し、そこで拒否されたら即座にまた開く(カウントを数え直さない)", async () => {
    const h = harness();
    h.script.push(403, 403, 403);
    const core = h.make();
    await one(core);
    await one(core);
    vi.setSystemTime(core.status().blockedUntil!);
    const probe = await one(core);
    expect(probe.kind).toBe("response"); // 1 回は通る(403 が返っても、それは応答)
    expect(core.status().blockedUntil).toBe(Date.now() + GATE_BREAKER_MS);
    const after = await one(core);
    expect(after.kind === "refused" && after.reason).toBe("blocked");
    expect(h.urls).toHaveLength(3);
  });

  it("解除後に 1 回成功すれば閉じ、その後は拒否 1 回では開かない(2 回必要)", async () => {
    const h = harness();
    h.script.push(403, 403, 200, 403);
    const core = h.make();
    await one(core);
    await one(core);
    vi.setSystemTime(core.status().blockedUntil!);
    await one(core); // 200
    expect(core.status().consecutiveRefusals).toBe(0);
    expect(core.status().blockedUntil).toBeNull();
    await one(core); // 403 が 1 回
    expect(core.status().blockedUntil).toBeNull();
    expect((await one(core)).kind).toBe("response");
  });

  it("状態は永続化される(DO が作り直されても、開いたまま・数えたカウントを引き継ぐ)", async () => {
    const h = harness();
    h.script.push(403);
    await one(h.make());
    h.script.push(403);
    const second = h.make(); // 1 回拒否された状態を引き継ぐ
    expect(second.status().consecutiveRefusals).toBe(1);
    await one(second);
    const third = h.make();
    expect(third.status().blockedUntil).not.toBeNull();
    const r = await one(third);
    expect(r.kind === "refused" && r.reason).toBe("blocked");
  });

  it("取得先の許可リストの判定はブレーカーより先(ブレーカーが開いていても、許可外の理由を隠さない)", async () => {
    const h = harness();
    h.script.push(403, 403);
    const core = h.make();
    await one(core);
    await one(core);
    const r = await one(core, "https://example.com/x");
    expect(r.kind === "refused" && r.reason).toBe("disallowed-url");
  });
});

describe("待っている間のブレーカー(AC-10b)", () => {
  it("待ち行列で待っていた呼び出しは、前の取得でブレーカーが開いたら、接続せずに blocked になる", async () => {
    const h = harness();
    h.script.push(403, 403, 200);
    const core = h.make();
    const results = await settle(core.fetchRaw(RACE), core.fetchRaw(RACE), core.fetchRaw(RACE));
    expect(results[0]!.kind).toBe("response");
    expect(results[1]!.kind).toBe("response");
    expect(results[2]!.kind === "refused" && results[2]!.reason).toBe("blocked");
    expect(h.urls).toHaveLength(2);
  });
});

describe("待ち行列の上限(AC-11)", () => {
  it("ブレーカーが開いているときは、待ち行列が満杯でも queue-full ではなく blocked を返す(原因をブレーカーとして示す)", async () => {
    const h = harness();
    h.durationMs.value = 3000;
    const core = h.make();
    const calls = Array.from({ length: 8 }, () => core.fetchRaw(RACE));
    await vi.advanceTimersByTimeAsync(10); // 先頭が実行中で、残りは待ち
    expect(core.status().pending).toBe(8);
    h.kv.set("blockedUntil", Date.now() + 60_000); // 外から開いた状態にする
    const ninth = await core.fetchRaw(RACE);
    expect(ninth.kind === "refused" && ninth.reason).toBe("blocked");
    await vi.runAllTimersAsync();
    await Promise.all(calls);
  });

  it("上限(8)までは受け付け、9 本目は queue-full で接続せずに拒否する。完了後は再び受け付ける", async () => {
    const h = harness();
    const core = h.make();
    const calls = Array.from({ length: 9 }, () => core.fetchRaw(RACE));
    const results = await settle(...calls);
    expect(results.filter((r) => r.kind === "response")).toHaveLength(8);
    const refused = results.filter((r) => r.kind === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.kind === "refused" && refused[0]!.reason).toBe("queue-full");
    expect(results[8]!.kind).toBe("refused"); // 超えた分(後から来たもの)が拒否される
    expect(h.urls).toHaveLength(8);
    expect((await one(core)).kind).toBe("response");
    expect(core.status().pending).toBe(0);
  });

  it("queue-full は間隔・ブレーカーに影響しない", async () => {
    const h = harness();
    const core = h.make();
    const calls = Array.from({ length: 10 }, () => core.fetchRaw(RACE));
    await settle(...calls);
    expect(core.status().consecutiveRefusals).toBe(0);
    expect(h.starts).toEqual(Array.from({ length: 8 }, (_, i) => T0 + i * 2000));
  });
});

describe("失敗の分類", () => {
  it.each([
    ["timeout", new SocketFetchError("timeout", "遅い"), "timeout"],
    ["network", new SocketFetchError("network", "切断"), "network-error"],
    ["too-large", new SocketFetchError("too-large", "大きい"), "bad-response"],
    ["malformed", new SocketFetchError("malformed", "壊れ"), "bad-response"],
    ["想定外の例外", new Error("???"), "network-error"],
  ])("%s → %s", async (_label, error, reason) => {
    const h = harness();
    h.script.push(error);
    const r = await one(h.make());
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reason).toBe(reason);
      expect(r.message).toContain(error.message);
      expect(r.status).toBeUndefined();
    }
  });

  it("圧縮された応答は bad-response で、受信済みの status を添える", async () => {
    const h = harness();
    h.script.push(new SocketFetchError("unsupported-encoding", "圧縮", 403));
    const r = await one(h.make());
    expect(r.kind === "refused" && r.reason).toBe("bad-response");
    expect(r.kind === "refused" && r.status).toBe(403);
  });
});

describe("応答の返し方", () => {
  it("ステータス・content-type・本文(ArrayBuffer。RPC で運べる形)を返す。4xx・5xx も応答として返す", async () => {
    const h = harness();
    h.script.push(404);
    const r = await one(h.make());
    expect(r.kind).toBe("response");
    if (r.kind === "response") {
      expect(r.status).toBe(404);
      expect(r.contentType).toBe("text/html; charset=UTF-8");
      expect(r.body).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(r.body)).toBe("body");
    }
  });

  it("本文は、受信バッファ全体の一部を指す view ではなく、その長さだけの ArrayBuffer にして返す", async () => {
    const big = new Uint8Array(100);
    big.set(enc.encode("abc"), 10);
    const core = new GateCore({
      kv: kvOf(new Map()),
      now: () => Date.now(),
      sleep,
      fetcher: async () => ({ status: 200, contentType: null, body: big.subarray(10, 13) }),
    });
    const r = await one(core);
    expect(r.kind === "response" && r.body.byteLength).toBe(3);
    expect(r.kind === "response" && r.contentType).toBeNull();
  });
});

describe("status()", () => {
  it("初期状態: カウント 0・解除時刻なし・POST の解除時刻なし・最後の開始なし・待ち 0", () => {
    const h = harness();
    expect(h.make().status()).toEqual({ consecutiveRefusals: 0, blockedUntil: null, postBlockedUntil: null, lastStartAt: null, pending: 0 });
  });

  it("取得後は最後の開始時刻を返す。解除時刻が過去なら null", async () => {
    const h = harness();
    h.kv.set("blockedUntil", T0 - 1);
    const core = h.make();
    await one(core);
    expect(core.status().lastStartAt).toBe(T0);
    expect(core.status().blockedUntil).toBeNull();
  });
});
