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
 * 1. 使ったツールは「自分のプロンプトファイル(絶対パス一致)の Read」がちょうど1回と、
 *    「`SubagentHandback` 0〜1回(Read より後)」だけ。Read の引数は `file_path` のみ
 *    (offset・limit 等で全文を読まなかった可能性を排除)。それ以外のツールは無効。
 * 2. その Read の結果がエラーでなく、プロンプトの全文(空でない各行)を含む。
 * 3. 依頼文の定型(`renderSubagentTaskText`)が、**最初の(`isMeta` でない)user メッセージと完全一致**する
 *    (harness のリマインダ〈`isMeta` の user メッセージ〉は無視する)。
 * 4. 応答の取り方(実行前に両方の形を固定した。応答を見てから規則を変えない):
 *    (a) `SubagentHandback` がちょうど1回なら、応答は**その `input.message`**(文字列。空白だけなら無効。
 *        `message` 以外のフィールドは無視する)。handback より後の平文テキストは数えない。2回以上は無効。
 *    (b) handback が無ければ、最後の tool_result より後の assistant のテキスト(空白だけでなく、
 *        tool_use を含まない)。
 *    どちらも**整形せず**そのまま返す(前置きの散文があっても production の `parseAnalyzerResponse` に任せる)。
 *
 * JSONL の形式は Claude Code のサブエージェントのトランスクリプトの実物(`type` が user / assistant /
 * attachment の行。assistant の `message.content` は thinking・text・tool_use のブロックが1行ずつ)
 * に合わせた。実物の1体目を取得して差異があれば、この形式に合わせて直す。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "./records.js";

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

/** トランスクリプトから機械的に拾う実行記録用の情報(手書きしない)。 */
export interface TranscriptMeta {
  /** assistant エントリの `message.model`(出現順・重複なし。無ければ空配列)。 */
  readonly models: readonly string[];
  /** エントリの `agentId`(最初に見つかったもの。無ければ null)。 */
  readonly agentId: string | null;
  /** 最初・最後のエントリのタイムスタンプ。無ければ null。 */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export type ExtractResult =
  | {
      readonly ok: true;
      /** 応答本文(handback の `input.message`、または最終メッセージ。連結のみでトリムしない)。 */
      readonly text: string;
      /** 応答の取り方: `handback`=(a)、`final-message`=(b)。 */
      readonly via: "handback" | "final-message";
      readonly toolUses: ReadonlyArray<{ readonly name: string; readonly filePath: string | null }>;
      readonly meta: TranscriptMeta;
    }
  | { readonly ok: false; readonly reasons: readonly string[]; readonly meta: TranscriptMeta };

/** harness が使う、最終報告用のツール名(0〜1回だけ許す)。 */
export const HANDBACK_TOOL_NAME = "SubagentHandback";

interface Entry {
  readonly index: number;
  readonly type: string;
  readonly content: unknown;
  readonly isMeta: boolean;
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
  const models: string[] = [];
  let agentId: string | null = null;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  jsonl.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      reasons.push(`${i + 1}行目が JSON として読めない`);
      return;
    }
    const obj = parsed as {
      type?: unknown;
      isMeta?: unknown;
      agentId?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; model?: unknown };
    };
    if ((obj.type === "user" || obj.type === "assistant") && obj.message !== undefined) {
      entries.push({ index: i, type: obj.type, content: obj.message.content, isMeta: obj.isMeta === true });
      if (obj.type === "assistant" && typeof obj.message.model === "string" && !models.includes(obj.message.model)) {
        models.push(obj.message.model);
      }
      if (agentId === null && typeof obj.agentId === "string") agentId = obj.agentId;
      if (typeof obj.timestamp === "string") {
        if (startedAt === null) startedAt = obj.timestamp;
        finishedAt = obj.timestamp;
      }
    }
  });

  // 依頼文の定型: 最初の(isMeta でない)user メッセージと完全一致(harness のリマインダは無視する)。
  const task = renderSubagentTaskText(options.expectedPromptPath);
  const firstUser = entries.find((e) => e.type === "user" && !e.isMeta);
  const firstUserText =
    firstUser === undefined
      ? null
      : typeof firstUser.content === "string"
        ? firstUser.content
        : blocksOf(firstUser.content)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("");
  if (firstUserText !== task) {
    reasons.push("依頼文の定型(renderSubagentTaskText)が、最初の(isMeta でない)user メッセージと完全一致しない");
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
  const handbacks: ToolUseBlock[] = [];
  for (const t of toolUses) {
    if (t.name === HANDBACK_TOOL_NAME) {
      handbacks.push(t);
      continue;
    }
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
  if (handbacks.length > 1) {
    reasons.push(`${HANDBACK_TOOL_NAME} を ${handbacks.length}回呼んだ(0〜1回だけ許す)`);
  }
  if (handbacks.length === 1 && ownReads.length >= 1 && handbacks[0]!.entryIndex <= Math.min(...ownReads.map((r) => r.entryIndex))) {
    reasons.push(`${HANDBACK_TOOL_NAME} が自分のプロンプトの Read より前にある(読まずに答えた)`);
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

  // 応答の取り方。(a) handback がちょうど1回ならその input.message。(b) 無ければ最終メッセージ。
  let text = "";
  let via: "handback" | "final-message" = "final-message";
  if (handbacks.length >= 1) {
    via = "handback";
    if (handbacks.length === 1) {
      const message = handbacks[0]!.input.message;
      if (typeof message !== "string" || message.trim() === "") {
        reasons.push(`${HANDBACK_TOOL_NAME} の input.message が空でない文字列でない`);
      } else {
        text = message;
      }
    }
  } else {
    // (b) 最後の tool_result より後の assistant のテキスト。
    const finalEntries = entries.filter((e) => e.type === "assistant" && e.index > lastToolResultEntry);
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
  }

  const meta: TranscriptMeta = { models, agentId, startedAt, finishedAt };
  if (reasons.length > 0) {
    return { ok: false, reasons, meta };
  }
  return {
    ok: true,
    text,
    via,
    toolUses: [
      ...ownReads.map((r) => ({ name: r.name, filePath: String(r.input.file_path) as string | null })),
      ...handbacks.map((h) => ({ name: h.name, filePath: null as string | null })),
    ],
    meta,
  };
}

export interface SaveExtractedInput {
  readonly workDir: string;
  readonly caseId: string;
  /** 1 または 2(production の最大試行は2回)。 */
  readonly attempt: number;
  readonly transcriptPath: string;
  /** 対応表(`index.json`)のパス。`subagent/case-NN.txt` の SHA-256 の照合に使う。 */
  readonly indexPath: string;
  /** 現在時刻(実行記録の `recordedAt`。テスト用)。 */
  readonly now?: () => Date;
}

export type SaveExtractedResult =
  | { readonly ok: true; readonly savedPath: string; readonly chars: number }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** 実行記録(`subagent-runs.json`)の1件。 */
export interface SubagentRunRecord {
  readonly caseId: string;
  readonly attempt: number;
  readonly valid: boolean;
  readonly via: "handback" | "final-message" | null;
  readonly models: readonly string[];
  readonly agentId: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly toolUses: ReadonlyArray<{ readonly name: string; readonly filePath: string | null }>;
  readonly reasons: readonly string[];
  /** 有効な応答本文の SHA-256(無効なら null)。 */
  readonly responseSha256: string | null;
  readonly transcriptPath: string;
  readonly recordedAt: string;
}

function appendRunRecord(workDir: string, record: SubagentRunRecord): void {
  const file = path.join(workDir, "subagent-runs.json");
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as { runs: SubagentRunRecord[] }).runs : [];
  mkdirSync(workDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ runs: [...existing, record] }, null, 2), "utf-8");
}

