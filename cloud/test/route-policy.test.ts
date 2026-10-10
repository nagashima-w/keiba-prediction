import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_PATHS } from "../src/icons";
import { ANALYSIS_DETAIL_PATTERN, REPORTS_PREFIX, requiredRole, ROUTE_RULES } from "../src/route-policy";

/**
 * Issue #238: ルート × 役割の表(route-policy.ts)の固定。
 *  - 表そのものを**テスト側にも手書きで持ち**(`EXPECTED`)、実装の表と突き合わせる。実装の表を参照して期待値を作ると、表を間違えたときに両方が一緒に間違う。
 *  - 表に無い(path, method)は管理者専用に倒れる(fail-closed)。新しいルートの足し忘れは、閲覧者に開く方向へは倒れない。
 *  - 静的ガード: handler.ts のルーティング(`pathname` の比較)を走査し、表に無いルートが増えたら落とす。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

interface Expected {
  /** 表の名前(パターンのルートは `{id}`・`{date}` つき)。 */
  readonly name: string;
  /** 実際に送る path の例。 */
  readonly sample: string;
  /** 閲覧者に許す method。ここに無い method は管理者専用。 */
  readonly viewer: readonly string[];
}

/** ルート × 役割の最終表(手書き)。閲覧者に許すのは GET(と、画面の `/`・`/app.js`・アイコン 7 本〈Issue #244〉の HEAD)だけ。 */
const EXPECTED: readonly Expected[] = [
  // ---- 閲覧者にも許す(16。画面と API が 9、アイコン〈Issue #244〉が 7) ----
  { name: "/", sample: "/", viewer: ["GET", "HEAD"] },
  { name: "/app.js", sample: "/app.js", viewer: ["GET", "HEAD"] },
  { name: "/api/races", sample: "/api/races", viewer: ["GET"] },
  { name: "/api/plan", sample: "/api/plan", viewer: ["GET"] },
  { name: "/api/analyses", sample: "/api/analyses", viewer: ["GET"] },
  { name: "/api/analyses/status", sample: "/api/analyses/status", viewer: ["GET"] },
  { name: "/api/analyses/{id}", sample: "/api/analyses/123", viewer: ["GET"] },
  { name: "/api/reports", sample: "/api/reports", viewer: ["GET"] },
  { name: "/api/reports/{date}", sample: "/api/reports/20261010", viewer: ["GET"] },
  // アイコン(Issue #244。タブの favicon・見出しの画像・apple-touch-icon。読み取りだけの静的な画像なので、閲覧者にも開く)
  { name: "/favicon.ico", sample: "/favicon.ico", viewer: ["GET", "HEAD"] },
  { name: "/apple-touch-icon.png", sample: "/apple-touch-icon.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/favicon-16.png", sample: "/icons/favicon-16.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/favicon-32.png", sample: "/icons/favicon-32.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/header-32.png", sample: "/icons/header-32.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/header-64.png", sample: "/icons/header-64.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/header-96.png", sample: "/icons/header-96.png", viewer: ["GET", "HEAD"] },
  // ---- 管理者だけ(11)。method を問わず ----
  { name: "/check", sample: "/check", viewer: [] },
  { name: "/api/health", sample: "/api/health", viewer: [] },
  { name: "/api/netkeiba/check", sample: "/api/netkeiba/check", viewer: [] },
  { name: "/api/settings", sample: "/api/settings", viewer: [] },
  { name: "/api/analyses/run", sample: "/api/analyses/run", viewer: [] },
  { name: "/api/results/import", sample: "/api/results/import", viewer: [] },
  { name: "/api/results/backfill", sample: "/api/results/backfill", viewer: [] },
  { name: "/api/migration", sample: "/api/migration", viewer: [] },
  { name: "/api/migration/upload", sample: "/api/migration/upload", viewer: [] },
  { name: "/api/reports/run", sample: "/api/reports/run", viewer: [] },
  { name: "/api/verify", sample: "/api/verify", viewer: [] },
];

