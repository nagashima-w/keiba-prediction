/**
 * スパイク結果の型・ログ出力・Markdown 化(Issue #159〈#21-A〉)。
 *
 * **ログへの出し方が設計の核**: メイン(オーケストレーター)が読めるのは Actions のジョブログ本文だけで、
 * artifact をダウンロードできる保証がない。そこで結果 JSON の全文を、前後を印で挟んだ**1行**で
 * ジョブログに出す({@link formatResultBlock})。ログは末尾から取得されるため、出力はジョブの後半に置く。
 */

import type { SearchResult } from "./cpu-search.js";
import {
  judgeReachability,
  summarizeReachability,
  type NetkeibaProbeRecord,
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
  /** `wrangler delete` の後も残っていた、接頭辞付きの Worker。 */
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
    stoppedReason: string | null;
  };
  selftest: { eucJpRoundTrip: boolean | null; detail: string | null };
  cpu: { worker: CpuSearches; durableObject: CpuSearches; samples: CpuSample[] };
  local: { entries: LocalCalibrationEntry[] } | null;
  cleanup: CleanupInfo | null;
  notes: string[];
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
    netkeiba: { records: [], requestCount: 0, stoppedReason: null },
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
  const maxPass = search.maxPassReps === null ? "通過なし" : String(search.maxPassReps);
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
  out.push("");

  out.push("## 到達性(Workers → netkeiba)");
  out.push("");
  const records = result.netkeiba.records;
  if (records.length === 0) {
    out.push("未実施");
  } else {
    const summary = summarizeReachability(records);
    out.push(
      `- 出したリクエスト: ${result.netkeiba.requestCount} 本 / 打ち切り理由: ${result.netkeiba.stoppedReason ?? "なし"}`,
    );
    out.push(
      `- 判定の件数: ${Object.entries(summary.counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" / ")}`,
    );
    out.push("");
    out.push("| ホスト | ok / 総数 |");
    out.push("|---|---|");
    for (const [host, h] of Object.entries(summary.byHost)) {
      out.push(`| ${host} | ${h.ok} / ${h.total} |`);
    }
    out.push("");
    out.push("| 対象 | ステータス | 本文バイト | charset | パース | 判定 | 理由 |");
    out.push("|---|---|---|---|---|---|---|");
    for (const r of records) {
      const j = judgeReachability(r);
      const parsed =
        r.parsedCount === null ? (r.parseError ?? "未実施") : `${r.parsedKind ?? ""} ${r.parsedCount} 件`;
      out.push(
        `| ${r.targetId} | ${r.status ?? "例外"} | ${r.bodyLength ?? "-"} | ${r.charset ?? "-"} | ${parsed} | ${j.verdict} | ${j.reason} |`,
      );
    }
  }
  out.push("");

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
  out.push("| 実行環境 | 処理 | maxPassReps | minFailReps | 停止理由 | 試行数 |");
  out.push("|---|---|---|---|---|---|");
  for (const work of CPU_WORKS) {
    out.push(searchRow("Worker", work, result.cpu.worker[work]));
  }
  for (const work of CPU_WORKS) {
    out.push(searchRow("Durable Object(SQLite)", work, result.cpu.durableObject[work]));
  }
  out.push("");

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
      out.push(`- wrangler delete の後も残っていた Worker: ${c.leftoverWorkers.join(", ")}`);
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
