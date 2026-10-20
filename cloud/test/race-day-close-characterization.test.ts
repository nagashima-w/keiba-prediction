import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { narOddsPageUrl } from "../../packages/core/src/scraper/urls";
import { CLOSE_FINAL_LEAD_MS, CLOSE_FIRST_LEAD_MS, type CloseSavePayload } from "../src/analysis-close";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { CLOSE_FETCH_RETRY_DELAY_MS } from "../src/race-day-close";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { newspaperOnlyPostRaw } from "./newspaper-post";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #399(R-9a): 締切の直前の再計算の段階(`registerClose`・`closeFetcher`・`runCloseStep`・`computeClosePayload`)を `RaceDayCore` から切り出す前に、
 * **今の挙動を固定する特性テスト**。切り出しの前後で、このファイルを書き換えずに緑のままであることが、挙動を変えていないことの根拠になる。
 *
 * 既存の `race-day-close*.test.ts` が固定していない面を固定する(既存のテストは `analysis_close` の行・理由・回・組合せの窓を固定している):
 *  - **ログの文言**(`onWarn` に渡る文面。全文一致)
 *  - **アラームの張り方**(`setAlarm` の呼び出しの系列。最新値だけでなく順序と回数)
 *  - **SQL の文と順序**(締切の 1 ステップが DO の SQLite に出す文と束縛値。先頭の語は読めるように、全体は SHA-1 で固定する)
 *  - ステップの戻り値(`reason` を含む)、保存した payload の要約、ゲートへ出た URL の系列
 *
 * 期待値は、切り出す前のコード(e1b1322)の実出力から作った。ハーネスは `race-day-close.test.ts` と同じ(ゲートは偽・ストレージは `node:sqlite`)。
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
    // 取得ステップが前走の条件(新聞形式 API。Issue #421 段階 1-b)を POST するので、警告を出さない応答を返す(このテストが固定する GET の列・警告は変わらない)。
    postRaw: newspaperOnlyPostRaw,
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
  failSaveClose: number;
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    closes: [],
    failSaveClose: 0,
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
    },
  };
  return sink;
}

const ALL_ON: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  includeComboOdds: true,
  baseScoreWeightJockey: 0,
  baseScoreWeightTrainer: 0,
};

/** 実出力を期待値と比べる。`CHAR_DUMP=<ファイル>` のときは比べず、期待値を作るために実出力を書き出す(期待値を作り直す手順。通常の実行では使わない)。 */
function check(name: string, actual: unknown): void {
  const dump = process.env.CHAR_DUMP;
  if (dump !== undefined && dump !== "") {
    appendFileSync(dump, `${JSON.stringify([name, actual])}\n`);
    return;
  }
  expect(EXPECTED[name], `${name} の期待値がある(空振りでない)`).toBeDefined();
  expect(actual).toEqual(EXPECTED[name]);
}

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly alarms: number[];
  readonly warnings: string[];
  /** 実行した SQL の全部(文を空白で詰めたもの + 束縛値の JSON)。 */
  readonly sqlLog: string[];
  settings: CloudSettings;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(): Harness {
  const base = openNodeSql();
  opened.push(base);
  const sqlLog: string[] = [];
  const sql: NodeSql = {
    get statements() {
      return base.statements;
    },
    exec(query: string, ...bindings: unknown[]) {
      sqlLog.push(`${query.replace(/\s+/g, " ").trim()} | ${JSON.stringify(bindings)}`);
      return base.exec(query, ...bindings);
    },
    close() {
      base.close();
    },
  };
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarms: number[] = [];
  const warnings: string[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const h = { sql, gate, sink, clock, alarms, warnings, sqlLog, settings: ALL_ON } as Harness;
  (h as { core: RaceDayCore }).core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarms.push(at);
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => h.settings,
  });
  return h;
}

async function analyze(h: Harness): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
  expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
}

/** 時刻を進めて 1 ステップ動かし、その間に起きたこと(戻り値・警告・アラーム・SQL・ゲート・保存)を集める。 */
async function trace(h: Harness, at: number) {
  const w = h.warnings.length;
  const a = h.alarms.length;
  const s = h.sqlLog.length;
  const u = h.gate.urls.length;
  const c = h.sink.closes.length;
  h.clock.now = at;
  const outcome: StepOutcome = await h.core.runNextStep();
  const sqlLines = h.sqlLog.slice(s);
  return {
    outcome,
    warnings: h.warnings.slice(w),
    alarms: h.alarms.slice(a),
    sqlHeads: sqlLines.map((l) => l.slice(0, 60)),
    sqlDigest: sha1(sqlLines.join("\n")),
    urls: h.gate.urls.slice(u),
    closes: h.sink.closes.slice(c).map((x) => ({
      analysisId: x.analysisId,
      payload: { ...x.payload, allocation: x.payload.allocation === null ? null : { route: x.payload.allocation.meta.route, bets: x.payload.allocation.bets.length, digest: sha1(JSON.stringify(x.payload.allocation)) } },
    })),
  };
}

const closeRows = (h: Harness) => h.sql.exec("SELECT race_id, round, analysis_id, due_ms, state, attempts, save_attempts, next_try_at, fired_at FROM race_day_close ORDER BY race_id, round").toArray();

