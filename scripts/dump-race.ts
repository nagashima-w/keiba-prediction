/**
 * JSONダンプCLIの起動シェル。
 *
 * 引数解釈は純関数 parseCliArgs に、データ取得はファサード scrapeRace / listRaces に委譲する。
 * 本ファイルは実IO(HttpClient + SQLiteキャッシュの組み立て・ファイル書き込み・console出力)
 * の薄いシェルに徹する。
 *
 * 使い方:
 *   pnpm tsx scripts/dump-race.ts --race 202603020211 [--out out.json] [--fresh-odds] [--db cache.sqlite]
 *   pnpm tsx scripts/dump-race.ts --date 20260628 [--out list.json] [--db cache.sqlite]
 *
 * - --race <race_id> : 1レースの完全データ(出馬表+戦績+調教+オッズ)をダンプ
 * - --date <YYYYMMDD>: 開催日のレース一覧をダンプ
 * - --out <path>     : 出力先ファイル(未指定なら標準出力)
 * - --fresh-odds     : オッズをキャッシュ迂回で再取得(発走直前用、--race のみ)
 * - --db <path>      : キャッシュDBファイル(既定 cache.sqlite)
 *
 * netkeibaのスクレイピングは規約上グレーであり、本ツールは個人利用専用(README参照)。
 */

import { writeFile } from "node:fs/promises";
import {
  CachedFetcher,
  HttpClient,
  ScrapeCache,
  listRaces,
  parseCliArgs,
  scrapeRace,
} from "../packages/core/src/index.js";

async function main(): Promise<void> {
  const cmd = parseCliArgs(process.argv.slice(2));

  // HttpClient はデフォルト(最低1.5秒間隔・UA明示)でレート制限を守る。
  // 取得結果は SQLite キャッシュに載せ、同一レースの再取得を避ける。
  const client = new HttpClient();
  const cache = new ScrapeCache({ filename: cmd.db });
  const fetcher = new CachedFetcher({ fetcher: client, cache });

  try {
    let output: unknown;

    if (cmd.kind === "race") {
      const data = await scrapeRace(
        cmd.raceId,
        { fetcher },
        { bypassOddsCache: cmd.freshOdds },
      );
      // 非致命的な警告は標準エラーに出す(本体のJSONは汚さない)。
      for (const warning of data.meta.warnings) {
        console.error(`[警告:${warning.kind}] ${warning.message}`);
      }
      output = data;
    } else {
      output = await listRaces(cmd.date, { fetcher });
    }

    const json = JSON.stringify(output, null, 2);
    if (cmd.out !== null) {
      await writeFile(cmd.out, json, "utf-8");
      console.error(`保存しました: ${cmd.out}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  } finally {
    cache.close();
  }
}

main().catch((error: unknown) => {
  console.error("ダンプ中にエラーが発生しました:", error);
  process.exitCode = 1;
});
