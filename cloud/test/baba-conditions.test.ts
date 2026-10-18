import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BABA_RAW_JSON_LIMIT, parseBabaResponse } from "../src/baba-conditions";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #294: 馬場の API の応答(JSON)の解析。純関数(ネットワーク・D1 に触れない)。
 * 見本は `fixtures/baba_latest_20261012.json`(ユーザーが手元の応答を貼ったもの。2026-10-12 17:05 JST の取得)。URL は含まない。
 * 主題: 計測日が「当日」の競馬場だけを選ぶこと(`measuredAt` に年が無いので、取得日 JST から補い、曜日で検算する)、形の不一致では何も保存しないこと。
 */

installFetchTrap();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE_TEXT = readFileSync(path.join(ROOT, "fixtures", "baba_latest_20261012.json"), "utf-8");
const SAMPLE = JSON.parse(SAMPLE_TEXT) as { fetchedAt: string; venues: Record<string, unknown>[] };
/** 見本の取得時刻(2026-10-12 17:05:52 JST)。 */
const NOW = Date.parse(SAMPLE.fetchedAt);

const tokyo = (): Record<string, unknown> => structuredClone(SAMPLE.venues[0]!);
const kyoto = (): Record<string, unknown> => structuredClone(SAMPLE.venues[1]!);
const sapporo = (): Record<string, unknown> => structuredClone(SAMPLE.venues[2]!);

/** 応答の文字列を作る。 */
function body(venues: unknown, fetchedAt: string = SAMPLE.fetchedAt): string {
  return JSON.stringify({ fetchedAt, text: "（使わない）", venues });
}

describe("見本の応答(2026-10-12。東京・京都は当日、札幌は 9/6 の古い値)", () => {
  it("前提: 見本は 3 競馬場で、うち札幌だけが当日でない(以降の検査が空振りでない)", () => {
    expect(SAMPLE.venues.map((v) => v["venueCode"])).toEqual(["05", "08", "01"]);
    expect(SAMPLE.venues.map((v) => v["measuredAt"])).toEqual(["10月12日（月曜）7時00分", "10月12日（月曜）7時00分", "9月6日（日曜）8時20分"]);
  });

  it("当日の東京・京都だけを残し、札幌(9/6)は捨てて件数に数える", () => {
    const r = parseBabaResponse(SAMPLE_TEXT, NOW);
    expect(r.result).toBe("ok");
    expect(r.venues.map((v) => v.venueCode)).toEqual(["05", "08"]);
    expect(r.dropped).toBe(1);
    expect(r.apiFetchedAt).toBe(SAMPLE.fetchedAt);
  });

  it("東京の各項目を取り込む(年は取得日 JST の 2026 で補う)", () => {
    const tokyoRecord = parseBabaResponse(SAMPLE_TEXT, NOW).venues[0]!;
    expect(tokyoRecord).toMatchObject({
      venueCode: "05",
      venueName: "東京",
      measuredAt: "2026-10-12T07:00+09:00",
      cushion: 9.6,
      turf: { condition: "良", goalCondition: "良", corner4Condition: "良", goalMoisture: 13.2, corner4Moisture: 11.8 },
      dirt: { condition: "良", goalCondition: "良", corner4Condition: "良", goalMoisture: 1.7, corner4Moisture: 1.7 },
      rainfallMm: null,
      usedCourse: "Aコース（内柵を最内に設置）",
      turfLength: "芝丈(cm) 芝野芝10から12・洋芝10から14 障害野芝10から12",
      turfConditionText: "1週使用しましたが、傷みは少なく概ね良好な状態です。",
    });
  });

  it("元の JSON(競馬場 1 件ぶん)を rawJson に残す", () => {
    const r = parseBabaResponse(SAMPLE_TEXT, NOW);
    expect(JSON.parse(r.venues[1]!.rawJson!)).toEqual(SAMPLE.venues[1]);
  });
});

