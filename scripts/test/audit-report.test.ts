/**
 * 毎日の `pnpm audit`(.github/workflows/audit.yml)の結果の分類(scripts/ci/audit-report.ts)のテスト(Issue #498)。
 *
 * 固定する契約:
 *  - 判定は `pnpm audit --json` の**出力の形**で行う。終了コードだけでは、脆弱性ありと「レジストリに届かない」を区別できない(どちらも exit 1。
 *    実測: 脆弱性のある lockfile → stdout に advisories と metadata を持つ JSON・exit 1 / レジストリへ届かない → stdout は `{"error":{"code":...}}`・exit 1)。
 *  - 閾値は low 以上(low・moderate・high・critical が 1 件でもあれば失敗)。info は件数に出すが、失敗の条件には数えない。
 *  - 安全側に倒す: exit 0 でも low 以上の件数が 1 以上なら FAIL(終了コードを信用しない)。exit 非 0 なのに low 以上の件数が 0 なら、
 *    監査の結果を信用できないので UNAVAILABLE(失敗)。出力が JSON でない・`metadata.vulnerabilities` が無い・error を含む場合も UNAVAILABLE。
 *  - 出力の 1 行目は `AUDIT-OK|AUDIT-FAIL|AUDIT-UNAVAILABLE <label>: ...`(Claude やログの grep が読む。印は変えない)。
 *    プロセスの終了コードは OK=0・FAIL=1・UNAVAILABLE=2。
 *
 * フィクスチャ(scripts/test/fixtures/pnpm-audit-*.json)は `pnpm audit --json` の**実出力**。
 *  - pnpm-audit-clean.json: 2026-10-26 にこのリポジトリのルートで `pnpm audit --json` を実行した出力そのもの(`diff` で一致を確認)。
 *  - pnpm-audit-vulnerable.json: `lodash@4.17.15` だけを依存に持つ使い捨ての package.json で `pnpm install --lockfile-only --ignore-workspace` のあと
 *    `pnpm audit --json` を実行した出力(exit 1)から、分類に使わない `actions` を空にし、advisory のうち必要な項目だけを残したもの。
 *    advisory の集合は GitHub の記録の更新で変わるので、**スナップショット**であり、再取得して一致させるものではない(期待値はこのファイルから数えている)。
 *  - pnpm-audit-registry-error.json: `pnpm audit --json --registry=http://127.0.0.1:9`(届かないレジストリ)の stdout そのもの(exit 1)。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyAudit } from "../ci/audit-report.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "scripts", "test", "fixtures");
const SCRIPT = path.join(ROOT, "scripts", "ci", "audit-report.ts");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf-8");
}

/** 件数だけを指定した、最小の `pnpm audit --json` 風の出力。 */
function counts(v: { info?: number; low?: number; moderate?: number; high?: number; critical?: number }): string {
  return JSON.stringify({
    actions: [],
    advisories: {},
    muted: [],
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...v } },
  });
}

describe("フィクスチャの前提(空振り防止。期待値の元になる数を、テストの側で数え直す)", () => {
  const vulnerable = JSON.parse(fixture("pnpm-audit-vulnerable.json")) as {
    advisories: Record<string, { severity: string }>;
    metadata: { vulnerabilities: Record<string, number> };
  };

  it("脆弱性のフィクスチャは advisory を持ち、metadata の件数と advisory の重大度ごとの数が一致する(moderate 3・high 3 の 6 件)", () => {
    const advisories = Object.values(vulnerable.advisories);
    expect(advisories).toHaveLength(6);
    for (const sev of ["info", "low", "moderate", "high", "critical"]) {
      expect(advisories.filter((a) => a.severity === sev).length, sev).toBe(vulnerable.metadata.vulnerabilities[sev]);
    }
    expect(vulnerable.metadata.vulnerabilities.moderate).toBe(3);
    expect(vulnerable.metadata.vulnerabilities.high).toBe(3);
  });

  it("届かないレジストリのフィクスチャは error だけを持ち、metadata を持たない", () => {
    const j = JSON.parse(fixture("pnpm-audit-registry-error.json")) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["error"]);
  });
});

