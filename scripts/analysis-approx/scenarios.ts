/**
 * Issue #315(想定ペースを LLM に展開予想させて決める)の近似確認用シナリオ。**実 API・ネットワークには出ない。**
 *
 * 実 API の代わりに、サブエージェントにプロンプトの全文を読ませて出力を確かめるための入力(`BuildPromptInput`)を作る。
 * S1〜S6 は合成(固定。乱数なし)、S0 は golden と同じ実フィクスチャのレース(CLI が組み立てる。ここでは扱わない)。
 * 各シナリオは、規則(逃げ馬の頭数。旧プロンプトが渡していた結論)の想定ペースと、LLM に期待する観察点を持つ。
 *
 * 本番のモデル(Sonnet 5.5・adaptive thinking・effort low)とは同じではない。max_tokens・thinking の量・JSON の破損率は測れない。
 */
import {
  buildPrompt,
  type BuildPromptInput,
  type PromptHorse,
} from "../../packages/core/src/analyzer/build-prompt.js";
import { analyzeHorseLegStyle, buildRaceDevelopment, type HorseRunPassing, type LegStyle } from "../../packages/core/src/analyzer/leg-style.js";

export type ScenarioId = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6";
export const SYNTHETIC_SCENARIO_IDS: readonly ScenarioId[] = ["S1", "S2", "S3", "S4", "S5", "S6"];
export const ALL_SCENARIO_IDS: readonly ScenarioId[] = ["S0", ...SYNTHETIC_SCENARIO_IDS];

/** 規則(旧プロンプトが渡していた結論)。突き合わせ用で、新しいプロンプトには載らない。 */
export interface RuleFacts {
  readonly pace: string;
  readonly styleCounts: Readonly<Record<LegStyle, number>>;
  readonly unknownCount: number;
  readonly paceSetterUmaban: number | null;
}

export interface ScenarioFacts {
  readonly scenario: ScenarioId;
  readonly title: string;
  /** LLM に見てほしい観察点(判定ではなく、読む人の確認用)。 */
  readonly observe: string;
  readonly maxAdjust: number;
  readonly priors: ReadonlyArray<{ readonly umaban: number; readonly prior: number }>;
  readonly rule: RuleFacts;
  /** プロンプト全文の長さ(コードポイント)。 */
  readonly promptLength: number;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly title: string;
  readonly observe: string;
  readonly input: BuildPromptInput;
}

/** 脚質ごとの合成の過去走(3 走。脚質に応じた位置の推移。ペースは前後半がほぼ同じ「平均的」で固定し、過去のペース傾向の材料が展開予想を誘導しないようにする)。 */
function runsOf(style: LegStyle | null, field: number): HorseRunPassing[] {
  if (style === null) return [];
  const p = (r: number): number => Math.max(1, Math.min(field, Math.round(field * r)));
  const shape: Record<LegStyle, readonly number[]> = {
    逃げ: [1, 1, 1, 1],
    先行: [p(0.2), p(0.2), p(0.2), p(0.2)],
    差し: [p(0.55), p(0.55), p(0.45), p(0.35)],
    追込: [p(0.9), p(0.9), p(0.8), p(0.6)],
  };
  return [0, 1, 2].map(() => ({ passing: shape[style], fieldSize: field, pace: "35.9-36.0", last3f: 35.5 }));
}

/** 合成の1頭。prior は人気順に近い固定値(番号が若いほど高い)。 */
function horse(umaban: number, style: LegStyle | null, field: number): PromptHorse {
  const prior = Math.max(0.05, 0.5 - umaban * (0.4 / field));
  return {
    umaban,
    horseName: `シナリオ馬${umaban}`,
    prior: Math.round(prior * 100) / 100,
    oikiri: null,
    runs: runsOf(style, field),
    restInterval: "中3週",
    winOdds: Math.round((3 + umaban * 1.7) * 10) / 10,
    popularity: umaban,
  };
}

/** 脚質の並び(馬番順)から馬の配列を作る。 */
function horsesOf(styles: ReadonlyArray<LegStyle | null>): PromptHorse[] {
  return styles.map((s, i) => horse(i + 1, s, styles.length));
}

const rep = <T>(v: T, n: number): T[] => Array.from({ length: n }, () => v);

