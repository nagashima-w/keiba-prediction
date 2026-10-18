import { describe, expect, it } from "vitest";
import type { StoredAnalysis, StoredAnalysisHorse } from "../../packages/core/src/ev/analysis-store-types";
import { TIME_INDEX_NAME, TIME_INDEX_RECENT_RUNS } from "../../packages/core/src/scorer/time-index";
import { buildAnalysisView } from "../src/analysis-view";
import type { AnalysisDetailResult, DetailStatus } from "../src/analysis-repository";

/**
 * Issue #359: `GET /api/analyses/{id}` の馬ごとの `timeIndexLine`(「タイム指数 +1.2(レース内 2位)」)と、レースごとの `timeIndexNote`(説明の 1 行)。
 * 材料は R2 の詳細に保存済みの馬ごとの contributions のうち、`biasName === "タイム指数"` の要素の `targetRate`(馬の代表値。秒/km)。新しい計算・取得はしない。
 * 文言はサーバで組み立てる(クライアントに日本語を置くと `\uXXXX` で 1 文字 6 バイトになるため)。
 */

/** タイム指数の寄与度の 1 要素(core の `ScoreContribution` と同じキー)。 */
function tiContribution(targetRate: unknown): Record<string, unknown> {
  return { biasName: TIME_INDEX_NAME, applied: targetRate !== null, reason: "r", weight: 0.12, correction: 0, sampleCount: 3, targetRate, overallRate: 1 };
}

/** 別の項目の寄与度(targetRate が入っていても、タイム指数として拾ってはならない)。 */
const OTHER = { biasName: "近走着順", applied: true, reason: "r", weight: 0.1, correction: 0.01, sampleCount: 5, targetRate: 9.9, overallRate: 0.3 };

function horse(umaban: number, contributions: unknown): StoredAnalysisHorse {
  return { umaban, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: true, contributions, mark: null, reason: null, highlights: [], concerns: [] } as StoredAnalysisHorse;
}

/** 各馬のタイム指数の代表値(null = 値なし)から、contributions にタイム指数の要素を持つ馬を作る。 */
function horsesOf(values: readonly (number | null)[]): StoredAnalysisHorse[] {
  return values.map((v, i) => horse(i + 1, [OTHER, tiContribution(v)]));
}

function result(horses: StoredAnalysisHorse[], status: DetailStatus = "present"): AnalysisDetailResult {
  const analysis = {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    horses,
    evEstimated: false,
    promptVersion: "2026-10-18.2",
    additionalInstruction: null,
    kaisaiDate: "20260628",
    model: "claude-sonnet-5-5",
    rawResponse: null,
    raceSnapshot: { race: { raceName: "テスト", courseType: "芝" }, horses: [] },
    historyCutoffDate: "20260627",
  } as StoredAnalysis;
  return { analysis, detail: status, llmNote: null, llmCalls: null };
}

const linesOf = (values: readonly (number | null)[]): (string | null | undefined)[] => buildAnalysisView(result(horsesOf(values)), undefined).horses.map((h) => h.timeIndexLine);

