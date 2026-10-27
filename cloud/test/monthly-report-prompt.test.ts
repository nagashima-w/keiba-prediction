import { describe, expect, it } from "vitest";
import { MONTHLY_NARRATIVE_LIMITS, MONTHLY_PROMPT_VERSION, buildMonthlyPrompt, parseMonthlyNarrative } from "../src/monthly-report-prompt";
import { dateLabel, yen } from "../src/daily-report-prompt";
import { formatRecoveryPercent } from "../src/recovery-format";
import type { AdjustmentFit, FitBucket, FitGroup } from "../src/adjustment-fit";
import { buildMonthStats } from "../src/monthly-stats";
import { SMALL_MONTH_SPEC, syntheticMonthRows, syntheticMonthStats } from "./monthly-fixtures";

/**
 * Issue #280(#265-B): 月報のプロンプトの組み立てと、LLM の応答(JSON)の解釈。月の確定値の節だけを渡し、各レースのブロックと日報の総括は渡さない。
 */

const STATS = syntheticMonthStats(SMALL_MONTH_SPEC);
const prompt = (over: { lastDayPending?: boolean; stats?: typeof STATS } = {}): string => buildMonthlyPrompt({ month: "202610", stats: over.stats ?? STATS, lastDayPending: over.lastDayPending ?? false });

describe("前提(退化した入力でテストが空振りしない)", () => {
  it("材料の月は 2 開催日・2 版・1 日 6 レースで、買い目と「もしも」の成績がある", () => {
    expect(STATS.days).toHaveLength(2);
    expect(STATS.byVersion.map((v) => v.promptVersion)).toEqual(["v-a", "v-b"]);
    expect(STATS.raceCount).toBe(12);
    expect(STATS.judgedBetCount).toBeGreaterThan(0);
    expect(STATS.totalStake).toBeGreaterThan(0);
    expect(STATS.whatIf).not.toBeNull();
    expect(STATS.days.every((d) => d.totalStake > 0)).toBe(true);
  });
});

