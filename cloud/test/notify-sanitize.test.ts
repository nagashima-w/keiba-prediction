import { describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { escapeDiscordMarkdown } from "../../packages/core/src/notify/discord-escape";
import { buildDayStats } from "../src/daily-report-digest";
import { buildReportEmbed } from "../src/daily-report-embed";
import { buildMonthlyEmbed } from "../src/monthly-report-embed";
import { buildAnalysisNotificationEmbed, buildFailureEmbed, buildPlanFailureEmbed, buildSummaryEmbed, fitEmbed, type CloudEmbed, type RaceLabel } from "../src/notify-embeds";
import type { PlanProgress } from "../src/race-day-core";
import { SMALL_MONTH_SPEC, syntheticMonthStats } from "./monthly-fixtures";

/**
 * Issue #301: Discord の embed に載る「外から来た文字列」(LLM の日報・月報の文章、netkeiba の馬名・レース名・会場名)の無害化。
 * 日報・月報の文章を保存する web 側には掛けない(画面にバックスラッシュが見えるため)ので、**embed を組み立てる側**で掛ける。
 * 掛けた結果は『素の `[` `]` が 1 つも残らない』(= マスクドリンクが成立しない)ことと、**二重に escape されていない**ことの両方を見る。
 */

const LINK = "[公式](https://evil.example/login)";
const LINK_ESCAPED = "\\[公式\\](https://evil.example/login)";
/** 馬名(32 コードポイント)・行のレース名(20 コードポイント)の切り詰めに掛からない短さのもの。 */
const TINY = "[a](b.c)";
const TINY_ESCAPED = "\\[a\\](b.c)";

/** escape の対(バックスラッシュ + `[` または `]`)を取り除いたあとに、素の `[` `]` が残っているか。 */
const hasRawBracket = (text: string): boolean => /[[\]]/.test(text.replace(/\\[[\]]/g, ""));

/** embed のすべての文字列(title・description・field の name と value)。 */
const allTexts = (e: CloudEmbed): string[] => [e.title ?? "", e.description ?? "", ...(e.fields ?? []).flatMap((f) => [f.name, f.value])];

describe("日報の embed: LLM の文章を escape する", () => {
  const STATS = { ...buildDayStats([]), raceCount: 3, resultRaceCount: 3, totalStake: 1000, totalReturn: 1200, recoveryRate: 1.2, judgedBetCount: 10, hitBetCount: 2 };
  const narrative = { summary: `総括 ${LINK} **強調** @everyone`, good: [`良い ${LINK}`, "普通の良かった点(括弧つき)"], improve: [`# 見出し ${LINK}`], races: [] };
  const e = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative, note: null, link: undefined });
  const field = (name: string) => e.fields!.find((f) => f.name === name)!;

  it("総括(description)・良かった点・改善点の値が escape される(期待する文字列をそのまま固定する)", () => {
    expect(e.description).toBe(`総括 ${LINK_ESCAPED} \\*\\*強調\\*\\* @everyone`);
    expect(field("良かった点").value).toBe(`・良い ${LINK_ESCAPED}\n・普通の良かった点(括弧つき)`);
    // 項目の文字列そのものを 1 つの文字列として escape する(『・』を足す前)ので、項目の先頭の # は行頭の規則で escape される。
    // 実際の行頭は『・』なので書式にはならず、過剰な escape だが、Discord はバックスラッシュを表示しないので見た目は変わらない。
    expect(field("改善点").value).toBe(`・\\# 見出し ${LINK_ESCAPED}`);
  });

  it("素の [ ] は、どの文字列にも残らない", () => {
    expect(allTexts(e).filter(hasRawBracket)).toEqual([]);
  });

  it("文章が無い日報(固定の理由 note)は変わらない", () => {
    const none = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative: null, note: "LLM の API キーが未登録のため、統計だけの日報です", link: undefined });
    expect(none.description).toBe("LLM の API キーが未登録のため、統計だけの日報です");
  });

  it("惜しかったレースのレース名(netkeiba 由来)が escape される", () => {
    const races = [{ raceId: "R1", title: `東京5R ${LINK}` }];
    const near = { total: 1, shown: [{ raceId: "R1", templateId: "trio" as const, payout: 12340 }] };
    const out = buildReportEmbed({ kaisaiDate: "20261010", stats: STATS, narrative, note: null, link: undefined, nearMisses: near, races });
    const value = out.fields!.find((f) => f.name.startsWith("惜しかったレース"))!.value;
    expect(value).toBe(`東京5R ${LINK_ESCAPED}: ◎〇▲の3連複 12,340円`);
  });
});

