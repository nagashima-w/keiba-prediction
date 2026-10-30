import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../packages/core/src/scraper/http-client.js";
import { abortMessage } from "../history-results/fetch-lib.js";
import { collectHorseIds, createPedFetchText, parsePedFetchArgs, pedigreeUrl, runPedFetch, type PedFetchOptions } from "../pedigree/fetch-lib.js";
import { errorsFilePath, rawPedPath } from "../pedigree/layout.js";
import { mkPedigreeHtml } from "./pedigree-test-lib.js";

/**
 * Issue #542 手順 2: 血統ページの取得(fetch)のテスト。ネットワークには出ない(偽の fetchText を差し込む)。
 */

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "pedigree-fetch-"));
  dirs.push(d);
  return d;
};

const httpErr = (status: number, url: string) => new HttpError(`HTTPエラー(${status})が発生しました: ${url}`, { url, status });

/** URL → 本文(文字列)または例外の対応表から、偽の fetchText と呼び出しの記録を作る。表に無い URL は 404。 */
function fakeSite(pages: Record<string, string | Error>): { fetchText: (url: string) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchText: async (url: string) => {
      calls.push(url);
      const page = pages[url];
      if (page === undefined) throw httpErr(404, url);
      if (page instanceof Error) throw page;
      return page;
    },
  };
}

const baseOpts = (outDir: string, fetchText: PedFetchOptions["fetchText"], over: Partial<PedFetchOptions> = {}): PedFetchOptions => ({
  outDir,
  horseIds: [],
  fetchText,
  log: () => {},
  ...over,
});

const errorsOf = (out: string): Record<string, any>[] => {
  const f = errorsFilePath(out);
  return existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, any>)
    : [];
};

const idN = (i: number): string => `20200100${String(i).padStart(2, "0")}`;
const urlN = (i: number): string => pedigreeUrl(idN(i));
const pageOf = (id: string): string => mkPedigreeHtml({ horseId: id });

describe("pedigreeUrl / createPedFetchText", () => {
  it("URL は db.netkeiba.com/horse/ped/<馬 ID>/", () => {
    expect(pedigreeUrl("2021105857")).toBe("https://db.netkeiba.com/horse/ped/2021105857/");
  });

  it("EUC-JP の指定でデコードして取る(HttpClient の fetchText に encoding: euc-jp を渡す)", async () => {
    const fetchText = vi.fn(async () => "本文");
    const f = createPedFetchText({ fetchText });
    expect(await f("https://db.netkeiba.com/horse/ped/2021105857/")).toBe("本文");
    expect(fetchText).toHaveBeenCalledWith("https://db.netkeiba.com/horse/ped/2021105857/", { encoding: "euc-jp" });
  });
});

describe("runPedFetch: 取って保存する", () => {
  it("馬 ID の順に、血統のページを db.netkeiba.com へ取りに行き、raw/ped/<ID>.html.gz に UTF-8 の gzip で置く(一時ファイルは残らない)", async () => {
    const out = tmp();
    const ids = [idN(1), idN(2)];
    const site = fakeSite({ [urlN(1)]: pageOf(ids[0]!), [urlN(2)]: pageOf(ids[1]!) });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids }));
    expect(site.calls).toEqual([urlN(1), urlN(2)]);
    expect(stats).toMatchObject({ requests: 2, saved: 2, skippedExisting: 0, errors: 0, aborted: false, restricted: false, limitReached: false });
    expect(gunzipSync(readFileSync(rawPedPath(out, ids[0]!))).toString("utf8")).toBe(pageOf(ids[0]!));
    expect(readdirSync(path.dirname(rawPedPath(out, ids[0]!))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("実物のフィクスチャ(中央の馬・地方所属の馬)は保存される", async () => {
    const out = tmp();
    const site = fakeSite({
      [pedigreeUrl("2021105857")]: fx("pedigree_ped_2021105857.html"),
      [pedigreeUrl("2017106443")]: fx("pedigree_ped_2017106443.html"),
    });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ["2021105857", "2017106443"] }));
    expect(stats.saved).toBe(2);
    expect(existsSync(rawPedPath(out, "2021105857"))).toBe(true);
    expect(existsSync(rawPedPath(out, "2017106443"))).toBe(true);
  });

  it("すでにある raw は取りに行かない(途中から再実行できる)", async () => {
    const out = tmp();
    const ids = [idN(1), idN(2), idN(3)];
    mkdirSync(path.dirname(rawPedPath(out, ids[0]!)), { recursive: true });
    writeFileSync(rawPedPath(out, ids[0]!), gzipSync(pageOf(ids[0]!)));
    const site = fakeSite({ [urlN(2)]: pageOf(ids[1]!), [urlN(3)]: pageOf(ids[2]!) });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids }));
    expect(site.calls).toEqual([urlN(2), urlN(3)]);
    expect(stats).toMatchObject({ requests: 2, saved: 2, skippedExisting: 1 });
  });

  it("--limit は新しく出したリクエストの数(スキップは数えない)。達したら止まり、再実行で続きから取る", async () => {
    const out = tmp();
    const ids = [idN(1), idN(2), idN(3), idN(4)];
    mkdirSync(path.dirname(rawPedPath(out, ids[0]!)), { recursive: true });
    writeFileSync(rawPedPath(out, ids[0]!), gzipSync(pageOf(ids[0]!)));
    const pages = Object.fromEntries(ids.map((id, i) => [urlN(i + 1), pageOf(id)]));
    const site = fakeSite(pages);
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids, limit: 2 }));
    expect(site.calls).toEqual([urlN(2), urlN(3)]);
    expect(stats).toMatchObject({ requests: 2, saved: 2, skippedExisting: 1, limitReached: true });
    expect(existsSync(rawPedPath(out, ids[3]!))).toBe(false);

    const site2 = fakeSite(pages);
    const stats2 = await runPedFetch(baseOpts(out, site2.fetchText, { horseIds: ids, limit: 2 }));
    expect(site2.calls).toEqual([urlN(4)]);
    expect(stats2).toMatchObject({ saved: 1, skippedExisting: 3, limitReached: false });
  });

  it("進捗とまとめをログに出す", async () => {
    const out = tmp();
    const lines: string[] = [];
    const site = fakeSite({ [urlN(1)]: pageOf(idN(1)) });
    await runPedFetch(baseOpts(out, site.fetchText, { horseIds: [idN(1)], log: (m) => lines.push(m) }));
    expect(lines.at(-1)).toMatch(/終了: リクエスト 1・保存 1・取得済みでスキップ 0・エラー 0/);
  });
});

