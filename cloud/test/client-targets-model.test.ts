import { describe, expect, it } from "vitest";
import type { TargetRace, TargetsData } from "../client/api-targets";
import { buildTargetsModel, remainingText } from "../client/targets-model";

/** Issue #336 段階 B: 今日の狙い目の表示用データ(純関数)。未発走・発走済みの分け方、残り時間の文言の境界、行のリンク、時計のずれの補正後の「今」の扱い。 */

const MIN = 60_000;
const NOW = Date.parse("2026-10-17T05:00:00Z");

describe("remainingText(境界値)", () => {
  it.each([
    [null, "時刻不明", false],
    [NOW, "発走済み", false], // ちょうどは発走済み
    [NOW - 1, "発走済み", false],
    [NOW - 3 * 60 * MIN, "発走済み", false],
    [NOW + 1, "まもなく", true],
    [NOW + MIN - 1, "まもなく", true],
    [NOW + MIN, "あと1分", true],
    [NOW + 12 * MIN + 30_000, "あと12分", false],
    [NOW + 10 * MIN, "あと10分", true], // 10 分ちょうどは「間近」
    [NOW + 10 * MIN + 1, "あと10分", false],
    [NOW + 59 * MIN + 59_999, "あと59分", false],
    [NOW + 60 * MIN, "あと1時間", false],
    [NOW + 61 * MIN, "あと1時間1分", false],
    [NOW + 125 * MIN, "あと2時間5分", false],
  ])("開始 %s → %s (間近=%s)", (startMs, text, soon) => {
    expect(remainingText(startMs, NOW)).toEqual({ text, soon });
  });
});

function race(id: string, startMs: number | null, overrides: Partial<TargetRace> = {}): TargetRace {
  return { raceId: id, analysisId: Number(id.slice(-4)), startMs, startTime: startMs === null ? null : "15:40", place: "東京11R", pick: "◎7", skipped: false, detail: "5点 1,200円 EV 1.42・分析時", resultState: null, result: null, ...overrides };
}

function data(races: TargetRace[], overrides: Partial<TargetsData> = {}): TargetsData {
  return { date: "20261017", nowMs: NOW, summary: "分析済み 5 レース中、狙い目 5", ledger: null, races, ...overrides };
}

const R = (n: number) => `2026050508${String(n).padStart(2, "0")}`;

function build(d: TargetsData | null, extra: { nowMs?: number; loading?: boolean; error?: string | null } = {}) {
  return buildTargetsModel({ date: "20261017", data: d, error: extra.error ?? null, loading: extra.loading ?? false, nowMs: extra.nowMs ?? NOW });
}

describe("buildTargetsModel: 未発走と発走済み", () => {
  it("未発走はサーバの並び(発走の近い順)のまま、時刻不明は未発走の末尾。発走済みは下に回し、新しいものを先にする", () => {
    const races = [race(R(1), NOW - 90 * MIN), race(R(2), NOW - 10 * MIN), race(R(3), NOW + 5 * MIN), race(R(4), NOW + 40 * MIN), race(R(5), null)];
    const model = build(data(races));
    expect(model.upcoming.map((r) => r.key)).toEqual([R(3), R(4), R(5)]);
    expect(model.past.map((r) => r.key)).toEqual([R(2), R(1)]);
    // 前提: 両方に行がある(分け方が退化していない)
    expect(model.upcoming.length).toBeGreaterThan(0);
    expect(model.past.length).toBeGreaterThan(0);
  });

  it("発走ちょうどの行は発走済み(境界)。1ms 前は未発走", () => {
    const model = build(data([race(R(1), NOW), race(R(2), NOW + 1)]));
    expect(model.past.map((r) => r.key)).toEqual([R(1)]);
    expect(model.upcoming.map((r) => r.key)).toEqual([R(2)]);
  });

  it("「今」は引数で決まる: 同じデータでも、時計が進めば未発走が発走済みに移り、残り時間が減る", () => {
    const d = data([race(R(1), NOW + 30 * MIN)]);
    expect(build(d, { nowMs: NOW }).upcoming[0]!.left).toBe("あと30分");
    expect(build(d, { nowMs: NOW + 20 * MIN }).upcoming[0]!.left).toBe("あと10分");
    const later = build(d, { nowMs: NOW + 31 * MIN });
    expect(later.upcoming).toEqual([]);
    expect(later.past[0]!.left).toBe("発走済み");
  });

  it("行の中身: 時刻・場と R・◎・2 行目はサーバの文言のまま、見送りと間近のしるしを持つ", () => {
    const model = build(data([race(R(3), NOW + 5 * MIN, { skipped: true, pick: null, detail: "見送り・発走2分前の再計算で0点" })]));
    expect(model.upcoming[0]).toMatchObject({ time: "15:40", place: "東京11R", pick: "", detail: "見送り・発走2分前の再計算で0点", left: "あと5分", soon: true, skipped: true });
  });

  it("時刻不明の行: 時刻は「--:--」、残りは「時刻不明」", () => {
    expect(build(data([race(R(5), null)])).upcoming[0]).toMatchObject({ time: "--:--", left: "時刻不明", soon: false });
  });
});