describe("締切の再計算の特性: 登録(registerClose)", () => {
  it("分析の保存と同じ同期区間で入力と 2 回ぶんの行を積む: SQL の文と順序・アラームの系列を固定する", async () => {
    const h = harness();
    const t = await (async () => {
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
      return trace(h, h.clock.now);
    })();
    expect(t.outcome).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const registerSql = h.sqlLog.filter((l) => /race_day_close/.test(l));
    check("registerSqlHeads", registerSql.map((l) => l.slice(0, 70)));
    check("registerSqlDigest", sha1(registerSql.join("\n")));
    expect(h.warnings).toEqual([]);
    check("registerAlarms", h.alarms);
    expect(h.alarms.at(-1)).toBe(DUE1);
  });

  it("開催日が分からない・発走時刻が分からないとき: 警告を 1 件だけ残し、行も入力も積まない(分析は完了する)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    // 発走時刻を取れないようにする(出馬表のキャッシュの発走時刻の表記を壊す)
    const row = h.sql.exec("SELECT key, value FROM fetch_cache WHERE key LIKE '%shutuba.html%'").toArray()[0] as { key: string; value: string } | undefined;
    expect(row).toBeDefined();
    const broken = row!.value.replace(/\d{1,2}:\d{2}発走/g, "発走");
    expect(broken).not.toBe(row!.value); // 前提: 実際に書き換わった
    h.sql.exec("UPDATE fetch_cache SET value = ? WHERE key = ?", broken, row!.key);
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    check("noStartTimeWarnings", h.warnings);
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM race_day_close").toArray()).toEqual([{ n: 0 }]);
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM race_day_close_input").toArray()).toEqual([{ n: 0 }]);
  });
});

describe("締切の再計算の特性: 登録の失敗(catch)", () => {
  it("入力を積む SQL が失敗しても、分析は完了し(compute ok)、警告を 1 件だけ残す(例外の文面は伏せ字を通して先頭 200 文字)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    h.sql.exec("DROP TABLE race_day_close_input");
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    check("registerCatchWarnings", h.warnings);
    expect(h.sink.saved).toHaveLength(1); // 前提: 分析は保存された
  });
});

describe("締切の再計算の特性: 登録する入力の中身(変異注入で見つけた穴を塞ぐ)", () => {
  const inputOf = (h: Harness) => JSON.parse((h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string }).input_json) as Record<string, unknown> & { horses: Record<string, unknown>[] };

  it("組合せ ON: 取得キャッシュを読んでよい期間が入る(下限 = 取得ステップの開始、上限 = 分析の保存の時刻)。取得と計算のあいだで時計が進んでいても、上限は保存の時刻", async () => {
    const h = harness();
    const t0 = h.clock.now;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    h.clock.now = t0 + 5_000;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const input = inputOf(h);
    expect(input.comboFromMs).toBe(t0);
    expect(input.comboToMs).toBe(t0 + 5_000);
    expect((input.comboToMs as number) - (input.comboFromMs as number)).toBe(5_000); // 差が 0 でない
    expect(h.sql.exec("SELECT instance FROM race_day_close_input WHERE race_id = ?", RACE).toArray()).toEqual([{ instance: t0 }]);
  });

  it("出馬表の発走時刻が 1 桁の時間(9:50)でも、2 桁に揃えて発走の瞬間(UTC 00:50)を控え、回の行を積む(警告なし)", async () => {
    const h = harness();
    const base = fixtureForUrl;
    h.gate.body = (url) => {
      const text = base(url);
      return text === null || !/shutuba\.html/.test(url) ? text : text.replace(/\d{1,2}:\d{2}発走/g, "9:50発走");
    };
    await analyze(h);
    const startMs = Date.parse("2026-06-28T00:50:00Z");
    expect(h.sql.exec("SELECT start_ms FROM race_day_close_input WHERE race_id = ?", RACE).toArray()).toEqual([{ start_ms: startMs }]);
    expect(closeRows(h).map((r) => (r as { due_ms: number }).due_ms)).toEqual([startMs - CLOSE_FIRST_LEAD_MS, startMs - CLOSE_FINAL_LEAD_MS]);
    expect(h.warnings).toEqual([]);
  });

  /**
   * 登録の口を直接呼ぶ(切り出し前は `RaceDayCore.registerClose`、切り出し後は `CloseStage.register`。**どちらでも同じテストが通る**ように両方を探す)。
   * LLM なしの分析は prior と adjustedProb が同じ値になり、そのままでは両者の取り違えを検出できないので、分析の記録を手で作り替えて渡す。
   */
  const registerDirect = (h: Harness, record: AnalysisRecord): void => {
    const core = h.core as unknown as { closeStage?: { register: (...a: unknown[]) => void }; registerClose?: (...a: unknown[]) => void };
    const task = { race_id: RACE, queued_at: 4242, fetch_started_at: null };
    if (core.closeStage !== undefined) {
      core.closeStage.register(task, record, 77, ALL_ON);
    } else {
      core.registerClose!.call(h.core, task, record, 77, ALL_ON);
    }
  };

  it("prior と adjustedProb が別の値でも、控えにはそれぞれの値が入る(取り違えない)。instance はタスクの queued_at、analysis_id は渡した id", async () => {
    const h = harness();
    await analyze(h);
    h.sql.exec("DELETE FROM race_day_close");
    h.sql.exec("DELETE FROM race_day_close_input");
    const base = h.sink.saved[0]!;
    const record: AnalysisRecord = { ...base, horses: base.horses.map((x) => ({ ...x, prior: x.adjustedProb + 0.01 })) };
    registerDirect(h, record);
    const input = inputOf(h);
    for (const x of input.horses) {
      const src = record.horses.find((r) => r.umaban === x.umaban)!;
      expect(x.prior).toBe(src.prior);
      expect(x.adjustedProb).toBe(src.adjustedProb);
      expect((x.prior as number) - (x.adjustedProb as number)).toBeCloseTo(0.01, 10); // 差が 0 でない
    }
    expect(h.sql.exec("SELECT instance, analysis_id FROM race_day_close_input WHERE race_id = ?", RACE).toArray()).toEqual([{ instance: 4242, analysis_id: 77 }]);
    expect(h.warnings).toEqual([]);
  });

  it("スナップショットに無い馬番が分析の記録にあれば、何も積まず、警告を 1 件(分析は続ける旨)", async () => {
    const h = harness();
    await analyze(h);
    h.sql.exec("DELETE FROM race_day_close");
    h.sql.exec("DELETE FROM race_day_close_input");
    const base = h.sink.saved[0]!;
    registerDirect(h, { ...base, horses: [...base.horses, { ...base.horses[0]!, umaban: 99 }] });
    expect(h.warnings).toEqual([`締切の直前の再計算の入力を積めませんでした(${RACE})。分析は続けます: 馬番 99 の枠番・馬名がスナップショットにありません`]);
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM race_day_close").toArray()).toEqual([{ n: 0 }]);
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM race_day_close_input").toArray()).toEqual([{ n: 0 }]);
  });

  it("組合せ OFF: 期間は入らない", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, includeComboOdds: false };
    await analyze(h);
    const input = inputOf(h);
    expect("comboFromMs" in input).toBe(false);
    expect("comboToMs" in input).toBe(false);
    expect(input.allocationSettings).toMatchObject({ includeComboOdds: false });
  });

  it("分析時に単勝オッズの無かった馬は、控えに hadWinOdds=false で入り、締切でも単勝オッズが無くて構わない(horse-set-mismatch にしない)", async () => {
    const h = harness();
    const base = fixtureForUrl;
    const dropWin = (url: string): string | null => {
      const text = base(url);
      if (text === null || !/api_get_jra_odds/.test(url) || /type=[3-8]/.test(url)) return text;
      const json = JSON.parse(text) as { data: { odds: Record<string, Record<string, string[]>> } };
      delete json.data.odds["1"]!["05"];
      return JSON.stringify(json);
    };
    h.gate.body = dropWin;
    await analyze(h);
    const horse5 = inputOf(h).horses.find((x) => x.umaban === 5)!;
    expect(horse5.hadWinOdds).toBe(false);
    expect(inputOf(h).horses.filter((x) => x.hadWinOdds === true).length).toBe(15);
    expect(await trace(h, DUE1)).toMatchObject({ outcome: { round: 1, result: "ok", reason: null } });
  });

  it("分析時に複勝オッズの無かった馬は、控えに hadPlaceOdds=false で入り、締切でも複勝オッズが無くて構わない(horse-set-mismatch にしない)", async () => {
    const h = harness();
    const base = fixtureForUrl;
    const dropPlace = (url: string): string | null => {
      const text = base(url);
      if (text === null || !/api_get_jra_odds/.test(url) || /type=[3-8]/.test(url)) return text;
      const json = JSON.parse(text) as { data: { odds: Record<string, Record<string, string[]>> } };
      delete json.data.odds["2"]!["05"];
      return JSON.stringify(json);
    };
    h.gate.body = dropPlace;
    await analyze(h);
    const horse5 = inputOf(h).horses.find((x) => x.umaban === 5)!;
    expect(horse5.hadPlaceOdds).toBe(false);
    expect(inputOf(h).horses.filter((x) => x.hadPlaceOdds === true).length).toBe(15);
    expect(await trace(h, DUE1)).toMatchObject({ outcome: { round: 1, result: "ok", reason: null } });
  });
});

