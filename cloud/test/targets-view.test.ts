import { describe, expect, it } from "vitest";
import { venueNameFromRaceId } from "../../packages/core/src/analysis/venue-codes";
import { buildTargetsView, type TargetsAnalysisRow, type TargetsCloseRoundRow, type TargetsPlanRow } from "../src/targets-view";

/**
 * Issue #336 段階 A: 「今日の狙い目」の一覧の整形(純関数。D1・DO・時計に触れない)。
 * どの回を採るか(2 分前 > 5 分前 > 分析時。status が ok の回のうち番号が最大)・見送り・除外・並び・文言・件数の要約を固定する。
 */

const DATE = "20261017";
const NOW = Date.parse("2026-10-17T03:00:00Z");

/** 分析 1 件。既定は 5 点・合計 1,200 円・最大 EV 1.42・◎は 7 番。 */
function analysis(raceId: string, overrides: Partial<TargetsAnalysisRow> = {}): TargetsAnalysisRow {
  return { analysisId: Number(raceId.slice(-4)), raceId, analyzedAt: "2026-10-17T02:00:00.000Z", betCount: 5, totalStake: 1200, maxEv: 1.42, markUmaban: 7, ...overrides };
}

function closeRound(a: TargetsAnalysisRow, round: number, overrides: Partial<TargetsCloseRoundRow> = {}): TargetsCloseRoundRow {
  return { analysisId: a.analysisId, round, status: "ok", betCount: 3, totalStake: 700, maxEv: 1.31, ...overrides };
}

const planRow = (raceId: string, startTime: string | null, venueName: string | null = "東京", raceNumber: number | null = 11): TargetsPlanRow => ({ raceId, venueName, raceNumber, startTime });

const R11 = "202605050811"; // 東京 11R(場コード 05)
const R12 = "202605050812";

function build(analyses: TargetsAnalysisRow[], closeRounds: TargetsCloseRoundRow[] | null = [], plan: TargetsPlanRow[] | null = null) {
  return buildTargetsView({ kaisaiDate: DATE, nowMs: NOW, analyses, closeRounds, plan });
}

describe("どの回を採るか(status が ok の回のうち番号が最大。無ければ分析時)", () => {
  it("close なし: 分析時の提案を出す(round は null・source は analysis)", () => {
    const a = analysis(R11);
    const [race] = build([a]).races;
    expect(race).toMatchObject({ source: "analysis", round: null, bet_count: 5, total_stake: 1200, max_ev: 1.42, skipped: false });
    expect(race!.detail).toBe("5点 1,200円 EV 1.42・分析時");
  });

  it("回 1(5 分前)が ok: 回 1 の点数・合計・最大 EV を出す(分析時の値ではない)", () => {
    const a = analysis(R11);
    const [race] = build([a], [closeRound(a, 1)]).races;
    expect(race).toMatchObject({ source: "close", round: 1, bet_count: 3, total_stake: 700, max_ev: 1.31, skipped: false });
    expect(race!.detail).toBe("3点 700円 EV 1.31・発走5分前の再計算");
    // 前提: 分析時と値が違う(分析時の値を返す実装を見逃さない)
    expect(race!.bet_count).not.toBe(a.betCount);
  });

  it("回 1・回 2 がどちらも ok: 回 2(2 分前)を優先する。close 行が逆順で渡されても同じ", () => {
    const a = analysis(R11);
    const r1 = closeRound(a, 1);
    const r2 = closeRound(a, 2, { betCount: 2, totalStake: 400, maxEv: 1.2 });
    for (const rounds of [[r1, r2], [r2, r1]]) {
      const [race] = build([a], rounds).races;
      expect(race).toMatchObject({ round: 2, bet_count: 2, total_stake: 400, max_ev: 1.2 });
      expect(race!.detail).toBe("2点 400円 EV 1.20・発走2分前の再計算");
    }
  });

  it("回 2 が failed・回 1 が ok: 回 1 を出す(失敗した回は採らない)", () => {
    const a = analysis(R11);
    const [race] = build([a], [closeRound(a, 1), closeRound(a, 2, { status: "failed", betCount: 0, totalStake: 0, maxEv: null })]).races;
    expect(race).toMatchObject({ round: 1, bet_count: 3 });
  });

  it("回 2 が skipped で回 1 が failed: 分析時に戻る", () => {
    const a = analysis(R11);
    const [race] = build([a], [closeRound(a, 1, { status: "failed" }), closeRound(a, 2, { status: "skipped" })]).races;
    expect(race).toMatchObject({ source: "analysis", round: null, bet_count: 5 });
  });

  it("未知の status の回は採らない", () => {
    const a = analysis(R11);
    const [race] = build([a], [closeRound(a, 2, { status: "weird" })]).races;
    expect(race).toMatchObject({ source: "analysis", round: null });
  });

  it("別の分析の close 行は混ざらない(analysis_id で結ぶ)", () => {
    const a = analysis(R11);
    const b = analysis(R12);
    const races = build([a, b], [closeRound(b, 2)]).races;
    expect(races.find((r) => r.race_id === R11)).toMatchObject({ source: "analysis" });
    expect(races.find((r) => r.race_id === R12)).toMatchObject({ source: "close", round: 2 });
  });

  it("close を取れなかった(null): 分析時の提案で出す", () => {
    const a = analysis(R11);
    expect(build([a], null).races[0]).toMatchObject({ source: "analysis", round: null });
  });

  it("定数にない回(3)は『第3回』の文言になる", () => {
    const a = analysis(R11);
    expect(build([a], [closeRound(a, 3)]).races[0]!.detail).toBe("3点 700円 EV 1.31・第3回の再計算");
  });
});

