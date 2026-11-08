/**
 * #654: 組合せの馬券の配当のずれの探索の実行(入出力と手順)。純粋な計算は lib.ts・stats.ts。
 *
 * 使い方(リポジトリルートで):
 *   pnpm exec tsx scripts/payout-patterns-654/run.ts --mode explore --from 2024-08-10 --to 2025-09-30 \
 *     --hist <hist.ndjson.gz> --out docs/investigations/payout-patterns-654 --label first
 *   pnpm exec tsx scripts/payout-patterns-654/run.ts --mode confirm --from 2025-10-01 --to 2026-10-31 \
 *     --hist <hist.ndjson.gz> --out docs/investigations/payout-patterns-654 --label second \
 *     --candidates docs/investigations/payout-patterns-654/candidates.json
 *
 * explore: 期間の全レースで形(計画 §5-A)と条件(§5-B)を集計し、§6 の目安で候補を選んで
 *   candidates.json(F1〜F4、エントロピーの境、割引 λ・μ)と results-<label>.json を書く。
 *   --no-candidates を付けると candidates.json を書かない(後半の全表を記述のために出すとき。候補は固定済み)。
 * confirm: candidates.json の候補だけを別の期間で集計し、§7 の判定を judgement-<label>.json と
 *   judgement-<label>.md に書く。
 *
 * 期間は --from/--to で変えられる(5 年分がそろったら流し直す。新しい登録として扱う)。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  allForms,
  bigHitExpectation,
  comboProb,
  conditionId,
  CONDITION_KEYS,
  COMBO_BETS,
  evaluateForm,
  formBet,
  formId,
  harvilleOrdered,
  raceConditions,
  roiWithoutTop,
  splitConditionId,
  takeoutOf,
  toAnalysisRace,
  type AnalysisRace,
  type ComboBet,
  type ConditionLabels,
  type Discount,
  type Form,
  type RawRace,
} from "./lib.js";
import {
  bootstrapRoi,
  judgeCandidates,
  selectConditionCandidates,
  selectFormCandidates,
  zPoisson,
  type Candidate,
  type ConditionResult,
  type FormResult,
  type Judgement,
} from "./stats.js";

interface Args {
  mode: "explore" | "confirm";
  from: string;
  to: string;
  hist: string;
  out: string;
  label: string;
  candidates?: string;
  reps: number;
  seed: number;
  /** explore で候補(candidates.json)を書かない(後半の記述のための全表だけを出す)。 */
  noCandidates: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, dflt?: string): string => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]!;
    if (dflt !== undefined) return dflt;
    throw new Error(`--${name} が要る`);
  };
  const mode = get("mode");
  if (mode !== "explore" && mode !== "confirm") throw new Error("--mode は explore か confirm");
  return {
    mode,
    from: get("from"),
    to: get("to"),
    hist: get("hist"),
    out: get("out"),
    label: get("label"),
    candidates: mode === "confirm" ? get("candidates") : undefined,
    reps: Number(get("reps", "2000")),
    seed: Number(get("seed", "654")),
    noCandidates: argv.includes("--no-candidates"),
  };
}

function loadRaces(path: string, from: string, to: string): { races: AnalysisRace[]; dropped: number; total: number } {
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  const races: AnalysisRace[] = [];
  let dropped = 0;
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as RawRace;
    if (raw.date < from || raw.date > to) continue;
    total++;
    const r = toAnalysisRace(raw);
    if (r) races.push(r);
    else dropped++;
  }
  races.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.raceId < b.raceId ? -1 : 1));
  return { races, dropped, total };
}

/** 2・3 着の割引 λ・μ を 1〜3 着(三連単の的中)の最尤で当てる(格子探索 0〜1.5、刻み 0.05)。 */
function fitDiscount(races: readonly AnalysisRace[]): { discount: Discount; logLik: number; harvilleLogLik: number; n: number } {
  const orders: { q: number[]; combo: number[] }[] = [];
  for (const r of races) {
    const h = r.hits.trifecta?.[0];
    if (h) orders.push({ q: r.q, combo: h.combo });
  }
  const ll = (d: Discount): number => orders.reduce((a, o) => a + Math.log(harvilleOrdered(o.q, o.combo, d)), 0);
  let best: Discount = { lambda: 1, mu: 1 };
  let bestLl = -Infinity;
  for (let l = 0; l <= 30; l++)
    for (let m = 0; m <= 30; m++) {
      const d = { lambda: l * 0.05, mu: m * 0.05 };
      const v = ll(d);
      if (v > bestLl) {
        bestLl = v;
        best = d;
      }
    }
  return { discount: best, logLik: bestLl, harvilleLogLik: ll({ lambda: 1, mu: 1 }), n: orders.length };
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i]!;
}

