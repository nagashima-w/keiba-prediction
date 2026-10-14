/**
 * レースの画面の「配分の提案」の下に出す、組合せの券種ごとの行(Issue #296)。純関数だけで、D1・R2 には触れない。
 *
 * 目的: 組合せの券種(特に地方の三連単〈#283〉)のオッズが取れたのか、取れたのに配分に入らなかったのか、が画面で分かるようにする。
 * 文言は**サーバで組み立てる**(クライアントの束は日本語を `\uXXXX` で出すため、文言を置くと 1 文字 6 バイトかかる)。
 *
 * 材料と出どころ:
 *  - 取得の状態: スナップショット(R2)の `comboOdds.<券種>.state`(available=取得できた・unavailable=オッズなし〈未発売・発売なし・パーサが読み取れなかった場合を区別しない〉・failed=取得できなかった)。
 *  - オッズの点数: `<券種>Combo` の写像のうち**数値のオッズが入っているセルの数**(値が null のセルは数えない。`obtainedComboCount` は null のセルも数える)。
 *    期待の点数(`comboOdds.<券種>.diagnostics.expectedComboCount`)に満たなければ「n/m」。取得できなかった軸(`attempts` の axis が数で state が available でない)の本数を添える。
 *  - EV プラスの点数: 書き込み側が残した `comboStats`(`packages/core/src/analysis/combo-stats.ts`)。**Issue #296 より前の分析には無い**ので、無ければ EV と理由は出さない(捏造しない)。
 *  - 配分の点数: D1 の配分の明細(stake>0 の行)のうち、その券種の件数。
 *
 * 券種は組合せの 6 つ(ワイド・馬連・枠連・馬単・三連複・三連単)だけ。単勝・複勝は含めない。
 */
import { COMBO_STATS_BET_TYPES, normalizeComboStats, type ComboStats, type ComboStatsBetType } from "../../packages/core/src/analysis/combo-stats";
import type { StoredAllocation } from "../../packages/core/src/ev/analysis-store-types";

const LABELS: Readonly<Record<ComboStatsBetType, string>> = {
  wide: "ワイド",
  quinella: "馬連",
  bracketQuinella: "枠連",
  exacta: "馬単",
  trio: "三連複",
  trifecta: "三連単",
};

/** スナップショットの組合せの写像のキー(`RaceSnapshot` の `*Combo`)。 */
const COMBO_FIELDS: Readonly<Record<ComboStatsBetType, string>> = {
  wide: "wideCombo",
  quinella: "quinellaCombo",
  bracketQuinella: "bracketQuinellaCombo",
  exacta: "exactaCombo",
  trio: "trioCombo",
  trifecta: "trifectaCombo",
};

