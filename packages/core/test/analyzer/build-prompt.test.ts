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
  buildPromptPreview,
  CLIP_VARIANTS,
  clipAbsoluteLabel,
  clipPercentLabel,
  computeReferenceEv,
  PROMPT_VERSION,
  type BuildPromptInput,
} from "../../src/analyzer/build-prompt.js";
import type { SameDayTrendSummary } from "../../src/analyzer/same-day-trend.js";
import type { BodyWeightTrendSummary } from "../../src/analyzer/body-weight-trend.js";
import type { MarketGapSummary } from "../../src/analyzer/market-gap.js";
import type { JockeyChangeSummary } from "../../src/analyzer/jockey-change.js";
import type { MarginTrendSummary } from "../../src/analyzer/margin-trend.js";

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

  it("展開想定(脚質分布・主導権候補・ペース想定・恵まれる/損する脚質)を明示すること", () => {
    const p = buildPrompt(baseInput());
    // 脚質分布: 逃げ1頭・差し1頭(baseInputの内訳)。
    expect(p).toContain("脚質分布");
    expect(p).toMatch(/逃げ1頭/);
    expect(p).toMatch(/差し1頭/);
    // 主導権候補: 逃げ馬(馬番1)が該当。
    expect(p).toContain("主導権候補");
    expect(p).toContain("馬番1");
    // ペース想定とその根拠。
    expect(p).toContain("ペース想定");
    // 恵まれる/損する脚質(逃げ馬1頭=平均ペース想定 → 先行・差しが恵まれる想定)。
    expect(p).toContain("恵まれる脚質");
    expect(p).toContain("損する脚質");
  });

  it("各馬行に脚質の安定度と過去のペース傾向を補足すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("安定度");
    expect(p).toContain("過去ペース傾向");
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

  it("頭数制約緩和後(◎はちょうど1頭必須・〇▲は0〜1頭・△は0〜3頭・☆注各0〜1頭)を明示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("0〜3頭");
    expect(p).toMatch(/◎.*ちょうど1頭|1頭.*◎/);
    expect(p).toContain("0〜1頭(該当馬がいなければ付けなくてよい)");
  });

  it("本線印(◎〇▲△)の gapless な優先順位(上位を飛ばして下位だけ付けることは不可)を明示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("上位を飛ばして下位だけに印を付けることは不可");
    expect(p).toContain("◎→〇→▲→△の順");
  });

  it("☆・注が本線と独立した人気薄枠であることを明示すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("本線(◎〇▲△)とは独立した人気薄向けの印");
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

  it("過去走の着差傾向反映(タスク#9)追加版として 2026-07-23.5 が付与されていること", () => {
    expect(PROMPT_VERSION).toBe("2026-07-23.5");
  });
});

describe("buildPrompt(芝の傷み目安、タスク#26-P3b)", () => {
  const turfWearHint = {
    開催日次: 8,
    開催回次: 2,
    柵: "A",
    note: "中央2回8日目(柵A)。開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。",
  };

  it("race.turfWearHintが指定されているとき、【レース情報】末尾に「芝コースの開催進行」行を1行追加すること", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: { ...baseInput().race, turfWearHint },
    });
    expect(p).toContain(`芝コースの開催進行: ${turfWearHint.note}`);
  });

  it("追加した行が【レース情報】ブロック内、馬場状態の直後に来ること", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: { ...baseInput().race, turfWearHint },
    });
    const trackConditionIndex = p.indexOf("馬場状態: 良");
    const turfWearIndex = p.indexOf("芝コースの開催進行:");
    const nextSectionIndex = p.indexOf("【展開想定】");
    expect(trackConditionIndex).toBeGreaterThanOrEqual(0);
    expect(turfWearIndex).toBeGreaterThan(trackConditionIndex);
    expect(nextSectionIndex).toBeGreaterThan(turfWearIndex);
  });

  it("race.turfWearHintがundefined(未指定)のとき、「芝コースの開催進行」行を含まないこと(既存文面バイト不変)", () => {
    const p = buildPrompt(baseInput());
    expect(p).not.toContain("芝コースの開催進行");
  });

  it("race.turfWearHintがnull(呼び出し側がnullを渡した)のとき、「芝コースの開催進行」行を含まないこと", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: { ...baseInput().race, turfWearHint: null },
    });
    expect(p).not.toContain("芝コースの開催進行");
  });

  it("回帰: turfWearHint未指定なら既存プロンプト(UNCHANGED_BASE_PROMPT相当)の【レース情報】ブロックが不変であること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain(
      "【レース情報】\nレース名: テスト特別\nコース: 芝2000m\n競馬場: 東京\n天候: 晴\n馬場状態: 良\n\n【展開想定】",
    );
  });
});

