import { describe, expect, it } from "vitest";
import type { BoardRow, RaceRow, TaskMode, TaskStatus } from "../client/api";
import { buildBulkModel, bulkAcceptedText, bulkDayCapText, jstHm, selectBulkTargets, type BulkUi } from "../client/bulk";

/**
 * Issue #251: 一括実行の対象の選別・確認画面の文言(純関数)。
 * 費用は件数と LLM の呼び出し回数だけを出す(円換算はしない)。発走前の分析では、自動の分析との二重課金・直列処理による遅れの 2 つの注意書きを出す(ユーザー決定)。
 */

const DATE = "20260628";
// 偽の現在時刻: 2026-06-28 05:00Z = JST 14:00(開催日 20260628 の今日)
const NOW = new Date("2026-06-28T05:00:00Z");

function race(n: number, startTime: string | null): RaceRow {
  const raceId = `2026030202${String(n).padStart(2, "0")}`;
  return { raceId, venueName: "福島", raceNumber: n, raceName: `R${n}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime };
}
function row(raceId: string, mode: TaskMode, status: TaskStatus): BoardRow {
  return { raceId, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null };
}

// R1: 13:59(発走済み)・R2: 14:00(ちょうど=発走済み)・R3: 14:01(未発走)・R4: 時刻不明・R5: 15:00・R6: 16:00
const RACES: RaceRow[] = [race(1, "13:59"), race(2, "14:00"), race(3, "14:01"), race(4, null), race(5, "15:00"), race(6, "16:00")];
const id = (n: number): string => RACES[n - 1]!.raceId;
const NO_EXCLUSION = { running: 0, done: 0, started: 0, timeUnknown: 0 };

describe("jstHm(現在の JST の HH:MM)", () => {
  it.each([
    ["2026-06-28T05:00:00Z", "14:00"],
    ["2026-06-28T14:59:00Z", "23:59"],
    ["2026-06-28T15:00:00Z", "00:00"], // UTC の 15:00 は JST の翌日 0 時
    ["2026-06-28T00:05:00Z", "09:05"],
  ])("%s → %s", (iso, expected) => {
    expect(jstHm(new Date(iso))).toBe(expected);
  });
});

describe("selectBulkTargets(Issue #251): 対象の選別", () => {
  it("事前分析(morning): 実行中(queued・fetched)と完了済み(done)を除き、失敗(failed)と未実行は含める。発走時刻は見ない(発走済み・時刻不明も含める)。入力の順を保つ", () => {
    const board = [row(id(1), "morning", "queued"), row(id(2), "morning", "fetched"), row(id(3), "morning", "done"), row(id(4), "morning", "failed")];
    const result = selectBulkTargets({ mode: "morning", races: RACES, board, date: DATE, now: NOW });
    expect(result.raceIds).toEqual([id(4), id(5), id(6)]);
    expect(result.excluded).toEqual({ running: 2, done: 1, started: 0, timeUnknown: 0 });
  });

  it("発走前(pre_race・開催日が今日): 実行中・完了済みに加えて、発走済み(発走時刻 ≦ 現在。ちょうども含む)と時刻不明を除く", () => {
    const board = [row(id(5), "pre_race", "done"), row(id(6), "pre_race", "queued")];
    const result = selectBulkTargets({ mode: "pre_race", races: RACES, board, date: DATE, now: NOW });
    // 前提: 全レースがいずれかの区分に入る(退化して全部が対象/全部が除外になっていない)
    expect(result.raceIds).toEqual([id(3)]); // 14:01 だけが未発走で、実行中でも完了済みでもない
    expect(result.excluded).toEqual({ running: 1, done: 1, started: 2, timeUnknown: 1 }); // 発走済み = R1(13:59)・R2(14:00)
  });

  it("発走前でも、失敗(failed)のレースは対象に含める(再試行)", () => {
    const board = [row(id(3), "pre_race", "failed")];
    const result = selectBulkTargets({ mode: "pre_race", races: [RACES[2]!], board, date: DATE, now: NOW });
    expect(result.raceIds).toEqual([id(3)]);
  });

  it("区分は排他: 実行中・完了済みが先で、発走済み・時刻不明は残りだけに数える(対象 + 除外の合計 = レース数)", () => {
    const board = [row(id(1), "pre_race", "done"), row(id(2), "pre_race", "queued"), row(id(4), "pre_race", "fetched")];
    const result = selectBulkTargets({ mode: "pre_race", races: RACES, board, date: DATE, now: NOW });
    expect(result.excluded).toEqual({ running: 2, done: 1, started: 0, timeUnknown: 0 }); // R1(発走済みでもある)は done に、R2 は running に、R4(時刻不明でもある)は running に数える
    const e = result.excluded;
    expect(result.raceIds.length + e.running + e.done + e.started + e.timeUnknown).toBe(RACES.length);
    expect(result.raceIds).toEqual([id(3), id(5), id(6)]);
  });

  it("開催日が今日でない(未来)なら、発走前でも発走時刻を見ない(時刻不明も対象)", () => {
    const result = selectBulkTargets({ mode: "pre_race", races: RACES, board: [], date: "20260629", now: NOW });
    expect(result.raceIds).toEqual(RACES.map((r) => r.raceId));
    expect(result.excluded).toEqual(NO_EXCLUSION);
  });

  it("もう一方のモードの状態は見ない: 事前分析が完了・実行中でも、発走前の対象は変わらない", () => {
    const board = RACES.map((r) => row(r.raceId, "morning", "done"));
    const result = selectBulkTargets({ mode: "pre_race", races: RACES, board, date: "20260629", now: NOW });
    expect(result.raceIds).toHaveLength(RACES.length);
  });

  it("日付が変わる境界: UTC 15:00 は JST の翌日になり、「今日」の判定も JST で行う(JST 翌日 00:00 の時点で、開催日 20260628 は過去=発走時刻の比較ではなく全除外にならないよう、呼び出し側が過去日として無効にする)", () => {
    const afterMidnight = new Date("2026-06-28T15:00:00Z"); // JST 6/29 00:00
    // 開催日 6/29 は「今日」になり、00:00 より前に発走したレースは無い
    const today = selectBulkTargets({ mode: "pre_race", races: RACES, board: [], date: "20260629", now: afterMidnight });
    expect(today.excluded.started).toBe(0);
    expect(today.excluded.timeUnknown).toBe(1);
    expect(today.raceIds).toHaveLength(RACES.length - 1);
  });
});

describe("buildBulkModel(Issue #251): ボタンの出し方", () => {
  const input = (over: Partial<Parameters<typeof buildBulkModel>[0]> = {}): Parameters<typeof buildBulkModel>[0] => ({
    date: DATE,
    groupName: "福島",
    races: RACES,
    board: [],
    now: NOW,
    ui: undefined,
    ...over,
  });

  it("2 つのボタン(事前分析・発走前の分析)を、対象の件数つきで返す。発走前は今日の発走済み・時刻不明を除いた件数", () => {
    const model = buildBulkModel(input());
    expect(model.buttons.map((b) => b.mode)).toEqual(["morning", "pre_race"]);
    expect(model.buttons.map((b) => b.label)).toEqual(["事前分析を一括実行(6)", "発走前の分析を一括実行(3)"]);
    expect(model.buttons.map((b) => b.count)).toEqual([6, 3]);
    expect(model.buttons.map((b) => b.disabled)).toEqual([false, false]);
    expect(model.note).toBeNull();
    expect(model.panel).toBeNull();
  });

  it("対象が 0 件のモードのボタンは無効(件数 0 と表示)。もう一方は影響を受けない", () => {
    const board = RACES.map((r) => row(r.raceId, "morning", "done"));
    const model = buildBulkModel(input({ board }));
    expect(model.buttons[0]).toMatchObject({ mode: "morning", count: 0, disabled: true, label: "事前分析を一括実行(0)" });
    expect(model.buttons[1]).toMatchObject({ mode: "pre_race", count: 3, disabled: false });
  });

  it("過去の開催日は両方無効で、理由の注記を出す(対象の件数を数えても押せない)", () => {
    const model = buildBulkModel(input({ date: "20260627" }));
    expect(model.buttons.map((b) => b.disabled)).toEqual([true, true]);
    expect(model.note).toBe("過去の開催日には一括実行できません。");
  });

  it("板が取れていない(null)ときは両方無効で、理由の注記を出す(状態が分からないまま課金しない)", () => {
    const model = buildBulkModel(input({ board: null }));
    expect(model.buttons.map((b) => b.disabled)).toEqual([true, true]);
    expect(model.note).toBe("実行状態を取得できていないため、一括実行できません。「更新」を押してください。");
  });

  it("板が取れていないことと過去日が重なったら、過去日の注記を優先する", () => {
    expect(buildBulkModel(input({ date: "20260627", board: null })).note).toBe("過去の開催日には一括実行できません。");
  });

  it("送信中(sending)は両方無効で、送信中の表示を返す", () => {
    const model = buildBulkModel(input({ ui: { kind: "sending", mode: "pre_race" } }));
    expect(model.buttons.map((b) => b.disabled)).toEqual([true, true]);
    expect(model.panel).toEqual({ kind: "sending", mode: "pre_race", text: "発走前の分析を予約しています…" });
  });
});

describe("buildBulkModel: 確認画面の文言", () => {
  const confirmUi = (mode: TaskMode, ids: string[], excluded = NO_EXCLUSION): BulkUi => ({ kind: "confirm", mode, raceIds: ids, excluded });
  const build = (ui: BulkUi) => buildBulkModel({ date: DATE, groupName: "福島", races: RACES, board: [], now: NOW, ui });

  it("発走前: 対象の件数・LLM の呼び出し回数(通常 N 回・最大 2N 回)・API キーの条件と、2 つの注意書き(自動の分析との二重課金・直列処理による遅れ)を出す", () => {
    const panel = build(confirmUi("pre_race", [id(3), id(5), id(6)])).panel;
    expect(panel).not.toBeNull();
    if (panel === null || panel.kind !== "confirm") throw new Error("確認画面のはず");
    expect(panel.title).toBe("福島の発走前の分析を一括実行しますか");
    expect(panel.count).toBe(3);
    expect(panel.lines).toContain("対象: 3 レース");
    expect(panel.lines.some((l) => l.includes("LLM の呼び出し: 通常 3 回") && l.includes("最大 6 回") && l.includes("API キーが登録されているときだけ"))).toBe(true);
    expect(panel.notes).toEqual([
      "自動の分析(発走の N 分前)は別に走ります。ここで分析したレースも、自動の分析が走ると二重に課金されることがあります。",
      "一括で積むと、レースは 1 つずつ順に処理されます。その間、自動の分析の開始が遅れることがあります。",
    ]);
    expect(panel.goLabel).toBe("実行する");
    expect(panel.cancelLabel).toBe("やめる");
  });

  it("事前分析: LLM を使わないこと・取得の目安を出す。LLM の呼び出し回数の行も、二重課金・遅れの注意書きも出さない(事前分析は課金されない)", () => {
    const panel = build(confirmUi("morning", [id(1), id(2)])).panel;
    if (panel === null || panel.kind !== "confirm") throw new Error("確認画面のはず");
    expect(panel.title).toBe("福島の事前分析を一括実行しますか");
    expect(panel.lines).toContain("対象: 2 レース");
    expect(panel.lines.some((l) => l.includes("LLM は使いません"))).toBe(true);
    expect(panel.lines.some((l) => l.includes("LLM の呼び出し"))).toBe(false);
    expect(panel.lines.some((l) => l.includes("1 レースあたり 1 分弱"))).toBe(true);
    expect(panel.notes).toEqual([]);
  });

  it("除外の件数は 0 でない区分だけを出す(全部 0 なら行を出さない)", () => {
    const withExcluded = build(confirmUi("pre_race", [id(3)], { running: 1, done: 2, started: 0, timeUnknown: 1 })).panel;
    if (withExcluded === null || withExcluded.kind !== "confirm") throw new Error("確認画面のはず");
    expect(withExcluded.lines).toContain("除外: 実行中 1・完了済み 2・発走時刻が不明 1");
    const none = build(confirmUi("pre_race", [id(3)])).panel;
    if (none === null || none.kind !== "confirm") throw new Error("確認画面のはず");
    expect(none.lines.some((l) => l.startsWith("除外"))).toBe(false);
  });

  it("確認画面の対象の件数は、押した時点の対象(スナップショット)。そのあと板が変わっても、画面の件数は変わらない", () => {
    const board = RACES.map((r) => row(r.raceId, "pre_race", "done"));
    const panel = buildBulkModel({ date: DATE, groupName: "福島", races: RACES, board, now: NOW, ui: confirmUi("pre_race", [id(3), id(5)]) }).panel;
    if (panel === null || panel.kind !== "confirm") throw new Error("確認画面のはず");
    expect(panel.count).toBe(2);
  });

  it("結果の表示(result)は、トーンと本文をそのまま返す。ボタンは押せる", () => {
    const model = build({ kind: "result", tone: "error", text: "失敗しました" });
    expect(model.panel).toEqual({ kind: "result", tone: "error", text: "失敗しました" });
    expect(model.buttons.map((b) => b.disabled)).toEqual([false, false]);
  });
});

describe("結果の文言", () => {
  it("bulkAcceptedText: 受け付けた件数と、実行中で見送った件数(0 なら出さない)", () => {
    expect(bulkAcceptedText([{ raceId: "a", result: "accepted" }, { raceId: "b", result: "accepted" }])).toBe("2 レースを予約しました。進み具合は各レースのバッジで確認できます。");
    expect(
      bulkAcceptedText([
        { raceId: "a", result: "accepted" },
        { raceId: "b", result: "already-running", status: "queued" },
      ]),
    ).toBe("1 レースを予約しました(実行中のため見送り: 1 レース)。進み具合は各レースのバッジで確認できます。");
    expect(bulkAcceptedText([{ raceId: "a", result: "already-running", status: "fetched" }])).toBe("予約したレースはありません(すべて実行中でした)。進み具合は各レースのバッジで確認できます。");
  });

  it("bulkDayCapText: 上限・現在の件数・追加で必要な件数を示し、何も予約していないことを明記する", () => {
    expect(bulkDayCapText({ limit: 100, used: 99, needed: 2 })).toBe("この開催日に受け付けられる上限(100)を超えるため、何も予約していません(現在 99・追加で必要 2)。");
  });
});