describe("buildAnalysisView の timeIndexLine(Issue #359)", () => {
  it("値と、値のある馬だけの中での順位(大きい順。同値は同順位で 1,2,2,4)を文言にする", () => {
    // 値: 馬1=+0.5, 馬2=+3.0, 馬3=-1.2, 馬4=+0.5(馬1と同値), 馬5=値なし, 馬6=+1.0
    const lines = linesOf([0.5, 3.0, -1.2, 0.5, null, 1.0]);
    expect(lines).toEqual([
      "タイム指数 +0.5(レース内 3位)",
      "タイム指数 +3.0(レース内 1位)",
      "タイム指数 -1.2(レース内 5位)",
      "タイム指数 +0.5(レース内 3位)",
      "タイム指数 —",
      "タイム指数 +1.0(レース内 2位)",
    ]);
  });

  it("同値は同順位で、次の順位は飛ぶ(1,2,2,4)", () => {
    const lines = linesOf([2.0, 1.0, 1.0, 0.0]);
    expect(lines).toEqual(["タイム指数 +2.0(レース内 1位)", "タイム指数 +1.0(レース内 2位)", "タイム指数 +1.0(レース内 2位)", "タイム指数 0.0(レース内 4位)"]);
  });

  it("順位は丸める前の値で比べる(表示が同じ +1.2 でも、1.24 と 1.21 は 1位と2位)", () => {
    const lines = linesOf([1.21, 1.24]);
    expect(lines[0]).toContain("+1.2");
    expect(lines[1]).toContain("+1.2"); // 前提: 丸めた表示は同じ
    expect(lines).toEqual(["タイム指数 +1.2(レース内 2位)", "タイム指数 +1.2(レース内 1位)"]);
  });

  it("値の書き方: 小数 1 桁・正は + 付き・負は ASCII の -・丸めて 0 になる値は『0.0』(+0.0・-0.0 にしない)", () => {
    const cases: readonly (readonly [number, string])[] = [
      [1.234, "+1.2"],
      [1.25, "+1.3"], // toFixed の丸めに従う(2 進で 1.25 ちょうど)
      [3, "+3.0"],
      [-1.26, "-1.3"],
      [-0.04, "0.0"],
      [0.04, "0.0"],
      [0, "0.0"],
      [-0, "0.0"],
      [-0.06, "-0.1"],
      [0.06, "+0.1"],
    ];
    for (const [value, text] of cases) {
      // 2 頭にして、片方を固定の小さな値(順位だけに効く)にする
      const line = linesOf([value, -100])[0];
      expect(line, String(value)).toBe(`タイム指数 ${text}(レース内 1位)`);
    }
  });

  it("値の無い馬は『タイム指数 —』(U+2014)。値の無い馬は順位に数えず、他の馬の順位を動かさない", () => {
    const withGaps = linesOf([null, 2.0, null, 1.0, null]);
    const compact = linesOf([2.0, 1.0]);
    expect(withGaps).toEqual(["タイム指数 —", "タイム指数 +2.0(レース内 1位)", "タイム指数 —", "タイム指数 +1.0(レース内 2位)", "タイム指数 —"]);
    expect(withGaps[1]).toBe(compact[0]);
    expect(withGaps[3]).toBe(compact[1]);
    expect("—".charCodeAt(0)).toBe(0x2014);
  });

  it("値のある馬が 1 頭だけでも、その馬は『レース内 1位』を出す(出さないのは 0 頭のときだけ)。他の馬は『—』", () => {
    expect(linesOf([null, 0.8, null])).toEqual(["タイム指数 —", "タイム指数 +0.8(レース内 1位)", "タイム指数 —"]);
  });

  it("値のある馬が 1 頭もいないとき(地方・障害・全馬が値なし)は、全馬の timeIndexLine と timeIndexNote が null", () => {
    const view = buildAnalysisView(result(horsesOf([null, null, null])), undefined);
    expect(view.horses).toHaveLength(3);
    expect(view.horses.map((h) => h.timeIndexLine)).toEqual([null, null, null]);
    expect(view.timeIndexNote).toBeNull();
  });

  it("#353 より前の版(contributions にタイム指数の要素が無い)・contributions が null の分析は、全馬 null・注記 null", () => {
    for (const contributions of [[OTHER], [], null]) {
      const view = buildAnalysisView(result([horse(1, contributions), horse(2, contributions)]), undefined);
      expect(view.horses.map((h) => h.timeIndexLine)).toEqual([null, null]);
      expect(view.timeIndexNote).toBeNull();
    }
  });

  it("詳細が present でない(none・missing)ときは、材料があっても全馬 null・注記 null", () => {
    for (const status of ["none", "missing"] as const) {
      const view = buildAnalysisView(result(horsesOf([1.0, 2.0]), status), undefined);
      expect(view.horses.map((h) => h.timeIndexLine), status).toEqual([null, null]);
      expect(view.timeIndexNote, status).toBeNull();
    }
    // 前提: present なら同じ材料で出る(空振りでない)
    expect(linesOf([1.0, 2.0])[0]).not.toBeNull();
  });

  it("壊れた contributions では投げず、その馬を『値なし』として扱う(配列でない・要素が null や文字列・targetRate が文字列や非有限)", () => {
    const broken: readonly unknown[] = ["x", 5, { biasName: TIME_INDEX_NAME, targetRate: 1 }, [null, "x", 3], [tiContribution("1.5")], [tiContribution(Infinity)], [tiContribution(NaN)], [tiContribution(undefined)], [tiContribution(null)], [{ biasName: TIME_INDEX_NAME }]];
    for (const contributions of broken) {
      const view = buildAnalysisView(result([horse(1, contributions), horse(2, [tiContribution(2.0)])]), undefined);
      expect(view.horses.map((h) => h.timeIndexLine), JSON.stringify(contributions)).toEqual(["タイム指数 —", "タイム指数 +2.0(レース内 1位)"]);
    }
  });

  it("タイム指数の要素だけを拾う(他の項目の targetRate は使わない)。要素の位置は問わない", () => {
    const view = buildAnalysisView(result([horse(1, [tiContribution(0.5), OTHER]), horse(2, [OTHER, tiContribution(1.5)]), horse(3, [OTHER])]), undefined);
    expect(view.horses.map((h) => h.timeIndexLine)).toEqual(["タイム指数 +0.5(レース内 2位)", "タイム指数 +1.5(レース内 1位)", "タイム指数 —"]);
  });

  it("タイム指数の要素が複数あるときは、最初の 1 つを使う(Issue #373。値が有効で異なる重複だけを固定する。順位の比較にも最初の値を使う)", () => {
    // 馬1: 最初が +1.0・あとが +9.0。馬2: 最初が +9.0・あとが +1.0。馬3: 単独 +5.0(最初の値で比べると 馬2 > 馬3 > 馬1、最後の値で比べると 馬1 > 馬3 > 馬2)
    const view = buildAnalysisView(
      result([horse(1, [OTHER, tiContribution(1.0), tiContribution(9.0)]), horse(2, [tiContribution(9.0), OTHER, tiContribution(1.0)]), horse(3, [tiContribution(5.0)])]),
      undefined,
    );
    expect(view.horses.map((h) => h.timeIndexLine)).toEqual(["タイム指数 +1.0(レース内 3位)", "タイム指数 +9.0(レース内 1位)", "タイム指数 +5.0(レース内 2位)"]);
  });

  it("値のある馬が 2 頭未満のレース(applied:false だが targetRate は入る)でも、targetRate を値として使う", () => {
    const only = horse(1, [{ ...tiContribution(0.8), applied: false, overallRate: null }]);
    expect(buildAnalysisView(result([only, horse(2, [tiContribution(null)])]), undefined).horses.map((h) => h.timeIndexLine)).toEqual(["タイム指数 +0.8(レース内 1位)", "タイム指数 —"]);
  });

  it("キーは常にある(null を含む)。馬 0 頭でも投げない", () => {
    const view = buildAnalysisView(result(horsesOf([null, null])), undefined);
    for (const h of view.horses) expect("timeIndexLine" in h).toBe(true);
    expect("timeIndexNote" in view).toBe(true);
    const empty = buildAnalysisView(result([]), undefined);
    expect(empty.horses).toEqual([]);
    expect(empty.timeIndexNote).toBeNull();
  });
});

