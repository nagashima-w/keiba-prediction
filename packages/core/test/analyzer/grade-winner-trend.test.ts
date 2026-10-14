import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  collectGradeWinnerTrend,
  excludeLookaheadEntries,
  summarizeGradeWinnerTrend,
  type GradeWinnerConditions,
} from "../../src/analyzer/grade-winner-trend.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import {
  parseGradeWinnerResponse,
  type GradeWinnerEntry,
  type GradeWinnerResultHorse,
} from "../../src/scraper/parse-grade-winner.js";

/** フィクスチャ(JSON文字列)を読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** テスト用: 最小限のGradeWinnerResultHorseを組み立てる(正常=ijyo null・降着なし)。 */
function horse(overrides: Partial<GradeWinnerResultHorse> = {}): GradeWinnerResultHorse {
  return {
    wakuban: null,
    umaban: null,
    kakutei: null,
    nyusen: null,
    dochakuCd: null,
    dochakuTosu: null,
    ijyo: null,
    corner: null,
    haron3: null,
    ninki: null,
    chakusa: null,
    ...overrides,
  };
}

/**
 * テスト用: レースIDに任意の場コード(2桁)を埋め込む(要修正8: 条件フィルタの場一致は
 * jyo文字列ではなくraceId.slice(4,6)同士の比較に変更したため、テスト側もraceIdで場を表す)。
 * 12桁形式(YYYY+場コード2桁+回次2桁+日次2桁+レース番号2桁)を維持する。
 */
function raceIdWithTrackCode(trackCode: string): string {
  return `2025${trackCode}020211`;
}

/** 条件一致のデフォルト場コード(福島=03)。 */
const FUKUSHIMA_TRACK_CODE = "03";
/** 場違い(条件不一致)テスト用の場コード(中山=06)。 */
const NAKAYAMA_TRACK_CODE = "06";

/** テスト用: 最小限のGradeWinnerEntryを組み立てる。デフォルトraceIdの場コードはCONDITIONSと一致(福島)。 */
function entry(overrides: Partial<GradeWinnerEntry> = {}): GradeWinnerEntry {
  return {
    raceId: raceIdWithTrackCode(FUKUSHIMA_TRACK_CODE),
    raceDate: null,
    jyo: "福島",
    nkai: null,
    kyori: 1800,
    track: "芝",
    fence: "A",
    baba: "良",
    tenko: "晴",
    tosu: 14,
    haronL3: null,
    haronS3: null,
    result: [],
    payback: null,
    ...overrides,
  };
}

const CONDITIONS: GradeWinnerConditions = {
  trackCode: FUKUSHIMA_TRACK_CODE,
  track: "芝",
  kyori: 1800,
};

describe("summarizeGradeWinnerTrend(条件フィルタ)", () => {
  it("trackCode(場コード)+track+kyoriがすべて一致する回だけを条件一致として数えること", () => {
    const entries = [
      entry(), // 一致
      entry({ raceId: raceIdWithTrackCode(NAKAYAMA_TRACK_CODE) }), // 場違い
      entry({ track: "ダ" }), // 面違い
      entry({ kyori: 2000 }), // 距離違い
      entry(), // 一致
      entry(), // 一致
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS);
    expect(summary).not.toBeNull();
    expect(summary!.対象回数).toBe(6);
    expect(summary!.条件一致回数).toBe(3);
    expect(summary!.条件除外回数).toBe(3);
  });

  it("raceIdがnull(パース不能)の回は場不一致として除外すること", () => {
    const entries = [entry(), entry(), entry(), entry({ raceId: null })];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.対象回数).toBe(4);
    expect(summary.条件一致回数).toBe(3);
  });

  it("jyo(会場名の文字列)が実際のAPI表記(例: 大井)とconditions側の値が違っていても、raceId由来の場コードが一致すれば条件一致に含めること(要修正8: jyo文字列同士の比較はしない)", () => {
    // jyoの文字列が仮に食い違っていても(例: 表記ゆれ・未知の地方場コード)、raceIdの場コードさえ
    // 一致していれば条件一致として扱われることを確認する。
    const entries = [
      entry({ jyo: "この値は比較に使われない" }),
      entry({ jyo: "" }),
      entry({ jyo: null }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.条件一致回数).toBe(3);
  });

  it("柵(coursekubun_cd)はフィルタに使わず、柵が異なっていても条件一致に含めること", () => {
    const entries = [entry({ fence: "A" }), entry({ fence: "B" }), entry({ fence: "C" })];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS);
    expect(summary!.条件一致回数).toBe(3);
  });

  it("条件一致が3回未満のときはブロック全体を非表示(null)にすること(境界: 2回)", () => {
    const entries = [entry(), entry(), entry({ raceId: raceIdWithTrackCode(NAKAYAMA_TRACK_CODE) })];
    expect(summarizeGradeWinnerTrend(entries, CONDITIONS)).toBeNull();
  });

  it("条件一致がちょうど3回のときは表示すること(境界: 3回)", () => {
    const entries = [entry(), entry(), entry()];
    expect(summarizeGradeWinnerTrend(entries, CONDITIONS)).not.toBeNull();
  });

  it("空配列(取得0件)ではnullを返すこと", () => {
    expect(summarizeGradeWinnerTrend([], CONDITIONS)).toBeNull();
  });
});

