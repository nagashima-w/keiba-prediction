import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { NAR_TRIFECTA_AXES_PER_STEP } from "../src/race-day-nar-trifecta";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";
import type { SqlLike } from "../src/sql-like";

/**
 * Issue #283(案D): 地方三連単の軸ごとの取得を、発走前の取得ステップとは**別のアラームの段階**で行う。
 *
 * 取得ステップ(三連単を除く、今までどおり) → 【三連単の段階: 1アラームあたり最大 9 軸】 → 計算ステップ(ネットワークに出ない)。
 * 段階の間も `status` は `fetched` のまま(新しい状態は作らない)。計算ステップは段階が終わる(pending が無くなる)まで動かない。
 * ゲート・保存先は偽、ストレージは `node:sqlite`(`race-day-pre-race.test.ts` と同じ流儀)。
 */

const NAR_RACE = "202654071210";
const NAR_DATE = "20260712";
const encoder = new TextEncoder();
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

// ---------- 地方の出馬表(n頭) ----------

/** 12頭のフィクスチャの馬番1の行を複製して、n頭(13〜18頭)の合成出馬表にする(馬ID・騎手IDは行ごとに一意)。 */
function narShutuba(n: number): string {
  const base = fixture("nar_shutuba_202654071210.html");
  if (n === 12) return base;
  const open = '<tr class="HorseList" id="tr_1">';
  const start = base.indexOf(open);
  const end = base.indexOf("</tr>", start) + "</tr>".length;
  const row = base.slice(start, end);
  const lastStart = base.lastIndexOf('<tr class="HorseList"');
  const lastEnd = base.indexOf("</tr>", lastStart) + "</tr>".length;
  let extra = "";
  for (let k = 13; k <= n; k++) {
    extra += row
      .replace('id="tr_1"', `id="tr_${k}"`)
      .replace('<td class="Umaban1">1</td>', `<td class="Umaban1">${k}</td>`)
      .replace(/2020106686/g, String(2020900000 + k))
      .replace(/jockey\/result\/recent\/a01bb/g, `jockey/result/recent/a09${String(k).padStart(2, "0")}`);
  }
  return base.slice(0, lastEnd) + extra + base.slice(lastEnd);
}

/** 1軸ぶんの合成NAR三連単HTML(軸=1着固定。値は大きく、期待値が閾値を超えて買い目に入りうる値 = 軸*1000+2着*10+3着)。 */
function axisHtml(axis: number, umabans: readonly number[]): string {
  const cells: string[] = [];
  for (const b of umabans) {
    if (b === axis) continue;
    for (const c of umabans) {
      if (c === axis || c === b) continue;
      cells.push(`<tr><td class="Odds" id="chk_x_b8_c0_${axis}_${b}_${c}">${axis * 1000 + b * 10 + c}.0</td></tr>`);
    }
  }
  return `<div id="odds_view_form"><table class="Odds_Table">${cells.join("")}</table></div>`;
}

const NAR_UNAVAILABLE = `<div id="odds_view_form"></div>`;
const jikuOf = (url: string): number => Number(/[?&]jiku=(\d+)/.exec(url)![1]);
const isB8 = (url: string): boolean => url.includes("odds_get_form.html") && url.includes("type=b8");

/** 地方の本体ハンドラ(n頭)。三連単(b8)は合成、3連複(b7)の軸は未発売、他は実フィクスチャ。 */
function narBody(n: number): (url: string) => string {
  const umabans = Array.from({ length: n }, (_, i) => i + 1);
  const shutuba = narShutuba(n);
  return (url) => {
    if (url.includes("shutuba.html")) return shutuba;
    if (url.includes("ajax_horse_results")) return fixture("horse_results_2021104387.json");
    if (url.includes("/jockey/result.html")) return fixture("nar_jockey_results_05496.html");
    if (isB8(url)) return axisHtml(jikuOf(url), umabans);
    if (url.includes("odds_get_form.html")) return NAR_UNAVAILABLE;
    if (url.includes("type=b1&")) return fixture("nar_odds_b1_202654071210.html");
    if (url.includes("type=b4&")) return fixture("nar_odds_b4_202654071210.html");
    if (url.includes("type=b5&")) return fixture("nar_odds_b5_202654071210.html");
    if (url.includes("type=b6&")) return fixture("nar_odds_b6_202654071210.html");
    if (url.includes("type=b3&")) return NAR_UNAVAILABLE;
    throw new Error(`未知のURL(NAR): ${url}`);
  };
}

