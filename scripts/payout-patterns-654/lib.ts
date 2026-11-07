/**
 * #654 組合せの馬券の配当のずれの探索: 純粋関数(確率・形・集計)。
 *
 * 計画は docs/investigations/payout-patterns-654/plan.md。本番のコードには触れない(packages/core の
 * Plackett–Luce 実装は θ の推定を伴うので使わず、ここでは単勝の市場の勝率 q から直接 Harville の確率を出す)。
 */

export type ComboBet = "quinella" | "wide" | "exacta" | "trio" | "trifecta";

export const COMBO_BETS: readonly ComboBet[] = ["quinella", "wide", "exacta", "trio", "trifecta"];

/** 券種ごとの JRA の控除率(計画 §3)。 */
export function takeoutOf(bet: ComboBet): number {
  switch (bet) {
    case "quinella":
    case "wide":
      return 0.225;
    case "exacta":
    case "trio":
      return 0.25;
    case "trifecta":
      return 0.275;
  }
}

/** 市場の勝率: 1/オッズをレース内で割り戻す。 */
export function marketProbs(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const sum = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / sum);
}

/** 人気順(1 始まり)。q の降順、同じ q は添字の小さい方を上位にする。 */
export function popularityRanks(q: readonly number[]): number[] {
  const order = q.map((_, i) => i).sort((a, b) => q[b]! - q[a]! || a - b);
  const ranks = new Array<number>(q.length);
  order.forEach((idx, pos) => {
    ranks[idx] = pos + 1;
  });
  return ranks;
}

/** 2 着・3 着の確率の割引(Lo–Bacon-Shone 型)。λ=μ=1 が Harville。 */
export interface Discount {
  lambda: number;
  mu: number;
}

const HARVILLE: Discount = { lambda: 1, mu: 1 };

/**
 * 順序付きの組合せ(馬単 [i,j]・三連単 [i,j,k])の確率。
 * 1 着は q、2 着は残りの馬の q^λ の割り戻し、3 着は残りの馬の q^μ の割り戻し。
 */
export function harvilleOrdered(q: readonly number[], combo: readonly number[], d: Discount = HARVILLE): number {
  const [i, j, k] = combo;
  if (i === undefined || j === undefined) throw new Error("順序付きの組合せは 2 頭以上");
  let p = q[i]!;
  // 2 着
  let denom = 0;
  for (let u = 0; u < q.length; u++) if (u !== i) denom += Math.pow(q[u]!, d.lambda);
  p *= Math.pow(q[j]!, d.lambda) / denom;
  if (k === undefined) return p;
  // 3 着
  denom = 0;
  for (let u = 0; u < q.length; u++) if (u !== i && u !== j) denom += Math.pow(q[u]!, d.mu);
  p *= Math.pow(q[k]!, d.mu) / denom;
  return p;
}

/** 馬連 {i,j}: 両順序の和。 */
export function quinellaProb(q: readonly number[], combo: readonly number[], d: Discount = HARVILLE): number {
  const [i, j] = combo as [number, number];
  return harvilleOrdered(q, [i, j], d) + harvilleOrdered(q, [j, i], d);
}

/** 三連複 {i,j,k}: 6 順序の和。 */
export function trioProb(q: readonly number[], combo: readonly number[], d: Discount = HARVILLE): number {
  const [i, j, k] = combo as [number, number, number];
  return (
    harvilleOrdered(q, [i, j, k], d) +
    harvilleOrdered(q, [i, k, j], d) +
    harvilleOrdered(q, [j, i, k], d) +
    harvilleOrdered(q, [j, k, i], d) +
    harvilleOrdered(q, [k, i, j], d) +
    harvilleOrdered(q, [k, j, i], d)
  );
}

/** ワイド {i,j}: 両方を含む三連複の和。 */
export function wideProb(q: readonly number[], combo: readonly number[], d: Discount = HARVILLE): number {
  const [i, j] = combo as [number, number];
  let p = 0;
  for (let k = 0; k < q.length; k++) {
    if (k === i || k === j) continue;
    p += trioProb(q, [i, j, k], d);
  }
  return p;
}

/** 券種に応じた組合せの確率。 */
export function comboProb(bet: ComboBet, q: readonly number[], combo: readonly number[], d: Discount = HARVILLE): number {
  switch (bet) {
    case "quinella":
      return quinellaProb(q, combo, d);
    case "wide":
      return wideProb(q, combo, d);
    case "exacta":
    case "trifecta":
      return harvilleOrdered(q, combo, d);
    case "trio":
      return trioProb(q, combo, d);
  }
}

