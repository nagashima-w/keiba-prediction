/**
 * 組合せオッズ(ワイド・三連複)実取得の動作確認スクリプト(機能D-2c第3段 boss ブリーフ・Issue #28)。
 *
 * 目的: U-B(妙味度に応じた推奨券種)の確定材料となる一次データを、実際の netkeiba から
 * 取得して残す。**指標(Σx* 等)はここでは算出しない**(boss裁定「一次データを残すことに徹する」。
 * 集計は後で別途行う)。`buildMixedCandidates` は呼ばない(第2段AC2「未使用の構造的保証」を
 * 崩さない。呼ぶと combo-odds-scope-guard.test.ts が落ちる)。
 *
 * `scripts/fetch-nar-trio-axis-fixture.ts` / `scripts/dump-race.ts` と同じ流儀:
 * - 単発の調査専用であり、CI からは呼ばない
 * - **取得した応答は受け取った直後に書き出し、解析はその後**という順序を構造的に持たせる
 *   (過去に「取得したのに保存しなかった」失敗が3回起きているため。AC10相当)
 *
 * ## 対象(boss指定・厳守)
 * - 中央1レース: race_id=202603020211(16頭・`docs/wide-trio-odds-investigation.md`の
 *   #1〜#5・#22・#23で実測済みの既存対象を流用。同ドキュメント102行に「16頭のレースで
 *   C(16,2)=120件・C(16,3)=560件が1レスポンスに全件含まれることを確認済み」と記録あり。
 *   一次データの量〈U-B: 妙味度に応じた推奨券種の確定材料〉を確保するため頭数の多いレースを
 *   選ぶ。組合せオッズ2リクエスト〈中央は頭数によらずワイド1+3連複1〉)
 * - 地方1レース: race_id=202654071210(高知10R ファイナルレース・12頭・同ドキュメントで
 *   軸1/軸2とも実測済みの既存対象を流用。ワイド1+3連複軸走査〈n-2=10軸〉=11リクエスト)
 * - 地方は1レースで打ち止め(合計でも組合せオッズ分は2+11=13リクエストで20未満に収まる)
 *
 * ## OFF/ON比較の設計(キャッシュ影響の排除条件を明記する)
 * レースごとに新規(:memory:)の ScrapeCache を用意し、
 *   1. OFF(includeComboOdds:false)を**先に**コールドキャッシュで実行・計測する
 *      → 出馬表・戦績・調教・単勝複勝オッズを含む「実際の初回分析」の所要時間(真の基準値)
 *   2. ON(includeComboOdds:true)を**同じキャッシュを使い回して**実行・計測する
 *      → 1.で取得済みの出馬表等はキャッシュ命中(実リクエスト無し)になるため、
 *        ON測定値はほぼ「組合せオッズ取得だけ」の所要時間を表す。
 *   3. 上記の設計により、出馬表・戦績・調教・単勝複勝オッズの実リクエストは
 *      レースあたり1回で済む(OFFとONそれぞれで二重に実リクエストしない。
 *      「回数は最小限に抑える」の遵守)。ON単独の完全新規(コールドキャッシュ)所要時間は
 *      本スクリプトでは測定しない(そのためには基礎データをもう1セット実リクエストする
 *      必要があり、最小化の方針に反するため)。
 *
 * **重要(code-reviewer指摘2回目対応): OFFとONの実測値の「差分」に意味を持たせない。**
 * OFF(コールド)は基礎データのみ(組合せオッズ0件)、ON(温キャッシュ再利用)は
 * 基礎データがキャッシュ命中のためほぼ組合せオッズ取得のみ、という**測定対象がほぼ重ならない
 * 2つの値**であるため、両者の引き算(ON−OFF)は「組合せオッズ取得の追加コスト」を
 * 意味しない(むしろ負値になり、額面どおり読むと「組合せオッズを取得すると27秒速くなる」
 * という誤読を招く)。過去に本リポジトリで繰り返された欠陥クラス「判定していないことを
 * 判定結果として名付ける」と同型のため、そのような差分フィールドは**持たない**。
 * 組合せオッズ取得コストを知りたい場合は、ON実測値(timingMs.onWarmReuseMs)を
 * そのまま読む(詳細は summary.json の note と各レコードの derivedComboOddsFetchCostMs を参照)。
 *
 * HttpClientは**スクリプト全体で1個だけ**生成して使い回す。レート制限
 * (`DEFAULT_MIN_INTERVAL_MS=1500`)はHttpClientインスタンス内部の状態(`lastStart`)で
 * 直列に保証されるため、インスタンスを使い回す限り自前の待機は不要(複数インスタンスに
 * 分けると各インスタンスが前回発火時刻を知らず、間隔保証が崩れるため絶対にやらない)。
 *
 * ## 出力
 * `docs/investigations/combo-odds-real-fetch/` 配下に、レース×OFF/ONごとの生データ
 * (RaceData全体のJSON)・実測所要時間の記録(timing.json)・まとめの summary.json
 * (所要時間・診断値・raceSnapshotサイズ)を書く。
 *
 * ## 実行方法
 *   pnpm tsx scripts/investigate-combo-odds-real-fetch.ts
 *
 * ## サマリのみ再生成(ネットワークアクセスなし)
 * 保存済みの `*-off.json` / `*-on.json` / `timing.json` から summary.json だけを
 * 再生成する(実リクエストは一切発行しない。同じ計測をやり直す必要がないときに使う)。
 *   pnpm tsx scripts/investigate-combo-odds-real-fetch.ts --from-saved
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CachedFetcher,
  HttpClient,
  parseRaceId,
  scrapeRace,
  ScrapeCache,
  type ComboOddsFetchOutcome,
  type RaceData,
  type RaceId,
} from "../packages/core/src/index.js";
import { buildRaceSnapshot, type RaceSnapshot } from "../packages/app/src/main/analysis-export.js";

/** 出力先ディレクトリ(リポジトリルート直下)。 */
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "investigations",
  "combo-odds-real-fetch",
);

