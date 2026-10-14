/**
 * 月報(Issue #280)の LLM に渡す最終プロンプトを、偽のデータで組み立てて標準出力・ファイルに出す(プロンプトの出来の確認用)。
 *
 * **実 Anthropic API・netkeiba には一切出ない**。D1・R2 にも触れない。本番と同じコード(`buildMonthlyPrompt`・`buildMonthlyEmbed`・`MONTHLY_MAX_TOKENS`)を通すので、
 * ここで見える文字列が本番で LLM に送る文字列と同じ形になる(本番のデータは、日・券種・印・版の行が実データになる)。
 *
 * 使い方(cloud/ で):
 *  - `pnpm run monthly:prompt` … シナリオ M1 のプロンプトを標準出力に出す
 *  - `pnpm run monthly:prompt -- --scenario M2` … 指定したシナリオ(M1 黒字の月・M2 赤字の月・M3 標本の少ない月。`monthly-prompt-scenarios.ts`)だけ
 *  - `pnpm run monthly:prompt -- --scenario all --out <ディレクトリ>` … 全シナリオの `<S>-prompt.txt`(LLM に送る user メッセージの全文)・`<S>-facts.json`(確定値の一覧。
 *    出力の突き合わせ用)・`<S>-embed.json`(文章が無い場合の Discord の embed)をそのディレクトリに書く
 *
 * 実 API の代わりに、サブエージェントにこのプロンプトを読ませて出力を確かめるための道具(本番のモデルと同じではない)。
 * 送信の形: 本番の送信は `system` を持たず、`messages` に user メッセージを 1 通だけ載せる(`MONTHLY_MAX_TOKENS`・日報と同じ `effort: low`)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { excludingTopRecoveryRate } from "./src/daily-report-digest";
import { buildMonthlyEmbed } from "./src/monthly-report-embed";
import { buildMonthlyPrompt, MONTHLY_MAX_TOKENS, MONTHLY_PROMPT_VERSION } from "./src/monthly-report-prompt";
import { buildMonthlyScenario, MONTHLY_SCENARIO_IDS, type MonthlyScenario, type MonthlyScenarioId } from "./monthly-prompt-scenarios";

/** シナリオの確定値の一覧(出力の突き合わせ用)。 */
export function scenarioFacts(scenario: MonthlyScenario): Record<string, unknown> {
  const s = scenario.stats;
  const round = (n: number | null, digits = 4): number | null => (n === null ? null : Number(n.toFixed(digits)));
  return {
    scenario: scenario.id,
    title: scenario.title,
    month: scenario.month,
    promptVersion: MONTHLY_PROMPT_VERSION,
    lastDayPending: scenario.lastDayPending,
    raceCount: s.raceCount,
    resultRaceCount: s.resultRaceCount,
    noResultRaceCount: s.noResultRaceCount,
    dayCount: s.dayCount,
    totalStake: s.totalStake,
    totalReturn: s.totalReturn,
    recoveryRate: round(s.recoveryRate),
    judgedBetCount: s.judgedBetCount,
    hitBetCount: s.hitBetCount,
    unjudgedBetCount: s.unjudgedBetCount,
    refundedBetCount: s.refundedBetCount,
    expectedBetCount: s.expectedBetCount,
    expectedHits: round(s.expectedHits, 2),
    expectedBaseHits: s.expectedBaseHits,
    excludingTopRecoveryRate: round(excludingTopRecoveryRate(s)),
    maxPayout: s.maxPayout,
    byBetType: s.byBetType,
    byMark: s.byMark,
    whatIf: s.whatIf,
    days: s.days.map((d) => ({ date: d.date, raceCount: d.raceCount, noResultRaceCount: d.noResultRaceCount, totalStake: d.totalStake, totalReturn: d.totalReturn, recoveryRate: round(d.recoveryRate), judgedBetCount: d.judgedBetCount, hitBetCount: d.hitBetCount, unjudgedBetCount: d.unjudgedBetCount, unjudgedStake: d.unjudgedStake })),
    byVersion: s.byVersion.map((v) => ({ promptVersion: v.promptVersion, raceCount: v.raceCount, totalStake: v.totalStake, totalReturn: v.totalReturn, recoveryRate: round(v.recoveryRate), judgedBetCount: v.judgedBetCount, hitBetCount: v.hitBetCount })),
  };
}

export function scenarioPrompt(scenario: MonthlyScenario): string {
  return buildMonthlyPrompt({ month: scenario.month, stats: scenario.stats, lastDayPending: scenario.lastDayPending });
}

function parseArgs(argv: readonly string[]): { scenario: MonthlyScenarioId | "all"; out: string | null } {
  let scenario: MonthlyScenarioId | "all" = "M1";
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--scenario") {
      const v = argv[(i += 1)];
      if (v === "all" || (MONTHLY_SCENARIO_IDS as readonly string[]).includes(v ?? "")) {
        scenario = v as MonthlyScenarioId | "all";
      } else {
        throw new Error(`--scenario は ${MONTHLY_SCENARIO_IDS.join("・")}・all のどれかです`);
      }
    } else if (arg === "--out") {
      out = argv[(i += 1)] ?? null;
    } else {
      throw new Error(`未知の引数: ${arg}`);
    }
  }
  return { scenario, out };
}

function main(): void {
  const { scenario, out } = parseArgs(process.argv.slice(2));
  const ids: readonly MonthlyScenarioId[] = scenario === "all" ? MONTHLY_SCENARIO_IDS : [scenario];
  if (out !== null) {
    const dir = path.resolve(out);
    mkdirSync(dir, { recursive: true });
    for (const id of ids) {
      const sc = buildMonthlyScenario(id);
      const prompt = scenarioPrompt(sc);
      writeFileSync(path.join(dir, `${id}-prompt.txt`), prompt, "utf8");
      writeFileSync(path.join(dir, `${id}-facts.json`), JSON.stringify(scenarioFacts(sc), null, 2) + "\n", "utf8");
      const embed = buildMonthlyEmbed({ month: sc.month, stats: sc.stats, narrative: null, note: "(文章なしの例)", link: "https://example.com/#report=202610", lastDayPending: sc.lastDayPending });
      writeFileSync(path.join(dir, `${id}-embed.json`), JSON.stringify(embed, null, 2) + "\n", "utf8");
      console.log(`${id}(${sc.title}): プロンプト ${prompt.length} 文字 → ${path.join(dir, `${id}-prompt.txt`)}`);
    }
    return;
  }
  for (const id of ids) {
    const sc = buildMonthlyScenario(id);
    const prompt = scenarioPrompt(sc);
    console.log(`==== 送信パラメータ(本番と同じ値。モデルは設定の analysisModel に従う) ====`);
    console.log(JSON.stringify({ model: "(設定の analysisModel〈auto は最新 Sonnet〉。固定モデルは claude-sonnet-5-5)", max_tokens: MONTHLY_MAX_TOKENS, output_config: { effort: "low" }, system: "(なし)", messages: "[{role: user, content: <下の全文>}]" }, null, 2));
    console.log(`\n==== user メッセージ(全文。${prompt.length} 文字・${sc.id} ${sc.title}) ====`);
    console.log(prompt);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
