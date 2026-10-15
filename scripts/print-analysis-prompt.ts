/**
 * Issue #315: 近似確認用に、分析の LLM に渡すプロンプトの全文を、シナリオ(S0〜S6)ごとに書き出す。
 * **実 API・netkeiba には出ない**(S0 は golden と同じリポジトリ内のフィクスチャ。S1〜S6 は合成)。
 *
 * 使い方(リポジトリルートで):
 *   pnpm tsx scripts/print-analysis-prompt.ts --scenario S1            # 標準出力にプロンプトの全文
 *   pnpm tsx scripts/print-analysis-prompt.ts --scenario all --out <ディレクトリ>   # <S>-prompt.txt と <S>-facts.json を全シナリオ分書く
 * facts.json は、応答の確認(check-llm-approx-response.ts)が使う馬番・prior と、規則の想定ペース(旧プロンプトの結論)。
 * サブエージェントには <S>-prompt.txt だけを読ませ、facts.json は見せない。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLIP_VARIANTS } from "../packages/core/src/analyzer/clip-variants.js";
import { computeGolden } from "../packages/core/test/golden/pipeline-golden-scenarios.js";
import { ALL_SCENARIO_IDS, buildSyntheticScenarios, renderScenario, type Scenario, type ScenarioId } from "./analysis-approx/scenarios.js";

/** S0: golden と同じ実フィクスチャのレース(中央 16 頭・同日傾向・重賞傾向つき)。 */
async function fixtureScenario(): Promise<Scenario> {
  const golden = await computeGolden();
  const input = golden.llmStubSameDayGrade.promptInput;
  if (input === undefined) throw new Error("golden に promptInput が無い");
  return {
    id: "S0",
    title: "実フィクスチャの中央 16 頭(golden と同じ。同日傾向・重賞傾向つき)",
    observe: "実データの材料(脚質分布・各馬のテンの位置)から展開予想を組み立てるか。development が材料と整合するか。",
    input,
  };
}

export async function allScenarios(): Promise<Scenario[]> {
  return [await fixtureScenario(), ...buildSyntheticScenarios()];
}

function parseArgs(argv: readonly string[]): { scenario: string; out: string | null } {
  let scenario = "";
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") scenario = argv[++i] ?? "";
    else if (argv[i] === "--out") out = argv[++i] ?? null;
    else throw new Error(`知らない引数: ${argv[i]}`);
  }
  return { scenario, out };
}

async function main(): Promise<void> {
  const { scenario, out } = parseArgs(process.argv.slice(2));
  const ids: readonly string[] = ALL_SCENARIO_IDS;
  if (scenario !== "all" && !ids.includes(scenario)) {
    throw new Error(`--scenario は all または ${ALL_SCENARIO_IDS.join("・")}`);
  }
  const maxAdjust = CLIP_VARIANTS.default.maxAdjust;
  const scenarios = (await allScenarios()).filter((s) => scenario === "all" || s.id === (scenario as ScenarioId));
  if (scenario !== "all") {
    process.stdout.write(renderScenario(scenarios[0]!, maxAdjust).prompt);
    return;
  }
  if (out === null) throw new Error("--scenario all には --out <ディレクトリ> が要る");
  mkdirSync(out, { recursive: true });
  for (const s of scenarios) {
    const { prompt, facts } = renderScenario(s, maxAdjust);
    writeFileSync(path.join(out, `${s.id}-prompt.txt`), prompt, "utf-8");
    writeFileSync(path.join(out, `${s.id}-facts.json`), `${JSON.stringify(facts, null, 2)}\n`, "utf-8");
    console.log(`${s.id}: ${path.join(out, `${s.id}-prompt.txt`)}(${facts.promptLength} 字・馬 ${facts.priors.length} 頭・規則の想定ペース ${facts.rule.pace})`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