describe("載せる条件・見送り", () => {
  it("分析時 0 点で close なし: 載せない(分析済みの件数には数える)", () => {
    const view = build([analysis(R11, { betCount: 0, totalStake: 0, maxEv: null })]);
    expect(view.races).toEqual([]);
    expect(view.summary).toBe("分析済み 1 レースのうち、狙い目はありません");
  });

  it("分析時 0 点でも、ok の回で 1 点以上になったら載せる(狙い目)", () => {
    const a = analysis(R11, { betCount: 0, totalStake: 0, maxEv: null });
    const [race] = build([a], [closeRound(a, 1)]).races;
    expect(race).toMatchObject({ round: 1, bet_count: 3, skipped: false });
  });

  it("分析時 5 点で、ok の回が 0 点: 『見送り』として行を残す", () => {
    const a = analysis(R11);
    const view = build([a], [closeRound(a, 2, { betCount: 0, totalStake: 0, maxEv: null })]);
    expect(view.races).toHaveLength(1);
    expect(view.races[0]).toMatchObject({ skipped: true, round: 2, bet_count: 0, total_stake: 0, max_ev: null });
    expect(view.races[0]!.detail).toBe("見送り・発走2分前の再計算で0点");
    expect(view.summary).toBe("分析済み 1 レースのうち、狙い目はありません(見送り 1)");
  });

  it("分析時 0 点で、ok の回も 0 点: 載せない(見送りでもない。もともと提案が無い)", () => {
    const a = analysis(R11, { betCount: 0, totalStake: 0, maxEv: null });
    expect(build([a], [closeRound(a, 1, { betCount: 0, totalStake: 0, maxEv: null })]).races).toEqual([]);
  });

  it("回 2 が 0 点・回 1 が 5 点: 最新の回 2 を採って見送り(古い回で狙い目に戻さない)", () => {
    const a = analysis(R11);
    const view = build([a], [closeRound(a, 1, { betCount: 5 }), closeRound(a, 2, { betCount: 0, totalStake: 0, maxEv: null })]);
    expect(view.races[0]).toMatchObject({ skipped: true, round: 2 });
  });

  it("最大 EV が null の買い目: 『EV』の語を出さない", () => {
    expect(build([analysis(R11, { betCount: 1, totalStake: 100, maxEv: null })]).races[0]!.detail).toBe("1点 100円・分析時");
  });

  it("退化: 買い目 1 点でも点数と合計はその値(1 点・100 円)", () => {
    const race = build([analysis(R11, { betCount: 1, totalStake: 100, maxEv: 2 })]).races[0]!;
    expect(race.bet_count).toBe(1);
    expect(race.detail).toBe("1点 100円 EV 2.00・分析時");
  });

  it("合計が 1,000 円以上は桁区切りになる", () => {
    expect(build([analysis(R11, { totalStake: 12345 })]).races[0]!.detail).toContain("12,345円");
  });
});

describe("◎の馬", () => {
  it("馬番があれば『◎7』、無ければ null", () => {
    expect(build([analysis(R11, { markUmaban: 7 })]).races[0]!.pick).toBe("◎7");
    expect(build([analysis(R11, { markUmaban: null })]).races[0]!.pick).toBeNull();
  });
});