// ---------- ハーネス ----------

interface FakeGate extends GateLike {
  readonly urls: string[];
  /** URL → 本文(null なら 404)。 */
  body: (url: string) => string | null;
  /** URL → 拒否(ブレーカー等)。null なら通す。 */
  refuse: (url: string) => { reason: "blocked" | "queue-full"; message: string } | null;
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    body: (url) => fixtureForUrl(url),
    refuse: () => null,
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const refusal = gate.refuse(url);
      if (refusal !== null) {
        return { kind: "refused", reason: refusal.reason, message: refusal.message };
      }
      const text = gate.body(url);
      if (text === null) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    async save(record) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

/** 組合せ ON・騎手の重み 0(本数を騎手の取得に左右されないようにする。騎手を取るテストは個別に重みを上げる)。 */
const BASE: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  includeComboOdds: true,
  baseScoreWeightJockey: 0,
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  settings: CloudSettings;
  /** 直近の「段階の表が空でない」ステップ後の行(完了後は表が空になるので、完了前の状態を検査するために残す)。 */
  stageSnapshot: { axis: number; state: string }[];
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(overrides: { settings?: CloudSettings; sql?: NodeSql; sqlWrap?: (sql: NodeSql) => SqlLike; gate?: FakeGate; sink?: FakeSink; clock?: { now: number } } = {}): Harness {
  const sql = overrides.sql ?? openNodeSql();
  if (overrides.sql === undefined) opened.push(sql);
  const clock = overrides.clock ?? { now: Date.parse("2026-07-12T00:00:00Z") };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const gate = overrides.gate ?? fakeGate();
  const sink = overrides.sink ?? fakeSink();
  const h = { sql, gate, sink, clock, alarm, warnings, settings: overrides.settings ?? BASE, stageSnapshot: [] } as unknown as Harness;
  const deps: RaceDayDeps = {
    sql: overrides.sqlWrap === undefined ? sql : overrides.sqlWrap(sql),
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => h.settings,
  };
  (h as { core: RaceDayCore }).core = new RaceDayCore(deps);
  return h;
}

/** 1ステップ進めて、「mode:step:result」と、そのステップで gate に出た URL を返す。 */
async function step(h: Harness): Promise<{ label: string; urls: string[] }> {
  const before = h.gate.urls.length;
  if (h.alarm.at !== null) h.clock.now = Math.max(h.clock.now, h.alarm.at);
  const outcome = await h.core.runNextStep();
  const label = outcome.kind === "idle" ? "idle" : `${outcome.mode}:${outcome.step}:${outcome.result}`;
  const rows = stageRows(h);
  if (rows.length > 0) h.stageSnapshot = rows;
  return { label, urls: h.gate.urls.slice(before) };
}

async function stepsUntilDone(h: Harness, max = 12): Promise<{ label: string; urls: string[] }[]> {
  const out: { label: string; urls: string[] }[] = [];
  for (let i = 0; i < max; i++) {
    const s = await step(h);
    out.push(s);
    if (s.label === "pre_race:compute:ok" || s.label.endsWith(":failed") || s.label === "idle") return out;
  }
  throw new Error("ステップが終わらない(上限超過)");
}

const taskStatus = (h: Harness): string => (h.sql.exec("SELECT status FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { status: string }[])[0]!.status;
const stageRows = (h: Harness): { axis: number; state: string }[] =>
  h.sql.exec("SELECT axis, state FROM race_day_nar_trifecta ORDER BY axis").toArray() as { axis: number; state: string }[];
const betTypes = (record: AnalysisRecord): string[] => [...new Set(record.allocation!.bets.map((b) => b.betType))].sort();
const trifectaBets = (record: AnalysisRecord) =>
  record.allocation!.bets
    .filter((b) => b.betType === "trifecta")
    // 三連単の comboKey は着順どおりの 6 桁(1着・2着・3着の馬番を 2 桁ずつ)
    .map((b) => ({ ...b, umabans: [b.comboKey.slice(0, 2), b.comboKey.slice(2, 4), b.comboKey.slice(4, 6)].map(Number) }));

async function scheduleNar(h: Harness, raceId = NAR_RACE): Promise<void> {
  await h.core.schedule({ raceId, kaisaiDate: NAR_DATE, mode: "pre_race" });
}

// ---------- テスト ----------

describe("地方三連単の段階: 順序・待ち条件・外への呼び出し数(12頭)", () => {
  it("取得(三連単を除く 2N+4=28 本) → 段階 9 軸 → 段階 3 軸 → 計算(gate 0 回)の順で進み、段階の間は status が fetched のまま、計算は pending が尽きるまで動かない", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    await scheduleNar(h);

    const s1 = await step(h);
    expect(s1.label).toBe("pre_race:fetch:ok");
    expect(s1.urls).toHaveLength(2 * 12 + 4); // 出馬表 1・戦績 12・単勝複勝 1・ワイド 1・3連複の軸 10・馬連 1・馬単 1・枠連 1(三連単は含まない)
    expect(s1.urls.filter(isB8)).toHaveLength(0);
    expect(taskStatus(h)).toBe("fetched");
    expect(stageRows(h).map((r) => r.state)).toEqual(Array(12).fill("pending")); // 取得ステップが全軸を pending で登録した

    const s2 = await step(h);
    expect(s2.label).toBe("pre_race:fetch:ok");
    expect(s2.urls).toHaveLength(NAR_TRIFECTA_AXES_PER_STEP);
    expect(s2.urls.map(jikuOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(taskStatus(h)).toBe("fetched"); // まだ計算には進まない
    expect(h.sink.saved).toHaveLength(0);

    const s3 = await step(h);
    expect(s3.label).toBe("pre_race:fetch:ok");
    expect(s3.urls.map(jikuOf)).toEqual([10, 11, 12]);
    expect(stageRows(h).every((r) => r.state === "fetched")).toBe(true);
    expect(h.sink.saved).toHaveLength(0);

    const s4 = await step(h);
    expect(s4.label).toBe("pre_race:compute:ok");
    expect(s4.urls).toHaveLength(0); // 計算ステップはネットワークに出ない(gate 0 回)
    expect(h.sink.saved).toHaveLength(1);
    expect(taskStatus(h)).toBe("done");
  });

  it("計算ステップは三連単をキャッシュから読み、地方の三連単が買い目に入る(1着が実在の軸・着順どおりの並び)。取得時の警告(部分被覆など)は出ない", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    await scheduleNar(h);
    await stepsUntilDone(h);

    const record = h.sink.saved[0]!;
    expect(betTypes(record)).toContain("trifecta");
    const bets = trifectaBets(record);
    expect(bets.length).toBeGreaterThan(0); // 前提固定(空振り防止)
    for (const bet of bets) {
      expect(bet.umabans).toHaveLength(3);
      expect(new Set(bet.umabans).size).toBe(3);
      expect(bet.umabans.every((u) => u >= 1 && u <= 12)).toBe(true);
    }
    expect(h.warnings.filter((w) => w.includes("組合せ") && w.includes("三連単"))).toEqual([]);
  });

  it("取得キャッシュに 12 軸ぶんの本文が積まれる(1軸 1 行。段階の取得は bypassCache で、前回の残りを読まない)", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    await scheduleNar(h);
    await step(h);
    await step(h);
    await step(h);
    const rows = h.sql.exec("SELECT key FROM fetch_cache WHERE key LIKE '%type=b8%'").toArray() as { key: string }[];
    expect(rows).toHaveLength(12);
  });
});

describe("地方三連単の段階: 外への呼び出し数の上限(16頭・18頭)", () => {
  for (const n of [16, 18]) {
    it(`${n}頭: 取得ステップ ${2 * n + 4} 本(騎手なし)、段階は 9 軸ずつ(${Math.ceil(n / 9)} アラーム)で、どのアラームも 50 を下回る。全軸が 1 回ずつ取られる`, async () => {
      const h = harness();
      h.gate.body = narBody(n);
      await scheduleNar(h);

      const s1 = await step(h);
      expect(s1.label).toBe("pre_race:fetch:ok");
      expect(s1.urls).toHaveLength(2 * n + 4);
      expect(s1.urls.length).toBeLessThan(50);

      const stage: { label: string; urls: string[] }[] = [];
      for (let i = 0; i < Math.ceil(n / NAR_TRIFECTA_AXES_PER_STEP); i++) {
        stage.push(await step(h));
      }
      expect(stage.map((s) => s.label)).toEqual(Array(Math.ceil(n / 9)).fill("pre_race:fetch:ok"));
      expect(stage.map((s) => s.urls.length)).toEqual(n === 16 ? [9, 7] : [9, 9]);
      for (const s of stage) expect(s.urls.length).toBeLessThanOrEqual(NAR_TRIFECTA_AXES_PER_STEP);
      const all = stage.flatMap((s) => s.urls.map(jikuOf));
      expect(all).toEqual(Array.from({ length: n }, (_, i) => i + 1)); // 全軸が 1 回ずつ・昇順
      expect(stageRows(h).every((r) => r.state === "fetched")).toBe(true);
      expect(stageRows(h)).toHaveLength(n);
    });
  }
});

describe("地方三連単の段階: 段階に入らない場合(中央・組合せ OFF・事前分析)", () => {
  it("中央のレースは段階に入らず、取得 → 計算の 2 ステップ(三連単は 1 リクエスト)。段階の表に行が作られない", async () => {
    const h = harness({ clock: { now: Date.parse("2026-06-28T00:00:00Z") } });
    await h.core.schedule({ raceId: "202603020211", kaisaiDate: "20260628", mode: "pre_race" });
    const s1 = await step(h);
    expect(s1.label).toBe("pre_race:fetch:ok");
    expect(s1.urls.filter((u) => u.includes("type=8"))).toHaveLength(1);
    expect(stageRows(h)).toEqual([]);
    const s2 = await step(h);
    expect(s2.label).toBe("pre_race:compute:ok");
    expect(s2.urls).toHaveLength(0);
  });

  it("地方でも includeComboOdds が OFF なら、三連単のリクエストは無く、段階に入らない(取得 → 計算)", async () => {
    const h = harness({ settings: { ...BASE, includeComboOdds: false } });
    h.gate.body = narBody(12);
    await scheduleNar(h);
    const steps = await stepsUntilDone(h);
    expect(steps.map((s) => s.label)).toEqual(["pre_race:fetch:ok", "pre_race:compute:ok"]);
    expect(h.gate.urls.filter(isB8)).toHaveLength(0);
    expect(stageRows(h)).toEqual([]);
  });

  it("地方の事前分析(morning)は、組合せオッズを取らないので段階に入らない", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    await h.core.schedule({ raceId: NAR_RACE, kaisaiDate: NAR_DATE });
    const first = await step(h);
    expect(first.label).toBe("morning:fetch:ok");
    expect(first.urls.filter(isB8)).toHaveLength(0);
    expect(stageRows(h)).toEqual([]);
  });

  it("出走が 3 頭未満なら軸が 0 件で、段階に入らない", async () => {
    const h = harness();
    // 出馬表を 2 頭に切り詰める(軸の導出が空になる)。計算は成立しないので、取得ステップの直後の状態だけを見る。
    h.gate.body = (url) => {
      if (url.includes("shutuba.html")) {
        let i = 0;
        return narShutuba(12).replace(/<tr class="HorseList"[\s\S]*?<\/tr>/g, (m) => (++i <= 2 ? m : ""));
      }
      return narBody(12)(url);
    };
    await scheduleNar(h);
    const s1 = await step(h);
    expect(s1.label).toBe("pre_race:fetch:ok");
    expect(stageRows(h)).toEqual([]);
  });
});

describe("地方三連単の段階: 再開・二重のアラーム(軸を二重に取らない)", () => {
  it("段階の途中で DO が落ちて(表への書き込みが例外)別のインスタンスで再開しても、結果を書いた軸は取り直さない(取り直すのは、結果を書く前に落ちた 1 軸だけ)", async () => {
    const sql = openNodeSql();
    opened.push(sql);
    const gate = fakeGate();
    gate.body = narBody(12);
    const clock = { now: Date.parse("2026-07-12T00:00:00Z") };
    // 軸の結果を書く UPDATE の 5 回目で例外にする(4 軸は書けて、5 軸目は「取得したが結果を書く前に落ちた」)
    let marks = 0;
    const crashing = (inner: NodeSql): SqlLike => ({
      exec(query: string, ...bindings: unknown[]) {
        if (query.includes("UPDATE race_day_nar_trifecta SET state") && !query.includes("'failed' WHERE")) {
          marks += 1;
          if (marks === 5) throw new Error("DO の落下(模擬)");
        }
        return inner.exec(query, ...bindings);
      },
    });
    const h1 = harness({ sql, gate, clock, sqlWrap: crashing });
    await scheduleNar(h1);
    expect((await step(h1)).label).toBe("pre_race:fetch:ok");
    await expect(step(h1)).rejects.toThrow("DO の落下");
    expect(stageRows(h1).filter((r) => r.state === "fetched").map((r) => r.axis)).toEqual([1, 2, 3, 4]);

    // 再起動: 同じ SQLite で新しい RaceDayCore を作り直す(ゲートも同じ=呼び出しの記録を続ける)
    const h2 = harness({ sql, gate, clock });
    const rest = await stepsUntilDone(h2);
    // 残りは軸 5〜12 の 8 本(1 アラームの上限 9 以内)→ 計算
    expect(rest.map((s) => s.label)).toEqual(["pre_race:fetch:ok", "pre_race:compute:ok"]);
    const b8 = gate.urls.filter(isB8).map(jikuOf);
    for (const axis of [1, 2, 3, 4]) {
      expect(b8.filter((a) => a === axis), `軸${axis}`).toHaveLength(1); // 書けた軸は取り直していない
    }
    expect(b8.filter((a) => a === 5)).toHaveLength(2); // 書く前に落ちた 1 軸だけが取り直された
    expect(b8).toHaveLength(13); // 12 軸 + 取り直し 1
    expect(new Set(b8).size).toBe(12); // 全軸が取れている
    expect(h2.sink.saved).toHaveLength(1);
  });
});

describe("地方三連単の段階: 失敗・部分被覆・打ち切り(三連単なしでも計算に進む)", () => {
  it("一部の軸(3・7)が 404 でも段階は続き、計算に進む。失敗した軸は 1 着の買い目に入らず、部分被覆の警告が出る(レース全体は throw しない)", async () => {
    const h = harness();
    const body = narBody(12);
    h.gate.body = (url) => (isB8(url) && [3, 7].includes(jikuOf(url)) ? null : body(url));
    await scheduleNar(h);
    const steps = await stepsUntilDone(h);

    expect(steps[steps.length - 1]!.label).toBe("pre_race:compute:ok");
    expect(h.stageSnapshot.filter((r) => r.state === "failed").map((r) => r.axis)).toEqual([3, 7]);
    const bets = trifectaBets(h.sink.saved[0]!);
    expect(bets.length).toBeGreaterThan(0); // 前提固定: 取れた軸の三連単は買い目に入る
    expect(bets.every((b) => ![3, 7].includes(b.umabans[0]!))).toBe(true);
    expect(h.warnings.some((w) => w.includes("組合せ") && w.includes("三連単") && w.includes("部分的"))).toBe(true);
  });

  it("全軸が 404 でも計算に進み、三連単の買い目は入らず(他の券種は入る)、警告が出る", async () => {
    const h = harness();
    const body = narBody(12);
    h.gate.body = (url) => (isB8(url) ? null : body(url));
    await scheduleNar(h);
    const steps = await stepsUntilDone(h);

    expect(steps[steps.length - 1]!.label).toBe("pre_race:compute:ok");
    expect(h.stageSnapshot).toHaveLength(12);
    expect(h.stageSnapshot.every((r) => r.state === "failed")).toBe(true);
    const types = betTypes(h.sink.saved[0]!);
    expect(types).not.toContain("trifecta");
    expect(types).toEqual(expect.arrayContaining(["wide", "quinella"]));
    expect(h.warnings.some((w) => w.includes("組合せ") && w.includes("三連単"))).toBe(true);
  });

  it("ブレーカーが開いた(blocked)ら、残りの軸を撃たずに failed にして打ち切り、三連単なしで計算に進む", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    h.gate.refuse = (url) => (isB8(url) && jikuOf(url) >= 4 ? { reason: "blocked", message: "ブレーカーが開いています(模擬)" } : null);
    await scheduleNar(h);
    const steps = await stepsUntilDone(h);

    expect(steps[steps.length - 1]!.label).toBe("pre_race:compute:ok");
    // 軸 1・2・3 は取れ、軸 4 で拒否 → そこで打ち切り(軸 5 以降には出ない)
    expect(h.gate.urls.filter(isB8).map(jikuOf)).toEqual([1, 2, 3, 4]);
    expect(h.stageSnapshot.map((r) => `${r.axis}:${r.state}`)).toEqual([
      "1:fetched", "2:fetched", "3:fetched", "4:failed", "5:failed", "6:failed", "7:failed", "8:failed", "9:failed", "10:failed", "11:failed", "12:failed",
    ]);
    const bets = trifectaBets(h.sink.saved[0]!);
    expect(bets.length).toBeGreaterThan(0); // 取れた軸 1〜3 の三連単は使える
    expect(bets.every((b) => [1, 2, 3].includes(b.umabans[0]!))).toBe(true);
  });

  it("致命的でない拒否(queue-full)は、その軸だけ failed にして次の軸へ進む(全体を打ち切らない)", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    h.gate.refuse = (url) => (isB8(url) && jikuOf(url) === 2 ? { reason: "queue-full", message: "待ち行列が満杯(模擬)" } : null);
    await scheduleNar(h);
    await stepsUntilDone(h);
    expect(h.gate.urls.filter(isB8).map(jikuOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(h.stageSnapshot.filter((r) => r.state === "failed").map((r) => r.axis)).toEqual([2]);
  });

  it("段階が終わったあとで、キャッシュから軸の本文が無くなっても(掃除などで)計算は throw せず、その軸を取得失敗(fetchFailed)として扱って部分被覆の警告を出す", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    await scheduleNar(h);
    await step(h);
    await step(h);
    await step(h);
    expect(stageRows(h).every((r) => r.state === "fetched")).toBe(true); // 前提: 全軸が取れた
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%type=b8%jiku=4'");
    const before = h.gate.urls.length;
    const compute = await step(h);
    expect(compute.label).toBe("pre_race:compute:ok");
    expect(h.gate.urls.length).toBe(before); // 計算ステップは取り直さない(ネットワークに出ない)
    const bets = trifectaBets(h.sink.saved[0]!);
    expect(bets.length).toBeGreaterThan(0);
    expect(bets.every((b) => b.umabans[0] !== 4)).toBe(true);
    expect(h.warnings.some((w) => w.includes("三連単") && w.includes("部分的"))).toBe(true);
  });
});

