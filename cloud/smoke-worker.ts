/**
 * **ローカルの smoke 専用**のエントリ(Issue #162 段階2b)。本番の `wrangler.toml` の `main` ではない(smoke が生成する一時設定だけがこれを指す)。
 *
 * 目的: netkeiba へ出さずに、workerd と nodejs_compat の実環境で、
 *   Worker → DO(NetkeibaGate) → ソケットクライアント → HttpClient → cheerio(core のパーサ)
 * が fixture で通り、頭数が返ることを確かめる。DO の `connectFn()` を、**偽ソケット**(リクエストの Host とパスを見て、保存済みの
 * fixture を HTTP/1.1 の応答として返す)に差し替えたサブクラスを `NetkeibaGate` として export する。
 *
 * **本番のバンドルには入らない**: 本番のエントリ(`src/worker.ts`)はこのファイルを import しない。偽ソケットの印({@link SMOKE_FAKE_SOCKET_MARKER})が
 * 本番の dry-run のバンドルに無いことを `test/bundle-guard.test.ts` が固定している。
 */
import centralHtml from "../fixtures/shutuba_202603020211.html";
import oikiriHtml from "../fixtures/oikiri_202603020211.html";
import oddsJson from "../fixtures/odds_202603020211.json";
import oddsWideJson from "../fixtures/odds_wide_202603020211.json";
import oddsTrioJson from "../fixtures/odds_trio_202603020211.json";
import oddsQuinellaJson from "../fixtures/odds_quinella_202603020211.json";
import oddsExactaJson from "../fixtures/odds_exacta_202603020211.json";
import oddsTrifectaJson from "../fixtures/odds_trifecta_202603020211.json";
import oddsWakurenJson from "../fixtures/odds_wakuren_202603020211.json";
import gradeWinnerJson from "../fixtures/grade_winner_202603020211.json";
import gradeWinnerNarJson from "../fixtures/grade_winner_nar_202644070111.json";
import results2023103386 from "../fixtures/horse_results_2023103386.json";
import results2021105857 from "../fixtures/horse_results_2021105857.json";
import results2021105727 from "../fixtures/horse_results_2021105727.json";
import results2024104976 from "../fixtures/horse_results_2024104976.json";
import { parseKaisaiDate, parseRaceId } from "../packages/core/src/scraper/ids";
import { scrapeRace } from "../packages/core/src/scraper/scrape-race";
import type { AnalysisRecord } from "../packages/core/src/ev/analysis-store-types";
import narHtml from "../fixtures/nar_shutuba_202654071210.html";
import centralListHtml from "../fixtures/race_list_sub_20260628.html";
import resultCentralHtml from "../fixtures/result_202603020211.html";
import resultNarPresaleHtml from "../fixtures/nar_result_presale_202642071612.html";
import narListHtml from "../fixtures/nar_race_list_sub_20260927.html";
import { NetkeibaGate as RealGate } from "./src/netkeiba-gate-do";
import type { ConnectFn, SocketLike } from "./src/socket-fetch";
import type { Env } from "./src/handler";
import { runCloudAnalysis } from "./src/pipeline";
import { RaceDay } from "./src/race-day-do";
import { D1ResultStore } from "./src/result-repository";
import worker from "./src/worker";

/** 偽ソケットの印(本番のバンドルに入っていないことの検査に使う)。メインモジュールの export は Worker・DO のクラスだけにできるので、export しない。 */
const SMOKE_FAKE_SOCKET_MARKER = "keiba-smoke-fake-socket";

const encoder = new TextEncoder();

/**
 * POST の応答(Issue #181。重賞の過去10年傾向の API)。実際に送られたバイト列を見て、ヘッダ(Content-Type・X-Requested-With・Referer・Origin)と
 * `Content-Length`(本文のバイト長と一致)が揃っていなければ 400 を返す(workerd の実環境で、組み立てたリクエストが正しいことの確認)。
 * 本文の race_id が中央 202603020211(race ホスト)・地方 202644070111(nar ホスト)なら fixture の JSON、202605010101 なら 403(POST のブレーカーの確認用)、それ以外は 404。
 */
