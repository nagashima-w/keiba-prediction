import { describe, expect, it } from "vitest";
import { courseDisplayName, parseCourseKey, readCourse, readCourseFit } from "../src/model-course";

/**
 * Issue #802: 別の Worker が返すコースの参考情報(`course`・`course_fit`)の検査。
 * 欄ごとに独立に検査し、崩れていればその欄だけ null にする。表示名は key から本番の側で組み、外から来た文字列は決まった語の一覧に合うときだけ使う。
 */

const FIT = { runs: 5, wins: 1, top3: 2, best: 1 };
const goodFit = (over: Record<string, unknown> = {}) => ({ same: { ...FIT }, similar: { ...FIT, courses: ["05-T-1600-out"] }, unknown_ring: 0, ...over });

describe("parseCourseKey(key の形)", () => {
  it.each([
    ["05-T-1600-out", { venue: "東京", surface: "芝", distance: 1600, ring: "out" }],
    ["10-D-1000-straight", { venue: "小倉", surface: "ダ", distance: 1000, ring: "straight" }],
    ["01-T-4000-outin", { venue: "札幌", surface: "芝", distance: 4000, ring: "outin" }],
    ["09-D-2400-in", { venue: "阪神", surface: "ダ", distance: 2400, ring: "in" }],
  ])("正しい key %s", (key, want) => {
    expect(parseCourseKey(key)).toEqual(want);
  });

  it.each([
    ["場コード 00", "00-T-1600-out"],
    ["場コード 11", "11-T-1600-out"],
    ["場コード 1 桁", "5-T-1600-out"],
    ["芝ダ以外", "05-X-1600-out"],
    ["小文字の芝", "05-t-1600-out"],
    ["距離が 2 桁", "05-T-16-out"],
    ["距離が 5 桁", "05-T-16000-out"],
    ["距離が 1000 未満(3 桁)", "05-T-999-out"],
    ["距離が 4000 超", "05-T-4001-out"],
    ["周りが語彙外", "05-T-1600-left"],
    ["周りが無い", "05-T-1600"],
    ["前後に余計な文字", "x05-T-1600-out"],
    ["末尾に余計な文字", "05-T-1600-out "],
    ["空文字", ""],
  ])("崩れた key は null: %s", (_label, key) => {
    expect(parseCourseKey(key)).toBeNull();
  });

  it("文字列以外は null", () => {
    expect(parseCourseKey(5)).toBeNull();
    expect(parseCourseKey(null)).toBeNull();
    expect(parseCourseKey(undefined)).toBeNull();
  });

  it("距離の境界 1000 と 4000 は通る", () => {
    expect(parseCourseKey("05-T-1000-in")?.distance).toBe(1000);
    expect(parseCourseKey("05-T-4000-in")?.distance).toBe(4000);
  });
});

describe("courseDisplayName(表示名は key から組む)", () => {
  it.each([
    ["組んだ名前と完全一致", "05-T-1600-out", "東京 芝1600", "東京 芝1600"],
    ["組んだ名前 + 周りに対応する語(out)", "06-T-2000-out", "中山 芝2000 外回り", "中山 芝2000 外回り"],
    ["in に対応する語", "06-T-2000-in", "中山 芝2000 内回り", "中山 芝2000 内回り"],
    ["outin に対応する語", "06-T-2000-outin", "中山 芝2000 外内回り", "中山 芝2000 外内回り"],
    ["straight に対応する語", "04-T-1000-straight", "新潟 芝1000 直線", "新潟 芝1000 直線"],
    ["周りと食い違う語は組んだ名前", "06-T-2000-out", "中山 芝2000 内回り", "中山 芝2000"],
    ["語の一覧にない末尾は組んだ名前", "05-T-1600-out", "東京 芝1600 おすすめ", "東京 芝1600"],
    ["場名が違う name は組んだ名前", "05-T-1600-out", "京都 芝1600", "東京 芝1600"],
    ["name が空文字は組んだ名前", "05-D-1600-in", "", "東京 ダ1600"],
    ["name が前置きだけ一致(余計な後ろ)は組んだ名前", "05-T-1600-out", "東京 芝16000", "東京 芝1600"],
    ["name の語の前に空白が無いものは不採用", "06-T-2000-out", "中山 芝2000外回り", "中山 芝2000"],
    ["HTML らしい文字列は組んだ名前", "05-T-1600-out", "<script>alert(1)</script>", "東京 芝1600"],
  ])("%s", (_label, key, name, want) => {
    expect(courseDisplayName(key, name)).toBe(want);
  });

  it("name が文字列以外でも、組んだ名前", () => {
    expect(courseDisplayName("05-T-1600-out", 5)).toBe("東京 芝1600");
    expect(courseDisplayName("05-T-1600-out", undefined)).toBe("東京 芝1600");
  });

  it("key が崩れていれば null", () => {
    expect(courseDisplayName("99-T-1600-out", "東京 芝1600")).toBeNull();
  });
});

