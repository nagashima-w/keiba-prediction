import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1ResultStore, LIST_BACKFILL_SQL, UNIMPORTED_MAX_LIMIT } from "../src/result-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #217(#167-C): 結果の補完の列挙・集計(`listBackfillRaces`・`countBackfill`)を、ローカル(workerd)の D1 で確かめる。
 * 判定は既存の `listUnimportedRacesByDay` と同じ(分析済み・`race_results` に行が 1 件も無い)。違いは 3 つ:
 * 窓の下限が無い(`to` 以前の全部)・「新しい日を 1 日だけ」取る・除外するレース ID を渡せる。
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

async function addAnalysis(raceId: string, kaisaiDate: string | null, i = 0): Promise<void> {
  await local.db
    .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)")
    .bind(raceId, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, kaisaiDate)
    .run();
}

describe("listBackfillRaces: 未取込のある最も新しい日(to 以前)を、その日のぶんだけ", () => {
  it("to 以前で最も新しい未取込の日だけを返す(その日のレースID 昇順)。to より後・開催日が NULL・結果のあるレースは含めない", async () => {
    await addAnalysis("B2", "20261003");
    await addAnalysis("A2", "20261003");
    await addAnalysis("OTHERDAY", "20261001"); // 古い日(返らない)
    await addAnalysis("AFTER", "20261005"); // to の後
    await addAnalysis("NULLDATE", null);
    await addAnalysis("DONE", "20261003");
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES ('DONE', 1, NULL)").run(); // 全頭中止でも行があれば取り込み済み
    const list = await store().listBackfillRaces({ to: "20261004", exclude: [], limit: 50 });
    expect(list).toStrictEqual([
      { raceId: "A2", kaisaiDate: "20261003" },
      { raceId: "B2", kaisaiDate: "20261003" },
    ]);
  });

  it("新しい日が尽きれば(取り込み済み・除外)、次に新しい日に移る", async () => {
    await addAnalysis("N1", "20261003");
    await addAnalysis("O1", "20261001");
    await local.db.prepare("INSERT INTO race_results (race_id, umaban) VALUES ('N1', 1)").run();
    expect(await store().listBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([{ raceId: "O1", kaisaiDate: "20261001" }]);
    await addAnalysis("N2", "20261003");
    expect((await store().listBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).map((r) => r.raceId)).toEqual(["N2"]);
    expect(await store().listBackfillRaces({ to: "20261004", exclude: ["N2"], limit: 50 })).toStrictEqual([{ raceId: "O1", kaisaiDate: "20261001" }]);
  });

  it("除外のレースは返さない。同じレースを複数回分析していても 1 件。limit で切る(レースID 昇順)", async () => {
    await addAnalysis("R1", "20261003", 1);
    await addAnalysis("R1", "20261003", 2);
    await addAnalysis("R2", "20261003");
    await addAnalysis("R3", "20261003");
    await addAnalysis("R4", "20261003");
    expect((await store().listBackfillRaces({ to: "20261003", exclude: [], limit: 50 })).map((r) => r.raceId)).toEqual(["R1", "R2", "R3", "R4"]);
    expect((await store().listBackfillRaces({ to: "20261003", exclude: ["R2"], limit: 50 })).map((r) => r.raceId)).toEqual(["R1", "R3", "R4"]);
    expect((await store().listBackfillRaces({ to: "20261003", exclude: [], limit: 2 })).map((r) => r.raceId)).toEqual(["R1", "R2"]);
  });

  it("除外が多数(500 件)でも動く(JSON 1 つの束縛)。未取込が無ければ空", async () => {
    await addAnalysis("KEEP", "20261003");
    const exclude = Array.from({ length: 500 }, (_, i) => `X${String(i).padStart(4, "0")}`);
    expect((await store().listBackfillRaces({ to: "20261003", exclude, limit: 50 })).map((r) => r.raceId)).toEqual(["KEEP"]);
    expect(await store().listBackfillRaces({ to: "20261003", exclude: ["KEEP"], limit: 50 })).toStrictEqual([]);
  });

  it("開催日が分かれている同じレース(MIN を採る)は、最小の開催日の日に属する", async () => {
    await addAnalysis("SPLIT", "20261003", 1);
    await addAnalysis("SPLIT", "20261002", 2);
    await addAnalysis("OTHER", "20261003");
    expect(await store().listBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([{ raceId: "OTHER", kaisaiDate: "20261003" }]);
  });

  it("入力の検証: to が YYYYMMDD でない・limit が 1〜上限の整数でない・exclude が配列でないと RangeError(D1 には発行しない)", async () => {
    const s = store();
    for (const bad of [
      { to: "2026-10-04", exclude: [], limit: 5 },
      { to: "20261004", exclude: [], limit: 0 },
      { to: "20261004", exclude: [], limit: UNIMPORTED_MAX_LIMIT + 1 },
      { to: "20261004", exclude: [], limit: 1.5 },
      { to: "20261004", exclude: "x" as unknown as string[], limit: 5 },
    ]) {
      await expect(s.listBackfillRaces(bad)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(s.listBackfillRaces({ to: "20261004", exclude: [], limit: UNIMPORTED_MAX_LIMIT })).resolves.toEqual([]); // 境界は通る
  });

  it("SQL は NOT EXISTS で判定する(COUNT(finish_position) ではない)・NULL の開催日は比較に入らない", () => {
    expect(LIST_BACKFILL_SQL).toContain("NOT EXISTS (SELECT 1 FROM race_results");
    expect(LIST_BACKFILL_SQL).not.toContain("COUNT(finish_position)");
  });
});

describe("countBackfill: 残り(開催日あり・to 以前・除外を除く)と、開催日不明の数", () => {
  it("dated は to 以前の未取込のレース数(除外・取り込み済みを除く)、undated は開催日がすべて NULL の未取込のレース数", async () => {
    await addAnalysis("D1", "20261003");
    await addAnalysis("D1", "20261003", 1); // 同じレースの重複は 1
    await addAnalysis("D2", "20261001");
    await addAnalysis("D3", "20261002"); // 除外
    await addAnalysis("FUT", "20261005"); // to の後(数えない)
    await addAnalysis("DONE", "20261001");
    await local.db.prepare("INSERT INTO race_results (race_id, umaban) VALUES ('DONE', 1)").run();
    await addAnalysis("U1", null);
    await addAnalysis("U1", null, 1);
    await addAnalysis("U2", null);
    await addAnalysis("MIX", null, 1); // 一部だけ NULL → 日付のある側で dated に数える(undated ではない)
    await addAnalysis("MIX", "20261001", 2);
    await addAnalysis("UDONE", null);
    await local.db.prepare("INSERT INTO race_results (race_id, umaban) VALUES ('UDONE', 1)").run();
    const counts = await store().countBackfill({ to: "20261004", exclude: ["D3"] });
    expect(counts).toStrictEqual({ dated: 3, undated: 2 }); // dated = D1, D2, MIX / undated = U1, U2
  });

  it("何も無ければ 0 と 0(SUM が NULL にならない)", async () => {
    expect(await store().countBackfill({ to: "20261004", exclude: [] })).toStrictEqual({ dated: 0, undated: 0 });
  });
});