describe("buildMonthlyPrompt: 節と確定値", () => {
  it("月の見出し・月全体の成績・開催日ごとの行・券種別・印別・「もしも」を含む", () => {
    const p = prompt();
    expect(p).toContain("2026年10月");
    expect(p).toContain("## 2026年10月の成績(確定値)");
    expect(p).toContain(`賭け金 ${yen(STATS.totalStake)}・払戻 ${yen(STATS.totalReturn)}`);
    expect(p).toContain(`回収率 ${formatRecoveryPercent(STATS.recoveryRate!)}`);
    expect(p).toContain("分析のあった開催日 2 日");
    expect(p).toContain("券種別:");
    expect(p).toContain("印別");
    expect(p).toContain("## 印の定型の買い方(「もしも」。確定値。各 100 円)");
    expect(p).toContain("◎単勝:");
    expect(p).toContain("◎〇▲の3連複:");
    expect(p).toContain("見込みの的中数:");
    expect(p).toContain("払戻が最大の 1 点を除いた回収率:");
  });

  it("開催日ごとの表は、日の数だけの行で、各行がその日の賭け金・払戻・回収率・的中を持つ", () => {
    const p = prompt();
    const heading = "## 開催日ごとの成績(確定値)";
    expect(p).toContain(heading);
    const section = p.slice(p.indexOf(heading)).split("\n\n")[0]!.split("\n").slice(1);
    expect(section).toHaveLength(STATS.days.length);
    STATS.days.forEach((d, i) => {
      const line = section[i]!;
      expect(line).toContain(dateLabel(d.date));
      expect(line).toContain(`${d.raceCount} レース`);
      expect(line).toContain(`賭け金 ${yen(d.totalStake)}・払戻 ${yen(d.totalReturn)}`);
      expect(line).toContain(`${d.judgedBetCount} 点中 ${d.hitBetCount} 点的中`);
    });
  });

  it("各レースのブロック(raceId・予想の行・買い目の行)と日報の総括は渡さない", () => {
    const p = prompt();
    expect(p).not.toContain("raceId=");
    expect(p).not.toContain("## レースごとの予想と結果");
    expect(p).not.toContain("補正後の3着内率");
    expect(p).not.toContain("買い目:");
    expect(p).not.toContain("日報の総括");
  });

  it("版ごとの表は 2 版以上のときだけ出す。1 版の月では出さず、版の規則も書かない", () => {
    const two = prompt();
    expect(STATS.byVersion).toHaveLength(2);
    expect(two).toContain("## プロンプトの版ごとの成績(確定値)");
    expect(two).toContain("- v-a:");
    expect(two).toContain("- v-b:");
    expect(two).toContain("版の優劣を決める材料にしない");
    const oneStats = syntheticMonthStats({ ...SMALL_MONTH_SPEC, versions: undefined });
    expect(oneStats.byVersion).toHaveLength(1);
    const one = prompt({ stats: oneStats });
    expect(one).not.toContain("プロンプトの版ごと");
    expect(one).not.toContain("版の優劣");
  });

  it("最終日の分が未反映の印(lastDayPending)があるときだけ、その旨の規則を書く", () => {
    expect(prompt({ lastDayPending: true })).toContain("最終日の結果または日報がそろう前に作った");
    expect(prompt({ lastDayPending: false })).not.toContain("最終日の結果または日報がそろう前に作った");
  });

  it("返還(取消・除外の馬への買い目)があるときだけ、返還の規則を書く", () => {
    const rows = syntheticMonthRows(SMALL_MONTH_SPEC);
    expect(buildMonthStats(rows, { fromDate: "20261001", toDate: "20261031" }).refundedBetCount).toBe(0);
    // 最初のレースの単勝の買い目の馬(1 番)を取消・除外にする
    const first = rows.races[0]!;
    const scratched = {
      ...rows,
      results: rows.results.map((r) => (r.raceId === first.raceId && r.umaban === 1 ? { ...r, finishPosition: null, winPayout: null, placePayout: null, scratched: true } : r)),
    };
    const refundStats = buildMonthStats(scratched, { fromDate: "20261001", toDate: "20261031" });
    expect(refundStats.refundedBetCount).toBeGreaterThan(0);
    expect(prompt({ stats: refundStats })).toContain("「返還」は、取消・除外になった馬を含む買い目");
    expect(prompt()).not.toContain("「返還」は、取消・除外になった馬を含む買い目");
  });

  it("規則: 気づきとして書かせる(命令しない)・来月に向けては見ておく数字の形・前の月との比較を書かせない・数字を計算し直させない", () => {
    const p = prompt();
    expect(p).toContain("プロンプトや重みを変えるよう命令する書き方はしない");
    expect(p).toContain("来月に向けて");
    expect(p).toContain("前の月・昨年との比較は、材料が無いので書かないでください");
    expect(p).toContain("計算し直さず、そのまま引用してください");
    expect(p).toContain("見込みの的中数との比較");
    expect(p).toContain("開催日数や点数が少ないとき");
  });

  it("出力形式は summary・good・improve・outlook の JSON で、上限の数字は定数と一致する", () => {
    const p = prompt();
    for (const key of ["summary", "good", "improve", "outlook"]) {
      expect(p).toContain(`"${key}"`);
    }
    expect(p).toContain(`${MONTHLY_NARRATIVE_LIMITS.summary} 字以内`);
    expect(p).toContain(`最大 ${MONTHLY_NARRATIVE_LIMITS.items} 件、各 ${MONTHLY_NARRATIVE_LIMITS.item} 字以内`);
    expect(p).not.toContain('"races"');
  });

  it("プロンプトの版は文字列で、月報の版と分かる", () => {
    expect(MONTHLY_PROMPT_VERSION).toMatch(/^monthly-\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});

describe("開催日ごとの行の判定不能(Issue #280。近似確認で見つかった修正)", () => {
  const dayLines = (p: string): string[] => p.slice(p.indexOf("## 開催日ごとの成績(確定値)")).split("\n\n")[0]!.split("\n").slice(1);

  it("判定不能の買い目がある日の行だけ、末尾に『・判定不能 N 点(賭け金 X円)』を足す。無い日の行は今の文面のまま", () => {
    const [d0, d1] = STATS.days as [(typeof STATS.days)[number], (typeof STATS.days)[number]];
    const stats = { ...STATS, days: [{ ...d0, unjudgedBetCount: 20, unjudgedStake: 2000 }, { ...d1, unjudgedBetCount: 0, unjudgedStake: 0 }] };
    const lines = dayLines(prompt({ stats }));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.endsWith("・判定不能 20 点(賭け金 2,000円)")).toBe(true);
    // 無い日の行: 判定不能の語を含まず、足す前の文面(同じ日の統計をそのまま出した行)と同じ
    expect(lines[1]).not.toContain("判定不能");
    expect(dayLines(prompt())[1]).toBe(lines[1]);
    // 前提: 判定不能を足した日の行は、足す前の行に末尾を足しただけ(他の数字は変わらない)
    expect(lines[0]).toBe(`${dayLines(prompt())[0]!}・判定不能 20 点(賭け金 2,000円)`);
  });

  it("返還があり、判定不能もある日: 返還の括弧のあとに判定不能が続く", () => {
    const d0 = STATS.days[0]!;
    const stats = { ...STATS, days: [{ ...d0, refundedBetCount: 2, unjudgedBetCount: 1, unjudgedStake: 100 }, STATS.days[1]!] };
    expect(dayLines(prompt({ stats }))[0]).toMatch(/\(うち返還 2 点\)・判定不能 1 点\(賭け金 100円\)$/);
  });

  it("近似確認の M3(最終日の結果が未取込の月): 最終日の行に、月全体の『判定不能の買い目』と同じ点数・賭け金が出る", async () => {
    const { buildMonthlyScenario } = await import("../monthly-prompt-scenarios");
    const m3 = buildMonthlyScenario("M3");
    const p = buildMonthlyPrompt({ month: m3.month, stats: m3.stats, lastDayPending: m3.lastDayPending });
    expect(m3.stats.unjudgedBetCount).toBe(20); // 前提: 0 でない
    expect(p).toContain("判定不能の買い目: 20 点(賭け金 2,000円。");
    const last = dayLines(p)[1]!;
    expect(last).toContain("10 レース(結果なし 10)");
    expect(last.endsWith("・判定不能 20 点(賭け金 2,000円)")).toBe(true);
  });
});

describe("最終日が未反映のときの規則(lastDayPending)", () => {
  it("『一部または全部』が反映されていない可能性、と書く(最終日がまるごと未反映のことがあるため)", () => {
    const p = prompt({ lastDayPending: true });
    expect(p).toContain("最終日の分は一部または全部が反映されていない可能性があります");
    expect(p).not.toContain("最終日の分は一部が反映されていない可能性があります");
  });
});

describe("補正の当たり具合の節と規則(Issue #509)", () => {
  const b = <K extends string>(key: K, count: number, placedCount: number, meanPrior: number | null, meanAdjusted: number | null): FitBucket<K> => ({ key, count, placedCount, meanPrior, meanAdjusted });
  const group: FitGroup = {
    raceCount: 80,
    horseCount: 1000,
    byDirection: [b("bigUp", 412, 187, 0.278, 0.347), b("up", 100, 40, 0.25, 0.27), b("same", 300, 90, 0.3, 0.3), b("down", 150, 40, 0.3, 0.28), b("bigDown", 29, 8, 0.4, 0.33)],
    byPopularity: [b("1", 80, 50, 0.499, 0.508), b("2-3", 160, 70, 0.383, 0.388), b("4-6", 240, 60, 0.264, 0.258), b("7+", 0, 0, null, null)],
    brier: { prior: 0.1234, adjusted: 0.121 },
    optimalK: 1.4523,
  };
  const fit: AdjustmentFit = { all: group, byVersion: [{ promptVersion: "v-a", ...group }], hiddenVersionCount: 1, excluded: { suspect: 0, unknown: 0, uncheckedRaces: 0, estimated: 0, notLlm: 0 } };
  const FIT_MARKERS = ["補正の当たり具合", "補正の向き別", "人気の帯別"];

  it("プロンプトの版が上がっている(文面を変えたので)", () => {
    expect(MONTHLY_PROMPT_VERSION).not.toBe("monthly-2026-10-13.1");
    expect(MONTHLY_PROMPT_VERSION).toBe("monthly-2026-10-27.1");
  });

  it("標本があるとき: 確定値の節(月全体と版ごとの表。画面と同じ行)と、規則(実際の率との差を数字で・30 頭未満は断定しない・命令しない)を入れる", () => {
    const p = prompt({ stats: { ...STATS, adjustmentFit: fit } });
    expect(p).toContain("## 補正の当たり具合(確定値)");
    expect(p).toContain("### 補正の向き別(月全体)");
    expect(p).toContain("### 補正の向き別(版 v-a)");
    expect(p).toContain("- 大きく上げた(+5pt 超): 412 頭・統計モデル 27.8%・補正後 34.7%・実際 45.4%(187/412)");
    expect(p).toContain("実際の率との差");
    expect(p).toContain("30 頭未満");
    expect(p).toContain("断定しないでください");
    expect(p).toContain("この節の数字についても、プロンプトや重みを変えるよう命令する書き方はしないでください");
    expect(p).toContain("統計モデルの偏りを表します");
    // 節は版ごとの成績の節より前、出力形式の説明より後(確定値の並びの中)
    expect(p.indexOf("## 補正の当たり具合(確定値)")).toBeGreaterThan(p.indexOf("## 出力形式"));
  });

  it("標本が無い・読み出せなかった・昔の月報(項目なし)・対象のレースが無いときは、節も規則も入れない(補正の当たり具合の語が一つも出ない)", () => {
    const none = prompt();
    const empty: AdjustmentFit = { ...fit, all: { ...group, raceCount: 0, horseCount: 0 }, byVersion: [] };
    for (const adjustmentFit of [{ unavailable: "read-failed" as const }, { unavailable: "too-many" as const }, { unavailable: "compute-failed" as const }, empty]) {
      const p = prompt({ stats: { ...STATS, adjustmentFit } });
      for (const marker of FIT_MARKERS) expect(p, marker).not.toContain(marker);
      expect(p).toBe(none);
    }
    for (const marker of FIT_MARKERS) expect(none, marker).not.toContain(marker);
  });
});

describe("parseMonthlyNarrative", () => {
  const valid = { summary: "10 月は 12 レースを分析。", good: ["a"], improve: ["b"], outlook: ["c"] };

  it("JSON(コードフェンス・前後の説明つきでもよい)を読む", () => {
    expect(parseMonthlyNarrative(JSON.stringify(valid))).toEqual(valid);
    expect(parseMonthlyNarrative(`はい。\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n以上`)).toEqual(valid);
  });

  it("長さの上限で切る: 総括・各項目の字数、項目の件数。切った印は…", () => {
    const long = "あ".repeat(MONTHLY_NARRATIVE_LIMITS.item + 50);
    const many = Array.from({ length: MONTHLY_NARRATIVE_LIMITS.items + 3 }, (_, i) => `項目${i}`);
    const out = parseMonthlyNarrative(JSON.stringify({ summary: "い".repeat(MONTHLY_NARRATIVE_LIMITS.summary + 10), good: [long], improve: many, outlook: many }))!;
    expect(out.summary).toHaveLength(MONTHLY_NARRATIVE_LIMITS.summary);
    expect(out.summary.endsWith("…")).toBe(true);
    expect(out.good[0]).toHaveLength(MONTHLY_NARRATIVE_LIMITS.item);
    expect(out.improve).toHaveLength(MONTHLY_NARRATIVE_LIMITS.items);
    expect(out.outlook).toHaveLength(MONTHLY_NARRATIVE_LIMITS.items);
  });

  it.each([
    { name: "JSON ではない文章", text: "今月は黒字でした" },
    { name: "波括弧はあるが JSON ではない", text: "{ 今月 }" },
    { name: "オブジェクトを含まない配列", text: JSON.stringify(["a", "b"]) },
    { name: "総括が無い", text: JSON.stringify({ good: ["a"], improve: [], outlook: [] }) },
    { name: "総括が空白だけ", text: JSON.stringify({ ...valid, summary: "  " }) },
    { name: "総括が文字列ではない", text: JSON.stringify({ ...valid, summary: 3 }) },
  ])("読めない応答は null: $name", ({ text }) => {
    expect(parseMonthlyNarrative(text)).toBeNull();
  });

  it("good・improve・outlook が配列でない・文字列でない要素・空要素は捨てる(総括があれば読める)", () => {
    const out = parseMonthlyNarrative(JSON.stringify({ summary: "s", good: "文字列", improve: ["", "  ", 3, "有効"], outlook: null }))!;
    expect(out).toEqual({ summary: "s", good: [], improve: ["有効"], outlook: [] });
  });
});
