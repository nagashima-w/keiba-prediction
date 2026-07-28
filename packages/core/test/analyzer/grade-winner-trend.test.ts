import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  collectGradeWinnerTrend,
  summarizeGradeWinnerTrend,
  type GradeWinnerConditions,
} from "../../src/analyzer/grade-winner-trend.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import type {
  GradeWinnerEntry,
  GradeWinnerResultHorse,
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
  it("複勝圏内馬のninkiから人気レンジと二桁人気回数を集計すること", () => {
    const entries = [
      entry({
        result: [horse({ kakutei: 1, ninki: 4 }), horse({ kakutei: 2, ninki: 12 })],
      }),
      entry({ result: [horse({ kakutei: 1, ninki: 1 })] }),
      entry({ result: [horse({ kakutei: 3, ninki: 9 })] }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.人気レンジ).toEqual({ min: 1, max: 12 });
    expect(summary.二桁人気回数).toBe(1);
  });

  it("payback.fuku_pay1〜3から複勝配当のレンジ・中央値を集計すること", () => {
    const entries = [
      entry({ payback: { fukuPay1: 280, fukuNinki1: 6, fukuPay2: 200, fukuNinki2: 1, fukuPay3: 430, fukuNinki3: 9 } }),
      entry({ payback: { fukuPay1: 150, fukuNinki1: 1, fukuPay2: 160, fukuNinki2: 2, fukuPay3: 170, fukuNinki3: 3 } }),
      entry({ payback: { fukuPay1: 900, fukuNinki1: 10, fukuPay2: null, fukuNinki2: null, fukuPay3: null, fukuNinki3: null } }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    // 値一覧: 280,200,430,150,160,170,900 (nullは除外)
    expect(summary.複勝配当レンジ).toEqual({ min: 150, max: 900 });
    expect(summary.複勝配当中央値).toBe(200);
  });

  it("paybackが丸ごとnullのレースが混ざっていてもクラッシュせず、他レースの値だけで集計すること", () => {
    const entries = [
      entry({ payback: null }),
      entry({ payback: { fukuPay1: 300, fukuNinki1: 1, fukuPay2: 300, fukuNinki2: 2, fukuPay3: 300, fukuNinki3: 3 } }),
      entry({ payback: null }),
    ];
    const summary = summarizeGradeWinnerTrend(entries, CONDITIONS)!;
    expect(summary.複勝配当レンジ).toEqual({ min: 300, max: 300 });
    expect(summary.複勝配当中央値).toBe(300);
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
        jyo: "福島",
        kyori: 1800,
        track: "芝",
        tosu: 14,
        result: [{ umaban: 1, kakutei: 1, ninki: 3 }],
        payback: null,
      },
      { race_id: "202403020211", jyo: "福島", kyori: 1800, track: "芝", tosu: 12, result: [], payback: null },
      { race_id: "202303020211", jyo: "福島", kyori: 1800, track: "芝", tosu: 16, result: [], payback: null },
    ];
    const fetcher = {
      fetchText: vi.fn(async () => makeOkRawResponse(rawEntries)),
    };
    const conditions: GradeWinnerConditions = {
      trackCode: FUKUSHIMA_TRACK_CODE,
      track: "芝",
      kyori: 1800,
    };

    const summary = await collectGradeWinnerTrend(raceId, conditions, { fetcher });

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
    const summary = await collectGradeWinnerTrend(raceId, CONDITIONS, { fetcher });
    expect(summary).toBeNull();
  });

  it("地方(NAR)の実フィクスチャ(帝王賞・大井)でも中央と同様に取得+集計できること(2026-07-28実測訂正: NARもスコープ内)", async () => {
    const narRaceId = parseRaceId("202644070111"); // 場コード44 → 大井。
    const fetcher = {
      fetchText: vi.fn(async () => loadFixture("grade_winner_nar_202644070111.json")),
    };
    const conditions: GradeWinnerConditions = { trackCode: "44", track: "ダ", kyori: 2000 };

    const summary = await collectGradeWinnerTrend(narRaceId, conditions, { fetcher });

    expect(fetcher.fetchText).toHaveBeenCalledTimes(1);
    expect(summary).not.toBeNull();
    expect(summary!.条件一致回数).toBe(10);
    expect(summary!.複勝圏内馬数).toBe(30);
  });

  it("要修正6回帰: 地方の実データはcoursekubun_cd(柵)が全10回とも空文字のため、柵内訳が空配列になること", async () => {
    const narRaceId = parseRaceId("202644070111");
    const fetcher = {
      fetchText: vi.fn(async () => loadFixture("grade_winner_nar_202644070111.json")),
    };
    const conditions: GradeWinnerConditions = { trackCode: "44", track: "ダ", kyori: 2000 };

    const summary = await collectGradeWinnerTrend(narRaceId, conditions, { fetcher });

    expect(summary!.柵内訳).toEqual([]);
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
