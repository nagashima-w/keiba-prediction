import { describe, expect, it } from "vitest";
import { renderOriginMarkdown } from "../cloudflare-spike/origin-report.js";
import { runOrigin, type OriginResult, type OriginRunDeps } from "../cloudflare-spike/origin-run.js";
import type { OriginStep } from "../cloudflare-spike/origin-plan.js";
import type { EchoFetchResult } from "../cloudflare-spike/echo.js";
import { emptyResult, formatResultBlock, extractResultBlock, renderMarkdown } from "../cloudflare-spike/result.js";

/**
 * #160 結果の Markdown 化(`renderOriginMarkdown`)と、`SpikeResult` への取り込み。
 * 生の値(IP・サブドメイン・Worker 名)が Markdown にも、ジョブログへ出す結果ブロックにも出ないことを確かめる。
 */

const RAW_IP = "198.51.100.9";
const RAW_SUB = "my-sub";
const RAW_WORKER = "keiba-cf-spike-123456-1";

const peet = (headers: string[]): EchoFetchResult => ({
  status: 200,
  bodyText: JSON.stringify({ http_version: "HTTP/1.1", tls: { ja3_hash: "a".repeat(32), ja4: "t13d_same" }, http1: { headers } }),
  responseHeaders: { server: "TrackMe.peet.ws" },
  error: null,
});

function deps(over: { echo?: OriginRunDeps["echo"]; status?: (s: OriginStep) => number } = {}): OriginRunDeps {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    echo:
      over.echo ??
      (async (place) =>
        peet(
          place === "worker"
            ? ["User-Agent: UA", `cf-connecting-ip: ${RAW_IP}`, `cf-worker: ${RAW_SUB}.workers.dev`, "cdn-loop: cloudflare"]
            : ["Host: x", "User-Agent: UA", "accept: */*"],
        )),
    send: async (step) => {
      const status = (over.status ?? ((s: OriginStep) => (s.sourceKey === "worker:fetch" ? 400 : 200)))(step);
      return {
        targetId: step.target.id,
        url: step.target.url,
        status,
        bodyLength: status === 200 ? 1234 : 0,
        charset: "UTF-8",
        parsedKind: step.target.kind,
        parsedCount: status === 200 ? 16 : null,
        parseError: null,
        replacementChars: status === 200 ? 0 : null,
        headers: {},
        bodyHead: null,
        error: null,
      };
    },
    mask: { subdomain: RAW_SUB, workerName: RAW_WORKER },
  };
}

async function sample(over: Parameters<typeof deps>[0] = {}): Promise<OriginResult> {
  return runOrigin(deps(over));
}

describe("renderOriginMarkdown", () => {
  it("見出し・netkeiba へ出した本数・エコーの回数(netkeiba の本数に含めない)を出す", async () => {
    const md = renderOriginMarkdown(await sample()).join("\n");
    expect(md).toContain("## 400 の原因の切り分け");
    expect(md).toMatch(/netkeiba へ出した本数: 6 本/);
    expect(md).toMatch(/エコーへ出した回数.*2/);
  });

  it("E1: 使ったエコー・HTTP バージョン・JA4・Worker にだけ現れたヘッダ(マスク済みの値つき)・ランナーにだけ現れたヘッダ", async () => {
    const md = renderOriginMarkdown(await sample()).join("\n");
    expect(md).toContain("### E1");
    expect(md).toContain("peet");
    expect(md).toContain("t13d_same");
    expect(md).toContain("cf-connecting-ip");
    expect(md).toContain("<ip>");
    expect(md).toContain("cf-worker");
    expect(md).toContain("<subdomain>.workers.dev");
    expect(md).toMatch(/ランナーにだけ現れたヘッダ.*accept/);
  });

  it("E0・E2・E3 の記録を、実験・場所・手段・対象・ステータス・判定つきの表で出す(6行)", async () => {
    const lines = renderOriginMarkdown(await sample()).filter((l) => /^\| E[023] \|/.test(l));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("worker");
    expect(lines[0]).toContain("fetch");
    expect(lines[0]).toContain("400");
    expect(lines[0]).toContain("blocked");
    expect(lines.filter((l) => l.includes("socket"))).toHaveLength(2);
  });

  it("E2: 付けたヘッダ名と、付けなかったヘッダ(理由つき)を出す", async () => {
    const r = await sample({
      echo: async (place) =>
        peet(place === "worker" ? ["User-Agent: UA", `cf-connecting-ip: ${RAW_IP}`, "te: trailers"] : ["Host: x", "User-Agent: UA"]),
    });
    const md = renderOriginMarkdown(r).join("\n");
    expect(md).toContain("### E2");
    expect(md).toContain("cf-connecting-ip");
    expect(md).toMatch(/te.*転送されない/);
  });

  it("E2 を実施しなかった場合は、その理由を出す", async () => {
    const r = await sample({ echo: async () => ({ status: 503, bodyText: "x", responseHeaders: {}, error: null }) });
    const md = renderOriginMarkdown(r).join("\n");
    expect(md).toMatch(/E2.*実施していない/);
  });

  it("E3: ヘッダの導出元(ランナーの観測 / 静的フォールバック)を出す", async () => {
    const a = renderOriginMarkdown(await sample()).join("\n");
    expect(a).toContain("ランナーの観測から導出");
    const b = renderOriginMarkdown(await sample({ echo: async () => ({ status: 503, bodyText: "x", responseHeaders: {}, error: null }) })).join("\n");
    expect(b).toContain("静的フォールバック");
  });

  it("結論の文面と、分離できないものを含む限界を出す", async () => {
    const md = renderOriginMarkdown(await sample()).join("\n");
    expect(md).toContain("### 結論");
    expect(md).toMatch(/fetch に固有/);
    expect(md).toMatch(/分離できない/);
    expect(md).toMatch(/基準.*再現.*(した|はい)/);
  });

  it("エコーが Cloudflare 上にある疑いの警告があれば出す", async () => {
    const r = await sample({
      echo: async (place) => ({ ...peet(place === "worker" ? ["User-Agent: UA", "x-a: 1"] : ["User-Agent: UA"]), responseHeaders: { "cf-ray": "x-IAD" } }),
    });
    expect(renderOriginMarkdown(r).join("\n")).toMatch(/警告.*Cloudflare/);
  });

  it("生の IP・サブドメイン・Worker 名が Markdown のどこにも出ない", async () => {
    const r = await sample({
      echo: async (place) =>
        peet(place === "worker" ? ["User-Agent: UA", `cf-connecting-ip: ${RAW_IP}`, `cf-worker: ${RAW_SUB}.workers.dev`, `x-trace: ${RAW_WORKER}`] : ["User-Agent: UA"]),
    });
    const md = renderOriginMarkdown(r).join("\n");
    for (const raw of [RAW_IP, RAW_SUB, RAW_WORKER]) {
      expect(md).not.toContain(raw);
    }
  });
});

