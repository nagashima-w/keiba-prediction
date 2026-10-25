import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { recomputeAllocationFromProbs } from "../../packages/core/src/analysis/recompute-allocation";
import { scrapeRace } from "../../packages/core/src/scraper/scrape-race";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { CLOSE_FINAL_LEAD_MS, CLOSE_FIRST_LEAD_MS, type CloseSavePayload } from "../src/analysis-close";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { CLOSE_FETCH_RETRY_DELAY_MS, CLOSE_SAVE_RETRY_DELAY_MS } from "../src/race-day-close";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #338(#335-A1): 締切の直前の再計算(発走の 5 分前と 2 分前の 2 回)。発走前の分析(`pre_race`)が保存されたら、再計算に要る最小の入力を DO の表に積み、
 * 発走 − リードの時刻に起こして、**オッズだけを取り直し**(非オッズはキャッシュ専用・オッズはキャッシュを迂回)、確率は分析時のまま EV と配分を作り直して `saveClose` に渡す。
 * ゲート・保存先は偽。ストレージは `node:sqlite`。出馬表の発走は 15:45 JST(= 06:45Z)。
 */

const DATE = "20260628";
const RACE = "202603020211";
const START_MS = Date.parse("2026-06-28T06:45:00Z");
const DUE1 = START_MS - CLOSE_FIRST_LEAD_MS;
const DUE2 = START_MS - CLOSE_FINAL_LEAD_MS;
const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

interface FakeGate extends GateLike {
  readonly urls: string[];
  body: (url: string) => string | null;
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    body: (url) => fixtureForUrl(url),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
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
  readonly closes: { readonly analysisId: number; readonly payload: CloseSavePayload }[];
  /** saveClose をこの回数だけ、保存せずに例外にする(D1 の一時的な失敗)。 */
  failSaveClose: number;
  /** saveClose をこの回数だけ「保存してから例外」にする(D1 へ書いた後、応答を受け取る前にクラッシュした状況)。 */
  crashAfterSaveClose: number;
}

function fakeSink(withSaveClose = true): FakeSink {
  const sink: FakeSink = {
    saved: [],
    closes: [],
    failSaveClose: 0,
    crashAfterSaveClose: 0,
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
    async saveClose(analysisId, payload) {
      if (sink.failSaveClose > 0) {
        sink.failSaveClose -= 1;
        throw new Error("D1 の一時的な失敗");
      }
      sink.closes.push({ analysisId, payload });
      if (sink.crashAfterSaveClose > 0) {
        sink.crashAfterSaveClose -= 1;
        throw new Error("保存後のクラッシュ");
      }
    },
  };
  if (!withSaveClose) {
    delete (sink as { saveClose?: unknown }).saveClose;
  }
  return sink;
}

const ALL_ON: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  includeComboOdds: true,
  baseScoreWeightJockey: 0, // 騎手の成績を取らない(取得の本数を固定する。race-day-pre-race.test.ts と同じ理由)
  baseScoreWeightTrainer: 0, // 調教師の成績も取らない(同じ理由。Issue #354)
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  readonly settingsLoads: number[];
  settings: CloudSettings;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(overrides: Partial<RaceDayDeps> = {}, withSaveClose = true): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const settingsLoads: number[] = [];
  const gate = fakeGate();
  const sink = fakeSink(withSaveClose);
  const h = { sql, gate, sink, clock, alarm, warnings, settingsLoads, settings: ALL_ON } as Harness;
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => {
      settingsLoads.push(clock.now);
      return h.settings;
    },
    ...overrides,
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

/** 発走前の分析(手動の予約)を取得 → 計算まで回す。 */
async function analyze(h: Harness): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
}

type CloseOutcome = Extract<StepOutcome, { mode: "close" }>;

async function fire(h: Harness, at: number): Promise<CloseOutcome> {
  h.clock.now = at;
  const outcome = await h.core.runNextStep();
  expect(outcome).toMatchObject({ kind: "ran", mode: "close", step: "recompute" });
  return outcome as CloseOutcome;
}

interface CloseRowSql {
  race_id: string;
  round: number;
  analysis_id: number;
  due_ms: number;
  state: string;
  attempts: number;
  save_attempts: number;
  next_try_at: number | null;
  fired_at: number | null;
  payload_json: string | null;
}
const closeRows = (h: Harness): CloseRowSql[] => h.sql.exec("SELECT * FROM race_day_close ORDER BY race_id, round").toArray() as CloseRowSql[];

const count = (urls: string[], fragment: string): number => urls.filter((u) => u.includes(fragment)).length;

/** 単勝・複勝のオッズ(type=1)だけを factor 倍にした応答を返す gate の本文(最後の動きの想定)。 */
function shiftedBody(factor: number, drop?: string): (url: string) => string | null {
  return (url) => {
    const text = fixtureForUrl(url);
    if (!/api_get_jra_odds/.test(url) || /type=[3-8]/.test(url)) return text;
    const json = JSON.parse(text) as { data: { odds: Record<string, Record<string, string[]>> } };
    const scale = (v: string): string => (Math.max(1.1, Math.round(Number(v) * factor * 10) / 10)).toFixed(1);
    for (const kind of ["1", "2"]) {
      for (const [umaban, cells] of Object.entries(json.data.odds[kind]!)) {
        json.data.odds[kind]![umaban] = [scale(cells[0]!), kind === "2" ? scale(cells[1]!) : cells[1]!, cells[2]!];
      }
    }
    if (drop !== undefined) {
      delete json.data.odds["1"]![drop];
    }
    return JSON.stringify(json);
  };
}

