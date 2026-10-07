import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { D1AnalysisStore } from "../src/analysis-repository";
import { createAnalysisSink, MAX_BETS_JSON_BYTES } from "../src/analysis-sink";
import { RaceDayCore } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql } from "./node-sql";

/**
 * Issue #178(#164-c): 発走前の分析の保存先(`AnalysisSink`)の実装。**本物の(ローカルの workerd の)D1・R2**に対して検査する(本番の D1・R2 には触れない)。
 *  - 子の行(馬・買い目)が正しい親 id に紐づく(#175 の `max(id)` の前提を、ローカルの D1 で確かめる)
 *  - 保存のあとの重複の確認(同じレース・同じ分析時刻)
 *  - 買い目の件数・大きさの上限(#175 の申し送り)
 *  - DO(RaceDayCore)から保存まで通して、D1 の文の数を数える(AC-c6)・保存が1件(AC-c1)
 */

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

const count = async (table: string): Promise<number> => (await local.db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;

function mkRecord(i: number, nHorses: number, nBets: number | null, extra: Partial<AnalysisRecord> = {}): AnalysisRecord {
  const base: AnalysisRecord = {
    raceId: `R${String(i).padStart(4, "0")}`,
    analyzedAt: `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    kaisaiDate: "20261006",
    promptVersion: null,
    horses: Array.from({ length: nHorses }, (_, k) => ({
      umaban: k + 1,
      prior: 0.5,
      adjustedProb: 0.25,
      placeOddsMin: 1.5,
      ev: 1.1,
      isPositive: false,
      contributions: { k },
      mark: null,
      reason: null,
    })),
    ...extra,
  };
  if (nBets === null) return base;
  const meta = contractCases[0]!.record.allocation!.meta;
  return { ...base, allocation: { meta, bets: Array.from({ length: nBets }, (_, b) => ({ betType: "wide", comboKey: `${i}-${b}`, stake: 100, odds: 5.5, ev: 1.2 })) } };
}

const sink = (): ReturnType<typeof createAnalysisSink> => createAnalysisSink(new D1AnalysisStore({ db: local.db, bucket: local.r2 }));

describe("子の行の件数(countChildren)", () => {
  it("分析ごとに、紐づいた馬・買い目の件数を返す(別の分析の子の行を数えない。max(id) の前提の確認)", async () => {
    const s = sink();
    const a = await s.save(mkRecord(1, 3, 2));
    const b = await s.save(mkRecord(2, 5, 0));
    const c = await s.save(mkRecord(3, 4, null));
    expect(await s.countChildren(a.id)).toEqual({ horses: 3, bets: 2 });
    expect(await s.countChildren(b.id)).toEqual({ horses: 5, bets: 0 });
    expect(await s.countChildren(c.id)).toEqual({ horses: 4, bets: 0 });
    expect(await s.countChildren(999_999)).toEqual({ horses: 0, bets: 0 });
    // 前提: 3つの分析が別の id で、全体の行数は子の行の合計(取り違えがない)
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(await count("analysis_horses")).toBe(12);
    expect(await count("analysis_bets")).toBe(2);
  });
});

describe("重複の確認(findByAnalyzedAt)", () => {
  it("同じレース・同じ分析時刻の分析があればその id、レース違い・分析時刻違いは null", async () => {
    const s = sink();
    const saved = await s.save(mkRecord(1, 2, null));
    const rec = mkRecord(1, 2, null);
    expect(await s.findByAnalyzedAt(rec.raceId, rec.analyzedAt)).toBe(saved.id);
    expect(await s.findByAnalyzedAt("R9999", rec.analyzedAt)).toBeNull();
    expect(await s.findByAnalyzedAt(rec.raceId, "2026-10-06T00:00:59.999Z")).toBeNull();
  });

  it("同じレースに複数の分析があっても、分析時刻が一致するものを見つける(新しい順の先頭だけを見ない)", async () => {
    const s = sink();
    const first = await s.save(mkRecord(1, 2, null, { analyzedAt: "2026-10-06T00:00:01.000Z" }));
    await s.save(mkRecord(1, 2, null, { analyzedAt: "2026-10-06T00:00:02.000Z" }));
    await s.save(mkRecord(1, 2, null, { analyzedAt: "2026-10-06T00:00:03.000Z" }));
    expect(await s.findByAnalyzedAt("R0001", "2026-10-06T00:00:01.000Z")).toBe(first.id);
  });
});

describe("直近の分析の読み取り(findRecentByRace。Issue #204: 発走前の自動実行が、手動の分析との重複を確かめる)", () => {
  const T = (sec: string): string => `2026-10-07T09:00:${sec}.000Z`;

  it("同じレースの、分析時刻が [from, to](両端を含む)の分析だけを、分析時刻の順に返す。1ms 外・別のレースは含まない", async () => {
    const s = sink();
    const at = async (raceIndex: number, analyzedAt: string) => (await s.save(mkRecord(raceIndex, 2, null, { analyzedAt, raceId: `R${String(raceIndex).padStart(4, "0")}` }))).id;
    const justBefore = await at(1, "2026-10-07T08:59:59.999Z");
    const atFrom = await at(1, "2026-10-07T09:00:00.000Z");
    const inside = await at(1, "2026-10-07T09:10:00.000Z");
    const atTo = await at(1, "2026-10-07T09:15:00.000Z");
    const justAfter = await at(1, "2026-10-07T09:15:00.001Z");
    const otherRace = await at(2, "2026-10-07T09:10:00.000Z");
    const found = await s.findRecentByRace("R0001", "2026-10-07T09:00:00.000Z", "2026-10-07T09:15:00.000Z");
    // 前提: 候補は 6 件あり、そのうち範囲内は 3 件(自明に通らないよう、外の 3 件の id が別であることも固定する)
    expect(new Set([justBefore, atFrom, inside, atTo, justAfter, otherRace]).size).toBe(6);
    expect(found.map((r) => r.id)).toEqual([atFrom, inside, atTo]);
  });

  it("prompt_version と model を、保存した値のまま返す(LLM が効いた分析は両方あり、キー未登録は両方 null、fallback は prompt_version だけ)", async () => {
    const s = sink();
    await s.save(mkRecord(1, 2, null, { analyzedAt: T("01"), promptVersion: "2026-10-07.1", model: "claude-sonnet-x" }));
    await s.save(mkRecord(1, 2, null, { analyzedAt: T("02"), promptVersion: null, model: null }));
    await s.save(mkRecord(1, 2, null, { analyzedAt: T("03"), promptVersion: "2026-10-07.1-clip015", model: null }));
    const found = await s.findRecentByRace("R0001", T("00"), T("59"));
    expect(found.map((r) => [r.analyzedAt, r.promptVersion, r.model])).toEqual([
      [T("01"), "2026-10-07.1", "claude-sonnet-x"],
      [T("02"), null, null],
      [T("03"), "2026-10-07.1-clip015", null],
    ]);
  });

  it("D1 の読み出しは 1 文(馬・買い目・大きな列は読まない)", async () => {
    const spied = spyDb(local.db);
    const s = createAnalysisSink(new D1AnalysisStore({ db: spied.db, bucket: local.r2 }));
    await s.findRecentByRace("R0001", T("00"), T("59"));
    expect(spied.prepared).toHaveLength(1);
    expect(spied.batches).toEqual([]);
    expect(spied.prepared[0]).not.toMatch(/analysis_horses|analysis_bets|raw_response|race_snapshot/);
  });
});

describe("買い目の大きさの上限(#175 の申し送り)", () => {
  /** 買い目の JSON が約 `bytes` バイトになる記録(1件の comboKey を長くする)。 */
  const bigBets = (bytes: number): AnalysisRecord => {
    const record = mkRecord(1, 2, 1);
    const bet = record.allocation!.bets[0]!;
    return { ...record, allocation: { ...record.allocation!, bets: [{ ...bet, comboKey: "x".repeat(bytes) }] } };
  };

  it("上限は 1.5MB(D1 の文字列の上限 2,000,000 バイトの手前)。上限を超える買い目は、D1 に何も書かずに拒否する", async () => {
    expect(MAX_BETS_JSON_BYTES).toBe(1_500_000);
    await expect(sink().save(bigBets(MAX_BETS_JSON_BYTES + 1000))).rejects.toThrow(/買い目/);
    expect(await count("analyses")).toBe(0);
    expect(await count("analysis_bets")).toBe(0);
  });

  it("上限の内側の大きな買い目は保存できる(1.4MB)。通常の最大(中央16頭・全券種で 265 件・約 23KB)は、上限の 1/60 以下", async () => {
    const saved = await sink().save(bigBets(1_400_000));
    expect(saved.id).toBeGreaterThan(0);
    expect(await count("analysis_bets")).toBe(1);
    // 通常の最大(exe 側の golden。全券種 ON の 265 件)の大きさ
    const typical = JSON.stringify(
      Array.from({ length: 265 }, (_, i) => ({ betType: "trifecta", comboKey: String(100_000 + i), stake: 100, odds: 100.5, ev: 1.2345678901234567 })),
    ).length;
    expect(typical * 60).toBeLessThan(MAX_BETS_JSON_BYTES);
  });
});

describe("DO(RaceDayCore)から保存まで通す(本物の D1・R2。AC-c1・c6)", () => {
  const DATE = "20260628";
  const RACE = "202603020211";
  const encoder = new TextEncoder();
  const SETTINGS: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, includeComboOdds: true };

  function setup(extra: { failPut?: (n: number) => boolean } = {}) {
    const spiedDb = spyDb(local.db);
    const spiedBucket = spyBucket(local.r2, extra);
    const gateUrls: string[] = [];
    const sql = openNodeSql();
    const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
    const alarm: { at: number | null } = { at: null };
    const warnings: string[] = [];
    const core = new RaceDayCore({
      sql,
      now: () => clock.now,
      gate: {
        fetchRaw: async (url) => {
          gateUrls.push(url);
          const view = encoder.encode(fixtureForUrl(url));
          const body = new Uint8Array(view.length);
          body.set(view);
          return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: body.buffer, queuedMs: 0, elapsedMs: 1 };
        },
      },
      setAlarm: (at) => {
        alarm.at = at;
      },
      onWarn: (m) => warnings.push(m),
      sink: createAnalysisSink(new D1AnalysisStore({ db: spiedDb.db, bucket: spiedBucket.bucket, now: () => new Date(clock.now) })),
      loadSettings: async () => SETTINGS,
    });
    return { core, sql, clock, alarm, warnings, gateUrls, spiedDb, spiedBucket };
  }

  it("AC-c6: 計算・保存ステップの D1 の文と R2 の操作の合計は 45 未満。保存は1件で、子の行が正しい親 id に紐づき、R2 に詳細が置かれ、childrenOk: true", async () => {
    const t = setup();
    await t.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await t.core.runNextStep(); // 取得(設定は DO 側の fake。D1 は使わない)
    t.spiedDb.prepared.length = 0;
    t.spiedBucket.calls.length = 0;
    const gateBefore = t.gateUrls.length;
    expect(await t.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    const total = t.spiedDb.prepared.length + t.spiedBucket.calls.length;
    expect(total).toBeLessThan(45);
    expect(total).toBeGreaterThan(5); // 前提: 実際に D1・R2 を使っている(空振りでない)
    expect(t.gateUrls).toHaveLength(gateBefore); // AC-c5: gate は0回

    expect(await count("analyses")).toBe(1);
    const row = await local.db.prepare("SELECT id, race_id, kaisai_date, detail_key FROM analyses").first<{ id: number; race_id: string; kaisai_date: string; detail_key: string | null }>();
    expect(row).toMatchObject({ race_id: RACE, kaisai_date: DATE });
    expect(row!.detail_key).toBe(`analyses/${row!.id}.json.gz`);
    expect((await local.r2.get(row!.detail_key!))).not.toBeNull();
    // 子の行はすべて、その親 id に紐づく(孤児がなく、別の id に付いていない)
    const horses = await local.db.prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT analysis_id) AS d, MIN(analysis_id) AS m FROM analysis_horses").first<{ c: number; d: number; m: number }>();
    expect(horses).toEqual({ c: 16, d: 1, m: row!.id });
    const bets = await local.db.prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT analysis_id) AS d, MIN(analysis_id) AS m FROM analysis_bets").first<{ c: number; d: number; m: number }>();
    expect(bets!.c).toBeGreaterThan(1);
    expect(bets).toMatchObject({ d: 1, m: row!.id });
    expect(t.core.getBoard().races[0]).toMatchObject({ status: "done", analysisId: row!.id, detail: "stored", childrenOk: true });
    expect(t.warnings).toEqual([]);
  });

  it("AC-c1(本物の D1): 保存のあとにクラッシュして計算ステップが再実行されても、D1 の分析は1件(2件目を作らない)", async () => {
    const t = setup();
    await t.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await t.core.runNextStep();
    // 保存はできたが、DO が状態(analysis_id)を書く前にクラッシュした状況: 状態の analysis_id・detail を消して「計算待ち」のまま再実行する
    await t.core.runNextStep();
    expect(await count("analyses")).toBe(1);
    const firstId = t.core.getBoard().races[0]!.analysisId;
    expect(firstId).not.toBeNull();
    t.sql.exec("UPDATE race_day_tasks SET status = 'fetched', analysis_id = NULL, detail = NULL, children_ok = NULL WHERE mode = 'pre_race'");
    expect(await t.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(await count("analyses")).toBe(1);
    expect(await count("analysis_horses")).toBe(16);
    // 再実行は、保存済みの分析(同じ id)を見つけて、新しく採番しない
    expect(t.core.getBoard().races[0]).toMatchObject({ status: "done", analysisId: firstId });
  });

  it("R2 の書き込みが失敗しても分析は保存される(要約だけが残り detail: failed)。分析は done で、R2 の失敗を理由に再試行しない", async () => {
    const t = setup({ failPut: () => true });
    await t.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await t.core.runNextStep();
    expect(await t.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(await count("analyses")).toBe(1);
    expect(t.core.getBoard().races[0]).toMatchObject({ status: "done", detail: "failed", childrenOk: true });
    const row = await local.db.prepare("SELECT detail_key FROM analyses").first<{ detail_key: string | null }>();
    expect(row!.detail_key).toBeNull();
  });
});
