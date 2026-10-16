/**
 * buildPrompt: 想定ペースを LLM に展開予想させて決める(Issue #315)。
 *
 *  - 【展開想定】は材料(脚質分布・主導権候補・各馬のテンの位置)だけを渡し、規則の結論
 *    (「ペース想定」「恵まれる脚質」「損する脚質」)は渡さない。
 *  - 【指示】に判断の手順(展開予想 → 想定ペース → 恵まれる/損する脚質 → 各馬の評価)と、
 *    development・pace の出力仕様を書く。出力スキーマは development・pace を horses より前に置く。
 *  - 各馬の行に「テンの位置」(近走の第1コーナーの相対位置の平均)を足す。
 *  - 新しい見出し【】は作らない(設定画面のプレビュー注記が列挙する見出しの集合を変えないため)。
 */
import { describe, expect, it } from "vitest";
import { buildPrompt, PROMPT_VERSION, type BuildPromptInput, type PromptHorse } from "../../src/analyzer/build-prompt.js";

function horse(umaban: number, runs: PromptHorse["runs"], extra: Partial<PromptHorse> = {}): PromptHorse {
  return { umaban, horseName: `馬${umaban}`, prior: 0.3, oikiri: null, runs, restInterval: "中2週", ...extra };
}

function input(horses: readonly PromptHorse[], race: Partial<BuildPromptInput["race"]> = {}): BuildPromptInput {
  return {
    race: { raceName: "テスト特別", courseType: "芝", distance: 1600, venueName: "東京", weather: "晴", trackCondition: "良", ...race },
    horses,
  };
}

/** 逃げ 2 頭(馬番 1・2)・差し 1 頭(馬番 3)。従来なら規則の結論は「ハイ」。 */
const FRONT2: readonly PromptHorse[] = [
  horse(1, [{ passing: [1, 1], fieldSize: 16 }]),
  horse(2, [{ passing: [1, 1], fieldSize: 16 }]),
  horse(3, [{ passing: [10, 10], fieldSize: 16 }]),
];
/** 全頭の過去走が無い(脚質がすべて不明。新馬戦相当)。 */
const ALL_UNKNOWN: readonly PromptHorse[] = [horse(1, []), horse(2, [])];

const lines = (p: string): string[] => p.split("\n");
const headingsOf = (p: string): string[] => lines(p).filter((l) => /^【.*】/.test(l));
/** 【見出し】から次の【見出し】の手前まで。 */
function section(p: string, heading: string): string {
  const start = p.indexOf(heading);
  expect(start, `前提: ${heading} がある`).toBeGreaterThanOrEqual(0);
  const next = p.indexOf("\n【", start + heading.length);
  return p.slice(start, next < 0 ? undefined : next);
}

