import { describe, expect, it } from "vitest";
import { diffAllocationBets, type DiffBet } from "../../packages/core/src/analysis/allocation-diff";
import { CLOSE_FAILED_REASONS, CLOSE_SKIPPED_REASONS } from "../src/analysis-close";
import { CLOSE_DIFF_ROW_LIMIT, CLOSE_NOTE, closeDiffLines, closeLabelOf, closeReasonText, closeSummaryLines } from "../src/close-view";

/**
 * Issue #344(#335-A2): 締切直前の再計算の、画面に出す文言の組み立て(サーバ側。クライアントの束に日本語を置かない)。
 */

const bet = (betType: string, comboKey: string, stake: number, odds: number | null = 5, ev: number | null = 1.2): DiffBet => ({ betType, comboKey, stake, odds, ev });

describe("closeReasonText: 理由の語彙すべてに日本語の文がある(型でも網羅を強制)", () => {
  const EXPECTED: Readonly<Record<string, string>> = {
    unset: "資金の設定が0のため計算していません",
    "nar-unsupported": "地方は対象外です",
    "too-late": "時刻を過ぎていたため行いませんでした",
    "fetch-failed": "オッズを取り直せませんでした",
    blocked: "オッズを取り直せませんでした",
    "horse-set-mismatch": "出走馬が分析時と変わったため行いませんでした",
    "analysis-failed": "計算できませんでした",
    "compute-failed": "計算できませんでした",
  };
  it("前提: 語彙の数(失敗 5 + 行わなかった 3)と、期待表の数が一致する", () => {
    expect(CLOSE_FAILED_REASONS.length + CLOSE_SKIPPED_REASONS.length).toBe(8);
    expect(Object.keys(EXPECTED).length).toBe(8);
  });
  it.each([...CLOSE_FAILED_REASONS, ...CLOSE_SKIPPED_REASONS])("%s", (reason) => {
    expect(closeReasonText(reason)).toBe(EXPECTED[reason]);
  });
});

describe("closeLabelOf", () => {
  it("リード(分)があれば「発走N分前」、無ければ「第N回」(定数にない回を分数に偽らない)", () => {
    expect(closeLabelOf(1, 5)).toBe("発走5分前");
    expect(closeLabelOf(2, 2)).toBe("発走2分前");
    expect(closeLabelOf(9, null)).toBe("第9回");
  });
});

describe("closeSummaryLines: 状態と理由・動いた時刻(JST の時:分)と遅れ", () => {
  // 2026-06-28T05:55:00Z = JST 14:55
  const base = { firedAt: "2026-06-28T05:55:00.000Z", lateMs: 0 };
  it("ok: 「再計算した」+ 時刻(遅れ 0 は出さない)", () => {
    expect(closeSummaryLines({ ...base, status: "ok", reason: null })).toEqual(["再計算した", "14:55に実行"]);
  });
  it("failed・skipped: 状態の後ろに理由を括弧で添える", () => {
    expect(closeSummaryLines({ ...base, status: "failed", reason: "fetch-failed" })).toEqual(["失敗(オッズを取り直せませんでした)", "14:55に実行"]);
    expect(closeSummaryLines({ ...base, status: "skipped", reason: "nar-unsupported" })).toEqual(["行わなかった(地方は対象外です)", "14:55に実行"]);
  });
  it("遅れの境界: 59,999ms は出さず、60,000ms は「1分遅れ」。119,999ms は切り捨てて「1分遅れ」、120,000ms は「2分遅れ」", () => {
    const line = (lateMs: number): string => closeSummaryLines({ ...base, lateMs, status: "ok", reason: null })[1]!;
    expect(line(59_999)).toBe("14:55に実行");
    expect(line(60_000)).toBe("14:55に実行(1分遅れ)");
    expect(line(119_999)).toBe("14:55に実行(1分遅れ)");
    expect(line(120_000)).toBe("14:55に実行(2分遅れ)");
  });
  it("JST 変換の境界: UTC 14:59 → 23:59、UTC 15:00 → 0:00 の翌日(時:分だけ)。UTC 時の 0 埋め", () => {
    const at = (iso: string): string => closeSummaryLines({ firedAt: iso, lateMs: 0, status: "ok", reason: null })[1]!;
    expect(at("2026-06-28T14:59:00.000Z")).toBe("23:59に実行");
    expect(at("2026-06-28T15:00:00.000Z")).toBe("00:00に実行");
    expect(at("2026-06-28T00:05:00.000Z")).toBe("09:05に実行");
  });
  it("時刻が解釈できなければ時刻の行を出さない(偽の時刻を作らない)", () => {
    expect(closeSummaryLines({ firedAt: "壊れた値", lateMs: 0, status: "ok", reason: null })).toEqual(["再計算した"]);
  });
});

