import { describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { estimateFairPlaceOdds } from "../../packages/core/src/ev/place-odds-estimate";
import { buildAnalysisNotificationEmbed, ODDS_FIELD_NOTE, type CloudEmbed, type RaceLabel } from "../src/notify-embeds";
import { embedLength } from "./support/embed-length";
import { formatFairPlaceOdds } from "../src/place-odds-format";

/**
 * Issue #253: Discord の分析の通知の「印」の field に、単勝に続けて複勝の想定と実際(下限〜上限)を添える。
 *  - 行: `◎ 3番 馬名 単勝 想定8.5倍/実際12.3倍 ↑想定より高い 複勝 想定1.5倍/実際1.6〜2.3倍 ↑想定より高い`(単勝・複勝それぞれ、高いときだけ末尾に ` ↑想定より高い`)
 *  - 5〜7頭は `複勝(2着まで)`。4頭以下(基準なし)・複勝の想定も実際の下限も無い馬は、複勝の部分を足さない
 *  - 複勝の「↑」は実際の**下限**と想定を丸めた値どうしで比べる。想定が 1.0倍未満のときは比べない
 *  - 説明の1行は末尾に1つだけ(単勝・複勝の両方の注意を含む)
 */

const label = (): RaceLabel => ({ raceId: "202606040911", venueName: "中山", raceNumber: 11, raceName: "テストステークス", startTime: "15:40" });
const effective = { effective: true, note: null } as const;

/** 12頭の典型的な補正後の3着内率(Σp=2.88)。 */
const PROBS = [0.55, 0.45, 0.38, 0.33, 0.28, 0.24, 0.2, 0.17, 0.12, 0.08, 0.05, 0.03];
/** 6頭(Σp=3。複勝は2着まで)。 */
const SIX = [0.7, 0.6, 0.5, 0.5, 0.4, 0.3];

function horse(umaban: number, mark: string | null, adjustedProb: number): AnalysisRecord["horses"][number] {
  return { umaban, prior: adjustedProb, adjustedProb, placeOddsMin: 2, ev: 0.8, isPositive: false, contributions: null, mark } as AnalysisRecord["horses"][number];
}

interface PlaceSpec {
  readonly min?: unknown;
  readonly max?: unknown;
}

function record(opts: {
  probs?: readonly number[];
  marks?: (umaban: number) => string | null;
  place?: (umaban: number) => PlaceSpec;
  winOdds?: (umaban: number) => unknown;
  oddsStatus?: string;
  names?: (umaban: number) => string | null;
}): AnalysisRecord {
  const probs = opts.probs ?? PROBS;
  const marks = opts.marks ?? ((u: number) => (u === 1 ? "◎" : u === 2 ? "〇" : u === 3 ? "▲" : null));
  const horses = probs.map((p, i) => horse(i + 1, marks(i + 1), p));
  return {
    raceId: "202606040911",
    analyzedAt: "2026-09-27T05:00:00.000Z",
    kaisaiDate: "20260927",
    evEstimated: false,
    horses,
    raceSnapshot: {
      race: { raceName: "テストステークス", courseType: "芝", distance: 1600, oddsStatus: opts.oddsStatus ?? "result" },
      horses: horses.map((h) => {
        const p = opts.place ? opts.place(h.umaban) : {};
        return {
          umaban: h.umaban,
          name: opts.names ? opts.names(h.umaban) : `馬${h.umaban}`,
          winOdds: opts.winOdds ? opts.winOdds(h.umaban) : null,
          placeOddsMin: p.min ?? null,
          ...("max" in p ? { placeOddsMax: p.max } : {}),
        };
      }),
    },
  } as AnalysisRecord;
}

const marksField = (out: CloudEmbed): { name: string; value: string } | undefined => out.fields?.find((f) => f.name === "印");
const linesOf = (r: AnalysisRecord): string[] => marksField(buildAnalysisNotificationEmbed(r, effective, label()))!.value.split("\n");

describe("Discord の印の field の複勝の想定・実際(Issue #253)", () => {
  it("単勝の後ろに『複勝 想定…/実際…(下限〜上限)』を添える。実際の下限が想定より高い馬だけ『↑想定より高い』。印のない馬の行は出ない", () => {
    // 想定: ◎ 0.8/0.55=1.45→1.5倍(下限 1.6 は高い)・〇 0.8/0.45=1.78→1.8倍(下限 1.8 は同じ=強調なし)・▲ 0.8/0.38=2.11→2.1倍(下限 1.5 は低い)
    const lines = linesOf(record({ winOdds: () => 12.3, place: (u) => ({ min: u === 1 ? 1.6 : u === 2 ? 1.8 : 1.5, max: u === 1 ? 2.3 : u === 2 ? 2.4 : 1.9 }) }));
    expect(lines.slice(0, 3)).toEqual([
      "◎ 1番 馬1 単勝 想定3.7倍/実際12.3倍 ↑想定より高い 複勝 想定1.5倍/実際1.6〜2.3倍 ↑想定より高い",
      "〇 2番 馬2 単勝 想定4.9倍/実際12.3倍 ↑想定より高い 複勝 想定1.8倍/実際1.8〜2.4倍",
      "▲ 3番 馬3 単勝 想定6.0倍/実際12.3倍 ↑想定より高い 複勝 想定2.1倍/実際1.5〜1.9倍",
    ]);
    expect(lines).toHaveLength(4); // 3行 + 説明の1行
  });

  it("単勝の実際が無くても、複勝は出る(単勝は『実際-』、複勝は幅つき)。単勝が全く無い馬は『単勝』の部分を足さない", () => {
    const withActual = linesOf(record({ place: () => ({ min: 1.6, max: 2.3 }) }));
    expect(withActual[0]).toBe("◎ 1番 馬1 単勝 想定3.7倍/実際- 複勝 想定1.5倍/実際1.6〜2.3倍 ↑想定より高い");
    // 単勝の想定が無い(3着内率 0)馬でも、実際の単勝が無ければ単勝の部分は無く、複勝の実際だけ
    const noWin = linesOf(record({ probs: [0, ...PROBS.slice(1)], place: () => ({ min: 1.6, max: 2.3 }) }));
    expect(noWin[0]).toBe("◎ 1番 馬1 複勝 想定-/実際1.6〜2.3倍");
  });

  it("オッズの状態: 発売中は複勝も『実際(暫定)』・発売前は『実際(予想)』(複勝が未発売の下限なしは『実際(予想)-』)・確定は『実際』", () => {
    for (const [status, text] of [["middle", "実際(暫定)"], ["yoso", "実際(予想)"], ["result", "実際"]] as const) {
      const lines = linesOf(record({ oddsStatus: status, place: () => ({ min: 1.6, max: 2.3 }) }));
      expect(lines[0], status).toBe(`◎ 1番 馬1 単勝 想定3.7倍/${text}- 複勝 想定1.5倍/${text}1.6〜2.3倍 ↑想定より高い`);
    }
    const yoso = linesOf(record({ oddsStatus: "yoso" }));
    expect(yoso[0]).toBe("◎ 1番 馬1 単勝 想定3.7倍/実際(予想)- 複勝 想定1.5倍/実際(予想)-");
  });

  it("上限が無い(過去の分析)は『実際1.6倍〜』。下限が欠損・不正(未確定 null・文字列・NaN・1.0 未満)は『実際-』", () => {
    expect(linesOf(record({ place: () => ({ min: 1.6 }) }))[0]).toContain("複勝 想定1.5倍/実際1.6倍〜 ↑想定より高い");
    for (const bad of [null, "1.6", Number.NaN, 0.5, undefined]) {
      expect(linesOf(record({ place: () => ({ min: bad, max: 2.3 }) }))[0], String(bad)).toContain("複勝 想定1.5倍/実際-");
    }
  });

  it("想定が 1.0倍未満(3着内率 90%)は『想定1.0倍未満』で強調なし(下限が 1.0 でも)", () => {
    const lines = linesOf(record({ probs: [0.9, ...PROBS.slice(1)], place: () => ({ min: 1.0, max: 1.2 }) }));
    expect(lines[0]).toContain("複勝 想定1.0倍未満/実際1.0〜1.2倍");
    expect(lines[0]!.endsWith("↑想定より高い")).toBe(false);
  });

  it("5〜7頭は『複勝(2着まで)』と2着内率からの想定。基準は core の estimateFairPlaceOdds(top2)と一致", () => {
    const fair = estimateFairPlaceOdds(SIX.map((p, i) => ({ umaban: i + 1, placeProb: p })), "top2");
    expect(fair.every((e) => e.fairPlaceOdds !== null)).toBe(true); // 前提
    const lines = linesOf(record({ probs: SIX, place: () => ({ min: 1.2, max: 1.9 }) }));
    const expected = `複勝(2着まで) 想定${formatFairPlaceOdds(fair[0]!.fairPlaceOdds)}/実際1.2〜1.9倍`;
    expect(lines[0]).toContain(expected);
    expect(lines[0]).toContain("複勝(2着まで) 想定1.6倍"); // ◎(3着内率 0.7)の2着内率は約 0.505 → 1.58 倍 → 1.6倍。3着内率からなら 1.1倍
    expect(lines[0]).not.toContain("想定1.1倍/実際1.2");
    // 8頭以上には『(2着まで)』が付かない
    expect(linesOf(record({ place: () => ({ min: 1.2, max: 1.9 }) })).join("\n")).not.toContain("2着まで");
  });

  it("4頭以下(複勝が発売されない)は、複勝の部分を足さない(実際の値があっても出さない)", () => {
    const lines = linesOf(record({ probs: [0.9, 0.7, 0.6, 0.5], winOdds: () => 5.5, place: () => ({ min: 1.2, max: 1.9 }) }));
    expect(lines[0]).toBe("◎ 1番 馬1 単勝 想定-/実際5.5倍"); // 4頭 = 単勝も判定不能(想定 -)。複勝の部分は無い
    expect(lines.slice(0, -1).join("\n")).not.toContain("複勝"); // 行にも無い(末尾の説明の1行には「複勝」の語がある)
    expect(lines.slice(0, -1)).toHaveLength(3); // 前提: 印の3頭の行を見ている
  });

  it("複勝の想定も実際の下限も無い馬は、複勝の部分を足さない(3着内率 0・上限だけある場合を含む)", () => {
    const lines = linesOf(record({ probs: [0, 0.45, ...PROBS.slice(2)], place: (u) => (u === 1 ? { min: null, max: 2.3 } : {}) }));
    expect(lines[0]).toBe("◎ 1番 馬1");
    expect(lines[1]).toContain("複勝 想定1.8倍/実際-");
  });

  it("説明の1行は末尾に1つだけで、単勝・複勝の両方の注意を含む(目安・払戻率80%・地方も80%と仮定・EV>1 とは限らない・複勝は下限と比較・5〜7頭は2着内率)", () => {
    const lines = linesOf(record({ winOdds: () => 12.3, place: () => ({ min: 1.6, max: 2.3 }) }));
    const notes = lines.filter((l) => l.startsWith("※"));
    expect(notes).toEqual([ODDS_FIELD_NOTE]);
    expect(lines[lines.length - 1]).toBe(ODDS_FIELD_NOTE);
    for (const word of ["目安", "80%", "地方", "EV", "複勝", "下限", "2着内率"]) {
      expect(ODDS_FIELD_NOTE, word).toContain(word);
    }
    expect(ODDS_FIELD_NOTE).not.toMatch(/妙味|お得/);
  });

  it("複勝の部分しか足せない馬しかいなくても、説明の1行は出る。足せる馬が1頭もいなければ出ない", () => {
    // 単勝の想定・実際が無く(4頭以下ではなく、3着内率 0 の馬だけに単勝の想定が無い)、複勝だけがある
    const only = linesOf(record({ probs: [0, 0, ...PROBS.slice(2)], marks: (u) => (u === 1 ? "◎" : null), place: () => ({ min: 1.6, max: 2.3 }) }));
    expect(only).toEqual(["◎ 1番 馬1 複勝 想定-/実際1.6〜2.3倍", ODDS_FIELD_NOTE]);
    const none = linesOf(record({ probs: [0, 0, ...PROBS.slice(2)], marks: (u) => (u === 1 ? "◎" : null) }));
    expect(none).toEqual(["◎ 1番 馬1"]);
  });

  it("EV プラスの馬の行(description)には足さない(core の embed を変えない)", () => {
    const base = record({ place: () => ({ min: 1.6, max: 2.3 }) });
    const horses = base.horses.map((h, i) => ({ ...h, isPositive: i === 0, ev: i === 0 ? 1.05 : 0.8 })) as AnalysisRecord["horses"];
    const out = buildAnalysisNotificationEmbed({ ...base, horses }, effective, label());
    expect(out.description).toContain("◎ 1番 馬1 AI補正後55.0% 複勝下限2.0 EV1.05");
    expect(out.description).not.toContain("想定");
    expect(out.description).not.toContain("実際");
  });
});

describe("Discord の印の field の上限(Issue #253。単勝と複勝が1行になって長くなる)", () => {
  /** 最大の印の数: ◎〇▲△☆注 の全種類に △ を2つ足した8頭(印のある馬の最大の想定)。 */
  const MARKS = ["◎", "〇", "▲", "△", "△", "△", "☆", "注"];

  it("最悪ケース(印8頭・全種類の印・馬名32文字・実際(暫定)・単勝 1000倍超・複勝 1000倍超の上限・両方とも強調あり)でも、印の field は 1024 以内で、8頭と説明の行が1行も落ちない。embed 全体は 6000 以内", () => {
    const out = buildAnalysisNotificationEmbed(
      record({
        marks: (u) => MARKS[u - 1] ?? null,
        oddsStatus: "middle",
        names: () => "あ".repeat(32),
        winOdds: () => 5000,
        place: () => ({ min: 1.9, max: 5000 }),
      }),
      effective,
      label(),
    );
    const field = marksField(out)!;
    const lines = field.value.split("\n");
    expect(lines).toHaveLength(9); // 前提: 8頭 + 説明の行(1行も落ちていない=退化させない)
    // 全頭で単勝・複勝の両方が付いている(退化させない): 最も長い形(どちらも強調あり)
    expect(lines.slice(0, 8).every((l) => l.includes(" 単勝 ") && l.includes(" 複勝 ") && l.includes("実際(暫定)1.9〜1000倍超"))).toBe(true);
    expect(field.value.length).toBeLessThanOrEqual(1024);
    expect(embedLength(out)).toBeLessThanOrEqual(6000);
  });

  it("全種類の印が1頭ずつ(6頭)・平均的な馬名でも、行は切り詰められない", () => {
    const out = buildAnalysisNotificationEmbed(
      record({ marks: (u) => ["◎", "〇", "▲", "△", "☆", "注"][u - 1] ?? null, names: (u) => `テスト馬${u}号`, winOdds: () => 12.3, place: () => ({ min: 1.9, max: 3.4 }) }),
      effective,
      label(),
    );
    const lines = marksField(out)!.value.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.slice(0, 6).every((l) => l.includes(" 単勝 ") && l.includes(" 複勝 "))).toBe(true);
    expect(lines.some((l) => /…ほか \d+ 件$/.test(l))).toBe(false);
  });

  it("18頭すべてに印があっても、field は 1024 以内・embed 全体は 6000 以内(収まらない行は既存の『…ほか N 件』で落ちる)", () => {
    const probs = Array.from({ length: 18 }, (_, i) => 0.5 - i * 0.02);
    const out = buildAnalysisNotificationEmbed(record({ probs, marks: () => "△", names: () => "あ".repeat(32), winOdds: () => 5000, place: () => ({ min: 1.9, max: 5000 }) }), effective, label());
    expect(marksField(out)!.value.length).toBeLessThanOrEqual(1024);
    expect(marksField(out)!.value).toMatch(/…ほか \d+ 件$/);
    expect(embedLength(out)).toBeLessThanOrEqual(6000);
  });
});