describe("ルート × 役割の表(手書きの期待値と、実装の requiredRole を全 method で突き合わせる)", () => {
  it("前提: 表は 27 ルート(閲覧者に開くもの 16・管理者だけ 11)で、閲覧者に開く method の組は 25 通り(GET が 16・HEAD が 9)", () => {
    expect(EXPECTED).toHaveLength(27);
    expect(EXPECTED.filter((e) => e.viewer.length > 0)).toHaveLength(16);
    expect(EXPECTED.filter((e) => e.viewer.length === 0)).toHaveLength(11);
    expect(EXPECTED.reduce((n, e) => n + e.viewer.length, 0)).toBe(25);
    expect(EXPECTED.filter((e) => e.viewer.includes("GET"))).toHaveLength(16);
    expect(EXPECTED.filter((e) => e.viewer.includes("HEAD"))).toHaveLength(9);
    expect(ROUTE_RULES).toHaveLength(EXPECTED.length);
    expect(ROUTE_RULES.map((r) => r.path).sort()).toEqual(EXPECTED.map((e) => e.name).sort());
  });

  const cases = EXPECTED.flatMap((e) => METHODS.map((method) => [e.name, method, e.sample, e.viewer.includes(method) ? "viewer" : "admin"] as const));
  it.each(cases)("%s の %s(%s)は %s で足りる", (_name, method, sample, expected) => {
    expect(requiredRole(method, sample)).toBe(expected);
  });

  it("method の組み合わせの数: 27 ルート × 7 method = 189 通りのうち、閲覧者でよいのは 25 通りだけ", () => {
    expect(cases).toHaveLength(189);
    expect(cases.filter((c) => c[3] === "viewer")).toHaveLength(25);
    expect(cases.filter((c) => c[3] === "admin")).toHaveLength(164);
  });

  it("リクエストの method が小文字などの未知の表記でも、閲覧者に開かない(完全一致の大文字だけを認める)", () => {
    expect(requiredRole("GET", "/api/plan")).toBe("viewer"); // 前提
    for (const method of ["get", "Get", "", "GET ", "TRACE", "CONNECT"]) {
      expect(requiredRole(method, "/api/plan")).toBe("admin");
    }
  });
});

describe("表に無い path は管理者専用(fail-closed。新しいルートの足し忘れが閲覧者に開く方向へ倒れない)", () => {
  // 前提: 同じ表の中に viewer になる path がある(下の表がすべて admin になる退化を防ぐ)
  it("前提: 既知の viewer の path は viewer", () => {
    expect(requiredRole("GET", "/api/analyses/1")).toBe("viewer");
    for (const iconPath of ICON_PATHS) expect(requiredRole("GET", iconPath), iconPath).toBe("viewer"); // アイコン 7 本(Issue #246: 下の /icons/x の行が、これらの完全一致だけを開けていることを確かめる前提)
    expect(requiredRole("GET", "/api/reports/20261010")).toBe("viewer");
  });

  it.each([
    ["未知の path", "/no-such-path"],
    ["/api だけ", "/api"],
    ["/api/", "/api/"],
    ["viewer の path の末尾にスラッシュ", "/api/plan/"],
    ["viewer の path の大文字", "/API/PLAN"],
    ["/app.js の大文字", "/App.js"],
    ["/app.js の下位", "/app.js/x"],
    ["先頭のスラッシュが 2 つ", "//api/plan"],
    ["admin の path の末尾にスラッシュ", "/api/settings/"],
    ["/api/races の下位", "/api/races/x"],
    ["{id} の位置が空", "/api/analyses/"],
    ["{id} の下位(2 階層)", "/api/analyses/1/2"],
    ["/api/health の下位", "/api/health/x"],
    ["空の path", ""],
    // Issue #246(#244 の【記録】): アイコンは完全一致の 7 本だけを開ける。/icons/ 配下を前方一致に広げても、ここで落ちる
    ["/icons/ の下の未知のパス", "/icons/x"],
    ["/icons/ の下の未知の PNG", "/icons/x.png"],
    ["未知の大きさのアイコン", "/icons/header-33.png"],
    ["アイコンの path の末尾にスラッシュ", "/icons/favicon-32.png/"],
    ["/icons/ の下位(2 階層)", "/icons/sub/header-32.png"],
    ["/icons/ だけ", "/icons/"],
    ["/index.html", "/index.html"],
    ["クエリ文字列を含む形(pathname には入らない)", "/api/plan?x=1"],
  ])("%s(%s)は、どの method でも admin", (_name, pathname) => {
    for (const method of METHODS) {
      expect(requiredRole(method, pathname), `${method} ${pathname}`).toBe("admin");
    }
  });

  // パターンに当たる path は、パターンの定義どおりに振り分ける(ハンドラ側も同じパターンで振り分ける)
  it("{id}・{date} のパターンは、ハンドラと同じ規則: 1 階層下の 1 つの区切りなしの文字列(run だけは管理者専用)", () => {
    expect(requiredRole("GET", "/api/analyses/1%2F2")).toBe("viewer"); // pathname はデコードされない。1 つの区切りなしの文字列
    expect(requiredRole("GET", "/api/analyses/run")).toBe("admin"); // 前提: run は {id} に化けない
    expect(requiredRole("GET", "/api/analyses/run/")).toBe("admin"); // 末尾のスラッシュ: 2 つの区切り → {id} に当たらない
    expect(requiredRole("GET", "/api/reports/run")).toBe("admin"); // run は {date} に化けない
    expect(requiredRole("GET", "/api/reports/run/x")).toBe("viewer"); // ハンドラの startsWith("/api/reports/") と同じ規則で、日付の検証が 400 を返す読み取り専用の経路
    expect(requiredRole("GET", "/api/reports/")).toBe("viewer"); // 同上(空の日付は 400)
  });
});

