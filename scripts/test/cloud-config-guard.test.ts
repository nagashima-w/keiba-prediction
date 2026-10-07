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

  it("Issue #177: 日単位の DO(RACE_DAY・RaceDay)は migration v2 で追加するだけ。v1(NetkeibaGate)は無変更で、new_classes・renamed・deleted は使わない", () => {
    const migrations = [...tomlCode.matchAll(/^\[\[migrations\]\]\ntag = "(v\d+)"\n(?:[^\n]*\n)*?new_sqlite_classes = \[([^\]]*)\]/gm)].map((m) => [m[1], m[2]]);
    expect(migrations).toEqual([
      ["v1", '"NetkeibaGate"'],
      ["v2", '"RaceDay"'],
    ]);
    expect(tomlCode).toMatch(/^name = "RACE_DAY"$/m);
    expect(tomlCode).toMatch(/^class_name = "RaceDay"$/m);
    expect(tomlCode).not.toMatch(/^(renamed_classes|deleted_classes|transferred_classes)\s*=/m);
    // DO のバインディングはちょうど2つ(NETKEIBA_GATE・RACE_DAY)
    expect((tomlCode.match(/^\[\[durable_objects\.bindings\]\]$/gm) ?? []).length).toBe(2);
  });

  it("Issue #180・#183: netkeiba への取得の起点は、認証の後ろの手動の操作だけ(POST の起動・GET の一覧・GET の確認)。Cron Trigger・scheduled ハンドラ・キューの consumer が無い。定時の起動は #166", () => {
    expect(tomlCode).not.toMatch(/^\[triggers\]/m);
    expect(tomlCode).not.toMatch(/^\s*crons\s*=/m);
    expect(tomlCode).not.toMatch(/^\[\[queues\./m);
    const worker = readTextLf("cloud", "src", "worker.ts");
    expect(worker.length).toBeGreaterThan(100); // 前提: 読めている
    expect(worker).not.toMatch(/\bscheduled\b/);
    expect(worker).not.toMatch(/\bqueue\b\s*\(/);
    // 手動の入口は、認証の後ろの POST /api/analyses/run だけ(handler.ts)。ここから日単位の DO の schedule を呼ぶ
    const handler = readTextLf("cloud", "src", "handler.ts");
    expect(handler).toContain('"/api/analyses/run"');
    expect(handler).toContain("originAllowed(request)");
    // Issue #183: GET の一覧(`/api/races`)も netkeiba に出うる。handler.ts から netkeiba に届く呼び出し(DO の予約・一覧・gate の取得)は、
    // **呼び出し箇所の数で固定する**(コメント除去後。新しい取得口を足すと、この数が変わってここで落ちる)。
    const code = handler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code.length).toBeGreaterThan(1000); // 前提: コメント除去で本文を消していない
    const count = (pattern: RegExp): number => (code.match(pattern) ?? []).length;
    expect(count(/\.schedule\(/g)).toBe(1); // handleRun(POST)
    expect(count(/\.getRaceList\(/g)).toBe(1); // handleRaces(GET。Sec-Fetch-Site・検証の後)
    expect(count(/\.fetchRaw\(/g)).toBe(1); // handleCheck(GET /api/netkeiba/check)
    expect(handler).toContain('"/api/races"');
    // 一覧の入口は、DO を呼ぶ前に Sec-Fetch-Site を見る
    expect(code.indexOf("sec-fetch-site")).toBeGreaterThan(-1);
    expect(code.indexOf("sec-fetch-site")).toBeLessThan(code.indexOf(".getRaceList("));
    // 対照(検出の確認。空振りでない): 取得口を1つ足した本文では、数が変わる
    expect(((code + "\ngate.fetchRaw(x);").match(/\.fetchRaw\(/g) ?? []).length).toBe(2);
  });

  it("Issue #184: 静的アセット([assets])を使わない。クライアントの JS は Worker が認証の後ろで配る(run_worker_first を付け忘れると認証を素通りする配信の経路ができるため、そもそも置かない)", () => {
    expect(tomlCode).not.toMatch(/^\[assets\]/m);
    expect(tomlCode).not.toMatch(/^\s*run_worker_first\s*=/m);
    expect(tomlCode).not.toMatch(/^\s*assets\s*=/m);
    // 検出の確認(空振りでない): 書かれていれば拾える形
    expect('[assets]\ndirectory = "./public"\n').toMatch(/^\[assets\]/m);
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

/** `[[d1_databases]]` テーブルの本文(次のテーブルの直前まで。コメント除去済みの tomlCode から)。 */
function d1Block(): string {
  const m = /^\[\[d1_databases\]\]\n((?:(?!\[)[^\n]*\n?)*)/m.exec(tomlCode);
  return m?.[1] ?? "";
}

const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";

describe("D1(Issue #171。AC-a7: wrangler.toml の設定)", () => {
  it("[[d1_databases]] はちょうど1つで、binding は DB・database_name は keiba-cloud-db・migrations_dir は migrations", () => {
    expect((tomlCode.match(/^\[\[d1_databases\]\]$/gm) ?? []).length).toBe(1);
    const block = d1Block();
    // 前提: ブロックを実際に読めている(空振りでない)
    expect(block).not.toBe("");
    expect(block).toMatch(/^binding = "DB"$/m);
    expect(block).toMatch(/^database_name = "keiba-cloud-db"$/m);
    expect(block).toMatch(/^migrations_dir = "migrations"$/m);
  });

  it("database_id は UUID の形で、仮の値(ゼロ UUID)ではない(ダッシュボードで作成した実際の D1。公開してよい値)", () => {
    const id = /^database_id = "([^"]*)"$/m.exec(d1Block())?.[1];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toBe(PLACEHOLDER_D1_ID);
  });

  it("remote = true を使わない(ローカルのテスト・開発が本番の D1 に繋がってしまう)。preview_database_id も使わない", () => {
    expect(tomlCode).not.toMatch(/^\s*remote\s*=/m);
    expect(tomlCode).not.toMatch(/preview_database_id/);
    // 検出の確認(空振りでない): 書かれていれば拾える形
    expect('[[d1_databases]]\nremote = true\n').toMatch(/^\s*remote\s*=/m);
  });

  it("migrations_dir が指すディレクトリがあり、migration が入っている", () => {
    expect(readdirSync(path.join(ROOT, "cloud", "migrations")).filter((f) => f.endsWith(".sql")).length).toBeGreaterThanOrEqual(2);
  });
});

/** `[[r2_buckets]]` テーブルの本文(次のテーブルの直前まで。コメント除去済みの tomlCode から)。 */
function r2Block(): string {
  const m = /^\[\[r2_buckets\]\]\n((?:(?!\[)[^\n]*\n?)*)/m.exec(tomlCode);
  return m?.[1] ?? "";
}

describe("R2(Issue #174〈#172-a〉: wrangler.toml の設定)", () => {
  it("[[r2_buckets]] はちょうど1つで、binding は ANALYSIS_DETAIL・bucket_name は keiba-cloud-r2", () => {
    expect((tomlCode.match(/^\[\[r2_buckets\]\]$/gm) ?? []).length).toBe(1);
    const block = r2Block();
    // 前提: ブロックを実際に読めている(空振りでない)
    expect(block).not.toBe("");
    expect(block).toMatch(/^binding = "ANALYSIS_DETAIL"$/m);
    expect(block).toMatch(/^bucket_name = "keiba-cloud-r2"$/m);
  });

  it("bucket_name は R2 のバケット名の規則(小文字・数字・ハイフンの 3〜63 文字)に合う(CI の権限確認が URL に使う値なので、記号を許さない)", () => {
    const name = /^bucket_name = "([^"]*)"$/m.exec(r2Block())?.[1];
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  });

  it("remote = true・preview_bucket_name・jurisdiction を使わない(ローカルのテスト・開発が本番のバケットに繋がらない。管轄の指定は無い前提=既定)", () => {
    // 前提: ブロックを実際に読めている(読めていないと、下の「無い」が自明に成立する)
    expect(r2Block()).not.toBe("");
    expect(tomlCode).not.toMatch(/^\s*remote\s*=/m);
    expect(tomlCode).not.toMatch(/preview_bucket_name/);
    expect(r2Block()).not.toMatch(/jurisdiction/);
    // 検出の確認(空振りでない): 書かれていれば拾える形
    expect('[[r2_buckets]]\njurisdiction = "eu"\n').toMatch(/jurisdiction/);
    expect('[[r2_buckets]]\npreview_bucket_name = "x"\n').toMatch(/preview_bucket_name/);
  });
});

/** コメント(`--` から行末)を除いた SQL。 */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** 破壊的な文(データ・列・表を壊す)の検出。文の先頭(`;` の直後か先頭)にあるものだけを見る(外部キーの `ON DELETE` 句は見ない)。 */
function destructiveStatements(sql: string): string[] {
  const code = stripSqlComments(sql);
  const found: string[] = [];
  for (const stmt of code.split(";")) {
    const text = stmt.trim();
    if (/^(DROP|DELETE|UPDATE|TRUNCATE|REPLACE)\b/i.test(text) || /^INSERT\s+OR\s+REPLACE\b/i.test(text) || /^ALTER\s+TABLE\s+\S+\s+(DROP|RENAME)\b/i.test(text)) {
      found.push(text.split("\n")[0]!);
    }
  }
  return found;
}

describe("D1 の migration は追加のみ(Issue #171。AC-a7: 静的ガード)", () => {
  const dir = path.join(ROOT, "cloud", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  it("ファイル名は NNNN_名前.sql(小文字・数字・アンダースコア)で、番号は 0001 から欠番なく連続している", () => {
    expect(files.length).toBeGreaterThan(0);
    files.forEach((f, i) => {
      expect(f, `${f} の名前`).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(Number(f.slice(0, 4)), `${f} の番号`).toBe(i + 1);
    });
  });

  it("破壊的な文(DROP・DELETE・UPDATE・TRUNCATE・REPLACE・ALTER TABLE の DROP/RENAME)が1つも無い", () => {
    for (const f of files) {
      expect(destructiveStatements(readTextLf("cloud", "migrations", f)), `${f}`).toEqual([]);
    }
  });

  it("検出の確認(空振りでない): 破壊的な文は拾い、追加の文・外部キーの句・コメントの中の語は拾わない", () => {
    for (const bad of [
      "DROP TABLE analyses;",
      "drop index idx_x;",
      "DELETE FROM analyses;",
      "UPDATE analyses SET model = 'x';",
      "TRUNCATE TABLE analyses;",
      "REPLACE INTO analyses VALUES (1);",
      "INSERT OR REPLACE INTO analyses VALUES (1);",
      "ALTER TABLE analyses DROP COLUMN model;",
      "ALTER TABLE analyses RENAME TO x;",
      "CREATE TABLE t (a INTEGER);\nDROP TABLE t;",
    ]) {
      expect(destructiveStatements(bad), bad).toHaveLength(1);
    }
    for (const ok of [
      "CREATE TABLE t (a INTEGER, FOREIGN KEY (a) REFERENCES u (id) ON DELETE CASCADE ON UPDATE CASCADE);",
      "ALTER TABLE analyses ADD COLUMN detail_key TEXT;",
      "CREATE INDEX i ON analyses (race_id);",
      "-- DROP TABLE analyses;\nCREATE TABLE t (a INTEGER);",
    ]) {
      expect(destructiveStatements(ok), ok).toEqual([]);
    }
  });
});

describe("core の取り込み(Issue #162 段階2。alias の3か所の対応)", () => {
  const ALIAS_KEYS = ["undici", "iconv-lite", "cheerio"];
  /**
   * Issue #176(#164-a): runAnalysis(app)が import する core のサブパス。wrangler の alias は完全一致なので1行ずつ要る。
   * 行き先は packages/core/src の実ファイル(依存の行き先〈cloud/node_modules・スタブ〉とは違い、リポジトリに入っているソース。CI にも在る)。
   * tsconfig.json の paths は `@keiba/core/*` の前方一致、vitest.config.ts の alias は `@keiba/core` の前方一致。
   */
  const CORE_SUBPATHS = ["pipeline", "scorer/snapshot-filter", "ev/bet-allocation", "ev/combo-bet-allocation"];

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
    // Issue #176: core のサブパス(完全一致の1行ずつ)。tsconfig の paths・vitest の alias は前方一致で、同じ行き先(packages/core/src)を向く
    for (const sub of CORE_SUBPATHS) {
      expect(aliasBlock, `[alias] に @keiba/core/${sub}`).toContain(`"@keiba/core/${sub}" = "../packages/core/src/${sub}.ts"`);
    }
    expect(tsconfig, "tsconfig の paths に @keiba/core/*").toContain('"@keiba/core/*": ["../packages/core/src/*"]');
    expect(vitestConfig, "vitest の alias に @keiba/core").toMatch(/"@keiba\/core": here\("\.\.\/packages\/core\/src"\)/);
    // バレル(`@keiba/core` そのもの)は、どこにも向けていない(better-sqlite3 を巻き込む)
    expect(aliasBlock).not.toMatch(/^"@keiba\/core"\s*=/m);
    expect(tsconfig).not.toContain('"@keiba/core":');
    // [alias] に余計な行き先が無い(依存3つ + core のサブパス)
    expect(aliasBlock.trim().split("\n")).toHaveLength(ALIAS_KEYS.length + CORE_SUBPATHS.length);
  });

  it("alias の行き先は cloud/ の中の相対パス(`..` で外へ出ない。packages/core/node_modules は CI に無い)で、スタブは実在する", () => {
    const aliasBlock = /^\[alias\]\n((?:[^\n[]+\n?)+)/m.exec(tomlCode)?.[1] ?? "";
    const targets = [...aliasBlock.matchAll(/^(?!"@keiba\/core\/)[^\n=]+= "([^"]+)"/gm)].map((m) => m[1]!);
    // 前提: 行き先を実際に読めている(空振りではない)
    expect(targets).toHaveLength(ALIAS_KEYS.length);
    for (const target of targets) {
      expect(target, `行き先 ${target}`).toMatch(/^\.\/(?!.*\.\.)/);
    }
    // Issue #176: core のサブパスの行き先は packages/core/src の実在するファイルだけ(cloud/ の外へ出るのは、この4行だけ)
    const coreTargets = [...aliasBlock.matchAll(/^"@keiba\/core\/[^"]+" = "([^"]+)"/gm)].map((m) => m[1]!);
    expect(coreTargets).toHaveLength(CORE_SUBPATHS.length);
    for (const target of coreTargets) {
      expect(target, `行き先 ${target}`).toMatch(/^\.\.\/packages\/core\/src\/[a-z/-]+\.ts$/);
      expect(existsSync(path.join(ROOT, "cloud", target)), `実在 ${target}`).toBe(true);
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
    for (const entry of ["node_modules/", ".wrangler/", "dist-dry/", "wrangler.smoke.generated.toml", "wrangler.smoke-fake.generated.toml", "wrangler.bundle-guard.generated.toml", "native-probe.generated.ts", "wrangler.native-probe.generated.toml"]) {
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
      "cloud/src/d1-health.ts",
      "cloud/migrations/0001_init.sql",
      "cloud/migrations/0002_d1.sql",
      "cloud/migrations/0003_r2_ops.sql",
      "cloud/migrations/0004_settings.sql",
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
