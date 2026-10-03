import { describe, expect, it } from "vitest";
import type { FinishPosition, RaceResult, RaceResultHorse } from "../../packages/core/src/index.js";
import { classifyFinish, classifyRaceFinishes } from "../probability-quality-41/observation.js";

/**
 * 着順の分類(`docs/investigations/probability-quality-41/measurement-plan.md` §3.1・§3.2・§3.3)。
 * 取消・除外は観測から除く / 中止・失格は 0 として残す / 数値は3以下なら 1 / 未知の文言はレースごと除外。
 */

const rank = (value: number, demoted?: boolean): FinishPosition =>
  demoted === undefined ? { kind: "順位", value } : { kind: "順位", value, demoted };
const text = (t: string): FinishPosition => ({ kind: "非数値", text: t });

describe("classifyFinish", () => {
  const table: ReadonlyArray<{
    readonly name: string;
    readonly finish: FinishPosition | null;
    readonly cls: "placed" | "notPlaced" | "scratched" | "unclassified";
  }> = [
    { name: "1着は3着以内", finish: rank(1), cls: "placed" },
    { name: "3着は3着以内(境界)", finish: rank(3), cls: "placed" },
    { name: "4着は3着以内でない(境界)", finish: rank(4), cls: "notPlaced" },
    { name: "降着で確定着順が5なら3着以内でない", finish: rank(5, true), cls: "notPlaced" },
    { name: "降着で確定着順が3なら3着以内(確定した数値で判定する)", finish: rank(3, true), cls: "placed" },
    { name: "取消は観測から除く", finish: text("取消"), cls: "scratched" },
    { name: "除外は観測から除く", finish: text("除外"), cls: "scratched" },
    { name: "中止は3着以内でない(出走した)", finish: text("中止"), cls: "notPlaced" },
    { name: "失格は3着以内でない(出走した)", finish: text("失格"), cls: "notPlaced" },
    { name: "未知の文言は分類不能(0/1へ割り振らない)", finish: text("競走除外"), cls: "unclassified" },
    { name: "別の未知の文言も分類不能", finish: text("降着"), cls: "unclassified" },
    { name: "着順欄が空(null)は分類不能", finish: null, cls: "unclassified" },
  ];
  it.each(table)("$name", ({ finish, cls }) => {
    expect(classifyFinish(finish).cls).toBe(cls);
  });

  it("結果に載せる文言(元の着順表記)を返す", () => {
    expect(classifyFinish(rank(2)).text).toBe("2");
    expect(classifyFinish(rank(5, true)).text).toBe("5(降)");
    expect(classifyFinish(text("取消")).text).toBe("取消");
    expect(classifyFinish(null).text).toBe("");
  });
});

/** 結果の1頭を作る。 */
function resultHorse(umaban: number, finish: FinishPosition | null): RaceResultHorse {
  return { umaban, finishPosition: finish, horseName: `H${umaban}`, wakuban: 1, passing: [], last3f: null };
}

function result(horses: readonly RaceResultHorse[]): RaceResult {
  return { horses: [...horses], placePayouts: [], winPayouts: [] };
}

