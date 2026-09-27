/**
 * 18頭立て・中央確定レースの実オッズスナップショット取得スクリプト(Issue #136・#25-E0)。
 *
 * ## 目的
 * `scripts/bench-trifecta-allocation.ts`のAC1(16頭・実オッズ)に続く18頭ケースを測るため、
 * 三連単を含む7券種すべての確定オッズと出馬表・戦績・調教を実際にnetkeibaから取得し、
 * `docs/investigations/combo-odds-real-fetch/central-on.json`(#28)と同じ置き場所・同じ形
 * (`scrapeRace`の戻り値=`RaceData`をそのままJSON化したもの)で保存する。
 *
 * ## 対象レース(オーケストレーター着手前ゲート合意・2026-09-26 Q1)
 * race_id=202604020511(中央、2026-08-08開催 11R「3歳以上1勝クラス」・芝1000m・18頭)。
 * 頭数18は**新規リクエスト不要**で確認済み(`fixtures/race_list_sub_20260808.html`に
 * `<span class="RaceList_Itemnumber">18頭 </span>`が本race_idの直後に含まれる。2026-08-06実施の
 * #32調査で取得済みの既存フィクスチャ)。本race_idには`odds_wide_presale_202604020511_20260806.json`・
 * `odds_trio_presale_202604020511_20260806.json`という発売前(unavailable)の既存フィクスチャが
 * あるが、いずれも確定オッズではないため今回とは無関係(ファイル名の衝突もない)。
 *
 * ## 安全確認(Q1「最初の1本で確定オッズが返らなければレースを選び直す」)
 * 最初に単勝・複勝オッズ(type=1)だけを取得し、`status==="OK"`かつ`data`がオブジェクトで
 * あることを確認してから残りを取得する。確認できなければ非ゼロ終了し、レースの選び直しを促す。
 *
 * ## リクエスト設計(オーケストレーター着手前ゲート合意・Q2でA案〈戦績→scorer〉に変更)
 * `scrapeRace(raceId, {fetcher}, {includeComboOdds:true})`が内部で発行する
 * 「出馬表1+戦績18+調教1+オッズ(単勝・複勝)1+ワイド1+3連複1+馬連1+馬単1」の計25本に加え、
 * `scrapeRace`がまだ配線していない三連単(type=8。Issue #132のスコープ)を本スクリプトが
 * 別途1本取得し、計26本(#129の16頭ベンチのAC1と同じ7券種を揃える)。
 *
 * **重複リクエストを避ける設計**: 単勝・複勝/ワイド/3連複/馬連/馬単の5本は、本スクリプトが
 * 個別フィクスチャ保存のため先に生テキストで取得し(下記「個別フィクスチャ」参照)、
 * `scrapeRace`に渡す`CachedFetcher`のキャッシュへ**取得直後に事前投入**する
 * (`ScrapeCache.set(url, text)`。キーは各URL関数〈`oddsApiUrl`・`wideOddsApiUrl`等〉が返す
 * 文字列そのもので、`scrape-race.ts`の`fetchComboBetTypeOdds`/オッズ取得ステップが使う
 * キャッシュキーと完全一致する。`fetch-combo-odds.ts`の`comboOddsUrlFor`参照)。
 * これにより`scrapeRace`内部の対応ステップはキャッシュ命中となり、同一URLへの二重発火が
 * 起きない。`scrapeRace`が新規に発行するのは出馬表1・戦績18・調教1の計20本のみ。
 *
 * ## 個別フィクスチャ(オーケストレーター着手前ゲート合意・Q4)
 * 命名は`202603020211`の既存フィクスチャ(`odds_202603020211.json`・`odds_wide_202603020211.json`
 * 等)に倣う: `odds_202604020511.json`(単勝・複勝)・`odds_wide_202604020511.json`・
 * `odds_trio_202604020511.json`・`odds_quinella_202604020511.json`・
 * `odds_exacta_202604020511.json`・`odds_trifecta_202604020511.json`。
 * いずれも受け取った生テキストを**解析より先に**`writeFileSync`する
 * (`scripts/fetch-quinella-exacta-raw.ts`・`scripts/investigate-combo-odds-real-fetch.ts`と
 * 同じ規律。過去に「取得したが保存しなかった」失敗が繰り返されているため)。
 *
 * 戦績(18頭分)・出馬表・調教は個別フィクスチャ化せず(#28の`central-on.json`も同様に
 * 個別の戦績フィクスチャを作っていない)、`scrapeRace`の戻り値である統合スナップショット
 * `docs/investigations/combo-odds-real-fetch/central18-on.json`にまとめて保存する。
 *
 * ## 400のリトライ規律(オーケストレーター指示「1.5秒以上の間隔・400が2回続いたら中断」)
 * HttpClientの既定`minIntervalMs`(1500ms)をそのまま使う(間隔保証はHttpClient内部で
 * 直列に行われるため、本スクリプトから追加の待機を挟む必要はない。
 * `investigate-combo-odds-real-fetch.ts`と同じ流儀)。400のみ8秒待って1回だけ再試行し、
 * 再試行後もなお400なら「2回連続」として中断する(403/429は再試行せず即座に失敗する。
 * `HttpClient`はデフォルトで4xxを自動リトライしない設計のため、この400専用リトライは
 * 本スクリプトが明示的に行う)。
 *
 * ## 先読みリークについて(Q2で明記指示)
 * `deps.scrape`にそのまま渡す`horses[].results`は日付フィルタをかけていない生データであり、
 * 当該レース自身の着順がprior算出に混入する(#129のベンチ・`bench-mixed-allocation.ts`と
 * 同じ状態。是正は#39のスコープ)。本スクリプトはこれを意図的に遮断しない
 * (目的が候補数・所要時間の実測であり、prior自体の精度検証ではないため)。
 *
 * ## 実行方法
 *   pnpm tsx scripts/fetch-trifecta-18horse-snapshot.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CachedFetcher,
  HttpClient,
  HttpError,
  oddsApiUrl,
  parseRaceId,
  scrapeRace,
  ScrapeCache,
  type RaceData,
} from "../packages/core/src/index.js";
import {
  exactaOddsApiUrl,
  quinellaOddsApiUrl,
  trifectaOddsApiUrl,
  trioOddsApiUrl,
  wideOddsApiUrl,
} from "../packages/core/src/scraper/urls.js";

const RACE_ID = parseRaceId("202604020511");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");
const SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "docs",
  "investigations",
  "combo-odds-real-fetch",
  "central18-on.json",
);

/** 実リクエスト1本分の記録(docs転記用)。 */
interface FetchLogEntry {
  readonly label: string;
  readonly url: string;
  readonly savedTo: string;
  readonly bytes: number;
  readonly fetchedAt: string;
}