describe("buildPrompt(当日の同一場・同一面傾向、タスク#27-C)", () => {
  /** テスト用の SameDayTrendSummary を組み立てるヘルパー(既定は脚質のみ・確定3R)。 */
  function sameDayTrend(overrides: Partial<SameDayTrendSummary> = {}): SameDayTrendSummary {
    return {
      脚質傾向: "前残り優勢",
      内外傾向: null,
      上がり傾向: null,
      サンプル数: { レース数: 3, 複勝圏内馬数: 9 },
      ...overrides,
    };
  }

  it("脚質傾向のみ(内外・上がりが共にnull)のとき、脚質だけの1行を追加すること", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: { ...baseInput().race, courseType: "芝", sameDayTrend: sameDayTrend() },
    });
    expect(p).toContain("当日の同場・同面傾向(芝、確定3R): 脚質=前残り優勢");
  });

  it("内外傾向がある場合、「/ 内外=」を末尾に追加すること", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: {
        ...baseInput().race,
        courseType: "芝",
        sameDayTrend: sameDayTrend({ 内外傾向: "内有利" }),
      },
    });
    expect(p).toContain("当日の同場・同面傾向(芝、確定3R): 脚質=前残り優勢 / 内外=内有利");
  });

  it("上がり傾向がある場合、「/ 上がり=」を末尾に追加すること", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: {
        ...baseInput().race,
        courseType: "ダ",
        sameDayTrend: sameDayTrend({ 上がり傾向: "差し・上がり優勢の示唆" }),
      },
    });
    expect(p).toContain(
      "当日の同場・同面傾向(ダ、確定3R): 脚質=前残り優勢 / 上がり=差し・上がり優勢の示唆",
    );
  });

  it("内外・上がり両方あるとき、両方を「/」区切りで追加すること", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: {
        ...baseInput().race,
        courseType: "芝",
        sameDayTrend: sameDayTrend({ 内外傾向: "外有利", 上がり傾向: "顕著な傾向なし" }),
      },
    });
    expect(p).toContain(
      "当日の同場・同面傾向(芝、確定3R): 脚質=前残り優勢 / 内外=外有利 / 上がり=顕著な傾向なし",
    );
  });

  it("内外・上がりが共にnullのときはそれぞれ省略し、脚質のみの行になること(該当項目のみスキップ)", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: {
        ...baseInput().race,
        sameDayTrend: sameDayTrend({ 内外傾向: null, 上がり傾向: null }),
      },
    });
    const line = p.split("\n").find((l) => l.startsWith("当日の同場・同面傾向"));
    expect(line).toBe(
      `当日の同場・同面傾向(${baseInput().race.courseType}、確定3R): 脚質=前残り優勢`,
    );
  });

  it("脚質傾向がデータ不足のとき、ブロックを一切出さないこと(サンプル不足時非描画)", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: {
        ...baseInput().race,
        sameDayTrend: sameDayTrend({
          脚質傾向: "データ不足",
          サンプル数: { レース数: 1, 複勝圏内馬数: 2 },
        }),
      },
    });
    expect(p).not.toContain("当日の同場・同面傾向");
  });

  it("追加した行が【レース情報】ブロック内、末尾(turfWearHintの後)に来ること", () => {
    const turfWearHint = {
      開催日次: 8,
      開催回次: 2,
      柵: "A",
      note: "中央2回8日目(柵A)。開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。",
    };
    const p = buildPrompt({
      ...baseInput(),
      race: { ...baseInput().race, turfWearHint, sameDayTrend: sameDayTrend() },
    });
    const turfWearIndex = p.indexOf("芝コースの開催進行:");
    const sameDayTrendIndex = p.indexOf("当日の同場・同面傾向");
    const nextSectionIndex = p.indexOf("【展開想定】");
    expect(turfWearIndex).toBeGreaterThanOrEqual(0);
    expect(sameDayTrendIndex).toBeGreaterThan(turfWearIndex);
    expect(nextSectionIndex).toBeGreaterThan(sameDayTrendIndex);
  });

  it("race.sameDayTrendが未指定のとき、行を含まないこと(既存文面バイト不変)", () => {
    const p = buildPrompt(baseInput());
    expect(p).not.toContain("当日の同場・同面傾向");
  });

  it("race.sameDayTrendがnull(呼び出し側がnullを渡した)のとき、行を含まないこと", () => {
    const p = buildPrompt({
      ...baseInput(),
      race: { ...baseInput().race, sameDayTrend: null },
    });
    expect(p).not.toContain("当日の同場・同面傾向");
  });

  it("回帰: sameDayTrend未指定なら既存プロンプト(【レース情報】ブロック)が不変であること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain(
      "【レース情報】\nレース名: テスト特別\nコース: 芝2000m\n競馬場: 東京\n天候: 晴\n馬場状態: 良\n\n【展開想定】",
    );
  });
});

describe("buildPrompt(展開想定: 地方/コース形態の有利脚質補正、タスクB)", () => {
  it("venueKind未指定(中央相当)でも、コース形態による前後有利をLLM自身に判断させる共通行を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain(
      "コース形態(会場・回り・距離)による前後有利は、上記に加えてあなた自身でも判断してください。",
    );
  });

  it("venueKind未指定(中央相当)では地方限定の1行を含まないこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).not.toContain("地方競馬は前残り");
  });

  it("venueKind=centralでは地方限定の1行を含まないこと(中央には非適用)", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      race: { ...input.race, venueKind: "central" },
    });
    expect(p).not.toContain("地方競馬は前残り");
  });

  it("venueKind=centralでも共通の判断委譲行は含むこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      race: { ...input.race, venueKind: "central" },
    });
    expect(p).toContain(
      "コース形態(会場・回り・距離)による前後有利は、上記に加えてあなた自身でも判断してください。",
    );
  });

  it("venueKind=narでは地方限定の1行(前残り・不良時は差しも軽視)を含むこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      race: { ...input.race, venueKind: "nar" },
    });
    expect(p).toContain(
      "地方競馬は前残り(先行有利)傾向が強く、馬場不良時は差しも届きにくい点を加味してください。",
    );
  });

  it("venueKind=narでも共通の判断委譲行は含むこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      race: { ...input.race, venueKind: "nar" },
    });
    expect(p).toContain(
      "コース形態(会場・回り・距離)による前後有利は、上記に加えてあなた自身でも判断してください。",
    );
  });

  it("既存の展開想定4行(脚質分布・主導権候補・ペース想定・恵まれる/損する脚質)の文言は変わらないこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("脚質分布: ");
    expect(p).toContain("主導権候補: ");
    expect(p).toContain("ペース想定: ");
    expect(p).toContain("恵まれる脚質: ");
    expect(p).toContain("損する脚質: ");
  });

  it("buildPromptPreview(venueKind未指定サンプル)が壊れず、共通行を含み地方限定行を含まないこと", () => {
    const p = buildPromptPreview();
    expect(p).toContain(
      "コース形態(会場・回り・距離)による前後有利は、上記に加えてあなた自身でも判断してください。",
    );
    expect(p).not.toContain("地方競馬は前残り");
  });
});

