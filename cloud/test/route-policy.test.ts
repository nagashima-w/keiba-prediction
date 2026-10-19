import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_PATHS } from "../src/icons";
import { ANALYSIS_DETAIL_PATTERN, MONTHLY_REPORTS_PREFIX, REPORTS_PREFIX, requiredRole, ROUTE_RULES } from "../src/route-policy";

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
  // ---- 閲覧者にも許す(20。画面と API が 13、アイコン〈Issue #244〉が 7) ----
  { name: "/", sample: "/", viewer: ["GET", "HEAD"] },
  { name: "/app.js", sample: "/app.js", viewer: ["GET", "HEAD"] },
  { name: "/api/races", sample: "/api/races", viewer: ["GET"] },
  { name: "/api/plan", sample: "/api/plan", viewer: ["GET"] },
  // 今日の狙い目(Issue #336)。D1 の集計と DO の計画の読み取りだけ(R2・netkeiba・LLM に触れない)。配分の提案は GET /api/analyses/{id} で閲覧者にもすでに見える
  { name: "/api/targets", sample: "/api/targets", viewer: ["GET"] },
  { name: "/api/analyses", sample: "/api/analyses", viewer: ["GET"] },
  { name: "/api/analyses/status", sample: "/api/analyses/status", viewer: ["GET"] },
  { name: "/api/analyses/{id}", sample: "/api/analyses/123", viewer: ["GET"] },
  { name: "/api/reports", sample: "/api/reports", viewer: ["GET"] },
  { name: "/api/reports/{date}", sample: "/api/reports/20261010", viewer: ["GET"] },
  // 月報(Issue #265・#279)。日報と同じく読み取り専用(D1 の monthly_reports を読むだけ)で、閲覧者にも見せる(ユーザーの決定)
  { name: "/api/monthly-reports", sample: "/api/monthly-reports", viewer: ["GET"] },
  { name: "/api/monthly-reports/{month}", sample: "/api/monthly-reports/202610", viewer: ["GET"] },
  // 検証(Issue #263)。閲覧者の GET は**集計のやり直しを起こさない**(キャッシュを返すだけ。handler.ts・verify-core.ts)。`refresh` は管理者だけが受け付ける
  { name: "/api/verify", sample: "/api/verify", viewer: ["GET"] },
  // アイコン(Issue #244。タブの favicon・見出しの画像・apple-touch-icon。読み取りだけの静的な画像なので、閲覧者にも開く)
  { name: "/favicon.ico", sample: "/favicon.ico", viewer: ["GET", "HEAD"] },
  { name: "/apple-touch-icon.png", sample: "/apple-touch-icon.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/favicon-16.png", sample: "/icons/favicon-16.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/favicon-32.png", sample: "/icons/favicon-32.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/header-32.png", sample: "/icons/header-32.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/header-64.png", sample: "/icons/header-64.png", viewer: ["GET", "HEAD"] },
  { name: "/icons/header-96.png", sample: "/icons/header-96.png", viewer: ["GET", "HEAD"] },
  // ---- 管理者だけ(14)。method を問わず ----
  { name: "/check", sample: "/check", viewer: [] },
  { name: "/api/health", sample: "/api/health", viewer: [] },
  { name: "/api/netkeiba/check", sample: "/api/netkeiba/check", viewer: [] },
  { name: "/api/settings", sample: "/api/settings", viewer: [] },
  { name: "/api/settings/prompt-preview", sample: "/api/settings/prompt-preview", viewer: [] }, // Issue #396: 設定画面のプロンプトのプレビュー(サーバが組み立てる。設定の画面と同じく管理者だけ)
  { name: "/api/analyses/run", sample: "/api/analyses/run", viewer: [] },
  { name: "/api/analyses/run/bulk", sample: "/api/analyses/run/bulk", viewer: [] }, // Issue #251: 一括実行(LLM を呼ぶ)
  { name: "/api/results/import", sample: "/api/results/import", viewer: [] },
  { name: "/api/results/backfill", sample: "/api/results/backfill", viewer: [] },
  { name: "/api/reports/run", sample: "/api/reports/run", viewer: [] },
  { name: "/api/monthly-reports/run", sample: "/api/monthly-reports/run", viewer: [] }, // Issue #280: 月報の手動の作成と作り直し(LLM を呼ぶ)
  { name: "/api/export/prior-dataset", sample: "/api/export/prior-dataset", viewer: [] }, // Issue #266
  { name: "/api/horse-runs", sample: "/api/horse-runs", viewer: [] }, // Issue #256 段階A: 各馬の戦績の蓄積の診断(D1 の全件に近い走査を起こしうる)
  { name: "/api/baba-fetch", sample: "/api/baba-fetch", viewer: [] }, // Issue #360: 外部の馬場の API の取得の結果の診断(利用の記録なので管理者だけ)
];