describe("SpikeResult への取り込み", () => {
  it("emptyResult には origin も experiments も無い(#159 の結果 JSON と互換。schemaVersion は 1 のまま)", () => {
    const r = emptyResult("x");
    expect(r.origin).toBeUndefined();
    expect(r.experiments).toBeUndefined();
    expect(r.schemaVersion).toBe(1);
  });

  it("origin を持つ結果の Markdown に、切り分けの節が入る", async () => {
    const r = emptyResult("x");
    r.origin = await sample();
    r.experiments = ["origin"];
    expect(renderMarkdown(r)).toContain("## 400 の原因の切り分け");
  });

  it("origin を持たない結果の Markdown には、切り分けの節が出ない", () => {
    expect(renderMarkdown(emptyResult("x"))).not.toContain("400 の原因の切り分け");
  });

  it("実行した実験を Markdown に出し、選ばなかった到達性・CPU は『選んでいない』と書く(未実施の表を並べない)", () => {
    const r = emptyResult("x");
    r.experiments = ["origin"];
    const md = renderMarkdown(r);
    expect(md).toMatch(/実行した実験: origin/);
    expect(md).toMatch(/到達性.*\n\n.*選んでいない/);
    expect(md).toMatch(/CPU.*\n\n.*選んでいない/);
    expect(md).not.toContain("| Worker | parse |");
  });

  it("experiments が無い(旧形式)の結果の Markdown は、従来どおり CPU の表を出す", () => {
    const md = renderMarkdown(emptyResult("x"));
    expect(md).toContain("| Worker | parse |");
    expect(md).not.toContain("実行した実験");
  });

  it("CPU を選んだ結果には、CPU の表が出る", () => {
    const r = emptyResult("x");
    r.experiments = ["origin", "cpu"];
    expect(renderMarkdown(r)).toContain("| Worker | parse |");
  });

  it("ジョブログへ出す結果ブロックに、生の IP・サブドメイン・Worker 名が出ず、往復で origin が保たれる", async () => {
    const r = emptyResult("x");
    r.origin = await sample({
      echo: async (place) => peet(place === "worker" ? ["User-Agent: UA", `cf-connecting-ip: ${RAW_IP}`, `cf-worker: ${RAW_SUB}.workers.dev`] : ["User-Agent: UA"]),
    });
    const block = formatResultBlock(r);
    for (const raw of [RAW_IP, RAW_SUB, RAW_WORKER]) {
      expect(block).not.toContain(raw);
    }
    expect(block).toContain("<ip>");
    const back = extractResultBlock(block);
    expect(back?.origin?.conclusion).toBe(r.origin.conclusion);
    expect(back?.origin?.records).toHaveLength(6);
  });
});
