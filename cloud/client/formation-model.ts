/**
 * 想定隊列図の純関数(Issue #362。レース再生〈#311・#314・#316〉の置き換え)。DOM・乱数源・時刻に触れない。
 *
 * **静止した図で、物理的なシミュレーションではない。** 道中と4コーナーの2つの局面について、各馬が先頭からどのあたりにいる想定かを
 * 「列」(左が先頭、右が後方。{@link FORMATION_SLOTS} 本)で返す。材料は馬ごとの脚質(`legStyle`)・序盤の位置(`earlyPos`)・終盤の位置(`latePos`。Issue #363)と、レースの想定ペース(`race.pace`)だけ。
 * **勝率・3着内率は位置に使わない**(使うと図が確率の言い換えになり、旧再生の「着順へ引っ張る不自然な動き」を弱い形で再現する)。抽選もしない。
 *
 * 位置の単位は「チップ 1 個分」(列 1 本分)。
 *  - 道中: 脚質の集団(逃げ→先行→差し→追込)の順に並べ、集団の中は {@link INTRA}・集団の間は {@link INTER} の間隔を積む。集団の中は `earlyPos` の昇順
 *    (null は値のある馬の中央値。同値は馬番の小さい方が前)。旧再生の `replay-plan.ts` の `layout` と同じ考え方。想定ペースで隊列の長さを変える({@link PACE_SCALE})。
 *    長すぎる隊列は {@link BASE_MAX} で一律に縮める(縮めたあとにペースの倍率を掛けるので、頭数が多くてもペースの差が残る)。
 *  - 4コーナー(Issue #363): 近走の最終コーナーの通過順位から決める。`latePos`(0〜1。小さいほど前)のある馬は「`latePos` のある馬の中の最小値との差」を
 *    `(FORMATION_SLOTS − 1)` 倍した値を「先頭との差」とし(Issue #375。最小の馬が 0)、**ペースの補正({@link CORNER_FADE} 等)はかけない**(実データがあるため)。
 *    `latePos` の無い馬は、従来どおり道中の「先頭との差」に脚質ごとの係数({@link CORNER_FACTOR}。差し・追込が詰める)を掛け、
 *    逃げ・先行はペースが速いほど後退({@link CORNER_FADE})させた値で補う。そのあと**全頭の最小値**を 0 に取り直す。並びの同値は馬番の小さい方が前。
 *    **補う馬は、`latePos` のある先頭の馬より前には出ない**(両者の先頭をどちらも 0 にそろえる式の帰結。{@link cornerGaps} 参照)。
 *    全馬の `latePos` が無い(Issue #363 より前の分析など)ときは、従来と同じ結果になる。道中の位置は `latePos` に影響されない。
 *
 * **係数({@link INTRA}・{@link INTER}・{@link PACE_SCALE}・{@link CORNER_FACTOR}・{@link CORNER_FADE})は根拠の薄い経験則である。** 実際のレースのデータで当てはめたものではなく、
 * 「ハイペースなら隊列が長く、前が早く止まり、差し・追込が詰める。スローなら隊列が詰まり、前が残る」という一般的な傾向を見た目に出すための値。
 * 4コーナーは `latePos` のある馬ではこの係数を使わない(係数は道中と、`latePos` の無い馬の補いに残る)。
 */
import type { AnalysisDetail, AnalysisHorse, LegStyle, PaceEstimate } from "./api-analysis";

/** 列の本数(左が先頭、右が後方)。 */
export const FORMATION_SLOTS = 10;