/** 対象レース1件分の設定。 */
interface TargetRace {
  readonly label: string;
  readonly raceId: RaceId;
}

const TARGETS: readonly TargetRace[] = [
  { label: "central", raceId: parseRaceId("202603020211") },
  { label: "nar", raceId: parseRaceId("202654071210") },
];

/** 1レース分のOFF/ON実測所要時間(timing.jsonの形。ネットワークなし再生成に使う)。 */
interface RaceTiming {
  readonly offColdMs: number;
  readonly onWarmReuseMs: number;
}

/** timing.json 全体の形(レースlabel→実測所要時間)。 */
type TimingRecord = Record<string, RaceTiming>;

/**
 * scrapeRace を実行し、**結果を受け取った直後に生データをファイルへ書き出してから**
 * 所要時間を返す(解析より保存が先。過去の「取得したのに保存しなかった」失敗の再発防止)。
 */
async function scrapeAndPersist(
  label: string,
  raceId: RaceId,
  fetcher: CachedFetcher,
  includeComboOdds: boolean,
  outPath: string,
): Promise<{ readonly race: RaceData; readonly elapsedMs: number }> {
  const state = includeComboOdds ? "ON" : "OFF";
  console.error(`[${label}/${state}] scrapeRace開始: race_id=${raceId}`);
  const startedAt = Date.now();
  const race = await scrapeRace(raceId, { fetcher }, { includeComboOdds });
  const elapsedMs = Date.now() - startedAt;

  // 解析(diagnostics集計・JSONサイズ比較等)より先に、生データをそのまま書き出す。
  writeFileSync(outPath, JSON.stringify(race, null, 2), "utf-8");
  console.error(
    `[${label}/${state}] scrapeRace完了: ${elapsedMs}ms、保存: ${outPath}`,
  );
  for (const warning of race.meta.warnings) {
    console.error(`[${label}/${state}][警告:${warning.kind}] ${warning.message}`);
  }
  return { race, elapsedMs };
}

