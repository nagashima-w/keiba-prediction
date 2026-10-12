import { describe, expect, it } from "vitest";
import { buildDayStats, type DayStats } from "../src/daily-report-digest";
import { formatExpectedHits } from "../src/expected-format";
import type { PeriodStats, RollingSummary } from "../src/period-stats";
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

describe("Issue #264: 直近 28 日の累計の field と、見込みの的中数", () => {
  const TOTAL: PeriodStats = {
    ...STATS, fromDate: "20260913", toDate: "20261010", dayCount: 7,
    raceCount: 156, resultRaceCount: 150, noResultRaceCount: 6, totalStake: 52000, totalReturn: 49400, recoveryRate: 0.95,
    judgedBetCount: 360, hitBetCount: 30, expectedBetCount: 360, expectedHits: 27.25, expectedBaseHits: 30,
  };
  const ROLLING: RollingSummary = { windowDays: 28, prior: { ...TOTAL, dayCount: 6 }, total: TOTAL };
  const DAY_STATS: DayStats = { ...STATS, expectedBetCount: 60, expectedHits: 9.5, expectedBaseHits: 14 };
  const build = (rolling: RollingSummary | undefined, stats: DayStats = DAY_STATS) => buildReportEmbed({ kaisaiDate: "20261010", stats, narrative: NARRATIVE, note: null, link: undefined, rolling });

  it("formatExpectedHits: 『見込み X.XX 点・実際 Y 点』。確率のある買い目が無ければ null(捏造しない)", () => {
    expect(formatExpectedHits({ expectedBetCount: 60, expectedHits: 9.5, expectedBaseHits: 14 })).toBe("見込み 9.50 点・実際 14 点");
    expect(formatExpectedHits({ expectedBetCount: 3, expectedHits: 0.3333, expectedBaseHits: 0 })).toBe("見込み 0.33 点・実際 0 点");
    expect(formatExpectedHits({ expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0 })).toBeNull();
  });

  it("成績・レースの次に、『直近 28 日の累計(その日を含む)』の field を出す。賭け金・払戻・回収率・点数・見込みと実際・開催日数", () => {
    const e = build(ROLLING);
    const names = e.fields!.map((f) => f.name);
    expect(names.slice(0, 3)).toEqual(["成績", "レース", "直近 28 日の累計(その日を含む)"]);
    const f = e.fields!.find((x) => x.name.startsWith("直近 28 日"))!;
    expect(f.value).toContain("賭け金 52,000円・払戻 49,400円・回収率 95.0%");
    expect(f.value).toContain("360 点中 30 点的中");
    expect(f.value).toContain("見込み 27.25 点・実際 30 点");
    expect(f.value).toContain("開催 7 日・156 レース");
  });

  it("その日の成績の field にも、見込みと実際を添える(4 週と同じ書き方)", () => {
    const stat = build(ROLLING).fields!.find((f) => f.name === "成績")!;
    expect(stat.value).toContain("60 点中 14 点的中(見込み 9.50 点・実際 14 点)");
  });

  it("累計が無い日報(この項目を持つ前の日報)は、field を出さず、従来の field のまま", () => {
    const e = build(undefined, STATS);
    expect(e.fields!.map((f) => f.name)).toEqual(["成績", "レース", "良かった点", "改善点"]);
  });

  it("見込みを出せない(確率のある買い目が無い)累計は、見込みの語を出さない", () => {
    const none: RollingSummary = { ...ROLLING, total: { ...TOTAL, expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0 } };
    const f = build(none).fields!.find((x) => x.name.startsWith("直近 28 日"))!;
    expect(f.value).not.toContain("見込み");
    expect(f.value).toContain("360 点中 30 点的中");
  });

  it("累計の賭け金が 0 なら回収率は『なし』(NaN を出さない)。直前 27 日が空でその日だけの累計でも出る", () => {
    const zero: RollingSummary = { ...ROLLING, total: { ...TOTAL, totalStake: 0, totalReturn: 0, recoveryRate: null, judgedBetCount: 0, hitBetCount: 0, expectedBetCount: 0 } };
    const f = build(zero).fields!.find((x) => x.name.startsWith("直近 28 日"))!;
    expect(f.value).toContain("回収率 なし");
    expect(f.value).not.toMatch(/NaN|Infinity/);
  });

  it("累計の field を足しても Discord の上限(合計 6000)を守る", () => {
    const long = { ...NARRATIVE, summary: "あ".repeat(4000), good: ["い".repeat(900), "い".repeat(900), "い".repeat(900)], improve: ["う".repeat(900), "う".repeat(900), "う".repeat(900)] };
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: DAY_STATS, narrative: long, note: null, link: undefined, rolling: ROLLING });
    expect(embedLength(e)).toBeLessThanOrEqual(EMBED_LIMITS.total);
  });
});


