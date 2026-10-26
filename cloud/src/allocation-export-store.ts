/**
 * 配分の再計算用の書き出し(Issue #463)の D1・R2 の読み書き。**呼び出し元に依存しない**(コンストラクタは `{ db, bucket, now, fixedLengthStream? }`。書き出しの DO〈`AllocationExportDO`〉が使う)。
 * 統計モデル用の書き出しのストア(`prior-export-store.ts`)と同じ作りで、読むものと仕上げの put の方式が違う。
 *
 * ## 読み
 *  - 候補(`readCandidates`): 統計モデル用の書き出しと同じ 1 文(`CANDIDATES_SQL`。結果のあるレースの分析の、選別に必要な列だけ)。
 *  - 馬・結果・配分のメタ・買い目・組合せ払戻・取込印(`readRaceData`): 1 回の batch(6 文)。いずれも `IN (SELECT value FROM json_each(?))` で主キーの索引を引くので、
 *    読む行数は束縛した ID の行だけ。D1 が返す `meta.rows_read` を合計して返す。自由文・大きな列(`reason`・`contributions_json`・`race_snapshot_json` など)は読まない。
 *  - 詳細(`fetchDetails`): R2 の `get` だけ(LIST・HEAD は使わない)。同時実行は {@link GET_CONCURRENCY}。取得を試みた回数を返す(Class B に数える)。
 *    オッズ・枠番・組合せは**同じ get で読んだ詳細の `raceSnapshot`** から取り出す(`toAllocationSnapshot`)。`detail_key` が NULL の行は取得しない(none)。
 *    R2 に無い・壊れている・別のレースのものも none(失敗ではない)。get の例外だけ failed(再試行する)。
 *
 * ## 書き
 *  - `r2_ops` の Class B の加算(`countReads`)と、Class A の加算 + R2 への流し込み(`putFileStream`)。put の前に Class A を数える(`analysis-repository.ts` の流儀:
 *    先に数えて、put の失敗は過少でなく過大に倒す)。
 *  - `putFileStream` は、塊を 1 つずつ `FixedLengthStream` に書いて R2 の `put` に渡す(固定キーを原子的に上書き)。全体を 1 つのバッファに連結しない。
 *    流している途中の例外・宣言した総バイト数との食い違いは put の失敗になり、固定キーの古いファイルは変わらない。
 */

import { decodeDetail } from "./analysis-detail";
import { monthKey, type R2Usage } from "./r2-fence";
import { toAllocationSnapshot } from "./allocation-export-format";
import type { AllocationDetailOutcome, AllocationExportStorePort, AllocationRaceDataBatch } from "./allocation-export-core";
import { CANDIDATES_SQL, COUNT_READS_SQL, COUNT_WRITE_SQL, GET_CONCURRENCY, SELECT_R2_USAGE_SQL, type PriorExportDb } from "./prior-export-store";
import type { CandidateRow } from "./prior-export-format";
import type { DetailRequest } from "./prior-export-core";

export type AllocationExportDb = PriorExportDb;
/** R2 のうち使う部分: 詳細の読み出し(get)と、完成したファイルの書き込み(put)だけ。 */
export type AllocationExportBucket = Pick<R2Bucket, "get" | "put">;

/** 定長のストリーム(workerd の組み込み `FixedLengthStream` と同じ形。R2 の put にストリームを渡すには長さが要る)。 */
export type FixedLengthStreamFactory = (length: number) => { readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array> };

const HORSES_SQL = `SELECT analysis_id AS analysisId, umaban, prior, adjusted_prob AS adjustedProb, place_odds_min AS placeOddsMin, ev
  FROM analysis_horses WHERE analysis_id IN (SELECT value FROM json_each(?)) ORDER BY analysis_id, umaban`;
const RESULTS_SQL = `SELECT race_id AS raceId, umaban, finish_position AS finishPosition, place_payout AS placePayout, win_payout AS winPayout, scratched, wakuban, win_odds AS winOdds, ninki
  FROM race_results WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id, umaban`;
