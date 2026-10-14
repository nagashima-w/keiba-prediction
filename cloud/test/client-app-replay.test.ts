import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { ReplayInit } from "../client/replay-model";
import type { VNode } from "../client/vnode";

/**
 * Issue #311(レース再生): 画面の制御(`app.ts`)。再生ボタン → キャンバスを出してからプレーヤを始める、速度、走り終えた着順の表示、画面遷移で止める。
 * プレーヤ(rAF・描画)は偽物。ここでは「いつ・何を渡して呼ぶか」を検査する(プレーヤ自体は client-replay-player.test.ts)。
 */

const DATE = "20260628";
const RACE_ID = "202603020211";
const ANALYSIS_5 = "/api/analyses/5";
const RACE_STATUS = `/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`;
const PAST = `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`;

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });

const horseBody = (umaban: number, over: Record<string, unknown> = {}) => ({
  umaban, name: `馬${umaban}`, prior: 0.3, adjustedProb: 0.25, placeOddsMin: 1.8, ev: 1.1, isPositive: false, mark: null, reason: null, highlights: [], concerns: [],
  winProb: 0.25, fairWinOdds: 3.2, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, earlyPos: umaban / 10, ...over,
});
const analysisBody = (horses: unknown[]) => ({
  ok: true,
  analysis: {
    id: 5, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, llmNote: null, llmCalls: null, promptVersion: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テスト", grade: null, startTime: null, courseType: "芝", distance: 1800, weather: null, trackCondition: null, oddsStatus: null, placeBasis: "top3", turn: "right" },
    horses, allocation: null, detail: "present",
  },
});
const boardRow = (mode: string, status: string, over: Record<string, unknown> = {}) => ({ race_id: RACE_ID, mode, status, attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: null, detail: null, children_ok: null, ...over });

function textOf(node: VNode | string): string {
  return typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));

interface Harness {
  readonly app: App;
  readonly log: string[];
  readonly starts: { init: ReplayInit; speed: number; treeHadCanvas: boolean }[];
  readonly speeds: number[];
  hash: string;
  tree(): VNode;
  go(hash: string): void;
}

function harness(initialHash: string, horses: unknown[] = [1, 2, 3, 4].map((u) => horseBody(u)), withReplay = true): Harness {
  const responders = new Map<string, () => Promise<Resp>>([
    [ANALYSIS_5, async () => ok(analysisBody(horses))],
    [RACE_STATUS, async () => ok({ ok: true, kaisai_date: DATE, races: [boardRow("pre_race", "done", { analysis_id: 5 })], prior: null })],
    [PAST, async () => ok({ ok: true, analyses: [] })],
  ]);
  const fetchLike: FetchLike = (url) => {
    const r = responders.get(url);
    if (r === undefined) throw new Error(`想定外の取得: ${url}`);
    return r();
  };
  let tree: VNode | null = null;
  const log: string[] = [];
  const starts: Harness["starts"] = [];
  const speeds: number[] = [];
  const h: Harness = {
    hash: initialHash,
    log,
    starts,
    speeds,
    tree: () => tree!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
    app: undefined as never,
  };
  (h as { app: App }).app = createApp({
    role: "admin",
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
    render: (t) => {
      tree = t;
    },
    getHash: () => h.hash,
    setHash: () => {},
    timers: { set: () => 0, clear: () => {} },
    isVisible: () => true,
    ...(withReplay
      ? {
          replay: {
            start: (init: ReplayInit, speed: number) => {
              log.push("start");
              starts.push({ init, speed, treeHadCanvas: findAll(tree!, (n) => n.tag === "canvas").length === 1 });
            },
            setSpeed: (speed: number) => {
              log.push("setSpeed");
              speeds.push(speed);
            },
            stop: () => {
              log.push("stop");
            },
          },
        }
      : {}),
  });
  return h;
}

async function open(h: Harness): Promise<void> {
  h.app.start();
  await h.app.whenIdle();
}

const play = (h: Harness): void => byClass(h.tree(), "replay-play")[0]!.on!.click!();
const speedBtn = (h: Harness, v: number): VNode => byClass(h.tree(), "replay-speed").find((b) => b.attrs?.["data-speed"] === String(v))!;

