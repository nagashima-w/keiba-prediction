/**
 * GitHub Actions の `uses:` が、コミット SHA でピン留めされ、版数のコメントを伴い、ワークフロー間で食い違わないことの静的検査
 * (Issue #305 で導入。Issue #310 で「期待表の固定」から「規則の検査」に変えた)。
 *
 * 背景: `actions/checkout@v4` のようなタグ固定は、タグの付け替えで中身が差し替わりうる(サプライチェーンのリスク)。
 * deploy ジョブは Cloudflare の API トークンを持つため、`uses:` を「コミットの SHA + 版数のコメント」に固定した(Issue #305)。
 * 固定した SHA は `git ls-remote https://github.com/<owner>/<repo>` の実出力から取った、ピン留めの時点で `v4` タグが指していたコミットである。
 *
 * Issue #310 で Dependabot(github-actions)を入れた。Dependabot は SHA でピン留めした行の SHA と、行末の版数コメントを
 * 同時に書き換えた PR を作る。以前の本テストは SHA と版数の**期待表を固定**していたので、その PR をそのままマージすると CI が赤くなった。
 * そこで、特定の SHA・版数ではなく**規則**を検査する:
 *  (a) 全 `uses:` が `owner/repo@<40 桁の小文字 16 進 SHA> # vX.Y.Z` の形(タグ・ブランチ・ローカル・docker の参照や、コメントの欠落・形式違いを検出)
 *  (b) 同じ action は、全ワークフローで同じ SHA・同じ版数(一部のファイルだけ更新された食い違いを検出)
 *  (c) 使ってよい action の名前の許可リスト(知らない action の混入を検出。追加するときは ALLOWED_ACTIONS を意図して直す)
 *  (d) ローカル action(`./x`)・Docker(`docker://x`)の参照は許さない(現状どちらも使っていない。(a) の SHA 形式で落ちる)
 *  (e) uses 行の数は固定(EXPECTED_COUNTS。行が検出器に読まれずに素通りする空振りを防ぐ)
 *
 * 限界: これは yml のテキストへの検査であり、SHA が実在するコミットか・そのコミットが版数のコメントのタグを指すかは
 * Actions 上で解決されるまで検証できない。**以前の期待表が持っていた「SHA の値そのものの固定」は無くなった**ので、
 * 全ファイルで揃って別の SHA に差し替わる変更(Dependabot の PR を含む)は本テストでは通る。Dependabot の PR を
 * マージする前に、差分(SHA と版数のコメント)をレビューで確かめる。
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

/** 使ってよい action の名前(許可リスト)。新しい action を使うときは、ここを意図して足す。 */
const ALLOWED_ACTIONS: readonly string[] = ["actions/checkout", "actions/setup-node", "pnpm/action-setup"];

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
const EXPECTED_COUNTS: Readonly<Record<string, number>> = { "audit.yml": 6, "ci.yml": 6, "deploy-cloud.yml": 9, "research.yml": 3 };

/**
 * 規則(a)〜(c)の違反を、人が読める文の配列で返す。違反が無ければ空配列。
 * 引数はファイル名 → yml 本文。実物の検査と、合成テキストでの「検出器が働く」確認の両方が、この関数を使う。
 */
function findViolations(ymls: Readonly<Record<string, string>>): string[] {
  const violations: string[] = [];
  // action 名 → 出現した (SHA, コメント) の組の集合(規則 (b) の食い違い検出に使う)
  const seen = new Map<string, Set<string>>();
  for (const [file, yml] of Object.entries(ymls)) {
    for (const u of extractUses(yml)) {
      if (!SHA40.test(u.ref)) {
        violations.push(`${file}: ${u.spec} は 40 桁の小文字 16 進 SHA で固定されていない`);
      }
      if (u.comment === null) {
        violations.push(`${file}: ${u.spec} に版数のコメントが無い`);
      } else if (!VERSION_COMMENT.test(u.comment)) {
        violations.push(`${file}: ${u.spec} のコメント「${u.comment}」が vX.Y.Z の形でない`);
      }
      if (!ALLOWED_ACTIONS.includes(u.action)) {
        violations.push(`${file}: ${u.action} は許可リスト(${ALLOWED_ACTIONS.join("・")})に無い`);
      }
      const set = seen.get(u.action) ?? new Set<string>();
      set.add(`${u.ref} # ${u.comment ?? "(コメント無し)"}`);
      seen.set(u.action, set);
    }
  }
  for (const [action, set] of seen) {
    if (set.size > 1) {
      violations.push(`${action} がワークフロー間で食い違っている: ${[...set].sort().join(" / ")}`);
    }
  }
  return violations;
}

