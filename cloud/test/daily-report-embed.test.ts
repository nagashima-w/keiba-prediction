import { describe, expect, it } from "vitest";
import { buildDayStats, type DayStats } from "../src/daily-report-digest";
import { buildReportEmbed } from "../src/daily-report-embed";
import { DISCORD_COLORS } from "../src/palette";
import { EMBED_LIMITS, embedLength } from "../src/notify-embeds";

/** Issue #235: Discord に送る日報の要約(embed)。上限を守り、リンクは基点があるときだけ付ける。 */

const STATS: DayStats = {
  ...buildDayStats([]),
  raceCount: 36,
  resultRaceCount: 34,
  noResultRaceCount: 2,
  betRaceCount: 20,
  totalStake: 12000,
  totalReturn: 15600,
  recoveryRate: 1.3,
  judgedBetCount: 60,
  hitBetCount: 14,
};
const NARRATIVE = { summary: "中央 36 レースを分析。◎の 1 着は 9 レース。", good: ["上位人気の取りこぼしが少なかった", "ワイドが安定", "穴の拾い方が良い", "4つ目"], improve: ["荒れたレースの買い目が多すぎる"], races: [] };

describe("buildReportEmbed", () => {
  it("タイトルは日付(曜日つき)、説明は LLM の総括、成績の field に賭け金・払戻・回収率・的中を出す", () => {
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: NARRATIVE, note: null, link: undefined });
    expect(e.title).toBe("日報 2026年10月10日(土)");
    expect(e.description).toBe(NARRATIVE.summary);
    const stat = e.fields!.find((f) => f.name === "成績")!;
    expect(stat.value).toContain("賭け金 12,000円");
    expect(stat.value).toContain("払戻 15,600円");
    expect(stat.value).toContain("回収率 130.0%");
    expect(stat.value).toContain("60 点中 14 点的中");
    // Issue #255: 結果あり・結果なしの件数も固定する(前提: 3 つの件数が互いに違う値なので、取り違えても同じ文面にならない)。
    expect(new Set([STATS.raceCount, STATS.resultRaceCount, STATS.noResultRaceCount]).size).toBe(3);
    expect(e.fields!.find((f) => f.name === "レース")!.value).toBe("36 件を分析(結果あり 34 件・結果なし 2 件)");
  });

  it("良かった点・改善点は先頭の 3 件までを field に出す。空なら field ごと出さない", () => {
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: NARRATIVE, note: null, link: undefined });
    const good = e.fields!.find((f) => f.name === "良かった点")!.value.split("\n");
    expect(good).toHaveLength(3);
    expect(good[0]).toContain("上位人気の取りこぼしが少なかった");
    expect(good.join("")).not.toContain("4つ目");
    const none = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: { ...NARRATIVE, good: [], improve: [] }, note: null, link: undefined });
    expect(none.fields!.map((f) => f.name)).not.toContain("良かった点");
    expect(none.fields!.map((f) => f.name)).not.toContain("改善点");
  });

  it("リンクがあれば url に付ける。無ければ url を持たない", () => {
    expect(buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: NARRATIVE, note: null, link: "https://example.com/#report=20261010" }).url).toBe("https://example.com/#report=20261010");
    expect("url" in buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: NARRATIVE, note: null, link: undefined })).toBe(false);
  });

  it("文章が無い(LLM を使えなかった)日報は、説明に固定の理由を出し、統計だけの field にする", () => {
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: null, note: "LLM の API キーが未登録のため、統計だけの日報です", link: undefined });
    expect(e.description).toContain("LLM の API キーが未登録");
    expect(e.fields!.map((f) => f.name)).toEqual(["成績", "レース"]);
  });

  it("色: 回収率 100% 以上は緑、未満は赤、賭け金なしは灰色", () => {
    const color = (stats: DayStats) => buildReportEmbed({ kaisaiDate: "20261010", stats, narrative: NARRATIVE, note: null, link: undefined }).color;
    expect(color({ ...STATS, recoveryRate: 1 })).toBe(DISCORD_COLORS.ok);
    expect(color({ ...STATS, recoveryRate: 0.99 })).toBe(DISCORD_COLORS.fail);
    expect(color({ ...STATS, recoveryRate: null, totalStake: 0 })).toBe(DISCORD_COLORS.none);
  });

  describe("Issue #239: 帯の色(緑・赤)だけに頼らず、成績に「黒字・赤字・収支±0」の語を添える", () => {
    const stat = (recoveryRate: number | null) =>
      buildReportEmbed({ kaisaiDate: "20261010", stats: { ...STATS, recoveryRate, totalStake: recoveryRate === null ? 0 : STATS.totalStake }, narrative: NARRATIVE, note: null, link: undefined });
    // [回収率, 添える語, 帯の色]。境界(0.99・1・1.0001)と両端(0)を含める。色の条件(`recoveryRate >= 1` で緑)と語の境界が一致していること
    const TABLE: readonly (readonly [number, string, number])[] = [
      [0, "(赤字)", DISCORD_COLORS.fail],
      [0.5, "(赤字)", DISCORD_COLORS.fail],
      [0.99, "(赤字)", DISCORD_COLORS.fail],
      [0.9999, "(赤字)", DISCORD_COLORS.fail],
      [1, "(収支±0)", DISCORD_COLORS.ok],
      [1.0001, "(黒字)", DISCORD_COLORS.ok],
      [1.3, "(黒字)", DISCORD_COLORS.ok],
    ];

    it.each(TABLE)("回収率 %f: 成績の field に「%s」を添え、帯は同じ意味の色", (rate, word, color) => {
      const e = stat(rate);
      const value = e.fields!.find((f) => f.name === "成績")!.value;
      expect(value).toMatch(/回収率 [0-9.]+%/);
      expect(value).toContain(word);
      expect(e.color).toBe(color);
      // 添える語は、ちょうど1つだけ(黒字と赤字が同時に出ない)
      expect(["(黒字)", "(赤字)", "(収支±0)"].filter((w) => value.includes(w))).toEqual([word]);
    });

    // Issue #245: 表示は、色・語と矛盾しない。「100.0%」と出るのは rate === 1(収支±0)のときだけ。
    // [回収率, 成績の field に出る回収率の部分]。期待値は実装前に `(rate*100).toFixed(1)`・`Math.round(rate*10000)` を実行して測り直した。
    const DISPLAY: readonly (readonly [number, string])[] = [
      [0.99, "回収率 99.0%(赤字)"],
      [0.9995, "回収率 99.95%(赤字)"],
      [0.9999, "回収率 99.99%(赤字)"],
      [0.99999, "回収率 99.99%(赤字)"],
      [1, "回収率 100.0%(収支±0)"],
      [1.00001, "回収率 100.01%(黒字)"],
      [1.3, "回収率 130.0%(黒字)"],
    ];

    it.each(DISPLAY)("Issue #245: 回収率 %f の表示は「%s」", (rate, expected) => {
      const value = stat(rate).fields!.find((f) => f.name === "成績")!.value;
      expect(value).toContain(expected);
    });

    it("Issue #245: 前提: 旧表示(小数第 1 位)では 1 以外の 3 値(0.9995・0.9999・1.00001)が『100.0%』と出て、語と矛盾していた。新表では『100.0%』は rate === 1 だけ", () => {
      const contradicted = DISPLAY.filter(([r]) => r === 0.9995 || r === 0.9999 || r === 1.00001);
      expect(contradicted).toHaveLength(3);
      for (const [rate] of contradicted) {
        expect(`${(rate * 100).toFixed(1)}%`).toBe("100.0%");
      }
      expect(DISPLAY.filter(([rate, text]) => text.includes("100.0%") && rate !== 1)).toEqual([]);
    });

    it("前提: 表に3つの語がすべて現れ、色は緑・赤の両方が現れる(表が片寄っていない)", () => {
      expect(new Set(TABLE.map((r) => r[1]))).toEqual(new Set(["(黒字)", "(赤字)", "(収支±0)"]));
      expect(new Set(TABLE.map((r) => r[2]))).toEqual(new Set([DISCORD_COLORS.ok, DISCORD_COLORS.fail]));
    });

    it("回収率が出せない日(null)は『なし』のまま。黒字・赤字の語は添えない", () => {
      const value = stat(null).fields!.find((f) => f.name === "成績")!.value;
      expect(value).toContain("回収率 なし");
      expect(["黒字", "赤字", "収支±0"].filter((w) => value.includes(w))).toEqual([]);
    });
  });

  it("賭け金が 0 の日の回収率は『なし』と出す(NaN・Infinity を出さない)", () => {
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: { ...STATS, totalStake: 0, totalReturn: 0, recoveryRate: null, judgedBetCount: 0, hitBetCount: 0 }, narrative: NARRATIVE, note: null, link: undefined });
    expect(e.fields!.find((f) => f.name === "成績")!.value).toContain("回収率 なし");
    expect(JSON.stringify(e)).not.toMatch(/NaN|Infinity/);
  });

  it("Discord の上限(説明 4096・field 1024・合計 6000)を守る: 長い総括・長い項目でも収まる", () => {
    const long = "あ".repeat(5000);
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: { summary: long, good: [long, long, long], improve: [long, long, long], races: [] }, note: null, link: undefined });
    expect(e.description!.length).toBeLessThanOrEqual(EMBED_LIMITS.description);
    for (const f of e.fields!) {
      expect(f.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
    }
    expect(embedLength(e)).toBeLessThanOrEqual(EMBED_LIMITS.total);
  });
});
