import { describe, expect, it } from "vitest";
import { buildDayStats, type DayStats } from "../src/daily-report-digest";
import { buildReportEmbed } from "../src/daily-report-embed";
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
    expect(e.fields!.find((f) => f.name === "レース")!.value).toContain("36 件");
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
    expect(color({ ...STATS, recoveryRate: 1 })).toBe(0x2ecc71);
    expect(color({ ...STATS, recoveryRate: 0.99 })).toBe(0xe74c3c);
    expect(color({ ...STATS, recoveryRate: null, totalStake: 0 })).toBe(0x95a5a6);
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