describe("締切の再計算の特性: 1 ステップ(runCloseStep・computeClosePayload)の戻り値・警告・アラーム・SQL・ゲート", () => {
  it("1 回目が ok: 7 本のオッズを取り、保存し、次のアラームは 2 回目の時刻", async () => {
    const h = harness();
    await analyze(h);
    const t = await trace(h, DUE1 + 7_000);
    check("ok1", t);
    check("ok1Rows", closeRows(h));
  });

  it("行わない(unset): 警告は「行いませんでした」1 件。取得なし", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, bankroll: 0, perRaceCap: 0 };
    await analyze(h);
    check("unset", await trace(h, DUE1));
  });

  it("行わない(too-late): 警告は「行いませんでした」1 件。取得なし", async () => {
    const h = harness();
    await analyze(h);
    check("tooLate", await trace(h, DUE2 + 1000));
  });

  it("ブレーカー(blocked): 再試行せず failed。取得の失敗の警告は出さず、「行いませんでした」だけ", async () => {
    const h = harness();
    await analyze(h);
    (h.gate as { fetchRaw: GateLike["fetchRaw"] }).fetchRaw = async () => ({ kind: "refused", reason: "blocked", message: "止めています", blockedUntil: 1, retryAfterMs: 1 });
    check("blocked", await trace(h, DUE1));
  });

  it("キャッシュに無い(CacheMissError): 取得の失敗の警告(試行 1 回。文面は CacheMissError のもの)+「行いませんでした」。再試行しない", async () => {
    const h = harness();
    await analyze(h);
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%shutuba.html%'");
    check("cacheMiss", await trace(h, DUE1));
  });

  it("オッズの取得が 404: 1 回目は retry(警告 1 件。次の試行にアラーム)、2 回目は failed(fetch-failed。警告 2 件)", async () => {
    const h = harness();
    await analyze(h);
    const okBody = h.gate.body;
    h.gate.body = (url) => (/api_get_jra_odds/.test(url) ? null : okBody(url));
    const first = await trace(h, DUE1 + 2_000);
    check("retry1", first);
    const retryAt = (closeRows(h)[0] as { next_try_at: number }).next_try_at;
    check("retry2", await trace(h, retryAt));
    check("retryRows", closeRows(h));
  });

  it("組合せオッズの警告(ワイドだけ 404): 取得の失敗の警告に組合せの警告の文面が入る", async () => {
    const h = harness();
    await analyze(h);
    const okBody = h.gate.body;
    h.gate.body = (url) => (/type=5/.test(url) ? null : okBody(url));
    check("comboWarn", await trace(h, DUE1));
  });

  it("馬の集合の不一致: failed(horse-set-mismatch)。警告は「行いませんでした」1 件", async () => {
    const h = harness();
    await analyze(h);
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as { horses: { umaban: number }[] };
    input.horses = input.horses.filter((x) => x.umaban !== 16);
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    check("horseSet", await trace(h, DUE1));
  });

  it("計算が無効(compute-failed)・入力が壊れている(analysis-failed): 警告は「行いませんでした」1 件ずつ", async () => {
    const a = harness();
    await analyze(a);
    const row = a.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as { horses: { adjustedProb: number }[] };
    input.horses = input.horses.map((x) => ({ ...x, adjustedProb: 0 }));
    a.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    check("computeFailed", await trace(a, DUE1));

    const b = harness();
    await analyze(b);
    b.sql.exec("UPDATE race_day_close_input SET input_json = '{壊れ' WHERE race_id = ?", RACE);
    check("analysisFailed", await trace(b, DUE1));
  });

  it("保存先が saveClose を持たない(分析の後に外れた): その回を abandoned にし、警告 1 件。failed(reason なし)", async () => {
    const h = harness();
    await analyze(h);
    delete (h.sink as { saveClose?: unknown }).saveClose;
    const t = await trace(h, DUE1);
    check("noSaveClose", t);
    check("noSaveCloseRows", closeRows(h));
  });

  it("保存の失敗: 1 回目は retry(アラームは +20 秒)、3 回目で諦めて(abandoned)警告。reason は payload のもの", async () => {
    const h = harness();
    await analyze(h);
    h.sink.failSaveClose = 3;
    const t1 = await trace(h, DUE1);
    const retry1 = (closeRows(h)[0] as { next_try_at: number }).next_try_at;
    const t2 = await trace(h, retry1);
    const retry2 = (closeRows(h)[0] as { next_try_at: number }).next_try_at;
    const t3 = await trace(h, retry2);
    check("saveFail", [t1, t2, t3]);
    check("saveFailRows", closeRows(h));
  });

  it("保存を諦める回の戻り値には、payload の理由が載る(行わない回〈unset〉を保存できなかったとき reason は unset)。警告は諦めた旨 1 件", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, bankroll: 0, perRaceCap: 0 };
    await analyze(h);
    h.sink.failSaveClose = 3;
    const t1 = await trace(h, DUE1);
    const t2 = await trace(h, (closeRows(h)[0] as { next_try_at: number }).next_try_at);
    const t3 = await trace(h, (closeRows(h)[0] as { next_try_at: number }).next_try_at);
    expect([t1, t2].map((t) => [t.outcome, t.warnings.length])).toEqual([
      [{ kind: "ran", raceId: RACE, mode: "close", step: "recompute", round: 1, result: "retry", reason: null }, 1], // 「行いませんでした」の警告 1 件(最初の 1 回だけ。payload は DO に残る)
      [{ kind: "ran", raceId: RACE, mode: "close", step: "recompute", round: 1, result: "retry", reason: null }, 0],
    ]);
    expect(t3.outcome).toEqual({ kind: "ran", raceId: RACE, mode: "close", step: "recompute", round: 1, result: "failed", reason: "unset" });
    expect(t3.warnings).toEqual([`締切の直前の再計算の保存を諦めました(${RACE}。回 1。試行 3 回): D1 の一時的な失敗`]);
    expect(closeRows(h)[0]).toMatchObject({ state: "abandoned", save_attempts: 3 });
  });

  it("保存を 1 回失敗したあとで保存先が saveClose を持たなくなったら、そこまでの保存の試行回数(1)を残して abandoned にする", async () => {
    const h = harness();
    await analyze(h);
    h.sink.failSaveClose = 1;
    await trace(h, DUE1);
    expect(closeRows(h)[0]).toMatchObject({ state: "pending", save_attempts: 1 });
    delete (h.sink as { saveClose?: unknown }).saveClose;
    const t = await trace(h, (closeRows(h)[0] as { next_try_at: number }).next_try_at);
    expect(t.outcome).toEqual({ kind: "ran", raceId: RACE, mode: "close", step: "recompute", round: 1, result: "failed", reason: null });
    expect(t.warnings).toEqual([`締切の直前の再計算を保存できません(${RACE}。回 1): 保存先が対応していません`]);
    expect(closeRows(h)[0]).toMatchObject({ state: "abandoned", save_attempts: 1 });
  });

  it("DO に結果がある回は取り直さない: 保存の失敗の後の再実行は、ゲートに出ず、同じ payload を保存する", async () => {
    const h = harness();
    await analyze(h);
    h.sink.failSaveClose = 1;
    await trace(h, DUE1);
    const retryAt = (closeRows(h)[0] as { next_try_at: number }).next_try_at;
    check("replay", await trace(h, retryAt));
  });
});

