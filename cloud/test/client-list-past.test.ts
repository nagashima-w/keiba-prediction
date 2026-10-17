import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import { hasStarted } from "../client/bulk";
import { buildListModel, needsListClock, type ListModelInput } from "../client/list";
import { parseHash } from "../client/route";

/**
 * Issue #346: 一覧(場ごとの折りたたみの中)で、発走済みのレースを下へ回して薄く出す(モデル。純関数)。
 * 守ること: 今日(JST)の開催日のときだけ。場の中で、未発走(時刻不明を含む)がレース番号順で上・発走済みがレース番号順で下。
 * 並べ替えるのは表示用の `races` だけ(要約・一括実行は元の順=R 順のまま数える)。判定は一括実行(`hasStarted`)と共通で、時計の補正はしない。
 */

const DATE = "20260628";
const NOW = new Date("2026-06-28T05:00:00Z"); // JST 14:00
const ROUTE = parseHash(`#date=${DATE}&venue=central`, DATE);

function race(raceId: string, venueName: string, n: number, startTime: string | null): RaceRow {
  return { raceId, venueName, raceNumber: n, raceName: `R${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime };
}

// 福島 6 レース。時刻は R1 10:00(発走済み)・R2 不明・R3 13:59(発走済み)・R4 14:00(ちょうど=発走済み)・R5 14:01(未発走)・R6 15:00(未発走)
const FUKUSHIMA: RaceRow[] = [
  race("202602020101", "福島", 1, "10:00"),
  race("202602020102", "福島", 2, null),
  race("202602020103", "福島", 3, "13:59"),
  race("202602020104", "福島", 4, "14:00"),
  race("202602020105", "福島", 5, "14:01"),
  race("202602020106", "福島", 6, "15:00"),
];

function model(races: readonly RaceRow[], over: Partial<ListModelInput> = {}) {
  return buildListModel({ route: ROUTE, list: { kind: "ready", races }, board: { kind: "none" }, now: NOW, ...over });
}
const labels = (m: ReturnType<typeof model>, group = 0): string[] => m.groups[group]!.races.map((r) => r.label);
const pasts = (m: ReturnType<typeof model>, group = 0): boolean[] => m.groups[group]!.races.map((r) => r.past);

describe("hasStarted(一括実行と一覧の共通の判定)", () => {
  it.each([
    ["今日・発走時刻が現在より前", "13:59", true, "14:00", true],
    ["今日・ちょうど現在(発走済みに含める)", "14:00", true, "14:00", true],
    ["今日・現在の 1 分後", "14:01", true, "14:00", false],
    ["今日・時刻不明は発走済みとしない", null, true, "14:00", false],
    ["今日でない開催日は、時刻が過ぎていても発走済みとしない", "10:00", false, "14:00", false],
  ])("%s", (_name, startTime, today, hm, expected) => {
    expect(hasStarted(startTime, today, hm)).toBe(expected);
  });
});

describe("buildListModel: 発走済みを下へ回す(Issue #346)", () => {
  it("今日: 未発走(時刻不明を含む)が R 順で上、発走済みが R 順で下。past はその区分", () => {
    const m = model(FUKUSHIMA);
    expect(m.groups).toHaveLength(1); // 前提: 1 つの場
    expect(labels(m)).toEqual(["2R", "5R", "6R", "1R", "3R", "4R"]);
    expect(pasts(m)).toEqual([false, false, false, true, true, true]);
  });

  it("前提の固定: 入力は R 昇順で、並べ替え前は先頭が発走済み(1R)。並べ替えが実際に起きている", () => {
    const m = model(FUKUSHIMA, { now: undefined });
    expect(labels(m)).toEqual(["1R", "2R", "3R", "4R", "5R", "6R"]);
    expect(labels(model(FUKUSHIMA))[0]).not.toBe(labels(m)[0]);
  });

  it("now を渡さない(省略)と並べ替えず、past は全部 false", () => {
    const m = model(FUKUSHIMA, { now: undefined });
    expect(pasts(m)).toEqual([false, false, false, false, false, false]);
  });

  it.each([
    ["過去の開催日", "20260627"],
    ["未来の開催日", "20260629"],
  ])("%s: 今の並びのまま・薄くしない(発走時刻が過ぎていても)", (_name, date) => {
    const route = parseHash(`#date=${date}&venue=central`, date);
    const m = model(FUKUSHIMA, { route });
    expect(labels(m)).toEqual(["1R", "2R", "3R", "4R", "5R", "6R"]);
    expect(pasts(m)).toEqual([false, false, false, false, false, false]);
    // 前提: 同じ入力で今日なら 3 件が発走済み=日付の条件だけが差(空振りにしない)
    expect(pasts(model(FUKUSHIMA)).filter((p) => p)).toHaveLength(3);
  });

  it("時刻が全部不明なら、並べ替えず薄くもしない", () => {
    const m = model(FUKUSHIMA.map((r) => ({ ...r, startTime: null })));
    expect(labels(m)).toEqual(["1R", "2R", "3R", "4R", "5R", "6R"]);
    expect(pasts(m)).toEqual([false, false, false, false, false, false]);
  });

  it("全部が発走済みなら、今の並び(R 昇順)と同じで、全部が past(最後の切り替わりで跳ねない)", () => {
    const m = model(FUKUSHIMA.map((r) => ({ ...r, startTime: "09:00" })));
    expect(labels(m)).toEqual(["1R", "2R", "3R", "4R", "5R", "6R"]);
    expect(pasts(m)).toEqual([true, true, true, true, true, true]);
  });

  it("場ごとに独立して並べる(別の場の発走済みの数に影響されない)。同じ場の中で R 順は安定", () => {
    const races = [...FUKUSHIMA, race("202605020101", "東京", 1, "15:00"), race("202605020102", "東京", 2, "09:00"), race("202605020103", "東京", 3, "16:00")];
    const m = model(races);
    expect(m.groups.map((g) => g.name)).toEqual(["福島", "東京"]); // 前提: 2 つの場
    expect(labels(m, 0)).toEqual(["2R", "5R", "6R", "1R", "3R", "4R"]);
    expect(labels(m, 1)).toEqual(["1R", "3R", "2R"]);
    expect(pasts(m, 1)).toEqual([false, false, true]);
  });

  it("閲覧者(readOnly)も同じに並ぶ", () => {
    const m = model(FUKUSHIMA, { readOnly: true });
    expect(labels(m)).toEqual(["2R", "5R", "6R", "1R", "3R", "4R"]);
  });

  it("並べ替えるのは表示用の races だけ。要約・一括実行は元の順(R 順)のまま数える=now の有無で変わらない", () => {
    const board = { kind: "ready", rows: [{ raceId: "202602020103", mode: "pre_race", status: "failed", attempts: 1, error: "x", queuedAt: 1, updatedAt: 2, prior: false, analysisId: null }] } as const;
    const bulk = { now: NOW, states: new Map() };
    const withNow = model(FUKUSHIMA, { board, bulk });
    const withoutNow = model(FUKUSHIMA, { board, bulk, now: undefined });
    expect(labels(withNow)).not.toEqual(labels(withoutNow)); // 前提: 並びは違う
    expect(withNow.groups[0]!.bulk).not.toBeNull(); // 前提: 管理者は bulk を持つ
    expect(withNow.groups[0]!.bulk).toEqual(withoutNow.groups[0]!.bulk);
    expect(withNow.groups[0]!.summary).toEqual(withoutNow.groups[0]!.summary);
    expect(withNow.groups[0]!.summary?.failed).toBe(1);
  });

  it("開閉の状態・キーは並べ替えの影響を受けない", () => {
    const a = model(FUKUSHIMA);
    const b = model(FUKUSHIMA, { now: undefined });
    expect(a.groups.map((g) => [g.key, g.open, g.name])).toEqual(b.groups.map((g) => [g.key, g.open, g.name]));
  });
});

describe("needsListClock(並べ替えの再描画のタイマーが要るか)", () => {
  it("今日で、時刻があり未発走のレースが 1 つでもあれば true", () => {
    expect(needsListClock(FUKUSHIMA, DATE, NOW)).toBe(true);
  });
  it("今日でも、全部が発走済みなら false(これ以上並びが変わらない)", () => {
    expect(needsListClock(FUKUSHIMA.map((r) => ({ ...r, startTime: "09:00" })), DATE, NOW)).toBe(false);
  });
  it("今日でも、時刻が全部不明なら false(並びが変わらない)", () => {
    expect(needsListClock(FUKUSHIMA.map((r) => ({ ...r, startTime: null })), DATE, NOW)).toBe(false);
  });
  it("今日でない開催日・空の一覧は false", () => {
    expect(needsListClock(FUKUSHIMA, "20260629", NOW)).toBe(false);
    expect(needsListClock(FUKUSHIMA, "20260627", NOW)).toBe(false);
    expect(needsListClock([], DATE, NOW)).toBe(false);
  });
});
