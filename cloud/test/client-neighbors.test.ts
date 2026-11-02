import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import { breadcrumbOf, neighborRaces, neighborsOf } from "../client/neighbors";

/**
 * Issue #571: 前後のレース(`neighborRaces`)・パンくず(`breadcrumbOf`)・前後のリンク(`neighborsOf`)の純関数。
 * 同じ日・同じ競馬場の判定は race_id の先頭 10 桁(中央 `YYYY+場+回次+日次`、地方 `YYYY+場+月日`)。R の数は競馬場でまちまち(地方は 10〜12)なので、R の算術では決めない。
 */

/** 中央: 2026 年・場 05(東京)・3 回 1 日 + R。 */
const tokyo = (r: number): string => `20260503${"01"}${String(r).padStart(2, "0")}`;
/** 中央: 2026 年・場 09(阪神)・2 回 1 日 + R(東京より ID の辞書順が後ろ)。 */
const hanshin = (r: number): string => `20260902${"01"}${String(r).padStart(2, "0")}`;
/** 中央: 2026 年・場 01(札幌)・1 回 1 日 + R(東京より ID の辞書順が前)。 */
const sapporo = (r: number): string => `20260101${"01"}${String(r).padStart(2, "0")}`;
/** 地方: 2026 年・場 44(大井)・7 月 12 日 + R。 */
const ooi = (r: number): string => `2026440712${String(r).padStart(2, "0")}`;
/** 地方: 2026 年・場 45(川崎)・7 月 12 日 + R。 */
const kawasaki = (r: number): string => `2026450712${String(r).padStart(2, "0")}`;

function rows(ids: readonly string[]): RaceRow[] {
  return ids.map((raceId) => ({ raceId, venueName: null, raceNumber: Number(raceId.slice(10)), raceName: `R${raceId.slice(10)}`, courseType: "芝", distance: 1600, entryCount: 16, grade: null, startTime: null }));
}
const range = (make: (r: number) => string, from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => make(from + i));
const idsOf = (n: { prev: RaceRow | null; next: RaceRow | null }) => ({ prev: n.prev?.raceId ?? null, next: n.next?.raceId ?? null });

describe("neighborRaces: 同じ日・同じ競馬場(先頭 10 桁が同じ)の中で、race_id の昇順の隣", () => {
  const cases: readonly { name: string; ids: string[]; at: string; expected: { prev: string | null; next: string | null } }[] = [
    { name: "中間: 前後がある", ids: range(tokyo, 1, 12), at: tokyo(6), expected: { prev: tokyo(5), next: tokyo(7) } },
    { name: "先頭: 前は無く、次がある", ids: range(tokyo, 1, 12), at: tokyo(1), expected: { prev: null, next: tokyo(2) } },
    { name: "末尾: 前があり、次は無い", ids: range(tokyo, 1, 12), at: tokyo(12), expected: { prev: tokyo(11), next: null } },
    { name: "1 レースだけ: 前後とも無い", ids: [tokyo(1)], at: tokyo(1), expected: { prev: null, next: null } },
    { name: "rows に無い race_id: 前後とも無い", ids: range(tokyo, 1, 12), at: tokyo(13), expected: { prev: null, next: null } },
    { name: "rows が空: 前後とも無い", ids: [], at: tokyo(5), expected: { prev: null, next: null } },
    { name: "欠番(R3 が無い): R の算術ではなく、いる隣を返す", ids: [tokyo(1), tokyo(2), tokyo(4), tokyo(5)], at: tokyo(4), expected: { prev: tokyo(2), next: tokyo(5) } },
    { name: "未整列の rows でも、昇順の隣を返す", ids: [tokyo(9), tokyo(3), tokyo(12), tokyo(1), tokyo(7), tokyo(2)], at: tokyo(7), expected: { prev: tokyo(3), next: tokyo(9) } },
    // 同じ日に別の競馬場が混ざる(中央は 3 場開催が普通)。第 2 場の 1R の前が、第 1 場の最終 R にならない。
    { name: "別の競馬場が後ろに混在: 第 1 場の最終 R の次が、第 2 場の 1R にならない", ids: [...range(tokyo, 1, 12), ...range(hanshin, 1, 12)], at: tokyo(12), expected: { prev: tokyo(11), next: null } },
    { name: "別の競馬場が後ろに混在: 第 2 場の 1R の前が、第 1 場の最終 R にならない", ids: [...range(tokyo, 1, 12), ...range(hanshin, 1, 12)], at: hanshin(1), expected: { prev: null, next: hanshin(2) } },
    { name: "別の競馬場が前に混在: 第 2 場の 1R の前が、前の場の最終 R にならない", ids: [...range(sapporo, 1, 12), ...range(tokyo, 1, 12)], at: tokyo(1), expected: { prev: null, next: tokyo(2) } },
    { name: "3 場が未整列で混在: 中間の場の中だけで隣を決める", ids: [...range(hanshin, 1, 3), ...range(sapporo, 1, 3), ...range(tokyo, 1, 3)], at: tokyo(2), expected: { prev: tokyo(1), next: tokyo(3) } },
    // 地方: R 数が競馬場ごとにまちまち(10〜12)。ID は YYYY+場+月日+R。
    { name: "地方: 大井(10R まで)の最終 R の次が、川崎の 1R にならない", ids: [...range(ooi, 1, 10), ...range(kawasaki, 1, 12)], at: ooi(10), expected: { prev: ooi(9), next: null } },
    { name: "地方: 川崎の 1R の前が、大井の最終 R にならない", ids: [...range(ooi, 1, 10), ...range(kawasaki, 1, 12)], at: kawasaki(1), expected: { prev: null, next: kawasaki(2) } },
    { name: "地方: 川崎の中間", ids: [...range(ooi, 1, 10), ...range(kawasaki, 1, 12)], at: kawasaki(11), expected: { prev: kawasaki(10), next: kawasaki(12) } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      // 前提: テーブルの入力が、実際に「その競馬場の中」を検査する形になっている(混在のケースは別の競馬場の行を持つ)
      if (c.name.includes("混在")) expect(new Set(c.ids.map((id) => id.slice(0, 10))).size, "前提: 2 つ以上の競馬場が混在").toBeGreaterThanOrEqual(2);
      expect(idsOf(neighborRaces(rows(c.ids), c.at))).toEqual(c.expected);
    });
  }

  it("返すのは rows の要素そのもの(ラベル用に raceNumber などをそのまま使える)", () => {
    const list = rows(range(tokyo, 1, 3));
    const n = neighborRaces(list, tokyo(2));
    expect(n.prev).toBe(list[0]);
    expect(n.next).toBe(list[2]);
  });

  it("venueName が null でも同一判定に使わない(null どうしを同じ競馬場とみなさない)", () => {
    const list = rows([...range(tokyo, 1, 2), ...range(hanshin, 1, 2)]);
    expect(list.every((r) => r.venueName === null), "前提: 全行の競馬場名が null").toBe(true);
    expect(idsOf(neighborRaces(list, tokyo(2)))).toEqual({ prev: tokyo(1), next: null });
  });
});

