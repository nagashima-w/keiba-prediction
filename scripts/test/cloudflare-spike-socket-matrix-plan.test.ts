import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STATIC_SOCKET_HEADERS } from "../cloudflare-spike/echo.js";
import { MIN_INTERVAL_MS, MAX_NETKEIBA_REQUESTS } from "../cloudflare-spike/request-guard.js";
import {
  buildMatrixSocketBody,
  buildSocketMatrixPlan,
  REFERENCE_E3_SHUTUBA_BYTES,
  SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT,
} from "../cloudflare-spike/socket-matrix-plan.js";
import { isAllowedUrl } from "../cloudflare-spike/targets.js";
import { validateSocketRequest } from "../cloudflare-spike/worker-input.js";
import { parseRaceId } from "../../packages/core/src/scraper/ids.js";
import { narOddsPageUrl, oddsApiUrl, shutubaUrl, trioOddsApiUrl } from "../../packages/core/src/scraper/urls.js";

/**
 * #162 段階1(socket-matrix)の送信の計画。netkeiba へ出す本数・順序・対象は、ゲートで合意した内訳
 * (9 本。上限 10 本以内)から変えない。計画そのものがガードの前提(本数・順序)になるので、ここで固定する。
 */

const plan = buildSocketMatrixPlan();
const ids = plan.map((s) => s.id);