describe("handler.ts の静的ガード(ルーティングの構文を走査する。表に無いルートが増えたら落ちる)", () => {
  // コメントを除く(`//` の直前が `:` のとき〈URL〉は除かない)
  const raw = readFileSync(path.join(CLOUD, "src", "handler.ts"), "utf-8").replace(/\r\n/g, "\n");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const handleStart = code.indexOf("export async function handle(");
  const handleBody = code.slice(handleStart, code.indexOf("\n}\n", handleStart));

  it("前提: handler.ts を読めていて、handle() の本体を取り出せている", () => {
    expect(code.length).toBeGreaterThan(10_000);
    expect(handleStart).toBeGreaterThan(-1);
    expect(handleBody.length).toBeGreaterThan(2_000);
  });

  it("pathname と完全一致で比べている path は 18 個。これにアイコン 7 本(ICON_PATHS。handler は iconAsset(pathname) で振り分ける)を足すと、表の完全一致のルート(25)と過不足なく一致する", () => {
    const literals = [...new Set([...code.matchAll(/\bpathname === "([^"]+)"/g)].map((m) => m[1]!))].sort();
    const exactRules = ROUTE_RULES.filter((r) => r.exact).map((r) => r.path).sort();
    expect(literals).toHaveLength(18);
    expect(ICON_PATHS).toHaveLength(7);
    expect(exactRules).toHaveLength(25);
    expect([...literals, ...ICON_PATHS].sort()).toEqual(exactRules);
    // アイコンの path が handler.ts に直書きされていない(表と共有する定数だけで振り分ける)
    for (const iconPath of ICON_PATHS) {
      expect(code, iconPath).not.toContain(iconPath);
    }
    expect(code).toContain("iconAsset(pathname)");
  });

  it("パターンのルート 2 つ({id}・{date})は、表と共有する定数(ANALYSIS_DETAIL_PATTERN・REPORTS_PREFIX)で振り分けている(正規表現・接頭辞のリテラルを直書きしない)", () => {
    expect(code).toContain("ANALYSIS_DETAIL_PATTERN.exec(pathname)");
    expect(code).toContain("pathname.startsWith(REPORTS_PREFIX)");
    expect(code).toContain("pathname.slice(REPORTS_PREFIX.length)");
    expect(code).not.toMatch(/startsWith\("/); // 直書きの接頭辞
    expect(code).not.toMatch(/\\\/api\\\//); // 直書きの正規表現(`\/api\/`)
    expect(ROUTE_RULES.filter((r) => !r.exact)).toHaveLength(2);
    // 共有する定数の中身(表の期待値と同じ規則)
    expect(ANALYSIS_DETAIL_PATTERN.exec("/api/analyses/123")?.[1]).toBe("123");
    expect(ANALYSIS_DETAIL_PATTERN.exec("/api/analyses/1/2")).toBeNull();
    expect(REPORTS_PREFIX).toBe("/api/reports/");
  });

  it("pathname を使う式は、上の形(完全一致・共有定数・分割代入)だけ。switch・endsWith・includes・正規表現の直接の比較などの新しい形が増えたら落ちる", () => {
    const leftover = code
      .replace(/const \{ pathname \} = new URL\(request\.url\);/g, "")
      .replace(/(?:new URL\(request\.url\)\.)?pathname === "[^"]+"/g, "")
      .replace(/pathname\.startsWith\(REPORTS_PREFIX\)/g, "")
      .replace(/pathname\.slice\(REPORTS_PREFIX\.length\)/g, "")
      .replace(/ANALYSIS_DETAIL_PATTERN\.exec\(pathname\)/g, "")
      .replace(/iconAsset\(pathname\)/g, "")
      .replace(/requiredRole\(method, pathname\)/g, "");
    const rest = [...leftover.matchAll(/.*\bpathname\b.*/g)].map((m) => m[0].trim());
    expect(rest).toEqual([]);
    // 対照(検出が空振りでない): 新しい形を足した本文では、残りが検出される
    const probe = `${code}\n  if (pathname.endsWith(".json")) {}\n`
      .replace(/(?:new URL\(request\.url\)\.)?pathname === "[^"]+"/g, "");
    expect([...probe.matchAll(/.*\bpathname\b.*/g)].some((m) => m[0].includes("endsWith"))).toBe(true);
  });

  it("役割の判定(requiredRole)は handle() の中で 1 回だけ呼ばれ、どのハンドラ・描画・バインディングの利用よりも前にある", () => {
    expect((code.match(/\brequiredRole\(/g) ?? []).length).toBe(1);
    const gate = handleBody.indexOf("requiredRole(");
    expect(gate).toBeGreaterThan(-1);
    const firstUse = [/\bhandle[A-Z]\w*\(/, /\brender(Check)?Page\(/, /\bCLIENT_JS\b/, /\benv\.(?!ACCESS_)\w+/, /\bconst \w+ = \w+Stub\(/]
      .map((pattern) => handleBody.search(pattern))
      .filter((i) => i >= 0);
    expect(firstUse.length).toBeGreaterThan(0);
    for (const index of firstUse) {
      expect(gate, "役割の判定より前に裏側を使う式がある").toBeLessThan(index);
    }
  });
});
