/**
 * #156(#41-B)サブエージェントのトランスクリプト(JSONL)から、最終メッセージ(応答本文そのもの)を
 * 取り出し、**許したツール使用だけであること**を検証する。
 *
 * ## 運用(計画 §サブエージェントの運用)
 * サブエージェントには「自分のプロンプトファイルの Read 1回」だけを許し、応答はファイルに書かせず
 * **最終メッセージ**として返させる。メインがトランスクリプトからこのモジュールで本文を取り出して
 * `responses/case-NN.attemptN.txt` に保存する(Write を許さないので、任意のパスへの書き込みも起きない)。
 *
 * ## 検証(いずれかに反すれば無効。理由を列挙して本文は返さない)
 * 1. 使ったツールは「自分のプロンプトファイル(絶対パス一致)の Read」がちょうど1回だけ。
 *    引数は `file_path` のみ(offset・limit 等で全文を読まなかった可能性を排除)。
 * 2. その Read の結果がエラーでなく、プロンプトの全文(空でない各行)を含む。
 * 3. 依頼文の定型(`renderSubagentTaskText`)がトランスクリプトの user メッセージにある。
 * 4. 最後の tool_result より後の assistant のテキストが最終メッセージで、空白だけでなく、tool_use を含まない。
 *
 * JSONL の形式は Claude Code のサブエージェントのトランスクリプトの実物(`type` が user / assistant /
 * attachment の行。assistant の `message.content` は thinking・text・tool_use のブロックが1行ずつ)
 * に合わせた。実物の1体目を取得して差異があれば、この形式に合わせて直す。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** サブエージェントへの依頼文の定型(計画に固定。プロンプトファイルのパスだけが変わる)。 */
export function renderSubagentTaskText(promptPath: string): string {
  return [
    `次のファイルを Read ツールで1回だけ読んでください: ${promptPath}`,
    "このファイルの全文を、あなたが受け取ったユーザーメッセージとして扱い、それへの返信本文だけを最終メッセージとして返してください。",
    "このファイルの Read 以外のツールは使わないでください。",
  ].join("\n");
}

export interface ExtractOptions {
  /** 自分のプロンプトファイルの絶対パス(Read を許す唯一のファイル)。 */
  readonly expectedPromptPath: string;
  /** プロンプトファイルの全文(Read の結果に含まれるべき内容)。 */
  readonly expectedPromptText: string;
}

