/**
 * JRA の「過去の含水率・クッション値」の年の頁(`https://www.jra.go.jp/keiba/baba/archive/{年}.html`。Shift_JIS を読んだ文字列)から、開催ごとの PDF の一覧を取る(Issue #769)。
 * **純関数**: ネットワーク・D1・R2・DO に触れない。PDF の名前は**頁に載っているものだけ**を採る(連番の推測はしない。京都は改修の年に無い、など年で違う)。
 * 見本は `fixtures/jra_baba_past_year_2021.html`(2021 年は PDF 36 本)。URL の組み立て(`babaPastYearUrl`・`babaPastPdfUrl`)は、JRA の URL を 1 ファイルに集める決まりのため `jra-http.ts` にある。
 */
import { VENUE_BY_TRACK_CODE } from "../../packages/core/src/analysis/venue-codes";

/** PDF の名前の場(ローマ字)→ JRA の場コード。 */
const VENUE_CODE_BY_SLUG: Readonly<Record<string, string>> = {
  sapporo: "01",
  hakodate: "02",
  fukushima: "03",
  niigata: "04",
  tokyo: "05",
  nakayama: "06",
  chukyo: "07",
  kyoto: "08",
  hanshin: "09",
  kokura: "10",
};
// 場コードの表(core)と食い違わないこと(10 場)
for (const code of Object.values(VENUE_CODE_BY_SLUG)) {
  if (!VENUE_BY_TRACK_CODE.has(code)) throw new Error(`場コードが core の表に無い: ${code}`);
}

export interface BabaPastLink {
  /** `archive/` からの相対(例 `2021pdf/tokyo01.pdf`)。 */
  readonly path: string;
  readonly year: number;
  readonly venueCode: string;
  /** 開催回(ファイル名の末尾の 2 桁)。 */
  readonly kai: number;
}

export type BabaPastLinksResult =
  | {
      readonly ok: true;
      /** 頁に載っていた順(重複は 1 本)。 */
      readonly links: readonly BabaPastLink[];
      /** 読めずに捨てた PDF の数(知らない場・別の年のディレクトリ・開催回が 0)。 */
      readonly skipped: number;
    }
  | { readonly ok: false; readonly result: "shape-mismatch" };

/**
 * 年の頁から PDF の一覧を取る。題名が `{年}年の含水率・クッション値` でない頁(別の年・別の頁が返った)と、読める PDF が 1 本も無い頁は shape-mismatch。
 */
export function parseBabaPastYearPage(html: string, year: number): BabaPastLinksResult {
  const title = /<title>([^<]*)<\/title>/i.exec(html);
  if (title === null || !title[1]!.normalize("NFKC").startsWith(`${year}年の含水率・クッション値`)) {
    return { ok: false, result: "shape-mismatch" };
  }
  const links: BabaPastLink[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const m of html.matchAll(/href="[^"]*?archive\/(\d+)pdf\/([a-z]+)(\d+)\.pdf"/g)) {
    const path = `${m[1]}pdf/${m[2]}${m[3]}.pdf`;
    if (seen.has(path)) continue;
    seen.add(path);
    const venueCode = VENUE_CODE_BY_SLUG[m[2]!];
    const kai = Number(m[3]);
    if (Number(m[1]) !== year || venueCode === undefined || !Number.isInteger(kai) || kai < 1) {
      skipped++;
      continue;
    }
    links.push({ path, year, venueCode, kai });
  }
  if (links.length === 0) return { ok: false, result: "shape-mismatch" };
  return { ok: true, links, skipped };
}