describe("buildPrompt(Issue #315: 規則の結論を渡さない)", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly p: string }> = [
    { name: "逃げ 2 頭(従来はハイ)", p: buildPrompt(input(FRONT2)) },
    { name: "逃げ 0 頭(従来はスロー)", p: buildPrompt(input([horse(1, [{ passing: [10], fieldSize: 16 }]), horse(2, [{ passing: [12], fieldSize: 16 }])])) },
    { name: "地方・不良馬場", p: buildPrompt(input(FRONT2, { venueKind: "nar", trackCondition: "不良" })) },
    { name: "全頭脚質不明", p: buildPrompt(input(ALL_UNKNOWN)) },
  ];
  for (const { name, p } of cases) {
    it(`${name}: 「ペース想定」「恵まれる脚質」「損する脚質」の行と、根拠の文言を含まない`, () => {
      expect(lines(p).some((l) => l.startsWith("ペース想定"))).toBe(false);
      expect(lines(p).some((l) => l.startsWith("恵まれる脚質"))).toBe(false);
      expect(lines(p).some((l) => l.startsWith("損する脚質"))).toBe(false);
      expect(p).not.toContain("(根拠:");
      expect(p).not.toContain("前残り)想定");
      expect(p).not.toContain("上記に加えて");
    });
  }

  it("前提(空振り防止): 逃げ 2 頭の入力で、材料の脚質分布は規則の入力そのもの(逃げ 2 頭)になっている", () => {
    const p = buildPrompt(input(FRONT2));
    expect(p).toContain("脚質分布: 逃げ2頭 / 先行0頭 / 差し1頭 / 追込0頭");
  });

  it("材料は残す: 脚質分布と主導権候補(従来の文言のまま)", () => {
    const p = buildPrompt(input(FRONT2));
    const dev = section(p, "【展開想定】");
    expect(dev).toContain("脚質分布: 逃げ2頭 / 先行0頭 / 差し1頭 / 追込0頭");
    expect(dev).toContain("主導権候補: 馬番1");
  });

  it("【展開想定】の見出しの直後に、これは材料で結論は「指示」の手順で自分が決める旨の1行を置く", () => {
    const dev = lines(section(buildPrompt(input(FRONT2)), "【展開想定】"));
    expect(dev[1]).toBe(
      "以下は展開を予想するための材料です。想定ペースの結論はここには書いていません。後ろの「指示」の手順に従って、あなた自身が展開を予想し、想定ペースを決めてください。",
    );
  });

  it("コース形態の行: 「上記に加えて」を使わず、馬場状態も含めて自分で判断させる(中央・地方とも)", () => {
    const expected = "コース形態(会場・回り・距離)と馬場状態による前後有利は、あなた自身で判断してください。";
    expect(buildPrompt(input(FRONT2))).toContain(expected);
    expect(buildPrompt(input(FRONT2, { venueKind: "central" }))).toContain(expected);
    expect(buildPrompt(input(FRONT2, { venueKind: "nar" }))).toContain(expected);
  });

  it("地方の前残りの行は従来の文言のまま(材料。中央には出さない)", () => {
    const nar = "地方競馬は前残り(先行有利)傾向が強く、馬場不良時は差しも届きにくい点を加味してください。";
    expect(buildPrompt(input(FRONT2, { venueKind: "nar" }))).toContain(nar);
    expect(buildPrompt(input(FRONT2, { venueKind: "central" }))).not.toContain("地方競馬は前残り");
    expect(buildPrompt(input(FRONT2))).not.toContain("地方競馬は前残り");
  });
});

describe("buildPrompt(Issue #315: 全頭脚質不明の注記。#262 の『断定しない』を維持)", () => {
  const NOTE = "注記: 出走全頭の脚質が不明です(新馬戦など)。脚質からは展開を判断できないため、ペースを断定しないでください。";

  it("全頭不明なら注記を出し、主導権候補は『該当馬なし(脚質のデータが無い)』、逃げ・先行不在とは書かない", () => {
    const p = buildPrompt(input(ALL_UNKNOWN));
    expect(section(p, "【展開想定】")).toContain(NOTE);
    expect(p).toContain("脚質分布: 逃げ0頭 / 先行0頭 / 差し0頭 / 追込0頭 / 不明2頭");
    expect(p).toContain("主導権候補: 該当馬なし(脚質のデータが無い)");
    expect(p).not.toContain("逃げ・先行タイプ不在");
  });

  it("一部だけ不明(既知が1頭でもいる)なら注記を出さず、主導権候補は従来の文言", () => {
    const p = buildPrompt(input([horse(1, [{ passing: [10], fieldSize: 16 }]), horse(2, [])]));
    expect(p).not.toContain(NOTE);
    expect(p).toContain("脚質分布: 逃げ0頭 / 先行0頭 / 差し1頭 / 追込0頭 / 不明1頭");
    expect(p).toContain("主導権候補: 該当馬なし(逃げ・先行タイプ不在)");
  });

  it("脚質がそろっているレースでは注記を出さない", () => {
    expect(buildPrompt(input(FRONT2))).not.toContain(NOTE);
  });
});