describe("締切の再計算の特性: 境界と壊れた入力(変異注入で見つけた穴を塞ぐ)", () => {
  const okBody = (h: Harness) => h.gate.body;
  const odds404 = (h: Harness): void => {
    const ok = okBody(h);
    h.gate.body = (url) => (/api_get_jra_odds/.test(url) ? null : ok(url));
  };

  it("再試行の時刻がちょうど次の回の時刻になるときは再試行しない(failed)。1 ミリ秒でも手前なら再試行する(retry)", async () => {
    const a = harness();
    await analyze(a);
    odds404(a);
    expect((await trace(a, DUE2 - CLOSE_FETCH_RETRY_DELAY_MS)).outcome).toMatchObject({ round: 1, result: "failed", reason: "fetch-failed" });

    const b = harness();
    await analyze(b);
    odds404(b);
    const t = await trace(b, DUE2 - CLOSE_FETCH_RETRY_DELAY_MS - 1);
    expect(t.outcome).toMatchObject({ round: 1, result: "retry", reason: null });
    expect(t.alarms).toEqual([DUE2 - 1]);
  });

  it("控えた馬の数は出馬表と同じでも、馬番の集合が違えば failed(horse-set-mismatch)", async () => {
    const h = harness();
    await analyze(h);
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as { horses: { umaban: number }[] };
    expect(input.horses).toHaveLength(16); // 前提
    // 差し替えた馬は「分析時にオッズが無かった」扱いにして、オッズの欠落(別の理由)で失敗する経路を塞ぐ。馬番の集合の違いだけで failed になることを確かめる。
    input.horses = input.horses.map((x) => (x.umaban === 16 ? { ...x, umaban: 99, hadWinOdds: false, hadPlaceOdds: false } : x));
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    expect((await trace(h, DUE1)).outcome).toMatchObject({ round: 1, result: "failed", reason: "horse-set-mismatch" });
  });

  it("race_id が壊れた行(通常は起きない)は、オッズを取らずに failed(analysis-failed)", async () => {
    const h = harness();
    await analyze(h);
    h.sql.exec("UPDATE race_day_close SET race_id = 'BAD'");
    h.sql.exec("UPDATE race_day_close_input SET race_id = 'BAD'");
    const t = await trace(h, DUE1);
    expect(t.outcome).toMatchObject({ raceId: "BAD", round: 1, result: "failed", reason: "analysis-failed" });
    expect(t.urls).toEqual([]);
  });

  it("確率が範囲外(2)で再計算が例外になっても、例外を投げず failed(compute-failed)", async () => {
    const h = harness();
    await analyze(h);
    const row = h.sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", RACE).toArray()[0] as { input_json: string };
    const input = JSON.parse(row.input_json) as { horses: { adjustedProb: number }[] };
    input.horses = input.horses.map((x, i) => ({ ...x, adjustedProb: i === 0 ? 2 : x.adjustedProb }));
    h.sql.exec("UPDATE race_day_close_input SET input_json = ? WHERE race_id = ?", JSON.stringify(input), RACE);
    expect((await trace(h, DUE1)).outcome).toMatchObject({ round: 1, result: "failed", reason: "compute-failed" });
  });
});