/** 1券種分の診断値を、報告しやすい平坦な形へ写す(算出・加工はしない。写すだけ)。 */
function summarizeDiagnostics(outcome: ComboOddsFetchOutcome | undefined): unknown {
  if (outcome === undefined) {
    return null;
  }
  const attempts = outcome.diagnostics.attempts;
  const attemptCounts = {
    available: attempts.filter((a) => a.state === "available").length,
    unavailable: attempts.filter((a) => a.state === "unavailable").length,
    fetchFailed: attempts.filter((a) => a.state === "fetchFailed").length,
    parseError: attempts.filter((a) => a.state === "parseError").length,
  };
  return {
    state: outcome.state,
    requestCount: outcome.diagnostics.requestCount,
    expectedComboCount: outcome.diagnostics.expectedComboCount,
    obtainedComboCount: outcome.diagnostics.obtainedComboCount,
    missingComboCount: outcome.diagnostics.missingComboCount,
    axisUmabans: outcome.diagnostics.axisUmabans,
    attemptCounts,
    attempts,
  };
}

/**
 * 1レース分(OFF/ONのRaceDataと実測所要時間)から、まとめの1レコードを組み立てる**純関数**。
 * IO・ネットワークを一切行わない(ライブ取得経路・保存済みファイルからの再生成経路の両方から
 * 呼べるようにするため)。
 */
function buildRaceRecord(
  target: TargetRace,
  offRace: RaceData,
  onRace: RaceData,
  timing: RaceTiming,
): Record<string, unknown> {
  // raceSnapshotのJSONサイズ比較(analysis-export.tsのbuildRaceSnapshotをそのまま使う。
  // 独自に再実装しない)。
  const snapshotOff: RaceSnapshot = buildRaceSnapshot(offRace);
  const snapshotOn: RaceSnapshot = buildRaceSnapshot(onRace);
  const snapshotOffJson = JSON.stringify(snapshotOff);
  const snapshotOnJson = JSON.stringify(snapshotOn);

  return {
    label: target.label,
    raceId: target.raceId,
    timingMs: {
      // 実測値: 基礎データのみ(組合せオッズ0件)取得の所要時間。
      offColdMs: timing.offColdMs,
      // 実測値: 基礎データがキャッシュ命中のため、ほぼ組合せオッズ取得のみの所要時間。
      onWarmReuseMs: timing.onWarmReuseMs,
      // 導出値(解釈): 組合せオッズ取得コストの推定値。OFF/ONは測定対象がほぼ重ならないため
      // 差分(ON−OFF)には意味が無く、ON実測値をそのまま「組合せオッズ取得コスト」とみなす。
      derivedComboOddsFetchCostMs: timing.onWarmReuseMs,
    },
    raceSnapshotByteSize: {
      offBytes: Buffer.byteLength(snapshotOffJson, "utf-8"),
      onBytes: Buffer.byteLength(snapshotOnJson, "utf-8"),
      increaseBytes:
        Buffer.byteLength(snapshotOnJson, "utf-8") - Buffer.byteLength(snapshotOffJson, "utf-8"),
    },
    comboOdds: {
      wide: summarizeDiagnostics(onRace.meta.comboOdds?.wide),
      trio: summarizeDiagnostics(onRace.meta.comboOdds?.trio),
    },
    // 一次データそのもの(券種別の正EV候補数・EV分布は後からこの値だけで再現できる。
    // ここでは指標を一切算出しない)。
    wideComboOdds: onRace.odds.wideCombo ?? null,
    trioComboOdds: onRace.odds.trioCombo ?? null,
  };
}

/** summary.json の共通の note(実体に合わせた説明。導出値と実測値を明確に区別する)。 */
const SUMMARY_NOTE =
  "指標(Σx*等)は未算出。一次データ(実オッズ・診断値)のみ。" +
  "timingMs.offColdMs/onWarmReuseMsは実測値。" +
  "OFF(コールドキャッシュ)は出馬表・戦績・調教・単勝複勝オッズ等の基礎データのみを取得した" +
  "所要時間で、組合せオッズは0件。ON(OFFのキャッシュを再利用)は基礎データがすべて" +
  "キャッシュ命中(実リクエスト無し)になるため、実測値はほぼ組合せオッズ取得のみの所要時間を表す。" +
  "したがってOFFとONは測定対象がほぼ重ならず、両者の差分(ON−OFF)には" +
  "『組合せオッズの追加コスト』という意味が無い(このため差分フィールドは持たない)。" +
  "組合せオッズの取得コスト(derivedComboOddsFetchCostMs。導出値・解釈)は、" +
  "ON実測値(timingMs.onWarmReuseMs)にほぼ等しいとみなせる。" +
  "所要時間の見積り(最大16リクエスト・約24秒等)はここでは使っていない(導出値であり実測値ではない)。";

