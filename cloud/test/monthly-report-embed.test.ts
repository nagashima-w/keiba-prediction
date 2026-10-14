import { describe, expect, it } from "vitest";
import { buildMonthlyEmbed } from "../src/monthly-report-embed";
import { MONTHLY_NARRATIVE_LIMITS, type MonthlyNarrative } from "../src/monthly-report-prompt";
import { EMBED_LIMITS, embedLength } from "../src/notify-embeds";
import { DISCORD_COLORS } from "../src/palette";
import { buildMonthlyLink } from "../src/notify-link";
import { SMALL_MONTH_SPEC, syntheticMonthStats } from "./monthly-fixtures";

/** Issue #280(#265-B): Discord に送る月報の要約(embed)。上限は fitEmbed が保証し、リンクは基点があるときだけ付ける。 */

const STATS = syntheticMonthStats(SMALL_MONTH_SPEC);
const NARRATIVE: MonthlyNarrative = {
  summary: "10 月は 12 レースを分析。見込みの的中数との差は小さい。",
  good: ["g1", "g2", "g3", "g4-隠れる"],
  improve: ["i1", "i2", "i3", "i4-隠れる"],
  outlook: ["o1", "o2", "o3", "o4-隠れる"],
};
const base = { month: "202610", stats: STATS, narrative: NARRATIVE, note: null, link: undefined, lastDayPending: false } as const;

describe("buildMonthlyEmbed", () => {
  it("タイトルは月、説明は総括、成績・レースの field に確定値を出す", () => {
    const e = buildMonthlyEmbed(base);
    expect(e.title).toBe("月報 2026年10月");
    expect(e.description).toBe(NARRATIVE.summary);
    const names = e.fields!.map((f) => f.name);
    expect(names.slice(0, 2)).toEqual(["成績", "レース"]);
    const stat = e.fields!.find((f) => f.name === "成績")!.value;
    expect(stat).toContain(`賭け金 ${STATS.totalStake.toLocaleString("en-US")}円`);
    expect(stat).toContain(`${STATS.judgedBetCount} 点中 ${STATS.hitBetCount} 点的中`);
    expect(e.fields!.find((f) => f.name === "レース")!.value).toBe(`${STATS.raceCount} 件を分析(開催 ${STATS.dayCount} 日・結果あり ${STATS.resultRaceCount} 件・結果なし ${STATS.noResultRaceCount} 件)`);
  });

  it("「もしも」の field に 5 型を月の成績で出す", () => {
    const e = buildMonthlyEmbed(base);
    const w = e.fields!.find((f) => f.name === "もしも(印の定型・各100円)")!;
    expect(w.value.split("\n")).toHaveLength(5);
    expect(w.value).toContain("◎単勝:");
    expect(w.value).not.toContain("28日");
  });

  it("良かった点・改善点・来月に向けては、それぞれ先頭の 3 件までを出す。空なら field ごと出さない", () => {
    const e = buildMonthlyEmbed(base);
    for (const name of ["良かった点", "改善点", "来月に向けて"]) {
      const lines = e.fields!.find((f) => f.name === name)!.value.split("\n");
      expect(lines, name).toHaveLength(3);
      expect(lines.join(""), name).not.toContain("隠れる");
    }
    const none = buildMonthlyEmbed({ ...base, narrative: { ...NARRATIVE, good: [], improve: [], outlook: [] } });
    for (const name of ["良かった点", "改善点", "来月に向けて"]) {
      expect(none.fields!.map((f) => f.name)).not.toContain(name);
    }
  });

  it("文章が無い月報は、説明に固定の理由を出し、文章の field を持たない", () => {
    const e = buildMonthlyEmbed({ ...base, narrative: null, note: "LLM を使えなかったため、統計だけの月報です" });
    expect(e.description).toBe("LLM を使えなかったため、統計だけの月報です");
    expect(e.fields!.map((f) => f.name)).not.toContain("良かった点");
  });

  it("リンクがあれば url に付ける。無ければ url を持たない", () => {
    expect(buildMonthlyEmbed({ ...base, link: "https://example.com/#report=202610" }).url).toBe("https://example.com/#report=202610");
    expect("url" in buildMonthlyEmbed(base)).toBe(false);
  });

  it("最終日の分が未反映の印があるときだけ、注記の field を出す", () => {
    expect(buildMonthlyEmbed({ ...base, lastDayPending: true }).fields!.map((f) => f.name)).toContain("注記");
    expect(buildMonthlyEmbed(base).fields!.map((f) => f.name)).not.toContain("注記");
  });

  it("帯の色: 回収率 100% 以上は緑、未満は赤、賭け金 0 は灰。語(黒字・赤字)も添える", () => {
    const profit = { ...STATS, recoveryRate: 1.2 };
    const loss = { ...STATS, recoveryRate: 0.8 };
    const none = { ...STATS, recoveryRate: null };
    expect(buildMonthlyEmbed({ ...base, stats: profit }).color).toBe(DISCORD_COLORS.ok);
    expect(buildMonthlyEmbed({ ...base, stats: loss }).color).toBe(DISCORD_COLORS.fail);
    expect(buildMonthlyEmbed({ ...base, stats: none }).color).toBe(DISCORD_COLORS.none);
    expect(buildMonthlyEmbed({ ...base, stats: profit }).fields![0]!.value).toContain("(黒字)");
    expect(buildMonthlyEmbed({ ...base, stats: loss }).fields![0]!.value).toContain("(赤字)");
  });

  it("上限: 文章が上限いっぱいでも、説明 4096・field 1024・合計 6000 に収まる(fitEmbed)", () => {
    const longItem = "あ".repeat(MONTHLY_NARRATIVE_LIMITS.item);
    const long: MonthlyNarrative = { summary: "い".repeat(MONTHLY_NARRATIVE_LIMITS.summary), good: Array(6).fill(longItem), improve: Array(6).fill(longItem), outlook: Array(6).fill(longItem) };
    const e = buildMonthlyEmbed({ ...base, narrative: long, link: "https://example.com/#report=202610" });
    expect(embedLength(e)).toBeLessThanOrEqual(EMBED_LIMITS.total);
    expect((e.description ?? "").length).toBeLessThanOrEqual(EMBED_LIMITS.description);
    for (const f of e.fields ?? []) {
      expect(f.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
    }
    // 前提: 切り詰めを要する入力だった(3 件 × 200 字 × 3 field だけで 1,800 字)
    expect(long.good.slice(0, 3).join("").length).toBe(3 * MONTHLY_NARRATIVE_LIMITS.item);
  });
});

describe("buildMonthlyLink", () => {
  it("月(6 桁)のときだけ、<オリジン>/#report=YYYYMM を返す", () => {
    expect(buildMonthlyLink("https://example.com", "202610")).toBe("https://example.com/#report=202610");
    expect(buildMonthlyLink("https://example.com", "20261031")).toBeUndefined();
    expect(buildMonthlyLink("https://example.com", "2026-10")).toBeUndefined();
    expect(buildMonthlyLink("https://example.com", "202613")).toBeUndefined();
  });
});
