/**
 * #654: results-<label>.json を Markdown の表にする(報告用)。
 *
 *   pnpm exec tsx scripts/payout-patterns-654/render.ts <results.json> [--top N] [--bet quinella]
 */

import { readFileSync } from "node:fs";

interface FormSummary {
  id: string;
  bet: string;
  races: number;
  ticketsPerRace: number;
  hits: number;
  expectedHits: number;
  expectedHitsDiscounted: number;
  z: number;
  roi: number;
  lo: number;
  hi: number;
  roiTop1: number;
  roiTop3: number;
  roiTop5: number;
  fairRatio: number;
  maxPayout: number;
}

interface ConditionSummary {
  id: string;
  bet: string;
  races: number;
  allRoi: number;
  allRoiLo: number;
  allRoiHi: number;
  roiTop3: number;
  bigHits: number;
  bigHitsExpected: number;
  bigHitsExpectedDiscounted?: number;
  bigRatio: number;
  bigZ: number;
  hugeHits: number;
  hugeHitsExpected: number;
  fairRatio: number;
}

interface Results {
  period: { from: string; to: string };
  races: number;
  dropped: number;
  discountFit: { discount: { lambda: number; mu: number }; logLik: number; harvilleLogLik: number; n: number };
  entropyCuts: [number, number];
  levelCheck: Record<string, { n: number; meanRp: number; oneMinusT: number }>;
  forms: FormSummary[];
  conditions: ConditionSummary[];
  conditionByForm: FormSummary[];
}

const f = (x: number, d = 3): string => (Number.isFinite(x) ? x.toFixed(d) : "-");

function formTable(rows: readonly FormSummary[]): string {
  const out = [
    "| 形 | N | 点数/レース | 的中 | 見込み(Harville) | 見込み(割引) | z | ROI | 95% 区間 | 上位1/3/5 除外 | 配当の比 | 最大配当 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    out.push(
      `| ${r.id} | ${r.races} | ${f(r.ticketsPerRace, 1)} | ${r.hits} | ${f(r.expectedHits, 1)} | ${f(r.expectedHitsDiscounted, 1)} | ${f(r.z, 2)} | ${f(r.roi)} | [${f(r.lo)}, ${f(r.hi)}] | ${f(r.roiTop1)}/${f(r.roiTop3)}/${f(r.roiTop5)} | ${f(r.fairRatio, 2)} | ${r.maxPayout} |`,
    );
  }
  return out.join("\n");
}

function conditionTable(rows: readonly ConditionSummary[]): string {
  const out = [
    "| 条件 | 券種 | N | 全買い ROI | 95% 区間 | 上位3除外 | 万馬券 実際/見込み | 比 | z | 見込み(割引) | 10万円 実際/見込み | 配当の比 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    out.push(
      `| ${r.id.split("|")[0]} | ${r.bet} | ${r.races} | ${f(r.allRoi)} | [${f(r.allRoiLo)}, ${f(r.allRoiHi)}] | ${f(r.roiTop3)} | ${r.bigHits}/${f(r.bigHitsExpected, 1)} | ${f(r.bigRatio, 2)} | ${f(r.bigZ, 2)} | ${f(r.bigHitsExpectedDiscounted ?? Number.NaN, 1)} | ${r.hugeHits}/${f(r.hugeHitsExpected, 1)} | ${f(r.fairRatio, 2)} |`,
    );
  }
  return out.join("\n");
}

function main(): void {
  const [path, ...rest] = process.argv.slice(2);
  if (!path) throw new Error("results.json のパスが要る");
  const topArg = rest.indexOf("--top");
  const top = topArg >= 0 ? Number(rest[topArg + 1]) : 20;
  const betArg = rest.indexOf("--bet");
  const bet = betArg >= 0 ? rest[betArg + 1] : undefined;
  const res = JSON.parse(readFileSync(path, "utf8")) as Results;
  console.log(`# ${res.period.from}〜${res.period.to}: ${res.races} レース(外した ${res.dropped})`);
  console.log(`割引 λ=${res.discountFit.discount.lambda} μ=${res.discountFit.discount.mu}(logLik ${f(res.discountFit.logLik, 1)}、Harville ${f(res.discountFit.harvilleLogLik, 1)}、n=${res.discountFit.n})`);
  console.log(`エントロピーの境 ${res.entropyCuts.map((c) => f(c, 4)).join(", ")}`);
  console.log("\n## 水準(的中組合せの R·p/100 の平均と 1−t)");
  console.log("| 券種 | 的中 | 平均 R·p/100 | 1−t |\n|---|---|---|---|");
  for (const [k, v] of Object.entries(res.levelCheck)) console.log(`| ${k} | ${v.n} | ${f(v.meanRp)} | ${f(v.oneMinusT)} |`);

  const forms = res.forms.filter((r) => (bet ? r.bet === bet : true));
  console.log("\n## 基準の形(全買い・ボックス・1 着固定・軸)");
  console.log(formTable(forms.filter((r) => !/:[RQ]:/.test(r.id))));
  console.log(`\n## 形: ROI 上位 ${top}(N ≥ 300・的中 ≥ 30)`);
  console.log(formTable(forms.filter((r) => r.races >= 300 && r.hits >= 30).sort((a, b) => b.roi - a.roi).slice(0, top)));
  console.log(`\n## 形: 的中数の比 |z| 上位 ${top}(的中 ≥ 30)`);
  console.log(formTable(forms.filter((r) => r.hits >= 30).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, top)));
  console.log(`\n## 形: ROI 下位 ${top}(N ≥ 300・的中 ≥ 30)`);
  console.log(formTable(forms.filter((r) => r.races >= 300 && r.hits >= 30).sort((a, b) => a.roi - b.roi).slice(0, top)));

  const conds = res.conditions.filter((r) => (bet ? r.bet === bet : true) && r.races >= 200);
  console.log(`\n## 条件: 全買い ROI 上位 ${top}(N ≥ 200)`);
  console.log(conditionTable(conds.slice().sort((a, b) => b.allRoi - a.allRoi).slice(0, top)));
  console.log(`\n## 条件: 万馬券の比 上位 ${top}(見込み ≥ 10)`);
  console.log(conditionTable(conds.filter((r) => r.bigHitsExpected >= 10).sort((a, b) => b.bigRatio - a.bigRatio).slice(0, top)));
  console.log(`\n## 条件: 万馬券の比 下位 ${top}(見込み ≥ 10)`);
  console.log(conditionTable(conds.filter((r) => r.bigHitsExpected >= 10).sort((a, b) => a.bigRatio - b.bigRatio).slice(0, top)));
  if (res.conditionByForm.length) {
    console.log(`\n## 条件 × 形: ROI 上位 ${top}(N ≥ 300・的中 ≥ 30)`);
    console.log(formTable(res.conditionByForm.filter((r) => r.races >= 300 && r.hits >= 30).sort((a, b) => b.roi - a.roi).slice(0, top)));
  }
}

main();