describe("closeDiffLines: 分析時の提案との差分の要約と主な行", () => {
  const before = [bet("place", "01", 300), bet("win", "03", 100), bet("wide", "0102", 200)];

  it("変化なし(賭け金が同じでオッズだけ動いたものを含む): 「分析時から変わりませんでした」だけ", () => {
    const after = [bet("place", "01", 300, 9, 2), bet("win", "03", 100), bet("wide", "0102", 200)];
    const diff = diffAllocationBets(before, after);
    expect(diff.unchanged).toBe(3); // 前提: 3 点とも「変化なし」に数えられている
    expect(closeDiffLines(diff, after.length)).toEqual(["分析時から変わりませんでした"]);
  });

  it("追加・削除・賭け金の変化が各 1 点: 要約(点数と合計の増減)と、変化の大きい順の主な行", () => {
    const after = [bet("place", "01", 500), bet("wide", "0102", 200), bet("exacta", "0301", 100)];
    const diff = diffAllocationBets(before, after);
    // 前提: 追加・削除・変化が各 1 件、合計が変わっている(退化していない)
    expect([diff.added.length, diff.removed.length, diff.changed.length]).toEqual([1, 1, 1]);
    expect(diff.totalStakeBefore).not.toBe(diff.totalStakeAfter);
    expect(closeDiffLines(diff, after.length)).toEqual([
      "追加 1点・削除 1点・賭け金の変化 1点(合計 600円 → 800円)",
      "変化 複勝 1番 300円→500円", // |+200|
      "追加 馬単 3→1 100円", // 100
      "削除 単勝 3番 100円", // 100(同値は券種・キー順: exacta < win)
    ]);
  });

  it("合計が変わらないときは、合計を添えない(賭け金が入れ替わっただけ)", () => {
    const diff = diffAllocationBets([bet("place", "01", 300)], [bet("place", "02", 300)]);
    expect(diff.totalStakeBefore).toBe(diff.totalStakeAfter); // 前提
    expect(diff.hasChange).toBe(true); // 前提
    expect(closeDiffLines(diff, 1)[0]).toBe("追加 1点・削除 1点・賭け金の変化 0点");
  });

  it("主な行は最大 CLOSE_DIFF_ROW_LIMIT(5)行。超えた分は「ほか N 点」", () => {
    expect(CLOSE_DIFF_ROW_LIMIT).toBe(5);
    const after = Array.from({ length: 8 }, (_, i) => bet("place", String(i + 1).padStart(2, "0"), 100 * (i + 1)));
    const diff = diffAllocationBets([], after);
    expect(diff.added.length).toBe(8); // 前提
    const lines = closeDiffLines(diff, after.length);
    expect(lines.length).toBe(1 + 5 + 1);
    expect(lines[1]).toBe("追加 複勝 8番 800円"); // 賭け金の大きい順
    expect(lines[5]).toBe("追加 複勝 4番 400円");
    expect(lines[6]).toBe("ほか 3点");
  });

  it("ちょうど 5 点のときは「ほか」を出さない(境界)", () => {
    const after = Array.from({ length: 5 }, (_, i) => bet("place", String(i + 1).padStart(2, "0"), 100));
    const lines = closeDiffLines(diffAllocationBets([], after), 5);
    expect(lines.length).toBe(1 + 5);
    expect(lines.some((l) => l.startsWith("ほか"))).toBe(false);
  });

  it("再計算の配分が 0 点: 先頭に「配分は0点です」。分析時も 0 点なら変化なしの文、分析時に買い目があれば要約(削除)が続く", () => {
    const none = diffAllocationBets([], []);
    expect(closeDiffLines(none, 0)).toEqual(["配分は0点です", "分析時から変わりませんでした"]);
    const diff = diffAllocationBets(before, []);
    expect(diff.removed.length).toBe(3); // 前提
    const lines = closeDiffLines(diff, 0);
    expect(lines[0]).toBe("配分は0点です");
    expect(lines[1]).toBe("追加 0点・削除 3点・賭け金の変化 0点(合計 600円 → 0円)");
    expect(lines.length).toBe(2 + 3);
  });

  it("差分が無い(null: 分析時の提案の配分が無い)ときは、差分の文を出さない。0 点の注記だけは出す", () => {
    expect(closeDiffLines(null, 2)).toEqual([]);
    expect(closeDiffLines(null, 0)).toEqual(["配分は0点です"]);
  });
});

describe("CLOSE_NOTE", () => {
  it("確率は分析時のままであることを説明する固定文", () => {
    expect(CLOSE_NOTE).toBe("オッズだけを取り直し、確率は分析時のまま計算した結果です(分析時の提案は変わりません)。");
  });
});