describe("runPedFetch: 保存前の検査(不合格は保存せず、分類つきで errors.ndjson に残す)", () => {
  const run = async (body: string | Error): Promise<{ saved: boolean; errors: Record<string, any>[]; requests: number }> => {
    const out = tmp();
    const id = idN(1);
    const site = fakeSite({ [urlN(1)]: body });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: [id] }));
    return { saved: existsSync(rawPedPath(out, id)), errors: errorsOf(out), requests: stats.requests };
  };

  it("0 バイト(空白のみ)", async () => {
    const r = await run("  \n ");
    expect(r.saved).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ stage: "ped", id: idN(1), url: urlN(1), category: "空" });
  });

  it("文字化け(U+FFFD を含む)", async () => {
    const r = await run(`${pageOf(idN(1))}�`);
    expect(r.saved).toBe(false);
    expect(r.errors[0]).toMatchObject({ category: "文字化け" });
  });

  it("血統表(table.blood_table)が無いページ", async () => {
    const r = await run(mkPedigreeHtml({ horseId: idN(1), noTable: true }));
    expect(r.saved).toBe(false);
    expect(r.errors[0]).toMatchObject({ category: "表なし" });
  });

  it("canonical の馬 ID が要求した ID と違うページ", async () => {
    const r = await run(mkPedigreeHtml({ horseId: idN(1), canonicalId: idN(9) }));
    expect(r.saved).toBe(false);
    expect(r.errors[0]).toMatchObject({ category: "馬ID不一致" });
    expect(String(r.errors[0]!.reason)).toContain(idN(9));
  });

  it("canonical が無いページ", async () => {
    const r = await run(mkPedigreeHtml({ horseId: idN(1), canonicalId: null }));
    expect(r.saved).toBe(false);
    expect(r.errors[0]).toMatchObject({ category: "馬ID不一致" });
  });

  it("実物の「存在しない ID」のページ(HTTP 200・62 個の空のセル・canonical が /horse// )は、canonical で弾いて保存しない", async () => {
    const out = tmp();
    const site = fakeSite({ [pedigreeUrl("2099999999")]: fx("pedigree_ped_2099999999.html") });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ["2099999999"] }));
    expect(stats.saved).toBe(0);
    expect(existsSync(rawPedPath(out, "2099999999"))).toBe(false);
    expect(errorsOf(out)).toHaveLength(1);
    expect(errorsOf(out)[0]).toMatchObject({ stage: "ped", id: "2099999999", category: "馬ID不一致" });
    expect(stats.errors).toBe(1);
  });

  it("セル数が 62 でない・木の形がおかしいページも、取得の検査では弾かず保存する(毎回取り直さないため。扱いは parse の rejects/issues)", async () => {
    const r61 = await run(mkPedigreeHtml({ horseId: idN(1), dropLast: 1 }));
    expect(r61.saved).toBe(true);
    expect(r61.errors).toEqual([]);
    const rSpan = await run(mkPedigreeHtml({ horseId: idN(1), overrides: { s: { rowspan: 8 } } }));
    expect(rSpan.saved).toBe(true);
    expect(rSpan.errors).toEqual([]);
  });

  it("HTTP 404 は制限ではない失敗として errors に残し、保存しない(category は HTTP)", async () => {
    const r = await run(httpErr(404, urlN(1)));
    expect(r.saved).toBe(false);
    expect(r.errors[0]).toMatchObject({ stage: "ped", id: idN(1), category: "HTTP" });
    expect(String(r.errors[0]!.reason)).toContain("HTTPエラー(404)");
  });
});