describe("年の補いと曜日の検算(measuredAt に年が無い)", () => {
  // 取得時刻(UTC)・その時の JST の暦日 → 競馬場の measuredAt の文字列 → 期待(保存されるか。保存されるなら ISO)
  const jst = (s: string): number => Date.parse(`${s}+09:00`);
  const cases: { name: string; now: number; measuredAt: string; saved: string | null }[] = [
    { name: "年末の当日(12/28 月曜)", now: jst("2026-12-28T08:00:00"), measuredAt: "12月28日（月曜）7時00分", saved: "2026-12-28T07:00+09:00" },
    { name: "UTC ではまだ前年だが JST では元日(2027-01-01 0:30 JST = 2026-12-31T15:30Z)", now: jst("2027-01-01T00:30:00"), measuredAt: "1月1日（金曜）0時05分", saved: "2027-01-01T00:05+09:00" },
    { name: "年をまたぐ古い値(1/3 の取得で 12/28 月曜 = 前年)は当日でない", now: jst("2027-01-03T08:00:00"), measuredAt: "12月28日（月曜）7時00分", saved: null },
    { name: "年末の取得で来年の月日(未来)は当日でない", now: jst("2026-12-27T08:00:00"), measuredAt: "1月3日（日曜）7時00分", saved: null },
    { name: "1 年前の同じ月日(2025-10-12 は日曜)は、曜日が合わないので当日でない", now: jst("2026-10-12T08:00:00"), measuredAt: "10月12日（日曜）7時00分", saved: null },
    { name: "同じ月日でも曜日が違えば捨てる(10/12 は月曜。火曜は誤り)", now: jst("2026-10-12T08:00:00"), measuredAt: "10月12日（火曜）7時00分", saved: null },
    { name: "うるう日の当日(2028-02-29 火曜)", now: jst("2028-02-29T08:00:00"), measuredAt: "2月29日（火曜）7時00分", saved: "2028-02-29T07:00+09:00" },
    { name: "実在しない日(平年の 2/29)は捨てる", now: jst("2026-10-12T08:00:00"), measuredAt: "2月29日（日曜）7時00分", saved: null },
    { name: "時が範囲外(24 時)は捨てる", now: jst("2026-10-12T08:00:00"), measuredAt: "10月12日（月曜）24時00分", saved: null },
    { name: "分が範囲外(60 分)は捨てる", now: jst("2026-10-12T08:00:00"), measuredAt: "10月12日（月曜）7時60分", saved: null },
    { name: "半角の括弧でも読める", now: jst("2026-10-12T08:00:00"), measuredAt: "10月12日(月曜)7時00分", saved: "2026-10-12T07:00+09:00" },
    { name: "形が違う(曜日が無い)は捨てる", now: jst("2026-10-12T08:00:00"), measuredAt: "10月12日 7時00分", saved: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const venue = { ...tokyo(), measuredAt: c.measuredAt };
      const r = parseBabaResponse(body([venue], new Date(c.now).toISOString()), c.now);
      if (c.saved === null) {
        expect(r.venues).toEqual([]);
        expect(r.dropped).toBe(1);
        expect(r.result).toBe("no-today-venues");
      } else {
        expect(r.venues.map((v) => v.measuredAt)).toEqual([c.saved]);
        expect(r.dropped).toBe(0);
        expect(r.result).toBe("ok");
      }
    });
  }
});

describe("取得日が今日でない応答(API 側の古いキャッシュ)", () => {
  it("fetchedAt の JST の日付が今日でなければ、何も保存しない(stale)", () => {
    const r = parseBabaResponse(body([tokyo(), kyoto()], "2026-10-11T08:00:00.000Z"), NOW);
    expect(r.result).toBe("stale");
    expect(r.venues).toEqual([]);
  });
});

describe("形が想定と違う応答は、何も保存しない", () => {
  const bad: { name: string; text: string; result: "not-json" | "shape-mismatch" }[] = [
    { name: "空の本文", text: "", result: "not-json" },
    { name: "HTML", text: "<html><body>Bad Gateway</body></html>", result: "not-json" },
    { name: "JSON の配列", text: "[]", result: "shape-mismatch" },
    { name: "JSON の null", text: "null", result: "shape-mismatch" },
    { name: "fetchedAt が無い", text: JSON.stringify({ venues: [tokyo()] }), result: "shape-mismatch" },
    { name: "fetchedAt が文字列でない", text: JSON.stringify({ fetchedAt: 1760256352863, venues: [tokyo()] }), result: "shape-mismatch" },
    { name: "fetchedAt が日時として読めない", text: JSON.stringify({ fetchedAt: "昨日", venues: [tokyo()] }), result: "shape-mismatch" },
    { name: "venues が無い", text: JSON.stringify({ fetchedAt: SAMPLE.fetchedAt }), result: "shape-mismatch" },
    { name: "venues が配列でない", text: JSON.stringify({ fetchedAt: SAMPLE.fetchedAt, venues: { "05": tokyo() } }), result: "shape-mismatch" },
  ];
  for (const c of bad) {
    it(c.name, () => {
      const r = parseBabaResponse(c.text, NOW);
      expect(r.result).toBe(c.result);
      expect(r.venues).toEqual([]);
      expect(r.dropped).toBe(0);
    });
  }

  it("venues が空の配列は、形は正しい(当日の競馬場が無い: no-today-venues)", () => {
    const r = parseBabaResponse(body([]), NOW);
    expect(r.result).toBe("no-today-venues");
    expect(r.venues).toEqual([]);
    expect(r.apiFetchedAt).toBe(SAMPLE.fetchedAt);
  });
});

