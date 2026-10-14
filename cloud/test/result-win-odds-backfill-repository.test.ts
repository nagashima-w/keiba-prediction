import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1ResultStore, UNIMPORTED_MAX_LIMIT } from "../src/result-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #259(前半): 結果の補完の段階 2 の列挙・集計(`listWinOddsBackfillRaces`・`countWinOddsBackfill`)を、ローカル(workerd)の D1 で確かめる。
 * 段階 1(`listBackfillRaces`)が「分析済みで結果の行が 1 件も無い」レースなのに対し、段階 2 は逆に
 * 「分析済みで、結果の行はあるが、確定の単勝オッズ(`win_odds`)が 1 頭も入っていない」レース。それ以外(新しい日を 1 日だけ・レースID 昇順・除外・開催日の扱い)は段階 1 と同じ。
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

/** 結果の行を入れる。odds は馬ごとの win_odds(省略・null は NULL)。 */
async function addResult(raceId: string, odds: ReadonlyArray<number | null> = [null, null]): Promise<void> {
  for (const [i, o] of odds.entries()) {
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds) VALUES (?, ?, ?, ?)").bind(raceId, i + 1, i + 1, o).run();
  }
}

describe("listWinOddsBackfillRaces: 結果はあるがオッズが 1 頭も無いレースの、最も新しい日(to 以前)", () => {
  it("結果の行があり win_odds が全頭 NULL のレースだけを返す。結果の無いレース(段階 1 の対象)・オッズのあるレース・to より後・開催日 NULL は返さない", async () => {
    await addAnalysis("NEED2", "20261003");
    await addAnalysis("NEED1", "20261003");
    await addAnalysis("NORESULT", "20261003"); // 結果が無い = 段階 1 の対象
    await addAnalysis("HASODDS", "20261003");
    await addAnalysis("AFTER", "20261005");
    await addAnalysis("NULLDATE", null);
    await addResult("NEED2");
    await addResult("NEED1");
    await addResult("HASODDS", [3.4, 5.6]);
    await addResult("AFTER");
    await addResult("NULLDATE");
    expect(await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([
      { raceId: "NEED1", kaisaiDate: "20261003" },
      { raceId: "NEED2", kaisaiDate: "20261003" },
    ]);
  });

  it("1 頭でもオッズがあれば対象外(除外の馬が NULL のままのレースを、毎晩列挙し直さない)", async () => {
    await addAnalysis("PARTIAL", "20261003");
    await addResult("PARTIAL", [4.5, null, 8.0]);
    await addAnalysis("EMPTY", "20261003");
    await addResult("EMPTY", [null, null, null]);
    expect((await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).map((r) => r.raceId)).toEqual(["EMPTY"]);
  });

  it("新しい日が尽きれば(オッズが入った・除外)、次に新しい日に移る。除外のレースは返さない。limit で切る", async () => {
    await addAnalysis("N1", "20261003");
    await addResult("N1");
    await addAnalysis("O1", "20261001");
    await addResult("O1");
    expect((await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).map((r) => r.raceId)).toEqual(["N1"]);
    expect((await store().listWinOddsBackfillRaces({ to: "20261004", exclude: ["N1"], limit: 50 })).map((r) => r.raceId)).toEqual(["O1"]);
    await local.db.prepare("UPDATE race_results SET win_odds = 2.0 WHERE race_id = 'N1' AND umaban = 1").run();
    expect((await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).map((r) => r.raceId)).toEqual(["O1"]);
    await addAnalysis("O2", "20261001");
    await addResult("O2");
    expect((await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 1 })).map((r) => r.raceId)).toEqual(["O1"]);
  });

  it("同じレースを複数回分析していても 1 件。開催日が分かれていれば最小の日に属する", async () => {
    await addAnalysis("SPLIT", "20261003", 1);
    await addAnalysis("SPLIT", "20261002", 2);
    await addAnalysis("OTHER", "20261003");
    await addResult("SPLIT");
    await addResult("OTHER");
    expect(await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toStrictEqual([{ raceId: "OTHER", kaisaiDate: "20261003" }]);
  });

  it("入力の検証は段階 1 と同じ(to が YYYYMMDD・limit が 1〜上限の整数・exclude が配列)", async () => {
    const s = store();
    for (const bad of [
      { to: "2026-10-04", exclude: [], limit: 5 },
      { to: "20261004", exclude: [], limit: 0 },
      { to: "20261004", exclude: [], limit: UNIMPORTED_MAX_LIMIT + 1 },
      { to: "20261004", exclude: "x" as unknown as string[], limit: 5 },
    ]) {
      await expect(s.listWinOddsBackfillRaces(bad)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(s.countWinOddsBackfill({ to: "bad", exclude: [] })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("countWinOddsBackfill: 残り(開催日あり・to 以前・除外を除く)と、開催日不明の数", () => {
  it("dated は to 以前の対象レース数(除外・オッズ済み・結果なしを除く)、undated は開催日がすべて NULL の対象レース数", async () => {
    await addAnalysis("D1", "20261003");
    await addAnalysis("D1", "20261003", 1); // 重複は 1
    await addAnalysis("D2", "20261001");
    await addAnalysis("D3", "20261002"); // 除外
    await addAnalysis("FUT", "20261005"); // to の後
    await addAnalysis("DONE", "20261001");
    await addAnalysis("NORES", "20261001"); // 結果なし
    await addAnalysis("U1", null);
    await addAnalysis("U1", null, 1);
    await addAnalysis("U2", null);
    for (const id of ["D1", "D2", "D3", "FUT", "U1", "U2"]) await addResult(id);
    await addResult("DONE", [2.0]);
    expect(await store().countWinOddsBackfill({ to: "20261004", exclude: ["D3"] })).toStrictEqual({ dated: 2, undated: 2, scratchedMissing: 0 });
    expect(await store().countWinOddsBackfill({ to: "20261004", exclude: [] })).toStrictEqual({ dated: 3, undated: 2, scratchedMissing: 0 });
  });
});

// ---------------------------------------------------------------------------
// Issue #270: 段階 2 の対象に「着順が NULL で scratched が NULL の行を持つレース」(B)を足す
// ---------------------------------------------------------------------------

/**
 * 結果の行を入れる(Issue #270)。rows は馬ごとの [着順, win_odds, scratched](着順 null は取消・中止など、scratched null は記録なし)。
 */
async function addResultRows(raceId: string, rows: ReadonlyArray<readonly [number | null, number | null, number | null]>): Promise<void> {
  for (const [i, [finish, odds, scratched]] of rows.entries()) {
    await local.db
      .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds, scratched) VALUES (?, ?, ?, ?, ?)")
      .bind(raceId, i + 1, finish, odds, scratched)
      .run();
  }
}

describe("Issue #270 listWinOddsBackfillRaces: オッズが入っていても、着順が NULL で scratched が NULL の行があるレースは対象(B)", () => {
  it("(B) に当たるレースを返す。オッズ済みでも返す。scratched が記録済み(0 も 1 も)のレース・着順が全頭にあるレース・どちらにも当たらないレースは返さない", async () => {
    for (const id of ["B_ODDS", "B_NOODDS", "REC0", "REC1", "ALLFINISH", "NEITHER", "A_ONLY"]) await addAnalysis(id, "20261003");
    await addResultRows("B_ODDS", [[1, 3.4, null], [null, 5.0, null]]); // オッズ済み・着順 NULL・scratched NULL
    await addResultRows("B_NOODDS", [[1, null, null], [null, null, null]]); // (A) と (B) の両方
    await addResultRows("REC0", [[1, 3.4, 0], [null, 5.0, 0]]); // 記録済み(中止)
    await addResultRows("REC1", [[1, 3.4, 0], [null, 5.0, 1]]); // 記録済み(取消)
    await addResultRows("ALLFINISH", [[1, 3.4, null], [2, 5.0, null]]); // 全頭に着順(scratched は NULL のまま=補完しても学ぶことが無い)
    await addResultRows("NEITHER", [[1, 3.4, 0], [2, 5.0, 0]]);
    await addResultRows("A_ONLY", [[1, null, 0], [null, null, 0]]); // オッズが 1 頭も無い (A) だけ
    const listed = (await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).map((r) => r.raceId);
    expect(listed).toEqual(["A_ONLY", "B_NOODDS", "B_ODDS"]);
  });

  it("着順が NULL の行が 1 つでも scratched NULL ならレースごと対象。その行だけが記録済みになれば外れる(他の馬が NULL でも、着順があれば数えない)", async () => {
    await addAnalysis("R1", "20261003");
    await addResultRows("R1", [[1, 3.4, null], [null, 5.0, null]]);
    expect((await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).map((r) => r.raceId)).toEqual(["R1"]);
    await local.db.prepare("UPDATE race_results SET scratched = 1 WHERE race_id = 'R1' AND umaban = 2").run();
    expect(await store().listWinOddsBackfillRaces({ to: "20261004", exclude: [], limit: 50 })).toEqual([]); // 馬 1 は着順ありで NULL のままだが、対象にしない
  });

  it("(B) のレースにも、除外・to・開催日 NULL・最も新しい日 1 日だけ・limit の規則がそのまま効く", async () => {
    await addAnalysis("NEW1", "20261003");
    await addAnalysis("NEW2", "20261003");
    await addAnalysis("OLD1", "20261001");
    await addAnalysis("AFTER", "20261005");
    await addAnalysis("UNDATED", null);
    for (const id of ["NEW1", "NEW2", "OLD1", "AFTER", "UNDATED"]) await addResultRows(id, [[1, 3.4, null], [null, 5.0, null]]);
    const ids = async (opts: { exclude: string[]; limit: number }) => (await store().listWinOddsBackfillRaces({ to: "20261004", ...opts })).map((r) => r.raceId);
    expect(await ids({ exclude: [], limit: 50 })).toEqual(["NEW1", "NEW2"]);
    expect(await ids({ exclude: [], limit: 1 })).toEqual(["NEW1"]);
    expect(await ids({ exclude: ["NEW1", "NEW2"], limit: 50 })).toEqual(["OLD1"]);
  });
});

describe("Issue #270 countWinOddsBackfill: scratched が欠けて対象になるレースの数(scratchedMissing)", () => {
  it("dated は (A) または (B) のレース数。scratchedMissing は、そのうち (B) に当たるレース数(オッズも欠けている両方のレースを含む)。除外は両方から除く", async () => {
    for (const id of ["A", "B", "AB", "EXCL_B", "FUT_B", "OK"]) await addAnalysis(id, id === "FUT_B" ? "20261005" : "20261003");
    await addAnalysis("U_B", null);
    await addAnalysis("U_A", null);
    await addResultRows("A", [[1, null, 0], [null, null, 0]]); // (A) のみ
    await addResultRows("B", [[1, 3.4, null], [null, 5.0, null]]); // (B) のみ
    await addResultRows("AB", [[1, null, null], [null, null, null]]); // 両方
    await addResultRows("EXCL_B", [[1, 3.4, null], [null, 5.0, null]]); // (B)・除外
    await addResultRows("FUT_B", [[1, 3.4, null], [null, 5.0, null]]); // (B)・to の後
    await addResultRows("OK", [[1, 3.4, 0], [null, 5.0, 0]]);
    await addResultRows("U_B", [[1, 3.4, null], [null, 5.0, null]]); // (B)・開催日 NULL
    await addResultRows("U_A", [[1, null, 0]]); // (A)・開催日 NULL
    expect(await store().countWinOddsBackfill({ to: "20261004", exclude: ["EXCL_B"] })).toStrictEqual({ dated: 3, undated: 2, scratchedMissing: 2 });
    expect(await store().countWinOddsBackfill({ to: "20261004", exclude: [] })).toStrictEqual({ dated: 4, undated: 2, scratchedMissing: 3 });
  });
});