describe("締切の直前の再計算: 入力の登録(分析の保存と同じ同期区間)", () => {
  it("手動の発走前の分析でも、保存の直後に 2 回ぶんの行(発走 5 分前・2 分前)と入力が積まれ、アラームは 1 回目の時刻に張られる", async () => {
    const h = harness();
    await analyze(h);
    const rows = closeRows(h);
    expect(rows.map((r) => [r.round, r.due_ms, r.state, r.analysis_id, r.attempts])).toEqual([
      [1, DUE1, "pending", 1, 0],
      [2, DUE2, "pending", 1, 0],
    ]);
    // 前提: 実際に 5 分差・3 分差で、リードが定数どおり(5 分と 2 分)
    expect(START_MS - DUE1).toBe(5 * 60_000);
    expect(START_MS - DUE2).toBe(2 * 60_000);
    expect(h.alarm.at).toBe(DUE1);
    const input = h.sql.exec("SELECT instance, analysis_id, start_ms, input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray() as { instance: number; analysis_id: number; start_ms: number; input_json: string }[];
    expect(input).toHaveLength(1);
    expect(input[0]!.start_ms).toBe(START_MS);
    const parsed = JSON.parse(input[0]!.input_json) as { horses: { umaban: number; wakuban: number; horseName: string; prior: number; adjustedProb: number }[]; baseRoute: string };
    expect(parsed.horses).toHaveLength(16);
    expect(parsed.horses.every((x) => x.wakuban >= 1 && x.horseName.length > 0 && x.adjustedProb > 0)).toBe(true);
    expect(parsed.baseRoute).toBe(h.sink.saved[0]!.allocation!.meta.route);
    // 分析時の確率と同じ値を控えている
    for (const x of parsed.horses) {
      expect(x.adjustedProb).toBe(h.sink.saved[0]!.horses.find((s) => s.umaban === x.umaban)!.adjustedProb);
    }
  });

  it("保存先が saveClose を持たない構成では、行も入力も積まず、アラームも張らない(従来どおり)", async () => {
    const h = harness({}, false);
    await analyze(h);
    expect(closeRows(h)).toEqual([]);
    expect(h.sql.exec("SELECT * FROM race_day_close_input").toArray()).toEqual([]);
    expect(h.alarm.at).not.toBe(DUE1);
  });

  it("分析の保存が発走より後なら、何も積まない(終わったレースの再計算はしない)", async () => {
    const h = harness();
    h.clock.now = START_MS + 60_000;
    await analyze(h);
    expect(closeRows(h)).toEqual([]);
    expect(h.sql.exec("SELECT * FROM race_day_close_input").toArray()).toEqual([]);
  });

  it("同じレースの発走前の分析を予約し直すと、前の実行の行と入力は消え、新しい実行が保存されたときに積み直される(新しい分析 id に紐づく)", async () => {
    const h = harness();
    await analyze(h);
    expect(closeRows(h).map((r) => r.analysis_id)).toEqual([1, 1]);
    h.clock.now += 1_000; // 分析時刻が前と同じだと、同じ分析として扱われる(冪等性の鍵)
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(closeRows(h)).toEqual([]);
    expect(h.sql.exec("SELECT * FROM race_day_close_input").toArray()).toEqual([]);
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    expect(closeRows(h).map((r) => [r.round, r.analysis_id])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("締切の直前の再計算: 入力の登録の細部(Issue #446: 削除した特性テストから移した)", () => {
  it("出馬表の発走時刻が 1 桁の時間(9:50)でも、2 桁に揃えて発走の瞬間(UTC 00:50)を控え、回の行を積む(警告なし)", async () => {
    const h = harness();
    const base = h.gate.body;
    h.gate.body = (url) => {
      const text = base(url);
      return text === null || !/shutuba\.html/.test(url) ? text : text.replace(/\d{1,2}:\d{2}発走/g, "9:50発走");
    };
    await analyze(h);
    const startMs = Date.parse("2026-06-28T00:50:00Z");
    expect(h.sql.exec("SELECT start_ms FROM race_day_close_input WHERE race_id = ?", RACE).toArray()).toEqual([{ start_ms: startMs }]);
    expect(closeRows(h).map((r) => r.due_ms)).toEqual([startMs - CLOSE_FIRST_LEAD_MS, startMs - CLOSE_FINAL_LEAD_MS]);
    expect(h.warnings.filter((w) => w.includes("締切の直前の再計算"))).toEqual([]); // 入力を積めなかった警告は出ない
  });

  it("組合せ ON のとき、分析時の組合せオッズを読んでよい期間の下限は、取得ステップの開始(fetch_started_at)。タスクを積んだ時刻(queued_at)ではない。上限は計算ステップの時刻", async () => {
    const h = harness();
    const queuedAt = h.clock.now;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    h.clock.now = queuedAt + 3_000;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    h.clock.now = queuedAt + 5_000;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const row = h.sql.exec("SELECT instance, input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { instance: number; input_json: string };
    const input = JSON.parse(row.input_json) as { comboFromMs: number; comboToMs: number };
    expect(row.instance).toBe(queuedAt); // 前提: 積んだ時刻は取得の開始より前
    expect(input.comboFromMs).toBe(queuedAt + 3_000);
    expect(input.comboToMs).toBe(queuedAt + 5_000);
  });
});

describe("締切の直前の再計算: 取得の再試行・保存の諦めの細部(Issue #446: 削除した特性テストから移した)", () => {
  const odds404 = (h: Harness): void => {
    const ok = h.gate.body;
    h.gate.body = (url) => (/api_get_jra_odds/.test(url) ? null : ok(url));
  };

  it("取得に失敗して、再試行の時刻がちょうど次の回の時刻になるときは再試行しない(failed)。1 ミリ秒でも手前なら再試行する(retry。アラームはその時刻)", async () => {
    const a = harness();
    await analyze(a);
    odds404(a);
    expect(await fire(a, DUE2 - CLOSE_FETCH_RETRY_DELAY_MS)).toMatchObject({ round: 1, result: "failed", reason: "fetch-failed" });

    const b = harness();
    await analyze(b);
    odds404(b);
    expect(await fire(b, DUE2 - CLOSE_FETCH_RETRY_DELAY_MS - 1)).toMatchObject({ round: 1, result: "retry", reason: null });
    expect(b.alarm.at).toBe(DUE2 - 1);
  });

  it("保存を 3 回失敗して諦めた回の戻り値には、payload の理由が載る(行わない回〈unset〉を保存できなかったとき reason は unset)", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, bankroll: 0, perRaceCap: 0 };
    await analyze(h);
    h.sink.failSaveClose = 3;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "retry", reason: null });
    expect(await fire(h, closeRows(h)[0]!.next_try_at!)).toMatchObject({ round: 1, result: "retry", reason: null });
    expect(await fire(h, closeRows(h)[0]!.next_try_at!)).toMatchObject({ round: 1, result: "failed", reason: "unset" });
    expect(closeRows(h)[0]).toMatchObject({ state: "abandoned", save_attempts: 3 });
    expect(h.sink.closes).toEqual([]); // 前提: 保存は 1 件も成功していない
  });
});

describe("締切の直前の再計算: 控える入力の中身と、1 ステップの細部(Issue #446: 削除した特性テストから移した)", () => {
  interface InputHorse {
    umaban: number;
    hadWinOdds: boolean;
    hadPlaceOdds: boolean;
  }
  const inputOf = (h: Harness): Record<string, unknown> & { horses: InputHorse[] } => {
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    return JSON.parse(row.input_json) as Record<string, unknown> & { horses: InputHorse[] };
  };
  /** 単勝(`"1"`)か複勝(`"2"`)のオッズから 5 番の馬を消した応答にする(単勝複勝の API 以外は元のまま)。 */
  const dropOdds = (h: Harness, kind: "1" | "2"): void => {
    const base = fixtureForUrl;
    h.gate.body = (url) => {
      const text = base(url);
      if (text === null || !/api_get_jra_odds/.test(url) || /type=[3-8]/.test(url)) return text;
      const json = JSON.parse(text) as { data: { odds: Record<string, Record<string, string[]>> } };
      delete json.data.odds[kind]!["05"];
      return JSON.stringify(json);
    };
  };

  it("分析時に複勝オッズの無かった馬は、控えに hadPlaceOdds=false で入り、締切でも複勝オッズが無くて構わない(horse-set-mismatch にしない。ほかの馬は true)", async () => {
    const h = harness();
    dropOdds(h, "2");
    await analyze(h);
    const horses = inputOf(h).horses;
    expect(horses).toHaveLength(16); // 前提
    expect(horses.find((x) => x.umaban === 5)!.hadPlaceOdds).toBe(false);
    expect(horses.filter((x) => x.hadPlaceOdds)).toHaveLength(15);
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "ok", reason: null });
  });

  it("分析時に単勝オッズの無かった馬は、控えに hadWinOdds=false で入り、締切でも単勝オッズが無くて構わない(horse-set-mismatch にしない。ほかの馬は true)", async () => {
    const h = harness();
    dropOdds(h, "1");
    await analyze(h);
    const horses = inputOf(h).horses;
    expect(horses).toHaveLength(16); // 前提
    expect(horses.find((x) => x.umaban === 5)!.hadWinOdds).toBe(false);
    expect(horses.filter((x) => x.hadWinOdds)).toHaveLength(15);
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "ok", reason: null });
  });

  it("組合せ OFF なら、控えに組合せオッズを読んでよい期間(comboFromMs・comboToMs)は入らない", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, includeComboOdds: false };
    await analyze(h);
    const input = inputOf(h);
    expect("comboFromMs" in input).toBe(false);
    expect("comboToMs" in input).toBe(false);
    expect(input.allocationSettings).toMatchObject({ includeComboOdds: false });
  });

  it("控えた馬の数は出馬表と同じでも、馬番の集合が違えば failed(horse-set-mismatch)。再試行しない", async () => {
    const h = harness();
    await analyze(h);
    const input = inputOf(h);
    expect(input.horses).toHaveLength(16); // 前提
    // 差し替えた馬は「分析時にオッズが無かった」扱いにして、オッズの欠落(別の理由)で失敗する経路を塞ぐ。馬番の集合の違いだけで failed になることを確かめる。
    input.horses = input.horses.map((x) => (x.umaban === 16 ? { ...x, umaban: 99, hadWinOdds: false, hadPlaceOdds: false } : x));
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "horse-set-mismatch" });
    expect(closeRows(h)[0]).toMatchObject({ state: "done", attempts: 1 });
  });

  it("予定の時刻ちょうどに動いた回の遅れ(lateMs)は 0。動いた時刻(firedAtMs)は予定の時刻と同じ", async () => {
    const h = harness();
    await analyze(h);
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "ok" });
    expect(h.sink.closes[0]!.payload).toMatchObject({ dueAtMs: DUE1, firedAtMs: DUE1, lateMs: 0 });
  });

  it("保存の失敗の再試行は、失敗した時刻(動いた時刻。予定の時刻ではない)の CLOSE_SAVE_RETRY_DELAY_MS(20 秒)後。アラームも同じ時刻", async () => {
    const h = harness();
    await analyze(h);
    h.sink.failSaveClose = 1;
    const firedAt = DUE1 + 7_000; // 予定の時刻より 7 秒遅れて動いた(now と due_ms を区別する)
    expect(await fire(h, firedAt)).toMatchObject({ round: 1, result: "retry", reason: null });
    expect(CLOSE_SAVE_RETRY_DELAY_MS).toBe(20_000); // 前提: 定数の値
    expect(closeRows(h)[0]).toMatchObject({ state: "pending", save_attempts: 1, due_ms: DUE1, next_try_at: firedAt + CLOSE_SAVE_RETRY_DELAY_MS });
    expect(h.alarm.at).toBe(firedAt + CLOSE_SAVE_RETRY_DELAY_MS);
  });

  it("分析のあとで保存先が saveClose を持たなくなったら、その回を abandoned にして警告 1 件。failed(reason なし)。次の回は動く", async () => {
    const h = harness();
    await analyze(h);
    delete (h.sink as { saveClose?: unknown }).saveClose;
    const warningsBefore = h.warnings.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: null });
    expect(closeRows(h)[0]).toMatchObject({ state: "abandoned" });
    expect(closeRows(h)[1]).toMatchObject({ round: 2, state: "pending" });
    expect(h.warnings.slice(warningsBefore).filter((w) => w.includes("保存できません"))).toHaveLength(1);
    expect(h.gate.urls.filter((u) => /api_get_jra_odds/.test(u)).length).toBe(7); // 前提: 分析時の 7 本だけ。保存先が無い回はオッズを取りに行かない
  });
});

