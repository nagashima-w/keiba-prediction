/**
 * #258 第1段の前後比較に使うデータセット(`docs/investigations/prior-normalization-258/dataset.json`)を作る。
 *
 * 入力:
 * - `--raw-dir <dir>`: 33 レースの `RaceData`(取消除外前の出馬表・各馬の全戦績・オッズ。
 *   `<dir>/<raceId>.json` または `<dir>/race-data/<raceId>.json`)。リポジトリの外にある。
 *   取得は `scripts/probability-quality-41/fetch.ts --raw-dir <dir>`(#41 の再実行)か、
 *   各 raceId への `scrapeRace(raceId, { fetcher }, { includeComboOdds: false })` の保存(2026-10-11 に
 *   #258 の調査でこの方法で取り直した。約 500 リクエスト・1.5 秒間隔)。
 * - `docs/investigations/probability-quality-41/observations/*.json`(#41 の観測。結果・どの馬を使うか)。
 * - `docs/investigations/probability-quality-41-llm/llm-observations/*.json`(subagent 近似の LLM 補正)。
 *
 * 出力: 馬ごとの数値だけ(**馬名・騎手名などの名前は一切含めない**)。
 *
 * ## rawPrior の出所と限界
 * - `runAnalysis` と同じ手順(先読み遮断 → `buildPriorInput` → `computeFieldPriors`)で、その時点の scorer から
 *   `rawPrior` を取る。**#258 の変更は正規化だけで `rawPrior` は変わらない**(`computeFieldPriors` が返す
 *   `rawPrior` は正規化の前の値)。
 * - 騎手の成績(#226)は入っていない(raw の戦績に騎手の成績が無いため。騎手項は `undefined` = 補正なし)。
 *   中立値を平均騎手に置いた設計なので影響は小さいはずだが、未検証。
 * - 人気順・複勝オッズは、`RaceData.odds`(取得日時点の確定オッズ)から取る。
 *
 * 使い方: pnpm tsx scripts/prior-normalization-258/build-dataset.ts --raw-dir <dir> [--out <path>]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPriorInput,
  classifyTrackWetness,
  computeFieldPriors,
  venueKindOfRaceId,
  type RaceData,
  type RaceId,
} from "../../packages/core/src/index.js";
import {
  excludeOwnRaceResults,
  filterRaceDataBefore,
} from "../../packages/core/src/scorer/snapshot-filter.js";
import { venueNameFromRaceId } from "../../packages/app/src/main/venue-codes.js";
import type { RaceObservation } from "../probability-quality-41/observation.js";
import type {
  DatasetHorse,
  DatasetRace,
  PriorNormalizationDataset,
} from "./compare.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBS_DIR = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41", "observations");
const LLM_DIR = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41-llm", "llm-observations");
const DEFAULT_OUT = path.join(REPO_ROOT, "docs", "investigations", "prior-normalization-258", "dataset.json");

/** 比較に使う最小頭数(#41 の市場比較と同じ)。 */
const MIN_RUNNERS = 8;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readRaceData(rawDir: string, raceId: string): RaceData {
  const candidates = [path.join(rawDir, "race-data", `${raceId}.json`), path.join(rawDir, `${raceId}.json`)];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error(`RaceData が見つかりません: ${candidates.join(" または ")}`);
  }
  return JSON.parse(readFileSync(found, "utf-8")) as RaceData;
}

interface LlmObservation {
  readonly fallback: boolean;
  readonly horses: ReadonlyArray<{ readonly umaban: number; readonly prior: number; readonly adjustedProb: number }>;
}