function routePost(host: string, path: string, requestText: string): { status: number; body: string } {
  const headEnd = requestText.indexOf("\r\n\r\n");
  const head = requestText.slice(0, headEnd);
  const body = requestText.slice(headEnd + 4);
  const length = /\r\nContent-Length: (\d+)\r\n/i.exec(`${head}\r\n`)?.[1];
  const wellFormed =
    path === "/race_api/" &&
    /\r\nContent-Type: application\/x-www-form-urlencoded; charset=UTF-8\r\n/.test(head) &&
    /\r\nX-Requested-With: XMLHttpRequest\r\n/.test(head) &&
    new RegExp(`\\r\\nReferer: https://${host.replace(/\./g, "\\.")}/race/past(?:10|5)\\.html\\?race_id=\\d{12}\\r\\n`).test(head) &&
    head.includes(`\r\nOrigin: https://${host}\r\n`) &&
    length === String(encoder.encode(body).length) &&
    body.startsWith("input=UTF-8&output=json&class=AplGradeWinner&method=get&compress=1&race_id=");
  if (!wellFormed) {
    return { status: 400, body: "malformed POST by fake socket" };
  }
  const raceId = /race_id=(\d{12})$/.exec(body)?.[1] ?? "";
  if (host === "race.netkeiba.com" && raceId === "202603020211") {
    return { status: 200, body: JSON.stringify(gradeWinnerJson) };
  }
  if (host === "nar.netkeiba.com" && raceId === "202644070111") {
    return { status: 200, body: JSON.stringify(gradeWinnerNarJson) };
  }
  if (host === "race.netkeiba.com" && raceId === "202605010101") {
    return { status: 403, body: "forbidden by fake socket" };
  }
  return { status: 404, body: "not found by fake socket" };
}

/** リクエストの Host とパスから、返す応答(ステータスと本文)を決める。 */
function route(host: string, path: string): { status: number; body: string } {
  const raceId = /[?&]race_id=(\d{12})(?:&|$)/.exec(path)?.[1] ?? "";
  if (host === "race.netkeiba.com" && path.startsWith("/race/shutuba.html") && raceId === "202603020211") {
    return { status: 200, body: centralHtml };
  }
  if (host === "nar.netkeiba.com" && path.startsWith("/race/shutuba.html") && raceId === "202654071210") {
    return { status: 200, body: narHtml };
  }
  // Issue #183: 開催日のレース一覧(race_list_sub)。中央は 20260628・地方は 20260927 だけ実フィクスチャ。それ以外の日は、開催なしの空の HTML(200)。
  if (path.startsWith("/top/race_list_sub.html") && (host === "race.netkeiba.com" || host === "nar.netkeiba.com")) {
    const date = /[?&]kaisai_date=(\d{8})(?:&|$)/.exec(path)?.[1] ?? "";
    if (host === "race.netkeiba.com" && date === "20260628") {
      return { status: 200, body: centralListHtml };
    }
    if (host === "nar.netkeiba.com" && date === "20260927") {
      return { status: 200, body: narListHtml };
    }
    return { status: 200, body: "<html><body></body></html>" };
  }
  // Issue #177: RaceDay(朝の取得)の確認用。出馬表のほかに、戦績 API(db ホスト)・調教・単勝複勝のオッズ(type=1)を fixture で返す。
  if (host === "db.netkeiba.com" && path.startsWith("/horse/ajax_horse_results.html")) {
    return { status: 200, body: fixtureText(`https://db.netkeiba.com${path}`) };
  }
  if (host === "race.netkeiba.com" && path.startsWith("/race/oikiri.html") && raceId === "202603020211") {
    return { status: 200, body: oikiriHtml };
  }
  if (host === "race.netkeiba.com" && path.startsWith("/api/api_get_jra_odds.html") && raceId === "202603020211" && /[?&]type=1(&|$)/.test(path)) {
    return { status: 200, body: JSON.stringify(oddsJson) };
  }
  // Issue #208: 結果ページ。中央は確定済みの実フィクスチャ(202603020211)、地方は発売前で結果の行が無い実フィクスチャ(202642071612。未確定の経路)。
  if (host === "race.netkeiba.com" && path.startsWith("/race/result.html") && raceId === "202603020211") {
    return { status: 200, body: resultCentralHtml };
  }
  if (host === "nar.netkeiba.com" && path.startsWith("/race/result.html") && raceId === "202642071612") {
    return { status: 200, body: resultNarPresaleHtml };
  }
  // ブレーカーの確認用: この race_id は、netkeiba に拒否された(403)ことにする。
  if (host === "race.netkeiba.com" && raceId === "202605010101") {
    return { status: 403, body: "forbidden by fake socket" };
  }
  return { status: 404, body: "not found by fake socket" };
}

