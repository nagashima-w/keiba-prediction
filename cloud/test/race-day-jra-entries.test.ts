import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { JRA_ENTRIES_META_DONE } from "../src/race-day-jra-entries";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fakeFetcher, fakeStore, world, type FakeStore, type World, type Trace } from "./jra-entries-fakes";
import { openNodeSql, type NodeSql } from "./node-sql";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #639: 日単位の DO(`RaceDayCore`)の中の、JRA の出馬表の取得の段の配線。
 * 前夜 21:00 の計画(中央の一覧あり)→ 翌朝 07:00 にアラームで取得 → 場ごとに保存。分析のタスクがあるあいだは動かない(最も低い優先度)。
 * ゲート・取得口・保存先は偽(実 netkeiba にも JRA にも触れない)。ストレージは `node:sqlite`。
 */

installFetchTrap();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20261012";
const jst = (s: string): number => Date.parse(`${s}+09:00`);
const T_2100 = jst("2026-10-11T21:00:00");
const AT_0700 = jst("2026-10-12T07:00:00");
const AT_0900 = jst("2026-10-12T09:00:00");
const CENTRAL_HTML = fixture("race_list_sub_20260927.html");
const NAR_HTML = fixture("synthetic_nar_race_list_sub_20260927_jpn3.html");

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });

/** 事前分析の取得は、このテストの主題ではないので失敗にする。`retryable` なら再試行待ちになる失敗(ネットワークの失敗)、そうでなければ即座に確定する失敗(ブレーカー)。 */
function fakeGate(retryable = false): GateLike {
  return {
    async fetchRaw(url): Promise<GateResult> {
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return ok(CENTRAL_HTML);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return ok(NAR_HTML);
      return retryable ? { kind: "refused", reason: "network-error", message: "接続できません" } : blocked();
    },
  };
}

const unusedSink: AnalysisSink = {
  save: async () => {
    throw new Error("保存先は使わない");
  },
  findByAnalyzedAt: async () => {
    throw new Error("保存先は使わない");
  },
  findRecentByRace: async () => {
    throw new Error("保存先は使わない");
  },
  countChildren: async () => {
    throw new Error("保存先は使わない");
  },
};

interface Harness {
  core: RaceDayCore;
  readonly sql: NodeSql;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly store: FakeStore;
  readonly w: World;
  readonly trace: Trace;
  readonly warns: string[];
  readonly infos: string[];
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(options: { withJra?: boolean; retryableGate?: boolean } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  // 見本の日(2026-10-12)の計画の中央の場コードは 06・09(一覧のフィクスチャの race_id から)。
  const w = world({ "06": 12, "09": 12 });
  const { fetcher, trace } = fakeFetcher(w);
  const base = { sql, clock: { now: T_2100 }, alarm: { at: null as number | null }, store: fakeStore(), w, trace, warns: [] as string[], infos: [] as string[] };
  const core = new RaceDayCore({
    sql,
    now: () => base.clock.now,
    gate: fakeGate(options.retryableGate === true),
    setAlarm: (at) => {
      base.alarm.at = at;
    },
    onWarn: (m) => base.warns.push(m),
    onInfo: (m) => base.infos.push(m),
    sink: unusedSink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(options.withJra === false ? {} : { fetchJraEntries: fetcher, jraEntriesStore: base.store }),
  });
  return { ...base, core };
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);

async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}

const meta = (h: Harness, key: string): string | null => (h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[])[0]?.value ?? null;

/** 前夜 21:00 の計画を確定まで進める(アラームが 23:59 までのもの)。 */
async function plan2100(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
  let n = 0;
  while (h.alarm.at !== null && h.alarm.at <= jst("2026-10-11T23:59:00")) {
    if (n++ > 200) throw new Error("計画が終わらない");
    await tick(h);
  }
}

