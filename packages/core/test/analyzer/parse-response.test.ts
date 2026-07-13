/**
 * レスポンス処理(JSON抽出・バリデーション・±10%クリップ・馬番欠け補完)の純関数テスト。
 *
 * 仕様「3. analyzer」:
 *  - LLM出力からJSONを抽出(コードフェンス・前後テキストの揺れに耐性)
 *  - place_prob が prior から ±10%(絶対値0.10)以内か検証し、逸脱は prior±0.10 にクリップ(記録)
 *  - 欠けた馬番は prior をそのまま使用(記録)
 *
 * Task#22(予想印): mark フィールドの検証を追加。
 *  - ◎・〇・▲はちょうど1頭ずつ、△は1〜3頭、☆・注は0〜1頭。違反は AnalyzerResponseParseError。
 *  - 未知の印文字列も AnalyzerResponseParseError。
 *  - mark がJSONに完全に欠けている(旧形式)場合は◎が0頭になり制約違反としてエラー。
 */

import { describe, expect, it } from "vitest";
import {
  AnalyzerResponseParseError,
  extractJsonObject,
  parseAnalyzerResponse,
  type PredictionMark,
  type PriorRef,
} from "../../src/analyzer/parse-response.js";

const priors: PriorRef[] = [
  { umaban: 1, prior: 0.4 },
  { umaban: 2, prior: 0.2 },
  // 予想印の頭数制約(◎〇▲△を最低1頭ずつ)を満たすための埋め合わせ馬(3〜6番)。
  // クリップ・欠け等の検証対象(馬番1・2)は印を持たない(null)ままにでき、
  // 本来の検証観点(place_prob の扱い)をぼかさないためにこの4頭で印制約を完結させる。
  { umaban: 3, prior: 0.3 },
  { umaban: 4, prior: 0.3 },
  { umaban: 5, prior: 0.3 },
  { umaban: 6, prior: 0.3 },
];

function body(horses: unknown): string {
  return JSON.stringify({ horses });
}

/** 予想印の頭数制約(◎〇▲△を1頭ずつ)を満たすための埋め合わせ馬(3〜6番)のJSON片。 */
function fillerMarkHorses(): unknown[] {
  return [
    { number: 3, place_prob: 0.3, reason: "filler", mark: "◎" },
    { number: 4, place_prob: 0.3, reason: "filler", mark: "〇" },
    { number: 5, place_prob: 0.3, reason: "filler", mark: "▲" },
    { number: 6, place_prob: 0.3, reason: "filler", mark: "△" },
  ];
}

/** 印制約の埋め合わせ馬を加えた body() を作る(place_prob等の検証テストで使う)。 */
function bodyWithFillers(focusHorses: unknown[]): string {
  return body([...focusHorses, ...fillerMarkHorses()]);
}

describe("extractJsonObject(JSON抽出の揺れ耐性)", () => {
  const cases: ReadonlyArray<{ label: string; text: string }> = [
    { label: "素のJSON", text: '{"horses":[]}' },
    { label: "```json フェンス付き", text: '```json\n{"horses":[]}\n```' },
    { label: "``` 素フェンス付き", text: '```\n{"horses":[]}\n```' },
    {
      label: "前後に説明文がある",
      text: 'こちらが結果です:\n{"horses":[]}\nよろしくお願いします。',
    },
  ];
  it.each(cases)("$label からオブジェクトを取り出せること", ({ text }) => {
    const obj = extractJsonObject(text) as { horses: unknown[] };
    expect(obj.horses).toEqual([]);
  });

  it("JSONが無ければ AnalyzerResponseParseError を投げること", () => {
    expect(() => extractJsonObject("これはJSONを含みません")).toThrow(
      AnalyzerResponseParseError,
    );
  });

  it("壊れたJSONは AnalyzerResponseParseError を投げること", () => {
    expect(() => extractJsonObject('{"horses": [')).toThrow(
      AnalyzerResponseParseError,
    );
  });
});

