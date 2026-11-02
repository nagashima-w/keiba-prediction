import { describe, expect, it } from "vitest";
import type { BoardRow, RaceRow } from "../client/api";
import { badgeOf, buildListModel, groupKeys, groupRaces, summarizeGroup, type ListModelInput } from "../client/list";
import type { Route } from "../client/route";

/** Issue #184: 一覧の画面の表示用データ(純関数)。場ごとのまとまり・R 順・板の (race_id, mode) ごとのバッジ・各状態の表示。 */

function race(raceId: string, over: Partial<RaceRow> = {}): RaceRow {
  return { raceId, venueName: "福島", raceNumber: Number(raceId.slice(-2)), raceName: `レース${raceId.slice(-2)}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: null, ...over };
}

function row(raceId: string, mode: BoardRow["mode"], status: BoardRow["status"], over: Partial<BoardRow> = {}): BoardRow {
  return { raceId, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null, ...over };
}

const ROUTE: Route = { date: "20260628", venue: "central", race: null, analysis: null, settings: false };

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

  it.each([
    ["時刻あり: detail の先頭に「HH:MM 発走・」", "15:40", "15:40 発走・芝 1800m・16頭"],
    ["時刻なし(null。発走後に取得した一覧など): 時刻の部分を出さない=従来の表示のまま", null, "芝 1800m・16頭"],
  ] as const)("Issue #236 発走予定時刻 — %s", (_name, startTime, expected) => {
    const model = buildListModel(input({ list: { kind: "ready", races: [race("202603020211", { startTime })] } }));
    expect(model.groups[0]!.races[0]!.detail).toBe(expected);
  });

  it("Issue #236: 時刻はレースごと。同じ場の中で、ある行は出て、ある行は出ない", () => {
    const model = buildListModel(input({ list: { kind: "ready", races: [race("202603020211", { startTime: "15:40" }), race("202603020212", { startTime: null })] } }));
    expect(model.groups[0]!.races.map((r) => r.detail)).toEqual(["15:40 発走・芝 1800m・16頭", "芝 1800m・16頭"]);
  });

  it("グレードが null の行は grade も null(表示しない)", () => {
    const model = buildListModel(input({ list: { kind: "ready", races: [race("202603020211")] } }));
    expect(model.groups[0]!.races[0]!.grade).toBeNull();
  });

  it.each([
    ["中央の重賞", "G1", "G1"],
    ["障害の重賞", "J・G2", "J・G2"],
    ["地方の交流重賞", "Jpn3", "Jpn3"],
    ["地方の重賞", "重賞", "重賞"],
    ["地方の OP は出さない(重賞ではない。Issue #250)", "OP", null],
    ["リステッドは出さない(重賞ではない)", "L", null],
  ] as const)("Issue #250 グレードのバッジ — %s", (_name, grade, expected) => {
    const model = buildListModel(input({ list: { kind: "ready", races: [race("202603020211", { grade })] } }));
    expect(model.groups[0]!.races[0]!.grade).toBe(expected);
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

  it("追跡の停止の注記(tracking)は、渡した文言がそのまま出る。無ければ null(Issue #186)", () => {
    expect(buildListModel(input({ tracking: "止めました" })).tracking).toBe("止めました");
    expect(buildListModel(input()).tracking).toBeNull();
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
    const model = buildListModel(input({ route: { date: "20261003", venue: "nar", race: null, analysis: null, settings: false } }));
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

describe("Issue #336: 一覧の「狙い目」への入口", () => {
  it("リンク先は、一覧で選んでいる日付の #targets=YYYYMMDD。管理者にも閲覧者にも同じ(読み取りだけの画面)", () => {
    const races = [race("202603020211")];
    const admin = buildListModel(input({ list: { kind: "ready", races } }));
    const viewer = buildListModel(input({ list: { kind: "ready", races }, readOnly: true }));
    expect(admin.targetsHref).toBe(`#targets=${admin.date}`);
    expect(admin.date).toMatch(/^[0-9]{8}$/); // 前提: 日付が入っている
    expect(viewer.targetsHref).toBe(admin.targetsHref);
  });
});

