/**
 * #156(#41-B)ファイルを返す `LlmClient`。production の `analyzeRace` に差し込み、
 * 「N 回目の `complete` は `case-NN.attemptN.txt` の中身を返す」ことで、サブエージェントが作った
 * 応答を、production のパース・クリップ・リトライ・フォールバックにそのまま通す。
 *
 * ## 未生成の扱い(リトライの設計。計画 §リトライ)
 * N 回目の応答ファイルが無いとき、**例外を投げず**に空文字を返し、`missingAttempt` に記録する
 * (例外を投げると `analyzeRace` が「LLM 呼び出し例外」と解釈して prior へフォールバックし、
 * 「まだ応答が無い」と「本物の失敗」が区別できなくなる)。呼び出し側は `analyzeRace` から戻った後に
 * `missingAttempt` を見て、`1` なら応答未生成、`2` ならリトライ用の2回目が未生成と判定する。
 * 2回目より後は呼ばれない(`analyzeRace` の最大試行は2回)。
 */

import type { LlmClient } from "../../packages/core/src/index.js";

export class FileLlmClient implements LlmClient {
  private readonly receivedPrompts: string[] = [];
  private missing: number | null = null;

  /**
   * @param readAttempt N 回目(1始まり)の応答テキストを返す。ファイルが無ければ undefined。
   */
  constructor(private readonly readAttempt: (attempt: number) => string | undefined) {}

  /** `complete` に渡されたプロンプト(呼ばれた順)。 */
  get prompts(): readonly string[] {
    return this.receivedPrompts;
  }

  /** 最初に未生成だった試行の番号(1始まり)。すべて生成済みなら null。 */
  get missingAttempt(): number | null {
    return this.missing;
  }

  async complete(prompt: string): Promise<string> {
    this.receivedPrompts.push(prompt);
    const attempt = this.receivedPrompts.length;
    const text = this.readAttempt(attempt);
    if (text === undefined) {
      if (this.missing === null) {
        this.missing = attempt;
      }
      return "";
    }
    return text;
  }
}
