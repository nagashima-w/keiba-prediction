import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractFinalResponse,
  renderSubagentTaskText,
  saveExtractedResponse,
} from "../probability-quality-41-llm/transcript.js";

/**
 * サブエージェントのトランスクリプト(JSONL)から、最終メッセージ(応答本文そのもの)を取り出し、
 * 「許したツール使用(自分のプロンプトファイルの Read 1回)だけ」であることを検証する(#156 §運用)。
 * 形式は Claude Code のサブエージェントのトランスクリプトの実物(user / assistant / attachment の行。
 * assistant の content は thinking・text・tool_use のブロックが1行ずつ)に合わせた合成データ。
 * 実物の1体目を取得したあと、差異があればこの形式に合わせて直す。
 */

const PROMPT_PATH = "/work/subagent/case-07.txt";
const PROMPT_TEXT = "あなたは競馬のアナリストです。\n\n【レース情報】\nレース名: テスト\n馬番1 テスト馬: 3着内率=0.20\n";

let seq = 0;
const line = (o: unknown): string => JSON.stringify(o);
const userString = (text: string) => line({ type: "user", message: { role: "user", content: text } });
const assistant = (blocks: unknown[], id = `msg_${++seq}`) =>
  line({ type: "assistant", message: { id, role: "assistant", content: blocks } });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, text: string, isError = false) =>
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
  });
const attachment = () => line({ type: "attachment", attachment: { type: "x" } });