/** 券種の全組合せ(添字)。非順序は昇順、順序付きは着順。 */
export function allCombos(bet: ComboBet, n: number): number[][] {
  const out: number[][] = [];
  switch (bet) {
    case "quinella":
    case "wide":
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
      break;
    case "exacta":
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) out.push([i, j]);
      break;
    case "trio":
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) out.push([i, j, k]);
      break;
    case "trifecta":
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          for (let k = 0; k < n; k++) if (k !== i && k !== j) out.push([i, j, k]);
        }
      break;
  }
  return out;
}

// ---- 人気帯 ----

export type RankBand = "R1" | "R2" | "R3" | "R4" | "R5";
export type QBand = "Q1" | "Q2" | "Q3" | "Q4" | "Q5";
export type Band = RankBand | QBand;
export type BandFamily = "R" | "Q";

export const RANK_BANDS: readonly RankBand[] = ["R1", "R2", "R3", "R4", "R5"];
export const Q_BANDS: readonly QBand[] = ["Q1", "Q2", "Q3", "Q4", "Q5"];

export function rankBand(rank: number): RankBand {
  if (rank <= 1) return "R1";
  if (rank <= 3) return "R2";
  if (rank <= 6) return "R3";
  if (rank <= 10) return "R4";
  return "R5";
}

export function qBand(q: number): QBand {
  if (q >= 0.3) return "Q1";
  if (q >= 0.15) return "Q2";
  if (q >= 0.07) return "Q3";
  if (q >= 0.03) return "Q4";
  return "Q5";
}

// ---- 形(form) ----

export type Form =
  | { kind: "pair"; bet: "quinella" | "wide"; family: BandFamily; bands: [Band, Band] }
  | { kind: "exacta"; family: BandFamily; bands: [Band, Band] }
  | { kind: "trio"; family: BandFamily; bands: [Band, Band, Band] }
  | { kind: "trifecta"; family: BandFamily; first: Band; rest: [Band, Band] }
  | { kind: "box"; bet: ComboBet; k: number }
  | { kind: "fav-first"; bet: "exacta" | "trifecta" }
  | { kind: "fav-axis"; bet: "quinella" | "wide" | "trio" }
  | { kind: "all"; bet: ComboBet };

export function formBet(form: Form): ComboBet {
  switch (form.kind) {
    case "pair":
    case "box":
    case "fav-first":
    case "fav-axis":
    case "all":
      return form.bet;
    case "exacta":
      return "exacta";
    case "trio":
      return "trio";
    case "trifecta":
      return "trifecta";
  }
}

/** 形の識別子(人が読める。candidates.json の鍵にも使う)。 */
export function formId(form: Form): string {
  switch (form.kind) {
    case "pair":
      return `${form.bet}:${form.family}:{${form.bands[0]},${form.bands[1]}}`;
    case "exacta":
      return `exacta:${form.family}:${form.bands[0]}>${form.bands[1]}`;
    case "trio":
      return `trio:${form.family}:{${form.bands.join(",")}}`;
    case "trifecta":
      return `trifecta:${form.family}:${form.first}>{${form.rest[0]},${form.rest[1]}}`;
    case "box":
      return `${form.bet}:box${form.k}`;
    case "fav-first":
      return `${form.bet}:fav-first`;
    case "fav-axis":
      return `${form.bet}:fav-axis`;
    case "all":
      return `${form.bet}:all`;
  }
}

/** 帯の多重集合を正規化した鍵。 */
function multisetKey(bands: readonly Band[]): string {
  return bands.slice().sort().join(",");
}

function horseBands(family: BandFamily, q: readonly number[], ranks: readonly number[]): Band[] {
  return family === "R" ? ranks.map(rankBand) : q.map(qBand);
}

/** 形がそのレースで買う組合せ(添字)。 */
export function formCombos(form: Form, race: { q: readonly number[]; ranks: readonly number[] }): number[][] {
  const n = race.q.length;
  const bet = formBet(form);
  const favIdx = race.ranks.indexOf(1);
  switch (form.kind) {
    case "pair": {
      const b = horseBands(form.family, race.q, race.ranks);
      const key = multisetKey(form.bands);
      return allCombos(bet, n).filter((c) => multisetKey([b[c[0]!]!, b[c[1]!]!]) === key);
    }
    case "exacta": {
      const b = horseBands(form.family, race.q, race.ranks);
      return allCombos("exacta", n).filter((c) => b[c[0]!] === form.bands[0] && b[c[1]!] === form.bands[1]);
    }
    case "trio": {
      const b = horseBands(form.family, race.q, race.ranks);
      const key = multisetKey(form.bands);
      return allCombos("trio", n).filter((c) => multisetKey(c.map((i) => b[i]!)) === key);
    }
    case "trifecta": {
      const b = horseBands(form.family, race.q, race.ranks);
      const key = multisetKey(form.rest);
      return allCombos("trifecta", n).filter(
        (c) => b[c[0]!] === form.first && multisetKey([b[c[1]!]!, b[c[2]!]!]) === key,
      );
    }
    case "box": {
      if (form.k > n) return [];
      return allCombos(bet, n).filter((c) => c.every((i) => race.ranks[i]! <= form.k));
    }
    case "fav-first":
      return allCombos(bet, n).filter((c) => c[0] === favIdx);
    case "fav-axis":
      return allCombos(bet, n).filter((c) => c.includes(favIdx));
    case "all":
      return allCombos(bet, n);
  }
}