export const FORMATION_HEADING = "想定隊列図";
/** 注記の共通の尾(材料の頭の文言は {@link FORMATION_NOTE} と {@link FORMATION_NOTE_NO_LATE} で違う)。 */
const NOTE_TAIL = "(実際の隊列とは異なることがあります)。馬の実力・勝率は反映していません。縦の並びは重なりを避けるためで、内外を表しません。位置の計算に使う係数は経験則です。";
/** 注記(1 頭でも `latePos` がある分析。4コーナーに近走の通過順位を使う)。 */
export const FORMATION_NOTE = `道中は馬の脚質と近走の序盤の位置から、4コーナーは近走の4コーナーの通過順位から(無い馬は脚質と想定ペースから)の想定です${NOTE_TAIL}`;
/** 注記(全馬の `latePos` が無い分析〈Issue #363 より前〉。4コーナーも脚質と想定ペースだけで決めるので、#362 のときの文言に戻す。Issue #375)。 */
export const FORMATION_NOTE_NO_LATE = `馬の脚質と想定ペースからの想定です${NOTE_TAIL}`;
/** 本命の印(core の `PREDICTION_MARKS` の先頭。クライアントの束に core の解析器を入れないため値を写し、テストで一致を確かめる)。 */
export const MAIN_MARK = "◎";
/** 馬名の最大の長さ(コードポイント)。超えたら「…」を付ける。 */
export const NAME_MAX = 6;

const STYLE_ORDER: readonly LegStyle[] = ["逃げ", "先行", "差し", "追込"];
/** 集団の中の間隔。逃げはハナを争って詰める(旧再生の `INTRA` と同じ値)。 */
const INTRA: readonly number[] = [0.25, 0.45, 0.45, 0.45];
/** 集団の間の間隔(旧再生の `INTER` と同じ値)。 */
const INTER = 1.6;
/** 隊列の長さの倍率(想定ペース別。旧再生の `FIELD_SCALE` と同じ値)。「不明」は平均。 */
const PACE_SCALE: Record<PaceEstimate, number> = { ハイ: 1.25, 平均: 1, スロー: 0.75, 不明: 1 };
/** 倍率を掛ける前の隊列の長さの上限。ハイ(最大の倍率)を掛けて最後尾が最後の列(FORMATION_SLOTS − 1)に収まる値。 */
const BASE_MAX = (FORMATION_SLOTS - 1) / PACE_SCALE.ハイ;
/** 4コーナーで道中の先頭との差に掛ける係数(1 未満は詰める)。逃げ・先行は動かない。 */
const CORNER_FACTOR: Record<PaceEstimate, Record<LegStyle, number>> = {
  ハイ: { 逃げ: 1, 先行: 1, 差し: 0.5, 追込: 0.45 },
  平均: { 逃げ: 1, 先行: 1, 差し: 0.6, 追込: 0.55 },
  スロー: { 逃げ: 1, 先行: 1, 差し: 0.75, 追込: 0.7 },
  不明: { 逃げ: 1, 先行: 1, 差し: 0.6, 追込: 0.55 },
};
/** 4コーナーの後退(チップ 1 個分。ハイペースで前が早く止まる)。 */
const CORNER_FADE: Record<PaceEstimate, Record<LegStyle, number>> = {
  ハイ: { 逃げ: 0.8, 先行: 0.5, 差し: 0, 追込: 0 },
  平均: { 逃げ: 0, 先行: 0, 差し: 0, 追込: 0 },
  スロー: { 逃げ: 0, 先行: 0, 差し: 0, 追込: 0 },
  不明: { 逃げ: 0, 先行: 0, 差し: 0, 追込: 0 },
};

export interface FormationChip {
  readonly umaban: number;
  /** 列(0 が先頭、FORMATION_SLOTS − 1 が最後尾側)。 */
  readonly slot: number;
  /** ◎の馬(強調する)。 */
  readonly main: boolean;
}

export interface FormationPhase {
  readonly label: string;
  /** 前から後ろの順(同じ位置は馬番の順)。 */
  readonly chips: readonly FormationChip[];
  /** 図の読み上げ文(図は `role="img"` で、中身の代わりにこれを読む)。 */
  readonly ariaLabel: string;
}

export interface FormationLegendRow {
  readonly umaban: number;
  /** 「馬番 馬名」(◎の馬は先頭に「◎ 」)。名前なしは馬番だけ。 */
  readonly text: string;
  readonly main: boolean;
}