describe("summarizeGradeWinnerTrend(基礎: 頭数レンジ・馬場内訳・柵内訳)", () => {
  it("条件一致した回のみから頭数レンジ・馬場内訳・柵内訳を集計すること", () => {
    const entries = [
      entry({ tosu: 12, baba: "良", fence: "A" }),
      entry({ tosu: 16, baba: "良", fence: "A" }),
      entry({ tosu: 14, baba: "稍重", fence: "B" }),
      entry({
        raceId: raceIdWithTrackCode(NAKAYAMA_TRACK_CODE),
        tosu: 99,
        baba: "不良",
        fence: "Z",
      }), // 除外対象(集計に混ぜない)
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.頭数レンジ).toEqual({ min: 12, max: 16 });
    expect(summary.馬場内訳).toEqual(
      expect.arrayContaining([
        { 値: "良", 回数: 2 },
        { 値: "稍重", 回数: 1 },
      ]),
    );
    expect(summary.柵内訳).toEqual(
      expect.arrayContaining([
        { 値: "A", 回数: 2 },
        { 値: "B", 回数: 1 },
      ]),
    );
  });
});

describe("summarizeGradeWinnerTrend(複勝圏内馬の判定: 確定着順を正とする)", () => {
  it("kakutei<=3の馬だけを複勝圏内として数え、4着以下は含めないこと", () => {
    const entries = [
      entry({ result: [horse({ kakutei: 1 }), horse({ kakutei: 2 }), horse({ kakutei: 4 })] }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(2);
  });

  it("降着(kakutei!==nyusen)の馬は確定着順(kakutei)を正として判定すること(入線2着でも確定4着なら複勝圏内に含めない)", () => {
    const entries = [
      entry({ result: [horse({ nyusen: 2, kakutei: 4 })] }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(0);
  });

  it("同着(dochaku_cd/dochaku_tosuが非null)で複勝が4頭になるケースも、kakutei<=3の全馬を複勝圏内に含めること", () => {
    const entries = [
      entry({
        result: [
          horse({ kakutei: 1 }),
          horse({ kakutei: 2 }),
          horse({ kakutei: 3, dochakuCd: "1", dochakuTosu: 2 }),
          horse({ kakutei: 3, dochakuCd: "1", dochakuTosu: 2 }),
        ],
      }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(4);
  });

  it("ijyoが非null(取消・除外・中止等)の馬は、kakuteiが数値でも複勝圏内から除外すること(防御的)", () => {
    const entries = [
      entry({ result: [horse({ kakutei: 1, ijyo: "取消" })] }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(0);
  });
});

describe("summarizeGradeWinnerTrend(人気傾向・複勝配当傾向)", () => {
  it("複勝圏内馬のninkiから人気レンジと二桁人気頭数を集計すること", () => {
    const entries = [
      entry({
        result: [horse({ kakutei: 1, ninki: 4 }), horse({ kakutei: 2, ninki: 12 })],
      }),
      entry({ result: [horse({ kakutei: 1, ninki: 1 })] }),
      entry({ result: [horse({ kakutei: 3, ninki: 9 })] }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.人気レンジ).toEqual({ min: 1, max: 12 });
    expect(summary.二桁人気頭数).toBe(1);
  });

  // 二桁人気頭数の境界(テーブル駆動): ninki=9は非該当、ninki=10は該当。
  it.each([
    { ninki: 9, expected: 0, label: "9番人気は二桁人気に含めないこと" },
    { ninki: 10, expected: 1, label: "10番人気は二桁人気に含めること" },
  ])("二桁人気の境界: $label", ({ ninki, expected }) => {
    const entries = [
      entry({ result: [horse({ kakutei: 1, ninki })] }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.二桁人気頭数).toBe(expected);
  });

  it("複勝圏内馬のninkiがnull/0の場合、人気サンプル数が複勝圏内馬数より少なくなること(標本数の食い違い・条件f)", () => {
    const entries = [
      entry({
        result: [
          horse({ kakutei: 1, ninki: 3 }),
          horse({ kakutei: 2, ninki: null }),
          horse({ kakutei: 3, ninki: 0 }),
        ],
      }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    // 複勝圏内馬数は3頭(ninkiの有無に関わらず全員数える)だが、人気サンプル数はninki有効な1頭のみ。
    expect(summary.複勝圏内馬数).toBe(3);
    expect(summary.人気サンプル数).toBe(1);
    expect(summary.人気サンプル数).toBeLessThan(summary.複勝圏内馬数);
  });

  it("payback.fuku_pay1〜3から複勝配当のレンジ・中央値・サンプル数を集計すること", () => {
    const entries = [
      entry({ payback: { fukuPay1: 280, fukuNinki1: 6, fukuPay2: 200, fukuNinki2: 1, fukuPay3: 430, fukuNinki3: 9 } }),
      entry({ payback: { fukuPay1: 150, fukuNinki1: 1, fukuPay2: 160, fukuNinki2: 2, fukuPay3: 170, fukuNinki3: 3 } }),
      entry({ payback: { fukuPay1: 900, fukuNinki1: 10, fukuPay2: null, fukuNinki2: null, fukuPay3: null, fukuNinki3: null } }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    // 値一覧: 280,200,430,150,160,170,900 (nullは除外)
    expect(summary.複勝配当レンジ).toEqual({ min: 150, max: 900 });
    expect(summary.複勝配当中央値).toBe(200);
    expect(summary.複勝配当サンプル数).toBe(7);
  });

  it("paybackが丸ごとnullのレースが混ざっていてもクラッシュせず、他レースの値だけで集計すること(複勝配当サンプル数も他回の件数のみ)", () => {
    const entries = [
      entry({ payback: null }),
      entry({ payback: { fukuPay1: 300, fukuNinki1: 1, fukuPay2: 300, fukuNinki2: 2, fukuPay3: 300, fukuNinki3: 3 } }),
      entry({ payback: null }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝配当レンジ).toEqual({ min: 300, max: 300 });
    expect(summary.複勝配当中央値).toBe(300);
    expect(summary.複勝配当サンプル数).toBe(3);
  });

  it("境界: fuku_pay3のみ欠損する回は、複勝圏内馬数は3のまま・複勝配当サンプル数は2になること(条件a)", () => {
    const entries = [
      entry({
        result: [horse({ kakutei: 1 })],
        payback: {
          fukuPay1: 280,
          fukuNinki1: 1,
          fukuPay2: 200,
          fukuNinki2: 2,
          fukuPay3: null,
          fukuNinki3: null,
        },
      }),
      entry({ result: [horse({ kakutei: 1 })], payback: null }),
      entry({ result: [horse({ kakutei: 1 })], payback: null }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(3);
    expect(summary.複勝配当サンプル数).toBe(2);
  });

  it("異常系: fuku_pay1〜3が全欠のとき、複勝配当サンプル数=0かつ複勝配当レンジ=nullになるが、複勝圏内馬数は影響を受けないこと(条件b)", () => {
    const entries = [
      entry({
        result: [horse({ kakutei: 1 })],
        payback: {
          fukuPay1: null,
          fukuNinki1: null,
          fukuPay2: null,
          fukuNinki2: null,
          fukuPay3: null,
          fukuNinki3: null,
        },
      }),
      entry({ result: [horse({ kakutei: 1 })] }),
      entry({ result: [horse({ kakutei: 1 })] }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(3);
    expect(summary.複勝配当サンプル数).toBe(0);
    expect(summary.複勝配当レンジ).toBeNull();
  });

  it("境界: 3着同着で複勝圏内が4頭になる回でも、複勝配当はpayback3枠分(サンプル数3)のみであること(条件c)", () => {
    const entries = [
      entry({
        result: [
          horse({ kakutei: 1 }),
          horse({ kakutei: 2 }),
          horse({ kakutei: 3, dochakuCd: "1", dochakuTosu: 2 }),
          horse({ kakutei: 3, dochakuCd: "1", dochakuTosu: 2 }),
        ],
        payback: {
          fukuPay1: 150,
          fukuNinki1: 1,
          fukuPay2: 200,
          fukuNinki2: 2,
          fukuPay3: 300,
          fukuNinki3: 3,
        },
      }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(4);
    expect(summary.複勝配当サンプル数).toBe(3);
  });

  it("fuku_payが0または非有限のときはサンプル数にも数えられないこと(条件e)", () => {
    const entries = [
      entry({
        payback: {
          fukuPay1: 0,
          fukuNinki1: 1,
          fukuPay2: Number.NaN,
          fukuNinki2: 2,
          fukuPay3: 250,
          fukuNinki3: 3,
        },
      }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    // 有効なのはfukuPay3(250)のみ。
    expect(summary.複勝配当サンプル数).toBe(1);
    expect(summary.複勝配当レンジ).toEqual({ min: 250, max: 250 });
  });

  it("不変条件: 人気レンジがnullのときは人気サンプル数が常に0であること", () => {
    const entries = [
      entry({ result: [horse({ kakutei: 1, ninki: null })] }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.人気レンジ).toBeNull();
    expect(summary.人気サンプル数).toBe(0);
  });

  it("不変条件: 複勝配当レンジがnullのときは複勝配当サンプル数が常に0であること", () => {
    const entries = [entry({ payback: null }), entry({ payback: null }), entry({ payback: null })];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝配当レンジ).toBeNull();
    expect(summary.複勝配当サンプル数).toBe(0);
  });
});

describe("summarizeGradeWinnerTrend(記述統計: 通過順相対・上がり・馬番相対。ラベルなし・サンプル数併記)", () => {
  it("複勝圏内馬のcorner(コーナー通過順)+tosuから平均通過順相対を、頭数で正規化して算出すること", () => {
    const entries = [
      entry({
        tosu: 10,
        result: [horse({ kakutei: 1, corner: "1-1-1-1" })],
      }),
      entry({ tosu: 10, result: [horse({ kakutei: 2, corner: "9-9-9-9" })] }),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    // (1/10 + 9/10) / 2 = 0.5
    expect(summary.平均通過順相対).toBeCloseTo(0.5);
    expect(summary.通過順相対サンプル数).toBe(2);
  });

  it("複勝圏内馬のharon3(上がり3F)から平均上がりを算出すること", () => {
    const entries = [
      entry({ result: [horse({ kakutei: 1, haron3: 34.8 })] }),
      entry({ result: [horse({ kakutei: 2, haron3: 35.2 })] }),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.平均上がり).toBeCloseTo(35.0);
    expect(summary.上がりサンプル数).toBe(2);
  });

  it("複勝圏内馬のumaban+tosuから平均馬番相対(馬番/頭数)を算出すること(ラベルは付けない=内有利/外有利という値を持たない)", () => {
    const entries = [
      entry({ tosu: 10, result: [horse({ kakutei: 1, umaban: 1 })] }),
      entry({ tosu: 10, result: [horse({ kakutei: 2, umaban: 9 })] }),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    // (1/10 + 9/10) / 2 = 0.5
    expect(summary.平均馬番相対).toBeCloseTo(0.5);
    expect(summary.馬番相対サンプル数).toBe(2);
    // ラベル用のフィールド(内有利/外有利等)を一切持たないこと。
    expect(summary).not.toHaveProperty("内外傾向");
  });

  it("corner/haron3/umabanが取得できない馬は、当該指標のみサンプルから除外すること(他の指標には影響しない)", () => {
    const entries = [
      entry({
        tosu: 10,
        result: [horse({ kakutei: 1, corner: null, haron3: null, umaban: null })],
      }),
      entry(),
      entry(),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝圏内馬数).toBe(1);
    expect(summary.通過順相対サンプル数).toBe(0);
    expect(summary.平均通過順相対).toBeNull();
    expect(summary.上がりサンプル数).toBe(0);
    expect(summary.平均上がり).toBeNull();
    expect(summary.馬番相対サンプル数).toBe(0);
    expect(summary.平均馬番相対).toBeNull();
  });
});

/** collectGradeWinnerTrend の合成テスト専用: 任意のJS値をAPIと同じ base64(zlib deflate) 形式にする。 */
function encodeGradeWinnerPayload(value: unknown): string {
  return deflateSync(Buffer.from(JSON.stringify(value), "utf-8")).toString("base64");
}

/** collectGradeWinnerTrend の合成テスト専用: status:OKの生レスポンス文字列を組み立てる。 */
function makeOkRawResponse(entries: readonly unknown[]): string {
  return JSON.stringify({
    status: "OK",
    reason: null,
    data: {
      "nkrace_gw::race_ids_testhash": encodeGradeWinnerPayload(entries),
      "nkrace_gw::race_ids_testhash_last_dt": "2026-01-01",
    },
  });
}

describe("collectGradeWinnerTrend(fetch+parse+集計の合成。analysis-pipeline.tsからの配線用)", () => {
  it("fetchGradeWinnerEntries経由で取得したentriesをsummarizeGradeWinnerTrendへ渡し、集計結果を返すこと(疑似POST応答を実際にparse+集計)", async () => {
    const raceId = parseRaceId("202603020211");
    const rawEntries = [
      {
        race_id: "202503020211",
        race_date: "2025-06-29",
        jyo: "福島",
        kyori: 1800,
        track: "芝",
        tosu: 14,
        result: [{ umaban: 1, kakutei: 1, ninki: 3 }],
        payback: null,
      },
      { race_id: "202403020211", race_date: "2024-06-30", jyo: "福島", kyori: 1800, track: "芝", tosu: 12, result: [], payback: null },
      { race_id: "202303020211", race_date: "2023-07-02", jyo: "福島", kyori: 1800, track: "芝", tosu: 16, result: [], payback: null },
    ];
    const fetcher = {
      fetchText: vi.fn(async () => makeOkRawResponse(rawEntries)),
    };
    const conditions: GradeWinnerConditions = {
      trackCode: FUKUSHIMA_TRACK_CODE,
      track: "芝",
      kyori: 1800,
    };

    const summary = await collectGradeWinnerTrend(raceId, conditions, "2026/06/28", { fetcher });

    expect(fetcher.fetchText).toHaveBeenCalledTimes(1);
    expect(summary).not.toBeNull();
    expect(summary!.条件一致回数).toBe(3);
    expect(summary!.複勝圏内馬数).toBe(1);
  });

  it("非重賞(status:NG相当。fetchGradeWinnerEntriesがnullを返す)ときはnullを返すこと", async () => {
    const raceId = parseRaceId("202602010607");
    const fetcher = {
      fetchText: vi.fn(async () =>
        JSON.stringify({ status: "NG", reason: "AplGradeWinner->get() Error" }),
      ),
    };
    const summary = await collectGradeWinnerTrend(raceId, CONDITIONS, "2026/06/28", { fetcher });
    expect(summary).toBeNull();
  });

  it("地方(NAR)の実フィクスチャ(帝王賞・大井)でも中央と同様に取得+集計できること(2026-07-28実測訂正: NARもスコープ内。リークが無い基準[どの回とも別のraceId・十分に未来の基準日]では全10回・30頭が従来どおり集計される)", async () => {
    const narRaceId = parseRaceId(NO_LEAK_NAR_RACE_ID);
    const fetcher = {
      fetchText: vi.fn(async () => loadFixture("grade_winner_nar_202644070111.json")),
    };
    const conditions: GradeWinnerConditions = { trackCode: "44", track: "ダ", kyori: 2000 };

    const summary = await collectGradeWinnerTrend(narRaceId, conditions, NO_LEAK_CUTOFF, { fetcher });

    expect(fetcher.fetchText).toHaveBeenCalledTimes(1);
    expect(summary).not.toBeNull();
    expect(summary!.条件一致回数).toBe(10);
    expect(summary!.複勝圏内馬数).toBe(30);
  });

  it("要修正6回帰: 地方の実データはcoursekubun_cd(柵)が全10回とも空文字のため、柵内訳が空配列になること(リークが無い基準で全10回を集計)", async () => {
    const narRaceId = parseRaceId(NO_LEAK_NAR_RACE_ID);
    const fetcher = {
      fetchText: vi.fn(async () => loadFixture("grade_winner_nar_202644070111.json")),
    };
    const conditions: GradeWinnerConditions = { trackCode: "44", track: "ダ", kyori: 2000 };

    const summary = await collectGradeWinnerTrend(narRaceId, conditions, NO_LEAK_CUTOFF, { fetcher });

    expect(summary!.対象回数).toBe(10);
    expect(summary!.柵内訳).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 先読みリークの遮断(Issue #153): excludeLookaheadEntries と collectGradeWinnerTrend への配線
// ---------------------------------------------------------------------------

/** リークが無い基準: どの回とも一致しない raceId(2027年の大井の仮想の回)。 */
const NO_LEAK_NAR_RACE_ID = "202744070111";
/** リークが無い基準: 取得した全回より十分に後の基準日。 */
const NO_LEAK_CUTOFF = "2099/12/31";

describe("excludeLookaheadEntries(先読みリークの除外。Issue #153)", () => {
  const TARGET = parseRaceId("202603020211");
  const CUTOFF = "2026/06/28";

  /** 対象レースと別の raceId・日付だけを指定した回を作る(他は固定)。 */
  function dated(raceDate: string | null, raceId: string | null = "202503020211"): GradeWinnerEntry {
    return entry({ raceId, raceDate });
  }

  /** excludeLookaheadEntries を通して残った回の raceDate を返す。 */
  function keptDates(entries: readonly GradeWinnerEntry[], cutoff = CUTOFF): (string | null)[] {
    return excludeLookaheadEntries(entries, { raceId: TARGET, cutoffDate: cutoff }).map((e) => e.raceDate);
  }

  it("raceId が対象レースと一致する回は、日付が基準日より十分前でも除外する(地方の当該回が応答に含まれる実態への対処)", () => {
    const own = dated("2020-01-01", "202603020211");
    const other = dated("2020-01-01", "202503020211");
    const kept = excludeLookaheadEntries([own, other], { raceId: TARGET, cutoffDate: CUTOFF });
    expect(kept).toEqual([other]);
  });

  it("raceDate が基準日と同日の回は(別の raceId でも)除外する(同日=当該回の可能性が高い)", () => {
    expect(keptDates([dated("2026-06-28")])).toEqual([]);
  });

  it("raceDate が基準日より後の回は除外し、前日の回は残す(境界値)", () => {
    expect(keptDates([dated("2026-06-29")])).toEqual([]);
    expect(keptDates([dated("2026-06-27")])).toEqual(["2026-06-27"]);
  });

  it("月またぎ・年またぎの境界でも日付の前後を正しく判定する(1桁月日・桁数字比較の確認)", () => {
    // 基準日 2026/07/01: 6/30 は前(残る)、7/01 は同日(除く)、7/02 は後(除く)。
    expect(keptDates([dated("2026-06-30"), dated("2026-07-01"), dated("2026-07-02")], "2026/07/01")).toEqual([
      "2026-06-30",
    ]);
    // 基準日 2026/01/01: 前年12/31 は前(残る)、同日は除く。
    expect(keptDates([dated("2025-12-31"), dated("2026-01-01")], "2026/01/01")).toEqual(["2025-12-31"]);
    // 基準日 2026/06/28 に対し 2026/12/01(桁数字で大)は後(除く)、2025/12/31 は前(残る)。
    expect(keptDates([dated("2026-12-01"), dated("2025-12-31")])).toEqual(["2025-12-31"]);
  });

  it.each([
    ["null(日付欠損)", null],
    ["空文字", ""],
    ["数字以外", "abcd-ef-gh"],
    ["月日が1桁でゼロ埋めされていない(桁数が合わない)", "2026-7-1"],
    ["日だけがゼロ埋めされていない(7桁でも月日の範囲検査は通ってしまう)", "2020-10-1"],
    ["月が範囲外", "2020-13-01"],
    ["日が範囲外", "2020-01-32"],
    ["月日がゼロ", "2020-00-00"],
  ])("raceDate が %s の回は、判定不能のため除外する(未来の走を混ぜない保守側。#39と同じ)", (_label, raceDate) => {
    // 前提: 比較対象として、正常な過去の回は残る(全件が空になる退化でテストが自明に通らないこと)。
    expect(keptDates([dated(raceDate as string | null), dated("2020-01-01")])).toEqual(["2020-01-01"]);
  });

  it("何も除外されないときは、同じ内容(順序も保つ)の新しい配列を返し、入力を破壊しない", () => {
    const entries = [dated("2025-06-29"), dated("2024-06-30", "202403020211"), dated("2023-07-02", "202303020211")];
    const snapshot = JSON.stringify(entries);
    const kept = excludeLookaheadEntries(entries, { raceId: TARGET, cutoffDate: CUTOFF });
    expect(kept).toEqual(entries);
    expect(kept).not.toBe(entries);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });

  it("除外が起きたときも、入力の配列・要素を破壊しない", () => {
    const entries = [dated("2026-06-29"), dated("2020-01-01")];
    const snapshot = JSON.stringify(entries);
    expect(keptDates(entries)).toEqual(["2020-01-01"]);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });

  it.each([
    ["YYYY/MM/DD(analysisDate の形式)", "2026/06/28"],
    ["YYYYMMDD(historyCutoffDate の形式)", "20260628"],
    ["YYYY-MM-DD(raceDate の形式)", "2026-06-28"],
  ])("基準日は %s のいずれの書式でも同じ結果になる", (_label, cutoff) => {
    const entries = [dated("2026-06-27"), dated("2026-06-28"), dated("2026-06-29")];
    expect(keptDates(entries, cutoff)).toEqual(["2026-06-27"]);
  });

  it.each([
    ["桁数が足りない(月日がゼロ埋めされていない)", "2026/6/28"],
    ["日だけがゼロ埋めされていない(7桁でも月日の範囲検査は通ってしまう)", "2026/10/1"],
    ["空文字", ""],
    ["日付でない", "today"],
    ["月が範囲外", "2026/13/01"],
  ])("基準日が %s ときは例外を投げる(呼び出し側の契約違反を握りつぶさない)", (_label, cutoff) => {
    expect(() => excludeLookaheadEntries([dated("2020-01-01")], { raceId: TARGET, cutoffDate: cutoff })).toThrow();
  });
});

describe("collectGradeWinnerTrend の先読みリーク遮断(Issue #153)", () => {
  const NAR_CONDITIONS: GradeWinnerConditions = { trackCode: "44", track: "ダ", kyori: 2000 };

  /** 固定のレスポンス文字列を返すフェッチャ。 */
  function fixtureFetcher(name: string) {
    return { fetchText: vi.fn(async () => loadFixture(name)) };
  }

  /** フィクスチャの生の過去回配列(独立オラクル用)。 */
  function rawEntries(name: string): readonly GradeWinnerEntry[] {
    const parsed = parseGradeWinnerResponse(loadFixture(name));
    expect(parsed).not.toBeNull();
    return parsed!;
  }

  it("地方の実フィクスチャ(当該回自身が先頭に含まれる実物)で、当該回を除いた9回で集計する(対象回数=絞った後の件数。リテラルで固定)", async () => {
    const raw = rawEntries("grade_winner_nar_202644070111.json");
    // 前提: 先頭が当該回自身(raceId 一致・開催日 2026-07-01)で、全10回。
    expect(raw).toHaveLength(10);
    expect(raw[0]!.raceId).toBe("202644070111");
    expect(raw[0]!.raceDate).toBe("2026-07-01");

    const summary = await collectGradeWinnerTrend(
      parseRaceId("202644070111"),
      NAR_CONDITIONS,
      "2026/07/01",
      { fetcher: fixtureFetcher("grade_winner_nar_202644070111.json") },
    );

    expect(summary).not.toBeNull();
    // リテラル(実測。自レースを除くと 10→9回・30→27頭・複勝配当中央値 150→160・稍重 2→1)。
    expect(summary!.対象回数).toBe(9);
    expect(summary!.条件一致回数).toBe(9);
    expect(summary!.条件除外回数).toBe(0);
    expect(summary!.複勝圏内馬数).toBe(27);
    expect(summary!.複勝配当中央値).toBe(160);
    expect(summary!.馬場内訳).toEqual([
      { 値: "良", 回数: 4 },
      { 値: "稍重", 回数: 1 },
      { 値: "重", 回数: 4 },
    ]);
    // 独立オラクル: 先頭(当該回)を取り除いた配列を直接集計した結果と全項目で一致する。
    expect(summary).toEqual(summarizeGradeWinnerTrend(raw.slice(1), NAR_CONDITIONS));
    // 非空振り: 絞らない集計(従来の挙動)とは値が異なる(差が0でない)。
    const leaky = summarizeGradeWinnerTrend(raw, NAR_CONDITIONS)!;
    expect(leaky.対象回数).toBe(10);
    expect(leaky.複勝配当中央値).toBe(150);
    expect(summary).not.toEqual(leaky);
  });

  it("raceId 分岐だけで当該回を除ける: 基準日が当該回より後(2026/07/02)でも、raceId 一致の回は除かれる(近似日の過去分析と同じ状況)", async () => {
    const summary = await collectGradeWinnerTrend(
      parseRaceId("202644070111"),
      NAR_CONDITIONS,
      "2026/07/02",
      { fetcher: fixtureFetcher("grade_winner_nar_202644070111.json") },
    );
    expect(summary!.対象回数).toBe(9);
    expect(summary!.複勝配当中央値).toBe(160);
  });

  it("日付分岐だけで当該回を除ける: raceId が別でも、開催日が基準日と同日の回は除かれる(2026-07-01 の回を日付で落とす)", async () => {
    const summary = await collectGradeWinnerTrend(
      parseRaceId(NO_LEAK_NAR_RACE_ID),
      NAR_CONDITIONS,
      "2026/07/01",
      { fetcher: fixtureFetcher("grade_winner_nar_202644070111.json") },
    );
    // 前提: 対象 raceId は取得した10回のどれとも一致しない(raceId 分岐が効かない)。
    expect(rawEntries("grade_winner_nar_202644070111.json").some((e) => e.raceId === NO_LEAK_NAR_RACE_ID)).toBe(false);
    expect(summary!.対象回数).toBe(9);
  });

  it("過去の地方重賞の実物(2023年の回を要求した応答。2026〜2024年の回と当該回〈2023年〉を含む)を、基準日 2023/06/28 で絞って6回で集計する", async () => {
    const raw = rawEntries("grade_winner_nar_202344062811.json");
    // 前提: 2023年の回を要求しても、応答は(大井のシリーズでは)race_id に依らない同じ応答(2026〜2017年)で、当該回の後の回(2026・2025・2024年)を含む。
    expect(raw.map((e) => e.raceId!.slice(0, 4))).toEqual([
      "2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018", "2017",
    ]);
    expect(raw[3]!.raceId).toBe("202344062811");

    const summary = await collectGradeWinnerTrend(
      parseRaceId("202344062811"),
      NAR_CONDITIONS,
      "2023/06/28",
      { fetcher: fixtureFetcher("grade_winner_nar_202344062811.json") },
    );

    expect(summary).not.toBeNull();
    expect(summary!.対象回数).toBe(6);
    expect(summary!.複勝圏内馬数).toBe(18);
    expect(summary!.複勝配当中央値).toBe(165);
    expect(summary!.馬場内訳).toEqual([
      { 値: "良", 回数: 2 },
      { 値: "重", 回数: 4 },
    ]);
    // 独立オラクル: 2022年以前の6回(配列の4番目以降)を直接集計した結果と一致する。
    expect(summary).toEqual(summarizeGradeWinnerTrend(raw.slice(4), NAR_CONDITIONS));
    // 非空振り: 絞らない集計(150)とは異なる。
    expect(summarizeGradeWinnerTrend(raw, NAR_CONDITIONS)!.複勝配当中央値).toBe(150);
  });

  it("中央の実フィクスチャ(当該回を含まず全て施行日より前)では何も除かれず、絞らない集計と全項目で一致する(no-op)", async () => {
    const raw = rawEntries("grade_winner_202603020211.json");
    // 前提: 全10回が当該回〈2026-06-28〉より前で、当該 raceId を含まない。
    expect(raw).toHaveLength(10);
    expect(raw.every((e) => e.raceId !== "202603020211" && e.raceDate! < "2026-06-28")).toBe(true);

    const summary = await collectGradeWinnerTrend(parseRaceId("202603020211"), CONDITIONS, "2026/06/28", {
      fetcher: fixtureFetcher("grade_winner_202603020211.json"),
    });
    expect(summary).toEqual(summarizeGradeWinnerTrend(raw, CONDITIONS));
    expect(summary!.対象回数).toBe(10);
    expect(summary!.複勝配当中央値).toBe(325);
  });

  it("中央の過去の回の実物(2021年の回を要求した応答)は、応答自体が当該年より前の10年で、絞っても何も変わらない(no-op)", async () => {
    const raw = rawEntries("grade_winner_202103010211.json");
    // 前提: 2021年の回を要求した応答は 2020〜2011年で、当該回〈2021-07-04〉もそれ以降の回も含まない
    // (最新10年ではなく「当該年より前の10年」。中央はAPIの側で先読みが無い)。
    expect(raw.map((e) => e.raceDate!.slice(0, 4))).toEqual([
      "2020", "2019", "2018", "2017", "2016", "2015", "2014", "2013", "2012", "2011",
    ]);
    const summary = await collectGradeWinnerTrend(parseRaceId("202103010211"), CONDITIONS, "2021/07/04", {
      fetcher: fixtureFetcher("grade_winner_202103010211.json"),
    });
    expect(summary).toEqual(summarizeGradeWinnerTrend(raw, CONDITIONS));
    expect(summary!.対象回数).toBe(10);
  });

  it("中央の日付分岐の疑似ケース: 2026年の応答を基準日 2023/07/02 で絞ると、同日の2023年と後の2024・2025年が除かれ2022年以前の7回になる", async () => {
    const raw = rawEntries("grade_winner_202603020211.json");
    const summary = await collectGradeWinnerTrend(parseRaceId("202603020211"), CONDITIONS, "2023/07/02", {
      fetcher: fixtureFetcher("grade_winner_202603020211.json"),
    });
    // 独立オラクル: 2022年以前の7回(配列の3番目以降)を直接集計した結果。
    expect(raw[3]!.raceDate).toBe("2022-07-03");
    expect(summary).toEqual(summarizeGradeWinnerTrend(raw.slice(3), CONDITIONS));
    expect(summary!.対象回数).toBe(7);
  });

  it("絞った後の条件一致がちょうど3回なら集計し、2回なら null を返す(リーク遮断後に標本が足りなければブロックを出さない。境界値)", async () => {
    const raw = rawEntries("grade_winner_202603020211.json");
    // 前提: 配列の 7番目以降(0始まり)が 2018-07-01・2017-07-02・2016-07-03。
    expect(raw.slice(7).map((e) => e.raceDate)).toEqual(["2018-07-01", "2017-07-02", "2016-07-03"]);
    // 基準日 2018/07/02: 2018-07-01 は前日で残る → 3回(2018・2017・2016年)。
    const three = await collectGradeWinnerTrend(parseRaceId("202603020211"), CONDITIONS, "2018/07/02", {
      fetcher: fixtureFetcher("grade_winner_202603020211.json"),
    });
    expect(three).not.toBeNull();
    expect(three!.対象回数).toBe(3);
    // 基準日 2018/07/01: 同日の2018年が除かれ → 2回(2017・2016年)で3回未満。
    const two = await collectGradeWinnerTrend(parseRaceId("202603020211"), CONDITIONS, "2018/07/01", {
      fetcher: fixtureFetcher("grade_winner_202603020211.json"),
    });
    expect(two).toBeNull();
  });
});

describe("summarizeGradeWinnerTrend(配列長が10件でなくても動作すること)", () => {
  it("5件しか無い(新設・改称想定)場合でも、3件一致していれば表示すること", () => {
    const entries = [
      entry(),
      entry(),
      entry(),
      entry({ raceId: raceIdWithTrackCode(NAKAYAMA_TRACK_CODE) }),
      entry({ raceId: raceIdWithTrackCode(NAKAYAMA_TRACK_CODE) }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS);
    expect(summary).not.toBeNull();
    expect(summary!.対象回数).toBe(5);
    expect(summary!.条件一致回数).toBe(3);
  });
});