describe("classifyAudit: 実出力のフィクスチャ", () => {
  it("0 件(exit 0)は OK。1 行だけ出し、終了コードは 0", () => {
    const r = classifyAudit("root", fixture("pnpm-audit-clean.json"), 0);
    expect(r.verdict).toBe("ok");
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual(["AUDIT-OK root: 0 vulnerabilities"]);
  });

  it("脆弱性あり(exit 1)は FAIL。1 行目に重大度別の件数と合計、続けて advisory ごとに 1 行(重大度の高い順・同じ重大度では GHSA の昇順)", () => {
    const r = classifyAudit("cloud", fixture("pnpm-audit-vulnerable.json"), 1);
    expect(r.verdict).toBe("fail");
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toBe("AUDIT-FAIL cloud: critical=0 high=3 moderate=3 low=0 info=0 (total 6)");
    expect(r.lines).toHaveLength(1 + 6);
    expect(r.lines.slice(1)).toEqual([
      "  high lodash <4.17.21 -> >=4.17.21 GHSA-35jh-r3h4-6jhm",
      "  high lodash >=3.7.0 <4.17.19 -> >=4.17.19 GHSA-p6mc-m468-83gw",
      "  high lodash >=4.0.0 <=4.17.23 -> >=4.18.0 GHSA-r5fr-rjxr-66jc",
      "  moderate lodash >=4.0.0 <4.17.21 -> >=4.17.21 GHSA-29mw-wpgm-hmr9",
      "  moderate lodash <=4.17.23 -> >=4.18.0 GHSA-f23m-r3pf-42rh",
      "  moderate lodash >=4.0.0 <=4.17.22 -> >=4.17.23 GHSA-xxjr-mmjv-4gpg",
    ]);
  });

  it("届かないレジストリ(exit 1・error の JSON)は UNAVAILABLE。FAIL・OK ではなく、終了コードは 2。理由にエラーの code と message が入る", () => {
    const r = classifyAudit("root", fixture("pnpm-audit-registry-error.json"), 1);
    expect(r.verdict).toBe("unavailable");
    expect(r.exitCode).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^AUDIT-UNAVAILABLE root: /);
    expect(r.lines[0]).toContain("ECONNREFUSED");
    expect(r.lines[0]).toContain("pnpm audit exit 1");
  });
});

