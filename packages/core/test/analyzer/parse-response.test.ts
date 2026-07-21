/**
 * レスポンス処理(JSON抽出・バリデーション・±10%クリップ・馬番欠け補完)の純関数テスト。
 *
 * 仕様「3. analyzer」:
 *  - LLM出力からJSONを抽出(コードフェンス・前後テキストの揺れに耐性)
 *  - place_prob が prior から ±10%(絶対値0.10)以内か検証し、逸脱は prior±0.10 にクリップ(記録)
 *  - 欠けた馬番は prior をそのまま使用(記録)
 *
 * Task#22(予想印): mark フィールドの検証を追加。
 *  - ◎はちょうど1頭。〇・▲は0〜1頭、△は0〜3頭、☆・注は0〜1頭(頭数制約緩和B-1)。
 *  - 本線印(◎〇▲△)は gapless な優先順位を持つ: ▲を付けるなら〇が1頭以上必要、
 *    △を付けるなら▲が1頭以上必要(結果として △≥1 ⇒ 〇≥1)。合法集合は
 *    {◎}/{◎〇}/{◎〇▲}/{◎〇▲+△(1〜3)}のいずれか。優先順位違反も AnalyzerResponseParseError。
 *  - ☆・注は本線と独立(◎〇▲△の有無に関わらず各0〜1頭、☆注間の順序依存もなし)。
 *  - 未知の印文字列も AnalyzerResponseParseError。
 *  - mark がJSONに完全に欠けている(旧形式)場合は◎が0頭になり制約違反としてエラー。
 *
 * A(フォールバック分離・2026-07-19合意): 印関連の違反(頭数・優先順位・未知の印文字の3種)は、
 * 確率補正(adjustedProb/clipped/reason)の計算自体は正常に完了しているため、それを捨てずに
 * 専用エラー AnalyzerMarkViolationError で「確率補正は保持したまま全馬 mark=null にした結果」を
 * 一緒に運ぶ(analyze-race側がリトライ後もこの違反ならその結果を採用する)。
 * これに対し、印と無関係な失敗(JSON破損・horses配列なし・有効な補正0件)は従来どおり
 * 汎用の AnalyzerResponseParseError のみを投げ、analyze-race側は全馬 prior フォールバックへ回す
 * (この判定順序: 「有効な補正0件」チェックは印関連チェックより必ず先に行う)。
 */

