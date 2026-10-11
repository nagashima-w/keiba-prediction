import { describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { estimateFairWinOdds } from "../../packages/core/src/ev/win-odds-estimate";
import { buildAnalysisNotificationEmbed, embedLength, type CloudEmbed, type RaceLabel } from "../src/notify-embeds";
import { formatWinOdds, WIN_ODDS_DISPLAY_MAX } from "../src/win-odds-format";

/**
 * Issue #247: Discord の分析の通知の「印」の field に、想定単勝オッズと分析時点の実際の単勝オッズを添える。
 *  - 行: `◎ 3番 馬名 想定8.5倍/実際12.3倍`(実際が高いときは末尾に ` ↑想定より高い`)。実際のラベルはオッズの状態(確定=実際・発売中=実際(暫定)・発売前=実際(予想))
 *  - 想定も実際も無い馬の行は、従来のまま(何も足さない)。1頭でも足したときは、field の末尾に説明の1行
 *  - EV プラスの馬の行(description。core の embed を exe と共有)には足さない
 */

const label = (): RaceLabel => ({ raceId: "202606040911", venueName: "中山", raceNumber: 11, raceName: "テストステークス", startTime: "15:40" });
const effective = { effective: true, note: null } as const;

/** 12頭の典型的な補正後の3着内率(Σp=2.88。固定馬が出ない)。 */
const PROBS = [0.55, 0.45, 0.38, 0.33, 0.28, 0.24, 0.2, 0.17, 0.12, 0.08, 0.05, 0.03];

function horse(umaban: number, mark: string | null, adjustedProb = PROBS[umaban - 1] ?? 0.1): AnalysisRecord["horses"][number] {
  return { umaban, prior: adjustedProb, adjustedProb, placeOddsMin: 2, ev: 0.8, isPositive: false, contributions: null, mark } as AnalysisRecord["horses"][number];
}

function record(opts: { horses?: AnalysisRecord["horses"]; winOdds?: (umaban: number) => unknown; oddsStatus?: string; names?: (umaban: number) => string | null } = {}): AnalysisRecord {
  const horses = opts.horses ?? PROBS.map((_, i) => horse(i + 1, i === 0 ? "◎" : i === 1 ? "〇" : i === 2 ? "▲" : null));
  return {
    raceId: "202606040911",
    analyzedAt: "2026-09-27T05:00:00.000Z",
    kaisaiDate: "20260927",
    evEstimated: false,
    horses,
    raceSnapshot: {
      race: { raceName: "テストステークス", courseType: "芝", distance: 1600, oddsStatus: opts.oddsStatus ?? "result" },
      horses: horses.map((h) => ({ umaban: h.umaban, name: opts.names ? opts.names(h.umaban) : `馬${h.umaban}`, winOdds: opts.winOdds ? opts.winOdds(h.umaban) : null })),
    },
  } as AnalysisRecord;
}

const marksField = (out: CloudEmbed): { name: string; value: string } | undefined => out.fields?.find((f) => f.name === "印");
const fairOf = (umaban: number): number => estimateFairWinOdds(PROBS.map((p, i) => ({ umaban: i + 1, placeProb: p })))[umaban - 1]!.fairWinOdds!;

describe("Discord の印の field の単勝の想定・実際(Issue #247)", () => {
  it("想定(配分と同じ関数の値)と実際を『想定8.5倍/実際12.3倍』の形で添える。実際が想定より高い馬だけ『↑想定より高い』。印のない馬の行は出ない", () => {
    // 前提: 想定は ◎ が約 3.7 倍・〇 が約 4.9 倍・▲ が約 6.0 倍(丸め前の値で、実際との大小を作り分ける)
    expect(fairOf(1)).toBeGreaterThan(3.6);
    expect(fairOf(1)).toBeLessThan(3.8);
    expect(fairOf(2)).toBeGreaterThan(3.0);
    expect(fairOf(2)).toBeLessThan(9.9);
    expect(fairOf(3)).toBeLessThan(9.9);
    const out = buildAnalysisNotificationEmbed(record({ winOdds: (u) => (u === 1 ? 12.3 : u === 2 ? 3.0 : 9.9) }), effective, label());
    const lines = marksField(out)!.value.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      `◎ 1番 馬1 想定${formatWinOdds(fairOf(1))}/実際12.3倍 ↑想定より高い`,
      `〇 2番 馬2 想定${formatWinOdds(fairOf(2))}/実際3.0倍`,
      `▲ 3番 馬3 想定${formatWinOdds(fairOf(3))}/実際9.9倍 ↑想定より高い`,
    ]);
    expect(lines).toHaveLength(4); // 3行 + 説明の1行
    expect(lines.some((l) => l.includes("4番"))).toBe(false);
  });

  it("具体値で固定: ◎ の想定は 3.7倍(= 0.8 ÷ 勝率)、実際 12.3倍 なら『想定3.7倍/実際12.3倍 ↑想定より高い』", () => {
    const out = buildAnalysisNotificationEmbed(record({ winOdds: () => 12.3 }), effective, label());
    expect(marksField(out)!.value.split("\n")[0]).toBe("◎ 1番 馬1 想定3.7倍/実際12.3倍 ↑想定より高い");
  });

  it("オッズの状態: 発売中は『実際(暫定)』・発売前は『実際(予想)』・確定は『実際』", () => {
    for (const [status, text] of [["middle", "実際(暫定)"], ["yoso", "実際(予想)"], ["result", "実際"]] as const) {
      const out = buildAnalysisNotificationEmbed(record({ oddsStatus: status, winOdds: () => 12.3 }), effective, label());
      expect(marksField(out)!.value.split("\n")[0], status).toBe(`◎ 1番 馬1 想定3.7倍/${text}12.3倍 ↑想定より高い`);
    }
  });

  it("実際が欠損(未確定 null・不正)は『実際-』。想定は出る", () => {
    for (const bad of [null, "5.0", Number.NaN, 0.5, undefined]) {
      const out = buildAnalysisNotificationEmbed(record({ winOdds: () => bad }), effective, label());
      expect(marksField(out)!.value.split("\n")[0], String(bad)).toBe("◎ 1番 馬1 想定3.7倍/実際-");
    }
  });

  it("想定が欠損(3着内率 0・判定不能)は『想定-』。実際は出る。強調なし", () => {
    const zero = buildAnalysisNotificationEmbed(
      record({ horses: PROBS.map((_, i) => horse(i + 1, i === 0 ? "◎" : null, i === 0 ? 0 : PROBS[i])), winOdds: () => 12.3 }),
      effective,
      label(),
    );
    expect(marksField(zero)!.value.split("\n")[0]).toBe("◎ 1番 馬1 想定-/実際12.3倍");
    // 頭数が3頭(判定不能)
    const three = buildAnalysisNotificationEmbed(record({ horses: [horse(1, "◎", 0.9), horse(2, null, 0.6), horse(3, null, 0.5)], winOdds: () => 5.5 }), effective, label());
    expect(marksField(three)!.value.split("\n")[0]).toBe("◎ 1番 馬1 想定-/実際5.5倍");
  });

  it("想定も実際も無い馬の行には何も足さない(従来のまま)。1頭も足さなければ説明の行も無い", () => {
    const horses = [horse(1, "◎", 0), horse(2, "〇", 0.45)];
    // 2頭 = 判定不能で想定は全頭 null、実際も無い
    const out = buildAnalysisNotificationEmbed(record({ horses }), effective, label());
    expect(marksField(out)!.value).toBe("◎ 1番 馬1\n〇 2番 馬2");
  });

  it("説明の1行: 目安・払戻率80%・地方も80%と仮定・EV>1 とは限らない。価値判断の語を含まない", () => {
    const out = buildAnalysisNotificationEmbed(record({ winOdds: () => 12.3 }), effective, label());
    const lines = marksField(out)!.value.split("\n");
    const note = lines[lines.length - 1]!;
    expect(note.startsWith("※")).toBe(true);
    for (const word of ["目安", "80%", "地方", "EV"]) {
      expect(note, word).toContain(word);
    }
    expect(note).not.toMatch(/妙味|お得/);
  });

  it("EV プラスの馬の行(description)には足さない(core の embed を変えない)", () => {
    const horses = PROBS.map((_, i) => ({ ...horse(i + 1, i === 0 ? "◎" : null), isPositive: i === 0, ev: i === 0 ? 1.05 : 0.8 })) as AnalysisRecord["horses"];
    const out = buildAnalysisNotificationEmbed(record({ horses, winOdds: () => 12.3 }), effective, label());
    expect(out.description).toContain("◎ 1番 馬1 AI補正後55.0% 複勝下限2.0 EV1.05");
    expect(out.description).not.toContain("想定");
    expect(out.description).not.toContain("実際");
  });

  it("最悪ケース(印8頭・馬名32文字・実際(暫定)・1000倍超・強調あり)でも、印の field は 1024 以内で、8頭と説明の行が1行も落ちない。embed 全体は 6000 以内", () => {
    const marks = ["◎", "〇", "▲", "△", "△", "△", "☆", "注"];
    const horses = PROBS.map((_, i) => horse(i + 1, marks[i] ?? null, i < 8 ? PROBS[i] : PROBS[i]));
    // 3着内率が極小の馬は想定が 1000 倍超になる
    const tiny = horses.map((h) => (h.umaban === 8 ? { ...h, adjustedProb: 0.0001 } : h)) as AnalysisRecord["horses"];
    const out = buildAnalysisNotificationEmbed(record({ horses: tiny, oddsStatus: "middle", names: () => "あ".repeat(32), winOdds: () => 5000 }), effective, label());
    const field = marksField(out)!;
    const lines = field.value.split("\n");
    expect(lines).toHaveLength(9); // 前提: 8頭 + 説明の行(1行も落ちていない=退化させない)
    expect(lines[7]).toContain(`想定${formatWinOdds(1e9)}`); // 極小の確率の馬の想定は「1000倍超」
    expect(lines[7]).toContain(`実際(暫定)${WIN_ODDS_DISPLAY_MAX}倍超`);
    expect(field.value.length).toBeLessThanOrEqual(1024);
    expect(embedLength(out)).toBeLessThanOrEqual(6000);
  });

  it("18頭すべてに印があっても、field は 1024 以内・embed 全体は 6000 以内(収まらない行は既存の『…ほか N 件』で落ちる)", () => {
    const horses = Array.from({ length: 18 }, (_, i) => horse(i + 1, "△", 0.5 - i * 0.02));
    const out = buildAnalysisNotificationEmbed(record({ horses, names: () => "あ".repeat(32), winOdds: () => 5000 }), effective, label());
    expect(marksField(out)!.value.length).toBeLessThanOrEqual(1024);
    expect(marksField(out)!.value).toMatch(/…ほか \d+ 件$/);
    expect(embedLength(out)).toBeLessThanOrEqual(6000);
  });
});