describe("ルート × 役割の表(手書きの期待値と、実装の requiredRole を全 method で突き合わせる)", () => {
  it("前提: 表は 34 ルート(閲覧者に開くもの 20・管理者だけ 14)で、閲覧者に開く method の組は 29 通り(GET が 20・HEAD が 9)", () => {
    expect(EXPECTED).toHaveLength(34);
    expect(EXPECTED.filter((e) => e.viewer.length > 0)).toHaveLength(20);
    expect(EXPECTED.filter((e) => e.viewer.length === 0)).toHaveLength(14);
    expect(EXPECTED.reduce((n, e) => n + e.viewer.length, 0)).toBe(29);
    expect(EXPECTED.filter((e) => e.viewer.includes("GET"))).toHaveLength(20);
    expect(EXPECTED.filter((e) => e.viewer.includes("HEAD"))).toHaveLength(9);
    expect(ROUTE_RULES).toHaveLength(EXPECTED.length);
    expect(ROUTE_RULES.map((r) => r.path).sort()).toEqual(EXPECTED.map((e) => e.name).sort());
  });

  const cases = EXPECTED.flatMap((e) => METHODS.map((method) => [e.name, method, e.sample, e.viewer.includes(method) ? "viewer" : "admin"] as const));
  it.each(cases)("%s の %s(%s)は %s で足りる", (_name, method, sample, expected) => {
    expect(requiredRole(method, sample)).toBe(expected);
  });

  it("method の組み合わせの数: 34 ルート × 7 method = 238 通りのうち、閲覧者でよいのは 29 通りだけ", () => {
    expect(cases).toHaveLength(238);
    expect(cases.filter((c) => c[3] === "viewer")).toHaveLength(29);
    expect(cases.filter((c) => c[3] === "admin")).toHaveLength(209);
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
    expect(requiredRole("GET", "/api/verify")).toBe("viewer"); // Issue #263
    expect(requiredRole("GET", "/api/targets")).toBe("viewer"); // Issue #336
    expect(requiredRole("GET", "/api/monthly-reports/202610")).toBe("viewer"); // Issue #279
  });

  it.each([
    ["未知の path", "/no-such-path"],
    ["/api だけ", "/api"],
    ["/api/", "/api/"],
    ["viewer の path の末尾にスラッシュ", "/api/plan/"],
    ["/api/targets の末尾にスラッシュ", "/api/targets/"], // Issue #336
    ["/api/targets の下位", "/api/targets/x"],
    ["viewer の path の大文字", "/API/PLAN"],
    ["/app.js の大文字", "/App.js"],
    ["/app.js の下位", "/app.js/x"],
    ["先頭のスラッシュが 2 つ", "//api/plan"],
    ["admin の path の末尾にスラッシュ", "/api/settings/"],
    ["プレビューの path の末尾にスラッシュ", "/api/settings/prompt-preview/"], // Issue #396
    ["プレビューの path の下位", "/api/settings/prompt-preview/x"],
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
    // Issue #251: 一括実行は run の下の階層(`run/bulk`)。{id} は 1 つの区切りなしの文字列だけなので当たらない。同じ階層の名前(`run-bulk`・`bulk`)にすると {id} に化けて、閲覧者に GET が開く
    expect(requiredRole("GET", "/api/analyses/run/bulk")).toBe("admin");
    expect(requiredRole("POST", "/api/analyses/run/bulk")).toBe("admin");
    expect(ANALYSIS_DETAIL_PATTERN.test("/api/analyses/run/bulk")).toBe(false); // 前提: {id} のパターンには当たらない(表の完全一致の行が管理者専用に倒している)
    expect(ROUTE_RULES.find((r) => r.matches("/api/analyses/run/bulk"))?.path).toBe("/api/analyses/run/bulk"); // 完全一致の行が先に当たる
    expect(requiredRole("GET", "/api/analyses/run-bulk")).toBe("viewer"); // 対照: 同じ階層の名前は {id} に当たる(この名前を使わない理由)
    expect(requiredRole("GET", "/api/reports/run")).toBe("admin"); // run は {date} に化けない
    expect(requiredRole("GET", "/api/reports/run/x")).toBe("viewer"); // ハンドラの startsWith("/api/reports/") と同じ規則で、日付の検証が 400 を返す読み取り専用の経路
    expect(requiredRole("GET", "/api/reports/")).toBe("viewer"); // 同上(空の日付は 400)
    // 月報(Issue #279・#280): 日報と同じ規則。`run` は {month} に化けない(POST /api/monthly-reports/run は表の完全一致の行で管理者専用)
    expect(ROUTE_RULES.find((r) => r.matches("/api/monthly-reports/run"))?.path).toBe("/api/monthly-reports/run"); // 完全一致の行が先に当たる(パターンの {month} ではない)
    expect(requiredRole("GET", "/api/monthly-reports/run")).toBe("admin");
    expect(requiredRole("POST", "/api/monthly-reports/run")).toBe("admin");
    expect(requiredRole("POST", "/api/monthly-reports")).toBe("admin"); // 読み取り専用: POST は管理者専用
    expect(requiredRole("POST", "/api/monthly-reports/202610")).toBe("admin");
    expect(requiredRole("GET", "/api/monthly-reports/run/x")).toBe("viewer"); // ハンドラの startsWith と同じ規則で、月の検証が 404 を返す読み取り専用の経路
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

  it("pathname と完全一致で比べている path は 24 個。これにアイコン 7 本(ICON_PATHS。handler は iconAsset(pathname) で振り分ける)を足すと、表の完全一致のルート(31)と過不足なく一致する", () => {
    const literals = [...new Set([...code.matchAll(/\bpathname === "([^"]+)"/g)].map((m) => m[1]!))].sort();
    const exactRules = ROUTE_RULES.filter((r) => r.exact).map((r) => r.path).sort();
    expect(literals).toHaveLength(24);
    expect(ICON_PATHS).toHaveLength(7);
    expect(exactRules).toHaveLength(31);
    expect([...literals, ...ICON_PATHS].sort()).toEqual(exactRules);
    // アイコンの path が handler.ts に直書きされていない(表と共有する定数だけで振り分ける)
    for (const iconPath of ICON_PATHS) {
      expect(code, iconPath).not.toContain(iconPath);
    }
    expect(code).toContain("iconAsset(pathname)");
  });

  it("パターンのルート 3 つ({id}・{date}・{month})は、表と共有する定数(ANALYSIS_DETAIL_PATTERN・REPORTS_PREFIX・MONTHLY_REPORTS_PREFIX)で振り分けている(正規表現・接頭辞のリテラルを直書きしない)", () => {
    expect(code).toContain("ANALYSIS_DETAIL_PATTERN.exec(pathname)");
    expect(code).toContain("pathname.startsWith(REPORTS_PREFIX)");
    expect(code).toContain("pathname.slice(REPORTS_PREFIX.length)");
    expect(code).toContain("pathname.startsWith(MONTHLY_REPORTS_PREFIX)");
    expect(code).toContain("pathname.slice(MONTHLY_REPORTS_PREFIX.length)");
    expect(code).not.toMatch(/startsWith\("/); // 直書きの接頭辞
    expect(code).not.toMatch(/\\\/api\\\//); // 直書きの正規表現(`\/api\/`)
    expect(ROUTE_RULES.filter((r) => !r.exact)).toHaveLength(3);
    // 共有する定数の中身(表の期待値と同じ規則)
    expect(ANALYSIS_DETAIL_PATTERN.exec("/api/analyses/123")?.[1]).toBe("123");
    expect(ANALYSIS_DETAIL_PATTERN.exec("/api/analyses/1/2")).toBeNull();
    expect(REPORTS_PREFIX).toBe("/api/reports/");
    expect(MONTHLY_REPORTS_PREFIX).toBe("/api/monthly-reports/");
  });

  it("pathname を使う式は、上の形(完全一致・共有定数・分割代入)だけ。switch・endsWith・includes・正規表現の直接の比較などの新しい形が増えたら落ちる", () => {
    const leftover = code
      .replace(/const \{ pathname \} = new URL\(request\.url\);/g, "")
      .replace(/(?:new URL\(request\.url\)\.)?pathname === "[^"]+"/g, "")
      .replace(/pathname\.startsWith\(REPORTS_PREFIX\)/g, "")
      .replace(/pathname\.slice\(REPORTS_PREFIX\.length\)/g, "")
      .replace(/pathname\.startsWith\(MONTHLY_REPORTS_PREFIX\)/g, "")
      .replace(/pathname\.slice\(MONTHLY_REPORTS_PREFIX\.length\)/g, "")
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
