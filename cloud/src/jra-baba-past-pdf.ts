/**
 * JRA の「過去の含水率・クッション値」の PDF(開催ごとに 1 本。`https://www.jra.go.jp/keiba/baba/archive/{年}pdf/{場}{回}.pdf`)の読み取り(Issue #769)。
 * **純関数**: ネットワーク・D1・R2・DO に触れない。依存を足さずに読む(Workers の `DecompressionStream` と、この中の小さな読み取りだけ)。
 *
 * ## PDF の形(2018〜2024 の実物 6 本と、#789 の 5 本で確認。見本は `fixtures/jra_baba_past_*.pdf`)
 * Excel が出力した 1 ページの PDF。文字は埋め込まれていて(画像ではない)、content stream の `Tm`(座標)と `TJ`(文字列)から読める。
 *  - 日本語(見出し・ラベル・日付)は CID フォントの 2 バイトのグリフ番号(`<27A8480D>`)で、**サブセットごとに番号が違う**ので、ToUnicode の CMap(`bfchar`・`bfrange`)で文字に戻す。
 *  - 数値は単純なフォントのリテラル文字列で、カーニングで割れている(`(8.)-4(4)` = 8.4)。
 *  - 書式の違い: 2018 は含水率だけで、日付が別行(`2018年7月27日（金）から29日（日）`)。2020 はクッション値の節が含水率の後ろ。2021 以降は前。
 *    2024 は Linearized で、content stream が複数あり(`/Contents[11 0 R …]`)、演算子が stream の境目をまたぐ(連結してから読む)。連休の塊は月曜の列を持つ(4 列)。
 *  - 書式の違い(2022 年までの未読の 5 本。Issue #789): 日付の開始日に「日」が無い(`4月2～4日`)・曜日の列が 2〜4(火水・金土日月)。Microsoft Print To PDF 製は `cm` で y を反転している(`q`・`Q`・`cm` の積を座標に掛ける)。
 *    CubePDF/iText 製は、2 バイトの符号を `(…)` の文字列で書き(ページの Font 辞書が `/Subtype /Type0` のときだけ、2 バイトずつ CMap で戻す。辞書はオブジェクトストリームの中にあるので読む)、1 行の数値を 1 つの TJ にまとめて
 *    TJ の大きな負の調整値(-1000 未満)で区切り、第 2 塊以降のラベルを `TL`・`T*` で描く。誤植 `8..8` は {@link TYPO_NUMBER} のとおり。
 * 読み方は**座標で行に集め、行の文字で意味を決める**(場所に頼らず、節の並びの違いに強くする): 「(2021年1月29日～31日)」の行で塊を始め、曜日の行で列(曜日)を決め、
 * 数値の行はラベル(クッション値・芝/ダートの含水率・ゴール前/4 コーナー)で割り当てる。数値の個数は列の数と**一致**しなければならない(欠けた値を位置で当てない)。
 *
 * ## 測定の時刻は載っていない
 * PDF には日付と曜日の列しかない。JRA の注記: 含水率は原則、金曜は午前・土日の開催日は早朝に測る。クッション値の測定時刻は競馬場の調教時間や天候などで異なり、公表されない。
 * 金曜(開催日でない日)の値も入る(曜日を `weekday` に持つ。開催日かどうかは読み手が決める)。
 *
 * ## 失敗の分類({@link BabaPastFailure})
 * 固定の語だけ。読めない形は**行を 1 つも返さず**、分類を返す(壊れた値を入れない。一部の塊だけ読めた結果も返さない)。投げない。
 */
import { VENUE_BY_TRACK_CODE } from "../../packages/core/src/analysis/venue-codes";

/** 読めなかった理由(固定の語)。 */
export type BabaPastFailure = "not-pdf" | "inflate-failed" | "too-large" | "no-text" | "shape-mismatch";

/** 1 日・1 場の値(PDF の 1 列ぶん)。測定の時刻は持たない。 */
export interface BabaPastRow {
  /** 日付(`YYYYMMDD`)。 */
  readonly kaisaiDate: string;
  /** 曜日の 1 字(金・土・日・月など。PDF の列の見出し)。 */
  readonly weekday: string;
  /** 芝のクッション値。クッション値の節が無い塊(2020-09-11 より前)は null。 */
  readonly cushion: number | null;
  readonly turfGoalMoisture: number;
  readonly turfCorner4Moisture: number;
  readonly dirtGoalMoisture: number;
  readonly dirtCorner4Moisture: number;
}