// ---- 地方・組合せ ON(部分的な取り直し)。ハーネスは race-day-close-nar.test.ts と同じ(ここは時計を進めるために別に持つ) ----

const NAR_DATE = "20260712";
const NAR_RACE = "202654071210";
const NAR_START_MS = Date.parse("2026-07-12T11:50:00Z");
const NAR_DUE1 = NAR_START_MS - CLOSE_FIRST_LEAD_MS;
const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name), "utf-8");
const axisHtml = (axis: number): string => `<div id="odds_view_form"><table class="Odds_Table"><tr><td class="Odds" id="chk_x_b7_c0_${axis}_11_12">900.0</td></tr></table></div>`;
const trifectaAxisHtml = (axis: number): string => {
  const second = axis === 11 ? 12 : 11;
  const third = axis === 1 ? 2 : 1;
  return `<div id="odds_view_form"><table class="Odds_Table"><tr><td class="Odds" id="chk_x_b8_c0_${axis}_${second}_${third}">90000.0</td></tr></table></div>`;
};
function narBody(url: string): string {
  if (url.includes("shutuba.html")) return fixture("nar_shutuba_202654071210.html");
  if (url.includes("ajax_horse_results")) return fixture("horse_results_2021104387.json");
  if (url.includes("odds_get_form.html")) {
    const axis = Number(/[?&]jiku=(\d+)/.exec(url)![1]);
    return url.includes("type=b8") ? trifectaAxisHtml(axis) : axisHtml(axis);
  }
  if (url.includes("type=b1&")) return fixture("nar_odds_b1_202654071210.html");
  if (url.includes("type=b4&")) return fixture("nar_odds_b4_202654071210.html");
  if (url.includes("type=b5&")) return fixture("nar_odds_b5_202654071210.html");
  if (url.includes("type=b6&")) return fixture("nar_odds_b6_202654071210.html");
  if (url.includes("type=b7&")) return fixture("nar_odds_b7_202654071210.html");
  if (url.includes("type=b3&")) return `<div id="odds_view_form"></div>`;
  throw new Error(`未知のURL(NAR): ${url}`);
}

