/**
 * 400 の原因の切り分け(Issue #160〈#21-B〉)の結果の Markdown 化。入力の `OriginResult` はマスク済み
 * (`origin-run.ts` が生の値を載せない)なので、ここでも生の値は扱わない。
 */

import { judgeReachability } from "./reachability.js";
import type { MaskedEchoObservation, OriginResult } from "./origin-run.js";
import type { OriginConclusion } from "./origin-plan.js";

const CONCLUSION_LABEL: Readonly<Record<OriginConclusion, string>> = {
  "fetch-specific": "fetch に固有の要素が原因(ソケットで回避できる)",
  "header-suspected": "ヘッダが原因の疑いが強い",
  "ip-suspected": "送信元(IP)が原因の疑いが強い",
  "both-suspected": "判定不能(ヘッダと送信元の両方に疑い)",
  "baseline-not-reproduced": "判定不能(基準 E0 が再現しなかった)",
  inconclusive: "判定不能",
};

const OUTCOME_LABEL = { good: "通った(good)", bad: "拒否された(bad)", unknown: "判定不能(unknown)" } as const;

function cell(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "-" : String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function observationRow(label: string, o: MaskedEchoObservation | null): string {
  if (o === null) {
    return `| ${label} | 取れなかった | - | - | - |`;
  }
  return `| ${label} | ${cell(o.service)} | ${cell(o.httpVersion)} | ${cell(o.tlsJa4)} | ${cell(o.h2Fingerprint)} |`;
}

/** 結果を Markdown の行にして返す(`renderMarkdown` に組み込まれる。見出しは `##` から)。 */
export function renderOriginMarkdown(origin: OriginResult): string[] {
  const out: string[] = [];
  out.push("## 400 の原因の切り分け(Issue #160。E0〜E3)");
  out.push("");
  out.push(
    `- netkeiba へ出した本数: ${origin.netkeibaRequestCount} 本 / 全体の打ち切り理由: ${origin.stoppedReason ?? "なし"}`,
  );
  out.push(
    `- 送信元(場所:手段)ごとの打ち切り: ${Object.entries(origin.stoppedBySource)
      .map(([k, v]) => `${k}: ${v ?? "なし"}`)
      .join(" / ")}`,
  );
  out.push(`- エコーへ出した回数(netkeiba の本数には含めない): ${origin.echo.requestCount} 回`);
  out.push("");

  out.push("### E1 ヘッダの観測(netkeiba へは出ない)");
  out.push("");
  out.push(`- 両側で取れたエコー: ${origin.echo.serviceUsed ?? "なし(両側がそろわなかった)"}`);
  for (const w of origin.echo.warnings) {
    out.push(`- 警告: ${w}`);
  }
  out.push("");
  out.push("| 試行 | 場所 | エコー | 結果 | ステータス | 理由 |");
  out.push("|---|---|---|---|---|---|");
  origin.echo.attempts.forEach((a, i) => {
    out.push(`| ${i + 1} | ${a.place} | ${a.service} | ${a.ok ? "成功" : "失敗"} | ${cell(a.status)} | ${cell(a.error)} |`);
  });
  out.push("");
  out.push("| 場所 | エコー | HTTP バージョン | TLS の JA4 | HTTP/2 の Akamai 指紋 |");
  out.push("|---|---|---|---|---|");
  out.push(observationRow("worker", origin.echo.worker));
  out.push(observationRow("runner", origin.echo.runner));
  out.push("");
  if (origin.echo.diff === null) {
    out.push("- ヘッダの差分: 両側の観測がそろわなかったため、取れていない");
  } else {
    const d = origin.echo.diff;
    out.push(
      `- Worker にだけ現れたヘッダ: ${d.workerOnly.length === 0 ? "なし" : d.workerOnly.map((h) => `${h.name}: ${h.value}`).join(" / ")}`,
    );
    out.push(`- ランナーにだけ現れたヘッダ: ${d.runnerOnly.length === 0 ? "なし" : d.runnerOnly.join(", ")}`);
    out.push(
      `- 名前は同じで値が違うヘッダ: ${
        d.valueDiffers.length === 0 ? "なし" : d.valueDiffers.map((v) => `${v.name}(worker: ${v.workerValue} / runner: ${v.runnerValue})`).join(" / ")
      }`,
    );
  }
  out.push("");

  out.push("### E0・E2・E3 の記録");
  out.push("");
  out.push("| 実験 | 場所 | 手段 | 対象 | ステータス | 本文バイト | パース | 判定 | 理由 |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of origin.records) {
    const j = judgeReachability(r);
    const parsed = r.parsedCount === null ? (r.parseError ?? "未実施") : `${r.parsedKind ?? ""} ${r.parsedCount} 件`;
    out.push(
      `| ${r.experiment} | ${r.place} | ${r.via} | ${r.targetId} | ${r.status ?? "例外"} | ${cell(r.bodyLength)} | ${cell(parsed)} | ${j.verdict} | ${cell(r.error ?? j.reason)} |`,
    );
  }
  out.push("");

  out.push("### E2 ランナー + Workers 風のヘッダ → netkeiba");
  out.push("");
  if (origin.e2.note !== null) {
    out.push(`- ${origin.e2.note}`);
  }
  if (origin.e2.sent.length > 0) {
    out.push(`- 付けたヘッダ(Worker が実際に付けた名前。値はマスク済み): ${origin.e2.sent.map((h) => `${h.name}: ${h.value}`).join(" / ")}`);
  }
  if (origin.e2.skipped.length > 0) {
    out.push("- 付けなかったヘッダ:");
    for (const s of origin.e2.skipped) {
      out.push(`  - ${s.name}: ${s.reason}`);
    }
  }
  out.push("");

  out.push("### E3 Worker の TCP ソケット → netkeiba");
  out.push("");
  out.push(
    `- 送ったヘッダ(Host と Connection: close に加えて): ${origin.e3.headers.map((h) => h.name).join(", ")} / 導出元: ${
      origin.e3.headerSource === "runner-echo" ? "ランナーの観測から導出(E1)" : "静的フォールバック(Node 22 で実測した集合)"
    }`,
  );
  out.push("");

  out.push("### 結論");
  out.push("");
  out.push(`- 基準(E0)の再現: ${origin.baselineReproduced ? "はい(Worker の fetch は拒否、ランナーの fetch は ok)" : "いいえ(再現しなかった)"}`);
  out.push(`- E2(ランナー + Workers 風のヘッダ): ${OUTCOME_LABEL[origin.outcomes.e2]}`);
  out.push(`- E3(Worker のソケット): ${OUTCOME_LABEL[origin.outcomes.e3]}`);
  out.push(`- 結論: **${CONCLUSION_LABEL[origin.conclusion]}**`);
  out.push(`- 読み: ${origin.reading.summary}`);
  out.push("- 限界:");
  for (const l of origin.reading.limitations) {
    out.push(`  - ${l}`);
  }
  out.push("");
  return out;
}