describe("breadcrumbOf: 一覧 › 日付 › 競馬場 › R", () => {
  it("中央: 一覧(#)・日付(その日の一覧へ)・競馬場(リンクなし)・R(現在地)", () => {
    expect(breadcrumbOf({ date: "20261103", venue: "central", venueName: "東京", raceId: tokyo(11) })).toEqual([
      { label: "一覧", href: "#", current: false },
      { label: "11/3(火)", href: "#date=20261103&venue=central", current: false },
      { label: "東京", href: null, current: false },
      { label: "11R", href: null, current: true },
    ]);
  });

  it("地方: 日付のリンクは nar の一覧へ。R は race_id の末尾 2 桁(先頭の 0 を落とす)", () => {
    const crumbs = breadcrumbOf({ date: "20260712", venue: "nar", venueName: "大井", raceId: ooi(5) });
    expect(crumbs.map((c) => c.label)).toEqual(["一覧", "7/12(日)", "大井", "5R"]);
    expect(crumbs[1]!.href).toBe("#date=20260712&venue=nar");
  });

  it("競馬場名が無い(null)ときは競馬場の節を省く", () => {
    const crumbs = breadcrumbOf({ date: "20261103", venue: "central", venueName: null, raceId: tokyo(11) });
    expect(crumbs.map((c) => c.label)).toEqual(["一覧", "11/3(火)", "11R"]);
  });

  it("現在地(current)は R の 1 つだけ。リンクを持つのは一覧と日付だけ", () => {
    const crumbs = breadcrumbOf({ date: "20261103", venue: "central", venueName: "東京", raceId: tokyo(11) });
    expect(crumbs.filter((c) => c.current).map((c) => c.label)).toEqual(["11R"]);
    expect(crumbs.filter((c) => c.href !== null).map((c) => c.label)).toEqual(["一覧", "11/3(火)"]);
  });

  it("race_id が 12 桁でない(結果画面の不正な値)ときは R の節を省く", () => {
    const crumbs = breadcrumbOf({ date: "20261103", venue: "central", venueName: "東京", raceId: "abc" });
    expect(crumbs.map((c) => c.label)).toEqual(["一覧", "11/3(火)", "東京"]);
  });
});

describe("neighborsOf: 前後のリンク(前後のレースのレース画面へ)", () => {
  it("前後があれば、ラベル「前のレース 10R」「次のレース 12R」と、レース画面のハッシュ", () => {
    const n = neighborsOf(rows(range(tokyo, 1, 12)), "20261103", "central", tokyo(11));
    expect(n).toEqual({
      prev: { label: "前のレース 10R", href: `#date=20261103&venue=central&race=${tokyo(10)}` },
      next: { label: "次のレース 12R", href: `#date=20261103&venue=central&race=${tokyo(12)}` },
    });
  });

  it("端では、その側を出さない(null)", () => {
    expect(neighborsOf(rows(range(tokyo, 1, 12)), "20261103", "central", tokyo(1))?.prev).toBeNull();
    expect(neighborsOf(rows(range(tokyo, 1, 12)), "20261103", "central", tokyo(12))?.next).toBeNull();
  });

  it("地方: 区分は nar のまま、行き先に出る", () => {
    const n = neighborsOf(rows(range(ooi, 1, 10)), "20260712", "nar", ooi(5));
    expect(n?.prev?.href).toBe(`#date=20260712&venue=nar&race=${ooi(4)}`);
    expect(n?.next?.label).toBe("次のレース 6R");
  });

  it("一覧が無い(undefined)・rows に無い・1 レースだけ(前後とも無い)ときは null(nav ごと出さない)", () => {
    expect(neighborsOf(undefined, "20261103", "central", tokyo(11))).toBeNull();
    expect(neighborsOf(rows(range(tokyo, 1, 12)), "20261103", "central", tokyo(13))).toBeNull();
    expect(neighborsOf(rows([tokyo(1)]), "20261103", "central", tokyo(1))).toBeNull();
  });
});
