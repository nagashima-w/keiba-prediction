import { deflateSync } from "node:zlib";

/**
 * 過去の馬場の PDF(Issue #769)の合成の見本の組み立て。実物と同じ作りの最小の PDF(Flate の content stream・ToUnicode の CMap・展開しないフォント本体)を作り、
 * 境界・欠落・壊れた入力の検査に使う。実物の PDF の期待値は `jra-baba-past-samples.ts`。
 *  - 日本語の文字は CID(16 進の 2 バイトのグリフ番号)、数値は実物と同じくカーニングで割った文字列(`(8.)-4(4)`)で書く。
 */

/** 1 つの文字列(`x` は左端の座標)。`lit` が真なら数値用の文字列、偽なら CID の文字列。 */
export interface SynthCell {
  readonly x: number;
  readonly text: string;
  readonly lit?: boolean;
}
/** 1 行(同じ y の文字列の集まり)。 */
export interface SynthLine {
  readonly y: number;
  readonly cells: readonly SynthCell[];
}

const utf16be = (ch: string): string => {
  let out = "";
  for (let i = 0; i < ch.length; i++) {
    out += ch.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return out.toUpperCase();
};

export interface BuildOptions {
  /** 真なら、ToUnicode の CMap を入れない。 */
  readonly omitCmap?: boolean;
  /** 真なら、content stream を壊れた Flate にする。 */
  readonly corruptContent?: boolean;
  /** 真なら、content stream に加えて、展開すると上限を超える stream を入れる。 */
  readonly addBomb?: boolean;
  /** 追加の ToUnicode の CMap の本文(爆弾の入力の検査用)。 */
  readonly extraCmap?: string;
  /** 真なら、文字列を 1 つも持たない(content stream が無い)。 */
  readonly noText?: boolean;
}

const stream = (num: number, dict: string, body: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from(`${num} 0 obj\n<<${dict}/Length ${body.length}>>\nstream\n`, "latin1"), Buffer.from(body), Buffer.from("\nendstream\nendobj\n", "latin1")]);

/** 行の並びから PDF のバイト列を作る。 */
export function buildPdf(lines: readonly SynthLine[], options: BuildOptions = {}): Uint8Array {
  const glyphs = new Map<string, number>();
  const gid = (ch: string): number => {
    let id = glyphs.get(ch);
    if (id === undefined) {
      id = 0x1000 + glyphs.size;
      glyphs.set(ch, id);
    }
    return id;
  };
  let content = "";
  for (const line of lines) {
    for (const cell of line.cells) {
      let arr: string;
      if (cell.lit === true) {
        // 最後の 1 字の手前で割る(実物の `(8.)-4(4)` の形)。1 字だけのときは割らない
        arr = cell.text.length >= 2 ? `[(${cell.text.slice(0, -1)})-4(${cell.text.slice(-1)})]` : `[(${cell.text})]`;
      } else {
        arr = `[${[...cell.text].map((c) => `<${gid(c).toString(16).padStart(4, "0").toUpperCase()}>`).join("5")}]`;
      }
      content += `q\nBT\n/F1 10.966 Tf\n1 0 0 1 ${cell.x} ${line.y} Tm\n0 g\n${arr} TJ\nET\nQ\n`;
    }
  }
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n%\xb5\xb5\xb5\xb5\n", "latin1")];
  if (options.noText !== true) {
    const body = options.corruptContent === true ? Buffer.from("これはFlateではない", "utf8") : deflateSync(Buffer.from(content, "latin1"));
    parts.push(stream(1, "/Filter/FlateDecode", body));
  }
  if (options.omitCmap !== true) {
    let cmap = "/CIDInit /ProcSet findresource begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
    const entries = [...glyphs].map(([ch, id]) => `<${id.toString(16).padStart(4, "0").toUpperCase()}> <${utf16be(ch)}>`);
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      cmap += `${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar\n`;
    }
    cmap += "endcmap\nend\n";
    parts.push(stream(2, "/Filter/FlateDecode", deflateSync(Buffer.from(cmap, "latin1"))));
  }
  if (options.extraCmap !== undefined) {
    parts.push(stream(5, "/Filter/FlateDecode", deflateSync(Buffer.from(options.extraCmap, "latin1"))));
  }
  // フォント本体(展開しない。/Length1 で見分ける)
  parts.push(stream(3, "/Filter/FlateDecode/Length1 9", Buffer.from("not-flate!", "latin1")));
  if (options.addBomb === true) {
    parts.push(stream(4, "/Filter/FlateDecode", deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x20))));
  }
  parts.push(Buffer.from("%%EOF\n", "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

export interface SynthBlock {
  /** 見出しの日付の行(例 `（2021年1月29日～31日）`)。 */
  readonly dateText: string;
  /** 曜日の列(例 `["金","土","日"]`)。 */
  readonly weekdays: readonly string[];
  /** 芝のクッション値(列の数だけ)。無ければクッション値の節を作らない。 */
  readonly cushion?: readonly string[];
  /** 含水率(列の数だけ。文字列のまま入れる)。 */
  readonly turfGoal: readonly string[];
  readonly turfCorner4: readonly string[];
  readonly dirtGoal: readonly string[];
  readonly dirtCorner4: readonly string[];
}

/** 2021 以降と同じ並び(クッション値が含水率の前)で行を作る。 */
export function layoutLines(title: string, blocks: readonly SynthBlock[]): SynthLine[] {
  const lines: SynthLine[] = [{ y: 700, cells: [{ x: 40, text: title }] }];
  let y = 680;
  const next = (): number => {
    y -= 12.1;
    return y;
  };
  const values = (vals: readonly string[]): SynthCell[] => vals.map((v, i) => ({ x: 303 + i * 58.26, text: v, lit: true }));
  const header = (b: SynthBlock, withPlace: boolean): SynthLine => ({
    y: next(),
    cells: [...(withPlace ? [{ x: 225, text: "場所" }] : []), ...b.weekdays.map((w, i) => ({ x: 278.75 + i * 58.26, text: `${w}曜日` }))],
  });
  for (const b of blocks) {
    y -= 12;
    lines.push({ y: next(), cells: [{ x: 40, text: `第１日・第２日${b.dateText}` }] });
    if (b.cushion !== undefined) {
      lines.push(header(b, false));
      const cy = next();
      lines.push({ y: cy, cells: [{ x: 90, text: "芝コースクッション値" }, ...values(b.cushion)] });
    }
    lines.push(header(b, true));
    const rows: Array<[string, string, readonly string[]]> = [
      ["芝コース含水率", "ゴール前", b.turfGoal],
      ["（パーセント）", "４コーナー", b.turfCorner4],
      ["ダートコース含水率", "ゴール前", b.dirtGoal],
      ["（パーセント）", "４コーナー", b.dirtCorner4],
    ];
    for (const [label, pos, vals] of rows) {
      const ry = next();
      lines.push({ y: ry, cells: [{ x: 86, text: label }, { x: 215, text: pos }, ...values(vals)] });
    }
  }
  return lines;
}