export type BabaPastPdfResult =
  | {
      readonly ok: true;
      /** 見出しの年(`2021年 第1回東京競馬`)。 */
      readonly year: number;
      readonly kai: number;
      readonly venueName: string;
      /** JRA の場コード(01〜10)。見出しの場名から決める。 */
      readonly venueCode: string;
      readonly rows: readonly BabaPastRow[];
    }
  | { readonly ok: false; readonly result: BabaPastFailure };

/** 入力の上限(実物は 35〜45KB)。 */
export const BABA_PAST_MAX_PDF_BYTES = 1024 * 1024;
/** 1 つの stream を展開した大きさの上限(実物の content stream は 約 22KB)。 */
const MAX_STREAM_OUT = 1024 * 1024;
/** 展開した大きさの合計の上限。 */
const MAX_TOTAL_OUT = 4 * 1024 * 1024;

const CUSHION_RANGE = [0, 20] as const;
const MOISTURE_RANGE = [0, 100] as const;
/** 同じ行とみなす y の差。実物の行間は約 12。 */
const ROW_TOLERANCE = 2;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const CODE_BY_VENUE_NAME: ReadonlyMap<string, string> = new Map([...VENUE_BY_TRACK_CODE].map(([code, name]) => [name, code]));

class PastFail extends Error {
  readonly result: BabaPastFailure;
  constructor(result: BabaPastFailure) {
    super(result);
    this.result = result;
  }
}
const fail = (result: BabaPastFailure): never => {
  throw new PastFail(result);
};

/** 1 バイト = 1 文字(位置を保つ)。 */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return out;
}

/** Flate(zlib)を展開する。上限を超えたら "too-large"、壊れていれば null。 */
async function inflate(data: Uint8Array, cap: number): Promise<Uint8Array | "too-large" | null> {
  try {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    const reader = source.pipeThrough(new DecompressionStream("deflate")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        return "too-large";
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  } catch {
    return null;
  }
}

interface PdfStream {
  readonly objNum: number;
  readonly text: string;
}

/** PDF から、読む対象の stream を展開して返す(フォント本体・画像・XRef・ObjStm・メタデータは展開しない)。 */
async function extractStreams(bytes: Uint8Array): Promise<{ streams: PdfStream[]; contentsOrder: number[] | null; objects: Map<number, string> }> {
  const raw = latin1(bytes);
  const streams: PdfStream[] = [];
  const objects = collectPlainObjects(raw);
  let totalOut = 0;
  const marker = />>\s*stream(\r\n|\n)/g;
  for (let m = marker.exec(raw); m !== null; m = marker.exec(raw)) {
    const objAt = raw.lastIndexOf(" obj", m.index);
    if (objAt < 0) continue;
    const head = raw.slice(Math.max(0, raw.lastIndexOf("\n", objAt - 1) + 1), m.index);
    const dict = head;
    const numMatch = /(\d+) 0 obj/.exec(dict);
    const objNum = numMatch === null ? -1 : Number(numMatch[1]);
    const start = m.index + m[0].length;
    const lenMatch = /\/Length (\d+)(?!\d)(?!\s+\d+\s+R)/.exec(dict);
    let end = -1;
    if (lenMatch !== null) {
      const candidate = start + Number(lenMatch[1]);
      const at = raw.indexOf("endstream", candidate);
      if (at >= 0 && at - candidate <= 2) end = candidate;
    }
    if (end < 0) {
      const at = raw.indexOf("endstream", start);
      if (at < 0) continue;
      end = at;
      if (raw[end - 1] === "\n") end--;
      if (raw[end - 1] === "\r") end--;
    }
    marker.lastIndex = Math.max(marker.lastIndex, end);
    if (/\/Type\s*\/ObjStm/.test(dict) && !/\/Length1/.test(dict)) {
      // オブジェクトストリーム: 中の辞書(フォントの種類を引くため)だけを読む。展開できなくても止めない(読む材料が減るだけ)
      if (/\/Filter\s*(?:\[\s*)?\/FlateDecode/.test(dict)) {
        const out = await inflate(bytes.subarray(start, end), MAX_STREAM_OUT);
        if (out === "too-large") return fail("too-large");
        if (out !== null) {
          totalOut += out.length;
          if (totalOut > MAX_TOTAL_OUT) return fail("too-large");
          readObjectStream(latin1(out), Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? "-1"), Number(/\/N\s+(\d+)/.exec(dict)?.[1] ?? "0"), objects);
        }
      }
      continue;
    }
    if (/\/Length1|\/Type\s*\/(?:XRef|Metadata)|\/Subtype\s*\/(?:Image|XML)/.test(dict)) continue;
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
    let body = bytes.subarray(start, end);
    if (filter !== null) {
      if (filter[1] !== "/FlateDecode" && filter[1] !== "[/FlateDecode]") continue;
      const out = await inflate(body, MAX_STREAM_OUT);
      if (out === "too-large") return fail("too-large");
      if (out === null) return fail("inflate-failed");
      totalOut += out.length;
      if (totalOut > MAX_TOTAL_OUT) return fail("too-large");
      body = out;
    }
    streams.push({ objNum, text: latin1(body) });
  }
  // ページの /Contents(1 本または配列)の順で並べる(演算子が stream の境目をまたぐので、連結の順が要る)
  let contentsOrder: number[] | null = null;
  const arr = /\/Contents\s*\[([^\]]*)\]/.exec(raw);
  const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(raw);
  if (arr !== null) {
    contentsOrder = [...arr[1]!.matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
  } else if (single !== null) {
    contentsOrder = [Number(single[1])];
  }
  return { streams, contentsOrder, objects };
}

/** ストリームでないオブジェクト(`12 0 obj << … >> endobj`)の本文を、番号で引ける表にする。ストリームのオブジェクトは辞書の部分だけ。 */
function collectPlainObjects(raw: string): Map<number, string> {
  const objects = new Map<number, string>();
  const re = /(?:^|[\r\n\s])(\d+)\s+0\s+obj\b/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const from = m.index + m[0].length;
    const stop = /endobj|stream[\r\n]/.exec(raw.slice(from, from + 20_000));
    if (stop === null) continue;
    const body = raw.slice(from, from + stop.index).trim();
    if (!objects.has(Number(m[1]))) objects.set(Number(m[1]), body);
    re.lastIndex = from;
  }
  return objects;
}

