import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parsePedigreeHtml, type Ancestor, type PedigreeRecord } from "../pedigree/pedigree-html.js";
import { parsePedParseArgs, runPedParse } from "../pedigree/parse-lib.js";
import { rawPedPath } from "../pedigree/layout.js";
import { mkPedigreeHtml, synthId, synthName } from "./pedigree-test-lib.js";

/**
 * Issue #542 手順 2: 血統ページの解析(parse)のテスト。ネットワークには出ない。
 * 実物のフィクスチャ(`fixtures/pedigree_ped_*.html`。中央の馬・地方所属の馬・存在しない ID)と、位置を一意にした合成ページで確かめる。
 */

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "pedigree-parse-"));
  dirs.push(d);
  return d;
};

const ROLES = ["sire", "dam", "sireSire", "sireDam", "damSire", "damDam"] as const;
const PATH_OF: Record<(typeof ROLES)[number], string> = { sire: "s", dam: "d", sireSire: "ss", sireDam: "sd", damSire: "ds", damDam: "dd" };

function parseOk(html: string, horseId: string): PedigreeRecord {
  const r = parsePedigreeHtml(html, horseId);
  if (!r.ok) throw new Error(`読めるはずのページが読めない: ${r.category} ${r.detail}`);
  return r.record;
}

