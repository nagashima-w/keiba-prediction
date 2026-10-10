/**
 * ルート × 役割の表(Issue #238)。**どのルートを閲覧者(viewer)に開くかを決める唯一の場所**。
 *
 * 誰がログインできるかは Cloudflare Access のポリシーだけで決まり、Worker は検証に通ったアカウントをすべて受け入れる。そのうえで、
 * 閲覧者は**読み取りだけ**にする(利用者の決定: LLM の API コールが発生する機能全般と設定変更は、管理者だけ)。
 * handler.ts は認証の直後・どのハンドラよりも前に {@link requiredRole} を 1 回だけ呼び、管理者専用なら 403 を返す。
 *
 * **表に無い (method, path) は管理者専用に倒れる(fail-closed)**。新しいルートを足して表に書き忘れても、閲覧者に開く方向には倒れない。
 * 表との突き合わせ(`test/route-policy.test.ts`)は、handler.ts の `pathname` の比較を走査し、表に無いルートが増えたら落とす。
 *
 * 閲覧者に開くもの(16 ルート):
 *   画面 `GET|HEAD /`・`GET|HEAD /app.js`、一覧 `GET /api/races`(netkeiba への取得を起こしうるが、キャッシュと gate が効く)、
 *   `GET /api/plan`、`GET /api/analyses`・`/api/analyses/status`・`/api/analyses/{id}`、`GET /api/reports`・`/api/reports/{date}`(日報は見せる)、
 *   アイコン 7 本 `GET|HEAD`(`/favicon.ico`・`/apple-touch-icon.png`・`/icons/…`。Issue #244。{@link ICON_PATHS}。表に無いと閲覧者の画面でアイコンが 403 になる)。
 * それ以外(設定・検証・移行・結果の補完と取り込み・分析の手動実行〈単独と一括。Issue #251〉・日報の手動作成・確認ページと確認 API・health)は管理者だけ。
 * 閲覧者が表の外の method(HEAD・POST など)を送ったときは、405 ではなく 403 になる(副作用の有無に関わらず管理者専用)。
 */
import { ICON_PATHS } from "./icons";

export type RouteRole = "viewer" | "admin";

export interface RouteRule {
  /** 表の名前。完全一致のルートはその path、パターンのルートは `{id}`・`{date}` つき。 */
  readonly path: string;
  /** 完全一致のルートか(false = パターン)。 */
  readonly exact: boolean;
  readonly matches: (pathname: string) => boolean;
  /** 閲覧者に許す method(大文字の完全一致)。空 = 管理者だけ。 */
  readonly viewerMethods: readonly string[];
}

/** `/api/analyses/{id}` の形(handler.ts もこの定数で振り分ける。表とハンドラで規則が食い違わないよう共有する)。 */
export const ANALYSIS_DETAIL_PATTERN = /^\/api\/analyses\/([^/]+)$/;

/** `/api/reports/{date}` の接頭辞(handler.ts もこの定数で振り分ける)。 */
export const REPORTS_PREFIX = "/api/reports/";

const GET = ["GET"] as const;
const PAGE = ["GET", "HEAD"] as const;
const ADMIN_ONLY: readonly string[] = [];

function exact(path: string, viewerMethods: readonly string[]): RouteRule {
  return { path, exact: true, matches: (pathname) => pathname === path, viewerMethods };
}

/**
 * 表。完全一致のルートが 26(画面・API・管理者専用が 19、アイコンが 7)、パターンのルートが 2(`/api/analyses/{id}`・`/api/reports/{date}`)。
 * パターンは、同じ階層の固定の path(`/api/analyses/run`・`/api/reports/run`)に化けないよう、`run` を除く。
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  // ---- 閲覧者にも許す ----
  exact("/", PAGE),
  exact("/app.js", PAGE),
  exact("/api/races", GET),
  exact("/api/plan", GET),
  exact("/api/analyses", GET),
  exact("/api/analyses/status", GET),
  {
    path: "/api/analyses/{id}",
    exact: false,
    matches: (pathname) => pathname !== "/api/analyses/run" && ANALYSIS_DETAIL_PATTERN.test(pathname),
    viewerMethods: GET,
  },
  exact("/api/reports", GET),
  {
    path: "/api/reports/{date}",
    exact: false,
    matches: (pathname) => pathname !== "/api/reports/run" && pathname.startsWith(REPORTS_PREFIX),
    viewerMethods: GET,
  },
  // アイコン(Issue #244)。handler.ts は `iconAsset(pathname)` で配る。パスの一覧は icons.ts と共有する(ここに直書きしない)
  ...ICON_PATHS.map((iconPath) => exact(iconPath, PAGE)),
  // ---- 管理者だけ(method を問わない) ----
  exact("/check", ADMIN_ONLY),
  exact("/api/health", ADMIN_ONLY), // 設定の有無(API キー・Webhook・サイトの URL)が見える
  exact("/api/netkeiba/check", ADMIN_ONLY), // netkeiba への取得を起こす確認
  exact("/api/settings", ADMIN_ONLY), // GET も含む(設定の中身を見せない)
  exact("/api/analyses/run", ADMIN_ONLY), // 手動の分析(LLM を呼ぶ)
  // 一括の手動の分析(Issue #251。LLM を呼ぶ)。**run の下の階層(`run/bulk`)にしてある**: 同じ階層の名前(`run-bulk`・`bulk` など)にすると `/api/analyses/{id}` のパターンに当たり、閲覧者に GET が開く
  exact("/api/analyses/run/bulk", ADMIN_ONLY),
  exact("/api/results/import", ADMIN_ONLY),
  exact("/api/results/backfill", ADMIN_ONLY),
  exact("/api/migration", ADMIN_ONLY),
  exact("/api/migration/upload", ADMIN_ONLY),
  exact("/api/reports/run", ADMIN_ONLY), // 日報の手動作成(LLM を呼ぶ)
  exact("/api/verify", ADMIN_ONLY),
];

/**
 * (method, pathname) に必要な役割。閲覧者に開く組み合わせとして表にあるものだけ "viewer"、それ以外(表に無い path・表の外の method を含む)は "admin"。
 * `method` は `Request.method`(標準の method は大文字に正規化される)。大文字の完全一致だけを認め、小文字などの表記は管理者専用に倒す。
 */
export function requiredRole(method: string, pathname: string): RouteRole {
  const rule = ROUTE_RULES.find((r) => r.matches(pathname));
  if (rule === undefined) {
    return "admin";
  }
  return rule.viewerMethods.includes(method) ? "viewer" : "admin";
}
