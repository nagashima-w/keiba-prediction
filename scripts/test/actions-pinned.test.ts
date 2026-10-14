/**
 * GitHub Actions の `uses:` がコミット SHA でピン留めされていることの静的検査(Issue #305)。
 *
 * 背景: `actions/checkout@v4` のようなタグ固定は、タグの付け替えで中身が差し替わりうる(サプライチェーンのリスク)。
 * deploy ジョブは Cloudflare の API トークンを持つため、`uses:` を「タグが指すコミットの SHA + 版数のコメント」に固定した。
 * SHA は `git ls-remote https://github.com/<owner>/<repo>` の実出力から取った(注釈付きタグは `^{}` の剥がした先のコミット)。
 *
 * 固定した版は、ピン留めの時点で `v4` タグが実際に指していたコミットである(CI が動かすコードを変えない)。
 *  - actions/checkout: `v4` = `v4.4.0`(軽量タグ)
 *  - actions/setup-node: `v4` = `v4.4.0`(軽量タグ)
 *  - pnpm/action-setup: `v4`(注釈付きタグ)が剥がした先は **`v4.3.0` のコミット**。最新の `v4.4.0` は別のコミット(`fc06bc12…`)で、`v4` タグはそこへ動いていない。
 *    したがってコメントは `# v4.3.0` と書く。
 *
 * 限界: これは yml のテキストへの検査であり、SHA が実在するコミットか・そのタグが指すかは Actions 上で解決されるまで検証できない
 * (SHA の出典は上記の `git ls-remote` の出力)。
 *
 * 版を上げるときは、下の PINS・ワークフロー・ここの JSDoc を揃えて直す。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS_DIR = path.join(ROOT, ".github", "workflows");

/** 改行を LF に正規化して読む(checkout 次第で CRLF になりうる)。 */
function readTextLf(filePath: string): string {
  return readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
}