describe("Issue #238: 閲覧者(readOnly)の一覧: 設定への入口を出さない(日報への入口は残す。検証への入口は Issue #263 で閲覧者にも出す)", () => {
  it("管理者(既定)は 3 つの入口のリンク先を持つ。readOnly は設定だけが null で、検証(Issue #263)と日報は残る。一覧そのもの(場・レース)は同じ", () => {
    const races = [race("202603020211")];
    const admin = buildListModel(input({ list: { kind: "ready", races } }));
    expect(admin.settingsHref).toBe("#settings");
    expect(admin.verifyHref).toBe("#verify");
    expect(admin.reportHref).toBe("#report");
    const viewer = buildListModel(input({ list: { kind: "ready", races }, readOnly: true }));
    expect(viewer.settingsHref).toBeNull();
    expect(viewer.verifyHref).toBe("#verify");
    expect(viewer.reportHref).toBe("#report");
    expect(viewer.groups).toEqual(admin.groups);
    expect(viewer.groups).toHaveLength(1);
  });
});

describe("Issue #544: トップの「月報」の入口(monthlyHref)", () => {
  const races = [race("202603020211")];

  it.each([
    ["月の途中", "2026-10-15T00:00:00Z", "#report=202609"],
    ["月の最終日の夜(月報は 22:00 に作るので、その日はまだ先月を指す)", "2026-10-31T10:00:00Z", "#report=202609"],
    ["月初(当月の月報が先月になる)", "2026-11-01T00:00:00Z", "#report=202610"],
    ["1 月は前年 12 月", "2026-01-15T00:00:00Z", "#report=202512"],
    ["JST の境界: UTC 12/31 15:00 は JST の 1/1", "2025-12-31T15:00:00Z", "#report=202512"],
  ])("%s: now=%s → %s(管理者も閲覧者も同じ。日報の入口 reportHref は #report のまま)", (_label, nowIso, expected) => {
    const admin = buildListModel(input({ list: { kind: "ready", races }, now: new Date(nowIso) }));
    const viewer = buildListModel(input({ list: { kind: "ready", races }, now: new Date(nowIso), readOnly: true }));
    expect(admin.monthlyHref).toBe(expected);
    expect(viewer.monthlyHref).toBe(expected);
    expect(admin.reportHref).toBe("#report");
  });

  it("月報の入口は、一覧で選んでいる開催日ではなく今日(now)で決まる(過去の日付の一覧でも、今日から見た先月)", () => {
    expect(ROUTE.date).toBe("20260628"); // 前提: 一覧の日付は 2026-06
    const model = buildListModel(input({ list: { kind: "ready", races }, now: new Date("2026-10-15T00:00:00Z") }));
    expect(model.date).toBe("20260628");
    expect(model.monthlyHref).toBe("#report=202609");
  });

  it("now を省くと null(リンクを出さない。日報のハッシュにフォールバックしない)", () => {
    const model = buildListModel(input({ list: { kind: "ready", races } }));
    expect(model.monthlyHref).toBeNull();
  });
});

