import { describe, expect, it } from "vitest";
import {
  RESULT_BEGIN_MARKER,
  RESULT_END_MARKER,
  emptyResult,
  extractResultBlock,
  formatResultBlock,
  renderMarkdown,
  type SpikeResult,
} from "../cloudflare-spike/result.js";
import type { SearchResult } from "../cloudflare-spike/cpu-search.js";

/**
 * #159 結果の記録。メイン(オーケストレーター)は Actions のジョブログ本文だけを読める前提のため、
 * 結果 JSON の全文を、前後を印で挟んだ1行でログに出す。
 */

function sampleResult(): SpikeResult {
  const r = emptyResult("12345-1");
  r.netkeiba.records.push({
    targetId: "central-shutuba",
    url: "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211",
    status: 200,
    bodyLength: 276861,
    charset: "UTF-8",
    parsedKind: "shutuba",
    parsedCount: 16,
    parseError: null,
    replacementChars: 0,
    headers: { server: "cloudflare" },
    bodyHead: null,
    error: null,
  });
  r.notes.push("改行を\n含む注記と、日本語と \"引用符\"");
  return r;
}

describe("formatResultBlock", () => {
  it("開始印・JSON1行・終了印のちょうど3行になる(JSON 内の改行はエスケープされる)", () => {
    const block = formatResultBlock(sampleResult());
    const lines = block.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(RESULT_BEGIN_MARKER);
    expect(lines[2]).toBe(RESULT_END_MARKER);
    expect(RESULT_BEGIN_MARKER).toBe("===CF-SPIKE-RESULT-BEGIN===");
    expect(RESULT_END_MARKER).toBe("===CF-SPIKE-RESULT-END===");
  });

  it("中の1行は JSON として元の結果に戻る", () => {
    const original = sampleResult();
    const json = formatResultBlock(original).split("\n")[1]!;
    expect(JSON.parse(json)).toEqual(original);
  });
});

describe("extractResultBlock", () => {
  it("ジョブログの行頭タイムスタンプや前後の他のログ行があっても、結果を取り出せる", () => {
    const original = sampleResult();
    const [b, j, e] = formatResultBlock(original).split("\n") as [string, string, string];
    const log = [
      "2026-10-04T05:30:20.1234567Z ##[group]Run something",
      "2026-10-04T05:30:21.0000000Z hello",
      `2026-10-04T05:30:22.0000000Z ${b}`,
      `2026-10-04T05:30:22.0000001Z ${j}`,
      `2026-10-04T05:30:22.0000002Z ${e}`,
      "2026-10-04T05:30:23.0000000Z ##[endgroup]",
    ].join("\n");
    expect(extractResultBlock(log)).toEqual(original);
  });

  it("先頭に BOM があっても取り出せる", () => {
    const original = sampleResult();
    const log = "﻿" + formatResultBlock(original);
    expect(extractResultBlock(log)).toEqual(original);
  });

  it("結果が複数あれば、最後のものを返す", () => {
    const first = emptyResult("first");
    const last = emptyResult("last");
    const log = `${formatResultBlock(first)}\nmiddle\n${formatResultBlock(last)}\n`;
    expect(extractResultBlock(log)?.runId).toBe("last");
  });

  it("印が無い、終了印が無い、JSON が壊れている場合は null(例外にしない)", () => {
    expect(extractResultBlock("no markers here")).toBeNull();
    expect(extractResultBlock(`${RESULT_BEGIN_MARKER}\n{"runId":"x"}\n`)).toBeNull();
    expect(extractResultBlock(`${RESULT_BEGIN_MARKER}\n{not json\n${RESULT_END_MARKER}`)).toBeNull();
  });
});

describe("renderMarkdown", () => {
  const searchOk: SearchResult = {
    points: [
      { reps: 1, trialsRun: 2, ok: 2, cpuExceeded: 0, otherError: 0, passed: true, elapsedMs: [10, 11] },
      { reps: 2, trialsRun: 1, ok: 0, cpuExceeded: 1, otherError: 0, passed: false, elapsedMs: [12] },
    ],
    maxPassReps: 1,
    minFailReps: 2,
    reachedMax: false,
    stopReason: "converged",
    inconclusive: false,
    totalProbes: 3,
  };

  it("到達性の件数、CPU 探索の maxPassReps/minFailReps、停止理由を本文に出す", () => {
    const r = sampleResult();
    r.cpu.worker.parse = searchOk;
    const md = renderMarkdown(r);
    expect(md).toContain("12345-1");
    expect(md).toContain("race.netkeiba.com");
    expect(md).toMatch(/ok\D+1/);
    expect(md).toContain("maxPassReps");
    expect(md).toContain("minFailReps");
    expect(md).toContain("converged");
  });

  it("未実施の探索や未取得の項目は『未実施』と書く(空欄や undefined を出さない)", () => {
    const md = renderMarkdown(emptyResult("x"));
    expect(md).toContain("未実施");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("null");
  });

  it("探索は Worker・Durable Object それぞれ4種(parse / score / alloc / allocFull)を表に出す(未実施なら8行とも未実施)", () => {
    const md = renderMarkdown(emptyResult("x"));
    const unrun = md.split("\n").filter((l) => l.endsWith("| 未実施 | 未実施 | 未実施 | 未実施 |"));
    expect(unrun).toHaveLength(8);
    for (const work of ["parse", "score", "alloc", "allocFull"]) {
      expect(unrun.filter((l) => l.includes(`| ${work} |`))).toHaveLength(2);
    }
  });

  it("探索で見つからなかった上限(minFailReps=null)と、maxPassReps=null(1回目から失敗)を区別して書く", () => {
    const r = sampleResult();
    r.cpu.worker.alloc = { ...searchOk, maxPassReps: null, minFailReps: 1 };
    r.cpu.durableObject.alloc = { ...searchOk, maxPassReps: 64, minFailReps: null, reachedMax: true, stopReason: "max-reps" };
    const md = renderMarkdown(r);
    expect(md).toContain("通過なし");
    expect(md).toContain("上限未検出");
  });

  it("後片付けの結果(残った Worker)が空でなければ、警告として本文に出す", () => {
    const r = sampleResult();
    r.cleanup = {
      leftoverWorkers: ["keiba-cf-spike-1"],
      deletedByFallback: [],
      durableObjectNamespaces: "unknown",
      ok: false,
    };
    expect(renderMarkdown(r)).toContain("keiba-cf-spike-1");
  });
});
