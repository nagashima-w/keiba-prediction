/**
 * プロンプト構築(1レース分のテキスト組み立て)の純関数テスト。
 *
 * 仕様「3. analyzer」がプロンプトに含めると定めた情報:
 *  - 各馬の prior / 調教評価(無い馬は「情報なし」)/ 厩舎コメント(未取得のため「なし」固定)
 *  - レース間隔・脚質と展開想定(逃げ馬の数)/ 当日の天候・馬場
 *  - LLMへの指示(JSONのみ・prior±10%以内・根拠明記)と出力スキーマ指定
 * ネットワークやLLMには一切依存しない。
 */

import { describe, expect, it } from "vitest";
import { buildPrompt, type BuildPromptInput } from "../../src/analyzer/build-prompt.js";

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
