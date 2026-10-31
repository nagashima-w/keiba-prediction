/**
 * 血統ページ(`db.netkeiba.com/horse/ped/<馬 ID>/`)の解析。Issue #542 手順 2。開発用。ネットワークには出ない。
 *
 * 実測(2026-10-30。フィクスチャ `fixtures/pedigree_ped_*.html`):
 * - `table.blood_table` に 5 代の血統表があり、`td` は 62 個。文書順に先行順(父 → 父の父 → … → 母 → …)で並ぶ。
 * - 世代は rowspan で表される(16 → 1 代、8 → 2 代、4 → 3 代、2 → 4 代、無指定 → 5 代)。
 * - 雌雄は td の class(雄 `b_ml`・雌 `b_fml`)。**父系・母系の別ではなく、その祖先の性別。**
 * - 各セルの先頭の `a` が名前と馬 ID(`/horse/<ID>/`)。2〜3 代目までは後ろに「血統」「産駒」のリンクが続くので、先頭の `a` だけを使う。
 *   祖先の ID は `000a011531` のような英数字 10 桁もある。
 * - 外国の馬は名前の後ろに「 (米)」のように国名が付く(間はノーブレークスペース)。国名の付かない外国の馬もいる。
 * - ページ自身の馬の ID は血統表に出ない。`<link rel="canonical">` で確かめる。**存在しない ID は HTTP 200 で、
 *   62 個の空のセルを持つページが返り、canonical が `/horse//` になる**(セル数では見分けられない)。
 *
 * 位置は CSS の位置指定ではなく、rowspan から世代を決める先行順の木の復元で決める(`expectedCells`)。木の形が想定と違うページは
 * 読まずに理由つきで返す(`木の構造不正`)。取得(fetch)の検査には入れない(恒久的に形が違うページを毎回取り直さないため)。
 */

import * as cheerio from "cheerio";

/** 祖先 1 人。リンクが無ければ id は null。 */
export interface Ancestor {
  readonly id: string | null;
  /** 国名を除いた名前。名前が取れなければ null。 */
  readonly name: string | null;
  /** 名前の後ろの「 (米)」の国名。付いていなければ null(国内の馬も、国名の無い外国の馬も null)。 */
  readonly country: string | null;
}

export interface PedigreeRecord {
  readonly horseId: string;
  readonly horseName: string | null;
  readonly sire: Ancestor;
  readonly dam: Ancestor;
  readonly sireSire: Ancestor;
  readonly sireDam: Ancestor;
  readonly damSire: Ancestor;
  readonly damDam: Ancestor;
  /** 読めたが注意が要る点(リンクが無い・位置と雌雄の class の食い違い等)。無ければ空配列。 */
  readonly issues: readonly string[];
}

export type PedRejectCategory = "表なし" | "木の構造不正" | "馬ID不一致" | "gzip失敗";

export type ParsePedigreeResult =
  | { readonly ok: true; readonly record: PedigreeRecord }
  | { readonly ok: false; readonly category: PedRejectCategory; readonly detail: string };

/** 出力する役割と、その木の中の位置(`s` = 父、`d` = 母を左から並べる)。 */
const ROLE_PATHS = {
  sire: "s",
  dam: "d",
  sireSire: "ss",
  sireDam: "sd",
  damSire: "ds",
  damDam: "dd",
} as const;

/** 5 代の血統表のセル数。 */
const CELL_COUNT = 62;

/** 想定する先行順の 62 セル(位置と、その位置の rowspan。5 代目は rowspan 無指定 = 0)。 */
function expectedCells(): Array<{ path: string; rowspan: number }> {
  const out: Array<{ path: string; rowspan: number }> = [];
  const walk = (prefix: string, depth: number): void => {
    if (depth > 5) return;
    for (const c of ["s", "d"]) {
      const p = prefix + c;
      out.push({ path: p, rowspan: depth <= 4 ? 16 >> (depth - 1) : 0 });
      walk(p, depth + 1);
    }
  };
  walk("", 1);
  return out;
}

const EXPECTED = expectedCells();

/** canonical の馬 ID(`.../horse/<ID>/`)。無い・空なら null。 */
export function canonicalHorseIdOf(html: string): string | null {
  const href = cheerio.load(html)('link[rel="canonical"]').attr("href") ?? "";
  return /\/horse\/([0-9A-Za-z]+)\/?$/.exec(href)?.[1] ?? null;
}

