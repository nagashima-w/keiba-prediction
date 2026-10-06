import { describe, expect, it } from "vitest";
import { renderSocketMatrixMarkdown } from "../cloudflare-spike/socket-matrix-report.js";
import { runSocketMatrix, type SocketMatrixDeps, type SocketMatrixResult } from "../cloudflare-spike/socket-matrix-run.js";
import { buildSocketMatrixPlan } from "../cloudflare-spike/socket-matrix-plan.js";
import { emptyResult, extractResultBlock, formatResultBlock, renderMarkdown } from "../cloudflare-spike/result.js";
import { demoteHeadings, extractGeneratedBlock, generatedMarkers, replaceGeneratedBlock } from "../cloudflare-spike/report-doc.js";

/**
 * #162 段階1(socket-matrix)の結果の Markdown 化と、`SpikeResult` への取り込み。
 * 生の値(IP・サブドメイン・Worker 名)が Markdown にも、ジョブログへ出す結果ブロックにも出ないことを確かめる。
 * 実測値はまだ無いので、ここでの数値は合成した入力(実測ではない)。
 */

const RAW_SUB = "my-sub";
const RAW_IP = "198.51.100.9";

async function sample(over: { gzipBlocked?: boolean } = {}): Promise<SocketMatrixResult> {
  let now = 1_000_000;
  const deps: SocketMatrixDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    send: async (step) => {
      const blocked = over.gzipBlocked === true && step.variant === "gzip";
      const status = blocked ? 400 : 200;
      const gzip = step.variant === "gzip";
      return {
        record: {
          targetId: step.target.id,
          url: step.target.url,
          status,
          bodyLength: status === 200 ? 5000 : 0,
          charset: "UTF-8",
          parsedKind: step.target.kind,
          parsedCount: status === 200 ? 16 : null,
          parseError: null,
          replacementChars: status === 200 ? 0 : null,
          headers: { server: `${RAW_SUB}.workers.dev`, "cf-ray": "abc123-ATL" },
          bodyHead: null,
          error: status === 200 ? null : `blocked from ${RAW_IP}`,
        },
        meta: {
          status,
          framing: "chunked",
          contentEncoding: gzip && status === 200 ? "gzip" : null,
          receivedBytes: 6000,
          wireBodyBytes: status !== 200 ? 0 : gzip ? 1000 : 5000,
          decodedBytes: status === 200 ? 5000 : 0,
          bodySha256: "0123456789abcdef",
          openedMs: 15,
          firstByteMs: 70,
          totalMs: gzip ? 110 : 150,
        },
        instance: { id: "inst-1", call: 1 },
      };
    },
    subrequestProbe: async (count) => ({ ran: true, requested: count, attempted: count, succeeded: count, firstFailureAt: null, errorKind: null, error: null, httpStatus: null }),
    mask: { subdomain: RAW_SUB, workerName: "keiba-cf-spike-1-1" },
  };
  return runSocketMatrix(deps);
}