describe("readCourse(`course` の検査)", () => {
  const el = (key: string, s: unknown, extra: Record<string, unknown> = {}) => ({ key, name: "x", s, ...extra });
  const base = (over: Record<string, unknown> = {}) => ({ key: "05-T-1600-out", name: "東京 芝1600", similar_shape: [], similar_results: [], ...over });

  it("正しい course は表示名つきの形にする(外から来た name は使わない場合もある)", () => {
    const c = readCourse(base({ name: "何か別の文字", similar_shape: [el("06-T-2000-out", 0.5)], similar_results: [el("09-D-1800-in", 0.25, { n: 12 })] }));
    expect(c).toEqual({
      name: "東京 芝1600",
      similarShape: [{ name: "中山 芝2000", s: 0.5 }],
      similarResults: [{ name: "阪神 ダ1800", s: 0.25, n: 12 }],
    });
  });

  it("course が無い・オブジェクトでない・key が崩れていれば null(course 全体を落とす)", () => {
    expect(readCourse(undefined)).toBeNull();
    expect(readCourse(null)).toBeNull();
    expect(readCourse([])).toBeNull();
    expect(readCourse("05-T-1600-out")).toBeNull();
    expect(readCourse(base({ key: "05-T-999-out" }))).toBeNull();
    expect(readCourse(base({ key: 5 }))).toBeNull();
  });

  it.each([
    ["s = 0", 0, true],
    ["s = 1", 1, true],
    ["s = 0.5", 0.5, true],
    ["s が負", -0.01, false],
    ["s が 1 超", 1.01, false],
    ["s が NaN", Number.NaN, false],
    ["s が Infinity", Number.POSITIVE_INFINITY, false],
    ["s が文字列", "0.5", false],
    ["s が null", null, false],
  ])("similar_shape の s の境界: %s", (_label, s, keep) => {
    const c = readCourse(base({ similar_shape: [el("06-T-2000-out", s)] }));
    expect(c).not.toBeNull();
    expect(c!.similarShape).toEqual(keep ? [{ name: "中山 芝2000", s }] : null);
  });

  it.each([
    ["n = 0", 0, true],
    ["n = 3", 3, true],
    ["n が負", -1, false],
    ["n が小数", 1.5, false],
    ["n が NaN", Number.NaN, false],
    ["n が文字列", "3", false],
    ["n が無い", undefined, false],
  ])("similar_results の n の境界: %s", (_label, n, keep) => {
    const e = n === undefined ? el("06-T-2000-out", 0.5) : el("06-T-2000-out", 0.5, { n });
    const c = readCourse(base({ similar_results: [e] }));
    expect(c).not.toBeNull();
    expect(c!.similarResults).toEqual(keep ? [{ name: "中山 芝2000", s: 0.5, n }] : null);
  });

  it("要素が 1 つでも崩れていれば、その配列全体を落とす(一部だけ出さない)。もう一方の配列には影響しない", () => {
    const c = readCourse(
      base({
        similar_shape: [el("06-T-2000-out", 0.5), el("06-T-2000-bad", 0.4)],
        similar_results: [el("06-T-2000-out", 0.5, { n: 2 })],
      }),
    );
    expect(c!.similarShape).toBeNull();
    expect(c!.similarResults).toEqual([{ name: "中山 芝2000", s: 0.5, n: 2 }]);
  });

  it("要素が配列でない・オブジェクトでない・距離が範囲外なら、その配列を落とす", () => {
    expect(readCourse(base({ similar_shape: "x" }))!.similarShape).toBeNull();
    expect(readCourse(base({ similar_shape: [null] }))!.similarShape).toBeNull();
    expect(readCourse(base({ similar_shape: [el("06-T-4001-out", 0.5)] }))!.similarShape).toBeNull();
    expect(readCourse(base({ similar_results: undefined }))!.similarResults).toBeNull();
  });

  it("5 件までは全部、6 件なら先頭 5 件", () => {
    const five = Array.from({ length: 5 }, (_, i) => el("06-T-2000-out", 0.1 * (i + 1)));
    const six = [...five, el("06-T-2000-in", 0.9)];
    expect(readCourse(base({ similar_shape: five }))!.similarShape).toHaveLength(5);
    const c = readCourse(base({ similar_shape: six }))!;
    expect(c.similarShape).toHaveLength(5);
    expect(c.similarShape!.map((x) => x.s)).toEqual(five.map((x) => x.s));
  });

  it("空の配列は、空のまま(崩れではない)", () => {
    const c = readCourse(base())!;
    expect(c.similarShape).toEqual([]);
    expect(c.similarResults).toEqual([]);
  });

  it("要素の name も、組んだ名前・対応する周りの語のときだけ使う", () => {
    const c = readCourse(base({ similar_shape: [{ key: "06-T-2000-out", name: "中山 芝2000 外回り", s: 0.5 }, { key: "06-T-2000-out", name: "任意の文字", s: 0.4 }] }))!;
    expect(c.similarShape!.map((x) => x.name)).toEqual(["中山 芝2000 外回り", "中山 芝2000"]);
  });
});

