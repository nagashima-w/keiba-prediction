import { readFileSync } from "node:fs";
import { pathFromMeta } from "./meta-path.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSaveResultStatements, D1ResultStore, MIGRATED_RESULTS_SQL, withScratchedColumn, withWakubanColumn } from "../src/result-repository";
import { UPSERT_RACE_RESULT_SQL } from "../../packages/core/src/ev/analysis-store-codec.js";
import { buildVerifySource, VERIFY_READ_SQL, type VerifyReadRows } from "../src/verify-read";
import type { RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { toResultEntries } from "../../packages/core/src/ev/result-import";
import { computeVerifyReport } from "../../packages/core/src/ev/verify";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #269: 枠番の記録(`race_results.wakuban`。migration 0016)。D1 への書き込み → 読み出し → 検証の集計まで、
 * ローカル(workerd)の D1 で通す。result-scratched.test.ts(#72)と同じ構成。
 *
 * 書き込み: 枠番(1〜8)がある馬はその値、`null`・キーなしの馬は NULL。移行で入れた行(exe 由来)は列に触れない = NULL(記録なし)。
 * 読み出し: 値はそのまま、NULL はキー自体を付けない(未記録を 0 や null にしない)。
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

const store = (): D1ResultStore => new D1ResultStore({ db: local.db });

async function wakubanColumn(raceId: string): Promise<Array<[number, number | null]>> {
  const r = await local.db.prepare("SELECT umaban, wakuban FROM race_results WHERE race_id = ? ORDER BY umaban").bind(raceId).all<{ umaban: number; wakuban: number | null }>();
  return r.results.map((x) => [x.umaban, x.wakuban]);
}

describe("withWakubanColumn(scratched を足した UPSERT に、D1 専用の枠番の列を足す)", () => {
  const withScratched = withScratchedColumn(UPSERT_RACE_RESULT_SQL);

  it("列・? ・DO UPDATE SET に wakuban が1つずつ足され、scratched までの列はそのまま残る", () => {
    const sql = withWakubanColumn(withScratched);
    expect(sql).toContain("(race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f, scratched, wakuban)");
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    expect(sql).toContain("scratched = excluded.scratched,");
    expect(sql).toContain("wakuban = excluded.wakuban");
    expect(sql.match(/wakuban/g)).toHaveLength(3);
    // 元の文は変えていない(codec の文と、scratched までの文)
    expect(UPSERT_RACE_RESULT_SQL).not.toContain("wakuban");
    expect(withScratched).not.toContain("wakuban");
  });

  it("文の形が想定と違えば(列・VALUES・SET のどれかが見つからなければ)落ちる(黙って wakuban を書かない文にならない)", () => {
    expect(() => withWakubanColumn("INSERT INTO race_results (a) VALUES (?)")).toThrow(/想定と違い/);
    expect(() => withWakubanColumn(withScratched.replace("scratched = excluded.scratched", "scratched = 1"))).toThrow(/想定と違い/);
    expect(() => withWakubanColumn(withScratched.replace("last3f, scratched)", "last3f, other)"))).toThrow(/想定と違い/);
    expect(() => withWakubanColumn(withScratched.replace("VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "VALUES (1, 2, 3, 4, 5, 6, 7, 8)"))).toThrow(/想定と違い/);
  });
});

describe("保存: wakuban の書き込み", () => {
  it("枠番のある馬はその値で保存される。null・キーなしの馬は NULL(推測で埋めない)", async () => {
    const entries: RaceResultEntry[] = [
      { umaban: 1, finishPosition: 1, wakuban: 1 },
      { umaban: 2, finishPosition: null, scratched: true, wakuban: 8 }, // 取消・除外の馬の行にも枠番がある
      { umaban: 3, finishPosition: 2, wakuban: null },
      { umaban: 4, finishPosition: 3 }, // キーなし
    ];
    await store().saveResult("R269A", entries, null);
    expect(await wakubanColumn("R269A")).toEqual([
      [1, 1],
      [2, 8],
      [3, null],
      [4, null],
    ]);
  });

  it("再保存(UPSERT)で上書きされる: NULL(旧い行)の馬も、取り込み直しで枠番が入る", async () => {
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES ('R269B', 1, 1), ('R269B', 2, NULL)").run();
    expect(await wakubanColumn("R269B")).toEqual([
      [1, null],
      [2, null],
    ]);
    await store().saveResult("R269B", [{ umaban: 1, finishPosition: 1, wakuban: 4 }, { umaban: 2, finishPosition: null, scratched: true, wakuban: 4 }], null);
    expect(await wakubanColumn("R269B")).toEqual([
      [1, 4],
      [2, 4],
    ]);
  });

  it("scratched の書き込みは変わらない(枠番の列を足しても、束縛の並びがずれて scratched に枠番が入らない)", async () => {
    await store().saveResult("R269C", [{ umaban: 1, finishPosition: 1, wakuban: 6 }, { umaban: 2, finishPosition: null, scratched: true, wakuban: 7 }], null);
    const r = await local.db.prepare("SELECT umaban, scratched, wakuban FROM race_results WHERE race_id = 'R269C' ORDER BY umaban").all<{ umaban: number; scratched: number | null; wakuban: number | null }>();
    expect(r.results).toEqual([
      { umaban: 1, scratched: 0, wakuban: 6 },
      { umaban: 2, scratched: 1, wakuban: 7 },
    ]);
  });

  it("文の数は増えない(枠番は馬ごとの UPSERT の1文に載る): 馬・面・組合せ払戻ありで従来どおり最大5文", () => {
    const entries: RaceResultEntry[] = Array.from({ length: 18 }, (_, i) => ({ umaban: i + 1, finishPosition: i + 1, wakuban: Math.min(8, Math.ceil((i + 1) / 2)) }));
    const statements = buildSaveResultStatements(
      local.db,
      "R269D",
      entries,
      "芝",
      { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 500 }] }, bracketQuinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 600 }] } },
    );
    // 馬のUPSERT・面・組合せのDELETE・INSERT・取込マーカー の5文。オッズも人気も無いので単勝オッズの文は無い。
    expect(statements).toHaveLength(5);
  });

  it("実フィクスチャ(中山1R。16頭立て、6番が取消): パース → toResultEntries → 保存で、各枠2頭ずつ。取消の6番は枠3", async () => {
    const html = readFileSync(pathFromMeta("../../fixtures/result_202606040901.html", import.meta.url), "utf-8");
    const parsed = parseRaceResult(html);
    await store().saveResult("202606040901", toResultEntries(parsed), parsed.courseType ?? null);
    const col = await wakubanColumn("202606040901");
    expect(col).toHaveLength(16);
    expect(col.map(([, w]) => w)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
    expect(col.find(([u]) => u === 6)).toEqual([6, 3]);
  });

  it("実フィクスチャ(12頭立て、10番が除外): 除外の10番は枠7", async () => {
    const html = readFileSync(pathFromMeta("../../fixtures/result_202605040205.html", import.meta.url), "utf-8");
    const parsed = parseRaceResult(html);
    await store().saveResult("202605040205", toResultEntries(parsed), parsed.courseType ?? null);
    const col = await wakubanColumn("202605040205");
    expect(col).toHaveLength(12);
    expect(col.find(([u]) => u === 10)).toEqual([10, 7]);
    expect(col.find(([u]) => u === 9)).toEqual([9, 7]);
  });

  it("移行で入れた行(MIGRATED_RESULTS_SQL。exe の列だけ)は wakuban に触れない = NULL のまま", async () => {
    await local.db.prepare(MIGRATED_RESULTS_SQL).bind("R269E", JSON.stringify([[1, 1, 150, 300, "[]", null], [2, null, null, null, "[]", null]]), "R269E").run();
    expect(await wakubanColumn("R269E")).toEqual([
      [1, null],
      [2, null],
    ]);
  });
});