describe("レース再生の制御(結果画面 #analysis=5)", () => {
  it("開いたとき: 『レースを再生』ボタンがあり、キャンバスは無い。プレーヤはまだ呼ばない", async () => {
    const h = harness(`#date=${DATE}&analysis=5`);
    await open(h);
    expect(byClass(h.tree(), "replay-play").map(textOf)).toEqual(["レースを再生"]);
    expect(findAll(h.tree(), (n) => n.tag === "canvas").length).toBe(0);
    expect(h.log).toEqual([]);
  });

  it("再生ボタン: 先にキャンバスを出して(描画して)から、プレーヤを始める。材料は分析の勝率・開始位置・距離・回り。速度は既定の ×1", async () => {
    const h = harness(`#date=${DATE}&analysis=5`);
    await open(h);
    play(h);
    expect(h.log).toEqual(["start"]);
    const s = h.starts[0]!;
    expect(s.treeHadCanvas, "プレーヤを始める時点で、キャンバスが木に入っている").toBe(true);
    expect(s.speed).toBe(1);
    expect(s.init).toMatchObject({ analysisId: 5, distance: 1800, turn: "right" });
    expect(s.init.horses.map((x) => [x.umaban, x.strength, x.early])).toEqual([[1, 0.25, 0.1], [2, 0.25, 0.2], [3, 0.25, 0.3], [4, 0.25, 0.4]]);
    expect(byClass(h.tree(), "replay-play").map(textOf)).toEqual(["別の展開で再生"]);
  });

  it("走り終えた通知で着順のテキストが出る。『別の展開で再生』で着順を消して、もう一度始める(新しい材料)", async () => {
    const h = harness(`#date=${DATE}&analysis=5`);
    await open(h);
    play(h);
    h.app.onReplayFinish(5, [3, 1, 2, 4]);
    expect(findAll(byClass(h.tree(), "replay-finish")[0]!, (n) => n.tag === "li").map(textOf)).toEqual(["1着 3 馬3", "2着 1 馬1", "3着 2 馬2", "4着 4 馬4"]);
    play(h);
    expect(byClass(h.tree(), "replay-finish").length).toBe(0);
    expect(h.starts.length).toBe(2);
  });

  it("別の分析の終了通知・始めていない再生の終了通知は無視する(着順を出さない)", async () => {
    const h = harness(`#date=${DATE}&analysis=5`);
    await open(h);
    h.app.onReplayFinish(5, [1, 2, 3, 4]); // まだ始めていない
    expect(byClass(h.tree(), "replay-finish").length).toBe(0);
    play(h);
    h.app.onReplayFinish(9, [1, 2, 3, 4]); // 別の分析
    expect(byClass(h.tree(), "replay-finish").length).toBe(0);
  });

  it("速度: 押すとプレーヤに伝え、押した状態(aria-pressed)が反映される。次の再生はその速度で始まる", async () => {
    const h = harness(`#date=${DATE}&analysis=5`);
    await open(h);
    speedBtn(h, 4).on!.click!();
    expect(h.speeds).toEqual([4]);
    expect(byClass(h.tree(), "replay-speed").map((b) => b.attrs?.["aria-pressed"])).toEqual(["false", "false", "true"]);
    play(h);
    expect(h.starts[0]!.speed).toBe(4);
  });

  it("画面遷移(ハッシュが変わる)で、プレーヤを止めて状態を捨てる。同じ分析に戻ると、キャンバスは無くボタンは『レースを再生』", async () => {
    const h = harness(`#date=${DATE}&analysis=5`);
    await open(h);
    play(h);
    h.app.onReplayFinish(5, [1, 2, 3, 4]);
    h.log.length = 0;
    h.go(`#date=${DATE}&analysis=5&x=1`);
    expect(h.log).toEqual(["stop"]);
    await h.app.whenIdle();
    expect(findAll(h.tree(), (n) => n.tag === "canvas").length).toBe(0);
    expect(byClass(h.tree(), "replay-play").map(textOf)).toEqual(["レースを再生"]);
    expect(byClass(h.tree(), "replay-finish").length).toBe(0);
    // 止めたあとに届いた終了通知は無視する
    h.app.onReplayFinish(5, [1, 2, 3, 4]);
    expect(byClass(h.tree(), "replay-finish").length).toBe(0);
  });

  it("勝率が判定不能の分析: 節ごと出ない。ボタンが無いので始まらない", async () => {
    const h = harness(`#date=${DATE}&analysis=5`, [1, 2, 3, 4].map((u) => horseBody(u, { winProb: null })));
    await open(h);
    expect(byClass(h.tree(), "replay").length).toBe(0);
    expect(h.starts.length).toBe(0);
  });

  it("replay の依存が無い環境(他のテスト・古い呼び出し側)でも、押して投げない(何も始まらない)", async () => {
    const h = harness(`#date=${DATE}&analysis=5`, undefined, false);
    await open(h);
    expect(() => play(h)).not.toThrow();
    expect(() => h.go(`#date=${DATE}&analysis=5&x=1`)).not.toThrow();
  });
});

describe("レース再生の制御(レース画面の発走前のカード)", () => {
  it("カードの結果の中の節でも同じに動く(最新の分析 5)", async () => {
    const h = harness(`#date=${DATE}&race=${RACE_ID}`);
    await open(h);
    expect(byClass(h.tree(), "replay").length).toBe(1);
    play(h);
    expect(h.starts.length).toBe(1);
    expect(h.starts[0]!.init.analysisId).toBe(5);
    expect(h.starts[0]!.treeHadCanvas).toBe(true);
  });
});
