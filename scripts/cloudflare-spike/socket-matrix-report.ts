/**
 * #162 段階1(socket-matrix)の結果の Markdown 化。入力の `SocketMatrixResult` はマスク済み(`socket-matrix-run.ts` が
 * 生の値を載せない)なので、ここでも生の値は扱わない。事実・推測・限界は別の見出しに分ける(事実の欄に推測を混ぜない)。
 */

import { judgeReachability } from "./reachability.js";
import type { SocketMatrixResult } from "./socket-matrix-run.js";

function cell(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "-" : String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function pair(a: string | number | null | undefined, b: string | number | null | undefined): string {
  return `${cell(a)} / ${cell(b)}`;
}

function hashLabel(value: boolean | null): string {
  return value === null ? "-" : value ? "一致" : "不一致";
}

/** gzip で返ったか。gzip で返れば content-encoding、返らなければ『圧縮されなかった』、判断できなければ -。 */
function compressedLabel(compressed: boolean | null, contentEncoding: string | null): string {
  if (compressed === null) {
    return "-";
  }
  return compressed ? cell(contentEncoding) : "圧縮されなかった";
}

/** 結果を Markdown の行にして返す(`renderMarkdown` に組み込まれる。見出しは `##` から)。 */
export function renderSocketMatrixMarkdown(result: SocketMatrixResult): string[] {
  const out: string[] = [];
  out.push("## DO の中のソケットでの取得(Issue #162 段階1。socket-matrix)");
  out.push("");
  out.push(`- netkeiba へ出した本数: ${result.netkeibaRequestCount} 本(計画 ${result.plannedCount} 本)`);
  out.push(`- 打ち切り: ${result.stoppedReason ?? "なし"}${result.skippedStepIds.length > 0 ? `(送らなかったステップ: ${result.skippedStepIds.join(", ")})` : ""}`);
  out.push(
    `- DO のインスタンス: 記録全体で異なる ID は ${result.summary.instances.distinctIds} 個(呼び出し通番の最大は ${result.summary.instances.maxCall ?? "なし"})`,
  );
  out.push("");

  out.push("### 取得先ごとの記録");
  out.push("");
  out.push("| ステップ | 対象 | 方式 | ステータス | 本文バイト(展開後) | パース | 判定 | DO(インスタンス #通番) | 時間 ms(opened / 最初のバイト / 全体) | 理由 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of result.records) {
    const j = judgeReachability(r);
    const parsed = r.parsedCount === null ? (r.parseError ?? "未実施") : `${r.parsedKind ?? ""} ${r.parsedCount} 件`;
    const time = r.meta === null ? "-" : `${r.meta.openedMs} / ${r.meta.firstByteMs ?? "-"} / ${r.meta.totalMs}`;
    const instance = r.instance === null ? "-" : `${r.instance.id.slice(0, 8)} #${r.instance.call}`;
    out.push(
      `| ${r.stepId} | ${cell(r.targetId)} | ${r.variant} | ${r.status ?? "例外"} | ${cell(r.meta?.decodedBytes ?? r.bodyLength)} | ${cell(parsed)} | ${j.verdict} | ${instance} | ${time} | ${cell(r.error ?? j.reason)} |`,
    );
  }
  out.push("");

  out.push("### gzip の比較(identity との対)");
  out.push("");
  if (result.summary.compression.length === 0) {
    out.push("gzip の取得は行っていない(打ち切りなどで送らなかった)");
  } else {
    out.push("| ステップ | 対 | ステータス(identity / gzip) | 線上の本文バイト(identity / gzip) | 展開後バイト(gzip) | 比率(gzip / identity) | 全体 ms(identity / gzip) | 最初のバイト ms(identity / gzip) | 本文のハッシュ | 圧縮(content-encoding) |");
    out.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const c of result.summary.compression) {
      out.push(
        `| ${c.stepId} | ${c.pairWith} | ${pair(c.identityStatus, c.gzipStatus)} | ${pair(c.identityWireBytes, c.gzipWireBytes)} | ${cell(c.gzipDecodedBytes)} | ${cell(c.wireRatio)} | ${pair(c.identityTotalMs, c.gzipTotalMs)} | ${pair(c.identityFirstByteMs, c.gzipFirstByteMs)} | ${hashLabel(c.bodyHashEqual)} | ${compressedLabel(c.compressed, c.contentEncoding)} |`,
      );
    }
  }
  out.push("");

  out.push("### 再現性(同じ URL を間隔を空けて2回)");
  out.push("");
  if (result.summary.repeat.length === 0) {
    out.push("2本目を取得していない(打ち切りなどで送らなかった)");
  } else {
    out.push("| ステップ | 対 | 対象 | ステータス(1本目 → 2本目) | 本文バイト | 本文のハッシュ | 間隔 ms | DO のインスタンス | 全体 ms(1本目 / 2本目) |");
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of result.summary.repeat) {
      const same = (v: boolean | null): string => (v === null ? "-" : v ? "同じ" : "違う");
      out.push(
        `| ${r.stepId} | ${r.pairWith} | ${cell(r.targetId)} | ${r.firstStatus ?? "例外"} → ${r.secondStatus ?? "例外"} | ${same(r.bytesEqual)} | ${hashLabel(r.hashEqual)} | ${r.gapMs} | ${r.sameInstance === null ? "-" : r.sameInstance ? "同じ" : "別"} | ${pair(r.firstTotalMs, r.secondTotalMs)} |`,
      );
    }
  }
  out.push("");

  out.push("### Worker から DO を繰り返し呼ぶ試験(netkeiba へは出ない)");
  out.push("");
  const probe = result.subrequestProbe;
  if (probe === null) {
    out.push("未実施");
  } else if (!probe.ran) {
    out.push(`- 実行できなかった(${cell(probe.error)})`);
  } else if (probe.firstFailureAt === null) {
    out.push(`- ${probe.requested} 回すべて成功した`);
  } else {
    out.push(
      `- ${probe.requested} 回のうち ${probe.succeeded ?? "-"} 回成功し、${probe.firstFailureAt} 回目で失敗した(種類: ${probe.errorKind ?? "不明"}。メッセージ: ${cell(probe.error)})`,
    );
  }
  out.push("");

  out.push("### 事実(記録に書かれていること)");
  out.push("");
  for (const f of result.reading.facts) {
    out.push(`- ${f}`);
  }
  out.push("");
  out.push("### 推測(事実ではない)");
  out.push("");
  if (result.reading.inferences.length === 0) {
    out.push("- なし");
  }
  for (const i of result.reading.inferences) {
    out.push(`- ${i}`);
  }
  out.push("");
  out.push("### 限界");
  out.push("");
  for (const l of result.reading.limitations) {
    out.push(`- ${l}`);
  }
  out.push("");
  return out;
}
