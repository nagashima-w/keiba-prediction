import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GradeWinnerParseError,
  parseGradeWinnerResponse,
} from "../../src/scraper/parse-grade-winner.js";

/** フィクスチャ(JSON文字列)を読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** テスト用: 任意のJS値をAPIと同じ base64(zlib deflate) 形式にエンコードする。 */
function encodePayload(value: unknown): string {
  return deflateSync(Buffer.from(JSON.stringify(value), "utf-8")).toString(
    "base64",
  );
}

/** テスト用: ハッシュ付きキー名を含む正常系レスポンス文字列を組み立てる。 */
function makeOkResponse(entries: unknown[], hash = "abc123hash"): string {
  return JSON.stringify({
    status: "OK",
    reason: null,
    data: {
      [`nkrace_gw::race_ids_${hash}`]: encodePayload(entries),
      [`nkrace_gw::race_ids_${hash}_last_dt`]: "2026-01-01 00:00:00",
    },
  });
}

/** 実フィクスチャ(正常系・過去10回)をパースした結果(テスト全体で使い回す)。 */
const fixtureEntries = parseGradeWinnerResponse(
  loadFixture("grade_winner_202603020211.json"),
);

describe("parseGradeWinnerResponse(実フィクスチャ: 正常系)", () => {
  it("status:OKのとき過去10回分の配列を返すこと", () => {
    expect(fixtureEntries).not.toBeNull();
    expect(fixtureEntries).toHaveLength(10);
  });

  it("先頭(直近年)の基本情報を正しく抽出すること", () => {
    const first = fixtureEntries![0]!;
    expect(first.raceId).toBe("202503020211");
    expect(first.raceDate).toBe("2025-06-29");
    expect(first.jyo).toBe("福島");
    expect(first.kyori).toBe(1800);
    expect(first.track).toBe("芝");
    expect(first.fence).toBe("A");
    expect(first.baba).toBe("良");
    expect(first.tenko).toBe("晴");
    expect(first.tosu).toBe(14);
  });

  it("結果配列(上位3着)の各フィールドを抽出すること(型の揺れ: futan/odds/haron3/weight_diffは文字列)", () => {
    const first = fixtureEntries![0]!;
    expect(first.result).toHaveLength(3);
    const winner = first.result[0]!;
    expect(winner.wakuban).toBe(1);
    expect(winner.umaban).toBe(1);
    expect(winner.kakutei).toBe(1);
    expect(winner.nyusen).toBe(1);
    expect(winner.corner).toBe("7-8-7-7");
    expect(winner.haron3).toBeCloseTo(34.8);
    expect(winner.ninki).toBe(4);
    // 先頭馬は着差なし(空文字)。異常ではなくnullへ正規化する。
    expect(winner.chakusa).toBeNull();
    // 正常時のijyoは半角スペース1文字。トリムしてnull(正常)に正規化する。
    expect(winner.ijyo).toBeNull();
    expect(winner.dochakuCd).toBeNull();
    expect(winner.dochakuTosu).toBeNull();
  });

  it("払戻(複勝1〜3着分)を抽出すること", () => {
    const first = fixtureEntries![0]!;
    expect(first.payback).toEqual({
      fukuPay1: 280,
      fukuNinki1: 6,
      fukuPay2: 200,
      fukuNinki2: 1,
      fukuPay3: 430,
      fukuNinki3: 9,
    });
  });

  it("年差し替え禁止の回帰テスト: 2021年は実際には1回(202103010211)であり、年だけ機械的に置換した202103020211とは異なること", () => {
    const entry2021 = fixtureEntries!.find((e) => e.raceDate?.startsWith("2021"));
    expect(entry2021).toBeDefined();
    // 正しいrace_id(実データ由来)。
    expect(entry2021!.raceId).toBe("202103010211");
    // 年だけ他の年(2回)のパターンに機械的に置換した値とは一致しないこと
    // (=各年のrace_idは必ずAPIが返す実データそのものを使い、パターン推測で構築してはならない)。
    expect(entry2021!.raceId).not.toBe("202103020211");
  });

  it("キー名のハッシュをハードコードしていないこと(実フィクスチャとは異なるハッシュのレスポンスもパースできる)", () => {
    const entries = [
      {
        race_id: "202001010101",
        race_date: "2020-01-01",
        jyo: "テスト場",
        kyori: 2000,
        track: "芝",
        tosu: 10,
        result: [],
        payback: null,
      },
    ];
    const raw = makeOkResponse(entries, "completely-different-hash-999");
    const parsed = parseGradeWinnerResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.raceId).toBe("202001010101");
  });

  it("要修正5回帰: 中央・地方でキー名の形式が全く異なる実データの両方をパースできること(race_ids_プレフィックスを前提にしていないこと)", () => {
    // 中央の実キー: "nkrace_gw::race_ids_7eae5ab6da4ba31c8a2331dd176ce6a1"
    // 地方の実キー: "nkrace_gw::2810"(race_ids_プレフィックスが無く、ハッシュでもなく単純な数字)。
    // "_last_dtで終わらないキーを取る"ルールのみに依拠しているため、両方とも問題なくパースできる
    // ことを実フィクスチャで固定する(2026-07-28 boss実測)。
    const centralRaw = loadFixture("grade_winner_202603020211.json");
    const centralData = (JSON.parse(centralRaw) as { data: Record<string, unknown> }).data;
    const centralKey = Object.keys(centralData).find((k) => !k.endsWith("_last_dt"))!;
    expect(centralKey).toBe("nkrace_gw::race_ids_7eae5ab6da4ba31c8a2331dd176ce6a1");

    const narRaw = loadFixture("grade_winner_nar_202644070111.json");
    const narData = (JSON.parse(narRaw) as { data: Record<string, unknown> }).data;
    const narKey = Object.keys(narData).find((k) => !k.endsWith("_last_dt"))!;
    expect(narKey).toBe("nkrace_gw::2810");
    // 地方のキーは "race_ids_" を含まない(central側の形式を前提にしていないことの確認)。
    expect(narKey).not.toContain("race_ids_");

    expect(parseGradeWinnerResponse(centralRaw)).toHaveLength(10);
    expect(parseGradeWinnerResponse(narRaw)).toHaveLength(10);
  });
});

