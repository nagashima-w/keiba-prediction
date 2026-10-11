/**
 * スパイク結果の型・ログ出力・Markdown 化(Issue #159〈#21-A〉)。
 *
 * **ログへの出し方が設計の核**: メイン(オーケストレーター)が読めるのは Actions のジョブログ本文だけで、
 * artifact をダウンロードできる保証がない。そこで結果 JSON の全文を、前後を印で挟んだ**1行**で
 * ジョブログに出す({@link formatResultBlock})。ログは末尾から取得されるため、出力はジョブの後半に置く。
 */

import {
  DOCUMENTED_DO_CPU_LIMIT_MS,
  estimateCpuPerRepMs,
  summarizeIndependence,
  type SearchResult,
} from "./cpu-search.js";
import { renderOriginMarkdown } from "./origin-report.js";
import type { OriginResult } from "./origin-run.js";
import { renderSocketMatrixMarkdown } from "./socket-matrix-report.js";
import type { SocketMatrixResult } from "./socket-matrix-run.js";
import {
  compareSources,
  judgeReachability,
  summarizeReachability,
  type NetkeibaProbeRecord,
  type ProbeSource,
} from "./reachability.js";

export const RESULT_BEGIN_MARKER = "===CF-SPIKE-RESULT-BEGIN===";
export const RESULT_END_MARKER = "===CF-SPIKE-RESULT-END===";

export type CpuRuntime = "worker" | "durableObject";
/**
 * 測る処理。parse=出馬表1ページのパース / score=1レース分の確率計算(prior) /
 * alloc=配分計算(単勝・複勝・ワイド・三連複) / allocFull=配分計算(全券種の実オッズ込み。実運用と同じ負荷)。
 */
export type CpuWork = "parse" | "score" | "alloc" | "allocFull";

/** CPU 探索で投げた1リクエストの記録。 */
export interface CpuSample {
  readonly runtime: CpuRuntime;
  readonly work: CpuWork;
  readonly reps: number;
  readonly status: number | null;
  readonly kind: string;
  /** ドライバ側の壁時計(ミリ秒)。 */
  readonly wallMs: number;
  /** 本番では処理の直後の時刻差は 0 になりうる(I/O が無いと時計が進まないため)。 */
  readonly insideMs: number | null;
  /** 処理のあとに I/O を1つ挟んだ後の時刻差(補助の測定)。 */
  readonly afterIoMs: number | null;
  readonly bodyHead: string | null;
  /**
   * Worker で CPU 超過になった直後に投げた、処理を伴わない /ping の HTTP ステータス(通信失敗は null)。
   * 超過の後の測定が独立かを確かめるため(未実施は undefined)。
   */
  readonly pingAfter?: number | null;
}

/** ローカル(workerd)での1回あたりの計測。ローカルは時計が進むので ms が読める(本番とは CPU が違う)。 */
export interface LocalCalibrationEntry {
  readonly runtime: CpuRuntime;
  readonly work: CpuWork;
  readonly reps: number;
  /** 同じ条件で繰り返した回数(ばらつきの母数)。 */
  readonly runs: number;
  /** 1 reps あたりの ms を、runs 回について小さい順に並べたもの。 */
  readonly perRepMsSorted: readonly number[];
}

export interface CleanupInfo {
  /** 削除ステップの後も残っていた、接頭辞付きの Worker(最終的に消えたかは ok と deletedByFallback を見る)。 */
  readonly leftoverWorkers: readonly string[];
  /** 残っていたため API の DELETE で消した Worker。 */
  readonly deletedByFallback: readonly string[];
  readonly durableObjectNamespaces: "removed" | "remaining" | "unknown";
  readonly ok: boolean;
  readonly listUnavailable?: boolean;
}

export interface CpuSearches {
  parse: SearchResult | null;
  score: SearchResult | null;
  alloc: SearchResult | null;
  allocFull: SearchResult | null;
}

