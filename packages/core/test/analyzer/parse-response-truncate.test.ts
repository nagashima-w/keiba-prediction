/**
 * LLM 由来の文字列の文字数上限(Issue #303)の純関数テスト。
 *
 * 決定:
 *  - `reason` は 400、highlights・concerns の各要素は 100、未知の印の値(JSON.stringify 後)は 40 コードポイントを上限にする。
 *  - 超過分は切る(例外にしない。分析を失敗させない)。切った結果は日報の digest の `cut()` と同じ形で、
 *    先頭 `max-1` コードポイント + `…` の合計ちょうど `max` コードポイント。サロゲートペアは割らない。
 *  - 上限以下の値は一切変えない(保存される値・画面の表示・golden を動かさない)。
 *  - 切った件数は記録しない(ただ切るだけ)。
 */

import { describe, expect, it } from "vitest";
import {
  AnalyzerMarkViolationError,
  AnalyzerResponseParseError,
  PARSE_ITEM_MAX_CODEPOINTS,
  PARSE_MARK_VALUE_MAX_CODEPOINTS,
  PARSE_REASON_MAX_CODEPOINTS,
  parseAnalyzerResponse,
  truncateByCodePoints,
  type PriorRef,
} from "../../src/analyzer/parse-response.js";

/** コードポイント数。 */
function cp(s: string): number {
  return Array.from(s).length;
}