describe("buildPrompt(条件替わり・妙味材料)", () => {
  it("各馬行に「条件替わり=」の項目を含むこと", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("条件替わり=");
  });

  it("runConditions未指定(省略)の馬は「条件替わり=なし」と表記すること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain("条件替わり=なし");
  });

  it("サーフェス替わりが判定できれば「◯替わり(前走△)」を該当馬の行に含めること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        {
          ...input.horses[0]!,
          // 前走(ダ)に加えて芝経験(older)も持たせ、enrichment(初芝)を誤発火させない。
          runConditions: [
            { courseType: "ダ", distance: 2000, venueKind: "中央" },
            { courseType: "芝", distance: 2000, venueKind: "中央" },
          ],
        },
        input.horses[1]!,
      ],
    });
    // baseInput の race.courseType は「芝」、過去走は「ダ」なので「芝替わり(前走ダ)」。
    expect(p).toContain("条件替わり=芝替わり(前走ダ)");
  });

  it("開催区分替わりは race.venueKind を指定したときだけ判定されること(未指定ならこのタグは出ない)", () => {
    const input = baseInput();
    const withoutVenueKind = buildPrompt({
      ...input,
      horses: [
        {
          ...input.horses[0]!,
          runConditions: [{ courseType: "芝", distance: 2000, venueKind: "地方" }],
        },
        input.horses[1]!,
      ],
    });
    expect(withoutVenueKind).not.toContain("中央→");
    expect(withoutVenueKind).not.toContain("地方→");

    const withVenueKind = buildPrompt({
      ...input,
      race: { ...input.race, venueKind: "central" },
      horses: [
        {
          ...input.horses[0]!,
          runConditions: [{ courseType: "芝", distance: 2000, venueKind: "地方" }],
        },
        input.horses[1]!,
      ],
    });
    expect(withVenueKind).toContain("条件替わり=地方→中央");
  });

  it("複数タグ(サーフェス+距離+開催)が該当する馬はサーフェス→距離→開催の順で並べること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      race: { ...input.race, courseType: "ダ", distance: 2400, venueKind: "central" },
      horses: [
        {
          ...input.horses[0]!,
          runConditions: [
            { courseType: "芝", distance: 2000, venueKind: "地方" },
            { courseType: "ダ", distance: 2000, venueKind: "地方" },
          ],
        },
        input.horses[1]!,
      ],
    });
    expect(p).toContain(
      "条件替わり=ダ替わり(前走芝)・距離延長(平均比+400m)・地方→中央",
    );
  });

  it("既存の runs(脚質・過去ペース傾向)や HorseRunPassing の挙動には影響しないこと", () => {
    const p = buildPrompt(baseInput());
    // baseInput の脚質(逃げ/差し)・レース間隔は条件替わり追加後も従来どおり含まれる。
    expect(p).toContain("脚質=逃げ");
    expect(p).toContain("脚質=差し");
    expect(p).toContain("中2週");
  });
});

describe("buildPrompt(馬体重トレンド、タスク#6・未使用パラメータ活用①)", () => {
  /** テスト用の BodyWeightTrendSummary を組み立てるヘルパー(既定は増加傾向・当日あり)。 */
  function bodyWeightTrend(
    overrides: Partial<BodyWeightTrendSummary> = {},
  ): BodyWeightTrendSummary {
    return {
      過去実測: [456, 452, 448],
      傾向: "増加傾向",
      当日: { 体重: 458, 前走比: 2 },
      note: "448→452→456kg(増加傾向)、当日458kg・前走比+2kg",
      ...overrides,
    };
  }

  it("h.bodyWeightTrendが指定されているとき、その馬の行に「馬体重推移=」+noteを含むこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, bodyWeightTrend: bodyWeightTrend() },
        input.horses[1]!,
      ],
    });
    expect(p).toContain(
      "馬体重推移=448→452→456kg(増加傾向)、当日458kg・前走比+2kg",
    );
  });

  it("「馬体重推移=」が「過去ペース傾向」の隣(直後、レース間隔の前)に来ること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, bodyWeightTrend: bodyWeightTrend() },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).toContain(
      "過去ペース傾向=データ不足, 馬体重推移=448→452→456kg(増加傾向)、当日458kg・前走比+2kg, レース間隔=中2週",
    );
  });

  it("h.bodyWeightTrendが未指定(undefined)の馬の行には「馬体重推移=」を含まないこと(既存行バイト不変)", () => {
    const p = buildPrompt(baseInput());
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("馬体重推移");
  });

  it("h.bodyWeightTrendがnull(呼び出し側がnullを渡した)の馬の行にも「馬体重推移=」を含まないこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, bodyWeightTrend: null },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("馬体重推移");
  });

  it("1頭だけbodyWeightTrend指定・もう1頭は未指定のとき、それぞれ独立に反映されること(馬ごとの非破壊optional)", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, bodyWeightTrend: bodyWeightTrend({ 傾向: "減少傾向" }) },
        input.horses[1]!,
      ],
    });
    const line1 = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    const line2 = p.split("\n").find((l) => l.startsWith("馬番2 "))!;
    expect(line1).toContain("馬体重推移=");
    expect(line2).not.toContain("馬体重推移");
  });

  it("回帰: bodyWeightTrend未指定なら既存プロンプト(【出走馬】各行)が不変であること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain(
      "馬番1 アルファ: 3着内率=0.42, 脚質=逃げ(安定度:不明), 過去ペース傾向=データ不足, レース間隔=中2週, 調教=評価「動き抜群」ランクA, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可, 条件替わり=なし",
    );
  });

  it("buildPromptPreview()は「馬体重推移」を含まないこと(PREVIEW_SAMPLE_HORSESに新フィールドを設定しないため不変)", () => {
    expect(buildPromptPreview()).not.toContain("馬体重推移");
  });
});