describe("締切の直前の再計算: 取り直しの範囲(Issue #446: 削除した特性テストから移した)", () => {
  it("1 ステップは、騎手・調教師の成績のキャッシュも読まない(オッズだけを取り直す。使わない読み取りをしない)", async () => {
    const h = harness();
    await analyze(h);
    const keys: string[] = [];
    const original = h.sql.exec.bind(h.sql);
    (h.sql as { exec: typeof h.sql.exec }).exec = (query: string, ...bindings: unknown[]) => {
      if (/FROM fetch_cache/i.test(query)) keys.push(String(bindings[0]));
      return original(query, ...bindings);
    };
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "ok" });
    expect(keys.length).toBeGreaterThan(0); // 前提: キャッシュを読んでいる(出馬表など)
    expect(keys.filter((k) => /jockey|trainer/.test(k))).toEqual([]);
  });
});

describe("締切の直前の再計算: 取り直しと再計算(中央)", () => {
  it("1 回目(組合せ ON): オッズ 7 本だけを取り直す(単勝複勝 1 + 組合せ 6)。出馬表・戦績・調教・騎手には出ない。同じオッズなら分析時の配分と一致し、遅れ(late_ms)を記録する", async () => {
    const h = harness();
    await analyze(h);
    const before = h.gate.urls.length;
    const loads = h.settingsLoads.length;
    const outcome = await fire(h, DUE1 + 7_000);
    expect(outcome).toMatchObject({ round: 1, result: "ok", reason: null });
    const fetched = h.gate.urls.slice(before);
    expect(fetched).toHaveLength(7);
    for (const type of [1, 3, 4, 5, 6, 7, 8]) {
      expect(count(fetched, `type=${type}`), `type=${type}`).toBe(1);
    }
    expect(count(fetched, "shutuba.html") + count(fetched, "ajax_horse_results") + count(fetched, "oikiri.html") + count(fetched, "/jockey/")).toBe(0);
    expect(h.settingsLoads.length).toBe(loads); // 設定は読み直さない(タスクのスナップショットを使う)
    expect(h.sink.closes).toHaveLength(1);
    const { analysisId, payload } = h.sink.closes[0]!;
    expect(analysisId).toBe(1);
    expect(payload).toMatchObject({ round: 1, status: "ok", reason: null, dueAtMs: DUE1, firedAtMs: DUE1 + 7_000, lateMs: 7_000 });
    expect(payload.oddsOfficialDatetime).toBe("2026-06-28 15:52:30");
    // 同じオッズ・同じ確率なので、分析時の配分(メタ・買い目)と完全に一致する(配分が多点であることを先に固定する)
    const base = h.sink.saved[0]!.allocation!;
    expect(base.bets.length).toBeGreaterThan(5);
    // Issue #470: 分析時の保存だけが、下限で外れた買い目の『外さなかった場合の賭け金』(meta.missed)を記録する。締切直前の再計算は下限は適用するが記録はしない(null)。
    // それ以外(買い目・メタの他の項目〈外れた件数を含む〉)は、同じオッズなら分析時と一致する。
    // 設定の下限が、分析(取得 → 計算 → 保存)の配分まで届いている(配線の抜けを検出する。既定 0.05 と別の値での確認は allocation-settings-of.test.ts)。
    expect(base.meta.minHitProb).toBe(ALL_ON.minHitProb);
    expect(base.meta.belowFloorCount, "前提: 実際に外れた買い目がある").toBeGreaterThan(0);
    expect(base.meta.missed, "前提: 分析時は外した買い目を記録している").not.toBeNull();
    expect(base.meta.missed!.length).toBeGreaterThan(0);
    expect(payload.allocation!.meta.missed).toBeNull();
    expect(JSON.stringify({ ...payload.allocation!, meta: { ...payload.allocation!.meta, missed: base.meta.missed } })).toBe(JSON.stringify(base));
    expect(closeRows(h).map((r) => [r.round, r.state])).toEqual([
      [1, "done"],
      [2, "pending"],
    ]);
    expect(h.alarm.at).toBe(DUE2);
  });

  it("オッズのキャッシュ(TTL 60 秒)の内側でも取り直す: 分析の直後(10 秒前に取得済み)に起きても、オッズ 7 本はネットワークから取る", async () => {
    const h = harness();
    h.clock.now = DUE1 - 10_000;
    await analyze(h);
    const before = h.gate.urls.length;
    await fire(h, DUE1);
    expect(h.gate.urls.length - before).toBe(7);
    expect(h.sink.closes[0]!.payload.status).toBe("ok");
  });

  it("出馬表のキャッシュが無い(掃除された)ときは、ネットワークに出ず、再試行もせずに failed(fetch-failed)", async () => {
    const h = harness();
    await analyze(h);
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%shutuba.html%'");
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "fetch-failed" });
    expect(h.gate.urls.length).toBe(before);
    expect(closeRows(h)[0]).toMatchObject({ state: "done", attempts: 1 });
  });

  it("組合せ OFF(既定)なら、取り直すのは単勝複勝の 1 本だけ", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, includeComboOdds: false };
    await analyze(h);
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "ok" });
    const fetched = h.gate.urls.slice(before);
    expect(fetched).toHaveLength(1);
    expect(count(fetched, "type=1")).toBe(1);
    expect(h.sink.closes[0]!.payload.status).toBe("ok");
  });

  it("オッズが動いたとき: 分析時の確率(DO に控えた値)のまま新しいオッズで配分が作り直され、分析時の配分と違う(差が 0 でない)。2 回目も同様に取り直す", async () => {
    const h = harness();
    await analyze(h);
    const base = h.sink.saved[0]!.allocation!;
    h.gate.body = shiftedBody(0.85);
    const before = h.gate.urls.length;
    await fire(h, DUE1);
    h.gate.body = shiftedBody(1.25);
    await fire(h, DUE2);
    expect(h.gate.urls.length - before).toBe(14); // 2 回 × 7 本
    expect(h.sink.closes.map((c) => c.payload.round)).toEqual([1, 2]);

    // 独立に期待値を作る: 同じフィクスチャ(オッズだけ差し替え)を scrapeRace し、分析時に保存された確率で recomputeAllocationFromProbs を呼ぶ
    const expectedFor = async (factor: number) => {
      const body = shiftedBody(factor);
      const race = await scrapeRace(parseRaceId(RACE), { fetcher: { fetchText: async (url) => body(url)! }, now: () => new Date(0) }, { includeComboOdds: true });
      const saved = h.sink.saved[0]!;
      return recomputeAllocationFromProbs({
        raceId: RACE,
        horses: race.horses.map((x) => ({ umaban: x.shutuba.umaban, wakuban: x.shutuba.wakuban, horseName: x.shutuba.name, prior: saved.horses.find((s) => s.umaban === x.shutuba.umaban)!.prior, adjustedProb: saved.horses.find((s) => s.umaban === x.shutuba.umaban)!.adjustedProb })),
        odds: race.odds,
        comboOdds: race.meta.comboOdds,
        allocationSettings: { bankroll: ALL_ON.bankroll, perRaceCap: ALL_ON.perRaceCap, kellyFraction: ALL_ON.kellyFraction, minHitProb: ALL_ON.minHitProb, includeComboOdds: true, includeWideInAllocation: ALL_ON.includeWideInAllocation, includeTrioInAllocation: ALL_ON.includeTrioInAllocation, includeQuinellaInAllocation: ALL_ON.includeQuinellaInAllocation, includeExactaInAllocation: ALL_ON.includeExactaInAllocation, includeTrifectaInAllocation: ALL_ON.includeTrifectaInAllocation, includeBracketQuinellaInAllocation: ALL_ON.includeBracketQuinellaInAllocation },
        evConfig: { threshold: ALL_ON.evThreshold },
      }).allocation;
    };
    const exp1 = await expectedFor(0.85);
    const exp2 = await expectedFor(1.25);
    expect(JSON.stringify(h.sink.closes[0]!.payload.allocation)).toBe(JSON.stringify(exp1));
    expect(JSON.stringify(h.sink.closes[1]!.payload.allocation)).toBe(JSON.stringify(exp2));
    // 前提(空振り防止): 期待値が分析時の配分と実際に違う(差の指標が 0 でない)。どれも空の配分(退化)ではない
    expect(base.bets.length).toBeGreaterThan(0);
    expect(exp1.bets.length).toBeGreaterThan(0);
    expect(exp2.bets.length).toBeGreaterThan(0);
    const total = (a: typeof base) => a.bets.reduce((s, b) => s + b.stake, 0);
    expect(JSON.stringify(exp1.bets) === JSON.stringify(base.bets)).toBe(false);
    expect(JSON.stringify(exp2.bets) === JSON.stringify(exp1.bets)).toBe(false);
    expect(Math.abs(total(exp1) - total(base)) > 0 || exp1.bets.length !== base.bets.length || JSON.stringify(exp1.bets) !== JSON.stringify(base.bets)).toBe(true);
  });

  it("確率は DO に控えた値を使う(取り直しで再計算しない): 控えた確率を書き換えると、配分がそれに従って変わる", async () => {
    const h = harness();
    await analyze(h);
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as { horses: { umaban: number; adjustedProb: number }[] };
    const original = JSON.stringify(h.sink.saved[0]!.allocation!.bets);
    // 1 番人気(13)に確率を集中させる(合計は変えない)
    input.horses = input.horses.map((x) => ({ ...x, adjustedProb: x.umaban === 13 ? 0.9 : 0.05 }));
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    await fire(h, DUE1);
    const bets = h.sink.closes[0]!.payload.allocation!.bets;
    expect(JSON.stringify(bets)).not.toBe(original);
  });

  it("1 回目と 2 回目は別々に D1 へ保存され、両方終わると行は done になる。以後は何も起きない", async () => {
    const h = harness();
    await analyze(h);
    await fire(h, DUE1);
    await fire(h, DUE2);
    expect(closeRows(h).map((r) => r.state)).toEqual(["done", "done"]);
    expect(h.sink.closes.map((c) => [c.analysisId, c.payload.round])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    h.clock.now = DUE2 + 1000;
    expect(await h.core.runNextStep()).toMatchObject({ kind: "idle" });
  });

  it("締切の再計算の時刻が来ていれば、待っている他のタスク(取得待ち)より先に走る", async () => {
    const h = harness();
    await analyze(h);
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE }); // 朝の取得待ち(同じレースの別 mode)
    const out = await fire(h, DUE1);
    expect(out.result).toBe("ok");
    expect(h.core.getBoard().races.find((r) => r.mode === "morning")!.status).toBe("queued"); // 朝はまだ動いていない
  });
});