describe("classifyAudit: 閾値(low 以上で失敗。表駆動)", () => {
  const cases: { name: string; v: Parameters<typeof counts>[0]; exit: number; verdict: "ok" | "fail" | "unavailable"; line: string }[] = [
    { name: "low が 1 件だけ(exit 1)でも FAIL", v: { low: 1 }, exit: 1, verdict: "fail", line: "AUDIT-FAIL t: critical=0 high=0 moderate=0 low=1 info=0 (total 1)" },
    { name: "moderate が 1 件だけでも FAIL", v: { moderate: 1 }, exit: 1, verdict: "fail", line: "AUDIT-FAIL t: critical=0 high=0 moderate=1 low=0 info=0 (total 1)" },
    { name: "high が 1 件だけでも FAIL", v: { high: 1 }, exit: 1, verdict: "fail", line: "AUDIT-FAIL t: critical=0 high=1 moderate=0 low=0 info=0 (total 1)" },
    { name: "critical が 1 件だけでも FAIL", v: { critical: 1 }, exit: 1, verdict: "fail", line: "AUDIT-FAIL t: critical=1 high=0 moderate=0 low=0 info=0 (total 1)" },
    { name: "重大度が混在する(合計は内訳の和: 2+3+4+5=14)", v: { critical: 2, high: 3, moderate: 4, low: 5, info: 9 }, exit: 1, verdict: "fail", line: "AUDIT-FAIL t: critical=2 high=3 moderate=4 low=5 info=9 (total 14)" },
    { name: "exit 0 でも low 以上が 1 件あれば FAIL(終了コードを信用しない。安全側)", v: { moderate: 1 }, exit: 0, verdict: "fail", line: "AUDIT-FAIL t: critical=0 high=0 moderate=1 low=0 info=0 (total 1)" },
    { name: "exit 1 だが件数が全部 0 は UNAVAILABLE(結果を信用できない)", v: {}, exit: 1, verdict: "unavailable", line: "AUDIT-UNAVAILABLE t: exit 1 だが low 以上の件数が 0(info=0)。監査の結果を信用できない (pnpm audit exit 1)" },
    { name: "exit 1 で info だけ 1 件も、low 以上は 0 なので UNAVAILABLE(info は失敗の条件に数えない)", v: { info: 1 }, exit: 1, verdict: "unavailable", line: "AUDIT-UNAVAILABLE t: exit 1 だが low 以上の件数が 0(info=1)。監査の結果を信用できない (pnpm audit exit 1)" },
    { name: "exit 0 で info だけ 1 件なら OK(info は失敗の条件に数えない)", v: { info: 1 }, exit: 0, verdict: "ok", line: "AUDIT-OK t: 0 vulnerabilities (info=1)" },
    { name: "exit 0・件数 0 は OK", v: {}, exit: 0, verdict: "ok", line: "AUDIT-OK t: 0 vulnerabilities" },
  ];
  it.each(cases)("$name", ({ v, exit, verdict, line }) => {
    const r = classifyAudit("t", counts(v), exit);
    expect(r.verdict).toBe(verdict);
    expect(r.lines[0]).toBe(line);
    expect(r.exitCode).toBe(verdict === "ok" ? 0 : verdict === "fail" ? 1 : 2);
  });

  it("FAIL の合計は、重大度別の内訳(critical+high+moderate+low)の和で、info を含まない(表の各行の total と内訳の和が一致する)", () => {
    for (const v of [{ low: 2, info: 7 }, { critical: 1, high: 1, moderate: 1, low: 1, info: 1 }]) {
      const r = classifyAudit("t", counts(v), 1);
      const m = /critical=(\d+) high=(\d+) moderate=(\d+) low=(\d+) info=(\d+) \(total (\d+)\)/.exec(r.lines[0]!);
      expect(m, r.lines[0]).not.toBeNull();
      const [c, h, mo, l, , total] = m!.slice(1).map(Number) as [number, number, number, number, number, number];
      expect(total).toBe(c + h + mo + l);
      expect(total).toBeGreaterThan(0);
    }
  });
});

