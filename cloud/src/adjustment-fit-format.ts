/**
 * 月報の「補正の当たり具合」(Issue #509)の文面。**純関数**。画面(ハンドラが読み出し時に作る。第 2 段階)と LLM のプロンプトが、同じ関数の出力を使う
 * (画面に出る数字と LLM が見た数字が同じになる)。保存するのは数字(`AdjustmentFit`)だけで、文面は保存しない: 文面を直せば、作成済みの月報の画面にも反映される。
 *
 * この module は、クライアント(ブラウザの束)から import しない(固定の文言が束に入って肥大するため。クライアントは、ここで作った文字列をそのまま出す)。
 */
import { formatRate } from "../../packages/core/src/view/verify-format";
import { FIT_FEW_COUNT, FIT_MIN_VERSION_RACES, isFitUnavailable, type AdjustmentFit, type AdjustmentFitUnavailable, type DirectionKey, type FitBucket, type FitGroup, type PopularityKey } from "./adjustment-fit";

/** 1 つの節。`note` が無いときは null。 */
export interface FitSection {
  readonly heading: string;
  readonly note: string | null;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

/** 読み出せなかった月報の理由ごとの固定の文言(例外の本文は入れない)。 */
export const FIT_UNAVAILABLE_NOTES: Readonly<Record<AdjustmentFitUnavailable["unavailable"], string>> = {
  "read-failed": "補正の当たり具合は、この月報を作るときに D1 から読めなかったため、載せていません。",
  "too-many": "補正の当たり具合は、この月の分析が多すぎて(一部だけの集計を避けるため)、載せていません。",
  "compute-failed": "補正の当たり具合は、計算できなかったため、載せていません。",
};

const DIRECTION_LABELS: Readonly<Record<DirectionKey, string>> = {
  bigUp: "大きく上げた(+5pt 超)",
  up: "上げた(+1pt 超〜+5pt)",
  same: "ほぼそのまま(±1pt)",
  down: "下げた(−1pt 超〜−5pt)",
  bigDown: "大きく下げた(−5pt 超)",
};

const POPULARITY_LABELS: Readonly<Record<PopularityKey, string>> = {
  "1": "1 番人気",
  "2-3": "2〜3 番人気",
  "4-6": "4〜6 番人気",
  "7+": "7 番人気以下",
};

/** 数が少ない区分に付ける印(断定しないための目印。プロンプトの規則が参照する)。 */
export const FIT_FEW_MARK = `※${FIT_FEW_COUNT} 頭未満`;

function bucketValue(b: FitBucket<string>): string {
  if (b.count === 0) return "0 頭";
  const actual = formatRate(b.placedCount / b.count);
  const text = `${b.count} 頭・統計モデル ${formatRate(b.meanPrior)}・補正後 ${formatRate(b.meanAdjusted)}・実際 ${actual}(${b.placedCount}/${b.count})`;
  return b.count < FIT_FEW_COUNT ? `${text} ${FIT_FEW_MARK}` : text;
}

const signed = (n: number): string => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(4)}`;

/**
 * 最適な倍率 k の文面。**表示する 2 桁に丸めた値で区分する**(表示が 0.00・1.00 になる値で、文面と数字が食い違わないため)。
 * k < 0: 補正の向きが実際と逆(補正しない方が当たった)。0: 補正を足しても良くならなかった。0〜1: 補正の幅が大きすぎた。1: ちょうどよかった。1 超: 小さすぎた。
 * 負号は他の差と同じ「−」(U+2212)。
 */
function kText(k: number | null): string {
  if (k === null) return "なし(補正が 1 頭も無い、または評価した馬が無い)";
  const r = Number(k.toFixed(2));
  if (r === 0) return "0.00(補正を足しても当たりは良くならなかった)";
  if (r < 0) return `−${Math.abs(r).toFixed(2)}(負の値: 補正の向きが実際と逆だった。補正しない方が当たった)`;
  const shown = r.toFixed(2);
  const lead = `${shown}(補正の幅を ${shown} 倍にしたとき最も当たった。`;
  if (r < 1) return `${lead}1 より小さいので補正の幅が大きすぎた)`;
  if (r === 1) return `${lead}今の補正の幅がちょうどよかった)`;
  return `${lead}1 より大きいので補正の幅が小さすぎた)`;
}

function summaryRows(g: FitGroup): FitSection["rows"] {
  const { prior, adjusted } = g.brier;
  const brierText =
    prior === null || adjusted === null ? "なし" : `統計モデル ${prior.toFixed(4)}・補正後 ${adjusted.toFixed(4)}(差 ${signed(adjusted - prior)}。負なら補正で良くなった)`;
  return [
    { label: "3 着内の Brier", value: brierText },
    { label: "最適な倍率 k", value: kText(g.optimalK) },
  ];
}

function groupSections(g: FitGroup, scope: string, titleNote: string | null): FitSection[] {
  return [
    { heading: `補正の当たり具合(${scope}・${g.raceCount} レース・${g.horseCount} 頭)`, note: titleNote, rows: summaryRows(g) },
    { heading: `補正の向き別(${scope})`, note: null, rows: g.byDirection.map((b) => ({ label: DIRECTION_LABELS[b.key], value: bucketValue(b) })) },
    { heading: `人気の帯別(${scope})`, note: null, rows: g.byPopularity.map((b) => ({ label: POPULARITY_LABELS[b.key], value: bucketValue(b) })) },
  ];
}

/** 母集団の説明(月全体の節の注)。除いた件数の単位: 先読みの疑い・判定不能は分析、ほかはレース。 */
function populationNote(fit: AdjustmentFit): string {
  const e = fit.excluded;
  const hidden = fit.hiddenVersionCount > 0 ? ` ${FIT_MIN_VERSION_RACES} レース未満の版(${fit.hiddenVersionCount} 版)は、版ごとの表に出していません(月全体には入っています)。` : "";
  return (
    "LLM が統計モデルの 3 着内率を補正した結果が、実際の 3 着内率に近づいたかを見る表です。補正の向きは「補正後 − 統計モデル」の 3 着内率の差で分けています。" +
    "対象は、先読みの疑いがなく、LLM の補正が効いた分析で、結果のあるレースの馬(着順なし・取消・除外を除く)です。人気の帯別は、確定の人気が無い馬を除きます。" +
    `除いたもの: 先読みの疑い ${e.suspect} 分析・判定不能 ${e.unknown} 分析・発走時刻の確認待ち ${e.uncheckedRaces} レース・推定オッズ ${e.estimated} レース・LLM 不使用など ${e.notLlm} レース。` +
    hidden
  );
}

/** 対象のレースがあるか(表を出せるか)。項目の無い昔の月報・読み出せなかった月報は false。 */
export function adjustmentFitHasData(fit: AdjustmentFit | AdjustmentFitUnavailable | undefined): fit is AdjustmentFit {
  return fit !== undefined && !isFitUnavailable(fit) && fit.all.raceCount > 0;
}

/**
 * 画面向けの節の並び。項目の無い昔の月報(undefined)は節なし、読み出せなかった月報は固定の理由の 1 節、対象のレースが無いときは説明の 1 節だけ。
 * 数があるときは、月全体の 3 節(要約・向き別・人気別)のあとに、版ごと(版の昇順)の 3 節ずつ。
 */
export function adjustmentFitSections(fit: AdjustmentFit | AdjustmentFitUnavailable | undefined): FitSection[] {
  if (fit === undefined) return [];
  if (isFitUnavailable(fit)) return [{ heading: "補正の当たり具合", note: FIT_UNAVAILABLE_NOTES[fit.unavailable], rows: [] }];
  if (fit.all.raceCount === 0) {
    return [{ heading: "補正の当たり具合", note: `対象のレースがありません。${populationNote(fit)}`, rows: [] }];
  }
  return [
    ...groupSections(fit.all, "月全体", populationNote(fit)),
    ...fit.byVersion.flatMap((v) => groupSections(v, `版 ${v.promptVersion}`, null)),
  ];
}

/** プロンプトに入れる行。データがあるときだけ(読み出せなかった月報・昔の月報・対象なしは空 = 節も規則も入れない)。 */
export function adjustmentFitPromptLines(fit: AdjustmentFit | AdjustmentFitUnavailable | undefined): string[] {
  if (!adjustmentFitHasData(fit)) return [];
  return adjustmentFitSections(fit).flatMap((s) => [`### ${s.heading}`, ...(s.note === null ? [] : [s.note]), ...s.rows.map((r) => `- ${r.label}: ${r.value}`), ""]);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 保存した月報の本文(`body_json` を読んだだけの、検証していない値)から、画面向けの節を作る(ハンドラが読み出し時に呼ぶ)。
 * **本文が壊れていても投げない**: 項目の無い昔の月報・`stats` や `adjustmentFit` が想定の形でない本文・知らない理由の印は、節なし(空の配列)にする。
 * 節の形(見出しは文字列・注は文字列か null・行は文字列の対)を確かめてから返す(クライアントは一部だけを採用しないので、1 つでも崩れると画面全体が読めなくなる)。
 */
export function fitSectionsOfBody(body: unknown): FitSection[] {
  if (!isRecord(body) || !isRecord(body["stats"])) return [];
  const fit = body["stats"]["adjustmentFit"];
  if (!isRecord(fit)) return [];
  try {
    const sections = adjustmentFitSections(fit as unknown as AdjustmentFit | AdjustmentFitUnavailable);
    const wellFormed = sections.every(
      (s) => typeof s.heading === "string" && (s.note === null || typeof s.note === "string") && s.rows.every((r) => typeof r.label === "string" && typeof r.value === "string"),
    );
    return wellFormed ? sections : [];
  } catch {
    return [];
  }
}
