/**
 * 当日レース結果の傾向を要約する集計純関数(summarizeSameDayTrend)のテスト。
 *
 * タスク#27-B(boss着手前ゲート合意): 面(芝/ダ)ごとに「同一場・同一面・確定済み」に
 * 絞り込み済みの RaceResult[] を受け取り、脚質傾向・内外傾向・上がり傾向を構造化オブジェクトで
 * 返す。文字列化(プロンプト反映)は行わない(Cの責務)。境界値・欠損耐性・決定論性を
 * テーブル駆動で検証する。
 */

import { describe, expect, it } from "vitest";
import { summarizeSameDayTrend } from "../../src/analyzer/same-day-trend.js";
import type { FinishPosition, RaceResult, RaceResultHorse } from "../../src/scraper/types.js";

/** 数値着順の FinishPosition を作る簡易ヘルパー。 */
function rank(value: number, demoted = false): FinishPosition {
  return demoted ? { kind: "順位", value, demoted: true } : { kind: "順位", value };
}

/** 非数値着順(中止・除外等)の FinishPosition を作る簡易ヘルパー。 */
function nonNumeric(text: string): FinishPosition {
  return { kind: "非数値", text };
}

/** テスト用に最小限のフィールドで RaceResultHorse を組み立てるヘルパー。 */
function horse(overrides: Partial<RaceResultHorse> & { umaban: number }): RaceResultHorse {
  return {
    umaban: overrides.umaban,
    finishPosition: overrides.finishPosition ?? null,
    horseName: overrides.horseName ?? `馬${overrides.umaban}`,
    wakuban: overrides.wakuban ?? null,
    passing: overrides.passing ?? [],
    last3f: overrides.last3f ?? null,
  };
}

/** テスト用に RaceResult を組み立てるヘルパー(払戻は本関数では使わないため空配列固定)。 */
function race(horses: RaceResultHorse[]): RaceResult {
  return { horses, placePayouts: [], winPayouts: [] };
}