describe("buildSocketMatrixPlan: 本数と順序", () => {
  it("netkeiba へ出すのは 9 本で、1回の実行の上限 10 本以内(予備 1 本)", () => {
    expect(plan).toHaveLength(9);
    expect(plan.length).toBeLessThanOrEqual(MAX_NETKEIBA_REQUESTS);
    expect(MAX_NETKEIBA_REQUESTS - plan.length).toBe(1);
  });

  it("ステップ ID は一意で、ゲートで合意した順(ホストを交互に・gzip は最後)", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["S1", "R1", "N1", "O1", "T1", "N2", "S1r", "S1g", "T1g"]);
  });

  it("identity の 7 本がすべて先で、gzip の 2 本が最後(gzip が拒否の引き金になっても identity の結果を汚さない)", () => {
    const variants = plan.map((s) => s.variant);
    expect(variants).toEqual(["identity", "identity", "identity", "identity", "identity", "identity", "identity", "gzip", "gzip"]);
  });

  it("再現性の2本目(S1r)は、1本目(S1)から 5 本以上あいている(2 秒間隔なら 10 秒以上)", () => {
    const gap = ids.indexOf("S1r") - ids.indexOf("S1");
    expect(gap).toBeGreaterThanOrEqual(5);
    expect(gap * MIN_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("buildSocketMatrixPlan: 対象(URL は core の URL ビルダが作る。再実装しない)", () => {
  const byId = Object.fromEntries(plan.map((s) => [s.id, s]));
  const central = parseRaceId("202603020211");
  const nar = parseRaceId("202654071210");

  it.each([
    ["S1", shutubaUrl(central), "shutuba"],
    ["N1", shutubaUrl(nar), "shutuba"],
    ["O1", oddsApiUrl(central), "odds-json"],
    ["T1", trioOddsApiUrl(central), "combo-trio-json"],
    ["N2", narOddsPageUrl(nar), "nar-odds-page"],
  ])("%s の URL と kind", (id, url, kind) => {
    expect(byId[id]!.target.url).toBe(url);
    expect(byId[id]!.target.kind).toBe(kind);
  });

  it("R1 は db の戦績 API(horse-results)", () => {
    expect(byId["R1"]!.target.url).toMatch(/^https:\/\/db\.netkeiba\.com\/horse\/ajax_horse_results\.html\?/);
    expect(byId["R1"]!.target.kind).toBe("horse-results");
  });

  it("gzip の2本は、対にする identity の2本と同じ URL・同じ kind(変えるのは Accept-Encoding の1つだけ)", () => {
    expect(byId["S1g"]!.target.url).toBe(byId["S1"]!.target.url);
    expect(byId["S1g"]!.target.kind).toBe(byId["S1"]!.target.kind);
    expect(byId["T1g"]!.target.url).toBe(byId["T1"]!.target.url);
    expect(byId["T1g"]!.target.kind).toBe(byId["T1"]!.target.kind);
    expect(byId["S1g"]!.pairWith).toBe("S1");
    expect(byId["T1g"]!.pairWith).toBe("T1");
  });

  it("再現性の2本目は、1本目と同じ URL・同じ identity(S1r は S1 と対)", () => {
    expect(byId["S1r"]!.target.url).toBe(byId["S1"]!.target.url);
    expect(byId["S1r"]!.variant).toBe("identity");
    expect(byId["S1r"]!.pairWith).toBe("S1");
    expect(byId["S1r"]!.role).toBe("repeat");
  });

  it("すべて許可ホストの https で、ステップ内の target.id は、同じ URL なら同じ(記録を対象で突き合わせられる)", () => {
    for (const s of plan) {
      expect(isAllowedUrl(s.target.url)).toBe(true);
    }
    const idByUrl = new Map<string, string>();
    for (const s of plan) {
      const seen = idByUrl.get(s.target.url);
      if (seen !== undefined) {
        expect(s.target.id).toBe(seen);
      }
      idByUrl.set(s.target.url, s.target.id);
    }
    // 異なる URL は異なる target.id(対象の取り違えがない)。
    expect(new Set(idByUrl.values()).size).toBe(idByUrl.size);
    expect(idByUrl.size).toBe(6);
  });

  it("ホストの内訳は race 6 本・db 1 本・nar 2 本", () => {
    const hosts = plan.map((s) => new URL(s.target.url).hostname);
    const count = (h: string): number => hosts.filter((x) => x === h).length;
    expect({ race: count("race.netkeiba.com"), db: count("db.netkeiba.com"), nar: count("nar.netkeiba.com") }).toEqual({ race: 6, db: 1, nar: 2 });
    expect(hosts).toHaveLength(9);
  });

  it("役割(role): S1 は reference、gzip の2本は compression、S1r は repeat、残りは coverage", () => {
    expect(plan.map((s) => s.role)).toEqual(["reference", "coverage", "coverage", "coverage", "coverage", "coverage", "repeat", "compression", "compression"]);
  });
});

describe("定数", () => {
  it("#160 E3 の出馬表の本文バイト数は、リポジトリの round3-result.json の E3 の記録と一致する(転記ではなく再現できる値)", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "investigations", "cloudflare-spike", "round3-result.json");
    const json = JSON.parse(readFileSync(file, "utf-8")) as { origin: { records: { experiment: string; targetId: string; bodyLength: number }[] } };
    const e3 = json.origin.records.find((r) => r.experiment === "E3" && r.targetId === "central-shutuba");
    expect(e3).toBeDefined();
    expect(REFERENCE_E3_SHUTUBA_BYTES).toBe(e3!.bodyLength);
  });

  it("DO の呼び出しを数える試験は、Free の上限 50 を超える 51 回以上を要求する(60 回)", () => {
    expect(SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT).toBe(60);
    expect(SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT).toBeGreaterThan(50);
  });

  it("送るヘッダは E3 と同じ集合(User-Agent・accept・accept-language・sec-fetch-mode の4つ。この順)", () => {
    expect(STATIC_SOCKET_HEADERS.map((h) => h.name)).toEqual(["User-Agent", "accept", "accept-language", "sec-fetch-mode"]);
  });
});

/**
 * ドライバが DO の `/do/netkeiba-socket` へ送る本文の組み立て(#162 段階1のレビュー指摘)。ドライバのソースを正規表現で
 * 走査するのではなく、組み立てを関数にして、**Worker が実際に使う入力検査(validateSocketRequest)を通した結果**で、
 * gzip の opt-in が確かに渡ることを固定する(キー名を誤ると、検査を通った値に acceptEncoding が現れず、赤になる)。
 */
describe("buildMatrixSocketBody", () => {
  const headers = STATIC_SOCKET_HEADERS.map((h) => ({ name: h.name, value: h.value }));

  it("gzip のステップ(S1g・T1g)は、検査を通した結果に acceptEncoding: gzip が入る", () => {
    for (const step of plan.filter((s) => s.variant === "gzip")) {
      const v = validateSocketRequest(buildMatrixSocketBody(step, headers));
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.value.acceptEncoding).toBe("gzip");
      }
    }
    expect(plan.filter((s) => s.variant === "gzip").map((s) => s.id)).toEqual(["S1g", "T1g"]);
  });

  it("identity のステップ(7 本)は、acceptEncoding のキー自体を持たず、検査を通した結果にも入らない", () => {
    const identity = plan.filter((s) => s.variant === "identity");
    expect(identity).toHaveLength(7);
    for (const step of identity) {
      const body = buildMatrixSocketBody(step, headers);
      expect("acceptEncoding" in body).toBe(false);
      const v = validateSocketRequest(body);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.value.acceptEncoding).toBeUndefined();
      }
    }
  });

  it("対象(targetId・url・kind・encoding)とヘッダ(名前と値の順序)を、そのまま渡す。Accept-Encoding をヘッダには入れない", () => {
    for (const step of plan) {
      const v = validateSocketRequest(buildMatrixSocketBody(step, headers));
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.value).toMatchObject({ targetId: step.target.id, url: step.target.url, kind: step.target.kind, encoding: step.target.encoding });
        expect(v.value.headers).toEqual(headers);
        expect(v.value.headers.some((h) => h.name.toLowerCase() === "accept-encoding")).toBe(false);
      }
    }
  });
});