/** 計画 §5-A の形の一覧(帯の族 2 つ × 券種の形 + 帯によらない形)。 */
export function allForms(): Form[] {
  const forms: Form[] = [];
  const families: { family: BandFamily; bands: readonly Band[] }[] = [
    { family: "R", bands: RANK_BANDS },
    { family: "Q", bands: Q_BANDS },
  ];
  for (const { family, bands } of families) {
    for (let a = 0; a < bands.length; a++)
      for (let b = a; b < bands.length; b++) {
        forms.push({ kind: "pair", bet: "quinella", family, bands: [bands[a]!, bands[b]!] });
        forms.push({ kind: "pair", bet: "wide", family, bands: [bands[a]!, bands[b]!] });
      }
    for (const a of bands) for (const b of bands) forms.push({ kind: "exacta", family, bands: [a, b] });
    for (let a = 0; a < bands.length; a++)
      for (let b = a; b < bands.length; b++)
        for (let c = b; c < bands.length; c++)
          forms.push({ kind: "trio", family, bands: [bands[a]!, bands[b]!, bands[c]!] });
    for (const first of bands)
      for (let a = 0; a < bands.length; a++)
        for (let b = a; b < bands.length; b++)
          forms.push({ kind: "trifecta", family, first, rest: [bands[a]!, bands[b]!] });
  }
  for (const k of [3, 4, 5, 6]) {
    for (const bet of ["quinella", "exacta", "trio", "trifecta"] as const) forms.push({ kind: "box", bet, k });
  }
  forms.push({ kind: "fav-first", bet: "exacta" });
  forms.push({ kind: "fav-first", bet: "trifecta" });
  forms.push({ kind: "fav-axis", bet: "quinella" });
  forms.push({ kind: "fav-axis", bet: "wide" });
  forms.push({ kind: "fav-axis", bet: "trio" });
  for (const bet of COMBO_BETS) forms.push({ kind: "all", bet });
  return forms;
}

// ---- 分析用のレース ----

export interface Hit {
  /** 添字の組合せ。非順序は昇順、順序付きは着順。 */
  combo: number[];
  /** 100 円あたりの配当。 */
  payout: number;
}

export interface RaceMeta {
  fieldSize: number;
  raceClass: string;
  weightType: string;
  courseType: string;
  distance: number;
  going: string;
  month: number;
  venue: string;
  filliesOnly: boolean;
  graded: boolean;
  ageCond: string;
  topQ: number;
  entropy: number;
}

export interface AnalysisRace {
  raceId: string;
  date: string;
  q: number[];
  ranks: number[];
  umaban: number[];
  hits: Partial<Record<ComboBet, Hit[]>>;
  meta: RaceMeta;
}

/** q の正規化エントロピー H / log(n)。 */
export function normalizedEntropy(q: readonly number[]): number {
  if (q.length <= 1) return 0;
  let h = 0;
  for (const p of q) if (p > 0) h -= p * Math.log(p);
  return h / Math.log(q.length);
}

/** 全角の数字を半角にする。 */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** raceData02Spans から年齢の条件(2歳 / 3歳 / 3歳以上 / 4歳以上 / 不明)。 */
export function ageCondOf(spans: readonly string[] | undefined): string {
  for (const s of spans ?? []) {
    const t = toHalfWidthDigits(s);
    const m = /サラ系(\d)歳(以上)?/.exec(t);
    if (m) return `${m[1]}歳${m[2] ?? ""}`;
  }
  return "不明";
}

/** hist.ndjson の 1 行(必要な項目だけ)。 */
export interface RawRace {
  raceId: string;
  date: string;
  raceClass?: string | null;
  weightType?: string | null;
  courseType?: string | null;
  distance?: number | null;
  going?: string | null;
  venueName?: string | null;
  filliesOnly?: boolean | null;
  grade?: string | null;
  raceData02Spans?: string[] | null;
  horses: { umaban: number; finishStatus?: string | null; winOdds?: number | null }[];
  payouts?: Partial<Record<string, unknown>> | null;
}