describe("締切の再計算の特性: 地方・組合せ ON で、取得と保存のあいだに時計が進んでも、分析時の組合せのキャッシュを読める", () => {
  it("取得ステップの開始 t0、計算の保存 t0+N 秒のとき、期間は [t0, 保存時刻] で、その間に取った組合せのキャッシュを読んで ok(配分は分析時と一致)", async () => {
    const sql = openNodeSql();
    opened.push(sql);
    const clock = { now: Date.parse("2026-07-12T09:00:00Z") };
    const warnings: string[] = [];
    const gate = fakeGate();
    gate.body = narBody;
    const sink = fakeSink();
    const core = new RaceDayCore({ sql, now: () => clock.now, gate, setAlarm: () => {}, onWarn: (m) => warnings.push(m), sink, loadSettings: async () => ALL_ON });
    const t0 = clock.now;
    await core.schedule({ raceId: NAR_RACE, kaisaiDate: NAR_DATE, mode: "pre_race" });
    let computed = false;
    for (let i = 0; i < 6 && !computed; i++) {
      const out = await core.runNextStep();
      computed = out.kind === "ran" && out.mode === "pre_race" && out.step === "compute";
      clock.now += 3_000; // ステップごとに時計を進める(取得 t0・軸の段階 t0+3 秒・計算 t0+6 秒ごろ)
    }
    expect(computed).toBe(true);
    const input = JSON.parse((sql.exec("SELECT input_json FROM race_day_close_input WHERE race_id = ?", NAR_RACE).toArray()[0] as { input_json: string }).input_json) as { comboFromMs: number; comboToMs: number };
    expect(input.comboFromMs).toBe(t0);
    expect(input.comboToMs - input.comboFromMs).toBeGreaterThanOrEqual(6_000); // 期間が 0 でない(下限と上限を取り違えても検出できる)
    clock.now = NAR_DUE1;
    const outcome = await core.runNextStep();
    expect(outcome).toMatchObject({ kind: "ran", mode: "close", round: 1, result: "ok", reason: null });
    expect(gate.urls.filter((u) => u.includes("/odds/")).slice(-1)).toEqual([narOddsPageUrl(parseRaceId(NAR_RACE))]);
    expect(JSON.stringify(sink.closes[0]!.payload.allocation)).toBe(JSON.stringify(sink.saved[0]!.allocation));
    expect(warnings).toEqual([]);
  });
});

/**
 * 期待値(切り出す前のコード e1b1322 の実出力。`CHAR_DUMP=<ファイル> npx vitest run test/race-day-close-characterization.test.ts` で書き出せる)。
 * `sqlHeads` は読むための先頭 60 文字、`sqlDigest` は全文(束縛値を含む)の SHA-1。`allocation.digest` は配分の JSON の SHA-1。時刻はテストの時計(UTC 2026-06-28)のエポックミリ秒。
 */
