import { describe, expect, it } from "vitest";
import { extractRaceFacts, RACE_FACT_TEXT_MAX_LENGTH, type RaceFacts } from "../src/race-facts";

/**
 * Issue #389(#385-B の a): 分析のスナップショット(R2 の詳細の `raceSnapshot`)から、条件別の見える化が使うレースの事実を取り出す純関数。
 * 想定外の形・型は例外にせず、その項目だけ null(推測で直さない)。値は生のまま持つ(良・稍・「−」・グレードの表記・レース名の正規化はしない。クラスの推定などは画面側 = #389-b)。
 */

const NONE: RaceFacts = { courseType: null, distance: null, trackCondition: null, grade: null, raceName: null };
const FULL = { race: { raceName: "3歳以上1勝クラス", courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3" } };

describe("extractRaceFacts: 正常な値", () => {
  it("5 項目を生のまま取り出す(馬場の略記・グレードの表記を変換しない)", () => {
    expect(extractRaceFacts(FULL)).toEqual({ courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "3歳以上1勝クラス" });
  });

  it("地方の馬場「−」も生のまま(未発表の扱いは画面側で決める)", () => {
    expect(extractRaceFacts({ race: { ...FULL.race, trackCondition: "−" } }).trackCondition).toBe("−");
  });

  it("文字列は前後の空白を除く。距離は整数のまま", () => {
    const facts = extractRaceFacts({ race: { raceName: "  ファイナルレース(C3) ", courseType: "ダ", distance: 1200, trackCondition: " 良", grade: " OP " } });
    expect(facts).toEqual({ courseType: "ダ", distance: 1200, trackCondition: "良", grade: "OP", raceName: "ファイナルレース(C3)" });
  });
});

describe("extractRaceFacts: 障害(Issue #389 の【記録】回収)", () => {
  it("courseType の「障」は想定内の値として残す(障害レースを『不明』にしない。距離・グレードも生のまま)", () => {
    expect(extractRaceFacts({ race: { raceName: "中山グランドJ", courseType: "障", distance: 4250, trackCondition: "良", grade: "J・G1" } })).toEqual({
      courseType: "障", distance: 4250, trackCondition: "良", grade: "J・G1", raceName: "中山グランドJ",
    });
  });
});

describe("extractRaceFacts: スナップショット全体が壊れている(全項目 null)", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["スナップショットが null", null],
    ["スナップショットが文字列", "x"],
    ["スナップショットが配列", [FULL]],
    ["race が無い", { horses: [] }],
    ["race が null", { race: null }],
    ["race が配列", { race: [FULL.race] }],
  ];
  it.each(cases)("%s", (_name, snapshot) => {
    expect(extractRaceFacts(snapshot)).toEqual(NONE);
  });
});

describe("extractRaceFacts: 項目ごとの欠落・型違い(その項目だけ null。ほかの項目は FULL の値のまま)", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, Partial<RaceFacts>]> = [
    ["courseType が想定外の値(障害)", { courseType: "障害" }, { courseType: null }],
    ["courseType が数値", { courseType: 1 }, { courseType: null }],
    ["distance が文字列", { distance: "1600" }, { distance: null }],
    ["distance が小数", { distance: 1600.5 }, { distance: null }],
    ["distance が 0", { distance: 0 }, { distance: null }],
    ["distance が負", { distance: -1200 }, { distance: null }],
    ["distance が NaN", { distance: Number.NaN }, { distance: null }],
    ["distance が Infinity", { distance: Number.POSITIVE_INFINITY }, { distance: null }],
    ["trackCondition が null(未発表)", { trackCondition: null }, { trackCondition: null }],
    ["trackCondition が空白だけ", { trackCondition: "  " }, { trackCondition: null }],
    ["trackCondition が数値", { trackCondition: 1 }, { trackCondition: null }],
    ["grade が空文字", { grade: "" }, { grade: null }],
    ["grade が数値", { grade: 1 }, { grade: null }],
    ["raceName が空文字(#252 より前の地方)", { raceName: "" }, { raceName: null }],
    ["raceName が配列", { raceName: ["a"] }, { raceName: null }],
  ];
  it.each(cases)("%s", (_name, broken, override) => {
    const expected: RaceFacts = { courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "3歳以上1勝クラス", ...override };
    // 前提(空振り防止): 壊していない項目は非 null で、壊した項目だけが null になる
    expect(Object.values(override).every((v) => v === null)).toBe(true);
    expect(Object.values(expected).filter((v) => v !== null).length).toBe(4);
    expect(extractRaceFacts({ race: { ...FULL.race, ...broken } })).toEqual(expected);
  });

  it("キー自体が無い項目(グレードを保存する前の旧いスナップショット)は null", () => {
    expect(extractRaceFacts({ race: { raceName: "x", courseType: "芝", distance: 1600 } })).toEqual({ courseType: "芝", distance: 1600, trackCondition: null, grade: null, raceName: "x" });
  });
});

describe("extractRaceFacts: 長すぎる文字列(自由文の疑い)", () => {
  it(`${RACE_FACT_TEXT_MAX_LENGTH} 文字ちょうどは残し、超えると null(切り詰めない=途中で切れた名前を事実として持たない)`, () => {
    const ok = "あ".repeat(RACE_FACT_TEXT_MAX_LENGTH);
    const over = "あ".repeat(RACE_FACT_TEXT_MAX_LENGTH + 1);
    expect(extractRaceFacts({ race: { raceName: ok, grade: ok, trackCondition: ok } })).toMatchObject({ raceName: ok, grade: ok, trackCondition: ok });
    expect(extractRaceFacts({ race: { raceName: over, grade: over, trackCondition: over } })).toMatchObject({ raceName: null, grade: null, trackCondition: null });
  });
});

describe("extractRaceFacts: レースのクラス(Issue #426)", () => {
  it("race.raceClass(中央の正準ラベル・地方の生のトークン)を取り出す。前後の空白は除く", () => {
    expect(extractRaceFacts({ race: { ...FULL.race, raceClass: "2勝クラス" } })).toEqual({ courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "3歳以上1勝クラス", raceClass: "2勝クラス" });
    expect(extractRaceFacts({ race: { raceClass: " A2B1 " } }).raceClass).toBe("A2B1");
  });

  it("★持たない・読めない値ではキー自体を付けない(クラスを保存する前のスナップショットの事実は従来のまま。null を足さない)", () => {
    // 対照: あればキーが現れる。
    expect("raceClass" in extractRaceFacts({ race: { raceClass: "新馬" } })).toBe(true);
    for (const raceClass of [undefined, null, "", "  ", 1, ["オープン"], "あ".repeat(RACE_FACT_TEXT_MAX_LENGTH + 1)]) {
      const facts = extractRaceFacts({ race: { ...FULL.race, raceClass } });
      expect("raceClass" in facts, String(raceClass)).toBe(false);
      expect(facts, String(raceClass)).toEqual({ courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "3歳以上1勝クラス" });
    }
    expect("raceClass" in extractRaceFacts(null)).toBe(false);
  });
});