/** 形の集計を FormResult にする(perRace・hitPayouts も持つ)。 */
function formResult(races: readonly AnalysisRace[], form: Form, discount: Discount, idPrefix = ""): FormResult {
  const ev = evaluateForm(races, form, discount);
  return {
    id: idPrefix + formId(form),
    family: "family" in form ? form.family : "-",
    bet: formBet(form),
    definition: form,
    ...ev,
  };
}

/** 書き出し用(perRace を落とし、区間と感度を足す)。 */
interface FormSummary {
  id: string;
  bet: ComboBet;
  family: string;
  races: number;
  tickets: number;
  ticketsPerRace: number;
  hits: number;
  expectedHits: number;
  expectedHitsDiscounted: number;
  z: number;
  roi: number;
  lo: number;
  hi: number;
  pAbove1: number;
  roiTop1: number;
  roiTop3: number;
  roiTop5: number;
  fairRatio: number;
  returnYen: number;
  maxPayout: number;
}

function summarize(r: FormResult, reps: number, seed: number): FormSummary {
  const b = r.races > 0 ? bootstrapRoi(r.perRace, reps, seed) : { lo: Number.NaN, hi: Number.NaN, mean: Number.NaN, pAbove1: Number.NaN };
  return {
    id: r.id,
    bet: r.bet,
    family: r.family,
    races: r.races,
    tickets: r.tickets,
    ticketsPerRace: r.races ? r.tickets / r.races : Number.NaN,
    hits: r.hits,
    expectedHits: r.expectedHits,
    expectedHitsDiscounted: r.expectedHitsDiscounted ?? r.expectedHits,
    z: zPoisson(r.hits, r.expectedHits),
    roi: r.roi,
    lo: b.lo,
    hi: b.hi,
    pAbove1: b.pAbove1,
    roiTop1: roiWithoutTop(r, 1),
    roiTop3: roiWithoutTop(r, 3),
    roiTop5: roiWithoutTop(r, 5),
    fairRatio: r.fairYen > 0 ? r.returnYen / r.fairYen : Number.NaN,
    returnYen: r.returnYen,
    maxPayout: r.hitPayouts.length ? Math.max(...r.hitPayouts) : 0,
  };
}

/** 条件 × 券種の集計。 */
function conditionResult(
  races: readonly AnalysisRace[],
  key: keyof ConditionLabels,
  value: string,
  bet: ComboBet,
  reps: number,
  seed: number,
  discount?: Discount,
): ConditionResult {
  const t = takeoutOf(bet);
  const all = evaluateForm(races, { kind: "all", bet });
  const b = all.races > 0 ? bootstrapRoi(all.perRace, reps, seed, 1 - t) : { lo: Number.NaN, hi: Number.NaN, mean: Number.NaN, pAbove1: Number.NaN };
  let bigHits = 0;
  let bigExp = 0;
  let hugeHits = 0;
  let hugeExp = 0;
  let bigExpDiscounted = 0;
  for (const r of races) {
    bigExp += bigHitExpectation(r.q, bet, 10000);
    hugeExp += bigHitExpectation(r.q, bet, 100000);
    if (discount) bigExpDiscounted += bigHitExpectation(r.q, bet, 10000, discount);
    for (const h of r.hits[bet] ?? []) {
      if (h.payout >= 10000) bigHits++;
      if (h.payout >= 100000) hugeHits++;
    }
  }
  return {
    id: `${key}=${value}|${bet}`,
    bet,
    condition: { key, value },
    races: all.races,
    allRoi: all.roi,
    allRoiLo: b.lo,
    allRoiHi: b.hi,
    bigHits,
    bigHitsExpected: bigExp,
    bigHitsExpectedDiscounted: discount ? bigExpDiscounted : undefined,
    hugeHits,
    hugeHitsExpected: hugeExp,
    fairRatio: all.fairYen > 0 ? all.returnYen / all.fairYen : Number.NaN,
    perRace: all.perRace,
    hitPayouts: all.hitPayouts,
  };
}

function stripCondition(c: ConditionResult): Omit<ConditionResult, "perRace" | "hitPayouts"> & { roiTop3: number; bigRatio: number; bigZ: number } {
  const { perRace, hitPayouts, ...rest } = c;
  const tickets = (perRace ?? []).reduce((a, x) => a + x.cost, 0) / 100;
  const returnYen = (perRace ?? []).reduce((a, x) => a + x.ret, 0);
  return {
    ...rest,
    roiTop3: roiWithoutTop({ tickets, returnYen, hitPayouts: hitPayouts ?? [] }, 3),
    bigRatio: c.bigHitsExpected > 0 ? c.bigHits / c.bigHitsExpected : Number.NaN,
    bigZ: zPoisson(c.bigHits, c.bigHitsExpected),
  };
}

