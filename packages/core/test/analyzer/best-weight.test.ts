/**
 * ベスト体重(好走時の馬体重)の要約(Issue #212・#210-A)の純関数テスト。
 *
 * 目的: 「馬体重が大きく減った」をそれだけで不安材料にせず、その馬が好走(3着以内)したときの
 * 体重と照らして LLM に判断させるための、中立な材料を作る(前走で増えすぎた分が戻っただけ、
 * といった場合を見分けられるようにする)。
 *
 * 確定事項(ユーザー決定 2026-10-09): 直近の好走5走の中央値と範囲を出す。範囲は最小〜最大だと
 * 古い走で幅が広がる(実戦績で幅50kg超)ため、直近5走に限る。
 * 着順の扱い(降着=確定着順・非数値は対象外)は scorer の isPlaced と揃える。
 */

import { describe, expect, it } from "vitest";
import { summarizeBestWeight, type BestWeightPastRun } from "../../src/analyzer/best-weight.js";
import type { BodyWeight, FinishPosition } from "../../src/scraper/types.js";

function pos(value: number, demoted = false): FinishPosition {
  return demoted ? { kind: "順位", value, demoted: true } : { kind: "順位", value };
}

/** 過去走1件(体重と着順)。diff は集計に使わないので固定。 */
function run(weight: number | null, finish: FinishPosition | null): BestWeightPastRun {
  return {
    bodyWeight: weight === null ? null : { weight, diff: 0 },
    finishPosition: finish,
  };
}

const today = (weight: number, diff = 0): BodyWeight => ({ weight, diff });

