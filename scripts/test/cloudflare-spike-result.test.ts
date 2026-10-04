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

describe("renderMarkdown: 対照実験・推定・独立性", () => {
  const rec = (targetId: string, source: "worker" | "runner", status: number, parsed = status === 200 ? 16 : null) => ({
    targetId,
    url: `https://race.netkeiba.com/${targetId}`,
    status,
    bodyLength: 0,
    charset: null,
    parsedKind: "shutuba",
    parsedCount: parsed,
    parseError: null,
    replacementChars: null,
    headers: {},
    bodyHead: null,
    error: null,
    source,
  });

  it("到達性の表に送信元の列を出し、Worker とランナーの行を区別する", () => {
    const r = emptyResult("x");
    r.netkeiba.records.push(rec("central-shutuba", "worker", 400), rec("central-shutuba", "runner", 200));
    r.netkeiba.requestCount = 2;
    const md = renderMarkdown(r);
    expect(md).toContain("| 送信元 |");
    expect(md).toMatch(/\| central-shutuba \| worker \| 400 \|/);
    expect(md).toMatch(/\| central-shutuba \| runner \| 200 \|/);
  });

  it("対照の表(同じ対象の Worker とランナー)と、暫定の読みを出す", () => {
    const r = emptyResult("x");
    r.netkeiba.records.push(rec("a", "worker", 400), rec("a", "runner", 200));
    const md = renderMarkdown(r);
    expect(md).toContain("対照");
    expect(md).toContain("worker-only-blocked");
    expect(md).toContain("Cloudflare");
  });

  it("両方拒否された場合の読みは『Cloudflare 固有ではない』", () => {
    const r = emptyResult("x");
    r.netkeiba.records.push(rec("a", "worker", 400), rec("a", "runner", 400));
    const md = renderMarkdown(r);
    expect(md).toContain("both-blocked");
    expect(md).toContain("Cloudflare 固有ではない");
  });

  it("送信元ごとの打ち切り理由を出す", () => {
    const r = emptyResult("x");
    r.netkeiba.records.push(rec("a", "worker", 400));
    r.netkeiba.stoppedBySource = { worker: "consecutive-blocks", runner: null };
    const md = renderMarkdown(r);
    expect(md).toContain("worker: consecutive-blocks");
    expect(md).toContain("runner: なし");
  });

  it("判定不能(network-error など)の対は『拒否』『Cloudflare 固有』と書かず、inconclusive と除外件数を出す", () => {
    const r = emptyResult("x");
    r.netkeiba.records.push(
      { ...rec("a", "worker", 200), status: null, bodyLength: null, parsedCount: null, error: "boom" },
      rec("a", "runner", 200),
    );
    const md = renderMarkdown(r);
    expect(md).toContain("inconclusive");
    expect(md).toMatch(/判定不能の対象 ?1 ?件/);
    expect(md).not.toContain("Cloudflare 固有の疑い");
    expect(md).not.toContain("worker-only-blocked");
  });

  it("対照の読みの文言は、拒否と数える判定(400/403/429・challenge)を明記する", () => {
    const r = emptyResult("x");
    r.netkeiba.records.push(rec("a", "worker", 400), rec("a", "runner", 400));
    const md = renderMarkdown(r);
    expect(md).toMatch(/400\/403\/429/);
    expect(md).toContain("challenge");
  });

  it("推定が単調でない結果(通過 40・超過 34)でも、小さい方から並べて表示する(low > high に見せない)", () => {
    const r = emptyResult("x");
    r.cpu.durableObject.alloc = {
      points: [],
      maxPassReps: 40,
      minFailReps: 34,
      reachedMax: false,
      stopReason: "converged",
      inconclusive: false,
      totalProbes: 10,
    };
    const md = renderMarkdown(r);
    expect(md).toContain("| alloc | 750 〜 882 |");
  });

  it("逆転だけがあり、超過の直後の /ping はすべて 200 のときは、『軽い処理も落ちている』と書かない(境界付近の揺らぎと読む)", () => {
    const r = emptyResult("x");
    r.cpu.samples.push(
      { runtime: "worker", work: "alloc", reps: 1, status: 200, kind: "ok", wallMs: 337, insideMs: 1, afterIoMs: 1, bodyHead: null },
      { runtime: "worker", work: "alloc", reps: 1, status: 503, kind: "cpu-exceeded", wallMs: 20, insideMs: null, afterIoMs: null, bodyHead: null, pingAfter: 200 },
    );
    const md = renderMarkdown(r);
    expect(md).toMatch(/1 ?件中 ?0 ?件/);
    expect(md).toContain("逆転(以前に通過した reps 以下の reps が失敗): 1 件");
    expect(md).not.toContain("軽い処理でも失敗している");
    expect(md).toContain("通過と超過が混在");
  });

  it("maxPassReps=null でも、最初の点で一部の試行が通過していたら『通過なし』だけで済ませず、内訳(通過・超過の回数)を書く", () => {
    const r = emptyResult("x");
    r.cpu.worker.alloc = {
      points: [{ reps: 1, trialsRun: 2, ok: 1, cpuExceeded: 1, otherError: 0, passed: false, interrupted: false, elapsedMs: [337, 20] }],
      maxPassReps: null,
      minFailReps: 1,
      reachedMax: false,
      stopReason: "converged",
      inconclusive: false,
      totalProbes: 2,
    };
    const md = renderMarkdown(r);
    expect(md).toContain("通過なし(reps=1 は 1 回通過・1 回超過)");
  });

  it("maxPassReps=null で、最初の点が1回も通過していなければ、これまでどおり『通過なし』だけ", () => {
    const r = emptyResult("x");
    r.cpu.worker.alloc = {
      points: [{ reps: 1, trialsRun: 1, ok: 0, cpuExceeded: 1, otherError: 0, passed: false, interrupted: false, elapsedMs: [20] }],
      maxPassReps: null,
      minFailReps: 1,
      reachedMax: false,
      stopReason: "converged",
      inconclusive: false,
      totalProbes: 1,
    };
    const md = renderMarkdown(r);
    expect(md).toContain("| Worker | alloc | 通過なし | 1 |");
  });

  const searchDo: SearchResult = {
    points: [],
    maxPassReps: 32,
    minFailReps: 34,
    reachedMax: false,
    stopReason: "converged",
    inconclusive: false,
    totalProbes: 10,
  };

  it("Durable Object の結果に、1回あたりの CPU の推定(30000/34 〜 30000/32 ms)を併記し、30 秒はドキュメントの値で実測ではないと明記する", () => {
    const r = emptyResult("x");
    r.cpu.durableObject.allocFull = searchDo;
    const md = renderMarkdown(r);
    expect(md).toContain("882");
    expect(md).toContain("938");
    expect(md).toMatch(/30 ?秒.*ドキュメント/);
    expect(md).toContain("実測ではない");
  });

  it("推定は Durable Object だけに出す(Worker の行には出さない)", () => {
    const r = emptyResult("x");
    r.cpu.worker.parse = searchDo;
    const md = renderMarkdown(r);
    expect(md).not.toContain("882");
  });

  it("Worker の超過後の /ping が落ちた件数と、逆転の件数を出し、独立でない可能性を注記する", () => {
    const r = emptyResult("x");
    r.cpu.samples.push(
      { runtime: "worker", work: "parse", reps: 8, status: 503, kind: "cpu-exceeded", wallMs: 30, insideMs: null, afterIoMs: null, bodyHead: null, pingAfter: 503 },
      { runtime: "worker", work: "score", reps: 1, status: 503, kind: "cpu-exceeded", wallMs: 20, insideMs: null, afterIoMs: null, bodyHead: null, pingAfter: 503 },
    );
    const md = renderMarkdown(r);
    expect(md).toContain("独立");
    expect(md).toMatch(/2 ?件中 ?2 ?件/);
  });
});

describe("renderMarkdown", () => {
  const searchOk: SearchResult = {
    points: [
      { reps: 1, trialsRun: 2, ok: 2, cpuExceeded: 0, otherError: 0, passed: true, interrupted: false, elapsedMs: [10, 11] },
      { reps: 2, trialsRun: 1, ok: 0, cpuExceeded: 1, otherError: 0, passed: false, interrupted: false, elapsedMs: [12] },
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

  it("Worker の行のラベルは『Worker』(プランを確かめていないので『Free』と書かない)", () => {
    const md = renderMarkdown(emptyResult("x"));
    expect(md).toContain("| Worker | parse |");
    expect(md).not.toContain("Free");
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