const NON_RUNNER = new Set(["取消", "除外"]);

/**
 * hist の 1 行から分析用のレースを作る。走った馬が 5 頭未満、または走った馬にオッズが無いレースは null。
 */
export function toAnalysisRace(raw: RawRace): AnalysisRace | null {
  const runners = raw.horses.filter((h) => !NON_RUNNER.has(h.finishStatus ?? ""));
  if (runners.length < 5) return null;
  if (runners.some((h) => typeof h.winOdds !== "number" || !(h.winOdds > 0))) return null;
  const umaban = runners.map((h) => h.umaban);
  const q = marketProbs(runners.map((h) => h.winOdds as number));
  const ranks = popularityRanks(q);
  const idxOf = new Map(umaban.map((u, i) => [u, i]));
  const hits: Partial<Record<ComboBet, Hit[]>> = {};
  const payouts = (raw.payouts ?? {}) as Record<string, { state?: string; payouts?: { umabans: number[]; payout: number }[] } | undefined>;
  for (const bet of COMBO_BETS) {
    const entry = payouts[bet];
    if (!entry || entry.state !== "parsed" || !Array.isArray(entry.payouts)) continue;
    const list: Hit[] = [];
    for (const p of entry.payouts) {
      const combo = p.umabans.map((u) => idxOf.get(u));
      if (combo.some((i) => i === undefined)) continue;
      const idx = combo as number[];
      list.push({ combo: bet === "exacta" || bet === "trifecta" ? idx : idx.slice().sort((a, b) => a - b), payout: p.payout });
    }
    hits[bet] = list;
  }
  return {
    raceId: raw.raceId,
    date: raw.date,
    q,
    ranks,
    umaban,
    hits,
    meta: {
      fieldSize: runners.length,
      raceClass: raw.raceClass ?? "不明",
      weightType: raw.weightType ?? "不明",
      courseType: raw.courseType ?? "不明",
      distance: raw.distance ?? 0,
      going: raw.going ?? "不明",
      month: Number(raw.date.slice(5, 7)),
      venue: raw.venueName ?? "不明",
      filliesOnly: raw.filliesOnly === true,
      graded: raw.grade != null && raw.grade !== "",
      ageCond: ageCondOf(raw.raceData02Spans ?? undefined),
      topQ: Math.max(...q),
      entropy: normalizedEntropy(q),
    },
  };
}

// ---- 形の集計 ----

export interface PerRace {
  cost: number;
  ret: number;
}

export interface FormEvaluation {
  races: number;
  tickets: number;
  returnYen: number;
  roi: number;
  hits: number;
  expectedHits: number;
  /** 副次の基準(割引つき)での見込みの的中数。 */
  expectedHitsDiscounted: number;
  fairYen: number;
  hitPayouts: number[];
  perRace: PerRace[];
}

export function evaluateForm(races: readonly AnalysisRace[], form: Form, discount?: Discount): FormEvaluation {
  const bet = formBet(form);
  const t = takeoutOf(bet);
  let tickets = 0;
  let returnYen = 0;
  let hits = 0;
  let expectedHits = 0;
  let expectedHitsDiscounted = 0;
  let fairYen = 0;
  const hitPayouts: number[] = [];
  const perRace: PerRace[] = [];
  let count = 0;
  for (const race of races) {
    const combos = formCombos(form, race);
    if (combos.length === 0) continue;
    count++;
    const keys = new Set(combos.map((c) => c.join("-")));
    let ret = 0;
    for (const c of combos) {
      expectedHits += comboProb(bet, race.q, c);
      if (discount) expectedHitsDiscounted += comboProb(bet, race.q, c, discount);
    }
    for (const h of race.hits[bet] ?? []) {
      if (!keys.has(h.combo.join("-"))) continue;
      hits++;
      ret += h.payout;
      hitPayouts.push(h.payout);
      fairYen += (100 * (1 - t)) / comboProb(bet, race.q, h.combo);
    }
    tickets += combos.length;
    returnYen += ret;
    perRace.push({ cost: combos.length * 100, ret });
  }
  return {
    races: count,
    tickets,
    returnYen,
    roi: tickets === 0 ? Number.NaN : returnYen / (tickets * 100),
    hits,
    expectedHits,
    expectedHitsDiscounted: discount ? expectedHitsDiscounted : expectedHits,
    fairYen,
    hitPayouts,
    perRace,
  };
}