interface CandidatesFile {
  plan: string;
  period: { from: string; to: string };
  params: { entropyCuts: [number, number]; discount: Discount; reps: number; seed: number };
  candidates: Candidate[];
}

/** 条件の値ごとにレースを分ける。 */
function groupByCondition(races: readonly AnalysisRace[], cuts: [number, number]): Map<string, AnalysisRace[]> {
  const groups = new Map<string, AnalysisRace[]>();
  for (const r of races) {
    const labels = raceConditions(r, { entropyCuts: cuts });
    for (const key of CONDITION_KEYS) {
      const id = conditionId(key, labels[key]);
      const g = groups.get(id) ?? [];
      g.push(r);
      groups.set(id, g);
    }
  }
  return groups;
}

/** 的中組合せの R·p/100 の平均(控除率の仮定の確かめ。1−t に近いはず)。 */
function levelCheck(races: readonly AnalysisRace[]): Record<ComboBet, { n: number; meanRp: number; oneMinusT: number }> {
  const out = {} as Record<ComboBet, { n: number; meanRp: number; oneMinusT: number }>;
  for (const bet of COMBO_BETS) {
    let n = 0;
    let sum = 0;
    for (const r of races) {
      for (const h of r.hits[bet] ?? []) {
        n++;
        sum += (h.payout * comboProb(bet, r.q, h.combo)) / 100;
      }
    }
    out[bet] = { n, meanRp: n ? sum / n : Number.NaN, oneMinusT: 1 - takeoutOf(bet) };
  }
  return out;
}

function fmt(x: number | undefined, d = 3): string {
  return x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d);
}