import { describe, expect, it } from "vitest";
import { CLIP_VARIANTS } from "../../src/analyzer/clip-variants.js";
import {
  AnalyzerMarkViolationError,
  AnalyzerResponseParseError,
  AnalyzerTruncationError,
  extractJsonObject,
  parseAnalyzerResponse,
  type ParsedHorseResult,
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

describe("AnalyzerTruncationError(応答がmax_tokensで切り詰められたことを表すエラー)", () => {
  it("AnalyzerResponseParseError のサブクラスであること(既存のinstanceof判定・リトライ意味論を壊さない)", () => {
    const e = new AnalyzerTruncationError("切り詰められました", "max_tokens");
    expect(e).toBeInstanceOf(AnalyzerResponseParseError);
    expect(e).toBeInstanceOf(AnalyzerTruncationError);
    expect(e.name).toBe("AnalyzerTruncationError");
  });

  it("検出した生の stop_reason を保持すること(診断用)", () => {
    const e = new AnalyzerTruncationError("切り詰められました", "max_tokens");
    expect(e.stopReason).toBe("max_tokens");
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

/**
 * クリップ幅版D-2(±0.15)の境界値テスト。
 * maxAdjust は CLIP_VARIANTS.wide15.maxAdjust をそのまま options に渡す(ハードコードした0.15を
 * 二重に持たず、build-prompt.ts の文面生成・pipeline-deps.ts の配線と単一ソースを共有する)。
 */
describe("parseAnalyzerResponse(クリップ幅版D-2: ±0.15)", () => {
  const maxAdjust = CLIP_VARIANTS.wide15.maxAdjust;

  it("CLIP_VARIANTS.wide15.maxAdjust が0.15であること(前提の固定)", () => {
    expect(maxAdjust).toBe(0.15);
  });

  // prior=0.40 に対する境界: +0.15ちょうど(0.55)は非クリップ、+0.16(0.56)はクリップ。
  const clipCases: ReadonlyArray<{
    label: string;
    value: number;
    expected: number;
    clipped: boolean;
  }> = [
    { label: "+0.15ちょうど(0.55)は非クリップ", value: 0.55, expected: 0.55, clipped: false },
    { label: "0.60(+0.20)は0.55へクリップ", value: 0.6, expected: 0.55, clipped: true },
    { label: "0.56(+0.16)は0.55へクリップ", value: 0.56, expected: 0.55, clipped: true },
  ];
  it.each(clipCases)("馬番1(prior=0.40): $label", ({ value, expected, clipped }) => {
    const text = bodyWithFillers([{ number: 1, place_prob: value, reason: "x" }]);
    const r = parseAnalyzerResponse(text, priors, { maxAdjust });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(expected, 9);
    expect(h1.clipped).toBe(clipped);
  });

  it("prior=0.90 の上限は 1.0 にクランプされること(1.05にはならない)", () => {
    const highPriors: PriorRef[] = [
      { umaban: 1, prior: 0.9 },
      { umaban: 3, prior: 0.3 },
      { umaban: 4, prior: 0.3 },
      { umaban: 5, prior: 0.3 },
      { umaban: 6, prior: 0.3 },
    ];
    const text = body([
      { number: 1, place_prob: 1.05, reason: "x" },
      ...fillerMarkHorses(),
    ]);
    const r = parseAnalyzerResponse(text, highPriors, { maxAdjust });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(1.0, 9);
    expect(h1.clipped).toBe(true);
  });

  it("prior=0.10 の下限は 0.0 にクランプされること", () => {
    const lowPriors: PriorRef[] = [
      { umaban: 1, prior: 0.1 },
      { umaban: 3, prior: 0.3 },
      { umaban: 4, prior: 0.3 },
      { umaban: 5, prior: 0.3 },
      { umaban: 6, prior: 0.3 },
    ];
    const text = body([
      { number: 1, place_prob: -0.5, reason: "x" },
      ...fillerMarkHorses(),
    ]);
    const r = parseAnalyzerResponse(text, lowPriors, { maxAdjust });
    const h1 = r.horses.find((h) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.0, 9);
    expect(h1.clipped).toBe(true);
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

  // 頭数制約違反のテーブル駆動テスト(境界値含む)。違反があれば必ず AnalyzerResponseParseError
  // (頭数制約緩和B-1後、〇・▲・△単体の頭数違反として残るのは「下限を持つ上限超過」または
  // 「◎の exactly 1」のみ。〇0頭・▲0頭は下限撤廃により単体では合法になったため、
  // 代わりに△やその上位印との優先順位違反として throw する〈理由コメント更新〉)。
  const violationCases: ReadonlyArray<{
    label: string;
    priorsCount: number;
    marks: ReadonlyArray<PredictionMark | null | undefined>;
  }> = [
    {
      label: "◎が0頭(頭数違反: ◎はちょうど1頭が必須)",
      priorsCount: 6,
      marks: [null, "〇", "▲", "△", "☆", "注"],
    },
    {
      label: "◎が2頭(頭数違反: ◎はちょうど1頭が必須)",
      priorsCount: 6,
      marks: ["◎", "◎", "▲", "△", "☆", "注"],
    },
    {
      label: "〇が0頭かつ▲△あり(優先順位違反: ▲を付けるには〇が1頭以上必要)",
      priorsCount: 6,
      marks: ["◎", null, "▲", "△", "☆", "注"],
    },
    {
      label: "〇が2頭(頭数違反: 上限1を超える)",
      priorsCount: 6,
      marks: ["◎", "〇", "〇", "△", "☆", "注"],
    },
    {
      label: "▲が0頭かつ△あり(優先順位違反: △を付けるには▲が1頭以上必要)",
      priorsCount: 6,
      marks: ["◎", "〇", null, "△", "☆", "注"],
    },
    {
      label: "▲が2頭(頭数違反: 上限1を超える)",
      priorsCount: 6,
      marks: ["◎", "〇", "▲", "▲", "☆", "注"],
    },
    {
      label: "△が4頭(境界: 上限3を超える頭数違反)",
      priorsCount: 7,
      marks: ["◎", "〇", "▲", "△", "△", "△", "△"],
    },
    {
      label: "☆が2頭(境界: 上限1を超える頭数違反)",
      priorsCount: 6,
      marks: ["◎", "〇", "▲", "△", "☆", "☆"],
    },
    {
      label: "注が2頭(境界: 上限1を超える頭数違反)",
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

  // 本線印(◎〇▲△)の gapless 優先順位の違反テーブル(頭数は境界内でも順序が飛んでいれば違反)。
  const priorityViolationCases: ReadonlyArray<{
    label: string;
    marks: ReadonlyArray<PredictionMark | null | undefined>;
  }> = [
    {
      label: "{◎▲}: 〇を飛ばして▲のみ付与",
      marks: ["◎", null, "▲", null, null, null],
    },
    {
      label: "{◎〇△}: ▲を飛ばして△のみ付与",
      marks: ["◎", "〇", null, "△", null, null],
    },
  ];
  it.each(priorityViolationCases)(
    "$label は優先順位違反として AnalyzerResponseParseError",
    ({ marks }) => {
      expect(() => parseAnalyzerResponse(markBody(marks), priorsN(6))).toThrow(
        AnalyzerResponseParseError,
      );
    },
  );

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
    // 実質2頭(◎〇のみで▲△の優先順位を満たせない状態ではない)が、
    // 余分な馬番(99)の▲は無視されるため◎〇のみの状態になり、本線としては合法
    // (△を付けていないため優先順位違反にもならない)→ここでは例外にならないことを確認する。
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.4, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.2, reason: "y", mark: "〇" },
        { number: 99, place_prob: 0.5, reason: "存在しない", mark: "▲" },
      ],
    });
    expect(() => parseAnalyzerResponse(text, priors)).not.toThrow();
  });

  it("priorsに無い余分な馬番の▲が無視された結果、本線の優先順位違反になる場合は例外を投げること", () => {
    // 馬番1,2の印は◎〇だが、馬番99(priorsに無い)の△は無視される。
    // 結果、本線は{◎〇}のみで△は実質0頭 → 単体では合法だが、
    // ここでは馬番2をnullにして〇0頭のまま▲を付けた状態を作り、優先順位違反を明示的に確認する。
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.4, reason: "x", mark: "◎" },
        { number: 2, place_prob: 0.2, reason: "y", mark: "▲" },
        { number: 99, place_prob: 0.5, reason: "存在しない", mark: "〇" },
      ],
    });
    expect(() => parseAnalyzerResponse(text, priors)).toThrow(
      AnalyzerResponseParseError,
    );
  });
});