/** 1 レース分のデータを作る。使えない(頭数不足など)なら null。 */
export function buildRace(obs: RaceObservation, raceData: RaceData, llm: LlmObservation | null): DatasetRace | null {
  if (obs.status !== "ok") return null;
  const raceId = obs.raceId as RaceId; // 観測の raceId は 12 桁の ID 文字列
  const kaisai = obs.kaisaiDate;
  const analysisDate = `${kaisai.slice(0, 4)}/${kaisai.slice(4, 6)}/${kaisai.slice(6, 8)}`;

  // 観測の馬のうち、確定単勝オッズ・結果・複勝オッズ下限が揃う馬だけを使う(#258 の調査と同じ条件)。
  const winOf = (umaban: number) => raceData.odds.win[umaban];
  const used = obs.horses.filter((h) => {
    const w = winOf(h.umaban);
    return w !== undefined && w.odds !== null && h.finish !== undefined && h.placeOddsMin !== null;
  });
  if (used.length < MIN_RUNNERS) return null;
  const keep = new Set(used.map((h) => h.umaban));

  // runAnalysis と同じ手順で rawPrior を再計算する。
  const filtered = filterRaceDataBefore(excludeOwnRaceResults(raceData, raceId).raceData, analysisDate).raceData;
  const venueName = venueNameFromRaceId(raceId);
  const venueKind = venueKindOfRaceId(raceId);
  const isWet = classifyTrackWetness(filtered.race.trackCondition ?? null, filtered.race.courseType)?.isWet ?? false;
  const horses = filtered.horses.filter((h) => keep.has(h.shutuba.umaban));
  const fieldSize = horses.length;
  const priors = computeFieldPriors(
    horses.map((h) =>
      buildPriorInput({
        horse: h.shutuba,
        raceResults: h.results ?? [],
        race: {
          courseType: filtered.race.courseType,
          distance: filtered.race.distance,
          venueName,
          isWet,
          date: analysisDate,
          venueKind,
        },
        fieldSize,
      }),
    ),
  );

  // 人気順: 確定単勝オッズの昇順(同オッズは馬番順)。
  const order = used
    .map((h) => ({ umaban: h.umaban, odds: winOf(h.umaban)!.odds as number }))
    .sort((a, b) => a.odds - b.odds || a.umaban - b.umaban);
  const popularity = new Map(order.map((o, i) => [o.umaban, i + 1]));
  const obsByUmaban = new Map(used.map((h) => [h.umaban, h]));
  const llmByUmaban = llm === null || llm.fallback ? null : new Map(llm.horses.map((h) => [h.umaban, h]));

  const rows: DatasetHorse[] = horses.map((h, i) => {
    const umaban = h.shutuba.umaban;
    const o = obsByUmaban.get(umaban)!;
    const place = raceData.odds.place[umaban];
    const l = llmByUmaban?.get(umaban);
    return {
      umaban,
      rawPrior: priors[i]!.rawPrior,
      neutralProb: priors[i]!.neutralProb,
      placed: o.outcome,
      won: o.finish.kind === "順位" && o.finish.value === 1 ? 1 : 0,
      popularity: popularity.get(umaban)!,
      winOdds: winOf(umaban)!.odds as number,
      placeOddsMin: o.placeOddsMin as number,
      placeOddsMax: (place?.oddsMax ?? o.placeOddsMin) as number,
      llmDelta: l === undefined ? null : l.adjustedProb - l.prior,
    };
  });
  return {
    raceId,
    region: obs.region,
    kaisaiDate: kaisai,
    fieldSize,
    horses: rows,
  };
}

function main(): void {
  const rawDir = argValue("--raw-dir");
  if (rawDir === undefined) {
    throw new Error("--raw-dir <RaceData の保存先(リポジトリの外)> が必要です");
  }
  const out = argValue("--out") ?? DEFAULT_OUT;

  const races: DatasetRace[] = [];
  for (const f of readdirSync(OBS_DIR).filter((n) => /^[0-9]{12}\.json$/.test(n)).sort()) {
    const obs = JSON.parse(readFileSync(path.join(OBS_DIR, f), "utf-8")) as RaceObservation;
    if (obs.status !== "ok" || obs.horses.length < MIN_RUNNERS) continue; // 頭数不足は戦績を取っていない
    const llmPath = path.join(LLM_DIR, f);
    const llm = existsSync(llmPath) ? (JSON.parse(readFileSync(llmPath, "utf-8")) as LlmObservation) : null;
    const race = buildRace(obs, readRaceData(rawDir, obs.raceId), llm);
    if (race !== null) races.push(race);
  }

  const dataset: PriorNormalizationDataset = {
    schemaVersion: 1,
    description:
      "Issue #258 第1段の前後比較用。馬ごとの rawPrior(正規化前の prior。騎手の成績〈#226〉は入っていない)・結果・単勝人気・" +
      "複勝オッズ・subagent 近似の LLM 補正量(llmDelta = 補正後確率 − 当時の prior)。名前は含まない。" +
      "作り方は scripts/prior-normalization-258/build-dataset.ts。",
    races,
  };
  // 差分を読みやすくするため、レースごとに 1 行で書く。
  const text =
    `{\n"schemaVersion": 1,\n"description": ${JSON.stringify(dataset.description)},\n"races": [\n` +
    dataset.races.map((r) => JSON.stringify(r)).join(",\n") +
    "\n]\n}\n";
  writeFileSync(out, text, "utf-8");
  console.error(`書き出しました: ${out}(${races.length} レース・${races.reduce((s, r) => s + r.horses.length, 0)} 頭)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