describe("runPedFetch: アクセスを制限されたらその場で打ち切る(HTTP 400・403・429)", () => {
  for (const status of [400, 403, 429]) {
    it(`HTTP ${status} は 1 件目でも打ち切り、あとは取りに行かない。aborted と restricted を立て、abortMessage は制限の文になる`, async () => {
      const out = tmp();
      const ids = [idN(1), idN(2)];
      const lines: string[] = [];
      const site = fakeSite({ [urlN(1)]: httpErr(status, urlN(1)), [urlN(2)]: pageOf(ids[1]!) });
      const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids, log: (m) => lines.push(m) }));
      expect(site.calls).toEqual([urlN(1)]);
      expect(stats).toMatchObject({ aborted: true, restricted: true, requests: 1, errors: 1 });
      expect(abortMessage(stats)).toContain("アクセスを制限された可能性");
      expect(errorsOf(out)[0]).toMatchObject({ id: idN(1), category: "HTTP" });
      expect(lines.join("\n")).toMatch(new RegExp(`アクセスを制限された可能性.*直近の失敗: .*HTTP ${status}`));
    });
  }

  it("途中で 400 が返ったら、そこで止まり、取れた分は残る。再実行で続きから取る", async () => {
    const out = tmp();
    const ids = [idN(1), idN(2), idN(3)];
    const site = fakeSite({ [urlN(1)]: pageOf(ids[0]!), [urlN(2)]: httpErr(400, urlN(2)), [urlN(3)]: pageOf(ids[2]!) });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids }));
    expect(stats.restricted).toBe(true);
    expect(site.calls).toEqual([urlN(1), urlN(2)]);
    expect(existsSync(rawPedPath(out, ids[0]!))).toBe(true);
    expect(existsSync(rawPedPath(out, ids[2]!))).toBe(false);
    const site2 = fakeSite({ [urlN(2)]: pageOf(ids[1]!), [urlN(3)]: pageOf(ids[2]!) });
    const stats2 = await runPedFetch(baseOpts(out, site2.fetchText, { horseIds: ids }));
    expect(stats2.aborted).toBe(false);
    expect(site2.calls).toEqual([urlN(2), urlN(3)]);
  });

  it("404・5xx は制限とみなさず、連続失敗の数え方になる", async () => {
    const out = tmp();
    const ids = [idN(1), idN(2), idN(3)];
    const site = fakeSite({ [urlN(1)]: httpErr(404, urlN(1)), [urlN(2)]: httpErr(503, urlN(2)), [urlN(3)]: pageOf(ids[2]!) });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids }));
    expect(stats).toMatchObject({ aborted: false, restricted: false, errors: 2, saved: 1 });
  });
});

describe("runPedFetch: 取得の失敗が続いたら打ち切る", () => {
  it("連続 N 件の失敗で打ち切り(既定 20)、理由をログに出す。abortMessage は連続失敗の文。再実行で続きから", async () => {
    const out = tmp();
    const ids = Array.from({ length: 25 }, (_, i) => idN(i + 1));
    const lines: string[] = [];
    const site = fakeSite({}); // 全部 404
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids, log: (m) => lines.push(m) }));
    expect(stats).toMatchObject({ aborted: true, restricted: false, requests: 20, errors: 20 });
    expect(abortMessage(stats)).toContain("連続失敗");
    expect(lines.join("\n")).toContain("連続 20 件の取得失敗のため打ち切ります");
  });

  it("--max-consecutive-failures で上限を変えられる。成功が 1 件あれば数え直す(失敗 2・成功 1・失敗 2 は上限 3 では止まらない)", async () => {
    const out = tmp();
    const ids = [1, 2, 3, 4, 5].map(idN);
    const site = fakeSite({ [urlN(3)]: pageOf(ids[2]!) });
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids, maxConsecutiveFailures: 3 }));
    expect(stats).toMatchObject({ aborted: false, errors: 4, saved: 1 });
    const out2 = tmp();
    const site2 = fakeSite({});
    const stats2 = await runPedFetch(baseOpts(out2, site2.fetchText, { horseIds: ids, maxConsecutiveFailures: 3 }));
    expect(stats2).toMatchObject({ aborted: true, requests: 3 });
  });

  it("保存前の検査の不合格も失敗として数える", async () => {
    const out = tmp();
    const ids = [1, 2, 3, 4].map(idN);
    const site = fakeSite(Object.fromEntries(ids.map((_, i) => [urlN(i + 1), ""])));
    const stats = await runPedFetch(baseOpts(out, site.fetchText, { horseIds: ids, maxConsecutiveFailures: 2 }));
    expect(stats).toMatchObject({ aborted: true, requests: 2, errors: 2 });
  });
});

