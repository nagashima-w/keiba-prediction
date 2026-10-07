/**
 * クラウド版(D1)の容量の見積もりの測定スクリプト(Issue #171・#169-a。#147 の「見積もりに再現手段がない」への対応)。
 *
 * 何を測るか:
 *  (1) 1回の分析で保存する大きな列の大きさ(リポジトリのフィクスチャから。中央16頭の 202603020211):
 *      組合せオッズ入りの race_snapshot_json・馬ごとの contributions_json・LLM の raw_response、
 *      R2 に置く詳細オブジェクト(上の3つ)の平文と gzip 後の大きさ
 *  (2) 実際の SQLite(better-sqlite3。D1 と同じ SQLite)に N 件保存したときの、1分析あたりの大きさ(`dbstat` の内訳つき)
 *      - A: 大きな列は NULL(R2 へ出す。D1 に残るのは要約・馬・配分・買い目)
 *      - 全部 D1: 大きな列も D1 の列に入れる(exe と同じ保存)
 *      表は cloud/migrations と同じ構造(exe の最終スキーマ + detail_key + 索引2つ。#197 の highlights_json・concerns_json は exe の最終スキーマに入っている。llm_note・r2_ops・cloud_settings は含めない)
 *  (2') 強調材料・懸念事項(#197)は合成(馬ごとに各 --item-count 項目 × 全角 --item-chars 字。既定 3 × 30 = 上限どおり。実データではない)。--item-count 0 で、#197 より前の保存の大きさを再現する
 *  (3) 500MB(D1 の Free の DB 1個あたりの上限)が埋まる年数(年間件数ごと)
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/measure-d1-size.ts [--n-a 1000] [--n-full 300]
 *
 * 再現性: 乱数は固定の種(mulberry32)で、同じ N なら同じ値になる(浮動小数のバイト数は値によらず8バイトで、
 * 文字列は実データ〔LLM の実応答 36 本の reason〕なので、乱数が効くのは値の並びだけ)。入力はすべてリポジトリ内のファイルで、
 * ネットワークへは出ない。結果の値と N は docs/current-spec.md(「クラウド版の D1 の容量の見積もり」)に記録している。
 *
 * 限界: 1回の実行・合成した配分(買い目 10 件/分析は仮定)・フィクスチャは1レース(16頭)で、
 * 18頭立てや地方(三連単なし)では大きさが変わる。ページサイズ 4096 の SQLite のファイルサイズであり、D1 が数える容量と
 * 完全に一致するとは限らない。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { AnalysisStore } from "../packages/core/src/ev/analysis-store.js";
import type { AnalysisRecord } from "../packages/core/src/ev/analysis-store-types.js";
import { toComboOddsScalarMap } from "../packages/core/src/scraper/combo-odds-key.js";
import { parseComboOdds, type ComboBetType } from "../packages/core/src/scraper/parse-combo-odds.js";
import { parseHorseResults } from "../packages/core/src/scraper/parse-horse-results.js";
import { parseShutuba } from "../packages/core/src/scraper/parse-shutuba.js";
import { buildPriorInput, computePrior } from "../packages/core/src/scorer/prior.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures");
const RESPONSES_DIR = path.join(ROOT, "docs", "investigations", "probability-quality-41-llm", "responses");
const D1_EXTRA_MIGRATION = path.join(ROOT, "cloud", "migrations", "0002_d1.sql");

/** D1 の Free の DB 1個あたりの上限(公式の制限表: Maximum database size 500 MB)。 */
export const D1_FREE_DB_BYTES = 500e6;

/** 1分析のバイト数と年間件数から、上限が埋まるまでの年数。 */
export function yearsUntilFull(bytesPerAnalysis: number, limitBytes: number, analysesPerYear: number): number {
  return limitBytes / bytesPerAnalysis / analysesPerYear;
}

/** 固定の種の乱数(mulberry32。0 以上 1 未満)。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

/**
 * 強調材料・懸念事項(Issue #197)の合成。**実データではなく**、`count` 個・各 `chars` 文字(全角)の文字列を返す
 * (「3項目・全角30字」の上限どおりに満たした、上限寄りの見積もり。実際の LLM の出力は、これより短い項目・少ない項目になりうる。
 * 公開後の実データで測り直す)。乱数は使わず、種類(`h`=強調・`c`=懸念)・馬番・項目の位置から決める(同じ入力なら同じ文字列)。
 * `count` が 0 なら空配列(#197 より前の保存の大きさを再現する基準値)。
 */