describe("競馬場 1 件の検査(不正な 1 件だけを捨て、ほかは残す)", () => {
  const withTokyo = (mutate: (v: Record<string, unknown>) => void): Record<string, unknown> => {
    const v = tokyo();
    mutate(v);
    return v;
  };
  const invalid: { name: string; venue: Record<string, unknown> }[] = [
    { name: "場コードが JRA の範囲外(11)", venue: withTokyo((v) => (v["venueCode"] = "11")) },
    { name: "場コードが 1 桁", venue: withTokyo((v) => (v["venueCode"] = "5")) },
    { name: "場コードが数値", venue: withTokyo((v) => (v["venueCode"] = 5)) },
    { name: "場名が文字列でない", venue: withTokyo((v) => (v["venueName"] = null)) },
    { name: "measuredAt が文字列でない", venue: withTokyo((v) => (v["measuredAt"] = 7)) },
    { name: "クッション値が文字列", venue: withTokyo((v) => (v["cushion"] = "9.6")) },
    { name: "クッション値が範囲外(99)", venue: withTokyo((v) => (v["cushion"] = 99)) },
    { name: "クッション値が負", venue: withTokyo((v) => (v["cushion"] = -1)) },
    { name: "含水率が範囲外(101)", venue: withTokyo((v) => ((v["turf"] as Record<string, unknown>)["goal"] = 101)) },
    { name: "含水率が負", venue: withTokyo((v) => ((v["dirt"] as Record<string, unknown>)["corner4"] = -0.1)) },
    { name: "含水率が文字列", venue: withTokyo((v) => ((v["dirt"] as Record<string, unknown>)["goal"] = "1.7")) },
    { name: "降水量が範囲外(1000)", venue: withTokyo((v) => (v["rainfallMm"] = 1000)) },
    { name: "turf が文字列", venue: withTokyo((v) => (v["turf"] = "良")) },
    { name: "状態が文字列でない", venue: withTokyo((v) => ((v["turf"] as Record<string, unknown>)["condition"] = 1)) },
    { name: "使用コースが数値", venue: withTokyo((v) => (v["usedCourse"] = 3)) },
    { name: "競馬場が null", venue: null as unknown as Record<string, unknown> },
  ];
  for (const c of invalid) {
    it(`${c.name}: その競馬場だけ捨てる(京都は残る)`, () => {
      const r = parseBabaResponse(body([c.venue, kyoto()]), NOW);
      expect(r.venues.map((v) => v.venueCode)).toEqual(["08"]);
      expect(r.dropped).toBe(1);
      expect(r.result).toBe("ok");
    });
  }

  it("見本に無い形は NULL として許容する(turf・dirt が null、降水量・使用コース・芝丈・芝の状態が欠落)", () => {
    const v = tokyo();
    v["turf"] = null;
    delete v["dirt"];
    delete v["rainfallMm"];
    v["usedCourse"] = null;
    delete v["turfLength"];
    delete v["turfCondition"];
    delete v["cushion"];
    const r = parseBabaResponse(body([v]), NOW);
    expect(r.result).toBe("ok");
    const none = { condition: null, goalCondition: null, corner4Condition: null, goalMoisture: null, corner4Moisture: null };
    expect(r.venues[0]).toMatchObject({ cushion: null, turf: none, dirt: none, rainfallMm: null, usedCourse: null, turfLength: null, turfConditionText: null });
  });

  it("降水量が数値なら取り込む", () => {
    const r = parseBabaResponse(body([withTokyo((v) => (v["rainfallMm"] = 12.5))]), NOW);
    expect(r.venues[0]?.rainfallMm).toBe(12.5);
  });

  it("境界の値(クッション値 0 と 20、含水率 0 と 100、降水量 0 と 500)は取り込む", () => {
    const lo = withTokyo((v) => {
      v["cushion"] = 0;
      v["rainfallMm"] = 0;
      (v["turf"] as Record<string, unknown>)["goal"] = 0;
    });
    const hi = withTokyo((v) => {
      v["venueCode"] = "08";
      v["cushion"] = 20;
      v["rainfallMm"] = 500;
      (v["turf"] as Record<string, unknown>)["goal"] = 100;
    });
    const r = parseBabaResponse(body([lo, hi]), NOW);
    expect(r.venues.map((v) => [v.cushion, v.rainfallMm, v.turf.goalMoisture])).toEqual([
      [0, 0, 0],
      [20, 500, 100],
    ]);
  });

  it("場コードが重複したら、最初の 1 件だけを残す(主キーの衝突を作らない)", () => {
    const second = withTokyo((v) => (v["cushion"] = 5));
    const r = parseBabaResponse(body([tokyo(), second]), NOW);
    expect(r.venues).toHaveLength(1);
    expect(r.venues[0]?.cushion).toBe(9.6);
    expect(r.dropped).toBe(1);
  });

  it("文字列の項目は、制御文字を除き、長さを切る(使用コース・芝丈は 200 字、芝の状態は 500 字、状態は 20 字)", () => {
    const v = withTokyo((x) => {
      x["usedCourse"] = `A\u0000コース\n${"あ".repeat(300)}`;
      x["turfLength"] = "い".repeat(300);
      x["turfCondition"] = "う".repeat(600);
      (x["turf"] as Record<string, unknown>)["condition"] = "え".repeat(50);
    });
    const r = parseBabaResponse(body([v]), NOW).venues[0]!;
    expect(r.usedCourse).toBe(`Aコース${"あ".repeat(196)}`);
    expect(r.usedCourse).toHaveLength(200);
    expect(r.turfLength).toHaveLength(200);
    expect(r.turfConditionText).toHaveLength(500);
    expect(r.turf.condition).toHaveLength(20);
    expect(`${r.usedCourse}`).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("rawJson は 4KB を超えるときは null(JSON の途中で切らない)", () => {
    const small = parseBabaResponse(body([tokyo()]), NOW).venues[0]!;
    expect(small.rawJson).not.toBeNull();
    expect(small.rawJson!.length).toBeLessThanOrEqual(BABA_RAW_JSON_LIMIT);
    const big = withTokyo((v) => (v["turfCondition"] = "う".repeat(BABA_RAW_JSON_LIMIT)));
    const r = parseBabaResponse(body([big]), NOW).venues[0]!;
    expect(r.rawJson).toBeNull();
    expect(r.turfConditionText).toHaveLength(500); // 列のほうは切って残る
  });
});

describe("全部捨てたときの分類", () => {
  it("形は正しいが当日の競馬場が 1 つも無い(札幌 9/6 だけ)→ no-today-venues(件数は dropped に残る)", () => {
    const r = parseBabaResponse(body([sapporo()]), NOW);
    expect(r.result).toBe("no-today-venues");
    expect(r.venues).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});

describe("捨てた競馬場の理由と計測日時の文字列(Issue #360。朝に値が載っていたか・読めなかったかを後から区別する診断)", () => {
  const jst = (s: string): number => Date.parse(`${s}+09:00`);
  const at = (nowText: string, venues: unknown[]): ReturnType<typeof parseBabaResponse> => {
    const now = jst(nowText);
    return parseBabaResponse(body(venues, new Date(now).toISOString()), now);
  };

  it("見本: 札幌(9/6)は not-today で、場コードと計測日時の文字列を残す。保存した東京・京都は詳細に入らない", () => {
    const r = parseBabaResponse(SAMPLE_TEXT, NOW);
    expect(r.dropped).toBe(1);
    expect(r.droppedDetails).toEqual([{ venue: "01", reason: "not-today", measured: "9月6日（日曜）8時20分" }]);
  });

  // 計測日時が「読めて今日でない」(not-today)と「読めない」(unparsed)の区別。後者は書式の変更などの不具合の兆候。
  const measuredCases: { name: string; now: string; measuredAt: string; reason: "not-today" | "unparsed" }[] = [
    { name: "前日の値(10/11 日曜)", now: "2026-10-12T08:00:00", measuredAt: "10月11日（日曜）7時00分", reason: "not-today" },
    { name: "年をまたぐ古い値(1/3 の取得で 12/28 月曜)", now: "2027-01-03T08:00:00", measuredAt: "12月28日（月曜）7時00分", reason: "not-today" },
    { name: "年末の取得で来年の月日(未来)", now: "2026-12-27T08:00:00", measuredAt: "1月3日（日曜）7時00分", reason: "not-today" },
    // 既知の限界: 半年(182 日)を超えて古い値は、年の補いで別の年(3/1 は 2027 年。140 日先)に当てはまる。その年の曜日(月曜)と合わなければ「読めない」側に分類される(7 通り中 6 通り)。計測日時の文字列は残るので、管理者は読める。
    { name: "半年を超えて古い値(10/12 の取得で 3/1 日曜。2027-03-01 は月曜なので曜日が合わない)", now: "2026-10-12T08:00:00", measuredAt: "3月1日（日曜）7時00分", reason: "unparsed" },
    { name: "1 年前の同じ月日(曜日の検算に失敗)", now: "2026-10-12T08:00:00", measuredAt: "10月12日（日曜）7時00分", reason: "unparsed" },
    { name: "曜日が合わない(10/12 は月曜。火曜は誤り)", now: "2026-10-12T08:00:00", measuredAt: "10月12日（火曜）7時00分", reason: "unparsed" },
    { name: "実在しない日(平年の 2/29)", now: "2026-10-12T08:00:00", measuredAt: "2月29日（日曜）7時00分", reason: "unparsed" },
    { name: "実在しない日(2/30)", now: "2026-10-12T08:00:00", measuredAt: "2月30日（月曜）7時00分", reason: "unparsed" },
    { name: "月が範囲外(13 月)", now: "2026-10-12T08:00:00", measuredAt: "13月1日（月曜）7時00分", reason: "unparsed" },
    { name: "時が範囲外(24 時)", now: "2026-10-12T08:00:00", measuredAt: "10月12日（月曜）24時00分", reason: "unparsed" },
    { name: "分が範囲外(60 分)", now: "2026-10-12T08:00:00", measuredAt: "10月12日（月曜）7時60分", reason: "unparsed" },
    { name: "形が違う(曜日が無い)", now: "2026-10-12T08:00:00", measuredAt: "10月12日 7時00分", reason: "unparsed" },
    { name: "空の文字列", now: "2026-10-12T08:00:00", measuredAt: "", reason: "unparsed" },
    { name: "書式の変更(ISO 形式)", now: "2026-10-12T08:00:00", measuredAt: "2026-10-12T07:00:00+09:00", reason: "unparsed" },
  ];
  for (const c of measuredCases) {
    it(`${c.name} → ${c.reason}。計測日時の文字列をそのまま残す`, () => {
      const r = at(c.now, [{ ...tokyo(), measuredAt: c.measuredAt }]);
      expect(r.venues).toEqual([]);
      expect(r.dropped).toBe(1);
      expect(r.droppedDetails).toEqual([{ venue: "05", reason: c.reason, measured: c.measuredAt }]);
    });
  }

  it("前提: 上の表は not-today と unparsed の両方を含む(区別できている)", () => {
    expect(new Set(measuredCases.map((c) => c.reason))).toEqual(new Set(["not-today", "unparsed"]));
    expect(measuredCases.filter((c) => c.reason === "not-today").length).toBeGreaterThanOrEqual(3);
    expect(measuredCases.filter((c) => c.reason === "unparsed").length).toBeGreaterThanOrEqual(8);
  });

  // 形が不正(invalid)。場コードが読めなければ venue は null、計測日時が文字列でなければ measured は null。
  const withTokyo = (mutate: (v: Record<string, unknown>) => void): Record<string, unknown> => {
    const v = tokyo();
    mutate(v);
    return v;
  };
  const invalidCases: { name: string; venue: unknown; expected: { venue: string | null; measured: string | null } }[] = [
    { name: "クッション値が範囲外(場コード・計測日時は読める)", venue: withTokyo((v) => (v["cushion"] = 99)), expected: { venue: "05", measured: "10月12日（月曜）7時00分" } },
    { name: "場コードが範囲外(11。文字列なので残る)", venue: withTokyo((v) => (v["venueCode"] = "11")), expected: { venue: "11", measured: "10月12日（月曜）7時00分" } },
    { name: "場コードが数値(venue は null)", venue: withTokyo((v) => (v["venueCode"] = 5)), expected: { venue: null, measured: "10月12日（月曜）7時00分" } },
    { name: "measuredAt が文字列でない(measured は null)", venue: withTokyo((v) => (v["measuredAt"] = 7)), expected: { venue: "05", measured: null } },
    { name: "競馬場が null(両方 null)", venue: null, expected: { venue: null, measured: null } },
    { name: "競馬場が配列(両方 null)", venue: [], expected: { venue: null, measured: null } },
  ];
  for (const c of invalidCases) {
    it(`invalid: ${c.name}`, () => {
      const r = parseBabaResponse(body([c.venue, kyoto()]), NOW);
      expect(r.venues.map((v) => v.venueCode)).toEqual(["08"]);
      expect(r.dropped).toBe(1);
      expect(r.droppedDetails).toEqual([{ ...c.expected, reason: "invalid" }]);
    });
  }

  it("duplicate: 場コードの重複の 2 件目。最初の 1 件は保存され、詳細には 2 件目の計測日時の文字列が残る", () => {
    const second = withTokyo((v) => (v["cushion"] = 5));
    const r = parseBabaResponse(body([tokyo(), second]), NOW);
    expect(r.venues).toHaveLength(1);
    expect(r.droppedDetails).toEqual([{ venue: "05", reason: "duplicate", measured: "10月12日（月曜）7時00分" }]);
  });

  it("複数の理由が混ざる応答: 並びは応答の並びのまま、件数 dropped と詳細の件数が一致する", () => {
    const r = parseBabaResponse(body([tokyo(), withTokyo((v) => (v["venueCode"] = "99")), sapporo(), { ...kyoto(), measuredAt: "壊れた" }, tokyo()]), NOW);
    expect(r.venues.map((v) => v.venueCode)).toEqual(["05"]);
    expect(r.dropped).toBe(4);
    expect(r.droppedDetails.map((d) => [d.venue, d.reason])).toEqual([
      ["99", "invalid"],
      ["01", "not-today"],
      ["08", "unparsed"],
      ["05", "duplicate"],
    ]);
    expect(r.droppedDetails).toHaveLength(r.dropped);
  });

  it("計測日時の文字列は制御文字を除いて 40 字に切る(外部の文字列をそのまま保存しない)", () => {
    const r = at("2026-10-12T08:00:00", [{ ...tokyo(), measuredAt: `10月\u0000\n${"あ".repeat(100)}` }]);
    const detail = r.droppedDetails[0]!;
    expect(detail.reason).toBe("unparsed");
    expect(detail.measured).toHaveLength(40);
    expect(detail.measured).toBe(`10月${"あ".repeat(37)}`); // 「10月」は 3 字
    expect(detail.measured).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("詳細は 20 件まで。それを超えても dropped は真の件数(25)のまま", () => {
    const many = Array.from({ length: 25 }, () => ({ ...sapporo(), venueCode: "01" }));
    const r = parseBabaResponse(body(many), NOW);
    expect(r.dropped).toBe(25); // 最初の 1 件は not-today、残り 24 件は duplicate
    expect(r.droppedDetails).toHaveLength(20);
    expect(r.droppedDetails[0]?.reason).toBe("not-today");
  });

  it("全体の失敗(JSON でない・形の不一致・stale)と、捨てた競馬場が無い応答では、詳細は空", () => {
    expect(parseBabaResponse("<html></html>", NOW).droppedDetails).toEqual([]);
    expect(parseBabaResponse("[]", NOW).droppedDetails).toEqual([]);
    expect(parseBabaResponse(body([tokyo(), kyoto()], "2026-10-11T08:00:00.000Z"), NOW).droppedDetails).toEqual([]);
    const clean = parseBabaResponse(body([tokyo(), kyoto()]), NOW);
    expect(clean.result).toBe("ok");
    expect(clean.dropped).toBe(0);
    expect(clean.droppedDetails).toEqual([]);
  });

  it("詳細に、競馬場の値(クッション値・文章)や元の JSON を入れない(場コード・理由・計測日時の文字列だけ)", () => {
    const r = parseBabaResponse(body([{ ...sapporo(), turfCondition: "本文の断片-CANARY" }]), NOW);
    expect(r.droppedDetails).toHaveLength(1);
    expect(Object.keys(r.droppedDetails[0]!).sort()).toEqual(["measured", "reason", "venue"]);
    expect(JSON.stringify(r.droppedDetails)).not.toContain("CANARY");
  });
});