describe("読み出し → 検証の集計", () => {
  async function readRows(): Promise<VerifyReadRows> {
    const all = async <T>(sql: string): Promise<T[]> => (await local.db.prepare(sql).all()).results as T[];
    return {
      analyses: await all(VERIFY_READ_SQL.analyses),
      horses: await all(VERIFY_READ_SQL.horses),
      allocationMeta: await all(VERIFY_READ_SQL.allocationMeta),
      bets: await all(VERIFY_READ_SQL.bets),
      results: await all(VERIFY_READ_SQL.results),
      comboPayouts: await all(VERIFY_READ_SQL.comboPayouts),
      comboImports: await all(VERIFY_READ_SQL.comboImports),
    };
  }

  it("D1 の枠番が、getResult の wakuban になる。NULL はキー自体を付けない", async () => {
    await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at) VALUES ('R269F', '2026-10-13T00:00:00.000Z')").run();
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, scratched, wakuban) VALUES ('R269F', 1, 1, 0, 1), ('R269F', 2, NULL, 1, 8), ('R269F', 3, 2, NULL, NULL)").run();
    const results = buildVerifySource(await readRows()).getResult("R269F")!;
    expect(results.map((r) => r.wakuban)).toEqual([1, 8, undefined]);
    expect("wakuban" in results[2]!).toBe(false);
  });

  it("エンドツーエンド: 枠番が記録済みのレースでは、枠の出走馬が尽きた枠連の買い目が返還になる。同じ構成で枠番が NULL(旧い行)のレースは返還にならず不的中", async () => {
    // 8頭立て(各枠1頭。馬番 = 枠番)。5番が取消で枠5が尽きる。R269G は枠番を記録済み、R269H は scratched は記録済みだが枠番が NULL。
    for (const raceId of ["R269G", "R269H"]) {
      await local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, kaisai_date, history_cutoff_date, prompt_lookahead_guarded) VALUES (?, '2026-10-13T00:00:00.000Z', '20261013', '20261013', 1)").bind(raceId).run();
    }
    const ids = (await local.db.prepare("SELECT id FROM analyses ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      await local.db
        .prepare("INSERT INTO analysis_allocation_meta (analysis_id, route, bankroll, per_race_cap, kelly_fraction, ev_threshold, include_combo_odds, include_wide, include_trio, odds_status) VALUES (?, 'mixed', 100000, 10000, 0.5, 1, 1, 1, 1, 'result')")
        .bind(id)
        .run();
      await local.db
        .prepare("INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake) VALUES (?, 'bracketQuinella', '0508', 400), (?, 'bracketQuinella', '0607', 200)")
        .bind(id, id)
        .run();
    }
    for (const raceId of ["R269G", "R269H"]) {
      const waku = (umaban: number): number | null => (raceId === "R269G" ? umaban : null);
      for (let umaban = 1; umaban <= 8; umaban++) {
        await local.db
          .prepare("INSERT INTO race_results (race_id, umaban, finish_position, scratched, wakuban) VALUES (?, ?, ?, ?, ?)")
          .bind(raceId, umaban, umaban === 5 ? null : umaban, umaban === 5 ? 1 : 0, waku(umaban))
          .run();
      }
      await local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, 'bracketQuinella')").bind(raceId).run();
      await local.db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, 'bracketQuinella', '0102', 600)").bind(raceId).run();
    }
    const report = computeVerifyReport(buildVerifySource(await readRows()));
    expect(report.proposedBet.population.allocated).toBe(2);
    // R269G: 枠5-8(400円)は返還、枠6-7(200円)は不的中。R269H: どちらも不的中(枠番が無いので返還を判定しない)。
    expect(report.proposedBet.bracketQuinella).toMatchObject({ betCount: 4, totalStake: 1200, totalReturn: 400, refundedCount: 1, refundedStake: 400, unjudgedCount: 0 });
    expect(report.proposedBet.overall).toMatchObject({ refundedCount: 1, refundedStake: 400 });
  });
});
