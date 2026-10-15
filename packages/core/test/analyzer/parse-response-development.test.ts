/**
 * 展開予想(development)と想定ペース(pace)の解析(Issue #315)。
 *
 *  - development: 文字列だけ受け、trim。空は null。コードポイント 500 を超えたら先頭 499 + 「…」(truncateByCodePoints)。
 *  - pace: trim し、末尾の「ペース」を除いてから「スロー」「平均」「ハイ」の完全一致だけ受ける。「ミドル」は「平均」に写す。それ以外は null。
 *  - どちらも欠落・不正でも**例外を投げず**、馬の確率・印の解析(clippedCount・missingCount・usedPrior)を変えない。
 *  - `extractDevelopment(text)`: 保存済みの生応答から取り出す入口(cloud の画面用)。JSON として読めない・印違反の応答でも throw しない。
 */
import { describe, expect, it } from "vitest";
import {
  AnalyzerMarkViolationError,
  extractDevelopment,
  parseAnalyzerResponse,
  PARSE_DEVELOPMENT_MAX_CODEPOINTS,
  type PriorRef,
} from "../../src/analyzer/parse-response.js";

const priors: PriorRef[] = [
  { umaban: 1, prior: 0.4 },
  { umaban: 2, prior: 0.3 },
  { umaban: 3, prior: 0.2 },
  { umaban: 4, prior: 0.1 },
];

/** 印の制約を満たす馬の配列(◎〇▲△ を 1〜4 番に付ける)。 */
function horses(): unknown[] {
  return [
    { number: 1, place_prob: 0.45, reason: "r", mark: "◎" },
    { number: 2, place_prob: 0.3, reason: "r", mark: "〇" },
    { number: 3, place_prob: 0.2, reason: "r", mark: "▲" },
    { number: 4, place_prob: 0.1, reason: "r", mark: "△" },
  ];
}

const body = (top: Record<string, unknown>, hs: unknown[] = horses()): string => JSON.stringify({ ...top, horses: hs });

describe("前提", () => {
  it("development の上限は 500 コードポイント(指示の全角200字の 2.5 倍)", () => {
    expect(PARSE_DEVELOPMENT_MAX_CODEPOINTS).toBe(500);
  });
});

describe("pace の解析(テーブル駆動)", () => {
  const table: ReadonlyArray<{ readonly name: string; readonly raw: unknown; readonly expected: string | null }> = [
    { name: "スロー", raw: "スロー", expected: "スロー" },
    { name: "平均", raw: "平均", expected: "平均" },
    { name: "ハイ", raw: "ハイ", expected: "ハイ" },
    { name: "前後の空白は除く", raw: "  ハイ \n", expected: "ハイ" },
    { name: "末尾の「ペース」を除く(ハイペース)", raw: "ハイペース", expected: "ハイ" },
    { name: "末尾の「ペース」を除く(スローペース)", raw: "スローペース", expected: "スロー" },
    { name: "末尾の「ペース」を除く(平均ペース)", raw: "平均ペース", expected: "平均" },
    { name: "ミドルは平均に写す", raw: "ミドル", expected: "平均" },
    { name: "ミドルペースは平均に写す", raw: "ミドルペース", expected: "平均" },
    { name: "null は null", raw: null, expected: null },
    { name: "不明は null(3 値以外)", raw: "不明", expected: null },
    { name: "空文字は null", raw: "", expected: null },
    { name: "「ペース」だけは null", raw: "ペース", expected: null },
    { name: "複数の語(スロー〜平均)は null", raw: "スロー〜平均", expected: null },
    { name: "例の文言そのまま(スロー・平均・ハイのいずれか)は null", raw: "スロー・平均・ハイのいずれか", expected: null },
    { name: "部分一致は受けない(ややハイ)", raw: "ややハイ", expected: null },
    { name: "半角カタカナは受けない", raw: "ﾊｲ", expected: null },
    { name: "数は null", raw: 1, expected: null },
    { name: "配列は null", raw: ["ハイ"], expected: null },
    { name: "オブジェクトは null", raw: { pace: "ハイ" }, expected: null },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(parseAnalyzerResponse(body({ development: "d", pace: t.raw }), priors).pace).toBe(t.expected);
    });
  }

  it("pace のキーが無いときは null", () => {
    expect(parseAnalyzerResponse(body({ development: "d" }), priors).pace).toBeNull();
  });
});

