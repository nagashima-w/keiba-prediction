/**
 * 移行ファイルの全体の検証(Issue #216・#167-B1)。**D1・R2 に書き始める前に、1 回の流しでフッタまで通す**。
 *
 * 通すもの(どれかが違えば {@link MigrationFormatError}。メッセージに行番号を含む):
 *  - gzip として展開できること(途中で切れていない)
 *  - 各行が `parseMigrationLine`(JSON → 形式の検証)を通ること
 *  - `MigrationTally`: 行の並び(ヘッダ → 分析 → 結果 → フッタ)・id/raceId の昇順・フッタの件数と読んだ行数の一致・**フッタが来ていること**
 *  - **取り込みの変換が通ること**(`toAnalysisImport`・`toResultImport`): JSON の列が壊れている・馬番/買い目のキーが重複する、といった「形式は通るが取り込みの途中で落ちる」行を、書き始める前に見つける
 */

import {
  MigrationFormatError,
  MigrationTally,
  parseMigrationLine,
  type MigrationFooterLine,
  type MigrationHeaderLine,
} from "../../packages/core/src/ev/cloud-migration-format";
import { toAnalysisImport, toResultImport } from "./migration-convert";
import { MigrationFileError, readLines } from "./migration-reader";

/** 検証の結果。 */
export interface VerifiedFile {
  readonly header: MigrationHeaderLine;
  readonly footer: MigrationFooterLine;
  /** 展開後の大きさ(バイト)。 */
  readonly bytes: number;
  /** 行数(ヘッダ・フッタを含む)。 */
  readonly lines: number;
}

/** @throws MigrationFormatError 検証に通らない(メッセージは固定の文言+位置+列名。値の全文は含めない) */
export async function verifyMigrationFile(gz: ReadableStream<Uint8Array>): Promise<VerifiedFile> {
  const tally = new MigrationTally();
  let header: MigrationHeaderLine | null = null;
  let footer: MigrationFooterLine | null = null;
  let bytes = 0;
  let count = 0;
  try {
    for await (const raw of readLines(gz)) {
      count += 1;
      bytes = raw.end;
      let line;
      try {
        line = parseMigrationLine(raw.text);
      } catch (e) {
        throw new MigrationFormatError(`${count} 行目: ${e instanceof Error ? e.message : String(e)}`);
      }
      tally.accept(line);
      if (line.type === "header") {
        header = line;
      } else if (line.type === "footer") {
        footer = line;
      } else {
        try {
          if (line.type === "analysis") {
            toAnalysisImport(line);
          } else {
            toResultImport(line);
          }
        } catch (e) {
          throw new MigrationFormatError(`${count} 行目: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) {
    if (e instanceof MigrationFileError) {
      throw new MigrationFormatError(`${count + 1} 行目付近: ファイルを展開できない(${e.message})`);
    }
    throw e;
  }
  tally.assertComplete();
  if (header === null || footer === null) {
    throw new MigrationFormatError("ヘッダまたはフッタが無い");
  }
  return { header, footer, bytes, lines: count };
}
