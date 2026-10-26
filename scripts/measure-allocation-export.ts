/**
 * クラウド版の「配分の再計算用の書き出し」(Issue #463・#494)の実測スクリプト。実際の規模に近い**合成データ**(既定: 943 レース・分析 1,600 件・1 レース 14 頭・全 6 券種の組合せオッズ。
 * レース数は #463 の 2026-10-23 の統計モデル用の書き出しの件数)を、ローカルの D1・R2 に**本番と同じ保存の文**(`packages/core/src/ev/analysis-store-codec.ts` の SQL と束縛値、`cloud/src/analysis-detail.ts` の詳細の符号化)で入れ、
 * ローカルの workerd(`wrangler dev --local`。本番の `src/worker.ts`)の書き出しの DO `AllocationExportDO` を `GET /api/export/allocation-dataset` で動かして測る。手法は `scripts/measure-prior-export.ts` と同じ。
 * 再現手順をコミット済みのコードに残すため(CLAUDE.md「再現手段のない数値を書かない」)。
 *
 * 測るもの:
 *  (i) 作成(`--repeat` 回): 作成の壁時計(最初の要求から ready まで)・要求の回数(ポーリング)・workerd の CPU 時間(`/proc/<pid>/stat` の utime+stime。刻み 10ms)・
 *      DO が数えた D1 の読み取り行数(`meta.rows_read` の合計。状態の `file.diag.rowsRead`)・R2 の取得を試みた回数(`file.diag.gets`)・ファイルの大きさ(gzip 後)
 *  (ii) ダウンロード: 壁時計・workerd の CPU(Worker が R2 の本体を流すだけ)・本体のバイト数・展開後のバイト数
 *  (iii) 開発側のローダでの読み込みと、計算し直し(`scripts/allocation-dataset.ts` の `summarizeReplay`。この機械の node での所要時間)。**合成データは分析時の提案を計算し直しと同じ関数で作っているので、一致率は 100% になるはず**
 *       (ならなければ、書き出し・ローダ・計算し直しのどこかが入力を落としている)。本番の一致率ではない。
 *
 * 合成データ(**乱数は固定の種で、同じ引数なら同じデータ**):
 *  - レースごとに、馬の確率(補正後の 3 着内率)と単勝・複勝のオッズ、6 券種(ワイド・馬連・馬単・三連複・三連単・枠連)の全組合せのオッズを作る。オッズは「市場の確率の粗い見積もり」から作り、
 *    対数正規の乱数で揺らしてあり、モデルの確率と市場が食い違うので、EV プラスの買い目が出る。**確率とオッズの分布は本番の実測ではない**(買い目の件数が本番と違いうる)。
 *  - 配分の記録(メタ行・買い目・下限で外した買い目)は、このオッズと確率から**本番の配分の関数**(`buildAllocationForRows`。分析時の保存と同じ。外した買い目を記録する)で作り、分析時の提案とスナップショットを整合させる。
 *  - 詳細(R2)は、`scripts/measure-d1-size.ts` と同じ実フィクスチャ(中央 16 頭の 202603020211・LLM の実応答)から作り、馬のオッズ・組合せ・レースの列だけを合成の値に差し替える(馬名など書き出しに入らない列と、
 *    寄与度・応答の大きさは実物のまま。DO が R2 から取って解凍・解析する CPU の見積もりが、小さすぎないようにするため)。
 *  - レース ID は中央 70%・地方 30%(`measure-verify.ts` の `syntheticRaceId`)。結果(着順・払戻・組合せ払戻・取込印)は全レースにある。1 レースに分析が複数あるとき、最新のものだけが書き出される。
 *  - 分析はすべて遮断済み(先読みの疑いなし)にする(遮断なしの旧い形の割合は、統計モデル用の書き出しの実測〈`measure-prior-export.ts`〉が見る)。
 *
 * 使い方(リポジトリのルートで。Linux のみ。/proc を使う。**ほかの wrangler・workerd が動いていないことを確かめてから、1 本だけ**):
 *   pnpm tsx scripts/measure-allocation-export.ts [--races 943] [--analyses 1600] [--horses 14] [--worst] [--repeat 1] [--port 8944]
 *   `--worst` は全レースを 18 頭にする(三連単 4,896 通りの最悪の構成。ファイルの大きさの上限の見積もり)。`--repeat` は 1 日の上限(3 回。DO の既定)を超えられない。
 *
 * 限界:
 *  - **この機械の CPU の速度・ローカルの D1(miniflare の SQLite)での値**。Cloudflare の本番の CPU・D1 の遅延とは一致しない。ローカルの workerd は CPU 上限を強制しない(使う量の測定であり、本番の上限の判定ではない)。
 *  - ローカルの D1 の `meta.rows_read` が本番と同じ数え方かは未確認(主キーの索引を引く文は、返した行数より多く数えられる)。本番の値は、最初の作成の `?status=1` の `file.diag.rowsRead` で確かめる。
 *  - 頭数の分布・買い目の件数・組合せの取得の状態(地方の軸馬別の取得が一部だけ、など)は本番の実測ではない。ファイルの大きさは主に頭数(三連単は n(n−1)(n−2) 通り)と、組合せが入るレースの割合で決まる。
 *  - 1 回の実行の値。下位桁に意味を読まないこと。CPU は 10ms の刻みで丸まる。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { encodeDetail } from "../cloud/src/analysis-detail.js";
import { buildAllocationForRows, recomputeAllocationFromProbs } from "../packages/core/src/analysis/recompute-allocation.js";
import {
  allocationBetParams,
  allocationMetaParams,
  analysisParams,
  comboPayoutParams,
  horseParams,
  INSERT_ALLOCATION_BET_SQL,
  INSERT_ALLOCATION_META_SQL,
  INSERT_ANALYSIS_HORSE_SQL,
  INSERT_ANALYSIS_SQL,
  INSERT_COMBO_PAYOUT_SQL,
  MARK_COMBO_IMPORTED_SQL,
  planComboWrites,
  raceResultParams,
  UPSERT_RACE_RESULT_META_SQL,
  UPSERT_RACE_RESULT_SQL,
} from "../packages/core/src/ev/analysis-store-codec.js";
import type { AnalysisAllocationRecord, AnalysisHorseRecord, AnalysisRecord, RaceComboPayoutsSaveInput, RaceResultEntry } from "../packages/core/src/ev/analysis-store-types.js";
import { buildComboOddsKeyFor, type ComboBetType } from "../packages/core/src/scraper/combo-odds-key.js";
import type { RaceData } from "../packages/core/src/scraper/scrape-race.js";
import { buildDetailText } from "./measure-d1-size.js";
import { syntheticContributions } from "./measure-prior-export.js";
import { syntheticRaceId } from "./measure-verify.js";
import { descendantsOf, parseProcStat } from "./measure-worker-cpu.js";
import { seededRandom } from "./synthetic-random.js";
import { parseAllocationDataset, summarize, summarizeReplay } from "./allocation-dataset.js";

interface SeedStatement {
  bind(...values: unknown[]): SeedStatement;
  first<T>(): Promise<T | null>;
}
interface SeedD1 {
  prepare(sql: string): SeedStatement;
  batch(statements: SeedStatement[]): Promise<Array<{ meta: { last_row_id: number } }>>;
}
interface SeedR2 {
  put(key: string, value: Uint8Array): Promise<unknown>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD = path.join(ROOT, "cloud");

export const COMBO_KINDS: readonly ComboBetType[] = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];

/** スナップショットの組合せの欄の名前(`cloud/src/allocation-export-format.ts` の `SNAPSHOT_COMBO_FIELD` と同じ)。 */
const SNAPSHOT_FIELD: Record<ComboBetType, string> = {
  wide: "wideCombo", trio: "trioCombo", quinella: "quinellaCombo", exacta: "exactaCombo", trifecta: "trifectaCombo", bracketQuinella: "bracketQuinellaCombo",
};