const EXPECTED: Record<string, any> = {
  "registerSqlHeads": [
    "CREATE TABLE IF NOT EXISTS race_day_close_input ( race_id TEXT PRIMARY",
    "CREATE TABLE IF NOT EXISTS race_day_close ( race_id TEXT NOT NULL, rou",
    "DELETE FROM race_day_close WHERE race_id = ? | [\"202603020211\"]",
    "DELETE FROM race_day_close_input WHERE race_id = ? | [\"202603020211\"]",
    "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day_close WHE",
    "SELECT * FROM race_day_close WHERE state = 'pending' AND COALESCE(next",
    "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day_close WHE",
    "SELECT * FROM race_day_close WHERE state = 'pending' AND COALESCE(next",
    "INSERT INTO race_day_close_input (race_id, instance, analysis_id, star",
    "INSERT INTO race_day_close (race_id, round, analysis_id, due_ms, state",
    "INSERT INTO race_day_close (race_id, round, analysis_id, due_ms, state",
    "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day_close WHE"
  ],
  "registerSqlDigest": "98a903c1b61e6ee29807756c4d6c5a44644b5096",
  "registerAlarms": [
    1782604800000,
    1782604800000,
    1782628800000
  ],
  "noStartTimeWarnings": [
    "締切の直前の再計算の入力を積めませんでした(202603020211): 開催日または発走時刻が分かりません"
  ],
  "registerCatchWarnings": [
    "締切の直前の再計算の入力を積めませんでした(202603020211)。分析は続けます: no such table: race_day_close_input"
  ],
  "ok1": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "ok",
      "reason": null
    },
    "warnings": [],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "0f9f2f7157b70ea7ddf1b73eb2f71be67d690208",
    "urls": [
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=5&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=4&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=6&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=8&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=3&action=init"
    ],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628807000,
          "lateMs": 7000,
          "status": "ok",
          "reason": null,
          "oddsOfficialDatetime": "2026-06-28 15:52:30",
          "allocation": {
            "route": "mixed",
            "bets": 273,
            "digest": "e9679eb625a165888f77c34245d888c80ab9a4f4"
          }
        }
      }
    ]
  },
  "ok1Rows": [
    {
      "race_id": "202603020211",
      "round": 1,
      "analysis_id": 1,
      "due_ms": 1782628800000,
      "state": "done",
      "attempts": 1,
      "save_attempts": 0,
      "next_try_at": null,
      "fired_at": 1782628807000
    },
    {
      "race_id": "202603020211",
      "round": 2,
      "analysis_id": 1,
      "due_ms": 1782628980000,
      "state": "pending",
      "attempts": 0,
      "save_attempts": 0,
      "next_try_at": null,
      "fired_at": null
    }
  ],
  "unset": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "unset"
    },
    "warnings": [
      "締切の直前の再計算を行いませんでした(202603020211。回 1): skipped unset"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "b80f170834d8605378cb75acf9fca6c039ecb9e3",
    "urls": [],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628800000,
          "lateMs": 0,
          "status": "skipped",
          "reason": "unset",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "tooLate": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "too-late"
    },
    "warnings": [
      "締切の直前の再計算を行いませんでした(202603020211。回 1): skipped too-late"
    ],
    "alarms": [
      1782628981000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "02aecc48c68174d730799a051097a951f248da1e",
    "urls": [],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628981000,
          "lateMs": 181000,
          "status": "skipped",
          "reason": "too-late",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "blocked": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "blocked"
    },
    "warnings": [
      "締切の直前の再計算を行いませんでした(202603020211。回 1): failed blocked"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "0aec4bcbe16d20c93f14c71cce6ab75db488dc5e",
    "urls": [],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628800000,
          "lateMs": 0,
          "status": "failed",
          "reason": "blocked",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "cacheMiss": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "fetch-failed"
    },
    "warnings": [
      "締切の直前の再計算の取得に失敗しました(202603020211。回 1。試行 1 回): キャッシュに無い取得先です(計算ステップは netkeiba には出ません): https://race.netkeiba.com/race/shutuba.html?race_id=202603020211",
      "締切の直前の再計算を行いませんでした(202603020211。回 1): failed fetch-failed"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "0e96094ae784de6ef5824bf3d877fa9410cfc5d1",
    "urls": [],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628800000,
          "lateMs": 0,
          "status": "failed",
          "reason": "fetch-failed",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "retry1": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "retry",
      "reason": null
    },
    "warnings": [
      "締切の直前の再計算の取得に失敗しました(202603020211。回 1。試行 1 回): HTTPエラー(404)が発生しました: https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init"
    ],
    "alarms": [
      1782628817000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "UPDATE race_day_close SET attempts = ?, next_try_at = ? WHER",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "d6e123aa2ece29dfadfcd4c4067e90d3c39369f7",
    "urls": [
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init"
    ],
    "closes": []
  },
  "retry2": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "fetch-failed"
    },
    "warnings": [
      "締切の直前の再計算の取得に失敗しました(202603020211。回 1。試行 2 回): HTTPエラー(404)が発生しました: https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init",
      "締切の直前の再計算を行いませんでした(202603020211。回 1): failed fetch-failed"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "e3e5a5df7786ac3c9394bc8dc03abd11b0b9c89a",
    "urls": [
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init"
    ],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628802000,
          "lateMs": 2000,
          "status": "failed",
          "reason": "fetch-failed",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "retryRows": [
    {
      "race_id": "202603020211",
      "round": 1,
      "analysis_id": 1,
      "due_ms": 1782628800000,
      "state": "done",
      "attempts": 2,
      "save_attempts": 0,
      "next_try_at": null,
      "fired_at": 1782628802000
    },
    {
      "race_id": "202603020211",
      "round": 2,
      "analysis_id": 1,
      "due_ms": 1782628980000,
      "state": "pending",
      "attempts": 0,
      "save_attempts": 0,
      "next_try_at": null,
      "fired_at": null
    }
  ],
  "comboWarn": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "retry",
      "reason": null
    },
    "warnings": [
      "締切の直前の再計算の取得に失敗しました(202603020211。回 1。試行 1 回): ワイドオッズを1件も取得できませんでした(発売なし/未発売〈状態②③〉とは異なる。内訳: 未発売/発売なし=0 / 取得失敗=1 / 構造異常=0。requestCount=1)"
    ],
    "alarms": [
      1782628815000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "UPDATE race_day_close SET attempts = ?, next_try_at = ? WHER",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "ab711d2c311937a09976baeb7f124252d8b8efda",
    "urls": [
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=5&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=4&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=6&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=8&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=3&action=init"
    ],
    "closes": []
  },
  "horseSet": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "horse-set-mismatch"
    },
    "warnings": [
      "締切の直前の再計算を行いませんでした(202603020211。回 1): failed horse-set-mismatch"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "51162341bac1b90e75973aaf104c8ba0c8e4fd0f",
    "urls": [
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=5&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=4&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=6&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=8&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=3&action=init"
    ],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628800000,
          "lateMs": 0,
          "status": "failed",
          "reason": "horse-set-mismatch",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "computeFailed": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "compute-failed"
    },
    "warnings": [
      "締切の直前の再計算を行いませんでした(202603020211。回 1): failed compute-failed"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "935895bb29845482546c8197131c35bf14c00aba",
    "urls": [
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=5&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=4&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=6&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=8&action=init",
      "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=3&action=init"
    ],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628800000,
          "lateMs": 0,
          "status": "failed",
          "reason": "compute-failed",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "analysisFailed": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": "analysis-failed"
    },
    "warnings": [
      "締切の直前の再計算を行いませんでした(202603020211。回 1): failed analysis-failed"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
      "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "fea2e3147889488770d467cff8b0871dff9ec578",
    "urls": [],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628800000,
          "lateMs": 0,
          "status": "failed",
          "reason": "analysis-failed",
          "oddsOfficialDatetime": null,
          "allocation": null
        }
      }
    ]
  },
  "noSaveClose": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "failed",
      "reason": null
    },
    "warnings": [
      "締切の直前の再計算を保存できません(202603020211。回 1): 保存先が対応していません"
    ],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET state = 'abandoned', save_attempts",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "cf30b865a8f4b9381e185ab24c0fc320ff1cb0f4",
    "urls": [],
    "closes": []
  },
  "noSaveCloseRows": [
    {
      "race_id": "202603020211",
      "round": 1,
      "analysis_id": 1,
      "due_ms": 1782628800000,
      "state": "abandoned",
      "attempts": 0,
      "save_attempts": 0,
      "next_try_at": null,
      "fired_at": 1782628800000
    },
    {
      "race_id": "202603020211",
      "round": 2,
      "analysis_id": 1,
      "due_ms": 1782628980000,
      "state": "pending",
      "attempts": 0,
      "save_attempts": 0,
      "next_try_at": null,
      "fired_at": null
    }
  ],
  "saveFail": [
    {
      "outcome": {
        "kind": "ran",
        "raceId": "202603020211",
        "mode": "close",
        "step": "recompute",
        "round": 1,
        "result": "retry",
        "reason": null
      },
      "warnings": [],
      "alarms": [
        1782628820000
      ],
      "sqlHeads": [
        "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
        "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
        "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
        "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
        "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
        "SELECT * FROM race_day_close_input WHERE race_id = ? | [\"202",
        "SELECT MIN(due_ms) AS t FROM race_day_close WHERE race_id = ",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "SELECT value, fetched_at AS fetchedAt FROM fetch_cache WHERE",
        "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
        "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
        "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
        "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
        "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
        "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
        "INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ",
        "UPDATE race_day_close SET attempts = ? WHERE race_id = ? AND",
        "UPDATE race_day_close SET payload_json = ? WHERE race_id = ?",
        "UPDATE race_day_close SET save_attempts = ?, next_try_at = ?",
        "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
        "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
        "SELECT status, attempts, compute_attempts FROM race_day_task",
        "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
        "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
        "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
        "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
        "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
      ],
      "sqlDigest": "af84a06785f19545908c2fc51f23b19e642d3573",
      "urls": [
        "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=1&action=init",
        "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=5&action=init",
        "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init",
        "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=4&action=init",
        "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=6&action=init",
        "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=8&action=init",
        "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=3&action=init"
      ],
      "closes": []
    },
    {
      "outcome": {
        "kind": "ran",
        "raceId": "202603020211",
        "mode": "close",
        "step": "recompute",
        "round": 1,
        "result": "retry",
        "reason": null
      },
      "warnings": [],
      "alarms": [
        1782628840000
      ],
      "sqlHeads": [
        "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
        "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
        "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
        "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
        "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
        "UPDATE race_day_close SET save_attempts = ?, next_try_at = ?",
        "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
        "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
        "SELECT status, attempts, compute_attempts FROM race_day_task",
        "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
        "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
        "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
        "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
        "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
      ],
      "sqlDigest": "bb51860376636649a7cf1c5dfe809065039f430d",
      "urls": [],
      "closes": []
    },
    {
      "outcome": {
        "kind": "ran",
        "raceId": "202603020211",
        "mode": "close",
        "step": "recompute",
        "round": 1,
        "result": "failed",
        "reason": null
      },
      "warnings": [
        "締切の直前の再計算の保存を諦めました(202603020211。回 1。試行 3 回): D1 の一時的な失敗"
      ],
      "alarms": [
        1782628980000
      ],
      "sqlHeads": [
        "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
        "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
        "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
        "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
        "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
        "UPDATE race_day_close SET state = 'abandoned', save_attempts",
        "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
        "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
        "SELECT status, attempts, compute_attempts FROM race_day_task",
        "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
        "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
        "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
        "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
        "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
      ],
      "sqlDigest": "10ba6c22ae67e46c532ba266b4943618cc21ee1a",
      "urls": [],
      "closes": []
    }
  ],
  "saveFailRows": [
    {
      "race_id": "202603020211",
      "round": 1,
      "analysis_id": 1,
      "due_ms": 1782628800000,
      "state": "abandoned",
      "attempts": 1,
      "save_attempts": 3,
      "next_try_at": null,
      "fired_at": 1782628800000
    },
    {
      "race_id": "202603020211",
      "round": 2,
      "analysis_id": 1,
      "due_ms": 1782628980000,
      "state": "pending",
      "attempts": 0,
      "save_attempts": 0,
      "next_try_at": null,
      "fired_at": null
    }
  ],
  "replay": {
    "outcome": {
      "kind": "ran",
      "raceId": "202603020211",
      "mode": "close",
      "step": "recompute",
      "round": 1,
      "result": "ok",
      "reason": null
    },
    "warnings": [],
    "alarms": [
      1782628980000
    ],
    "sqlHeads": [
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT venue FROM race_day_plan_venue WHERE state = 'pending",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT * FROM race_day_close WHERE state = 'pending' AND COA",
      "UPDATE race_day_close SET fired_at = ? WHERE race_id = ? AND",
      "UPDATE race_day_close SET state = 'done', next_try_at = NULL",
      "SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('q",
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONF",
      "SELECT status, attempts, compute_attempts FROM race_day_task",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"purge_due_",
      "SELECT MIN(next_try_at) AS at FROM race_day_plan_venue WHERE",
      "SELECT * FROM race_day_plan_venue ORDER BY venue | []",
      "SELECT value FROM race_day_meta WHERE key = ? | [\"plan_final",
      "SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day"
    ],
    "sqlDigest": "bea848144f0de61746ba5fab6e3304d7e3db05f0",
    "urls": [],
    "closes": [
      {
        "analysisId": 1,
        "payload": {
          "round": 1,
          "dueAtMs": 1782628800000,
          "firedAtMs": 1782628800000,
          "lateMs": 0,
          "status": "ok",
          "reason": null,
          "oddsOfficialDatetime": "2026-06-28 15:52:30",
          "allocation": {
            "route": "mixed",
            "bets": 273,
            "digest": "e9679eb625a165888f77c34245d888c80ab9a4f4"
          }
        }
      }
    ]
  }
};