describe("地方三連単の段階: 前回の残りを使わない・再予約", () => {
  it("再予約した別の実行で軸 5 が 404 のとき、前回の実行のキャッシュ(軸 5)は使わない(取得ステップの開始より前のオッズは古い)", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    await scheduleNar(h);
    await stepsUntilDone(h);
    expect(trifectaBets(h.sink.saved[0]!).some((b) => b.umabans[0] === 5)).toBe(true); // 前提: 1回目は軸 5 の三連単も買い目に入る

    h.clock.now += 60 * 60_000;
    const body = narBody(12);
    h.gate.body = (url) => (isB8(url) && jikuOf(url) === 5 ? null : body(url));
    await scheduleNar(h);
    await stepsUntilDone(h);
    expect(h.sink.saved).toHaveLength(2);
    expect(trifectaBets(h.sink.saved[1]!).length).toBeGreaterThan(0);
    expect(trifectaBets(h.sink.saved[1]!).every((b) => b.umabans[0] !== 5)).toBe(true);
  });

  it("段階の途中で再予約はできない(実行中の同じレースは受け付けない)。完了後に再予約すると、段階の行は新しい実行のぶんに入れ替わる", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    await scheduleNar(h);
    await step(h);
    await step(h); // 段階の途中
    expect(await h.core.schedule({ raceId: NAR_RACE, kaisaiDate: NAR_DATE, mode: "pre_race" })).toMatchObject({ accepted: false });
    await stepsUntilDone(h);
    h.clock.now += 60 * 60_000;
    await scheduleNar(h);
    const first = await step(h);
    expect(first.label).toBe("pre_race:fetch:ok");
    expect(stageRows(h).map((r) => r.state)).toEqual(Array(12).fill("pending")); // 新しい実行: 全軸が pending
  });
});

