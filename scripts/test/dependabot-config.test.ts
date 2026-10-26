/**
 * Dependabot の設定(.github/dependabot.yml)の静的検査(Issue #310)。
 *
 * 背景: Issue #305 で Actions を SHA でピン留めし、依存の版を固定した。固定すると更新が自動で入らず、通知も来ない。
 * Dependabot の「バージョン更新」で知らせ、PR をレビューしてマージする運用にする。
 *
 * 方針:
 *  - PR の宛先は作業ブランチ(main へ直接取り込まない規則。CLAUDE.md「その他」)。すべての更新に `target-branch` を付ける。
 *  - 対象は github-actions と npm(ルート・cloud/)。cloud/ は pnpm workspace の外にあり、別の pnpm-lock.yaml を持つ。
 *    packages/*(workspace のメンバー)は directories に並べない。ルート("/")の job が workspace のメンバーの依存まで見て、
 *    メンバーの package.json とルートの pnpm-lock.yaml を一緒に更新する。メンバーを別のディレクトリとして並べると、
 *    メンバーの中には lockfile が無いので、ルートの job が失敗した回に package.json だけの PR ができる(Issue #465。docs/current-spec.md「Dependabot」)。
 *  - `@anthropic-ai/sdk`・`iconv-lite`・`cheerio`(core は `^X.Y.Z`、cloud は exact `X.Y.Z`)など、core と cloud が同じ版を揃えている依存は、
 *    1 つの group にして 1 つの PR で同時に上げさせる(片方だけの PR は cloud-config-guard.test.ts が赤にして気づける)。
 *  - Issue #498: 更新は平日の毎日(`interval: daily`。GitHub の仕様で月〜金だけ動く。土日は動かない)・日本時間 02:41(`time`・`timezone`)。毎日の監査(.github/workflows/audit.yml。03:17 JST)と、Claude の毎朝の確認(04:23 JST)より前に動く。
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

/** pnpm-workspace.yaml の `packages:` の値(`  - packages/*` の形)を返す。無ければ空配列。 */
function workspacePackagesOf(text: string): string[] {
  const m = /(?:^|\n)packages:\n((?: {2}- .+\n?)+)/.exec(text);
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

describe("検査する側の自己検証: pnpm-workspace.yaml の読み取り(Issue #465)", () => {
  it("workspacePackagesOf は packages: の値だけを返す(他のキーの項目や、packages が無い場合は拾わない)", () => {
    expect(workspacePackagesOf("packages:\n  - packages/*\n")).toEqual(["packages/*"]);
    expect(workspacePackagesOf("packages:\n  - packages/*\n  - 'tools/a'\ncatalog:\n  - x\n")).toEqual(["packages/*", "tools/a"]);
    expect(workspacePackagesOf("packages: []\n")).toEqual([]);
    expect(workspacePackagesOf("catalog:\n  - x\n")).toEqual([]);
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

  it("Issue #498: すべての項目が平日の毎日(schedule.interval: daily。月〜金だけ動く)・日本時間 02:41(time・timezone)。weekly が残っていない", () => {
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e).toMatch(/\n {4}schedule:\n {6}interval: daily\n {6}time: "02:41"\n {6}timezone: "Asia\/Tokyo"\n/);
    }
    expect(code).not.toContain("weekly");
    // schedule の行は項目ごとに 1 つ(項目の数と一致する)
    expect(code.match(/^ {6}interval: /gm)).toHaveLength(2);
    expect(code.match(/^ {6}time: /gm)).toHaveLength(2);
    expect(code.match(/^ {6}timezone: /gm)).toHaveLength(2);
  });

  it("Issue #498: Dependabot の時刻(02:41 JST)は、毎日の監査(audit.yml の cron。03:17 JST)より前。Claude の確認(04:23 JST)より前に、監査と更新の PR が出そろう", () => {
    const m = /time: "(\d{2}):(\d{2})"/.exec(code);
    expect(m, "time が読める").not.toBeNull();
    const dependabotMinutes = Number(m![1]) * 60 + Number(m![2]);
    const audit = readTextLf(".github", "workflows", "audit.yml");
    const cron = /- cron: "(\d+) (\d+) \* \* \*"/.exec(audit);
    expect(cron, "audit.yml の cron が読める").not.toBeNull();
    const auditMinutesJst = (((Number(cron![2]) + 9) % 24) * 60) + Number(cron![1]);
    expect(dependabotMinutes).toBeLessThan(auditMinutesJst);
    expect(auditMinutesJst).toBeLessThan(4 * 60 + 23);
    // 02 時台
    expect(Math.floor(dependabotMinutes / 60)).toBe(2);
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

    it("Issue #465: directories は ルートと cloud の 2 つだけ(workspace のメンバー packages/* は並べない。directory の単数指定も使わない)", () => {
      expect(dirs).toEqual(["/", "/cloud"]);
      expect(e).not.toMatch(/\n {4}directory:/);
    });

    it("Issue #465: リポジトリ内の package.json のあるディレクトリは、directories に含まれるか、pnpm workspace のメンバー(ルートの job が担当)のどちらかで、workspace のメンバーは directories に含まれない", () => {
      const workspacePatterns = workspacePackagesOf(readTextLf("pnpm-workspace.yaml"));
      // 前提(空振り防止): workspace の指定を読めている
      expect(workspacePatterns, "pnpm-workspace.yaml の packages").toEqual(["packages/*"]);
      const isMember = (dir: string) => workspacePatterns.some((p) => directoryMatches(`/${p}`, dir));
      const found: string[] = [];
      if (existsSync(path.join(ROOT, "package.json"))) found.push("/");
      for (const d of readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(path.join(ROOT, "packages", d.name, "package.json"))) found.push(`/packages/${d.name}`);
      }
      if (existsSync(path.join(ROOT, "cloud", "package.json"))) found.push("/cloud");
      // 前提(空振り防止): ルート・workspace のメンバー(packages/core)・workspace の外の cloud を、実際に見つけている
      expect(found).toEqual(expect.arrayContaining(["/", "/packages/core", "/cloud"]));
      expect(isMember("/packages/core"), "packages/core は workspace のメンバー").toBe(true);
      expect(isMember("/cloud"), "cloud は workspace の外(別の lockfile を持つ)").toBe(false);
      expect(isMember("/"), "ルートは workspace のメンバーの指定には当たらない").toBe(false);
      for (const dir of found) {
        expect(
          dirs.some((p) => directoryMatches(p, dir)) || isMember(dir),
          `${dir} は directories に含まれるか、workspace のメンバーである`,
        ).toBe(true);
      }
      for (const p of dirs) {
        expect(
          found.some((dir) => directoryMatches(p, dir)),
          `${p} に対応する package.json がある`,
        ).toBe(true);
        // メンバーを別のディレクトリとして並べない(メンバーの中に lockfile が無く、package.json だけの PR ができる)
        expect(
          found.filter((dir) => directoryMatches(p, dir)).some((dir) => isMember(dir)),
          `${p} は workspace のメンバーに当たらない`,
        ).toBe(false);
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

    it("Issue #332: @types/node の semver-major は ignore する(Node の実行環境〈CI の node-version〉のメジャーに合わせて手で上げる。minor・patch は受ける)", () => {
      const m = /\n {4}ignore:\n((?: {6,}.+\n)+)/.exec(`${e}\n`);
      expect(m, "npm の項目に ignore ブロックがある").not.toBeNull();
      const block = m![1]!;
      // ignore の項目は @types/node の 1 つだけ(他の依存を巻き込んで握りつぶさない)
      expect([...block.matchAll(/^ {6}- dependency-name: (.+)$/gm)].map((x) => (x[1] ?? "").replace(/^["']|["']$/g, ""))).toEqual(["@types/node"]);
      // 種類は semver-major だけ(minor・patch まで無視すると、型定義の修正が届かない)
      expect([...block.matchAll(/^ {10}- (.+)$/gm)].map((x) => (x[1] ?? "").replace(/^["']|["']$/g, ""))).toEqual(["version-update:semver-major"]);
      expect(block).toMatch(/\n? {8}update-types:\n/);
      // 実体がある(@types/node は cloud の devDependencies にある。名前だけが残って依存が消えた、を防ぐ)
      const cloud = JSON.parse(readTextLf("cloud", "package.json")) as { devDependencies: Record<string, string> };
      expect(cloud.devDependencies["@types/node"]).toBeDefined();
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