describe("summarizeBestWeight(ベスト体重の要約・純関数)", () => {
  describe("材料なし(null)", () => {
    it("当日の馬体重が未発表(null)なら null を返すこと", () => {
      expect(summarizeBestWeight([run(470, pos(1)), run(474, pos(2))], null)).toBeNull();
    });

    it("当日の馬体重が有限でない(NaN)なら null を返すこと", () => {
      expect(summarizeBestWeight([run(470, pos(1))], { weight: Number.NaN, diff: 0 })).toBeNull();
    });
  });

  describe("好走時の体重が基準になるとき(好走2走以上)", () => {
    const past = [run(478, pos(1)), run(470, pos(3)), run(474, pos(2))];

    it("中央値・範囲・好走数を持ち、今回が範囲内なら位置が範囲内であること", () => {
      const s = summarizeBestWeight(past, today(476, 2))!;
      expect(s.好走数).toBe(3);
      expect(s.好走時体重).toEqual([478, 470, 474]);
      expect(s.中央値).toBe(474);
      expect(s.最小).toBe(470);
      expect(s.最大).toBe(478);
      expect(s.サンプル不足).toBe(false);
      expect(s.今回).toEqual({ 体重: 476, 位置: "範囲内", 範囲外差: 0 });
    });

    it("今回が範囲より重いとき、位置=重い・範囲外差=最大からの差になること", () => {
      const s = summarizeBestWeight(past, today(485, 0))!;
      expect(s.今回).toEqual({ 体重: 485, 位置: "重い", 範囲外差: 7 });
      expect(s.note).toContain("範囲より7kg重い");
    });

    it("今回が範囲より軽いとき、位置=軽い・範囲外差=最小からの差になること", () => {
      const s = summarizeBestWeight(past, today(460, 0))!;
      expect(s.今回).toEqual({ 体重: 460, 位置: "軽い", 範囲外差: 10 });
      expect(s.note).toContain("範囲より10kg軽い");
    });

    it("範囲の端ちょうど(最小・最大)は範囲内であること(境界)", () => {
      expect(summarizeBestWeight(past, today(470))!.今回.位置).toBe("範囲内");
      expect(summarizeBestWeight(past, today(478))!.今回.位置).toBe("範囲内");
      expect(summarizeBestWeight(past, today(469))!.今回.位置).toBe("軽い");
      expect(summarizeBestWeight(past, today(479))!.今回.位置).toBe("重い");
    });

    it("前走比から前走体重(今回-前走比)を復元し、前走の位置も持つこと: 前走+12kg→今回-9kgで戻ったケース", () => {
      // 今回476・前走比-9 → 前走485(範囲より7kg重い)。今回476は範囲内。
      const s = summarizeBestWeight(past, today(476, -9))!;
      expect(s.前走).toEqual({ 体重: 485, 位置: "重い", 範囲外差: 7 });
      expect(s.今回.位置).toBe("範囲内");
      expect(s.note).toContain("今回476kg(範囲内)");
      expect(s.note).toContain("前走485kg(範囲より7kg重い)");
    });

    it("前走比が有限でないときは前走の位置を持たず、note にも前走を書かないこと", () => {
      const s = summarizeBestWeight(past, { weight: 476, diff: Number.NaN })!;
      expect(s.前走).toBeNull();
      expect(s.note).not.toContain("前走");
    });

    it("note に好走時の中央値・範囲・走数が入ること", () => {
      const s = summarizeBestWeight(past, today(476, 2))!;
      expect(s.note).toContain("好走(3着以内)時の直近3走");
      expect(s.note).toContain("中央値474kg");
      expect(s.note).toContain("範囲470〜478kg");
    });
  });

  describe("中央値の計算", () => {
    it("好走が偶数(2走)のとき、中央値は中央2値の平均(小数を含む)であること", () => {
      const s = summarizeBestWeight([run(470, pos(1)), run(475, pos(2))], today(472))!;
      expect(s.中央値).toBe(472.5);
      expect(s.note).toContain("中央値472.5kg");
    });
  });

  describe("対象となる走の選び方", () => {
    it("好走は直近5走に限り、6走目以降(古い走)は含まないこと", () => {
      const past = [
        run(480, pos(1)),
        run(481, pos(1)),
        run(482, pos(1)),
        run(483, pos(1)),
        run(484, pos(1)),
        run(400, pos(1)), // 6走目の好走。範囲に入れてはならない。
      ];
      const s = summarizeBestWeight(past, today(482))!;
      expect(s.好走数).toBe(5);
      expect(s.最小).toBe(480);
      expect(s.最大).toBe(484);
      expect(s.好走時体重).toEqual([480, 481, 482, 483, 484]);
    });

    it("4着以下・非数値着順・着順欠損の走は好走に含めないこと", () => {
      const past = [
        run(500, pos(4)),
        run(501, { kind: "非数値", text: "中止" }),
        run(502, null),
        run(470, pos(3)),
        run(474, pos(1)),
      ];
      const s = summarizeBestWeight(past, today(472))!;
      expect(s.好走時体重).toEqual([470, 474]);
    });

    it("降着(3着〈降〉)は確定着順の3着として好走に含め、4着〈降〉は含めないこと", () => {
      const past = [run(470, pos(3, true)), run(520, pos(4, true)), run(474, pos(1))];
      const s = summarizeBestWeight(past, today(472))!;
      expect(s.好走時体重).toEqual([470, 474]);
    });

    it("好走でも馬体重が無い(null/非有限)走は飛ばして、さらに過去の好走を探すこと(直近5走の消費に数えない)", () => {
      const past = [
        run(null, pos(1)),
        { bodyWeight: { weight: Number.NaN, diff: 0 }, finishPosition: pos(1) } as BestWeightPastRun,
        run(470, pos(2)),
        run(474, pos(3)),
      ];
      const s = summarizeBestWeight(past, today(472))!;
      expect(s.好走時体重).toEqual([470, 474]);
      expect(s.好走数).toBe(2);
    });
  });

  describe("サンプル不足(好走2走未満は中立に扱わせる合図)", () => {
    it("好走が1走のとき、サンプル不足=true・範囲の位置は持たず、note に「サンプル不足」と体重が入ること", () => {
      const s = summarizeBestWeight([run(472, pos(1)), run(500, pos(8))], today(480, -4))!;
      expect(s.好走数).toBe(1);
      expect(s.サンプル不足).toBe(true);
      expect(s.今回).toEqual({ 体重: 480, 位置: null, 範囲外差: null });
      expect(s.前走).toBeNull();
      expect(s.note).toContain("サンプル不足");
      expect(s.note).toContain("472kg");
      expect(s.note).not.toContain("範囲より");
      expect(s.note).not.toContain("範囲内");
    });

    it("好走が0走のとき、サンプル不足=true で note に「好走時の体重データなし」と今回体重が入ること", () => {
      const s = summarizeBestWeight([run(500, pos(8)), run(null, pos(1))], today(480))!;
      expect(s.好走数).toBe(0);
      expect(s.サンプル不足).toBe(true);
      expect(s.中央値).toBeNull();
      expect(s.note).toContain("好走時の体重データなし");
      expect(s.note).toContain("480kg");
    });

    it("過去走が空でも当日体重があれば好走0走として扱うこと", () => {
      const s = summarizeBestWeight([], today(480))!;
      expect(s.好走数).toBe(0);
      expect(s.サンプル不足).toBe(true);
    });

    it("好走がちょうど2走のとき、サンプル不足=false であること(境界)", () => {
      const s = summarizeBestWeight([run(470, pos(1)), run(474, pos(2))], today(472))!;
      expect(s.サンプル不足).toBe(false);
    });
  });

  describe("評価語を出さない(中立な事実のみ)", () => {
    it("note に評価語(ベスト体重に戻った・太め・絞れた・良化・悪化・不安)を含まないこと", () => {
      const s = summarizeBestWeight([run(470, pos(1)), run(474, pos(2))], today(485, -9))!;
      for (const word of ["戻った", "太め", "絞れ", "良化", "悪化", "不安", "好調", "絶好"]) {
        expect(s.note).not.toContain(word);
      }
    });
  });
});
