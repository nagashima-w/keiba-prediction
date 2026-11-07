/**
 * #649 段階 1: `fit.py` の scores.csv(各モデルのログオッズ)を、レース内で合計を目標に合わせて確率にし、指標を出す。
 *
 * 使い方: pnpm tsx scripts/stat-model-649/eval.ts <scores.csv> [出力.json]
 *
 * 確率にする: 勝率(合計 1)・2着内率(合計 2)・3着内率(合計 3)のロジットシフト(`normalizeLogitShift`)。
 * 現行(prior の Plackett–Luce 換算)は本番の確率をそのまま使う(勝率 = plWin、2着内率 = plTop2、3着内率 = prior)。
 * 指標: 対数損失・Brier(試験の月をまとめて)、月ごとの対数損失、市場(モデル `market`)に対する差のレース単位ブートストラップ、
 * 市場への係数(y ~ 1 + logit(モデル) + logit(市場))、単勝の回収率(確率 × 確定オッズ > 1 の馬に 1 ずつ。確定オッズは分析時点より情報が多い)。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { brier, fitLogistic, logLoss, logit, mulberry32, normalizeLogitShift, pairedRaceBootstrap, singleWinRoi } from "./lib.js";

type Obj = "win" | "top2" | "top3";
const OBJS: Obj[] = ["win", "top2", "top3"];
const TARGET: Record<Obj, number> = { win: 1, top2: 2, top3: 3 };
const MODELS = ["current", "q_raw", "market", "lr_odds", "lr_noodds", "xgb_odds"] as const;
type Model = (typeof MODELS)[number];
const LABEL: Record<Model, string> = {
  current: "(i) 現行(prior→PL 換算)",
  q_raw: "(0) 市場そのまま(1/オッズ)",
  market: "(ii) 市場だけ(LR)",
  lr_odds: "(iii) 案 L(オッズ入り LR)",
  lr_noodds: "(iv) オッズなし LR",
  xgb_odds: "(v) XGBoost(オッズ入り)",
};

interface Row {
  raceId: string;
  month: string;
  umaban: number;
  n: number;
  winOdds: number;
  q: number;
  prior: number;
  plWin: number;
  plTop2: number;
  y: Record<Obj, number>;
  s: Record<string, number>; // `${model}_${obj}` のログオッズ
}

function readScores(path: string): Row[] {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const head = lines[0]!.split(",");
  const col = (name: string): number => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`列がありません: ${name}`);
    return i;
  };
  const sCols = head.filter((h) => /^(market|lr_odds|lr_noodds|xgb_odds)_(win|top2|top3)$/.test(h));
  return lines.slice(1).map((line) => {
    const f = line.split(",");
    const s: Record<string, number> = {};
    for (const c of sCols) s[c] = Number(f[col(c)]);
    return {
      raceId: f[col("raceId")]!,
      month: f[col("month")]!,
      umaban: Number(f[col("umaban")]),
      n: Number(f[col("n")]),
      winOdds: Number(f[col("winOdds")]),
      q: Number(f[col("q")]),
      prior: Number(f[col("prior")]),
      plWin: Number(f[col("plWin")]),
      plTop2: Number(f[col("plTop2")]),
      y: { win: Number(f[col("y_win")]), top2: Number(f[col("y_top2")]), top3: Number(f[col("y_top3")]) },
      s,
    };
  });
}

/** レースごとの行の並び。 */
function byRace(rows: Row[]): Row[][] {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const l = m.get(r.raceId) ?? [];
    l.push(r);
    m.set(r.raceId, l);
  }
  return [...m.values()];
}

/** モデル・目的ごとの確率(rows と同じ順)。 */
function probs(races: Row[][], model: Model, obj: Obj): number[][] {
  return races.map((rs) => {
    if (model === "current") {
      return rs.map((r) => (obj === "win" ? r.plWin : obj === "top2" ? r.plTop2 : r.prior));
    }
    if (model === "q_raw") {
      // 市場そのままは勝率だけ意味がある(2着内・3着内は、市場の確率を同じロジットシフトで目標に合わせたもの)。
      const l = rs.map((r) => logit(Math.min(1 - 1e-9, Math.max(1e-9, r.q))));
      return obj === "win" ? rs.map((r) => r.q) : normalizeLogitShift(l, TARGET[obj]);
    }
    return normalizeLogitShift(
      rs.map((r) => r.s[`${model}_${obj}`]!),
      TARGET[obj],
    );
  });
}