describe("buildTargetsModel: リンクと画面の要素", () => {
  it("行のリンクは結果画面。中央は venue=central、地方(場コード 30 以上)は venue=nar", () => {
    const model = build(data([race("202605050811", NOW + MIN, { analysisId: 11 }), race("202644101701", NOW + 2 * MIN, { analysisId: 12 })]));
    expect(model.upcoming.map((r) => r.href)).toEqual(["#date=20261017&venue=central&analysis=11", "#date=20261017&venue=nar&analysis=12"]);
  });

  it("戻るリンクは一覧(その日・中央)。日付は YYYY-MM-DD で出す", () => {
    const model = build(data([]));
    expect(model.backHref).toBe("#date=20261017&venue=central");
    expect(model.dateLabel).toBe("2026-10-17");
  });

  it("データなし: 一覧は空で要約は null。読み込み中の印・エラー文をそのまま持つ", () => {
    const model = build(null, { loading: true, error: "通信に失敗しました。" });
    expect(model).toMatchObject({ kind: "targets", summary: null, upcoming: [], past: [], loading: true, error: "通信に失敗しました。" });
  });

  it("データあり: 要約はサーバの文言。狙い目 0 件でも要約が出る", () => {
    const model = build(data([], { summary: "分析済み 12 レースのうち、狙い目はありません" }));
    expect(model.summary).toBe("分析済み 12 レースのうち、狙い目はありません");
    expect(model.upcoming).toEqual([]);
    expect(model.past).toEqual([]);
  });
});

describe("buildTargetsModel: 収支の途中経過(Issue #361)", () => {
  const settled = (id: string, startMs: number | null, result = "的中 +1,200円"): TargetRace => race(id, startMs, { resultState: "settled", result });

  it("上部の合計はサーバの文言のまま。データなしは null", () => {
    expect(build(data([], { ledger: "確定 2R: 投資 3,000円 / 回収 4,200円 / 回収率 140.0%" })).ledger).toBe("確定 2R: 投資 3,000円 / 回収 4,200円 / 回収率 140.0%");
    expect(build(data([])).ledger).toBeNull();
    expect(build(null).ledger).toBeNull();
  });

  it("発走済みの行にだけ結果の文言を出す。未発走の行は(サーバが結果を持っていても)空", () => {
    const model = build(data([settled(R(1), NOW - 30 * MIN), settled(R(2), NOW + 30 * MIN, "結果待ち")]));
    expect(model.past.map((r) => r.result)).toEqual(["的中 +1,200円"]);
    expect(model.upcoming.map((r) => r.result)).toEqual([""]);
    // 前提: 未発走の行の元データには文言がある(隠したのが表示側であって、データが無いからではない)
    expect(data([settled(R(2), NOW + 30 * MIN, "結果待ち")]).races[0]!.result).toBe("結果待ち");
  });

  it("「今」が進んで行が発走済みに移ると、取り直さなくてもサーバが持っていた文言(結果待ち)が出る。発走の瞬間ちょうどから", () => {
    const d = data([race(R(1), NOW + 10 * MIN, { resultState: "pending", result: "結果待ち" })]);
    expect(build(d, { nowMs: NOW + 10 * MIN - 1 }).upcoming[0]!.result).toBe("");
    expect(build(d, { nowMs: NOW + 10 * MIN }).past[0]!.result).toBe("結果待ち");
  });

  it("発走時刻が不明な行は、確定・結果なし・集計対象外のときだけ出す(待ち・提案なしは、発走前かもしれないので出さない)", () => {
    const states: [string, string, string][] = [["settled", "的中 +100円", "的中 +100円"], ["none", "結果なし", "結果なし"], ["excluded", "集計対象外", "集計対象外"], ["pending", "結果待ち", ""], ["pending_payout", "結果待ち(払戻)", ""], ["no_proposal", "分析時の提案なし", ""]];
    for (const [state, text, shown] of states) {
      expect(build(data([race(R(5), null, { resultState: state, result: text })])).upcoming[0]!.result, state).toBe(shown);
    }
  });

  it("結果の文言が null(収支なし・ledger に無い行)は空", () => {
    expect(build(data([race(R(1), NOW - MIN)])).past[0]!.result).toBe("");
  });
});