describe("Issue #559: 一覧の先頭の「次に発走するレース」(ListModel.next)", () => {
  const DATE = "20260628";
  /** 2026-06-28 の JST の時刻(`HH:MM` または `HH:MM:SS`)。 */
  const at = (hms: string): Date => new Date(`2026-06-28T${hms.length === 5 ? `${hms}:00` : hms}+09:00`);
  const raceAt = (venue: string, n: number, startTime: string | null, over: Partial<RaceRow> = {}): RaceRow =>
    race(`2026${venue === "福島" ? "03" : "08"}0201${String(n).padStart(2, "0")}`, { venueName: venue, raceNumber: n, startTime, ...over });
  const f = (n: number, startTime: string | null, over: Partial<RaceRow> = {}): RaceRow => raceAt("福島", n, startTime, over);
  const ready = (races: RaceRow[], now: Date | undefined, over: Partial<ListModelInput> = {}): ListModelInput =>
    input({ route: { ...ROUTE, date: DATE }, list: { kind: "ready", races }, ...(now === undefined ? {} : { now }), ...over });
  const ids = (m: ReturnType<typeof buildListModel>): string[] => m.next.map((n) => n.raceId.slice(-2));

  describe("どのレースが「次」か(今日の一覧の中だけから。最も早い発走時刻のもの)", () => {
    it("未発走の中で最も早い発走時刻の 1 レースだけ(前提: 一覧には 3 レースある)", () => {
      const races = [f(3, "12:00"), f(1, "10:00"), f(2, "11:00")];
      const m = buildListModel(ready(races, at("09:00")));
      expect(m.groups[0]!.races).toHaveLength(3);
      expect(ids(m)).toEqual(["01"]);
    });

    it("発走時刻ちょうど(10:00:00)のレースは次から外れ、1 分前(09:59:59)は次のまま。境界は hasStarted(HH:MM の比較)と同じ", () => {
      const races = [f(1, "10:00"), f(2, "11:00")];
      expect(ids(buildListModel(ready(races, at("09:59:59"))))).toEqual(["01"]);
      expect(ids(buildListModel(ready(races, at("10:00:00"))))).toEqual(["02"]);
      expect(ids(buildListModel(ready(races, at("10:00:59"))))).toEqual(["02"]); // 分未満の秒は見ない(一覧の並べ替えと同じ瞬間)
    });

    it("最も早い発走時刻を共有するレースは全部(race_id 順。入力が逆順でも)", () => {
      const races = [f(5, "12:00"), f(2, "12:00"), f(9, "13:00"), f(1, "10:00")];
      const m = buildListModel(ready(races, at("11:00")));
      expect(ids(m)).toEqual(["02", "05"]);
      // 前提: 2 つの会場が混ざっても、時刻が同じなら全部(会場名つきのラベル)
      const mixed = buildListModel(ready([raceAt("福島", 5, "12:00"), raceAt("京都", 2, "12:00")], at("11:00")));
      expect(mixed.next.map((n) => n.label)).toEqual(["福島 5R", "京都 2R"]); // race_id: 福島 2026 03…05 < 京都 2026 08…02
    });

    it("会場をまたいで最も早いもの(福島 12:00 より京都 11:30)", () => {
      const m = buildListModel(ready([raceAt("福島", 1, "12:00"), raceAt("京都", 3, "11:30")], at("11:00")));
      expect(m.next.map((n) => n.label)).toEqual(["京都 3R"]);
    });

    it("発走時刻の分からないレースは対象にしない(時刻のあるレースが残っていればそちら。時刻不明は最も早いと見なさない)", () => {
      const m = buildListModel(ready([f(1, null), f(2, "13:00")], at("11:00")));
      expect(ids(m)).toEqual(["02"]);
    });

    it.each([
      ["時刻の分からないレースだけ", [f(1, null), f(2, null)], at("09:00")],
      ["全部発走済み", [f(1, "10:00"), f(2, "11:00")], at("11:00")],
      ["一覧が空", [], at("09:00")],
      ["now なし", [f(1, "10:00")], undefined],
    ] as const)("カードを出さない(空配列): %s", (_label, races, now) => {
      const m = buildListModel(ready([...races], now));
      expect(m.next).toEqual([]);
    });

    it.each([
      ["過去の開催日", "20260627"],
      ["未来の開催日", "20260629"],
    ])("今日以外の開催日(%s)は出さない(前提: 一覧には時刻つきのレースがある)", (_label, date) => {
      const m = buildListModel(input({ route: { ...ROUTE, date }, list: { kind: "ready", races: [f(1, "23:00")] }, now: at("09:00") }));
      expect(m.groups[0]!.races).toHaveLength(1);
      expect(m.next).toEqual([]);
    });

    it("一覧が loading・error のときは出さない", () => {
      expect(buildListModel(input({ route: { ...ROUTE, date: DATE }, list: { kind: "loading" }, now: at("09:00") })).next).toEqual([]);
      expect(buildListModel(input({ route: { ...ROUTE, date: DATE }, list: { kind: "error", message: "失敗" }, now: at("09:00") })).next).toEqual([]);
    });
  });

  describe("カードの内容", () => {
    it("ラベル・レース名・発走時刻・リンク先(レース画面のハッシュ。区分は画面で選んでいる区分)", () => {
      const m = buildListModel(ready([f(11, "15:40", { raceName: "福島民報杯", grade: "G3" })], at("09:00"), { route: { ...ROUTE, date: DATE, venue: "central" } }));
      const n = m.next[0]!;
      expect(n.label).toBe("福島 11R");
      expect(n.name).toBe("福島民報杯");
      expect(n.startTime).toBe("15:40");
      expect(n.grade).toBe("G3");
      expect(n.href).toBe(`#date=${DATE}&venue=central&race=${n.raceId}`);
    });

    it("会場名が無いレースは「会場不明」(一覧の見出しと同じ)", () => {
      const m = buildListModel(ready([f(1, "10:00", { venueName: null })], at("09:00")));
      expect(m.next[0]!.label).toBe("会場不明 1R");
    });

    it.each([
      ["30 秒前でも", "11:59:30", "まもなく"],
      ["1 分前", "11:59:00", "あと1分"],
      ["12 分前", "11:48", "あと12分"],
      ["59 分前", "11:01", "あと59分"],
      ["ちょうど 1 時間前(分の端数なし)", "11:00", "あと1時間"],
      ["1 時間 5 分前", "10:55", "あと1時間5分"],
      ["3 時間 30 分前", "08:30", "あと3時間30分"],
    ])("発走 12:00 まで: %s(%s)→「%s」", (_label, hms, expected) => {
      const m = buildListModel(ready([f(1, "12:00")], at(hms)));
      expect(m.next).toHaveLength(1);
      expect(m.next[0]!.left).toBe(expected);
    });
  });

  describe("状態のバッジとボタン(発走前の分析 pre_race だけ。管理者だけがボタン)", () => {
    const R = f(1, "12:00");
    const board = (rows: BoardRow[]): Partial<ListModelInput> => ({ board: { kind: "ready", rows } });
    const first = (over: Partial<ListModelInput>) => buildListModel(ready([R], at("11:00"), over)).next[0]!;

    it.each([
      ["行なし", [], { label: "未実行", tone: "none" }, "発走前の分析を実行", false],
      ["queued", [row(R.raceId, "pre_race", "queued")], { label: "待ち", tone: "wait" }, "待ち", true],
      ["fetched", [row(R.raceId, "pre_race", "fetched")], { label: "取得済み", tone: "wait" }, "取得済み", true],
      ["failed", [row(R.raceId, "pre_race", "failed")], { label: "失敗", tone: "fail" }, "再試行", false],
    ] as const)("管理者・pre_race=%s: バッジ %j・ボタン「%s」(押せない=%s)", (_name, rows, badge, label, disabled) => {
      const n = first(board([...rows]));
      expect(n.badge).toEqual(badge);
      expect(n.button).toEqual({ label, disabled, date: DATE, raceId: R.raceId, mode: "pre_race" });
    });

    it("pre_race が完了(done)のレースは、ボタンを出さない(null)。バッジ「完了」とリンクは残る(再実行による LLM の再課金を防ぐ)", () => {
      const n = first(board([row(R.raceId, "pre_race", "done", { analysisId: 7 })]));
      expect(n.badge).toEqual({ label: "完了", tone: "ok" });
      expect(n.button).toBeNull();
      expect(n.href).toContain(`race=${R.raceId}`);
    });

    it("morning の行はバッジにもボタンにも効かない(pre_race の行だけを見る)。morning が done でも pre_race が無ければ「未実行」・実行できる", () => {
      const n = first(board([row(R.raceId, "morning", "done", { analysisId: 3 })]));
      expect(n.badge).toEqual({ label: "未実行", tone: "none" });
      expect(n.button).toEqual({ label: "発走前の分析を実行", disabled: false, date: DATE, raceId: R.raceId, mode: "pre_race" });
      // 逆: morning が実行中でも、pre_race が無ければ押せる
      expect(first(board([row(R.raceId, "morning", "queued")])).button!.disabled).toBe(false);
    });

    it("別のレースの行は混ざらない(同じ mode でも race_id が違えば無視)", () => {
      const n = first(board([row(f(2, "13:00").raceId, "pre_race", "done", { analysisId: 9 })]));
      expect(n.badge).toEqual({ label: "未実行", tone: "none" });
      expect(n.button).not.toBeNull();
    });

    it.each([
      ["板が未取得(none)", { kind: "none" }],
      ["板の取得に失敗(error)", { kind: "error", message: "失敗" }],
    ] as const)("%s: バッジなし(null)・ボタンは出すが押せない(押せない理由は状態が分からないこと)", (_name, b) => {
      const n = first({ board: b });
      expect(n.badge).toBeNull();
      expect(n.button).toEqual({ label: "発走前の分析を実行", disabled: true, date: DATE, raceId: R.raceId, mode: "pre_race" });
    });

    it.each([
      ["行なし", []],
      ["queued", [row(R.raceId, "pre_race", "queued")]],
      ["failed", [row(R.raceId, "pre_race", "failed")]],
      ["done", [row(R.raceId, "pre_race", "done", { analysisId: 7 })]],
    ])("閲覧者(readOnly): pre_race=%s でもボタンは出さない(null)。バッジは出す", (_name, rows) => {
      const n = first({ ...board(rows), readOnly: true });
      expect(n.button).toBeNull();
      expect(n.badge).not.toBeNull();
    });

    it("閲覧者でも板が無ければバッジなし・ボタンなし", () => {
      const n = first({ readOnly: true });
      expect(n.badge).toBeNull();
      expect(n.button).toBeNull();
    });
  });

  describe("実行の操作の表示(runs。レース画面と同じ RunUi)", () => {
    const R = f(1, "12:00");
    const asked: string[] = [];
    const runsOf = (map: Record<string, ReadonlyMap<"morning" | "pre_race", { kind: "sending" } | { kind: "error"; message: string } | { kind: "already" }>>) => (id: string) => {
      asked.push(id);
      return map[id] ?? new Map();
    };
    const first = (rows: BoardRow[], runs: ReturnType<typeof runsOf>, over: Partial<ListModelInput> = {}) =>
      buildListModel(ready([R], at("11:00"), { board: { kind: "ready", rows }, runs, ...over })).next[0]!;

    it("送信中: ボタンは「送信中…」で押せない(板の状態によらない)", () => {
      const n = first([], runsOf({ [R.raceId]: new Map([["pre_race", { kind: "sending" }]]) }));
      expect(n.button).toEqual({ label: "送信中…", disabled: true, date: DATE, raceId: R.raceId, mode: "pre_race" });
    });

    it("失敗: 文言を runError に。ボタンは押せる(再試行できる)", () => {
      const n = first([], runsOf({ [R.raceId]: new Map([["pre_race", { kind: "error", message: "失敗しました" }]]) }));
      expect(n.runError).toBe("失敗しました");
      expect(n.button!.disabled).toBe(false);
    });

    it("すでに実行中(already): 板が実行中のときだけ注記を出す。板が実行中でなければ出さない", () => {
      const already = runsOf({ [R.raceId]: new Map([["pre_race", { kind: "already" }]]) });
      expect(first([row(R.raceId, "pre_race", "queued")], already).runInfo).toBe("すでに実行中です。状態を追跡します。");
      expect(first([], already).runInfo).toBeNull();
    });

    it("morning の操作は無関係(pre_race のボタンに効かない)", () => {
      const n = first([], runsOf({ [R.raceId]: new Map([["morning", { kind: "sending" }]]) }));
      expect(n.button!.label).toBe("発走前の分析を実行");
      expect(n.runError).toBeNull();
    });

    it("runs は「次」のレースの race_id で引く(同時刻の 2 レースなら 2 つとも。一覧の他のレースでは引かない)", () => {
      asked.length = 0;
      const m = buildListModel(ready([f(1, "12:00"), f(2, "12:00"), f(3, "13:00")], at("11:00"), { runs: runsOf({}) }));
      expect(m.next).toHaveLength(2);
      expect([...new Set(asked)].sort()).toEqual(m.next.map((n) => n.raceId).sort());
    });

    it("runs を渡さない・状態が無いとき: 注記・失敗は null", () => {
      const n = buildListModel(ready([R], at("11:00"))).next[0]!;
      expect(n.runError).toBeNull();
      expect(n.runInfo).toBeNull();
    });
  });
});
