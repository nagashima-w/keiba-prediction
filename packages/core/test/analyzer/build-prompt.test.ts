/**
 * プロンプト構築(1レース分のテキスト組み立て)の純関数テスト。
 *
 * 仕様「3. analyzer」がプロンプトに含めると定めた情報:
 *  - 各馬の prior / 調教評価(無い馬は「情報なし」)/ 厩舎コメント(未取得のため「なし」固定)
 *  - レース間隔・脚質と展開想定(逃げ馬の数)/ 当日の天候・馬場
 *  - 単勝オッズ・人気・複勝オッズ下限・参考EV(市場データ。人気薄判定や妙味把握に使い、
 *    3着内率の補正を市場に迎合させる〈アンカリング〉目的では使わないよう明示指示する)
 *  - 予想印(◎〇▲△☆注)の定義・頭数制約・判断材料の指示
 *  - LLMへの指示(JSONのみ・prior±10%以内・根拠明記)と出力スキーマ指定
 * ネットワークやLLMには一切依存しない。
 */

import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  computeReferenceEv,
  type BuildPromptInput,
} from "../../src/analyzer/build-prompt.js";

function baseInput(): BuildPromptInput {
  return {
    race: {
      raceName: "テスト特別",
      courseType: "芝",
      distance: 2000,
      venueName: "東京",
      weather: "晴",
      trackCondition: "良",
    },
    horses: [
      {
        umaban: 1,
        horseName: "アルファ",
        prior: 0.42,
        oikiri: { critic: "動き抜群", rank: "A" },
        runs: [{ passing: [1, 1], fieldSize: 16 }], // 逃げ
        restInterval: "中2週",
      },
      {
        umaban: 2,
        horseName: "ブラボー",
        prior: 0.18,
        oikiri: null, // 調教情報なし
        runs: [{ passing: [10], fieldSize: 16 }], // 差し
        restInterval: "休み明け",
      },
    ],
  };
}

describe("buildPrompt(1レース分のプロンプト)", () => {
  it("各馬の馬番・馬名・prior を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("アルファ");
    expect(p).toContain("ブラボー");
    expect(p).toContain("0.42");
    expect(p).toContain("0.18");
  });

  it("調教評価があれば評価テキストとランクを含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("動き抜群");
    expect(p).toContain("A");
  });

  it("調教情報が無い馬は「情報なし」と表記すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("情報なし");
  });

  it("厩舎コメントは未取得のため「なし」固定で含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("厩舎コメント");
    expect(p).toContain("なし");
  });

  it("将来の受け皿として厩舎コメント引数を渡せばそれを反映すること", () => {
    const input = baseInput();
    const withComment: BuildPromptInput = {
      ...input,
      horses: [{ ...input.horses[0]!, stableComment: "今回は勝負気配" }, input.horses[1]!],
    };
    const p = buildPrompt(withComment);
    expect(p).toContain("今回は勝負気配");
  });

  it("脚質(逃げ/差し)とレース間隔を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("逃げ");
    expect(p).toContain("差し");
    expect(p).toContain("中2週");
    expect(p).toContain("休み明け");
  });

  it("逃げ馬の数(展開想定)を明示すること", () => {
    const p = buildPrompt(baseInput());
    // 逃げ馬は1頭。
    expect(p).toContain("逃げ馬");
    expect(p).toMatch(/逃げ馬.*1/);
  });

  it("当日の天候・馬場状態を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("晴");
    expect(p).toContain("良");
  });

  it("LLMへの指示(JSONのみ・±10%・根拠)を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("JSON");
    expect(p).toContain("10%");
    expect(p).toContain("根拠");
  });

  it("出力スキーマ(horses/number/place_prob/reason)を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("place_prob");
    expect(p).toContain("number");
    expect(p).toContain("reason");
    expect(p).toContain("horses");
  });

  it("出力テキストに『prior』という語を使わない(3着内率表記に統一)", () => {
    // ユーザー要望: LLM出力を見てパッとわかるよう、prior ではなく「3着内率」表記に統一する。
    // JSONスキーマのキー(place_prob 等)は英語のまま変えないので、それらは影響しない。
    const p = buildPrompt(baseInput());
    expect(p).not.toContain("prior");
  });

  it("各馬の事前推定値を『3着内率』という表記で提示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("3着内率");
    // 値自体は従来どおり載る。
    expect(p).toContain("0.42");
  });

  it("reason にも『prior』ではなく『3着内率』と書くよう明示指示すること", () => {
    const p = buildPrompt(baseInput());
    // 根拠(reason)文中の表記指示があり、3着内率 を使うよう促している。
    expect(p).toContain("reason");
    expect(p).toContain("3着内率");
  });

  it("天候・馬場が未取得なら不明表記で落ちないこと", () => {
    const input = baseInput();
    const noWeather: BuildPromptInput = {
      ...input,
      race: { ...input.race, weather: null, trackCondition: null },
    };
    const p = buildPrompt(noWeather);
    expect(p).toContain("不明");
  });
});

