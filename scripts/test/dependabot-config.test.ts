/**
 * Dependabot の設定(.github/dependabot.yml)の静的検査(Issue #310)。
 *
 * 背景: Issue #305 で Actions を SHA でピン留めし、依存の版を固定した。固定すると更新が自動で入らず、通知も来ない。
 * Dependabot の「バージョン更新」で知らせ、PR をレビューしてマージする運用にする。
 *
 * 方針:
 *  - PR の宛先は作業ブランチ(main へ直接取り込まない規則。CLAUDE.md「その他」)。すべての更新に `target-branch` を付ける。
 *  - 対象は github-actions と npm(ルート・packages/*・cloud/)。cloud/ は pnpm workspace の外にあり、別の pnpm-lock.yaml を持つ。
 *  - `@anthropic-ai/sdk`・`iconv-lite`・`cheerio`(core は `^X.Y.Z`、cloud は exact `X.Y.Z`)など、core と cloud が同じ版を揃えている依存は、
 *    1 つの group にして 1 つの PR で同時に上げさせる(片方だけの PR は cloud-config-guard.test.ts が赤にして気づける)。
 *  - 自動の脆弱性修正(セキュリティ更新)の PR はこのファイルでは扱えない(宛先を main 以外にできない見込み。未確認)ので、
 *    リポジトリの「Dependabot alerts」で通知を受け、作業ブランチで対応する(docs/current-spec.md)。
 *
 * 限界: これは yml のテキストへの検査である。Dependabot が実際にどんな PR を作るか(group が 2 つのディレクトリをまたいで
 * 1 つの PR になるか・pnpm workspace と cloud/ の lockfile を正しく更新するか)は、dependabot.yml が既定ブランチ(main)に
 * 入って最初の PR が来るまで確かめられない。yml のパーサは使わない(依存を足さない。ci-workflow.test.ts と同じ流儀)。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALLOWED_BRANCH = "claude/issue-order-processing-wjgpdd";

function readTextLf(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), "utf-8").replace(/\r\n/g, "\n");
}

/** コメント行を除いた本文。 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** `updates:` 直下の各項目(`  - package-ecosystem: x` から次の項目の直前まで)を、出現順に返す。 */
function splitUpdates(code: string): string[] {
  const start = code.indexOf("\nupdates:\n");
  if (start < 0) return [];
  return code
    .slice(start + "\nupdates:\n".length)
    .split(/\n(?=  - package-ecosystem: )/)
    .filter((b) => b.trim() !== "");
}

/** `directories:` のブロック形式(`    directories:` に続く `      - "x"`)の値を返す。無ければ空配列。 */
function directoriesOf(entry: string): string[] {
  const m = /\n {4}directories:\n((?: {6}- .+\n?)+)/.exec(entry);
  if (m === null) return [];
  return m[1]!
    .trim()
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, "").trim());
}