describe("buildPrompt(Issue #315: 【指示】の判断の手順と出力仕様)", () => {
  const instruction = (p: string): string => section(p, "【指示】");

  it("判断の手順: 展開予想 → 想定ペース → 恵まれる/損する脚質 → 各馬の評価 を (1)〜(4) の順で書き、(4) は (1)〜(3) と矛盾させない", () => {
    const sec = instruction(buildPrompt(input(FRONT2)));
    const idx = ["判断の手順:", "(1) ", "(2) ", "(3) ", "(4) "].map((k) => sec.indexOf(k));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx); // 昇順(順序どおり)
    expect(sec).toContain("展開予想");
    expect(sec).toContain("想定ペース(スロー・平均・ハイのいずれか)");
    expect(sec).toContain("恵まれる脚質と損する脚質");
    expect(sec).toContain("(1)〜(3) と矛盾させない");
  });

  it("逃げ馬の頭数だけで機械的に決めない旨を書き、ペースの定石の表(スロー=前残り 等)は書かない", () => {
    const sec = instruction(buildPrompt(input(FRONT2)));
    expect(sec).toContain("逃げ馬の頭数だけで機械的に決めず");
    expect(sec).not.toContain("スロー=");
    expect(sec).not.toContain("前残りになりやすい");
  });

  it("手順は【指示】の最初の行(JSON のみで出力)の直後に置く", () => {
    const l = lines(instruction(buildPrompt(input(FRONT2))));
    expect(l[0]).toBe("【指示】");
    expect(l[1]).toContain("JSON のみで出力してください");
    expect(l[2]).toContain("判断の手順:");
  });

  it("development の仕様: 全角200字以内・1段落・改行とダブルクォートを使わない・オッズ/人気を根拠にしない", () => {
    const sec = instruction(buildPrompt(input(FRONT2)));
    expect(sec).toContain("development には");
    expect(sec).toContain("全角200字以内の日本語1段落");
    expect(sec).toContain("改行とダブルクォートは使わない");
    expect(sec).toContain("単勝オッズ・人気は development の根拠にしない");
  });

  it("pace の仕様: development と一致する 3 値の文字列・全頭脚質不明などで判断できなければ null・horses より前に出力", () => {
    const sec = instruction(buildPrompt(input(FRONT2)));
    expect(sec).toContain("pace は development の結論と一致する「スロー」「平均」「ハイ」のいずれか1つ");
    expect(sec).toContain("pace を null にし、development にその理由を書く");
    expect(sec).toContain("development と pace は horses より前に出力する");
  });

  it("手順・仕様の文は【指示】の中だけにある(新しい見出し【】は作らない)", () => {
    const p = buildPrompt(input(FRONT2));
    expect(p.split("判断の手順:").length - 1).toBe(1);
    expect(instruction(p)).toContain("判断の手順:");
    expect(headingsOf(p)).toEqual(["【レース情報】", "【展開想定】", "【出走馬(3着内率 は scorer が数値データから算出した複勝圏内〈3着以内〉確率の事前推定値)】", "【指示】", "【予想印】", "【出力スキーマ(この形式の JSON のみ)】"]);
  });

  it("【予想印】の判断材料の行は従来のまま(整合は手順 (4) が担う)", () => {
    expect(buildPrompt(input(FRONT2))).toContain(
      "判断材料: 3着内率・参考EV・単勝オッズ/人気・脚質と展開想定、およびここまでの分析(各馬の place_prob と reason)を総合して判断してください。",
    );
  });
});

describe("buildPrompt(Issue #315: 出力スキーマ)", () => {
  function schemaLine(p: string): string {
    const head = p.indexOf("【出力スキーマ");
    expect(head).toBeGreaterThanOrEqual(0);
    return p.slice(head).split("\n")[1]!;
  }

  it("1 行の JSON で、キーの順は development → pace → horses。horses の例は従来どおり(2 頭・キー順 number…concerns)", () => {
    const line = schemaLine(buildPrompt(input(FRONT2)));
    const ex = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(ex)).toEqual(["development", "pace", "horses"]);
    expect(typeof ex["development"]).toBe("string");
    expect(typeof ex["pace"]).toBe("string");
    const horses = ex["horses"] as Array<Record<string, unknown>>;
    expect(horses).toHaveLength(2);
    for (const h of horses) {
      expect(Object.keys(h)).toEqual(["number", "place_prob", "reason", "mark", "highlights", "concerns"]);
    }
  });

  it("例の値は具体値(スロー・平均・ハイのどれか1つ)にしない(LLM が例をそのまま返すのを避ける)", () => {
    const ex = JSON.parse(schemaLine(buildPrompt(input(FRONT2)))) as { development: string; pace: string };
    expect(["スロー", "平均", "ハイ"]).not.toContain(ex.pace);
    expect(ex.pace).toBe("スロー・平均・ハイのいずれか");
    expect(ex.development).toBe("展開予想の短文");
  });
});

describe("buildPrompt(Issue #315: プロンプトの版)", () => {
  it("版は 2026-10-15.1 以降(Issue #315 の版。現行の値の固定は build-prompt.test.ts)", () => {
    expect(PROMPT_VERSION >= "2026-10-15.1").toBe(true);
  });
});