describe("Issue #264 デプロイをまたぐジョブ: 旧コードが作った record(見込みの項目が無い stats)を、新コードの通知が読んでも落ちない", () => {
  /** 旧コード(#264 の前)の DayStats の形: 見込み・最大払戻の項目が無い。 */
  const OLD_STATS = (() => {
    const { expectedBetCount, expectedHits, expectedBaseHits, maxPayout, maxPayoutStake, ...old } = { ...STATS } as DayStats;
    void [expectedBetCount, expectedHits, expectedBaseHits, maxPayout, maxPayoutStake];
    return old as unknown as DayStats;
  })();

  it("前提: 旧形の stats には見込みの項目が実際に無い(あるつもりで検査していない)", () => {
    for (const key of ["expectedBetCount", "expectedHits", "expectedBaseHits", "maxPayout", "maxPayoutStake"]) {
      expect(key in OLD_STATS, key).toBe(false);
    }
    expect(OLD_STATS.judgedBetCount).toBe(60);
  });

  it("buildReportEmbed は throw せず、成績は旧来の『N 点中 M 点的中』だけ(見込みの括弧を出さない)。累計の field は出さない", () => {
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: OLD_STATS, narrative: NARRATIVE, note: null, link: undefined });
    const stat = e.fields!.find((f) => f.name === "成績")!;
    expect(stat.value).toBe("賭け金 12,000円・払戻 15,600円・回収率 130.0%(黒字)\n60 点中 14 点的中");
    expect(e.fields!.map((f) => f.name)).toEqual(["成績", "レース", "良かった点", "改善点"]);
  });

  it.each([
    ["expectedBetCount が無い", { expectedHits: 1.2, expectedBaseHits: 1 }],
    ["expectedHits が無い", { expectedBetCount: 3, expectedBaseHits: 1 }],
    ["expectedBaseHits が無い", { expectedBetCount: 3, expectedHits: 1.2 }],
    ["expectedHits が null", { expectedBetCount: 3, expectedHits: null, expectedBaseHits: 1 }],
    ["expectedHits が NaN", { expectedBetCount: 3, expectedHits: Number.NaN, expectedBaseHits: 1 }],
    ["expectedHits が Infinity", { expectedBetCount: 3, expectedHits: Number.POSITIVE_INFINITY, expectedBaseHits: 1 }],
    ["expectedBetCount が文字列", { expectedBetCount: "3", expectedHits: 1.2, expectedBaseHits: 1 }],
    ["全部無い", {}],
  ])("formatExpectedHits は欠けた・不正な項目では throw せず null: %s", (_n, s) => {
    expect(formatExpectedHits(s as unknown as Parameters<typeof formatExpectedHits>[0])).toBeNull();
  });

  it("対照: 項目がそろっていれば従来どおり出す(欠損の扱いが、そろった入力まで落としていない)", () => {
    expect(formatExpectedHits({ expectedBetCount: 3, expectedHits: 1.2, expectedBaseHits: 1 })).toBe("見込み 1.20 点・実際 1 点");
    const e = buildReportEmbed({ kaisaiDate: "20261010", stats: { ...OLD_STATS, expectedBetCount: 60, expectedHits: 9.5, expectedBaseHits: 14 }, narrative: NARRATIVE, note: null, link: undefined });
    expect(e.fields!.find((f) => f.name === "成績")!.value).toContain("60 点中 14 点的中(見込み 9.50 点・実際 14 点)");
  });
});