/** 合成のレースで使う設定(本番の既定に近い値。全券種を配分に含め、的中確率の下限は #470 の 0.05)。 */
export const SYNTHETIC_SETTINGS = {
  bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, includeComboOdds: true, includeWideInAllocation: true, includeTrioInAllocation: true, includeQuinellaInAllocation: true,
  includeExactaInAllocation: true, includeTrifectaInAllocation: true, includeBracketQuinellaInAllocation: true, minHitProb: 0.05,
} as const;

/** n 頭の枠番(1〜8)。n が 8 以下なら馬番と同じ。9 頭以上は、後ろの枠から順に 1 頭ずつ多くなる(中央・地方の枠の割り当ての規則)。 */
export function wakubanOf(n: number): number[] {
  if (n <= 8) return Array.from({ length: n }, (_, i) => i + 1);
  const base = Math.floor(n / 8);
  const extra = n % 8;
  const out: number[] = [];
  for (let frame = 1; frame <= 8; frame += 1) {
    const size = frame > 8 - extra ? base + 1 : base;
    for (let k = 0; k < size; k += 1) out.push(frame);
  }
  return out;
}

/** 合成した 1 レース。 */
export interface SyntheticRace {
  readonly raceId: string;
  readonly horses: ReadonlyArray<{ umaban: number; wakuban: number; prior: number; adjustedProb: number; winOdds: number; ninki: number; placeMin: number; placeMax: number }>;
  /** 券種ごとの全組合せのオッズ(キーは `buildComboOddsKeyFor`。枠連は枠番)。 */
  readonly combos: Record<ComboBetType, Record<string, number>>;
  readonly odds: RaceData["odds"];
  readonly horseRecords: AnalysisHorseRecord[];
  readonly allocation: AnalysisAllocationRecord;
  readonly entries: RaceResultEntry[];
  readonly combo: RaceComboPayoutsSaveInput;
  readonly wakubans: readonly number[];
  readonly finishOrder: readonly number[];
}

