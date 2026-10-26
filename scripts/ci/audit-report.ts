/**
 * 毎日の `pnpm audit`(.github/workflows/audit.yml)の結果を、1 行の印(AUDIT-OK / AUDIT-FAIL / AUDIT-UNAVAILABLE)と終了コードに分類する(Issue #498)。
 *
 * ★なぜ `pnpm audit` の終了コードをそのまま使わないか: 脆弱性が見つかったときも、レジストリに届かないときも、`pnpm audit` は exit 1 で終わる
 *   (実測。scripts/test/audit-report.test.ts のヘッダ)。そのまま赤にすると、「脆弱性がある」と「監査できなかった」がログで区別できない。
 *   区別は `--json` の出力の形で行う: 脆弱性ありは `advisories` と `metadata.vulnerabilities` を持つ JSON、届かないときは `{"error":{"code","message"}}`。
 *
 * ★判定(安全側に倒す。監査していない日を「安全」と読ませない):
 *   - low 以上(low・moderate・high・critical)の件数の合計が 1 以上 → FAIL(exit 0 でも FAIL。終了コードを信用しない)
 *   - 出力が空・JSON でない・`metadata.vulnerabilities` の 5 つの件数が数でない・error を含み件数が 0 → UNAVAILABLE
 *   - 件数が 0 なのに exit が 0 でない → UNAVAILABLE(監査の結果を信用できない)
 *   - 件数が 0 で exit 0 → OK。info は件数の表示に出すが、失敗の条件には数えない(閾値は「low 以上」)。
 *   プロセスの終了コードは OK=0・FAIL=1・UNAVAILABLE=2(Actions の画面ではどちらも赤。区別はログの印で行う)。
 *
 * ★素の `node scripts/ci/audit-report.ts <label> <audit の stdout のファイル> <pnpm audit の終了コード> [stderr のファイル]` で実行できる
 *   (CI は依存をインストールしないので tsx は使えない。Node の型除去による実行。import は node: の組込みだけで、enum・パラメータプロパティなど型除去で動かない構文は使わない)。
 *   scripts/test/audit-report.test.ts が、実際に `node` で実行して確かめている。
 *
 * 印は grep の対象(定期の確認が読む)なので、変えるときは audit.yml のヘッダと scripts/test/audit-workflow.test.ts も揃える。
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AuditVerdict = "ok" | "fail" | "unavailable";

export interface AuditReport {
  readonly verdict: AuditVerdict;
  /** プロセスの終了コード。OK=0・FAIL=1・UNAVAILABLE=2。 */
  readonly exitCode: 0 | 1 | 2;
  /** 出力する行。1 行目が印つきの要約。FAIL のときは続けて advisory ごとに 1 行。 */
  readonly lines: readonly string[];
}

const SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];
/** 失敗の条件に数える重大度(low 以上)。 */
const FAILING: readonly Severity[] = ["critical", "high", "moderate", "low"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function unavailable(label: string, reason: string, auditExitCode: number): AuditReport {
  return { verdict: "unavailable", exitCode: 2, lines: [`AUDIT-UNAVAILABLE ${label}: ${reason} (pnpm audit exit ${auditExitCode})`] };
}

/** error オブジェクトの `code: message`。読めなければ null。 */
function errorText(parsed: Record<string, unknown>): string | null {
  const e = parsed.error;
  if (!isRecord(e)) return null;
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  const text = [code, message].filter((s) => s !== "").join(": ");
  return text === "" ? null : text;
}

/** `metadata.vulnerabilities` の 5 つの件数(すべて数のときだけ)。 */
function readCounts(parsed: Record<string, unknown>): Record<Severity, number> | null {
  const meta = parsed.metadata;
  if (!isRecord(meta) || !isRecord(meta.vulnerabilities)) return null;
  const v = meta.vulnerabilities;
  const out = {} as Record<Severity, number>;
  for (const s of SEVERITIES) {
    const n = v[s];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    out[s] = n;
  }
  return out;
}

/** advisory を、重大度の高い順・同じ重大度では GHSA の昇順に、1 行ずつにする。 */
function advisoryLines(parsed: Record<string, unknown>): string[] {
  const adv = parsed.advisories;
  if (!isRecord(adv)) return [];
  const rows = Object.values(adv)
    .filter(isRecord)
    .map((a) => ({
      severity: typeof a.severity === "string" ? a.severity : "?",
      module: typeof a.module_name === "string" ? a.module_name : "?",
      vulnerable: typeof a.vulnerable_versions === "string" ? a.vulnerable_versions : "?",
      patched: typeof a.patched_versions === "string" ? a.patched_versions : "?",
      ghsa: typeof a.github_advisory_id === "string" ? a.github_advisory_id : typeof a.id === "number" ? String(a.id) : "?",
    }));
  const rank = (s: string): number => {
    const i = (SEVERITIES as readonly string[]).indexOf(s);
    return i < 0 ? SEVERITIES.length : i;
  };
  rows.sort((x, y) => rank(x.severity) - rank(y.severity) || (x.ghsa < y.ghsa ? -1 : x.ghsa > y.ghsa ? 1 : 0));
  return rows.map((r) => `  ${r.severity} ${r.module} ${r.vulnerable} -> ${r.patched} ${r.ghsa}`);
}

/**
 * `pnpm audit --json` の標準出力と終了コードから、結果を分類する。
 * @param label ログの識別(`root`・`cloud`。grep しやすい ASCII)
 * @param stdout `pnpm audit --json` の標準出力
 * @param auditExitCode `pnpm audit` の終了コード
 * @param stderr 標準エラー(任意)。出力が空のときだけ、先頭行を理由に添える
 */
export function classifyAudit(label: string, stdout: string, auditExitCode: number, stderr?: string): AuditReport {
  if (stdout.trim() === "") {
    const first = (stderr ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
    return unavailable(label, `出力が空${first === undefined ? "" : `(stderr: ${first})`}`, auditExitCode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unavailable(label, "出力が JSON ではない", auditExitCode);
  }
  if (!isRecord(parsed)) return unavailable(label, "metadata.vulnerabilities が無い(JSON の最上位がオブジェクトではない)", auditExitCode);
  const counts = readCounts(parsed);
  if (counts === null) {
    return unavailable(label, errorText(parsed) ?? "metadata.vulnerabilities が無い(または件数が数でない)", auditExitCode);
  }
  const total = FAILING.reduce((sum, s) => sum + counts[s], 0);
  if (total > 0) {
    const head = `AUDIT-FAIL ${label}: critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low} info=${counts.info} (total ${total})`;
    return { verdict: "fail", exitCode: 1, lines: [head, ...advisoryLines(parsed)] };
  }
  const err = errorText(parsed);
  if (err !== null) return unavailable(label, err, auditExitCode);
  if (auditExitCode !== 0) {
    return unavailable(label, `exit ${auditExitCode} だが low 以上の件数が 0(info=${counts.info})。監査の結果を信用できない`, auditExitCode);
  }
  return { verdict: "ok", exitCode: 0, lines: [`AUDIT-OK ${label}: 0 vulnerabilities${counts.info > 0 ? ` (info=${counts.info})` : ""}`] };
}

/** CLI。引数の不備・ファイルの読めない場合も、例外で落ちて OK 扱いにならないよう UNAVAILABLE(終了コード 2)にする。 */
function main(argv: readonly string[]): number {
  const [label, jsonPath, codeText, stderrPath] = argv;
  const safeLabel = label ?? "?";
  let report: AuditReport;
  if (label === undefined || jsonPath === undefined || codeText === undefined) {
    report = unavailable(safeLabel, "引数が足りない(使い方: <label> <stdout のファイル> <pnpm audit の終了コード> [stderr のファイル])", -1);
  } else if (!/^\d+$/.test(codeText)) {
    report = unavailable(label, `終了コードが数ではない: ${codeText}`, -1);
  } else {
    let stdout = "";
    let stderr: string | undefined;
    try {
      stdout = readFileSync(jsonPath, "utf-8");
    } catch (e) {
      report = unavailable(label, `出力のファイルを読めない: ${e instanceof Error ? e.message : String(e)}`, Number(codeText));
      return emit(report);
    }
    if (stderrPath !== undefined) {
      try {
        stderr = readFileSync(stderrPath, "utf-8");
      } catch {
        stderr = undefined;
      }
    }
    report = classifyAudit(label, stdout, Number(codeText), stderr);
  }
  return emit(report);
}

function emit(report: AuditReport): number {
  const text = report.lines.join("\n");
  console.log(text);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") {
    try {
      appendFileSync(summary, `\`\`\`\n${text}\n\`\`\`\n`);
    } catch {
      // サマリを書けなくても、判定と終了コードは変えない
    }
  }
  return report.exitCode;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