const fakeConnect: ConnectFn = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let requestText = "";
  let responded = false;
  const respond = (): void => {
    responded = true;
    const requestLine = /^(GET|POST) (\S+) HTTP\/1\.1\r\n/.exec(requestText);
    const host = /\r\nHost: ([^\r\n]+)\r\n/.exec(requestText)?.[1] ?? "";
    const { status, body } =
      requestLine?.[1] === "POST" ? routePost(host, requestLine[2] ?? "", requestText) : route(host, requestLine?.[2] ?? "");
    const bodyBytes = encoder.encode(body);
    const head = encoder.encode(
      `HTTP/1.1 ${status} X\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: ${bodyBytes.length}\r\nX-Smoke: ${SMOKE_FAKE_SOCKET_MARKER}\r\nConnection: close\r\n\r\n`,
    );
    controller.enqueue(head);
    // 小さな断片に分けて返す(読み取りのループを通す)。
    for (let offset = 0; offset < bodyBytes.length; offset += 16 * 1024) {
      controller.enqueue(bodyBytes.subarray(offset, offset + 16 * 1024));
    }
    controller.close();
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      requestText += new TextDecoder().decode(chunk);
      if (!responded && requestText.includes("\r\n\r\n")) {
        respond();
      }
    },
  });
  const socket: SocketLike = {
    readable,
    writable,
    opened: Promise.resolve({}),
    close: async () => {},
  };
  return socket;
};

export class NetkeibaGate extends RealGate {
  protected override connectFn(): ConnectFn {
    return fakeConnect;
  }
}

/**
 * Issue #176: runAnalysis(クラウド版の入口 runCloudAnalysis)を、workerd と nodejs_compat の実環境で、フィクスチャ(中央16頭 202603020211・
 * 全券種の組合せオッズ・LLM なし)から最後まで走らせる。結果(AnalysisResult)と保存レコード(AnalysisRecord)の SHA-256 を返す。
 * smoke.ts が、exe 側の golden(`packages/app/test/golden/pipeline-golden.json` の noLlmAllBets。変更前のコミットで生成)の
 * 同じ SHA-256 と照合する(Node で走る cloud の単体テストに加えて、workerd でも同じ出力になることの確認)。
 * **この経路は smoke 専用で、本番のエントリ(worker.ts)には無い**(認証の関門の前に置いている。netkeiba にも Anthropic にも出ない)。
 */
const RESULTS_BY_HORSE: Record<string, unknown> = {
  "2023103386": results2023103386,
  "2023105684": results2021105857,
  "2023104885": results2021105727,
  "2023101569": results2024104976,
};

