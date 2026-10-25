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
 * 閲覧者に開くもの(20 ルート):
 *   画面 `GET|HEAD /`・`GET|HEAD /app.js`、一覧 `GET /api/races`(netkeiba への取得を起こしうるが、キャッシュと gate が効く)、
 *   `GET /api/plan`、`GET /api/targets`(今日の狙い目。Issue #336)、`GET /api/analyses`・`/api/analyses/status`・`/api/analyses/{id}`、`GET /api/reports`・`/api/reports/{date}`(日報は見せる)、`GET /api/monthly-reports`・`/api/monthly-reports/{month}`(月報も見せる。Issue #279)、
 *   `GET /api/verify`(検証。Issue #263。閲覧者の要求は集計のやり直しを起こさない〈キャッシュを返すだけ〉、`refresh` は管理者だけ)、
 *   アイコン 7 本 `GET|HEAD`(`/favicon.ico`・`/apple-touch-icon.png`・`/icons/…`。Issue #244。{@link ICON_PATHS}。表に無いと閲覧者の画面でアイコンが 403 になる)。
 * それ以外(設定・移行・結果の補完と取り込み・分析の手動実行〈単独と一括。Issue #251〉・日報の手動作成・統計モデル用の書き出し〈Issue #266〉・各馬の戦績の蓄積の診断〈Issue #256〉・馬場の API の取得の結果の診断〈Issue #360〉・JRA に Worker から届くかの確認〈Issue #488〉・確認ページと確認 API・health)は管理者だけ。
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

/** `/api/monthly-reports/{month}` の接頭辞(月報。Issue #279。handler.ts もこの定数で振り分ける)。 */
export const MONTHLY_REPORTS_PREFIX = "/api/monthly-reports/";

const GET = ["GET"] as const;
const PAGE = ["GET", "HEAD"] as const;
const ADMIN_ONLY: readonly string[] = [];

function exact(path: string, viewerMethods: readonly string[]): RouteRule {
  return { path, exact: true, matches: (pathname) => pathname === path, viewerMethods };
}

/**
 * 表。完全一致のルートが 32(画面・API・管理者専用が 25、アイコンが 7)、パターンのルートが 3(`/api/analyses/{id}`・`/api/reports/{date}`・`/api/monthly-reports/{month}`)。
 * パターンは、同じ階層の固定の path(`/api/analyses/run`・`/api/reports/run`・`/api/monthly-reports/run`)に化けないよう、`run` を除く。
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  // ---- 閲覧者にも許す ----
  exact("/", PAGE),
  exact("/app.js", PAGE),
  exact("/api/races", GET),
  exact("/api/plan", GET),
  // 今日の狙い目(Issue #336)。D1 の集計と DO の計画の読み取りだけ(R2・netkeiba・LLM に触れない)。配分の提案は `GET /api/analyses/{id}` で閲覧者にもすでに見えるので、新しい露出は無い。GET だけ
  exact("/api/targets", GET),
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
  // 月報(Issue #265・#279)。日報と同じく D1 の `monthly_reports` を読むだけ(LLM も netkeiba も使わない)で、閲覧者にも見せる(ユーザーの決定)。
  // パターンは、同じ階層の固定の path(`/api/monthly-reports/run`。管理者専用の POST。Issue #280)に化けないよう、`run` を除く。
  exact("/api/monthly-reports", GET),
  {
    path: "/api/monthly-reports/{month}",
    exact: false,
    matches: (pathname) => pathname !== "/api/monthly-reports/run" && pathname.startsWith(MONTHLY_REPORTS_PREFIX),
    viewerMethods: GET,
  },
  // 検証(Issue #263)。D1 の集計の読み取りだけで LLM も netkeiba も使わない。**閲覧者の要求は集計のやり直しを起こさない**(handler.ts の `handleVerify` が役割で DO のメソッドを分け、
  // 閲覧者はキャッシュを読むだけの `getViewerReport`。`refresh` は管理者だけ)。柵(最短 5 分・1 日 20 回)を閲覧者が消費しない。GET だけ(HEAD は管理者専用)
  exact("/api/verify", GET),
  // アイコン(Issue #244)。handler.ts は `iconAsset(pathname)` で配る。パスの一覧は icons.ts と共有する(ここに直書きしない)
  ...ICON_PATHS.map((iconPath) => exact(iconPath, PAGE)),
  // ---- 管理者だけ(method を問わない) ----
  exact("/check", ADMIN_ONLY),
  exact("/api/health", ADMIN_ONLY), // 設定の有無(API キー・Webhook・サイトの URL)が見える
  exact("/api/netkeiba/check", ADMIN_ONLY), // netkeiba への取得を起こす確認
  exact("/api/settings", ADMIN_ONLY), // GET も含む(設定の中身を見せない)
  // 設定画面のプロンプトのプレビュー(Issue #396)。純関数の組み立てだけ(D1・LLM・netkeiba に触れない)。設定の画面そのものが管理者専用なので、同じ扱い。POST だけ
  exact("/api/settings/prompt-preview", ADMIN_ONLY),
  exact("/api/analyses/run", ADMIN_ONLY), // 手動の分析(LLM を呼ぶ)
  // 一括の手動の分析(Issue #251。LLM を呼ぶ)。**run の下の階層(`run/bulk`)にしてある**: 同じ階層の名前(`run-bulk`・`bulk` など)にすると `/api/analyses/{id}` のパターンに当たり、閲覧者に GET が開く
  exact("/api/analyses/run/bulk", ADMIN_ONLY),
  exact("/api/results/import", ADMIN_ONLY),
  exact("/api/results/backfill", ADMIN_ONLY),
  exact("/api/reports/run", ADMIN_ONLY), // 日報の手動作成(LLM を呼ぶ)
  exact("/api/monthly-reports/run", ADMIN_ONLY), // 月報の手動作成と作り直し(Issue #280。LLM を呼ぶ)
  // 統計モデルの見直し用の書き出し(Issue #266)。分析・結果の全件に近い内容(prior・補正・着順・オッズ)が出るので管理者だけ。作成は DO が R2 の詳細を大量に読む
  exact("/api/export/prior-dataset", ADMIN_ONLY),
  // 各馬の戦績の蓄積の診断(Issue #256 段階A)。D1 の horse_runs の走査(件数・開催区分別・セルの分布)を起こしうるので管理者だけ。読み取り専用・GET だけ
  exact("/api/horse-runs", ADMIN_ONLY),
  // 馬場の取得の結果の診断(Issue #360)。取得の時刻・結果の分類・捨てた競馬場の理由を読む(D1 の SELECT だけ。JRA にも出ない)。JRA への取得の利用の記録なので管理者だけ。GET だけ
  exact("/api/baba-fetch", ADMIN_ONLY),
  // Worker から JRA のページに届くかの確認(Issue #488)。開くたびに JRA へ 2 回出る(取得を起こす)ので管理者だけ。GET だけ
  exact("/api/jra/check", ADMIN_ONLY),
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
