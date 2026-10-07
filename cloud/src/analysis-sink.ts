/**
 * 発走前の分析の保存先(`AnalysisSink`。Issue #178〈#164-c〉): `D1AnalysisStore`(D1 の要約 + R2 の詳細)を、DO(`RaceDayCore`)が使う形にする薄い層。
 *  - `save`: 買い目の大きさの上限を確かめてから保存する(理由の固定文言 `extra.llmNote`・LLM 呼び出しの記録 `extra.llmCalls` も、一緒に保存する。Issue #194・#197)。#175 は買い目を1つの JSON 文字列にまとめて1回の bind で渡す(D1 の文字列の上限は
 *    2,000,000 バイト〈公式の制限表。要約ツールで読んだ値で、一次確認は未了〉)。通常の最大は、中央16頭・全券種 ON で 265 件(約 23KB)で上限の 1/60 以下。
 *    上限は {@link MAX_BETS_JSON_BYTES}(1.5MB)。超えたら D1 に何も書かずに拒否する(保存の失敗として再試行され、上限で failed になる)。
 *  - `findByAnalyzedAt`: 同じレース・同じ分析時刻の分析の id(重複の確認。DO の計算ステップの再実行で、2件目を保存しないため)。D1 の読み出しは一覧の2文。
 *  - `findRecentByRace`: 同じレースの、分析時刻が `[fromIso, toIso]` の分析(id・分析時刻・prompt_version・model だけ)。発走前の自動実行が、手動の分析との重複を確かめる(Issue #204)。D1 の読み出しは1文。
 *  - `countChildren`: 保存した分析の子の行(馬・買い目)の件数(最初の実保存で、子の行が正しい親 id に紐づいたかを確かめる)。
 */
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { LIST_MAX_LIMIT, type D1AnalysisStore } from "./analysis-repository";
import type { AnalysisSaveExtra, AnalysisSink } from "./race-day-core";

/** 買い目の JSON の大きさの上限(バイト)。D1 の文字列の上限(2,000,000 バイト)の手前。 */
export const MAX_BETS_JSON_BYTES = 1_500_000;

export function createAnalysisSink(store: D1AnalysisStore): AnalysisSink {
  return {
    async save(record: AnalysisRecord, extra?: AnalysisSaveExtra) {
      const bets = record.allocation?.bets;
      if (bets !== undefined) {
        const bytes = new TextEncoder().encode(JSON.stringify(bets)).byteLength;
        if (bytes > MAX_BETS_JSON_BYTES) {
          throw new Error(`買い目が大きすぎます(${bets.length} 件・${bytes} バイト。上限 ${MAX_BETS_JSON_BYTES} バイト)`);
        }
      }
      // 理由(固定文言。Issue #194)は analyses.llm_note に、LLM 呼び出しの記録(Issue #197 段2)は analyses.llm_calls_json に入る。無ければ null。
      return store.saveAnalysis(record, { llmNote: extra?.llmNote ?? null, llmCalls: extra?.llmCalls ?? null });
    },
    async findByAnalyzedAt(raceId: string, analyzedAt: string) {
      const summaries = await store.listAnalysisSummaries({ raceId, limit: LIST_MAX_LIMIT });
      return summaries.find((s) => s.analyzedAt === analyzedAt)?.id ?? null;
    },
    findRecentByRace(raceId: string, fromIso: string, toIso: string) {
      return store.listRecentForRace(raceId, fromIso, toIso);
    },
    countChildren(analysisId: number) {
      return store.countChildren(analysisId);
    },
  };
}