function fixtureText(url: string): string {
  if (url.includes("shutuba.html")) return centralHtml;
  if (url.includes("ajax_horse_results")) {
    const horseId = /[?&]id=([^&]+)/.exec(url)?.[1] ?? "";
    return JSON.stringify(RESULTS_BY_HORSE[horseId] ?? results2021105857);
  }
  if (url.includes("oikiri.html")) return oikiriHtml;
  if (url.includes("type=5")) return JSON.stringify(oddsWideJson);
  if (url.includes("type=7")) return JSON.stringify(oddsTrioJson);
  if (url.includes("type=4")) return JSON.stringify(oddsQuinellaJson);
  if (url.includes("type=6")) return JSON.stringify(oddsExactaJson);
  if (url.includes("type=8")) return JSON.stringify(oddsTrifectaJson);
  if (url.includes("type=3")) return JSON.stringify(oddsWakurenJson);
  if (url.includes("api_get_jra_odds")) return JSON.stringify(oddsJson);
  throw new Error(`未知のURL: ${url}`);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function smokeAnalysis(): Promise<Response> {
  const fixedNow = (): Date => new Date("2026-06-28T12:00:00.000Z");
  const raceId = parseRaceId("202603020211");
  const race = await scrapeRace(
    raceId,
    { fetcher: { fetchText: async (url) => fixtureText(url) }, now: fixedNow },
    { includeComboOdds: true },
  );
  const saved: AnalysisRecord[] = [];
  const result = await runCloudAnalysis(raceId, parseKaisaiDate("20260628"), {
    scrape: async () => race,
    analyze: null,
    saveAnalysis: async (record) => {
      saved.push(record);
      return { id: saved.length, detail: "stored" };
    },
    allocationSettings: {
      bankroll: 1_000_000,
      perRaceCap: 100_000,
      kellyFraction: 0.5,
      includeComboOdds: true,
      includeWideInAllocation: true,
      includeTrioInAllocation: true,
      includeQuinellaInAllocation: true,
      includeExactaInAllocation: true,
      includeTrifectaInAllocation: true,
      includeBracketQuinellaInAllocation: true,
    },
    llmSkipReason: "golden: LLM なし",
    now: fixedNow,
  });
  const record = saved[0];
  return Response.json({
    ok: true,
    saved: saved.length,
    rows: result.rows.length,
    bets: record?.allocation?.bets.length ?? 0,
    resultSha256: await sha256Hex(JSON.stringify(result)),
    recordSha256: await sha256Hex(JSON.stringify(record)),
  });
}

/** 日単位の DO(Issue #177)。本番の入口(#180)はまだ無いので、smoke だけが RPC を呼ぶ。 */
export { RaceDay };
// Issue #216: 移行の DO(本番の worker.ts と同じもの。偽ソケットも netkeiba への経路も持たない)。wrangler は binding のクラスが入口から export されていることを要求する。
export { CloudMigration } from "./src/migration-do";
export { ResultBackfill } from "./src/result-backfill-do";
export { VerifyReportDO } from "./src/verify-do";

type SmokeEnv = Env;

/**
 * Issue #177: 日単位の DO `RaceDay` を、workerd の実環境(本物の DO の SQLite・アラーム・NetkeibaGate への RPC・偽ソケット)で通す。
 *  - `/smoke/race-day/schedule?date=...&race_id=...`: 予約(RPC。予約だけをして戻る)
 *  - `/smoke/race-day/board?date=...`: 状態(RPC)
 *  - `/smoke/race-day/prior?date=...&race_id=...`: 朝の prior の要約(RPC。頭数・LLM の使用・組合せオッズの有無・prior の値)
 * smoke 専用(認証の関門の前に置く。netkeiba にも Anthropic にも出ない)。
 */
async function smokeRaceDay(url: URL, env: SmokeEnv): Promise<Response> {
  const date = url.searchParams.get("date") ?? "";
  const stub = env.RACE_DAY.get(env.RACE_DAY.idFromName(date));
  if (url.pathname === "/smoke/race-day/request-result") {
    return Response.json(await stub.requestResultImport({ kaisaiDate: date, raceIds: (url.searchParams.get("race_ids") ?? "").split(",").filter((x) => x !== "") }));
  }
  if (url.pathname === "/smoke/race-day/schedule") {
    return Response.json(await stub.schedule({ raceId: url.searchParams.get("race_id") ?? "", kaisaiDate: date }));
  }
  if (url.pathname === "/smoke/race-day/board") {
    return Response.json(await stub.getBoard());
  }
  const prior = await stub.getMorningPrior(url.searchParams.get("race_id") ?? "");
  return Response.json(
    prior === null
      ? { ok: true, prior: null }
      : {
          ok: true,
          prior: {
            rows: prior.result.rows.length,
            llmUsed: prior.result.llmUsed,
            dateApproximate: prior.result.dateApproximate,
            hasWideCombo: "wideCombo" in prior.result,
            priors: prior.result.rows.map((r) => [r.umaban, r.prior]),
          },
        },
  );
}

/**
 * Issue #208: 結果の取り込みの確認用（smoke 専用。認証の関門の前に置く。netkeiba にも Anthropic にも出ない）。
 *  - `/smoke/race-day/request-result?date=...&race_ids=a,b`: 結果の取り込みの依頼（RPC。依頼だけをして戻る）
 *  - `/smoke/results?race_id=...`: D1 に保存された結果（馬の頭数・面。無ければ null）
 *  - `/smoke/results/clear?race_id=...`: D1 の結果の行を消す（ローカルの D1 だけ。DO の「取り込み済み」の行は残る）
 */
async function smokeResults(url: URL, env: SmokeEnv): Promise<Response> {
  const raceId = url.searchParams.get("race_id") ?? "";
  if (url.pathname === "/smoke/results/clear") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM race_results WHERE race_id = ?").bind(raceId),
      env.DB.prepare("DELETE FROM race_result_meta WHERE race_id = ?").bind(raceId),
      env.DB.prepare("DELETE FROM race_combo_payouts WHERE race_id = ?").bind(raceId),
      env.DB.prepare("DELETE FROM race_combo_payout_imports WHERE race_id = ?").bind(raceId),
    ]);
    return Response.json({ ok: true });
  }
  const detail = (await new D1ResultStore({ db: env.DB }).getRaceResultDetails([raceId])).get(raceId);
  const combos = await env.DB.prepare("SELECT count(*) AS n FROM race_combo_payouts WHERE race_id = ?").bind(raceId).first<{ n: number }>();
  return Response.json({ ok: true, result: detail === undefined ? null : { horses: detail.horses.length, courseType: detail.courseType ?? null, comboPayoutRows: combos?.n ?? 0 } });
}

export default {
  async fetch(request: Request, env: SmokeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/smoke/results" || url.pathname === "/smoke/results/clear") {
      try {
        return await smokeResults(url, env);
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 500 });
      }
    }
    if (url.pathname.startsWith("/smoke/race-day/")) {
      try {
        return await smokeRaceDay(url, env);
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 500 });
      }
    }
    if (new URL(request.url).pathname === "/smoke/analysis") {
      try {
        return await smokeAnalysis();
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 500 });
      }
    }
    return worker.fetch(request, env, ctx);
  },
  /**
   * Issue #206: 本番の `scheduled`(cron の入口)をそのまま呼ぶ転送。smoke が `/cdn-cgi/local/scheduled?time=...`(wrangler dev が提供する、cron の手動発火)で起動する。
   * 本番では手動で scheduled を起動する手段が無いので、workerd と本物の DO・偽ソケットでの確認はここだけ。
   */
  async scheduled(controller: ScheduledController, env: SmokeEnv): Promise<void> {
    await worker.scheduled(controller, env);
  },
} satisfies ExportedHandler<SmokeEnv>;
