import { describe, expect, it } from "vitest";

import { AUTO_RUN_STARTED_ERROR, classifyAutoRun, type ClassifyInput } from "../src/auto-run-result";

/**
 * Issue #204(#166-C): 自動実行の各レースの結果を、状態(計画の行・pre_race のタスク・自動の印)から一意に読み取る分類器(純関数)。
 * 通知に出すか・どう出すかは #205(D)の持ち分で、ここは「何が起きたか」を決めるだけ。
 */

const task = (over: Partial<NonNullable<ClassifyInput["task"]>> = {}): NonNullable<ClassifyInput["task"]> => ({
  status: "done",
  queuedAt: 1000,
  analysisId: 7,
  detail: "stored",
  error: null,
  ...over,
});
const marker = (over: Partial<NonNullable<ClassifyInput["marker"]>> = {}): NonNullable<ClassifyInput["marker"]> => ({ enqueuedAt: 1000, failReason: null, ...over });

describe("classifyAutoRun(状態 → 結果)", () => {
  const cases: readonly { name: string; input: ClassifyInput; expected: ReturnType<typeof classifyAutoRun> }[] = [
    { name: "planned(期限待ち)→ waiting", input: { planState: "planned", skipReason: null, task: null, marker: null }, expected: { kind: "waiting" } },
    { name: "planned は、pre_race のタスクがあっても(手動で先に走らせた)waiting のまま", input: { planState: "planned", skipReason: null, task: task(), marker: null }, expected: { kind: "waiting" } },
    ...(["no-start-time", "started", "too-late", "cap", "manual"] as const).map((reason) => ({
      name: `skipped(${reason})→ skipped / ${reason}`,
      input: { planState: "skipped", skipReason: reason, task: null, marker: null } as ClassifyInput,
      expected: { kind: "skipped", reason } as const,
    })),
    { name: "skipped で理由が無い(あってはならない行)→ unknown(読み取りは投げない)", input: { planState: "skipped", skipReason: null, task: null, marker: null }, expected: { kind: "skipped", reason: "unknown" } },
    { name: "skipped(manual)は、手動のタスクが done でも skipped(手動のタスクの結果を自動の結果と読まない)", input: { planState: "skipped", skipReason: "manual", task: task(), marker: null }, expected: { kind: "skipped", reason: "manual" } },
    { name: "promoted・自動の印あり・queued → running", input: { planState: "promoted", skipReason: null, task: task({ status: "queued", analysisId: null, detail: null }), marker: marker() }, expected: { kind: "running" } },
    { name: "promoted・自動の印あり・fetched → running", input: { planState: "promoted", skipReason: null, task: task({ status: "fetched", analysisId: null, detail: null }), marker: marker() }, expected: { kind: "running" } },
    { name: "promoted・自動の印あり・done → completed(分析 id と R2 の状態を運ぶ)", input: { planState: "promoted", skipReason: null, task: task(), marker: marker() }, expected: { kind: "completed", analysisId: 7, detail: "stored" } },
    { name: "done で R2 の詳細の保存が失敗していても completed(分析は保存されている)", input: { planState: "promoted", skipReason: null, task: task({ detail: "failed" }), marker: marker() }, expected: { kind: "completed", analysisId: 7, detail: "failed" } },
    ...(["started", "blocked", "fetch-exhausted", "compute-exhausted"] as const).map((reason) => ({
      name: `promoted・failed・印の失敗理由 ${reason} → failed / ${reason}(タスクのエラー文を運ぶ)`,
      input: { planState: "promoted", skipReason: null, task: task({ status: "failed", analysisId: null, detail: null, error: "メッセージ" }), marker: marker({ failReason: reason }) } as ClassifyInput,
      expected: { kind: "failed", reason, message: "メッセージ" } as const,
    })),
    { name: "failed で失敗理由が書かれていない → unknown(読み取りは投げない)", input: { planState: "promoted", skipReason: null, task: task({ status: "failed", analysisId: null, detail: null }), marker: marker() }, expected: { kind: "failed", reason: "unknown", message: null } },
    { name: "promoted で印が無い(手動の再実行が印を消した)→ superseded", input: { planState: "promoted", skipReason: null, task: task(), marker: null }, expected: { kind: "superseded" } },
    { name: "promoted で印の enqueuedAt とタスクの queuedAt が食い違う → superseded(別の実行のタスクを、自動の結果と読まない)", input: { planState: "promoted", skipReason: null, task: task({ queuedAt: 2000 }), marker: marker({ enqueuedAt: 1000 }) }, expected: { kind: "superseded" } },
    { name: "promoted でタスクが無い(あってはならない)→ superseded", input: { planState: "promoted", skipReason: null, task: null, marker: marker() }, expected: { kind: "superseded" } },
  ];
  it.each(cases)("$name", ({ input, expected }) => {
    expect(classifyAutoRun(input)).toEqual(expected);
  });

  it("前提: 表は planned・skipped・promoted の全部の状態と、結果の種類 6 つ(waiting・running・completed・failed・skipped・superseded)を覆っている", () => {
    const kinds = new Set(cases.map((c) => c.expected.kind));
    expect([...kinds].sort()).toEqual(["completed", "failed", "running", "skipped", "superseded", "waiting"]);
    expect(new Set(cases.map((c) => c.input.planState))).toEqual(new Set(["planned", "skipped", "promoted"]));
  });

  it("発走済みの固定のエラー文は、日本語の固定文(板に出す)", () => {
    expect(AUTO_RUN_STARTED_ERROR).toBe("発走済みのため、自動実行しませんでした");
  });
});
