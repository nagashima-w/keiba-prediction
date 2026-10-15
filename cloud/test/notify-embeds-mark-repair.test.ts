import { describe, expect, it } from "vitest";
import type { MarkRepairReport } from "@keiba/core/llm";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { buildAnalysisNotificationEmbed, EMBED_LIMITS, type CloudEmbed, type RaceLabel } from "../src/notify-embeds";

/**
 * Issue #317: 分析完了の Discord の embed の「印」の欄に、印を補修した馬の目印「直 元の印→今の印」を出す。
 * 補修していない馬の行は、これまでと1文字も変わらない。固定の語彙だけ(LLM の生の文字列は出さない)。embed の長さの上限(field 1024・全体 6000)を超えない。
 */

const label: RaceLabel = { raceId: "202606040911", venueName: "中山", raceNumber: 11, raceName: "テストステークス", startTime: "15:40" };
const effective = (markRepair: MarkRepairReport | null) => ({ effective: true, note: markRepair?.repaired ? "印の一部を規則に合わせて直しました(3着内率の補正は反映しています)" : null, markRepair });

const horse = (umaban: number, mark: string | null, adjustedProb = 0): AnalysisRecord["horses"][number] =>
  ({ umaban, prior: 0.2, adjustedProb, placeOddsMin: 2, ev: 0.8, isPositive: false, contributions: null, mark }) as AnalysisRecord["horses"][number];
const record = (horses: AnalysisRecord["horses"], names: readonly (string | null)[]): AnalysisRecord =>
  ({
    raceId: "202606040911",
    analyzedAt: "2026-09-27T05:00:00.000Z",
    kaisaiDate: "20260927",
    evEstimated: false,
    horses,
    raceSnapshot: { race: { raceName: "R", courseType: "芝", distance: 1600, oddsStatus: "result" }, horses: names.map((name, i) => ({ umaban: i + 1, name })) },
  }) as AnalysisRecord;
const marksLines = (out: CloudEmbed): string[] => out.fields!.find((f) => f.name === "印")!.value.split("\n").filter((l) => !l.startsWith("※"));
const embedLength = (out: CloudEmbed): number =>
  (out.title?.length ?? 0) + (out.description?.length ?? 0) + (out.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

const REPAIRED: MarkRepairReport = {
  repaired: true,
  adoptedAttempt: 2,
  attempts: [{ n: 1, kinds: ["over-◎"] }, { n: 2, kinds: ["over-◎"] }],
  changes: [
    { umaban: 2, from: "◎", to: "〇" },
    { umaban: 3, from: "なし", to: "▲" },
    { umaban: 4, from: "☆", to: null }, // 印が消えた馬(印の欄には載らない)
    { umaban: 5, from: "不明", to: null },
  ],
};

describe("buildAnalysisNotificationEmbed: 印を補修した馬の目印(Issue #317)", () => {
  const horses = [horse(1, "◎"), horse(2, "〇"), horse(3, "▲"), horse(4, null), horse(5, null)];
  const names = ["アルファ", "ブラボー", "チャーリー", "デルタ", "エコー"];

  it("補修した馬の行に「直 元の印→今の印」が付く。補修していない馬の行は変わらない。印が消えた馬は欄に載らない", () => {
    const out = buildAnalysisNotificationEmbed(record(horses, names), effective(REPAIRED), label);
    expect(marksLines(out)).toEqual(["◎ 1番 アルファ", "〇 2番 ブラボー 直 ◎→〇", "▲ 3番 チャーリー 直 印なし→▲"]);
  });

  it("補修していない(markRepair が null・repaired:false)ときは、どの行にも「直」が付かない", () => {
    const resolved: MarkRepairReport = { repaired: false, adoptedAttempt: 2, attempts: [{ n: 1, kinds: ["over-◎"] }], changes: [] };
    for (const r of [null, resolved]) {
      const out = buildAnalysisNotificationEmbed(record(horses, names), effective(r), label);
      expect(marksLines(out).some((l) => l.includes("直")), String(r)).toBe(false);
    }
    // outcome に markRepair が無い旧い呼び出し(note と effective だけ)も動く。
    const out = buildAnalysisNotificationEmbed(record(horses, names), { effective: true, note: null }, label);
    expect(marksLines(out)).toEqual(["◎ 1番 アルファ", "〇 2番 ブラボー", "▲ 3番 チャーリー"]);
  });

  it("現在の印が記録の補修後の印と食い違う馬には付けない", () => {
    const stale: MarkRepairReport = { ...REPAIRED, changes: [{ umaban: 2, from: "◎", to: "▲" }] }; // 2番の印は〇
    const out = buildAnalysisNotificationEmbed(record(horses, names), effective(stale), label);
    expect(marksLines(out).some((l) => l.includes("直"))).toBe(false);
  });

  it("race 全体の注記(LLM補正の注記)に、補修の固定文言が出る", () => {
    const out = buildAnalysisNotificationEmbed(record(horses, names), effective(REPAIRED), label);
    expect(out.description).toContain("LLM補正の注記: 印の一部を規則に合わせて直しました");
  });

  it("最悪の長さ: 印の付く最大 8 頭がすべて補修され、馬名が 32 文字でも、field は 1024 以内・embed 全体は 6000 以内で、1行も落ちない(「…ほか」が出ない)", () => {
    // 印の欄に載るのは最大 ◎1・〇1・▲1・△3・☆1・注1 = 8 頭(補修後の印は規則を満たす)。全頭を「なし→印」の補修にして、行を最長にする。
    const marks = ["◎", "〇", "▲", "△", "△", "△", "☆", "注"];
    const hs = marks.map((m, i) => horse(i + 1, m, 0));
    const longNames = marks.map(() => "あ".repeat(32));
    const report: MarkRepairReport = { repaired: true, adoptedAttempt: 2, attempts: [{ n: 1, kinds: ["over-◎"] }], changes: marks.map((m, i) => ({ umaban: i + 1, from: "なし" as const, to: m as "◎" })) };
    const out = buildAnalysisNotificationEmbed(record(hs, longNames), effective(report), label);
    const lines = marksLines(out);
    expect(lines).toHaveLength(8); // 前提: 8 頭とも載っていて、落ちていない(退化させない)
    expect(lines.every((l) => l.includes(" 直 印なし→"))).toBe(true); // 前提: 全行が最長の目印つき
    const field = out.fields!.find((f) => f.name === "印")!;
    expect(field.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
    expect(embedLength(out)).toBeLessThanOrEqual(EMBED_LIMITS.total);
    expect(field.value).not.toContain("ほか");
  });

  it("単勝・複勝の想定が付く行でも、目印は馬名の直後(想定の前)に付き、行が壊れない", () => {
    const hs = [horse(1, "◎", 0.5), horse(2, "〇", 0.3), horse(3, null, 0.2)];
    const out = buildAnalysisNotificationEmbed(record(hs, ["アルファ", "ブラボー", "チャーリー"]), effective({ ...REPAIRED, changes: [{ umaban: 2, from: "◎", to: "〇" }] }), label);
    const line = out.fields!.find((f) => f.name === "印")!.value.split("\n")[1]!;
    expect(line.startsWith("〇 2番 ブラボー 直 ◎→〇")).toBe(true);
  });
});