describe("buildPrompt(人気・着順の乖離、タスク#7・未使用パラメータ活用②)", () => {
  /** テスト用の MarketGapSummary を組み立てるヘルパー(既定は2走・上回りが多い傾向)。 */
  function marketGap(overrides: Partial<MarketGapSummary> = {}): MarketGapSummary {
    return {
      過去走: [
        { 人気: 5, 着順: 3, 頭数: 11, 判定: "人気を上回る着順" },
        { 人気: 8, 着順: 2, 頭数: 11, 判定: "人気を上回る着順" },
      ],
      傾向: "人気を上回る着順が多い",
      note: "近2走で人気を上回る着順2回・下回る着順0回・相応0回(人気を上回る着順が多い)",
      ...overrides,
    };
  }

  it("h.marketGapが指定されているとき、その馬の行に「人気着順乖離=」+noteを含むこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marketGap: marketGap() },
        input.horses[1]!,
      ],
    });
    expect(p).toContain(
      "人気着順乖離=近2走で人気を上回る着順2回・下回る着順0回・相応0回(人気を上回る着順が多い)",
    );
  });

  it("「人気着順乖離=」が「条件替わり=」の直後(行末)に来ること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marketGap: marketGap() },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).toContain(
      "条件替わり=なし, 人気着順乖離=近2走で人気を上回る着順2回・下回る着順0回・相応0回(人気を上回る着順が多い)",
    );
    // 行末である(乖離セグメントの後に別の項目が続かない)ことも確認する。
    expect(line.endsWith("(人気を上回る着順が多い)")).toBe(true);
  });

  it("h.marketGapが未指定(undefined)の馬の行には「人気着順乖離」を含まないこと(既存行バイト不変)", () => {
    const p = buildPrompt(baseInput());
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("人気着順乖離");
  });

  it("h.marketGapがnull(呼び出し側がnullを渡した)の馬の行にも「人気着順乖離」を含まないこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marketGap: null },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("人気着順乖離");
  });

  it("1頭だけmarketGap指定・もう1頭は未指定のとき、それぞれ独立に反映されること(馬ごとの非破壊optional)", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marketGap: marketGap() },
        input.horses[1]!,
      ],
    });
    const line1 = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    const line2 = p.split("\n").find((l) => l.startsWith("馬番2 "))!;
    expect(line1).toContain("人気着順乖離=");
    expect(line2).not.toContain("人気着順乖離");
  });

  it("回帰: marketGap未指定なら既存プロンプト(【出走馬】各行)が不変であること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain(
      "馬番1 アルファ: 3着内率=0.42, 脚質=逃げ(安定度:不明), 過去ペース傾向=データ不足, レース間隔=中2週, 調教=評価「動き抜群」ランクA, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可, 条件替わり=なし",
    );
  });

  it("buildPromptPreview()は「人気着順乖離」を含まないこと(PREVIEW_SAMPLE_HORSESに新フィールドを設定しないため不変)", () => {
    expect(buildPromptPreview()).not.toContain("人気着順乖離");
  });
});

