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
import results2023103386 from "../fixtures/horse_results_2023103386.json";
import results2021105857 from "../fixtures/horse_results_2021105857.json";
import results2021105727 from "../fixtures/horse_results_2021105727.json";
import results2024104976 from "../fixtures/horse_results_2024104976.json";
import { parseKaisaiDate, parseRaceId } from "../packages/core/src/scraper/ids";
import { scrapeRace } from "../packages/core/src/scraper/scrape-race";
import type { AnalysisRecord } from "../packages/core/src/ev/analysis-store-types";
import narHtml from "../fixtures/nar_shutuba_202654071210.html";
import centralListHtml from "../fixtures/race_list_sub_20260628.html";
import narListHtml from "../fixtures/nar_race_list_sub_20260927.html";
import { NetkeibaGate as RealGate } from "./src/netkeiba-gate-do";
import type { ConnectFn, SocketLike } from "./src/socket-fetch";
import type { Env } from "./src/handler";
import { runCloudAnalysis } from "./src/pipeline";
import { RaceDay } from "./src/race-day-do";
import worker from "./src/worker";

/** 偽ソケットの印(本番のバンドルに入っていないことの検査に使う)。メインモジュールの export は Worker・DO のクラスだけにできるので、export しない。 */
const SMOKE_FAKE_SOCKET_MARKER = "keiba-smoke-fake-socket";

const encoder = new TextEncoder();

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
    const requestLine = /^GET (\S+) HTTP\/1\.1\r\n/.exec(requestText);
    const host = /\r\nHost: ([^\r\n]+)\r\n/.exec(requestText)?.[1] ?? "";
    const { status, body } = route(host, requestLine?.[1] ?? "");
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

export default {
  async fetch(request: Request, env: SmokeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
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
} satisfies ExportedHandler<SmokeEnv>;
