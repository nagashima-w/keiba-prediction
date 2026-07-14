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
  PROMPT_VERSION,
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

describe("PROMPT_VERSION(プロンプト版番号、Task#27)", () => {
  it("YYYY-MM-DD.N 形式の版番号文字列であること", () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("現行プロンプトの初版として 2026-07-14.1 が付与されていること", () => {
    expect(PROMPT_VERSION).toBe("2026-07-14.1");
  });
});

describe("buildPrompt(追加指示の注入口・Task#28 プロンプト改善C)", () => {
  // Task#27時点(コミット09fa1f0)の buildPrompt(baseInput()) の出力をそのまま固定した回帰用リテラル。
  // additionalInstruction が空/未指定のときにこの文字列と完全一致することを保証し、
  // 注入口を追加してもデフォルト挙動(既存プロンプト)が一切変わらないことを担保する。
  const UNCHANGED_BASE_PROMPT =
    "あなたは競馬の複勝圏内(3着以内)確率を評価するアナリストです。\n\n【レース情報】\nレース名: テスト特別\nコース: 芝2000m\n競馬場: 東京\n天候: 晴\n馬場状態: 良\n\n【展開想定】\n逃げ馬の数: 1頭\nペース想定: 逃げ馬1頭で平均ペース想定\n\n【出走馬(3着内率 は scorer が数値データから算出した複勝圏内〈3着以内〉確率の事前推定値)】\n馬番1 アルファ: 3着内率=0.42, 脚質=逃げ, レース間隔=中2週, 調教=評価「動き抜群」ランクA, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可\n馬番2 ブラボー: 3着内率=0.18, 脚質=差し, レース間隔=休み明け, 調教=情報なし, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可\n\n注記: 参考EVは 3着内率(LLM補正前の事前推定値)× 複勝オッズ下限 の参考値です。あなたが出す補正後確率(place_prob)で最終的なEVは別途再計算されるため、参考EV自体を出力する必要はありません。\n重要: 単勝オッズ・人気・参考EVは、予想印の☆・注(人気薄判定)や妙味の把握に使ってください。3着内率の補正そのものを市場オッズに近づける(アンカリングする)目的で使うことは禁止します。補正の根拠はあくまで脚質・展開・調教・レース間隔・厩舎コメント等のデータに基づいてください。本ツールは市場から独立した確率推定と市場オッズを掛け合わせて妙味を見つけることが目的であり、確率推定が市場に迎合すると妙味が失われます。\n\n【指示】\n各馬の複勝圏内確率を JSON のみで出力してください。散文や説明文は出力しないでください。\n補正は各馬の 3着内率(データからの事前推定)から ±10%(絶対値0.10)以内に留めてください。3着内率から大きく離れた値は禁止です。\n補正には必ず根拠(調教・厩舎コメント・展開のいずれか)を reason に日本語で明記してください。\nreason の文中では、事前推定値を指すときは必ず「3着内率」と日本語で表記してください(英語の略称は使わないでください)。\nplace_prob は 0 以上 1 以下の小数です。全馬について出力してください。\n\n【予想印】\n各馬に以下6種類の予想印(mark)のいずれか、または印なし(null)を1つ付けてください(1頭に複数の印を付けることはできません)。\n◎(本命): 1着になりそうな最有力の馬。必ずちょうど1頭。\n〇(対抗): 本命に対抗できそうな2番手の馬。必ずちょうど1頭。\n▲(単穴): 本命と対抗を差し置いて勝てる可能性がある3番手の馬。必ずちょうど1頭。\n△(連下): 上記3つの印よりは劣るが、2着や3着に入りそうな馬。1〜3頭。\n☆(星): 人気はないが(単勝オッズ・人気を根拠に判断)、展開やペースがはまれば勝てる可能性のある穴馬。0〜1頭。\n注(注意): 人気はないが(単勝オッズ・人気を根拠に判断)、展開やペースがはまれば3着に入る可能性のある穴馬。0〜1頭。\n判断材料: 3着内率・参考EV・単勝オッズ/人気・脚質と展開想定、およびここまでの分析(各馬の place_prob と reason)を総合して判断してください。\n頭数制約は厳守してください: ◎〇▲はちょうど1頭ずつ、△は1〜3頭、☆と注はそれぞれ0〜1頭。この条件を満たさない出力は不可です。\n\n【出力スキーマ(この形式の JSON のみ)】\n{\"horses\": [{\"number\": 1, \"place_prob\": 0.42, \"reason\": \"...\", \"mark\": \"◎\"}, {\"number\": 2, \"place_prob\": 0.30, \"reason\": \"...\", \"mark\": null}]}";

  it("回帰: additionalInstruction未指定なら既存プロンプトと完全一致すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toBe(UNCHANGED_BASE_PROMPT);
  });

  it("回帰: additionalInstructionが空文字なら既存プロンプトと完全一致すること(差し込まない)", () => {
    const p = buildPrompt({ ...baseInput(), additionalInstruction: "" });
    expect(p).toBe(UNCHANGED_BASE_PROMPT);
  });

  it("additionalInstructionが空白のみなら差し込まないこと(既存プロンプトと完全一致)", () => {
    const p = buildPrompt({ ...baseInput(), additionalInstruction: "   \n  " });
    expect(p).toBe(UNCHANGED_BASE_PROMPT);
  });

  it("additionalInstructionを指定すると本文を含むこと", () => {
    const p = buildPrompt({
      ...baseInput(),
      additionalInstruction: "人気薄の複勝率は慎重に見積もること",
    });
    expect(p).toContain("人気薄の複勝率は慎重に見積もること");
  });

  it("additionalInstructionの見出し【追加指示】を含むこと", () => {
    const p = buildPrompt({
      ...baseInput(),
      additionalInstruction: "テスト指示",
    });
    expect(p).toContain("【追加指示");
  });

  it("差し込み位置は【予想印】セクションより後、【出力スキーマ】セクションより前であること", () => {
    const p = buildPrompt({
      ...baseInput(),
      additionalInstruction: "テスト指示",
    });
    const markIndex = p.indexOf("【予想印】");
    const instructionIndex = p.indexOf("【追加指示");
    const schemaIndex = p.indexOf("【出力スキーマ");
    expect(markIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeGreaterThan(markIndex);
    expect(schemaIndex).toBeGreaterThan(instructionIndex);
  });

  it("追加指示によって既存のアンカリング禁止・±10%制約等を上書きしない旨を明示すること", () => {
    const p = buildPrompt({
      ...baseInput(),
      additionalInstruction: "テスト指示",
    });
    expect(p).toContain("上書き");
    expect(p).toContain("アンカリング");
  });

  it("前後の空白をトリムして本文のみ差し込むこと", () => {
    const p = buildPrompt({
      ...baseInput(),
      additionalInstruction: "  トリム対象  \n",
    });
    expect(p).toContain("トリム対象");
    expect(p).not.toContain("  トリム対象  ");
  });

  it("複数行の追加指示をそのまま(改行を保持して)差し込めること", () => {
    const p = buildPrompt({
      ...baseInput(),
      additionalInstruction: "1行目の指示\n2行目の指示",
    });
    expect(p).toContain("1行目の指示\n2行目の指示");
  });
});