describe("summarizeSameDayTrend", () => {
  describe("観点1: 確定レース2本未満の閾値(面ごと独立)", () => {
    it("レース1本のみ → データ不足", () => {
      const r = race([
        horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1] }),
        horse({ umaban: 2, finishPosition: rank(2), passing: [2, 2, 2, 2] }),
      ]);
      const result = summarizeSameDayTrend([r]);
      expect(result.脚質傾向).toBe("データ不足");
      expect(result.内外傾向).toBeNull();
      expect(result.上がり傾向).toBeNull();
      expect(result.サンプル数).toEqual({ レース数: 1, 複勝圏内馬数: 2 });
    });

    it("空配列(0本) → データ不足", () => {
      const result = summarizeSameDayTrend([]);
      expect(result.脚質傾向).toBe("データ不足");
      expect(result.内外傾向).toBeNull();
      expect(result.上がり傾向).toBeNull();
      expect(result.サンプル数).toEqual({ レース数: 0, 複勝圏内馬数: 0 });
    });

    it("ちょうど2本 → データ不足を返さず集計する(境界固定)", () => {
      // 頭数4、複勝圏内馬(1〜3着)は前目(r=1/4=0.25)に集中させ「前残り優勢」を確実にする。
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1] }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [1, 1, 1, 1] }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [1, 1, 1, 1] }),
          horse({ umaban: 4, finishPosition: rank(4), passing: [4, 4, 4, 4] }),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.脚質傾向).not.toBe("データ不足");
      expect(result.サンプル数).toEqual({ レース数: 2, 複勝圏内馬数: 6 });
    });
  });

  describe("観点2: 複勝圏内馬のみを集計対象にする", () => {
    it("4着以下・非数値着順・着順null の馬は除外し、降着(demoted)は確定valueで判定する", () => {
      const r1 = race([
        horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1] }),
        horse({ umaban: 2, finishPosition: rank(2, true), passing: [2, 2, 2, 2] }), // 降着でも2着扱い→複勝圏内
        horse({ umaban: 3, finishPosition: rank(4), passing: [4, 4, 4, 4] }), // 4着→対象外
        horse({ umaban: 4, finishPosition: nonNumeric("中止"), passing: [] }), // 非数値→対象外
        horse({ umaban: 5, finishPosition: null, passing: [] }), // 着順欠損→対象外
      ]);
      const r2 = race([
        horse({ umaban: 1, finishPosition: rank(3), passing: [1, 1, 1, 1] }),
        horse({ umaban: 2, finishPosition: rank(5), passing: [5, 5, 5, 5] }),
      ]);
      const result = summarizeSameDayTrend([r1, r2]);
      // 複勝圏内馬数 = r1の2頭(1着・降着2着) + r2の1頭(3着) = 3頭。
      expect(result.サンプル数).toEqual({ レース数: 2, 複勝圏内馬数: 3 });
    });
  });

  describe("観点3: 脚質傾向の境界(相対位置 r = 全コーナー平均÷頭数)", () => {
    // レビュー指摘(要修正2)対応: 複勝圏内複数頭の同一比率をプール平均すると、個々の値は
    // 2進浮動小数として正確でも(例: 2/5===0.4)、6個の同値を合計してから割ると
    // 0.39999999999999997 のような微小な丸め誤差が生じ、「<=」を「<」に変異させても
    // 通過してしまう(誤差により実質的に「厳密未満」の値になっているため)。
    // これを避けるため、境界ちょうどの値を作る複勝圏内馬をレース群全体で「ちょうど1頭」に絞り、
    // 他の複勝圏内馬は passing を空(通過順欠損)にして脚質傾向のプールから除外する。
    // 単一値の average() は加算誤差が生じない(0+x=xが常に正確)ため、プール平均が
    // ビット単位で境界値と一致することを保証できる。
    it("r=0.4 ちょうど(プールする値は唯一1つ) → 前残り優勢(以下側に含む)", () => {
      const raceWithBoundaryHorse = race([
        // 唯一の脚質傾向プール対象。passing平均2÷頭数5=0.4ちょうど(2/5は2進数で正確な0.4)。
        horse({ umaban: 1, finishPosition: rank(1), passing: [2, 2, 2, 2] }),
        horse({ umaban: 2, finishPosition: rank(2), passing: [] }), // 通過順欠損→プール対象外
        horse({ umaban: 3, finishPosition: rank(3), passing: [] }), // 同上
        horse({ umaban: 4, finishPosition: rank(4), passing: [5, 5, 5, 5] }), // 非複勝圏内
        horse({ umaban: 5, finishPosition: rank(5), passing: [5, 5, 5, 5] }), // 非複勝圏内
      ]);
      // 2本目は確定レース数の閾値(2本)を満たすためだけの複勝圏内0頭レース。
      const raceWithNoPlaced = race([
        horse({ umaban: 1, finishPosition: rank(4), passing: [] }),
        horse({ umaban: 2, finishPosition: rank(5), passing: [] }),
      ]);
      const result = summarizeSameDayTrend([raceWithBoundaryHorse, raceWithNoPlaced]);
      expect(result.脚質傾向).toBe("前残り優勢");
    });

    it("r=0.6 ちょうど(プールする値は唯一1つ) → 差し優勢(以上側に含む)", () => {
      const raceWithBoundaryHorse = race([
        // passing平均3÷頭数5=0.6ちょうど(3/5は2進数で正確な0.6)。
        horse({ umaban: 1, finishPosition: rank(1), passing: [3, 3, 3, 3] }),
        horse({ umaban: 2, finishPosition: rank(2), passing: [] }),
        horse({ umaban: 3, finishPosition: rank(3), passing: [] }),
        horse({ umaban: 4, finishPosition: rank(4), passing: [5, 5, 5, 5] }),
        horse({ umaban: 5, finishPosition: rank(5), passing: [5, 5, 5, 5] }),
      ]);
      const raceWithNoPlaced = race([
        horse({ umaban: 1, finishPosition: rank(4), passing: [] }),
        horse({ umaban: 2, finishPosition: rank(5), passing: [] }),
      ]);
      const result = summarizeSameDayTrend([raceWithBoundaryHorse, raceWithNoPlaced]);
      expect(result.脚質傾向).toBe("差し優勢");
    });

    it("r=0.5(0.4<r<0.6の中間) → 顕著な傾向なし", () => {
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [2, 3, 2, 3] }), // 平均2.5÷5=0.5
          horse({ umaban: 2, finishPosition: rank(2), passing: [2, 3, 2, 3] }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [2, 3, 2, 3] }),
          horse({ umaban: 4, finishPosition: rank(4), passing: [5, 5, 5, 5] }),
          horse({ umaban: 5, finishPosition: rank(5), passing: [5, 5, 5, 5] }),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.脚質傾向).toBe("顕著な傾向なし");
    });
  });

  describe("観点4: 内外傾向の境界(馬番相対 umaban/頭数)", () => {
    // 観点3と同じ理由(浮動小数のプール加算誤差)により、境界ちょうどの値を作る複勝圏内馬を
    // 「ちょうど1頭」に絞る(他の複勝圏内馬を作らない)ことで、プール平均がビット単位で
    // 境界値と一致することを保証する。外有利側(平均馬番6=r0.6)は元々複数値プールでも
    // ビット単位で一致することを確認済みだが、一貫性のため同じ単一値方式に揃える。
    it.each([
      { label: "内偏り(馬番4=r0.4ちょうど) → 内有利", boundaryUmaban: 4, expected: "内有利" },
      { label: "外偏り(馬番6=r0.6ちょうど) → 外有利", boundaryUmaban: 6, expected: "外有利" },
      { label: "中立(馬番5=r0.5) → null", boundaryUmaban: 5, expected: null },
    ])("$label", ({ boundaryUmaban, expected }) => {
      const fieldSize = 10;
      const otherUmaban = Array.from({ length: fieldSize }, (_, i) => i + 1).filter(
        (u) => u !== boundaryUmaban,
      );
      const raceWithBoundaryHorse = race([
        horse({ umaban: boundaryUmaban, finishPosition: rank(1) }), // 唯一の内外傾向プール対象
        ...otherUmaban.map((u) => horse({ umaban: u, finishPosition: rank(4) })), // 全て非複勝圏内
      ]);
      const raceWithNoPlaced = race([
        horse({ umaban: 1, finishPosition: rank(4) }),
        horse({ umaban: 2, finishPosition: rank(5) }),
      ]);
      const result = summarizeSameDayTrend([raceWithBoundaryHorse, raceWithNoPlaced]);
      expect(result.内外傾向).toBe(expected);
    });

    it("母数不足(馬番が非有限・0以下)の馬は内外傾向の指標のみ除外し throw しない", () => {
      const makeRace = () =>
        race([
          horse({ umaban: 0, finishPosition: rank(1), passing: [1, 1, 1, 1] }), // 馬番欠損相当
          horse({ umaban: Number.NaN, finishPosition: rank(2), passing: [2, 2, 2, 2] }), // 馬番欠損相当
          horse({ umaban: 3, finishPosition: rank(3), passing: [3, 3, 3, 3] }),
        ]);
      expect(() => summarizeSameDayTrend([makeRace(), makeRace()])).not.toThrow();
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      // 有効な馬番は1頭(umaban=3, 頭数3 → r=1)のみ →外有利側だが、境界確認が主眼ではなく
      // 例外が起きないこと・計算が有効データのみで行われることの確認。
      expect(result.内外傾向).toBe("外有利");
    });
  });

  describe("観点5: 欠損耐性(該当指標のみ除外、他指標は算出継続)", () => {
    it("passingが空の馬は脚質傾向・上がり傾向の位置情報から除外されるが、他の複勝圏内馬で算出は継続する", () => {
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [] }), // 通過順欠損
          horse({ umaban: 2, finishPosition: rank(2), passing: [1, 1, 1, 1] }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [1, 1, 1, 1] }),
          horse({ umaban: 4, finishPosition: rank(4), passing: [4, 4, 4, 4] }),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.脚質傾向).toBe("前残り優勢");
    });

    it("last3fがnullの馬は上がり傾向の算出から除外されるが、脚質傾向・内外傾向は算出継続する", () => {
      // 頭数10、複勝圏内(1〜3着)の馬番を1・2・3(内寄り)に固定して内外傾向を確実に「内有利」にする。
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1], last3f: null }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [1, 1, 1, 1], last3f: null }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [1, 1, 1, 1], last3f: null }),
          ...Array.from({ length: 7 }, (_, i) =>
            horse({ umaban: i + 4, finishPosition: rank(i + 4), passing: [i + 4, i + 4, i + 4, i + 4], last3f: null }),
          ),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.脚質傾向).toBe("前残り優勢");
      expect(result.内外傾向).toBe("内有利");
      expect(result.上がり傾向).toBeNull(); // last3fが全馬nullのため判定不可
    });

    it("ある指標(上がり)が全馬欠損でも、他指標(脚質・内外)はnullにならず算出される", () => {
      // 頭数10、複勝圏内の馬番を1・2・3(内寄り)に固定して内外傾向が中立バンドに落ちないようにする。
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1], last3f: null }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [1, 1, 1, 1], last3f: null }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [1, 1, 1, 1], last3f: null }),
          ...Array.from({ length: 7 }, (_, i) =>
            horse({ umaban: i + 4, finishPosition: rank(i + 4), passing: [i + 4, i + 4, i + 4, i + 4], last3f: null }),
          ),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.脚質傾向).not.toBe("データ不足");
      expect(result.内外傾向).not.toBeNull();
      expect(result.上がり傾向).toBeNull();
    });
  });

  describe("観点6: 異常系で例外を投げない", () => {
    it.each([
      { label: "複勝圏内0頭(全馬非数値着順)", races: () => [race0Placed(), race0Placed()] },
      { label: "空配列", races: () => [] as RaceResult[] },
      { label: "全レース1本のみ", races: () => [race0Placed()] },
    ])("$label", ({ races }) => {
      expect(() => summarizeSameDayTrend(races())).not.toThrow();
    });

    function race0Placed(): RaceResult {
      return race([
        horse({ umaban: 1, finishPosition: nonNumeric("中止"), passing: [] }),
        horse({ umaban: 2, finishPosition: nonNumeric("除外"), passing: [] }),
      ]);
    }
  });

  describe("観点7: 決定論性(順序に依存しない)", () => {
    it("レース配列・馬配列の順序を入れ替えても出力が変わらない", () => {
      const r1 = race([
        horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1], last3f: 34.0 }),
        horse({ umaban: 2, finishPosition: rank(2), passing: [2, 2, 2, 2], last3f: 34.5 }),
        horse({ umaban: 3, finishPosition: rank(3), passing: [3, 3, 3, 3], last3f: 35.0 }),
        horse({ umaban: 4, finishPosition: rank(4), passing: [4, 4, 4, 4], last3f: 35.5 }),
      ]);
      const r2 = race([
        horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1], last3f: 33.0 }),
        horse({ umaban: 2, finishPosition: rank(2), passing: [2, 2, 2, 2], last3f: 33.5 }),
        horse({ umaban: 3, finishPosition: rank(3), passing: [3, 3, 3, 3], last3f: 34.0 }),
      ]);

      const original = summarizeSameDayTrend([r1, r2]);

      const r1Shuffled = race([...r1.horses].reverse());
      const r2Shuffled = race([...r2.horses].reverse());
      const reordered = summarizeSameDayTrend([r2Shuffled, r1Shuffled]);

      expect(reordered).toEqual(original);
    });
  });

  describe("観点8: 上がり傾向(案A・自己参照的・絶対タイム非依存)", () => {
    it("複勝圏内馬が同レース平均より速い上がりかつ後方脚質(r>=0.6)に偏る → 差し・上がり優勢の示唆", () => {
      // 頭数5。複勝圏内(1〜3着)は後方(r=4/5=0.8)かつ上がりが最速(平均より速い)。
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [4, 4, 4, 4], last3f: 33.0 }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [4, 4, 4, 4], last3f: 33.2 }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [4, 4, 4, 4], last3f: 33.4 }),
          horse({ umaban: 4, finishPosition: rank(4), passing: [1, 1, 1, 1], last3f: 37.0 }),
          horse({ umaban: 5, finishPosition: rank(5), passing: [1, 1, 1, 1], last3f: 37.5 }),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.上がり傾向).toBe("差し・上がり優勢の示唆");
    });

    it("複勝圏内馬が絶対タイムの遅い/速いに関わらず前残り(r<=0.4)かつ上がりが平均以下 → 顕著な傾向なし", () => {
      // 距離・馬場が変わっても(絶対タイムが遅くても)自己参照的な判定は変わらないことを確認。
      const makeRace = (baseLast3f: number) =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1], last3f: baseLast3f + 0.5 }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [1, 1, 1, 1], last3f: baseLast3f + 0.4 }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [1, 1, 1, 1], last3f: baseLast3f + 0.3 }),
          horse({ umaban: 4, finishPosition: rank(4), passing: [5, 5, 5, 5], last3f: baseLast3f - 1.0 }),
          horse({ umaban: 5, finishPosition: rank(5), passing: [5, 5, 5, 5], last3f: baseLast3f - 1.2 }),
        ]);
      // 平均タイムが全く異なる2レース(絶対タイム閾値に依存しないことの確認)。
      const result = summarizeSameDayTrend([makeRace(33.0), makeRace(40.0)]);
      expect(result.上がり傾向).toBe("顕著な傾向なし");
    });

    // レビュー指摘(要修正1)対応: 上記の既存テストはいずれも「後方脚質(backLeaning)」と
    // 「絶対タイム閾値による速さ」の判定が偶然一致してしまい(前者は常にfalseで判定を握り潰す、
    // 後者はたまたま同じ結果になる値を使っている)、`raceAvgLast3f`(自己参照比較)を固定の
    // 絶対閾値(例: 35.0秒)に置き換える変異を入れても21件全通過してしまっていた
    // (要修正1・ミューテーションで検出済み)。後方脚質(r>=0.6)を満たしたまま、
    // 絶対タイム水準だけを大きく変えて「自己参照でなければ判定が狂う」状況を作り、
    // `raceAvgLast3f`→固定閾値への変異で実際に失敗することを確認したうえで追加する。
    it("(a) 絶対水準を大きく変えても、後方脚質かつ同レース内で相対的に速いという構造が同じなら上がり傾向の判定は変わらない(自己参照の確認)", () => {
      // 頭数5。複勝圏内(1〜3着)は後方(r=4/5=0.8)かつ同レース平均より上がりが速い構造を保ったまま、
      // 上がり3Fの絶対水準(base)だけを大きく変える。
      const makeRace = (base: number) =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [4, 4, 4, 4], last3f: base }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [4, 4, 4, 4], last3f: base + 0.2 }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [4, 4, 4, 4], last3f: base + 0.4 }),
          horse({ umaban: 4, finishPosition: rank(4), passing: [1, 1, 1, 1], last3f: base + 4.0 }),
          horse({ umaban: 5, finishPosition: rank(5), passing: [1, 1, 1, 1], last3f: base + 4.5 }),
        ]);
      // low: 絶対タイムが十分速い(固定閾値35.0秒未満に収まる)水準。
      const low = summarizeSameDayTrend([makeRace(33.0), makeRace(33.0)]);
      // high: 絶対タイムが十分遅い(固定閾値35.0秒を上回る)水準。自己参照であれば構造は
      // lowと同じ(後方かつ同レース内最速)なので判定は変わらないはず。
      const high = summarizeSameDayTrend([makeRace(38.0), makeRace(38.0)]);
      expect(low.上がり傾向).toBe("差し・上がり優勢の示唆");
      expect(high.上がり傾向).toBe(low.上がり傾向);
    });

    it("(b) 絶対水準だけが高く(固定の絶対タイム閾値なら「遅い」と誤判定されうる水準)ても、後方かつ相対的に速い複勝圏内馬は示唆判定になる", () => {
      // 頭数5。上がり3Fの絶対水準を38秒台(一般的な「速い上がり」の目安である35秒より遅い)に
      // そろえた上で、複勝圏内馬(後方・r=0.8)がレース内では相対的に最速という構造にする。
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [4, 4, 4, 4], last3f: 38.0 }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [4, 4, 4, 4], last3f: 38.2 }),
          horse({ umaban: 3, finishPosition: rank(3), passing: [4, 4, 4, 4], last3f: 38.4 }),
          horse({ umaban: 4, finishPosition: rank(4), passing: [1, 1, 1, 1], last3f: 42.0 }),
          horse({ umaban: 5, finishPosition: rank(5), passing: [1, 1, 1, 1], last3f: 42.5 }),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.上がり傾向).toBe("差し・上がり優勢の示唆");
    });

    // レビュー指摘(要修正3)対応: 過半数判定(hitRatio > 0.5)の「ちょうど50%」境界が未検証で、
    // `>`→`>=` の変異が通過していた(ミューテーションで検出済み)。1レースにつき
    // 該当馬(後方かつ相対的に速い)1頭・非該当馬(前残りで backLeaning が成立しない)1頭を
    // 複勝圏内に置き、2レース分プールして 2/4=0.5 ちょうどを作る。
    it("該当馬の比率がちょうど50%(2/4) → 過半数に届かず顕著な傾向なし(境界は超側=exclusiveを含まない)", () => {
      const makeRace = () =>
        race([
          // 該当(hit): 後方(r=4/4=1.0>=0.6)かつ同レース平均より上がりが速い。
          horse({ umaban: 1, finishPosition: rank(1), passing: [4, 4, 4, 4], last3f: 33.0 }),
          // 非該当(miss): 前残り(r=1/4=0.25<0.6)のため上がりが速くても後方脚質を満たさない。
          horse({ umaban: 2, finishPosition: rank(2), passing: [1, 1, 1, 1], last3f: 33.5 }),
          // 非複勝圏内(4着以下)。レース平均の算出材料としてのみ使う。
          horse({ umaban: 3, finishPosition: rank(4), passing: [2, 2, 2, 2], last3f: 37.0 }),
          horse({ umaban: 4, finishPosition: rank(5), passing: [2, 2, 2, 2], last3f: 37.5 }),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.上がり傾向).toBe("顕著な傾向なし");
    });

    it("last3fが全馬null → 判定不可(null)", () => {
      const makeRace = () =>
        race([
          horse({ umaban: 1, finishPosition: rank(1), passing: [1, 1, 1, 1], last3f: null }),
          horse({ umaban: 2, finishPosition: rank(2), passing: [1, 1, 1, 1], last3f: null }),
        ]);
      const result = summarizeSameDayTrend([makeRace(), makeRace()]);
      expect(result.上がり傾向).toBeNull();
    });
  });
});