export interface SpikeResult {
  schemaVersion: 1;
  runId: string;
  startedAt: string | null;
  finishedAt: string | null;
  netkeiba: {
    records: NetkeibaProbeRecord[];
    requestCount: number;
    /** 全体の打ち切り理由(本数の上限)。 */
    stoppedReason: string | null;
    /** 送信元ごとの打ち切り理由(連続拒否)。第1ラウンドの結果には無い。 */
    stoppedBySource?: Record<ProbeSource, string | null>;
  };
  selftest: { eucJpRoundTrip: boolean | null; detail: string | null };
  cpu: { worker: CpuSearches; durableObject: CpuSearches; samples: CpuSample[] };
  local: { entries: LocalCalibrationEntry[] } | null;
  cleanup: CleanupInfo | null;
  notes: string[];
  /** この実行で選んだ実験(`SPIKE_EXPERIMENTS`)。#159 の結果には無い。 */
  experiments?: string[];
  /** 400 の原因の切り分け(Issue #160〈#21-B〉)の結果。選ばなかった実行・#159 の結果には無い。 */
  origin?: OriginResult;
  /** DO の中のソケットでの取得(Issue #162 段階1)の結果。選ばなかった実行・過去の結果には無い。 */
  socketMatrix?: SocketMatrixResult;
}

/** 測る処理の一覧(表示順)。 */
export const CPU_WORKS: readonly CpuWork[] = ["parse", "score", "alloc", "allocFull"];

/** 何も測っていない結果の雛形。 */
export function emptyResult(runId: string): SpikeResult {
  return {
    schemaVersion: 1,
    runId,
    startedAt: null,
    finishedAt: null,
    netkeiba: { records: [], requestCount: 0, stoppedReason: null, stoppedBySource: { worker: null, runner: null } },
    selftest: { eucJpRoundTrip: null, detail: null },
    cpu: {
      worker: { parse: null, score: null, alloc: null, allocFull: null },
      durableObject: { parse: null, score: null, alloc: null, allocFull: null },
      samples: [],
    },
    local: null,
    cleanup: null,
    notes: [],
  };
}

/** 「拒否」と数えるのは blocked(400/403/429)と challenge だけ。それ以外の失敗は判定不能として集計から外す。 */
const CONTROL_READING: Record<ReturnType<typeof compareSources>["conclusion"], string> = {
  "both-ok": "both-ok: Worker からもランナーからも読めた。",
  "both-blocked":
    "both-blocked: Worker からもランナーからも拒否(400/403/429 または challenge)された。Cloudflare 固有ではない(データセンター IP 全般、またはリクエストの内容による可能性)。",
  "worker-only-blocked":
    "worker-only-blocked: Worker だけが拒否(400/403/429 または challenge)された。Cloudflare(Workers)からのアクセスに固有の疑いがある。",
  "runner-only-blocked": "runner-only-blocked: ランナーだけが拒否(400/403/429 または challenge)された。",
  mixed: "mixed: 対象によって結果が違う(表を参照)。",
  inconclusive:
    "inconclusive: 判定できた対が1つも無い(通信エラー・想定外のステータス・パース失敗・転送などは、拒否とは数えない)。",
  "no-pairs": "no-pairs: Worker とランナーの両方を測れた対象がない。",
};

/** 結果を、開始印・JSON1行・終了印のちょうど3行にして返す。 */
export function formatResultBlock(result: SpikeResult): string {
  // JSON.stringify は(インデント無しなら)改行を出さない。文字列中の改行は \n にエスケープされる。
  return `${RESULT_BEGIN_MARKER}\n${JSON.stringify(result)}\n${RESULT_END_MARKER}`;
}

/**
 * ジョブログ本文から、最後の結果ブロックを取り出す。行頭のタイムスタンプ・BOM・前後の他の行は無視する。
 * 見つからない・終了印が無い・JSON が壊れている場合は null(例外にしない)。
 */