/** 孤立サロゲートを含むか。 */
function hasLoneSurrogate(s: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

describe("上限の値(Issue #303 の決定)", () => {
  it("reason 400・項目 100・印の値 40", () => {
    expect(PARSE_REASON_MAX_CODEPOINTS).toBe(400);
    expect(PARSE_ITEM_MAX_CODEPOINTS).toBe(100);
    expect(PARSE_MARK_VALUE_MAX_CODEPOINTS).toBe(40);
  });
});

describe("truncateByCodePoints(境界値。表駆動)", () => {
  const max = 5;
  const cases: ReadonlyArray<{ label: string; input: string; expected: string }> = [
    { label: "空文字はそのまま", input: "", expected: "" },
    { label: "上限-1 字はそのまま", input: "あいうえ", expected: "あいうえ" },
    { label: "上限ちょうどはそのまま(印も付けない)", input: "あいうえお", expected: "あいうえお" },
    { label: "上限+1 字は先頭 max-1 字 + …", input: "あいうえおか", expected: "あいうえ…" },
    { label: "大きく超えても結果は max コードポイント", input: "あ".repeat(1000), expected: "ああああ…" },
    { label: "サロゲートペアだけで上限ちょうど(UTF-16 では 10 だがコードポイントは 5)はそのまま", input: "𠮷𠮷𠮷𠮷𠮷", expected: "𠮷𠮷𠮷𠮷𠮷" },
    { label: "サロゲートペアが先頭 max-1 字の最後にある: ペアを割らずに残す", input: "あいう𠮷えお", expected: "あいう𠮷…" },
    { label: "サロゲートペアが先頭 max-1 字のすぐ外にある: ペアごと落とす", input: "あいうえ𠮷お", expected: "あいうえ…" },
    { label: "サロゲートペア 5 つ+1 字で上限超過", input: "𠮷𠮷𠮷𠮷𠮷あ", expected: "𠮷𠮷𠮷𠮷…" },
    { label: "前後の空白は変えない(切らないとき)", input: "  あ  ", expected: "  あ  " },
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    const out = truncateByCodePoints(input, max);
    expect(out).toBe(expected);
    // 結果は上限を超えず、孤立サロゲートを含まない。
    expect(cp(out)).toBeLessThanOrEqual(max);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("切るケースでは、入力が上限を超えていて、結果は ちょうど max コードポイントで … で終わる(自明に成立していない)", () => {
    const input = "あいうえおか";
    expect(cp(input)).toBeGreaterThan(max);
    const out = truncateByCodePoints(input, max);
    expect(cp(out)).toBe(max);
    expect(out.endsWith("…")).toBe(true);
  });
});

const priors: PriorRef[] = [
  { umaban: 1, prior: 0.4 },
  { umaban: 2, prior: 0.3 },
];

/** 馬1に生の値を与え、馬2に◎を付けた応答(印の頭数制約は満たす)。 */
function parseWith(horse1: Record<string, unknown>) {
  const text = JSON.stringify({
    horses: [
      { number: 1, place_prob: 0.42, reason: "r", ...horse1 },
      { number: 2, place_prob: 0.3, reason: "r2", mark: "◎" },
    ],
  });
  return parseAnalyzerResponse(text, priors).horses.find((h) => h.umaban === 1)!;
}

describe("reason の上限(parseAnalyzerResponse 経由)", () => {
  const max = PARSE_REASON_MAX_CODEPOINTS;
  const cases: ReadonlyArray<{ label: string; reason: string; expected: string }> = [
    { label: "空文字はそのまま(null にしない)", reason: "", expected: "" },
    { label: "上限ちょうどはそのまま", reason: "あ".repeat(max), expected: "あ".repeat(max) },
    { label: "上限+1 は 399 字 + …", reason: "あ".repeat(max + 1), expected: `${"あ".repeat(max - 1)}…` },
    {
      label: "境界にサロゲートペアがまたがる: ペアを割らない",
      reason: `${"あ".repeat(max - 2)}𠮷あい`,
      expected: `${"あ".repeat(max - 2)}𠮷…`,
    },
    { label: "trim しない(従来どおり)。前後の空白は残る", reason: "  根拠  ", expected: "  根拠  " },
  ];

  it.each(cases)("$label", ({ reason, expected }) => {
    const h = parseWith({ reason });
    expect(h.reason).toBe(expected);
    expect(cp(h.reason ?? "")).toBeLessThanOrEqual(max);
    expect(hasLoneSurrogate(h.reason ?? "")).toBe(false);
  });

  it("切っても分析は止まらず、確率・clipped・usedPrior は変わらない", () => {
    const original = "あ".repeat(max * 10);
    const long = parseWith({ reason: original });
    const short = parseWith({ reason: "短い" });
    expect(long.reason).not.toBe(original);
    expect({ ...long, reason: null }).toEqual({ ...short, reason: null });
  });
});

describe("highlights・concerns の各要素の上限(parseAnalyzerResponse 経由)", () => {
  const max = PARSE_ITEM_MAX_CODEPOINTS;
  const cases: ReadonlyArray<{ label: string; raw: string[]; expected: string[] }> = [
    { label: "空文字だけ・空白だけは従来どおり捨てる", raw: ["", "  ", "a"], expected: ["a"] },
    { label: "上限ちょうどはそのまま", raw: ["い".repeat(max)], expected: ["い".repeat(max)] },
    { label: "上限+1 は 99 字 + …", raw: ["い".repeat(max + 1)], expected: [`${"い".repeat(max - 1)}…`] },
    { label: "境界にサロゲートペアがまたがる: ペアを割らない", raw: [`${"い".repeat(max - 2)}𠮷うえ`], expected: [`${"い".repeat(max - 2)}𠮷…`] },
    {
      label: "4 件以上: 先頭 3 件に切ったうえで、各要素を切る(長い 3 件目は切られ、4 件目は出ない)",
      raw: ["a", "b", "い".repeat(max + 50), "d"],
      expected: ["a", "b", `${"い".repeat(max - 1)}…`],
    },
    { label: "trim したあとで数える(前後の空白で上限を消費しない)", raw: [`  ${"い".repeat(max)}  `], expected: ["い".repeat(max)] },
  ];

  it.each(cases)("$label", ({ raw, expected }) => {
    const h = parseWith({ highlights: raw, concerns: raw });
    expect(h.highlights).toEqual(expected);
    expect(h.concerns).toEqual(expected);
    for (const s of [...h.highlights, ...h.concerns]) {
      expect(cp(s)).toBeLessThanOrEqual(max);
      expect(hasLoneSurrogate(s)).toBe(false);
    }
  });

  it("切るケースの入力は上限を超えている(自明に成立していない)", () => {
    const input = "い".repeat(max + 1);
    expect(cp(input)).toBeGreaterThan(max);
    const h = parseWith({ highlights: [input] });
    expect(cp(h.highlights[0]!)).toBe(max);
  });
});

describe("未知の印の値の上限(AnalyzerMarkViolationError のメッセージ)", () => {
  const prefix = "未知の予想印です(馬番1): ";

  function violationMessage(rawMark: unknown): string {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.42, reason: "r", mark: rawMark },
        { number: 2, place_prob: 0.3, reason: "r2", mark: "◎" },
      ],
    });
    try {
      parseAnalyzerResponse(text, priors);
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerMarkViolationError);
      return (e as Error).message;
    }
    throw new Error("例外が投げられませんでした");
  }

  it("短い未知の印は従来どおりの文面(JSON.stringify した値を含む)", () => {
    expect(violationMessage("X")).toBe(`${prefix}"X"`);
  });

  it("stringify 後がちょうど上限のとき(引用符込み)は切らない", () => {
    const value = "x".repeat(PARSE_MARK_VALUE_MAX_CODEPOINTS - 2);
    expect(cp(JSON.stringify(value))).toBe(PARSE_MARK_VALUE_MAX_CODEPOINTS);
    expect(violationMessage(value)).toBe(`${prefix}${JSON.stringify(value)}`);
  });

  it("stringify 後が上限+1 のときは切る", () => {
    const value = "x".repeat(PARSE_MARK_VALUE_MAX_CODEPOINTS - 1);
    expect(cp(JSON.stringify(value))).toBe(PARSE_MARK_VALUE_MAX_CODEPOINTS + 1);
    const msg = violationMessage(value);
    expect(cp(msg.slice(prefix.length))).toBe(PARSE_MARK_VALUE_MAX_CODEPOINTS);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("巨大な文字列は切る: 値の部分が上限ちょうど、メッセージ全体も有界", () => {
    const msg = violationMessage("x".repeat(100000));
    expect(msg.startsWith(prefix)).toBe(true);
    expect(cp(msg.slice(prefix.length))).toBe(PARSE_MARK_VALUE_MAX_CODEPOINTS);
    expect(msg.endsWith("…")).toBe(true);
    expect(msg.length).toBeLessThan(200);
  });

  it("巨大なオブジェクト・配列も切る", () => {
    for (const v of [{ a: "y".repeat(100000) }, Array.from({ length: 5000 }, (_, i) => i)]) {
      expect(JSON.stringify(v).length).toBeGreaterThan(PARSE_MARK_VALUE_MAX_CODEPOINTS);
      const msg = violationMessage(v);
      expect(cp(msg.slice(prefix.length))).toBe(PARSE_MARK_VALUE_MAX_CODEPOINTS);
    }
  });

  it("複数馬が未知の印でも、各馬の値がそれぞれ有界(メッセージ全体は馬数に比例)", () => {
    const text = JSON.stringify({
      horses: [
        { number: 1, place_prob: 0.42, reason: "r", mark: "x".repeat(10000) },
        { number: 2, place_prob: 0.3, reason: "r2", mark: "y".repeat(10000) },
      ],
    });
    let msg = "";
    try {
      parseAnalyzerResponse(text, priors);
    } catch (e) {
      msg = (e as Error).message;
    }
    // 未知の印が 2 頭分 + 「◎が0頭」の違反が出る。値は各 40 コードポイントなので全体は有界。
    expect(msg).toContain("馬番1");
    expect(msg).toContain("馬番2");
    expect(msg.length).toBeLessThan(1000);
  });
});

describe("AnalyzerResponseParseError のメッセージは既に有界(Issue #303 Q4: 実装は触らない)", () => {
  // JSON.parse の例外文(V8 が位置と短い断片だけを含める)を取り込む唯一の経路。他の文面は固定文言。
  // 実装(parse-response.ts)は何も切っていないので、これは V8 の挙動への依存を固定する回帰テストである。
  it.each([
    { label: "巨大な値が壊れている", text: `{"a":${"x".repeat(100000)}}` },
    { label: "巨大な文字列の直後が壊れている", text: `{"a":"${"x".repeat(100000)}" "b"}` },
    { label: "巨大な全角のキーが壊れている", text: `{${"あ".repeat(100000)}}` },
  ])("$label", ({ text }) => {
    let msg = "";
    try {
      parseAnalyzerResponse(text, priors);
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerResponseParseError);
      msg = (e as Error).message;
    }
    expect(msg).toContain("JSONのパースに失敗しました");
    expect(cp(msg)).toBeLessThan(200);
  });
});