const lognormal = (rand: () => number, sigma: number): number => Math.exp((rand() + rand() + rand() + rand() - 2) * sigma * 1.73);
const clampOdds = (x: number): number => Math.round(Math.min(9999.9, Math.max(1.1, x)) * 10) / 10;

/**
 * 合成した 1 レース(`index` 番目。レース ID は `syntheticRaceId(index)`)。確率は強さの乱数から作り、市場の確率の粗い見積もり(`q`)に 0.75 の控除を掛けた逆数をオッズにして揺らす。
 * 配分の記録は、このオッズと確率から本番の配分の関数で作る(分析時の保存と同じ。下限で外した買い目も記録する)。
 */
export function syntheticRace(index: number, horseCount: number, rand: () => number): SyntheticRace {
  const n = horseCount;
  const raceId = syntheticRaceId(index);
  const strength = Array.from({ length: n }, () => 0.15 + rand() ** 2);
  const total = strength.reduce((a, b) => a + b, 0);
  const win = strength.map((s) => s / total); // 市場の単勝確率の粗い見積もり
  const place = win.map((w) => Math.min(0.92, w * 3 * (0.85 + 0.3 * rand()))); // 3 着内率
  const wakubans = wakubanOf(n);
  const frameWin = Array.from({ length: 8 }, () => 0);
  win.forEach((w, i) => (frameWin[wakubans[i]! - 1]! += w));
  const frameCount = Array.from({ length: 8 }, () => 0);
  wakubans.forEach((f) => (frameCount[f - 1]! += 1));
  const noise = (): number => lognormal(rand, 0.55);
  const market = (q: number): number => clampOdds((0.75 / Math.min(0.95, Math.max(1e-5, q))) * noise());

  const combos = Object.fromEntries(COMBO_KINDS.map((k) => [k, {} as Record<string, number>])) as Record<ComboBetType, Record<string, number>>;
  for (let a = 1; a <= n; a += 1) {
    for (let b = 1; b <= n; b += 1) {
      if (a === b) continue;
      const [pa, pb, wa, wb] = [place[a - 1]!, place[b - 1]!, win[a - 1]!, win[b - 1]!];
      if (a < b) {
        combos.wide[buildComboOddsKeyFor("wide", [a, b])] = market(pa * pb * 1.6);
        combos.quinella[buildComboOddsKeyFor("quinella", [a, b])] = market(wa * wb * 3.2);
      }
      combos.exacta[buildComboOddsKeyFor("exacta", [a, b])] = market(wa * wb * 1.6);
      for (let c = 1; c <= n; c += 1) {
        if (c === a || c === b) continue;
        if (a < b && b < c) combos.trio[buildComboOddsKeyFor("trio", [a, b, c])] = market(pa * pb * place[c - 1]! * 1.1);
        combos.trifecta[buildComboOddsKeyFor("trifecta", [a, b, c])] = market(wa * wb * win[c - 1]! * 2.4);
      }
    }
  }
  for (let fa = 1; fa <= 8; fa += 1) {
    for (let fb = fa; fb <= 8; fb += 1) {
      if (frameCount[fa - 1] === 0 || frameCount[fb - 1] === 0) continue;
      if (fa === fb && frameCount[fa - 1]! < 2) continue; // 同じ枠の組は、その枠に 2 頭以上いるときだけ実在する
      combos.bracketQuinella[buildComboOddsKeyFor("bracketQuinella", [fa, fb])] = market(fa === fb ? frameWin[fa - 1]! ** 2 * 1.5 : frameWin[fa - 1]! * frameWin[fb - 1]! * 2);
    }
  }

  // モデルの確率は市場の見積もりとずれる(ずれが EV プラスの買い目を作る)。
  const adjusted = place.map((p) => Math.min(0.95, Math.max(0.01, p * lognormal(rand, 0.3))));
  const prior = adjusted.map((p) => Math.min(0.95, Math.max(0.01, p * lognormal(rand, 0.1))));
  const winOdds = win.map((w) => clampOdds((0.8 / w) * noise()));
  const ranked = [...winOdds.keys()].sort((x, y) => winOdds[x]! - winOdds[y]!);
  const ninkiOf = new Map(ranked.map((idx, r) => [idx, r + 1] as const));
  const placeMin = place.map((p) => clampOdds((0.8 / p) * noise() * 0.9));
  const horses = Array.from({ length: n }, (_, i) => ({
    umaban: i + 1, wakuban: wakubans[i]!, prior: prior[i]!, adjustedProb: adjusted[i]!, winOdds: winOdds[i]!, ninki: ninkiOf.get(i)!, placeMin: placeMin[i]!, placeMax: clampOdds(placeMin[i]! * 1.4),
  }));

  const odds: RaceData["odds"] = {
    officialDatetime: null,
    oddsStatus: "result",
    win: Object.fromEntries(horses.map((h) => [h.umaban, { odds: h.winOdds, ninki: h.ninki }])),
    place: Object.fromEntries(horses.map((h) => [h.umaban, { oddsMin: h.placeMin, oddsMax: h.placeMax, ninki: null }])),
    wideCombo: combos.wide,
    trioCombo: combos.trio,
    quinellaCombo: combos.quinella,
    exactaCombo: combos.exacta,
    trifectaCombo: combos.trifecta,
    bracketQuinellaCombo: combos.bracketQuinella,
  };
  // 馬ごとの複勝下限と EV の行だけを取る(総資金 0 は『未設定』の経路で、配分の計算をしない=安い)。配分は次の行で、本来の設定で 1 回だけ計算する。
  const recomputed = recomputeAllocationFromProbs({
    raceId,
    horses: horses.map((h) => ({ umaban: h.umaban, wakuban: h.wakuban, horseName: "", prior: h.prior, adjustedProb: h.adjustedProb })),
    odds,
    allocationSettings: { ...SYNTHETIC_SETTINGS, bankroll: 0 },
    evConfig: { threshold: 1 },
  });
  // 分析時の保存と同じく、下限で外した買い目の記録つきで配分する(買い目は `recomputed` と同じ)。
  const { allocation } = buildAllocationForRows({ rows: recomputed.rows, raceId, odds, allocationSettings: SYNTHETIC_SETTINGS, evConfig: { threshold: 1 }, recordMissed: true });
  const horseRecords: AnalysisHorseRecord[] = recomputed.rows.map((r) => ({
    umaban: r.umaban, prior: r.prior, adjustedProb: r.adjustedProb, placeOddsMin: r.placeOddsMin, ev: r.ev, isPositive: r.isPositive, contributions: null, mark: null,
  }));

  // 結果: 市場の強さに乱数を掛けた順に着順を決める。払戻は、その組のオッズ(合成)× 100 円。
  const finishOrder = [...win.keys()].map((i) => ({ umaban: i + 1, key: (win[i]! + 0.02) * rand() })).sort((x, y) => y.key - x.key).map((x) => x.umaban);
  const entries: RaceResultEntry[] = finishOrder.map((umaban, k) => ({
    umaban, finishPosition: k + 1, placePayout: k < 3 ? Math.round(placeMin[umaban - 1]! * 100) : null, winPayout: k === 0 ? Math.round(winOdds[umaban - 1]! * 100) : null, passing: [3, 3, 2, 1], last3f: 34 + rand(),
  }));
  const [first, second, third] = finishOrder as [number, number, number];
  const payoutOf = (kind: ComboBetType, umabans: number[]): { umabans: number[]; payout: number } => ({ umabans, payout: Math.round((combos[kind][buildComboOddsKeyFor(kind, umabans)] ?? 10) * 100) });
  const frameOf = (u: number): number => wakubans[u - 1]!;
  const combo: RaceComboPayoutsSaveInput = {
    wide: { state: "parsed", payouts: [[first, second], [first, third], [second, third]].map((p) => payoutOf("wide", p)) },
    quinella: { state: "parsed", payouts: [payoutOf("quinella", [first, second])] },
    exacta: { state: "parsed", payouts: [payoutOf("exacta", [first, second])] },
    trio: { state: "parsed", payouts: [payoutOf("trio", [first, second, third])] },
    trifecta: { state: "parsed", payouts: [payoutOf("trifecta", [first, second, third])] },
    bracketQuinella: { state: "parsed", payouts: [payoutOf("bracketQuinella", [frameOf(first), frameOf(second)].sort((a, b) => a - b))] },
  };
  return { raceId, horses, combos, odds, horseRecords, allocation, entries, combo, wakubans, finishOrder };
}

