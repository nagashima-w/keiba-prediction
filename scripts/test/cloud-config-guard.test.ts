import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #161(#21-C): クラウド版(cloud/)の設定と、公開リポジトリに載せてはいけない値の混入の静的検査。
 *
 * 限界: wrangler.toml は正規表現で行を見るだけ(TOML パーサは使わない)。値の混入の検査は「文書用でない
 * メールアドレス・チーム名の形」だけを見る(実在の値そのものは知り得ない)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function readTextLf(...segments: string[]): string {
  return readFileSync(path.join(ROOT, ...segments), "utf-8").replace(/\r\n/g, "\n");
}

const toml = readTextLf("cloud", "wrangler.toml");
const tomlCode = toml
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("wrangler.toml", () => {
  it("workers.dev に出し、独自ドメイン・routes・Version/Preview URL は使わない", () => {
    expect(tomlCode).toMatch(/^workers_dev = true$/m);
    expect(tomlCode).toMatch(/^preview_urls = false$/m);
    expect(tomlCode).not.toMatch(/^\s*routes?\s*=/m);
    expect(tomlCode).not.toMatch(/^\[\[?routes\]?\]/m);
  });

  it("DO は SQLite バックエンド(new_sqlite_classes)だけで、KV バックエンド(new_classes。Paid のみ)を使わない", () => {
    expect(tomlCode).toMatch(/^new_sqlite_classes = \["NetkeibaGate"\]$/m);
    expect(tomlCode).not.toMatch(/new_classes\s*=/);
    expect(tomlCode).toMatch(/^name = "NETKEIBA_GATE"$/m);
    expect(tomlCode).toMatch(/^class_name = "NetkeibaGate"$/m);
  });

  it("設定値(チーム名・AUD・メール)を [vars] に置かず、secrets.required も使わない(未設定は Worker が 403 で受ける)", () => {
    expect(tomlCode).not.toMatch(/^\[vars\]/m);
    expect(tomlCode).not.toMatch(/ACCESS_(TEAM_NAME|AUD|ALLOWED_EMAIL)/);
    expect(tomlCode).not.toMatch(/^\[secrets\]/m);
    expect(tomlCode).not.toMatch(/keep_vars/);
  });

  it("本番の main は src/worker.ts で、smoke 専用エントリ(偽ソケット。smoke.ts が一時設定でだけ指す)を指さない", () => {
    expect(tomlCode).toMatch(/^main = "src\/worker\.ts"$/m);
    expect(tomlCode).not.toMatch(/smoke/i);
    const smoke = readTextLf("cloud", "smoke.ts");
    expect(smoke).toContain('main = "smoke-worker.ts"');
    expect(existsSync(path.join(ROOT, "cloud", "smoke-worker.ts"))).toBe(true);
  });

  it("本番の設定に [access.dev](ローカルの ctx.access 注入)を置かない。注入はスモークが一時ファイルで行う", () => {
    expect(tomlCode).not.toMatch(/^\[access/m);
    expect(readTextLf("cloud", "smoke.ts")).toContain("[access.dev]");
  });
});

describe("core の取り込み(Issue #162 段階2。alias の3か所の対応)", () => {
  const ALIAS_KEYS = ["undici", "iconv-lite", "cheerio"];

  it("nodejs_compat を有効にしている(core の HttpClient・iconv-lite が Buffer を使う)", () => {
    expect(tomlCode).toMatch(/^compatibility_flags = \["nodejs_compat"\]$/m);
  });

  it("wrangler.toml の [alias]・tsconfig.json の paths・vitest.config.ts の alias が、同じ3つの依存を同じ行き先へ向ける(CI にだけ効く設定の書き忘れを防ぐ)", () => {
    const aliasBlock = /^\[alias\]\n((?:[^\n[]+\n?)+)/m.exec(tomlCode)?.[1] ?? "";
    // 前提: [alias] を実際に読めている(空振りではない)
    expect(aliasBlock).not.toBe("");
    const tsconfig = readTextLf("cloud", "tsconfig.json");
    const vitestConfig = readTextLf("cloud", "vitest.config.ts");
    const target: Record<string, string> = {
      undici: "./src/undici-stub.ts",
      "iconv-lite": "./node_modules/iconv-lite",
      cheerio: "./node_modules/cheerio",
    };
    for (const key of ALIAS_KEYS) {
      expect(aliasBlock, `[alias] に ${key}`).toContain(`${key} = "${target[key]}"`);
      expect(tsconfig, `tsconfig の paths に ${key}`).toContain(`"${key}": ["${target[key]}"]`);
      expect(vitestConfig, `vitest の alias に ${key}`).toMatch(new RegExp(`"?${key}"?: here\\("${target[key]!.replace(/[./]/g, "\\$&")}"\\)`));
    }
    // [alias] に余計な行き先が無い(3つだけ)
    expect(aliasBlock.trim().split("\n")).toHaveLength(ALIAS_KEYS.length);
  });

  it("alias の行き先は cloud/ の中の相対パス(`..` で外へ出ない。packages/core/node_modules は CI に無い)で、スタブは実在する", () => {
    const aliasBlock = /^\[alias\]\n((?:[^\n[]+\n?)+)/m.exec(tomlCode)?.[1] ?? "";
    const targets = [...aliasBlock.matchAll(/= "([^"]+)"/g)].map((m) => m[1]!);
    // 前提: 行き先を実際に読めている(空振りではない)
    expect(targets).toHaveLength(ALIAS_KEYS.length);
    for (const target of targets) {
      expect(target, `行き先 ${target}`).toMatch(/^\.\/(?!.*\.\.)/);
    }
    expect(existsSync(path.join(ROOT, "cloud", "src", "undici-stub.ts"))).toBe(true);
  });

  it("cheerio・iconv-lite は固定版で、追加理由が //deps にある", () => {
    const pkg = JSON.parse(readTextLf("cloud", "package.json")) as {
      dependencies: Record<string, string>;
      "//deps": Record<string, string>;
    };
    for (const name of ["cheerio", "iconv-lite"]) {
      expect(pkg.dependencies[name], `${name} の版`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg["//deps"][name], `${name} の理由`).toBeTruthy();
    }
  });
});

describe("cloud/ はワークスペースの外(既存の CI のインストールを重くしない)", () => {
  it("pnpm-workspace.yaml は packages/* だけで、cloud を含まない", () => {
    const workspace = readTextLf("pnpm-workspace.yaml");
    expect(workspace).toContain("packages/*");
    expect(workspace).not.toMatch(/cloud/);
  });

  it("依存は固定され(jose・wrangler・workers-types は ^ ~ なし)、jose の追加理由が //deps にある", () => {
    const pkg = JSON.parse(readTextLf("cloud", "package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      "//deps": Record<string, string>;
    };
    expect(pkg.dependencies["jose"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["wrangler"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["@cloudflare/workers-types"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg["//deps"]["jose"]).toBeTruthy();
    expect(existsSync(path.join(ROOT, "cloud", "pnpm-lock.yaml"))).toBe(true);
  });

  it(".gitignore が node_modules・.wrangler・スモークの一時設定を除外する", () => {
    const gi = readTextLf("cloud", ".gitignore");
    for (const entry of ["node_modules/", ".wrangler/", "dist-dry/", "wrangler.smoke.generated.toml", "wrangler.smoke-fake.generated.toml", "wrangler.bundle-guard.generated.toml"]) {
      expect(gi.split("\n")).toContain(entry);
    }
  });
});

/**
 * 検査対象のファイル: cloud/ 配下の全ファイル(cloud/.gitignore が除外するもの、すなわち node_modules などの
 * 生成物は除く)と、デプロイのワークフロー。固定の一覧にしない(新しいファイル・README も自動で対象になる)。
 * 戻り値は ROOT からの相対パス(/ 区切り)。
 */
function scanTargets(): string[] {
  const ignored = readTextLf("cloud", ".gitignore")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const ignoredDirs = new Set(ignored.filter((l) => l.endsWith("/")).map((l) => l.slice(0, -1)));
  const ignoredFiles = new Set(ignored.filter((l) => !l.endsWith("/")));
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(next);
        }
      } else if (!ignoredFiles.has(entry.name)) {
        out.push(next);
      }
    }
  };
  walk("cloud");
  out.push(".github/workflows/deploy-cloud.yml");
  return out.sort();
}

const EMAIL_RE = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TEAM_HOST_RE = /[A-Za-z0-9-]+\.cloudflareaccess\.com/g;
/** Access の AUD タグは 64 桁の 16 進。 */
const AUD_LIKE_RE = /\b[0-9a-f]{64}\b/gi;

describe("公開リポジトリへの値の混入(実在のメール・チーム名・AUD を cloud/ 配下の全ファイルとワークフローに書かない)", () => {
  const targets = scanTargets();
  /** pnpm-lock.yaml は生成物で `名前@版数` がメールの形に見えるため、メールの検査からだけ除く。 */
  const emailTargets = targets.filter((t) => t !== "cloud/pnpm-lock.yaml");

  it("検査が空振りしていない: 対象に期待するファイル(README・ソース・テスト・設定・ワークフロー)が含まれ、生成物は含まれない", () => {
    for (const expected of [
      "cloud/README.md",
      "cloud/wrangler.toml",
      "cloud/package.json",
      "cloud/smoke.ts",
      "cloud/smoke-worker.ts",
      "cloud/src/access-jwt.ts",
      "cloud/src/authenticate.ts",
      "cloud/src/handler.ts",
      "cloud/src/worker.ts",
      "cloud/test/helpers.ts",
      "cloud/test/handler.test.ts",
      ".github/workflows/deploy-cloud.yml",
    ]) {
      expect(targets, `対象に ${expected} がある`).toContain(expected);
    }
    expect(targets.length).toBeGreaterThanOrEqual(19);
    expect(targets.filter((t) => t.includes("node_modules") || t.includes("dist-dry") || t.includes(".wrangler"))).toEqual([]);
  });

  it("メールアドレスの形は example.com のものだけ(全ファイル。README を含む)", () => {
    const found: string[] = [];
    for (const rel of emailTargets) {
      for (const m of readTextLf(...rel.split("/")).matchAll(EMAIL_RE)) {
        found.push(`${rel}: ${m[0]}`);
      }
    }
    // 前提: 検査が空振りしていない(テストのフィクスチャのメールを拾えている。検出の正規表現が実際にメールを拾う)
    expect(found.length).toBeGreaterThan(0);
    expect("someone@gmail.com".match(EMAIL_RE)).not.toBeNull();
    // 許可するドメイン: example.com と、部分一致の拒否テストが使う文書用のダミー2つ(example.com.evil / example.co)だけ
    const bad = found.filter((f) => !/@example\.(com|com\.evil|co)$/i.test(f));
    expect(bad).toEqual([]);
  });

  it("<リテラル>.cloudflareaccess.com の形は、テスト以外のファイルに無い(チーム名を書かない。README・ワークフローを含む)", () => {
    const bad: string[] = [];
    for (const rel of targets.filter((t) => !t.startsWith("cloud/test/") && t !== "cloud/pnpm-lock.yaml")) {
      for (const m of readTextLf(...rel.split("/")).matchAll(TEAM_HOST_RE)) {
        bad.push(`${rel}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
    // 前提: 検出の正規表現が、リテラルのチーム名を実際に拾える(テストのダミーで確認)
    expect(TEAM_HOST_RE.test("https://real-team.cloudflareaccess.com")).toBe(true);
    TEAM_HOST_RE.lastIndex = 0;
    expect(readTextLf("cloud", "test", "access-jwt.test.ts").match(TEAM_HOST_RE)).not.toBeNull();
  });

  it("AUD らしい 64 桁の 16 進の文字列が、どのファイルにも無い(ロックファイルを含む)", () => {
    const bad: string[] = [];
    for (const rel of targets) {
      for (const m of readTextLf(...rel.split("/")).matchAll(AUD_LIKE_RE)) {
        bad.push(`${rel}: ${m[0].slice(0, 8)}…`);
      }
    }
    expect(bad).toEqual([]);
    // 前提: 検出の正規表現が、64 桁の 16 進を拾い、63 桁・65 桁は拾わない
    const sample = "a".repeat(64);
    expect(`x ${sample} y`.match(AUD_LIKE_RE)).toEqual([sample]);
    expect(`x ${"a".repeat(63)} y`.match(AUD_LIKE_RE)).toBeNull();
    expect(`x ${"a".repeat(65)} y`.match(AUD_LIKE_RE)).toBeNull();
  });
});