describe("buildPrompt(乗り替わり、タスク#8・未使用パラメータ活用③)", () => {
  /** テスト用の JockeyChangeSummary を組み立てるヘルパー(既定は継続)。 */
  function jockeyChange(overrides: Partial<JockeyChangeSummary> = {}): JockeyChangeSummary {
    return {
      区分: "継続",
      今走騎手名: "武豊",
      前走騎手名: "武豊",
      判定根拠: "id",
      note: "騎手=武豊(前走から継続)",
      ...overrides,
    };
  }

  it("(10-a) h.jockeyChangeが指定されているとき、その馬の行に note の内容を含むこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, jockeyChange: jockeyChange() },
        input.horses[1]!,
      ],
    });
    expect(p).toContain("騎手=武豊(前走から継続)");
  });

  it("(11) 「人気着順乖離」の直後(行末)に乗り替わりが描画されること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        {
          ...input.horses[0]!,
          marketGap: {
            過去走: [{ 人気: 5, 着順: 3, 頭数: 11, 判定: "人気を上回る着順" }],
            傾向: null,
            note: "直近1走: 11頭中5番人気で3着(人気を上回る着順)",
          },
          jockeyChange: jockeyChange({
            区分: "乗り替わり",
            今走騎手名: "武豊",
            前走騎手名: "川田将雅",
            判定根拠: "id",
            note: "騎手=武豊(前走川田将雅から乗り替わり)",
          }),
        },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).toContain(
      "人気着順乖離=直近1走: 11頭中5番人気で3着(人気を上回る着順), 騎手=武豊(前走川田将雅から乗り替わり)",
    );
    // 行末である(乗り替わりセグメントの後に別の項目が続かない)ことも確認する。
    expect(line.endsWith("(前走川田将雅から乗り替わり)")).toBe(true);
  });

  it("(11-b) marketGap未指定・jockeyChangeのみ指定のとき、「条件替わり」の直後に描画されること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, jockeyChange: jockeyChange() },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).toContain("条件替わり=なし, 騎手=武豊(前走から継続)");
    expect(line.endsWith("(前走から継続)")).toBe(true);
  });

  it("(10-b) h.jockeyChangeが未指定(undefined)の馬の行には「騎手=」を含まないこと(既存行バイト不変)", () => {
    const p = buildPrompt(baseInput());
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("騎手=");
  });

  it("h.jockeyChangeがnull(呼び出し側がnullを渡した)の馬の行にも「騎手=」を含まないこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, jockeyChange: null },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("騎手=");
  });

  it("1頭だけjockeyChange指定・もう1頭は未指定のとき、それぞれ独立に反映されること(馬ごとの非破壊optional)", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, jockeyChange: jockeyChange() },
        input.horses[1]!,
      ],
    });
    const line1 = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    const line2 = p.split("\n").find((l) => l.startsWith("馬番2 "))!;
    expect(line1).toContain("騎手=");
    expect(line2).not.toContain("騎手=");
  });

  it("回帰: jockeyChange未指定なら既存プロンプト(【出走馬】各行)が不変であること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain(
      "馬番1 アルファ: 3着内率=0.42, 脚質=逃げ(安定度:不明), 過去ペース傾向=データ不足, レース間隔=中2週, 調教=評価「動き抜群」ランクA, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可, 条件替わり=なし",
    );
  });

  it("buildPromptPreview()は「騎手=」を含まないこと(PREVIEW_SAMPLE_HORSESに新フィールドを設定しないため不変)", () => {
    expect(buildPromptPreview()).not.toContain("騎手=");
  });
});

describe("buildPrompt(過去走の着差傾向、タスク#9・未使用パラメータ活用④)", () => {
  /** テスト用の MarginTrendSummary を組み立てるヘルパー(既定は僅差の敗戦1件のみ)。 */
  function marginTrend(overrides: Partial<MarginTrendSummary> = {}): MarginTrendSummary {
    return {
      過去走: [{ 結果: "敗け", 着差: 0.3, 区分: "僅差" }],
      傾向: null,
      note: "直近1走: 前の馬と0.3差の敗戦(僅差)",
      ...overrides,
    };
  }

  it("h.marginTrendが指定されているとき、その馬の行に「着差傾向=」+noteを含むこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marginTrend: marginTrend() },
        input.horses[1]!,
      ],
    });
    expect(p).toContain("着差傾向=直近1走: 前の馬と0.3差の敗戦(僅差)");
  });

  it("「乗り替わり(騎手=)」の直後(行末)に着差傾向が描画されること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        {
          ...input.horses[0]!,
          jockeyChange: {
            区分: "継続",
            今走騎手名: "武豊",
            前走騎手名: "武豊",
            判定根拠: "id",
            note: "騎手=武豊(前走から継続)",
          },
          marginTrend: marginTrend({
            過去走: [
              { 結果: "敗け", 着差: 0.2, 区分: "僅差" },
              { 結果: "敗け", 着差: 0.1, 区分: "僅差" },
            ],
            傾向: "僅差の敗戦が多い",
            note: "近2走で僅差の敗け2回(僅差の敗戦が多い)",
          }),
        },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).toContain(
      "騎手=武豊(前走から継続), 着差傾向=近2走で僅差の敗け2回(僅差の敗戦が多い)",
    );
    // 行末である(着差傾向セグメントの後に別の項目が続かない)ことも確認する。
    expect(line.endsWith("(僅差の敗戦が多い)")).toBe(true);
  });

  it("jockeyChange未指定・marginTrendのみ指定のとき、「条件替わり」の直後に描画されること", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marginTrend: marginTrend() },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).toContain(
      "条件替わり=なし, 着差傾向=直近1走: 前の馬と0.3差の敗戦(僅差)",
    );
    expect(line.endsWith("(僅差)")).toBe(true);
  });

  it("h.marginTrendが未指定(undefined)の馬の行には「着差傾向」を含まないこと(既存行バイト不変)", () => {
    const p = buildPrompt(baseInput());
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("着差傾向");
  });

  it("h.marginTrendがnull(呼び出し側がnullを渡した)の馬の行にも「着差傾向」を含まないこと", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marginTrend: null },
        input.horses[1]!,
      ],
    });
    const line = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).not.toContain("着差傾向");
  });

  it("1頭だけmarginTrend指定・もう1頭は未指定のとき、それぞれ独立に反映されること(馬ごとの非破壊optional)", () => {
    const input = baseInput();
    const p = buildPrompt({
      ...input,
      horses: [
        { ...input.horses[0]!, marginTrend: marginTrend() },
        input.horses[1]!,
      ],
    });
    const line1 = p.split("\n").find((l) => l.startsWith("馬番1 "))!;
    const line2 = p.split("\n").find((l) => l.startsWith("馬番2 "))!;
    expect(line1).toContain("着差傾向=");
    expect(line2).not.toContain("着差傾向=");
  });

  it("回帰: marginTrend未指定なら既存プロンプト(【出走馬】各行)が不変であること", () => {
    const p = buildPrompt(baseInput());
    expect(p).toContain(
      "馬番1 アルファ: 3着内率=0.42, 脚質=逃げ(安定度:不明), 過去ペース傾向=データ不足, レース間隔=中2週, 調教=評価「動き抜群」ランクA, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可, 条件替わり=なし",
    );
  });

  it("buildPromptPreview()は「着差傾向」を含まないこと(PREVIEW_SAMPLE_HORSESに新フィールドを設定しないため不変)", () => {
    expect(buildPromptPreview()).not.toContain("着差傾向");
  });
});

