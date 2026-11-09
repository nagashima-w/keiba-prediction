import { describe, expect, it } from "vitest";

import { createJraFetchers } from "../src/jra-fetchers";
import type { JraPacer } from "../src/jra-odds-fetch";
import type { JraFetchLike } from "../src/jra-http";
import { installFetchTrap } from "./fetch-trap";
import { NOW_SUNDAY, fixtureBytes, FIXTURE_NAMES } from "./jra-baba-samples";

/**
 * Issue #680 項目 4: DO の中で、馬場の取得口とオッズの取得口が**同じ pacer**(JRA への 1.5 秒の間隔)を使うこと。
 * 配線が外れても気づけないので、DO から切り出した組み立て(`createJraFetchers`)で固定する。実 JRA には出ない(偽の fetch・グローバルの fetch は罠)。
 */
installFetchTrap();

function spyPacer(): { pacer: JraPacer; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pacer: {
      async beforeRequest() {
        calls.push("pacer");
      },
    },
  };
}
/** 馬場の 6 本に答える偽の fetch(中身は実物のフィクスチャ)。オッズの開催選択には、最低限の応答を返す(読めなくてもよい。間隔の呼び出しだけを見る)。 */
const fakeFetch: JraFetchLike = async (url) => {
  if (url.includes("_data_cushion")) return new Response(fixtureBytes(FIXTURE_NAMES.cushion), { status: 200 });
  if (url.includes("_data_moist")) return new Response(fixtureBytes(FIXTURE_NAMES.moist), { status: 200 });
  if (url.includes("accessJ")) return new Response(fixtureBytes(FIXTURE_NAMES.access), { status: 200 });
  if (url.includes("accessO")) return new Response("<html><title>x</title></html>", { status: 200 });
  if (url.includes("/keiba/baba/index")) return new Response(fixtureBytes(FIXTURE_NAMES.index1), { status: 200 });
  throw new Error(`想定外の URL: ${url}`);
};

describe("createJraFetchers: 馬場とオッズが同じ間隔(pacer)を共有する", () => {
  it("馬場の取得とオッズの取得の両方が、渡した同じ pacer を送信の前に呼ぶ", async () => {
    const spy = spyPacer();
    const fetchers = createJraFetchers({ oddsEnabled: true, pacer: spy.pacer, fetch: fakeFetch, wait: async () => undefined });
    await fetchers.fetchBaba(NOW_SUNDAY);
    const afterBaba = spy.calls.length;
    expect(afterBaba).toBeGreaterThan(0); // 馬場が pacer を使った
    await fetchers.fetchJraOdds!.open().listVenues("20261108");
    expect(spy.calls.length).toBeGreaterThan(afterBaba); // オッズも同じ pacer を使った
  });

  it("オッズを無効にすると fetchJraOdds は無い(従来と同じ)。馬場は pacer を使う", async () => {
    const spy = spyPacer();
    const fetchers = createJraFetchers({ oddsEnabled: false, pacer: spy.pacer, fetch: fakeFetch, wait: async () => undefined });
    expect(fetchers.fetchJraOdds).toBeUndefined();
    await fetchers.fetchBaba(NOW_SUNDAY);
    expect(spy.calls.length).toBeGreaterThan(0);
  });

  it("pacer を省くと、組み立ての中で 1 つ作って両方に渡す(既定の経路)", async () => {
    const waits: number[] = [];
    const fetchers = createJraFetchers({ oddsEnabled: true, fetch: fakeFetch, wait: async (ms) => void waits.push(ms) });
    await fetchers.fetchBaba(NOW_SUNDAY);
    await fetchers.fetchJraOdds!.open().listVenues("20261108");
    expect(waits.length).toBeGreaterThan(0); // 馬場の 6 本の間・直後のオッズの 1 本に、pacer が間隔を入れた
  });
});