describe("classifyRaceFinishes", () => {
  it("通常のレース: 3着以内=1・それ以外=0、取消なし", () => {
    const r = classifyRaceFinishes(
      [1, 2, 3, 4, 5],
      result([resultHorse(3, rank(1)), resultHorse(1, rank(2)), resultHorse(5, rank(3)), resultHorse(2, rank(4)), resultHorse(4, rank(5))]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("前提");
    expect(r.runners.map((x) => [x.umaban, x.outcome])).toEqual([
      [3, 1],
      [1, 1],
      [5, 1],
      [2, 0],
      [4, 0],
    ]);
    expect(r.scratched).toEqual([]);
  });

  it("同着で3着以内が4頭になる場合は全員を1とする(1着・2着・3着同着×2)", () => {
    const r = classifyRaceFinishes(
      [1, 2, 3, 4, 5],
      result([resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(3, rank(3)), resultHorse(4, rank(3)), resultHorse(5, rank(5))]),
    );
    if (!r.ok) throw new Error("前提");
    expect(r.runners.filter((x) => x.outcome === 1)).toHaveLength(4);
    expect(r.runners.find((x) => x.umaban === 5)!.outcome).toBe(0);
  });

  it("取消・除外の馬は観測から除き(出馬表にいる場合は scratched に残す)、中止・失格は0で残す", () => {
    const r = classifyRaceFinishes(
      [1, 2, 3, 4, 5, 6, 7],
      result([
        resultHorse(1, rank(1)),
        resultHorse(2, rank(2)),
        resultHorse(3, rank(3)),
        resultHorse(4, rank(4)),
        resultHorse(5, text("中止")),
        resultHorse(6, text("取消")),
        resultHorse(7, text("除外")),
      ]),
    );
    if (!r.ok) throw new Error("前提");
    expect(r.runners.map((x) => x.umaban)).toEqual([1, 2, 3, 4, 5]);
    expect(r.runners.find((x) => x.umaban === 5)!.outcome).toBe(0);
    expect(r.scratched).toEqual([
      { umaban: 6, text: "取消", inShutuba: true },
      { umaban: 7, text: "除外", inShutuba: true },
    ]);
  });

  it("取消馬が出馬表に残っていない場合も記録する(inShutuba=false)。馬の対応は取れているので除外しない", () => {
    const r = classifyRaceFinishes(
      [1, 2, 3, 4],
      result([resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(3, rank(3)), resultHorse(4, rank(4)), resultHorse(9, text("取消"))]),
    );
    if (!r.ok) throw new Error("前提");
    expect(r.scratched).toEqual([{ umaban: 9, text: "取消", inShutuba: false }]);
    expect(r.runners).toHaveLength(4);
  });

  const failures: ReadonlyArray<{
    readonly name: string;
    readonly starting: readonly number[];
    readonly horses: readonly RaceResultHorse[];
    readonly reason: string;
    readonly detailIncludes: string;
  }> = [
    {
      name: "未知の着順文言を含むレースは、文言と馬番を残して除外する",
      starting: [1, 2, 3, 4],
      horses: [resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(3, rank(3)), resultHorse(4, text("競走除外"))],
      reason: "unclassified-finish",
      detailIncludes: "競走除外",
    },
    {
      name: "着順欄が空の馬を含むレースは除外する",
      starting: [1, 2, 3, 4],
      horses: [resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(3, rank(3)), resultHorse(4, null)],
      reason: "unclassified-finish",
      detailIncludes: "馬番4",
    },
    {
      name: "結果に出走した馬が、出馬表にいない場合は除外する(馬の対応が取れない)",
      starting: [1, 2, 3],
      horses: [resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(3, rank(3)), resultHorse(4, rank(4))],
      reason: "horse-mismatch",
      detailIncludes: "馬番4",
    },
    {
      name: "出馬表にいる馬が、結果に載っていない場合は除外する",
      starting: [1, 2, 3, 4],
      horses: [resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(3, rank(3))],
      reason: "horse-mismatch",
      detailIncludes: "馬番4",
    },
    {
      name: "結果に同じ馬番が2回現れる場合は除外する",
      starting: [1, 2, 3],
      horses: [resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(2, rank(3)), resultHorse(3, rank(4))],
      reason: "horse-mismatch",
      detailIncludes: "馬番2",
    },
    {
      name: "出走頭数が3頭未満のレースは除外する(取消後)",
      starting: [1, 2, 3],
      horses: [resultHorse(1, rank(1)), resultHorse(2, rank(2)), resultHorse(3, text("取消"))],
      reason: "too-few-runners",
      detailIncludes: "2頭",
    },
    {
      name: "3着以内の馬が0頭(全馬が中止など)のレースは除外する",
      starting: [1, 2, 3],
      horses: [resultHorse(1, text("中止")), resultHorse(2, text("中止")), resultHorse(3, text("失格"))],
      reason: "no-placed-horse",
      detailIncludes: "0頭",
    },
  ];
  it.each(failures)("$name", ({ starting, horses, reason, detailIncludes }) => {
    const r = classifyRaceFinishes(starting, result(horses));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("前提");
    expect(r.reason).toBe(reason);
    expect(r.detail).toContain(detailIncludes);
  });
});
