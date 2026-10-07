import { describe, expect, it } from "vitest";
import type { BoardRow, RaceRow } from "../client/api";
import { badgeOf, buildListModel, buildPendingModel, groupRaces, type ListModelInput } from "../client/list";
import type { Route } from "../client/route";

/** Issue #184: 一覧の画面の表示用データ(純関数)。場ごとのまとまり・R 順・板の (race_id, mode) ごとのバッジ・各状態の表示。 */

function race(raceId: string, over: Partial<RaceRow> = {}): RaceRow {
  return { raceId, venueName: "福島", raceNumber: Number(raceId.slice(-2)), raceName: `レース${raceId.slice(-2)}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, ...over };
}

function row(raceId: string, mode: BoardRow["mode"], status: BoardRow["status"], over: Partial<BoardRow> = {}): BoardRow {
  return { raceId, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null, ...over };
}

const ROUTE: Route = { date: "20260628", venue: "central", race: null, analysis: null };

function input(over: Partial<ListModelInput> = {}): ListModelInput {
  return { route: ROUTE, list: { kind: "ready", races: [] }, board: { kind: "none" }, ...over };
}

describe("groupRaces(場ごと・R 順)", () => {
  it("入力の順が場・R で入り混じっていても、race_id の昇順(場 → R)で、場ごとにまとめる", () => {
    const groups = groupRaces([
      race("202603020212"),
      race("202610020301", { venueName: "函館" }),
      race("202603020211"),
      race("202602010109", { venueName: "函館" }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["函館", "福島", "函館"]);
    // 前提: 場コード順(02 函館・03 福島・10 函館)のため、同じ名前でも race_id の順に並ぶ=グループは3つ(名前だけで合流させない)
    expect(groups.map((g) => g.races.map((r) => r.raceId))).toEqual([["202602010109"], ["202603020211", "202603020212"], ["202610020301"]]);
  });

  it("会場名が null のレースは「会場不明」の組にする", () => {
    const groups = groupRaces([race("202654071210", { venueName: null }), race("202654071211", { venueName: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("会場不明");
    expect(groups[0]!.races).toHaveLength(2);
  });

  it("空は空", () => {
    expect(groupRaces([])).toEqual([]);
  });
});

describe("badgeOf(板の行 → バッジ)", () => {
  const cases: readonly [BoardRow["status"] | undefined, string, string][] = [
    [undefined, "未実行", "none"],
    ["queued", "待ち", "wait"],
    ["fetched", "取得済み", "wait"],
    ["done", "完了", "ok"],
    ["failed", "失敗", "fail"],
  ];
  for (const [status, label, tone] of cases) {
    it(`${status ?? "行なし"} → ${label}`, () => {
      expect(badgeOf(status === undefined ? undefined : row("202603020211", "morning", status))).toEqual({ label, tone });
    });
  }
});

describe("buildListModel", () => {
  it("レースの行: 見出し(R)・レース名・コース距離頭数・グレード・タップ先(race 付きのハッシュ)", () => {
    const model = buildListModel(input({ list: { kind: "ready", races: [race("202603020211", { grade: "Jpn1", courseType: "ダ", distance: 1200, entryCount: 9, raceName: "福島民報杯" })] } }));
    expect(model.groups).toHaveLength(1);
    const r = model.groups[0]!.races[0]!;
    expect(r.label).toBe("11R");
    expect(r.name).toBe("福島民報杯");
    expect(r.detail).toBe("ダ 1200m・9頭");
    expect(r.grade).toBe("Jpn1");
    expect(r.href).toBe("#date=20260628&venue=central&race=202603020211");
  });

  it("グレードが null の行は grade も null(表示しない)", () => {
    const model = buildListModel(input({ list: { kind: "ready", races: [race("202603020211")] } }));
    expect(model.groups[0]!.races[0]!.grade).toBeNull();
  });

  it("バッジは板の (race_id, mode) ごと: 同じレースの morning と pre_race を別々に、別のレースの行を取り違えずに写す", () => {
    const board: BoardRow[] = [
      row("202603020211", "morning", "done"),
      row("202603020211", "pre_race", "failed"),
      row("202603020212", "morning", "queued"),
    ];
    const model = buildListModel(input({ list: { kind: "ready", races: [race("202603020211"), race("202603020212"), race("202603020201")] }, board: { kind: "ready", rows: board } }));
    const byId = new Map(model.groups.flatMap((g) => g.races).map((r) => [r.raceId, r]));
    expect(byId.get("202603020211")!.badges).toEqual({ morning: { label: "完了", tone: "ok" }, preRace: { label: "失敗", tone: "fail" } });
    expect(byId.get("202603020212")!.badges).toEqual({ morning: { label: "待ち", tone: "wait" }, preRace: { label: "未実行", tone: "none" } });
    expect(byId.get("202603020201")!.badges).toEqual({ morning: { label: "未実行", tone: "none" }, preRace: { label: "未実行", tone: "none" } });
  });

  it("板が無い(未取得・失敗)ときはバッジを出さない(badges が null)。失敗なら注記を出す。一覧は表示する", () => {
    const none = buildListModel(input({ list: { kind: "ready", races: [race("202603020211")] }, board: { kind: "none" } }));
    expect(none.groups[0]!.races[0]!.badges).toBeNull();
    expect(none.boardNotice).toBeNull();
    const err = buildListModel(input({ list: { kind: "ready", races: [race("202603020211")] }, board: { kind: "error", message: "板の失敗の文言" } }));
    expect(err.groups[0]!.races[0]!.badges).toBeNull();
    expect(err.boardNotice).toBe("板の失敗の文言");
    expect(err.groups).toHaveLength(1);
  });

  it("読み込み中は loading で、更新ボタンを押せない状態を示す。エラー時は error の文言を持ち、レースは出さない", () => {
    const loading = buildListModel(input({ list: { kind: "loading" } }));
    expect(loading.loading).toBe(true);
    expect(loading.error).toBeNull();
    expect(loading.empty).toBe(false);
    expect(loading.groups).toEqual([]);
    const error = buildListModel(input({ list: { kind: "error", message: "一覧の失敗の文言" } }));
    expect(error.loading).toBe(false);
    expect(error.error).toBe("一覧の失敗の文言");
    expect(error.empty).toBe(false);
    expect(error.groups).toEqual([]);
  });

  it("開催なし(成功の空配列)は empty。レースがあれば empty でない", () => {
    expect(buildListModel(input()).empty).toBe(true);
    expect(buildListModel(input({ list: { kind: "ready", races: [race("202603020211")] } })).empty).toBe(false);
  });

  it("日付(YYYYMMDD と input 用 YYYY-MM-DD)・区分のタブ(現在の区分が current。タップ先は日付を保ち race を持たない)", () => {
    const model = buildListModel(input({ route: { date: "20261003", venue: "nar", race: null, analysis: null } }));
    expect(model.date).toBe("20261003");
    expect(model.dateInput).toBe("2026-10-03");
    expect(model.venue).toBe("nar");
    expect(model.venueTabs).toEqual([
      { venue: "central", label: "中央", href: "#date=20261003&venue=central", current: false },
      { venue: "nar", label: "地方", href: "#date=20261003&venue=nar", current: true },
    ]);
  });
});

describe("buildPendingModel(#185 で作るレース・分析の画面の代わり)", () => {
  it("race のハッシュ: 準備中の文言と、一覧(日付・区分を保つ。race なし)へ戻るリンク", () => {
    const model = buildPendingModel({ date: "20261003", venue: "nar", race: "202654071210", analysis: null });
    expect(model.kind).toBe("pending");
    expect(model.text).toContain("準備中");
    expect(model.backHref).toBe("#date=20261003&venue=nar");
  });
  it("analysis のハッシュも準備中。race と analysis で文言が異なる", () => {
    const race = buildPendingModel({ date: "20261003", venue: "nar", race: "202654071210", analysis: null });
    const analysis = buildPendingModel({ date: "20261003", venue: "nar", race: null, analysis: 5 });
    expect(analysis.text).toContain("準備中");
    expect(analysis.text).not.toBe(race.text);
  });
});