describe("parseAnalyzerResponse(バリデーション・クリップ)", () => {
  it("正常系: 範囲内はそのまま補正後確率になること", () => {
    const text = bodyWithFillers([
      { number: 1, place_prob: 0.45, reason: "調教良化" },
      { number: 2, place_prob: 0.15, reason: "展開不利" },
    ]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 10);
    expect(h1.clipped).toBe(false);
    expect(h1.usedPrior).toBe(false);
    expect(h1.reason).toBe("調教良化");
    expect(r.clippedCount).toBe(0);
    expect(r.missingCount).toBe(0);
  });

  // クリップ境界: prior=0.40 に対し +0.10 ちょうど(0.50)はOK、+0.101(0.501)はクリップ。
  const clipCases: ReadonlyArray<{
    label: string;
    value: number;
    expected: number;
    clipped: boolean;
  }> = [
    { label: "+0.10ちょうどは非クリップ", value: 0.5, expected: 0.5, clipped: false },
    { label: "+0.101はクリップ", value: 0.501, expected: 0.5, clipped: true },
    { label: "-0.10ちょうどは非クリップ", value: 0.3, expected: 0.3, clipped: false },
    { label: "-0.101はクリップ", value: 0.299, expected: 0.3, clipped: true },
    { label: "大幅超過は上限へ", value: 0.99, expected: 0.5, clipped: true },
    { label: "1超は上限へ(かつ[0,1])", value: 1.5, expected: 0.5, clipped: true },
  ];
  it.each(clipCases)("馬番1(prior=0.40): $label", ({ value, expected, clipped }) => {
    const text = bodyWithFillers([{ number: 1, place_prob: value, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(expected, 9);
    expect(h1.clipped).toBe(clipped);
  });

  it("[0,1]下限クリップ: prior=0.20 で負値は0へ", () => {
    // prior 0.20 の下限は max(0, 0.10)=0.10。-0.5 は 0.10 へクリップ。
    const text = bodyWithFillers([{ number: 2, place_prob: -0.5, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors);
    const h2 = r.horses.find((h) => h.umaban === 2)!;
    expect(h2.adjustedProb).toBeCloseTo(0.1, 9);
    expect(h2.clipped).toBe(true);
  });

  it("馬番欠け: prior をそのまま使い記録すること", () => {
    // 馬番2 のみ回答 → 馬番1 は欠け(印の頭数制約は埋め合わせ馬3〜6番で満たす)。
    const text = bodyWithFillers([{ number: 2, place_prob: 0.2, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.usedPrior).toBe(true);
    expect(h1.adjustedProb).toBeCloseTo(0.4, 10);
    expect(h1.mark).toBeNull();
    expect(r.missingCount).toBe(1);
  });

  it("不正な place_prob(数値でない)は prior 採用として記録すること", () => {
    const text = bodyWithFillers([
      { number: 1, place_prob: "たかい", reason: "x" },
      { number: 2, place_prob: 0.2, reason: "y" },
    ]);
    const r = parseAnalyzerResponse(text, priors);
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.usedPrior).toBe(true);
    expect(h1.adjustedProb).toBeCloseTo(0.4, 10);
  });

  it("priors に無い余分な馬番は無視されること", () => {
    const text = bodyWithFillers([
      { number: 1, place_prob: 0.4, reason: "x" },
      { number: 2, place_prob: 0.2, reason: "y" },
      { number: 99, place_prob: 0.5, reason: "存在しない" },
    ]);
    const r = parseAnalyzerResponse(text, priors);
    expect(r.horses.map((h) => h.umaban).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("空の horses(有効な補正0件)はパース失敗として例外を投げること", () => {
    // スキーマ妥当だが実質失敗(全馬 prior のまま)→ リトライ/フォールバックに回すため例外にする。
    expect(() => parseAnalyzerResponse(body([]), priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });

  it("全馬番が余分(有効な補正0件)でもパース失敗として例外を投げること", () => {
    const text = body([{ number: 99, place_prob: 0.5, reason: "存在しない" }]);
    expect(() => parseAnalyzerResponse(text, priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });

  it("maxAdjust を config で狭められること(0.05でクリップ幅が縮む)", () => {
    // prior=0.40、maxAdjust=0.05 → 上限0.45。0.48 は 0.45 へクリップ。
    const text = bodyWithFillers([{ number: 1, place_prob: 0.48, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors, { maxAdjust: 0.05 });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.45, 9);
    expect(h1.clipped).toBe(true);
  });

  it("JSON抽出不能は AnalyzerResponseParseError を投げること", () => {
    expect(() => parseAnalyzerResponse("no json here", priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });
});

describe("parseAnalyzerResponse(予想印 mark の検証・Task#22)", () => {
  /** umaban 1..n の PriorRef を作る(place_prob=prior=0.3固定でクリップ・欠け判定に影響させない)。 */
  function priorsN(n: number): PriorRef[] {
    return Array.from({ length: n }, (_, i) => ({ umaban: i + 1, prior: 0.3 }));
  }

  /**
   * marks[i] を umaban i+1 の mark として持つ horses 配列のJSON文字列を作る。
   * undefined を渡すと mark キー自体を省略する(JSON.stringifyがundefined値のキーを落とす)。
   */
  function markBody(
    marks: ReadonlyArray<PredictionMark | null | undefined>,
  ): string {
    const horses = marks.map((m, i) => ({
      number: i + 1,
      place_prob: 0.3,
      reason: "x",
      mark: m,
    }));
    return JSON.stringify({ horses });
  }

  it("正常系: 頭数制約を満たせば各馬のmarkが反映されること(印なし・explicit nullも許容)", () => {
    const marks: Array<PredictionMark | null> = [
      "◎",
      "〇",
      "▲",
      "△",
      "△",
      "☆",
      null, // 7頭目は明示的に印なし。
    ];
    const r = parseAnalyzerResponse(markBody(marks), priorsN(7));
    expect(r.horses.find((h) => h.umaban === 1)!.mark).toBe("◎");
    expect(r.horses.find((h) => h.umaban === 2)!.mark).toBe("〇");
    expect(r.horses.find((h) => h.umaban === 3)!.mark).toBe("▲");
    expect(r.horses.find((h) => h.umaban === 4)!.mark).toBe("△");
    expect(r.horses.find((h) => h.umaban === 6)!.mark).toBe("☆");
    expect(r.horses.find((h) => h.umaban === 7)!.mark).toBeNull();
  });

  it("馬番が重複した場合、place_prob・mark とも最初の出現のみ採用され2件目は無視されること(仕様固定)", () => {
    // priorsN の prior は 0.3(±0.10 の範囲は [0.2, 0.4])。馬番1が2回出現し、
    // 1件目(place_prob=0.35, mark=◎)が採用され、
    // 2件目(place_prob=0.39, mark=〇)は byNumber.has(num) ガードにより丸ごと無視される。
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.35, reason: "1件目(採用される)", mark: "◎" },
        { number: 1, place_prob: 0.39, reason: "2件目(無視される)", mark: "〇" },
        { number: 2, place_prob: 0.3, reason: "y", mark: "〇" },
        { number: 3, place_prob: 0.3, reason: "z", mark: "▲" },
        { number: 4, place_prob: 0.3, reason: "w", mark: "△" },
      ],
    });
    const r = parseAnalyzerResponse(text, priorsN(4));
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    // 1件目の値(place_prob=0.35・mark=◎・reason)が採用されること。
    expect(h1.adjustedProb).toBeCloseTo(0.35, 10);
    expect(h1.reason).toBe("1件目(採用される)");
    expect(h1.mark).toBe("◎");
    // 2件目の mark(〇)が重複加算されず、◎・〇ともちょうど1頭のまま(頭数制約も破られない)こと。
    expect(r.horses.filter((h) => h.mark === "◎")).toHaveLength(1);
    expect(r.horses.filter((h) => h.mark === "〇")).toHaveLength(1);
  });

  // 頭数制約違反のテーブル駆動テスト(境界値含む)。違反があれば必ず AnalyzerResponseParseError。
  const violationCases: ReadonlyArray<{
    label: string;
    priorsCount: number;
    marks: ReadonlyArray<PredictionMark | null | undefined>;
  }> = [
    {
      label: "◎が0頭",
      priorsCount: 6,
      marks: [null, "〇", "▲", "△", "☆", "注"],
    },
    {
      label: "◎が2頭",
      priorsCount: 6,
      marks: ["◎", "◎", "▲", "△", "☆", "注"],
    },
    {
      label: "〇が0頭",
      priorsCount: 6,
      marks: ["◎", null, "▲", "△", "☆", "注"],
    },
    {
      label: "〇が2頭",
      priorsCount: 6,
      marks: ["◎", "〇", "〇", "△", "☆", "注"],
    },
    {
      label: "▲が0頭",
      priorsCount: 6,
      marks: ["◎", "〇", null, "△", "☆", "注"],
    },
    {
      label: "▲が2頭",
      priorsCount: 6,
      marks: ["◎", "〇", "▲", "▲", "☆", "注"],
    },
    {
      label: "△が0頭(境界: 下限1に満たない)",
      priorsCount: 6,
      marks: ["◎", "〇", "▲", null, "☆", "注"],
    },
    {
      label: "△が4頭(境界: 上限3を超える)",
      priorsCount: 7,
      marks: ["◎", "〇", "▲", "△", "△", "△", "△"],
    },
    {
      label: "☆が2頭(境界: 上限1を超える)",
      priorsCount: 6,
      marks: ["◎", "〇", "▲", "△", "☆", "☆"],
    },
    {
      label: "注が2頭(境界: 上限1を超える)",
      priorsCount: 6,
      marks: ["◎", "〇", "▲", "△", "注", "注"],
    },
    {
      label: "markフィールドが完全に欠落(旧形式)→◎0頭として制約違反",
      priorsCount: 6,
      marks: [undefined, undefined, undefined, undefined, undefined, undefined],
    },
  ];
  it.each(violationCases)("$label は AnalyzerResponseParseError", ({ priorsCount, marks }) => {
    expect(() =>
      parseAnalyzerResponse(markBody(marks), priorsN(priorsCount)),
    ).toThrow(AnalyzerResponseParseError);
  });

  it("未知の印文字列は AnalyzerResponseParseError を投げること", () => {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.4, reason: "x", mark: "◇" },
        { number: 2, place_prob: 0.2, reason: "y", mark: null },
      ],
    });
    expect(() => parseAnalyzerResponse(text, priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });

  it("priorsに無い余分な馬番のmarkは無視され、制約カウントに含まれないこと", () => {
    // 実質2頭(◎〇のみ必須が満たせない)だが、余分な馬番(99)の印は無視されるため
    // 全体の制約違反(◎〇▲が各1頭に満たない)としてエラーになる。
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.4, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.2, reason: "y", mark: "〇" },
        { number: 99, place_prob: 0.5, reason: "存在しない", mark: "▲" },
      ],
    });
    expect(() => parseAnalyzerResponse(text, priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });
});

describe("parseAnalyzerResponse(予想印 mark の同形異字正規化・Task#23)", () => {
  /** umaban 1..n の PriorRef を作る(place_prob=prior=0.3固定でクリップ・欠け判定に影響させない)。 */
  function priorsN(n: number): PriorRef[] {
    return Array.from({ length: n }, (_, i) => ({ umaban: i + 1, prior: 0.3 }));
  }

  // 「〇」(U+3007 IDEOGRAPHIC NUMBER ZERO)と見た目が似た同形異字は正規化して受理する。
  const acceptedAliasCases: ReadonlyArray<{ label: string; raw: string }> = [
    { label: "U+25CB WHITE CIRCLE(○)は〇として受理される", raw: "○" },
    { label: "U+25EF LARGE CIRCLE(◯)は〇として受理される", raw: "◯" },
  ];
  it.each(acceptedAliasCases)("$label", ({ raw }) => {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.3, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.3, reason: "y", mark: raw },
        { number: 3, place_prob: 0.3, reason: "z", mark: "▲" },
        { number: 4, place_prob: 0.3, reason: "w", mark: "△" },
      ],
    });
    const r = parseAnalyzerResponse(text, priorsN(4));
    expect(r.horses.find((h) => h.umaban === 2)!.mark).toBe("〇");
  });

  it("正規化対象以外の未知の同形異字(●黒丸)は従来どおりエラーになること", () => {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.3, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.3, reason: "y", mark: "●" }, // U+25CF BLACK CIRCLE(正規化対象外)
        { number: 3, place_prob: 0.3, reason: "z", mark: "▲" },
        { number: 4, place_prob: 0.3, reason: "w", mark: "△" },
      ],
    });
    expect(() => parseAnalyzerResponse(text, priorsN(4))).toThrow(
      AnalyzerResponseParseError,
    );
  });
});