describe("renderSocketMatrixMarkdown", () => {
  it("見出し・netkeiba へ出した本数・打ち切りの有無を出す", async () => {
    const md = renderSocketMatrixMarkdown(await sample()).join("\n");
    expect(md).toContain("## DO の中のソケットでの取得(Issue #162 段階1。socket-matrix)");
    expect(md).toMatch(/netkeiba へ出した本数: 9 本/);
    expect(md).toMatch(/打ち切り: なし/);
  });

  it("取得先ごとの表: ステップ・対象・方式・ステータス・本文バイト・パース・判定・DO のインスタンス・時間(3点)を、記録の数だけ並べる", async () => {
    const md = renderSocketMatrixMarkdown(await sample()).join("\n");
    expect(md).toContain("### 取得先ごとの記録");
    for (const step of buildSocketMatrixPlan()) {
      expect(md).toContain(`| ${step.id} |`);
    }
    expect(md).toMatch(/\| S1g \| central-shutuba \| gzip \| 200 \|/);
    const section = md.slice(md.indexOf("### 取得先ごとの記録"), md.indexOf("### gzip の比較"));
    const rows = section.split("\n").filter((l) => /^\| (S1|R1|N1|O1|T1|N2|S1r|S1g|T1g) \|/.test(l));
    expect(rows).toHaveLength(9);
    expect(md).toContain("15 / 70 / 150");
  });

  it("gzip の比較の表: 線上のバイト数・展開後・比率・時間・本文のハッシュ", async () => {
    const md = renderSocketMatrixMarkdown(await sample()).join("\n");
    expect(md).toContain("### gzip の比較(identity との対)");
    expect(md).toMatch(/\| S1g \| S1 \| 200 \/ 200 \| 5000 \/ 1000 \| 5000 \| 0\.2 \|/);
    expect(md).toContain("一致");
  });

  it("再現性の表と、DO の呼び出し試験の結果", async () => {
    const md = renderSocketMatrixMarkdown(await sample()).join("\n");
    expect(md).toContain("### 再現性(同じ URL を間隔を空けて2回)");
    expect(md).toMatch(/\| S1r \| S1 \|/);
    expect(md).toContain("### Worker から DO を繰り返し呼ぶ試験(netkeiba へは出ない)");
    expect(md).toMatch(/60 回すべて成功/);
  });

  it("事実・推測・限界を、別の見出しに分けて出す(事実の欄に推測の言い回しを混ぜない)", async () => {
    const md = renderSocketMatrixMarkdown(await sample()).join("\n");
    const facts = md.slice(md.indexOf("### 事実"), md.indexOf("### 推測"));
    expect(md.indexOf("### 事実")).toBeGreaterThan(0);
    expect(md.indexOf("### 推測")).toBeGreaterThan(md.indexOf("### 事実"));
    expect(md.indexOf("### 限界")).toBeGreaterThan(md.indexOf("### 推測"));
    expect(facts).not.toMatch(/疑い|推測/);
    expect(md).toMatch(/n=1/);
  });

  it("gzip が拒否された実行でも出力できる(比率は - で、拒否が事実の欄に載る)", async () => {
    const md = renderSocketMatrixMarkdown(await sample({ gzipBlocked: true })).join("\n");
    expect(md).toMatch(/\| S1g \| S1 \| 200 \/ 400 \|/);
    expect(md).toContain("S1g: 400");
  });

  it("生の値(IP・サブドメイン)は Markdown に出ない", async () => {
    const md = renderSocketMatrixMarkdown(await sample({ gzipBlocked: true })).join("\n");
    expect(md).not.toContain(RAW_SUB);
    expect(md).not.toContain(RAW_IP);
  });

  it("セル内の | と改行は、表を壊さないようにエスケープされる", async () => {
    const r = await sample();
    const withPipe: SocketMatrixResult = { ...r, records: r.records.map((x, i) => (i === 0 ? { ...x, status: null, error: "a|b\nc" } : x)) };
    const md = renderSocketMatrixMarkdown(withPipe).join("\n");
    expect(md).toContain("a\\|b c");
  });
});

describe("SpikeResult への取り込み", () => {
  it("socketMatrix があれば renderMarkdown に節が出る。なければ出ない(旧形式・他の実験の結果を壊さない)", async () => {
    const r = emptyResult("x");
    expect(renderMarkdown(r)).not.toContain("socket-matrix");
    r.socketMatrix = await sample();
    expect(renderMarkdown(r)).toContain("## DO の中のソケットでの取得");
  });

  it("結果ブロック(ジョブログへ出す1行)の往復で、socketMatrix が壊れない。生の値は出ない", async () => {
    const r = emptyResult("x");
    r.socketMatrix = await sample({ gzipBlocked: true });
    const block = formatResultBlock(r);
    expect(block.split("\n")).toHaveLength(3);
    expect(block).not.toContain(RAW_SUB);
    expect(block).not.toContain(RAW_IP);
    expect(extractResultBlock(block)).toEqual(r);
  });

  it("名前つきの生成節 round4 に、見出しを3段下げて差し込める(report.md の第4ラウンド用。印は名前つきで他の節と衝突しない)", async () => {
    const r = emptyResult("x");
    r.socketMatrix = await sample();
    const markers = generatedMarkers("round4");
    expect(markers.begin).toContain("round4");
    const doc = `前文\n${markers.begin}\nold\n${markers.end}\n後文\n`;
    const generated = demoteHeadings(renderMarkdown(r), 3);
    const updated = replaceGeneratedBlock(doc, generated, "round4");
    expect(updated.startsWith("前文\n")).toBe(true);
    expect(updated.endsWith("後文\n")).toBe(true);
    expect(extractGeneratedBlock(updated, "round4")).toContain("##### DO の中のソケットでの取得");
  });
});