describe("classifyAudit: 件数(metadata)が全部 0 でも advisories が空でなければ FAIL(件数と advisories の食い違い。安全側)", () => {
  /** 件数は全部 0 で、advisories にだけ指定の advisory を持つ出力(食い違い)。 */
  function mismatched(advisories: Record<string, Record<string, unknown>>): string {
    return JSON.stringify({
      actions: [],
      advisories,
      muted: [],
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
    });
  }
  const high = { "1": { severity: "high", module_name: "lodash", vulnerable_versions: "<4.17.21", patched_versions: ">=4.17.21", github_advisory_id: "GHSA-35jh-r3h4-6jhm" } };

  it("前提(空振り防止): 入力は件数が全部 0 で、advisories が 1 件ある", () => {
    const j = JSON.parse(mismatched(high)) as { advisories: Record<string, unknown>; metadata: { vulnerabilities: Record<string, number> } };
    expect(Object.values(j.metadata.vulnerabilities)).toEqual([0, 0, 0, 0, 0]);
    expect(Object.keys(j.advisories)).toHaveLength(1);
  });

  it.each([0, 1])("件数 0・high の advisory が 1 件(exit %i)は FAIL。1 行目に食い違いを明記し、advisory の行が続く(終了コード 1)", (exit) => {
    const r = classifyAudit("t", mismatched(high), exit);
    expect(r.verdict).toBe("fail");
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toBe("AUDIT-FAIL t: critical=0 high=0 moderate=0 low=0 info=0 (total 0。ただし metadata の件数が 0 なのに advisories が 1 件ある(食い違い))");
    expect(r.lines).toEqual([r.lines[0], "  high lodash <4.17.21 -> >=4.17.21 GHSA-35jh-r3h4-6jhm"]);
  });

  it("重大度が読めない(severity が無い)advisory も、失敗側として数える", () => {
    const r = classifyAudit("t", mismatched({ "2": { module_name: "x" } }), 0);
    expect(r.verdict).toBe("fail");
    expect(r.lines[0]).toContain("advisories が 1 件ある");
    expect(r.lines[1]).toBe("  ? x ? -> ? ?");
  });

  it("info だけの advisory は、閾値(low 以上)の対象外なので OK のまま(exit 0)。info を含めて数えた件数 2 件でも FAIL にしない", () => {
    const info = { "3": { severity: "info", module_name: "a", vulnerable_versions: "*", patched_versions: "-", github_advisory_id: "GHSA-aaaa-aaaa-aaaa" }, "4": { severity: "info", module_name: "b", vulnerable_versions: "*", patched_versions: "-", github_advisory_id: "GHSA-bbbb-bbbb-bbbb" } };
    expect(Object.keys(info)).toHaveLength(2);
    const r = classifyAudit("t", mismatched(info), 0);
    expect(r.verdict).toBe("ok");
    expect(r.lines).toEqual(["AUDIT-OK t: 0 vulnerabilities"]);
  });

  it("info の advisory と high の advisory が混在し、件数が全部 0 なら FAIL。advisory の行は 2 件(重大度の高い順)", () => {
    const mixed = { ...high, "3": { severity: "info", module_name: "a", vulnerable_versions: "*", patched_versions: "-", github_advisory_id: "GHSA-aaaa-aaaa-aaaa" } };
    const r = classifyAudit("t", mismatched(mixed), 0);
    expect(r.verdict).toBe("fail");
    expect(r.lines[0]).toContain("advisories が 1 件ある");
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1]).toContain("high lodash");
    expect(r.lines[2]).toContain("info a");
  });

  it("advisories が空のオブジェクトや無い出力は、これまでどおり件数で判定する(0 件・exit 0 は OK)", () => {
    expect(classifyAudit("t", mismatched({}), 0).verdict).toBe("ok");
    expect(classifyAudit("t", JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }), 0).verdict).toBe("ok");
  });
});

describe("classifyAudit: 監査の結果として読めない出力は UNAVAILABLE(OK にしない)", () => {
  const cases: { name: string; stdout: string; exit: number; reasonIncludes: string }[] = [
    { name: "空の出力(exit 1)", stdout: "", exit: 1, reasonIncludes: "出力が空" },
    { name: "JSON でない出力(exit 1)", stdout: "ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS The audit endpoint", exit: 1, reasonIncludes: "JSON ではない" },
    { name: "空の出力でも exit 0 は OK にしない(監査していないのに緑にしない)", stdout: "", exit: 0, reasonIncludes: "出力が空" },
    { name: "metadata が無い JSON(exit 0)", stdout: JSON.stringify({ advisories: {} }), exit: 0, reasonIncludes: "metadata.vulnerabilities が無い" },
    { name: "件数が数でない(exit 0)", stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: "0", high: 0, critical: 0 } } }), exit: 0, reasonIncludes: "metadata.vulnerabilities が無い" },
    { name: "件数のキーが欠けている(critical が無い。exit 0)", stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0 } } }), exit: 0, reasonIncludes: "metadata.vulnerabilities が無い" },
    { name: "error を含み、件数も 0 の JSON(exit 0)", stdout: JSON.stringify({ error: { code: "E", message: "m" }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }), exit: 0, reasonIncludes: "E: m" },
    { name: "JSON の最上位が配列(exit 0)", stdout: "[]", exit: 0, reasonIncludes: "metadata.vulnerabilities が無い" },
    { name: "JSON の最上位が null(exit 0)", stdout: "null", exit: 0, reasonIncludes: "metadata.vulnerabilities が無い" },
  ];
  it.each(cases)("$name", ({ stdout, exit, reasonIncludes }) => {
    const r = classifyAudit("t", stdout, exit);
    expect(r.verdict).toBe("unavailable");
    expect(r.exitCode).toBe(2);
    expect(r.lines[0]).toMatch(/^AUDIT-UNAVAILABLE t: /);
    expect(r.lines[0]).toContain(reasonIncludes);
    expect(r.lines[0]).toContain(`pnpm audit exit ${exit}`);
  });

  it("標準エラーの先頭行を、出力が空のときの手がかりとして理由に添える(渡したときだけ)", () => {
    const r = classifyAudit("t", "", 1, " ERR_PNPM_AUDIT_BAD_RESPONSE  The audit endpoint responded with 500\nstack...");
    expect(r.lines[0]).toContain("ERR_PNPM_AUDIT_BAD_RESPONSE");
    expect(r.lines[0]).not.toContain("stack...");
    expect(classifyAudit("t", "", 1).lines[0]).not.toContain("stderr");
  });

  it("error を含んでいても low 以上の件数が 1 以上なら、UNAVAILABLE ではなく FAIL を優先する(件数は監査の結果そのもの。取りこぼしを避ける側)", () => {
    const r = classifyAudit("t", JSON.stringify({ error: { code: "E", message: "m" }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } } }), 1);
    expect(r.verdict).toBe("fail");
  });
});