/** `table.blood_table` があるか。 */
export function hasBloodTable(html: string): boolean {
  return cheerio.load(html)("table.blood_table").length > 0;
}

/** 空白(ノーブレークスペース・改行・タブを含む)を 1 つの半角空白に詰めて前後を削る。 */
function squash(s: string): string {
  return s.replace(/[\s ]+/g, " ").trim();
}

/** 表示名を、国名を除いた名前と国名に分ける。 */
function splitCountry(display: string): { name: string | null; country: string | null } {
  const text = squash(display);
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(text);
  if (m !== null && m[1] !== "") return { name: m[1]!, country: m[2]!.trim() };
  return { name: text === "" ? null : text, country: null };
}

/** 馬のリンクの href から ID を取る。馬のページ(`/horse/<10 桁の英数字>/`)でなければ null。 */
function horseIdOfHref(href: string): string | null {
  return /^https?:\/\/db\.netkeiba\.com\/horse\/([0-9A-Za-z]{10})\/?$/.exec(href)?.[1] ?? null;
}

export function parsePedigreeHtml(html: string, horseId: string): ParsePedigreeResult {
  const $ = cheerio.load(html);
  const canonical = canonicalHorseIdOf(html);
  if (canonical !== horseId) {
    return { ok: false, category: "馬ID不一致", detail: `canonical の馬 ID が要求した ID と違います(要求 ${horseId}・canonical ${canonical ?? "なし"})` };
  }
  const tds = $("table.blood_table td").toArray();
  if (tds.length === 0) {
    return { ok: false, category: "表なし", detail: "血統表(table.blood_table)に td がありません" };
  }
  if (tds.length !== CELL_COUNT) {
    return { ok: false, category: "木の構造不正", detail: `セル数が ${tds.length} 個です(5 代の血統表は ${CELL_COUNT} 個)` };
  }
  for (let i = 0; i < CELL_COUNT; i++) {
    const rs = Number($(tds[i]).attr("rowspan") ?? "0");
    if (rs !== EXPECTED[i]!.rowspan) {
      return { ok: false, category: "木の構造不正", detail: `${i + 1} 番目のセル(想定の位置 ${EXPECTED[i]!.path})の rowspan が ${rs} です(想定 ${EXPECTED[i]!.rowspan})` };
    }
  }

  const issues: string[] = [];
  const byPath = new Map<string, cheerio.Cheerio<any>>();
  for (let i = 0; i < CELL_COUNT; i++) {
    const p = EXPECTED[i]!.path;
    byPath.set(p, $(tds[i]));
    const expectedCls = p.endsWith("s") ? "b_ml" : "b_fml";
    const cls = ($(tds[i]).attr("class") ?? "").split(/\s+/).find((c) => c === "b_ml" || c === "b_fml");
    if (cls !== expectedCls) {
      issues.push(`雌雄の class が位置と食い違う: ${p}(期待 ${expectedCls}・実際 ${cls ?? "なし"})`);
    }
  }

  const ancestorAt = (p: string): Ancestor => {
    const cell = byPath.get(p)!;
    const a = cell.find("a").first();
    if (a.length === 0) {
      const { name, country } = splitCountry(cell.find(".parent > div").first().text());
      issues.push(`名前のリンクが無い: ${p}`);
      return { id: null, name, country };
    }
    const { name, country } = splitCountry(a.text());
    const id = horseIdOfHref(a.attr("href") ?? "");
    if (id === null) issues.push(`馬のリンクの形でない: ${p}`);
    return { id, name, country };
  };

  const record: PedigreeRecord = {
    horseId,
    horseName: squash($(".horse_title h1").first().text()) || null,
    sire: ancestorAt(ROLE_PATHS.sire),
    dam: ancestorAt(ROLE_PATHS.dam),
    sireSire: ancestorAt(ROLE_PATHS.sireSire),
    sireDam: ancestorAt(ROLE_PATHS.sireDam),
    damSire: ancestorAt(ROLE_PATHS.damSire),
    damDam: ancestorAt(ROLE_PATHS.damDam),
    issues,
  };
  return { ok: true, record };
}