/**
 * R2 に置く詳細の raceSnapshot。実フィクスチャ(中央 16 頭)の形と大きさのまま、馬のオッズ・組合せ・レースの列だけを合成の値にする。
 * 馬の数が 16 と違うときは、フィクスチャの馬を繰り返す(馬名などは書き出しに入らない)。
 */
export function snapshotOf(base: Record<string, unknown>, race: SyntheticRace): Record<string, unknown> {
  const baseHorses = base["horses"] as Array<Record<string, unknown>>;
  const baseRace = (base["race"] ?? {}) as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {
    ...base,
    race: { ...baseRace, courseType: "芝", distance: 1600, grade: null, oddsStatus: "result" },
    horses: race.horses.map((h, i) => ({
      ...baseHorses[i % baseHorses.length]!, umaban: h.umaban, wakuban: h.wakuban, winOdds: h.winOdds, popularity: h.ninki, placeOddsMin: h.placeMin, placeOddsMax: h.placeMax,
    })),
    comboOdds: Object.fromEntries(COMBO_KINDS.map((k) => [k, { state: "available" }])),
  };
  for (const kind of COMBO_KINDS) snapshot[SNAPSHOT_FIELD[kind]] = race.combos[kind];
  return snapshot;
}

function argNumber(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

function workerdTicks(wranglerPid: number): number {
  const table = new Map<number, { ppid: number; cpuTicks: number; comm: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf-8"));
      table.set(Number(entry), { ...stat, comm: readFileSync(`/proc/${entry}/comm`, "utf-8").trim() });
    } catch {
      // 読む間に終了したプロセス。
    }
  }
  const parents = new Map<number, number>([...table].map(([pid, v]) => [pid, v.ppid]));
  let total = 0;
  for (const pid of descendantsOf(wranglerPid, parents)) {
    const p = table.get(pid);
    if (p !== undefined && p.comm === "workerd") total += p.cpuTicks;
  }
  return total;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ExportView {
  status: string;
  phase?: string;
  file?: { generatedAt: string; rows: number; races: number; missingOdds: number; noAllocation: number; excluded: Record<string, number>; bytes: number; diag: { rowsRead: number; gets: number } } | null;
}

/** 下限で外した買い目の記録(`analysis_allocation_meta.missed_json`)。cloud の `serializeMissed` と同じ JSON(snake_case)。 */
const missedJson = (missed: AnalysisAllocationRecord["meta"]["missed"]): string | null =>
  missed === undefined || missed === null ? null : JSON.stringify(missed.map((m) => ({ bet_type: m.betType, combo_key: m.comboKey, hit_prob: m.hitProb, odds: m.odds, ev: m.ev, would_stake: m.wouldStake })));

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("このスクリプトは Linux(/proc)でだけ動きます");
  const races = argNumber("--races", 943);
  const analyses = argNumber("--analyses", 1600);
  const worst = process.argv.includes("--worst");
  const horseCount = worst ? 18 : argNumber("--horses", 14);
  const repeat = argNumber("--repeat", 1);
  const port = argNumber("--port", 8944);
  if (analyses < races) throw new Error("--analyses は --races 以上にしてください(1 レースに分析が 1 件以上)");
  const clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8" }).trim());
  const msPerTick = 1000 / clkTck;
  const dir = mkdtempSync(path.join(tmpdir(), "keiba-allocation-export-measure-"));
  const stateDir = path.join(dir, "state");
  const configPath = path.join(CLOUD, "wrangler.measure-allocation-export.generated.toml");
  const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
  writeFileSync(configPath, `${base}\n[access.dev]\naud = "measure-aud"\n\n[access.dev.identity]\nemail = "owner@example.com"\n`);
  const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  const wrangler = path.join(CLOUD, "node_modules", ".bin", "wrangler");
  let child: ReturnType<typeof spawn> | null = null;
  const stop = (): void => {
    if (child?.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // すでに終了。
      }
    }
  };
  process.on("exit", stop);
  try {
    // 1. migration を適用し、本番と同じ保存の文・束縛値で合成データを入れる。
    execFileSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "--config", configPath], { cwd: CLOUD, env, stdio: "pipe", timeout: 120_000 });
    const { getPlatformProxy } = createRequire(path.join(CLOUD, "package.json"))("wrangler") as {
      getPlatformProxy(options: { configPath: string; persist: { path: string } }): Promise<{ env: { DB: SeedD1; ANALYSIS_DETAIL: SeedR2 }; dispose(): Promise<void> }>;
    };
    const proxy = await getPlatformProxy({ configPath, persist: { path: path.join(stateDir, "v3") } });
    const db = proxy.env.DB;
    const seedStarted = Date.now();
    const detailBase = JSON.parse(buildDetailText()) as { raceSnapshot: Record<string, unknown>; rawResponse: string };
    const rand = seededRandom(494);
    const T0 = Date.UTC(2026, 9, 3, 3, 0, 0);
    const stats = { bets: 0, missed: 0, raceRows: 0 };
    const raceList: SyntheticRace[] = [];
    for (let r = 0; r < races; r += 1) raceList.push(syntheticRace(r, horseCount, rand));
    let saved = 0;
    for (let a = 0; a < analyses; a += 1) {
      const race = raceList[a % races]!;
      // 最初の `races` 件が各レースの最新の分析。あとの分析は、同じレースの古い分析(書き出しには入らない)。
      const analyzedAtMs = a < races ? T0 + a * 1000 : T0 - (a - races + 1) * 60_000;
      const snapshot = snapshotOf(detailBase.raceSnapshot, race);
      const kaisai = race.raceId.startsWith("202544") ? `2025${race.raceId.slice(6, 10)}` : "20251005";
      const rec: AnalysisRecord = {
        raceId: race.raceId, analyzedAt: new Date(analyzedAtMs).toISOString(), evEstimated: false, promptVersion: "v8", additionalInstruction: null, kaisaiDate: kaisai, model: "claude-sonnet-5-5",
        rawResponse: detailBase.rawResponse, raceSnapshot: snapshot, historyCutoffDate: kaisai, promptLookaheadGuarded: true, horses: race.horseRecords.map((h) => ({ ...h, contributions: syntheticContributions(rand) })), allocation: race.allocation,
      };
      const [inserted] = await db.batch([db.prepare(INSERT_ANALYSIS_SQL).bind(...analysisParams({ ...rec, rawResponse: null, raceSnapshot: null }))]);
      const id = inserted!.meta.last_row_id;
      const statements: SeedStatement[] = [db.prepare("UPDATE analyses SET detail_key = ? WHERE id = ?").bind(`analyses/${id}.json.gz`, id)];
      for (const h of rec.horses) statements.push(db.prepare(INSERT_ANALYSIS_HORSE_SQL).bind(...horseParams(id, { ...h, contributions: null })));
      const meta = race.allocation.meta;
      statements.push(db.prepare(INSERT_ALLOCATION_META_SQL).bind(...allocationMetaParams(id, meta)));
      // 的中確率の下限(Issue #470)の 3 列。本番の保存(`cloud/src/analysis-repository.ts` の UPDATE_MIN_HIT_PROB_SQL)と同じ列・同じ値。
      statements.push(db.prepare("UPDATE analysis_allocation_meta SET min_hit_prob = ?, below_floor_count = ?, missed_json = ? WHERE analysis_id = ?").bind(meta.minHitProb, meta.belowFloorCount ?? null, missedJson(meta.missed), id));
      for (const b of race.allocation.bets) statements.push(db.prepare(INSERT_ALLOCATION_BET_SQL).bind(...allocationBetParams(id, b)));
      await db.batch(statements);
      await proxy.env.ANALYSIS_DETAIL.put(`analyses/${id}.json.gz`, encodeDetail(rec));
      if (a < races) {
        stats.bets += race.allocation.bets.length;
        stats.missed += meta.missed?.length ?? 0;
      }
      saved += 1;
    }
    for (const race of raceList) {
      const statements: SeedStatement[] = race.entries.map((e) => db.prepare(UPSERT_RACE_RESULT_SQL).bind(...raceResultParams(race.raceId, e)));
      statements.push(db.prepare(UPSERT_RACE_RESULT_META_SQL).bind(race.raceId, "芝"));
      for (const e of race.entries) {
        const h = race.horses[e.umaban - 1]!;
        // 確定の単勝オッズ・人気(Issue #259)、取消の記録(Issue #72)、枠番(Issue #269)。本番の補完・取込と同じ列を直接書く(測定用の合成データ)。
        statements.push(db.prepare("UPDATE race_results SET win_odds = ?, ninki = ?, scratched = 0, wakuban = ? WHERE race_id = ? AND umaban = ?").bind(h.winOdds, h.ninki, h.wakuban, race.raceId, e.umaban));
      }
      for (const { betType, payouts } of planComboWrites(race.combo)) {
        for (const entry of payouts) statements.push(db.prepare(INSERT_COMBO_PAYOUT_SQL).bind(...comboPayoutParams(race.raceId, betType, entry)));
        statements.push(db.prepare(MARK_COMBO_IMPORTED_SQL).bind(race.raceId, betType));
      }
      await db.batch(statements);
      stats.raceRows += race.entries.length;
    }
    const tableCounts: Record<string, number> = {};
    for (const table of ["analyses", "analysis_horses", "analysis_allocation_meta", "analysis_bets", "race_results", "race_combo_payouts", "race_combo_payout_imports"]) {
      tableCounts[table] = (await db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
    }
    await proxy.dispose();
    const comboKeys = Object.fromEntries(COMBO_KINDS.map((k) => [k, Object.keys(raceList[0]!.combos[k]).length]));
    console.log(`## 合成データ(${((Date.now() - seedStarted) / 1000).toFixed(0)}秒): レース ${races}・分析 ${saved} 件(うち書き出されるのは各レースの最新の 1 件)・1 レース ${horseCount} 頭${worst ? "(--worst)" : ""}`);
    console.log(`  表の行数: ${JSON.stringify(tableCounts)}`);
    console.log(`  最新の分析の買い目: 計 ${stats.bets} 点(1 レース平均 ${(stats.bets / races).toFixed(1)} 点)・下限で外した買い目の記録 ${stats.missed} 点。先頭のレースの組合せのキー数: ${JSON.stringify(comboKeys)}`);

    // 2. 本番の worker.ts を wrangler dev --local で起動する。
    child = spawn(wrangler, ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", stateDir, "--config", configPath,
      "--var", "ACCESS_TEAM_NAME:measure", "--var", "ACCESS_AUD:measure-aud", "--var", "ACCESS_ALLOWED_EMAIL:owner@example.com"],
    { cwd: CLOUD, stdio: ["ignore", "pipe", "pipe"], detached: true, env });
    let logs = "";
    child.stdout?.on("data", (d: Buffer) => (logs += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (logs += d.toString()));
    for (let i = 0; ; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
        break;
      } catch {
        if (i > 90) throw new Error(`wrangler dev が起動しませんでした\n${logs.slice(-2000)}`);
        await sleep(1000);
      }
    }
    const pid = child.pid!;
    const url = `http://127.0.0.1:${port}/api/export/allocation-dataset`;

    // 3. (i) 作成を repeat 回。
    for (let n = 1; n <= repeat; n += 1) {
      const c0 = workerdTicks(pid);
      const started = Date.now();
      let polls = 0;
      let view: ExportView;
      const first = await fetch(`${url}${n === 1 ? "" : "?refresh=1"}`, { signal: AbortSignal.timeout(60_000) });
      await first.arrayBuffer();
      if (first.status !== 202) throw new Error(`作成が始まらなかった: ${first.status}`);
      for (;;) {
        polls += 1;
        view = (await (await fetch(`${url}?status=1`, { signal: AbortSignal.timeout(60_000) })).json()) as ExportView;
        if (view.status === "ready" && view.file !== null && view.file !== undefined && Date.parse(view.file.generatedAt) >= started) break;
        if (view.status === "failed") throw new Error(`作成が失敗した: ${JSON.stringify(view)}`);
        if (Date.now() - started > 30 * 60_000) throw new Error("30 分経っても作成が終わらない");
        await sleep(500);
      }
      const wall = Date.now() - started;
      const cpu = (workerdTicks(pid) - c0) * msPerTick;
      const f = view.file!;
      console.log(`\n## (i-${n}) 作成(${n === 1 ? "通常の GET" : "refresh=1"}): 壁時計 ${(wall / 1000).toFixed(1)}秒(状態のポーリング ${polls} 回)、workerd の CPU 合計 ${cpu.toFixed(0)}ms(10ms 刻み)`);
      console.log(`  ファイル: ${f.rows} 行・${f.races} レース・詳細なし ${f.missingOdds}・配分の記録なし ${f.noAllocation}・gzip ${f.bytes} バイト・除外 ${JSON.stringify(f.excluded)}`);
      console.log(`  D1 の読み取り行数(meta.rows_read の合計): ${f.diag.rowsRead} 行、R2 の取得を試みた回数: ${f.diag.gets}`);
    }

    // 4. (ii) ダウンロード。
    const c1 = workerdTicks(pid);
    const t1 = Date.now();
    const dl = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    const body = new Uint8Array(await dl.arrayBuffer());
    const dlWall = Date.now() - t1;
    const dlCpu = (workerdTicks(pid) - c1) * msPerTick;
    const raw = gunzipSync(body);
    console.log(`\n## (ii) ダウンロード: ${dl.status}・${dl.headers.get("content-disposition")}・本体 ${body.length} バイト(展開後 ${raw.length} バイト)、壁時計 ${dlWall}ms、workerd の CPU ${dlCpu.toFixed(0)}ms`);

    // 5. (iii) 開発側のローダで読み、計算し直す。
    const tLoad = Date.now();
    const loaded = parseAllocationDataset(body);
    const loadMs = Date.now() - tLoad;
    const tReplay = Date.now();
    const report = summarizeReplay(loaded.rows);
    const replayMs = Date.now() - tReplay;
    console.log(`\n## (iii) ローダ: 読み込み ${loadMs}ms・要約 ${JSON.stringify(summarize(loaded.rows))}・1 行の平均 ${Math.round(raw.length / Math.max(1, loaded.rows.length))} バイト`);
    console.log(`  計算し直し(この機械の node。${loaded.rows.length} レース): ${replayMs}ms(1 レースあたり ${(replayMs / Math.max(1, loaded.rows.length)).toFixed(1)}ms)`);
    console.log(`  一致率(合成データ。100% になるはず): ${JSON.stringify(report.total)}`);
    console.log(`  区分別: 中央 ${JSON.stringify(report.byVenueKind.central.reasons)}・地方 ${JSON.stringify(report.byVenueKind.nar.reasons)}`);
    console.log(`  自由文を含まない: ${!raw.toString("utf-8").includes('"reason"')}`);
  } finally {
    stop();
    rmSync(configPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
    await sleep(1000);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
