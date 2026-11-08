/** xcheck-m.py の出力を TS の式で再計算して比べる。使い方: pnpm tsx scripts/market-calib-694/xcheck-m.ts <xcheck.json> <fit-coef.json> */
import { readFileSync } from "node:fs";
import { marketPlaceProbs } from "../../packages/core/src/ev/market-shrink.js";
import { loadFitCoef, marketProbs, type FormulaId } from "./mix-formula.js";

const [xc, coefPath] = process.argv.slice(2) as [string, string];
const cases = JSON.parse(readFileSync(xc, "utf8")) as { f: FormulaId; odds: number[]; m: number[] }[];
const fc = loadFitCoef(coefPath);
let maxd = 0, n = 0, maxProd = 0;
for (const c of cases) {
  const m = marketProbs(c.odds.map((o, i) => ({ umaban: i + 1, p: 0.1, winOdds: o })), c.f, fc);
  if (c.f === "F_prod") {
    const prod = marketPlaceProbs(c.odds.map((o, i) => ({ umaban: i + 1, p: 0.1, winOdds: o })));
    c.m.forEach((v, i) => { maxProd = Math.max(maxProd, Math.abs(prod.get(i + 1)! - v)); });
  }
  c.m.forEach((v, i) => { maxd = Math.max(maxd, Math.abs(m.get(i + 1)! - v)); n++; });
}
console.log(`本番 marketPlaceProbs(F_prod)との最大差 ${maxProd.toExponential(2)}`);
console.log(`cases ${cases.length} horses ${n} max|TS-Py| ${maxd.toExponential(2)}`);
if (maxd > 1e-9 || maxProd > 1e-9) { console.error("不一致"); process.exit(1); }