/** 配当の上位 k 件を除いた回収率(感度)。 */
export function roiWithoutTop(ev: { tickets: number; returnYen: number; hitPayouts: readonly number[] }, k: number): number {
  if (ev.tickets === 0) return Number.NaN;
  const top = ev.hitPayouts
    .slice()
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((a, b) => a + b, 0);
  return (ev.returnYen - top) / (ev.tickets * 100);
}

/** 公平配当が threshold 円以上になる組合せの p の和(万馬券の見込み)。 */
export function bigHitExpectation(q: readonly number[], bet: ComboBet, threshold: number, d?: Discount): number {
  const t = takeoutOf(bet);
  const pMax = (100 * (1 - t)) / threshold;
  let e = 0;
  for (const c of allCombos(bet, q.length)) {
    // 「万馬券になる組合せ」は Harville の公平配当で決め、その組合せの確率を割引の有無で足す
    const p = comboProb(bet, q, c);
    if (p <= pMax) e += d ? comboProb(bet, q, c, d) : p;
  }
  return e;
}

// ---- 多重比較 ----

/** Benjamini–Hochberg の q 値(入力の順序で返す)。 */
export function benjaminiHochberg(p: readonly number[]): number[] {
  const m = p.length;
  if (m === 0) return [];
  const order = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]!);
  const q = new Array<number>(m);
  let running = 1;
  for (let pos = m - 1; pos >= 0; pos--) {
    const i = order[pos]!;
    running = Math.min(running, (p[i]! * m) / (pos + 1));
    q[i] = running;
  }
  return q;
}

/** Holm の調整 p 値(入力の順序で返す)。 */
export function holm(p: readonly number[]): number[] {
  const m = p.length;
  if (m === 0) return [];
  const order = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]!);
  const adj = new Array<number>(m);
  let running = 0;
  for (let pos = 0; pos < m; pos++) {
    const i = order[pos]!;
    running = Math.max(running, Math.min(1, p[i]! * (m - pos)));
    adj[i] = running;
  }
  return adj;
}

// ---- レースの条件 ----

export interface ConditionLabels {
  fieldSize: string;
  raceClass: string;
  weightType: string;
  courseType: string;
  distance: string;
  going: string;
  season: string;
  venue: string;
  filliesOnly: string;
  graded: string;
  ageCond: string;
  entropy: string;
  topQ: string;
}

export const CONDITION_KEYS: readonly (keyof ConditionLabels)[] = [
  "fieldSize",
  "raceClass",
  "weightType",
  "courseType",
  "distance",
  "going",
  "season",
  "venue",
  "filliesOnly",
  "graded",
  "ageCond",
  "entropy",
  "topQ",
];

export function raceConditions(race: AnalysisRace, opt: { entropyCuts: [number, number] }): ConditionLabels {
  const m = race.meta;
  const fieldSize = m.fieldSize <= 8 ? "<=8" : m.fieldSize <= 12 ? "9-12" : m.fieldSize <= 15 ? "13-15" : m.fieldSize === 16 ? "16" : "17-18";
  const distance = m.distance <= 1400 ? "<=1400" : m.distance <= 1800 ? "1401-1800" : m.distance <= 2200 ? "1801-2200" : ">=2201";
  const season = m.month === 12 || m.month <= 2 ? "12-2" : m.month <= 5 ? "3-5" : m.month <= 8 ? "6-8" : "9-11";
  const topQ = m.topQ >= 0.4 ? ">=0.40" : m.topQ >= 0.3 ? "0.30-0.40" : m.topQ >= 0.2 ? "0.20-0.30" : "<0.20";
  const entropy = m.entropy < opt.entropyCuts[0] ? "low" : m.entropy < opt.entropyCuts[1] ? "mid" : "high";
  return {
    fieldSize,
    raceClass: m.raceClass,
    weightType: m.weightType,
    courseType: m.courseType,
    distance,
    going: m.going,
    season,
    venue: m.venue,
    filliesOnly: m.filliesOnly ? "yes" : "no",
    graded: m.graded ? "yes" : "no",
    ageCond: m.ageCond,
    entropy,
    topQ,
  };
}

/** 条件の識別子 `key=value`(値は「<=8」のように「=」を含みうる)。 */
export function conditionId(key: string, value: string): string {
  return `${key}=${value}`;
}

/** 条件の識別子を最初の「=」だけで鍵と値に分ける。 */
export function splitConditionId(id: string): { key: string; value: string } {
  const i = id.indexOf("=");
  if (i < 0) throw new Error(`条件の識別子の形が違う: ${id}`);
  return { key: id.slice(0, i), value: id.slice(i + 1) };
}