describe("buildPrompt(Issue #315: 各馬の行の『テンの位置』)", () => {
  const rowOf = (p: string, umaban: number): string => lines(p).find((l) => l.startsWith(`馬番${umaban} `))!;
  const tenOf = (row: string): string => /テンの位置=([^,]*),/.exec(row)![1]!;

  const table: ReadonlyArray<{ readonly name: string; readonly runs: PromptHorse["runs"]; readonly expected: string; readonly recent?: number }> = [
    { name: "1 走だけ(2/16 = 0.125 → 約1割)", runs: [{ passing: [2, 3], fieldSize: 16 }], expected: "直近1走の1角で前から約1割(0.13)" },
    { name: "3 走の平均(4/10・6/10・8/10 → 0.6)", runs: [{ passing: [4], fieldSize: 10 }, { passing: [6], fieldSize: 10 }, { passing: [8], fieldSize: 10 }], expected: "近3走の1角の平均で前から約6割(0.60)" },
    { name: "4 走目以降は見ない(既定の 3 走)", runs: [{ passing: [2], fieldSize: 10 }, { passing: [2], fieldSize: 10 }, { passing: [2], fieldSize: 10 }, { passing: [10], fieldSize: 10 }], expected: "近3走の1角の平均で前から約2割(0.20)" },
    { name: "recentRunsForLegStyle=2 なら直近 2 走(脚質と同じ窓)", runs: [{ passing: [2], fieldSize: 10 }, { passing: [4], fieldSize: 10 }, { passing: [10], fieldSize: 10 }], recent: 2, expected: "近2走の1角の平均で前から約3割(0.30)" },
    { name: "頭数が取れない走は採らない(頭数 null の走だけなら不明)", runs: [{ passing: [3], fieldSize: null }], expected: "不明" },
    { name: "通過順位が無い走だけなら不明", runs: [{ passing: [], fieldSize: 16 }], expected: "不明" },
    { name: "過去走が無い(初出走)なら不明", runs: [], expected: "不明" },
    { name: "最後尾(16/16 = 1.0 → 約10割)", runs: [{ passing: [16], fieldSize: 16 }], expected: "直近1走の1角で前から約10割(1.00)" },
    { name: "先頭(1/18 = 0.056 → 丸めても 1 割。下限に頼らない通常の頭数)", runs: [{ passing: [1], fieldSize: 18 }], expected: "直近1走の1角で前から約1割(0.06)" },
    // 下限 `Math.max(1, …)` を検査する行: 位置は小数 3 桁に丸まって 0.045 → ×10 = 0.45 → 丸めると 0。下限が無いと「約0割」になる(実運用の最大頭数を超える入力なので、この行は下限そのものの固定)。
    { name: "先頭(1/22 → 0.045 → 丸めると 0 になるが下限で 1 割)", runs: [{ passing: [1], fieldSize: 22 }], expected: "直近1走の1角で前から約1割(0.04)" },
  ];
  for (const t of table) {
    it(t.name, () => {
      const base = input([horse(1, t.runs)]);
      const p = buildPrompt(t.recent === undefined ? base : { ...base, recentRunsForLegStyle: t.recent });
      expect(tenOf(rowOf(p, 1))).toBe(t.expected);
    });
  }

  it("全馬の行に出る(値が無い馬も『不明』で。行数と一致)", () => {
    const p = buildPrompt(input([...FRONT2, horse(4, [])]));
    expect(p.split("テンの位置=").length - 1).toBe(4);
    expect(tenOf(rowOf(p, 4))).toBe("不明");
  });

  it("位置は『脚質=…(安定度:…)』の直後・『過去ペース傾向=』の前", () => {
    const row = rowOf(buildPrompt(input(FRONT2)), 1);
    const i = [row.indexOf("脚質="), row.indexOf("テンの位置="), row.indexOf("過去ペース傾向=")];
    expect(i.every((x) => x >= 0)).toBe(true);
    expect(i[0]!).toBeLessThan(i[1]!);
    expect(i[1]!).toBeLessThan(i[2]!);
    expect(row).toMatch(/脚質=逃げ\(安定度:[^)]*\), テンの位置=[^,]*, 過去ペース傾向=/);
  });

  it("差を検出できる: テンの位置は馬ごとに違う値になる(前の馬と後ろの馬で値が異なる)", () => {
    const p = buildPrompt(input([horse(1, [{ passing: [1], fieldSize: 16 }]), horse(2, [{ passing: [12], fieldSize: 16 }])]));
    expect(tenOf(rowOf(p, 1))).not.toBe(tenOf(rowOf(p, 2)));
  });
});