export function extractResultBlock(log: string): SpikeResult | null {
  const lines = log.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]!.includes(RESULT_END_MARKER)) {
      continue;
    }
    // 終了印より前に、開始印 → JSON 行 の並びがあるか。
    const jsonLine = lines[i - 1];
    const beginLine = lines[i - 2];
    if (jsonLine === undefined || beginLine === undefined || !beginLine.includes(RESULT_BEGIN_MARKER)) {
      continue;
    }
    const start = jsonLine.indexOf("{");
    if (start < 0) {
      continue;
    }
    try {
      return JSON.parse(jsonLine.slice(start)) as SpikeResult;
    } catch {
      continue;
    }
  }
  return null;
}

function describeSearch(search: SearchResult): {
  maxPass: string;
  minFail: string;
} {
  let maxPass: string;
  if (search.maxPassReps !== null) {
    maxPass = String(search.maxPassReps);
  } else {
    // 「通過」は全試行が通った点。最初の点で一部の試行が通っていたら、内訳を添える(全部失敗と区別するため)。
    const first = search.points[0];
    maxPass =
      first !== undefined && first.ok > 0
        ? `通過なし(reps=${first.reps} は ${first.ok} 回通過・${first.cpuExceeded} 回超過)`
        : "通過なし";
  }
  let minFail: string;
  if (search.minFailReps !== null) {
    minFail = String(search.minFailReps);
  } else if (search.reachedMax) {
    minFail = "上限未検出";
  } else if (search.inconclusive) {
    minFail = "判定不能";
  } else {
    minFail = "不明";
  }
  return { maxPass, minFail };
}

function searchRow(label: string, work: string, search: SearchResult | null): string {
  if (search === null) {
    return `| ${label} | ${work} | 未実施 | 未実施 | 未実施 | 未実施 |`;
  }
  const { maxPass, minFail } = describeSearch(search);
  return `| ${label} | ${work} | ${maxPass} | ${minFail} | ${search.stopReason} | ${search.totalProbes} |`;
}

