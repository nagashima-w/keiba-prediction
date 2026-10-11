/**
 * 日報(Issue #235)の LLM に渡す最終プロンプトを、偽のデータで組み立てて標準出力に出す(プロンプトの出来の確認用)。
 *
 * **実 Anthropic API・netkeiba には一切出ない**(送信は偽の sender がプロンプトを受け取るだけ。偽の応答は固定の JSON)。D1・R2 にも触れない。
 * 本番と同じコード(`DailyReportCore`・`buildReportPrompt`・`buildReportEmbed`)を通すので、ここで見える文字列が本番で LLM に送る文字列と同じ形になる
 * (本番のデータは、各レースの根拠・強調材料・懸念事項・買い目・着順が実データになる)。
 *
 * 使い方(cloud/ で): `pnpm run report:prompt`(3 レース)/ `pnpm run report:prompt -- --races 36`(36 レース。大きさの見積もり用)
 *
 * 送信の形: 本番の送信(`createSdkMessageSender`)は `system` を持たず、`messages` に user メッセージを 1 通だけ載せる。
 * 規則・出力形式・事実をすべてその 1 通にまとめている(下の「user メッセージ」がその全文)。他の送信パラメータは下の「送信パラメータ」。
 */
import { buildReportEmbed } from "./src/daily-report-embed";
import { REPORT_MAX_TOKENS } from "./src/daily-report-prompt";
import { DEFAULT_ANALYZER_CONFIG } from "@keiba/core/llm";
import { buildSavedRecord, fixtureRaceInputs, FIXTURE_DATE } from "./test/daily-report-fixtures";
import type { RaceInput } from "./src/daily-report-core";

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