/** ディレクトリの指定(`*` を 1 階層のワイルドカードとして扱う)が、dir(`/` 始まり)に一致するか。 */
function directoryMatches(pattern: string, dir: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}$`);
  return re.test(dir);
}

describe("検査する側の自己検証(正の対照。検出器が空振りしていないことの確認)", () => {
  const sample = [
    "version: 2",
    "updates:",
    "  # コメント内の - package-ecosystem: は数えない",
    "  - package-ecosystem: github-actions",
    '    directory: "/"',
    "  - package-ecosystem: npm",
    "    directories:",
    '      - "/"',
    '      - "/packages/*"',
    "    schedule:",
    "      interval: weekly",
  ].join("\n");

  it("splitUpdates は updates の項目だけを出現順に分ける", () => {
    const entries = splitUpdates(withoutComments(sample));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("github-actions");
    expect(entries[1]).toContain("package-ecosystem: npm");
    expect(entries[1]).not.toContain("github-actions");
    expect(splitUpdates("version: 2\n")).toEqual([]);
  });

  it("directoriesOf は directories のブロックの値だけを返す(directory 指定や、他のキーの項目は拾わない)", () => {
    const entries = splitUpdates(withoutComments(sample));
    expect(directoriesOf(entries[0]!)).toEqual([]);
    expect(directoriesOf(entries[1]!)).toEqual(["/", "/packages/*"]);
  });

  it("directoryMatches は * を 1 階層のワイルドカードとして扱う", () => {
    expect(directoryMatches("/packages/*", "/packages/core")).toBe(true);
    expect(directoryMatches("/packages/*", "/packages")).toBe(false);
    expect(directoryMatches("/packages/*", "/packages/core/src")).toBe(false);
    expect(directoryMatches("/", "/")).toBe(true);
    expect(directoryMatches("/", "/cloud")).toBe(false);
    expect(directoryMatches("/cloud", "/cloud")).toBe(true);
  });
});

describe("dependabot.yml(Issue #310)", () => {
  const ymlPath = path.join(ROOT, ".github", "dependabot.yml");

  it("存在する(以降の検査が、ファイルが無いまま空振りしない前提)", () => {
    expect(existsSync(ymlPath)).toBe(true);
  });

  const yml = existsSync(ymlPath) ? readTextLf(".github", "dependabot.yml") : "";
  const code = withoutComments(yml);
  const entries = splitUpdates(code);

  it("version: 2。updates は github-actions と npm の 2 項目だけ(この順)", () => {
    expect(code).toMatch(/^version: 2$/m);
    expect(entries.map((e) => /package-ecosystem: (\S+)/.exec(e)?.[1])).toEqual(["github-actions", "npm"]);
  });

  it("すべての項目の target-branch は作業ブランチ(main 宛てにしない。項目の数と target-branch の行の数が一致する)", () => {
    expect(entries).toHaveLength(2);
    const targets = [...code.matchAll(/^ {4}target-branch: (.+)$/gm)].map((m) => (m[1] ?? "").trim().replace(/^["']|["']$/g, ""));
    expect(targets).toEqual([ALLOWED_BRANCH, ALLOWED_BRANCH]);
    for (const e of entries) {
      expect(e, "項目ごとに target-branch がある").toMatch(new RegExp(`\\n {4}target-branch: ${ALLOWED_BRANCH}\\n`));
    }
    expect(code).not.toMatch(/target-branch: ["']?main\b/);
  });

  it("すべての項目が週 1 回(schedule.interval: weekly)", () => {
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e).toMatch(/\n {4}schedule:\n {6}interval: weekly\n/);
    }
  });

  it("コミットメッセージの接頭辞は付ける(日本語可)が、承認印 [PUBLISH-APPROVED] と『レビュー継続中』は含まない(Dependabot のマージだけで本番へ出ない・出る条件に触れない)", () => {
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e, "項目ごとに commit-message.prefix がある").toMatch(/\n {4}commit-message:\n {6}prefix: .+\n/);
    }
    expect(code).not.toContain("PUBLISH-APPROVED");
    expect(code).not.toContain("レビュー継続中");
  });

  it("github-actions: ルートの .github/workflows を対象にし、全 Actions を 1 つの group にまとめる", () => {
    const e = entries[0]!;
    expect(e).toMatch(/\n {4}directory: ["']?\/["']?\n/);
    expect(e).toMatch(/\n {4}groups:\n {6}[\w-]+:\n {8}patterns:\n {10}- ["']\*["']\n/);
    expect(existsSync(path.join(ROOT, ".github", "workflows"))).toBe(true);
  });

  describe("npm", () => {
    const e = entries[1]!;
    const dirs = directoriesOf(e);

    it("directories は ルート・packages/*・cloud の 3 つ(directory の単数指定は使わない)", () => {
      expect(dirs).toEqual(["/", "/packages/*", "/cloud"]);
      expect(e).not.toMatch(/\n {4}directory:/);
    });

    it("リポジトリ内の package.json のあるディレクトリ(ルート・packages/*・cloud)がすべて directories に含まれ、含まれるディレクトリには package.json がある", () => {
      const found: string[] = [];
      if (existsSync(path.join(ROOT, "package.json"))) found.push("/");
      for (const d of readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(path.join(ROOT, "packages", d.name, "package.json"))) found.push(`/packages/${d.name}`);
      }
      if (existsSync(path.join(ROOT, "cloud", "package.json"))) found.push("/cloud");
      // 前提(空振り防止): 実際に 3 つ以上見つけている
      expect(found).toEqual(expect.arrayContaining(["/", "/packages/core", "/cloud"]));
      for (const dir of found) {
        expect(dirs.some((p) => directoryMatches(p, dir)), `${dir} が directories に含まれる`).toBe(true);
      }
      for (const p of dirs) {
        expect(
          found.some((dir) => directoryMatches(p, dir)),
          `${p} に対応する package.json がある`,
        ).toBe(true);
      }
    });

    it("core と cloud が同じ版を揃えている依存(@anthropic-ai/sdk・cheerio・iconv-lite)を、先頭の group に入れて 1 つの PR で同時に上げる", () => {
      const m = /\n {4}groups:\n {6}([\w-]+):\n {8}patterns:\n((?: {10}- .+\n)+)/.exec(e);
      expect(m).not.toBeNull();
      const patterns = m![2]!
        .trim()
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, "").trim());
      expect(patterns).toEqual(["@anthropic-ai/sdk", "cheerio", "iconv-lite"]);
      // この 3 つは実際に core と cloud の両方の dependencies にある(group の名前だけが残って実体が無い、を防ぐ)
      const core = JSON.parse(readTextLf("packages", "core", "package.json")) as { dependencies: Record<string, string> };
      const cloud = JSON.parse(readTextLf("cloud", "package.json")) as { dependencies: Record<string, string> };
      for (const name of patterns) {
        expect(core.dependencies[name], `core に ${name}`).toBeDefined();
        expect(cloud.dependencies[name], `cloud に ${name}`).toBeDefined();
      }
    });

    it("上の group のあとに、本番の依存(production)と開発の依存(development)の group があり、PR の数を抑える", () => {
      expect(e).toMatch(/\n {6}[\w-]+:\n {8}dependency-type: ["']?production["']?\n/);
      expect(e).toMatch(/\n {6}[\w-]+:\n {8}dependency-type: ["']?development["']?\n/);
      const names = [...e.matchAll(/^ {6}([\w-]+):$/gm)].map((m) => m[1]);
      // groups 配下のキーが 3 つ(core/cloud 共通・production・development)。先頭が共通 group(最初に一致した group に入るため)
      expect(names).toHaveLength(3);
      expect(e.indexOf("@anthropic-ai/sdk")).toBeLessThan(e.indexOf("dependency-type: production"));
      expect(e.indexOf("@anthropic-ai/sdk")).toBeLessThan(e.indexOf("dependency-type: development"));
    });
  });
});
