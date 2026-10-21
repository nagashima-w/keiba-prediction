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

/** コメント(ブロック・行)を除いたコード。文字列中の `//`(URL)を壊さないよう、`:` の直後の `//` は除かない。 */
function stripCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Issue #397(R-4): GET の入口の `Sec-Fetch-Site` の検査は、handler.ts の `crossSiteRejection(request)` に集約した(8 ルートが共有)。
 * 各ハンドラの本体には、この呼び出しと「結果を返す」形が**1 回だけ**あり、**D1・DO・gate に触れる記述より前**にあることを検査する(旧版は本体の `sec-fetch-site` の文字列の位置で検査していた)。
 * 検査の中身(`sec-fetch-site`・`same-origin`・`"none"`・`origin-mismatch`・403)はヘルパー自体の検査(下の「crossSiteRejection」のテスト)が持つ。
 */
const CROSS_SITE_CALL = "crossSiteRejection(request)";
const CROSS_SITE_RETURNS = /const crossSite = crossSiteRejection\(request\);\s*if \(crossSite !== null\) \{\s*return crossSite;\s*\}/;
function expectCrossSiteCheckFirst(name: string, body: string, touches: readonly string[]): void {
  const at = body.indexOf(CROSS_SITE_CALL);
  expect(at, `${name} に ${CROSS_SITE_CALL} がある`).toBeGreaterThan(-1);
  expect((body.match(/crossSiteRejection\(/g) ?? []).length, `${name} の呼び出しは 1 回`).toBe(1);
  expect(body, `${name} は検査の結果を返す`).toMatch(CROSS_SITE_RETURNS);
  expect(touches.length, `${name}: 順序の検査の対象がある(空振りでない)`).toBeGreaterThan(0);
  for (const touch of touches) {
    expect(body, `${name} に ${touch} がある(前提)`).toContain(touch);
    expect(at, `別サイトの検査は ${touch} より前(${name})`).toBeLessThan(body.indexOf(touch));
  }
}

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

  it("Issue #177・#216・#217・#219・#235・#266・#279・#402: 日単位の DO(RACE_DAY・RaceDay)は migration v2、結果の補完の DO(RESULT_BACKFILL・ResultBackfill)は migration v4、検証の集計の DO(VERIFY_REPORT・VerifyReportDO)は migration v5、日報の DO(DAILY_REPORT・DailyReportDO)は migration v6、統計モデル用の書き出しの DO(PRIOR_EXPORT・PriorExportDO)は migration v7、月報の DO(MONTHLY_REPORT・MonthlyReportDO)は migration v8 で追加するだけ。v1(NetkeibaGate)は無変更。移行の DO(CloudMigration)は v3 で作られ、v9 の deleted_classes で削除される(Issue #402。binding は #394 で廃止済み)。それ以外のクラスの削除・new_classes・renamed・transferred は使わない", () => {
    // migration のブロック(コメント除去済みの tomlCode から、[[migrations]] ごとに本体を取る)
    const blocks = [...tomlCode.matchAll(/^\[\[migrations\]\]\n((?:(?!\[)[^\n]*\n?)*)/gm)].map((m) => m[1]!);
    const field = (body: string, key: string): string | null => new RegExp(`^${key} = \\[([^\\]]*)\\]$`, "m").exec(body)?.[1] ?? null;
    const tagOf = (body: string): string | null => /^tag = "(v\d+)"$/m.exec(body)?.[1] ?? null;
    // 前提: migration を実際に読めている(空振りでない)。v1〜v9 の 9 ブロック
    expect(blocks.length, "migration ブロックの数(v1〜v9)").toBe(9);
    expect(blocks.map(tagOf)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"]);
    // 追加(new_sqlite_classes)は v1〜v8 の各 1 クラス。v3 の CloudMigration は残す(v9 の deleted_classes が指す先行の migration。wrangler が同じ toml 内で存在を検査する)
    expect(blocks.map((b) => field(b, "new_sqlite_classes"))).toEqual([
      '"NetkeibaGate"',
      '"RaceDay"',
      '"CloudMigration"',
      '"ResultBackfill"',
      '"VerifyReportDO"',
      '"DailyReportDO"',
      '"PriorExportDO"',
      '"MonthlyReportDO"',
      null,
    ]);
    // 削除(deleted_classes)は v9 の 1 回だけで、中身は CloudMigration ちょうど 1 クラス。他のクラスの削除は禁じる
    expect(blocks.map((b) => field(b, "deleted_classes"))).toEqual([null, null, null, null, null, null, null, null, '"CloudMigration"']);
    expect((tomlCode.match(/deleted_classes/g) ?? []).length, "deleted_classes は toml 全体で 1 回").toBe(1);
    // v9 は削除だけ(同じブロックに追加・改名・移管を混ぜない)
    expect(blocks[8]!.trim().split("\n")).toEqual(['tag = "v9"', 'deleted_classes = ["CloudMigration"]']);
    // コメントを除いたとき、CloudMigration が出るのは v3 の追加と v9 の削除の 2 行だけ(binding・その他の参照は無い)
    expect(tomlCode.split("\n").filter((l) => l.includes("CloudMigration"))).toEqual(['new_sqlite_classes = ["CloudMigration"]', 'deleted_classes = ["CloudMigration"]']);
    expect(tomlCode).toMatch(/^name = "RACE_DAY"$/m);
    expect(tomlCode).toMatch(/^class_name = "RaceDay"$/m);
    // Issue #394・#402: CloudMigration の binding は無い(クラスの殻も無い。migration は v3 の追加と v9 の削除だけ)
    expect(tomlCode).not.toMatch(/CLOUD_MIGRATION/);
    expect(tomlCode).not.toMatch(/^class_name = "CloudMigration"$/m);
    expect(tomlCode).toMatch(/^name = "RESULT_BACKFILL"$/m);
    expect(tomlCode).toMatch(/^class_name = "ResultBackfill"$/m);
    expect(tomlCode).toMatch(/^name = "VERIFY_REPORT"$/m);
    expect(tomlCode).toMatch(/^class_name = "VerifyReportDO"$/m);
    expect(tomlCode).toMatch(/^name = "DAILY_REPORT"$/m);
    expect(tomlCode).toMatch(/^class_name = "DailyReportDO"$/m);
    expect(tomlCode).toMatch(/^name = "PRIOR_EXPORT"$/m);
    expect(tomlCode).toMatch(/^class_name = "PriorExportDO"$/m);
    expect(tomlCode).toMatch(/^name = "MONTHLY_REPORT"$/m);
    expect(tomlCode).toMatch(/^class_name = "MonthlyReportDO"$/m);
    expect(tomlCode).not.toMatch(/^(renamed_classes|transferred_classes|new_classes)\s*=/m);
    // DO のバインディングはちょうど7つ(NETKEIBA_GATE・RACE_DAY・RESULT_BACKFILL・VERIFY_REPORT・DAILY_REPORT・PRIOR_EXPORT・MONTHLY_REPORT。Issue #394 で CLOUD_MIGRATION を外した)
    expect((tomlCode.match(/^\[\[durable_objects\.bindings\]\]$/gm) ?? []).length).toBe(7);
  });

  it("Issue #206・#249: cron はちょうど2本で `0 12 * * *`(UTC 12:00 = JST 21:00)と `0 14 * * *`(UTC 14:00 = JST 23:00)。朝 9 時の定時実行は無い。止め方(`crons = []`)をコメントに残す。キューの consumer・producer は無い", () => {
    // 前提: [triggers] を実際に読めている(空振りでない)
    expect((tomlCode.match(/^\[triggers\]$/gm) ?? []).length).toBe(1);
    const crons = [...tomlCode.matchAll(/^crons\s*=\s*\[([^\]]*)\]\s*$/gm)];
    expect(crons).toHaveLength(1);
    const entries = crons[0]![1]!.split(",").map((e) => e.trim()).filter((e) => e !== "");
    expect(entries).toEqual(['"0 12 * * *"', '"0 14 * * *"']);
    // 朝 9 時(UTC 0:00)の cron は無い
    expect(entries).not.toContain('"0 0 * * *"');
    // [triggers] の中身は crons だけ(他の種類のトリガを足していない)
    const triggersBlock = /^\[triggers\]\n((?:(?!\[)[^\n]*\n?)*)/m.exec(tomlCode)?.[1] ?? "";
    expect(triggersBlock.trim()).toBe('crons = ["0 12 * * *", "0 14 * * *"]');
    // キュー: consumer も producer も無い
    expect(tomlCode).not.toMatch(/^\[\[queues\./m);
    expect(tomlCode).not.toMatch(/^\[queues/m);
    // 止め方(`[triggers]` を消すだけでは止まらない)がコメントに書いてある
    expect(toml).toContain("crons = []");
    expect(toml).toContain("消すだけでは止まらない");
    // 検出の確認(空振りでない): 3本目や別の式は拾う形
    expect('[triggers]\ncrons = ["0 12 * * *", "0 14 * * *", "30 0 * * *"]\n'.match(/^crons\s*=\s*\[([^\]]*)\]\s*$/m)![1]!.split(",")).toHaveLength(3);
  });

  it("Issue #249: toml の cron の時刻(UTC → JST に直した時)は、scheduled の判別が使う定数(auto-run-plan.ts の FIRST_RUN_JST_HOUR・RETRY_RUN_JST_HOUR)と一致する。再実行の判別の境界(RETRY_RUN_FROM_JST_HOUR)は 2 本の間にある", () => {
    const plan = readTextLf("cloud", "src", "auto-run-plan.ts");
    const constant = (name: string): number => {
      const m = new RegExp(`export const ${name} = (\\d+);`).exec(plan);
      expect(m, `${name} を auto-run-plan.ts から読めた`).not.toBeNull();
      return Number(m![1]);
    };
    const first = constant("FIRST_RUN_JST_HOUR");
    const retry = constant("RETRY_RUN_JST_HOUR");
    const from = constant("RETRY_RUN_FROM_JST_HOUR");
    const crons = [...tomlCode.matchAll(/^crons\s*=\s*\[([^\]]*)\]\s*$/gm)][0]![1]!.split(",").map((e) => e.trim().replace(/"/g, "")).filter((e) => e !== "");
    // cron は「分 時 * * *」の形で、分は 0。UTC の時 + 9 = JST の時(夏時間なし。24 を超えない時刻だけを使う)
    const jstHours = crons.map((c) => {
      const m = /^0 (\d{1,2}) \* \* \*$/.exec(c);
      expect(m, `cron ${c} は「0 時 * * *」の形`).not.toBeNull();
      return Number(m![1]) + 9;
    });
    expect(jstHours).toEqual([first, retry]);
    expect(first).toBe(21);
    expect(retry).toBe(23);
    expect(first).toBeLessThan(from);
    expect(from).toBeLessThanOrEqual(retry);
    // 21 時と 23 時は同じ JST の日(日付をまたがない): 計画する翌日が同じになる前提
    expect(jstHours.every((h) => h < 24)).toBe(true);
  });

  it("Issue #180・#183・#206・#208・#251: netkeiba への取得の起点は、手動の 4 つ(POST の予約・POST の一括の予約・GET の一覧・GET の確認。認証の後ろ)と、定時の 1 つ(scheduled の requestPlan)の呼び出し箇所 5 つに、結果の取り込みの依頼の呼び出し箇所 1 つ(result-dispatch.ts。cron と手動 POST が共有)を加えた計 6 つだけ", () => {
    const worker = readTextLf("cloud", "src", "worker.ts");
    const workerCode = stripCode(worker);
    expect(worker.length).toBeGreaterThan(100); // 前提: 読めている
    // scheduled は worker.ts に 1 経路だけで、scheduled.ts の runScheduled に委譲する(netkeiba にも DO にも直接出ない)
    expect((workerCode.match(/\bscheduled\s*\(/g) ?? []).length).toBe(1);
    expect((workerCode.match(/\brunScheduled\(/g) ?? []).length).toBe(1);
    expect(workerCode).not.toMatch(/\bqueue\b\s*\(/);
    for (const forbidden of ["NETKEIBA_GATE", "RACE_DAY", "fetch(", ".fetchRaw(", ".getRaceList(", ".schedule(", ".scheduleMany(", ".requestPlan("]) {
      // `fetch(` は export default の fetch ハンドラ(`async fetch(`)だけ: 呼び出しの形(`.fetch(` や `await fetch(`)を禁じる
      const pattern = forbidden === "fetch(" ? /(\.|await\s+)fetch\(/ : new RegExp(forbidden.replace(/[.()]/g, "\\$&"));
      expect(workerCode, `worker.ts に ${forbidden} が無い`).not.toMatch(pattern);
    }
    // scheduled.ts: DO の RPC は requestPlan の 1 つだけ。取得・予約・一覧の呼び出しを持たない
    const scheduledCode = stripCode(readTextLf("cloud", "src", "scheduled.ts"));
    expect(scheduledCode.length).toBeGreaterThan(500); // 前提: コメント除去で本文を消していない
    expect((scheduledCode.match(/\.requestPlan\(/g) ?? []).length).toBe(1);
    for (const forbidden of [".schedule(", ".scheduleMany(", ".getRaceList(", ".fetchRaw(", ".getBoard(", ".requestResultImport(", "NETKEIBA_GATE", "ANTHROPIC"]) {
      expect(scheduledCode, `scheduled.ts に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // Issue #249(利用者の決定): scheduled.ts は Discord を参照しない、という従来の制約を、「**送信の部品を使うのは、23 時の再実行で計画の依頼が 3 回とも失敗したときの失敗通知の 1 箇所だけ**」に改めた。
    // (DO に届かない状況では、DO の状態から通知を作れないため。first〈21 時〉の失敗では送らない。)
    //  - DISCORD の語は、Worker の secret の名前 DISCORD_WEBHOOK_URL だけ(型の宣言 1 + 読む 1 の計 2 箇所)
    expect(scheduledCode.match(/DISCORD\w*/g)).toEqual(["DISCORD_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"]);
    expect((scheduledCode.match(/\benv\.DISCORD_WEBHOOK_URL\b/g) ?? []).length).toBe(1);
    //  - 送信の部品(createDiscordNotifier)の呼び出しは 1 箇所、送信(`.send(`)も 1 箇所
    expect((scheduledCode.match(/(?<!function\s)\bcreateDiscordNotifier\(/g) ?? []).length).toBe(1);
    expect((scheduledCode.match(/\.send\(/g) ?? []).length).toBe(1);
    //  - その入口(notifyPlanRequestFailed)の呼び出しは 1 箇所で、retry のときの失敗(!planned)の中だけ
    expect((scheduledCode.match(/(?<!function\s)\bnotifyPlanRequestFailed\(/g) ?? []).length).toBe(1);
    expect(scheduledCode).toMatch(/if \(!planned\) \{[\s\S]*?if \(isRetry\) \{\s*await notifyPlanRequestFailed\(/);
    //  - 固定文の embed だけを送る(日単位の DO の embed・分析の embed は使わない)
    expect(scheduledCode).toContain("buildPlanRequestFailedEmbed(");
    expect(scheduledCode).not.toMatch(/buildSummaryEmbed|buildAnalysisNotificationEmbed|buildFailureEmbed/);
    // 対照(検出の確認。空振りでない): 余計な送信を足した本文は拾う
    expect(("await x.send(y); await z.send(w);").match(/\.send\(/g)).toHaveLength(2);
    // Issue #208: 結果の依頼は dispatchResultImports に委譲する(1 箇所)。D1 は結果の未取込の列挙(D1ResultStore)にだけ使う(env.DB は 1 箇所)
    expect((scheduledCode.match(/\bdispatchResultImports\(/g) ?? []).length).toBe(1);
    // Issue #235: 日報の取り残しの列挙（D1ReportStore。読み取り 1 クエリ）にも env.DB を渡す。計 2 箇所（結果の未取込の列挙・日報の取り残しの列挙）。
    expect((scheduledCode.match(/\benv\.DB\b/g) ?? []).length).toBe(2);
    expect(scheduledCode).toContain("CRON_RESULT_MAX_DAYS");
    expect(scheduledCode).toContain("resultWindowFor(");
    expect(scheduledCode).not.toMatch(/(\.|await\s+)fetch\(/);
    expect(scheduledCode).toContain("jstKaisaiDate(");
    // 手動の入口は、認証の後ろの POST /api/analyses/run だけ(handler.ts)。ここから日単位の DO の schedule を呼ぶ
    const handler = readTextLf("cloud", "src", "handler.ts");
    expect(handler).toContain('"/api/analyses/run"');
    expect(handler).toContain("originAllowed(request)");
    // Issue #183: GET の一覧(`/api/races`)も netkeiba に出うる。handler.ts から netkeiba に届く呼び出し(DO の予約・一覧・gate の取得)は、
    // **呼び出し箇所の数で固定する**(コメント除去後。新しい取得口を足すと、この数が変わってここで落ちる)。
    const code = stripCode(handler);
    expect(code.length).toBeGreaterThan(1000); // 前提: コメント除去で本文を消していない
    const count = (pattern: RegExp): number => (code.match(pattern) ?? []).length;
    expect(count(/\.schedule\(/g)).toBe(1); // handleRun(POST)
    expect(count(/\.scheduleMany\(/g)).toBe(1); // handleRunBulk(POST /api/analyses/run/bulk。Issue #251)
    expect(count(/\.getRaceList\(/g)).toBe(1); // handleRaces(GET。Sec-Fetch-Site・検証の後)
    expect(count(/\.fetchRaw\(/g)).toBe(1); // handleCheck(GET /api/netkeiba/check)
    expect(count(/\.requestPlan\(/g)).toBe(0); // 計画の依頼は cron(scheduled.ts)だけ。手動の入口は呼ばない
    expect(count(/\.requestResultImport\(/g)).toBe(0); // 結果の依頼は result-dispatch.ts の 1 箇所だけ(handler.ts は dispatchResultImports に委譲する)
    expect(handler).toContain('"/api/races"');
    // 一覧の入口は、DO を呼ぶ前に Sec-Fetch-Site を見る
    expect(code.indexOf("sec-fetch-site")).toBeGreaterThan(-1);
    expect(code.indexOf("sec-fetch-site")).toBeLessThan(code.indexOf(".getRaceList("));
    // 起点の総数(呼び出し箇所): handler.ts(手動 4)+ scheduled.ts(定時 1)+ result-dispatch.ts(結果の依頼 1。cron と手動 POST が共有)= 6。worker.ts は 0
    const originCalls = (c: string): number => (c.match(/\.(schedule|scheduleMany|getRaceList|fetchRaw|requestPlan|requestResultImport)\(/g) ?? []).length;
    const dispatchCode = stripCode(readTextLf("cloud", "src", "result-dispatch.ts"));
    expect(dispatchCode.length).toBeGreaterThan(1000); // 前提: 読めている
    expect(originCalls(code)).toBe(4);
    expect(originCalls(scheduledCode)).toBe(1);
    expect(originCalls(workerCode)).toBe(0);
    expect(originCalls(dispatchCode)).toBe(1);
    expect((dispatchCode.match(/\.requestResultImport\(/g) ?? []).length).toBe(1);
    expect(originCalls(code) + originCalls(scheduledCode) + originCalls(workerCode) + originCalls(dispatchCode)).toBe(6);
    // 結果の依頼(`.requestResultImport(`)を持つファイルは、cloud/src で result-dispatch.ts(呼び出し 1)と race-day-do.ts(DO の RPC が core に委譲する 1)だけ
    const srcDir = path.join(ROOT, "cloud", "src");
    const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "client-bundle.generated.ts");
    const resultCallSites: Record<string, number> = {};
    const dispatchCallSites: Record<string, number> = {};
    for (const f of srcFiles) {
      const c = stripCode(readTextLf("cloud", "src", f));
      const n = (c.match(/\.requestResultImport\(/g) ?? []).length;
      if (n > 0) resultCallSites[f] = n;
      // dispatchResultImports の呼び出し(関数の宣言 `function dispatchResultImports(` は数えない)
      const d = (c.match(/(?<!function\s)\bdispatchResultImports\(/g) ?? []).length;
      if (d > 0) dispatchCallSites[f] = d;
    }
    expect(resultCallSites).toEqual({ "race-day-do.ts": 1, "result-dispatch.ts": 1 });
    // dispatchResultImports の呼び出し箇所は 3 つだけ: cron(scheduled.ts)・手動 POST(handler.ts)・結果の補完(result-backfill-core.ts。Issue #217。列挙だけを補完用に差し替えて同じ関数に委譲する)
    expect(dispatchCallSites).toEqual({ "handler.ts": 1, "result-backfill-core.ts": 1, "scheduled.ts": 1 });
    // 対照(検出の確認。空振りでない): 取得口を1つ足した本文では、数が変わる
    expect(((code + "\ngate.fetchRaw(x);").match(/\.fetchRaw\(/g) ?? []).length).toBe(2);
    expect(originCalls(scheduledCode + "\nstub.getRaceList(a, b);")).toBe(2);
    expect(originCalls(scheduledCode + "\nstub.requestResultImport(a);")).toBe(2);
    expect(originCalls(scheduledCode + "\nstub.scheduleMany(a);")).toBe(2); // 一括の予約口も数える(`.schedule(` の正規表現だけでは、`.scheduleMany(` が数えられずにすり抜ける)
    expect(("await dispatchResultImports(x);\nexport async function dispatchResultImports(i) {}").match(/(?<!function\s)\bdispatchResultImports\(/g)).toHaveLength(1);
  });

  it("Issue #208・#251・#394・#396: 手動の POST を受けるルートは 7 つだけ(/api/settings・/api/settings/prompt-preview〈Issue #396〉・/api/analyses/run・/api/analyses/run/bulk・/api/results/import・/api/reports/run・/api/monthly-reports/run〈Issue #280〉。/api/migration/upload は Issue #394 で廃止)。結果の取り込みの POST は、run と同じ守り(readJsonObjectBody)を通り、D1 の列挙 → 日ごとの依頼を dispatchResultImports に任せる", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    expect(code.length).toBeGreaterThan(1000); // 前提: 読めている
    // POST の分岐は 7 つ(`method === "POST"`。下の path つきの 6 つと、`/api/settings` の pathname の分岐の中で method を見る 1 つ)
    expect((code.match(/method === "POST"/g) ?? []).length).toBe(7);
    const routes = [...code.matchAll(/method === "POST" && new URL\(request\.url\)\.pathname === "([^"]+)"/g)].map((m) => m[1]);
    expect(routes).toEqual(["/api/settings/prompt-preview", "/api/analyses/run", "/api/analyses/run/bulk", "/api/results/import", "/api/reports/run", "/api/monthly-reports/run"]); // settings は pathname の分岐の中で method を見る
    expect(code).toMatch(/pathname === "\/api\/settings"/);
    // Issue #396: handlePromptPreview は守りの後で純関数 buildPreviewText を呼ぶだけ。env・D1・DO・R2・netkeiba・LLM・Discord に触れない
    const previewStart = code.indexOf("async function handlePromptPreview(");
    expect(previewStart).toBeGreaterThan(-1);
    const previewBody = code.slice(previewStart, code.indexOf("\n}\n", previewStart));
    expect(previewBody.length).toBeGreaterThan(300); // 前提: 本体を実際に読めている(空振りでない)
    expect(previewBody).toContain("readJsonObjectBody(request, PROMPT_PREVIEW_BODY_MAX_BYTES)");
    expect(previewBody.indexOf("readJsonObjectBody(")).toBeLessThan(previewBody.indexOf("buildPreviewText(")); // 守りが先
    expect(previewBody).toContain("buildPreviewText(");
    for (const forbidden of ["env", ".DB", ".schedule", ".requestPlan(", ".getRaceList(", ".fetchRaw(", ".requestResultImport(", "NETKEIBA_GATE", "ANALYSIS_DETAIL", "ANTHROPIC", "DISCORD", "fetch("]) {
      expect(previewBody, `handlePromptPreview に ${forbidden} が無い`).not.toContain(forbidden);
    }
    expect((previewBody + "\nawait env.DB.prepare(x);").includes("env")).toBe(true); // 対照(検出の確認。空振りでない)
    // handleResultsImport の本体
    const start = code.indexOf("async function handleResultsImport(");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("\n}\n", start);
    const body = code.slice(start, end);
    expect(body.length).toBeGreaterThan(800); // 前提: 本体を実際に読めている(空振りでない)
    expect(body).toContain("readJsonObjectBody(request");
    expect(body.indexOf("readJsonObjectBody(")).toBeLessThan(body.indexOf("dispatchResultImports(")); // 守りが先
    expect(body).toContain("dispatchResultImports(");
    expect(body).toContain("MANUAL_RESULT_MAX_DAYS");
    expect(body).toContain("jstKaisaiDate(");
    for (const forbidden of [".schedule(", ".scheduleMany(", ".requestPlan(", ".getRaceList(", ".fetchRaw(", ".requestResultImport(", "NETKEIBA_GATE", "ANALYSIS_DETAIL", "ANTHROPIC", "DISCORD", "fetch("]) {
      expect(body, `handleResultsImport に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 対照(検出の確認。空振りでない)
    expect((body + "\nstub.requestResultImport(a);").includes(".requestResultImport(")).toBe(true);
  });

  it("Issue #251: 一括の手動起動(POST /api/analyses/run/bulk)は、単独の run と同じ守り(readJsonObjectBody)の後で、日単位の DO の scheduleMany を 1 回だけ呼ぶ。scheduleMany を呼ぶ箇所は handler.ts と DO の委譲の 2 つだけ。netkeiba・LLM・D1・Discord には触れない", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = code.indexOf("async function handleRunBulk(");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("\n}\n", start);
    const body = code.slice(start, end);
    expect(body.length).toBeGreaterThan(800); // 前提: 本体を実際に読めている(空振りでない)
    expect(body).toContain("readJsonObjectBody(request, BULK_BODY_MAX_BYTES)");
    expect(body.indexOf("readJsonObjectBody(")).toBeLessThan(body.indexOf("parseBulkBody(")); // 守りが先
    expect(body.indexOf("parseBulkBody(")).toBeLessThan(body.indexOf(".scheduleMany(")); // 検証が先(検証を通ったものだけが DO に届く)
    expect((body.match(/\.scheduleMany\(/g) ?? []).length).toBe(1);
    for (const forbidden of [".schedule(", ".requestPlan(", ".getRaceList(", ".fetchRaw(", ".requestResultImport(", "NETKEIBA_GATE", "ANALYSIS_DETAIL", "env.DB", "ANTHROPIC", "DISCORD", "fetch("]) {
      expect(body, `handleRunBulk に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 入力の検証(parseBulkBody)は、単独の run と同じ検証関数を使い、件数の上限は共有の定数を使う
    const parseStart = code.indexOf("function parseBulkBody(");
    expect(parseStart).toBeGreaterThan(-1);
    const parseBody = code.slice(parseStart, code.indexOf("\n}\n", parseStart));
    expect(parseBody).toContain("validateRaceId(");
    expect(parseBody).toContain("checkRaceDate(");
    expect(parseBody).toContain("MAX_BULK_RACES");
    // scheduleMany の呼び出し(`.scheduleMany(`)を持つファイルは、handler.ts(1)と race-day-do.ts(DO の RPC が core に委譲する 1)だけ
    const srcDir = path.join(ROOT, "cloud", "src");
    const sites: Record<string, number> = {};
    for (const f of readdirSync(srcDir).filter((name) => name.endsWith(".ts") && name !== "client-bundle.generated.ts")) {
      const n = (stripCode(readTextLf("cloud", "src", f)).match(/\.scheduleMany\(/g) ?? []).length;
      if (n > 0) sites[f] = n;
    }
    expect(sites).toEqual({ "handler.ts": 1, "race-day-do.ts": 1 });
    // 対照(検出の確認。空振りでない)
    expect(((body + "\nstub.scheduleMany(a);").match(/\.scheduleMany\(/g) ?? []).length).toBe(2);
  });

  it("Issue #208: 結果のページは、DO の中で gate 経由・キャッシュなしの HttpClient 1 本だけで取る(グローバルの fetch・bypassCache・CachedFetcher 経由では取らない)。D1 に出るのは 1 レースぶんの saveResult だけ", () => {
    const core = stripCode(readTextLf("cloud", "src", "race-day-core.ts"));
    expect(core.length).toBeGreaterThan(5000); // 前提: 読めている
    const count = (pattern: RegExp): number => (core.match(pattern) ?? []).length;
    expect(count(/createGateHttpClient\(/g)).toBe(1); // 取得のクライアントは 1 つ(gate 経由)
    expect(count(/serializeGate\(deps\.gate\)/g)).toBe(1); // 直列化した gate は 1 つ(キャッシュ付きの取得と結果の取得が同じ待ち行列を使う)
    // 【Issue #399(R-9d)で改訂】旧: `this.httpClient.fetchText(` が race-day-core.ts にちょうど 1 件(結果のページの取得は 1 箇所)。結果の取り込みの段階を `race-day-result-stage.ts` に切り出したので、
    // core には 0 件になり、1 件は段階のファイルに移った(cloud/src 全体でも 1 件のまま)。
    // 保証していたことは変わらない: (1) 結果のページの取得は cloud/src 全体で 1 箇所(段階の `runStep`) (2) その取得口は、本体が gate 経由で作った `httpClient` そのもの(キャッシュを通る取得口ではない)。
    // (2) は、段階を作る箇所(`new ResultStage({ ... })`)に何を渡すかの検査(下の「配線」)で守る: 切り出しによって、取得口を差し替える余地が配線に移ったため。
    expect(count(/this\.httpClient\.fetchText\(/g)).toBe(0);
    const fetchTextSites: Record<string, number> = {};
    for (const f of readdirSync(path.join(ROOT, "cloud", "src")).filter((name) => name.endsWith(".ts") && name !== "client-bundle.generated.ts")) {
      const n = (stripCode(readTextLf("cloud", "src", f)).match(/this\.httpClient\.fetchText\(/g) ?? []).length;
      if (n > 0) fetchTextSites[f] = n;
    }
    expect(fetchTextSites).toEqual({ "race-day-result-stage.ts": 1 });
    expect(count(/(\.|await\s+)fetch\(/g)).toBe(0); // グローバルの fetch に出ない
    // 【Issue #283で改訂】旧: `bypassCache` が race-day-core.ts に 0 件(結果のページを、キャッシュを通す取得〈CachedFetcher〉の bypassCache では取らない)。
    // 地方三連単の段階(`runNarTrifectaStep`)が、オッズの軸の本文をキャッシュに積むために `{ bypassCache: true }` で CachedFetcher を呼ぶので、1 件になった。
    // 保証していたことは変わらない: 結果のページの取得(runResultStep)に `bypassCache` は無く(下の本体の検査)、この 1 件は runNarTrifectaStep の中にだけある。
    // 【Issue #338で改訂】旧: 1 件(runNarTrifectaStep の中だけ)。締切の直前の再計算の取得口(`closeFetcher`)が、オッズの URL だけ `{ ...options, bypassCache: true }` で CachedFetcher を呼ぶので、2 件になった。
    // 保証していたことは変わらない: 結果のページの取得(runResultStep)に `bypassCache` は無く(下の本体の検査)、2 件は runNarTrifectaStep と closeFetcher の中にだけある(どちらもオッズ。それ以外の URL は cacheOnly)。
    // 【Issue #399(R-9a)で改訂】旧: `bypassCache` が race-day-core.ts に 2 件(runNarTrifectaStep と closeFetcher)。締切の再計算の段階を `race-day-close-stage.ts` に切り出したので、
    // core には runNarTrifectaStep の 1 件だけが残り、closeFetcher の 1 件は段階のファイルに移った(合計は 2 件のまま)。
    // 保証していたことは変わらない: (1) 結果のページの取得(`runResultStep`。R-9d で `ResultStage.runStep` に移った)に `bypassCache` は無い(下の本体の検査) (2) `bypassCache` があるのはオッズの取得 2 箇所
    // (core の runNarTrifectaStep と段階の closeFetcher)だけで、cloud/src の他のファイルには無い (3) 締切の取得口の形(オッズの URL だけ bypassCache・それ以外はキャッシュ専用)は段階のファイルで同じ検査をする。
    expect(count(/bypassCache/g)).toBe(1);
    const closeStage = stripCode(readTextLf("cloud", "src", "race-day-close-stage.ts"));
    expect(closeStage.length).toBeGreaterThan(3000); // 前提: 段階のファイルを読めている
    expect((closeStage.match(/bypassCache/g) ?? []).length).toBe(1);
    const bypassSites: Record<string, number> = {};
    for (const f of readdirSync(path.join(ROOT, "cloud", "src")).filter((name) => name.endsWith(".ts") && name !== "client-bundle.generated.ts")) {
      const n = (stripCode(readTextLf("cloud", "src", f)).match(/\bbypassCache\b/g) ?? []).length;
      if (n > 0) bypassSites[f] = n;
    }
    expect(bypassSites).toEqual({ "race-day-core.ts": 1, "race-day-close-stage.ts": 1 });
    const stageStart = core.indexOf("private async runNarTrifectaStep(");
    expect(stageStart).toBeGreaterThan(-1);
    const stageEnd = core.indexOf("\n  }\n", stageStart);
    expect(core.slice(stageStart, stageEnd)).toContain("bypassCache");
    const closeStart = closeStage.indexOf("private closeFetcher(");
    expect(closeStart).toBeGreaterThan(-1);
    const closeBody = closeStage.slice(closeStart, closeStage.indexOf("\n  }\n", closeStart));
    expect(closeBody.length).toBeGreaterThan(500); // 前提: 本体を実際に読めている
    expect(closeBody).toContain("ODDS_URL_PATTERN.test(url)"); // オッズの URL だけ
    expect(closeBody).toContain("bypassCache: true");
    expect(closeBody).toContain("this.cacheOnly.fetchText("); // それ以外(出馬表・戦績・調教)はキャッシュ専用=ネットワークに出ない
    expect(count(/this\.setAlarm\(/g)).toBe(1); // アラームを張るのは rearm の 1 箇所だけ
    // 【Issue #399(R-9d)で改訂】旧: core の `private async runResultStep(` の本体を検査していた。結果の取り込みの段階を `race-day-result-stage.ts` に切り出したので、
    // 同じ検査(`toContain` の 4 項目・`forbidden` の全項目・本体長)を、段階の `async runStep(` の本体に対して行う。項目は 1 つも減らしていない。
    // 保証していたことは変わらない: 結果のステップの本体は、キャッシュ付きの取得(networkFetcher・cacheOnly)を使わず、D1 は saveResult の 1 経路だけ。
    // 加えて、段階を作る配線(core の `new ResultStage({ ... })`)に、取得口として `httpClient: this.httpClient` が渡り、キャッシュ系・分析の保存先が渡らないことを検査する(切り出しで新たに必要になった保証)。
    const stage = stripCode(readTextLf("cloud", "src", "race-day-result-stage.ts"));
    expect(stage.length).toBeGreaterThan(3000); // 前提: 段階のファイルを読めている
    const start = stage.indexOf("async runStep(");
    expect(start).toBeGreaterThan(-1);
    const end = stage.indexOf("\n  }\n", start);
    const body = stage.slice(start, end);
    expect(body.length).toBeGreaterThan(1500); // 前提: 本体を実際に読めている
    const wireStart = core.indexOf("new ResultStage({");
    expect(wireStart).toBeGreaterThan(-1);
    expect(core.indexOf("new ResultStage({", wireStart + 1)).toBe(-1); // 段階を作る箇所は 1 つ
    const wireEnd = core.indexOf("\n    });", wireStart);
    expect(wireEnd).toBeGreaterThan(wireStart);
    const wiring = core.slice(wireStart, wireEnd);
    expect(wiring.length).toBeGreaterThan(100); // 前提: 配線を実際に読めている
    expect(wiring).toContain("httpClient: this.httpClient,"); // 取得口は gate 経由・キャッシュなしの HttpClient そのもの
    for (const forbidden of ["this.cache", "cacheOnly", "networkFetcher", "this.sink"]) {
      expect(wiring, `ResultStage の配線に ${forbidden} が無い`).not.toContain(forbidden);
    }
    expect(body).toContain("this.httpClient.fetchText(");
    expect(body).toContain("importRaceResult(");
    expect(body).toContain("this.resultStore!.saveResult(");
    expect(body).toContain("winPayouts.length === 0"); // 払戻のテーブルが出てから保存する
    expect(body).not.toContain("bypassCache"); // 結果の取得は、キャッシュを通す取得の bypassCache では取らない(旧: ファイル全体で 0 件)
    for (const forbidden of ["networkFetcher", "cacheOnly", "this.cache", "this.sink", "loadSettings", "fetch("]) {
      expect(body.replace(/this\.httpClient\.fetchText\(/g, ""), `ResultStage.runStep に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 結果のステップを動かす条件(resultsRunnable)を、アラームの候補(rearm)と実行(runNextStep)の両方が使う
    expect(count(/this\.resultsRunnable\(\)/g)).toBe(2);
  });

  it("Issue #399(R-9e e2): 計画の昇格の段階(race-day-promote-stage.ts)は、アラーム・取得口・キャッシュ・保存に触れない。段階を作る配線(core の new PromoteStage)も、取得口・キャッシュ・アラームを渡さない", () => {
    // 昇格は D1 に手動の分析の有無を問い合わせる(findRecentByRace)だけで、netkeiba に出ず、D1 に書かず、アラームも張らない(張り直しは本体の armAlarm)。
    // 切り出しによって、取得口やアラームを段階に渡せる余地が配線に移ったため、段階の本文と配線の両方を検査する。
    const stage = stripCode(readTextLf("cloud", "src", "race-day-promote-stage.ts"));
    expect(stage.length).toBeGreaterThan(3000); // 前提: 段階のファイルを読めている
    expect(stage).toContain(".findRecentByRace("); // 前提: 段階が使う保存先の窓口はこれ(読み取りだけ)
    const stageForbidden = ["setAlarm(", "rearm(", "armAlarm(", "fetch(", "networkFetcher", "cacheOnly", "httpClient", ".save(", "saveClose("];
    const found = (text: string): string[] => stageForbidden.filter((f) => text.includes(f));
    expect(found(stage)).toEqual([]);
    // 対照(検出の確認。空振りでない): 禁止の文字列を含む本文は検出する
    expect(found(`${stage}\nthis.setAlarm(1);\nthis.sink.save(x);`)).toEqual(["setAlarm(", ".save("]);
    const core = stripCode(readTextLf("cloud", "src", "race-day-core.ts"));
    const wireStart = core.indexOf("new PromoteStage({");
    expect(wireStart).toBeGreaterThan(-1);
    expect(core.indexOf("new PromoteStage({", wireStart + 1)).toBe(-1); // 段階を作る箇所は 1 つ
    const wireEnd = core.indexOf("\n    });", wireStart);
    expect(wireEnd).toBeGreaterThan(wireStart);
    const wiring = core.slice(wireStart, wireEnd);
    expect(wiring.length).toBeGreaterThan(200); // 前提: 配線を実際に読めている
    expect(wiring).toContain("plan: this.plan,"); // 前提: 配線の中身を読めている(計画の表)
    expect(wiring).toContain("sink: this.sink,"); // 保存先は本体の sink(段階の型が findRecentByRace だけに狭める)
    for (const forbidden of ["setAlarm", "this.cache", "httpClient", "cacheOnly", "networkFetcher"]) {
      expect(wiring, `PromoteStage の配線に ${forbidden} が無い`).not.toContain(forbidden);
    }
  });

  it("Issue #399(R-9e e1): 計画の一覧と確定の段階(race-day-plan-stage.ts)は、アラーム・取得口・キャッシュに触れず、一覧の取得は注入された getRaceList だけを通る。段階を作る配線(core の new PlanStage)も、取得口・キャッシュ・アラームを渡さない", () => {
    // 一覧と確定は、一覧の取得を本体の getRaceList(gate 経由のキャッシュ・合流・掃除のアラームを持つ)に任せ、計画の表・タスクの表(注入された関数)・結果の行(注入された関数)を書くだけで、
    // netkeiba に直接出ず、アラームも張らない(張り直しは本体の armAlarm)。切り出しによって、取得口やアラームを段階に渡せる余地が配線に移ったため、段階の本文と配線の両方を検査する。
    const stage = stripCode(readTextLf("cloud", "src", "race-day-plan-stage.ts"));
    expect(stage.length).toBeGreaterThan(3000); // 前提: 段階のファイルを読めている
    expect(stage).toContain("this.getRaceList(kaisaiDate, venue)"); // 前提: 一覧の取得の窓口はこれ(注入された本体の getRaceList)
    expect(stage).toContain("this.enqueueSameDayResults(kaisaiDate, nowMs)"); // 前提: 結果の行を積む窓口はこれ(注入された本体の関数)
    const stageForbidden = ["setAlarm(", "rearm(", "armAlarm(", "fetch(", "networkFetcher", "cacheOnly", "httpClient"];
    const found = (text: string): string[] => stageForbidden.filter((f) => text.includes(f));
    expect(found(stage)).toEqual([]);
    // 対照(検出の確認。空振りでない): 禁止の文字列を含む本文は検出する
    expect(found(`${stage}\nthis.setAlarm(1);\nthis.httpClient.get(x);`)).toEqual(["setAlarm(", "httpClient"]);
    const core = stripCode(readTextLf("cloud", "src", "race-day-core.ts"));
    const wireStart = core.indexOf("new PlanStage({");
    expect(wireStart).toBeGreaterThan(-1);
    expect(core.indexOf("new PlanStage({", wireStart + 1)).toBe(-1); // 段階を作る箇所は 1 つ
    const wireEnd = core.indexOf("\n    });", wireStart);
    expect(wireEnd).toBeGreaterThan(wireStart);
    const wiring = core.slice(wireStart, wireEnd);
    expect(wiring.length).toBeGreaterThan(400); // 前提: 配線を実際に読めている
    expect(wiring).toContain("plan: this.plan,"); // 前提: 配線の中身を読めている(計画の表)
    expect(wiring).toContain("getRaceList: (kaisaiDate, venue) => this.getRaceList(kaisaiDate, venue),"); // 一覧の取得は本体の getRaceList だけ(gate の取得口を直接渡さない)
    for (const forbidden of ["setAlarm", "this.cache", "httpClient", "cacheOnly", "networkFetcher"]) {
      expect(wiring, `PlanStage の配線に ${forbidden} が無い`).not.toContain(forbidden);
    }
  });

  it("Issue #399(R-9e e3): 救済の段階(race-day-rescue-stage.ts)は、アラーム・取得口・キャッシュに触れず、通知は材料を積むだけで送らない。段階を作る配線(core の new RescueStage)も、取得口・キャッシュ・アラームを渡さず、notifier そのものは渡さない(有無の boolean だけ)", () => {
    // 救済は、計画の表(会場・タスク)と判定の永続化(meta)と通知の材料(race_day_notify の ready の行)を書くだけで、netkeiba に直接出ず、アラームも張らず、Discord にも送らない
    // (張り直しは本体の armAlarm、送るのは NotifyStage)。切り出しによって、取得口・アラーム・送信の口を段階に渡せる余地が配線に移ったため、段階の本文と配線の両方を検査する。
    const stage = stripCode(readTextLf("cloud", "src", "race-day-rescue-stage.ts"));
    expect(stage.length).toBeGreaterThan(3000); // 前提: 段階のファイルを読めている
    expect(stage).toContain("this.notifyStore.putReady("); // 前提: 通知は材料を積む窓口(putReady)だけ
    expect(stage).toContain("this.enqueueTask(row.race_id,"); // 前提: タスクを積む窓口はこれ(注入された本体の関数)
    const stageForbidden = ["setAlarm(", "rearm(", "armAlarm(", "fetch(", "networkFetcher", "cacheOnly", "httpClient", "notifier.send"];
    const found = (text: string): string[] => stageForbidden.filter((f) => text.includes(f));
    expect(found(stage)).toEqual([]);
    // 対照(検出の確認。空振りでない): 禁止の文字列を含む本文は検出する
    expect(found(`${stage}\nthis.setAlarm(1);\nthis.notifier.send(x);`)).toEqual(["setAlarm(", "notifier.send"]);
    const core = stripCode(readTextLf("cloud", "src", "race-day-core.ts"));
    const wireStart = core.indexOf("new RescueStage({");
    expect(wireStart).toBeGreaterThan(-1);
    expect(core.indexOf("new RescueStage({", wireStart + 1)).toBe(-1); // 段階を作る箇所は 1 つ
    const wireEnd = core.indexOf("\n    });", wireStart);
    expect(wireEnd).toBeGreaterThan(wireStart);
    const wiring = core.slice(wireStart, wireEnd);
    expect(wiring.length).toBeGreaterThan(300); // 前提: 配線を実際に読めている
    expect(wiring).toContain("plan: this.plan,"); // 前提: 配線の中身を読めている(計画の表)
    expect(wiring).toContain("notifierEnabled: this.notifier !== undefined,"); // 送信の口は渡さず、有無だけを値で渡す
    for (const forbidden of ["setAlarm", "this.cache", "httpClient", "cacheOnly", "networkFetcher"]) {
      expect(wiring, `RescueStage の配線に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // notifier オブジェクトそのものを渡さない: this.notifier の出現は `this.notifier !== undefined` の形だけ
    const notifierRefs = wiring.match(/this\.notifier\b(?!\s*!==\s*undefined)/g) ?? [];
    expect(notifierRefs, "RescueStage の配線に notifier そのもの(this.notifier の !== undefined 以外の参照)が無い").toEqual([]);
    // 対照(検出の確認。空振りでない): notifier そのものを渡す配線は検出する
    expect(`${wiring}\n      notifier: this.notifier,`.match(/this\.notifier\b(?!\s*!==\s*undefined)/g) ?? []).toEqual(["this.notifier"]);
  });

  it("Issue #206: binding の使用箇所を概念で走査する(cloud/src の全ファイル)。env.RACE_DAY・env.NETKEIBA_GATE に触れるファイルと回数が固定で、新しい経路は赤になる", () => {
    const srcDir = path.join(ROOT, "cloud", "src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "client-bundle.generated.ts");
    expect(files.length).toBeGreaterThan(30); // 前提: 走査が空振りしていない
    const found: Record<string, { RACE_DAY: number; NETKEIBA_GATE: number }> = {};
    for (const f of files) {
      const c = stripCode(readTextLf("cloud", "src", f));
      const race = (c.match(/\benv\.RACE_DAY\b/g) ?? []).length;
      const gate = (c.match(/\benv\.NETKEIBA_GATE\b/g) ?? []).length;
      if (race + gate > 0) {
        found[f] = { RACE_DAY: race, NETKEIBA_GATE: gate };
      }
    }
    expect(found).toEqual({
      // 手動の入口: raceDayStub の 1 行(get と idFromName の 2 回)+ 確認用・health の gate(2 箇所 × 2 回)
      "handler.ts": { RACE_DAY: 2, NETKEIBA_GATE: 4 },
      // 定時の入口: DO の stub を 1 行で引く(get と idFromName の 2 回)。NETKEIBA_GATE には触れない
      "scheduled.ts": { RACE_DAY: 2, NETKEIBA_GATE: 0 },
      // DO の中: 取得の出口(gate)を引く 1 行(get と idFromName の 2 回)
      "race-day-do.ts": { RACE_DAY: 0, NETKEIBA_GATE: 2 },
      // 結果の補完の DO(Issue #217): 日単位の DO を引く 1 行・gate の状態(status)を読む 1 行(それぞれ get と idFromName の 2 回)。取得(fetchRaw・postRaw)は呼ばない(下の専用の検査)
      "result-backfill-do.ts": { RACE_DAY: 2, NETKEIBA_GATE: 2 },
    });
    // 対照(検出の確認。空振りでない): 余計な経路を足した本文は拾う
    expect(("const s = env.RACE_DAY.get(x);").match(/\benv\.RACE_DAY\b/g)).toHaveLength(1);
  });

  it("Issue #206 G-E3: GET /api/plan の関数(handlePlan)は読み取りの RPC だけを呼ぶ。取得・予約・計画の依頼・gate・D1・R2・LLM・Webhook に触れない", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = code.indexOf("async function handlePlan(");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("\n}\n", start);
    const body = code.slice(start, end);
    expect(body.length).toBeGreaterThan(500); // 前提: 本体を実際に読めている(空振りでない)
    expect(body).toContain(".getPlanProgress(");
    expect(body).toContain(".getAutoRunResults(");
    expect(body).toContain(".getNotifications(");
    expect(body).toContain(".getResultImportProgress("); // Issue #208: 結果の取り込みの観測(読み取り)
    expectCrossSiteCheckFirst("handlePlan", body, ["raceDayStub(", ".getPlanProgress("]);
    expect(body).toContain("raceDayStub(");
    for (const forbidden of [".schedule(", ".scheduleMany(", ".requestPlan(", ".requestResultImport(", "dispatchResultImports(", "D1ResultStore", ".getRaceList(", ".fetchRaw(", ".getBoard(", "NETKEIBA_GATE", "env.DB", "ANALYSIS_DETAIL", "ANTHROPIC", "DISCORD_WEBHOOK_URL", "webhook", "fetch("]) {
      expect(body, `handlePlan に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // DISCORD_WEBHOOK_URL を読むのは /api/health の「登録の有無」の 1 箇所だけ(値は返さない)
    expect((code.match(/env\.DISCORD_WEBHOOK_URL/g) ?? []).length).toBe(1);
    // 対照(検出の確認。空振りでない): 取得口を足した本文は拾う
    expect((body + "\nstub.getRaceList(a, b);").includes(".getRaceList(")).toBe(true);
  });

  it("Issue #336・#361: GET /api/targets の関数(handleTargets)と、その部品(targets-repository.ts・targets-view.ts・targets-ledger.ts)は読み取りだけ。D1 の集計と DO の getPlanProgress・getTargetsLedger(どちらも読み取り)の 2 つ以外は呼ばない。収支の計算は Worker でしない。R2・netkeiba・gate・LLM・Webhook に触れない", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = code.indexOf("async function handleTargets(");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("\n}\n", start);
    const body = code.slice(start, end);
    expect(body.length).toBeGreaterThan(500); // 前提: 本体を実際に読めている(空振りでない)
    for (const required of [".getPlanProgress(", ".getTargetsLedger(", "raceDayStub(", "D1TargetsStore", "env.DB"]) {
      expect(body, `handleTargets に ${required} がある`).toContain(required);
    }
    expectCrossSiteCheckFirst("handleTargets", body, ["env.DB", "D1TargetsStore", "raceDayStub("]);
    // DO の RPC は getPlanProgress と getTargetsLedger(Issue #361。収支の途中経過の計算。読み取りだけ。下の専用の検査)の 2 つだけ(`.get〇〇(` の出現を数える。時刻の `.getTime(` は DO ではないので除く)
    expect((body.match(/\.get(?!Time\()[A-Z][A-Za-z]*\(/g) ?? []).sort()).toEqual([".getPlanProgress(", ".getTargetsLedger("]);
    for (const forbidden of [".schedule(", ".scheduleMany(", ".requestPlan(", ".requestResultImport(", "dispatchResultImports(", ".getRaceList(", ".fetchRaw(", ".getBoard(", ".getAutoRunResults(", ".getNotifications(", ".getResultImportProgress(", "readLedger(", "buildTargetsLedger(", "computeVerifyReport", "NETKEIBA_GATE", "ANALYSIS_DETAIL", "D1AnalysisStore", "ANTHROPIC", "DISCORD_WEBHOOK_URL", "webhook", "fetch("]) {
      expect(body, `handleTargets に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 部品(D1 の読み取りと整形)も、R2・取得・LLM・通知を import も参照もしない
    for (const file of ["targets-repository.ts", "targets-view.ts", "targets-ledger.ts"]) {
      const part = stripCode(readTextLf("cloud", "src", file));
      expect(part.length, file).toBeGreaterThan(500); // 前提: 実際に読めている
      for (const forbidden of ["R2", "bucket", "Bucket", "gate", "Gate", "netkeiba", "anthropic", "Anthropic", "webhook", "Webhook", "fetch(", "cloudflare:workers"]) {
        expect(part, `${file} に ${forbidden} が無い`).not.toContain(forbidden);
      }
    }
    // 対照(検出の確認。空振りでない): 取得口・R2 を足した本文は拾う
    expect((body + "\nstub.getRaceList(a, b);").includes(".getRaceList(")).toBe(true);
    expect(("const b = env.ANALYSIS_DETAIL;").includes("ANALYSIS_DETAIL")).toBe(true);
  });

  it("Issue #361: 日単位の DO の RPC getTargetsLedger(収支の途中経過の計算)は読み取りだけ。状態を変えず、netkeiba・gate・R2・LLM・通知に出ない。Worker Free の CPU 10ms に収まらない計算なので、Worker ではなくここで行う", () => {
    const code = stripCode(readTextLf("cloud", "src", "race-day-do.ts"));
    const start = code.indexOf("getTargetsLedger(input");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("\n  }\n", start);
    const body = code.slice(start, end);
    expect(body.length).toBeGreaterThan(200); // 前提: 本体を実際に読めている(空振りでない)
    for (const required of ["getTargetsLedgerWire(", "this.core.getPlanProgress()", "this.core.getResultImportProgress()", "D1TargetsStore", "readLedger("]) {
      expect(body, `getTargetsLedger に ${required} がある`).toContain(required);
    }
    // 状態を変える・外に出る経路を呼ばない(this.core の呼び出しは、読み取りの 2 つだけ)
    expect((body.match(/this\.core\.[A-Za-z]+\(/g) ?? []).sort()).toEqual(["this.core.getPlanProgress(", "this.core.getResultImportProgress("]);
    for (const forbidden of ["schedule", "requestPlan", "requestResultImport", "fetchRaw", "postRaw", "NETKEIBA_GATE", "ANALYSIS_DETAIL", "ANTHROPIC", "DISCORD", "webhook", "fetch(", "setAlarm", "storage", ".put(", "D1ResultStore", "D1AnalysisStore", ".run(", ".exec("]) {
      expect(body, `getTargetsLedger に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 計算の本体(targets-ledger.ts)が呼ぶ DO・D1 は、渡された読み取り口だけ(自分では何にも触れない)。D1 の読み取り(targets-repository.ts)の SQL は SELECT だけ
    const ledger = stripCode(readTextLf("cloud", "src", "targets-ledger.ts"));
    expect(ledger).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE)\b/);
    const repo = stripCode(readTextLf("cloud", "src", "targets-repository.ts"));
    const verifyRead = stripCode(readTextLf("cloud", "src", "verify-read.ts"));
    for (const [file, source] of [["targets-repository.ts", repo], ["verify-read.ts", verifyRead]] as const) {
      expect(source, `${file} に書き込みの SQL が無い`).not.toMatch(/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|REPLACE INTO)\b/);
    }
    // 対照(検出の確認。空振りでない): 書き込み・取得を足した本文は拾う
    expect(("this.core.requestPlan(x);").match(/this\.core\.[A-Za-z]+\(/g)).toEqual(["this.core.requestPlan("]);
    expect(/\b(INSERT INTO|UPDATE \w+ SET)\b/.test("UPDATE analyses SET a = 1")).toBe(true);
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

  it("Issue #217: smoke は結果の補完を止めて動かす(CI の smoke が補完の窓〈JST 1:00〜6:00〉に当たっても、netkeiba に出ない)。設定を持つ(--config)すべての構成が vars() を通り、vars() が RESULT_BACKFILL_NIGHTLY_LIMIT:0 を渡す", () => {
    const smoke = stripCode(readTextLf("cloud", "smoke.ts"));
    expect(smoke.length).toBeGreaterThan(5000); // 前提: 読めている
    const start = smoke.indexOf("function vars(");
    expect(start).toBeGreaterThan(-1);
    const body = smoke.slice(start, smoke.indexOf("\n}\n", start));
    expect(body).toContain('"--var", "RESULT_BACKFILL_NIGHTLY_LIMIT:0"');
    // withWorker の呼び出しのうち、設定ファイル(--config)を使うもの(認証の設定を持つ構成)は、すべて ...vars( を含む
    const calls = [...smoke.matchAll(/await withWorker\([^\n]*\n/g)].map((m) => m[0]);
    const withConfig = calls.filter((c) => c.includes("--config"));
    expect(calls.length).toBeGreaterThanOrEqual(8); // 前提: 検出が空振りでない(構成は 1 つの無設定 + 7 つの設定つき)
    expect(withConfig.length).toBe(calls.length - 1);
    for (const c of withConfig) {
      expect(c, c.trim()).toContain("...vars(");
    }
    // 無設定の構成(認証の設定が無く、全リクエストが 403)は DO に届かない
    expect(calls.filter((c) => !c.includes("--config"))).toHaveLength(1);
    // 対照(検出の確認。空振りでない)
    expect(("await withWorker(1, [\"--config\", P], async () => {\n").includes("...vars(")).toBe(false);
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

  /**
   * 番号が 1 から欠番なく連続しているか。ただし `reserved` に挙げた番号は、まだこの枝に無くてよい(別の Issue が使う予約。あれば普通に連続の一部)。
   * 予約: 0011(#259)・0012(#226)・0013(#72)は 2026-10-12 の公開でそろったので、予約は空にした。番号を決め打ちで先に使う Issue があるときは、ここに予約を足す。
   */
  const isContinuousExceptReserved = (numbers: readonly number[], reserved: ReadonlySet<number>): boolean => {
    let expected = 1;
    for (const n of numbers) {
      while (reserved.has(expected) && expected !== n) {
        expected += 1;
      }
      if (n !== expected) {
        return false;
      }
      expected += 1;
    }
    return true;
  };
  const RESERVED_NUMBERS: ReadonlySet<number> = new Set<number>();

  it("ファイル名は NNNN_名前.sql(小文字・数字・アンダースコア)で、番号は 0001 から欠番なく連続している(予約は今は無い)", () => {
    expect(files.length).toBeGreaterThan(0);
    files.forEach((f) => {
      expect(f, `${f} の名前`).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    });
    expect(isContinuousExceptReserved(files.map((f) => Number(f.slice(0, 4))), RESERVED_NUMBERS), files.join(",")).toBe(true);
  });

  it("検出の確認(空振りでない): 欠番・重複・順序の乱れを拾う(予約が無いので、0011〜0014 のどれが欠けても拾う)", () => {
    const ok = (nums: number[]): boolean => isContinuousExceptReserved(nums, RESERVED_NUMBERS);
    expect(ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).toBe(true); // 今の枝(0014 は #256 の horse_runs)
    expect(ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14])).toBe(false); // 0013 の欠番
    expect(ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(true);
    expect(ok([1, 2, 4])).toBe(false); // 欠番
    expect(ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13])).toBe(false); // 0011・0012 の欠番
    expect(ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13])).toBe(false); // 0012 の欠番
    // 予約の仕組み自体の検出力(予約した番号だけは無くてよく、予約を理由に後ろの番号を飛ばしてはいけない)
    expect(isContinuousExceptReserved([1, 3], new Set([2]))).toBe(true);
    expect(isContinuousExceptReserved([1, 4], new Set([2]))).toBe(false);
    expect(ok([2, 3])).toBe(false); // 0001 から始まらない
    expect(ok([1, 2, 2])).toBe(false); // 重複
    expect(ok([1, 3, 2])).toBe(false); // 順序の乱れ
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
  // Issue #193(#179-a): `@anthropic-ai/sdk` を足した(core の anthropic-client.ts・model-selection.ts が値で import する。cheerio と同じく、cloud/node_modules へ向ける)。
  const ALIAS_KEYS = ["undici", "iconv-lite", "cheerio", "@anthropic-ai/sdk"];
  /** TOML の素のキーは英数字・`_`・`-` だけ。`@`・`/` を含むキーは引用符が要る。 */
  const tomlKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : `"${key}"`);
  /**
   * Issue #176(#164-a): runAnalysis(app)が import する core のサブパス。wrangler の alias は完全一致なので1行ずつ要る。
   * 行き先は packages/core/src の実ファイル(依存の行き先〈cloud/node_modules・スタブ〉とは違い、リポジトリに入っているソース。CI にも在る)。
   * tsconfig.json の paths は `@keiba/core/*` の前方一致、vitest.config.ts の alias は `@keiba/core` の前方一致。
   */
  // Issue #193: `llm`(LLM 用の狭い入口。analyze-race・anthropic-client・model-selection)を足した。
  // Issue #286(#285 の段階A): runAnalysis が packages/core/src/analysis/ へ移り、core の中で相対 import になったため、cloud/src が直接 import するサブパスは `pipeline`・`llm` の2つになった
  // (旧: `scorer/snapshot-filter`・`ev/bet-allocation`・`ev/combo-bet-allocation` も alias に要った)。cloud/test/import-guard.test.ts が、閉包が使うサブパスとこの行の一致を検査する。
  const CORE_SUBPATHS = ["pipeline", "llm"];

  it("nodejs_compat を有効にしている(core の HttpClient・iconv-lite が Buffer を使う)", () => {
    expect(tomlCode).toMatch(/^compatibility_flags = \["nodejs_compat"\]$/m);
  });

  it("wrangler.toml の [alias]・tsconfig.json の paths・vitest.config.ts の alias が、同じ4つの依存を同じ行き先へ向ける(CI にだけ効く設定の書き忘れを防ぐ)", () => {
    const aliasBlock = /^\[alias\]\n((?:[^\n[]+\n?)+)/m.exec(tomlCode)?.[1] ?? "";
    // 前提: [alias] を実際に読めている(空振りではない)
    expect(aliasBlock).not.toBe("");
    const tsconfig = readTextLf("cloud", "tsconfig.json");
    const vitestConfig = readTextLf("cloud", "vitest.config.ts");
    const target: Record<string, string> = {
      undici: "./src/undici-stub.ts",
      "iconv-lite": "./node_modules/iconv-lite",
      cheerio: "./node_modules/cheerio",
      "@anthropic-ai/sdk": "./node_modules/@anthropic-ai/sdk",
    };
    for (const key of ALIAS_KEYS) {
      expect(aliasBlock, `[alias] に ${key}`).toContain(`${tomlKey(key)} = "${target[key]}"`);
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
    // [alias] に余計な行き先が無い(依存4つ + core のサブパス)
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

  it("cheerio・iconv-lite・@anthropic-ai/sdk は固定版で、追加理由が //deps にある", () => {
    const pkg = JSON.parse(readTextLf("cloud", "package.json")) as {
      dependencies: Record<string, string>;
      "//deps": Record<string, string>;
    };
    for (const name of ["cheerio", "iconv-lite", "@anthropic-ai/sdk"]) {
      expect(pkg.dependencies[name], `${name} の版`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg["//deps"][name], `${name} の理由`).toBeTruthy();
    }
  });

  // Issue #324: 以前は SDK だけを検査していた。Dependabot が core 側だけを上げて cloud を上げなかった(#321)ので、core と cloud が版を揃えている 3 つ全部を同じ形で検査する。
  it.each(["@anthropic-ai/sdk", "iconv-lite", "cheerio"])(
    "%s は core と同じ版(core の範囲 `^X.Y.Z` の X.Y.Z)で、cloud/pnpm-lock.yaml にその版で固定されている(CI の --frozen-lockfile が通る前提)",
    (name) => {
      const cloudPkg = JSON.parse(readTextLf("cloud", "package.json")) as { dependencies: Record<string, string> };
      const corePkg = JSON.parse(readTextLf("packages", "core", "package.json")) as { dependencies: Record<string, string> };
      const version = cloudPkg.dependencies[name] ?? "";
      // 前提(空振り防止): 両方の版を実際に読めている
      expect(version, `cloud の ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(corePkg.dependencies[name], `core の ${name}`).toMatch(/^\^\d+\.\d+\.\d+$/);
      expect(corePkg.dependencies[name]).toBe(`^${version}`);
      const lock = readTextLf("cloud", "pnpm-lock.yaml");
      const escaped = version.replace(/\./g, "\\.");
      const key = name.replace(/[/@]/g, (c) => `\\${c}`);
      expect(lock).toMatch(new RegExp(`\n {6}'?${key}'?:\n\\s+specifier: ${escaped}\n\\s+version: ${escaped}\n`));
    },
  );
});

describe("cloud/ はワークスペースの外(既存の CI のインストールを重くしない)", () => {
  it("pnpm-workspace.yaml は packages/* だけで、cloud を含まない", () => {
    const workspace = readTextLf("pnpm-workspace.yaml");
    expect(workspace).toContain("packages/*");
    expect(workspace).not.toMatch(/cloud/);
  });

  it("Issue #324: cloud/pnpm-workspace.yaml は空のワークスペース(`packages: []`)。Dependabot の pnpm が親(ルート)のワークスペースを更新せず、cloud の lockfile を更新するための目印", () => {
    // 背景: Dependabot は `cloud/` で `pnpm update … -r` を実行するが、`--ignore-workspace` は渡せない。cloud/ に pnpm-workspace.yaml が無いと、
    // pnpm が親のルートの pnpm-workspace.yaml を見つけて「ルート+packages/core」を更新し、cloud/pnpm-lock.yaml は更新されなかった(#321 の実ログ: `Scope: all 2 workspace projects`)。
    // 空のワークスペースを置くと cloud/ 自身がルートになる。`pnpm install --ignore-workspace` はそのまま使える(CI・deploy-cloud.yml)。
    expect(existsSync(path.join(ROOT, "cloud", "pnpm-workspace.yaml"))).toBe(true);
    const code = readTextLf("cloud", "pnpm-workspace.yaml")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
      .map((l) => l.trim());
    expect(code).toEqual(["packages: []"]);
    // ルート側は変えない(packages/* だけ)。cloud/ をメンバーにすると、既存の CI のインストールが重くなる
    expect(readTextLf("pnpm-workspace.yaml")).not.toMatch(/cloud/);
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

  it("Issue #332: @types/node のメジャーは CI の Node(node-version)のメジャーと同じ。Node を上げるときは両方を手で上げる(Dependabot は @types/node の semver-major を提案しない)", () => {
    const pkg = JSON.parse(readTextLf("cloud", "package.json")) as { devDependencies: Record<string, string> };
    const typesMajor = /^\^?(\d+)\./.exec(pkg.devDependencies["@types/node"] ?? "")?.[1];
    expect(typesMajor, "cloud/package.json の @types/node の範囲からメジャーが読める").toBeDefined();
    const nodeMajors = new Set<string>();
    let count = 0;
    for (const wf of ["ci.yml", "deploy-cloud.yml", "research.yml"]) {
      for (const m of readTextLf(".github", "workflows", wf).matchAll(/^\s*node-version: (\d+)\s*$/gm)) {
        nodeMajors.add(m[1]!);
        count++;
      }
    }
    expect(count, "node-version の指定を実際に読めている(空振り防止)").toBeGreaterThanOrEqual(5);
    expect([...nodeMajors], "ワークフローの node-version は全部同じメジャー").toHaveLength(1);
    expect([...nodeMajors][0]).toBe(typesMajor);
  });

  it("Issue #332: cloud の .ts は `fileURLToPath(new URL(…))` と書かない(グローバルの URL は workers-types のもので、@types/node 24 以上では node:url の URL と型が合わず TS2345)。test/meta-path.ts の pathFromMeta を使う", () => {
    const helper = readTextLf("cloud", "test", "meta-path.ts");
    expect(helper).toMatch(/new URL\(relative, metaUrl\)\.href/); // 文字列で渡す
    // 変換ヘルパ自身は `.href` で文字列にして渡す形で、上で固定済み。それ以外の .ts を検査する
    const tsFiles = scanTargets().filter((f) => f.startsWith("cloud/") && f.endsWith(".ts") && f !== "cloud/test/meta-path.ts");
    expect(tsFiles.length, "走査した .ts が十分ある(空振り防止)").toBeGreaterThan(100);
    const offenders = tsFiles.filter((f) => /fileURLToPath\(\s*new\s+URL\(/.test(readTextLf(...f.split("/"))));
    expect(offenders).toEqual([]);
  });

  it("Issue #333: cloud の .ts は `new URL(…, import.meta.url)` を URL のまま Node の API(readFileSync 等)へ渡さない(@types/node 24 以上では型が合わない: 呼び方によって TS2769(`readFileSync(URL, 'utf8')`・`readdirSync(URL)` など)または TS2345(`readFileSync(URL)`〈エンコーディング引数なし〉・`existsSync`・`fileURLToPath` など)になる。`.href` の文字列にするとファイルとして開けず実行時に落ちるので、test/meta-path.ts の pathFromMeta でファイルシステムのパスにして渡す)", () => {
    const tsFiles = scanTargets().filter((f) => f.startsWith("cloud/") && f.endsWith(".ts") && f !== "cloud/test/meta-path.ts");
    expect(tsFiles.length, "走査した .ts が十分ある(空振り防止)").toBeGreaterThan(100);
    // 走査関数の自己検査: 検出すべき形は検出し、許す形(`fileURLToPath(…).href`・meta URL を含まない `new URL`)は検出しない(これが無いと、空振りの走査で常に緑になる)
    const violations = findMetaUrlViolations;
    // 従来から検出していた形(単行。ダブルクォート・テンプレートリテラル)
    expect(violations('readFileSync(new URL("../a.sql", import.meta.url), "utf-8")')).toHaveLength(1);
    expect(violations("readFileSync(new URL(`../${x}`, import.meta.url), \"utf-8\")")).toHaveLength(1);
    // 従来は取りこぼしていた形(Issue #373)
    expect(violations('readFileSync(new URL(\n  "../a.sql",\n  import.meta.url\n), "utf-8")'), "複数行(import.meta.url の後ろに改行)").toHaveLength(1);
    expect(violations('readFileSync(new URL("../a.sql", import.meta.url,), "utf-8")'), "末尾のカンマ").toHaveLength(1);
    expect(violations('readFileSync(new URL(\n  "../a.sql",\n  import.meta.url,\n))'), "複数行 + 末尾のカンマ").toHaveLength(1);
    expect(violations("readFileSync(new URL(`../${name(x)}.sql`, import.meta.url))"), "引数の中の括弧").toHaveLength(1);
    expect(violations("readFileSync(new URL(`../${a(b(c))}.sql`, import.meta.url))"), "引数の中の括弧(入れ子)").toHaveLength(1);
    expect(violations('readFileSync(new URL("../a(1).sql", import.meta.url))'), "文字列リテラルの中の括弧(対応している)").toHaveLength(1);
    expect(violations('readFileSync(new URL("../a).sql", import.meta.url))'), "文字列リテラルの中の閉じ括弧だけ(対応していない)").toHaveLength(1);
    expect(violations("readFileSync(new URL(`../a).sql`, import.meta.url))"), "テンプレートリテラルの中の閉じ括弧だけ(対応していない)").toHaveLength(1);
    expect(violations('readFileSync(new URL("../a.sql", import.meta.url).href, "utf-8")'), "`.href` を fs の API へ直接渡す").toHaveLength(1);
    expect(violations('const u = new URL("../a.sql", import.meta.url).href;\nreadFileSync(u)'), "`.href` を fileURLToPath 以外へ渡す(変数に入れる)").toHaveLength(1);
    expect(violations('fileURLToPath(new URL("../a.sql", import.meta.url))'), "`.href` なしの fileURLToPath の引数").toHaveLength(1);
    expect(violations('a(new URL("x", import.meta.url));\nb(new URL("y", import.meta.url));'), "1 ファイルに 2 件").toHaveLength(2);
    // 検出してはいけない形
    expect(violations('fileURLToPath(new URL("../a.sql", import.meta.url).href)'), "fileURLToPath の直接の引数の `.href`(test/meta-path.ts と同じ形)").toHaveLength(0);
    expect(violations('fileURLToPath(\n  new URL("../a.sql", import.meta.url).href,\n)'), "同(複数行)").toHaveLength(0);
    expect(violations("const u = new URL(request.url);\nfoo(import.meta.url);"), "meta URL が別の文にあるだけ").toHaveLength(0);
    expect(violations('readFileSync(pathFromMeta("../a.sql", import.meta.url), "utf-8")'), "pathFromMeta を使う正しい形").toHaveLength(0);
    expect(violations('new URL("x", base)'), "meta URL を含まない new URL").toHaveLength(0);
    expect(violations('new URL(")" + y); foo(import.meta.url)'), "文字列の中の閉じ括弧に惑わされない").toHaveLength(0);
    expect(violations('new URL("(" + y); foo(import.meta.url)'), "文字列の中の開き括弧に惑わされない").toHaveLength(0);
    const offenders = tsFiles.filter((f) => findMetaUrlViolations(readTextLf(...f.split("/"))).length > 0);
    expect(offenders).toEqual([]);
  });

  it(".gitignore が node_modules・.wrangler・スモークの一時設定を除外する", () => {
    const gi = readTextLf("cloud", ".gitignore");
    for (const entry of ["node_modules/", ".wrangler/", "dist-dry/", "wrangler.smoke.generated.toml", "wrangler.smoke-fake.generated.toml", "wrangler.bundle-guard.generated.toml", "native-probe.generated.ts", "wrangler.native-probe.generated.toml"]) {
      expect(gi.split("\n")).toContain(entry);
    }
  });
});

/**
 * `new URL(…)` の引数に `import.meta.url` を含む呼び出しのうち、違反の形のものを(該当箇所の文字列で)返す(Issue #333・#373)。
 * 違反でないのは、`.href` の文字列にして **`fileURLToPath(` の直接の引数**に渡す形(test/meta-path.ts の形。`fileURLToPath(new URL(…))` と書く形は #332 の検査が別に禁じる)だけ。
 * 括弧の対応を数えて引数の範囲を決める(複数行・末尾のカンマ・引数の中の括弧に依らない)。文字列リテラル(' " `)の中の括弧は数えない。
 * 限界:
 *  - 正規表現ではなく字句の走査だが、構文解析ではない。テンプレートリテラルの `${…}` の中に別のテンプレートリテラル(入れ子のバッククォート)があると、閉じ括弧の位置を誤りうる。
 *  - データフロー(`const u = new URL(…, import.meta.url).href;` を作ってから fs の API に渡す)は追わない。`.href` は `fileURLToPath(` の直接の引数でなければ、その時点で違反とする(変数に入れた形も違反として検出する)。
 *    `.href` を fs 以外の用途(例: import() の指定)に使う正当な形は想定しない。必要になったら、この関数の許可条件を見直す。
 *  - **コメントの中の記述も違反として数える**(従来の正規表現と同じ挙動。コメント除去で本物の違反を隠すより、コメントを書き換える方を選ぶ)。
 */
function findMetaUrlViolations(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/new\s+URL\s*\(/g)) {
    const open = m.index! + m[0].length;
    let depth = 1;
    let i = open;
    let quote: string | null = null;
    while (i < source.length && depth > 0) {
      const c = source[i]!;
      if (quote !== null) {
        if (c === "\\") i++; // エスケープ(次の 1 字を飛ばす)
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"' || c === "`") {
        quote = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
      i++;
    }
    const args = source.slice(open, i - 1);
    if (!args.includes("import.meta.url")) continue;
    const href = /^\s*\.href\b/.test(source.slice(i));
    const wrapped = /fileURLToPath\(\s*$/.test(source.slice(0, m.index!));
    if (!(href && wrapped)) found.push(source.slice(m.index!, Math.min(source.length, i + 8)));
  }
  return found;
}

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

describe("Issue #216・#394・#402: 移行の DO(CloudMigration)は削除済みで、殻のソースも export も無く、定時の自動実行(cron → RaceDay)と干渉しない", () => {
  it("殻のソース(src/migration-do.ts)は存在せず、本番の入口(worker.ts)とスモークの入口(smoke-worker.ts)は CloudMigration を export しない。src の他のファイルも CloudMigration・migration-do を参照しない", () => {
    expect(existsSync(path.join(ROOT, "cloud", "src", "migration-do.ts")), "migration-do.ts が無い").toBe(false);
    // 前提(空振り防止): 入口を読めていて、他の DO のクラスを export している
    for (const entry of [path.join("src", "worker.ts"), "smoke-worker.ts"]) {
      const code = stripCode(readTextLf("cloud", entry));
      expect(code, `${entry} を読めている(他の DO の export がある)`).toMatch(/export \{ ResultBackfill \} from/);
      expect(code, `${entry} は CloudMigration を参照しない`).not.toMatch(/CloudMigration|CLOUD_MIGRATION|migration-do/);
    }
    const srcDir = path.join(ROOT, "cloud", "src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length, "src の .ts を読めている").toBeGreaterThan(20);
    for (const f of files) {
      expect(stripCode(readTextLf("cloud", "src", f)), `${f} は移行の DO を参照しない`).not.toMatch(/CloudMigration|CLOUD_MIGRATION|migration-do/);
    }
  });

  it("cron の scheduled・RaceDay・result-dispatch は、移行の DO を呼ばない(CLOUD_MIGRATION・CloudMigration・migration-* を参照しない)", () => {
    for (const f of ["scheduled.ts", "race-day-do.ts", "race-day-core.ts", "result-dispatch.ts", "netkeiba-gate-do.ts"]) {
      const code = stripCode(readTextLf("cloud", "src", f));
      expect(code.length, `${f} を読めている`).toBeGreaterThan(500);
      expect(code, `${f} は移行を参照しない`).not.toMatch(/CLOUD_MIGRATION|CloudMigration|migration-core|migration-do/);
    }
  });

  it("Issue #217: 結果の補完は netkeiba に直接は出ない(取得は日単位の DO が行う)。補完の DO の呼び出し箇所は固定(kick は scheduled.ts の 1 つ、handler.ts は getStatus だけ)。補完のコードは gate の status() だけを読む", () => {
    const srcDir = path.join(ROOT, "cloud", "src");
    const core = stripCode(readTextLf("cloud", "src", "result-backfill-core.ts"));
    const doCode = stripCode(readTextLf("cloud", "src", "result-backfill-do.ts"));
    const scheduled = stripCode(readTextLf("cloud", "src", "scheduled.ts"));
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    for (const [name, code] of [["result-backfill-core.ts", core], ["result-backfill-do.ts", doCode]] as const) {
      expect(code.length, `${name} を読めている`).toBeGreaterThan(1500);
      // 取得口(gate の fetchRaw・postRaw・一覧・予約・計画の依頼)も、LLM・通知・R2 も持たない
      for (const forbidden of [".fetchRaw(", ".postRaw(", ".schedule(", ".scheduleMany(", ".getRaceList(", ".requestPlan(", ".requestResultImport(", "ANTHROPIC", "DISCORD", "ANALYSIS_DETAIL", "HttpClient", "CachedFetcher"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
      expect((code.match(/(^|[^.\w])fetch\(/g) ?? []).length, `${name} にグローバルの fetch が無い`).toBe(0);
    }
    // 補完が日単位の DO に呼ぶのは、dispatchResultImports 経由の依頼と、進行の読み取り(getResultImportProgress)だけ
    expect((core.match(/\.getResultImportProgress\(/g) ?? []).length).toBe(1);
    expect((core.match(/(?<!function\s)\bdispatchResultImports\(/g) ?? []).length).toBe(1);
    // DO の中: gate は status() を 1 回読むだけ(Issue #394: 移行の DO は読まない。CLOUD_MIGRATION を参照しない)
    expect((doCode.match(/\.status\(\)/g) ?? []).length).toBe(1);
    expect(doCode).not.toMatch(/CLOUD_MIGRATION|CloudMigration|MIGRATION_NAME|migrationState/);
    expect(core).not.toMatch(/MigrationState|migrationState|waiting-migration/);
    expect(doCode).not.toMatch(/\.start\(/); // 移行の取り込みを始めさせない
    // 補完の DO の呼び出し箇所(cloud/src の全ファイルを概念で走査)
    const kickSites: Record<string, number> = {};
    const bindingSites: Record<string, number> = {};
    for (const f of readdirSync(srcDir).filter((x) => x.endsWith(".ts") && x !== "client-bundle.generated.ts")) {
      const c = stripCode(readTextLf("cloud", "src", f));
      const k = (c.match(/\.kick\(\)/g) ?? []).length;
      if (k > 0) kickSites[f] = k;
      const b = (c.match(/\benv\.RESULT_BACKFILL\b/g) ?? []).length;
      if (b > 0) bindingSites[f] = b;
    }
    // kick を呼ぶのは scheduled.ts(毎日の起動)と result-backfill-do.ts(DO 自身が getStatus・kick の RPC から core に委譲する 2 つ)だけ
    expect(kickSites).toEqual({ "result-backfill-do.ts": 2, "scheduled.ts": 1 });
    // env.RESULT_BACKFILL に触れるのは scheduled.ts(有無の確認・get・idFromName の 3 回)と handler.ts(namespace 変数への代入の 1 回)だけ
    expect(bindingSites).toEqual({ "handler.ts": 1, "scheduled.ts": 3 });
    // handler.ts: 補完の DO は getStatus だけ(kick・start は呼ばない)。GET /api/results/backfill の 1 本
    const start = handler.indexOf("async function handleBackfillStatus(");
    expect(start).toBeGreaterThan(-1);
    const body = handler.slice(start, handler.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(300); // 前提: 本体を実際に読めている
    expect(body).toContain(".getStatus()");
    for (const forbidden of [".kick(", ".start(", ".requestResultImport(", "dispatchResultImports(", "NETKEIBA_GATE", "RACE_DAY", "env.DB", "ANALYSIS_DETAIL", "fetch("]) {
      expect(body, `handleBackfillStatus に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // scheduled.ts は kick だけ(getStatus・start を呼ばない)
    expect(scheduled).not.toMatch(/\.getStatus\(/);
    // 対照(検出の確認。空振りでない)
    expect(("a.kick();\nb.kick();".match(/\.kick\(\)/g) ?? []).length).toBe(2);
    expect((core + "\nstub.fetchRaw(x);").includes(".fetchRaw(")).toBe(true);
  });

  it("Issue #394: 移行の DO は呼ばれない(handler.ts に migrationStub・CLOUD_MIGRATION・/api/migration が無い)。stub.start( の呼び出しも無い", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    expect(handler.length).toBeGreaterThan(1000); // 前提: 読めている
    expect(handler).not.toMatch(/migrationStub|CLOUD_MIGRATION|MigrationStubLike|\/api\/migration/);
    expect((handler.match(/\bstub\.start\(/g) ?? []).length).toBe(0);
    // 検出の確認(空振りでない)
    expect(("a stub.start(x);\nb stub.start(y);".match(/\bstub\.start\(/g) ?? []).length).toBe(2);
  });
});

describe("Issue #219: 検証の集計(VerifyReportDO)は netkeiba にも LLM にも出ず、他の DO・cron と干渉せず、Worker は D1・R2 に触れない", () => {
  const verifySources = ["verify-core.ts", "verify-do.ts", "verify-store.ts", "verify-read.ts", "verify-breakdown.ts"].map((f) => [f, stripCode(readTextLf("cloud", "src", f))] as const);

  it("検証のソース(5 ファイル。Issue #384 で verify-breakdown.ts を足した)に、netkeiba の取得口・RaceDay・LLM・Discord・グローバルの fetch・他の DO が無い", () => {
    expect(verifySources).toHaveLength(5);
    for (const [name, code] of verifySources) {
      expect(code.length, `${name} を読めている`).toBeGreaterThan(500);
      for (const forbidden of ["NETKEIBA_GATE", "fetchRaw", "postRaw", "RACE_DAY", "RaceDay", "CLOUD_MIGRATION", "RESULT_BACKFILL", "ANTHROPIC", "DISCORD", "createCloudLlm", "createDiscordNotifier", "createGateHttpClient", "socket"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
      expect((code.match(/(^|[^.\w])fetch\(/g) ?? []).length, `${name} にグローバルの fetch が無い`).toBe(0);
    }
  });

  it("D1・R2 の読み書きは verify-store.ts だけ。R2 は get だけ(put・list・head・delete を使わない)、D1 の書き込みは analyses.start_time の補完と r2_ops の Class B の加算の 2 文だけ", () => {
    const store = verifySources.find(([n]) => n === "verify-store.ts")![1];
    expect(store).toContain("this.bucket.get(");
    for (const forbidden of [".put(", ".list(", ".head(", ".delete(", "DELETE FROM", "INSERT INTO analyses", "INSERT INTO race_", "UPDATE race_", "UPDATE analysis_"]) {
      expect(store, `verify-store.ts に ${forbidden} が無い`).not.toContain(forbidden);
    }
    expect((store.match(/UPDATE analyses SET start_time/g) ?? []).length).toBe(1);
    expect((store.match(/INSERT INTO r2_ops/g) ?? []).length).toBe(1);
    // 型 VerifyBucket は get だけを許す
    expect(store).toMatch(/type VerifyBucket = Pick<R2Bucket, "get">/);
    // ほかの検証のソースは D1・R2 に直接触れない(core は注入された窓口だけを使う)
    for (const [name, code] of verifySources.filter(([n]) => n === "verify-core.ts" || n === "verify-read.ts" || n === "verify-breakdown.ts")) {
      for (const forbidden of ["env.DB", "ANALYSIS_DETAIL", ".prepare(", ".batch("]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
    }
  });

  it("Issue #267: GET /api/netkeiba/check の関数(handleCheck)は、ゲートに触れる前に Sec-Fetch-Site を見て、request を受け取る(別サイトからの取得を起こさせない)", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = code.indexOf("async function handleCheck(");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(500); // 前提: 本体を実際に読めている(空振りでない)
    // 前提: ゲートに触れる呼び出し(binding・取得・POST・状態)が本体にある。順序の検査が空振りにならない
    const gateTouches = ["NETKEIBA_GATE", ".fetchRaw(", ".postRaw(", ".status("];
    for (const touch of gateTouches) {
      expect(body, `handleCheck に ${touch} がある(前提)`).toContain(touch);
    }
    expectCrossSiteCheckFirst("handleCheck", body, gateTouches);
    // ヘッダを見るには request が要る(url だけを受け取る形に戻すと、検査を書けない)
    expect(code.slice(start, code.indexOf("{", start))).toMatch(/\(\s*request\s*:\s*Request\s*,\s*env\s*:\s*Env\s*\)/);
    // 呼び出しは 1 箇所だけで、request を渡す
    expect((code.match(/\bhandleCheck\(/g) ?? []).length).toBe(2); // 定義 1 + 呼び出し 1
    expect(code).toContain("handleCheck(request, env)");
    // 対照(検出の確認。空振りでない): 検査より後にゲートに触れる本体は「前」の検査を満たさない
    const bad = 'async function handleCheck(request: Request, env: Env) {\n  const g = env.NETKEIBA_GATE;\n  const crossSite = crossSiteRejection(request);\n  if (crossSite !== null) {\n    return crossSite;\n  }\n}';
    expect(bad.indexOf(CROSS_SITE_CALL) < bad.indexOf("NETKEIBA_GATE")).toBe(false);
    expect(() => expectCrossSiteCheckFirst("bad", bad, ["NETKEIBA_GATE"])).toThrow(); // 検出器が悪い例を実際に拒否する(空振りでない)
  });

  it("Issue #397(R-4): 別サイトからの GET の拒否は crossSiteRejection の 1 つに集約されている。ヘルパーは Sec-Fetch-Site が none・same-origin 以外なら 403 origin-mismatch。呼び出しは 8 ルート(関数名の一覧つき)で、各ルートは D1・DO・gate に触れる前に呼ぶ。インラインの検査が戻っていない", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    expect(code.length).toBeGreaterThan(1000); // 前提: 読めている
    const bodyOf = (signature: string): string => {
      const start = code.indexOf(signature);
      expect(start, `${signature} がある`).toBeGreaterThan(-1);
      return code.slice(start, code.indexOf("\n}\n", start));
    };
    // ヘルパー自体: 定義は 1 つ。ヘッダ名・none・same-origin を見て、拒否なら originMismatch() の応答、通すなら null
    expect((code.match(/\bfunction crossSiteRejection\(/g) ?? []).length).toBe(1);
    const helper = bodyOf("function crossSiteRejection(");
    for (const needle of ['"sec-fetch-site"', '"same-origin"', '"none"', "originMismatch()", "null"]) {
      expect(helper, `crossSiteRejection に ${needle} がある`).toContain(needle);
    }
    expect(helper).toMatch(/site !== null && site !== "same-origin" && site !== "none"/); // 3 値のうち「ヘッダなし・same-origin・none」だけを通す
    // 拒否の応答: 固定の本文の 403
    const mismatch = bodyOf("function originMismatch(");
    expect(mismatch).toContain('{ ok: false, error: { type: "origin-mismatch" } }, 403');
    // Sec-Fetch-Site を読む関数は、このヘルパーと POST の Origin の確認(originAllowed。別物)の 2 つだけ(インラインの検査が戻っていない)
    const functionStarts = [...code.matchAll(/^(?:async )?function (\w+)\(/gm)].map((m) => ({ name: m[1]!, index: m.index! }));
    const enclosing = (index: number): string => functionStarts.filter((f) => f.index <= index).at(-1)!.name;
    const siteReaders = [...code.matchAll(/"sec-fetch-site"/g)].map((m) => enclosing(m.index!));
    expect(siteReaders.sort()).toEqual(["crossSiteRejection", "originAllowed"]);
    // 呼び出し箇所: 8 つで、関数名の一覧が固定(handleRaces を含む)
    const callers = [...code.matchAll(/\bcrossSiteRejection\(request\)/g)].map((m) => enclosing(m.index!));
    expect(callers.sort()).toEqual(["handleBabaFetch", "handleCheck", "handleHorseRuns", "handlePlan", "handlePriorExport", "handleRaces", "handleTargets", "handleVerify"]);
    expect(callers).toHaveLength(8);
    // handleRaces(GET が netkeiba に出る): DO を呼ぶ前に検査する(他の 7 つは各ハンドラの検査が持つ)
    expectCrossSiteCheckFirst("handleRaces", bodyOf("async function handleRaces("), ["raceDayStub(", ".getRaceList("]);
    // 対照(検出の確認。空振りでない): 呼び出しを足した本文は 9 つに数える。インラインの検査は「sec-fetch-site を読む関数」に数えられる
    expect(((code + "\nasync function handleX(request: Request) {\n  crossSiteRejection(request);\n}").match(/\bcrossSiteRejection\(request\)/g) ?? []).length).toBe(9);
    expect([...(code + '\nfunction handleY(request: Request) {\n  request.headers.get("sec-fetch-site");\n}').matchAll(/"sec-fetch-site"/g)]).toHaveLength(3);
    expect(() => expectCrossSiteCheckFirst("結果を返さない", "async function f(request: Request) {\n  crossSiteRejection(request);\n  env.DB;\n}", ["env.DB"])).toThrow();
  });

  it("Issue #256: GET /api/horse-runs の関数(handleHorseRuns)は、D1 に触れる前に Sec-Fetch-Site を見て、request を受け取る。読み取り(readHorseRunsStatus)だけで、取得・LLM・Webhook・DO・R2・書き込みに触れない", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = code.indexOf("async function handleHorseRuns(");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(800); // 前提: 本体を実際に読めている(空振りでない)
    expect(body).toContain("readHorseRunsStatus(env.DB");
    expectCrossSiteCheckFirst("handleHorseRuns", body, ["env.DB"]); // Sec-Fetch-Site の検査は D1 に触れるより前
    for (const forbidden of ["NETKEIBA_GATE", "RACE_DAY", "RESULT_BACKFILL", "CLOUD_MIGRATION", "VERIFY_REPORT", "PRIOR_EXPORT", "ANALYSIS_DETAIL", ".fetchRaw(", ".prepare(", ".batch(", ".run(", "INSERT", "UPDATE", "DELETE", "ANTHROPIC", "DISCORD_WEBHOOK_URL", "fetch("]) {
      expect(body, `handleHorseRuns に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // ヘッダを見るには request が要る。呼び出しは 1 箇所だけで、request を渡す
    expect(code.slice(start, code.indexOf("{", start))).toMatch(/\(\s*request\s*:\s*Request\s*,\s*env\s*:\s*Env\s*,/);
    expect((code.match(/\bhandleHorseRuns\(/g) ?? []).length).toBe(2); // 定義 1 + 呼び出し 1
    expect(code).toContain("handleHorseRuns(request, env,");
    // 対照(検出の確認。空振りでない): 検査より後に D1 に触れる本体は「前」の検査を満たさない
    const bad = 'async function handleHorseRuns(request: Request, env: Env) {\n  await readHorseRunsStatus(env.DB, {});\n  const crossSite = crossSiteRejection(request);\n  if (crossSite !== null) {\n    return crossSite;\n  }\n}';
    expect(bad.indexOf(CROSS_SITE_CALL) < bad.indexOf("env.DB")).toBe(false);
    expect(() => expectCrossSiteCheckFirst("bad", bad, ["env.DB"])).toThrow(); // 検出器が悪い例を実際に拒否する(空振りでない)
  });

  it("GET /api/verify の関数(handleVerify)は、検証の DO の getReport だけを呼ぶ。D1・R2・取得・LLM・Webhook に触れない", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = handler.indexOf("async function handleVerify(");
    expect(start).toBeGreaterThan(-1);
    const body = handler.slice(start, handler.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(800); // 前提: 本体を実際に読めている
    expect(body).toContain(".getReport(");
    expectCrossSiteCheckFirst("handleVerify", body, ["env.VERIFY_REPORT", ".getReport("]);
    for (const forbidden of ["env.DB", "ANALYSIS_DETAIL", "NETKEIBA_GATE", "RACE_DAY", "RESULT_BACKFILL", "CLOUD_MIGRATION", ".kick(", ".start(", ".fetchRaw(", ".prepare(", "ANTHROPIC", "DISCORD_WEBHOOK_URL", "fetch("]) {
      expect(body, `handleVerify に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 検証の DO の binding に触れるのは handler.ts の 1 行(namespace 変数への代入)だけ(cloud/src の全ファイルを概念で走査)
    const srcDir = path.join(ROOT, "cloud", "src");
    const sites: Record<string, number> = {};
    for (const f of readdirSync(srcDir).filter((x) => x.endsWith(".ts") && x !== "client-bundle.generated.ts")) {
      const n = (stripCode(readTextLf("cloud", "src", f)).match(/\benv\.VERIFY_REPORT\b|\bVerifyReportDO\b|\bVERIFY_REPORT\b/g) ?? []).length;
      if (n > 0) sites[f] = n;
    }
    // handler.ts(Env の型・env.VERIFY_REPORT・binding なしのエラー文)・worker.ts(export の VerifyReportDO)・verify-do.ts(クラス定義の VerifyReportDO)だけ
    expect(Object.keys(sites).sort()).toEqual(["handler.ts", "verify-do.ts", "worker.ts"]);
    expect((handler.match(/\benv\.VERIFY_REPORT\b/g) ?? []).length).toBe(1);
  });

  it("Issue #263: 閲覧者の検証の要求は集計のやり直しを起こさない。handleVerify は管理者の分岐でだけ getReport を呼び、閲覧者は getViewerReport。VerifyCore.getViewerReport は store・アラーム・kv の書き込み・再計算・柵に触れない同期関数", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = handler.indexOf("async function handleVerify(");
    const body = handler.slice(start, handler.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(800); // 前提: 本体を実際に読めている
    const admin = body.indexOf('role === "admin"');
    const getReport = body.indexOf(".getReport(");
    const viewer = body.indexOf(".getViewerReport(");
    expect(admin).toBeGreaterThan(-1);
    expect(admin).toBeLessThan(getReport); // 管理者の分岐の中(役割の判定が先)
    expect(getReport).toBeLessThan(viewer); // 閲覧者の側は別の呼び出し
    expect((body.match(/\.getReport\(/g) ?? []).length).toBe(1);
    expect((body.match(/\.getViewerReport\(/g) ?? []).length).toBe(1);
    // DO のラッパは core の getViewerReport だけを呼ぶ(getReport・store を経由しない)
    const doCode = stripCode(readTextLf("cloud", "src", "verify-do.ts"));
    const doStart = doCode.indexOf("getViewerReport(venue");
    expect(doStart).toBeGreaterThan(-1);
    const doBody = doCode.slice(doStart, doCode.indexOf("\n  }\n", doStart));
    expect(doBody).toContain("this.core.getViewerReport(");
    expect(doBody).not.toContain("getReport(");
    // core の getViewerReport: 同期(async・await なし)で、D1・R2・アラーム・書き込み・再計算・柵に触れない
    const core = stripCode(readTextLf("cloud", "src", "verify-core.ts"));
    const coreStart = core.indexOf("  getViewerReport(venue");
    expect(coreStart).toBeGreaterThan(-1);
    const coreBody = core.slice(coreStart, core.indexOf("\n  }\n", coreStart));
    expect(coreBody.length).toBeGreaterThan(300); // 前提: 本体を実際に読めている
    expect(coreBody).toContain("this.readCache()");
    expect(coreBody).not.toContain("async");
    for (const forbidden of ["await", "store", "setAlarm", "getAlarm", "kv.put", "recompute", "gate(", "inflight", "armBackfill", "getReport", "readAll", "refresh"]) {
      expect(coreBody, `getViewerReport に ${forbidden} が無い`).not.toContain(forbidden);
    }
    expect(core.slice(Math.max(0, coreStart - 8), coreStart)).not.toContain("async");
  });

  it("cron の scheduled・RaceDay・result-dispatch・他の DO は、検証の DO を参照しない", () => {
    for (const f of ["scheduled.ts", "race-day-do.ts", "race-day-core.ts", "result-dispatch.ts", "netkeiba-gate-do.ts", "result-backfill-do.ts", "result-backfill-core.ts"]) {
      const code = stripCode(readTextLf("cloud", "src", f));
      expect(code.length, `${f} を読めている`).toBeGreaterThan(500);
      expect(code, `${f} は検証を参照しない`).not.toMatch(/VERIFY_REPORT|VerifyReport|verify-core|verify-do|verify-store/);
    }
  });
});

describe("Issue #235: 日報(DailyReportDO)は netkeiba に出ず、LLM・Discord を使う場所と、依頼の呼び出し箇所が固定されている", () => {
  const srcDir = path.join(ROOT, "cloud", "src");
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "client-bundle.generated.ts");
  const reportSources = ["daily-report-core.ts", "daily-report-digest.ts", "daily-report-bets.ts", "daily-report-prompt.ts", "daily-report-embed.ts", "daily-report-repository.ts", "daily-report-do.ts", "day-quiet.ts", "period-stats.ts", "report-job-support.ts"].map(
    (f) => [f, stripCode(readTextLf("cloud", "src", f))] as const,
  );
  /** コメントを除いた cloud/src の全ファイルで、パターンの出現数をファイルごとに数える(関数の宣言は数えない呼び出しの走査用)。 */
  const sites = (pattern: RegExp): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const f of srcFiles) {
      const n = (stripCode(readTextLf("cloud", "src", f)).match(pattern) ?? []).length;
      if (n > 0) out[f] = n;
    }
    return out;
  };

  it("日報のソース(10 ファイル。Issue #264 で period-stats.ts が、Issue #399 で日報・月報が共有する report-job-support.ts が加わった)に、netkeiba の取得口・日単位の DO・他の DO・グローバルの fetch・socket が無い", () => {
    expect(reportSources).toHaveLength(10);
    for (const [name, code] of reportSources) {
      expect(code.length, `${name} を読めている`).toBeGreaterThan(300);
      for (const forbidden of ["NETKEIBA_GATE", "fetchRaw", "postRaw", "RACE_DAY", "RaceDay", "CLOUD_MIGRATION", "RESULT_BACKFILL", "VERIFY_REPORT", "createGateHttpClient", "socket"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
      expect((code.match(/(^|[^.\w])fetch\(/g) ?? []).length, `${name} にグローバルの fetch が無い`).toBe(0);
    }
  });

  it("LLM の依存(createCloudLlm)を作るのは、発走前の分析の DO(race-day-do.ts)・日報の DO(daily-report-do.ts)・月報の DO(monthly-report-do.ts。Issue #280)の 3 箇所だけ。Discord の送信(createDiscordNotifier)は、この 3 箇所と、scheduled.ts の失敗通知の 1 箇所(Issue #249)だけ", () => {
    expect(sites(/(?<!function\s)\bcreateCloudLlm\(/g)).toEqual({ "daily-report-do.ts": 1, "monthly-report-do.ts": 1, "race-day-do.ts": 1 });
    // Issue #249: scheduled.ts の 1 箇所が加わった(23 時の再実行で計画の依頼が 3 回とも失敗したときの固定文の通知だけ。上の scheduled.ts の検査が固定する)
    expect(sites(/(?<!function\s)\bcreateDiscordNotifier\(/g)).toEqual({ "daily-report-do.ts": 1, "monthly-report-do.ts": 1, "race-day-do.ts": 1, "scheduled.ts": 1 });
  });

  it("日報の作成の依頼(.requestReport( の呼び出し)の箇所: 手動 POST(handler.ts)・取り残しの補完(scheduled.ts)・日単位の DO の配線(race-day-do.ts)・その中の呼び出し(race-day-core.ts)・DO の RPC の委譲(daily-report-do.ts)だけ", () => {
    expect(sites(/\.requestReport\(/g)).toEqual({ "daily-report-do.ts": 1, "handler.ts": 1, "race-day-core.ts": 1, "race-day-do.ts": 1, "scheduled.ts": 1 });
    // 日報の DO の binding に触れるファイル: handler.ts（手動 POST・進行状況）・scheduled.ts（補完）・race-day-do.ts（日単位の DO の配線）・worker.ts（export）・daily-report-do.ts（クラス）
    expect(Object.keys(sites(/\bDAILY_REPORT\b|\bDailyReportDO\b/g)).sort()).toEqual(["daily-report-do.ts", "handler.ts", "race-day-do.ts", "scheduled.ts", "worker.ts"]);
    // 依頼の mode は 4 種類（auto は日単位の DO・catchup は cron・manual と regenerate は手動 POST〈regenerate は本文の `regenerate: true`。Issue #268〉）で、呼び出し側が固定している。
    // 自動で作り直す経路は無い（auto・catchup のファイルに "regenerate" が出ない）
    expect(stripCode(readTextLf("cloud", "src", "race-day-do.ts"))).toContain('mode: "auto"');
    expect(stripCode(readTextLf("cloud", "src", "scheduled.ts"))).toContain('mode: "catchup"');
    expect(stripCode(readTextLf("cloud", "src", "handler.ts"))).toContain('mode: regenerate ? "regenerate" : "manual"');
    for (const f of ["race-day-do.ts", "race-day-core.ts", "scheduled.ts"]) {
      expect(stripCode(readTextLf("cloud", "src", f)), `${f} は作り直しを依頼しない`).not.toContain("regenerate");
    }
    // 日単位の DO は、依頼の結果の「完了」の判定を isRequestSettled に任せる（too-old を完了として扱う。個別の条件を持たない）
    expect(stripCode(readTextLf("cloud", "src", "race-day-do.ts"))).toContain("isRequestSettled(result)");
  });

  it("Issue #268: 日報の Discord への送信は daily-report-core.ts の 1 箇所だけ（runNotify）。作り直しの save は通知の段階を書かない（作り直しは Discord に送らない）", () => {
    const core = reportSources.find(([n]) => n === "daily-report-core.ts")![1];
    expect((core.match(/notifier\.send\(/g) ?? []).length).toBe(1);
    expect((core.match(/\.send\(/g) ?? []).length).toBe(1);
    // 通知の段階（phase: "notify"）を書くのは runSave の通常の保存の 1 箇所だけで、作り直しの分岐（mode === "regenerate"）より後ろにある
    expect((core.match(/phase: "notify"/g) ?? []).length).toBe(1);
    expect(core.indexOf('job.mode === "regenerate"')).toBeGreaterThan(-1);
    expect(core.indexOf('job.mode === "regenerate"')).toBeLessThan(core.indexOf('phase: "notify"'));
    // 作り直しの他のファイル（通知の埋め込み・DO）が、通知を足していない
    for (const f of ["daily-report-embed.ts", "daily-report-do.ts"]) {
      expect(reportSources.find(([n]) => n === f)![1], `${f} に regenerate の送信が無い`).not.toContain("regenerate");
    }
  });

  it("Issue #399: 日報・月報が共有するジョブ機構の部品(report-job-support.ts)は、Discord への送信・通知の段階・D1 への保存を持たない(通知に入る経路と保存の呼び出しは、各 core の 1 箇所に残る)。葉のモジュールで、日報・月報の core を import しない", () => {
    const shared = reportSources.find(([n]) => n === "report-job-support.ts")![1];
    expect(shared.length, "report-job-support.ts を読めている").toBeGreaterThan(1000);
    for (const forbidden of [".send(", 'phase: "notify"', "replaceReport", "saveReport"]) {
      expect(shared, `report-job-support.ts に ${forbidden} が無い`).not.toContain(forbidden);
    }
    expect(shared).not.toMatch(/daily-report-core|monthly-report-core/);
    // 日報・月報の core は、この部品を使っている(重複した実装に戻っていない)
    for (const core of ["daily-report-core.ts", "monthly-report-core.ts"]) {
      const code = stripCode(readTextLf("cloud", "src", core));
      expect(code, `${core} が report-job-support.ts を使う`).toContain('from "./report-job-support"');
      expect(code, `${core} に LLM を直接呼ぶ実装(AnthropicLlmClient)が無い`).not.toContain("AnthropicLlmClient");
    }
  });

  it("日報の D1 の書き込みは daily-report-repository.ts の 2 文だけ: 通常の保存の INSERT OR IGNORE INTO daily_reports(上書きしない)と、作り直し(Issue #268)の UPSERT 1 文(INSERT INTO daily_reports … ON CONFLICT(kaisai_date) DO UPDATE。文章のある前の日報を文章の無い記録で潰さない WHERE つき)。削除・他の表への書き込みが無い。Worker の GET は読むだけ", () => {
    const repo = reportSources.find(([n]) => n === "daily-report-repository.ts")![1];
    expect((repo.match(/INSERT OR IGNORE INTO daily_reports/g) ?? []).length).toBe(1);
    // 作り直しの UPSERT: 書き込みの文は 1 つ(INSERT INTO 1・ON CONFLICT 1・DO UPDATE 1)で、対象は daily_reports だけ。上書きを許す条件(WHERE)を持つ
    expect((repo.match(/INSERT INTO daily_reports/g) ?? []).length).toBe(1);
    expect((repo.match(/INSERT INTO/g) ?? []).length).toBe(1);
    expect((repo.match(/ON CONFLICT\(kaisai_date\) DO UPDATE SET/g) ?? []).length).toBe(1);
    expect((repo.match(/UPDATE /g) ?? []).length).toBe(1); // 上の DO UPDATE SET だけ（単独の UPDATE 文は無い）
    expect(repo).toContain("WHERE excluded.model IS NOT NULL OR daily_reports.model IS NULL");
    for (const forbidden of ["DELETE FROM", "REPLACE INTO", "DROP ", "ALTER "]) {
      expect(repo, `daily-report-repository.ts に ${forbidden} が無い`).not.toContain(forbidden);
    }
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    for (const fn of ["handleReportList", "handleReportDetail"]) {
      const start = handler.indexOf(`async function ${fn}(`);
      expect(start, `${fn} がある`).toBeGreaterThan(-1);
      const body = handler.slice(start, handler.indexOf("\n}\n", start));
      expect(body.length, `${fn} の本体を読めている`).toBeGreaterThan(300);
      for (const forbidden of [".saveReport(", ".requestReport(", "ANALYSIS_DETAIL", "NETKEIBA_GATE", "RACE_DAY", "ANTHROPIC", "DISCORD", "fetch(", ".prepare("]) {
        expect(body, `${fn} に ${forbidden} が無い`).not.toContain(forbidden);
      }
    }
  });

  it("手動の作成（handleReportRun）は run と同じ守り(readJsonObjectBody)を先に通り、日報の DO の requestReport だけを呼ぶ。D1・R2・LLM・取得に触れない", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = handler.indexOf("async function handleReportRun(");
    expect(start).toBeGreaterThan(-1);
    const body = handler.slice(start, handler.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(800);
    expect(body.indexOf("readJsonObjectBody(")).toBeGreaterThan(-1);
    expect(body.indexOf("readJsonObjectBody(")).toBeLessThan(body.indexOf(".requestReport("));
    for (const forbidden of ["env.DB", "ANALYSIS_DETAIL", "NETKEIBA_GATE", "RACE_DAY", "ANTHROPIC", "DISCORD", "fetch(", ".prepare("]) {
      expect(body, `handleReportRun に ${forbidden} が無い`).not.toContain(forbidden);
    }
  });

  it("cron の行は 1 行のまま(日報のために cron を足していない。Issue #249 で 21 時・23 時の 2 本になったが、日報は 23 時の再実行が補完する)。起動は日単位の DO のイベント（静かになったとき）と、23 時の cron の補完・手動", () => {
    expect((tomlCode.match(/^crons\s*=\s*\[[^\]]*\]\s*$/gm) ?? []).length).toBe(1);
    expect(tomlCode).toContain('crons = ["0 12 * * *", "0 14 * * *"]');
  });
});

describe("Issue #266: 統計モデル用の書き出し(PriorExportDO)は netkeiba にも LLM にも出ず、他の DO・cron と干渉せず、R2 への書き込みは 1 箇所、Worker は D1 に触れない", () => {
  const exportSources = ["prior-export-core.ts", "prior-export-do.ts", "prior-export-store.ts", "prior-export-format.ts"].map((f) => [f, stripCode(readTextLf("cloud", "src", f))] as const);

  it("書き出しのソース(4 ファイル)に、netkeiba の取得口・RaceDay・LLM・Discord・グローバルの fetch・他の DO が無い", () => {
    expect(exportSources).toHaveLength(4);
    for (const [name, code] of exportSources) {
      expect(code.length, `${name} を読めている`).toBeGreaterThan(500);
      for (const forbidden of ["NETKEIBA_GATE", "fetchRaw", "postRaw", "RACE_DAY", "RaceDay", "CLOUD_MIGRATION", "RESULT_BACKFILL", "VERIFY_REPORT", "ANTHROPIC", "DISCORD", "createCloudLlm", "createDiscordNotifier", "createGateHttpClient", "socket"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
      expect((code.match(/(^|[^.\w])fetch\(/g) ?? []).length, `${name} にグローバルの fetch が無い`).toBe(0);
    }
  });

  it("D1・R2 の読み書きは prior-export-store.ts だけ。R2 の put は putFile の 1 箇所、get は詳細の読みの 1 箇所(list・head・delete は使わない)。D1 の書き込みは r2_ops の 2 文(Class B の加算・Class A の加算)だけ", () => {
    const store = exportSources.find(([n]) => n === "prior-export-store.ts")![1];
    expect((store.match(/this\.bucket\.put\(/g) ?? []).length).toBe(1);
    expect((store.match(/this\.bucket\.get\(/g) ?? []).length).toBe(1);
    for (const forbidden of [".list(", ".head(", ".delete(", "DELETE FROM", "UPDATE analyses", "UPDATE analysis_", "UPDATE race_", "UPDATE daily_", "UPDATE cloud_", "INSERT INTO analyses", "INSERT INTO race_", "INSERT INTO daily_", "INSERT INTO cloud_"]) {
      expect(store, `prior-export-store.ts に ${forbidden} が無い`).not.toContain(forbidden);
    }
    expect((store.match(/INSERT INTO r2_ops/g) ?? []).length).toBe(2);
    // 型 PriorExportBucket は get と put だけを許す
    expect(store).toMatch(/type PriorExportBucket = Pick<R2Bucket, "get" \| "put">/);
    // ほかの書き出しのソースは D1・R2 に直接触れない(core は注入された窓口だけを使う)
    for (const [name, code] of exportSources.filter(([n]) => n === "prior-export-core.ts" || n === "prior-export-format.ts")) {
      for (const forbidden of ["env.DB", "ANALYSIS_DETAIL", ".prepare(", ".batch(", ".put(\"exports"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
    }
  });

  it("GET /api/export/prior-dataset の関数(handlePriorExport)は、DO の request を呼び、R2 は完成したファイルの get 1 回だけ。D1・取得・LLM・Webhook・R2 の書き込みに触れない。Refresh ヘッダの遷移先は定数のパスだけ(?refresh=1 を含めない)", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = handler.indexOf("async function handlePriorExport(");
    expect(start).toBeGreaterThan(-1);
    const body = handler.slice(start, handler.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(1500); // 前提: 本体を実際に読めている
    expect(body).toContain(".request(mode)");
    expectCrossSiteCheckFirst("handlePriorExport", body, ["env.PRIOR_EXPORT", "env.ANALYSIS_DETAIL", ".request(mode)"]);
    expect((body.match(/env\.ANALYSIS_DETAIL\.get\(PRIOR_EXPORT_KEY\)/g) ?? []).length).toBe(1);
    expect((body.match(/env\.ANALYSIS_DETAIL/g) ?? []).length).toBe(1);
    expect(body).toContain("url=${PRIOR_EXPORT_PATH}");
    expect(body).not.toContain("refresh=1}");
    for (const forbidden of ["env.DB", "NETKEIBA_GATE", "RACE_DAY", "RESULT_BACKFILL", "CLOUD_MIGRATION", "VERIFY_REPORT", ".kick(", ".start(", ".fetchRaw(", ".prepare(", ".put(", ".list(", ".delete(", "ANTHROPIC", "DISCORD_WEBHOOK_URL", "fetch("]) {
      expect(body, `handlePriorExport に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 書き出しの DO の binding・クラスに触れるファイルは、概念で走査して固定(cloud/src の全ファイル)
    const srcDir = path.join(ROOT, "cloud", "src");
    const sites: Record<string, number> = {};
    for (const f of readdirSync(srcDir).filter((x) => x.endsWith(".ts") && x !== "client-bundle.generated.ts")) {
      const n = (stripCode(readTextLf("cloud", "src", f)).match(/\bPRIOR_EXPORT\b|\bPriorExportDO\b/g) ?? []).length;
      if (n > 0) sites[f] = n;
    }
    // handler.ts(Env の型・env.PRIOR_EXPORT)・worker.ts(export)・prior-export-do.ts(クラス定義・上書きの var 名の型)だけ
    expect(Object.keys(sites).sort()).toEqual(["handler.ts", "prior-export-do.ts", "worker.ts"]);
    expect((handler.match(/\benv\.PRIOR_EXPORT\b/g) ?? []).length).toBe(1);
  });

  it("cron の scheduled・RaceDay・result-dispatch・他の DO は、書き出しの DO を参照しない。route-policy は管理者専用の行を持つ", () => {
    for (const f of ["scheduled.ts", "race-day-do.ts", "race-day-core.ts", "result-dispatch.ts", "netkeiba-gate-do.ts", "result-backfill-do.ts", "result-backfill-core.ts", "verify-do.ts", "verify-core.ts", "verify-store.ts", "daily-report-do.ts"]) {
      const code = stripCode(readTextLf("cloud", "src", f));
      expect(code.length, `${f} を読めている`).toBeGreaterThan(500);
      expect(code, `${f} は書き出しを参照しない`).not.toMatch(/PRIOR_EXPORT|PriorExport|prior-export/);
    }
    expect(stripCode(readTextLf("cloud", "src", "route-policy.ts"))).toContain('exact("/api/export/prior-dataset", ADMIN_ONLY)');
  });
});

describe("Issue #279・#280: 月報(MonthlyReportDO)は netkeiba に出ず、LLM・Discord の配線は DO だけで、他の DO・cron と干渉せず、D1 の書き込みは 2 文、Worker の GET は読むだけ(進行状況は管理者だけ)", () => {
  const srcDir = path.join(ROOT, "cloud", "src");
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "client-bundle.generated.ts");
  /** 純ロジックの 8 ファイル(LLM・Discord の本物に触れない。core は注入された口だけを使う。Issue #399 で日報と共有の report-job-support.ts が加わった)と、配線の DO。 */
  const pureNames = ["monthly-month.ts", "monthly-stats.ts", "monthly-report-core.ts", "monthly-report-plan.ts", "monthly-report-repository.ts", "monthly-report-prompt.ts", "monthly-report-embed.ts", "report-job-support.ts"];
  const monthlySources = [...pureNames, "monthly-report-do.ts"].map((f) => [f, stripCode(readTextLf("cloud", "src", f))] as const);
  const sites = (pattern: RegExp): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const f of srcFiles) {
      const n = (stripCode(readTextLf("cloud", "src", f)).match(pattern) ?? []).length;
      if (n > 0) out[f] = n;
    }
    return out;
  };
  const coreCode = monthlySources.find(([n]) => n === "monthly-report-core.ts")![1];

  it("月報のソース(9 ファイル)に、netkeiba の取得口・日単位の DO・他の DO・グローバルの fetch・socket が無い。LLM・Discord の本物(secret・作る関数)に触れるのは DO だけ", () => {
    expect(monthlySources).toHaveLength(9);
    for (const [name, code] of monthlySources) {
      expect(code.length, `${name} を読めている`).toBeGreaterThan(300);
      for (const forbidden of ["NETKEIBA_GATE", "fetchRaw", "postRaw", "RACE_DAY", "RaceDay", "CLOUD_MIGRATION", "RESULT_BACKFILL", "VERIFY_REPORT", "DAILY_REPORT", "PRIOR_EXPORT", "createGateHttpClient", "socket"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
      expect((code.match(/(^|[^.\w])fetch\(/g) ?? []).length, `${name} にグローバルの fetch が無い`).toBe(0);
    }
    for (const [name, code] of monthlySources.filter(([n]) => n !== "monthly-report-do.ts")) {
      for (const forbidden of ["ANTHROPIC", "DISCORD_WEBHOOK", "createCloudLlm", "createDiscordNotifier"]) {
        expect(code, `${name} に ${forbidden} が無い(本物の LLM・Discord への配線は DO だけ。DISCORD_COLORS は帯の色の定数)`).not.toContain(forbidden);
      }
    }
    const doCode = monthlySources.find(([n]) => n === "monthly-report-do.ts")![1];
    expect((doCode.match(/createCloudLlm\(/g) ?? []).length).toBe(1);
    expect((doCode.match(/createDiscordNotifier\(/g) ?? []).length).toBe(1);
    expect(doCode).toContain("ANTHROPIC_API_KEY");
    expect(doCode).toContain("DISCORD_WEBHOOK_URL");
  });

  it("月報の依頼(.requestMonthlyReport( の呼び出し)の箇所は cron(scheduled.ts)と管理者の手動の入口(handler.ts の handleMonthlyRun)の 2 箇所だけ。月報の DO の binding に触れるファイルは固定", () => {
    expect(sites(/\.requestMonthlyReport\(/g)).toEqual({ "handler.ts": 1, "scheduled.ts": 1 });
    // MONTHLY_REPORT・MonthlyReportDO に触れるファイル: handler.ts(Env の型・手動の入口・進行状況)・scheduled.ts(依頼)・worker.ts(export)・monthly-report-do.ts(クラス)
    expect(Object.keys(sites(/\bMONTHLY_REPORT\b|\bMonthlyReportDO\b/g)).sort()).toEqual(["handler.ts", "monthly-report-do.ts", "scheduled.ts", "worker.ts"]);
    // cron が出す mode は auto と catchup だけ(plan が決める)。cron の側に作り直し・手動は無い。自動で作り直す経路は無い
    const scheduled = stripCode(readTextLf("cloud", "src", "scheduled.ts"));
    expect(scheduled).not.toContain("regenerate");
    expect(scheduled).not.toContain('"manual"');
    const plan = monthlySources.find(([n]) => n === "monthly-report-plan.ts")![1];
    expect(plan).toContain('mode: "auto"');
    expect(plan).toContain('mode: "catchup"');
    expect(plan).not.toContain('"manual"');
    expect(plan).not.toContain("regenerate");
    // 手動の入口が出す mode は、本文の `regenerate: true` で決まる manual と regenerate だけ
    expect(stripCode(readTextLf("cloud", "src", "handler.ts"))).toContain('mode: regenerate ? "regenerate" : "manual"');
  });

  it("新しい cron は足していない(月報の依頼は 21:00・23:00 の既存の実行が出す)。cron の行は 1 行のまま", () => {
    expect((tomlCode.match(/^crons\s*=\s*\[[^\]]*\]\s*$/gm) ?? []).length).toBe(1);
    expect(tomlCode).toContain('crons = ["0 12 * * *", "0 14 * * *"]');
  });

  it('月報の Discord への送信は monthly-report-core.ts の 1 箇所だけ(runNotify)。通知の段階(phase: "notify")を書くのは runSave の自動・補完の経路の 1 箇所だけで、作り直し・手動の作成の分岐より後ろにある(送るのは auto・catchup だけ)', () => {
    expect((coreCode.match(/notifier\.send\(/g) ?? []).length).toBe(1);
    expect((coreCode.match(/\.send\(/g) ?? []).length).toBe(1);
    expect((coreCode.match(/phase: "notify"/g) ?? []).length).toBe(1);
    const notifyAt = coreCode.indexOf('phase: "notify"');
    expect(coreCode.indexOf('job.mode === "regenerate"')).toBeGreaterThan(-1);
    expect(coreCode.indexOf('job.mode === "regenerate"')).toBeLessThan(notifyAt);
    expect(coreCode.indexOf('job.mode === "manual"')).toBeGreaterThan(-1);
    expect(coreCode.indexOf('job.mode === "manual"')).toBeLessThan(notifyAt);
    // 通知の他のファイル(embed・DO・repository・prompt)に送信が無い
    for (const f of ["monthly-report-embed.ts", "monthly-report-do.ts", "monthly-report-repository.ts", "monthly-report-prompt.ts"]) {
      expect(monthlySources.find(([n]) => n === f)![1], `${f} に送信が無い`).not.toMatch(/\.send\(/);
    }
  });

  it("月報の D1 の書き込みは monthly-report-repository.ts の 2 文だけ: 通常の保存の INSERT OR IGNORE INTO monthly_reports(上書きしない)と、作り直しの UPSERT 1 文(INSERT INTO monthly_reports … ON CONFLICT(month) DO UPDATE。文章のある前の月報を文章の無い記録で潰さない WHERE つき)。削除・他の表への書き込みが無い", () => {
    const repo = monthlySources.find(([n]) => n === "monthly-report-repository.ts")![1];
    expect((repo.match(/INSERT OR IGNORE INTO monthly_reports/g) ?? []).length).toBe(1);
    expect((repo.match(/INSERT INTO monthly_reports/g) ?? []).length).toBe(1);
    expect((repo.match(/INSERT /g) ?? []).length).toBe(2);
    expect((repo.match(/ON CONFLICT\(month\) DO UPDATE SET/g) ?? []).length).toBe(1);
    expect((repo.match(/UPDATE /g) ?? []).length).toBe(1); // 上の DO UPDATE SET だけ(単独の UPDATE 文は無い)
    expect(repo).toContain("WHERE excluded.model IS NOT NULL OR monthly_reports.model IS NULL");
    for (const forbidden of ["DELETE FROM", "REPLACE INTO", "DROP ", "ALTER "]) {
      expect(repo, `monthly-report-repository.ts に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 月報の他のソースは D1 に直接触れない(core は注入された窓口だけを使う)
    for (const [name, code] of monthlySources.filter(([n]) => n !== "monthly-report-repository.ts")) {
      expect(code, `${name} は D1 に直接触れない`).not.toMatch(/\.prepare\(|\.batch\(|\.exec\(/);
    }
  });

  it("Worker の GET(handleMonthlyList・handleMonthlyDetail)は読むだけ: D1MonthlyStore の読み出しと、(詳細だけ)管理者のときの月報の DO の getStatus 以外の DO・R2・取得・LLM・Webhook・書き込みに触れない。閲覧者は DO に触れない。route-policy は GET の行だけを閲覧者に開く", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const bodyOf = (fn: string): string => {
      const start = handler.indexOf(`async function ${fn}(`);
      expect(start, `${fn} がある`).toBeGreaterThan(-1);
      const body = handler.slice(start, handler.indexOf("\n}\n", start));
      expect(body.length, `${fn} の本体を読めている`).toBeGreaterThan(300);
      return body;
    };
    const forbiddenAlways = [".saveReport(", ".replaceReport(", ".requestMonthlyReport(", "DAILY_REPORT", "ANALYSIS_DETAIL", "NETKEIBA_GATE", "RACE_DAY", "ANTHROPIC", "DISCORD", "fetch(", ".prepare(", ".batch("];
    const list = bodyOf("handleMonthlyList");
    for (const forbidden of [...forbiddenAlways, "MONTHLY_REPORT", ".getStatus("]) {
      expect(list, `handleMonthlyList に ${forbidden} が無い`).not.toContain(forbidden);
    }
    const detail = bodyOf("handleMonthlyDetail");
    for (const forbidden of forbiddenAlways) {
      expect(detail, `handleMonthlyDetail に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // DO に触れるのは getStatus の 1 箇所だけで、管理者のときにしか呼ばれない(閲覧者は DO に触れない)
    expect((detail.match(/\.getStatus\(/g) ?? []).length).toBe(1);
    expect((detail.match(/readJob\(\)/g) ?? []).length).toBe(1);
    expect(detail).toContain('role === "admin" ? await readJob() : { job: null, jobStatus: "ok" as const }');
    const policy = stripCode(readTextLf("cloud", "src", "route-policy.ts"));
    expect(policy).toContain('exact("/api/monthly-reports", GET)');
    expect(policy).toContain('path: "/api/monthly-reports/{month}"');
    expect(policy).toContain('exact("/api/monthly-reports/run", ADMIN_ONLY)');
  });

  it("手動の作成・作り直し(handleMonthlyRun)は run と同じ守り(readJsonObjectBody)を先に通り、月報の DO の requestMonthlyReport だけを呼ぶ。D1・R2・LLM・取得に触れない", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = handler.indexOf("async function handleMonthlyRun(");
    expect(start).toBeGreaterThan(-1);
    const body = handler.slice(start, handler.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(800);
    expect(body.indexOf("readJsonObjectBody(")).toBeGreaterThan(-1);
    expect(body.indexOf("readJsonObjectBody(")).toBeLessThan(body.indexOf(".requestMonthlyReport("));
    for (const forbidden of ["env.DB", "ANALYSIS_DETAIL", "NETKEIBA_GATE", "RACE_DAY", "DAILY_REPORT", "ANTHROPIC", "DISCORD", "fetch(", ".prepare(", ".getStatus("]) {
      expect(body, `handleMonthlyRun に ${forbidden} が無い`).not.toContain(forbidden);
    }
  });

  it("他の DO(日報・検証・日単位・結果の補完・移行・書き出し)と日報のソースは、月報を参照しない(干渉しない。アラームは DO ごとに 1 つ)", () => {
    for (const f of ["daily-report-core.ts", "daily-report-do.ts", "race-day-do.ts", "race-day-core.ts", "result-dispatch.ts", "netkeiba-gate-do.ts", "result-backfill-do.ts", "result-backfill-core.ts", "verify-do.ts", "verify-core.ts", "verify-store.ts", "prior-export-do.ts"]) {
      const code = stripCode(readTextLf("cloud", "src", f));
      expect(code.length, `${f} を読めている`).toBeGreaterThan(500);
      expect(code, `${f} は月報を参照しない`).not.toMatch(/MONTHLY_REPORT|MonthlyReport|monthly-report/);
    }
  });

  it("月報のプロンプト・embed・core のソースは、クライアントの束(cloud/client)から import されない(プロンプトの文面が束に入って肥大しない)", () => {
    const clientDir = path.join(ROOT, "cloud", "client");
    const files = readdirSync(clientDir).filter((n) => n.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10); // 前提: 走査の対象を読めている
    const offenders = files.filter((f) => /monthly-report-(prompt|embed|core)/.test(readTextLf("cloud", "client", f)));
    expect(offenders).toEqual([]);
  });
});

describe("Issue #294: 馬場の API の取得は、URL を secret の 1 箇所だけで読み、core・純ロジックは外向きの通信も URL も持たず、D1 の書き込みは 3 文だけ", () => {
  const srcDir = path.join(ROOT, "cloud", "src");
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "client-bundle.generated.ts");
  const code = (f: string): string => stripCode(readTextLf("cloud", "src", f));
  const sites = (pattern: RegExp): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const f of srcFiles) {
      const n = (code(f).match(pattern) ?? []).length;
      if (n > 0) out[f] = n;
    }
    return out;
  };
  /** 馬場の API に関わるソース(取得の部品・純ロジック・保存先・段階)。 */
  const babaSources = ["baba-conditions.ts", "baba-fetch.ts", "baba-repository.ts", "race-day-baba.ts"];

  it("前提: 馬場のソースと core を実際に読めている(以降の検査が空振りでない)", () => {
    for (const f of [...babaSources, "race-day-core.ts", "race-day-do.ts"]) {
      expect(code(f).length, `${f} を読めている`).toBeGreaterThan(500);
    }
  });

  it("secret の名前 BABA_API_URL が現れるのは race-day-do.ts だけ(型の宣言 1 + 形式の確認 1 + 取得口の作成 1 + 形式不正の警告の文言 1)。ほかのソースには現れない。wrangler.toml の [vars] にも置かない", () => {
    expect(sites(/\bBABA_API_URL\b/g)).toEqual({ "race-day-do.ts": 4 });
    expect((code("race-day-do.ts").match(/\benv\.BABA_API_URL\b/g) ?? []).length).toBe(2);
    expect(code("race-day-do.ts")).toContain("fetchBaba: createBabaFetcher(env.BABA_API_URL)");
    expect(tomlCode).not.toMatch(/BABA/);
  });

  it("取得口を作る createBabaFetcher の呼び出しは race-day-do.ts の 1 箇所だけ", () => {
    expect(sites(/(?<!function\s)\bcreateBabaFetcher\(/g)).toEqual({ "race-day-do.ts": 1 });
  });

  it("グローバルの fetch を呼ぶのは baba-fetch.ts の 1 箇所(注入できる既定)だけ。core・段階・純ロジック・保存先には外向きの通信が無い", () => {
    expect((code("baba-fetch.ts").match(/(^|[^.\w])fetch\(/g) ?? []).length).toBe(1);
    for (const f of ["baba-conditions.ts", "baba-repository.ts", "race-day-baba.ts", "race-day-core.ts"]) {
      expect((code(f).match(/(^|[^.\w])fetch\(/g) ?? []).length, `${f} にグローバルの fetch が無い`).toBe(0);
      expect(code(f), `${f} に .fetch( が無い`).not.toMatch(/\.fetch\(/);
    }
  });

  it("リダイレクトを追わない(redirect: manual)。再試行の仕組み(retry・リトライのループ)を持たない: 取得口の fetch は 1 回の呼び出しに 1 回", () => {
    const fetchCode = code("baba-fetch.ts");
    expect(fetchCode).toContain('redirect: "manual"');
    expect((fetchCode.match(/await fetchFn\(/g) ?? []).length).toBe(1);
    expect(fetchCode).not.toMatch(/\b(for|while)\b[^\n]*fetchFn/);
  });

  it("馬場のソースに URL のリテラル(http(s)://…)が無い。外部の API の宛先は secret にだけある", () => {
    for (const f of babaSources) {
      expect(code(f), `${f} に URL のリテラルが無い`).not.toMatch(/https?:\/\//);
    }
    for (const f of ["race-day-core.ts"]) {
      expect(code(f), `${f} に馬場の API の URL が無い`).not.toMatch(/baba[^\n]*https?:\/\//i);
    }
  });

  it("D1 の書き込みは baba-repository.ts の 3 文だけ(claim の INSERT・結果の UPDATE・競馬場の INSERT)。DELETE は無い", () => {
    const repo = code("baba-repository.ts");
    expect((repo.match(/INSERT INTO baba_fetches/g) ?? []).length).toBe(1);
    expect((repo.match(/UPDATE baba_fetches/g) ?? []).length).toBe(1);
    expect((repo.match(/INSERT INTO baba_conditions/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(/\bDELETE\b|\bREPLACE\b/);
    expect(repo).toContain("ON CONFLICT (kaisai_date) DO NOTHING");
    // 表を書くのはこのファイルだけ
    expect(sites(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+baba_(fetches|conditions)\b/g)).toEqual({ "baba-repository.ts": 3 });
  });

  it("取得の段階(BabaStage)を使うのは race-day-core.ts だけ。runNextStep では通知の後・タスクの前に 1 箇所、アラームの合成で 1 箇所(期限の候補)", () => {
    expect(sites(/\bBabaStage\b/g)).toEqual({ "race-day-baba.ts": 1, "race-day-core.ts": 3 }); // core: import・フィールドの型・new
    const core = code("race-day-core.ts");
    expect((core.match(/this\.baba\.runnable\(\)/g) ?? []).length).toBe(1);
    expect((core.match(/this\.baba\.run\(\)/g) ?? []).length).toBe(1);
    expect((core.match(/this\.baba\.dueAtMs\(\)/g) ?? []).length).toBe(1);
    const notify = core.indexOf("const notice = this.notifyPlan().sendNow;");
    const baba = core.indexOf("this.baba.runnable()");
    const pick = core.indexOf("const next = this.pickNext();");
    expect(notify).toBeGreaterThan(-1);
    expect(baba).toBeGreaterThan(notify);
    expect(pick).toBeGreaterThan(baba);
  });

  it("他の DO・cron・日報・月報は、馬場の API の取得を参照しない(アラームは DO ごとに 1 つ。干渉しない)。入口(handler.ts)と ルートの表(route-policy.ts)は診断の入口 /api/baba-fetch だけが例外(次のテスト)", () => {
    for (const f of srcFiles.filter((n) => !babaSources.includes(n) && !["race-day-core.ts", "race-day-do.ts", "race-day-plan.ts", "handler.ts", "route-policy.ts"].includes(n))) {
      expect(code(f), `${f} は馬場の API を参照しない`).not.toMatch(/baba-(conditions|fetch|repository)|race-day-baba|BabaStage|BABA_API_URL/);
    }
  });

  it("Issue #360: 診断の入口 GET /api/baba-fetch の関数(handleBabaFetch)は、D1 に触れる前に Sec-Fetch-Site を見る。baba-repository の読み出し(loadFetches)だけを使い、外部の API・取得口・段階・URL の secret・取得・LLM・Webhook・DO・R2・書き込みに触れない。handler.ts と route-policy.ts が馬場について参照するのはこの入口だけ", () => {
    const handler = code("handler.ts");
    const start = handler.indexOf("async function handleBabaFetch(");
    expect(start).toBeGreaterThan(-1);
    const body = handler.slice(start, handler.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(800); // 前提: 本体を実際に読めている(空振りでない)
    expect(body).toContain(".loadFetches(");
    expectCrossSiteCheckFirst("handleBabaFetch", body, ["env.DB", ".loadFetches("]); // Sec-Fetch-Site の検査は D1 に触れるより前
    for (const forbidden of ["NETKEIBA_GATE", "RACE_DAY", "RESULT_BACKFILL", "CLOUD_MIGRATION", "VERIFY_REPORT", "PRIOR_EXPORT", "ANALYSIS_DETAIL", "BABA_API_URL", ".fetchRaw(", ".prepare(", ".batch(", ".run(", ".claim(", ".finish(", "INSERT", "UPDATE", "DELETE", "ANTHROPIC", "DISCORD_WEBHOOK_URL", "fetch("]) {
      expect(body, `handleBabaFetch に ${forbidden} が無い`).not.toContain(forbidden);
    }
    expect((handler.match(/\bhandleBabaFetch\(/g) ?? []).length).toBe(2); // 定義 1 + 呼び出し 1
    // handler.ts の馬場への参照は、baba-repository からの import(D1BabaStore・FETCH_LIST_LIMIT_DEFAULT)と、このルートの文字列だけ
    const imports = [...handler.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/baba-repository"/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());
    expect(imports).toEqual(["D1BabaStore, FETCH_LIST_LIMIT_DEFAULT"]);
    const strip = (text: string): string => text.replaceAll("/api/baba-fetch", "").replaceAll("baba-fetch-error", "").replaceAll("./baba-repository", "");
    expect(strip(handler), "handler.ts は、診断の入口(ルートの文字列・エラーの種類名・baba-repository の import)のほかに取得の部品を参照しない").not.toMatch(/baba-(conditions|fetch|repository)|race-day-baba|BabaStage|BABA_API_URL|createBabaFetcher/);
    expect(strip(code("route-policy.ts")), "route-policy.ts は、ルートの文字列のほかに馬場を参照しない").not.toMatch(/baba-(conditions|fetch|repository)|race-day-baba|BabaStage|BABA_API_URL/);
    // 対照(検出の確認。空振りでない): 検査より後に D1 に触れる本体は「前」の検査を満たさない
    const bad = 'async function handleBabaFetch(request: Request, env: Env) {\n  await new D1BabaStore({ db: env.DB });\n  const crossSite = crossSiteRejection(request);\n  if (crossSite !== null) {\n    return crossSite;\n  }\n}';
    expect(bad.indexOf(CROSS_SITE_CALL) < bad.indexOf("env.DB")).toBe(false);
    expect(() => expectCrossSiteCheckFirst("bad", bad, ["env.DB"])).toThrow(); // 検出器が悪い例を実際に拒否する(空振りでない)
  });

  it("deploy-cloud.yml は BABA_API_URL を必須の secret にしない(任意の secret。未登録なら機能が止まるだけ)", () => {
    expect(readTextLf(".github", "workflows", "deploy-cloud.yml")).not.toMatch(/BABA/);
  });

  it("migration 0017 は baba_fetches・baba_conditions の 2 表だけを作る", () => {
    const sql = readTextLf("cloud", "migrations", "0017_baba.sql")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect([...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1])).toEqual(["baba_fetches", "baba_conditions"]);
  });
});