describe("development の解析(テーブル駆動)", () => {
  const long = "あ".repeat(PARSE_DEVELOPMENT_MAX_CODEPOINTS);
  const table: ReadonlyArray<{ readonly name: string; readonly raw: unknown; readonly expected: string | null }> = [
    { name: "正常な短文はそのまま", raw: "逃げ馬が2頭で先行争いが激しく、ハイペースの見立て。差し・追込が有利。", expected: "逃げ馬が2頭で先行争いが激しく、ハイペースの見立て。差し・追込が有利。" },
    { name: "前後の空白は除く", raw: "  展開  ", expected: "展開" },
    { name: "空文字は null", raw: "", expected: null },
    { name: "空白だけは null", raw: " \n\t ", expected: null },
    { name: "null は null", raw: null, expected: null },
    { name: "数は null", raw: 123, expected: null },
    { name: "配列は null", raw: ["展開"], expected: null },
    { name: "オブジェクトは null", raw: { text: "展開" }, expected: null },
    { name: "ちょうど上限(500)はそのまま", raw: long, expected: long },
    { name: "上限 + 1 は先頭 499 + 「…」(合計 500)", raw: `${long}あ`, expected: `${"あ".repeat(PARSE_DEVELOPMENT_MAX_CODEPOINTS - 1)}…` },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(parseAnalyzerResponse(body({ development: t.raw, pace: "平均" }), priors).development).toBe(t.expected);
    });
  }

  it("サロゲートペア(絵文字)の途中で割らない(コードポイントで数える)", () => {
    const s = "😀".repeat(PARSE_DEVELOPMENT_MAX_CODEPOINTS + 5);
    const got = parseAnalyzerResponse(body({ development: s, pace: "平均" }), priors).development!;
    expect(Array.from(got)).toHaveLength(PARSE_DEVELOPMENT_MAX_CODEPOINTS);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(got)).toBe(false);
    expect(got.endsWith("…")).toBe(true);
  });

  it("development のキーが無いときは null", () => {
    expect(parseAnalyzerResponse(body({ pace: "ハイ" }), priors).development).toBeNull();
  });
});

describe("馬の解析を変えない(欠落・不正でも分析は止めない)", () => {
  it("development・pace が付いた応答と、付かない応答で、horses・clippedCount・missingCount が完全に一致する", () => {
    const withBoth = parseAnalyzerResponse(body({ development: "展開", pace: "ハイ" }), priors);
    const without = parseAnalyzerResponse(body({}), priors);
    const broken = parseAnalyzerResponse(body({ development: 5, pace: { a: 1 } }), priors);
    expect(withBoth.development).toBe("展開");
    expect(withBoth.pace).toBe("ハイ");
    expect(without.development).toBeNull();
    expect(without.pace).toBeNull();
    expect(broken.development).toBeNull();
    expect(broken.pace).toBeNull();
    expect(without.horses).toHaveLength(4);
    expect(withBoth.horses).toEqual(without.horses);
    expect(broken.horses).toEqual(without.horses);
    expect({ c: withBoth.clippedCount, m: withBoth.missingCount }).toEqual({ c: without.clippedCount, m: without.missingCount });
  });

  it("キーの順が逆(horses が先)でも読める", () => {
    const text = JSON.stringify({ horses: horses(), pace: "スロー", development: "後ろに書かれた展開" });
    const r = parseAnalyzerResponse(text, priors);
    expect(r.development).toBe("後ろに書かれた展開");
    expect(r.pace).toBe("スロー");
  });

  it("コードフェンス・前置きの散文つきでも読める", () => {
    const text = `展開を考えました。\n\`\`\`json\n${body({ development: "前置きつき", pace: "平均" })}\n\`\`\``;
    const r = parseAnalyzerResponse(text, priors);
    expect(r.development).toBe("前置きつき");
    expect(r.pace).toBe("平均");
  });
});

describe("extractDevelopment(保存済みの生応答から取り出す入口)", () => {
  it("正常: development と pace を返す", () => {
    expect(extractDevelopment(body({ development: "展開", pace: "ハイ" }))).toEqual({ development: "展開", pace: "ハイ" });
  });

  it("parseAnalyzerResponse と同じ値を返す(整形の規則を共有している)", () => {
    const text = body({ development: `  ${"あ".repeat(600)}  `, pace: "ハイペース" });
    const parsed = parseAnalyzerResponse(text, priors);
    expect(extractDevelopment(text)).toEqual({ development: parsed.development, pace: parsed.pace });
    expect(parsed.development).not.toBeNull();
    expect(parsed.pace).toBe("ハイ");
  });

  const unreadable: ReadonlyArray<{ readonly name: string; readonly text: unknown }> = [
    { name: "空文字", text: "" },
    { name: "JSON でない文章", text: "申し訳ありません" },
    { name: "壊れた JSON", text: '{"development": "展開", "pace": ' },
    { name: "配列(オブジェクトでない)", text: "[1,2]" },
    { name: "null(型の外から来た値)", text: null },
    { name: "undefined", text: undefined },
    { name: "数", text: 5 },
  ];
  for (const t of unreadable) {
    it(`読めない応答(${t.name})は throw せず両方 null`, () => {
      expect(extractDevelopment(t.text as string)).toEqual({ development: null, pace: null });
    });
  }

  it("horses が無い応答でも、development・pace は取り出せる(馬の解析とは独立)", () => {
    expect(extractDevelopment(JSON.stringify({ development: "展開のみ", pace: "平均" }))).toEqual({ development: "展開のみ", pace: "平均" });
  });

  it("印の制約違反の応答(parseAnalyzerResponse は AnalyzerMarkViolationError)でも取り出せる", () => {
    const text = body({ development: "印違反でも残る", pace: "ハイ" }, [{ number: 1, place_prob: 0.45, reason: "r", mark: null }, ...horses().slice(1)]);
    expect(() => parseAnalyzerResponse(text, priors)).toThrow(AnalyzerMarkViolationError);
    expect(extractDevelopment(text)).toEqual({ development: "印違反でも残る", pace: "ハイ" });
  });

  it("文字列中の波括弧・エスケープされた改行があっても読める", () => {
    const text = JSON.stringify({ development: "括弧 { } を含む\n二行目", pace: "平均", horses: horses() });
    expect(extractDevelopment(text)).toEqual({ development: "括弧 { } を含む\n二行目", pace: "平均" });
  });
});