export function syntheticItems(count: number, chars: number, kind: "h" | "c", umaban: number): string[] {
  const alphabet = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ"; // 全角(UTF-8 で 1 文字 3 バイト)
  return Array.from({ length: count }, (_, i) => {
    const seed = (kind === "h" ? 0 : 11) + umaban * 5 + i * 3;
    return Array.from({ length: chars }, (_, j) => alphabet[(seed + j) % alphabet.length]!).join("");
  });
}

/** 強調材料・懸念事項の合成の指定(`count` が 0 なら付けない)。 */
interface ItemSpec {
  readonly count: number;
  readonly chars: number;
}
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");

const COMBO_FIXTURES: ReadonlyArray<readonly [ComboBetType, string]> = [
  ["wide", "odds_wide_202603020211.json"],
  ["trio", "odds_trio_202603020211.json"],
  ["quinella", "odds_quinella_202603020211.json"],
  ["exacta", "odds_exacta_202603020211.json"],
  ["trifecta", "odds_trifecta_202603020211.json"],
  ["bracketQuinella", "odds_wakuren_202603020211.json"],
];
const HORSE_RESULT_FIXTURES = [
  "horse_results_2021104387.json",
  "horse_results_2021105727.json",
  "horse_results_2021105857.json",
  "horse_results_2023103386.json",
  "horse_results_2024104976.json",
];

