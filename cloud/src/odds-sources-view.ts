/**
 * オッズの取得元と時刻の行(Issue #677。#668-F)。D1 の `odds_sources_json`(`analyses` と `analysis_close`。形は `odds-sources-json.ts`)から、画面に出す日本語の行を組み立てる。純関数だけで、D1・R2 には触れない。
 *
 * 文言は**サーバで組み立てる**(クライアントの束は日本語を `\uXXXX` で出し、1 文字 6 バイトかかる。前例は `analysis-diff-view.ts`)。クライアントは行を並べるだけ。
 * 記録なし・読めない JSON・知らない版は何も出さない(例外を投げない)。取得元と時刻は秘密の情報ではないので、閲覧者にも管理者にも同じに出す。
 * netkeiba に戻した理由(`fallbackReason`)は内部の語を出さず、利用者向けの言葉にする(未知の理由は無しとして扱う)。
 */
import type { OddsFallbackReason, OddsSourceKind, OddsSourceName, OddsSourceRecord } from "../../packages/core/src/scraper/odds-override";
import { ODDS_SOURCES_VERSION } from "./odds-sources-json";

/** 行の先頭。 */
const PREFIX = "オッズ: ";
/** 分析の行の上限(句が多いときは 2 行に分け、2 行目は「、」で連ねる)。 */
export const ODDS_SOURCES_MAX_LINES = 2;

/** 券種の表示順とラベル(単勝・複勝は同じ頁なので 1 つ)。 */
const KINDS: ReadonlyArray<readonly [OddsSourceKind, string]> = [
  ["winPlace", "単勝・複勝"],
  ["wide", "ワイド"],
  ["trio", "3連複"],
  ["quinella", "馬連"],
  ["exacta", "馬単"],
  ["trifecta", "3連単"],
  ["bracketQuinella", "枠連"],
];

const SOURCE_TEXT: Readonly<Record<OddsSourceName, string>> = { jra: "JRA", netkeiba: "netkeiba" };

const REASON_TEXT: Readonly<Record<OddsFallbackReason, string>> = {
  "override-unavailable": "JRA を使えず",
  "override-error": "JRA を使えず",
  "horse-set-mismatch": "JRA と出走馬が合わず",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `YYYY-MM-DD HH:MM:SS`(JST)→ `M/D HH:MM`。形が違えば null。 */
function shortTime(datetime: string | null): string | null {
  const m = datetime === null ? null : /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2}):\d{2}$/.exec(datetime);
  return m === null ? null : `${Number(m[1])}/${Number(m[2])} ${m[3]}`;
}

/** 1 つの券種の記録(検査済み)。形が違えば null。 */
function recordOf(value: unknown): OddsSourceRecord | null {
  if (!isRecord(value)) return null;
  const source = value["source"];
  if (source !== "jra" && source !== "netkeiba") return null;
  const dt = value["officialDatetime"];
  const reasonRaw = value["fallbackReason"];
  const reason = typeof reasonRaw === "string" && Object.hasOwn(REASON_TEXT, reasonRaw) ? (reasonRaw as OddsFallbackReason) : undefined;
  return { source, officialDatetime: typeof dt === "string" ? dt : null, ...(reason === undefined ? {} : { fallbackReason: reason }) };
}

/** 句(同じ取得元・時刻・理由の券種のまとまり)の並び。読めない・空は空配列。 */
function phrasesOf(json: string | null | undefined): Array<{ labels: string[]; detail: string }> {
  if (typeof json !== "string" || json === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed["v"] !== ODDS_SOURCES_VERSION || !isRecord(parsed["sources"])) return [];
  const sources = parsed["sources"];
  const groups = new Map<string, { labels: string[]; detail: string }>();
  for (const [kind, label] of KINDS) {
    const rec = Object.hasOwn(sources, kind) ? recordOf(sources[kind]) : null;
    if (rec === null) continue;
    const time = shortTime(rec.officialDatetime);
    const notes = [...(time === null ? [] : [`${time} 現在`]), ...(rec.fallbackReason === undefined ? [] : [REASON_TEXT[rec.fallbackReason]])];
    const detail = `${SOURCE_TEXT[rec.source]}${notes.length === 0 ? "" : `(${notes.join("、")})`}`;
    const g = groups.get(detail);
    if (g === undefined) groups.set(detail, { labels: [label], detail });
    else g.labels.push(label);
  }
  return [...groups.values()];
}

/** 句の列を、先頭に「オッズ: 」を付けた文にする。句が 1 つだけ(全券種が同じ)なら券種名は省く。 */
function phraseText(p: { labels: string[]; detail: string }, whole: boolean): string {
  return whole ? p.detail : `${p.labels.join("・")}は ${p.detail}`;
}

/**
 * 分析の詳細に出す行(最大 {@link ODDS_SOURCES_MAX_LINES} 行)。句が 2 つまでなら 1 行、3 つ以上なら先頭の 2 句を 1 行目、残りを 2 行目に「、」で連ねる。記録なし・読めない入力は空配列。
 */
export function oddsSourcesLines(json: string | null | undefined): string[] {
  const phrases = phrasesOf(json);
  if (phrases.length === 0) return [];
  const texts = phrases.map((p) => phraseText(p, phrases.length === 1));
  if (texts.length <= 2) return [`${PREFIX}${texts.join("、")}`];
  return [`${PREFIX}${texts.slice(0, 2).join("、")}`, texts.slice(2).join("、")];
}

/** 再計算の回の 1 行(`summaryLines` の末尾に足す)。分析時と同じ内容でも省かない。記録なしは null。 */
export function oddsSourcesLineOfClose(json: string | null | undefined): string | null {
  const lines = oddsSourcesLines(json);
  return lines.length === 0 ? null : lines.join("、");
}
