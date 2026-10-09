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

  it("Issue #177・#216・#217: 日単位の DO(RACE_DAY・RaceDay)は migration v2、移行の DO(CLOUD_MIGRATION・CloudMigration)は migration v3、結果の補完の DO(RESULT_BACKFILL・ResultBackfill)は migration v4 で追加するだけ。v1(NetkeibaGate)は無変更で、new_classes・renamed・deleted は使わない", () => {
    const migrations = [...tomlCode.matchAll(/^\[\[migrations\]\]\ntag = "(v\d+)"\n(?:[^\n]*\n)*?new_sqlite_classes = \[([^\]]*)\]/gm)].map((m) => [m[1], m[2]]);
    expect(migrations).toEqual([
      ["v1", '"NetkeibaGate"'],
      ["v2", '"RaceDay"'],
      ["v3", '"CloudMigration"'],
      ["v4", '"ResultBackfill"'],
    ]);
    expect(tomlCode).toMatch(/^name = "RACE_DAY"$/m);
    expect(tomlCode).toMatch(/^class_name = "RaceDay"$/m);
    expect(tomlCode).toMatch(/^name = "CLOUD_MIGRATION"$/m);
    expect(tomlCode).toMatch(/^class_name = "CloudMigration"$/m);
    expect(tomlCode).toMatch(/^name = "RESULT_BACKFILL"$/m);
    expect(tomlCode).toMatch(/^class_name = "ResultBackfill"$/m);
    expect(tomlCode).not.toMatch(/^(renamed_classes|deleted_classes|transferred_classes)\s*=/m);
    // DO のバインディングはちょうど4つ(NETKEIBA_GATE・RACE_DAY・CLOUD_MIGRATION・RESULT_BACKFILL)
    expect((tomlCode.match(/^\[\[durable_objects\.bindings\]\]$/gm) ?? []).length).toBe(4);
  });

  it("Issue #206: cron はちょうど1本で `0 0 * * *`(UTC 0:00 = JST 9:00)。止め方(`crons = []`)をコメントに残す。キューの consumer・producer は無い", () => {
    // 前提: [triggers] を実際に読めている(空振りでない)
    expect((tomlCode.match(/^\[triggers\]$/gm) ?? []).length).toBe(1);
    const crons = [...tomlCode.matchAll(/^crons\s*=\s*\[([^\]]*)\]\s*$/gm)];
    expect(crons).toHaveLength(1);
    const entries = crons[0]![1]!.split(",").map((e) => e.trim()).filter((e) => e !== "");
    expect(entries).toEqual(['"0 0 * * *"']);
    // [triggers] の中身は crons だけ(他の種類のトリガを足していない)
    const triggersBlock = /^\[triggers\]\n((?:(?!\[)[^\n]*\n?)*)/m.exec(tomlCode)?.[1] ?? "";
    expect(triggersBlock.trim()).toBe('crons = ["0 0 * * *"]');
    // キュー: consumer も producer も無い
    expect(tomlCode).not.toMatch(/^\[\[queues\./m);
    expect(tomlCode).not.toMatch(/^\[queues/m);
    // 止め方(`[triggers]` を消すだけでは止まらない)がコメントに書いてある
    expect(toml).toContain("crons = []");
    expect(toml).toContain("消すだけでは止まらない");
    // 検出の確認(空振りでない): 2本目や別の式は拾う形
    expect('[triggers]\ncrons = ["0 0 * * *", "30 0 * * *"]\n'.match(/^crons\s*=\s*\[([^\]]*)\]\s*$/m)![1]!.split(",")).toHaveLength(2);
  });

  it("Issue #180・#183・#206・#208: netkeiba への取得の起点は、手動の 3 つ(POST の予約・GET の一覧・GET の確認。認証の後ろ)と、定時の 1 つ(scheduled の requestPlan)の呼び出し箇所 4 つに、結果の取り込みの依頼の呼び出し箇所 1 つ(result-dispatch.ts。cron と手動 POST が共有)を加えた計 5 つだけ", () => {
    const worker = readTextLf("cloud", "src", "worker.ts");
    const workerCode = stripCode(worker);
    expect(worker.length).toBeGreaterThan(100); // 前提: 読めている
    // scheduled は worker.ts に 1 経路だけで、scheduled.ts の runScheduled に委譲する(netkeiba にも DO にも直接出ない)
    expect((workerCode.match(/\bscheduled\s*\(/g) ?? []).length).toBe(1);
    expect((workerCode.match(/\brunScheduled\(/g) ?? []).length).toBe(1);
    expect(workerCode).not.toMatch(/\bqueue\b\s*\(/);
    for (const forbidden of ["NETKEIBA_GATE", "RACE_DAY", "fetch(", ".fetchRaw(", ".getRaceList(", ".schedule(", ".requestPlan("]) {
      // `fetch(` は export default の fetch ハンドラ(`async fetch(`)だけ: 呼び出しの形(`.fetch(` や `await fetch(`)を禁じる
      const pattern = forbidden === "fetch(" ? /(\.|await\s+)fetch\(/ : new RegExp(forbidden.replace(/[.()]/g, "\\$&"));
      expect(workerCode, `worker.ts に ${forbidden} が無い`).not.toMatch(pattern);
    }
    // scheduled.ts: DO の RPC は requestPlan の 1 つだけ。取得・予約・一覧の呼び出しを持たない
    const scheduledCode = stripCode(readTextLf("cloud", "src", "scheduled.ts"));
    expect(scheduledCode.length).toBeGreaterThan(500); // 前提: コメント除去で本文を消していない
    expect((scheduledCode.match(/\.requestPlan\(/g) ?? []).length).toBe(1);
    for (const forbidden of [".schedule(", ".getRaceList(", ".fetchRaw(", ".getBoard(", ".requestResultImport(", "NETKEIBA_GATE", "ANTHROPIC", "DISCORD"]) {
      expect(scheduledCode, `scheduled.ts に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // Issue #208: 結果の依頼は dispatchResultImports に委譲する(1 箇所)。D1 は結果の未取込の列挙(D1ResultStore)にだけ使う(env.DB は 1 箇所)
    expect((scheduledCode.match(/\bdispatchResultImports\(/g) ?? []).length).toBe(1);
    expect((scheduledCode.match(/\benv\.DB\b/g) ?? []).length).toBe(1);
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
    expect(count(/\.getRaceList\(/g)).toBe(1); // handleRaces(GET。Sec-Fetch-Site・検証の後)
    expect(count(/\.fetchRaw\(/g)).toBe(1); // handleCheck(GET /api/netkeiba/check)
    expect(count(/\.requestPlan\(/g)).toBe(0); // 計画の依頼は cron(scheduled.ts)だけ。手動の入口は呼ばない
    expect(count(/\.requestResultImport\(/g)).toBe(0); // 結果の依頼は result-dispatch.ts の 1 箇所だけ(handler.ts は dispatchResultImports に委譲する)
    expect(handler).toContain('"/api/races"');
    // 一覧の入口は、DO を呼ぶ前に Sec-Fetch-Site を見る
    expect(code.indexOf("sec-fetch-site")).toBeGreaterThan(-1);
    expect(code.indexOf("sec-fetch-site")).toBeLessThan(code.indexOf(".getRaceList("));
    // 起点の総数(呼び出し箇所): handler.ts(手動 3)+ scheduled.ts(定時 1)+ result-dispatch.ts(結果の依頼 1。cron と手動 POST が共有)= 5。worker.ts は 0
    const originCalls = (c: string): number => (c.match(/\.(schedule|getRaceList|fetchRaw|requestPlan|requestResultImport)\(/g) ?? []).length;
    const dispatchCode = stripCode(readTextLf("cloud", "src", "result-dispatch.ts"));
    expect(dispatchCode.length).toBeGreaterThan(1000); // 前提: 読めている
    expect(originCalls(code)).toBe(3);
    expect(originCalls(scheduledCode)).toBe(1);
    expect(originCalls(workerCode)).toBe(0);
    expect(originCalls(dispatchCode)).toBe(1);
    expect((dispatchCode.match(/\.requestResultImport\(/g) ?? []).length).toBe(1);
    expect(originCalls(code) + originCalls(scheduledCode) + originCalls(workerCode) + originCalls(dispatchCode)).toBe(5);
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
    expect(("await dispatchResultImports(x);\nexport async function dispatchResultImports(i) {}").match(/(?<!function\s)\bdispatchResultImports\(/g)).toHaveLength(1);
  });

  it("Issue #208・#216: 手動の POST を受けるルートは 4 つだけ(/api/settings・/api/analyses/run・/api/results/import・/api/migration/upload)。結果の取り込みの POST は、run と同じ守り(readJsonObjectBody)を通り、D1 の列挙 → 日ごとの依頼を dispatchResultImports に任せる", () => {
    const code = stripCode(readTextLf("cloud", "src", "handler.ts"));
    expect(code.length).toBeGreaterThan(1000); // 前提: 読めている
    // POST の分岐は 4 つ(`method === "POST"`)
    expect((code.match(/method === "POST"/g) ?? []).length).toBe(4);
    const routes = [...code.matchAll(/method === "POST" && new URL\(request\.url\)\.pathname === "([^"]+)"/g)].map((m) => m[1]);
    expect(routes).toEqual(["/api/analyses/run", "/api/results/import", "/api/migration/upload"]); // settings は pathname の分岐の中で method を見る
    expect(code).toMatch(/pathname === "\/api\/settings"/);
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
    for (const forbidden of [".schedule(", ".requestPlan(", ".getRaceList(", ".fetchRaw(", ".requestResultImport(", "NETKEIBA_GATE", "ANALYSIS_DETAIL", "ANTHROPIC", "DISCORD", "fetch("]) {
      expect(body, `handleResultsImport に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 対照(検出の確認。空振りでない)
    expect((body + "\nstub.requestResultImport(a);").includes(".requestResultImport(")).toBe(true);
  });

  it("Issue #208: 結果のページは、DO の中で gate 経由・キャッシュなしの HttpClient 1 本だけで取る(グローバルの fetch・bypassCache・CachedFetcher 経由では取らない)。D1 に出るのは 1 レースぶんの saveResult だけ", () => {
    const core = stripCode(readTextLf("cloud", "src", "race-day-core.ts"));
    expect(core.length).toBeGreaterThan(5000); // 前提: 読めている
    const count = (pattern: RegExp): number => (core.match(pattern) ?? []).length;
    expect(count(/createGateHttpClient\(/g)).toBe(1); // 取得のクライアントは 1 つ(gate 経由)
    expect(count(/serializeGate\(deps\.gate\)/g)).toBe(1); // 直列化した gate は 1 つ(キャッシュ付きの取得と結果の取得が同じ待ち行列を使う)
    expect(count(/this\.httpClient\.fetchText\(/g)).toBe(1); // 結果のページの取得は 1 箇所
    expect(count(/(\.|await\s+)fetch\(/g)).toBe(0); // グローバルの fetch に出ない
    expect(count(/bypassCache/g)).toBe(0); // キャッシュを通す取得(CachedFetcher)の bypassCache では取らない
    expect(count(/this\.setAlarm\(/g)).toBe(1); // アラームを張るのは rearm の 1 箇所だけ
    // runResultStep の本体は、キャッシュ付きの取得(networkFetcher・cacheOnly)を使わず、D1 は saveResult の 1 経路だけ
    const start = core.indexOf("private async runResultStep(");
    expect(start).toBeGreaterThan(-1);
    const end = core.indexOf("\n  }\n", start);
    const body = core.slice(start, end);
    expect(body.length).toBeGreaterThan(1500); // 前提: 本体を実際に読めている
    expect(body).toContain("this.httpClient.fetchText(");
    expect(body).toContain("importRaceResult(");
    expect(body).toContain("this.resultStore!.saveResult(");
    expect(body).toContain("winPayouts.length === 0"); // 払戻のテーブルが出てから保存する
    for (const forbidden of ["networkFetcher", "cacheOnly", "this.cache", "this.sink", "loadSettings", "fetch("]) {
      expect(body.replace(/this\.httpClient\.fetchText\(/g, ""), `runResultStep に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // 結果のステップを動かす条件(resultsRunnable)を、アラームの候補(rearm)と実行(runNextStep)の両方が使う
    expect(count(/this\.resultsRunnable\(\)/g)).toBe(2);
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
    expect(body).toContain("sec-fetch-site");
    expect(body).toContain("raceDayStub(");
    for (const forbidden of [".schedule(", ".requestPlan(", ".requestResultImport(", "dispatchResultImports(", "D1ResultStore", ".getRaceList(", ".fetchRaw(", ".getBoard(", "NETKEIBA_GATE", "env.DB", "ANALYSIS_DETAIL", "ANTHROPIC", "DISCORD_WEBHOOK_URL", "webhook", "fetch("]) {
      expect(body, `handlePlan に ${forbidden} が無い`).not.toContain(forbidden);
    }
    // DISCORD_WEBHOOK_URL を読むのは /api/health の「登録の有無」の 1 箇所だけ(値は返さない)
    expect((code.match(/env\.DISCORD_WEBHOOK_URL/g) ?? []).length).toBe(1);
    // 対照(検出の確認。空振りでない): 取得口を足した本文は拾う
    expect((body + "\nstub.getRaceList(a, b);").includes(".getRaceList(")).toBe(true);
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
  const CORE_SUBPATHS = ["pipeline", "llm", "scorer/snapshot-filter", "ev/bet-allocation", "ev/combo-bet-allocation"];

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

  it("@anthropic-ai/sdk は core と同じ版(core の範囲 `^X.Y.Z` の X.Y.Z)で、cloud/pnpm-lock.yaml にその版で固定されている(CI の --frozen-lockfile が通る前提)", () => {
    const cloudPkg = JSON.parse(readTextLf("cloud", "package.json")) as { dependencies: Record<string, string> };
    const corePkg = JSON.parse(readTextLf("packages", "core", "package.json")) as { dependencies: Record<string, string> };
    const version = cloudPkg.dependencies["@anthropic-ai/sdk"] ?? "";
    // 前提(空振り防止): 両方の版を実際に読めている
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(corePkg.dependencies["@anthropic-ai/sdk"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(corePkg.dependencies["@anthropic-ai/sdk"]).toBe(`^${version}`);
    const lock = readTextLf("cloud", "pnpm-lock.yaml");
    expect(lock).toMatch(new RegExp(`'@anthropic-ai/sdk':\\n\\s+specifier: ${version.replace(/\./g, "\\.")}\\n\\s+version: ${version.replace(/\./g, "\\.")}`));
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

describe("Issue #216: 移行の取り込み(CloudMigration)は netkeiba にも LLM にも出ず、定時の自動実行(cron → RaceDay)と干渉しない", () => {
  const migrationSources = ["migration-core.ts", "migration-do.ts", "migration-convert.ts", "migration-reader.ts", "migration-verify.ts"].map((f) => [f, stripCode(readTextLf("cloud", "src", f))] as const);

  it("移行のソース(5 ファイル)に、netkeiba の取得口・RaceDay・LLM・Discord・グローバルの fetch が無い", () => {
    expect(migrationSources).toHaveLength(5);
    for (const [name, code] of migrationSources) {
      expect(code.length, `${name} を読めている`).toBeGreaterThan(500);
      for (const forbidden of ["NETKEIBA_GATE", "fetchRaw", "postRaw", "RACE_DAY", "RaceDay", "ANTHROPIC", "DISCORD", "createCloudLlm", "createDiscordNotifier", "createGateHttpClient", "socket"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
      expect((code.match(/(^|[^.\w])fetch\(/g) ?? []).length, `${name} にグローバルの fetch が無い`).toBe(0);
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
      for (const forbidden of [".fetchRaw(", ".postRaw(", ".schedule(", ".getRaceList(", ".requestPlan(", ".requestResultImport(", "ANTHROPIC", "DISCORD", "ANALYSIS_DETAIL", "HttpClient", "CachedFetcher"]) {
        expect(code, `${name} に ${forbidden} が無い`).not.toContain(forbidden);
      }
      expect((code.match(/(^|[^.\w])fetch\(/g) ?? []).length, `${name} にグローバルの fetch が無い`).toBe(0);
    }
    // 補完が日単位の DO に呼ぶのは、dispatchResultImports 経由の依頼と、進行の読み取り(getResultImportProgress)だけ
    expect((core.match(/\.getResultImportProgress\(/g) ?? []).length).toBe(1);
    expect((core.match(/(?<!function\s)\bdispatchResultImports\(/g) ?? []).length).toBe(1);
    // DO の中: gate は status()、移行の DO は getStatus() を 1 回ずつ読むだけ
    expect((doCode.match(/\.status\(\)/g) ?? []).length).toBe(1);
    expect((doCode.match(/CLOUD_MIGRATION\.idFromName\(MIGRATION_NAME\)\)\.getStatus\(\)/g) ?? []).length).toBe(1);
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

  it("移行の DO の呼び出し(stub の start・getStatus)は handler.ts の移行の 2 つの API だけ。start の呼び出しは 1 箇所", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    expect((handler.match(/migrationStub\(env\)/g) ?? []).length).toBe(2); // GET /api/migration と POST /api/migration/upload
    expect((handler.match(/\bstub\.start\(/g) ?? []).length).toBe(1);
    // 検出の確認(空振りでない)
    expect(("a stub.start(x);\nb stub.start(y);".match(/\bstub\.start\(/g) ?? []).length).toBe(2);
  });

  it("アップロードの本文は解釈しない: handleMigrationUpload は request.body をそのまま R2 の put に渡す(text()・json()・arrayBuffer()・getReader で読まない)", () => {
    const handler = stripCode(readTextLf("cloud", "src", "handler.ts"));
    const start = handler.indexOf("async function handleMigrationUpload(");
    expect(start).toBeGreaterThan(-1);
    const end = handler.indexOf("\n}\n", start);
    const body = handler.slice(start, end);
    expect(body.length).toBeGreaterThan(1200); // 前提: 本体を実際に読めている
    expect(body).toContain("bucket.put(key, request.body");
    for (const forbidden of [".text()", ".json()", ".arrayBuffer()", ".blob()", "getReader(", "readLimitedText", "readJsonObjectBody"]) {
      expect(body, `handleMigrationUpload に ${forbidden} が無い`).not.toContain(forbidden);
    }
  });
});
