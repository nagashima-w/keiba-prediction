/**
 * Cloudflare の拠点コード(3 文字)に添える都市名の固定の表(Issue #812)。画面の「DO の拠点」の表示だけに使う。
 * 確かなものだけを入れる(アジア太平洋を中心に、これまでの観測で出た拠点を足した)。表に無いコードは 3 文字だけを出す。
 */
export const COLO_CITIES: Readonly<Record<string, string>> = {
  NRT: "成田",
  KIX: "関西",
  FUK: "福岡",
  OKA: "沖縄",
  HKG: "香港",
  SIN: "シンガポール",
  ICN: "ソウル",
  TPE: "台北",
  BKK: "バンコク",
  KUL: "クアラルンプール",
  MNL: "マニラ",
  CGK: "ジャカルタ",
  BOM: "ムンバイ",
  DEL: "デリー",
  MAA: "チェンナイ",
  SYD: "シドニー",
  MEL: "メルボルン",
  AMS: "アムステルダム",
  LAX: "ロサンゼルス",
  ATL: "アトランタ",
  MIA: "マイアミ",
  IAD: "ワシントン",
  ORD: "シカゴ",
  EWR: "ニューヨーク",
};

/** 「NRT 成田」の形。表に無いコードは 3 文字だけ。 */
export function coloLabel(code: string): string {
  const city = Object.hasOwn(COLO_CITIES, code) ? COLO_CITIES[code] : undefined;
  return city === undefined ? code : `${code} ${city}`;
}
