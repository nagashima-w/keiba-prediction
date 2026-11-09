import { describe, expect, it } from "vitest";
import type { OddsSourcesMeta } from "../../packages/core/src/scraper/odds-override";
import { serializeOddsSources } from "../src/odds-sources-json";
import { oddsSourcesLines, oddsSourcesLineOfClose } from "../src/odds-sources-view";

/**
 * Issue #677: オッズの取得元と時刻の行(サーバで日本語まで組み立てる)。入力は `serializeOddsSources` の出力(D1 の `odds_sources_json`)。
 * 記録なし・読めない JSON は例外を投げず null(何も出さない)。
 */

const jra = (officialDatetime: string | null) => ({ source: "jra" as const, officialDatetime });
const nk = (officialDatetime: string | null, fallbackReason?: "override-unavailable" | "override-error" | "horse-set-mismatch") =>
  fallbackReason === undefined ? { source: "netkeiba" as const, officialDatetime } : { source: "netkeiba" as const, officialDatetime, fallbackReason };
const json = (s: OddsSourcesMeta): string => {
  const out = serializeOddsSources(s);
  if (out === null) throw new Error("テストの前提: 空でない記録");
  return out;
};

describe("oddsSourcesLines(分析の行)", () => {
  it("全券種が同じ取得元・同じ時刻なら 1 行にまとめる(日付付き・「現在」)", () => {
    const s = { winPlace: jra("2026-11-14 12:05:30"), wide: jra("2026-11-14 12:05:30"), trifecta: jra("2026-11-14 12:05:30") };
    expect(oddsSourcesLines(json(s))).toEqual(["オッズ: JRA(11/14 12:05 現在)"]);
  });

  it("取得元が券種で分かれるとき: 同じ取得元・時刻の券種をまとめ、netkeiba で時刻が null なら時刻を出さない", () => {
    const s = { winPlace: jra("2026-11-14 12:05:00"), trifecta: nk(null) };
    expect(Object.keys(s)).toHaveLength(2);
    expect(oddsSourcesLines(json(s))).toEqual(["オッズ: 単勝・複勝は JRA(11/14 12:05 現在)、3連単は netkeiba"]);
  });

  it("同じ JRA でも時刻が違えば別の句にする(取得元だけ見てまとめない)", () => {
    const s = { winPlace: jra("2026-11-14 12:05:00"), wide: jra("2026-11-14 12:06:00") };
    expect(oddsSourcesLines(json(s))).toEqual(["オッズ: 単勝・複勝は JRA(11/14 12:05 現在)、ワイドは JRA(11/14 12:06 現在)"]);
  });

  it("同じ時刻でも取得元が違えば別の句にする(時刻だけ見てまとめない)", () => {
    const s = { winPlace: jra("2026-11-14 12:05:00"), wide: nk("2026-11-14 12:05:00") };
    expect(oddsSourcesLines(json(s))).toEqual(["オッズ: 単勝・複勝は JRA(11/14 12:05 現在)、ワイドは netkeiba(11/14 12:05 現在)"]);
  });

  it("netkeiba に戻した理由は利用者向けの言葉にする(内部の語を出さない。unavailable と error は同じ文言)", () => {
    const cases: Array<[Parameters<typeof nk>[1], string]> = [
      ["override-unavailable", "JRA を使えず"],
      ["override-error", "JRA を使えず"],
      ["horse-set-mismatch", "JRA と出走馬が合わず"],
    ];
    for (const [reason, text] of cases) {
      const lines = oddsSourcesLines(json({ winPlace: jra("2026-11-14 12:05:00"), wide: nk(null, reason) }));
      expect(lines).toEqual([`オッズ: 単勝・複勝は JRA(11/14 12:05 現在)、ワイドは netkeiba(${text})`]);
      expect(lines.join("")).not.toMatch(/override|mismatch/);
    }
  });

  it("理由と時刻が両方あるときは「、」で並べる", () => {
    expect(oddsSourcesLines(json({ winPlace: nk("2026-11-14 12:05:00", "override-unavailable") }))).toEqual(["オッズ: netkeiba(11/14 12:05 現在、JRA を使えず)"]);
  });

  it("全券種のラベルと並び順(単勝・複勝→ワイド→3連複→馬連→馬単→3連単→枠連)", () => {
    const s = { bracketQuinella: nk(null), trifecta: nk(null), exacta: nk(null), quinella: nk(null), trio: nk(null), wide: nk(null), winPlace: nk(null) };
    expect(Object.keys(s)).toHaveLength(7);
    expect(oddsSourcesLines(json(s))).toEqual(["オッズ: netkeiba"]);
    const mixed = { bracketQuinella: nk(null), trifecta: jra("2026-11-14 12:05:00"), exacta: nk(null), quinella: jra("2026-11-14 12:05:00"), trio: nk(null), wide: jra("2026-11-14 12:05:00"), winPlace: nk(null) };
    expect(oddsSourcesLines(json(mixed))).toEqual([
      "オッズ: 単勝・複勝・3連複・馬単・枠連は netkeiba、ワイド・馬連・3連単は JRA(11/14 12:05 現在)",
    ]);
  });

  it("句が 3 つ以上に割れたら 2 行にする(上限 2 行。2 行目は「、」で連ねる)", () => {
    const s = { winPlace: jra("2026-11-14 12:05:00"), wide: jra("2026-11-14 12:06:00"), trio: jra("2026-11-14 12:07:00"), quinella: jra("2026-11-14 12:08:00") };
    expect(Object.keys(s)).toHaveLength(4);
    const lines = oddsSourcesLines(json(s));
    expect(lines).toEqual(["オッズ: 単勝・複勝は JRA(11/14 12:05 現在)、ワイドは JRA(11/14 12:06 現在)", "3連複は JRA(11/14 12:07 現在)、馬連は JRA(11/14 12:08 現在)"]);
  });

  it("7 券種がすべて別の句でも 2 行を超えない", () => {
    const t = (m: number) => jra(`2026-11-14 12:0${m}:00`);
    const s = { winPlace: t(1), wide: t(2), trio: t(3), quinella: t(4), exacta: t(5), trifecta: t(6), bracketQuinella: t(7) };
    expect(Object.keys(s)).toHaveLength(7);
    expect(oddsSourcesLines(json(s))).toHaveLength(2);
  });

  it("時刻の形が想定外なら時刻だけ落とす(undefined・null の文字を出さない)", () => {
    const lines = oddsSourcesLines(json({ winPlace: jra("昨日") }));
    expect(lines).toEqual(["オッズ: JRA"]);
  });
});