export interface FormationSection {
  readonly heading: string;
  readonly note: string;
  readonly paceLine: string;
  readonly phases: readonly FormationPhase[];
  readonly legend: readonly FormationLegendRow[];
  /** 脚質が分からず図に置けなかった馬の行。全馬が置けたときは null。 */
  readonly unknownLine: string | null;
}

interface Placed {
  readonly umaban: number;
  readonly style: LegStyle;
  readonly early: number | null;
  /** 近走の最終コーナーの相対位置(0〜1。小さいほど前)。無い馬は null。 */
  readonly late: number | null;
}

const isLegStyle = (v: unknown): v is LegStyle => STYLE_ORDER.some((s) => s === v);

/** 数の配列の中央値(偶数個は中央 2 つの平均)。空は呼ばない。 */
function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 道中の「先頭との差」(チップ 1 個分。馬ごと)。 */
function middleGaps(placed: readonly Placed[], pace: PaceEstimate): number[] {
  const known = placed.map((h) => h.early).filter((v): v is number => v !== null && Number.isFinite(v));
  const fill = known.length === 0 ? 0.5 : median(known);
  const early = placed.map((h) => (h.early !== null && Number.isFinite(h.early) ? h.early : fill));
  const layout: number[] = Array(placed.length).fill(0);
  let acc = 0;
  let first = true;
  for (let c = 0; c < STYLE_ORDER.length; c++) {
    const members = placed
      .map((h, i) => (h.style === STYLE_ORDER[c] ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => early[a]! - early[b]! || placed[a]!.umaban - placed[b]!.umaban);
    if (members.length === 0) continue;
    if (!first) acc += INTER;
    first = false;
    members.forEach((h, k) => {
      if (k > 0) acc += INTRA[c]!;
      layout[h] = acc;
    });
  }
  const shrink = acc > BASE_MAX ? BASE_MAX / acc : 1;
  return layout.map((v) => v * shrink * PACE_SCALE[pace]);
}

/**
 * 4コーナーの「先頭との差」(チップ 1 個分。先頭が 0)。
 * `latePos` のある馬は、「`latePos` のある馬の中の最小値」を先頭(0)とした差 `(latePos − 最小値) × (FORMATION_SLOTS − 1)` にする(ペースの補正はかけない)。
 * 無い馬は道中の差に脚質の係数と後退をかけた値で補う(道中の差は全頭の先頭が 0 なので、補う値は 0 以上)。両者を混ぜたあとに、全頭の最小値を 0 に取り直す。
 *
 * **性質(Issue #375)**: `latePos` が 1 頭でもあれば、その最小の馬が 0 に置かれ、補う値は 0 以上なので、**補う馬は `latePos` のある先頭より前には出ない**(同じ 0 なら馬番の順)。
 * 取り直しが効くのは `latePos` が 1 頭もない(全馬を補う)ときだけで、ハイペースの後退で全頭が 0 より後ろにあるのを先頭 0 に戻す。
 * 旧式は `latePos × 9` の絶対位置で混ぜていたため、補う馬が先頭のとき `latePos` のある馬が(その最小値 × 9 だけ)後ろへずれていた。
 *
 * 式を `late×S − minLate×S` と書き、`(late − minLate)×S` と書かない理由: 全馬に `latePos` があるとき、`min(late×S)` は `minLate×S` とビット単位で等しいので、
 * 旧式(`late×S` から全頭の最小値を引く)と**浮動小数点まで一致**する(丸め `Math.round` の 0.5 境界の結果が変わらない)。`(late − minLate)×S` は丸め誤差で最後の桁がずれうる。
 */
function cornerGaps(placed: readonly Placed[], middle: readonly number[], pace: PaceEstimate): number[] {
  const scale = FORMATION_SLOTS - 1;
  const lates = placed.map((h) => h.late).filter((v): v is number => v !== null);
  const lateBase = lates.length === 0 ? 0 : Math.min(...lates) * scale;
  const raw = placed.map((h, i) => (h.late !== null ? h.late * scale - lateBase : middle[i]! * CORNER_FACTOR[pace][h.style] + CORNER_FADE[pace][h.style]));
  const lead = Math.min(...raw);
  return raw.map((v) => v - lead);
}

const slotOf = (gap: number): number => Math.min(FORMATION_SLOTS - 1, Math.max(0, Math.round(gap)));

function phase(label: string, placed: readonly Placed[], gaps: readonly number[], mains: ReadonlySet<number>): FormationPhase {
  const order = placed.map((_, i) => i).sort((a, b) => gaps[a]! - gaps[b]! || placed[a]!.umaban - placed[b]!.umaban);
  const chips = order.map((i) => ({ umaban: placed[i]!.umaban, slot: slotOf(gaps[i]!), main: mains.has(placed[i]!.umaban) }));
  // 読み上げ: 同じ列の馬は「・」でつなぎ、列の間は「 / 」で区切る(前から後ろへ)。
  const groups: number[][] = [];
  let lastSlot = -1;
  for (const c of chips) {
    if (c.slot !== lastSlot) groups.push([]);
    groups[groups.length - 1]!.push(c.umaban);
    lastSlot = c.slot;
  }
  return { label, chips, ariaLabel: `${label}の想定隊列(先頭側から): ${groups.map((g) => g.map((u) => `${u}番`).join("・")).join(" / ")}` };
}

/** 馬名を {@link NAME_MAX} コードポイントまでにする。超えたら「…」。 */
function shortName(name: string): string {
  const chars = Array.from(name);
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX).join("")}…` : name;
}

function legendRow(h: AnalysisHorse): FormationLegendRow {
  const main = h.mark === MAIN_MARK;
  const base = h.name === null || h.name === "" ? String(h.umaban) : `${h.umaban} ${shortName(h.name)}`;
  return { umaban: h.umaban, text: main ? `${MAIN_MARK} ${base}` : base, main };
}

function paceLineOf(a: AnalysisDetail, pace: PaceEstimate): string {
  if (pace === "不明") return "想定ペース: 不明(平均として描きます)";
  // 出どころ: LLM の展開予想に pace があればそれ(サーバが `race.pace` に優先して入れる)。無ければ逃げ馬の頭数からの規則の値。
  return `想定ペース: ${pace}(${a.development?.pace != null ? "AI の展開予想" : "逃げ馬の頭数からの規則"})`;
}

/**
 * 分析から想定隊列図の表示用データを作る。**脚質の分かる馬が 2 頭未満なら null**(節ごと出さない。10/15 の #314 より前の分析など)。
 * 脚質の分からない馬は図に置かず、`unknownLine` に別記する(差しなどに仮置きしない)。
 */
export function buildFormation(a: AnalysisDetail): FormationSection | null {
  const placed: Placed[] = a.horses.filter((h) => isLegStyle(h.legStyle)).map((h) => ({ umaban: h.umaban, style: h.legStyle as LegStyle, early: h.earlyPos ?? null, late: h.latePos ?? null }));
  if (placed.length < 2) {
    return null;
  }
  const pace: PaceEstimate = a.race.pace ?? "不明";
  const mains = new Set(a.horses.filter((h) => h.mark === MAIN_MARK).map((h) => h.umaban));
  const middle = middleGaps(placed, pace);
  const corner = cornerGaps(placed, middle, pace);
  const unknown = a.horses.filter((h) => !isLegStyle(h.legStyle)).map((h) => h.umaban).sort((x, y) => x - y);
  return {
    heading: FORMATION_HEADING,
    note: placed.some((h) => h.late !== null) ? FORMATION_NOTE : FORMATION_NOTE_NO_LATE,
    paceLine: paceLineOf(a, pace),
    phases: [phase("道中", placed, middle, mains), phase("4コーナー", placed, corner, mains)],
    legend: [...a.horses].sort((x, y) => x.umaban - y.umaban).map(legendRow),
    unknownLine: unknown.length === 0 ? null : `位置を推定できない馬: ${unknown.join(", ")}`,
  };
}