describe("発走時刻・場・R(計画の行があれば優先。無ければ race_id から)", () => {
  it("計画の行: start_time から start_ms(JST → UTC)と場・R を作る", () => {
    const race = build([analysis(R11)], [], [planRow(R11, "15:40", "東京", 11)]).races[0]!;
    expect(race.start_time).toBe("15:40");
    expect(race.start_ms).toBe(Date.parse("2026-10-17T06:40:00Z"));
    expect(race.place).toBe("東京11R");
  });

  it("計画の行が無い / 計画を取れなかった(null): 時刻は null、場・R は race_id から導く(例外にしない)", () => {
    for (const plan of [null, []]) {
      const race = build([analysis(R11)], [], plan).races[0]!;
      expect(race.start_time).toBeNull();
      expect(race.start_ms).toBeNull();
      expect(race.place).toBe("東京11R");
    }
  });

  it("計画の行の start_time が null・壊れた形(25:99)でも例外にしない(時刻なし)", () => {
    for (const startTime of [null, "25:99", "abc", ""]) {
      const race = build([analysis(R11)], [], [planRow(R11, startTime)]).races[0]!;
      expect(race.start_ms, String(startTime)).toBeNull();
      expect(race.start_time, String(startTime)).toBeNull();
    }
  });

  it("計画の場名・R が null: race_id から補う", () => {
    expect(build([analysis(R11)], [], [planRow(R11, "15:40", null, null)]).races[0]!.place).toBe("東京11R");
  });

  it("race_id が 12 桁でない: 場は『会場不明』、R は付けない(例外にしない)", () => {
    expect(build([analysis("X-1")], []).races[0]!.place).toBe("会場不明");
  });

  it("12 桁だが場コードが未知(中央にも地方にも無い 99): 例外にせず『会場不明』に落とし、R は race_id の末尾から付ける(analysis-view と同じ扱い)", () => {
    const unknown = "202699050811";
    // 前提: core の関数は、この場コードで実際に投げる(落とす処理が空振りでない)
    expect(() => venueNameFromRaceId(unknown)).toThrow();
    const view = build([analysis(unknown)], []);
    expect(view.races).toHaveLength(1);
    expect(view.races[0]!.place).toBe("会場不明11R");
  });

  it("計画の場名があれば、場コードが未知でも計画の場名を使う", () => {
    expect(build([analysis("202699050811")], [], [planRow("202699050811", "15:40", "東京", 11)]).races[0]!.place).toBe("東京11R");
  });
});

describe("並びと要約", () => {
  it("発走時刻の昇順、時刻なしは末尾、同じなら race_id の昇順(サーバの基準の並び)", () => {
    const ids = ["202605050801", "202605050802", "202605050803", "202605050804"];
    const analyses = ids.map((id) => analysis(id));
    const plan = [planRow(ids[0]!, "15:00"), planRow(ids[1]!, null), planRow(ids[2]!, "10:00"), planRow(ids[3]!, "15:00")];
    expect(build(analyses, [], plan).races.map((r) => r.race_id)).toEqual([ids[2], ids[0], ids[3], ids[1]]);
  });

  it("分析 0 件: 『まだ分析されたレースがありません』", () => {
    const view = build([]);
    expect(view.races).toEqual([]);
    expect(view.summary).toBe("まだ分析されたレースがありません");
  });

  it("狙い目 2・分析済み 3(1 つは提案なし): 『分析済み 3 レース中、狙い目 2』", () => {
    const view = build([analysis("202605050801"), analysis("202605050802"), analysis("202605050803", { betCount: 0, totalStake: 0, maxEv: null })]);
    expect(view.races).toHaveLength(2);
    expect(view.summary).toBe("分析済み 3 レース中、狙い目 2");
  });

  it("見送りがあるときは、狙い目がある場合も件数を添える", () => {
    const a = analysis("202605050801");
    const b = analysis("202605050802");
    const view = build([a, b], [closeRound(b, 1, { betCount: 0, totalStake: 0, maxEv: null })]);
    expect(view.summary).toBe("分析済み 2 レース中、狙い目 1(見送り 1)");
  });

  it("now_ms と kaisai_date を返す(クライアントの時計のずれの補正用)", () => {
    const view = build([]);
    expect(view.now_ms).toBe(NOW);
    expect(view.kaisai_date).toBe(DATE);
  });

  it("応答の各レースのキーは許可したものだけ(内部の列を展開して漏らさない)", () => {
    const race = build([analysis(R11)], [], [planRow(R11, "15:40")]).races[0]!;
    expect(Object.keys(race).sort()).toEqual(["analysis_id", "bet_count", "detail", "max_ev", "pick", "place", "race_id", "round", "skipped", "source", "start_ms", "start_time", "total_stake"]);
  });
});
