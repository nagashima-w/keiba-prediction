import { describe, expect, it } from "vitest";
import type { BoardRow, RaceRow } from "../client/api";
import type { BulkUi } from "../client/bulk";
import { buildListModel, groupKeys } from "../client/list";
import { parseHash } from "../client/route";

/**
 * Issue #251: 一覧のモデルに、場ごとの一括実行(`bulk`)を載せる。管理者だけ(閲覧者は null)。場のまとまりごとに、その場のレースだけを対象にする。
 */

const DATE = "20260628";
const NOW = new Date("2026-06-28T05:00:00Z"); // JST 14:00
const ROUTE = parseHash(`#date=${DATE}&venue=central`, DATE);

function race(raceId: string, venueName: string, n: number, startTime: string | null): RaceRow {
  return { raceId, venueName, raceNumber: n, raceName: `R${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime };
}
// 福島 2 レース・東京 3 レース(race_id の昇順で 場コード 02 の福島 → 05 の東京)
const RACES: RaceRow[] = [
  race("202602020101", "福島", 1, "15:00"),
  race("202602020102", "福島", 2, "15:30"),
  race("202605020101", "東京", 1, "15:00"),
  race("202605020102", "東京", 2, "15:30"),
  race("202605020103", "東京", 3, "16:00"),
];

const BOARD_ROWS: BoardRow[] = [];

describe("buildListModel の bulk(Issue #251)", () => {
  it("管理者(readOnly でない)で bulk の入力があれば、場のまとまりごとに bulk を作る。件数はその場のレースだけを数える", () => {
    const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board: { kind: "ready", rows: BOARD_ROWS }, bulk: { now: NOW, states: new Map() } });
    expect(model.groups.map((g) => g.name)).toEqual(["福島", "東京"]); // 前提: 2 つの場
    expect(model.groups[0]!.bulk?.buttons.map((b) => b.count)).toEqual([2, 2]);
    expect(model.groups[1]!.bulk?.buttons.map((b) => b.count)).toEqual([3, 3]);
    expect(model.groups[0]!.bulk?.date).toBe(DATE);
  });

  it("確認画面の見出しには、その場の名前が入る(別の場の状態を取り違えない)。状態は場のまとまりのキーで引く", () => {
    const keys = groupKeys(RACES);
    const ui: BulkUi = { kind: "confirm", mode: "pre_race", raceIds: ["202605020101"], excluded: { running: 0, done: 0, started: 0, timeUnknown: 0 } };
    const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board: { kind: "ready", rows: [] }, bulk: { now: NOW, states: new Map([[keys[1]!, ui]]) } });
    expect(model.groups[0]!.bulk?.panel).toBeNull();
    const panel = model.groups[1]!.bulk?.panel;
    expect(panel).not.toBeNull();
    expect(panel?.kind === "confirm" ? panel.title : "").toBe("東京の発走前の分析を一括実行しますか");
  });

  it("板の行は、その場のレースの対象の選別に使う(実行中のレースは件数から外れる)", () => {
    const board: BoardRow[] = [{ raceId: "202602020101", mode: "morning", status: "queued", attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null }];
    const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board: { kind: "ready", rows: board }, bulk: { now: NOW, states: new Map() } });
    expect(model.groups[0]!.bulk?.buttons.map((b) => b.count)).toEqual([1, 2]);
    expect(model.groups[1]!.bulk?.buttons.map((b) => b.count)).toEqual([3, 3]);
  });

  it("板が取れていない(none・error)ときは、ボタンは無効で理由の注記つき", () => {
    for (const board of [{ kind: "none" }, { kind: "error", message: "x" }] as const) {
      const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board, bulk: { now: NOW, states: new Map() } });
      for (const group of model.groups) {
        expect(group.bulk?.buttons.map((b) => b.disabled)).toEqual([true, true]);
        expect(group.bulk?.note).not.toBeNull();
      }
    }
  });

  it("閲覧者(readOnly)には、bulk の入力があっても bulk を作らない(null)", () => {
    const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board: { kind: "ready", rows: [] }, bulk: { now: NOW, states: new Map() }, readOnly: true });
    expect(model.groups).toHaveLength(2); // 前提
    expect(model.groups.map((g) => g.bulk)).toEqual([null, null]);
  });

  it("bulk の入力が無ければ null(従来どおり)", () => {
    const model = buildListModel({ route: ROUTE, list: { kind: "ready", races: RACES }, board: { kind: "ready", rows: [] } });
    expect(model.groups.map((g) => g.bulk)).toEqual([null, null]);
  });
});