describe("parseGradeWinnerResponse(実フィクスチャ: 異常系・非重賞)", () => {
  it("status:NGのときnullを返すこと(エラーを投げない。呼び出し側が静かにスキップする)", () => {
    const raw = loadFixture("grade_winner_ng_202602010607.json");
    expect(() => parseGradeWinnerResponse(raw)).not.toThrow();
    expect(parseGradeWinnerResponse(raw)).toBeNull();
  });
});

describe("parseGradeWinnerResponse(異常系・型の揺れへの耐性)", () => {
  it("配列長が10未満(新設・改称レース想定)でも正しくパースできること", () => {
    const entries = [1, 2, 3, 4, 5].map((n) => ({
      race_id: `20200101010${n}`,
      race_date: `2020-0${n}-01`,
      jyo: "テスト場",
      kyori: 1600,
      track: "ダ",
      tosu: 12,
      result: [],
      payback: null,
    }));
    const parsed = parseGradeWinnerResponse(makeOkResponse(entries));
    expect(parsed).toHaveLength(5);
  });

  it("kakuteiとnyusenが不一致(降着)の馬も、両方の値をそのまま保持すること", () => {
    const entries = [
      {
        race_id: "202001010101",
        jyo: "テスト場",
        kyori: 2000,
        track: "芝",
        tosu: 10,
        result: [
          { umaban: 3, nyusen: 2, kakutei: 4, ijyo: " " },
        ],
        payback: null,
      },
    ];
    const parsed = parseGradeWinnerResponse(makeOkResponse(entries));
    const horse = parsed![0]!.result[0]!;
    expect(horse.nyusen).toBe(2);
    expect(horse.kakutei).toBe(4);
  });

  it("dochaku_cd/dochaku_tosuが非null(同着)の馬も正しく保持すること", () => {
    const entries = [
      {
        race_id: "202001010101",
        jyo: "テスト場",
        kyori: 2000,
        track: "芝",
        tosu: 10,
        result: [
          { umaban: 5, kakutei: 3, dochaku_cd: "1", dochaku_tosu: 2, ijyo: " " },
          { umaban: 6, kakutei: 3, dochaku_cd: "1", dochaku_tosu: 2, ijyo: " " },
        ],
        payback: null,
      },
    ];
    const parsed = parseGradeWinnerResponse(makeOkResponse(entries));
    expect(parsed![0]!.result).toHaveLength(2);
    expect(parsed![0]!.result[0]!.dochakuCd).toBe("1");
    expect(parsed![0]!.result[0]!.dochakuTosu).toBe(2);
  });

  it("chakusaが空文字の場合はnullへ正規化すること", () => {
    const entries = [
      {
        race_id: "202001010101",
        jyo: "テスト場",
        kyori: 2000,
        track: "芝",
        tosu: 10,
        result: [{ umaban: 1, kakutei: 1, chakusa: "", ijyo: " " }],
        payback: null,
      },
    ];
    const parsed = parseGradeWinnerResponse(makeOkResponse(entries));
    expect(parsed![0]!.result[0]!.chakusa).toBeNull();
  });

  it("ijyoが半角スペースでない(取消・除外等)場合は、トリム後の文字列をそのまま保持すること", () => {
    const entries = [
      {
        race_id: "202001010101",
        jyo: "テスト場",
        kyori: 2000,
        track: "芝",
        tosu: 10,
        result: [{ umaban: 1, kakutei: null, ijyo: "取消" }],
        payback: null,
      },
    ];
    const parsed = parseGradeWinnerResponse(makeOkResponse(entries));
    expect(parsed![0]!.result[0]!.ijyo).toBe("取消");
    expect(parsed![0]!.result[0]!.kakutei).toBeNull();
  });

  it("payback.fuku_pay*が欠損(null)していても例外を投げず、該当項目のみnullになること", () => {
    const entries = [
      {
        race_id: "202001010101",
        jyo: "テスト場",
        kyori: 2000,
        track: "芝",
        tosu: 10,
        result: [],
        payback: {
          fuku_pay1: 280,
          fuku_ninki1: 6,
          fuku_pay2: null,
          fuku_ninki2: null,
          fuku_pay3: 430,
          fuku_ninki3: 9,
        },
      },
    ];
    const parsed = parseGradeWinnerResponse(makeOkResponse(entries));
    expect(parsed![0]!.payback).toEqual({
      fukuPay1: 280,
      fukuNinki1: 6,
      fukuPay2: null,
      fukuNinki2: null,
      fukuPay3: 430,
      fukuNinki3: 9,
    });
  });

  it("status:OKなのにdataが欠損している場合はGradeWinnerParseErrorを投げること", () => {
    const raw = JSON.stringify({ status: "OK", reason: null });
    expect(() => parseGradeWinnerResponse(raw)).toThrow(GradeWinnerParseError);
  });

  it("JSONとして解析できない応答はGradeWinnerParseErrorを投げること", () => {
    expect(() => parseGradeWinnerResponse("not a json")).toThrow(
      GradeWinnerParseError,
    );
  });
});
