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
 *        ON測定値と OFF測定値の差分は「組合せオッズ取得だけによる純増分」を表す
 *        (単勝・複勝オッズ等のキャッシュ影響を意図的に排除した条件)。
 *   3. 上記の設計により、出馬表・戦績・調教・単勝複勝オッズの実リクエストは
 *      レースあたり1回で済む(OFFとONそれぞれで二重に実リクエストしない。
 *      「回数は最小限に抑える」の遵守)。ON単独の完全新規(コールドキャッシュ)所要時間は
 *      本スクリプトでは測定しない(そのためには基礎データをもう1セット実リクエストする
 *      必要があり、最小化の方針に反するため)。
 *
 * HttpClientは**スクリプト全体で1個だけ**生成して使い回す。レート制限
 * (`DEFAULT_MIN_INTERVAL_MS=1500`)はHttpClientインスタンス内部の状態(`lastStart`)で
 * 直列に保証されるため、インスタンスを使い回す限り自前の待機は不要(複数インスタンスに
 * 分けると各インスタンスが前回発火時刻を知らず、間隔保証が崩れるため絶対にやらない)。
 *
 * ## 出力
 * `docs/investigations/combo-odds-real-fetch/` 配下に、レース×OFF/ONごとの生データ
 * (RaceData全体のJSON)と、まとめの summary.json(所要時間・診断値・raceSnapshotサイズ)を書く。
 *
 * ## 実行方法
 *   pnpm tsx scripts/investigate-combo-odds-real-fetch.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
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

/** 1回の scrapeRace 実測結果(生データを保存した直後の状態)。 */
interface ScrapeMeasurement {
  readonly race: RaceData;
  readonly elapsedMs: number;
}

/**
 * scrapeRace を実行し、**結果を受け取った直後に生データをファイルへ書き出してから**
 * 所要時間等の記録を返す(解析より保存が先。過去の「取得したのに保存しなかった」失敗の再発防止)。
 */
async function scrapeAndPersist(
  label: string,
  raceId: RaceId,
  fetcher: CachedFetcher,
  includeComboOdds: boolean,
  outPath: string,
): Promise<ScrapeMeasurement> {
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

/** 1レース分(OFF/ON)を実測し、生データを保存し、まとめの1レコードを返す。 */
async function investigateOneRace(
  target: TargetRace,
  fetcher: CachedFetcher,
): Promise<Record<string, unknown>> {
  const offPath = path.join(OUT_DIR, `${target.label}-off.json`);
  const onPath = path.join(OUT_DIR, `${target.label}-on.json`);

  // 1. OFF(コールドキャッシュ)を先に実測する(真の初回分析所要時間)。
  const off = await scrapeAndPersist(target.label, target.raceId, fetcher, false, offPath);
  // 2. ON(同じキャッシュを使い回す)を後で実測する(組合せオッズ純増分)。
  const on = await scrapeAndPersist(target.label, target.raceId, fetcher, true, onPath);

  // raceSnapshotのJSONサイズ比較(analysis-export.tsのbuildRaceSnapshotをそのまま使う。
  // 独自に再実装しない)。
  const snapshotOff: RaceSnapshot = buildRaceSnapshot(off.race);
  const snapshotOn: RaceSnapshot = buildRaceSnapshot(on.race);
  const snapshotOffJson = JSON.stringify(snapshotOff);
  const snapshotOnJson = JSON.stringify(snapshotOn);

  return {
    label: target.label,
    raceId: target.raceId,
    timingMs: {
      offCold: off.elapsedMs,
      onWarmReuse: on.elapsedMs,
      // ON測定値からOFF測定値を引いた差分(実測値。「組合せオッズ取得だけの純増分」を表す。
      // OFF・ONそれぞれの絶対値も実測値であり、この差分だけが導出値)。
      comboOddsMarginalMs: on.elapsedMs - off.elapsedMs,
    },
    raceSnapshotByteSize: {
      offBytes: Buffer.byteLength(snapshotOffJson, "utf-8"),
      onBytes: Buffer.byteLength(snapshotOnJson, "utf-8"),
      increaseBytes:
        Buffer.byteLength(snapshotOnJson, "utf-8") - Buffer.byteLength(snapshotOffJson, "utf-8"),
    },
    comboOdds: {
      wide: summarizeDiagnostics(on.race.meta.comboOdds?.wide),
      trio: summarizeDiagnostics(on.race.meta.comboOdds?.trio),
    },
    // 一次データそのもの(券種別の正EV候補数・EV分布は後からこの値だけで再現できる。
    // ここでは指標を一切算出しない)。
    wideComboOdds: on.race.odds.wideCombo ?? null,
    trioComboOdds: on.race.odds.trioCombo ?? null,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // HttpClientはスクリプト全体で1個だけ(レート制限の直列保証はインスタンス内部状態に依存する)。
  const client = new HttpClient();

  const summary: Record<string, unknown>[] = [];
  for (const target of TARGETS) {
    // レースごとに新規(:memory:)キャッシュ(OFF/ON比較のキャッシュ条件を明確にするため、
    // 他レースの取得結果を一切引き継がない)。fetcherはHttpClientを共有するが、
    // キャッシュ層は独立させる。
    const cache = new ScrapeCache();
    const fetcher = new CachedFetcher({ fetcher: client, cache });
    try {
      const record = await investigateOneRace(target, fetcher);
      summary.push(record);
    } finally {
      cache.close();
    }
  }

  const summaryPath = path.join(OUT_DIR, "summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          "指標(Σx*等)は未算出。一次データ(実オッズ・診断値)のみ。" +
          "timingMs.offCold/onWarmReuseは実測値、comboOddsMarginalMsはその差分(実測値の減算)。" +
          "所要時間の見積り(最大16リクエスト・約24秒等)はここでは使っていない(導出値であり実測値ではない)。",
        results: summary,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.error(`まとめを保存しました: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