const META_SQL = `SELECT analysis_id AS analysisId, route, unavailable_reason AS unavailableReason, fallback_reason AS fallbackReason, skip_reason_code AS skipReasonCode,
       combo_odds_wide AS comboOddsWide, combo_odds_trio AS comboOddsTrio, bankroll, per_race_cap AS perRaceCap, kelly_fraction AS kellyFraction, ev_threshold AS evThreshold,
       include_combo_odds AS includeComboOdds, include_wide AS includeWide, include_trio AS includeTrio, include_quinella AS includeQuinella, include_exacta AS includeExacta,
       include_trifecta AS includeTrifecta, include_bracket_quinella AS includeBracketQuinella, bet_unit AS betUnit, greedy_steps AS greedySteps, candidate_cap AS candidateCap,
       model_id AS modelId, model_approximate AS modelApproximate, odds_status AS oddsStatus, min_hit_prob AS minHitProb, below_floor_count AS belowFloorCount, missed_json AS missedJson
  FROM analysis_allocation_meta WHERE analysis_id IN (SELECT value FROM json_each(?)) ORDER BY analysis_id`;
const BETS_SQL = `SELECT analysis_id AS analysisId, bet_type AS betType, combo_key AS comboKey, stake, odds, ev
  FROM analysis_bets WHERE analysis_id IN (SELECT value FROM json_each(?)) ORDER BY analysis_id, bet_type, combo_key`;
const PAYOUTS_SQL = `SELECT race_id AS raceId, bet_type AS betType, combo_key AS comboKey, payout
  FROM race_combo_payouts WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id, bet_type, combo_key`;
const IMPORTS_SQL = `SELECT race_id AS raceId, bet_type AS betType FROM race_combo_payout_imports WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id, bet_type`;

export interface D1AllocationExportStoreOptions {
  readonly db: AllocationExportDb;
  readonly bucket: AllocationExportBucket;
  /** 時計(R2 の月の区切りに使う)。既定は現在時刻。テストで注入する。 */
  readonly now?: () => Date;
  /** 定長のストリームの作り方。既定は workerd の `FixedLengthStream`。Node のテストは、長さを検査する偽物を注入する。 */
  readonly fixedLengthStream?: FixedLengthStreamFactory;
}

export class D1AllocationExportStore implements AllocationExportStorePort {
  private readonly db: AllocationExportDb;
  private readonly bucket: AllocationExportBucket;
  private readonly now: () => Date;
  private readonly fixedLengthStream: FixedLengthStreamFactory;

  constructor(options: D1AllocationExportStoreOptions) {
    this.db = options.db;
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
    this.fixedLengthStream = options.fixedLengthStream ?? ((length) => new FixedLengthStream(length));
  }

  async readUsage(): Promise<R2Usage> {
    const row = await this.db.prepare(SELECT_R2_USAGE_SQL).bind(monthKey(this.now())).first<R2Usage>();
    return row ?? { classA: 0, classB: 0 };
  }

  async readCandidates(): Promise<{ readonly rows: CandidateRow[]; readonly rowsRead: number }> {
    const res = await this.db.prepare(CANDIDATES_SQL).all<CandidateRow>();
    return { rows: res.results, rowsRead: res.meta.rows_read ?? 0 };
  }