describe("buildAnalysisView の timeIndexNote(Issue #359)", () => {
  it("値のある馬がいるとき、説明の 1 行を返す(指数の名前と直近の走数は core の定数から組み立てる)", () => {
    const view = buildAnalysisView(result(horsesOf([1.0, null])), undefined);
    expect(view.timeIndexNote).toBe(`${TIME_INDEX_NAME}: 基準タイムより 1000m あたり何秒速いか(指数を出せた直近${TIME_INDEX_RECENT_RUNS}走の最高。大きいほど速い)。中央の芝・ダートのみ。`);
    expect(view.timeIndexNote).toContain("直近5走"); // 定数が 5 であることの固定(定数を変えたらここで気づく)
    expect(TIME_INDEX_RECENT_RUNS).toBe(5);
  });

  it("値のある馬の数に依らず同じ文(1 頭でも出る)", () => {
    const one = buildAnalysisView(result(horsesOf([1.0, null, null])), undefined).timeIndexNote;
    const many = buildAnalysisView(result(horsesOf([1.0, 2.0, 3.0])), undefined).timeIndexNote;
    expect(one).not.toBeNull();
    expect(one).toBe(many);
  });

  it("応答の他の項目と独立: 馬の contributions そのものは応答に載せない", () => {
    const view = buildAnalysisView(result(horsesOf([1.0, 2.0])), undefined);
    expect(JSON.stringify(view)).not.toContain("targetRate");
    expect(JSON.stringify(view)).not.toContain("近走着順");
  });
});