describe("oddsSourcesLines の無記録・壊れた入力(何も出さず、例外を投げない)", () => {
  const bad: Array<[string, string | null | undefined]> = [
    ["null", null],
    ["undefined", undefined],
    ["空文字", ""],
    ["壊れた JSON", "{"],
    ["配列", "[]"],
    ["知らない版", JSON.stringify({ v: 2, sources: { winPlace: jra("2026-11-14 12:05:00") } })],
    ["版なし", JSON.stringify({ sources: { winPlace: jra("2026-11-14 12:05:00") } })],
    ["sources が無い", JSON.stringify({ v: 1 })],
    ["sources が空", JSON.stringify({ v: 1, sources: {} })],
    ["未知の券種だけ", JSON.stringify({ v: 1, sources: { foo: jra(null) } })],
    ["未知の取得元だけ", JSON.stringify({ v: 1, sources: { winPlace: { source: "bashira", officialDatetime: null } } })],
    ["JSON の null", "null"],
  ];
  it.each(bad)("%s は null 相当(空配列)", (_name, input) => {
    expect(() => oddsSourcesLines(input)).not.toThrow();
    expect(oddsSourcesLines(input)).toEqual([]);
    expect(oddsSourcesLineOfClose(input)).toBeNull();
  });

  it("未知の券種・取得元は、その券種だけ捨てて残りを出す", () => {
    const input = JSON.stringify({ v: 1, sources: { foo: jra(null), wide: { source: "x", officialDatetime: null }, winPlace: jra("2026-11-14 12:05:00") } });
    expect(oddsSourcesLines(input)).toEqual(["オッズ: JRA(11/14 12:05 現在)"]);
  });

  it("未知の fallbackReason は理由なしとして扱う(未知の語彙を流さない)", () => {
    const input = JSON.stringify({ v: 1, sources: { wide: { source: "netkeiba", officialDatetime: null, fallbackReason: "secret-reason" } } });
    expect(oddsSourcesLines(input)).toEqual(["オッズ: netkeiba"]);
  });
});

describe("oddsSourcesLineOfClose(再計算の回の 1 行)", () => {
  it("分析時と同じ内容でも省かず、1 行にして返す", () => {
    const s = { winPlace: jra("2026-11-14 12:58:00"), trifecta: nk(null) };
    expect(oddsSourcesLineOfClose(json(s))).toBe("オッズ: 単勝・複勝は JRA(11/14 12:58 現在)、3連単は netkeiba");
  });
  it("2 行になる記録も 1 行に連ねる", () => {
    const t = (m: number) => jra(`2026-11-14 12:0${m}:00`);
    const line = oddsSourcesLineOfClose(json({ winPlace: t(1), wide: t(2), trio: t(3) }));
    expect(line).not.toBeNull();
    expect(line).toBe("オッズ: 単勝・複勝は JRA(11/14 12:01 現在)、ワイドは JRA(11/14 12:02 現在)、3連複は JRA(11/14 12:03 現在)");
  });
});