describe("readCourseFit(`course_fit` の検査)", () => {
  it("正しい形はそのまま(courses は持たない)", () => {
    expect(readCourseFit(goodFit())).toEqual({ same: FIT, similar: FIT, unknownRing: 0 });
  });

  it("無い・オブジェクトでない場合は null", () => {
    expect(readCourseFit(undefined)).toBeNull();
    expect(readCourseFit(null)).toBeNull();
    expect(readCourseFit([])).toBeNull();
  });

  it.each([
    ["runs が負", { runs: -1, wins: 0, top3: 0, best: null }],
    ["runs が小数", { runs: 1.5, wins: 0, top3: 0, best: null }],
    ["wins が文字列", { runs: 3, wins: "1", top3: 1, best: 1 }],
    ["wins > top3", { runs: 5, wins: 3, top3: 2, best: 1 }],
    ["top3 > runs", { runs: 2, wins: 1, top3: 3, best: 1 }],
    ["best が 0", { runs: 5, wins: 0, top3: 0, best: 0 }],
    ["best が小数", { runs: 5, wins: 0, top3: 0, best: 1.5 }],
    ["best が文字列", { runs: 5, wins: 0, top3: 0, best: "1" }],
    ["runs 0 なのに best がある", { runs: 0, wins: 0, top3: 0, best: 1 }],
    ["best のキーが無い", { runs: 5, wins: 0, top3: 0 }],
    ["NaN", { runs: Number.NaN, wins: 0, top3: 0, best: null }],
  ])("same が崩れていれば null: %s", (_label, same) => {
    expect(readCourseFit(goodFit({ same }))).toBeNull();
  });

  it("similar が崩れていても null(馬の course_fit ごと落とす)", () => {
    expect(readCourseFit(goodFit({ similar: { runs: 1, wins: 2, top3: 1, best: 1 } }))).toBeNull();
  });

  it("境界: runs 0 と best null、wins = top3 = runs、best が 1 以上", () => {
    expect(readCourseFit(goodFit({ same: { runs: 0, wins: 0, top3: 0, best: null } }))!.same).toEqual({ runs: 0, wins: 0, top3: 0, best: null });
    expect(readCourseFit(goodFit({ same: { runs: 3, wins: 3, top3: 3, best: 1 } }))!.same.runs).toBe(3);
    expect(readCourseFit(goodFit({ same: { runs: 4, wins: 0, top3: 0, best: 18 } }))!.same.best).toBe(18);
  });

  it("runs > 0 で best が null は許す。wins > 0 でも best は検査しない", () => {
    expect(readCourseFit(goodFit({ same: { runs: 2, wins: 0, top3: 0, best: null } }))).not.toBeNull();
    expect(readCourseFit(goodFit({ same: { runs: 2, wins: 1, top3: 1, best: 3 } }))).not.toBeNull();
  });

  it.each([
    ["負", -1],
    ["小数", 0.5],
    ["文字列", "1"],
    ["null", null],
    ["無い", undefined],
  ])("unknown_ring が %s なら null", (_label, v) => {
    const raw = goodFit();
    if (v === undefined) delete (raw as Record<string, unknown>)["unknown_ring"];
    else raw.unknown_ring = v as never;
    expect(readCourseFit(raw)).toBeNull();
  });

  it("unknown_ring が 3 ならそのまま", () => {
    expect(readCourseFit(goodFit({ unknown_ring: 3 }))!.unknownRing).toBe(3);
  });
});