describe("地方三連単の段階: 手動・一括でも同じ段階を通り、レースごとに直列に進む", () => {
  it("一括(scheduleMany)で地方 2 レースを予約すると、レースごとに「取得 → 段階 → 段階 → 計算」を終えてから次のレースに進む", async () => {
    const h = harness();
    h.gate.body = narBody(12);
    const result = await h.core.scheduleMany({ kaisaiDate: NAR_DATE, mode: "pre_race", raceIds: ["202654071209", NAR_RACE] });
    expect(result).toMatchObject({ accepted: true });
    const labels: string[] = [];
    for (let i = 0; i < 10; i++) {
      const s = await step(h);
      labels.push(s.label);
      if (s.label === "idle") break;
    }
    expect(labels.slice(0, 8)).toEqual([
      "pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:compute:ok",
      "pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:compute:ok",
    ]);
    expect(h.sink.saved.map((r) => r.raceId).sort()).toEqual(["202654071209", NAR_RACE]);
  });
});

describe("地方三連単の段階: 騎手の補正を落とさない・上限の上書きが取得ステップに漏れない", () => {
  const WITH_JOCKEY: CloudSettings = { ...BASE, baseScoreWeightJockey: 0.15 };

  it("地方 12 頭の冷えた状態: 取得ステップが騎手 12 人まで取り(合計 40 本)、計算ステップは gate に出ず、騎手の上限の警告を出さない(3N+4=40 に達しても、キャッシュから騎手を読む)", async () => {
    const h = harness({ settings: WITH_JOCKEY });
    h.gate.body = narBody(12);
    await scheduleNar(h);
    const s1 = await step(h);
    expect(s1.label).toBe("pre_race:fetch:ok");
    expect(s1.urls.filter((u) => u.includes("/jockey/result.html"))).toHaveLength(12);
    expect(s1.urls).toHaveLength(2 * 12 + 4 + 12); // 28 + 12 = 40(騎手の上限ちょうど)
    const rest = await stepsUntilDone(h);
    expect(rest[rest.length - 1]!.label).toBe("pre_race:compute:ok");
    expect(rest[rest.length - 1]!.urls).toHaveLength(0);
    expect(h.warnings.filter((w) => w.includes("騎手"))).toEqual([]);
  });

  it("地方 16 頭の冷えた状態: 取得ステップの騎手の上限 40 は有効なまま(36 本 + 騎手 4 人 = 40 本で止まる)。計算ステップ用の上限の上書きは取得ステップに漏れない", async () => {
    const h = harness({ settings: WITH_JOCKEY });
    h.gate.body = narBody(16);
    await scheduleNar(h);
    const s1 = await step(h);
    expect(s1.label).toBe("pre_race:fetch:ok");
    expect(s1.urls).toHaveLength(40);
    expect(s1.urls.filter((u) => u.includes("/jockey/result.html"))).toHaveLength(4);
    expect(s1.urls.length).toBeLessThan(2 * 16 + 4 + 16); // 上限が無ければ騎手 16 人全員(52 本)になる。上限 40 で止まっている
  });
});