describe("Issue #272: 印の定型の買い方(もしも)と惜しかったレース", () => {
  const stat = (betCount: number, hitCount: number, payout: number, over: Record<string, number> = {}) => ({ betCount, hitCount, stake: betCount * 100, payout, refundCount: 0, unjudgedCount: 0, inapplicableCount: 0, ...over });
  const DAY = { win: stat(10, 2, 1500), place: stat(10, 5, 1100), wide: stat(4, 0, 0, { inapplicableCount: 6 }), quinella: stat(4, 1, 2400), trio: stat(0, 0, 0, { inapplicableCount: 10 }) };
  const TOTAL = { win: stat(41, 9, 3550), place: stat(40, 20, 4000), wide: stat(30, 5, 3900), quinella: stat(30, 3, 2100), trio: stat(20, 1, 6000) };
  const rolling = (): RollingSummary => {
    const p = { ...STATS, fromDate: "20260913", toDate: "20261010", dayCount: 8, whatIf: TOTAL } as PeriodStats;
    return { windowDays: 28, prior: p, total: p };
  };
  const base = { kaisaiDate: "20261010", stats: { ...STATS, whatIf: DAY }, narrative: NARRATIVE, note: null, link: undefined, rolling: rolling() };
  const field = (e: ReturnType<typeof buildReportEmbed>, name: string) => e.fields!.find((f) => f.name === name);

  it("型ごとに 1 行: その日と直近 28 日の『的中/点数 回収率』を並べる。判定できた点が無い型は回収率を『-』にする", () => {
    const lines = field(buildReportEmbed(base), "もしも(印の定型・各100円)")!.value.split("\n");
    expect(lines).toEqual([
      "◎単勝: その日 2/10 150.0%・28日 9/41 86.6%",
      "◎複勝: その日 5/10 110.0%・28日 20/40 100.0%",
      "◎-〇ワイド: その日 0/4 0.0%・28日 5/30 130.0%",
      "◎-〇馬連: その日 1/4 600.0%・28日 3/30 70.0%",
      "◎〇▲の3連複: その日 0/0 -・28日 1/20 300.0%",
    ]);
  });

  it("直近 28 日の累計が無い(旧形)ときは、その日だけ出す。その日の成績が無い(null)・レースが 0 件なら field ごと出さない", () => {
    const dayOnly = field(buildReportEmbed({ ...base, rolling: undefined }), "もしも(印の定型・各100円)")!.value;
    expect(dayOnly.split("\n")[0]).toBe("◎単勝: その日 2/10 150.0%");
    expect(field(buildReportEmbed({ ...base, stats: { ...STATS, whatIf: null } }), "もしも(印の定型・各100円)")).toBeUndefined();
    expect(field(buildReportEmbed({ ...base, stats: { ...STATS, raceCount: 0, whatIf: buildDayStats([]).whatIf } }), "もしも(印の定型・各100円)")).toBeUndefined();
  });

  it("旧コードが積んだ record(stats に whatIf の項目そのものが無い)でも落ちず、field を出さない", () => {
    const { whatIf: _omitted, ...legacyStats } = STATS;
    const e = buildReportEmbed({ ...base, stats: legacyStats as DayStats });
    expect(e.fields!.map((f) => f.name)).toEqual(["成績", "レース", "直近 28 日の累計(その日を含む)", "良かった点", "改善点"]);
  });

  it("惜しかったレース: 全件数を見出しに、最大 3 件をレース名・型・定型の払戻で出す。0 件・未計算なら field ごと出さない", () => {
    const races = [{ raceId: "R1", title: "東京5R 3歳未勝利" }, { raceId: "R2", title: "中山11R テストS" }];
    const near = { total: 4, shown: [{ raceId: "R1", templateId: "trio", payout: 12340 }, { raceId: "R2", templateId: "wide", payout: 800 }] };
    const e = buildReportEmbed({ ...base, nearMisses: near, races });
    expect(field(e, "惜しかったレース(全 4 件)")!.value).toBe("東京5R 3歳未勝利: ◎〇▲の3連複 12,340円\n中山11R テストS: ◎-〇ワイド 800円");
    const names = (x: ReturnType<typeof buildReportEmbed>) => x.fields!.map((f) => f.name).join("|");
    expect(names(buildReportEmbed({ ...base, nearMisses: { total: 0, shown: [] }, races }))).not.toContain("惜しかったレース");
    expect(names(buildReportEmbed(base))).not.toContain("惜しかったレース");
    // レースの名前が分からなくても落ちない(raceId を出す)
    expect(field(buildReportEmbed({ ...base, nearMisses: near }), "惜しかったレース(全 4 件)")!.value).toContain("R1: ◎〇▲の3連複 12,340円");
  });

  it("上限(field 1024・合計 6000)を守る", () => {
    const long = "あ".repeat(900);
    const near = { total: 3, shown: [1, 2, 3].map((i) => ({ raceId: `R${i}`, templateId: "trio", payout: 100 })) };
    const e = buildReportEmbed({ ...base, nearMisses: near, races: [1, 2, 3].map((i) => ({ raceId: `R${i}`, title: long })) });
    for (const f of e.fields!) expect(f.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
    expect(embedLength(e)).toBeLessThanOrEqual(EMBED_LIMITS.total);
  });
});