describe("buildPrompt(雨予報時の馬場悪化シナリオ・仕様L104)", () => {
  function withRace(race: Partial<BuildPromptInput["race"]>): string {
    const input = baseInput();
    return buildPrompt({ ...input, race: { ...input.race, ...race } });
  }

  it("天候が雨系なら馬場悪化シナリオの指示を含むこと", () => {
    const p = withRace({ weather: "雨", trackCondition: "良" });
    expect(p).toContain("馬場悪化");
    expect(p).toContain("道悪適性");
  });

  it("馬場が稍重以下なら馬場悪化シナリオの指示を含むこと", () => {
    const p = withRace({ weather: "曇", trackCondition: "稍重" });
    expect(p).toContain("馬場悪化");
  });

  it("wetForecast=true(前日想定)なら馬場悪化シナリオの指示を含むこと", () => {
    const p = withRace({ weather: "晴", trackCondition: "良", wetForecast: true });
    expect(p).toContain("馬場悪化");
  });

  it("良馬場かつ予報なしなら馬場悪化シナリオの指示を含まないこと", () => {
    const p = withRace({ weather: "晴", trackCondition: "良" });
    expect(p).not.toContain("馬場悪化");
  });
});

describe("computeReferenceEv(参考EV = 3着内率 × 複勝オッズ下限)", () => {
  const cases: ReadonlyArray<{
    label: string;
    prior: number;
    placeOddsMin: number | null;
    expected: number | null;
  }> = [
    { label: "通常計算", prior: 0.4, placeOddsMin: 2.0, expected: 0.8 },
    { label: "複勝オッズ下限がnullならnull", prior: 0.4, placeOddsMin: null, expected: null },
    { label: "prior=0でも0を返す(nullにしない)", prior: 0, placeOddsMin: 2.0, expected: 0 },
  ];
  it.each(cases)("$label", ({ prior, placeOddsMin, expected }) => {
    expect(computeReferenceEv(prior, placeOddsMin)).toEqual(expected);
  });
});

describe("buildPrompt(市場データ: 単勝オッズ・人気・複勝オッズ下限・参考EV)", () => {
  function withOdds(
    overrides: Partial<BuildPromptInput["horses"][number]>,
  ): string {
    const input = baseInput();
    return buildPrompt({
      ...input,
      horses: [{ ...input.horses[0]!, ...overrides }, input.horses[1]!],
    });
  }

  it("単勝オッズ・人気・複勝オッズ下限・参考EVの値を含むこと", () => {
    const p = withOdds({
      winOdds: 5.2,
      popularity: 3,
      placeOddsMin: 1.8,
      referenceEv: 0.76,
    });
    expect(p).toContain("単勝オッズ");
    expect(p).toContain("5.2");
    expect(p).toContain("3番人気");
    expect(p).toContain("複勝オッズ下限");
    expect(p).toContain("1.8");
    expect(p).toContain("参考EV");
    expect(p).toContain("0.76");
  });

  it("単勝オッズ未取得は「不明」と表記すること", () => {
    const p = withOdds({ winOdds: null });
    expect(p).toContain("不明");
  });

  it("人気未取得は「不明(オッズ値から判断)」と表記すること", () => {
    const p = withOdds({ popularity: null });
    expect(p).toContain("不明(オッズ値から判断)");
  });

  it("複勝オッズ下限未取得(複勝未発売等)は「複勝未発売」と表記すること", () => {
    const p = withOdds({ placeOddsMin: null });
    expect(p).toContain("複勝未発売");
  });

  it("参考EV未算出は「算出不可」と表記すること", () => {
    const p = withOdds({ referenceEv: null });
    expect(p).toContain("算出不可");
  });

  it("市場データ未指定(フィールド省略)でも落ちずに既定表記になること", () => {
    const input = baseInput();
    const p = buildPrompt(input);
    expect(p).toContain("不明");
    expect(p).toContain("複勝未発売");
    expect(p).toContain("算出不可");
  });

  it("市場オッズは人気薄判定・妙味把握用であり、3着内率補正のアンカリングに使わないよう明示指示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("アンカリング");
    expect(p).toContain("市場");
  });

  it("参考EVは事前推定に基づく参考値であり最終EVはLLM補正後確率で再計算される旨を明示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("参考EV");
    expect(p).toContain("再計算");
  });
});

describe("buildPrompt(予想印の指示)", () => {
  it("6種類の印(◎〇▲△☆注)の定義を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("◎");
    expect(p).toContain("〇");
    expect(p).toContain("▲");
    expect(p).toContain("△");
    expect(p).toContain("☆");
    expect(p).toContain("注");
    expect(p).toContain("本命");
    expect(p).toContain("対抗");
    expect(p).toContain("単穴");
    expect(p).toContain("連下");
  });

  it("頭数制約(◎〇▲各1頭・△1〜3頭・☆注各0〜1頭)を明示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("1〜3頭");
    expect(p).toMatch(/◎.*ちょうど1頭|1頭.*◎/);
  });

  it("☆・注は人気薄(オッズ・人気を根拠に)であることを条件として含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("人気");
    expect(p).toContain("穴馬");
  });

  it("判断材料(3着内率・参考EV・オッズ/人気・脚質/展開・ここまでの分析)を明示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("判断材料");
    expect(p).toContain("3着内率");
    expect(p).toContain("参考EV");
    expect(p).toContain("脚質");
  });

  it("出力スキーマに mark フィールドを含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("mark");
  });
});