describe("開催日の朝に取得する(最も低い優先度)", () => {
  it("計画の後の最初のアラームは 07:00 JST(前夜〜06:59 は JRA に 0 回)。07:00 から 3 回の起床(開催の選択 + 場ごとに 1 回ずつ)で、JRA への本数は 3 + 12 + 12 = 27 本", async () => {
    const h = harness();
    await plan2100(h);
    expect(h.trace.calls).toEqual([]);
    expect(h.store.claims).toEqual([]);
    expect(h.alarm.at).toBe(AT_0700);

    const labels: string[] = [];
    while (h.alarm.at !== null && h.alarm.at < AT_0900) {
      if (labels.length >= 60) throw new Error("取得が終わらない(アラームが同じ時刻に張られ続けている)");
      labels.push(await tick(h));
    }
    expect(labels.filter((l) => l.includes(":jra-entries:"))).toEqual([`${DATE}:jra-entries:fetch:ok`, `${DATE}:jra-entries:fetch:ok`, `${DATE}:jra-entries:fetch:ok`]);
    expect(h.trace.sessions.map((s) => s.calls.length)).toEqual([3, 12, 12]); // 開催の選択 1 + レースの選択 2 / 詳細 12 / 詳細 12
    expect(h.trace.calls.filter((c) => c.startsWith("venues:"))).toHaveLength(1);
    expect(h.store.saves.map((s) => s.races.length)).toEqual([12, 12]);
    expect(meta(h, JRA_ENTRIES_META_DONE)).toBe("1");
    expect(h.infos).toHaveLength(3);
    expect(h.infos.every((m) => m.startsWith("JRA の出馬表の取得: "))).toBe(true);
    // 先頭の起床が 07:00 JST、以降は STEP_GAP ずつ
    expect(h.store.claims.map((c) => c.venue)).toEqual(["00", "06", "09"]);
  });

  it("取得口が無い構成では、アラームの候補にならず、取得も印もない", async () => {
    const h = harness({ withJra: false });
    await plan2100(h);
    expect(h.alarm.at).not.toBe(AT_0700);
    h.clock.now = AT_0900 + 3600_000;
    await h.core.runNextStep();
    expect(h.trace.calls).toEqual([]);
    expect(meta(h, "jra_entries_state")).toBeNull();
  });

  it("分析のタスクがあるあいだは動かない(タスクが先。JRA への取得は 0 回のまま)", async () => {
    const h = harness();
    await plan2100(h);
    // 最初の発走前の分析の期限を 07:00 ちょうどにずらして、07:00 の起床にタスクがある状態にする。
    const first = (h.sql.exec("SELECT MIN(due_ms) AS at FROM race_day_plan WHERE venue = 'central'").toArray() as { at: number }[])[0]!.at;
    h.sql.exec("UPDATE race_day_plan SET due_ms = due_ms + ?", AT_0700 - first);
    h.clock.now = AT_0700;
    const labels: string[] = [];
    for (let i = 0; i < 12 && h.trace.calls.length === 0; i++) labels.push(label(await h.core.runNextStep()));
    // JRA に出る起床の前に、タスクの起床がある。タスクの起床の間は 0 回。
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.slice(0, -1).every((l) => !l.includes(":jra-entries:"))).toBe(true);
    expect(labels.at(-1)).toContain(":jra-entries:");
  });
});

describe("再試行待ちのタスクの間隔を、この段が無効にしない", () => {
  it("事前分析の取得が再試行待ち(60 秒おき)のあいだ、アラームはタスクの再試行の時刻に張られ(07:00 の取得の期限で撃ち直さない)、JRA には出ない。タスクが尽きた後に動く", async () => {
    const h = harness({ retryableGate: true });
    await plan2100(h);
    const first = (h.sql.exec("SELECT MIN(due_ms) AS at FROM race_day_plan WHERE venue = 'central'").toArray() as { at: number }[])[0]!.at;
    h.sql.exec("UPDATE race_day_plan SET due_ms = due_ms + ?", AT_0700 - first);
    h.clock.now = AT_0700;
    h.alarm.at = AT_0700;
    const labels: string[] = [];
    let sawRetryWait = false;
    for (let i = 0; i < 40 && h.trace.calls.length === 0; i++) {
      const l = await tick(h);
      labels.push(l);
      if (l.endsWith(":pre_race:fetch:retry")) {
        sawRetryWait = true;
        // 再試行待ちのタスクが残っている間は、アラームは再試行の時刻(60 秒後)で、JRA の期限(もう過ぎている)ではない
        const queued = (h.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks WHERE status = 'queued'").toArray() as { n: number }[])[0]!.n;
        expect(queued).toBeGreaterThan(0);
        expect(h.alarm.at).toBe(h.clock.now + 60_000);
      }
    }
    expect(sawRetryWait).toBe(true); // 前提: 再試行待ちの状態を実際に通った(空振りでない)
    expect(labels.at(-1)).toContain(":jra-entries:");
    expect(labels.slice(0, -1).every((l) => !l.includes(":jra-entries:"))).toBe(true);
  });
});

describe("失敗しても分析を止めない", () => {
  it("取得口が全部失敗し、保存先も壊れていても、runNextStep は例外を投げず、警告は固定の語だけ", async () => {
    const h = harness();
    h.w.throwOnOpen = true;
    h.store.failClaim = 5;
    await plan2100(h);
    h.clock.now = AT_0700;
    for (let i = 0; i < 30; i++) {
      await expect(h.core.runNextStep()).resolves.toBeDefined();
      if (h.alarm.at !== null) h.clock.now = Math.max(h.clock.now, h.alarm.at);
    }
    expect(h.warns.every((m) => !/https?:|secret|invalid/.test(m))).toBe(true);
  });
});