function judgementMarkdown(j: readonly Judgement[], candidates: readonly Candidate[]): string {
  const byId = new Map(candidates.map((c) => [`${c.family}:${c.id}:${c.f3Kind ?? ""}`, c]));
  const lines: string[] = [];
  lines.push("| 族 | 候補 | 後半 N | 点数/レース | 的中 | 見込み | z | ROI | 95% 区間 | 上位1/3/5 除外 | p | BH q | Holm | 残る | 理由 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of j) {
    const c = byId.get(`${row.family}:${row.id}:${row.f3Kind ?? ""}`);
    const fh = c?.firstHalf;
    const first = fh ? ` (前半 ROI ${fmt(fh.roi)}${fh.lo !== undefined ? ` [${fmt(fh.lo)}, ${fmt(fh.hi)}]` : ""})` : "";
    lines.push(
      `| ${row.family} | ${row.id}${first} | ${row.races} | ${fmt(row.ticketsPerRace, 1)} | ${row.hits} | ${fmt(row.expectedHits, 1)} | ${fmt(row.z, 2)} | ${fmt(row.roi)} | [${fmt(row.lo)}, ${fmt(row.hi)}] | ${fmt(row.roiTop1)}/${fmt(row.roiTop3)}/${fmt(row.roiTop5)} | ${fmt(row.p, 4)} | ${fmt(row.bhQ, 4)} | ${fmt(row.holmP, 4)} | ${row.survived ? "○" : "×"} | ${row.reasons.join("・")} |`,
    );
  }
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const { races, dropped, total } = loadRaces(args.hist, args.from, args.to);
  console.log(`期間 ${args.from}〜${args.to}: ${total} レース、使う ${races.length}、外した ${dropped}`);

  if (args.mode === "explore") {
    const fit = fitDiscount(races);
    console.log(`割引 λ=${fit.discount.lambda} μ=${fit.discount.mu} (logLik ${fit.logLik.toFixed(1)} vs Harville ${fit.harvilleLogLik.toFixed(1)}, n=${fit.n})`);
    const ent = races.map((r) => r.meta.entropy).sort((a, b) => a - b);
    const cuts: [number, number] = [quantile(ent, 1 / 3), quantile(ent, 2 / 3)];
    console.log(`エントロピーの境 ${cuts.map((c) => c.toFixed(4)).join(", ")}`);
    const level = levelCheck(races);
    const cf0 = { discount: fit.discount };

    // 形
    const forms = allForms();
    const formResults: FormResult[] = forms.map((f) => formResult(races, f, fit.discount));
    const formSummaries = formResults.map((r) => summarize(r, args.reps, args.seed));
    const formCandidates = selectFormCandidates(formResults, { reps: args.reps, seed: args.seed });
    console.log(`形 ${forms.length}、候補 F1 ${formCandidates.filter((c) => c.family === "F1").length}、F2 ${formCandidates.filter((c) => c.family === "F2").length}`);

    // 条件
    const groups = groupByCondition(races, cuts);
    const condResults: ConditionResult[] = [];
    for (const [id, rs] of groups) {
      const { key, value } = splitConditionId(id);
      for (const bet of COMBO_BETS) condResults.push(conditionResult(rs, key as keyof ConditionLabels, value, bet, args.reps, args.seed, cf0.discount));
    }
    const condCandidates = selectConditionCandidates(condResults);
    console.log(`条件 × 券種 ${condResults.length}、候補 F3 ${condCandidates.length}`);

    // 条件 × 形(F1 の候補の形に限る)
    const f1Forms = formCandidates.filter((c) => c.family === "F1").map((c) => c.id);
    const f4Results: FormResult[] = [];
    for (const fid of f1Forms) {
      const form = forms.find((f) => formId(f) === fid)!;
      for (const [cid, rs] of groups) f4Results.push(formResult(rs, form, fit.discount, `${cid}|`));
    }
    const f4Candidates = selectFormCandidates(f4Results, { reps: args.reps, seed: args.seed })
      .filter((c) => c.family === "F1")
      .map((c) => ({ ...c, family: "F4" as const }));
    console.log(`条件 × 形 ${f4Results.length}、候補 F4 ${f4Candidates.length}`);

    const candidates: CandidatesFile = {
      plan: "docs/investigations/payout-patterns-654/plan.md §6",
      period: { from: args.from, to: args.to },
      params: { entropyCuts: cuts, discount: fit.discount, reps: args.reps, seed: args.seed },
      candidates: [...formCandidates, ...condCandidates, ...f4Candidates],
    };
    if (args.noCandidates) console.log("--no-candidates: candidates.json は書かない(記述のための全表だけ)");
    else writeFileSync(join(args.out, "candidates.json"), JSON.stringify(candidates, null, 1));
    writeFileSync(
      join(args.out, `results-${args.label}.json`),
      JSON.stringify(
        {
          period: { from: args.from, to: args.to },
          races: races.length,
          dropped,
          discountFit: fit,
          entropyCuts: cuts,
          levelCheck: level,
          forms: formSummaries,
          conditions: condResults.map(stripCondition),
          conditionByForm: f4Results.map((r) => summarize(r, args.reps, args.seed)),
        },
        null,
        1,
      ),
    );
    console.log(`書き出し: ${join(args.out, `results-${args.label}.json`)}`);
    return;
  }

  // confirm
  const cf = JSON.parse(readFileSync(args.candidates!, "utf8")) as CandidatesFile;
  const forms = allForms();
  const formById = new Map(forms.map((f) => [formId(f), f]));
  const groups = groupByCondition(races, cf.params.entropyCuts);
  const results: Record<string, FormResult | ConditionResult> = {};
  for (const c of cf.candidates) {
    if (results[c.id]) continue;
    if (c.family === "F3") {
      const [cid, bet] = c.id.split("|") as [string, ComboBet];
      const { key, value } = splitConditionId(cid);
      results[c.id] = conditionResult(groups.get(cid) ?? [], key as keyof ConditionLabels, value, bet, args.reps, args.seed, cf.params.discount);
    } else if (c.family === "F4") {
      const [cid, fid] = c.id.split("|") as [string, string];
      results[c.id] = formResult(groups.get(cid) ?? [], formById.get(fid)!, cf.params.discount, `${cid}|`);
    } else {
      results[c.id] = formResult(races, formById.get(c.id)!, cf.params.discount);
    }
  }
  const judgement = judgeCandidates(cf.candidates, results, { reps: args.reps, seed: args.seed });
  const survived = judgement.filter((j) => j.survived);
  console.log(`候補 ${cf.candidates.length}、残った ${survived.length}`);
  for (const j of survived) console.log(`  ${j.family} ${j.id} ROI ${fmt(j.roi)} [${fmt(j.lo)}, ${fmt(j.hi)}] z ${fmt(j.z, 2)} BH q ${fmt(j.bhQ, 4)}`);
  writeFileSync(
    join(args.out, `judgement-${args.label}.json`),
    JSON.stringify({ period: { from: args.from, to: args.to }, races: races.length, dropped, levelCheck: levelCheck(races), judgement }, null, 1),
  );
  writeFileSync(join(args.out, `judgement-${args.label}.md`), judgementMarkdown(judgement, cf.candidates) + "\n");
  console.log(`書き出し: ${join(args.out, `judgement-${args.label}.json`)}`);
}

main();