const fetchLog: FetchLogEntry[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1本のURLを取得し、受け取った生テキストを**解析より先に**保存する。
 * 400のみ8秒待って1回だけ再試行し、それでも400なら中断する(呼び出し元がcatchしてexitする)。
 */
async function fetchAndSave(
  client: HttpClient,
  label: string,
  url: string,
  savePath: string,
): Promise<string> {
  console.error(`[${label}] 取得開始: ${url}`);
  let text: string;
  try {
    text = await client.fetchText(url);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      console.error(`[${label}] 400を受信。8秒待って1回だけ再試行します。`);
      await sleep(8000);
      try {
        text = await client.fetchText(url);
      } catch (retryError) {
        if (retryError instanceof HttpError && retryError.status === 400) {
          throw new Error(`[${label}] 400が2回連続しました。中断します(URL: ${url})`);
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }
  writeFileSync(savePath, text, "utf-8");
  const bytes = Buffer.byteLength(text, "utf-8");
  const fetchedAt = new Date().toISOString();
  console.error(`[${label}] 保存しました: ${savePath}(${bytes}バイト)`);
  fetchLog.push({ label, url, savedTo: path.relative(REPO_ROOT, savePath), bytes, fetchedAt });
  return text;
}

/**
 * 単勝・複勝オッズ応答(type=1)が確定済みの実データか(未発売のNG応答でないか)を判定する。
 *
 * **実測訂正**: 当初`status==="OK"`を確認条件にしていたが、実際に確定済みレースへ
 * 発火したところ実データは`status:"result"`(`parse-odds.ts`の`KNOWN_STATUSES`と同じ値)で
 * 返ることを確認した(本race_idの実測: `official_datetime:"2026-08-08 17:57:14"`。レース日
 * 8/8と一致)。「OK」という値は未発売時の別envelope(`{"status":"NG","data":"",...}"`。
 * `docs/wide-trio-odds-investigation.md`§11.2)の対比から誤って類推したものであり、
 * 実データの確認は`data.odds`が存在するかで行う方が実体に即している。
 */
function looksLikeConfirmedOdds(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { status?: unknown; data?: { odds?: unknown } };
    return (
      typeof parsed.status === "string" &&
      parsed.status !== "NG" &&
      typeof parsed.data === "object" &&
      parsed.data !== null &&
      typeof parsed.data.odds === "object" &&
      parsed.data.odds !== null
    );
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const client = new HttpClient();

  // 1. 安全確認: 単勝・複勝(type=1)を最初の1本として取得する。
  // 既に本スクリプトの前回実行(1回目の検証ロジックの不備〈status==="OK"という誤った
  // 判定条件〉により中断したのみで実データ自体は取得済み)でフィクスチャが保存済みの場合は
  // 再実行せず読み直す(重複リクエストを避ける。#13以来の「保存直後に即座に使う」規律の応用)。
  const winPlaceUrl = oddsApiUrl(RACE_ID);
  const winPlacePath = path.join(FIXTURES_DIR, "odds_202604020511.json");
  const winPlaceRaw = existsSync(winPlacePath)
    ? (() => {
        console.error(`[単勝・複勝(type=1)] 既存フィクスチャを再利用します(再取得しない): ${winPlacePath}`);
        const text = readFileSync(winPlacePath, "utf-8");
        fetchLog.push({
          label: "単勝・複勝(type=1)【今回は再取得なし。前回実行で取得済みの実応答をそのまま再利用】",
          url: winPlaceUrl,
          savedTo: path.relative(REPO_ROOT, winPlacePath),
          bytes: Buffer.byteLength(text, "utf-8"),
          fetchedAt: "前回実行時に取得済み(本実行では未発火)",
        });
        return text;
      })()
    : await fetchAndSave(client, "単勝・複勝(type=1)", winPlaceUrl, winPlacePath);
  if (!looksLikeConfirmedOdds(winPlaceRaw)) {
    console.error(
      "確定オッズが返りませんでした(status!==\"OK\"またはdataが非オブジェクト)。" +
        "race_id=202604020511は本タスクでは使えません。レースを選び直してください。" +
        `応答冒頭: ${winPlaceRaw.slice(0, 300)}`,
    );
    process.exitCode = 1;
    return;
  }
  console.error("確定オッズを確認しました。残りの取得を続けます。");

  // 2. 組合せオッズ5券種(ワイド・3連複・馬連・馬単・三連単)。
  const wideUrl = wideOddsApiUrl(RACE_ID);
  const wideRaw = await fetchAndSave(
    client,
    "ワイド(type=5)",
    wideUrl,
    path.join(FIXTURES_DIR, "odds_wide_202604020511.json"),
  );
  const trioUrl = trioOddsApiUrl(RACE_ID);
  const trioRaw = await fetchAndSave(
    client,
    "3連複(type=7)",
    trioUrl,
    path.join(FIXTURES_DIR, "odds_trio_202604020511.json"),
  );
  const quinellaUrl = quinellaOddsApiUrl(RACE_ID);
  const quinellaRaw = await fetchAndSave(
    client,
    "馬連(type=4)",
    quinellaUrl,
    path.join(FIXTURES_DIR, "odds_quinella_202604020511.json"),
  );
  const exactaUrl = exactaOddsApiUrl(RACE_ID);
  const exactaRaw = await fetchAndSave(
    client,
    "馬単(type=6)",
    exactaUrl,
    path.join(FIXTURES_DIR, "odds_exacta_202604020511.json"),
  );
  const trifectaUrl = trifectaOddsApiUrl(RACE_ID);
  await fetchAndSave(
    client,
    "三連単(type=8)",
    trifectaUrl,
    path.join(FIXTURES_DIR, "odds_trifecta_202604020511.json"),
  );

  // 3. 出馬表・戦績(18頭)・調教は scrapeRace に任せる。上記5本(単勝複勝込み)は
  //    取得済みの生テキストをキャッシュへ事前投入し、scrapeRace内部からの再取得(重複リクエスト)
  //    を防ぐ(キーは各URL関数の戻り値そのもの。fetch-combo-odds.ts の comboOddsUrlFor と
  //    同じURL文字列であることをJSDoc冒頭で確認済み)。
  const cache = new ScrapeCache();
  cache.set(winPlaceUrl, winPlaceRaw);
  cache.set(wideUrl, wideRaw);
  cache.set(trioUrl, trioRaw);
  cache.set(quinellaUrl, quinellaRaw);
  cache.set(exactaUrl, exactaRaw);
  const fetcher = new CachedFetcher({ fetcher: client, cache });

  console.error("出馬表・戦績(18頭分)・調教の取得を開始します(scrapeRace)。");
  const race: RaceData = await scrapeRace(RACE_ID, { fetcher }, { includeComboOdds: true });
  console.error(
    `scrapeRace完了。horses=${race.horses.length}頭、警告=${race.meta.warnings.length}件。`,
  );
  for (const warning of race.meta.warnings) {
    console.error(`[警告:${warning.kind}] ${warning.message}`);
  }

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(race, null, 2), "utf-8");
  console.error(`スナップショットを保存しました: ${SNAPSHOT_PATH}`);

  console.error("=== 実リクエスト一覧(docs転記用) ===");
  console.error(JSON.stringify(fetchLog, null, 2));
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