describe("月報の embed: LLM の文章を escape する", () => {
  const stats = syntheticMonthStats(SMALL_MONTH_SPEC);
  const narrative = { summary: `総括 ${LINK}`, good: [`g ${LINK}`], improve: ["i *x*"], outlook: [`o ${LINK}`, "来月も(通常どおり)"] };
  const e = buildMonthlyEmbed({ month: "202610", stats, narrative, note: null, link: undefined, lastDayPending: false });
  const field = (name: string) => e.fields!.find((f) => f.name === name)!;

  it("総括・良かった点・改善点・来月に向けての値が escape される", () => {
    expect(e.description).toBe(`総括 ${LINK_ESCAPED}`);
    expect(field("良かった点").value).toBe(`・g ${LINK_ESCAPED}`);
    expect(field("改善点").value).toBe("・i \\*x\\*");
    expect(field("来月に向けて").value).toBe(`・o ${LINK_ESCAPED}\n・来月も(通常どおり)`);
  });

  it("素の [ ] は、どの文字列にも残らない", () => {
    expect(allTexts(e).filter(hasRawBracket)).toEqual([]);
  });
});

describe("レース・分析の通知の embed: netkeiba 由来の馬名・レース名・会場名を escape する", () => {
  const label = (over: Partial<RaceLabel> = {}): RaceLabel => ({ raceId: "202606040911", venueName: "中山", raceNumber: 11, raceName: "テストステークス", startTime: "15:40", ...over });

  it("失敗の通知の title: レース名・会場名が escape される。通常のレース名(括弧つき)・グレードは変わらない", () => {
    expect(buildFailureEmbed(label({ raceName: `杯 ${LINK}`, venueName: "中*山" }), "x").title).toBe(`中\\*山 11R 杯 ${LINK_ESCAPED}`);
    expect(buildFailureEmbed(label({ raceName: "ジャパンC", grade: "G1" }), "x").title).toBe("中山 11R ジャパンC(G1)");
  });

  const record = (over: Partial<AnalysisRecord> = {}): AnalysisRecord =>
    ({
      raceId: "202606040911",
      analyzedAt: "2026-09-27T05:00:00.000Z",
      kaisaiDate: "20260927",
      evEstimated: false,
      horses: [{ umaban: 1, prior: 0.3, adjustedProb: 0.42, placeOddsMin: 2.5, ev: 1.05, isPositive: true, contributions: null, mark: "◎" }],
      raceSnapshot: {
        race: { raceName: `杯 ${LINK}`, courseType: "芝", distance: 1600, oddsStatus: "result" },
        horses: [{ umaban: 1, name: `馬 ${TINY}` }],
      },
      ...over,
    }) as AnalysisRecord;

  it("分析の完了: title・EV プラスの行(core)・印の field の馬名・メタ行の会場名が 1 回だけ escape される(二重に escape しない)", () => {
    const out = buildAnalysisNotificationEmbed(record(), { effective: true, note: null }, label({ venueName: "中*山" }));
    expect(out.title).toBe(`中\\*山 11R 杯 ${LINK_ESCAPED}`);
    expect(out.description).toContain("2026/09/27 / 中\\*山 / 芝1600m");
    expect(out.description).toContain(`◎ 1番 馬 ${TINY_ESCAPED} AI補正後42.0% 複勝下限2.5 EV1.05`);
    const marks = out.fields!.find((f) => f.name === "印")!.value;
    expect(marks.split("\n")[0]).toContain(`◎ 1番 馬 ${TINY_ESCAPED}`);
    expect(allTexts(out).filter(hasRawBracket)).toEqual([]);
    // 二重 escape(バックスラッシュが 2 個続く)になっていない
    expect(allTexts(out).filter((t) => t.includes("\\\\"))).toEqual([]);
  });

  it("分析の完了: こちらが書く固定文(LLM の注記)・印・数値は escape されない(外から来た文字列だけを対象にする)", () => {
    const out = buildAnalysisNotificationEmbed(record(), { effective: false, note: "LLM の API キー(ANTHROPIC_API_KEY)が未登録" }, label());
    expect(out.description).toContain("LLM補正の注記: LLM の API キー(ANTHROPIC_API_KEY)が未登録");
    expect(out.description).toContain("LLM補正: スキップ");
  });

  type Row = PlanProgress["rows"][number];
  const row = (over: Partial<Row> & { raceId: string }): Row => ({
    venue: "central",
    venueName: "中山",
    raceNumber: 1,
    raceName: "R",
    grade: null,
    startTime: "10:00",
    dueMs: 1,
    disposition: "scheduled",
    skipReason: null,
    state: "promoted",
    morning: "done",
    ...over,
  });
  const progress = (rows: Row[]): PlanProgress => ({
    stage: "done",
    requestedAt: 1,
    finalizedAt: 2,
    offsetMinutes: 45,
    offsetSource: "settings",
    venues: [
      { venue: "central", state: "ok", attempts: 1, reason: null, listed: 1, targeted: 1 },
      { venue: "nar", state: "ok", attempts: 1, reason: null, listed: 0, targeted: 0 },
    ],
    rows,
    morningAllTerminal: true,
  });

  it("事前分析のまとめ: 行のレース名と、場ごとの field の名前(会場名)が escape される。普通の行は変わらない", () => {
    const rows = [row({ raceId: "202606040901", raceName: `杯 ${TINY}`, venueName: "中*山" }),row({ raceId: "202609030901", venueName: "阪神", raceName: "阪神1(G3)", raceNumber: 2 })];
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress(rows) });
    expect(out.fields!.map((f) => f.name).slice(0, 2)).toEqual(["中\\*山", "阪神"]);
    expect(out.fields![0]!.value).toBe(`1R 杯 ${TINY_ESCAPED} 10:00 事前分析OK`);
    expect(out.fields![1]!.value).toBe("2R 阪神1(G3) 10:00 事前分析OK");
  });

  it("事前分析の失敗: 行のレース名・会場名が escape される", () => {
    const rows = [row({ raceId: "202606040901", raceName: `杯 ${TINY}`, venueName: "中*山", morning: "failed" })];
    const out = buildPlanFailureEmbed({ progress: progress(rows), reasons: { planNotFinal: false, venueFailures: [], morningFailed: 1, morningIncomplete: 0, capSkipped: 0 }, kaisaiDate: "20260927" });
    expect(out.fields!.map((f) => f.value).join("\n")).toContain(`中\\*山 1R 杯 ${TINY_ESCAPED}`);
    expect(allTexts(out).filter(hasRawBracket)).toEqual([]);
  });
});