export type ExtractResult =
  | {
      readonly ok: true;
      /** 最終メッセージの本文(連結のみ。トリムしない)。 */
      readonly text: string;
      readonly toolUses: ReadonlyArray<{ readonly name: string; readonly filePath: string | null }>;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

interface Entry {
  readonly index: number;
  readonly type: string;
  readonly content: unknown;
}

interface ToolUseBlock {
  readonly entryIndex: number;
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    : [];
}

/** tool_result の content(文字列または text ブロックの配列)を1つの文字列にする。 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export function extractFinalResponse(jsonl: string, options: ExtractOptions): ExtractResult {
  const reasons: string[] = [];
  const entries: Entry[] = [];
  jsonl.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      reasons.push(`${i + 1}行目が JSON として読めない`);
      return;
    }
    const obj = parsed as { type?: unknown; message?: { content?: unknown } };
    if ((obj.type === "user" || obj.type === "assistant") && obj.message !== undefined) {
      entries.push({ index: i, type: obj.type, content: obj.message.content });
    }
  });

  // 依頼文の定型。
  const task = renderSubagentTaskText(options.expectedPromptPath);
  const userTexts = entries
    .filter((e) => e.type === "user")
    .map((e) =>
      typeof e.content === "string"
        ? e.content
        : blocksOf(e.content)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join(""),
    );
  if (!userTexts.some((t) => t.includes(task))) {
    reasons.push("依頼文の定型(renderSubagentTaskText)がトランスクリプトに無い");
  }

  // ツール使用。
  const toolUses: ToolUseBlock[] = [];
  for (const e of entries) {
    if (e.type !== "assistant") continue;
    for (const b of blocksOf(e.content)) {
      if (b.type === "tool_use") {
        toolUses.push({
          entryIndex: e.index,
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          input: (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>,
        });
      }
    }
  }
  const expectedPath = path.resolve(options.expectedPromptPath);
  const ownReads: ToolUseBlock[] = [];
  for (const t of toolUses) {
    if (t.name !== "Read") {
      reasons.push(`許可していないツールを使った: ${t.name}`);
      continue;
    }
    const filePath = typeof t.input.file_path === "string" ? t.input.file_path : null;
    if (filePath === null || path.resolve(filePath) !== expectedPath) {
      reasons.push(`自分のプロンプト以外のファイルを Read した: ${filePath ?? "(file_path なし)"}`);
      continue;
    }
    ownReads.push(t);
  }
  if (ownReads.length === 0) {
    reasons.push("自分のプロンプトファイルの Read がない");
  } else if (ownReads.length > 1) {
    reasons.push(`自分のプロンプトファイルを ${ownReads.length}回 Read した(1回だけ許す)`);
  }
  for (const r of ownReads) {
    const extra = Object.keys(r.input).filter((k) => k !== "file_path");
    if (extra.length > 0) {
      reasons.push(`Read の引数に file_path 以外がある(${extra.join(", ")}。全文を読んだことを保証できない)`);
    }
  }

  // Read の結果。
  const results = new Map<string, { text: string; isError: boolean; entryIndex: number }>();
  let lastToolResultEntry = -1;
  for (const e of entries) {
    if (e.type !== "user") continue;
    for (const b of blocksOf(e.content)) {
      if (b.type === "tool_result") {
        results.set(String(b.tool_use_id ?? ""), {
          text: toolResultText(b.content),
          isError: b.is_error === true,
          entryIndex: e.index,
        });
        lastToolResultEntry = Math.max(lastToolResultEntry, e.index);
      }
    }
  }
  for (const r of ownReads) {
    const res = results.get(r.id);
    if (res === undefined) {
      reasons.push("自分のプロンプトの Read の結果(tool_result)がない");
      continue;
    }
    if (res.isError) {
      reasons.push("自分のプロンプトの Read の結果がエラー");
      continue;
    }
    const lines = options.expectedPromptText.split("\n").filter((l) => l.trim() !== "");
    const missing = lines.filter((l) => !res.text.includes(l));
    if (missing.length > 0) {
      reasons.push(`Read の結果にプロンプトの全文が含まれていない(欠けた行 ${missing.length}/${lines.length})`);
    }
  }

  // 最終メッセージ: 最後の tool_result より後の assistant のテキスト。
  const finalEntries = entries.filter((e) => e.type === "assistant" && e.index > lastToolResultEntry);
  let text = "";
  let finalHasToolUse = false;
  for (const e of finalEntries) {
    for (const b of blocksOf(e.content)) {
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text;
      } else if (b.type === "tool_use") {
        finalHasToolUse = true;
      }
    }
  }
  if (finalHasToolUse) {
    reasons.push("最終メッセージの行に tool_use が含まれる(作業が終わっていない)");
  }
  if (text.trim() === "") {
    reasons.push("最終メッセージ(最後の tool_result より後の assistant のテキスト)がない、または空白だけ");
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    text,
    toolUses: ownReads.map((r) => ({ name: r.name, filePath: String(r.input.file_path) })),
  };
}

export interface SaveExtractedInput {
  readonly workDir: string;
  readonly caseId: string;
  /** 1 または 2(production の最大試行は2回)。 */
  readonly attempt: number;
  readonly transcriptPath: string;
}

export type SaveExtractedResult =
  | { readonly ok: true; readonly savedPath: string; readonly chars: number }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * トランスクリプトを検証し、通れば `<workDir>/responses/<caseId>.attempt<N>.txt` に最終メッセージを
 * そのまま書く。既にあるファイルは上書きしない(取り直しの選択をさせない)。attempt 2 は
 * attempt 1 が保存済みのときだけ。
 */
export function saveExtractedResponse(input: SaveExtractedInput): SaveExtractedResult {
  if (input.attempt !== 1 && input.attempt !== 2) {
    return { ok: false, reasons: [`attempt は 1 か 2 だけ(指定: ${input.attempt})`] };
  }
  const responsesDir = path.join(input.workDir, "responses");
  const target = path.join(responsesDir, `${input.caseId}.attempt${input.attempt}.txt`);
  if (existsSync(target)) {
    return { ok: false, reasons: [`${target} は既に存在する(上書きしない)`] };
  }
  if (input.attempt === 2 && !existsSync(path.join(responsesDir, `${input.caseId}.attempt1.txt`))) {
    return { ok: false, reasons: [`attempt 2 は attempt 1 の保存後だけ(${input.caseId}.attempt1.txt がない)`] };
  }
  const promptPath = path.resolve(input.workDir, "subagent", `${input.caseId}.txt`);
  if (!existsSync(promptPath)) {
    return { ok: false, reasons: [`プロンプトファイルがない: ${promptPath}`] };
  }
  const result = extractFinalResponse(readFileSync(input.transcriptPath, "utf-8"), {
    expectedPromptPath: promptPath,
    expectedPromptText: readFileSync(promptPath, "utf-8"),
  });
  if (!result.ok) {
    return { ok: false, reasons: result.reasons };
  }
  mkdirSync(responsesDir, { recursive: true });
  writeFileSync(target, result.text, { encoding: "utf-8", flag: "wx" });
  return { ok: true, savedPath: target, chars: result.text.length };
}