/** 結果を Markdown にする(step summary と report.md の下書きに使う)。 */
export function renderMarkdown(result: SpikeResult): string {
  const out: string[] = [];
  out.push(`# Cloudflare 移行スパイク結果(run ${result.runId})`);
  out.push("");
  out.push(`- 開始: ${result.startedAt ?? "未実施"} / 終了: ${result.finishedAt ?? "未実施"}`);
  if (result.experiments !== undefined) {
    out.push(`- 実行した実験: ${result.experiments.join(", ")}`);
  }
  out.push("");
  /** 実験を選ぶ仕組みを持つ実行(experiments あり)で、その実験を選んでいたか。旧形式(experiments なし)は常に true。 */
  const selected = (name: string): boolean => result.experiments === undefined || result.experiments.includes(name);

  out.push("## 到達性(netkeiba への取得。Worker とランナーの対照)");
  out.push("");
  const records = result.netkeiba.records;
  if (records.length === 0) {
    out.push(selected("reachability") ? "未実施" : "未実施(この実行では選んでいない)");
  } else {
    const summary = summarizeReachability(records);
    const stopped = result.netkeiba.stoppedBySource;
    out.push(
      `- 出したリクエスト(Worker とランナーの合計): ${result.netkeiba.requestCount} 本 / 全体の打ち切り理由: ${result.netkeiba.stoppedReason ?? "なし"}`,
    );
    if (stopped !== undefined) {
      out.push(
        `- 送信元ごとの打ち切り: worker: ${stopped.worker ?? "なし"} / runner: ${stopped.runner ?? "なし"}`,
      );
    }
    out.push(
      `- 判定の件数: ${Object.entries(summary.counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" / ")}`,
    );
    out.push(
      `- 送信元ごとの ok / 総数: worker ${summary.bySource.worker.ok} / ${summary.bySource.worker.total}、runner ${summary.bySource.runner.ok} / ${summary.bySource.runner.total}`,
    );
    out.push("");
    out.push("| ホスト | ok / 総数 |");
    out.push("|---|---|");
    for (const [host, h] of Object.entries(summary.byHost)) {
      out.push(`| ${host} | ${h.ok} / ${h.total} |`);
    }
    out.push("");
    out.push("| 対象 | 送信元 | ステータス | 本文バイト | charset | パース | 判定 | 理由 |");
    out.push("|---|---|---|---|---|---|---|---|");
    for (const r of records) {
      const j = judgeReachability(r);
      const parsed =
        r.parsedCount === null ? (r.parseError ?? "未実施") : `${r.parsedKind ?? ""} ${r.parsedCount} 件`;
      out.push(
        `| ${r.targetId} | ${r.source ?? "worker"} | ${r.status ?? "例外"} | ${r.bodyLength ?? "-"} | ${r.charset ?? "-"} | ${parsed} | ${j.verdict} | ${j.reason} |`,
      );
    }
    if (records.some((r) => r.source === "runner")) {
      const control = compareSources(records);
      out.push("");
      out.push("### 対照(同じ対象を Worker とランナーから。変えたのは送信元だけ)");
      out.push("");
      out.push("| 対象 | Worker | ランナー |");
      out.push("|---|---|---|");
      const cell = (verdict: string | null, status: number | null): string =>
        verdict === null ? "未測定" : `${verdict}(${status ?? "例外"})`;
      for (const p of control.pairs) {
        out.push(`| ${p.targetId} | ${cell(p.worker, p.workerStatus)} | ${cell(p.runner, p.runnerStatus)} |`);
      }
      out.push("");
      out.push(`- 暫定の読み: ${CONTROL_READING[control.conclusion]}`);
      if (control.indeterminatePairs > 0) {
        out.push(
          `- 判定不能の対象 ${control.indeterminatePairs} 件(どちらかが blocked / challenge / ok のいずれでもない)は、結論の集計から除外した。`,
        );
      }
    }
  }
  out.push("");

  if (result.origin !== undefined) {
    out.push(...renderOriginMarkdown(result.origin));
  }

  if (result.socketMatrix !== undefined) {
    out.push(...renderSocketMatrixMarkdown(result.socketMatrix));
  }

  out.push("## EUC-JP のデコード(Worker 内の往復)");
  out.push("");
  out.push(
    result.selftest.eucJpRoundTrip === null
      ? "未実施"
      : `${result.selftest.eucJpRoundTrip ? "成功" : "失敗"}${result.selftest.detail !== null ? `(${result.selftest.detail})` : ""}`,
  );
  out.push("");

  out.push("## CPU(反復回数を増やして上限超過になる点を探索)");
  out.push("");
  if (selected("cpu")) {
    out.push("| 実行環境 | 処理 | maxPassReps | minFailReps | 停止理由 | 試行数 |");
    out.push("|---|---|---|---|---|---|");
    for (const work of CPU_WORKS) {
      out.push(searchRow("Worker", work, result.cpu.worker[work]));
    }
    for (const work of CPU_WORKS) {
      out.push(searchRow("Durable Object(SQLite)", work, result.cpu.durableObject[work]));
    }
  } else {
    out.push("未実施(この実行では選んでいない)");
  }
  out.push("");

  const estimateRows: string[] = [];
  for (const work of CPU_WORKS) {
    const e = estimateCpuPerRepMs(result.cpu.durableObject[work], DOCUMENTED_DO_CPU_LIMIT_MS);
    if (e !== null) {
      // 探索が単調でない(通過した最大 reps が、超過した最小 reps より大きい)と low > high になるので、
      // 両方あるときは小さい方から並べて表示する。
      const both = e.lowMs !== null && e.highMs !== null;
      const lowValue = both ? Math.min(e.lowMs!, e.highMs!) : e.lowMs;
      const highValue = both ? Math.max(e.lowMs!, e.highMs!) : e.highMs;
      const low = lowValue === null ? "不明" : `${lowValue.toFixed(0)}`;
      const high = highValue === null ? "不明" : `${highValue.toFixed(0)}`;
      estimateRows.push(`| ${work} | ${low} 〜 ${high} |`);
    }
  }
  if (estimateRows.length > 0) {
    out.push("### Durable Object: 1回あたりの CPU の推定");
    out.push("");
    out.push(
      `**注意**: ${DOCUMENTED_DO_CPU_LIMIT_MS / 1000} 秒はドキュメントに書かれている上限の値であり、実測ではない。` +
        "実測したのは「通過した最大の反復回数」と「超過した最小の反復回数」だけで、以下は上限を 30 秒と仮定したときの目安である" +
        "(30 秒 ÷ 超過した最小 reps 〜 30 秒 ÷ 通過した最大 reps)。",
    );
    out.push("");
    out.push("| 処理 | 1回あたりの CPU(ms) |");
    out.push("|---|---|");
    out.push(...estimateRows);
    out.push("");
  }

  const independence = summarizeIndependence(result.cpu.samples.filter((s) => s.runtime === "worker"));
  if (independence.pingChecks > 0 || independence.inversions.length > 0) {
    out.push("### Worker: 超過の後の測定は独立か");
    out.push("");
    out.push(
      `- 超過の直後の /ping(処理なし): ${independence.pingChecks} 件中 ${independence.pingFailures} 件が 200 以外`,
    );
    out.push(`- 逆転(以前に通過した reps 以下の reps が失敗): ${independence.inversions.length} 件`);
    if (independence.inversions.length > 0) {
      out.push(
        `- 逆転の内訳: ${independence.inversions
          .map((i) => `${i.runtime}/${i.work}: reps=${i.failedReps} で超過(以前に reps=${i.earlierPassedReps} が通過)`)
          .join("、")}`,
      );
    }
    if (independence.pingFailures > 0) {
      out.push(
        "- 読み: Worker の最初の超過の後の測定は独立していない可能性がある(超過の後は、軽い処理でも失敗している)。Worker の上限の値としては扱わない。",
      );
    } else if (independence.inversions.length > 0) {
      out.push(
        "- 読み: 超過の直後の /ping はすべて 200(軽い処理は落ちていない)。逆転は、同じ reps で通過と超過が混在していることを示す(原因は未調査)。超過の後に軽い処理まで落ちる、という意味では独立でない証拠は無いが、測定が独立だったとまでは言えない。",
      );
    } else {
      out.push("- 読み: 超過の直後の /ping はすべて 200 で、逆転もなく、独立でない証拠は見つからなかった。");
    }
    out.push("");
  }

  if (result.local !== null && result.local.entries.length > 0) {
    out.push("## ローカル(workerd)での 1 reps あたり ms(本番の CPU とは異なる目安)");
    out.push("");
    out.push("| 実行環境 | 処理 | reps | 試行 | 1 reps あたり ms(小さい順) |");
    out.push("|---|---|---|---|---|");
    for (const e of result.local.entries) {
      out.push(
        `| ${e.runtime} | ${e.work} | ${e.reps} | ${e.runs} | ${e.perRepMsSorted.map((v) => v.toFixed(2)).join(", ")} |`,
      );
    }
    out.push("");
  }

  out.push("## 後片付け");
  out.push("");
  if (result.cleanup === null) {
    out.push("未実施");
  } else {
    const c = result.cleanup;
    out.push(`- 結果: ${c.ok ? "OK(接頭辞付きの Worker は残っていない)" : "NG"}`);
    if (c.leftoverWorkers.length > 0) {
      out.push(`- 削除ステップの後も残っていた Worker: ${c.leftoverWorkers.join(", ")}`);
    }
    if (c.deletedByFallback.length > 0) {
      out.push(`- API の DELETE で消した Worker: ${c.deletedByFallback.join(", ")}`);
    }
    out.push(`- Durable Object の名前空間: ${c.durableObjectNamespaces}`);
  }
  out.push("");

  if (result.notes.length > 0) {
    out.push("## 注記");
    out.push("");
    for (const note of result.notes) {
      out.push(`- ${note.replaceAll("\n", " ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}