describe("AC5: escape の後に切り詰めても、escape の対を割らない(fitEmbed)", () => {
  /** 末尾の『…』の直前に続くバックスラッシュの数。 */
  const danglingRun = (text: string): number => {
    const body = text.endsWith("…") ? text.slice(0, -1) : text;
    return /\\*$/.exec(body)![0].length;
  };

  it("前提: 切り詰めの境界(先頭 4095 文字)の末尾が奇数個のバックスラッシュで終わる入力が、表の中に実際にある(境界を踏んでいる)", () => {
    const texts = [0, 1].map((prefix) => `${"a".repeat(prefix)}${"\\*".repeat(2100)}`);
    const odd = texts.filter((t) => /\\*$/.exec(t.slice(0, 4095))![0].length % 2 === 1);
    expect(odd).toHaveLength(1);
  });

  it.each([0, 1])("description(先頭に %i 文字の通常文字 + escape された * の連続): 切った後の末尾に孤立したバックスラッシュが残らない", (prefix) => {
    const text = `${"a".repeat(prefix)}${escapeDiscordMarkdown("*".repeat(2100))}`;
    const out = fitEmbed({ title: "t", description: text }).description!;
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith("…")).toBe(true); // 前提: 実際に切った
    expect(danglingRun(out) % 2).toBe(0);
  });

  it.each([0, 1])("field の value(1 行・先頭に %i 文字の通常文字): 同じ", (prefix) => {
    const text = `${"a".repeat(prefix)}${escapeDiscordMarkdown("*".repeat(600))}`;
    const out = fitEmbed({ title: "t", fields: [{ name: "f", value: text }] }).fields![0]!.value;
    expect(out.length).toBeLessThanOrEqual(1024);
    expect(out.endsWith("…")).toBe(true);
    expect(danglingRun(out) % 2).toBe(0);
  });

  it.each([0, 1])("title(先頭に %i 文字の通常文字): 同じ", (prefix) => {
    const text = `${"a".repeat(prefix)}${escapeDiscordMarkdown("*".repeat(200))}`;
    const out = fitEmbed({ title: text }).title!;
    expect(out.length).toBeLessThanOrEqual(256);
    expect(out.endsWith("…")).toBe(true);
    expect(danglingRun(out) % 2).toBe(0);
  });

  it("レース名が長くて title(256)で切れるとき(raceTitle の切り詰め)も、孤立したバックスラッシュを残さない", () => {
    // 先頭の通常文字の数(0・1)で、切り詰めの境界(先頭 255 文字)が escape の対の途中になる入力と、ならない入力の両方を作る。
    const cases = [0, 1].map((p) => ({ raceName: `${"a".repeat(p)}${"*".repeat(200)}`, full: `中山 ${"a".repeat(p)}${escapeDiscordMarkdown("*".repeat(200))}` }));
    const oddBoundary = cases.filter((c) => /\\*$/.exec(c.full.slice(0, 255))![0].length % 2 === 1);
    expect(oddBoundary).toHaveLength(1); // 前提: 対の途中で切れる入力が実際にある
    for (const c of cases) {
      const title = buildFailureEmbed({ raceId: "202606040911", venueName: "中山", raceNumber: null, raceName: c.raceName, startTime: null }, "x").title!;
      expect(title.length).toBeLessThanOrEqual(256);
      expect(title.endsWith("…")).toBe(true);
      expect(danglingRun(title) % 2).toBe(0);
    }
  });
});
