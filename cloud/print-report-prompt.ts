/**
 * 日報(Issue #235)の LLM に渡す最終プロンプトを、偽のデータで組み立てて標準出力に出す(プロンプトの出来の確認用)。
 *
 * **実 Anthropic API・netkeiba には一切出ない**(送信は偽の sender がプロンプトを受け取るだけ。偽の応答は固定の JSON)。D1・R2 にも触れない。
 * 本番と同じコード(`DailyReportCore`・`buildReportPrompt`・`buildReportEmbed`)を通すので、ここで見える文字列が本番で LLM に送る文字列と同じ形になる
 * (本番のデータは、各レースの根拠・強調材料・懸念事項・買い目・着順が実データになる)。
 *
 * 使い方(cloud/ で): `pnpm run report:prompt`(3 レース)/ `pnpm run report:prompt -- --races 36`(36 レース。大きさの見積もり用)
 *
 * **近似確認のシナリオ(Issue #264)**: `pnpm run report:prompt -- --scenario S1 [--old]` は、シナリオ(`report-prompt-scenarios.ts`。S1〜S6)のプロンプトだけを標準出力に出す
 * (`--old` は旧プロンプト〈{@link OLD_PROMPT_COMMIT} の `daily-report-prompt.ts`。『数十レースの 1 日分では偶然の影響が大きい』〉。新旧で「その日」のレースと買い目は同一)。
 * `--scenario all --out <ディレクトリ>` は、全シナリオの `<S>-new.txt`・`<S>-old.txt`・`<S>-facts.json`(確定値の一覧。判定の突き合わせ用)をそのディレクトリに書く。
 * 実 API の代わりに、サブエージェントにこのプロンプトを読ませて出力を確かめるための道具(本番のモデルと同じではない)。
 *
 * 送信の形: 本番の送信(`createSdkMessageSender`)は `system` を持たず、`messages` に user メッセージを 1 通だけ載せる。
 * 規則・出力形式・事実をすべてその 1 通にまとめている(下の「user メッセージ」がその全文)。他の送信パラメータは下の「送信パラメータ」。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReportEmbed } from "./src/daily-report-embed";
import { buildRaceDigest, excludingTopRecoveryRate } from "./src/daily-report-digest";
import { REPORT_MAX_TOKENS } from "./src/daily-report-prompt";
import { DEFAULT_ANALYZER_CONFIG } from "@keiba/core/llm";
import { buildSavedRecord, fixtureRaceInputs, FIXTURE_DATE } from "./test/daily-report-fixtures";
import type { RaceInput } from "./src/daily-report-core";
import { buildScenario, SCENARIO_DATE, SCENARIO_IDS, type ScenarioId } from "./report-prompt-scenarios";

/** 旧プロンプト(Issue #264 の前。『数十レースの 1 日分では偶然の影響が大きい』を規則に持つ版)のコミット。`--old` はここから `daily-report-prompt.ts` を取り出す。 */
export const OLD_PROMPT_COMMIT = "6d345a6";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 旧プロンプトの組み立て関数を、git から取り出して読み込む(一時ディレクトリに置く。リポジトリは変えない)。 */
async function loadOldBuilder(): Promise<(input: { kaisaiDate: string; digests: unknown; stats: unknown }) => string> {
  const dir = mkdtempSync(path.join(tmpdir(), "old-report-prompt-"));
  try {
    for (const file of ["daily-report-prompt.ts", "recovery-format.ts"]) {
      const text = execFileSync("git", ["show", `${OLD_PROMPT_COMMIT}:cloud/src/${file}`], { cwd: HERE, encoding: "utf8", maxBuffer: 10_000_000 });
      writeFileSync(path.join(dir, file), text);
    }
    const mod = (await import(pathToFileURL(path.join(dir, "daily-report-prompt.ts")).href)) as { buildReportPrompt: (input: { kaisaiDate: string; digests: unknown; stats: unknown }) => string };
    return mod.buildReportPrompt;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** シナリオ 1 つの新旧プロンプトと確定値の一覧を作る。 */
async function scenarioOutputs(id: ScenarioId, oldBuilder: Awaited<ReturnType<typeof loadOldBuilder>>): Promise<{ readonly newPrompt: string; readonly oldPrompt: string; readonly facts: unknown }> {
  const scenario = buildScenario(id);
  const prompts: string[] = [];
  const record = await buildSavedRecord({ inputs: scenario.inputs, prior: scenario.prior, promptOut: prompts });
  const digests = scenario.inputs.map((i) => buildRaceDigest(i.view, i.result)).sort((a, b) => (a.raceId < b.raceId ? -1 : 1));
  const oldPrompt = oldBuilder({ kaisaiDate: SCENARIO_DATE, digests, stats: record.body.stats });
  const day = record.body.stats;
  const total = record.body.rolling!.total;
  const prior = record.body.rolling!.prior;
  const facts = {
    id, description: scenario.description, promptVersion: record.body.promptVersion,
    day: { ...day, excludingTopRecoveryRate: excludingTopRecoveryRate(day), actualMinusExpected: day.expectedBaseHits - day.expectedHits },
    prior: { ...prior, excludingTopRecoveryRate: excludingTopRecoveryRate(prior), actualMinusExpected: prior.expectedBaseHits - prior.expectedHits },
    total: { ...total, excludingTopRecoveryRate: excludingTopRecoveryRate(total), actualMinusExpected: total.expectedBaseHits - total.expectedHits },
  };
  return { newPrompt: prompts[0]!, oldPrompt, facts };
}

async function runScenarios(arg: string, out: string | undefined, old: boolean): Promise<void> {
  const ids = arg === "all" ? [...SCENARIO_IDS] : SCENARIO_IDS.filter((id) => id === arg);
  if (ids.length === 0) {
    throw new Error(`--scenario は ${SCENARIO_IDS.join("・")} か all を指定してください`);
  }
  const oldBuilder = await loadOldBuilder();
  for (const id of ids) {
    const o = await scenarioOutputs(id, oldBuilder);
    if (out === undefined) {
      process.stdout.write(old ? o.oldPrompt : o.newPrompt);
      return;
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, `${id}-new.txt`), o.newPrompt);
    writeFileSync(path.join(out, `${id}-old.txt`), o.oldPrompt);
    writeFileSync(path.join(out, `${id}-facts.json`), `${JSON.stringify(o.facts, null, 2)}\n`);
    process.stdout.write(`${id}: ${out}/${id}-new.txt(${o.newPrompt.length} 文字)・${id}-old.txt(${o.oldPrompt.length} 文字)・${id}-facts.json\n`);
  }
}

function inputsOf(count: number): RaceInput[] {
  const base = fixtureRaceInputs();
  if (count <= base.length) {
    return base.slice(0, count);
  }
  return Array.from({ length: count }, (_, i) => {
    const src = base[i % base.length]!;
    const n = i + 1;
    const raceId = `2026050308${String(n).padStart(2, "0")}`;
    return { view: { ...src.view, id: 100 + n, raceId, race: { ...src.view.race, raceNumber: ((n - 1) % 12) + 1, venueName: ["東京", "京都", "福島"][Math.floor((n - 1) / 12) % 3] ?? "東京" } }, result: src.result };
  });
}

async function main(): Promise<void> {
  const scenarioFlag = process.argv.indexOf("--scenario");
  if (scenarioFlag !== -1) {
    const outFlag = process.argv.indexOf("--out");
    await runScenarios(process.argv[scenarioFlag + 1] ?? "", outFlag === -1 ? undefined : process.argv[outFlag + 1], process.argv.includes("--old"));
    return;
  }
  const flag = process.argv.indexOf("--races");
  const requested = flag === -1 ? 3 : Number(process.argv[flag + 1]);
  const count = Number.isInteger(requested) && requested >= 1 && requested <= 200 ? requested : 3;
  const prompts: string[] = [];
  const record = await buildSavedRecord({ promptOut: prompts, inputs: inputsOf(count) });
  const prompt = prompts[0]!;
  const embed = buildReportEmbed({ kaisaiDate: FIXTURE_DATE, stats: record.body.stats, narrative: record.body.narrative, note: record.body.note, link: undefined });

  const lines = [
    "==== 送信パラメータ(本番と同じ値。モデルは設定の analysisModel に従い、自動選択か固定モデル) ====",
    JSON.stringify({ model: `(設定の analysisModel〈auto は最新 Sonnet〉。固定モデルは ${DEFAULT_ANALYZER_CONFIG.model})`, max_tokens: REPORT_MAX_TOKENS, output_config: { effort: DEFAULT_ANALYZER_CONFIG.effort }, system: "(なし)", messages: "[{role: user, content: <下の全文>}]" }, null, 2),
    "",
    `==== user メッセージ(全文。${prompt.length} 文字・${count} レース) ====`,
    prompt,
    "==== ここまで ====",
    "",
    "==== 偽の応答(固定の JSON。本番では LLM がこの形で返す) ====",
    JSON.stringify(record.body.narrative, null, 2),
    "",
    "==== この応答から作る Discord の embed(リンクなし) ====",
    JSON.stringify(embed, null, 2),
    "",
    "==== 統計(決定的に計算。LLM には確定値として渡す) ====",
    JSON.stringify(record.body.stats, null, 2),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

void main();
