/**
 * #652: #649 の道具に足す新しい材料を、過去のレコードから作る(1 頭 1 行の NDJSON を gzip)。
 *
 *  - 騎手・調教師の市場比の指標(#642 の式。`cloud/src/market-edge-calc.ts` の `buildMarketRow`・`fitMarketBase` を再利用)。
 *    **先読みを避ける作り**:
 *      * 基準の係数(切片 + logit(q) + log(頭数) の回帰)は、月ごとに「その月の初日より前の直近 2 年」の行だけで当てはめる。
 *      * 各騎乗の読み残し(y − p)は、その騎乗の月の係数で一度だけ決める(あとから係数が変わっても書き換えない)。
 *      * レース日 D の指標 = D より前(D は含まない)かつ D の 2 年前(含む)以降の読み残しの合計 ÷ (件数 + 30)。
 *    手元の記録は 2024-08 からで、最初の月(2024-08)は当てはめる行が無いため係数を [0, 1, 0](市場の確率そのまま)にする。特徴量を使う期間は 2025-02 からなので、
 *    この近似は評価の期間に直接は入らない(指標の窓には入る)。
 *  - 斤量のレース内の相対値(平均との差・最軽量との差・順位)。走った馬だけで数える。
 *  - 重量の種別(weightType)・騎手の減量の印(jockeyMark)・性・齢・斤量そのもの。
 *
 * 使い方: pnpm tsx scripts/stat-model-649/extras.ts <入力.ndjson.gz> <出力.ndjson.gz>
 */

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { MARKET_WINDOW_YEARS, buildMarketRow } from "../../cloud/src/market-edge-calc.js";
import type { RaceRecord, RecordHorse } from "../../packages/core/src/scraper/race-record.js";
import { buildEdgeIndex, edgeAt } from "./edge-features.js";
import { burdenRelative } from "./lib.js";

const ran = (h: RecordHorse): boolean => h.finishStatus !== "取消" && h.finishStatus !== "除外";

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (inPath === undefined || outPath === undefined) throw new Error("使い方: extras.ts <入力.ndjson.gz> <出力.ndjson.gz>");
  const records: RaceRecord[] = [];
  for await (const line of createInterface({ input: createReadStream(inPath).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (line.trim() !== "") records.push(JSON.parse(line) as RaceRecord);
  }
  records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.raceId < b.raceId ? -1 : 1));

  const index = buildEdgeIndex(records);
  const marketRowCount = records.filter((r) => buildMarketRow(r) !== null).length;

  const gz = createGzip();
  gz.pipe(createWriteStream(outPath));
  let rows = 0;
  for (const rec of records) {
    const horses = rec.horses.filter(ran);
    if (horses.length < 2) continue;
    const rel = burdenRelative(horses.map((h) => h.burden ?? 55));
    horses.forEach((h, i) => {
      const j = edgeAt(index.jockeys, h.jockeyId, rec.date);
      const t = edgeAt(index.trainers, h.trainerId, rec.date);
      gz.write(
        `${JSON.stringify({
          raceId: rec.raceId,
          umaban: h.umaban,
          jEdge: j.edge,
          jN: j.n,
          tEdge: t.edge,
          tN: t.n,
          burden: h.burden,
          bdMean: rel[i]!.diffMean,
          bdMin: rel[i]!.diffMin,
          bdRank: rel[i]!.rank,
          weightType: rec.weightType ?? null,
          mark: h.jockeyMark ?? null,
          sex: h.sex ?? null,
          age: h.age ?? null,
        })}\n`,
      );
      rows += 1;
    });
  }
  await new Promise<void>((resolve) => gz.end(resolve));
  process.stderr.write(`市場の行 ${marketRowCount}・月 ${index.coefByMonth.size}・窓 ${MARKET_WINDOW_YEARS} 年・出力 ${rows} 行\n`);
}

void main();