describe("buildPrompt(追加指示の注入口・Task#28 プロンプト改善C)", () => {
  // Task#27時点(コミット09fa1f0)の buildPrompt(baseInput()) の出力をそのまま固定した回帰用リテラル。
  // additionalInstruction が空/未指定のときにこの文字列と完全一致することを保証し、
  // 注入口を追加してもデフォルト挙動(既存プロンプト)が一切変わらないことを担保する。
  // 2026-07-19: 予想印の頭数制約緩和(B-1)+優先順位明記(PROMPT_VERSION "2026-07-19.1")に伴い、
  // 【予想印】セクションの文面を新しい固定文面として更新した。他セクションは不変。
  // 2026-07-19(2): 条件替わり(妙味材料)追加(PROMPT_VERSION "2026-07-19.2")に伴い、各馬行末尾に
  // 「, 条件替わり=なし」を追加した(baseInputの各馬はrunConditions未指定のため新馬相当=タグなし)。
  // 2026-07-19(3): 地方/コース形態の有利脚質補正(タスクB。PROMPT_VERSION "2026-07-19.3")に伴い、
  // 【展開想定】末尾に共通の判断委譲行を追加した(baseInputはvenueKind未指定=中央相当のため
  // 地方限定行は出ない)。他セクションは不変。
  const UNCHANGED_BASE_PROMPT =
    "あなたは競馬の複勝圏内(3着以内)確率を評価するアナリストです。\n\n【レース情報】\nレース名: テスト特別\nコース: 芝2000m\n競馬場: 東京\n天候: 晴\n馬場状態: 良\n\n【展開想定】\n脚質分布: 逃げ1頭 / 先行0頭 / 差し1頭 / 追込0頭\n主導権候補: 馬番1\nペース想定: 平均(根拠: 逃げ馬1頭で平均ペース想定(逃げ1頭・主導権候補は馬番1))\n恵まれる脚質: 先行・差し\n損する脚質: 特になし\nコース形態(会場・回り・距離)による前後有利は、上記に加えてあなた自身でも判断してください。\n\n【出走馬(3着内率 は scorer が数値データから算出した複勝圏内〈3着以内〉確率の事前推定値)】\n馬番1 アルファ: 3着内率=0.42, 脚質=逃げ(安定度:不明), 過去ペース傾向=データ不足, レース間隔=中2週, 調教=評価「動き抜群」ランクA, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可, 条件替わり=なし\n馬番2 ブラボー: 3着内率=0.18, 脚質=差し(安定度:不明), 過去ペース傾向=データ不足, レース間隔=休み明け, 調教=情報なし, 厩舎コメント=なし, 単勝オッズ=不明, 人気=不明(オッズ値から判断), 複勝オッズ下限=複勝未発売, 参考EV=算出不可, 条件替わり=なし\n\n注記: 参考EVは 3着内率(LLM補正前の事前推定値)× 複勝オッズ下限 の参考値です。あなたが出す補正後確率(place_prob)で最終的なEVは別途再計算されるため、参考EV自体を出力する必要はありません。\n重要: 単勝オッズ・人気・参考EVは、予想印の☆・注(人気薄判定)や妙味の把握に使ってください。3着内率の補正そのものを市場オッズに近づける(アンカリングする)目的で使うことは禁止します。補正の根拠はあくまで脚質・展開・調教・レース間隔・厩舎コメント等のデータに基づいてください。本ツールは市場から独立した確率推定と市場オッズを掛け合わせて妙味を見つけることが目的であり、確率推定が市場に迎合すると妙味が失われます。\n\n【指示】\n各馬の複勝圏内確率を JSON のみで出力してください。散文や説明文は出力しないでください。\n補正は各馬の 3着内率(データからの事前推定)から ±10%(絶対値0.10)以内に留めてください。3着内率から大きく離れた値は禁止です。\n補正には必ず根拠(調教・厩舎コメント・展開のいずれか)を reason に日本語で明記してください。\nreason の文中では、事前推定値を指すときは必ず「3着内率」と日本語で表記してください(英語の略称は使わないでください)。\nplace_prob は 0 以上 1 以下の小数です。全馬について出力してください。\n\n【予想印】\n各馬に以下6種類の予想印(mark)のいずれか、または印なし(null)を1つ付けてください(1頭に複数の印を付けることはできません)。\n◎(本命): 1着になりそうな最有力の馬。必ずちょうど1頭。\n〇(対抗): 本命に対抗できそうな2番手の馬。0〜1頭(該当馬がいなければ付けなくてよい)。\n▲(単穴): 本命と対抗を差し置いて勝てる可能性がある3番手の馬。0〜1頭(該当馬がいなければ付けなくてよい)。\n△(連下): 上記3つの印よりは劣るが、2着や3着に入りそうな馬。0〜3頭(該当馬がいなければ付けなくてよい)。\n☆(星): 人気はないが(単勝オッズ・人気を根拠に判断)、展開やペースがはまれば勝てる可能性のある穴馬。0〜1頭。\n注(注意): 人気はないが(単勝オッズ・人気を根拠に判断)、展開やペースがはまれば3着に入る可能性のある穴馬。0〜1頭。\n判断材料: 3着内率・参考EV・単勝オッズ/人気・脚質と展開想定、およびここまでの分析(各馬の place_prob と reason)を総合して判断してください。\n本線印(◎〇▲△)の頭数制約: ◎は必ずちょうど1頭。それ以外は◎→〇→▲→△の順で上位から途切れなく付けてください(▲を付けるなら〇も必ず付ける、△を付けるなら〇と▲も必ず付ける)。上位を飛ばして下位だけに印を付けることは不可です。自信の持てる印がそこまでなら、それより下位の印は無理に付けず省略してください(例: ◎のみ、◎〇のみ、◎〇▲のみもすべて可)。\n☆・注は本線(◎〇▲△)とは独立した人気薄向けの印です。本線印の頭数や有無、☆と注のどちらを先に検討したかに関わらず、それぞれ単独で0〜1頭を判断してください(☆だけ・注だけ・両方・どちらもなし、いずれも可)。\n\n【出力スキーマ(この形式の JSON のみ)】\n{\"horses\": [{\"number\": 1, \"place_prob\": 0.42, \"reason\": \"...\", \"mark\": \"◎\"}, {\"number\": 2, \"place_prob\": 0.30, \"reason\": \"...\", \"mark\": null}]}";

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

/**
 * clipVariant(タスクD-2: ±10%↔±15%クリップ幅のA/B・新版並走)のテスト。
 * 対照(clipVariant未指定 or "default")のバイト完全不変・新版(wide15)の文面反映・
 * 単一ソース(CLIP_VARIANTS)からの機械導出・anti-anchoring等の非破壊を検証する。
 */
describe("clipVariant(タスクD-2: クリップ幅の版切替)", () => {
  it("未指定は対照(±10%・絶対値0.10)のままで、明示的に'default'を渡した場合とバイト完全一致すること", () => {
    const withoutVariant = buildPrompt(baseInput());
    const withDefaultVariant = buildPrompt({ ...baseInput(), clipVariant: "default" });
    expect(withoutVariant).toBe(withDefaultVariant);
    expect(withoutVariant).toContain("±10%(絶対値0.10)以内に留めてください");
  });

  it("不正な版ID・未知の値は対照(±10%)へフォールバックすること(受け入れ条件: 不正値/未設定フォールバック)", () => {
    const p = buildPrompt({
      ...baseInput(),
      clipVariant: "bogus" as unknown as BuildPromptInput["clipVariant"],
    });
    expect(p).toBe(buildPrompt(baseInput()));
  });

  it("新版(wide15)は【指示】セクションの許容幅が「±15%(絶対値0.15)」になること", () => {
    const p = buildPrompt({ ...baseInput(), clipVariant: "wide15" });
    expect(p).toContain("±15%(絶対値0.15)以内に留めてください");
    expect(p).not.toContain("±10%(絶対値0.10)");
  });

  it("新版(wide15)は追加指示ブロックの「3着内率±X%の制約」表記も±15%へ連動すること(D-6: 取りこぼし防止)", () => {
    const p = buildPrompt({
      ...baseInput(),
      clipVariant: "wide15",
      additionalInstruction: "テスト指示",
    });
    expect(p).toContain("3着内率±15%の制約");
    expect(p).not.toContain("3着内率±10%の制約");
  });

  it("文面の許容幅数値はCLIP_VARIANTSレジストリのmaxAdjustから機械導出されること(単一ソース保証・D-3)", () => {
    const variant = CLIP_VARIANTS.wide15;
    expect(variant.maxAdjust).toBe(0.15);
    const p = buildPrompt({ ...baseInput(), clipVariant: variant.id });
    // この期待文字列自体を variant.maxAdjust(=parseAnalyzerResponseへ渡るmaxAdjustと同一値。
    // clip-variants.test.ts / pipeline-deps.test.ts の配線疎通テストと合わせて一致を保証する)から
    // 動的に組み立てることで、ハードコードした数値同士の偶然の一致ではないことを示す。
    expect(p).toContain(
      `±${clipPercentLabel(variant.maxAdjust)}(絶対値${clipAbsoluteLabel(variant.maxAdjust)})`,
    );
  });

  it("新版と対照の文面差分はクリップ幅の数値のみに局所化されること(anti-anchoring・出力スキーマ等は非破壊)", () => {
    const defaultPrompt = buildPrompt(baseInput());
    const wide15Prompt = buildPrompt({ ...baseInput(), clipVariant: "wide15" });
    const normalizedWide15 = wide15Prompt
      .replaceAll("±15%(絶対値0.15)", "±10%(絶対値0.10)")
      .replaceAll("3着内率±15%の制約", "3着内率±10%の制約");
    expect(normalizedWide15).toBe(defaultPrompt);
  });

  it("新版でもアンカリング禁止の指示文言が変わらず残ること", () => {
    const p = buildPrompt({ ...baseInput(), clipVariant: "wide15" });
    expect(p).toContain(
      "3着内率の補正そのものを市場オッズに近づける(アンカリングする)目的で使うことは禁止します。",
    );
  });
});

/**
 * buildPromptPreview(設定画面のプロンプトプレビュー用。実レース不要の決定論的サンプル)のテスト。
 * 設定画面で「実際にLLMへ送る文面」を確認できるようにする機能の一部(ユーザーフィードバック対応)。
 * 【レース情報】【出走馬】はサンプル(動的)だが、【指示】【予想印】制約・±10%・アンカリング禁止・
 * 【出力スキーマ】は buildPrompt がそのまま組み立てる固定文面であり、それらが含まれることを検証する。
 */
describe("buildPromptPreview(設定画面向けプロンプトプレビュー)", () => {
  it("固定の指示・制約・出力スキーマを含むこと", () => {
    const p = buildPromptPreview();
    expect(p).toContain("【指示】");
    expect(p).toContain("10%");
    expect(p).toContain("アンカリング");
    expect(p).toContain("【予想印】");
    expect(p).toContain("◎");
    expect(p).toContain("頭数制約");
    expect(p).toContain("【出力スキーマ");
    expect(p).toContain("place_prob");
  });

  it("サンプルのレース情報・出走馬(固定3頭、オッズ・prior付き)を含むこと", () => {
    const p = buildPromptPreview();
    expect(p).toContain("【レース情報】");
    expect(p).toContain("【出走馬");
    expect(p).toContain("芝");
    expect(p).toContain("晴");
    expect(p).toContain("良");
    // サンプルは固定3頭(頭数が意図せず変わったら退行として検知できるよう厳密に比較する)。
    const horseLines = p
      .split("\n")
      .filter((line) => line.startsWith("馬番"));
    expect(horseLines.length).toBe(3);
    for (const line of horseLines) {
      expect(line).toContain("3着内率=");
      expect(line).toContain("単勝オッズ=");
      expect(line).not.toContain("単勝オッズ=不明");
    }
  });

  it("同じ引数なら常に同一の文面を返すこと(決定論的)", () => {
    expect(buildPromptPreview()).toBe(buildPromptPreview());
  });

  it("固定サンプルはsameDayTrendを持たないため「当日の同場・同面傾向」行を含まないこと(タスク#27-C: 不変)", () => {
    expect(buildPromptPreview()).not.toContain("当日の同場・同面傾向");
  });

  it.each([
    { label: "追加指示なし(未指定)", additionalInstruction: undefined },
    { label: "追加指示なし(空文字)", additionalInstruction: "" },
    { label: "追加指示なし(空白のみ)", additionalInstruction: "   " },
  ])("$label なら【追加指示】セクションを含まないこと", ({ additionalInstruction }) => {
    const p = buildPromptPreview(additionalInstruction);
    expect(p).not.toContain("【追加指示");
  });

  it("additionalInstruction を渡すと【追加指示】セクションと本文を含むこと", () => {
    const p = buildPromptPreview("人気薄の複勝率は慎重に見積もること");
    expect(p).toContain("【追加指示");
    expect(p).toContain("人気薄の複勝率は慎重に見積もること");
  });

  it("clipVariant未指定は既定(±10%)のままであること(タスクD-2: 設定画面のプレビューにも版反映)", () => {
    expect(buildPromptPreview(undefined)).toContain("±10%(絶対値0.10)以内に留めてください");
  });

  it("clipVariant='wide15' を渡すとプレビューにも±15%(絶対値0.15)が反映されること(タスクD-2)", () => {
    const p = buildPromptPreview(undefined, "wide15");
    expect(p).toContain("±15%(絶対値0.15)以内に留めてください");
  });

  /** プレビュー本文からセクション見出し(行頭「【」)のラベル部分(括弧内の説明文を除く)だけを抜き出す。 */
  function sectionHeadingKeys(text: string): string[] {
    return text
      .split("\n")
      .filter((line) => line.startsWith("【"))
      .map((line) => line.match(/^【([^(（】]+)/)?.[1] ?? line);
  }

  it(
    "出力されるセクション見出しの集合が固定であること" +
      "(設定画面〈SettingsView.tsx〉のプレビュー注記が列挙するセクションと1対1で対応させる必要があるため、" +
      "buildPrompt のセクション構成が変わったらこのテストで検知し、注記側の見直しを促す)",
    () => {
      const withoutAdditional = sectionHeadingKeys(buildPromptPreview());
      expect(withoutAdditional).toEqual([
        "レース情報",
        "展開想定",
        "出走馬",
        "指示",
        "予想印",
        "出力スキーマ",
      ]);

      const withAdditional = sectionHeadingKeys(
        buildPromptPreview("テスト追加指示"),
      );
      expect(withAdditional).toEqual([
        "レース情報",
        "展開想定",
        "出走馬",
        "指示",
        "予想印",
        "追加指示",
        "出力スキーマ",
      ]);
    },
  );

  it("サンプルレースは晴・良のため馬場悪化シナリオの指示(条件付き1行)を含まないこと", () => {
    // 馬場悪化シナリオは独立したセクション見出しではなく【指示】内の条件付き1行のため、
    // 上のセクション見出し集合のテストでは検知できない。SettingsView の注記が「馬場悪化」に
    // 触れていないことと矛盾しないよう、サンプル入力(晴・良)では出ないことを別途固定する。
    const p = buildPromptPreview();
    expect(p).not.toContain("馬場悪化");
  });
});