/** 実 LLM 応答(サブエージェントの応答 36 本)。raw_response の大きさと、reason の文字列に使う。 */
function loadResponses(): string[] {
  return readdirSync(RESPONSES_DIR)
    .sort()
    .map((f) => readFileSync(path.join(RESPONSES_DIR, f), "utf-8"));
}
const reasonsOf = (text: string): string[] => [...text.matchAll(/"reason":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);

/** 大きな列の材料(フィクスチャ 202603020211。中央16頭)。`measureColumns`(大きさの表示)と `buildDetailText`(CPU 測定の入力。Issue #174)が共有する。 */
interface DetailColumns {
  readonly comboSizes: ReadonlyArray<{ readonly betType: string; readonly keys: number; readonly bytes: number }>;
  readonly horseCount: number;
  readonly withoutCombos: string;
  readonly snapshot: string;
  readonly contributions: ReadonlyArray<{ readonly umaban: number; readonly contributions: unknown }>;
  readonly perHorseBytes: readonly number[];
}

function buildDetailColumns(): DetailColumns {
  const combos: Record<string, Record<string, number | null>> = {};
  const comboSizes: Array<{ betType: string; keys: number; bytes: number }> = [];
  for (const [betType, file] of COMBO_FIXTURES) {
    const parsed = parseComboOdds(fixture(file), betType);
    if (parsed.state !== "available") {
      throw new Error(`${file} が available でない`);
    }
    combos[betType] = Object.fromEntries(toComboOddsScalarMap(parsed.odds));
    comboSizes.push({ betType, keys: parsed.odds.size, bytes: bytes(JSON.stringify(combos[betType])) });
  }
  const shutuba = parseShutuba(fixture("shutuba_202603020211.html"));
  const horses = shutuba.horses.map((h) => ({
    umaban: h.umaban, wakuban: h.wakuban, name: h.name, sex: h.sex, age: h.age, kinryo: h.kinryo,
    jockeyName: h.jockeyName, trainerName: h.trainerName, bodyWeight: h.bodyWeight?.weight ?? null,
    winOdds: 12.3, popularity: 5, placeOddsMin: 2.1, oikiriCritic: "動き良好", oikiriRank: "B",
  }));
  const base = { race: { raceName: shutuba.race?.raceName ?? "x", courseType: "芝", distance: 2000, weather: "晴", trackCondition: "良", startTime: "15:45", fence: null, oddsStatus: "result", officialDatetime: "2026-06-28 15:52:30" }, horses };
  const withoutCombos = JSON.stringify(base);
  const snapshot = JSON.stringify({
    ...base, wideCombo: combos["wide"], trioCombo: combos["trio"], quinellaCombo: combos["quinella"],
    exactaCombo: combos["exacta"], trifectaCombo: combos["trifecta"], bracketQuinellaCombo: combos["bracketQuinella"],
  });

  const priorOf = (file: string, umaban: number): unknown =>
    computePrior(
      buildPriorInput({
        horse: { wakuban: 3, umaban, name: "x", horseId: "1" as never, sex: "牡", age: 4, kinryo: 56, jockeyName: "j", jockeyId: null, stableLocation: "栗東", trainerName: "t", trainerId: null, bodyWeight: { weight: 480, diff: 2 } },
        raceResults: parseHorseResults(fixture(file)),
        race: { courseType: "芝", distance: 2000, venueName: "東京", isWet: false, date: "2026/06/28", venueKind: "central" },
        fieldSize: horses.length,
      }),
    ).contributions;
  const contributions = Array.from({ length: horses.length }, (_, i) => ({
    umaban: i + 1,
    contributions: priorOf(HORSE_RESULT_FIXTURES[i % HORSE_RESULT_FIXTURES.length]!, i + 1),
  }));
  const perHorseBytes = HORSE_RESULT_FIXTURES.map((file) => bytes(JSON.stringify(priorOf(file, 5))));
  return { comboSizes, horseCount: horses.length, withoutCombos, snapshot, contributions, perHorseBytes };
}

/** R2 に置く詳細オブジェクト(snapshot 全部入り + raw + contributions 16頭)の JSON 文字列。`responses` は実 LLM 応答。 */
function detailTextOf(columns: DetailColumns, responses: readonly string[]): string {
  return JSON.stringify({ raceSnapshot: JSON.parse(columns.snapshot), rawResponse: responses[2] ?? responses[0], contributions: columns.contributions });
}

/**
 * R2 に置く詳細オブジェクトの JSON 文字列(Issue #174。Worker の CPU 測定〈scripts/measure-worker-cpu.ts〉の入力)。
 * `pnpm tsx scripts/measure-d1-size.ts` の「R2 に置く詳細オブジェクト」の行と同じ入力(フィクスチャ・実 LLM 応答 36 本の3番目)から作る。
 */
export function buildDetailText(): string {
  return detailTextOf(buildDetailColumns(), loadResponses());
}

function measureColumns(responses: readonly string[]): void {
  console.log("## (1) 大きな列の大きさ(フィクスチャ 202603020211 〔中央16頭〕)");
  const columns = buildDetailColumns();
  for (const c of columns.comboSizes) {
    console.log(`  ${c.betType}: ${c.keys} キー, ${c.bytes} バイト`);
  }
  console.log(`  頭数 ${columns.horseCount}; race_snapshot_json(組合せなし) ${bytes(columns.withoutCombos)} バイト`);
  console.log(`  race_snapshot_json(組合せ全部入り) ${bytes(columns.snapshot)} バイト, gzip ${gzipSync(columns.snapshot).length} バイト`);
  const perHorse = columns.perHorseBytes;
  console.log(`  contributions_json(1頭): ${Math.min(...perHorse)}〜${Math.max(...perHorse)} バイト(戦績の異なる ${perHorse.length} 頭), 平均 ${(perHorse.reduce((a, b) => a + b, 0) / perHorse.length).toFixed(0)} バイト; ${columns.horseCount}頭分 ${bytes(JSON.stringify(columns.contributions))} バイト`);

  const rawSizes = responses.map(bytes);
  console.log(`  raw_response: 平均 ${(rawSizes.reduce((a, b) => a + b, 0) / rawSizes.length).toFixed(0)} バイト(最小 ${Math.min(...rawSizes)}・最大 ${Math.max(...rawSizes)}), n=${rawSizes.length}`);
  const reasonBytes = responses.map((r) => reasonsOf(r).reduce((a, x) => a + bytes(x), 0));
  console.log(`  reason(1分析の合計): 平均 ${(reasonBytes.reduce((a, b) => a + b, 0) / reasonBytes.length).toFixed(0)} バイト, n=${reasonBytes.length}`);

  const detail = detailTextOf(columns, responses);
  console.log(`  R2 に置く詳細オブジェクト(snapshot 全部入り + raw + contributions ${columns.horseCount}頭): 平文 ${bytes(detail)} バイト, gzip ${gzipSync(detail).length} バイト`);
}

function makeRecord(i: number, full: boolean, nHorses: number, responses: readonly string[], rand: () => number, items: ItemSpec): AnalysisRecord {
  const c = i % responses.length;
  const reasons = reasonsOf(responses[c]!);
  const marks = ["◎", "〇", "▲", null] as const;
  const horses = Array.from({ length: nHorses }, (_, k) => ({
    umaban: k + 1, prior: rand(), adjustedProb: rand(), placeOddsMin: 1 + rand() * 20, ev: rand() * 2,
    isPositive: rand() < 0.3, mark: marks[k % 4] ?? null,
    contributions: full ? Array.from({ length: 13 }, (_, j) => ({ biasName: `バイアス項目${j}`, applied: true, reason: `近走の着順から算出(サンプル${j})`, weight: rand(), correction: rand() * 0.02, sampleCount: j, targetRate: rand(), overallRate: rand() })) : null,
    reason: reasons[k % reasons.length] ?? null,
    highlights: syntheticItems(items.count, items.chars, "h", k + 1),
    concerns: syntheticItems(items.count, items.chars, "c", k + 1),
  }));
  return {
    raceId: String(202600000000 + i), analyzedAt: new Date(1.78e12 + i * 600000).toISOString(), kaisaiDate: "20260628",
    promptVersion: "v-test", model: "claude-sonnet-5", evEstimated: false, historyCutoffDate: "20260628", promptLookaheadGuarded: true,
    rawResponse: full ? responses[c]! : null,
    ...(full ? { raceSnapshot: { race: { raceName: "x" }, pad: "x".repeat(73080) } } : {}),
    horses,
    allocation: {
      meta: { route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: null, comboOddsTrio: null, bankroll: 10000, perRaceCap: 2000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true, includeTrifecta: true, includeBracketQuinella: true, betUnit: 100, greedySteps: 50, candidateCap: 200, modelId: "m", modelApproximate: false, oddsStatus: "result" },
      bets: Array.from({ length: 10 }, (_, b) => ({ betType: ["place", "wide", "trio", "quinella", "exacta", "trifecta"][b % 6]!, comboKey: String(100000 + b * 111 + (i % 7)).slice(0, 6), stake: 100, odds: 5.5, ev: 1.2 })),
    },
  };
}

function measureDb(label: string, full: boolean, n: number, responses: readonly string[], dir: string, items: ItemSpec): number {
  const rand = seededRandom(20261006);
  const store = new AnalysisStore({ filename: path.join(dir, `${label}.db`) });
  const db = store.rawDatabase;
  db.exec(readFileSync(D1_EXTRA_MIGRATION, "utf-8")); // D1 専用の追加分(detail_key・索引2つ)。表は exe の最終スキーマと同じ
  for (let i = 0; i < n; i += 1) {
    store.saveAnalysis(makeRecord(i, full, 16, responses, rand, items));
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  const pages = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const free = db.pragma("freelist_count", { simple: true }) as number;
  const per = ((pages - free) * pageSize) / n;
  console.log(`  ${label}: N=${n}, page_size=${pageSize}, 合計 ${(((pages - free) * pageSize) / 1e6).toFixed(1)}MB, 1分析あたり ${per.toFixed(0)} バイト`);
  const tables = db.prepare("SELECT name, sum(pgsize) AS b FROM dbstat GROUP BY name ORDER BY b DESC LIMIT 8").all() as Array<{ name: string; b: number }>;
  console.log(`    内訳(バイト/分析・上位): ${tables.map((t) => `${t.name}=${(t.b / n).toFixed(0)}`).join(" ")}`);
  store.close();
  return per;
}

function argNumber(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

function main(): void {
  const nA = argNumber("--n-a", 1000);
  const nFull = argNumber("--n-full", 300);
  // 強調材料・懸念事項(#197)の合成の指定。既定は上限(3項目・全角30字)。--item-count 0 で、#197 より前の保存の大きさ(基準値)を再現する。
  const items: ItemSpec = { count: argNumber("--item-count", 3), chars: argNumber("--item-chars", 30) };
  const responses = loadResponses();
  measureColumns(responses);
  console.log("\n## (2) 1分析あたりの D1(SQLite)の大きさ(16頭・買い目 10 件・索引込み・固定の種)");
  const dir = mkdtempSync(path.join(tmpdir(), "keiba-d1-size-"));
  try {
    console.log(`  強調材料・懸念事項: 馬ごとに各 ${items.count} 項目 × 全角 ${items.chars} 字(合成。実データではなく、上限寄りの見積もり)`);
    const perA = measureDb("A(大きな列は NULL)", false, nA, responses, dir, items);
    const perFull = measureDb("全部 D1(大きな列も入れる)", true, nFull, responses, dir, items);
    console.log("\n## (3) 500MB が埋まる年数(年間件数ごと)");
    for (const [name, per] of [["A", perA], ["全部 D1", perFull]] as const) {
      console.log(`  ${name}(${per.toFixed(0)} バイト/分析): ${[3500, 10000, 20000].map((y) => `${y}件/年 → ${yearsUntilFull(per, D1_FREE_DB_BYTES, y).toFixed(1)}年`).join(", ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