  async readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<AllocationRaceDataBatch> {
    const ids = JSON.stringify(analysisIds);
    const races = JSON.stringify(raceIds);
    const results = await this.db.batch<Record<string, never>>([
      this.db.prepare(HORSES_SQL).bind(ids),
      this.db.prepare(RESULTS_SQL).bind(races),
      this.db.prepare(META_SQL).bind(ids),
      this.db.prepare(BETS_SQL).bind(ids),
      this.db.prepare(PAYOUTS_SQL).bind(races),
      this.db.prepare(IMPORTS_SQL).bind(races),
    ]);
    const rowsRead = results.reduce((n, r) => n + (r?.meta.rows_read ?? 0), 0);
    const rowsOf = <T>(i: number): T => (results[i]?.results ?? []) as unknown as T;
    return {
      horses: rowsOf<AllocationRaceDataBatch["horses"]>(0),
      results: rowsOf<AllocationRaceDataBatch["results"]>(1),
      metas: rowsOf<AllocationRaceDataBatch["metas"]>(2),
      bets: rowsOf<AllocationRaceDataBatch["bets"]>(3),
      payouts: rowsOf<AllocationRaceDataBatch["payouts"]>(4),
      imports: rowsOf<AllocationRaceDataBatch["imports"]>(5),
      rowsRead,
    };
  }

  async fetchDetails(items: readonly DetailRequest[]): Promise<{ readonly outcomes: AllocationDetailOutcome[]; readonly gets: number }> {
    const outcomes: AllocationDetailOutcome[] = new Array<AllocationDetailOutcome>(items.length);
    let gets = 0;
    const one = async (index: number): Promise<void> => {
      const item = items[index]!;
      if (item.detailKey === null) {
        outcomes[index] = { kind: "none" };
        return;
      }
      gets += 1;
      let bytes: Uint8Array | null;
      try {
        const object = await this.bucket.get(item.detailKey);
        bytes = object === null ? null : new Uint8Array(await object.arrayBuffer());
      } catch {
        outcomes[index] = { kind: "failed" };
        return;
      }
      const payload = bytes === null ? null : decodeDetail(bytes);
      outcomes[index] = payload === null || payload.raceId !== item.raceId ? { kind: "none" } : { kind: "ok", snapshot: toAllocationSnapshot(payload.raceSnapshot) };
    };
    for (let start = 0; start < items.length; start += GET_CONCURRENCY) {
      await Promise.all(Array.from({ length: Math.min(GET_CONCURRENCY, items.length - start) }, (_, k) => one(start + k)));
    }
    return { outcomes, gets };
  }

  async countReads(gets: number): Promise<void> {
    if (gets <= 0) {
      return;
    }
    await this.db.prepare(COUNT_READS_SQL).bind(monthKey(this.now()), gets, gets).run();
  }

  async putFileStream(
    key: string,
    parts: () => Iterable<Uint8Array>,
    totalBytes: number,
    info: { readonly generatedAt: string; readonly rows: number; readonly races: number },
  ): Promise<void> {
    await this.db.prepare(COUNT_WRITE_SQL).bind(monthKey(this.now())).run();
    const { readable, writable } = this.fixedLengthStream(totalBytes);
    // put の結果。この Promise 自身は reject しない(失敗は putError に記録する)ので、流し込みの途中で put が先に失敗しても未処理の reject にならない。
    let putFailed = false;
    let putError: unknown;
    const putCall = this.bucket.put(key, readable, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { generatedAt: info.generatedAt, rows: String(info.rows), races: String(info.races) },
    });
    const putDone = putCall.then(
      () => undefined,
      (error: unknown) => {
        putFailed = true;
        putError = error;
      },
    );
    // put が先に失敗したら、読み手のいないストリームへの書き込みで待ち続けないよう、書き込みの待ちを打ち切る。
    const putAborted = putDone.then(() => (putFailed ? Promise.reject(putError) : new Promise<never>(() => undefined)));
    putAborted.catch(() => undefined);
    const writer = writable.getWriter();
    try {
      for (const part of parts()) {
        await Promise.race([writer.write(part), putAborted]);
      }
      await Promise.race([writer.close(), putAborted]);
    } catch (error) {
      // abort の完了は待たない(読み手のいないストリームでは、進行中の書き込みが詰まったまま abort が終わらないことがある)。abort は読み手に伝わり、put は失敗で終わる。
      void writer.abort(error).catch(() => undefined);
      await putDone;
      throw error;
    }
    await putDone;
    if (putFailed) {
      throw putError;
    }
  }
}