/**
 * トランスクリプトを検証し、通れば `<workDir>/responses/<caseId>.attempt<N>.txt` に応答本文を
 * そのまま書く。既にあるファイルは上書きしない(取り直しの選択をさせない)。attempt 2 は
 * attempt 1 が保存済みのときだけ。`subagent/<caseId>.txt` の SHA-256 が対応表と一致しなければ書かない。
 * 有効・無効を問わず、トランスクリプトの検証を行った結果を `subagent-runs.json` に追記する
 * (モデル ID は assistant エントリの `message.model` から機械的に拾う)。
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
  const promptText = readFileSync(promptPath, "utf-8");
  const index = JSON.parse(readFileSync(input.indexPath, "utf-8")) as {
    entries: ReadonlyArray<{ caseId: string; promptSha256: string }>;
  };
  const entry = index.entries.find((e) => e.caseId === input.caseId);
  if (entry === undefined) {
    return { ok: false, reasons: [`対応表(${input.indexPath})に ${input.caseId} がない`] };
  }
  if (sha256Hex(promptText) !== entry.promptSha256) {
    return {
      ok: false,
      reasons: [`${promptPath} の SHA-256 が対応表と一致しない(プロンプトが段階1の後で書き換わった可能性)`],
    };
  }

  const result = extractFinalResponse(readFileSync(input.transcriptPath, "utf-8"), {
    expectedPromptPath: promptPath,
    expectedPromptText: promptText,
  });
  const recordedAt = (input.now ?? (() => new Date()))().toISOString();
  const base = {
    caseId: input.caseId,
    attempt: input.attempt,
    models: result.meta.models,
    agentId: result.meta.agentId,
    startedAt: result.meta.startedAt,
    finishedAt: result.meta.finishedAt,
    transcriptPath: path.resolve(input.transcriptPath),
    recordedAt,
  };
  if (!result.ok) {
    appendRunRecord(input.workDir, {
      ...base,
      valid: false,
      via: null,
      toolUses: [],
      reasons: result.reasons,
      responseSha256: null,
    });
    return { ok: false, reasons: result.reasons };
  }
  mkdirSync(responsesDir, { recursive: true });
  writeFileSync(target, result.text, { encoding: "utf-8", flag: "wx" });
  appendRunRecord(input.workDir, {
    ...base,
    valid: true,
    via: result.via,
    toolUses: result.toolUses,
    reasons: [],
    responseSha256: sha256Hex(result.text),
  });
  return { ok: true, savedPath: target, chars: result.text.length };
}