/** 配分の経路のうち、組合せの候補を評価して配分を決めた(または決めようとした)もの。それ以外〈unset・yoso・unavailable〉は配分の点数を出さない。 */
const ALLOCATED_ROUTES: ReadonlySet<string> = new Set(["mixed", "place-only", "invalid"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const formatCount = (n: number): string => n.toLocaleString("en-US");

/** その券種を配分に含める設定か。記録なし(Issue #118 などより前の分析)は null。 */
function includeOf(type: ComboStatsBetType, a: StoredAllocation): boolean | null {
  switch (type) {
    case "wide":
      return a.includeWide;
    case "quinella":
      return a.includeQuinella;
    case "bracketQuinella":
      return a.includeBracketQuinella;
    case "exacta":
      return a.includeExacta;
    case "trio":
      return a.includeTrio;
    case "trifecta":
      return a.includeTrifecta;
  }
}

/** 数値のオッズが入っているセルの数。写像が無い・オブジェクトでなければ 0。 */
function numericCellCount(map: unknown): number {
  if (!isRecord(map)) return 0;
  let n = 0;
  for (const v of Object.values(map)) {
    if (typeof v === "number" && Number.isFinite(v)) n++;
  }
  return n;
}

/** 取得できなかった軸の本数(軸のある試行のうち、available でないもの)。 */
function failedAxisCount(diagnostics: Record<string, unknown> | null): number {
  const attempts = diagnostics?.["attempts"];
  if (!Array.isArray(attempts)) return 0;
  let n = 0;
  for (const attempt of attempts as unknown[]) {
    if (isRecord(attempt) && typeof attempt["axis"] === "number" && attempt["state"] !== "available") n++;
  }
  return n;
}

function expectedCount(diagnostics: Record<string, unknown> | null): number | null {
  const e = diagnostics?.["expectedComboCount"];
  return typeof e === "number" && Number.isInteger(e) && e >= 0 ? e : null;
}

/** EV プラスがあるのに配分が 0 点だった理由。確実に言えるものだけ(優先: 計算の失敗 > レース全体の見送り > それ以外)。 */
function zeroAllocationReason(a: StoredAllocation): string {
  if (a.route === "invalid") return "配分の計算に失敗";
  if (a.skipReasonCode !== null) return "レース全体が見送り";
  // 2 つの原因を区別できない: (a) 貪欲法が他の買い目に配分した、(b) 連続配分は正だったが 100 円の単位に届かず切り捨てられた(roundStakes)。D1 には stake>0 しか残らない。
  return "他の買い目が優先、または 100 円未満";
}

function lineOf(type: ComboStatsBetType, snapshot: Record<string, unknown>, outcome: Record<string, unknown>, stats: ComboStats | null, allocation: StoredAllocation | undefined): string | null {
  const label = LABELS[type];
  const state = outcome["state"];
  if (state === "failed") return `${label}: オッズを取得できませんでした`;
  if (state === "unavailable") return `${label}: オッズなし(未発売・発売なし・読み取れず)`;
  if (state !== "available") return null;

  const diagnostics = isRecord(outcome["diagnostics"]) ? outcome["diagnostics"] : null;
  const count = numericCellCount(snapshot[COMBO_FIELDS[type]]);
  const expected = expectedCount(diagnostics);
  const failedAxes = failedAxisCount(diagnostics);
  let head = `${label}: オッズ ${expected !== null && count < expected ? `${formatCount(count)}/${formatCount(expected)}` : formatCount(count)} 点取得`;
  if (failedAxes > 0) head += `(取得できなかった軸 ${failedAxes} 本)`;

  if (allocation === undefined) return head;
  if (includeOf(type, allocation) === false) return `${head}・配分に含めない設定`;
  if (!ALLOCATED_ROUTES.has(allocation.route)) return head;

  const allocated = allocation.bets.filter((b) => b.betType === type).length;
  const s = stats?.[type];
  let line = head;
  if (s !== undefined) {
    line += s.judged === 0 ? "・EV 判定できず" : `・EV プラス ${formatCount(s.positive)} 点`;
  }
  line += `・配分 ${formatCount(allocated)} 点`;
  if (s !== undefined && s.positive > 0 && allocated === 0) {
    line += `(${zeroAllocationReason(allocation)})`;
  }
  return line;
}

/**
 * 組合せの券種ごとの行。材料が無い(スナップショットが不正・`comboOdds` が無い・行になる券種が 1 つも無い)ときは null。
 * @param rawSnapshot R2 の詳細の `raceSnapshot`(JSON から復元しただけで型は検証されていない)
 * @param allocation D1 の配分(無ければ undefined。取得の点数だけの行になる)
 */
export function buildComboCountLines(rawSnapshot: unknown, allocation: StoredAllocation | undefined): string[] | null {
  if (!isRecord(rawSnapshot) || !isRecord(rawSnapshot["comboOdds"])) return null;
  const comboOdds = rawSnapshot["comboOdds"];
  const stats = normalizeComboStats(rawSnapshot["comboStats"]);
  const lines: string[] = [];
  for (const type of COMBO_STATS_BET_TYPES) {
    const outcome = comboOdds[type];
    if (!isRecord(outcome)) continue;
    const line = lineOf(type, rawSnapshot, outcome, stats, allocation);
    if (line !== null) lines.push(line);
  }
  return lines.length === 0 ? null : lines;
}