const SHA_A = "11d5960a326750d5838078e36cf38b85af677262";
const SHA_B = "49933ea5288caeca8642d1e84afbd3f7d6820020";

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

  it("SHA の形の判定: タグ・39 桁・大文字は落ち、40 桁の小文字 16 進だけが通る", () => {
    expect(SHA40.test("v4")).toBe(false);
    expect(SHA40.test(SHA_A)).toBe(true);
    expect(SHA40.test(SHA_A.slice(1))).toBe(false); // 39 桁
    expect(SHA40.test(SHA_A.toUpperCase())).toBe(false); // 大文字
  });
});

describe("検出器の確認(空振りでない): findViolations は規則ごとに違反を検出し、規則に沿った入力では何も言わない", () => {
  const ok = `        uses: actions/checkout@${SHA_A} # v4.4.0`;

  it("正の対照: 規則に沿った入力(Dependabot が SHA と版数を同時に更新した状態を含む)は違反ゼロ", () => {
    expect(findViolations({ "a.yml": ok })).toEqual([]);
    // 版数・SHA が変わっても、全ファイルで揃っていれば通る(Dependabot の PR をそのままマージできる)
    const updated = `        uses: actions/checkout@${SHA_B} # v4.5.0`;
    expect(findViolations({ "a.yml": updated, "b.yml": updated })).toEqual([]);
  });

  it.each([
    ["(a) タグ固定", "        uses: actions/checkout@v4", "40 桁"],
    ["(a) ブランチ固定", "        uses: actions/checkout@main", "40 桁"],
    ["(a) 39 桁の SHA", `        uses: actions/checkout@${SHA_A.slice(1)} # v4.4.0`, "40 桁"],
    ["(a) 大文字の SHA", `        uses: actions/checkout@${SHA_A.toUpperCase()} # v4.4.0`, "40 桁"],
    ["(a) 版数のコメントの欠落", `        uses: actions/checkout@${SHA_A}`, "コメントが無い"],
    ["(a) コメントが vX.Y.Z でない(メジャーだけ)", `        uses: actions/checkout@${SHA_A} # v4`, "vX.Y.Z の形でない"],
    ["(a) コメントが vX.Y.Z でない(v なし)", `        uses: actions/checkout@${SHA_A} # 4.4.0`, "vX.Y.Z の形でない"],
    ["(c) 許可リストに無い action", `        uses: evil/steal@${SHA_A} # v1.0.0`, "許可リスト"],
    ["(d) ローカル action", "        uses: ./local-action", "40 桁"],
    ["(d) Docker の参照", "        uses: docker://alpine:3.19", "40 桁"],
  ])("%s を検出する", (_name, line, expected) => {
    const v = findViolations({ "a.yml": line });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join("\n")).toContain(expected);
  });

  it("(b) 同じ action の SHA が食い違えば検出する(一部のファイルだけ更新された状態)", () => {
    const v = findViolations({ "a.yml": ok, "b.yml": `        uses: actions/checkout@${SHA_B} # v4.4.0` });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("食い違っている");
  });

  it("(b) SHA が同じでも版数のコメントが食い違えば検出する", () => {
    const v = findViolations({ "a.yml": ok, "b.yml": `        uses: actions/checkout@${SHA_A} # v4.5.0` });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("食い違っている");
  });

  it("(b) 別の action どうしは、SHA や版数が違っても食い違いと数えない", () => {
    const v = findViolations({ "a.yml": ok, "b.yml": `        uses: actions/setup-node@${SHA_B} # v4.5.0` });
    expect(v).toEqual([]);
  });
});

describe("Issue #305・#310: すべてのワークフローの uses: が、SHA 固定・版数のコメント付き・ワークフロー間で一致・許可リスト内である", () => {
  const ymls: Record<string, string> = {};
  for (const f of files) ymls[f] = readTextLf(path.join(WORKFLOWS_DIR, f));

  it("前提: 検査対象のワークフローは audit.yml・ci.yml・deploy-cloud.yml・research.yml の 4 つで、uses 行の数は期待どおり(空振りでない。合計 24 行)", () => {
    expect(files).toEqual(["audit.yml", "ci.yml", "deploy-cloud.yml", "research.yml"]);
    const counts: Record<string, number> = {};
    for (const f of files) {
      counts[f] = extractUses(ymls[f]!).length;
    }
    expect(counts).toEqual(EXPECTED_COUNTS);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(24);
  });

  it("規則 (a)〜(d) の違反が 1 件も無い(全ワークフローの全 uses 行)", () => {
    expect(findViolations(ymls)).toEqual([]);
  });

  it("4 つのワークフローを通して、action ごとの使用箇所は checkout 8・setup-node 8・pnpm/action-setup 8(合計 24。許可リストの 3 つすべてが使われている)", () => {
    const counts: Record<string, number> = {};
    for (const f of files) {
      for (const u of extractUses(ymls[f]!)) {
        counts[u.action] = (counts[u.action] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({ "actions/checkout": 8, "actions/setup-node": 8, "pnpm/action-setup": 8 });
    expect(Object.keys(counts).sort()).toEqual([...ALLOWED_ACTIONS].sort());
  });
});