describe("parseAnalyzerResponse(予想印: 頭数制約緩和後の正常系・優先順位・☆注独立/Task#B-1)", () => {
  /** umaban 1..n の PriorRef を作る(place_prob=prior=0.3固定でクリップ・欠け判定に影響させない)。 */
  function priorsN(n: number): PriorRef[] {
    return Array.from({ length: n }, (_, i) => ({ umaban: i + 1, prior: 0.3 }));
  }

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

  // 本線印(◎〇▲△)の合法4集合。gapless優先順位さえ満たせば頭数下限は撤廃されているため通ること。
  const legalMainLineCases: ReadonlyArray<{
    label: string;
    marks: ReadonlyArray<PredictionMark | null | undefined>;
  }> = [
    { label: "{◎}のみ", marks: ["◎", null, null, null, null, null] },
    { label: "{◎〇}", marks: ["◎", "〇", null, null, null, null] },
    { label: "{◎〇▲}", marks: ["◎", "〇", "▲", null, null, null] },
    {
      label: "{◎〇▲+△1頭}",
      marks: ["◎", "〇", "▲", "△", null, null],
    },
    {
      label: "{◎〇▲+△3頭}(上限3頭ちょうど)",
      marks: ["◎", "〇", "▲", "△", "△", "△"],
    },
  ];
  it.each(legalMainLineCases)("$label は合法(例外を投げない)", ({ marks }) => {
    const r = parseAnalyzerResponse(markBody(marks), priorsN(6));
    expect(r.horses.find((h) => h.umaban === 1)!.mark).toBe("◎");
  });

  // ☆・注は本線(◎〇▲△)と独立し、☆注間の順序依存もない(各0〜1頭)。
  const independentStarNoteCases: ReadonlyArray<{
    label: string;
    marks: ReadonlyArray<PredictionMark | null | undefined>;
  }> = [
    { label: "☆のみ(注なし)", marks: ["◎", null, null, null, "☆", null] },
    { label: "注のみ(☆なし)", marks: ["◎", null, null, null, null, "注"] },
    { label: "☆と注の両方", marks: ["◎", null, null, null, "☆", "注"] },
    { label: "☆も注もなし", marks: ["◎", null, null, null, null, null] },
  ];
  it.each(independentStarNoteCases)(
    "$label は合法(本線の印の有無と無関係に成立)",
    ({ marks }) => {
      expect(() => parseAnalyzerResponse(markBody(marks), priorsN(6))).not.toThrow();
    },
  );

  it("◎が欠けていれば☆・注があっても違反になること(☆・注は◎の必須制約を免除しない)", () => {
    const marks: Array<PredictionMark | null> = [
      null,
      null,
      null,
      null,
      "☆",
      "注",
    ];
    expect(() => parseAnalyzerResponse(markBody(marks), priorsN(6))).toThrow(
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

describe("parseAnalyzerResponse(A: 印関連違反時のフォールバック分離・確率補正のレスキュー)", () => {
  /** umaban 1..n の PriorRef を作る(prior=0.3固定)。 */
  function priorsN(n: number): PriorRef[] {
    return Array.from({ length: n }, (_, i) => ({ umaban: i + 1, prior: 0.3 }));
  }

  /** 印以外は正常な確率補正を持つ horses から、AnalyzerMarkViolationError を捕捉して返す。 */
  function captureMarkViolation(text: string, priors: PriorRef[]): AnalyzerMarkViolationError {
    try {
      parseAnalyzerResponse(text, priors);
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerMarkViolationError);
      return e as AnalyzerMarkViolationError;
    }
    throw new Error("AnalyzerMarkViolationError が投げられませんでした");
  }

  it("頭数違反(◎が2頭)でもA救済: 確率補正(adjustedProb/reason)を保持し全馬mark=nullでエラーを投げること", () => {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.35, reason: "根拠1", mark: "◎" },
        { number: 2, place_prob: 0.25, reason: "根拠2", mark: "◎" }, // ◎が2頭で頭数違反。
        { number: 3, place_prob: 0.3, reason: "根拠3", mark: "▲" },
        { number: 4, place_prob: 0.3, reason: "根拠4", mark: "△" },
      ],
    });
    const err = captureMarkViolation(text, priorsN(4));
    expect(err.horses.every((h: ParsedHorseResult) => h.mark === null)).toBe(true);
    const h1 = err.horses.find((h: ParsedHorseResult) => h.umaban === 1)!;
    expect(h1.adjustedProb).toBeCloseTo(0.35, 10); // priorに戻さずクリップ済み補正値を保持。
    expect(h1.clipped).toBe(false);
    expect(h1.usedPrior).toBe(false);
    expect(h1.reason).toBe("根拠1");
  });

  it("優先順位違反(〇を飛ばして▲のみ)でもA救済: 確率補正を保持し全馬mark=nullでエラーを投げること", () => {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.32, reason: "根拠1", mark: "◎" },
        { number: 2, place_prob: 0.28, reason: "根拠2", mark: "▲" }, // 〇を飛ばして▲→優先順位違反。
        { number: 3, place_prob: 0.3, reason: "根拠3", mark: null },
        { number: 4, place_prob: 0.3, reason: "根拠4", mark: null },
      ],
    });
    const err = captureMarkViolation(text, priorsN(4));
    expect(err.horses.every((h: ParsedHorseResult) => h.mark === null)).toBe(true);
    const h2 = err.horses.find((h: ParsedHorseResult) => h.umaban === 2)!;
    expect(h2.adjustedProb).toBeCloseTo(0.28, 10);
    expect(h2.reason).toBe("根拠2");
  });

  it("未知の印文字でもA救済: 該当馬を含め全馬の確率補正を保持し全馬mark=nullでエラーを投げること", () => {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.33, reason: "根拠1", mark: "◎" },
        { number: 2, place_prob: 0.27, reason: "根拠2", mark: "◇" }, // 未知の印文字。
        { number: 3, place_prob: 0.3, reason: "根拠3", mark: "▲" },
        { number: 4, place_prob: 0.3, reason: "根拠4", mark: "△" },
      ],
    });
    const err = captureMarkViolation(text, priorsN(4));
    expect(err.horses.every((h: ParsedHorseResult) => h.mark === null)).toBe(true);
    // 未知の印を付けられた馬自身の確率補正も、他馬の計算継続に巻き込まれず保持されること。
    const h2 = err.horses.find((h: ParsedHorseResult) => h.umaban === 2)!;
    expect(h2.adjustedProb).toBeCloseTo(0.27, 10);
    expect(h2.reason).toBe("根拠2");
    expect(h2.usedPrior).toBe(false);
  });

  it("有効な補正0件(全馬prior採用)が優先: 印違反があっても AnalyzerMarkViolationError にはならないこと(L2の判定順序)", () => {
    // 全馬 place_prob が不正(prior採用)の場合、mark重複違反(◎が2頭)があっても
    // 「有効な補正0件」チェックが先に働き、汎用の AnalyzerResponseParseError を投げる
    // (AnalyzerMarkViolationError ではない = マーク救済の対象にしない)。
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: "たかい", reason: "x", mark: "◎" },
        { number: 2, place_prob: "たかい", reason: "y", mark: "◎" },
      ],
    });
    let caught: unknown;
    try {
      parseAnalyzerResponse(text, priorsN(2));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AnalyzerResponseParseError);
    expect(caught).not.toBeInstanceOf(AnalyzerMarkViolationError);
  });
});
