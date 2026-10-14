/**
 * 過去10年結果API(AplGradeWinner)の「基準日」を実測するスクリプト(Issue #153 / #39-C)。
 *
 * 目的: 過去のレースの race_id を投げたとき、応答が「そのレースの年を基準にした10年」なのか
 * 「今日を基準にした最新10年」なのかを確かめる。あわせて、先読みリーク(当該回自身・基準日以降の回)が
 * 実際に応答へ入った実物のフィクスチャを得る。結果の記録は
 * docs/grade-winner-lookahead-investigation.md。
 *
 * 取得はコアの HttpClient を使い、間隔は 8 秒(既定 1.5 秒より十分長い)。HTTP 400 が 2 回連続したら
 * 中断する。**取得したらその場でフィクスチャへ保存する**(後続の失敗で成果を失わないため)。
 * リクエストの組み立ては本番の fetchGradeWinnerEntries と同一(URL・ヘッダ・ボディ)。
 *
 * 実行方法:
 *   pnpm tsx scripts/fetch-grade-winner-lookahead.ts [race_id ...]
 * 引数なしのときは既定の2本(中央の2021年の回・地方の2023年の回)を取得する。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpClient,
  HttpError,
  parseGradeWinnerResponse,
  parseRaceId,
  venueKindOfRaceId,
} from "../packages/core/src/index.js";
import {
  gradeWinnerApiUrl,
  gradeWinnerOriginUrl,
  gradeWinnerRefererUrl,
} from "../packages/core/src/scraper/urls.js";

/** 既定の取得対象。R1=中央の過去重賞(福島 ラジオNIKKEI賞 2021)、R2=地方の1年以上前の重賞(大井 2023)。 */
const DEFAULT_RACE_IDS = ["202103010211", "202344062811"] as const;

/** 取得間隔(ミリ秒)。 */
const INTERVAL_MS = 8000;

/** HTTP 400 がこの回数連続したら中断する。 */
const MAX_CONSECUTIVE_400 = 2;

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

async function main(): Promise<void> {
  const raceIds = (process.argv.length > 2 ? process.argv.slice(2) : [...DEFAULT_RACE_IDS]).map(
    (id) => parseRaceId(id),
  );
  await mkdir(FIXTURES_DIR, { recursive: true });
  const client = new HttpClient({ minIntervalMs: INTERVAL_MS });
  let consecutive400 = 0;

  for (const raceId of raceIds) {
    const started = new Date().toISOString();
    try {
      const raw = await client.fetchText(gradeWinnerApiUrl(raceId), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Referer: gradeWinnerRefererUrl(raceId),
          Origin: gradeWinnerOriginUrl(raceId),
        },
        body: `input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=${raceId}`,
        encoding: "utf-8",
      });
      consecutive400 = 0;
      // 先に保存する(パースが失敗しても生の応答を失わない)。
      const prefix = venueKindOfRaceId(raceId) === "nar" ? "grade_winner_nar_" : "grade_winner_";
      const file = path.join(FIXTURES_DIR, `${prefix}${raceId}.json`);
      await writeFile(file, raw, "utf-8");
      const entries = parseGradeWinnerResponse(raw);
      console.log(`[${started}] ${raceId} -> ${path.relative(process.cwd(), file)}`);
      if (entries === null) {
        console.log("  status が OK でない(非重賞・対象データなし)");
      } else {
        for (const e of entries) {
          console.log(`  ${e.raceId} ${e.raceDate} ${e.jyo} ${e.track}${e.kyori}`);
        }
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        consecutive400++;
        console.error(`[${started}] ${raceId}: HTTP 400(連続 ${consecutive400} 回目)`);
        if (consecutive400 >= MAX_CONSECUTIVE_400) {
          console.error("HTTP 400 が連続したため中断します。");
          process.exitCode = 1;
          return;
        }
        continue;
      }
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
