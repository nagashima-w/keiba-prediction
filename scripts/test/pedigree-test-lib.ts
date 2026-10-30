/**
 * Issue #542 手順 2: 血統ページのテスト用に、実物と同じ形の血統表(5 代・62 セル)を合成する。
 * セルは文書順に先行順(父 → 父の父 → … → 母)で並び、世代は rowspan(16/8/4/2/無指定)で表す。
 * 各セルの名前・ID は位置から一意に決まる(位置の取り違えを assert で見つけられるように、全セルで互いに異なる)。
 */

export interface SynthCell {
  readonly path: string;
  readonly depth: number;
}

/** 先行順の 62 セル。`s` = 父、`d` = 母。`ss` = 父の父、`sd` = 父の母、`ds` = 母の父、`dd` = 母の母。 */
export function synthCells(): SynthCell[] {
  const out: SynthCell[] = [];
  const walk = (prefix: string, depth: number): void => {
    if (depth > 5) return;
    for (const c of ["s", "d"]) {
      const p = prefix + c;
      out.push({ path: p, depth });
      walk(p, depth + 1);
    }
  };
  walk("", 1);
  return out;
}

/** 位置ごとの既定の名前。 */
export const synthName = (path: string): string => `祖先${path}`;

/** 位置ごとの既定の ID(10 桁の英数字。位置ごとに異なる)。 */
export const synthId = (path: string): string => `00a${[...path].map((c) => (c === "s" ? "1" : "2")).join("").padStart(7, "0")}`;

export interface CellOverride {
  /** 表示名(HTML にそのまま入れる。`&nbsp;` を含めてよい)。 */
  readonly name?: string;
  /** 名前のリンク先の ID。 */
  readonly id?: string;
  /** true なら名前のリンクを付けず、テキストだけにする。 */
  readonly noLink?: boolean;
  /** 雌雄の class を上書きする。 */
  readonly cls?: "b_ml" | "b_fml";
  /** rowspan を上書きする(0 なら属性を付けない)。 */
  readonly rowspan?: number;
}

export interface SynthOptions {
  readonly horseId?: string;
  readonly horseName?: string;
  /** canonical の href の馬 ID。null なら canonical のリンク自体を出さない。 */
  readonly canonicalId?: string | null;
  readonly overrides?: Readonly<Record<string, CellOverride>>;
  /** 末尾からこの数のセルを減らす。 */
  readonly dropLast?: number;
  /** true なら血統表を出さない。 */
  readonly noTable?: boolean;
}

function cellHtml(c: SynthCell, o: CellOverride): string {
  const id = o.id ?? synthId(c.path);
  const name = o.name ?? synthName(c.path);
  const cls = o.cls ?? (c.path.endsWith("s") ? "b_ml" : "b_fml");
  const span = o.rowspan ?? (c.depth <= 4 ? 16 >> (c.depth - 1) : 0);
  const spanAttr = span > 0 ? ` rowspan="${span}"` : "";
  // 実物と同じく、名前のリンクの後ろに「血統」「産駒」のリンクが続く(3 代目までは。先頭の a だけが名前)
  const extra = c.depth <= 3 && o.noLink !== true ? `<br />[<a href="https://db.netkeiba.com/horse/ped/${id}/">血統</a>][<a href="https://db.netkeiba.com/horse/sire/${id}/">産駒</a>]` : "";
  const link = o.noLink === true ? `${name}` : `\n\t\t\t<a href="https://db.netkeiba.com/horse/${id}/">${name}\n\t\t\t</a>`;
  return `<tr><td width="20%"${spanAttr} class="${cls}"><div class="parent"><div>${link}${extra}</div><div>3-l</div></div></td></tr>`;
}

/** 血統ページ(`/horse/ped/<ID>/`)の合成 HTML。 */
export function mkPedigreeHtml(opts: SynthOptions = {}): string {
  const horseId = opts.horseId ?? "2021105857";
  const canonicalId = opts.canonicalId === undefined ? horseId : opts.canonicalId;
  const cells = synthCells();
  const kept = opts.dropLast !== undefined ? cells.slice(0, cells.length - opts.dropLast) : cells;
  const table = opts.noTable === true ? "" : `<table class="blood_table detail" summary="5代血統表">${kept.map((c) => cellHtml(c, opts.overrides?.[c.path] ?? {})).join("")}</table>`;
  const canonical = canonicalId === null ? "" : `<link rel="canonical" href="https://db.netkeiba.com/horse/${canonicalId}/" />`;
  return (
    `<!DOCTYPE html><html><head><title>${opts.horseName ?? "テスト馬"} (Test Horse) | 競走馬データ - netkeiba</title>${canonical}</head>` +
    `<body><h1><a href="https://www.netkeiba.com/"><img alt="netkeiba"></a></h1>` +
    `<div class="db_head_name fc"><div class="horse_title"><h1>${opts.horseName ?? "テスト馬"}</h1></div></div>` +
    `<div class="db_main_deta">${table}</div></body></html>`
  );
}
