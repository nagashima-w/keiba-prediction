import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractFinalResponse,
  renderSubagentTaskText,
  saveExtractedResponse,
} from "../probability-quality-41-llm/transcript.js";
import { sha256Hex } from "../probability-quality-41-llm/records.js";

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
/** harness のリマインダ(isMeta の user メッセージ)。実物では依頼文の直後に入る。 */
const metaReminder = () =>
  line({
    type: "user",
    isMeta: true,
    message: { role: "user", content: "<system-reminder>\nYour final report is delivered through SubagentHandback: ...\n</system-reminder>" },
  });
const handback = (id: string, input: Record<string, unknown>) => assistant([toolUse(id, "SubagentHandback", input)]);
const handbackResult = (id: string) => toolResult(id, '{"success":true,"message":"Report delivered to your caller."}');

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

describe("extractFinalResponse: SubagentHandback 経由の最終出力(実行前の改訂)", () => {
  /** Read のあとに handback で報告する正常な形。 */
  function withHandback(message: unknown, extra: string[] = [], head: string[] = []): string {
    return [
      userString(TASK),
      metaReminder(),
      ...head,
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      handback("tuH", { message }),
      handbackResult("tuH"),
      ...extra,
    ].join("\n");
  }
  const reasonsOf = (jsonl: string): string[] => {
    const r = extractFinalResponse(jsonl, OPTS);
    expect(r.ok).toBe(false);
    return r.ok ? [] : [...r.reasons];
  };

  it("(a) handback がちょうど1回なら、応答はその input.message(整形せず、そのまま)", () => {
    const r = extractFinalResponse(withHandback(FINAL), OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe(FINAL);
    expect(r.via).toBe("handback");
    expect(r.toolUses).toEqual([
      { name: "Read", filePath: PROMPT_PATH },
      { name: "SubagentHandback", filePath: null },
    ]);
  });

  it("前置きの散文つきの message もそのまま採る(production の LLM の散文と同じ扱い。パースは production に任せる)", () => {
    const msg = "以下が回答です。\n" + FINAL;
    const r = extractFinalResponse(withHandback(msg), OPTS);
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe(msg);
  });

  it("handback の後の平文テキストは応答に数えない", () => {
    const r = extractFinalResponse(withHandback(FINAL, [assistant([{ type: "text", text: "完了しました" }])]), OPTS);
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe(FINAL);
    expect(r.text).not.toContain("完了しました");
  });

  it("handback の input に message 以外のフィールドがあっても、message だけを採り他は無視する", () => {
    const text = [
      userString(TASK),
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      handback("tuH", { message: FINAL, extra: "無視される", notes: ["x"] }),
      handbackResult("tuH"),
    ].join("\n");
    const r = extractFinalResponse(text, OPTS);
    if (!r.ok) throw new Error("前提");
    expect(r.text).toBe(FINAL);
  });

  it("handback が2回以上なら無効", () => {
    const text = [
      userString(TASK),
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      handback("tuH1", { message: FINAL }),
      handbackResult("tuH1"),
      handback("tuH2", { message: FINAL }),
      handbackResult("tuH2"),
    ].join("\n");
    expect(reasonsOf(text).some((x) => x.includes("SubagentHandback") && x.includes("2回"))).toBe(true);
  });

  it("handback が自分のプロンプトの Read より前なら無効(読まずに答えた)", () => {
    const text = [
      userString(TASK),
      handback("tuH", { message: FINAL }),
      handbackResult("tuH"),
      assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
    ].join("\n");
    expect(reasonsOf(text).some((x) => x.includes("Read より前"))).toBe(true);
  });

  it("handback の message が文字列でない・空白だけなら無効", () => {
    expect(reasonsOf(withHandback(123)).some((x) => x.includes("message"))).toBe(true);
    expect(reasonsOf(withHandback("  \n")).some((x) => x.includes("message"))).toBe(true);
    expect(reasonsOf(withHandback(undefined)).some((x) => x.includes("message"))).toBe(true);
  });

  it("handback の前に Bash を使っていれば無効(許すのは Read 1回と handback 0〜1回だけ)", () => {
    const head = [assistant([toolUse("tuB", "Bash", { command: "ls" })]), toolResult("tuB", "a")];
    expect(reasonsOf(withHandback(FINAL, [], head)).some((x) => x.includes("Bash"))).toBe(true);
  });

  it("handback を使わない場合は (b): 最後の tool_result より後の assistant テキスト(従来どおり)", () => {
    const r = extractFinalResponse(good(), OPTS);
    if (!r.ok) throw new Error("前提");
    expect(r.via).toBe("final-message");
    expect(r.text).toBe(FINAL);
  });

  it("isMeta の user メッセージ(harness のリマインダ)が入っていても、依頼文の検証は壊れない", () => {
    const r = extractFinalResponse(good({ head: [metaReminder()] }), OPTS);
    expect(r.ok).toBe(true);
  });
});

describe("extractFinalResponse: 依頼文は最初の(isMeta でない)user メッセージと完全一致", () => {
  const reasonsOf = (jsonl: string): string[] => {
    const r = extractFinalResponse(jsonl, OPTS);
    expect(r.ok).toBe(false);
    return r.ok ? [] : [...r.reasons];
  };
  const body = [
    assistant([toolUse("tu1", "Read", { file_path: PROMPT_PATH })]),
    toolResult("tu1", readOutput(PROMPT_TEXT)),
    assistant([{ type: "text", text: FINAL }]),
  ];

  it("依頼文に余計な文が足されていれば無効(部分一致では通さない)", () => {
    const text = [userString(TASK + "\n追加の指示: 結果ファイルも見てください。"), ...body].join("\n");
    expect(reasonsOf(text).some((x) => x.includes("依頼文"))).toBe(true);
  });

  it("依頼文が最初の user メッセージでなく、後から入っているだけなら無効", () => {
    const text = [userString("別の依頼"), userString(TASK), ...body].join("\n");
    expect(reasonsOf(text).some((x) => x.includes("依頼文"))).toBe(true);
  });

  it("isMeta のメッセージが先に来ても、最初の isMeta でない user メッセージが依頼文なら受理する", () => {
    const text = [metaReminder(), userString(TASK), ...body].join("\n");
    expect(extractFinalResponse(text, OPTS).ok).toBe(true);
  });

  it("依頼文が無ければ(user メッセージが isMeta だけ)無効", () => {
    const text = [metaReminder(), ...body].join("\n");
    expect(reasonsOf(text).some((x) => x.includes("依頼文"))).toBe(true);
  });
});

describe("extractFinalResponse: 実行記録のためのメタ情報", () => {
  it("assistant エントリの message.model・agentId・タイムスタンプを機械的に拾う", () => {
    const text = [
      line({ type: "user", agentId: "agent1", timestamp: "2026-10-03T00:00:00.000Z", message: { role: "user", content: TASK } }),
      line({ type: "assistant", agentId: "agent1", timestamp: "2026-10-03T00:00:01.000Z", message: { id: "m1", model: "claude-sonnet-5-5", role: "assistant", content: [toolUse("tu1", "Read", { file_path: PROMPT_PATH })] } }),
      line({ type: "user", agentId: "agent1", timestamp: "2026-10-03T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: readOutput(PROMPT_TEXT) }] } }),
      line({ type: "assistant", agentId: "agent1", timestamp: "2026-10-03T00:00:09.000Z", message: { id: "m2", model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: FINAL }] } }),
    ].join("\n");
    const r = extractFinalResponse(text, OPTS);
    if (!r.ok) throw new Error("前提");
    expect(r.meta.models).toEqual(["claude-sonnet-5-5"]);
    expect(r.meta.agentId).toBe("agent1");
    expect(r.meta.startedAt).toBe("2026-10-03T00:00:00.000Z");
    expect(r.meta.finishedAt).toBe("2026-10-03T00:00:09.000Z");
  });

  it("モデルが複数ならすべて(出現順・重複なし)。無ければ空配列(手書きで補わない)", () => {
    const withModels = [
      userString(TASK),
      line({ type: "assistant", message: { id: "a", model: "m-1", role: "assistant", content: [toolUse("tu1", "Read", { file_path: PROMPT_PATH })] } }),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      line({ type: "assistant", message: { id: "b", model: "m-2", role: "assistant", content: [{ type: "text", text: FINAL }] } }),
      line({ type: "assistant", message: { id: "c", model: "m-1", role: "assistant", content: [{ type: "text", text: "" }] } }),
    ].join("\n");
    const r = extractFinalResponse(withModels, OPTS);
    if (!r.ok) throw new Error("前提");
    expect(r.meta.models).toEqual(["m-1", "m-2"]);
    const none = extractFinalResponse(good(), OPTS);
    if (!none.ok) throw new Error("前提");
    expect(none.meta.models).toEqual([]);
    expect(none.meta.agentId).toBeNull();
  });
});

describe("saveExtractedResponse: 検証を通った応答だけを responses/ に保存する", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function work(): { dir: string; transcript: string; indexPath: string } {
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
    const indexPath = path.join(dir, "index.json");
    writeFileSync(
      indexPath,
      JSON.stringify({ entries: [{ caseId: "case-07", raceId: "202606040801", promptSha256: sha256Hex(PROMPT_TEXT) }] }),
      "utf-8",
    );
    return { dir, transcript, indexPath };
  }

  it("応答本文を responses/case-07.attempt1.txt にそのまま書く", () => {
    const { dir, transcript, indexPath } = work();
    const r = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(r.ok).toBe(true);
    const saved = path.join(dir, "responses", "case-07.attempt1.txt");
    expect(readFileSync(saved, "utf-8")).toBe(FINAL);
  });

  it("無効な応答は何も書かない", () => {
    const { dir, transcript, indexPath } = work();
    writeFileSync(transcript, readFileSync(transcript, "utf-8").replace('"Read"', '"Bash"'), "utf-8");
    const r = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(dir, "responses", "case-07.attempt1.txt"))).toBe(false);
  });

  it("既にある応答は上書きしない(取り直しの選択をさせない)", () => {
    const { dir, transcript, indexPath } = work();
    expect(saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript }).ok).toBe(true);
    const again = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("前提");
    expect(again.reasons.join("\n")).toContain("既に");
  });

  it("attempt 2 は attempt 1 が保存済みのときだけ保存できる", () => {
    const { dir, transcript, indexPath } = work();
    const r2 = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 2, transcriptPath: transcript });
    expect(r2.ok).toBe(false);
    expect(saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript }).ok).toBe(true);
    expect(saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 2, transcriptPath: transcript }).ok).toBe(true);
  });

  it("attempt は 1 か 2 だけ", () => {
    const { dir, transcript, indexPath } = work();
    const r = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 3, transcriptPath: transcript });
    expect(r.ok).toBe(false);
  });

  it("subagent/case-NN.txt の SHA-256 が index.json と食い違えば何も書かない(プロンプトが書き換わっていない保証)", () => {
    const { dir, transcript, indexPath } = work();
    writeFileSync(indexPath, JSON.stringify({ entries: [{ caseId: "case-07", raceId: "202606040801", promptSha256: sha256Hex("別のプロンプト") }] }), "utf-8");
    const r = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("前提");
    expect(r.reasons.join("\n")).toContain("SHA-256");
    expect(existsSync(path.join(dir, "responses", "case-07.attempt1.txt"))).toBe(false);
  });

  it("index.json にケースが無ければ何も書かない", () => {
    const { dir, transcript, indexPath } = work();
    writeFileSync(indexPath, JSON.stringify({ entries: [] }), "utf-8");
    const r = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(dir, "responses", "case-07.attempt1.txt"))).toBe(false);
  });

  it("実行記録(subagent-runs.json)に、有効な応答もモデル ID(message.model から機械的に拾う)つきで追記する", () => {
    const { dir, transcript, indexPath } = work();
    const promptPath = path.join(dir, "subagent", "case-07.txt");
    const jsonl = [
      line({ type: "user", agentId: "ag1", timestamp: "2026-10-03T00:00:00.000Z", message: { role: "user", content: renderSubagentTaskText(promptPath) } }),
      line({ type: "assistant", agentId: "ag1", timestamp: "2026-10-03T00:00:01.000Z", message: { id: "m1", model: "claude-sonnet-5-5", role: "assistant", content: [toolUse("tu1", "Read", { file_path: promptPath })] } }),
      toolResult("tu1", readOutput(PROMPT_TEXT)),
      line({ type: "assistant", agentId: "ag1", timestamp: "2026-10-03T00:00:05.000Z", message: { id: "m2", model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: FINAL }] } }),
    ].join("\n");
    writeFileSync(transcript, jsonl, "utf-8");
    const r = saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript, now: () => new Date("2026-10-03T01:00:00.000Z") });
    expect(r.ok).toBe(true);
    const runs = JSON.parse(readFileSync(path.join(dir, "subagent-runs.json"), "utf-8")) as { runs: Array<Record<string, unknown>> };
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      caseId: "case-07",
      attempt: 1,
      valid: true,
      via: "final-message",
      models: ["claude-sonnet-5-5"],
      agentId: "ag1",
      startedAt: "2026-10-03T00:00:00.000Z",
      finishedAt: "2026-10-03T00:00:05.000Z",
      responseSha256: sha256Hex(FINAL),
      recordedAt: "2026-10-03T01:00:00.000Z",
    });
  });

  it("無効な応答も、理由つきで実行記録に追記する(破棄した件数と理由を残す)。応答ファイルは書かない", () => {
    const { dir, transcript, indexPath } = work();
    writeFileSync(transcript, readFileSync(transcript, "utf-8").replace('"Read"', '"Bash"'), "utf-8");
    expect(saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript }).ok).toBe(false);
    const runs = JSON.parse(readFileSync(path.join(dir, "subagent-runs.json"), "utf-8")) as { runs: Array<{ valid: boolean; reasons: string[] }> };
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.valid).toBe(false);
    expect(runs.runs[0]!.reasons.join("\n")).toContain("Bash");
    expect(existsSync(path.join(dir, "responses", "case-07.attempt1.txt"))).toBe(false);
  });

  it("実行記録は追記され、既存の記録を消さない(無効→有効の順で2件)", () => {
    const { dir, transcript, indexPath } = work();
    const good1 = readFileSync(transcript, "utf-8");
    writeFileSync(transcript, good1.replace('"Read"', '"Bash"'), "utf-8");
    saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript });
    writeFileSync(transcript, good1, "utf-8");
    expect(saveExtractedResponse({ indexPath, workDir: dir, caseId: "case-07", attempt: 1, transcriptPath: transcript }).ok).toBe(true);
    const runs = JSON.parse(readFileSync(path.join(dir, "subagent-runs.json"), "utf-8")) as { runs: Array<{ valid: boolean }> };
    expect(runs.runs.map((x) => x.valid)).toEqual([false, true]);
  });
});