describe("締切の直前の再計算: 行わない・失敗の語彙", () => {
  it("分析時の提案が「未設定」(総資金・上限が 0)なら、オッズを取らずに skipped(unset)", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, bankroll: 0, perRaceCap: 0 };
    await analyze(h);
    expect(h.sink.saved[0]!.allocation!.meta.route).toBe("unset"); // 前提
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "unset" });
    expect(h.gate.urls.length).toBe(before);
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "skipped", reason: "unset", allocation: null });
  });

  // 旧「地方のレースは、オッズを取らずに skipped(nar-unsupported)」は Issue #379 で廃止した(地方も再計算の対象になった)。保証していた 3 点の行き先:
  //   ① 地方はオッズを取らない → 組合せ ON の地方は単勝・複勝の 1 本だけ(`race-day-close-nar.test.ts`)。旧い入力(期間なし)は何も取らない(同ファイルの「入力に期間が無い」)
  //   ② 行わなかった回も理由つきで 1 行を保存する → 同ファイルの combo-missing(failed)の保存。skipped の保存は上の unset・too-late のテストが引き続き固定する
  //   ③ 理由は固定の語彙 → `close-view.test.ts`・`analysis-close-reasons.test.ts`(旧 `nar-unsupported` を読めることを含む)

  it("起きたのが遅く、2 回目の時刻を過ぎていたら、1 回目は skipped(too-late)。2 回目はまだ発走前なので実行する", async () => {
    const h = harness();
    await analyze(h);
    const before = h.gate.urls.length;
    const first = await fire(h, DUE2 + 1000); // 1 回目が 2 回目の時刻を過ぎて起きた
    expect(first).toMatchObject({ round: 1, result: "failed", reason: "too-late" });
    expect(h.gate.urls.length).toBe(before);
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "skipped", reason: "too-late", lateMs: DUE2 + 1000 - DUE1 });
    const second = await fire(h, DUE2 + 1000);
    expect(second).toMatchObject({ round: 2, result: "ok" });
  });

  it("発走を過ぎて起きたら、2 回目も skipped(too-late)でオッズは取らない", async () => {
    const h = harness();
    await analyze(h);
    await fire(h, START_MS); // 1 回目: too-late
    const before = h.gate.urls.length;
    expect(await fire(h, START_MS)).toMatchObject({ round: 2, result: "failed", reason: "too-late" });
    expect(h.gate.urls.length).toBe(before);
  });

  it("ブレーカーが開いている(blocked)なら再試行せず failed(blocked)", async () => {
    const h = harness();
    await analyze(h);
    (h.gate as { fetchRaw: GateLike["fetchRaw"] }).fetchRaw = async () => ({ kind: "refused", reason: "blocked", message: "止めています", blockedUntil: 1, retryAfterMs: 1 });
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "blocked" });
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "failed", reason: "blocked" });
    expect(closeRows(h)[0]).toMatchObject({ state: "done", attempts: 1 });
  });

  it("取得の一時的な失敗は 1 回だけ再試行する: 1 回目は retry(保存せず、次の試行の時刻にアラーム)、2 回目で取れれば ok(遅れは最初に動いた時刻から数える)", async () => {
    const h = harness();
    await analyze(h);
    const okBody = h.gate.body;
    h.gate.body = (url) => (/api_get_jra_odds/.test(url) ? null : okBody(url)); // オッズが 404
    const first = await fire(h, DUE1 + 2_000);
    expect(first).toMatchObject({ round: 1, result: "retry", reason: null });
    expect(h.sink.closes).toHaveLength(0);
    const retryAt = closeRows(h)[0]!.next_try_at!;
    expect(retryAt).toBeGreaterThan(DUE1 + 2_000);
    expect(retryAt).toBeLessThan(DUE2); // 次の回の時刻より前
    expect(h.alarm.at).toBe(retryAt);
    h.gate.body = okBody;
    expect(await fire(h, retryAt)).toMatchObject({ round: 1, result: "ok" });
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "ok", lateMs: 2_000 });
  });

  it("取得の失敗が 2 回続けば failed(fetch-failed)。再試行の時刻が次の回の時刻を過ぎるなら、再試行せずに failed", async () => {
    const h = harness();
    await analyze(h);
    const okBody = h.gate.body;
    h.gate.body = (url) => (/api_get_jra_odds/.test(url) ? null : okBody(url));
    await fire(h, DUE1);
    const retryAt = closeRows(h)[0]!.next_try_at!;
    expect(await fire(h, retryAt)).toMatchObject({ round: 1, result: "failed", reason: "fetch-failed" });
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "failed", reason: "fetch-failed", allocation: null });
    // 2 回目(最後の回): 起きた時刻が発走の直前で、再試行の余地が無い
    const last = await fire(h, START_MS - 5_000);
    expect(last).toMatchObject({ round: 2, result: "failed", reason: "fetch-failed" });
    expect(closeRows(h)[1]).toMatchObject({ state: "done", attempts: 1 });
  });

  it("取得の失敗の警告は、鍵の形(sk-ant-...)を伏せて onWarn に出す(段階は本体の redactSecrets の包みを通した onWarn を受け取る。素の deps.onWarn に配線すると漏れる。Issue #433〈#399 R-9a の記録〉)", async () => {
    const h = harness();
    await analyze(h);
    const SECRET = "sk-ant-api03-ABCDEFghij_klmn-0123456789";
    const okFetch = h.gate.fetchRaw.bind(h.gate);
    h.gate.fetchRaw = async (url, ...rest) => {
      if (/api_get_jra_odds/.test(url)) throw new Error(`取得先が落ちています ${SECRET} (再試行してください)`);
      return okFetch(url, ...rest);
    };
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "retry" });
    const failures = h.warnings.filter((w) => w.includes("締切の直前の再計算の取得に失敗しました"));
    expect(failures).toHaveLength(1); // 前提: 取得の失敗の警告が実際に出ている
    expect(failures[0]).toContain("取得先が落ちています"); // 前提: 失敗の原因の文面が警告に載っている(原因を丸ごと捨てていない)
    expect(failures[0]).toContain("sk-ant-***"); // 鍵の形は伏せた形で残る
    expect(h.warnings.join("\n")).not.toContain("ABCDEFghij");
    expect(h.warnings.join("\n")).not.toContain(SECRET);
  });

  it("組合せオッズの取得に警告が出たら(券種が欠ける)、見かけの買い目の削除にしないため failed(fetch-failed)", async () => {
    const h = harness();
    await analyze(h);
    const okBody = h.gate.body;
    h.gate.body = (url) => (/type=5/.test(url) ? null : okBody(url)); // ワイドだけ 404
    const a = await fire(h, DUE1);
    expect(a.result).toBe("retry");
    const retryAt = closeRows(h)[0]!.next_try_at!;
    expect(await fire(h, retryAt)).toMatchObject({ result: "failed", reason: "fetch-failed" });
  });

  it("分析時にオッズのあった馬の単勝オッズが無い(取消など)なら failed(horse-set-mismatch)。再試行しない", async () => {
    const h = harness();
    await analyze(h);
    h.gate.body = shiftedBody(1, "05");
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "horse-set-mismatch" });
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "failed", reason: "horse-set-mismatch" });
    expect(closeRows(h)[0]!.attempts).toBe(1);
  });

  it("分析時に複勝オッズのあった馬の複勝オッズが無い場合も failed(horse-set-mismatch)", async () => {
    const h = harness();
    await analyze(h);
    const base = shiftedBody(1);
    h.gate.body = (url) => {
      const text = base(url);
      if (text === null || !/api_get_jra_odds/.test(url) || /type=[3-8]/.test(url)) return text;
      const json = JSON.parse(text) as { data: { odds: Record<string, Record<string, string[]>> } };
      delete json.data.odds["2"]!["05"];
      return JSON.stringify(json);
    };
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "horse-set-mismatch" });
  });

  it("控えた馬の集合と出馬表(キャッシュ)の馬の集合が違えば failed(horse-set-mismatch)", async () => {
    const h = harness();
    await analyze(h);
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as { horses: { umaban: number }[] };
    input.horses = input.horses.filter((x) => x.umaban !== 16); // 控えた入力から 1 頭欠ける
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    expect(input.horses).toHaveLength(15); // 前提
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "horse-set-mismatch" });
  });

  it("配分の計算が無効(route=invalid。確率が不正で計算できない)になったら failed(compute-failed)。無効の配分は保存しない", async () => {
    const h = harness();
    await analyze(h);
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as { horses: { adjustedProb: number }[] };
    input.horses = input.horses.map((x) => ({ ...x, adjustedProb: 0 }));
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "compute-failed" });
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "failed", reason: "compute-failed", allocation: null });
  });

  it("再計算の入力(控えた確率)が壊れていたら failed(analysis-failed)。オッズは取らない", async () => {
    const h = harness();
    await analyze(h);
    h.sql.exec("UPDATE race_day_close_input SET input_json = '{壊れ' WHERE race_id = ?", RACE);
    const before = h.gate.urls.length;
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "analysis-failed" });
    expect(h.gate.urls.length).toBe(before);
    expect(h.sink.closes[0]!.payload).toMatchObject({ status: "failed", reason: "analysis-failed" });
  });

  it("設定の値が壊れている入力(allocationSettings が null)も、再計算に進まず failed(analysis-failed)", async () => {
    const h = harness();
    await analyze(h);
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as Record<string, unknown>;
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify({ ...input, allocationSettings: null }), RACE);
    expect(await fire(h, DUE1)).toMatchObject({ round: 1, result: "failed", reason: "analysis-failed" });
  });
});