describe("parsePedigreeHtml: 実物のフィクスチャ", () => {
  it("中央の馬(ウィンターガーデン): 父・母・父の父・父の母・母の父・母の母の名前と ID、国名を取る", () => {
    const rec = parseOk(fx("pedigree_ped_2021105857.html"), "2021105857");
    expect(rec.horseId).toBe("2021105857");
    expect(rec.horseName).toBe("ウィンターガーデン");
    expect(rec.sire).toEqual({ id: "2008103244", name: "リアルインパクト", country: null });
    expect(rec.dam).toEqual({ id: "000a011531", name: "リッチダンサー", country: null });
    expect(rec.sireSire).toEqual({ id: "2002100816", name: "ディープインパクト", country: null });
    expect(rec.sireDam).toEqual({ id: "1994109536", name: "トキオリアリティー", country: null });
    // 外国の馬は「 (米)」の国名を名前から分ける(間はノーブレークスペース)
    expect(rec.damSire).toEqual({ id: "000a002075", name: "Halling", country: "米" });
    // 国名の無い外国の馬の名前も、そのまま取れる
    expect(rec.damDam).toEqual({ id: "000a0114c9", name: "Fairy Flight", country: null });
    expect(rec.issues).toEqual([]);
  });

  it("実物でも 6 人の祖先の ID は互いに異なる(位置の取り違えで同じ人を拾う空振りを防ぐ)", () => {
    const rec = parseOk(fx("pedigree_ped_2021105857.html"), "2021105857");
    const ids = ROLES.map((r) => rec[r].id);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(new Set(ids).size).toBe(6);
  });

  it("地方所属の馬(トップロイヤル・金沢)も同じ表で読める", () => {
    const rec = parseOk(fx("pedigree_ped_2017106443.html"), "2017106443");
    expect(rec.horseName).toBe("トップロイヤル");
    expect(rec.sire).toMatchObject({ id: "2003102205", name: "メイショウサムソン" });
    expect(rec.dam).toMatchObject({ id: "2009100818", name: "ロイヤルシフォン" });
    expect(rec.sireSire).toMatchObject({ id: "000a000d77", name: "オペラハウス" });
    expect(rec.sireDam).toMatchObject({ id: "1997102385", name: "マイヴィヴィアン" });
    expect(rec.damSire).toMatchObject({ id: "2001103114", name: "ダイワメジャー" });
    expect(rec.damDam).toMatchObject({ id: "1996105467", name: "ビツキーロイヤル" });
    expect(rec.issues).toEqual([]);
  });

  it("存在しない ID のページ(HTTP 200・62 個の空のセル・canonical が /horse// )は、馬 ID の不一致で読めない扱いにする", () => {
    const html = fx("pedigree_ped_2099999999.html");
    // 前提: セルは 62 個あるので、セル数の検査では見分けられない。canonical の馬 ID が空であることが手がかり
    expect((html.match(/<td[^>]*class="b_f?ml"/g) ?? []).length).toBe(62);
    const r = parsePedigreeHtml(html, "2099999999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("馬ID不一致");
  });
});

describe("parsePedigreeHtml: 合成ページで位置を確かめる(全セルの名前・ID が互いに異なる)", () => {
  it("6 つの役割が、それぞれ正しい位置のセルを指す(父・母・父の父・父の母・母の父・母の母)", () => {
    const rec = parseOk(mkPedigreeHtml({ horseId: "2020100001", horseName: "合成馬" }), "2020100001");
    expect(rec.horseName).toBe("合成馬");
    for (const role of ROLES) {
      const a: Ancestor = rec[role];
      expect({ role, id: a.id, name: a.name }).toEqual({ role, id: synthId(PATH_OF[role]), name: synthName(PATH_OF[role]) });
    }
    expect(new Set(ROLES.map((r) => rec[r].id)).size).toBe(6);
    expect(rec.issues).toEqual([]);
  });

  it("名前のリンクの後ろにある「血統」「産駒」のリンクは名前・ID に混ざらない", () => {
    // 父・母は 3 代目までの余計なリンクを持つ(合成ページの既定)。先頭の a だけを使う
    const rec = parseOk(mkPedigreeHtml({ horseId: "2020100001" }), "2020100001");
    expect(rec.sire.id).toBe(synthId("s"));
    expect(rec.sire.name).toBe("祖先s");
  });

  it("国名の分離: 末尾の「 (米)」を country に分け、名前の空白・ノーブレークスペース・改行は詰める", () => {
    const html = mkPedigreeHtml({
      horseId: "2020100001",
      overrides: {
        s: { name: "Halo&nbsp;(米)" },
        d: { name: "Lady   Rebecca\n  (英)" },
        ss: { name: "Northern Dancer" },
        ds: { name: "  ディープ&nbsp;インパクト  " },
      },
    });
    const rec = parseOk(html, "2020100001");
    expect(rec.sire).toMatchObject({ name: "Halo", country: "米" });
    expect(rec.dam).toMatchObject({ name: "Lady Rebecca", country: "英" });
    expect(rec.sireSire).toMatchObject({ name: "Northern Dancer", country: null });
    expect(rec.damSire).toMatchObject({ name: "ディープ インパクト", country: null });
  });

  it("母のセルが父系の class(b_ml)になっているページは、読めるが issues に位置と雌雄の食い違いを載せる", () => {
    const rec = parseOk(mkPedigreeHtml({ horseId: "2020100001", overrides: { d: { cls: "b_ml" } } }), "2020100001");
    expect(rec.issues).toEqual(["雌雄の class が位置と食い違う: d(期待 b_fml・実際 b_ml)"]);
    // 位置で取っているので、母は取り違えない
    expect(rec.dam.id).toBe(synthId("d"));
  });

  it("父の名前のリンクが無いページ: 父の ID は null・名前はテキストから取る。理由が issues に載り、母側は落ちない", () => {
    const rec = parseOk(mkPedigreeHtml({ horseId: "2020100001", overrides: { s: { noLink: true, name: "名無しの父" } } }), "2020100001");
    expect(rec.sire).toEqual({ id: null, name: "名無しの父", country: null });
    expect(rec.issues).toEqual(["名前のリンクが無い: s"]);
    expect(rec.dam.id).toBe(synthId("d"));
    expect(rec.damSire.id).toBe(synthId("ds"));
  });

  it("名前もリンクも無い祖先(空のセル)は id・name とも null で、issues に載る", () => {
    const rec = parseOk(mkPedigreeHtml({ horseId: "2020100001", overrides: { dd: { noLink: true, name: "" } } }), "2020100001");
    expect(rec.damDam).toEqual({ id: null, name: null, country: null });
    expect(rec.issues).toEqual(["名前のリンクが無い: dd"]);
  });

  it("名前のリンクが馬のページを指していない(ID が取れない)ときも id は null にして issues に載せる", () => {
    const html = mkPedigreeHtml({ horseId: "2020100001" }).replace(`/horse/${synthId("s")}/">祖先s`, `/other/page.html">祖先s`);
    const rec = parseOk(html, "2020100001");
    expect(rec.sire.id).toBeNull();
    expect(rec.sire.name).toBe("祖先s");
    expect(rec.issues).toEqual(["馬のリンクの形でない: s"]);
  });
});

describe("parsePedigreeHtml: 読めないページは理由の分類つきで返す", () => {
  it("血統表が無いページは「表なし」", () => {
    const r = parsePedigreeHtml(mkPedigreeHtml({ noTable: true }), "2021105857");
    expect(r).toMatchObject({ ok: false, category: "表なし" });
  });

  it("セルが 61 個(祖先が欠けた形)のページは「木の構造不正」で、detail にセル数を書く", () => {
    const r = parsePedigreeHtml(mkPedigreeHtml({ dropLast: 1 }), "2021105857");
    expect(r).toMatchObject({ ok: false, category: "木の構造不正" });
    if (!r.ok) expect(r.detail).toContain("61");
  });

  it("父のセルの rowspan が違う(世代の並びが先行順にならない)ページは「木の構造不正」", () => {
    const r = parsePedigreeHtml(mkPedigreeHtml({ overrides: { s: { rowspan: 8 } } }), "2021105857");
    expect(r).toMatchObject({ ok: false, category: "木の構造不正" });
  });

  it("canonical の馬 ID が要求した ID と違うページは「馬ID不一致」(別の馬のページを取り違えて保存した場合)", () => {
    const r = parsePedigreeHtml(mkPedigreeHtml({ horseId: "2020100001", canonicalId: "2020100002" }), "2020100001");
    expect(r).toMatchObject({ ok: false, category: "馬ID不一致" });
    if (!r.ok) {
      expect(r.detail).toContain("2020100001");
      expect(r.detail).toContain("2020100002");
    }
  });

  it("canonical が無いページも「馬ID不一致」", () => {
    const r = parsePedigreeHtml(mkPedigreeHtml({ canonicalId: null }), "2021105857");
    expect(r).toMatchObject({ ok: false, category: "馬ID不一致" });
  });
});

describe("runPedParse: raw/ped → NDJSON(gzip)", () => {
  function put(dir: string, id: string, content: string | Buffer, gz = true): void {
    const p = rawPedPath(dir, id);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, gz ? gzipSync(content) : content);
  }
  const readOut = (file: string): Record<string, any>[] =>
    gunzipSync(readFileSync(file))
      .toString("utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, any>);
  const readRejects = (file: string): Record<string, any>[] =>
    readFileSync(`${file}.rejects.ndjson`, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, any>);

  it("1 行 1 頭(馬 ID の昇順)。読めなかったものは出力に入れず、理由つきで rejects に残して件数を数える", () => {
    const dir = tmp();
    put(dir, "2021105857", fx("pedigree_ped_2021105857.html"));
    put(dir, "2017106443", fx("pedigree_ped_2017106443.html"));
    put(dir, "2020100003", mkPedigreeHtml({ horseId: "2020100003", noTable: true }));
    put(dir, "2020100004", Buffer.from("gzip ではない"), false);
    put(dir, "2020100005", mkPedigreeHtml({ horseId: "2020100005", overrides: { s: { noLink: true, name: "名無しの父" } } }));
    const out = path.join(dir, "out.ndjson.gz");
    const lines: string[] = [];
    const summary = runPedParse({ dir, outFile: out, log: (m) => lines.push(m) });

    const rows = readOut(out);
    expect(rows.map((r) => r.horseId)).toEqual(["2017106443", "2020100005", "2021105857"]);
    expect(rows[2]).toMatchObject({
      horseId: "2021105857",
      horseName: "ウィンターガーデン",
      sire: { id: "2008103244", name: "リアルインパクト", country: null },
      damSire: { id: "000a002075", name: "Halling", country: "米" },
      issues: [],
    });
    expect(rows[1]!.sire).toEqual({ id: null, name: "名無しの父", country: null });
    expect(rows[1]!.issues).toEqual(["名前のリンクが無い: s"]);

    const rejects = readRejects(out);
    expect(rejects.map((r) => [r.horseId, r.category])).toEqual([
      ["2020100003", "表なし"],
      ["2020100004", "gzip失敗"],
    ]);
    expect(summary).toMatchObject({ total: 5, ok: 3, rejected: 2, rowsWithIssues: 1 });
    expect(summary.rejectedByCategory).toEqual({ 表なし: 1, gzip失敗: 1 });
    expect(lines.join("\n")).toContain("読めた 3");
    expect(lines.join("\n")).toContain("読めない 2");
  });

  it("国名の種類ごとの件数を数える(想定外の値に気づけるように)", () => {
    const dir = tmp();
    put(dir, "2021105857", fx("pedigree_ped_2021105857.html")); // 母の父だけが「米」
    put(dir, "2020100006", mkPedigreeHtml({ horseId: "2020100006", overrides: { s: { name: "A&nbsp;(米)" }, d: { name: "B (英)" } } }));
    const out = path.join(dir, "out.ndjson.gz");
    const summary = runPedParse({ dir, outFile: out, log: () => {} });
    expect(summary.countryCounts).toEqual({ 米: 2, 英: 1 });
  });

  it("raw が 0 件でも、空の出力と空の rejects を書く", () => {
    const dir = tmp();
    const out = path.join(dir, "out.ndjson.gz");
    const summary = runPedParse({ dir, outFile: out, log: () => {} });
    expect(summary).toMatchObject({ total: 0, ok: 0, rejected: 0 });
    expect(readOut(out)).toEqual([]);
    expect(readFileSync(`${out}.rejects.ndjson`, "utf8")).toBe("");
  });

  it("raw のファイル名の馬 ID と canonical が食い違うもの(別の馬のページを取り違えて置いた)は rejects に「馬ID不一致」で残す", () => {
    const dir = tmp();
    put(dir, "2020100007", mkPedigreeHtml({ horseId: "2020100007", canonicalId: "2020100008" }));
    const out = path.join(dir, "out.ndjson.gz");
    runPedParse({ dir, outFile: out, log: () => {} });
    expect(readOut(out)).toEqual([]);
    expect(readRejects(out).map((r) => [r.horseId, r.category])).toEqual([["2020100007", "馬ID不一致"]]);
  });
});

describe("parsePedParseArgs", () => {
  it("ディレクトリ 1 つと --out", () => {
    expect(parsePedParseArgs(["d", "--out", "o.ndjson.gz"])).toEqual({ ok: true, value: { dir: "d", outFile: "o.ndjson.gz" } });
  });
  it("ディレクトリが 0 個・2 個、--out が無い、知らない引数は拒否", () => {
    expect(parsePedParseArgs(["--out", "o"]).ok).toBe(false);
    expect(parsePedParseArgs(["a", "b", "--out", "o"]).ok).toBe(false);
    expect(parsePedParseArgs(["a"]).ok).toBe(false);
    expect(parsePedParseArgs(["a", "--out", "o", "--x"]).ok).toBe(false);
  });
});