const flat = <T>(xs: T[][]): T[] => xs.flat();
const ll = (p: number[], y: number[]): number => logLoss(p, y);
const f4 = (x: number | null): string => (x === null ? "—" : x.toFixed(4));

function main(): void {
  const [csv, jsonOut] = process.argv.slice(2);
  if (csv === undefined) throw new Error("使い方: eval.ts <scores.csv> [出力.json]");
  const rows = readScores(csv);
  const races = byRace(rows);
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const report: Record<string, unknown> = { races: races.length, horses: rows.length, months };
  console.log(`試験: ${months[0]}〜${months[months.length - 1]}  レース ${races.length}  馬 ${rows.length}`);

  const P: Record<string, number[][]> = {};
  for (const m of MODELS) for (const o of OBJS) P[`${m}_${o}`] = probs(races, m, o);
  const Y: Record<Obj, number[][]> = {
    win: races.map((rs) => rs.map((r) => r.y.win)),
    top2: races.map((rs) => rs.map((r) => r.y.top2)),
    top3: races.map((rs) => rs.map((r) => r.y.top3)),
  };

  // 整合: 勝率 ≤ 2着内率 ≤ 3着内率 を破る馬の割合。
  console.log("\n## 整合(勝率 ≤ 2着内率 ≤ 3着内率を破る馬の割合)");
  for (const m of MODELS) {
    const w = flat(P[`${m}_win`]!);
    const t2 = flat(P[`${m}_top2`]!);
    const t3 = flat(P[`${m}_top3`]!);
    const bad = w.filter((v, i) => v > t2[i]! + 1e-12 || t2[i]! > t3[i]! + 1e-12).length;
    console.log(`${LABEL[m]}: ${bad}/${w.length} (${((100 * bad) / w.length).toFixed(2)}%)`);
    (report[`inconsistent_${m}`] as unknown) = bad / w.length;
  }

  for (const o of OBJS) {
    console.log(`\n## 目的: ${o}(試験の月をまとめた対数損失・Brier)`);
    console.log("| モデル | 対数損失 | Brier | 市場(ii)との差(A−B) | 95%区間 | 差<0の割合 | 現行(i)との差(A−B) | 95%区間 | 市場への係数(z) |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    const yAll = flat(Y[o]);
    const mkt = P[`market_${o}`]!;
    for (const m of MODELS) {
      const p = P[`${m}_${o}`]!;
      const l = ll(flat(p), yAll);
      const b = brier(flat(p), yAll);
      let diff = "—";
      let ci = "—";
      let share = "—";
      let coef = "—";
      let dCur = "—";
      let dCurCi = "—";
      if (m !== "current") {
        const cur = P[`current_${o}`]!;
        const pc = races.map((_, i) => ({ a: p[i]!.length * ll(p[i]!, Y[o][i]!), b: cur[i]!.length * ll(cur[i]!, Y[o][i]!), n: p[i]!.length }));
        const bc = pairedRaceBootstrap(pc, 1000, 650);
        dCur = f4(bc.meanDiff);
        dCurCi = `[${f4(bc.ciLow)}, ${f4(bc.ciHigh)}]`;
        (report[`diffCur_${m}_${o}`] as unknown) = bc;
      }
      if (m !== "market") {
        const pairs = races.map((_, i) => {
          const a = p[i]!;
          const bb = mkt[i]!;
          const ys = Y[o][i]!;
          return { a: a.length * ll(a, ys), b: bb.length * ll(bb, ys), n: a.length };
        });
        const bs = pairedRaceBootstrap(pairs, 1000, 649);
        diff = f4(bs.meanDiff);
        ci = `[${f4(bs.ciLow)}, ${f4(bs.ciHigh)}]`;
        share = bs.shareBelowZero.toFixed(3);
        // 市場への係数: y ~ 1 + logit(モデル) + logit(市場 LR)。
        const mktFlat = flat(mkt);
        const x = flat(p).map((v, i) => [logit(Math.min(1 - 1e-6, Math.max(1e-6, v))), logit(Math.min(1 - 1e-6, Math.max(1e-6, mktFlat[i]!)))]);
        const fit = fitLogistic(x, yAll);
        coef = `${fit.coef[1]!.toFixed(3)} (z=${(fit.coef[1]! / fit.se[1]!).toFixed(2)})`;
        (report[`coef_${m}_${o}`] as unknown) = { coef: fit.coef[1], z: fit.coef[1]! / fit.se[1]!, marketCoef: fit.coef[2] };
        (report[`diff_${m}_${o}`] as unknown) = bs;
      }
      (report[`ll_${m}_${o}`] as unknown) = l;
      (report[`brier_${m}_${o}`] as unknown) = b;
      console.log(`| ${LABEL[m]} | ${f4(l)} | ${f4(b)} | ${diff} | ${ci} | ${share} | ${dCur} | ${dCurCi} | ${coef} |`);
    }
  }

  console.log("\n## 月ごとの対数損失(勝率 / 2着内率 / 3着内率の順。市場(ii)と案 L とオッズなしと現行)");
  console.log("| 月 | レース | 現行 | 市場 | 案L | オッズなし | XGB |");
  console.log("|---|---|---|---|---|---|---|");
  for (const mo of months) {
    const idx = races.map((rs, i) => (rs[0]!.month === mo ? i : -1)).filter((i) => i >= 0);
    const cell = (m: Model): string =>
      OBJS.map((o) => f4(ll(idx.flatMap((i) => P[`${m}_${o}`]![i]!), idx.flatMap((i) => Y[o][i]!)))).join(" / ");
    console.log(`| ${mo} | ${idx.length} | ${cell("current")} | ${cell("market")} | ${cell("lr_odds")} | ${cell("lr_noodds")} | ${cell("xgb_odds")} |`);
  }

  console.log("\n## 単勝の回収率(確率 × 確定オッズ > 1 の馬に 1 ずつ。確定オッズは分析の約 45 分前より情報が多い)");
  console.log("| モデル | 賭けた馬 | 回収率 | 95%区間(レース単位) | 全馬に賭けた回収率 |");
  console.log("|---|---|---|---|---|");
  const allBets = singleWinRoi(rows.map((r) => ({ p: 2, odds: r.winOdds, win: r.y.win === 1 })));
  for (const m of MODELS) {
    const p = P[`${m}_win`]!;
    const perRace = races.map((rs, i) => {
      const r = singleWinRoi(rs.map((x, j) => ({ p: p[i]![j]!, odds: x.winOdds, win: x.y.win === 1 })));
      return { bets: r.bets, payout: r.payout };
    });
    const tot = perRace.reduce((s, r) => ({ bets: s.bets + r.bets, payout: s.payout + r.payout }), { bets: 0, payout: 0 });
    const rnd = mulberry32(649);
    const rois: number[] = [];
    for (let it = 0; it < 1000; it++) {
      let b = 0;
      let pay = 0;
      for (let k = 0; k < perRace.length; k++) {
        const r = perRace[Math.floor(rnd() * perRace.length)]!;
        b += r.bets;
        pay += r.payout;
      }
      if (b > 0) rois.push(pay / b);
    }
    rois.sort((a, b) => a - b);
    const lo = rois[Math.floor(0.025 * rois.length)];
    const hi = rois[Math.floor(0.975 * rois.length)];
    console.log(`| ${LABEL[m]} | ${tot.bets} | ${tot.bets === 0 ? "—" : (tot.payout / tot.bets).toFixed(3)} | ${lo === undefined ? "—" : `[${lo.toFixed(3)}, ${hi!.toFixed(3)}]`} | ${allBets.roi!.toFixed(3)} |`);
    (report[`roi_${m}`] as unknown) = { bets: tot.bets, roi: tot.bets === 0 ? null : tot.payout / tot.bets, ci: [lo, hi] };
  }
  if (jsonOut !== undefined) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
}

main();