describe("締切の直前の再計算: D1 への保存の失敗と冪等性", () => {
  it("保存の失敗は、再計算の結果を DO に持ったまま再試行する: 取り直し(ゲート)は繰り返さず、2 回目の試行で保存される", async () => {
    const h = harness();
    await analyze(h);
    h.sink.failSaveClose = 1;
    const before = h.gate.urls.length;
    const first = await fire(h, DUE1);
    expect(first).toMatchObject({ round: 1, result: "retry" });
    expect(h.gate.urls.length - before).toBe(7);
    const row = closeRows(h)[0]!;
    expect(row.state).toBe("pending");
    expect(row.payload_json).not.toBeNull();
    expect(h.sink.closes).toHaveLength(0);
    const second = await fire(h, row.next_try_at!);
    expect(second).toMatchObject({ round: 1, result: "ok" });
    expect(h.gate.urls.length - before).toBe(7); // 取り直していない
    expect(h.sink.closes).toHaveLength(1);
  });

  it("保存が 3 回続けて失敗したら、その回は諦める(abandoned)。警告を残し、次の回は動く", async () => {
    const h = harness();
    await analyze(h);
    h.sink.failSaveClose = 3;
    let at = DUE1;
    for (let i = 0; i < 3; i++) {
      const out = await fire(h, at);
      expect(out.round).toBe(1);
      at = closeRows(h)[0]!.next_try_at ?? at;
    }
    expect(closeRows(h)[0]).toMatchObject({ state: "abandoned", save_attempts: 3, attempts: 1 });
    expect(h.warnings.some((w) => w.includes("締切の直前の再計算") && w.includes(RACE))).toBe(true);
    expect(await fire(h, DUE2)).toMatchObject({ round: 2, result: "ok" });
  });

  it("保存したあとに落ちて再実行されても(アラームは少なくとも 1 回)、取り直さず、同じ (分析 id, 回) の保存をやり直すだけ", async () => {
    const h = harness();
    await analyze(h);
    h.sink.crashAfterSaveClose = 1;
    const before = h.gate.urls.length;
    await fire(h, DUE1); // 保存してから例外 → retry
    const retryAt = closeRows(h)[0]!.next_try_at!;
    await fire(h, retryAt);
    expect(h.gate.urls.length - before).toBe(7);
    expect(h.sink.closes.map((c) => [c.analysisId, c.payload.round])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(JSON.stringify(h.sink.closes[0]!.payload)).toBe(JSON.stringify(h.sink.closes[1]!.payload));
    expect(closeRows(h)[0]!.state).toBe("done");
  });
});