/** summary.json を書き出す(共通処理)。 */
function writeSummary(results: readonly Record<string, unknown>[]): void {
  const summaryPath = path.join(OUT_DIR, "summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), note: SUMMARY_NOTE, results },
      null,
      2,
    ),
    "utf-8",
  );
  console.error(`まとめを保存しました: ${summaryPath}`);
}

/** ライブ取得経路: 実際に scrapeRace を叩き、生データ・timing.json・summary.json を書く。 */
async function runLiveFetch(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // HttpClientはスクリプト全体で1個だけ(レート制限の直列保証はインスタンス内部状態に依存する)。
  const client = new HttpClient();

  const results: Record<string, unknown>[] = [];
  const timing: TimingRecord = {};
  for (const target of TARGETS) {
    // レースごとに新規(:memory:)キャッシュ(OFF/ON比較のキャッシュ条件を明確にするため、
    // 他レースの取得結果を一切引き継がない)。fetcherはHttpClientを共有するが、
    // キャッシュ層は独立させる。
    const cache = new ScrapeCache();
    const fetcher = new CachedFetcher({ fetcher: client, cache });
    try {
      const offPath = path.join(OUT_DIR, `${target.label}-off.json`);
      const onPath = path.join(OUT_DIR, `${target.label}-on.json`);

      // 1. OFF(コールドキャッシュ)を先に実測する(真の初回分析所要時間)。
      const off = await scrapeAndPersist(target.label, target.raceId, fetcher, false, offPath);
      // 2. ON(同じキャッシュを使い回す)を後で実測する。
      const on = await scrapeAndPersist(target.label, target.raceId, fetcher, true, onPath);

      const raceTiming: RaceTiming = { offColdMs: off.elapsedMs, onWarmReuseMs: on.elapsedMs };
      timing[target.label] = raceTiming;
      results.push(buildRaceRecord(target, off.race, on.race, raceTiming));
    } finally {
      cache.close();
    }
  }

  // 実測所要時間は生データ(RaceData)に含まれないため、再生成(--from-saved)用に別途保存する。
  const timingPath = path.join(OUT_DIR, "timing.json");
  writeFileSync(timingPath, JSON.stringify(timing, null, 2), "utf-8");
  console.error(`実測所要時間を保存しました: ${timingPath}`);

  writeSummary(results);
}

/**
 * 再生成経路: 保存済みの `*-off.json` / `*-on.json` / `timing.json` を読み、
 * summary.json だけを作り直す。**ネットワークアクセスは一切行わない**
 * (新規の scrapeRace 呼び出し・HttpClient/ScrapeCacheの生成すら行わない)。
 */
function runRegenerateFromSaved(): void {
  const timingPath = path.join(OUT_DIR, "timing.json");
  if (!existsSync(timingPath)) {
    throw new Error(
      `timing.json が見つかりません(${timingPath})。--from-saved はライブ取得(引数無し実行)で` +
        "生成したtiming.jsonが無いと実測所要時間を復元できないため使えません。",
    );
  }
  const timing = JSON.parse(readFileSync(timingPath, "utf-8")) as TimingRecord;

  const results: Record<string, unknown>[] = [];
  for (const target of TARGETS) {
    const offPath = path.join(OUT_DIR, `${target.label}-off.json`);
    const onPath = path.join(OUT_DIR, `${target.label}-on.json`);
    const raceTiming = timing[target.label];
    if (raceTiming === undefined) {
      throw new Error(`timing.jsonに${target.label}の記録がありません`);
    }
    console.error(`[${target.label}] 保存済みファイルから読み込み: ${offPath} / ${onPath}`);
    const offRace = JSON.parse(readFileSync(offPath, "utf-8")) as RaceData;
    const onRace = JSON.parse(readFileSync(onPath, "utf-8")) as RaceData;
    results.push(buildRaceRecord(target, offRace, onRace, raceTiming));
  }

  writeSummary(results);
}

async function main(): Promise<void> {
  if (process.argv.includes("--from-saved")) {
    runRegenerateFromSaved();
    return;
  }
  await runLiveFetch();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
