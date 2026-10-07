import { describe, expect, it } from "vitest";
import type { BoardRow, RaceRow } from "../client/api";
import { badgeOf, buildListModel, groupKeys, groupRaces, summarizeGroup, type ListModelInput } from "../client/list";
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
    // Issue #186 段階1(#184 の【記録】3): 何の失敗かが分かるよう、失敗の文言の前に「実行状態を取得できなかった」ことを付ける(旧版は文言そのまま)
    expect(err.boardNotice).toBe("実行状態(バッジ)を取得できませんでした。板の失敗の文言");
    expect(err.groups).toHaveLength(1);
  });

  it("板を取得中なら、一覧が取得済みでも loading(更新ボタンを押せない)。一覧の表示・注記は変わらない(Issue #186 段階1)", () => {
    const ready = { kind: "ready", races: [race("202603020211")] } as const;
    const idle = buildListModel(input({ list: ready, board: { kind: "none" } }));
    expect(idle.loading).toBe(false); // 前提: 板を取得中でなければ、一覧が取得済みなら loading でない
    const boardLoading = buildListModel(input({ list: ready, board: { kind: "none" }, boardLoading: true }));
    expect(boardLoading.loading).toBe(true);
    expect(boardLoading.error).toBeNull();
    expect(boardLoading.boardNotice).toBeNull();
    expect(boardLoading.empty).toBe(false);
    expect(boardLoading.groups).toHaveLength(1);
    // 一覧を取得中なら、板を取得中でなくても loading(従来どおり)
    expect(buildListModel(input({ list: { kind: "loading" }, boardLoading: false })).loading).toBe(true);
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

/** Issue #187: 場ごとの開閉(既定・利用者の選択)と、見出しの要約(レース単位の数え方)。 */
describe("場の開閉(既定と利用者の選択)", () => {
  const FUKUSHIMA = [race("202603020211"), race("202603020212")];
  const HAKODATE = [race("202602010101", { venueName: "函館" }), race("202602010102", { venueName: "函館" })];

  it("前提: 1 場なら 1 組・2 場なら 2 組にまとまる(既定の判定の入力が成り立つ)", () => {
    expect(buildListModel(input({ list: { kind: "ready", races: FUKUSHIMA } })).groups).toHaveLength(1);
    expect(buildListModel(input({ list: { kind: "ready", races: [...FUKUSHIMA, ...HAKODATE] } })).groups).toHaveLength(2);
  });

  it("既定: 場が 1 つなら開く・2 つ以上なら全部閉じる", () => {
    const one = buildListModel(input({ list: { kind: "ready", races: FUKUSHIMA } }));
    expect(one.groups.map((g) => g.open)).toEqual([true]);
    const two = buildListModel(input({ list: { kind: "ready", races: [...FUKUSHIMA, ...HAKODATE] } }));
    expect(two.groups).toHaveLength(2);
    expect(two.groups.map((g) => g.open)).toEqual([false, false]);
    const three = buildListModel(input({ list: { kind: "ready", races: [...FUKUSHIMA, ...HAKODATE, race("202610020301", { venueName: "東京" })] } }));
    expect(three.groups.map((g) => g.open)).toEqual([false, false, false]);
  });

  it("利用者が押した値だけが既定を上書きする(その場だけ。押していない場は既定のまま)", () => {
    const races = [...FUKUSHIMA, ...HAKODATE];
    const keys = groupKeys(races);
    expect(keys).toHaveLength(2);
    const opened = buildListModel(input({ list: { kind: "ready", races }, choices: new Map([[keys[1]!, true]]) }));
    expect(opened.groups.map((g) => g.open)).toEqual([false, true]);
    const single = buildListModel(input({ list: { kind: "ready", races: FUKUSHIMA }, choices: new Map([[groupKeys(FUKUSHIMA)[0]!, false]]) }));
    expect(single.groups.map((g) => g.open)).toEqual([false]); // 1 場でも、閉じる選択は尊重する
  });

  it("閉じた場も races を持つ(隠すのは描画の側。要約・件数の元になる)", () => {
    const model = buildListModel(input({ list: { kind: "ready", races: [...FUKUSHIMA, ...HAKODATE] } }));
    expect(model.groups.map((g) => g.open)).toEqual([false, false]);
    expect(model.groups.map((g) => g.races.length)).toEqual([2, 2]);
  });

  it("キーは「場名 + 同名の出現順」: 離れた同名の 2 組は別のキーになり、互いの開閉に連動しない", () => {
    const races = [race("202602010109", { venueName: "函館" }), race("202603020211"), race("202610020301", { venueName: "函館" })];
    const keys = groupKeys(races);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    const model = buildListModel(input({ list: { kind: "ready", races }, choices: new Map([[keys[0]!, true]]) }));
    expect(model.groups.map((g) => g.name)).toEqual(["函館", "福島", "函館"]);
    expect(model.groups.map((g) => g.key)).toEqual(keys);
    expect(model.groups.map((g) => g.open)).toEqual([true, false, false]);
  });

  it("グループの key は groupKeys と一致する(app の保存と描画が同じキーを使う)", () => {
    const races = [...FUKUSHIMA, ...HAKODATE];
    expect(buildListModel(input({ list: { kind: "ready", races } })).groups.map((g) => g.key)).toEqual(groupKeys(races));
  });

  it("読み込み中・エラー・空は、グループなし(選択があっても何も出さない)", () => {
    const choices = new Map([["福島#0", true]]);
    expect(buildListModel(input({ list: { kind: "loading" }, choices })).groups).toEqual([]);
    expect(buildListModel(input({ list: { kind: "error", message: "x" }, choices })).groups).toEqual([]);
    expect(buildListModel(input({ choices })).groups).toEqual([]);
  });
});

describe("見出しの要約(summarizeGroup。レース単位)", () => {
  const R1 = race("202603020201");
  const R2 = race("202603020202");
  const R3 = race("202603020203");
  const ready = (rows: BoardRow[]) => ({ kind: "ready", rows }) as const;

  it("板が無い(none・error)なら null(件数だけ出す)", () => {
    expect(summarizeGroup([R1], { kind: "none" })).toBeNull();
    expect(summarizeGroup([R1], { kind: "error", message: "x" })).toBeNull();
  });

  const cases: readonly { name: string; rows: BoardRow[]; running: number; failed: number }[] = [
    { name: "板の行なし(全部未実行)は 0・0", rows: [], running: 0, failed: 0 },
    { name: "完了だけは 0・0", rows: [row(R1.raceId, "morning", "done")], running: 0, failed: 0 },
    { name: "待ち(queued)は実行中", rows: [row(R1.raceId, "morning", "queued")], running: 1, failed: 0 },
    { name: "取得済み(fetched)は実行中", rows: [row(R1.raceId, "pre_race", "fetched")], running: 1, failed: 0 },
    { name: "失敗(failed)は失敗", rows: [row(R1.raceId, "morning", "failed")], running: 0, failed: 1 },
    {
      name: "同じレースの 2 モードがどちらも実行中でも、レースは 1 つと数える(行数ではない)",
      rows: [row(R1.raceId, "morning", "queued"), row(R1.raceId, "pre_race", "fetched")],
      running: 1,
      failed: 0,
    },
    {
      name: "同じレースの 2 モードがどちらも失敗でも、レースは 1 つ",
      rows: [row(R1.raceId, "morning", "failed"), row(R1.raceId, "pre_race", "failed")],
      running: 0,
      failed: 1,
    },
    {
      name: "朝が失敗・発走前が待ちのレースは、実行中にも失敗にも 1 つずつ数える(両方に入る)",
      rows: [row(R1.raceId, "morning", "failed"), row(R1.raceId, "pre_race", "queued")],
      running: 1,
      failed: 1,
    },
    {
      name: "別のレースの行を取り違えない(R1 実行中・R2 失敗・R3 完了)",
      rows: [row(R1.raceId, "morning", "queued"), row(R2.raceId, "pre_race", "failed"), row(R3.raceId, "morning", "done")],
      running: 1,
      failed: 1,
    },
    {
      name: "この場に無いレースの行は数えない",
      rows: [row("202610020301", "morning", "queued"), row("202610020301", "pre_race", "failed")],
      running: 0,
      failed: 0,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(summarizeGroup([R1, R2, R3], ready(c.rows))).toEqual({ running: c.running, failed: c.failed });
    });
  }

  it("buildListModel の各グループは、自分の場のレースだけで要約する(別の場の状態を混ぜない)", () => {
    const hako = race("202602010101", { venueName: "函館" });
    const model = buildListModel(
      input({ list: { kind: "ready", races: [R1, R2, hako] }, board: ready([row(R1.raceId, "morning", "queued"), row(hako.raceId, "morning", "failed")]) }),
    );
    expect(model.groups.map((g) => [g.name, g.summary])).toEqual([
      ["函館", { running: 0, failed: 1 }],
      ["福島", { running: 1, failed: 0 }],
    ]);
  });

  it("板が無いとき、グループの summary は null", () => {
    expect(buildListModel(input({ list: { kind: "ready", races: [R1] }, board: { kind: "none" } })).groups[0]!.summary).toBeNull();
  });
});