export function buildSyntheticScenarios(): Scenario[] {
  const turf = (distance: number, venueName: string, trackCondition = "良") => ({ courseType: "芝" as const, distance, venueName, weather: "晴", trackCondition });
  return [
    {
      id: "S1",
      title: "逃げ馬 3 頭の中央・芝 1600m(規則の想定はハイ)",
      observe: "逃げ馬が複数いる。LLM がハイ(または競り合いの見立て)を出すか、展開予想がプロンプトの材料(脚質分布・主導権候補)と整合するか。",
      input: { race: { raceName: "シナリオ1", ...turf(1600, "阪神"), venueKind: "central" }, horses: horsesOf(["逃げ", "逃げ", "先行", "先行", "差し", "差し", "差し", "追込", "追込", "逃げ", "先行", "差し"]) },
    },
    {
      id: "S2",
      title: "逃げ馬不在・先行 3 頭の中央・芝 2000m(規則の想定はスロー)",
      observe: "逃げ馬が 0 頭でも、先行馬が多いとき LLM が規則どおりスローとするか、先行力から別の判断をするか。理由が展開予想に書かれているか。",
      input: { race: { raceName: "シナリオ2", ...turf(2000, "京都"), venueKind: "central" }, horses: horsesOf(["先行", "先行", "先行", "差し", "差し", "差し", "追込", "追込", "差し", "先行"]) },
    },
    {
      id: "S3",
      title: "逃げ 1 頭 + 先行 5 頭の中央・ダ 1200m(規則の想定は平均)",
      observe: "規則は逃げ 1 頭で平均だが、先行馬が多く実質は速くなりうる。LLM が規則に機械的に追従せず、材料から独自に判断するか(結果が平均でも、理由が展開予想にあるか)。",
      input: { race: { raceName: "シナリオ3", courseType: "ダ", distance: 1200, venueName: "中山", weather: "晴", trackCondition: "良", venueKind: "central" }, horses: horsesOf(["逃げ", ...rep<LegStyle>("先行", 5), ...rep<LegStyle>("差し", 5), ...rep<LegStyle>("追込", 3)]) },
    },
    {
      id: "S4",
      title: "全頭の脚質が不明(新馬戦相当。規則の想定は不明)",
      observe: "pace を null にし、development にその理由を書くか(3 値を無理に出さないか)。馬ごとの評価で過去の出走を作らないか。",
      input: { race: { raceName: "シナリオ4 (2歳新馬)", ...turf(1200, "福島"), venueKind: "central" }, horses: horsesOf(rep<LegStyle | null>(null, 9)) },
    },
    {
      id: "S5",
      title: "地方・不良馬場・逃げ馬 2 頭のダ 1400m(規則の想定はハイ)",
      observe: "地方の前残り傾向(プロンプトの材料)と不良馬場を、LLM が展開予想に織り込むか。ハイと出しても前が止まらない見立てを書けるか。",
      input: { race: { raceName: "シナリオ5", courseType: "ダ", distance: 1400, venueName: "川崎", weather: "雨", trackCondition: "不良", venueKind: "nar" }, horses: horsesOf(["逃げ", "逃げ", "先行", "先行", "差し", "差し", "差し", "追込", "追込", "先行", "差し", "追込"]) },
    },
    {
      id: "S6",
      title: "18 頭立ての中央・芝 2400m(出力の大きさと JSON の破損の観察)",
      observe: "18 頭分の応答が最後まで出るか(切り詰めの観察)。development が 200 字以内の 1 段落で、改行・ダブルクォートを含まないか。応答の文字数。",
      input: {
        race: { raceName: "シナリオ6", ...turf(2400, "東京"), venueKind: "central" },
        horses: horsesOf(["逃げ", "逃げ", ...rep<LegStyle>("先行", 5), ...rep<LegStyle>("差し", 7), ...rep<LegStyle>("追込", 4)]),
      },
    },
  ];
}

/** 規則(旧プロンプトが渡していた結論)を、入力の馬から求める。 */
export function ruleFactsOf(input: BuildPromptInput): RuleFacts {
  const recentRuns = input.recentRunsForLegStyle ?? 3;
  const dev = buildRaceDevelopment(
    input.horses.map((h) => {
      const a = analyzeHorseLegStyle(h.runs, { recentRuns });
      return { umaban: h.umaban, style: a.style, stability: a.stability, frontRunningScore: a.frontRunningScore };
    }),
    input.race.venueKind,
    input.race.trackCondition,
  );
  return { pace: dev.pace, styleCounts: dev.styleCounts, unknownCount: dev.unknownCount, paceSetterUmaban: dev.paceSetterUmaban };
}

/** シナリオ 1 件のプロンプト全文と、突き合わせ用の事実(`facts.json`)。 */
export function renderScenario(s: Scenario, maxAdjust: number): { readonly prompt: string; readonly facts: ScenarioFacts } {
  const prompt = buildPrompt(s.input);
  return {
    prompt,
    facts: {
      scenario: s.id,
      title: s.title,
      observe: s.observe,
      maxAdjust,
      priors: [...s.input.horses].sort((a, b) => a.umaban - b.umaban).map((h) => ({ umaban: h.umaban, prior: h.prior })),
      rule: ruleFactsOf(s.input),
      promptLength: Array.from(prompt).length,
    },
  };
}