/** オブジェクトストリームの本文(先頭に「番号 位置」の組が N 個、`First` から本体)を、番号で引ける表に足す。 */
function readObjectStream(text: string, first: number, count: number, objects: Map<number, string>): void {
  if (first < 0 || count <= 0 || count > 10_000) return;
  const head = text.slice(0, first).trim().split(/\s+/).map(Number);
  for (let k = 0; k < count && 2 * k + 1 < head.length; k++) {
    const num = head[2 * k]!;
    const at = head[2 * k + 1]!;
    const next = 2 * k + 3 < head.length ? head[2 * k + 3]! : text.length - first;
    if (!Number.isInteger(num) || !Number.isInteger(at) || !Number.isInteger(next) || at < 0 || next < at) continue;
    if (!objects.has(num)) objects.set(num, text.slice(first + at, first + next).trim());
  }
}

/** 辞書の本文から、キーの値(`<< … >>` の入れ子つきの本文か、参照先のオブジェクトの本文)を取り出す。無ければ null。 */
function dictValue(dict: string, key: string, objects: ReadonlyMap<number, string>): string | null {
  const m = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`).exec(dict);
  if (m === null) return null;
  const at = m.index + m[0].length;
  if (dict.startsWith("<<", at)) {
    let depth = 0;
    for (let i = at; i < dict.length - 1; i++) {
      if (dict.startsWith("<<", i)) {
        depth++;
        i++;
      } else if (dict.startsWith(">>", i)) {
        depth--;
        i++;
        if (depth === 0) return dict.slice(at, i + 1);
      }
    }
    return null;
  }
  const ref = /^(\d+)\s+\d+\s+R/.exec(dict.slice(at, at + 24));
  return ref === null ? null : (objects.get(Number(ref[1])) ?? null);
}

/**
 * ページの `/Resources` の `/Font` から、フォントの名前(`Tf` で使う `/F1` など)ごとに、2 バイトの符号を使う複合フォント(`/Subtype /Type0`)かを調べる。
 * 複合フォントのときだけ、`(…)` の文字列を 2 バイトずつ CMap で文字に戻す(CubePDF/iText 製の PDF は 2 バイトの符号を `(…)` で書く)。単純フォントの文字列は今までどおり 1 バイト = 1 文字。
 * 辞書をたどれなかったときは空の表(= 単純フォントとして読む。今までの動き)。
 */
function readFontKinds(objects: ReadonlyMap<number, string>): Map<string, boolean> {
  const kinds = new Map<string, boolean>();
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Page(?![A-Za-z])/.test(body) || !/\/Resources/.test(body)) continue;
    const fonts = dictValue(dictValue(body, "Resources", objects) ?? "", "Font", objects);
    if (fonts === null) continue;
    for (const f of fonts.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      kinds.set(f[1]!, /\/Subtype\s*\/Type0(?![A-Za-z0-9])/.test(objects.get(Number(f[2])) ?? ""));
    }
    break;
  }
  return kinds;
}

/** CMap 全体(PDF 1 本)の項目数と、文字の数(範囲の幅の合計)の上限。実物の CMap は 39〜43 項目・52〜59 文字(`fixtures/jra_baba_past_*.pdf` 6 本)で、その約 100 倍。 */
const MAX_CMAP_ENTRIES = 5_000;
const MAX_CMAP_CODES = 10_000;

/** ToUnicode の CMap(`bfchar`・`bfrange`)を、グリフ番号 → 文字の表にする。`budget` は PDF 全体で共有する残りの項目数と文字数(上限を超えたら too-large)。 */
function parseCMap(text: string, budget: { entries: number; codes: number }, map: Map<number, string>): Map<number, string> {
  const spend = (entries: number, codes: number): void => {
    budget.entries -= entries;
    budget.codes -= codes;
    if (budget.entries < 0 || budget.codes < 0) fail("too-large");
  };
  const toStr = (hex: string): string => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  for (const sec of text.matchAll(/begin(bfchar|bfrange)([\s\S]*?)end\1/g)) {
    const tokens = [...sec[2]!.matchAll(/<([0-9A-Fa-f]+)>|(\[)|(\])/g)];
    let i = 0;
    while (i < tokens.length) {
      const a = tokens[i]!;
      if (a[1] === undefined) {
        i++;
        continue;
      }
      if (sec[1] === "bfchar") {
        const b = tokens[i + 1];
        if (b === undefined || b[1] === undefined) break;
        spend(1, 1);
        map.set(parseInt(a[1], 16), toStr(b[1]));
        i += 2;
        continue;
      }
      const hi = tokens[i + 1];
      const dst = tokens[i + 2];
      if (hi === undefined || hi[1] === undefined || dst === undefined) break;
      const lo = parseInt(a[1], 16);
      const high = parseInt(hi[1], 16);
      spend(1, high >= lo ? high - lo + 1 : 0);
      if (dst[2] !== undefined) {
        // 配列の形 `<lo> <hi> [<d1> <d2> …]`
        let j = i + 3;
        let code = lo;
        while (j < tokens.length && tokens[j]![3] === undefined) {
          const t = tokens[j]![1];
          if (t !== undefined && code <= high) map.set(code++, toStr(t));
          j++;
        }
        i = j + 1;
      } else if (dst[1] !== undefined) {
        const base = toStr(dst[1]);
        if (high >= lo && high - lo < 0x10000 && base.length > 0) {
          for (let code = lo; code <= high; code++) {
            map.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (code - lo)));
          }
        }
        i += 3;
      } else {
        i++;
      }
    }
  }
  return map;
}

interface TextItem {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/** TJ の配列の中の、これ以下の調整値(1000 分の 1 em。大きな負 = 大きな空き)は、別の項目の区切りとみなす。通常の字詰めは約 -2、実物の項目の区切りは -2000 台以下。 */
const TJ_ITEM_GAP = -1000;
/** 1 つの TJ から取り出した項目の区切りの印(文字列の中に現れない制御文字)。 */
const ITEM_BREAK = "\u0001";
/** 同じ TJ から取り出した項目の x を、並びの順を保つだけのわずかな差で離す。 */
const ITEM_X_STEP = 0.001;

/**
 * content stream から、座標つきの文字列を取り出す(`q`・`Q`・`cm`・`BT`・`Tf`・`Tm`・`Td`・`TD`・`TL`・`T*`・`TJ`・`Tj`)。
 * 座標は、`cm` の積(拡大・縮小と平行移動だけ。回転・せん断は無視)を掛けた先の座標。Print To PDF 製は `0.75 0 0 -0.75 0 841.92 cm` で y を反転しているので、これを掛けないと行の並びが上下逆になる。
 * `fontKinds` は {@link readFontKinds}(Tf の名前 → 複合フォントか)。
 */
function readTextItems(content: string, glyphs: ReadonlyMap<number, string>, fontKinds: ReadonlyMap<string, boolean>): TextItem[] {
  const items: TextItem[] = [];
  const isSpace = (c: string): boolean => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
  const isDelim = (c: string): boolean => "()<>[]{}/%".includes(c);
  type Operand = number | string | { readonly arr: readonly string[] };
  let stack: Operand[] = [];
  // テキストの行の行列(Tm・Td の結果。a・d は拡大、e・f は位置)
  let tlm = { a: 1, d: 1, e: 0, f: 0 };
  let leading = 0;
  // 現在の変換行列(cm の積)と、q で積んだ控え
  type Ctm = { readonly a: number; readonly d: number; readonly e: number; readonly f: number };
  let ctm: Ctm = { a: 1, d: 1, e: 0, f: 0 };
  const ctmStack: Ctm[] = [];
  let compositeFont = false;
  const decodeCodes = (s: string): string => {
    let out = "";
    for (let k = 0; k < s.length; k += 2) out += glyphs.get((s.charCodeAt(k) << 8) | (k + 1 < s.length ? s.charCodeAt(k + 1) : 0)) ?? "�";
    return out;
  };
  const literal = (s: string): string => (compositeFont ? decodeCodes(s) : s);
  const decodeHex = (hex: string): string => {
    const h = hex.replace(/\s+/g, "");
    let out = "";
    for (let i = 0; i < h.length; i += 4) {
      const code = parseInt(h.slice(i, i + 4).padEnd(4, "0"), 16);
      out += glyphs.get(code) ?? "�";
    }
    return out;
  };
  const readLiteral = (from: number): { text: string; next: number } => {
    let depth = 1;
    let out = "";
    let i = from;
    while (i < content.length && depth > 0) {
      const c = content[i]!;
      if (c === "\\") {
        const n = content[i + 1] ?? "";
        const oct = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4));
        if (oct !== null) {
          out += String.fromCharCode(parseInt(oct[0], 8));
          i += 1 + oct[0].length;
          continue;
        }
        const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        out += esc[n] ?? n;
        i += 2;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      out += c;
      i++;
    }
    return { text: out, next: i };
  };
  const emit = (s: string): void => {
    s.split(ITEM_BREAK).filter((piece) => piece.length > 0).forEach((piece, k) => {
      items.push({ x: ctm.a * tlm.e + ctm.e + k * ITEM_X_STEP, y: ctm.d * tlm.f + ctm.f, text: piece });
    });
  };
  const moveLine = (tx: number, ty: number): void => {
    tlm = { ...tlm, e: tlm.e + tx * tlm.a, f: tlm.f + ty * tlm.d };
  };
  const nums = (): number[] => stack.filter((o): o is number => typeof o === "number");

  let i = 0;
  while (i < content.length) {
    const c = content[i]!;
    if (isSpace(c)) {
      i++;
    } else if (c === "%") {
      while (i < content.length && content[i] !== "\n" && content[i] !== "\r") i++;
    } else if (c === "<" && content[i + 1] === "<") {
      const close = content.indexOf(">>", i + 2);
      i = close < 0 ? content.length : close + 2;
    } else if (c === "<") {
      const close = content.indexOf(">", i + 1);
      if (close < 0) break;
      stack.push(`H${content.slice(i + 1, close)}`);
      i = close + 1;
    } else if (c === "(") {
      const lit = readLiteral(i + 1);
      stack.push(`L${literal(lit.text)}`);
      i = lit.next;
    } else if (c === "[") {
      const parts: string[] = [];
      i++;
      while (i < content.length && content[i] !== "]") {
        const d = content[i]!;
        if (d === "<") {
          const close = content.indexOf(">", i + 1);
          if (close < 0) {
            i = content.length;
            break;
          }
          parts.push(decodeHex(content.slice(i + 1, close)));
          i = close + 1;
        } else if (d === "(") {
          const lit = readLiteral(i + 1);
          parts.push(literal(lit.text));
          i = lit.next;
        } else {
          const num = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(content.slice(i, i + 32));
          if (num !== null) {
            if (Number(num[0]) < TJ_ITEM_GAP) parts.push(ITEM_BREAK);
            i += num[0].length;
          } else {
            i++;
          }
        }
      }
      i++;
      stack.push({ arr: parts });
    } else if (c === "/") {
      i++;
      const nameFrom = i;
      while (i < content.length && !isSpace(content[i]!) && !isDelim(content[i]!)) i++;
      stack.push(`N${content.slice(nameFrom, i)}`);
    } else {
      let j = i;
      while (j < content.length && !isSpace(content[j]!) && !isDelim(content[j]!)) j++;
      const word = content.slice(i, j);
      i = j === i ? i + 1 : j;
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
        stack.push(Number(word));
        continue;
      }
      switch (word) {
        case "q":
          ctmStack.push(ctm);
          break;
        case "Q":
          ctm = ctmStack.pop() ?? ctm;
          break;
        case "cm": {
          const n = nums();
          if (n.length >= 6) {
            const [a, , , d, e, f] = n.slice(-6) as [number, number, number, number, number, number];
            // 新しい行列を、今の行列の前に掛ける(拡大・縮小と平行移動だけ)
            ctm = { a: a * ctm.a, d: d * ctm.d, e: e * ctm.a + ctm.e, f: f * ctm.d + ctm.f };
          }
          break;
        }
        case "BT":
          tlm = { a: 1, d: 1, e: 0, f: 0 };
          break;
        case "Tf": {
          const name = [...stack].reverse().find((o): o is string => typeof o === "string" && o.startsWith("N"));
          compositeFont = name !== undefined && fontKinds.get(name.slice(1)) === true;
          break;
        }
        case "TL": {
          const n = nums();
          if (n.length >= 1) leading = n[n.length - 1]!;
          break;
        }
        case "T*":
          moveLine(0, -leading);
          break;
        case "Tm": {
          const n = nums();
          if (n.length >= 6) tlm = { a: n[n.length - 6]!, d: n[n.length - 3]!, e: n[n.length - 2]!, f: n[n.length - 1]! };
          break;
        }
        case "Td":
        case "TD": {
          const n = nums();
          if (n.length >= 2) {
            if (word === "TD") leading = -n[n.length - 1]!;
            moveLine(n[n.length - 2]!, n[n.length - 1]!);
          }
          break;
        }
        case "TJ": {
          const top = stack[stack.length - 1];
          if (typeof top === "object") emit(top.arr.join(""));
          break;
        }
        case "Tj": {
          const top = stack[stack.length - 1];
          if (typeof top === "string" && top.startsWith("H")) emit(decodeHex(top.slice(1)));
          else if (typeof top === "string" && top.startsWith("L")) emit(top.slice(1));
          break;
        }
        default:
          break;
      }
      stack = [];
    }
  }
  return items;
}

interface Cluster {
  readonly y: number;
  readonly items: readonly TextItem[];
}

/** y が近い文字列を 1 行に集める(上から下へ。行の中は x の昇順)。 */
function clusterRows(items: readonly TextItem[]): Cluster[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const out: TextItem[][] = [];
  let currentY = Number.NaN;
  for (const it of sorted) {
    if (out.length > 0 && Math.abs(currentY - it.y) <= ROW_TOLERANCE) {
      out[out.length - 1]!.push(it);
    } else {
      out.push([it]);
      currentY = it.y;
    }
  }
  return out.map((row) => ({ y: row[0]!.y, items: [...row].sort((a, b) => a.x - b.x) }));
}

const norm = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "");

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);
function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(utc(y, m, d));
  return m >= 1 && m <= 12 && d >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const ymd = (ms: number): string => {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
};

type RowKey = "turfGoal" | "turfCorner4" | "dirtGoal" | "dirtCorner4" | "cushion";

interface Block {
  readonly dates: readonly number[];
  weekdays: readonly string[] | null;
  readonly values: Partial<Record<RowKey, readonly number[]>>;
}

function inRange(v: number, [lo, hi]: readonly [number, number]): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

// 開始日の「日」は省ける(2021 阪神 2 回の「4月2～4日」)。終わりの日は「日」が要る。
const DATE_RANGE = /(\d{4})年(\d{1,2})月(\d{1,2})日?(?:\(.\))?(?:~|〜|から)(?:(\d{1,2})月)?(\d{1,2})日(?:\(.\))?/;
const TITLE = /(\d{4})年第(\d+)回(.+?)競馬/;
const NUMBER = /^\d{1,3}\.\d$/;
/**
 * PDF の誤植の形(小数点が 2 つ: `8..8`)。2022 阪神 1 回の第 5・6 日の芝ゴール前の金曜(実物 `fixtures/jra_baba_past_2022_hanshin01.pdf`)にだけある。
 * **ユーザーの決定(2026-11-22): 8.8 として読む**(余分な小数点を 1 つ落とした値)。その行の隣の値は 9.1・8.7 で、8.8 はそれと並んで不自然でない。
 * 読むのは、**PDF 全体でこの形がちょうど 1 つ**のときだけ。2 つ以上あれば、直さずに(数が合わなくなって)shape-mismatch にする。壊れたセルがほかにもある PDF を、推測で埋めて通さない。
 */
const TYPO_NUMBER = /^\d{1,3}\.\.\d$/;

function readBlocks(clusters: readonly Cluster[]): { year: number; kai: number; venueName: string; blocks: Block[] } {
  let title: { year: number; kai: number; venueName: string } | null = null;
  const blocks: Block[] = [];
  const blockYears: number[] = [];
  let block: Block | null = null;
  let surface: "turf" | "dirt" | null = null;
  const fixTypo = clusters.reduce((n, cl) => n + cl.items.filter((it) => TYPO_NUMBER.test(norm(it.text))).length, 0) === 1;
  const isNumber = (it: TextItem): boolean => NUMBER.test(norm(it.text)) || (fixTypo && TYPO_NUMBER.test(norm(it.text)));
  for (const cl of clusters) {
    const numbers = cl.items.filter(isNumber);
    const labels = norm(cl.items.filter((it) => !isNumber(it)).map((it) => it.text).join(""));
    if (numbers.length === 0) {
      const t = TITLE.exec(labels);
      if (title === null && t !== null) {
        title = { year: Number(t[1]), kai: Number(t[2]), venueName: t[3]! };
        continue;
      }
      const dr = DATE_RANGE.exec(labels);
      if (dr !== null) {
        const y = Number(dr[1]);
        const m = Number(dr[2]);
        const d = Number(dr[3]);
        const em = dr[4] === undefined ? m : Number(dr[4]);
        const ed = Number(dr[5]);
        const ey = em < m ? y + 1 : y;
        if (!validDate(y, m, d) || !validDate(ey, em, ed)) return fail("shape-mismatch");
        const days = (utc(ey, em, ed) - utc(y, m, d)) / DAY_MS + 1;
        if (!Number.isInteger(days) || days < 1 || days > 7) return fail("shape-mismatch");
        block = { dates: Array.from({ length: days }, (_, k) => utc(y, m, d) + k * DAY_MS), weekdays: null, values: {} };
        blocks.push(block);
        blockYears.push(y);
        surface = null;
        continue;
      }
      const wd = [...labels.matchAll(/([日月火水木金土])曜日/g)].map((x) => x[1]!);
      if (wd.length > 0) {
        if (block === null || wd.length !== block.dates.length) return fail("shape-mismatch");
        if (!block.dates.every((ms, k) => WEEKDAYS[new Date(ms).getUTCDay()] === wd[k])) return fail("shape-mismatch");
        block.weekdays = wd;
        continue;
      }
      continue;
    }
    // 数値の行
    if (block === null || block.weekdays === null || numbers.length !== block.weekdays.length) return fail("shape-mismatch");
    let key: RowKey;
    if (labels.includes("クッション")) {
      if (labels.includes("ダート")) return fail("shape-mismatch");
      key = "cushion";
    } else {
      if (labels.includes("ダートコース")) surface = "dirt";
      else if (labels.includes("芝コース")) surface = "turf";
      if (surface === null) return fail("shape-mismatch");
      if (labels.includes("ゴール前")) key = surface === "turf" ? "turfGoal" : "dirtGoal";
      else if (labels.includes("コーナー")) key = surface === "turf" ? "turfCorner4" : "dirtCorner4";
      else return fail("shape-mismatch");
    }
    if (block.values[key] !== undefined) return fail("shape-mismatch");
    const vals = numbers.map((it) => Number(norm(it.text).replace("..", ".")));
    if (!vals.every((v) => inRange(v, key === "cushion" ? CUSHION_RANGE : MOISTURE_RANGE))) return fail("shape-mismatch");
    block.values[key] = vals;
  }
  if (title === null || blocks.length === 0) return fail("shape-mismatch");
  // 見出しの年と、塊の最初の日付の年が合うこと(別の年の PDF・日付の読み違いを入れない。開催は暦の年をまたがない)
  if (blockYears.some((y) => y !== title!.year)) return fail("shape-mismatch");
  return { ...title, blocks };
}

/** 過去の馬場の PDF を読む。投げない(読めない形は分類を返す)。 */
export async function parseBabaPastPdf(bytes: Uint8Array): Promise<BabaPastPdfResult> {
  try {
    if (bytes.length > BABA_PAST_MAX_PDF_BYTES) return { ok: false, result: "too-large" };
    if (latin1(bytes.subarray(0, 8)).indexOf("%PDF-") !== 0) return { ok: false, result: "not-pdf" };
    const { streams, contentsOrder, objects } = await extractStreams(bytes);
    const cmaps = streams.filter((s) => /begin(?:bfchar|bfrange)/.test(s.text));
    const glyphs = new Map<number, string>();
    const budget = { entries: MAX_CMAP_ENTRIES, codes: MAX_CMAP_CODES };
    for (const c of cmaps) parseCMap(c.text, budget, glyphs);
    const isCMap = new Set(cmaps);
    let content: PdfStream[] = [];
    if (contentsOrder !== null) {
      const byNum = new Map(streams.map((s) => [s.objNum, s]));
      const ordered = contentsOrder.map((n) => byNum.get(n));
      if (ordered.length > 0 && ordered.every((s): s is PdfStream => s !== undefined)) content = ordered;
    }
    if (content.length === 0) content = streams.filter((s) => !isCMap.has(s) && /\b(?:Tf|TJ|Tj|Tm)\b/.test(s.text));
    if (content.length === 0) return { ok: false, result: "no-text" };
    const items = readTextItems(content.map((s) => s.text).join("\n"), glyphs, readFontKinds(objects));
    if (items.length === 0) return { ok: false, result: "no-text" };
    const { year, kai, venueName, blocks } = readBlocks(clusterRows(items));
    const venueCode = CODE_BY_VENUE_NAME.get(venueName);
    if (venueCode === undefined || kai < 1) return { ok: false, result: "shape-mismatch" };
    const rows: BabaPastRow[] = [];
    const seen = new Set<string>();
    for (const b of blocks) {
      const tg = b.values.turfGoal;
      const t4 = b.values.turfCorner4;
      const dg = b.values.dirtGoal;
      const d4 = b.values.dirtCorner4;
      if (tg === undefined || t4 === undefined || dg === undefined || d4 === undefined || b.weekdays === null) return { ok: false, result: "shape-mismatch" };
      b.dates.forEach((ms, k) => {
        const kaisaiDate = ymd(ms);
        if (seen.has(kaisaiDate)) return fail("shape-mismatch");
        seen.add(kaisaiDate);
        rows.push({
          kaisaiDate,
          weekday: b.weekdays![k]!,
          cushion: b.values.cushion?.[k] ?? null,
          turfGoalMoisture: tg[k]!,
          turfCorner4Moisture: t4[k]!,
          dirtGoalMoisture: dg[k]!,
          dirtCorner4Moisture: d4[k]!,
        });
      });
    }
    return { ok: true, year, kai, venueName, venueCode, rows };
  } catch (e) {
    return { ok: false, result: e instanceof PastFail ? e.result : "shape-mismatch" };
  }
}
