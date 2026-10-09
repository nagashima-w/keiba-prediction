/**
 * クラウド移行ファイルの行の生成器(Issue #215・#167-A)。
 *
 * ヘッダ → 分析の行(id 昇順)→ 結果の行(race_id 昇順)→ フッタ の順に、NDJSON の 1 行ぶんの文字列を yield する。
 * DB の読み出しは {@link CloudMigrationSource}(キーセット・ページング)に委ねる。**このファイルは better-sqlite3 にも
 * `node:` にも依存しない**(実 DB のソースは `cloud-migration-reader.ts`)。
 *
 * - 同期のジェネレータにしてある(読み出しは better-sqlite3 の同期 API。app の main は `Readable.from` で受けて
 *   gzip・ファイルへ流す)。ページを読むのは**次の行を要求されたときだけ**で、行を渡している間は DB の文も
 *   イテレータも保持しない(await をまたいで接続を占有しない)。
 * - **各行は書く前に {@link serializeMigrationLine} を通す**。形式に合わない値(Infinity・型の揺れなど)は、
 *   どの表・どの id/race_id・どの列かを含むエラーでこの時点で失敗する(取り込みの段になって初めて気づくのではなく)。
 * - 全体のスナップショットは取らない: 1 ページは同期で読むので整合しているが、ページ間には他の保存が入りうる。
 *   フッタの件数は「実際に書いた行数」(静止した DB では各表の COUNT(*) と一致する)。
 */

import {
  MigrationTally,
  buildAnalysisLine,
  buildHeaderLine,
  buildResultLine,
  serializeMigrationLine,
  type MigrationAnalysisLine,
  type MigrationFooterLine,
  type MigrationResultLine,
} from "./cloud-migration-format.js";

/** 分析 1 件ぶん(analyses の行と、その子の行)。 */
export type MigrationAnalysisPageItem = Omit<MigrationAnalysisLine, "type">;
/** 1 レースぶん(結果 4 表の行)。 */
export type MigrationResultPageItem = Omit<MigrationResultLine, "type">;

/** 書き出し元(ページ単位の読み出し)。実装は同期でよい。返す配列は昇順で、起点より後ろだけを含む。 */
export interface CloudMigrationSource {
  /** analyses.id > afterId のうち id 昇順で最大 limit 件(子の行つき)。 */
  readAnalysisPage(afterId: number, limit: number): readonly MigrationAnalysisPageItem[];
  /** 4 表のどれかに現れる race_id > afterRaceId のうち昇順で最大 limit レース。 */
  readResultPage(afterRaceId: string, limit: number): readonly MigrationResultPageItem[];
}

/** 分析のページサイズの既定。出馬表の写し・LLM の応答が大きいので小さめにする。 */
export const DEFAULT_ANALYSIS_PAGE_SIZE = 50;
/** 結果のページサイズの既定。 */
export const DEFAULT_RESULT_PAGE_SIZE = 200;

/** 生成器のオプション。 */
export interface GenerateMigrationLinesOptions {
  /** ヘッダの書き出し日時(ISO 8601 UTC)。 */
  readonly exportedAt: string;
  /** ヘッダのアプリの版。 */
  readonly appVersion: string;
  readonly analysisPageSize?: number;
  readonly resultPageSize?: number;
}

/**
 * 移行ファイルの行(末尾の改行なし)を順に yield し、終わったらフッタ行を返す。
 * 形式違反の値があれば {@link MigrationFormatError} を throw する(それ以前の行は yield 済み)。
 */
export function* generateMigrationLines(
  source: CloudMigrationSource,
  options: GenerateMigrationLinesOptions,
): Generator<string, MigrationFooterLine> {
  const analysisPageSize = options.analysisPageSize ?? DEFAULT_ANALYSIS_PAGE_SIZE;
  const resultPageSize = options.resultPageSize ?? DEFAULT_RESULT_PAGE_SIZE;
  const tally = new MigrationTally();

  const header = buildHeaderLine({ exportedAt: options.exportedAt, appVersion: options.appVersion });
  const headerText = serializeMigrationLine(header);
  tally.accept(header);
  yield headerText;

  let afterId = 0;
  for (;;) {
    const page = source.readAnalysisPage(afterId, analysisPageSize);
    if (page.length === 0) {
      break;
    }
    for (const item of page) {
      const line = buildAnalysisLine(item);
      const text = serializeMigrationLine(line);
      tally.accept(line); // 昇順でない(起点が進まない)ソースはここで失敗する
      afterId = item.analysis["id"] as number;
      yield text;
    }
  }

  let afterRaceId = "";
  for (;;) {
    const page = source.readResultPage(afterRaceId, resultPageSize);
    if (page.length === 0) {
      break;
    }
    for (const item of page) {
      const line = buildResultLine(item);
      const text = serializeMigrationLine(line);
      tally.accept(line);
      afterRaceId = item.raceId;
      yield text;
    }
  }

  const footer = tally.buildFooter();
  const footerText = serializeMigrationLine(footer);
  tally.accept(footer);
  yield footerText;
  return footer;
}