/** Read ツールの出力の形(行番号つき)。 */
function readOutput(text: string): string {
  return text
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(6, " ")}\t${l}`)
    .join("\n");
}

const TASK = renderSubagentTaskText(PROMPT_PATH);
const FINAL = '{"horses": [{"number": 1, "place_prob": 0.25, "reason": "根拠", "mark": "◎"}]}\n';

function good(overrides: { tail?: string[]; head?: string[] } = {}): string {
  return [
    userString(TASK),
    ...(overrides.head ?? []),
    attachment(),
    assistant([{ type: "thinking", thinking: "..." }]),
    assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
    toolResult("tu1", readOutput(PROMPT_TEXT)),
    attachment(),
    ...(overrides.tail ?? [assistant([{ type: "text", text: FINAL }])]),
  ].join("\n");
}

const OPTS = { expectedPromptPath: PROMPT_PATH, expectedPromptText: PROMPT_TEXT };

describe("renderSubagentTaskText: 依頼文の定型", () => {
  it("プロンプトファイルのパスを含み、Read 以外のツールを使わないこと・最終メッセージが応答本文であることを述べる", () => {
    expect(TASK).toContain(PROMPT_PATH);
    expect(TASK).toContain("ユーザーメッセージ");
    expect(TASK).toContain("最終メッセージ");
    expect(TASK).toContain("Read");
    expect(TASK).toContain("使わない");
  });
});

describe("extractFinalResponse: 検証を通る場合", () => {
  it("最終メッセージの本文をそのまま(末尾の改行も含めて)取り出し、使ったツールは Read 1回だけと報告する", () => {
    const r = extractFinalResponse(good(), OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe(FINAL);
    expect(r.toolUses).toEqual([{ name: "Read", filePath: PROMPT_PATH }]);
  });

  it("最終メッセージが複数の行(同じメッセージの text ブロック)に分かれていても、順に連結する(production と同じ連結)", () => {
    const r = extractFinalResponse(
      good({ tail: [assistant([{ type: "text", text: '{"horses": ' }], "m9"), assistant([{ type: "text", text: "[]}" }], "m9")] }),
      OPTS,
    );
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe('{"horses": []}');
  });

  it("thinking ブロック・attachment 行は応答本文に含めない", () => {
    const r = extractFinalResponse(
      good({ tail: [assistant([{ type: "thinking", thinking: "考え中" }], "m5"), assistant([{ type: "text", text: "本文" }], "m5")] }),
      OPTS,
    );
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe("本文");
  });

  it("Read の前の途中経過のテキスト(前置き)は応答本文に含めない", () => {
    const text = [
      userString(TASK),
      assistant([{ type: "text", text: "ファイルを読みます" }]),
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      assistant([{ type: "text", text: FINAL }]),
    ].join("\n");
    const r = extractFinalResponse(text, OPTS);
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe(FINAL);
  });
});

describe("extractFinalResponse: 無効な応答(理由を返し、本文は返さない)", () => {
  function reasonsOf(jsonl: string): string[] {
    const r = extractFinalResponse(jsonl, OPTS);
    expect(r.ok).toBe(false);
    return r.ok ? [] : [...r.reasons];
  }
  const has = (reasons: string[], word: string) => reasons.some((x) => x.includes(word));

  it("Read 以外のツール(Bash)を使っていれば無効", () => {
    const text = good({
      head: [assistant([toolUse("tuB", "Bash", { command: "ls" })]), toolResult("tuB", "a")],
    });
    expect(has(reasonsOf(text), "Bash")).toBe(true);
  });

  it("Write を使っていれば無効", () => {
    const text = good({ head: [assistant([toolUse("tuW", "Write", { file_path: "/x", content: "y" })]), toolResult("tuW", "ok")] });
    expect(has(reasonsOf(text), "Write")).toBe(true);
  });

  it("Read でも、自分のプロンプトファイル以外を読んでいれば無効", () => {
    const text = good({ head: [assistant([toolUse("tuR", "Read", { file_path: "/work/subagent/case-08.txt" })]), toolResult("tuR", "他")] });
    expect(has(reasonsOf(text), "case-08")).toBe(true);
  });

  it("自分のプロンプトの Read が2回なら無効(1回だけ許す)", () => {
    const text = good({ head: [assistant([toolUse("tuR2", "Read", { file_path: PROMPT_PATH })]), toolResult("tuR2", readOutput(PROMPT_TEXT))] });
    expect(has(reasonsOf(text), "2回")).toBe(true);
  });

  it("Read が1回もなければ無効(プロンプトを読まずに答えた)", () => {
    const text = [userString(TASK), assistant([{ type: "text", text: FINAL }])].join("\n");
    expect(has(reasonsOf(text), "Read")).toBe(true);
  });

  it("Read に offset・limit が付いていれば無効(全文を読んでいない可能性)", () => {
    const text = [
      userString(TASK),
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH, limit: 3 })]),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      assistant([{ type: "text", text: FINAL }]),
    ].join("\n");
    expect(has(reasonsOf(text), "limit")).toBe(true);
  });

  it("Read の結果がエラーなら無効", () => {
    const text = [
      userString(TASK),
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
      toolResult("tu1", "ENOENT", true),
      assistant([{ type: "text", text: FINAL }]),
    ].join("\n");
    expect(has(reasonsOf(text), "エラー")).toBe(true);
  });

  it("Read の結果にプロンプトの全文が含まれていなければ無効(切り詰められた読み取り)", () => {
    const text = [
      userString(TASK),
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
      toolResult("tu1", readOutput(PROMPT_TEXT.split("\n").slice(0, 2).join("\n"))),
      assistant([{ type: "text", text: FINAL }]),
    ].join("\n");
    expect(has(reasonsOf(text), "全文")).toBe(true);
  });

  it("最終メッセージが無ければ無効(Read の結果のあとに assistant のテキストが無い)", () => {
    expect(has(reasonsOf(good({ tail: [] })), "最終メッセージ")).toBe(true);
  });

  it("最終メッセージが空白だけなら無効", () => {
    expect(has(reasonsOf(good({ tail: [assistant([{ type: "text", text: " \n" }])] })), "最終メッセージ")).toBe(true);
  });

  it("最終メッセージの行に tool_use が含まれていれば無効(まだ作業の途中)", () => {
    const tail = [assistant([{ type: "text", text: "途中" }, toolUse("tuX", "Bash", { command: "ls" })])];
    expect(reasonsOf(good({ tail })).length).toBeGreaterThan(0);
  });

  it("依頼文の定型がトランスクリプトに無ければ無効(別の依頼で起動された)", () => {
    const text = good().replace(TASK.slice(0, 20), "別の依頼ですよ。");
    expect(has(reasonsOf(text), "依頼文")).toBe(true);
  });

  it("JSON として読めない行があれば無効", () => {
    expect(has(reasonsOf(good() + "\n{壊れた"), "JSON")).toBe(true);
  });

  it("理由は複数同時に返す(Bash と他ファイルの Read の両方)", () => {
    const text = good({
      head: [
        assistant([toolUse("tuB", "Bash", { command: "ls" })]), toolResult("tuB", "a"),
        assistant([toolUse("tuR", "Read", { file_path: "/x/y" })]), toolResult("tuR", "b"),
      ],
    });
    const reasons = reasonsOf(text);
    expect(has(reasons, "Bash")).toBe(true);
    expect(has(reasons, "/x/y")).toBe(true);
  });
});

describe("saveExtractedResponse: 検証を通った応答だけを responses/ に保存する", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function work(): { dir: string; transcript: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "pq41llm-tr-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "subagent"), { recursive: true });
    writeFileSync(path.join(dir, "subagent", "case-07.txt"), PROMPT_TEXT, "utf-8");
    const promptPath = path.join(dir, "subagent", "case-07.txt");
    const task = renderSubagentTaskText(promptPath);
    const jsonl = [
      userString(task),
      assistant([toolUse("tu1", "Read", { file_path: promptPath })]),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      assistant([{ type: "text", text: FINAL }]),
    ].join("\n");
    const transcript = path.join(dir, "t.jsonl");
    writeFileSync(transcript, jsonl, "utf-8");
    return { dir, transcript };
  }

  it("応答本文を responses/case-07.attempt1.txt にそのまま書く", () => {
    const { dir, transcript } = work();
    const r = saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(r.ok).toBe(true);
    const saved = path.join(dir, "responses", "case-07.attempt1.txt");
    expect(readFileSync(saved, "utf-8")).toBe(FINAL);
  });

  it("無効な応答は何も書かない", () => {
    const { dir, transcript } = work();
    writeFileSync(transcript, readFileSync(transcript, "utf-8").replace('"Read"', '"Bash"'), "utf-8");
    const r = saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(dir, "responses", "case-07.attempt1.txt"))).toBe(false);
  });

  it("既にある応答は上書きしない(取り直しの選択をさせない)", () => {
    const { dir, transcript } = work();
    expect(saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript }).ok).toBe(true);
    const again = saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("前提");
    expect(again.reasons.join("\n")).toContain("既に");
  });

  it("attempt 2 は attempt 1 が保存済みのときだけ保存できる", () => {
    const { dir, transcript } = work();
    const r2 = saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 2, transcriptPath: transcript });
    expect(r2.ok).toBe(false);
    expect(saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript }).ok).toBe(true);
    expect(saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 2, transcriptPath: transcript }).ok).toBe(true);
  });

  it("attempt は 1 か 2 だけ", () => {
    const { dir, transcript } = work();
    const r = saveExtractedResponse({ workDir: dir, caseId: "case-07", attempt: 3, transcriptPath: transcript });
    expect(r.ok).toBe(false);
  });
});