/** ピン留めの期待表: action 名 → コミット SHA と、コメントに書く版数。 */
const PINS: Readonly<Record<string, { readonly sha: string; readonly version: string }>> = {
  "actions/checkout": { sha: "11d5960a326750d5838078e36cf38b85af677262", version: "v4.4.0" },
  "actions/setup-node": { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4.4.0" },
  "pnpm/action-setup": { sha: "b906affcce14559ad1aafd4ab0e942779e9f58b1", version: "v4.3.0" },
};

interface UsesLine {
  /** `uses:` の値の全体(`@` 以降を含む。行末のコメントは含まない)。 */
  readonly spec: string;
  /** `@` の前(action 名)。`@` が無ければ spec 全体。 */
  readonly action: string;
  /** `@` の後(ref)。`@` が無ければ空文字。 */
  readonly ref: string;
  /** 行末のコメント(`#` の後。前後の空白は除く)。無ければ null。 */
  readonly comment: string | null;
}

/** コメント行を除いた本文から、`uses:` 行を出現順に全数抽出する。 */
function extractUses(yml: string): UsesLine[] {
  const result: UsesLine[] = [];
  for (const line of yml.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*(?:- )?uses:\s*(\S+)(?:\s+#\s*(.*?))?\s*$/.exec(line);
    if (m === null) continue;
    const spec = m[1]!;
    const at = spec.indexOf("@");
    result.push({
      spec,
      action: at < 0 ? spec : spec.slice(0, at),
      ref: at < 0 ? "" : spec.slice(at + 1),
      comment: m[2] === undefined ? null : m[2],
    });
  }
  return result;
}

const SHA40 = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;

const files = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort();

/** ワークフローごとの uses 行の数(`grep -c "^\s*uses:" .github/workflows/<file>` で再現できる)。 */
const EXPECTED_COUNTS: Readonly<Record<string, number>> = { "ci.yml": 3, "deploy-cloud.yml": 9 };

describe("検出器の確認(空振りでない): extractUses が uses 行を正しく読む", () => {
  it("タグ固定・SHA 固定・コメント付き・コメント行・ローカル action を区別して読む", () => {
    const text = [
      "      - name: a",
      "        uses: actions/checkout@v4",
      "      - name: b",
      "        uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567 # v4.4.0",
      "      # uses: actions/ignored@v1",
      "      - uses: ./local-action",
    ].join("\n");
    expect(extractUses(text)).toEqual([
      { spec: "actions/checkout@v4", action: "actions/checkout", ref: "v4", comment: null },
      { spec: "actions/setup-node@0123456789abcdef0123456789abcdef01234567", action: "actions/setup-node", ref: "0123456789abcdef0123456789abcdef01234567", comment: "v4.4.0" },
      { spec: "./local-action", action: "./local-action", ref: "", comment: null },
    ]);
  });

  it("タグ固定の行は SHA の判定で落ちる(この検査がタグ固定を検出できる)", () => {
    expect(SHA40.test("v4")).toBe(false);
    expect(SHA40.test("11d5960a326750d5838078e36cf38b85af677262")).toBe(true);
    expect(SHA40.test("11d5960a326750d5838078e36cf38b85af67726")).toBe(false); // 39 桁
    expect(SHA40.test("11D5960A326750D5838078E36CF38B85AF677262")).toBe(false); // 大文字
  });
});

describe("Issue #305: すべてのワークフローの uses: がコミット SHA でピン留めされている", () => {
  it("前提: 検査対象のワークフローは ci.yml と deploy-cloud.yml の 2 つで、uses 行の数は期待どおり(空振りでない。合計 12 行)", () => {
    expect(files).toEqual(["ci.yml", "deploy-cloud.yml"]);
    const counts: Record<string, number> = {};
    for (const f of files) {
      counts[f] = extractUses(readTextLf(path.join(WORKFLOWS_DIR, f))).length;
    }
    expect(counts).toEqual(EXPECTED_COUNTS);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it.each(files)("%s: すべての uses が `<action>@<40 桁の小文字 16 進 SHA> # vX.Y.Z` の形で、タグ・ブランチ・ローカル・docker の参照が無い", (file) => {
    const uses = extractUses(readTextLf(path.join(WORKFLOWS_DIR, file)));
    // 前提を無条件で固定してから、全件を検査する(0 件のままの自明な成立にしない)
    expect(uses.length).toBe(EXPECTED_COUNTS[file]);
    for (const u of uses) {
      expect(u.ref, `${file}: ${u.spec} の ref は 40 桁の SHA`).toMatch(SHA40);
      expect(u.comment, `${file}: ${u.spec} に版数のコメントがある`).not.toBeNull();
      expect(u.comment!, `${file}: ${u.spec} のコメントは vX.Y.Z`).toMatch(VERSION_COMMENT);
    }
  });

  it.each(files)("%s: 使う action は期待表(checkout・setup-node・pnpm/action-setup)のものだけで、SHA とコメントの版数が表と完全一致する", (file) => {
    const uses = extractUses(readTextLf(path.join(WORKFLOWS_DIR, file)));
    expect(uses.length).toBe(EXPECTED_COUNTS[file]);
    for (const u of uses) {
      const pin = PINS[u.action];
      expect(pin, `${file}: ${u.action} は期待表にある`).toBeDefined();
      expect(u.ref, `${file}: ${u.action} の SHA`).toBe(pin!.sha);
      expect(u.comment, `${file}: ${u.action} のコメント`).toBe(pin!.version);
    }
  });

  it("2 つのワークフローを通して、action ごとの使用箇所は checkout 4・setup-node 4・pnpm/action-setup 4(合計 12)", () => {
    const counts: Record<string, number> = {};
    for (const f of files) {
      for (const u of extractUses(readTextLf(path.join(WORKFLOWS_DIR, f)))) {
        counts[u.action] = (counts[u.action] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({ "actions/checkout": 4, "actions/setup-node": 4, "pnpm/action-setup": 4 });
  });
});