describe("audit-report.ts の CLI(型を除去して素の node で実行できる。CI は tsx をインストールしない)", () => {
  /** 一時ディレクトリに出力・標準エラーのファイルを作り、`node scripts/ci/audit-report.ts` を実行する。 */
  function run(args: (dir: string) => string[], files: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-report-"));
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
      const summary = path.join(dir, "summary.md");
      const r = spawnSync(process.execPath, [SCRIPT, ...args(dir)], {
        encoding: "utf-8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      });
      let summaryText = "";
      try {
        summaryText = readFileSync(summary, "utf-8");
      } catch {
        // 書かれなかった
      }
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, summaryText };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("OK: 0 件の出力 + exit 0 で、標準出力に AUDIT-OK、終了コード 0、ステップサマリにも同じ行を書く", () => {
    const r = run((d) => ["root", path.join(d, "a.json"), "0", path.join(d, "a.err")], { "a.json": fixture("pnpm-audit-clean.json"), "a.err": "" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("AUDIT-OK root: 0 vulnerabilities");
    expect(r.summaryText).toContain("AUDIT-OK root: 0 vulnerabilities");
  });

  it("FAIL: 脆弱性の出力 + exit 1 で、AUDIT-FAIL と advisory の行、終了コード 1", () => {
    const r = run((d) => ["cloud", path.join(d, "a.json"), "1", path.join(d, "a.err")], { "a.json": fixture("pnpm-audit-vulnerable.json"), "a.err": "" });
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n")[0]).toBe("AUDIT-FAIL cloud: critical=0 high=3 moderate=3 low=0 info=0 (total 6)");
    expect(r.stdout.trim().split("\n")).toHaveLength(7);
  });

  it("UNAVAILABLE: 届かないレジストリの出力 + exit 1 で、終了コード 2", () => {
    const r = run((d) => ["root", path.join(d, "a.json"), "1", path.join(d, "a.err")], { "a.json": fixture("pnpm-audit-registry-error.json"), "a.err": "" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("AUDIT-UNAVAILABLE root: ");
  });

  it("出力のファイルが無い・終了コードが数でない・引数が足りないときは、UNAVAILABLE として終了コード 2(例外で落ちて OK 扱いにならない)", () => {
    const missing = run((d) => ["root", path.join(d, "nothing.json"), "1"], {});
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain("AUDIT-UNAVAILABLE root: ");
    const badCode = run((d) => ["root", path.join(d, "a.json"), "abc"], { "a.json": fixture("pnpm-audit-clean.json") });
    expect(badCode.status).toBe(2);
    expect(badCode.stdout).toContain("AUDIT-UNAVAILABLE root: ");
    const noArgs = run(() => [], {});
    expect(noArgs.status).toBe(2);
    expect(noArgs.stdout).toContain("AUDIT-UNAVAILABLE");
  });
});
