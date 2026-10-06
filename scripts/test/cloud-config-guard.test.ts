import { existsSync, readFileSync } from "node:fs";
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

  it("本番の設定に [access.dev](ローカルの ctx.access 注入)を置かない。注入はスモークが一時ファイルで行う", () => {
    expect(tomlCode).not.toMatch(/^\[access/m);
    expect(readTextLf("cloud", "smoke.ts")).toContain("[access.dev]");
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
    for (const entry of ["node_modules/", ".wrangler/", "dist-dry/", "wrangler.smoke.generated.toml"]) {
      expect(gi.split("\n")).toContain(entry);
    }
  });
});

describe("公開リポジトリへの値の混入(実在のメール・チーム名・AUD をコード・テスト・ワークフローに書かない)", () => {
  const files = [
    ["cloud", "wrangler.toml"],
    ["cloud", "smoke.ts"],
    [".github", "workflows", "deploy-cloud.yml"],
    ["cloud", "src", "access-jwt.ts"],
    ["cloud", "src", "authenticate.ts"],
    ["cloud", "src", "handler.ts"],
    ["cloud", "src", "page.ts"],
    ["cloud", "src", "worker.ts"],
    ["cloud", "src", "netkeiba-gate-do.ts"],
    ["cloud", "test", "helpers.ts"],
    ["cloud", "test", "access-jwt.test.ts"],
    ["cloud", "test", "authenticate.test.ts"],
    ["cloud", "test", "handler.test.ts"],
  ];

  it("メールアドレスの形は example.com のものだけ", () => {
    const found: string[] = [];
    for (const segments of files) {
      const text = readTextLf(...segments);
      for (const m of text.matchAll(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) {
        found.push(`${segments.join("/")}: ${m[0]}`);
      }
    }
    // 前提: 検査が空振りしていない(テストのフィクスチャのメールを拾えている)
    expect(found.length).toBeGreaterThan(0);
    const bad = found.filter((f) => !/@example\.com$/i.test(f));
    expect(bad).toEqual([]);
  });

  it("<リテラル>.cloudflareaccess.com の形は、ソース・設定・ワークフローに無い(チーム名を書かない。テストのダミーのみ)", () => {
    const nonTest = files.filter((s) => s[1] !== "test");
    const bad: string[] = [];
    for (const segments of nonTest) {
      for (const m of readTextLf(...segments).matchAll(/[A-Za-z0-9-]+\.cloudflareaccess\.com/g)) {
        bad.push(`${segments.join("/")}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
    // 前提: 検査の正規表現が、リテラルのチーム名を実際に拾える(テストのダミーで確認)
    const dummy = readTextLf("cloud", "test", "access-jwt.test.ts");
    expect(/[A-Za-z0-9-]+\.cloudflareaccess\.com/.test(dummy)).toBe(true);
  });
});