describe("collectHorseIds: 入力(--races / --ids)から馬の ID の一覧を作る", () => {
  const racesFile = (dir: string, name: string, races: Array<{ date: string; raceId: string; horses: Array<{ horseId: string | null }> }>): string => {
    const f = path.join(dir, name);
    writeFileSync(f, gzipSync(`${races.map((r) => JSON.stringify(r)).join("\n")}\n`));
    return f;
  };

  it("--races は日付の新しい順(同じ日はファイルの順)に、重複を除いて並べる。horseId が null の馬は数えるだけ", () => {
    const dir = tmp();
    const f = racesFile(dir, "r.ndjson.gz", [
      { date: "2021-11-03", raceId: "a", horses: [{ horseId: "2020100001" }, { horseId: "2020100002" }] },
      { date: "2026-10-24", raceId: "b", horses: [{ horseId: "2020100003" }, { horseId: null }, { horseId: "2020100001" }] },
      { date: "2026-10-24", raceId: "c", horses: [{ horseId: "2020100004" }] },
    ]);
    const r = collectHorseIds({ raceFiles: [f], idFiles: [] });
    expect(r.ids).toEqual(["2020100003", "2020100001", "2020100004", "2020100002"]);
    expect(r.nullHorseIds).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual([]);
  });

  it("--ids は 1 行 1 ID。空行と # で始まる行は無視し、前後の空白は取る。--ids が先、--races が後に並ぶ", () => {
    const dir = tmp();
    const ids = path.join(dir, "ids.txt");
    writeFileSync(ids, "# 先頭のコメント\n2020100009\n\n  2020100001  \n");
    const f = racesFile(dir, "r.ndjson.gz", [{ date: "2026-10-24", raceId: "b", horses: [{ horseId: "2020100001" }, { horseId: "2020100005" }] }]);
    const r = collectHorseIds({ raceFiles: [f], idFiles: [ids] });
    expect(r.ids).toEqual(["2020100009", "2020100001", "2020100005"]);
    expect(r.duplicates).toBe(1);
  });

  it("10 桁の英数字でない ID は取らず、invalid に載せる(URL に埋め込むため)", () => {
    const dir = tmp();
    const ids = path.join(dir, "ids.txt");
    writeFileSync(ids, "2020100001\nabc\n2020/100002\n20201000012\n000a011531\n");
    const r = collectHorseIds({ raceFiles: [], idFiles: [ids] });
    expect(r.ids).toEqual(["2020100001", "000a011531"]);
    expect(r.invalid).toEqual(["abc", "2020/100002", "20201000012"]);
  });
});

describe("parsePedFetchArgs", () => {
  it("--out と、--races / --ids(繰り返し可)、--limit・--interval-ms・--max-consecutive-failures", () => {
    const r = parsePedFetchArgs(["--out", "o", "--races", "a.gz", "--races", "b.gz", "--ids", "i.txt", "--limit", "5", "--interval-ms", "3000", "--max-consecutive-failures", "7"]);
    expect(r).toEqual({ ok: true, value: { outDir: "o", raceFiles: ["a.gz", "b.gz"], idFiles: ["i.txt"], limit: 5, intervalMs: 3000, maxConsecutiveFailures: 7 } });
  });

  it("既定の間隔は 10000ms", () => {
    const r = parsePedFetchArgs(["--out", "o", "--ids", "i.txt"]);
    expect(r.ok && r.value.intervalMs).toBe(10000);
  });

  it("--out が無い・入力(--races も --ids も)が無い・間隔が 1500 未満・limit が正の整数でない・知らない引数は拒否", () => {
    expect(parsePedFetchArgs(["--ids", "i"]).ok).toBe(false);
    expect(parsePedFetchArgs(["--out", "o"]).ok).toBe(false);
    expect(parsePedFetchArgs(["--out", "o", "--ids", "i", "--interval-ms", "1499"]).ok).toBe(false);
    expect(parsePedFetchArgs(["--out", "o", "--ids", "i", "--limit", "0"]).ok).toBe(false);
    expect(parsePedFetchArgs(["--out", "o", "--ids", "i", "--max-consecutive-failures", "x"]).ok).toBe(false);
    expect(parsePedFetchArgs(["--out", "o", "--ids", "i", "--x"]).ok).toBe(false);
  });
});
